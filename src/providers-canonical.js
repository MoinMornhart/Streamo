/**
 * ---------------------------------------------------------------------------
 * src/providers-canonical.js – Doppelte Streaming-Anbieter zusammenfassen
 * ---------------------------------------------------------------------------
 * Das Problem:
 *   TMDB führt denselben Dienst gleich mehrfach, weil JustWatch jede
 *   Abo-Variante und jeden Vertriebsweg getrennt zählt:
 *
 *     Netflix · Netflix basic with Ads · Netflix Standard with Ads
 *     Paramount Plus · Paramount+ Amazon Channel · Paramount+ Apple TV Channel
 *     WOW · WOW Amazon Channel
 *     Disney Plus · Disney+ Amazon Channel
 *
 *   In der Anbieter-Auswahl steht man dann vor drei Netflix-Kacheln und weiß
 *   nicht, welche gemeint ist. Und wer "Netflix" angeklickt hat, bekäme eine
 *   Serie, die nur unter "Netflix basic with Ads" geführt wird, nicht als
 *   "in deinem Abo" angezeigt – obwohl er sie sehen kann.
 *
 * Die Lösung:
 *   Jede Variante wird auf ihren Hauptanbieter zurückgeführt. Das geschieht
 *   auf zwei Wegen:
 *
 *     1. Über eine Liste bekannter IDs – die ist verlässlich und schnell.
 *     2. Über Namensmuster, falls TMDB eine neue Variante einführt, die die
 *        Liste noch nicht kennt. Endungen wie "with Ads" oder "Amazon
 *        Channel" werden abgeschnitten und der Rest mit den bekannten
 *        Anbietern verglichen.
 *
 * Verknüpfungen:
 *   - src/store.js -> beim Aufbau des Katalogs und beim Speichern der
 *                     Verfügbarkeiten
 * ---------------------------------------------------------------------------
 */

/**
 * Bekannte Varianten und ihr Hauptanbieter.
 *
 * Bewusst kurz gehalten. Der verlässlichere Weg ist die Auswertung der Namen
 * weiter unten: Sie erkennt jede Variante, deren Name auf "with Ads",
 * "Amazon Channel" und Ähnliches endet – auch solche, die es heute noch gar
 * nicht gibt. Diese Liste ist nur für Fälle da, in denen der Name allein
 * nicht ausreicht.
 *
 * Links die TMDB-ID der Variante, rechts die des Dienstes, unter dem sie
 * erscheinen soll.
 */
const VARIANT_TO_MAIN = new Map([
  // Netflix führt seine Werbe-Abos unter eigenen Kennungen. Die Namen enden
  // zwar auf "with Ads" und würden auch so erkannt – die Zuordnung hier wirkt
  // aber zusätzlich beim Speichern der Verfügbarkeiten, wo der vollständige
  // Katalog nicht zur Verfügung steht.
  [1796, 8], // Netflix basic with Ads
  [1855, 8], // Netflix Standard with Ads
]);

/**
 * Dienste, bei denen man einzelne Titel kauft oder leiht, statt sie zu
 * abonnieren.
 *
 * Sie erscheinen weiterhin in der Verfügbarkeitsanzeige einer Serie – dort
 * ist "bei Google Play für 3,99 € leihbar" ja eine nützliche Auskunft. Aus
 * der Abo-Auswahl gehören sie aber heraus: Man kann "Amazon Video" nicht
 * abonnieren, und eine Kachel dafür stiftet nur Verwirrung neben der Kachel
 * für "Amazon Prime Video".
 *
 * Erkannt wird über den Namen, nicht über die ID – das ist unabhängig von
 * der Region und überlebt Änderungen im TMDB-Katalog.
 */
const PURCHASE_ONLY_NAMES = [
  'amazon video',
  'google play movies',
  'google play',
  'apple tv', // der Kaufladen; "Apple TV+" ist ein anderer Eintrag
  'itunes',
  'microsoft store',
  'rakuten tv',
  'sky store',
  'videoload',
  'maxdome store',
  'youtube', // gemeint ist der Kaufbereich, nicht YouTube Premium
  'cineplex',
  'vudu',
  'fandango at home',
  'freenet video',
  'chili',
  'alleskino',
  'pantaflix',
];

