/**
 * ---------------------------------------------------------------------------
 * src/recommend.js – Persönliche Empfehlungen
 * ---------------------------------------------------------------------------
 * Rolle im Gesamtsystem:
 *   "Entdecken" zeigt von sich aus, was gerade populär ist. Das ist für alle
 *   dasselbe und sagt nichts darüber aus, was DIR gefällt. Dieses Modul
 *   beantwortet die andere Frage: Was passt zu dem, was du schon gesehen hast?
 *
 *   Die Antwort entsteht ausschließlich aus eigenen Daten – der Bibliothek,
 *   den Bewertungen, den Favoriten, den abgehakten Folgen. Es gibt kein
 *   fremdes Empfehlungssystem und keine zusätzliche Anmeldung irgendwo.
 *
 * So wird gerechnet, in drei Schritten:
 *
 *   1. GESCHMACKSPROFIL (buildTasteProfile)
 *      Aus der Bibliothek werden "Saatkörner" gezogen: Titel, die du wirklich
 *      gesehen hast. Jeder bekommt ein Gewicht – eine 9 von 10 zählt mehr als
 *      eine 6, ein Favorit mehr als ein Nebenbei-Titel, eine abgeschlossene
 *      Serie mehr als eine angefangene. Abgebrochenes und Ungesehenes zählt
 *      gar nicht: Was auf der Merkliste liegt, hast du noch nicht beurteilt.
 *      Nebenbei entsteht ein Genre-Profil aus denselben Gewichten.
 *
 *   2. VORSCHLÄGE SAMMELN (getPersonalRecommendations)
 *      Zu jedem Saatkorn liefert TMDB ähnliche Titel. Wer bei mehreren
 *      Saatkörnern auftaucht, steigt: Das ist das eigentliche Signal. Dazu
 *      kommt ein zweiter Weg über die Lieblingsgenres, eingeschränkt auf die
 *      eigenen Abos – damit auch etwas dabei ist, das man sofort anschauen
 *      kann.
 *
 *   3. BEGRÜNDEN
 *      Jeder Vorschlag sagt, warum er da ist ("Weil du Breaking Bad gesehen
 *      hast"). Eine Empfehlung ohne Begründung ist nur eine Behauptung.
 *
 * Verknüpfungen:
 *   - src/db.js            -> library, shows, watched_episodes, user_providers
 *   - src/tmdb.js          -> getRecommendations, discover, getGenres
 *   - src/routes/search.js -> GET /api/search/for-you
 *   - public/js/views/discover.js -> die Leiste "Für dich" ganz oben
 *
 * Zum Zwischenspeicher: Ein Durchlauf kostet gut ein Dutzend TMDB-Aufrufe.
 * Deshalb wird das Ergebnis im Arbeitsspeicher gehalten – aber nur so lange,
 * wie sich die Bibliothek nicht ändert. Dafür sorgt ein "Fingerabdruck" aus
 * Anzahl und letztem Änderungszeitpunkt: Sobald du etwas hinzufügst,
 * bewertest oder abhakst, ändert er sich und die Empfehlungen werden neu
 * berechnet. Kein Aufräum-Zeitgeber nötig, keine veralteten Vorschläge.
 * ---------------------------------------------------------------------------
 */

import { all, get } from './db.js';
import * as tmdb from './tmdb.js';
import { normalizeListItem } from './tmdb.js';

// ===========================================================================
// Stellschrauben
// ===========================================================================

/**
 * So viele Saatkörner werden befragt. Jedes kostet einen TMDB-Aufruf, deshalb
 * ist die Zahl bewusst klein: Die zehn liebsten Titel beschreiben den
 * Geschmack schon ziemlich genau, der elfte ändert wenig.
 */
const MAX_SEEDS = 10;

/**
 * So viele Vorschläge kommen am Ende heraus, wenn nichts anderes verlangt ist.
 */
const DEFAULT_LIMIT = 20;

/**
 * Wie lange ein Ergebnis höchstens gilt, auch wenn sich die Bibliothek nicht
 * geändert hat. TMDB pflegt seine Ähnlichkeitslisten nach; nach einem halben
 * Tag darf ruhig neu gefragt werden.
 */
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Gewicht je Status in der Bibliothek.
 *
 * "watchlist" fehlt mit Absicht: Was man sich vorgenommen hat, sagt nichts
 * darüber aus, ob es einem gefallen hat. "dropped" fehlt ebenfalls – ein
 * Abbruch ist eher ein Gegenzeichen, und daraus Empfehlungen abzuleiten wäre
 * verkehrt herum.
 */
