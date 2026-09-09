/**
 * ---------------------------------------------------------------------------
 * tests/fuzzy.test.mjs – Suche, die Tippfehler verzeiht
 * ---------------------------------------------------------------------------
 * Ausführen:  npm run test:fuzzy
 *
 * Getestet wird mit echten Vertippern, wie sie beim schnellen Schreiben
 * entstehen: verdoppelte Buchstaben, vergessene Zeichen, vertauschte
 * Nachbarn, fehlende Bindestriche.
 *
 * Ebenso wichtig ist die Gegenprobe: Eine Suche, die ALLES findet, ist
 * genauso unbrauchbar wie eine, die nichts findet. Deshalb prüft der zweite
 * Teil, dass deutlich verschiedene Titel eben NICHT als Treffer gelten.
 * ---------------------------------------------------------------------------
 */

import { normalize, distance, similarity, matches, variants, rank } from '../src/fuzzy.js';

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

console.log('\nStreamo – Nachsichtige Suche\n');

// ===========================================================================
// Normalisieren
// ===========================================================================
console.log('Aufräumen von Suchbegriffen');

check('Kleinschreibung', normalize('Breaking Bad'), 'breaking bad');
check('Bindestriche werden zu Leerzeichen', normalize('Spider-Man'), 'spider man');
check('Doppelpunkte fallen weg', normalize('Kingsman: The Secret Service'), 'kingsman the secret service');
check('Umlaute werden ausgeschrieben', normalize('Höhle'), 'hoehle');
check('Das scharfe S auch', normalize('Straße'), 'strasse');
check('Akzente verschwinden', normalize('Amélie'), 'amelie');
check('Mehrfache Leerzeichen werden eins', normalize('  viel   raum  '), 'viel raum');
check('Ziffern bleiben', normalize('Se7en'), 'se7en');

// ===========================================================================
// Abstand messen
// ===========================================================================
console.log('\nAbstand zwischen Wörtern');

check('Gleiche Wörter haben Abstand 0', distance('kingsman', 'kingsman'), 0);
check('Ein Buchstabe zu viel: 1', distance('kingsman', 'kingsmann'), 1);
check('Ein Buchstabe fehlt: 1', distance('kingsman', 'kingman'), 1);
check('Ein Buchstabe falsch: 1', distance('kingsman', 'kingsmen'), 1);
check('Zwei vertauschte Nachbarn: 2', distance('kingsman', 'kignsman'), 2);
check('Gegen leer: die eigene Länge', distance('abc', ''), 3);

// ===========================================================================
// Ähnlichkeit
// ===========================================================================
console.log('\nÄhnlichkeit');

check('Identisch ergibt 1', similarity('Breaking Bad', 'breaking bad'), 1);
check(
  'Ein Tippfehler bleibt sehr ähnlich',
  similarity('Kingsman', 'Kingsmann') > 0.85,
  true,
);
check(
  'Verschiedene Titel sind unähnlich',
  similarity('Breaking Bad', 'Stranger Things') < 0.4,
  true,
);

// ===========================================================================
// Treffer erkennen – der eigentliche Zweck
// ===========================================================================
console.log('\nTitel trotz Vertipper finden');

const cases = [
  ['Kingsman: The Secret Service', 'kingsmann', 'verdoppelter Buchstabe'],
  ['Kingsman: The Secret Service', 'kingsman', 'genau richtig'],
  ['Kingsman: The Secret Service', 'Kingsman', 'Großschreibung'],
  ['Breaking Bad', 'braking bad', 'fehlender Buchstabe'],
  ['Breaking Bad', 'breaking badd', 'Buchstabe zu viel'],
  ['Breaking Bad', 'Bad Breaking', 'vertauschte Wörter'],
  ['Spider-Man: No Way Home', 'spiderman', 'fehlender Bindestrich'],
  ['Spider-Man: No Way Home', 'spider man no way home', 'ausgeschrieben'],
  ['Stranger Things', 'stranger thing', 'Endung vergessen'],
  ['Stranger Things', 'stranegr things', 'vertauschte Nachbarn'],
  ['Game of Thrones', 'game of thrones', 'exakt'],
  ['Game of Thrones', 'thrones', 'nur ein Wort'],
  ['Der Herr der Ringe', 'herr der ringe', 'Artikel weggelassen'],
  ['Die Simpsons', 'simpsons', 'Artikel weggelassen'],
  ['Amélie', 'amelie', 'ohne Akzent'],
];

for (const [title, query, why] of cases) {
  check(`"${query}" findet "${title}" (${why})`, matches(title, query), true);
}

console.log('\nGegenprobe: was NICHT passen darf');

const nonCases = [
  ['Breaking Bad', 'stranger things'],
  ['Kingsman', 'batman'],
  ['Die Simpsons', 'futurama'],
  ['Der Pate', 'der herr der ringe'],
];

for (const [title, query] of nonCases) {
  check(`"${query}" findet NICHT "${title}"`, matches(title, query), false);
}

check('Ein leerer Suchbegriff passt auf alles', matches('Irgendwas', ''), true);

// ===========================================================================
// Varianten für den zweiten Versuch
// ===========================================================================
console.log('\nSchreibvarianten für einen zweiten Versuch');

const kingsmannVariants = variants('Kingsmann');
check(
  'Der doppelte Buchstabe wird reduziert',
  kingsmannVariants.includes('kingsman'),
  true,
);

const spiderVariants = variants('Spider-Man!');
check(
  'Sonderzeichen fallen weg',
  spiderVariants.includes('spider man'),
  true,
);

const longVariants = variants('Kingsmann Golden Circel');
check(
  'Bei mehreren Wörtern kommt das längste allein dazu',
  longVariants.some((v) => v === 'kingsmann'),
  true,
);

check('Ein leerer Begriff ergibt keine Varianten', variants(''), []);
check(
  'Der ursprüngliche Begriff ist nicht dabei – er wurde ja schon probiert',
  variants('kingsman').includes('kingsman'),
  false,
);

// ===========================================================================
// Sortieren
// ===========================================================================
console.log('\nSortieren nach Ähnlichkeit');

const results = [
  { title: 'The Kingsman Documentary' },
  { title: 'Kingsman' },
  { title: 'Kings of Summer' },
  { title: 'Kingsman: The Golden Circle' },
];

const ranked = rank(results, 'kingsman');

check('Der genaueste Treffer steht vorn', ranked[0].title, 'Kingsman');
check(
  'Und das Unähnlichste hinten',
  ranked[ranked.length - 1].title,
  'Kings of Summer',
);
check('Es geht nichts verloren', ranked.length, results.length);

// ===========================================================================
console.log('');
console.log(
  failures === 0
    ? `Alle ${checks} Prüfungen bestanden.\n`
    : `${failures} von ${checks} Prüfungen fehlgeschlagen.\n`,
);

process.exit(failures === 0 ? 0 : 1);