/**
 * Sagt, ob ein Anbieter nur Kauf und Leihe anbietet.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isPurchaseOnly(name) {
  const lower = String(name || '').trim().toLowerCase();

  // Wörter, die einen Dienst eindeutig als Abo ausweisen. Steht eines davon
  // im Namen, ist es kein Kaufladen – auch wenn der Anfang des Namens gleich
  // lautet. So bleiben "Apple TV+" und "YouTube Premium" erhalten, während
  // "Apple TV" und "YouTube" aussortiert werden.
  const SUBSCRIPTION_MARKERS = ['+', 'plus', 'premium', 'unlimited'];

  if (SUBSCRIPTION_MARKERS.some((marker) => lower.includes(marker))) {
    return false;
  }

  return PURCHASE_ONLY_NAMES.some((entry) => {
    // Exakter Vergleich – der Regelfall.
    if (lower === entry) return true;
    // Und Schreibweisen mit Zusatz wie "Google Play Movies & TV".
    return lower.startsWith(entry + ' ');
  });
}

/**
 * Endungen, die eine Variante kennzeichnen.
 *
 * Wird eine davon am Namensende gefunden, gehört der Eintrag zu dem Dienst,
 * dessen Name übrig bleibt. Die Reihenfolge ist wichtig: Längere Muster
 * müssen zuerst geprüft werden, sonst schneidet "Channel" bereits ab, bevor
 * "Amazon Channel" greifen kann.
 */
const VARIANT_SUFFIXES = [
  ' basic with ads',
  ' standard with ads',
  ' with ads',
  ' amazon channel',
  ' apple tv channel',
  ' roku premium channel',
  ' premium channel',
  ' channel',
  ' ad-supported',
  ' ads',
];

/**
 * Vereinheitlicht einen Anbieternamen für den Vergleich.
 *
 * Kleinschreibung, "+" zu "plus", und alles außer Buchstaben und Ziffern
 * entfernt. Dadurch gelten "Paramount+", "Paramount Plus" und "paramount+"
 * als derselbe Name.
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
 * Entfernt eine bekannte Varianten-Endung, falls vorhanden.
 *
 * @param {string} name
 * @returns {string} der Name ohne Endung, sonst unverändert
 */
function stripVariantSuffix(name) {
  const lower = String(name || '').toLowerCase();

  for (const suffix of VARIANT_SUFFIXES) {
    if (lower.endsWith(suffix)) {
      return String(name).slice(0, -suffix.length).trim();
    }
  }

  return name;
}

/**
 * Führt eine Liste von Anbietern zusammen.
 *
 * Aus mehreren Einträgen desselben Dienstes wird einer. Welcher übrig bleibt,
 * entscheidet die Anzeige-Priorität von TMDB: Der geläufigste Eintrag hat die
 * kleinste Zahl, und genau der ist der, den man erwartet.
 *
 * @param {{id: number, name: string, logo_path?: string, display_priority?: number}[]} providers
 * @returns {{id: number, name: string, logo_path: string|null, display_priority: number}[]}
 *   zusammengefasst und nach Priorität sortiert
 */
