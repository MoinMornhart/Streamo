/**
 * ---------------------------------------------------------------------------
 * tests/friends.test.mjs – Freunde und gemeinsames Schauen
 * ---------------------------------------------------------------------------
 * Ausführen:  npm run test:friends
 *
 * Zwei Schwerpunkte:
 *
 *   1. Der Umgang mit Freundschaften: anfragen, annehmen, beenden. Besonders
 *      der Fall, dass sich zwei gleichzeitig anfragen – daraus soll keine
 *      doppelte Beziehung entstehen.
 *
 *   2. Die Vorschläge für einen gemeinsamen Abend. Das ist der eigentliche
 *      Zweck der Freundesliste, und die Regeln dahinter sind nicht trivial:
 *      Was beide wollen, was nur einer kennt, was der andere liebt – und
 *      immer nur das, was bei einem der beiden Abos auch läuft.
 *
 * Dazu kommt die Frage, wer was sehen darf. Ohne bestätigte Freundschaft
 * sieht niemand die Bibliothek eines anderen.
 * ---------------------------------------------------------------------------
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamo-friends-'));
process.env.DATA_DIR = tempDir;

const { db, run, get, all } = await import('../src/db.js');
const { upsertShow, saveAvailability } = await import('../src/store.js');
const friends = await import('../src/friends.js');

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

console.log('\nStreamo – Freunde\n');

// ===========================================================================
// Ausgangslage: drei Konten
// ===========================================================================
for (const name of ['anna', 'bert', 'carl']) {
  run("INSERT INTO users (username, password_hash, region) VALUES (?,'x:y','DE')", name);
}

const anna = get("SELECT id FROM users WHERE username='anna'").id;
const bert = get("SELECT id FROM users WHERE username='bert'").id;
const carl = get("SELECT id FROM users WHERE username='carl'").id;

// ===========================================================================
// Freundschaften
// ===========================================================================
console.log('Anfragen');

check(
  'Am Anfang kennt sich niemand',
  friends.getFriendshipStatus(anna, bert).status,
  'none',
);

const request = friends.requestFriendship(anna, bert);
check('Anna fragt Bert an', request.status, 'pending');

check(
  'Aus Annas Sicht ist die Anfrage ausgehend',
  friends.getFriendshipStatus(anna, bert).direction,
  'outgoing',
);
check(
  'Aus Berts Sicht eingehend',
  friends.getFriendshipStatus(bert, anna).direction,
  'incoming',
);

// Doppelte Anfragen und Selbstanfragen abweisen.
let error = null;
try {
  friends.requestFriendship(anna, bert);
} catch (e) {
  error = e.message;
}
check('Eine zweite Anfrage wird abgewiesen', Boolean(error), true);

error = null;
try {
  friends.requestFriendship(anna, anna);
} catch (e) {
  error = e.message;
}
check('Mit sich selbst befreundet man sich nicht', Boolean(error), true);

console.log('\nAnnehmen');

check('Bert nimmt an', friends.acceptFriendship(bert, anna), true);
check('Beide sind befreundet', friends.areFriends(anna, bert), true);
check('Und zwar in beide Richtungen', friends.areFriends(bert, anna), true);
check('Es bleibt bei EINER gespeicherten Zeile', all('SELECT * FROM friendships').length, 1);

check(
  'Ein Annehmen ohne offene Anfrage tut nichts',
  friends.acceptFriendship(carl, anna),
  false,
);

console.log('\nGleichzeitige Anfragen');

// Beide fragen einander an – daraus soll direkt eine Freundschaft werden,
// statt zweier Anfragen, die aufeinander warten.
friends.requestFriendship(anna, carl);
const mutual = friends.requestFriendship(carl, anna);

check('Die Gegenanfrage nimmt sofort an', mutual.status, 'accepted');
check('Anna und Carl sind befreundet', friends.areFriends(anna, carl), true);
check('Immer noch nur eine Zeile je Freundschaft', all('SELECT * FROM friendships').length, 2);

console.log('\nÜbersicht');

const annaList = friends.listFriends(anna);
check('Anna hat zwei Freunde', annaList.friends.length, 2);
check('Keine offenen Anfragen mehr', annaList.incoming.length + annaList.outgoing.length, 0);

// ===========================================================================
// Gemeinsames Schauen
// ===========================================================================
console.log('\nVorschläge für einen gemeinsamen Abend');

// Beide abonnieren Netflix; Bert zusätzlich Disney+.
run("INSERT INTO user_providers (user_id, provider_id, name) VALUES (?,8,'Netflix')", anna);
run("INSERT INTO user_providers (user_id, provider_id, name) VALUES (?,8,'Netflix')", bert);
run("INSERT INTO user_providers (user_id, provider_id, name) VALUES (?,337,'Disney Plus')", bert);

/**
 * Legt einen Titel an und macht ihn bei einem Anbieter verfügbar.
 * @param {number} tmdbId
 * @param {string} title
 * @param {number} providerId 0 = nirgends verfügbar
 * @returns {object}
 */
function addShow(tmdbId, title, providerId) {
  const show = upsertShow({ id: tmdbId, name: title, vote_average: 8 }, 'tv');

  if (providerId) {
    saveAvailability(show.id, 'DE', {
      flatrate: [{ provider_id: providerId, provider_name: 'Anbieter', logo_path: '/x.jpg' }],
    });
  }

  return show;
}

const beideWollen = addShow(101, 'Beide wollen das', 8); // Netflix
const nurBert = addShow(102, 'Nur auf Berts Liste', 337); // Disney+, hat Bert
const bertsLiebling = addShow(103, 'Berts Liebling', 8);
const nirgends = addShow(104, 'Nirgends verfügbar', 0);
const beideWollenAberNirgends = addShow(105, 'Wollen beide, geht aber nicht', 0);

