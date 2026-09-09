/**
 * ---------------------------------------------------------------------------
 * src/sync.js – Hintergrundabgleich mit TMDB
 * ---------------------------------------------------------------------------
 * Rolle im Gesamtsystem:
 *   Streaming-Rechte wandern ständig. Eine Serie, die heute bei Netflix läuft,
 *   ist nächsten Monat bei Prime – und genau das soll Streamo mitbekommen,
 *   ohne dass jemand auf "Aktualisieren" drückt.
 *
 *   Dieses Modul läuft alle SYNC_INTERVAL_HOURS Stunden und frischt auf:
 *     1. den Anbieter-Katalog jeder benutzten Region  (Tabelle providers)
 *     2. die Verfügbarkeiten aller Titel in Bibliotheken (Tabelle availability)
 *     3. veraltete oder unvollständige Metadaten        (Tabelle shows)
 *
 *   Es werden ausschließlich Titel angefasst, die mindestens eine Person in
 *   ihrer Bibliothek hat. Serien, die nur einmal in einer Suche auftauchten,
 *   werden bewusst NICHT dauerhaft aktualisiert – das spart API-Aufrufe.
 *
 * Verknüpfungen zu anderen Dateien:
 *   - src/store.js  -> refreshAvailability, ensureShow, syncProviderCatalog
 *   - src/db.js     -> Tabellen shows, library, users, sync_log
 *   - src/config.js -> syncIntervalHours
 *   - src/server.js -> ruft startSyncScheduler() beim Start
 *   - src/routes/settings.js -> manueller Start über POST /api/settings/sync
 * ---------------------------------------------------------------------------
 */

import config from './config.js';
import { all, get, run, getSetting, setSetting } from './db.js';
import { hasApiKey } from './tmdb.js';
import { refreshAvailability, ensureShow, syncProviderCatalog } from './store.js';

/**
 * Zustand des aktuell laufenden bzw. letzten Laufs.
 * Wird von GET /api/settings/sync ausgelesen und im UI angezeigt.
 */
const state = {
  /** Läuft gerade ein Abgleich? Verhindert Doppelläufe. */
  running: false,
  /** 'availability' | 'metadata' | 'providers' | 'full' */
  kind: null,
  /** Beginn des laufenden Durchgangs (ISO) */
  startedAt: null,
  /** Wie viele Titel sind zu tun / schon erledigt? Für den Fortschrittsbalken. */
  total: 0,
  done: 0,
  /** Zeitpunkt und Ergebnis des letzten abgeschlossenen Laufs */
  lastRunAt: null,
  lastResult: null,
  /** Handle des setInterval-Timers, damit er beim Herunterfahren löschbar ist */
  timer: null,
};

/**
 * Liefert eine Kopie des Zustands für die API.
 * Kopie statt Referenz, damit niemand von außen hineinschreiben kann.
 * @returns {object}
 */
export function getSyncState() {
  return {
    running: state.running,
    kind: state.kind,
    startedAt: state.startedAt,
    total: state.total,
    done: state.done,
    lastRunAt: state.lastRunAt || getSetting('last_sync_at', null),
    lastResult: state.lastResult,
    intervalHours: config.syncIntervalHours,
  };
}

/**
 * Ermittelt alle Regionen, für die überhaupt Daten gebraucht werden.
 *
 * Das sind die Regionen aller Benutzer plus die globale Vorgabe. In einer
 * Ein-Personen-Installation ist das genau ein Land; in einer Familien-Instanz
 * mit einem Konto in Österreich sind es zwei.
 *
 * @returns {string[]} z. B. ["DE", "AT"]
 */
function activeRegions() {
  const rows = all('SELECT DISTINCT region FROM users WHERE region IS NOT NULL');

  const regions = new Set(rows.map((r) => String(r.region).toUpperCase()));
  regions.add(String(getSetting('region', config.region)).toUpperCase());

  return [...regions].filter(Boolean);
}

/**
 * Schreibt eine Zeile ins Protokoll und gibt ihre ID zurück.
 * @param {string} kind
 * @returns {number} sync_log.id
 */
function startLog(kind) {
  const result = run('INSERT INTO sync_log (kind) VALUES (?)', kind);
  return Number(result.lastInsertRowid);
}

/**
 * Schließt eine Protokollzeile ab.
 * @param {number} id     sync_log.id aus startLog()
 * @param {boolean} ok
 * @param {number} items  Anzahl verarbeiteter Titel
 * @param {string} detail Kurzbericht oder Fehlermeldung
 */
function finishLog(id, ok, items, detail) {
  run(
    `UPDATE sync_log
        SET finished_at = datetime('now'), ok = ?, items = ?, detail = ?
      WHERE id = ?`,
    ok ? 1 : 0,
    items,
    detail?.slice(0, 500) ?? null,
    id,
  );
}

/**
 * Führt einen Abgleich durch.
 *
 * @param {'availability'|'metadata'|'providers'|'full'} [kind]
 *   availability – nur nachsehen, wo die Titel gerade laufen (schnell, Standard)
 *   metadata     – Titel, Poster, Staffelzahlen auffrischen
 *   providers    – nur den Anbieter-Katalog neu laden
 *   full         – alles drei nacheinander
 * @returns {Promise<{ok: boolean, items: number, detail: string}>}
 */