const STATUS_WEIGHT = {
  completed: 2.0, // durchgesehen – das stärkste Signal
  watching: 1.5, // läuft gerade, gefällt also offenbar
  paused: 0.6, // liegen geblieben – zählt, aber wenig
};

// ===========================================================================
// Zwischenspeicher
// ===========================================================================

/**
 * userId -> { key, at, payload }
 *
 * Bewusst nur im Arbeitsspeicher: Nach einem Neustart des Servers wird einmal
 * neu gerechnet, das dauert gut eine Sekunde. Eine Tabelle dafür anzulegen,
 * die man auch wieder aufräumen müsste, wäre teurer als der Nutzen.
 * @type {Map<number, {key: string, at: number, payload: object}>}
 */
const cache = new Map();

/**
 * Baut den Schlüssel, unter dem ein Ergebnis gilt.
 *
 * Er enthält alles, was das Ergebnis beeinflusst: den Zustand der Bibliothek
 * (Anzahl Einträge, letzte Änderung, Anzahl abgehakter Folgen) und die
 * Parameter der Anfrage. Ändert sich irgendetwas davon, passt der Schlüssel
 * nicht mehr und es wird neu gerechnet.
 *
 * @param {number} userId
 * @param {object} opts
 * @returns {string}
 */
function cacheKey(userId, opts) {
  const library = get(
    `SELECT COUNT(*) AS count, IFNULL(MAX(updated_at), '') AS latest
       FROM library
      WHERE user_id = ?`,
    userId,
  ) || { count: 0, latest: '' };

  // Abgehakte Folgen zählen mit: Wer eine Serie zu Ende sieht, verschiebt sein
  // Profil, auch wenn sich der Status in der Bibliothek nicht ändert.
  const episodes = get(
    'SELECT COUNT(*) AS count FROM watched_episodes WHERE user_id = ?',
    userId,
  ) || { count: 0 };

  return [
    library.count,
    library.latest,
    episodes.count,
    opts.mediaType || 'all',
    opts.region || '',
    opts.language || '',
    opts.limit || DEFAULT_LIMIT,
  ].join('|');
}

/**
 * Wirft den Zwischenspeicher eines Benutzers weg.
 *
 * Wird nicht zwingend gebraucht – der Fingerabdruck erledigt das von selbst –,
 * ist aber nützlich für Tests und für den Fall, dass jemand von Hand in der
 * Datenbank arbeitet.
 *
 * @param {number} [userId] ohne Angabe wird alles verworfen
 */
export function clearRecommendationCache(userId) {
  if (userId === undefined) cache.clear();
  else cache.delete(userId);
}

// ===========================================================================
// Schritt 1: Geschmacksprofil
// ===========================================================================

/**
 * Liest aus der Bibliothek heraus, was jemand mag.
 *
 * @param {number} userId
 * @param {object} [opts]
 * @param {'tv'|'movie'} [opts.mediaType] nur diesen Medientyp betrachten
 * @returns {{
 *   seeds: Array<{tmdbId:number, mediaType:string, title:string, weight:number}>,
 *   genres: Array<{name:string, weight:number}>,
 *   inLibrary: Set<string>,
 *   watchedCount: number
 * }}
 */