// Annas Liste
run("INSERT INTO library (user_id, show_id, status) VALUES (?,?,'watchlist')", anna, beideWollen.id);
run(
  "INSERT INTO library (user_id, show_id, status) VALUES (?,?,'watchlist')",
  anna,
  beideWollenAberNirgends.id,
);

// Berts Liste
run("INSERT INTO library (user_id, show_id, status) VALUES (?,?,'watchlist')", bert, beideWollen.id);
run(
  "INSERT INTO library (user_id, show_id, status) VALUES (?,?,'watchlist')",
  bert,
  beideWollenAberNirgends.id,
);
run("INSERT INTO library (user_id, show_id, status) VALUES (?,?,'watchlist')", bert, nurBert.id);
run("INSERT INTO library (user_id, show_id, status) VALUES (?,?,'watchlist')", bert, nirgends.id);
run(
  "INSERT INTO library (user_id, show_id, status, rating) VALUES (?,?,'completed',9)",
  bert,
  bertsLiebling.id,
);

const together = friends.findCommonGround(anna, bert, 'DE');

check('Eure Abos zusammen: Netflix und Disney+', together.providerCount, 2);

check(
  'Was beide wollen und auch läuft',
  together.bothWant.map((s) => s.title),
  ['Beide wollen das'],
);
check(
  'Was beide wollen, aber nirgends läuft, wird nicht vorgeschlagen',
  together.bothWant.some((s) => s.title === 'Wollen beide, geht aber nicht'),
  false,
);

check(
  'Von Berts Liste kommt, was Anna nicht kennt – auch über SEIN Abo',
  together.fromTheirList.map((s) => s.title),
  ['Nur auf Berts Liste'],
);
check(
  'Was nirgends läuft, taucht auch hier nicht auf',
  together.fromTheirList.some((s) => s.title === 'Nirgends verfügbar'),
  false,
);
check(
  'Was Anna schon auf der Liste hat, ist kein Vorschlag',
  together.fromTheirList.some((s) => s.title === 'Beide wollen das'),
  false,
);

check(
  'Berts Lieblinge, die Anna nicht kennt',
  together.theirFavourites.map((s) => s.title),
  ['Berts Liebling'],
);
check(
  'Mit seiner Bewertung, damit man sie einordnen kann',
  together.theirFavourites[0]?.friendRating,
  9,
);

console.log('\nBibliothek eines Freundes');

const bertLibrary = friends.getFriendLibrary(bert, anna, 'DE');

check('Anna sieht Berts fünf Titel', bertLibrary.length, 5);
check(
  'Mit seinem Status und seiner Bewertung',
  bertLibrary.find((e) => e.title === 'Berts Liebling')?.friendRating,
  9,
);
check(
  'Und der Angabe, was sie selbst schon hat',
  bertLibrary.find((e) => e.title === 'Beide wollen das')?.inMyLibrary,
  true,
);
// Persönliche Notizen bleiben privat – sie sind für einen selbst gedacht.
check(
  'Persönliche Notizen werden nicht mitgeliefert',
  bertLibrary[0].notes,
  undefined,
);

// ===========================================================================
// Empfehlungen
// ===========================================================================
console.log('\nEmpfehlungen');

friends.recommend(bert, anna, bertsLiebling.id, 'Das musst du sehen!');

check('Anna hat eine ungelesene Empfehlung', friends.countUnread(anna), 1);

const received = friends.getRecommendations(anna, 'DE');
check('Sie steht in ihrer Liste', received.length, 1);
check('Von Bert', received[0].from.username, 'bert');
check('Mit der Begründung', received[0].message, 'Das musst du sehen!');
check('Und ist noch ungelesen', received[0].seen, false);

// Dieselbe Empfehlung noch einmal soll nicht verdoppeln.
friends.recommend(bert, anna, bertsLiebling.id, 'Wirklich!');
check('Eine erneute Empfehlung verdoppelt nichts', friends.getRecommendations(anna, 'DE').length, 1);
check(
  'Sondern frischt die Begründung auf',
  friends.getRecommendations(anna, 'DE')[0].message,
  'Wirklich!',
);

friends.markRead(anna);
check('Nach dem Lesen ist der Zähler leer', friends.countUnread(anna), 0);

// Nur unter Freunden.
error = null;
try {
  friends.recommend(carl, bert, bertsLiebling.id, 'Hallo');
} catch (e) {
  error = e.message;
}
check('An Fremde kann man nicht empfehlen', Boolean(error), true);

// ===========================================================================
// Sichtbarkeit und Aufräumen
// ===========================================================================
console.log('\nSichtbarkeit');

check('Bert und Carl sind nicht befreundet', friends.areFriends(bert, carl), false);

console.log('\nFreundschaft beenden');

check('Anna beendet die Freundschaft mit Bert', friends.removeFriendship(anna, bert), true);
check('Danach sind sie es nicht mehr', friends.areFriends(anna, bert), false);
check(
  'Ein zweites Beenden meldet, dass nichts da war',
  friends.removeFriendship(anna, bert),
  false,
);

console.log('\nLöschen eines Kontos');

run('DELETE FROM users WHERE id = ?', carl);
check(
  'Seine Freundschaften verschwinden mit',
  all('SELECT * FROM friendships WHERE user_id = ? OR friend_id = ?', carl, carl).length,
  0,
);

run('DELETE FROM users WHERE id = ?', bert);
check('Und seine Empfehlungen auch', all('SELECT * FROM recommendations').length, 0);

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
