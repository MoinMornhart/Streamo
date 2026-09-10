/**
 * ---------------------------------------------------------------------------
 * public/js/provider-links.js – Direkt zum Anbieter statt über JustWatch
 * ---------------------------------------------------------------------------
 * Das Problem:
 *   TMDB liefert zu jedem Titel genau EINEN Link pro Region, und der zeigt
 *   auf die JustWatch-Seite des Titels (siehe src/store.js ->
 *   saveAvailability, Spalte "link"). Einen Link je Anbieter gibt es dort
 *   nicht, in keiner Form. Wer auf der Detailseite "Prime Video" anklickte,
 *   landete deshalb bisher erst bei JustWatch und musste dort noch einmal
 *   klicken.
 *
 * Die Lösung:
 *   Für die bekannten Anbieter bauen wir die Adresse selbst: die Suchseite
 *   des Anbieters, gefüllt mit dem Titel. Das ist kein Link auf die exakte
 *   Titelseite – die ID, die Netflix oder Amazon intern verwenden, kennt
 *   TMDB nicht –, aber bei einer Suche nach dem Namen steht der Titel
 *   praktisch immer ganz oben. Ein Klick, und man ist beim Anbieter.
 *
 *   Unbekannte Anbieter bekommen null zurück. Die Detailseite fällt dann
 *   auf den JustWatch-Link zurück – das Verhalten von vorher, und immer noch
 *   besser als eine geratene Adresse, die ins Leere führt.
 *
 * Warum über den Namen und nicht über die TMDB-ID:
 *   Das ist dieselbe Entscheidung wie in src/providers-canonical.js. Namen
 *   sind in jeder Region gleich, IDs nicht zwingend, und TMDB legt für neue
 *   Abo-Varianten ("with Ads", "Amazon Channel") laufend neue IDs an. Ein
 *   Name wie "Netflix Standard with Ads" wird erkannt, ohne dass diese Liste
 *   angepasst werden muss.
 *
 * Warum im Frontend:
 *   Die Adresse hängt nur vom Anbieternamen und vom Titel ab, und beides hat
 *   die Detailseite ohnehin. Auf dem Server müsste man den Titel erst durch
 *   buildAvailabilityView() und alle elf Aufrufer davon reichen – für eine
 *   reine Umrechnung ohne Datenbankzugriff.
 *   Die Datei greift bewusst nicht auf das DOM zu, damit sie sich in Node
 *   testen lässt (tests/provider-links.test.mjs).
 *
 * Geprüft (mit curl, September 2026):
 *   - Seite UND Suchbegriff bestätigt – der gesuchte Titel steht in der
 *     Antwort: Prime Video, Apple TV, ARD, ZDF, Arte, YouTube, Crunchyroll.
 *   - Joyn: Parametername aus der offiziellen Suchvorlage des Anbieters
 *     (https://www.joyn.de/opensearch.xml -> "suche?q={searchTerms}").
 *   - Nur die Seite bestätigt (200): Netflix, Paramount+, RTL+, MagentaTV.
 *     Diese Seiten bauen ihre Suche erst im Browser, curl sieht davon
 *     nichts. Sollte ein Parametername nicht stimmen, landet man immerhin
 *     auf der Suchseite des richtigen Anbieters.
 *   - Disney+ schickt als reine Browser-Anwendung für JEDE Unterseite das
 *     Grundgerüst mit Status 404; die Suche baut erst das Skript im Browser.
 *   - WOW (wow.de) lehnt Verbindungen ohne echten Browser ab und ließ sich
 *     gar nicht prüfen – WOW bleibt deshalb vorerst bei JustWatch.
 *
 * Verknüpfungen:
 *   - public/js/views/detail.js -> availabilityBlock() setzt den Link auf
 *                                  jede Anbieter-Kachel
 *   - src/store.js              -> liefert "name" und den JustWatch-"link",
 *                                  auf den zurückgefallen wird
 * ---------------------------------------------------------------------------
 */

/**
 * Wie die Suchadresse eines Anbieters gebaut wird.
 *
 * Schlüssel ist der vereinheitlichte Name (siehe normalizeName unten), Wert
 * eine Funktion, die den bereits URL-kodierten Titel in die Adresse setzt.
 * Mehrere Schlüssel dürfen auf dieselbe Adresse zeigen, weil TMDB denselben
 * Dienst unter verschiedenen Namen führt ("Amazon Prime Video" für das Abo,
 * "Amazon Video" für Kauf und Leihe – beides findet man auf primevideo.com).
 *
 * @type {Map<string, (q: string) => string>}
 */