export function buildTasteProfile(userId, opts = {}) {
  // Alles aus der Bibliothek, samt der Anzahl abgehakter Folgen. Das
  // LEFT JOIN mit Unterabfrage statt eines GROUP BY über die ganze Tabelle:
  // So bleibt eine Zeile je Bibliothekseintrag, auch bei null Folgen.
  const rows = all(
    `SELECT s.tmdb_id, s.media_type, s.title, s.genres, s.vote_average,
            l.status, l.rating, l.favorite,
            (SELECT COUNT(*)
               FROM watched_episodes w
               JOIN episodes e ON e.id = w.episode_id
              WHERE w.user_id = l.user_id AND e.show_id = s.id) AS watched_episodes
       FROM library l
       JOIN shows s ON s.id = l.show_id
      WHERE l.user_id = ?`,
    userId,
  );

  const seeds = [];
  const genreWeights = new Map();

  // Alles, was schon in der Bibliothek steht – egal mit welchem Status –,
  // darf später nicht als Empfehlung auftauchen. Auch die Merkliste nicht:
  // Was man sich schon vorgemerkt hat, muss einem niemand mehr vorschlagen.
  const inLibrary = new Set();

  let watchedCount = 0;

  for (const row of rows) {
    inLibrary.add(`${row.media_type}:${row.tmdb_id}`);

    // Der Medientyp-Filter greift erst hier, nicht in der Abfrage: Die
    // Ausschlussliste soll beide Typen enthalten, das Profil nur den einen.
    if (opts.mediaType && row.media_type !== opts.mediaType) continue;

    // -- Gewicht bestimmen ---------------------------------------------------

    // Grundlage ist der Status. Was nicht in STATUS_WEIGHT steht (Merkliste,
    // Abgebrochenes), taugt nicht als Saatkorn.
    let weight = STATUS_WEIGHT[row.status];
    if (!weight) continue;

    // Eine eigene Bewertung ist das ehrlichste Signal und überschreibt die
    // Grundlage: 10 ergibt 3.0, 8 ergibt 1.8, 6 ergibt 0.6.
    if (row.rating != null) {
      // Unter 6 hat es einem nicht gefallen – daraus wollen wir nichts ableiten.
      if (row.rating < 6) continue;
      weight = (row.rating - 5) * 0.6;
    }

    // Ein Favorit ist eine ausdrückliche Ansage – aber eine ohne Zahl. Der
    // Aufschlag ist deshalb so bemessen, dass ein Favorit ohne Bewertung
    // unter einer glatten 10 bleibt: Wer eine Höchstnote vergeben hat, hat
    // sich deutlicher geäußert.
    if (row.favorite) weight += 1.0;

    // Wer viele Folgen abgehakt hat, hat sich wirklich damit beschäftigt.
    // Gedeckelt, damit eine 300-Folgen-Serie nicht alles andere erdrückt.
    if (row.watched_episodes > 0) {
      weight += Math.min(1.0, row.watched_episodes / 40);
      watchedCount += row.watched_episodes;
    }

    seeds.push({
      tmdbId: row.tmdb_id,
      mediaType: row.media_type,
      title: row.title,
      weight,
    });

    // -- Genres mitzählen ----------------------------------------------------

    // shows.genres liegt als JSON-Array von Namen vor (siehe src/store.js).
    // Kaputtes JSON darf die Empfehlungen nicht zum Absturz bringen.
    let genres = [];
    try {
      const parsed = JSON.parse(row.genres || '[]');
      if (Array.isArray(parsed)) genres = parsed;
    } catch {
      /* unbrauchbarer Eintrag – dann eben ohne Genres */
    }

    for (const name of genres) {
      genreWeights.set(name, (genreWeights.get(name) || 0) + weight);
    }
  }

  // Die stärksten Saatkörner zuerst; getPersonalRecommendations nimmt oben ab.
  seeds.sort((a, b) => b.weight - a.weight);

  const genres = [...genreWeights.entries()]
    .map(([name, weight]) => ({ name, weight }))
    .sort((a, b) => b.weight - a.weight);

  return { seeds, genres, inLibrary, watchedCount };
}

// ===========================================================================
// Schritt 2: Vorschläge sammeln
// ===========================================================================

/**
 * Übersetzt Genre-Namen in die TMDB-Kennungen, die /discover braucht.
 *
 * Die Namen stehen in der Sprache, in der die Serie geholt wurde – deshalb
 * wird die Genre-Liste in derselben Sprache abgefragt.
 *
 * @param {object} client TMDB-Zugang (für Tests ersetzbar)
 * @param {'tv'|'movie'} mediaType
 * @param {string} [language]
 * @returns {Promise<Map<string, number>>} Name (klein) -> ID
 */
async function loadGenreIndex(client, mediaType, language) {
  const data = await client.getGenres(mediaType, { language });

  return new Map((data.genres || []).map((genre) => [String(genre.name).toLowerCase(), genre.id]));
}

/**
 * Stellt die persönlichen Vorschläge zusammen.
 *
 * @param {number} userId
 * @param {object} [opts]
 * @param {'tv'|'movie'} [opts.mediaType] auf einen Typ beschränken
 * @param {string} [opts.region] Land für die Abo-Prüfung (z. B. "DE")
 * @param {string} [opts.language]
 * @param {number} [opts.limit]
 * @param {object} [opts.client] TMDB-Zugang; nur für Tests ersetzt
 * @param {boolean} [opts.noCache] Zwischenspeicher übergehen
 * @returns {Promise<{results: object[], basedOn: object[], reason: string|null}>}
 *   `results` sind fertige Kacheln, `basedOn` die verwendeten Saatkörner,
 *   `reason` ist gesetzt, wenn nichts empfohlen werden konnte.
 */
