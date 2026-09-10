/**
 * ---------------------------------------------------------------------------
 * tests/provider-links.test.mjs – Direktlinks zu den Streaming-Anbietern
 * ---------------------------------------------------------------------------
 * Prüft public/js/provider-links.js: Aus Anbietername und Titel muss die
 * Suchadresse beim Anbieter werden – oder null, wenn der Anbieter unbekannt
 * ist, damit die Detailseite auf JustWatch zurückfällt.
 *
 * Die Datei liegt im Frontend, kommt aber ohne DOM aus und lässt sich
 * deshalb direkt in Node laden.
 *
 * Aufruf: npm run test:links
 * ---------------------------------------------------------------------------
 */

import { providerDirectLink } from '../public/js/provider-links.js';

let passed = 0;
let failed = 0;

/**
 * Vergleicht und zählt.
 *
 * @param {string} label   Was geprüft wird
 * @param {*} actual       Tatsächliches Ergebnis
 * @param {*} expected     Erwartetes Ergebnis
 */
function check(label, actual, expected) {
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ ${label}\n      erwartet: ${expected}\n      erhalten: ${actual}`);
  }
}

// ---------------------------------------------------------------------------
// Die großen Dienste, so wie TMDB sie benennt
// ---------------------------------------------------------------------------
check(
  'Netflix',
  providerDirectLink('Netflix', 'Dark'),
  'https://www.netflix.com/search?q=Dark',
);
check(
  'Amazon Prime Video (der Fall aus der Anfrage)',
  providerDirectLink('Amazon Prime Video', 'The Boys'),
  'https://www.primevideo.com/search?phrase=The%20Boys',
);
check(
  'Amazon Video (Kauf/Leihe) landet ebenfalls bei Prime Video',
  providerDirectLink('Amazon Video', 'The Boys'),
  'https://www.primevideo.com/search?phrase=The%20Boys',
);
check(
  'Disney Plus',
  providerDirectLink('Disney Plus', 'Andor'),
  'https://www.disneyplus.com/search?q=Andor',
);
check(
  'Disney+ in Kurzschreibweise ergibt denselben Schlüssel',
  providerDirectLink('Disney+', 'Andor'),
  'https://www.disneyplus.com/search?q=Andor',
);
check(
  'Apple TV+ (Abo)',
  providerDirectLink('Apple TV+', 'Severance'),
  'https://tv.apple.com/search?term=Severance',
);
check(
  'Apple TV Plus (andere Schreibweise)',
  providerDirectLink('Apple TV Plus', 'Severance'),
  'https://tv.apple.com/search?term=Severance',
);
check(
  'Apple TV (Kaufladen)',
  providerDirectLink('Apple TV', 'Severance'),
  'https://tv.apple.com/search?term=Severance',
);
check(
  'Paramount Plus',
  providerDirectLink('Paramount Plus', 'Yellowstone'),
  'https://www.paramountplus.com/search/?q=Yellowstone',
);
check(
  'Crunchyroll',
  providerDirectLink('Crunchyroll', 'Naruto'),
  'https://www.crunchyroll.com/de/search?q=Naruto',
);

// ---------------------------------------------------------------------------
// Deutsche und öffentlich-rechtliche Dienste
// ---------------------------------------------------------------------------
check('RTL+', providerDirectLink('RTL+', 'Der Lehrer'), 'https://plus.rtl.de/suche?query=Der%20Lehrer');
check('Joyn', providerDirectLink('Joyn', 'Jerks'), 'https://www.joyn.de/suche?q=Jerks');
check('Joyn Plus', providerDirectLink('Joyn Plus', 'Jerks'), 'https://www.joyn.de/suche?q=Jerks');
check('MagentaTV', providerDirectLink('MagentaTV', 'Oderbruch'), 'https://www.magentatv.de/suche?q=Oderbruch');
check(
  'ARD Mediathek setzt den Titel in den Pfad',
  providerDirectLink('ARD Mediathek', 'Tatort'),
  'https://www.ardmediathek.de/suche/Tatort',
);
check('ZDF', providerDirectLink('ZDF', 'Der Bergdoktor'), 'https://www.zdf.de/suche?q=Der%20Bergdoktor');
check('Arte', providerDirectLink('Arte', 'Fargo'), 'https://www.arte.tv/de/search/?q=Fargo');
check(
  'YouTube Premium',
  providerDirectLink('YouTube Premium', 'Cobra Kai'),
  'https://www.youtube.com/results?search_query=Cobra%20Kai',
);

// ---------------------------------------------------------------------------
// Abo-Varianten werden auf den Dienst zurückgeführt
// ---------------------------------------------------------------------------
check(
  'Netflix basic with Ads ist Netflix',
  providerDirectLink('Netflix basic with Ads', 'Dark'),
  'https://www.netflix.com/search?q=Dark',
);
check(
  'Netflix Standard with Ads ist Netflix',
  providerDirectLink('Netflix Standard with Ads', 'Dark'),
  'https://www.netflix.com/search?q=Dark',
);

// ---------------------------------------------------------------------------
// Channels laufen über die Plattform, bei der man sie bucht
// ---------------------------------------------------------------------------
check(
  'Paramount+ Amazon Channel führt zu Amazon, nicht zu Paramount',
  providerDirectLink('Paramount+ Amazon Channel', 'Yellowstone'),
  'https://www.primevideo.com/search?phrase=Yellowstone',
);
check(
  'Paramount+ Apple TV Channel führt zu Apple',
  providerDirectLink('Paramount+ Apple TV Channel', 'Yellowstone'),
  'https://tv.apple.com/search?term=Yellowstone',
);

// ---------------------------------------------------------------------------
// Sonderzeichen im Titel dürfen die Adresse nicht zerlegen
// ---------------------------------------------------------------------------
check(
  '"&" wird kodiert und beendet den Parameter nicht',
  providerDirectLink('Netflix', 'Love, Death & Robots'),
  'https://www.netflix.com/search?q=Love%2C%20Death%20%26%20Robots',
);
check(
  'Umlaute werden als UTF-8 kodiert',
  providerDirectLink('Netflix', 'Tribes of Europa: Übergang'),
  'https://www.netflix.com/search?q=Tribes%20of%20Europa%3A%20%C3%9Cbergang',
);
check(
  '"/" im Titel bricht den Pfad der ARD nicht auf',
  providerDirectLink('ARD Mediathek', 'AC/DC'),
  'https://www.ardmediathek.de/suche/AC%2FDC',
);
check(
  'Leerzeichen am Rand werden entfernt',
  providerDirectLink('Netflix', '  Dark  '),
  'https://www.netflix.com/search?q=Dark',
);

// ---------------------------------------------------------------------------
// Rückfall auf JustWatch: null für alles, was nicht sicher ist
// ---------------------------------------------------------------------------
check('Unbekannter Anbieter ergibt null', providerDirectLink('Irgendein Kanal', 'Dark'), null);
check('WOW ist bewusst (noch) nicht dabei', providerDirectLink('WOW', 'House of the Dragon'), null);
check('Leerer Titel ergibt null', providerDirectLink('Netflix', ''), null);
check('Fehlender Titel ergibt null', providerDirectLink('Netflix', undefined), null);
check('Fehlender Anbieter ergibt null', providerDirectLink(undefined, 'Dark'), null);
check('Nur Leerzeichen als Titel ergibt null', providerDirectLink('Netflix', '   '), null);

// Nicht "Netflix" findet, nur weil der Name so anfängt: "Netflixxx" ist
// ein anderer Name und darf nicht auf Netflix zeigen.
check('Ähnlicher, aber anderer Name ergibt null', providerDirectLink('Netflixxx', 'Dark'), null);

// ---------------------------------------------------------------------------
// Jede erzeugte Adresse ist https – kein Klick verlässt die Verschlüsselung
// ---------------------------------------------------------------------------
const alleNamen = [
  'Netflix', 'Amazon Prime Video', 'Amazon Video', 'Disney Plus', 'Apple TV+', 'Apple TV',
  'Paramount Plus', 'Crunchyroll', 'MUBI', 'YouTube', 'YouTube Premium', 'Joyn', 'RTL+',
  'MagentaTV', 'ARD Mediathek', 'ZDF', 'Arte', 'iTunes',
];

for (const name of alleNamen) {
  const url = providerDirectLink(name, 'Test');
  check(`${name}: https-Adresse`, typeof url === 'string' && url.startsWith('https://'), true);
}

// ---------------------------------------------------------------------------
// Dieselbe Schlusszeile wie in den übrigen Testdateien, damit
// "npm run test:all" einheitlich lesbar bleibt.
if (failed > 0) {
  console.error(`\n${failed} von ${passed + failed} Prüfungen fehlgeschlagen.`);
  process.exit(1);
}
console.log(`Alle ${passed} Prüfungen bestanden.`);
