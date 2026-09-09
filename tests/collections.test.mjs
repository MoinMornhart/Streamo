/**
 * ---------------------------------------------------------------------------
 * tests/collections.test.mjs – Filmreihen
 * ---------------------------------------------------------------------------
 * Ausführen:  npm run test:collections
 *
 * Geprüft werden beide Arten von Reihen:
 *
 *   Offizielle (von TMDB) – hier mit einer festen Antwort statt eines echten
 *   Aufrufs, damit der Test ohne API-Key und ohne Netzwerk läuft. Wichtig ist
 *   vor allem die Sortierung nach Erscheinungsdatum und dass ein zweiter
 *   Durchlauf nichts verdoppelt.
 *
 *   Eigene – anlegen, Titel aufnehmen, umsortieren, entfernen. Und die Frage,
 *   ob fremde Reihen wirklich unsichtbar bleiben: Eine Vorwissen-Liste ist
 *   nichts, was andere Konten sehen sollen.
 * ---------------------------------------------------------------------------
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamo-coll-'));
process.env.DATA_DIR = tempDir;

const { db, run, get, all } = await import('../src/db.js');
const { upsertShow } = await import('../src/store.js');
const collections = await import('../src/collections.js');

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

console.log('\nStreamo – Filmreihen\n');

// ===========================================================================
// Ausgangslage
// ===========================================================================
run("INSERT INTO users (username, password_hash, region) VALUES ('anna','x:y','DE')");
run("INSERT INTO users (username, password_hash, region) VALUES ('bert','x:y','DE')");

const anna = get("SELECT id FROM users WHERE username='anna'").id;
const bert = get("SELECT id FROM users WHERE username='bert'").id;

const ctx = { userId: anna, region: 'DE' };

// ===========================================================================
// Offizielle Reihe
// ===========================================================================
console.log('Offizielle Reihe von TMDB');

// Die Antwort von /collection/{id} nachgestellt – absichtlich in falscher
// Reihenfolge, damit die Sortierung nach Erscheinungsdatum etwas zu tun hat.
const kingsman = {
  id: 391860,
  name: 'Kingsman Filmreihe',
  overview: 'Ein britischer Geheimdienst.',
  poster_path: '/kingsman.jpg',
  backdrop_path: '/kingsman-bg.jpg',
  parts: [
    { id: 343668, title: 'Kingsman: The Golden Circle', release_date: '2017-09-20', runtime: 141 },
    { id: 207703, title: 'Kingsman: The Secret Service', release_date: '2014-12-13', runtime: 129 },
    { id: 476669, title: 'The King’s Man', release_date: '2021-12-22', runtime: 131 },
  ],
};

// Die Antwort wird direkt uebergeben, statt sie bei TMDB zu holen. Der Rest
// der Funktion – Sortierung, Speichern, Verknuepfen – laeuft unveraendert,
// und der Test braucht weder Netzwerk noch API-Key.
const collection = await collections.ensureOfficialCollection(391860, {
  region: 'DE',
  language: 'de-DE',
  data: kingsman,
});

check('Die Reihe wurde angelegt', collection.name, 'Kingsman Filmreihe');
check('Sie ist als offiziell erkennbar', collection.user_id, null);
check('Die TMDB-Kennung ist hinterlegt', collection.tmdb_id, 391860);

const loaded = collections.getCollection(collection.id, ctx);

check('Alle drei Teile sind drin', loaded.items.length, 3);
check(
  'Nach Erscheinungsdatum sortiert, nicht in der Reihenfolge der Antwort',
  loaded.items.map((i) => i.year),
  ['2014', '2017', '2021'],
);
check('Der erste Teil steht vorn', loaded.items[0].title, 'Kingsman: The Secret Service');
check('Gesamtlaufzeit aufaddiert', loaded.totalRuntime, 401);
check('Noch nichts gesehen', loaded.progress.watched, 0);
check('Eine offizielle Reihe ist nicht änderbar', loaded.isCustom, false);

// Ein zweiter Durchlauf darf nichts verdoppeln – der Abgleich läuft ja
// regelmäßig über dieselben Reihen.
await collections.ensureOfficialCollection(391860, {
  region: 'DE',
  language: 'de-DE',
  data: kingsman,
});

check('Kein zweiter Eintrag der Reihe', all('SELECT * FROM collections').length, 1);
check('Und keine doppelten Teile', all('SELECT * FROM collection_items').length, 3);

console.log('\nFortschritt');

// Anna nimmt den ersten Teil in ihre Bibliothek und hakt ihn ab.
const firstPart = get('SELECT id FROM shows WHERE tmdb_id = 207703');
run(
  "INSERT INTO library (user_id, show_id, status) VALUES (?,?,'completed')",
  anna,
  firstPart.id,
);

const withProgress = collections.getCollection(collection.id, ctx);
check('Ein Teil zählt als gesehen', withProgress.progress.watched, 1);
check('Das sind 33 Prozent', withProgress.progress.percent, 33);
check('Der Eintrag ist als gesehen markiert', withProgress.items[0].watched, true);
check('Und als in der Bibliothek', withProgress.items[0].inLibrary, true);
check('Die anderen nicht', withProgress.items[1].inLibrary, false);

console.log('\nÜbersicht');

// Offizielle Reihen erscheinen nur, wenn man mindestens einen Teil besitzt –
// sonst stünden dort alle je abgerufenen Reihen.
check('Anna sieht die Reihe', collections.listCollections(anna).length, 1);
check('Bert nicht, er besitzt keinen Teil', collections.listCollections(bert).length, 0);

console.log('\nZugehörigkeit eines Films');

const belongs = collections.findCollectionForShow(firstPart.id, anna);
check('Der Film kennt seine Reihe', belongs?.name, 'Kingsman Filmreihe');
check('Und weiß, der wievielte Teil er ist', [belongs?.part, belongs?.total], [1, 3]);

// ===========================================================================
// Eigene Reihe
// ===========================================================================
console.log('\nEigene Reihe');

const custom = collections.createCustomCollection(anna, {
  name: 'Vorwissen für Spider-Man: Brand New Day',
  description: 'Was man vorher gesehen haben sollte.',
});

check('Sie wurde angelegt', custom.name, 'Vorwissen für Spider-Man: Brand New Day');
check('Und gehört Anna', custom.user_id, anna);

const detail = collections.getCollection(custom.id, ctx);
check('Sie ist als eigene erkennbar', detail.isCustom, true);
check('Und zunächst leer', detail.items.length, 0);

// Drei Filme aufnehmen.
const filme = [
  { id: 634649, title: 'Spider-Man: No Way Home', release_date: '2021-12-15' },
  { id: 429617, title: 'Spider-Man: Far From Home', release_date: '2019-06-28' },
  { id: 315635, title: 'Spider-Man: Homecoming', release_date: '2017-07-05' },
];

for (const film of filme) {
  const show = upsertShow(film, 'movie');
  collections.addItem(custom.id, show.id, `Hinweis zu ${film.title}`);
}

const filled = collections.getCollection(custom.id, ctx);
check('Drei Titel aufgenommen', filled.items.length, 3);
check(
  'In der Reihenfolge des Aufnehmens, nicht nach Datum',
  filled.items.map((i) => i.title),
  ['Spider-Man: No Way Home', 'Spider-Man: Far From Home', 'Spider-Man: Homecoming'],
);
check('Die Notiz ist gespeichert', filled.items[0].note, 'Hinweis zu Spider-Man: No Way Home');

console.log('\nUmsortieren');

// Chronologisch umsortieren – genau das ist der Zweck einer Vorwissen-Liste.
const chronological = [
  filled.items[2].showId, // Homecoming
  filled.items[1].showId, // Far From Home
  filled.items[0].showId, // No Way Home
];

check('Drei Einträge neu einsortiert', collections.reorderItems(custom.id, chronological), 3);

const reordered = collections.getCollection(custom.id, ctx);
check(
  'Jetzt in der gewünschten Ordnung',
  reordered.items.map((i) => i.title),
  ['Spider-Man: Homecoming', 'Spider-Man: Far From Home', 'Spider-Man: No Way Home'],
);
check('Die Positionen sind lückenlos', reordered.items.map((i) => i.position), [0, 1, 2]);

console.log('\nEntfernen');

check('Ein Titel wird entfernt', collections.removeItem(custom.id, reordered.items[1].showId), true);
check('Zwei bleiben übrig', collections.getCollection(custom.id, ctx).items.length, 2);
check(
  'Ein zweites Entfernen meldet, dass nichts da war',
  collections.removeItem(custom.id, reordered.items[1].showId),
  false,
);

console.log('\nSichtbarkeit');

// Eine Vorwissen-Liste ist privat.
check(
  'Bert kann Annas Reihe nicht öffnen',
  collections.getCollection(custom.id, { userId: bert, region: 'DE' }),
  null,
);
check(
  'Und sie steht nicht in seiner Übersicht',
  collections.listCollections(bert).some((c) => c.id === custom.id),
  false,
);
check(
  'Bert kann sie auch nicht ändern',
  collections.getEditableCollection(custom.id, bert),
  null,
);
check(
  'Offizielle Reihen sind für niemanden änderbar',
  collections.getEditableCollection(collection.id, anna),
  null,
);

console.log('\nTeilen');

const token = collections.shareCollection(custom.id);

check('Ein Token wird vergeben', typeof token === 'string' && token.length > 20, true);
check(
  'Erneutes Teilen liefert denselben Link – verschickte Links bleiben gültig',
  collections.shareCollection(custom.id),
  token,
);
check(
  'Mit renew entsteht ein neuer, der alte ist damit entwertet',
  collections.shareCollection(custom.id, true) !== token,
  true,
);

const currentToken = get('SELECT share_token FROM collections WHERE id = ?', custom.id).share_token;
const shared = collections.getSharedCollection(currentToken);

check('Die geteilte Liste ist abrufbar', shared?.name, 'Vorwissen für Spider-Man: Brand New Day');
check('Mit ihren Titeln', shared?.items.length, 2);
check('Und den Notizen', Boolean(shared?.items[0].note), true);

// Datenschutz: Wer einen Link weitergibt, teilt eine Liste – nicht seinen
// Sehverlauf. Diese Felder dürfen in der öffentlichen Antwort nicht auftauchen.
check('Sie verrät nicht, wem sie gehört', shared?.userId, undefined);
check('Und nicht, was der Ersteller gesehen hat', shared?.items[0].watched, undefined);
check('Und nicht, was in seiner Bibliothek steht', shared?.items[0].inLibrary, undefined);
check('Und nicht, welche Abos er hat', shared?.items[0].availability, undefined);

check('Ein unbekannter Token ergibt nichts', collections.getSharedCollection('erfunden'), null);
check('Ein leerer Token auch nicht', collections.getSharedCollection(''), null);

collections.unshareCollection(custom.id);
check(
  'Nach dem Widerruf führt der Link ins Leere',
  collections.getSharedCollection(currentToken),
  null,
);

console.log('\nLöschen eines Kontos');

run('DELETE FROM users WHERE id = ?', anna);

check('Annas eigene Reihe ist weg', all('SELECT * FROM collections WHERE user_id IS NOT NULL').length, 0);
check(
  'Die offizielle bleibt – sie gehört niemandem',
  all('SELECT * FROM collections WHERE user_id IS NULL').length,
  1,
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