const SEARCH_URLS = new Map([
  // --- Die großen Abodienste -----------------------------------------------
  ['netflix', (q) => `https://www.netflix.com/search?q=${q}`],

  // Amazon: Abo, Kauf/Leihe und die "Channels" (Paramount+ Amazon Channel
  // usw., siehe AMAZON_CHANNEL unten) laufen alle über dieselbe Suche.
  ['amazonprimevideo', (q) => `https://www.primevideo.com/search?phrase=${q}`],
  ['primevideo', (q) => `https://www.primevideo.com/search?phrase=${q}`],
  ['amazonvideo', (q) => `https://www.primevideo.com/search?phrase=${q}`],

  ['disneyplus', (q) => `https://www.disneyplus.com/search?q=${q}`],

  // Apple: "Apple TV+" ist das Abo, "Apple TV" der Kaufladen (früher
  // iTunes). Beides zeigt dieselbe Suche auf tv.apple.com.
  ['appletvplus', (q) => `https://tv.apple.com/search?term=${q}`],
  ['appletv', (q) => `https://tv.apple.com/search?term=${q}`],
  ['itunes', (q) => `https://tv.apple.com/search?term=${q}`],

  ['paramountplus', (q) => `https://www.paramountplus.com/search/?q=${q}`],
  ['crunchyroll', (q) => `https://www.crunchyroll.com/de/search?q=${q}`],
  ['mubi', (q) => `https://mubi.com/de/de/search/films?query=${q}`],

  // YouTube: der Kaufbereich ("YouTube") und YouTube Premium.
  ['youtube', (q) => `https://www.youtube.com/results?search_query=${q}`],
  ['youtubepremium', (q) => `https://www.youtube.com/results?search_query=${q}`],

  // --- Deutsche Dienste ----------------------------------------------------
  ['joyn', (q) => `https://www.joyn.de/suche?q=${q}`],
  ['joynplus', (q) => `https://www.joyn.de/suche?q=${q}`],
  ['rtlplus', (q) => `https://plus.rtl.de/suche?query=${q}`],
  ['magentatv', (q) => `https://www.magentatv.de/suche?q=${q}`],

  // Öffentlich-rechtlich – kostenlos, tauchen bei TMDB unter "free" auf.
  ['ardmediathek', (q) => `https://www.ardmediathek.de/suche/${q}`],
  ['zdf', (q) => `https://www.zdf.de/suche?q=${q}`],
  ['zdfmediathek', (q) => `https://www.zdf.de/suche?q=${q}`],
  ['arte', (q) => `https://www.arte.tv/de/search/?q=${q}`],
]);

/**
 * Endungen, die nur die Abo-Variante bezeichnen, nicht den Dienst.
 *
 * "Netflix Standard with Ads" ist Netflix. Die Liste deckt sich mit
 * VARIANT_SUFFIXES in src/providers-canonical.js, ohne die "Channel"-
 * Endungen: Die haben hier eine eigene Bedeutung (siehe unten).
 * Längere Muster stehen vorn, sonst schneidet " ads" zu früh ab.
 */
const PLAN_SUFFIXES = [' basic with ads', ' standard with ads', ' with ads', ' ad-supported', ' ads'];

/**
 * "Paramount+ Amazon Channel" wird bei Amazon gebucht und dort geschaut,
 * nicht bei Paramount. Der Link muss also zu Amazon – das Gleiche gilt für
 * die Apple-TV-Channels.
 */
const AMAZON_CHANNEL = / amazon channel$/i;
const APPLE_CHANNEL = / apple tv channel$/i;

/**
 * Vereinheitlicht einen Anbieternamen für den Nachschlag in SEARCH_URLS.
 *
 * Kleinschreibung, "+" wird zu "plus", alles außer Buchstaben und Ziffern
 * fällt weg. So sind "Disney+", "Disney Plus" und "disney plus" derselbe
 * Schlüssel. Genau dieselbe Regel wie normalizeName() in
 * src/providers-canonical.js – nur kann das Frontend jene Datei nicht
 * laden, weil src/ nicht an den Browser ausgeliefert wird.
 *
 * @param {string} name
 * @returns {string}
 */
function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\+/g, ' plus ')
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * Baut die direkte Adresse zu einem Titel bei einem Anbieter.
 *
 * @param {string} providerName Anbietername, wie TMDB ihn liefert
 *                              (z. B. "Amazon Prime Video")
 * @param {string} title        Titel der Serie oder des Films
 * @returns {string|null} die Suchadresse beim Anbieter, oder null, wenn der
 *                        Anbieter unbekannt oder kein Titel da ist – dann
 *                        soll der Aufrufer den JustWatch-Link nehmen
 */
export function providerDirectLink(providerName, title) {
  const cleanTitle = String(title || '').trim();
  if (!cleanTitle || !providerName) return null;

  // encodeURIComponent statt eigener Ersetzungen: Titel wie "Love, Death &
  // Robots" oder "Mr. & Mrs. Smith" enthalten Zeichen, die sonst die
  // Adresse zerlegen würden ("&" beendet den Parameter).
  const q = encodeURIComponent(cleanTitle);

  let name = String(providerName).trim();

  // Erst die Channels: Sie gehören zu der Plattform, über die sie laufen.
  if (AMAZON_CHANNEL.test(name)) return SEARCH_URLS.get('primevideo')(q);
  if (APPLE_CHANNEL.test(name)) return SEARCH_URLS.get('appletv')(q);

  // Dann die Werbe-Varianten auf den Dienst zurückführen.
  const lower = name.toLowerCase();
  const suffix = PLAN_SUFFIXES.find((s) => lower.endsWith(s));
  if (suffix) name = name.slice(0, -suffix.length);

  const build = SEARCH_URLS.get(normalizeName(name));
  return build ? build(q) : null;
}
