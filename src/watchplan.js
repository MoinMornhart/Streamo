/**
 * ---------------------------------------------------------------------------
 * src/watchplan.js – Sehpläne: "jeden Montag zwei Folgen"
 * ---------------------------------------------------------------------------
 * Rolle im Gesamtsystem:
 *   So schaut man Serien tatsächlich – nicht irgendwann, sondern in einem
 *   Rhythmus. Ein Sehplan nimmt einem die Buchführung ab: An den festgelegten
 *   Tagen hakt Streamo die nächsten Folgen selbst ab.
 *
 * Die wichtigste Entscheidung dabei:
 *   Der Plan merkt sich NICHT, bei welcher Folge er steht. Er nimmt jedes Mal
 *   die nächsten UNGESEHENEN. Das klingt nach einem Detail, ist aber der
 *   ganze Unterschied: Wer an einem Abend spontan fünf Folgen schaut und von
 *   Hand abhakt, bekommt am nächsten Montag nicht dieselben noch einmal
 *   angehakt – der Plan macht dort weiter, wo man steht.
 *
 * Das Nachholen:
 *   War der Server am Montag aus, wird der Montag am Dienstag nachgeholt.
 *   Dafür merkt sich der Plan den letzten Lauf und zählt beim nächsten Mal,
 *   wie viele Plantage seither vergangen sind. Gedeckelt, damit nach zwei
 *   Wochen Urlaub nicht eine halbe Staffel auf einmal abgehakt wird.
 *
 * Verknüpfungen:
 *   - src/db.js           -> Tabellen watch_plans, episodes, watched_episodes
 *   - src/routes/shows.js -> anlegen, ändern, löschen
 *   - src/calendar.js     -> die kommenden Termine im Kalender
 *   - src/server.js       -> ruft runDuePlans() beim Start und stündlich
 *   - public/js/views/detail.js -> die Einstellung dazu
 * ---------------------------------------------------------------------------
 */

import { all, get, run, transaction } from './db.js';

/**
 * Wie viele versäumte Plantage höchstens nachgeholt werden.
 *
 * Nach zwei Wochen Urlaub soll nicht eine halbe Staffel auf einmal als
 * gesehen dastehen – das wäre schlimmer als gar nichts, weil man den Stand
 * danach von Hand korrigieren müsste.
 */
const MAX_CATCH_UP = 3;

/**
 * Zerlegt die gespeicherte Wochentagsliste.
 *
 * @param {string} weekdays z. B. "1,4"
 * @returns {number[]} 1 = Montag … 7 = Sonntag
 */
export function parseWeekdays(weekdays) {
  return String(weekdays || '')
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((day) => Number.isInteger(day) && day >= 1 && day <= 7);
}

/**
 * Bringt eine Wochentagsliste auf die gespeicherte Form.
 *
 * Sortiert und ohne Doppelte, damit "4,1,1" und "1,4" dasselbe ergeben und
 * die Anzeige nicht von der Eingabereihenfolge abhängt.
 *
 * @param {number[]|string} input
 * @returns {string} z. B. "1,4"
 */
export function normalizeWeekdays(input) {
  const list = Array.isArray(input) ? input : parseWeekdays(input);

  return [...new Set(list.map(Number))]
    .filter((day) => Number.isInteger(day) && day >= 1 && day <= 7)
    .sort((a, b) => a - b)
    .join(',');
}

/**
 * Der Wochentag eines Datums nach ISO-8601.
 *
 * getDay() liefert 0 für Sonntag; hier ist Montag die 1 und Sonntag die 7 –
 * so, wie man es aufschreibt und wie es in der Datenbank steht.
 *
 * @param {Date} date
 * @returns {number} 1–7
 */
function isoWeekday(date) {
  return date.getDay() === 0 ? 7 : date.getDay();
}

