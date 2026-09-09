/**
 * ---------------------------------------------------------------------------
 * src/routes/settings.js – Einstellungen, Abgleich, Sessions
 * ---------------------------------------------------------------------------
 * Eingehängt in src/server.js unter /api/settings.
 *
 * Endpunkte:
 *   GET    /api/settings           – aktuelle Einstellungen (Key maskiert)
 *   PUT    /api/settings           – Region/Sprache ändern (jeder für sich)
 *   PUT    /api/settings/global    – TMDB-Key & globale Defaults (nur Admin)
 *   POST   /api/settings/test-key  – API-Key prüfen, ohne ihn zu speichern
 *   POST   /api/settings/sync      – Abgleich sofort starten (nur Admin)
 *   GET    /api/settings/sync      – Protokoll der letzten Läufe
 *   GET    /api/settings/sessions  – meine aktiven Anmeldungen
 *   DELETE /api/settings/sessions  – alle anderen Geräte abmelden
 *
 * Verknüpfungen:
 *   - src/db.js   -> getSetting/setSetting (Tabelle settings)
 *   - src/tmdb.js -> testApiKey()
 *   - src/sync.js -> runSync() für den manuellen Abgleich
 *   - src/auth.js -> listSessions / destroyAllSessions
 * ---------------------------------------------------------------------------
 */

import express from 'express';
import config from '../config.js';
import { all, get, run, getSetting, setSetting } from '../db.js';
import {
  requireAuth,
  requireAdmin,
  listSessions,
  createSession,
  setSessionCookie,
  destroyAllSessions,
  // Entscheidet, ob eine Einladung noetig ist - Datenbank sticht .env.
  isRegistrationOpen,
} from '../auth.js';
import * as tmdb from '../tmdb.js';
import { getRuntimeSettings } from '../tmdb.js';
import { runSync, getSyncState, applySyncInterval, getSyncIntervalHours } from '../sync.js';

const router = express.Router();
router.use(requireAuth);

/**
 * GET /api/settings
 * Alles, was die Einstellungsseite anzeigt.
 */
router.get('/', (req, res) => {
  const runtime = getRuntimeSettings(req.user);

  res.json({
    user: {
      username: req.user.username,
      // Ohne dieses Feld stand das E-Mail-Eingabefeld auf der
      // Einstellungsseite immer leer, egal ob eine Adresse hinterlegt war –
      // das Frontend liest genau hier.
      email: req.user.email || null,
      displayName: req.user.display_name,
      isAdmin: Boolean(req.user.is_admin),
      region: req.user.region || runtime.region,
      language: req.user.language || runtime.language,
    },
    global: {
      // Der TMDB-Schlüssel selbst verlässt den Server NIE – auch nicht
      // maskiert. Früher stand hier "eyJhbGciOi…9f3a", damit man sieht, dass
      // einer hinterlegt ist. Nur: Wozu? Ändern kann man ihn ohnehin nur,
      // indem man einen neuen einträgt, und die ersten sechs Zeichen sind
      // nichts, was auf einem Bildschirmfoto oder in einer Bildschirmfreigabe
      // etwas verloren hätte.
      //
      // Es bleibt die eine Auskunft, die wirklich gebraucht wird: Gibt es
      // einen? Davon hängt der Hinweisbanner ab.
      hasApiKey: Boolean(runtime.apiKey),
      region: getSetting('region', config.region),
      language: getSetting('language', config.language),
      // Ob eine Einladung nötig ist. Der gespeicherte Wert sticht die .env –
      // siehe isRegistrationOpen() in src/auth.js.
      allowRegistration: isRegistrationOpen(),
      // Woher der geltende Wert stammt. Die Oberfläche schreibt das dazu,
      // damit erkennbar ist, ob noch die Vorgabe aus der .env gilt.
      allowRegistrationSource:
        getSetting('allow_registration', null) === null ? 'env' : 'database',
      // Der tatsaechlich geltende Takt - der gespeicherte Wert sticht die .env.
      syncIntervalHours: getSyncIntervalHours(),
    },
    sync: getSyncState(),
    version: config.version,
  });
});

/**
 * PUT /api/settings
 * Persönliche Einstellungen. Body: { region?, language?, displayName? }
 *
 * Die Region ist die wichtigste Einstellung überhaupt: Sie entscheidet,
 * welche Anbieter im Katalog stehen und welche Verfügbarkeiten geladen werden.
 */
