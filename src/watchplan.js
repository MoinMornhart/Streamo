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

  run(
    `INSERT INTO watch_plans (user_id, show_id, weekdays, episodes_per_run, active)
     VALUES (?,?,?,?,?)
     ON CONFLICT(user_id, show_id) DO UPDATE SET
        weekdays         = excluded.weekdays,
        episodes_per_run = excluded.episodes_per_run,
        active           = excluded.active`,
    userId,
    showId,
    weekdays,
    perRun,
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
    `SELECT e.id, e.season_number, e.episode_number, e.name
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
 * @returns {{plans: number, episodes: number, details: object[]}}
 */
export function runDuePlans(opts = {}) {
  const tag = opts.today || heute();
  const heuteWochentag = isoWeekday(new Date(`${tag}T00:00:00`));

  const plans = all(
    `SELECT p.*, s.title
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
    // ein Plantag ist; dazu kommen versäumte Termine seit dem letzten Lauf.
    let termine = weekdays.includes(heuteWochentag) ? 1 : 0;

    if (plan.last_run_on) {
      // Bis gestern zählen – heute ist oben schon berücksichtigt.
      const gestern = new Date(`${tag}T00:00:00`);
      gestern.setDate(gestern.getDate() - 1);

      const gestrigISO = gestern.toISOString().slice(0, 10);

      if (plan.last_run_on < gestrigISO) {
        termine += countDueDays(weekdays, plan.last_run_on, gestrigISO);
      }
    }

    if (termine === 0) continue;

    // Nach einem langen Ausfall nicht eine halbe Staffel auf einmal abhaken.
    termine = Math.min(termine, MAX_CATCH_UP);

    const folgen = nextUnwatched(plan.user_id, plan.show_id, termine * plan.episodes_per_run);

    // Nichts mehr zu sehen? Dann trotzdem den Lauf vermerken, sonst versucht
    // es der Plan jede Stunde erneut.
    if (folgen.length === 0) {
      run('UPDATE watch_plans SET last_run_on = ? WHERE id = ?', tag, plan.id);
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

      run('UPDATE watch_plans SET last_run_on = ? WHERE id = ?', tag, plan.id);
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
