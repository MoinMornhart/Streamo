/**
 * ---------------------------------------------------------------------------
 * tests/watchplan.test.mjs – Sehpläne
 * ---------------------------------------------------------------------------
 * Ausführen:  npm run test:watchplan
 *
 * Ein Sehplan hakt Folgen von selbst ab. Das ist bequem, solange er das
 * Richtige tut – und ärgerlich, sobald er danebengreift: Einen falsch
 * gesetzten Haken merkt man erst, wenn man vor der übersprungenen Folge
 * sitzt. Deshalb liegt der Schwerpunkt hier auf den Fällen, in denen etwas
 * schiefgehen könnte.
 *
 * Die drei wichtigsten:
 *
 *   1. Der Plan darf pro Tag nur EINMAL laufen. Aufgerufen wird er stündlich;
 *      ohne Schutz wären am Abend 24 Folgen abgehakt.
 *
 *   2. "Falls man mehr schaut, geht das auch." Wer von Hand vorausschaut,
 *      darf am nächsten Plantag nicht dieselben Folgen noch einmal bekommen.
 *      Deshalb merkt sich der Plan NICHT, wo er steht, sondern nimmt jedes
 *      Mal die nächsten ungesehenen.
 *
 *   3. Nachholen mit Maß. War der Server eine Woche aus, sollen die
 *      versäumten Termine nachgeholt werden – aber nicht alle auf einmal,
 *      sonst steht nach dem Urlaub eine halbe Staffel als gesehen da.
 * ---------------------------------------------------------------------------
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamo-plan-'));
process.env.DATA_DIR = tempDir;

const { db, run, get } = await import('../src/db.js');
const plan = await import('../src/watchplan.js');

let failures = 0;
let checks = 0;

/**
 * Vergleicht zwei Werte strukturell.
 * @param {string} label
 * @param {any} actual
 * @param {any} expected
 */
function check(label, actual, expected) {
  checks++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    `${ok ? '  ok  ' : '  FAIL'} ${label}` +
      (ok
        ? ''
        : `\n        erwartet: ${JSON.stringify(expected)}\n        erhalten: ${JSON.stringify(actual)}`),
  );
}

console.log('\nStreamo – Sehpläne\n');

// ===========================================================================
// Ausgangslage: eine Serie mit zwanzig Folgen
// ===========================================================================

run("INSERT INTO users (username, password_hash) VALUES ('morni','x:y')");
const morni = get("SELECT id FROM users WHERE username='morni'").id;

run("INSERT INTO shows (tmdb_id, media_type, title) VALUES (1396,'tv','Breaking Bad')");
const showId = get('SELECT id FROM shows WHERE tmdb_id = 1396').id;

run("INSERT INTO library (user_id, show_id, status) VALUES (?,?,'watchlist')", morni, showId);

// Zwanzig Folgen in zwei Staffeln, alle längst ausgestrahlt.
for (let staffel = 1; staffel <= 2; staffel++) {
  for (let folge = 1; folge <= 10; folge++) {
    run(
      `INSERT INTO episodes (show_id, tmdb_id, season_number, episode_number, name, air_date)
       VALUES (?,?,?,?,?, '2020-01-01')`,
      showId,
      staffel * 100 + folge,
      staffel,
      folge,
      `S${staffel}E${folge}`,
    );
  }
}

// Ein Special – es darf NIE angefasst werden.
run(
  `INSERT INTO episodes (show_id, tmdb_id, season_number, episode_number, name, air_date)
   VALUES (?,?,0,1,'Special','2020-01-01')`,
  showId,
  999,
);

// Eine Folge, die es noch gar nicht gibt.
run(
  `INSERT INTO episodes (show_id, tmdb_id, season_number, episode_number, name, air_date)
   VALUES (?,?,3,1,'Zukunft','2099-01-01')`,
  showId,
  998,
);

/** Wie viele Folgen gelten als gesehen? */
const gesehen = () =>
  get('SELECT COUNT(*) AS count FROM watched_episodes WHERE user_id = ?', morni).count;

/** Die zuletzt abgehakte Folge, als "SxEy". */
const letzte = () => {
  const row = get(
    `SELECT e.season_number, e.episode_number
       FROM watched_episodes w
       JOIN episodes e ON e.id = w.episode_id
      WHERE w.user_id = ?
      ORDER BY e.season_number DESC, e.episode_number DESC
      LIMIT 1`,
    morni,
  );

  return row ? `S${row.season_number}E${row.episode_number}` : null;
};

// ===========================================================================
// Wochentage
// ===========================================================================
console.log('Wochentage');