router.put('/', (req, res) => {
  const updates = [];
  const params = [];

  if (req.body?.region) {
    // ISO-3166-1 alpha-2: genau zwei Buchstaben.
    const region = String(req.body.region).toUpperCase().trim();
    if (!/^[A-Z]{2}$/.test(region)) {
      return res.status(400).json({ error: 'Region muss ein Länderkürzel wie "DE" sein.' });
    }
    updates.push('region = ?');
    params.push(region);
  }

  if (req.body?.language) {
    updates.push('language = ?');
    params.push(String(req.body.language).trim());
  }

  if (req.body?.displayName !== undefined) {
    updates.push('display_name = ?');
    params.push(String(req.body.displayName).trim().slice(0, 60));
  }

  // Das Farbschema. Es gilt nur für dieses eine Konto – am Telefon soll
  // dieselbe Farbe erscheinen wie am Rechner, aber nicht bei allen anderen.
  //
  // Der Server prüft die Werte, statt sie blind zu übernehmen: Das Frontend
  // schreibt sie zwar sauber, aber der Endpunkt ist offen und eine unsinnige
  // Farbe würde beim nächsten Laden halbe Bedienelemente unsichtbar machen.
  if (req.body?.theme !== undefined) {
    const theme = req.body.theme ?? {};

    const accent = String(theme.accent ?? '');
    const base = String(theme.base ?? '');

    if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(accent)) {
      return res.status(400).json({ error: 'Die Akzentfarbe muss eine Farbe wie "#f39c12" sein.' });
    }

    if (!['nacht', 'schwarz'].includes(base)) {
      return res.status(400).json({ error: 'Unbekannter Grundton.' });
    }

    updates.push('theme = ?');
    params.push(JSON.stringify({ accent: accent.toLowerCase(), base }));
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'Keine Änderungen übergeben.' });
  }

  params.push(req.user.id);
  run(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, ...params);

  res.json({ ok: true });
});

/**
 * PUT /api/settings/global
 * Instanzweite Einstellungen. Body: { apiKey?, region?, language?, allowRegistration? }
 * Nur für Admins – der TMDB-Key gilt für alle Benutzer dieser Installation.
 */