export function mergeProviders(providers) {
  // Erster Durchgang: Alle Namen einsammeln, damit die Zuordnung über
  // Namensmuster weiß, welche Hauptanbieter es überhaupt gibt.
  /** @type {Map<string, {id: number, priority: number}>} normalisierter Name -> Anbieter */
  const byName = new Map();

  for (const provider of providers) {
    const name = String(provider.name ?? '');

    // Varianten kommen hier nicht infrage – sie sollen ja gerade nicht zum
    // Hauptanbieter werden.
    if (stripVariantSuffix(name) !== name) continue;
    if (VARIANT_TO_MAIN.has(provider.id)) continue;

    const key = normalizeName(name);
    const priority = provider.display_priority ?? 9999;

    const existing = byName.get(key);
    if (!existing || priority < existing.priority) {
      byName.set(key, { id: provider.id, priority });
    }
  }

  /**
   * Bestimmt, unter welcher ID ein Eintrag erscheinen soll.
   * @param {{id: number, name: string}} provider
   * @returns {number}
   */
  const resolveMainId = (provider) => {
    // 1. Bekannte Zuordnung – hat Vorrang.
    const known = VARIANT_TO_MAIN.get(provider.id);
    if (known !== undefined) return known;

    // 2. Namensmuster: Endung abschneiden und nachsehen, ob es den Dienst
    //    ohne Endung gibt.
    const base = stripVariantSuffix(provider.name);
    if (base !== provider.name) {
      const main = byName.get(normalizeName(base));
      if (main) return main.id;
    }

    // 3. Gleicher Name, andere ID (TMDB führt manche Dienste doppelt).
    const sameName = byName.get(normalizeName(provider.name));
    if (sameName && sameName.id !== provider.id) return sameName.id;

    return provider.id;
  };

  // Zweiter Durchgang: zusammenfassen.
  /** @type {Map<number, object>} */
  const merged = new Map();

  for (const provider of providers) {
    const mainId = resolveMainId(provider);
    const priority = provider.display_priority ?? 9999;

    const existing = merged.get(mainId);

    if (!existing) {
      merged.set(mainId, {
        id: mainId,
        // Für den Namen den Eintrag ohne Varianten-Endung bevorzugen.
        name: stripVariantSuffix(provider.name),
        logo_path: provider.logo_path ?? null,
        display_priority: priority,
      });
      continue;
    }

    // Der Eintrag mit der besseren (kleineren) Priorität bestimmt Name und
    // Logo – das ist der bekannteste und damit der erwartete.
    if (priority < existing.display_priority) {
      existing.name = stripVariantSuffix(provider.name);
      existing.logo_path = provider.logo_path ?? existing.logo_path;
      existing.display_priority = priority;
    }
  }

  return [...merged.values()].sort(
    (a, b) => a.display_priority - b.display_priority || a.name.localeCompare(b.name),
  );
}

/**
 * Gibt die Hauptanbieter-ID zu einer beliebigen Anbieter-ID zurück.
 *
 * Wird beim Speichern der Verfügbarkeiten gebraucht: Läuft eine Serie bei
 * "Netflix basic with Ads", soll sie unter "Netflix" auftauchen – sonst
 * erkennt Streamo sie nicht als im Abo enthalten.
 *
 * @param {number} providerId
 * @param {string} [name] Der Name hilft bei unbekannten Varianten
 * @returns {number}
 */
export function canonicalProviderId(providerId, name) {
  const known = VARIANT_TO_MAIN.get(providerId);
  if (known !== undefined) return known;

  // Ohne bekannte Zuordnung bleibt es bei der eigenen ID. Der Name allein
  // reicht hier nicht: Um "Netflix basic with Ads" der ID 8 zuzuordnen,
  // müsste man den gesamten Katalog kennen – und der steht an dieser Stelle
  // nicht zur Verfügung. Deshalb ist die Liste oben der verlässliche Weg,
  // und mergeProviders() fängt den Rest beim Aufbau des Katalogs ab.
  return providerId;
}

/**
 * Fasst die Angebote einer Serie zusammen, sodass derselbe Dienst nur einmal
 * erscheint.
 *
 * @param {{provider_id: number, provider_name?: string, logo_path?: string, display_priority?: number}[]} offers
 * @returns {object[]} ohne Doppelte
 */
export function mergeOffers(offers) {
  if (!Array.isArray(offers)) return [];

  // Dieselbe Zuordnung wie beim Katalog, statt einer eigenen, schwächeren.
  //
  // Früher lief hier nur die feste ID-Liste (canonicalProviderId). Die Endung
  // wurde trotzdem vom Namen abgeschnitten – bei einer Variante, die nicht in
  // der Liste steht, entstand so ein zweiter Eintrag mit gleichem Namen:
  // "HBO Max Amazon Channel" (1825) hieß danach "HBO Max", behielt aber seine
  // ID und stand neben dem echten HBO Max (1899). In der Statistik tauchte
  // der Dienst deshalb zweimal auf.
  //
  // mergeProviders() gleicht zusätzlich die Namen innerhalb der Liste ab und
  // führt die Variante auf den Hauptdienst zurück, sobald er ebenfalls
  // angeboten wird. TMDB liefert je Angebot genau diese vier Felder, es geht
  // beim Umbenennen also nichts verloren.
  const asProviders = offers.map((offer) => ({
    id: offer.provider_id,
    name: offer.provider_name ?? '',
    logo_path: offer.logo_path ?? null,
    display_priority: offer.display_priority ?? 9999,
  }));

  return mergeProviders(asProviders).map((provider) => ({
    provider_id: provider.id,
    provider_name: provider.name,
    logo_path: provider.logo_path,
    display_priority: provider.display_priority,
  }));
}