/** Der heutige Tag als "YYYY-MM-DD", ohne Zeitzonenverschiebung. */
function heute() {
  const now = new Date();
  const monat = String(now.getMonth() + 1).padStart(2, '0');
  const tag = String(now.getDate()).padStart(2, '0');

  return `${now.getFullYear()}-${monat}-${tag}`;
}

/**
 * Ein Datum als "YYYY-MM-DD", LOKAL gerechnet.
 *
 * Nicht toISOString(): Das rechnet nach UTC um, und lokale Mitternacht ist
 * in deutscher Zeit 22 oder 23 Uhr UTC des Vortags – das Ergebnis läge einen
 * Tag zu früh.
 *
 * @param {Date} date
 * @returns {string}
 */
function isoTag(date) {
  const monat = String(date.getMonth() + 1).padStart(2, '0');
  const tag = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${monat}-${tag}`;
}

/** Die aktuelle Uhrzeit als "HH:MM". */
function jetzt() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

// ===========================================================================
// Uhrzeit und Dauer
// ===========================================================================

/**
 * So lange dauert eine Folge, wenn weder die Folge selbst noch die Serie eine
 * Laufzeit bei TMDB hat – in Minuten. Eine übliche Dramaserie.
 */
export const FALLBACK_EPISODE_MINUTES = 45;

/**
 * Bringt eine Uhrzeit auf die gespeicherte Form "HH:MM".
 *
 * "8:05" wird zu "08:05" – sonst sortierten "8:05" und "20:15" falsch.
 * Leer heißt "keine Uhrzeit".
 *
 * @param {*} value
 * @returns {string|null}
 * @throws bei einer unbrauchbaren Angabe wie "25:00" oder "abends"
 */
export function normalizeTime(value) {
  if (value === null || value === undefined || value === '') return null;

  const match = String(value).trim().match(/^(\d{1,2}):(\d{2})$/);

  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
    throw new Error('Bitte eine Uhrzeit wie 20:15 angeben.');
  }

  return `${match[1].padStart(2, '0')}:${match[2]}`;
}

/**
 * "20:15" -> Minuten seit Mitternacht.
 * @param {string} time
 * @returns {number}
 */
export function toMinutes(time) {
  const [stunden, minuten] = String(time).split(':').map(Number);
  return stunden * 60 + minuten;
}

/**
 * Wie lange ein Block Folgen dauert.
 *
 * Jede Folge mit ihrer eigenen Laufzeit, wenn TMDB sie kennt
 * (episodes.runtime) – Staffelfinale sind oft deutlich länger. Sonst die
 * übliche Folgenlänge der Serie (shows.runtime), sonst 45 Minuten.
 *
 * @param {{runtime?: number|null}[]} folgen
 * @param {number|null} [serienLaufzeit]
 * @returns {number} Minuten
 */
export function blockMinutes(folgen, serienLaufzeit) {
  const standard = serienLaufzeit > 0 ? serienLaufzeit : FALLBACK_EPISODE_MINUTES;
  return folgen.reduce((summe, folge) => summe + (folge.runtime > 0 ? folge.runtime : standard), 0);
}

// ===========================================================================
// Lesen und Schreiben
// ===========================================================================

/**
 * Holt den Plan zu einer Serie.
 *
 * @param {number} userId
 * @param {number} showId
 * @returns {object|null} mit weekdays als Zahlenliste
 */
export function getPlan(userId, showId) {
  const row = get(
    'SELECT * FROM watch_plans WHERE user_id = ? AND show_id = ?',
    userId,
    showId,
  );

  if (!row) return null;

  return {
    weekdays: parseWeekdays(row.weekdays),
    episodesPerRun: row.episodes_per_run,
    // "20:15" oder null (ohne Uhrzeit, ganztägig). Migration 15.
    time: row.watch_time ?? null,
    active: Boolean(row.active),
    lastRunOn: row.last_run_on,
    createdAt: row.created_at,
  };
}

/**
 * Legt einen Plan an oder ändert ihn.
 *
 * @param {number} userId
 * @param {number} showId
 * @param {object} plan
 * @param {number[]} plan.weekdays
 * @param {number} plan.episodesPerRun
 * @param {string|null} [plan.time] Uhrzeit "HH:MM", freiwillig
 * @param {boolean} [plan.active]
 * @returns {object} der gespeicherte Plan
 * @throws bei unsinnigen Angaben
 */
export function savePlan(userId, showId, plan) {
  const weekdays = normalizeWeekdays(plan.weekdays);

  if (!weekdays) {
    throw new Error('Wähle mindestens einen Wochentag.');
  }

  const perRun = Number(plan.episodesPerRun);

  if (!Number.isInteger(perRun) || perRun < 1 || perRun > 20) {
    throw new Error('Zwischen 1 und 20 Folgen je Termin.');
  }

  // Wirft bei Unsinn – die Route gibt die Meldung als 400 weiter.
  const time = normalizeTime(plan.time);

  run(
    `INSERT INTO watch_plans (user_id, show_id, weekdays, episodes_per_run, watch_time, active)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(user_id, show_id) DO UPDATE SET
        weekdays         = excluded.weekdays,
        episodes_per_run = excluded.episodes_per_run,
        watch_time       = excluded.watch_time,
        active           = excluded.active`,
    userId,
    showId,
    weekdays,
    perRun,
    time,
    plan.active === false ? 0 : 1,
  );

  return getPlan(userId, showId);
}

/**
 * Entfernt einen Plan. Bereits abgehakte Folgen bleiben abgehakt – der Plan
 * hat sie ja tatsächlich gesehen gemacht.
 *
 * @param {number} userId
 * @param {number} showId
 * @returns {boolean} ob es einen gab
 */
export function deletePlan(userId, showId) {
  const result = run(
    'DELETE FROM watch_plans WHERE user_id = ? AND show_id = ?',
    userId,
    showId,
  );

  return result.changes > 0;
}

/**
 * Alle Pläne eines Kontos, für die Übersicht.
 *
 * @param {number} userId
 * @returns {object[]}
 */
export function listPlans(userId) {
  return all(
    `SELECT p.*, s.title, s.poster_path, s.media_type
       FROM watch_plans p
       JOIN shows s ON s.id = p.show_id
      WHERE p.user_id = ?
      ORDER BY s.title COLLATE NOCASE`,
    userId,
  ).map((row) => ({
    showId: row.show_id,
    title: row.title,
    posterPath: row.poster_path,
    mediaType: row.media_type,
    weekdays: parseWeekdays(row.weekdays),
    episodesPerRun: row.episodes_per_run,
    time: row.watch_time ?? null,
    active: Boolean(row.active),
    lastRunOn: row.last_run_on,
  }));
}

// ===========================================================================
// Das automatische Abhaken
// ===========================================================================

/**
 * Die nächsten ungesehenen Folgen einer Serie.
 *
 * Specials (Staffel 0) bleiben außen vor – sie gehören nicht in die laufende
 * Reihenfolge, und der Fortschritt wäre sonst sofort über 100 %.
 *
 * Noch nicht ausgestrahlte Folgen ebenfalls nicht: Was es noch nicht gibt,
 * kann man nicht gesehen haben.
 *
 * @param {number} userId
 * @param {number} showId
 * @param {number} limit
 * @returns {object[]}
 */
export function nextUnwatched(userId, showId, limit) {
  return all(
    // runtime: Aus den Laufzeiten dieser Folgen ergibt sich, wie lange ein
    // Termin mit Uhrzeit dauert (blockMinutes).
    `SELECT e.id, e.season_number, e.episode_number, e.name, e.runtime
       FROM episodes e
      WHERE e.show_id = ?
        AND e.season_number > 0
        AND (e.air_date IS NULL OR e.air_date <= date('now'))
        AND NOT EXISTS (
          SELECT 1 FROM watched_episodes w
           WHERE w.user_id = ? AND w.episode_id = e.id
        )
      ORDER BY e.season_number, e.episode_number
      LIMIT ?`,
    showId,
    userId,
    limit,
  );
}

/**
 * Zählt, wie viele Plantage zwischen zwei Daten liegen.
 *
 * Gebraucht fürs Nachholen: War der Server von Freitag bis Mittwoch aus und
 * der Plan läuft montags und donnerstags, sind zwei Termine ausgefallen.
 *
 * @param {number[]} weekdays 1–7
 * @param {string} nach   Ausschließend – der Tag des letzten Laufs
 * @param {string} bis    Einschließend – heute
 * @returns {number}
 */
export function countDueDays(weekdays, nach, bis) {
  const start = new Date(`${nach}T00:00:00`);
  const ende = new Date(`${bis}T00:00:00`);

  let treffer = 0;

  // Am Tag nach dem letzten Lauf beginnen – dieser Tag ist ja erledigt.
  const cursor = new Date(start);
  cursor.setDate(cursor.getDate() + 1);

  // Eine Schranke gegen einen kaputten Datumswert: Mehr als ein Jahr
  // rückwärts zu zählen hätte ohnehin keinen Sinn.
  let schritte = 0;

  while (cursor <= ende && schritte < 400) {
    if (weekdays.includes(isoWeekday(cursor))) treffer++;

    cursor.setDate(cursor.getDate() + 1);
    schritte++;
  }

  return treffer;
}

/**
 * Führt alle fälligen Sehpläne aus.
 *
 * Wird beim Start und danach stündlich aufgerufen. Der Schutz gegen doppelte
 * Läufe ist `last_run_on`: Ein Plan läuft je Tag höchstens einmal, egal wie
 * oft diese Funktion aufgerufen wird.
 *
 * @param {object} [opts]
 * @param {string} [opts.today] Für Tests
 * @param {string} [opts.now]   Uhrzeit "HH:MM", für Tests
 * @returns {{plans: number, episodes: number, details: object[]}}
 */
export function runDuePlans(opts = {}) {
  const tag = opts.today || heute();
  const uhrzeit = opts.now || jetzt();
  const heuteWochentag = isoWeekday(new Date(`${tag}T00:00:00`));

  const plans = all(
    `SELECT p.*, s.title, s.runtime AS show_runtime
       FROM watch_plans p
       JOIN shows s ON s.id = p.show_id
      WHERE p.active = 1
        -- Heute noch nicht gelaufen.
        AND (p.last_run_on IS NULL OR p.last_run_on < ?)`,
    tag,
  );

  let episodenGesamt = 0;
  const details = [];

  for (const plan of plans) {
    const weekdays = parseWeekdays(plan.weekdays);
    if (weekdays.length === 0) continue;

    // Wie viele Termine sind abzuarbeiten? Heute selbst zählt nur, wenn heute
    // ein Plantag ist – und bei einem Plan mit Uhrzeit erst, wenn der Termin
    // vorbei ist: "Um 20:15 zwei Folgen" heißt, dass sie gegen 22 Uhr gesehen
    // sind, nicht schon ab Mitternacht davor. Wie lange der Termin geht,
    // ergibt sich aus der Länge genau der Folgen, die dran sind.
    let heuteFaellig = weekdays.includes(heuteWochentag);

    if (heuteFaellig && plan.watch_time) {
      const dauer = blockMinutes(
        nextUnwatched(plan.user_id, plan.show_id, plan.episodes_per_run),
        plan.show_runtime,
      );
      // Endet der Termin nach Mitternacht, ist er heute nie vorbei – dann
      // holt ihn morgen das Nachholen unten ab.
      heuteFaellig = toMinutes(uhrzeit) >= toMinutes(plan.watch_time) + dauer;
    }

    let termine = heuteFaellig ? 1 : 0;

    // Dazu versäumte Termine seit dem letzten Lauf, bis gestern gezählt.
    const gestern = new Date(`${tag}T00:00:00`);
    gestern.setDate(gestern.getDate() - 1);
    const gestrigISO = isoTag(gestern);

    if (plan.last_run_on && plan.last_run_on < gestrigISO) {
      termine += countDueDays(weekdays, plan.last_run_on, gestrigISO);
    }

    if (termine === 0) continue;

    // Bis wann gilt dieser Lauf? Steht heute noch ein Termin mit Uhrzeit aus,
    // nur bis gestern – sonst fiele der heutige Termin weg, sobald versäumte
    // nachgeholt wurden.
    const heuteOffen = weekdays.includes(heuteWochentag) && !heuteFaellig;
    const laufTag = heuteOffen ? gestrigISO : tag;

    // Nach einem langen Ausfall nicht eine halbe Staffel auf einmal abhaken.
    termine = Math.min(termine, MAX_CATCH_UP);

    const folgen = nextUnwatched(plan.user_id, plan.show_id, termine * plan.episodes_per_run);

    // Nichts mehr zu sehen? Dann trotzdem den Lauf vermerken, sonst versucht
    // es der Plan jede Stunde erneut.
    if (folgen.length === 0) {
      run('UPDATE watch_plans SET last_run_on = ? WHERE id = ?', laufTag, plan.id);
      continue;
    }

    transaction(() => {
      for (const folge of folgen) {
        run(
          `INSERT INTO watched_episodes (user_id, episode_id, show_id)
           VALUES (?,?,?)
           ON CONFLICT(user_id, episode_id) DO NOTHING`,
          plan.user_id,
          folge.id,
          plan.show_id,
        );
      }

      // Sobald die erste Folge abgehakt ist, schaut man die Serie – der
      // Status "will ich sehen" stimmt dann nicht mehr.
      run(
        `UPDATE library
            SET status = 'watching', updated_at = datetime('now')
          WHERE user_id = ? AND show_id = ? AND status = 'watchlist'`,
        plan.user_id,
        plan.show_id,
      );

      run('UPDATE watch_plans SET last_run_on = ? WHERE id = ?', laufTag, plan.id);
    });

    episodenGesamt += folgen.length;

    details.push({
      userId: plan.user_id,
      showId: plan.show_id,
      title: plan.title,
      episodes: folgen.length,
    });
  }

  if (episodenGesamt > 0) {
    console.log(
      `[plan] ${episodenGesamt} Folge${episodenGesamt === 1 ? '' : 'n'} nach Sehplan abgehakt.`,
    );
  }

  return { plans: details.length, episodes: episodenGesamt, details };
}

/**
 * Die nächsten Termine eines Plans – für den Kalender.
 *
 * @param {number[]} weekdays
 * @param {number} anzahl Wie viele Termine voraus
 * @param {string} [ab] Startdatum, Vorgabe heute
 * @returns {string[]} ISO-Tage
 */
export function nextOccurrences(weekdays, anzahl, ab) {
  if (weekdays.length === 0) return [];

  const cursor = new Date(`${ab || heute()}T00:00:00`);
  const tage = [];

  // Höchstens ein Jahr vorausschauen – bei einem Plan mit einem Tag pro Woche
  // sind das 52 Termine, mehr braucht kein Kalender.
  for (let i = 0; i < 366 && tage.length < anzahl; i++) {
    if (weekdays.includes(isoWeekday(cursor))) {
      const monat = String(cursor.getMonth() + 1).padStart(2, '0');
      const tag = String(cursor.getDate()).padStart(2, '0');

      tage.push(`${cursor.getFullYear()}-${monat}-${tag}`);
    }

    cursor.setDate(cursor.getDate() + 1);
  }

  return tage;
}
