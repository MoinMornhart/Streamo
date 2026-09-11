/**
 * ---------------------------------------------------------------------------
 * tests/i18n.test.mjs – Die englische Oberfläche
 * ---------------------------------------------------------------------------
 * Prüft public/js/i18n.js und das Wörterbuch public/js/i18n/en.js:
 *   - Deutsch bleibt unangetastet
 *   - exakte Einträge, Muster mit Platzhaltern, übersetzte Fanggruppen
 *   - zusammengesetzte Texte nur dann, wenn jedes Stück übersetzt ist
 *   - unbekannte Texte bleiben stehen, statt verstümmelt zu werden
 *   - das Wörterbuch selbst: keine doppelten Schlüssel, Platzhalter
 *     vollständig, keine deutschen Reste in den Übersetzungen
 *
 * Aufruf: npm run test:i18n
 * ---------------------------------------------------------------------------
 */

import { translate, t, setLanguage, locale } from '../public/js/i18n.js';
import EN, { PARTS } from '../public/js/i18n/en.js';

let passed = 0;
let failed = 0;

/**
 * Vergleicht und zählt.
 * @param {string} label
 * @param {*} actual
 * @param {*} expected
 */
function check(label, actual, expected) {
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ ${label}\n      erwartet: ${JSON.stringify(expected)}\n      erhalten: ${JSON.stringify(actual)}`);
  }
}

const en = (text) => translate(text, 'en');

// ---------------------------------------------------------------------------
// Deutsch: nichts wird angefasst
// ---------------------------------------------------------------------------
check('Deutsch bleibt Deutsch', translate('Bibliothek', 'de'), 'Bibliothek');
check('Auch Muster greifen bei Deutsch nicht', translate('Noch 5 Tage', 'de'), 'Noch 5 Tage');
check('Nicht-Texte kommen unverändert zurück', translate(42, 'en'), 42);
check('Leere Texte bleiben leer', translate('   ', 'en'), '   ');

// ---------------------------------------------------------------------------
// Exakte Einträge
// ---------------------------------------------------------------------------
check('Navigation', en('Bibliothek'), 'Library');
check('Status', en('Will ich sehen'), 'Want to watch');
check('Fehlermeldung vom Server', en('Benutzername oder Passwort ist falsch.'), 'Username or password is wrong.');
check('Leerraum am Rand bleibt erhalten', en('Noch kein Konto? '), 'No account yet? ');

// ---------------------------------------------------------------------------
// Muster mit Platzhaltern
// ---------------------------------------------------------------------------
check('Zahl eingesetzt', en('Noch 5 Tage'), '5 days left');
check('Zwei Zahlen', en('Staffel 2 (3/10)'), 'Season 2 (3/10)');
check('Wert vom Server', en('Zu viele Versuche. Bitte warte 30 Sekunden.'), 'Too many attempts. Please wait 30 seconds.');
check('Titel im Muster bleibt, wie er ist', en('Weil du Dark gesehen hast'), 'Because you watched Dark');
check('Kalendereintrag mit Symbol', en('📅 Severance: 1 Folge'), '📅 Severance: 1 episode');
check('Kalendereintrag, Mehrzahl', en('📅 Shōgun: 2 Folgen'), '📅 Shōgun: 2 episodes');
check('Letzter Tag im Kalender', en('⏳ Letzter Tag: The Boys'), '⏳ Last day: The Boys');

// Was eine Fanggruppe auffängt, wird selbst übersetzt.
check(
  'Fanggruppen werden übersetzt',
  en('Sehplan gesetzt: Mo, Do · 2 Folgen.'),
  'Watch plan set: Mon, Thu · 2 episodes.',
);
check(
  'Beschreibung im Kalender-Feed',
  en('Du hast dir vorgenommen, diese Serie zu sehen.'),
  'You planned to watch this show.',
);

// ---------------------------------------------------------------------------
// Zusammengesetzte Texte
// ---------------------------------------------------------------------------
check('Zerlegt, wenn jedes Stück übersetzt ist', en('Mo, Do · 1 Folge'), 'Mon, Thu · 1 episode');
check('Zahlen dürfen unübersetzt bleiben', en('2008 · Beendet'), '2008 · Ended');
check(
  'Kein Mischmasch: ein unbekanntes Stück lässt alles stehen',
  en('Breaking Bad · Staffel 2'),
  'Breaking Bad · Staffel 2',
);

// Ein kurzes Muster ("{0} einzeln") darf nicht den ganzen Rest schlucken und
// ihn deutsch stehen lassen – so geschehen in der Bibliothek.
check(
  'Kurzes Muster schluckt keinen zusammengesetzten Rest',
  en('19 Einträge · 2 Filmreihen · 14 einzeln'),
  '19 entries · 2 collections · 14 individual',
);

// Mehrere Sätze hintereinander werden Satz für Satz übersetzt.
check(
  'Zwei Sätze hintereinander',
  en('Der automatische Abgleich ist abgeschaltet. Du kannst den Abgleich auch sofort starten.'),
  'Automatic sync is turned off. You can also start the sync right away.',
);
check('Kein Zerschneiden von Wörtern durch Platzhalter', en('Letzter Abgleich: nie'), 'Last sync: never');

// Benannte Platzhalter sind Vorlagen für t(), keine Muster.
check('"{current} von {goal}" greift nicht als Muster', en('19 von 25'), '19 von 25');

// ---------------------------------------------------------------------------
// Rückfall
// ---------------------------------------------------------------------------
check('Unbekannter Text bleibt stehen', en('Ein Satz, den es nirgends gibt'), 'Ein Satz, den es nirgends gibt');
check('Serientitel bleiben Serientitel', en('The Last of Us'), 'The Last of Us');
check('Die Fußzeile "Daten von TMDB" wird nicht halb übersetzt', en('Daten von TMDB'), 'Daten von TMDB');

// ---------------------------------------------------------------------------
// t() und die eingestellte Sprache
// ---------------------------------------------------------------------------
setLanguage('en');
check('t() übersetzt und setzt ein', t('{current} von {goal}', { current: 3, goal: 10 }), '3 of 10');
check('t() mit Wörterbuch-Eintrag', t('Noch {0} Tage', { 0: 4 }), '4 days left');
check('Gebietsschema Englisch', locale(), 'en-GB');
setLanguage('de');
check('Gebietsschema Deutsch', locale(), 'de-DE');
setLanguage('xx');
check('Unbekannte Sprache fällt auf Deutsch zurück', locale(), 'de-DE');

// ---------------------------------------------------------------------------
// Das Wörterbuch selbst
// ---------------------------------------------------------------------------
const seen = new Map();
for (const [part, entries] of Object.entries(PARTS)) {
  for (const key of Object.keys(entries)) {
    if (seen.has(key)) {
      check(`Schlüssel doppelt: "${key}" (${seen.get(key)} und ${part})`, false, true);
    }
    seen.set(key, part);
  }
}
check('Keine doppelten Schlüssel zwischen den Teilen', true, true);

const placeholders = (text) => (text.match(/\{\w+\}/g) || []).sort().join(',');
let placeholderProblems = 0;
let umlautProblems = 0;
let emptyProblems = 0;

for (const [german, english] of Object.entries(EN)) {
  if (typeof english !== 'string' || !english.trim()) {
    emptyProblems++;
    console.error(`  ✗ leere Übersetzung für "${german}"`);
    continue;
  }
  if (placeholders(german) !== placeholders(english)) {
    placeholderProblems++;
    console.error(`  ✗ Platzhalter passen nicht: "${german}" -> "${english}"`);
  }
  // Umlaute in der Übersetzung sind fast immer vergessenes Deutsch.
  if (/[äöüÄÖÜß]/.test(english)) {
    umlautProblems++;
    console.error(`  ✗ Umlaut in der Übersetzung: "${english}"`);
  }
}
check('Jede Übersetzung ist ein nichtleerer Text', emptyProblems, 0);
check('Platzhalter stimmen überall überein', placeholderProblems, 0);
check('Keine Umlaute in den englischen Texten', umlautProblems, 0);
check('Das Wörterbuch hat eine brauchbare Größe', Object.keys(EN).length > 700, true);

// ---------------------------------------------------------------------------
if (failed > 0) {
  console.error(`\n${failed} von ${passed + failed} Prüfungen fehlgeschlagen.`);
  process.exit(1);
}
console.log(`Alle ${passed} Prüfungen bestanden.`);