export async function getPersonalRecommendations(userId, opts = {}) {
  const client = opts.client || tmdb;
  const limit = opts.limit || DEFAULT_LIMIT;
  const language = opts.language;
  const mediaType = opts.mediaType === 'movie' || opts.mediaType === 'tv' ? opts.mediaType : null;

  // -- Zwischenspeicher ------------------------------------------------------
  const key = cacheKey(userId, { ...opts, limit });
  const cached = cache.get(userId);

  if (!opts.noCache && cached && cached.key === key && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.payload;
  }

  // -- Profil ----------------------------------------------------------------
  const profile = buildTasteProfile(userId, { mediaType });

  if (profile.seeds.length === 0) {
    // Kein Grund, TMDB zu behelligen. Das Frontend zeigt stattdessen einen
    // Hinweis, was zu tun ist, damit hier etwas erscheint.
    const payload = {
      results: [],
      basedOn: [],
      reason: 'Sieh dir ein paar Serien oder Filme an, dann entsteht hier eine Empfehlung.',
    };

    cache.set(userId, { key, at: Date.now(), payload });
    return payload;
  }

  const seeds = profile.seeds.slice(0, MAX_SEEDS);

  /**
   * Sammelstelle: "tv:1396" -> { item, score, because:Set<string> }
   * @type {Map<string, {item: object, score: number, because: Set<string>}>}
   */
  const candidates = new Map();

  /**
   * Trägt einen Vorschlag ein oder verstärkt einen vorhandenen.
   *
   * Der zweite Fall ist der wichtige: Ein Titel, der zu drei verschiedenen
   * Lieblingsserien passt, ist ein besserer Vorschlag als einer, der nur zu
   * einer passt. Genau das drückt das aufsummierte Gewicht aus.
   *
   * @param {object} raw roher TMDB-Eintrag
   * @param {'tv'|'movie'} type Medientyp, falls der Eintrag keinen trägt
   * @param {number} score Gewicht dieses Fundes
   * @param {string|null} because Begründung ("Breaking Bad" oder ein Genre)
   */
  function addCandidate(raw, type, score, because) {
    const item = normalizeListItem(raw, type);
    if (!item) return;

    // Ohne Poster wirkt eine Empfehlung wie ein Fehler – und meistens ist es
    // ein Randeintrag, den ohnehin niemand sucht.
    if (!item.posterPath) return;

    const id = `${item.mediaType}:${item.tmdbId}`;

    // Was schon in der Bibliothek steht, ist keine Entdeckung mehr.
    if (profile.inLibrary.has(id)) return;

    // Bei einem Medientyp-Filter alles andere verwerfen.
    if (mediaType && item.mediaType !== mediaType) return;

    const existing = candidates.get(id);

    if (existing) {
      existing.score += score;
      if (because) existing.because.add(because);
      return;
    }

    candidates.set(id, {
      item,
      score,
      because: new Set(because ? [because] : []),
    });
  }

  // -- Weg 1: ähnliche Titel zu den Saatkörnern ------------------------------
  //
  // Die Aufrufe laufen nacheinander, nicht parallel: src/tmdb.js drosselt
  // ohnehin auf einen Aufruf alle 60 ms, und ein Schwall paralleler Anfragen
  // brächte nur Fehler statt Tempo.
  for (const seed of seeds) {
    let data;

    try {
      data = await client.getRecommendations(seed.tmdbId, seed.mediaType, { language });
    } catch {
      // Ein Saatkorn, zu dem TMDB nichts weiß, darf nicht die ganze Leiste
      // kosten – die anderen liefern genug.
      continue;
    }

    const results = data.results || [];

    results.forEach((raw, index) => {
      // Die Liste kommt nach Relevanz sortiert; weiter hinten zählt weniger.
      // Der Boden von 0.4 sorgt dafür, dass auch Platz 20 noch mitspielt,
      // wenn er bei mehreren Saatkörnern auftaucht.
      const positionFactor = Math.max(0.4, 1 - index * 0.03);

      addCandidate(raw, seed.mediaType, seed.weight * positionFactor, seed.title);
    });
  }

  // -- Weg 2: Lieblingsgenres, eingeschränkt auf die eigenen Abos ------------
  //
  // Der erste Weg findet, was thematisch passt – aber vielleicht nirgends
  // läuft, wo man ein Abo hat. Dieser Weg gleicht das aus: Er fragt gezielt
  // nach dem, was in den verknüpften Abos verfügbar ist.
  const providerIds = all(
    'SELECT provider_id FROM user_providers WHERE user_id = ?',
    userId,
  ).map((row) => row.provider_id);

  const topGenres = profile.genres.slice(0, 3);

  if (topGenres.length > 0) {
    // Für beide Medientypen getrennt, weil TMDB getrennte Genre-Listen führt
    // ("Action & Adventure" gibt es nur bei Serien).
    const types = mediaType ? [mediaType] : ['tv', 'movie'];

    for (const type of types) {
      try {
        const genreIndex = await loadGenreIndex(client, type, language);

        const genreIds = topGenres
          .map((genre) => genreIndex.get(genre.name.toLowerCase()))
          .filter((id) => id !== undefined);

        if (genreIds.length === 0) continue;

        const data = await client.discover({
          mediaType: type,
          providerIds,
          region: opts.region,
          language,
          genres: genreIds.join(','),
          sortBy: 'vote_average.desc',
          // Gegen Ausreißer: Ein Titel mit fünf Bewertungen und 10,0 ist kein
          // guter Vorschlag, sondern ein Zufall.
          minVotes: 300,
        });

        const label = topGenres.map((genre) => genre.name).join(', ');

        (data.results || []).forEach((raw, index) => {
          // Bewusst schwächer als Weg 1: Ein Genre-Treffer ist ein gröberes
          // Signal als "passt zu dieser konkreten Serie". Er soll die Liste
          // ergänzen, nicht bestimmen.
          const score = Math.max(0.2, 0.8 - index * 0.03);

          addCandidate(raw, type, score, `deinen Vorlieben (${label})`);

          // Diese Titel laufen nachweislich in einem der eigenen Abos –
          // das ist einen eigenen Hinweis auf der Kachel wert.
          if (providerIds.length > 0) {
            const entry = candidates.get(`${type}:${raw.id}`);
            if (entry) entry.inMySubscriptions = true;
          }
        });
      } catch {
        // Ohne diesen zweiten Weg sind die Empfehlungen etwas ärmer, aber
        // brauchbar. Kein Grund, die ganze Anfrage scheitern zu lassen.
      }
    }
  }

  // -- Schritt 3: sortieren, begründen, abschneiden ---------------------------
  const results = [...candidates.values()]
    .sort((a, b) => {
      // Bei fast gleichem Gewicht entscheidet die TMDB-Bewertung. "Fast
      // gleich" heißt hier: weniger als 0.05 Unterschied – darunter ist der
      // Vorsprung ohnehin Rauschen.
      if (Math.abs(b.score - a.score) > 0.05) return b.score - a.score;
      return (b.item.voteAverage ?? 0) - (a.item.voteAverage ?? 0);
    })
    .slice(0, limit)
    .map((entry) => ({
      ...entry.item,

      // Die Begründung, die auf der Kachel steht. Bis zu zwei Titel werden
      // genannt – bei mehr wird die Zeile länger als die Kachel breit ist.
      reason: buildReason([...entry.because]),

      // Für die Anzeige eines Abo-Hinweises.
      inMySubscriptions: Boolean(entry.inMySubscriptions),

      // Nicht fürs UI gedacht, aber hilfreich beim Nachvollziehen, warum
      // etwas oben steht.
      matchScore: Math.round(entry.score * 100) / 100,
    }));

  const payload = {
    results,
    // Woraus das Ganze entstanden ist – das Frontend schreibt es unter die
    // Überschrift, damit nachvollziehbar bleibt, was Streamo über einen weiß.
    basedOn: seeds.map((seed) => ({ title: seed.title, mediaType: seed.mediaType })),
    reason: results.length === 0 ? 'Zu deinen Titeln hat TMDB nichts Passendes gefunden.' : null,
  };

  cache.set(userId, { key, at: Date.now(), payload });

  return payload;
}

/**
 * Formt aus den gesammelten Anlässen einen lesbaren Satz.
 *
 * @param {string[]} because Titel oder Genre-Beschreibungen
 * @returns {string}
 */
function buildReason(because) {
  if (because.length === 0) return 'Passt zu deiner Bibliothek';

  // Genre-Begründungen beginnen mit "deinen …" und sind bewusst zweite Wahl:
  // Ein konkreter Titel ist die bessere Erklärung.
  const titles = because.filter((entry) => !entry.startsWith('deinen '));
  const chosen = titles.length > 0 ? titles : because;

  if (chosen.length === 1) return `Weil du ${quote(chosen[0])} gesehen hast`;
  if (chosen.length === 2) return `Weil du ${quote(chosen[0])} und ${quote(chosen[1])} gesehen hast`;

  return `Weil du ${quote(chosen[0])}, ${quote(chosen[1])} und ${chosen.length - 2} weitere gesehen hast`;
}

/**
 * Setzt einen Titel in deutsche Anführungszeichen – aber nur, wenn es ein
 * Titel ist. Die Genre-Begründung liest sich ohne besser.
 *
 * @param {string} text
 * @returns {string}
 */
function quote(text) {
  return text.startsWith('deinen ') ? text : `„${text}“`;
}