export async function runSync(kind = 'availability') {
  // Doppelläufe verhindern: Zwei gleichzeitige Durchgänge würden sich nur
  // gegenseitig das Rate-Limit wegnehmen.
  if (state.running) {
    return { ok: false, items: 0, detail: 'Es läuft bereits ein Abgleich.' };
  }

  // Ohne API-Key gibt es nichts abzugleichen.
  if (!hasApiKey()) {
    return { ok: false, items: 0, detail: 'Kein TMDB-API-Key hinterlegt.' };
  }

  state.running = true;
  state.kind = kind;
  state.startedAt = new Date().toISOString();
  state.total = 0;
  state.done = 0;

  const logId = startLog(kind);
  const regions = activeRegions();
  const language = getSetting('language', config.language);

  let processed = 0;
  const problems = [];

  try {
    // ---------------------------------------------------------------------
    // 1. Anbieter-Katalog je Region
    // ---------------------------------------------------------------------
    if (kind === 'providers' || kind === 'full') {
      for (const region of regions) {
        try {
          const catalog = await syncProviderCatalog(region, language);
          processed += catalog.length;
        } catch (error) {
          problems.push(`Katalog ${region}: ${error.message}`);
        }
      }
    }

    // ---------------------------------------------------------------------
    // 2. Verfügbarkeiten aller Titel, die in mindestens einer Bibliothek stehen
    // ---------------------------------------------------------------------
    if (kind === 'availability' || kind === 'full') {
      // DISTINCT über die Bibliotheken aller Benutzer: Eine Serie, die drei
      // Personen tracken, wird trotzdem nur einmal abgefragt.
      const shows = all(
        `SELECT DISTINCT s.*
           FROM shows s
           JOIN library l ON l.show_id = s.id
          -- Am längsten nicht geprüfte zuerst; NULL (nie geprüft) gewinnt,
          -- weil COALESCE es auf den frühestmöglichen Zeitpunkt setzt.
          ORDER BY COALESCE(s.availability_updated_at, '1970-01-01')`,
      );

      state.total = shows.length * regions.length;

      for (const show of shows) {
        for (const region of regions) {
          try {
            await refreshAvailability(show, region);
            processed++;
          } catch (error) {
            problems.push(`${show.title} (${region}): ${error.message}`);
          }
          state.done++;
        }
      }
    }

    // ---------------------------------------------------------------------
    // 3. Metadaten – nur, was älter als eine Woche oder unvollständig ist
    // ---------------------------------------------------------------------
    if (kind === 'metadata' || kind === 'full') {
      const stale = all(
        `SELECT DISTINCT s.*
           FROM shows s
           JOIN library l ON l.show_id = s.id
          WHERE s.metadata_updated_at IS NULL
             OR s.metadata_updated_at < datetime('now', '-7 days')
          -- Deckel, damit ein Lauf nicht stundenlang dauert; der Rest kommt
          -- beim nächsten Durchgang dran.
          LIMIT 200`,
      );

      state.total += stale.length;

      for (const show of stale) {
        try {
          await ensureShow(show.tmdb_id, show.media_type, {
            region: regions[0],
            language,
            force: true,
          });
          processed++;
        } catch (error) {
          problems.push(`${show.title}: ${error.message}`);
        }
        state.done++;
      }
    }

    const detail =
      problems.length === 0
        ? `${processed} Einträge aktualisiert.`
        : `${processed} aktualisiert, ${problems.length} Probleme: ${problems.slice(0, 3).join(' | ')}`;

    finishLog(logId, problems.length === 0, processed, detail);

    // Zeitstempel dauerhaft merken – überlebt einen Neustart, anders als
    // state.lastRunAt.
    setSetting('last_sync_at', new Date().toISOString());

    state.lastRunAt = new Date().toISOString();
    state.lastResult = detail;

    return { ok: true, items: processed, detail };
  } catch (error) {
    // Unerwarteter Abbruch (z. B. TMDB komplett offline).
    finishLog(logId, false, processed, error.message);
    state.lastResult = `Fehlgeschlagen: ${error.message}`;
    return { ok: false, items: processed, detail: error.message };
  } finally {
    // In JEDEM Fall zurücksetzen – sonst bliebe der Sync für immer "running"
    // und ließe sich nie wieder starten.
    state.running = false;
    state.kind = null;
    state.startedAt = null;
  }
}

/**
 * Startet den wiederkehrenden Abgleich.
 * Aufgerufen von src/server.js, nachdem der HTTP-Server lauscht.
 *
 * Beim Start passiert absichtlich nichts sofort: Ein frisch gestarteter
 * Container soll erst einmal erreichbar sein. Der erste Lauf wird um zwei
 * Minuten verzögert, danach greift das reguläre Intervall.
 */
export function startSyncScheduler() {
  if (config.syncIntervalHours <= 0) {
    console.log('[sync] Hintergrundabgleich ist deaktiviert (SYNC_INTERVAL_HOURS=0).');
    return;
  }

  const intervalMs = config.syncIntervalHours * 3_600_000;

  // Erster Lauf nach zwei Minuten.
  setTimeout(() => {
    runSync('full').catch((error) => console.error('[sync] Erster Lauf fehlgeschlagen:', error.message));
  }, 120_000).unref?.(); // unref: hält den Prozess nicht künstlich am Leben

  // Danach im festen Takt. "availability" ist der günstige Standardlauf;
  // einmal täglich zusätzlich die Metadaten wäre über 'full' möglich.
  state.timer = setInterval(() => {
    runSync('availability').catch((error) =>
      console.error('[sync] Abgleich fehlgeschlagen:', error.message),
    );
  }, intervalMs);

  console.log(
    // "alle 1 Stunden" liest sich falsch – bei genau einer Stunde heißt es
    // "jede Stunde".
    `[sync] Hintergrundabgleich aktiv – ${
      config.syncIntervalHours === 1 ? 'jede Stunde' : `alle ${config.syncIntervalHours} Stunden`
    }.`,
  );
}

/**
 * Stoppt den Zeitgeber. Wird beim geordneten Herunterfahren aufgerufen,
 * damit der Prozess sich wirklich beenden kann.
 */
export function stopSyncScheduler() {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
}