router.put('/global', requireAdmin, async (req, res, next) => {
  try {
    if (req.body?.apiKey !== undefined) {
      const key = String(req.body.apiKey).trim();

      if (key === '') {
        // Leerer Wert = Key entfernen (zurück auf den Wert aus der .env).
        setSetting('tmdb_api_key', null);
      } else {
        // Erst prüfen, dann speichern – ein kaputter Key würde sonst die
        // ganze Instanz lahmlegen.
        await tmdb.testApiKey(key);
        setSetting('tmdb_api_key', key);
      }
    }

    if (req.body?.region) setSetting('region', String(req.body.region).toUpperCase().trim());
    if (req.body?.language) setSetting('language', String(req.body.language).trim());

    // Offene Registrierung ein- oder ausschalten.
    //
    // Bis hierher ließ sich das nur über ALLOW_REGISTRATION in der .env
    // regeln – man musste also auf den Server. Der gespeicherte Wert gilt ab
    // sofort und überstimmt die .env; ausgewertet wird er in
    // isRegistrationOpen() (src/auth.js).
    //
    // Die Vorgabe bleibt "aus": Sobald Streamo aus dem Internet erreichbar
    // ist, könnte sonst jeder, der die Adresse findet, ein Konto anlegen und
    // den TMDB-Zugang der Instanz mitbenutzen.
    if (req.body?.allowRegistration !== undefined) {
      setSetting('allow_registration', req.body.allowRegistration ? '1' : '0');
    }

    // Takt des Hintergrundabgleichs.
    //
    // Auch hier sticht der gespeicherte Wert die .env – und das ist hier sogar
    // zwingend: Der Installer schreibt SYNC_INTERVAL_HOURS fest in die .env.
    // Eine geänderte Vorgabe im Programm käme bei bestehenden Installationen
    // deshalb nie an, und man müsste für eine Zahl auf den Server.
    //
    // Der neue Takt gilt sofort: applySyncInterval() räumt den laufenden
    // Zeitgeber ab und setzt einen neuen. Ohne diesen Aufruf würde die
    // Änderung erst beim nächsten Neustart wirken.
    if (req.body?.syncIntervalHours !== undefined) {
      const hours = Number(req.body.syncIntervalHours);

      if (!Number.isFinite(hours) || hours < 0 || hours > 168) {
        return res.status(400).json({
          error: 'Der Takt muss zwischen 0 (aus) und 168 Stunden liegen.',
        });
      }

      setSetting('sync_interval_hours', String(hours));
      applySyncInterval();
    }

    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/settings/test-key
 * Prüft einen Schlüssel, ohne ihn zu speichern. Body: { apiKey }
 */
router.post('/test-key', requireAdmin, async (req, res) => {
  try {
    await tmdb.testApiKey(String(req.body?.apiKey ?? '').trim());
    res.json({ ok: true, message: 'Der Schlüssel funktioniert.' });
  } catch (error) {
    res.status(error.status || 400).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/settings/sync
 * Startet den Abgleich sofort. Body: { kind?: 'availability'|'metadata'|'full' }
 *
 * Der Aufruf wartet NICHT auf das Ende – ein voller Lauf kann bei großen
 * Bibliotheken Minuten dauern. Der Fortschritt wird über GET /api/settings/sync
 * abgefragt.
 */
router.post('/sync', requireAdmin, (req, res) => {
  const kind = ['availability', 'metadata', 'full'].includes(req.body?.kind)
    ? req.body.kind
    : 'availability';

  // Bewusst ohne await: sofort antworten, im Hintergrund weiterarbeiten.
  // Der catch verhindert eine unbehandelte Promise-Ablehnung.
  runSync(kind).catch(() => {});

  res.json({ ok: true, started: kind });
});

/**
 * GET /api/settings/sync
 * Zustand und Protokoll der letzten zehn Läufe.
 */
router.get('/sync', (req, res) => {
  res.json({
    state: getSyncState(),
    log: all('SELECT * FROM sync_log ORDER BY started_at DESC LIMIT 10'),
  });
});

/**
 * GET /api/settings/sessions
 * Meine aktiven Anmeldungen. Die aktuelle wird markiert, damit man sie im UI
 * nicht versehentlich für ein fremdes Gerät hält.
 */
router.get('/sessions', (req, res) => {
  const sessions = listSessions(req.user.id).map((s) => ({
    ...s,
    // Den Token selbst nie ausliefern – nur die Info "das bist du gerade".
    id: undefined,
    current: s.id === req.sessionToken,
  }));

  res.json({ sessions });
});

/**
 * DELETE /api/settings/sessions
 * Meldet alle Geräte ab und stellt für den aktuellen Browser sofort eine
 * frische Session aus, damit man nicht sich selbst aussperrt.
 */
router.delete('/sessions', (req, res) => {
  destroyAllSessions(req.user.id);

  const token = createSession(req.user.id, {
    userAgent: req.headers['user-agent'],
    ip: null,
  });
  setSessionCookie(res, token);

  res.json({ ok: true });
});

// ==========================================================================
// Benutzerverwaltung (nur Administratoren)
// ==========================================================================
// Bis hierher gab es keine Übersicht darüber, wer auf einer Instanz überhaupt
// ein Konto hat. Wer eine Einladung verschickt, will aber sehen, ob sie
// angekommen ist – und Adminrechte ließen sich nur über die Konsole vergeben
// (scripts/make-admin.mjs).

/**
 * GET /api/settings/users
 *
 * Alle Konten dieser Instanz mit ihrem Rang und der letzten Anmeldung.
 *
 * Bewusst sparsam: Es kommen keine Passwort-Hashes, keine TOTP-Geheimnisse
 * und keine E-Mail-Adressen. Wer hier Konten verwaltet, muss wissen, WER da
 * ist – nicht, was diese Person sieht oder womit sie sich anmeldet.
 */
router.get('/users', requireAdmin, (req, res) => {
  const users = all(
    `SELECT u.id, u.username, u.display_name, u.is_admin,
            u.created_at, u.last_login_at,
            -- Wie viele Titel stehen in der Bibliothek? Daran erkennt man,
            -- ob ein Konto tatsächlich benutzt wird oder nur existiert.
            (SELECT COUNT(*) FROM library l WHERE l.user_id = u.id) AS library_count,
            -- Ist gerade jemand angemeldet? Zählt die noch gültigen Sitzungen.
            (SELECT COUNT(*) FROM sessions s
              WHERE s.user_id = u.id AND s.expires_at > datetime('now')) AS active_sessions,
            -- Zweiter Faktor eingeschaltet? Nur ja/nein, nie das Geheimnis.
            u.totp_enabled
       FROM users u
      ORDER BY u.is_admin DESC, u.username COLLATE NOCASE`,
  );

  res.json({
    users: users.map((user) => ({
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      isAdmin: Boolean(user.is_admin),
      createdAt: user.created_at,
      lastLoginAt: user.last_login_at,
      libraryCount: user.library_count,
      activeSessions: user.active_sessions,
      twoFactor: Boolean(user.totp_enabled),
      // Damit die Oberfläche das eigene Konto kenntlich machen und den
      // Schalter dafür sperren kann.
      isSelf: user.id === req.user.id,
    })),
  });
});

/**
 * PUT /api/settings/users/:id
 * Body: { isAdmin: boolean }
 *
 * Vergibt oder entzieht Adminrechte.
 *
 * Zwei Sperren, die beide denselben Zweck haben – niemanden aussperren:
 *
 *   1. Man kann sich nicht selbst die Rechte nehmen. Sonst wäre der Schalter
 *      dafür sofort weg und man käme nur noch über die Konsole zurück.
 *   2. Der letzte Administrator bleibt einer. Ohne ihn könnte niemand mehr
 *      den TMDB-Key ändern, Einladungen erzeugen oder den Abgleich starten.
 *
 * Denselben Schutz hat scripts/make-admin.mjs auf der Konsole.
 */
router.put('/users/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const makeAdmin = Boolean(req.body?.isAdmin);

  const target = get('SELECT id, username, is_admin FROM users WHERE id = ?', id);

  if (!target) {
    return res.status(404).json({ error: 'Dieses Konto gibt es nicht.' });
  }

  if (target.id === req.user.id && !makeAdmin) {
    return res.status(400).json({
      error: 'Du kannst dir die Adminrechte nicht selbst nehmen. Lass das jemand anderen tun.',
    });
  }

  if (!makeAdmin && target.is_admin) {
    const admins = get('SELECT COUNT(*) AS count FROM users WHERE is_admin = 1').count;

    if (admins <= 1) {
      return res.status(400).json({
        error: 'Das ist der einzige Administrator. Gib zuerst jemand anderem die Rechte.',
      });
    }
  }

  run('UPDATE users SET is_admin = ? WHERE id = ?', makeAdmin ? 1 : 0, target.id);

  res.json({ ok: true, username: target.username, isAdmin: makeAdmin });
});

/**
 * DELETE /api/settings/users/:id
 * Body: { confirm: "<benutzername>" }
 *
 * Löscht ein Konto endgültig.
 *
 * Was dabei verschwindet, erledigt die Datenbank selbst: An `users` hängen
 * Bibliothek, Sehfortschritt, Abos, Bewertungen, Erfolge, Passkeys, Sitzungen,
 * Freundschaften, Empfehlungen, eigene Filmreihen und der zweite Faktor jeweils
 * mit ON DELETE CASCADE (siehe src/db.js). Es bleibt nichts zurück.
 *
 * Zwei Dinge überleben mit Absicht:
 *   - Einladungen, die diese Person erzeugt hat (ON DELETE SET NULL). Sie
 *     gehören zur Instanz, nicht zur Person – ein verschickter Link soll nicht
 *     ins Leere führen, nur weil der Absender gegangen ist.
 *   - Offizielle Filmreihen von TMDB. Die gehören ohnehin niemandem.
 *
 * Drei Sperren:
 *   1. Der Benutzername muss zur Bestätigung mitgeschickt werden. Das ist
 *      keine Sicherheitsmaßnahme, sondern eine gegen Versehen: Ein Klick
 *      daneben löscht sonst die Bibliothek einer anderen Person.
 *   2. Man kann sich nicht selbst löschen – dabei würde man sich mitten im
 *      Vorgang die eigene Sitzung entziehen.
 *   3. Der letzte Administrator bleibt. Ohne ihn könnte niemand mehr den
 *      TMDB-Zugang ändern oder Einladungen erzeugen.
 */
router.delete('/users/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);

  const target = get('SELECT id, username, is_admin FROM users WHERE id = ?', id);

  if (!target) {
    return res.status(404).json({ error: 'Dieses Konto gibt es nicht.' });
  }

  if (target.id === req.user.id) {
    return res.status(400).json({
      error:
        'Du kannst dein eigenes Konto hier nicht löschen. Lass das jemand anderen mit Adminrechten tun.',
    });
  }

  if (target.is_admin) {
    const admins = get('SELECT COUNT(*) AS count FROM users WHERE is_admin = 1').count;

    if (admins <= 1) {
      return res.status(400).json({
        error: 'Das ist der einzige Administrator. Gib zuerst jemand anderem die Rechte.',
      });
    }
  }

  // Der Vergleich ist bewusst streng: Wer den Namen abtippt, hat hingesehen.
  if (String(req.body?.confirm ?? '').trim() !== target.username) {
    return res.status(400).json({
      error: `Zur Bestätigung muss der Benutzername „${target.username}" genau so eingegeben werden.`,
    });
  }

  // Vorher zählen, was verloren geht – das gehört in die Rückmeldung, damit
  // hinterher klar ist, was tatsächlich passiert ist.
  const removed = {
    library: get('SELECT COUNT(*) AS count FROM library WHERE user_id = ?', id).count,
    collections: get(
      'SELECT COUNT(*) AS count FROM collections WHERE user_id = ?',
      id,
    ).count,
  };

  run('DELETE FROM users WHERE id = ?', id);

  res.json({ ok: true, username: target.username, removed });
});

export default router;
