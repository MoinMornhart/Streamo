/**
 * ---------------------------------------------------------------------------
 * tests/until.test.mjs – "Verfügbar bis": wann ein Titel eine Plattform verlässt
 * ---------------------------------------------------------------------------
 * Ausführen:  npm run test:until
 *
 * Vorweg das Wichtigste: TMDB liefert kein Ablaufdatum. Je Anbieter kommen
 * genau vier Felder zurück – logo_path, provider_id, provider_name und
 * display_priority. Bekannt wird ein Enddatum also nur, wenn es jemand
 * einträgt, etwa aus dem Hinweis "Letzter Tag" beim Anbieter.
 *
 * Der Test, auf den es hier vor allem ankommt, steht im Abschnitt "Überlebt es
 * einen Abgleich?": src/store.js -> saveAvailability() räumt bei jedem Lauf
 * erst alle Zeilen des Titels weg und schreibt sie neu. Läge das Datum in
 * derselben Tabelle, wäre es stündlich verschwunden – und zwar lautlos.
 *
 * Der zweite wichtige Punkt ist der Umgang mit abgelaufenen Angaben. Steht ein
 * Titel nach dem genannten Tag immer noch beim Anbieter, war die Angabe falsch
 * oder wurde verlängert. Dann darf nichts angezeigt werden: Ein stiller
 * Fehlalarm ("nur noch heute!") ist schlimmer als gar keine Angabe.
 * ---------------------------------------------------------------------------
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamo-until-'));
process.env.DATA_DIR = tempDir;

const { db, run, get } = await import('../src/db.js');
const { buildAvailabilityView, saveAvailability } = await import('../src/store.js');

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

/**
 * Ein Datum, das eine bestimmte Anzahl Tage in der Zukunft liegt.
 * @param {number} days negativ = Vergangenheit
 * @returns {string} "YYYY-MM-DD"
 */
const tagIn = (days) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

console.log('\nStreamo – Verfügbar bis\n');

// ===========================================================================
// Ausgangslage
// ===========================================================================

run("INSERT INTO shows (tmdb_id, media_type, title) VALUES (1396,'tv','Breaking Bad')");
const showId = get('SELECT id FROM shows WHERE tmdb_id = 1396').id;

// Genau die Form, die der Abgleich schreibt.
const vomAbgleich = {
  link: 'https://justwatch.example',
  flatrate: [
    { provider_id: 8, provider_name: 'Netflix' },
    { provider_id: 337, provider_name: 'Disney+' },
  ],
};

saveAvailability(showId, 'DE', vomAbgleich);

/** Kurzform: die Ansicht aus Sicht von jemandem mit Netflix-Abo. */
const ansicht = () => buildAvailabilityView(showId, 'DE', new Set([8]));

/** Das Angebot eines bestimmten Anbieters aus der Ansicht ziehen. */
const angebot = (view, providerId) =>
  view.offers.flatrate.find((entry) => entry.provider_id === providerId);

// ===========================================================================
// Ohne Eintrag
// ===========================================================================
console.log('Solange niemand etwas eingetragen hat');

let view = ansicht();

check('steht am Angebot kein Datum', angebot(view, 8).availableUntil, null);
check('und keine Restlaufzeit', angebot(view, 8).daysLeft, null);
check('die Kachel bekommt nichts angehängt', view.expiring, null);

// ===========================================================================
// Ein Datum eintragen
// ===========================================================================
console.log('\nMit eingetragenem Datum');

run(
  'INSERT INTO availability_until (show_id, region, provider_id, available_until) VALUES (?,?,?,?)',
  showId,
  'DE',
  8,
  tagIn(5),
);

view = ansicht();

check('steht es am richtigen Anbieter', angebot(view, 8).availableUntil, tagIn(5));
check('mit fünf verbleibenden Tagen', angebot(view, 8).daysLeft, 5);
check('der andere Anbieter bleibt unberührt', angebot(view, 337).availableUntil, null);

check('die Kachel bekommt es oben angehängt', view.expiring?.daysLeft, 5);
check('samt Anbieternamen', view.expiring?.providerName, 'Netflix');
check('und dem Hinweis, dass es das eigene Abo ist', view.expiring?.subscribed, true);

// ===========================================================================
// Der eigentliche Grund für die eigene Tabelle
// ===========================================================================
console.log('\nÜberlebt es einen Abgleich?');

// Genau das passiert stündlich: erst alles löschen, dann neu schreiben.
saveAvailability(showId, 'DE', vomAbgleich);

view = ansicht();

check('das Datum ist noch da', angebot(view, 8).availableUntil, tagIn(5));
check('und die Restlaufzeit stimmt weiterhin', angebot(view, 8).daysLeft, 5);

// ===========================================================================
// Abgelaufen
// ===========================================================================
console.log('\nWenn der Tag vorbei ist');

run('UPDATE availability_until SET available_until = ? WHERE show_id = ?', tagIn(-1), showId);

view = ansicht();

check('wird die Angabe übergangen', angebot(view, 8).availableUntil, null);
check('nichts auf der Kachel', view.expiring, null);
check(
  'der Eintrag bleibt aber stehen, statt gelöscht zu werden',
  get('SELECT COUNT(*) AS count FROM availability_until').count,
  1,
);

console.log('\nHeute ist der letzte Tag');

run('UPDATE availability_until SET available_until = ? WHERE show_id = ?', tagIn(0), showId);

view = ansicht();

check('noch sichtbar', angebot(view, 8).availableUntil, tagIn(0));
check('mit null Tagen – die Anzeige macht daraus "Letzter Tag"', angebot(view, 8).daysLeft, 0);

// ===========================================================================
// Mehrere Anbieter
// ===========================================================================
console.log('\nMehrere Anbieter mit Datum');

run('UPDATE availability_until SET available_until = ? WHERE show_id = ?', tagIn(20), showId);
run(
  'INSERT INTO availability_until (show_id, region, provider_id, available_until) VALUES (?,?,?,?)',
  showId,
  'DE',
  337,
  tagIn(3),
);

view = ansicht();

check(
  'auf der Kachel steht der dringendste',
  view.expiring?.daysLeft,
  3,
);
check('das ist hier Disney+', view.expiring?.providerName, 'Disney+');
check('beide stehen weiterhin am jeweiligen Angebot', [
  angebot(view, 8).daysLeft,
  angebot(view, 337).daysLeft,
], [20, 3]);

// ===========================================================================
// Regionen
// ===========================================================================
console.log('\nRegionen bleiben getrennt');

// Dieselbe Serie in Österreich – dort ist nichts eingetragen.
saveAvailability(showId, 'AT', vomAbgleich);

const oesterreich = buildAvailabilityView(showId, 'AT', new Set([8]));

check(
  'das deutsche Datum gilt nicht in Österreich',
  oesterreich.offers.flatrate.every((entry) => entry.availableUntil === null),
  true,
);
check('und dort erscheint nichts auf der Kachel', oesterreich.expiring, null);

// ===========================================================================
// Aufräumen
// ===========================================================================
console.log('\nWenn der Titel verschwindet');

run('DELETE FROM shows WHERE id = ?', showId);

check(
  'gehen die Einträge mit – kein verwaister Rest',
  get('SELECT COUNT(*) AS count FROM availability_until').count,
  0,
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