check('Doppelte und Reihenfolge werden geglättet', plan.normalizeWeekdays([4, 1, 1]), '1,4');
check('Unsinn fällt weg', plan.normalizeWeekdays([0, 3, 9, 'x']), '3');
check('Zurücklesen ergibt Zahlen', plan.parseWeekdays('1,4'), [1, 4]);
check('Eine leere Liste bleibt leer', plan.parseWeekdays(''), []);

// ===========================================================================
// Anlegen
// ===========================================================================
console.log('\nAnlegen');

let threw = null;
try {
  plan.savePlan(morni, showId, { weekdays: [], episodesPerRun: 2 });
} catch (error) {
  threw = error.message;
}
check('Ohne Wochentag geht es nicht', threw, 'Wähle mindestens einen Wochentag.');

threw = null;
try {
  plan.savePlan(morni, showId, { weekdays: [1], episodesPerRun: 0 });
} catch (error) {
  threw = error.message;
}
check('Null Folgen ergeben keinen Plan', threw, 'Zwischen 1 und 20 Folgen je Termin.');

// Montags zwei Folgen.
const gespeichert = plan.savePlan(morni, showId, { weekdays: [1], episodesPerRun: 2 });

check('Der Plan steht', gespeichert.weekdays, [1]);
check('mit zwei Folgen', gespeichert.episodesPerRun, 2);
check('und ist aktiv', gespeichert.active, true);
check('Noch nie gelaufen', gespeichert.lastRunOn, null);

// ===========================================================================
// Der Lauf
// ===========================================================================
console.log('\nEin Montag');

// Ein fester Montag, damit der Test nicht vom Wochentag abhängt, an dem er
// zufällig ausgeführt wird.
const MONTAG = '2026-09-07';
const DIENSTAG = '2026-09-08';
const MONTAG_DRAUF = '2026-09-14';

let ergebnis = plan.runDuePlans({ today: MONTAG });

check('Ein Plan lief', ergebnis.plans, 1);
check('Zwei Folgen abgehakt', ergebnis.episodes, 2);
check('Es sind zwei', gesehen(), 2);
check('nämlich die ersten beiden', letzte(), 'S1E2');

check(
  'Der Status wechselt auf "Schaue ich"',
  get('SELECT status FROM library WHERE user_id = ? AND show_id = ?', morni, showId).status,
  'watching',
);

console.log('\nDerselbe Tag noch einmal');

// Aufgerufen wird stündlich – ohne Schutz wären am Abend 24 Folgen weg.
ergebnis = plan.runDuePlans({ today: MONTAG });

check('läuft nicht noch einmal', ergebnis.episodes, 0);
check('es bleiben zwei', gesehen(), 2);

console.log('\nEin Dienstag');

ergebnis = plan.runDuePlans({ today: DIENSTAG });

check('An einem Tag ohne Plan passiert nichts', ergebnis.episodes, 0);
check('es bleiben zwei', gesehen(), 2);

// ===========================================================================
// "Falls man mehr schaut, geht das auch"
// ===========================================================================
console.log('\nWenn man zwischendurch selbst weiterschaut');

// Von Hand die nächsten drei abhaken – so, wie es die Oberfläche täte.
for (const folge of plan.nextUnwatched(morni, showId, 3)) {
  run(
    'INSERT INTO watched_episodes (user_id, episode_id, show_id) VALUES (?,?,?)',
    morni,
    folge.id,
    showId,
  );
}

check('Jetzt sind es fünf', gesehen(), 5);
check('zuletzt S1E5', letzte(), 'S1E5');

ergebnis = plan.runDuePlans({ today: MONTAG_DRAUF });

check('Am nächsten Montag läuft der Plan wieder', ergebnis.episodes, 2);
check(
  'und macht dort weiter, wo man steht – keine Wiederholung',
  letzte(),
  'S1E7',
);
check('insgesamt sieben', gesehen(), 7);

// ===========================================================================
// Nachholen
// ===========================================================================
console.log('\nNachholen nach einem Ausfall');

check(
  'Zwischen zwei Montagen liegt ein Plantag',
  plan.countDueDays([1], '2026-09-07', '2026-09-14'),
  1,
);
check(
  'In drei Wochen sind es drei',
  plan.countDueDays([1], '2026-09-07', '2026-09-28'),
  3,
);
check(
  'Bei zwei Tagen je Woche entsprechend mehr',
  plan.countDueDays([1, 4], '2026-09-07', '2026-09-21'),
  4,
);

// Der Server war einen Monat aus: letzter Lauf Mitte September, jetzt Mitte
// Oktober. Das wären fünf versäumte Montage.
run('UPDATE watch_plans SET last_run_on = ? WHERE user_id = ?', '2026-09-14', morni);

