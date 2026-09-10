/**
 * ---------------------------------------------------------------------------
 * tests/achievements.test.mjs – Erfolge und Anbieter-Zusammenfassung
 * ---------------------------------------------------------------------------
 * Ausführen:  npm run test:achievements
 *
 * Zwei Themen in einer Datei, weil beide dieselbe Testdatenbank brauchen:
 *
 *   1. Erfolge: Werden sie zum richtigen Zeitpunkt vergeben? Bleiben sie
 *      erhalten? Werden sie nicht doppelt vergeben?
 *   2. Anbieter: Werden Varianten wie "Netflix basic with Ads" korrekt mit
 *      "Netflix" zusammengefasst? Das ist wichtiger, als es klingt – ohne
 *      die Zusammenfassung erkennt Streamo eine Serie nicht als "in deinem
 *      Abo enthalten", nur weil sie unter einer Variante geführt wird.
 * ---------------------------------------------------------------------------
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamo-ach-'));
process.env.DATA_DIR = tempDir;

const { db, run, get, all } = await import('../src/db.js');
const { checkAchievements, listAchievements } = await import('../src/achievements.js');
const { mergeProviders, mergeOffers, isPurchaseOnly } = await import(
  '../src/providers-canonical.js'
);

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

console.log('\nStreamo – Erfolge und Anbieter\n');

// ===========================================================================
// Anbieter zusammenfassen
// ===========================================================================
console.log('Anbieter-Varianten zusammenfassen');

// So sieht eine Katalogantwort von TMDB in Wirklichkeit aus: derselbe Dienst
// mehrfach, einmal regulär und einmal je Abo-Variante oder Vertriebsweg.
const rawCatalog = [
  { id: 8, name: 'Netflix', logo_path: '/nf.jpg', display_priority: 0 },
  { id: 1796, name: 'Netflix basic with Ads', logo_path: '/nfa.jpg', display_priority: 8 },
  { id: 1855, name: 'Netflix Standard with Ads', logo_path: '/nfs.jpg', display_priority: 9 },
  { id: 337, name: 'Disney Plus', logo_path: '/dp.jpg', display_priority: 2 },
  { id: 1771, name: 'Disney+ Amazon Channel', logo_path: '/dpa.jpg', display_priority: 15 },
  { id: 531, name: 'Paramount Plus', logo_path: '/pp.jpg', display_priority: 5 },
  { id: 582, name: 'Paramount+ Amazon Channel', logo_path: '/ppa.jpg', display_priority: 20 },
  { id: 30, name: 'WOW', logo_path: '/wow.jpg', display_priority: 6 },
  { id: 1773, name: 'WOW Amazon Channel', logo_path: '/wowa.jpg', display_priority: 22 },
  { id: 9, name: 'Amazon Prime Video', logo_path: '/pv.jpg', display_priority: 1 },
  { id: 10, name: 'Amazon Video', logo_path: '/av.jpg', display_priority: 3 },
];

const merged = mergeProviders(rawCatalog);
const names = merged.map((p) => p.name);

check('Aus elf Einträgen werden sechs', merged.length, 6);
check('Netflix erscheint genau einmal', names.filter((n) => n.startsWith('Netflix')).length, 1);
check('Disney erscheint genau einmal', names.filter((n) => n.startsWith('Disney')).length, 1);
check('Paramount erscheint genau einmal', names.filter((n) => n.startsWith('Paramount')).length, 1);
check('WOW erscheint genau einmal', names.filter((n) => n === 'WOW').length, 1);
check(
  'Der Netflix-Eintrag behält die Haupt-ID',
  merged.find((p) => p.name === 'Netflix')?.id,
  8,
);
check(
  'Und das Logo des Hauptanbieters',
  merged.find((p) => p.name === 'Netflix')?.logo_path,
  '/nf.jpg',
);
check(
  'Nach Anzeige-Priorität sortiert',
  merged.map((p) => p.display_priority),
  [0, 1, 2, 3, 5, 6],
);
check(
  'Abo und Leihe bei Amazon bleiben getrennt',
  [
    names.includes('Amazon Prime Video'),
    names.includes('Amazon Video'),
  ],
  [true, true],
);

console.log('\nAngebote einer Serie zusammenfassen');

const rawOffers = [
  { provider_id: 8, provider_name: 'Netflix', logo_path: '/nf.jpg', display_priority: 0 },
  { provider_id: 1796, provider_name: 'Netflix basic with Ads', logo_path: '/nfa.jpg', display_priority: 8 },
  { provider_id: 337, provider_name: 'Disney Plus', logo_path: '/dp.jpg', display_priority: 2 },
];

const mergedOffers = mergeOffers(rawOffers);
check('Zwei statt drei Angebote', mergedOffers.length, 2);
check(
  'Die Netflix-Variante wurde auf Netflix zurückgeführt',
  mergedOffers.find((o) => o.provider_id === 8)?.provider_name,
  'Netflix',
);
check('Kein Eintrag mit der Varianten-ID', mergedOffers.some((o) => o.provider_id === 1796), false);
check('Leere Eingabe ergibt eine leere Liste', mergeOffers(undefined), []);

// Eine Variante, die NICHT in der festen ID-Liste steht: Sie darf nicht als
// zweiter "HBO Max" neben dem echten stehen bleiben (so geschehen in der
// Statistik), sondern muss über den Namen zum Hauptdienst finden.
const hboOffers = mergeOffers([
  { provider_id: 1825, provider_name: 'HBO Max Amazon Channel', logo_path: '/ch.jpg', display_priority: 0 },
  { provider_id: 1899, provider_name: 'HBO Max', logo_path: '/hbo.jpg', display_priority: 3 },
]);
check('Channel ohne ID-Zuordnung: ein Eintrag statt zwei', hboOffers.length, 1);
check('Er trägt die ID des Hauptdienstes', hboOffers[0]?.provider_id, 1899);
check('Und dessen Namen', hboOffers[0]?.provider_name, 'HBO Max');

// Gegenprobe: Wird nur der Channel angeboten, gibt es nichts zusammenzuführen.
const nurChannel = mergeOffers([
  { provider_id: 1825, provider_name: 'HBO Max Amazon Channel', logo_path: '/ch.jpg', display_priority: 0 },
]);
check('Allein angeboten bleibt der Channel erhalten', nurChannel.length, 1);
check('... mit seiner eigenen ID', nurChannel[0]?.provider_id, 1825);

console.log('\nKauf- und Leihplattformen erkennen');

// Diese gehören nicht in die Abo-Auswahl – man kann sie nicht abonnieren.
for (const name of [
  'Amazon Video',
  'Google Play Movies',
  'Apple TV',
  'Microsoft Store',
  'Rakuten TV',
  'Sky Store',
  'YouTube',
]) {
  check(`"${name}" ist ein Kaufladen`, isPurchaseOnly(name), true);
}

// Diese sind echte Abo-Dienste und müssen bleiben – auch die, deren Name dem
// eines Kaufladens ähnelt.
for (const name of [
  'Netflix',
  'Amazon Prime Video',
  'Apple TV+',
  'Apple TV Plus',
  'Disney Plus',
  'WOW',
  'YouTube Premium',
]) {
  check(`"${name}" ist ein Abo-Dienst`, isPurchaseOnly(name), false);
}

// ===========================================================================
// Erfolge
// ===========================================================================
console.log('\nErfolge – Ausgangslage');

run("INSERT INTO users (username, password_hash, region) VALUES ('tester','x:y','DE')");
const userId = get("SELECT id FROM users WHERE username='tester'").id;

check('Ein frisches Konto hat noch keine Erfolge', checkAchievements(userId).length, 0);

console.log('\nErste Schritte');

// Eine Serie aufnehmen -> "Der Anfang"
run("INSERT INTO shows (tmdb_id, media_type, title, number_of_episodes) VALUES (1408,'tv','Dr. House',177)");
const houseId = get('SELECT id FROM shows WHERE tmdb_id=1408').id;
run("INSERT INTO library (user_id, show_id, status) VALUES (?,?,'watching')", userId, houseId);

let unlocked = checkAchievements(userId);
check('"Der Anfang" wird vergeben', unlocked.map((a) => a.id), ['first_show']);

check('Ein zweiter Lauf vergibt nichts erneut', checkAchievements(userId).length, 0);

console.log('\nSerien-Erfolg');

// Serie auf "completed" setzen -> der Erfolg für Dr. House
run("UPDATE library SET status='completed' WHERE user_id=? AND show_id=?", userId, houseId);

unlocked = checkAchievements(userId);
const ids = unlocked.map((a) => a.id).sort();

check(
  'Dr. House schaltet "Regelbrecher" frei',
  ids.includes('house'),
  true,
);
check('Und gleichzeitig "Durchgezogen"', ids.includes('first_completed'), true);
check(
  'Der Titel spielt auf die Serie an',
  unlocked.find((a) => a.id === 'house')?.title,
  'Regelbrecher',
);
check(
  'Und "Marathonläufer", weil die Serie über 100 Folgen hat',
  ids.includes('marathon_show'),
  true,
);

console.log('\nErfolge bleiben erhalten');

// Die Serie wieder aus der Bibliothek werfen – der Erfolg bleibt trotzdem.
run('DELETE FROM library WHERE user_id=? AND show_id=?', userId, houseId);

const afterRemoval = listAchievements(userId);
check(
  '"Regelbrecher" bleibt auch nach dem Entfernen',
  afterRemoval.earned.some((a) => a.id === 'house'),
  true,
);
check('Nichts wird nachträglich entzogen', checkAchievements(userId).length, 0);

console.log('\nAnzeige');

const listed = listAchievements(userId);

check('Verdiente und offene zusammen ergeben die Gesamtzahl',
  listed.earned.length + listed.locked.length, listed.total);
check('earnedCount stimmt mit der Liste überein', listed.earnedCount, listed.earned.length);
check(
  'Offene Serien-Erfolge verraten ihren Titel nicht',
  listed.locked.filter((a) => a.kind === 'show').every((a) => a.title === 'Noch verborgen'),
  true,
);

const collector = listed.locked.find((a) => a.id === 'collector_25');
check('Offene Erfolge zeigen ihren Fortschritt', collector?.progress?.goal, 25);

// ===========================================================================
// Fremdschlüssel
// ===========================================================================
console.log('\nLöschen eines Kontos');

run('DELETE FROM users WHERE id = ?', userId);
check('Erfolge werden mitgelöscht', all('SELECT * FROM user_achievements').length, 0);

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