const vorher = gesehen();
ergebnis = plan.runDuePlans({ today: '2026-10-19' });

check(
  'Nachgeholt wird gedeckelt – nicht eine halbe Staffel auf einmal',
  ergebnis.episodes,
  6, // 3 Termine (Obergrenze) mal 2 Folgen
);
check('entsprechend gestiegen', gesehen(), vorher + 6);

// ===========================================================================
// Was nie angefasst werden darf
// ===========================================================================
console.log('\nWas außen vor bleibt');

// Alles bis auf Special und Zukunftsfolge abhaken – über viele Montage
// hinweg. Der Merker muss dabei vor JEDEM Lauf zurückgesetzt werden: Sonst
// greift (völlig richtig) die Tagessperre und es bliebe bei zwei Folgen.
for (let i = 0; i < 12; i++) {
  run('UPDATE watch_plans SET last_run_on = NULL WHERE user_id = ?', morni);
  plan.runDuePlans({ today: MONTAG });
}

const offen = plan.nextUnwatched(morni, showId, 50);

check('Nach genug Läufen sind alle regulären Folgen gesehen', gesehen(), 20);
check('Es bleibt nichts Abhakbares übrig', offen.length, 0);

check(
  'Das Special wurde nie angefasst',
  get(
    `SELECT COUNT(*) AS count FROM watched_episodes w
       JOIN episodes e ON e.id = w.episode_id
      WHERE w.user_id = ? AND e.season_number = 0`,
    morni,
  ).count,
  0,
);

check(
  'Die noch nicht ausgestrahlte Folge auch nicht',
  get(
    `SELECT COUNT(*) AS count FROM watched_episodes w
       JOIN episodes e ON e.id = w.episode_id
      WHERE w.user_id = ? AND e.air_date > date('now')`,
    morni,
  ).count,
  0,
);

console.log('\nWenn nichts mehr übrig ist');

run('UPDATE watch_plans SET last_run_on = NULL WHERE user_id = ?', morni);
ergebnis = plan.runDuePlans({ today: MONTAG });

check('läuft der Plan ins Leere, ohne Fehler', ergebnis.episodes, 0);
check(
  'vermerkt den Lauf aber trotzdem – sonst versucht er es jede Stunde erneut',
  plan.getPlan(morni, showId).lastRunOn,
  MONTAG,
);

// ===========================================================================
// Pausieren und Löschen
// ===========================================================================
console.log('\nPausieren');

plan.savePlan(morni, showId, { weekdays: [1], episodesPerRun: 2, active: false });
run('UPDATE watch_plans SET last_run_on = NULL WHERE user_id = ?', morni);

// Etwas zum Abhaken schaffen.
run('DELETE FROM watched_episodes WHERE user_id = ?', morni);

check('Ein pausierter Plan läuft nicht', plan.runDuePlans({ today: MONTAG }).episodes, 0);
check('nichts abgehakt', gesehen(), 0);

plan.savePlan(morni, showId, { weekdays: [1], episodesPerRun: 2, active: true });
check('Wieder eingeschaltet läuft er', plan.runDuePlans({ today: MONTAG }).episodes, 2);

console.log('\nDie nächsten Termine für den Kalender');

const termine = plan.nextOccurrences([1], 3, '2026-09-07');
check('drei Montage in Folge', termine, ['2026-09-07', '2026-09-14', '2026-09-21']);
check(
  'zwei Tage je Woche ergeben mehr Termine',
  plan.nextOccurrences([1, 4], 4, '2026-09-07'),
  ['2026-09-07', '2026-09-10', '2026-09-14', '2026-09-17'],
);
check('Ohne Wochentag gibt es keine', plan.nextOccurrences([], 3, '2026-09-07'), []);

console.log('\nLöschen');

check('Der Plan verschwindet', plan.deletePlan(morni, showId), true);
check('und ist danach weg', plan.getPlan(morni, showId), null);
check('Ein zweites Löschen meldet, dass nichts da war', plan.deletePlan(morni, showId), false);
check(
  'Abgehakte Folgen bleiben abgehakt – gesehen ist gesehen',
  gesehen() > 0,
  true,
);

// ===========================================================================
console.log('');
console.log(
  failures === 0
    ? `Alle ${checks} Prüfungen bestanden.\n`
    : `${failures} von ${checks} Prüfungen fehlgeschlagen.\n`,
);

db.close();
try {
  fs.rmSync(tempDir, { recursive: true, force: true });
} catch {
  /* Windows lässt geöffnete Dateien nicht löschen – unkritisch */
}

process.exit(failures === 0 ? 0 : 1);
