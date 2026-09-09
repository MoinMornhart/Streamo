/**
 * ---------------------------------------------------------------------------
 * src/tmdb.js – Client für die TMDB-API (Metadaten + Streaming-Verfügbarkeit)
 * ---------------------------------------------------------------------------
 * Rolle im Gesamtsystem:
 *   Das ist die einzige Stelle, an der Streamo mit der Außenwelt spricht.
 *   Alles, was das Projekt ausmacht – Serien finden, Poster holen, und vor
 *   allem "wo läuft das gerade?" – kommt von hier.
 *
 * Woher kommen die Streaming-Informationen?
 *   TMDB (themoviedb.org) liefert unter /watch/providers die Daten von
 *   JustWatch. Das ist dieselbe Quelle, die auch die großen Vergleichsseiten
 *   benutzen: pro Land eine Liste von Anbietern, aufgeteilt nach Abo
 *   (flatrate), Werbefinanziert (ads), Gratis (free), Leihe (rent) und Kauf
 *   (buy). Genau diese Aufteilung landet 1:1 in unserer Tabelle
 *   `availability` (siehe src/db.js).
 *
 *   Wichtig für die Nutzungsbedingungen: TMDB verlangt, dass die JustWatch-
 *   Attribution sichtbar ist. Das erledigt das Frontend im Footer und auf der
 *   Detailseite (public/js/views/detail.js).
 *
 * Verknüpfungen zu anderen Dateien:
 *   - src/config.js        -> Start-API-Key, Region, Sprache
 *   - src/db.js            -> getSetting('tmdb_api_key') überschreibt die .env
 *   - src/store.js         -> schreibt die hier geholten Daten in die Tabellen
 *   - src/routes/search.js -> Suche und Discover
 *   - src/sync.js          -> periodische Auffrischung
 * ---------------------------------------------------------------------------
 */

import config from './config.js';
import { getSetting } from './db.js';

/** Basis-URL der TMDB-REST-API (Version 3 der Endpunkte). */
const API_BASE = 'https://api.themoviedb.org/3';

/** Basis-URL für Bilder. Der Größen-Ordner wird beim Bauen ergänzt. */
export const IMAGE_BASE = 'https://image.tmdb.org/t/p';

/**
 * Fehlerklasse für alle TMDB-Probleme.
 * Trägt den HTTP-Status mit, damit die Routen ihn an das Frontend
 * durchreichen können (z. B. 401 -> "API-Key ungültig").
 */
export class TmdbError extends Error {
  /**
   * @param {string} message Lesbare Meldung (wird im UI angezeigt)
   * @param {number} status  HTTP-Status der TMDB-Antwort
   */
  constructor(message, status = 500) {
    super(message);
    this.name = 'TmdbError';
    this.status = status;
  }
}

/**
 * Ermittelt die zur Laufzeit gültigen Einstellungen.
 *
 * Rangfolge (das Spätere gewinnt):
 *   1. .env  (config.tmdbApiKey / config.region / config.language)
 *   2. Tabelle `settings` – im UI gesetzt, überschreibt die .env
 *   3. Der übergebene Benutzer – seine persönliche Region/Sprache
 *
 * Dadurch kann man Streamo komplett ohne .env einrichten (alles im
 * Setup-Assistenten), und in einer Familien-Instanz darf trotzdem jede Person
 * ihre eigene Region haben.
 *
 * @param {object|null} [user] Optionaler Benutzer aus req.user
 * @returns {{apiKey: string, region: string, language: string}}
 */
export function getRuntimeSettings(user = null) {
  const apiKey = getSetting('tmdb_api_key', '') || config.tmdbApiKey || '';

  const region = (user?.region || getSetting('region', '') || config.region || 'DE').toUpperCase();
  const language = user?.language || getSetting('language', '') || config.language || 'de-DE';

  return { apiKey, region, language };
}

/**
 * Sagt, ob überhaupt ein API-Key hinterlegt ist.
 * Wird von /api/health und vom Setup-Assistenten benutzt, um zu entscheiden,
 * ob die Einrichtung noch aussteht.
 * @returns {boolean}
 */
export function hasApiKey() {
  return Boolean(getRuntimeSettings().apiKey);
}

// --------------------------------------------------------------------------
// Sanftes Rate-Limiting.
// TMDB erlaubt sehr großzügige ~50 Anfragen pro Sekunde. Der Sync-Lauf könnte
// diese Grenze bei einer großen Bibliothek trotzdem reißen, deshalb halten wir
// einen Mindestabstand zwischen zwei Aufrufen ein. Die Umsetzung ist bewusst
// simpel: eine Promise-Kette, an die sich jeder Aufruf hinten anstellt.
// --------------------------------------------------------------------------

/** Mindestabstand zwischen zwei TMDB-Aufrufen in Millisekunden. */
const MIN_REQUEST_GAP_MS = 60;

/** Zeitpunkt des letzten Aufrufs (Epoch-Millisekunden). */
let lastRequestAt = 0;

/** Die Warteschlange: jeder neue Aufruf hängt sich an das Ende dieser Kette. */
let requestChain = Promise.resolve();

/**
 * Reiht eine Aufgabe in die Warteschlange ein und stellt sicher, dass
 * zwischen zwei Ausführungen mindestens MIN_REQUEST_GAP_MS liegen.
 * @template T
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
function enqueue(task) {
  const result = requestChain.then(async () => {
    const wait = MIN_REQUEST_GAP_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt = Date.now();
    return task();
  });

  // Die Kette selbst darf nie in den Fehlerzustand geraten – sonst würden alle
  // nachfolgenden Aufrufe abgelehnt. Deshalb hier ein leerer catch; der Fehler
  // selbst wird über `result` an den Aufrufer weitergereicht.
  requestChain = result.then(
    () => {},
    () => {},
  );

  return result;
}

/**
 * Führt einen GET-Aufruf gegen die TMDB-API aus.
 *
 * Authentifizierung: TMDB kennt zwei Schlüsselarten, und Streamo akzeptiert
 * beide, damit niemand rätseln muss, welchen er aus dem TMDB-Konto kopieren soll:
 *   - v4 "API Read Access Token": ein langer JWT, beginnt mit "eyJ".
 *     Wird als "Authorization: Bearer …"-Header geschickt.
 *   - v3 "API Key": 32 Zeichen, wird als Query-Parameter ?api_key= angehängt.
 *
 * @param {string} path   Endpunktpfad, z. B. "/tv/1399"
 * @param {object} [params] Query-Parameter; undefined/null-Werte fliegen raus
 * @param {object} [options]
 * @param {string} [options.apiKey] Expliziter Key (für den Setup-Test, bevor
 *                                  der Key gespeichert wurde)
 * @returns {Promise<object>} geparste JSON-Antwort
 * @throws {TmdbError}
 */
export async function tmdbFetch(path, params = {}, options = {}) {
  const apiKey = options.apiKey || getRuntimeSettings().apiKey;

  if (!apiKey) {
    throw new TmdbError(
      'Kein TMDB-API-Key hinterlegt. Trage ihn in den Einstellungen ein.',
      412, // 412 Precondition Failed – das Frontend zeigt daraufhin den Setup-Hinweis.
    );
  }

  const url = new URL(API_BASE + path);

  // Query-Parameter anhängen, leere Werte überspringen.
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }

  // Ein JWT (v4-Token) besteht aus drei mit Punkten getrennten Teilen und
  // beginnt mit "eyJ" (Base64 von '{"'). Alles andere behandeln wir als v3-Key.
  const isBearerToken = apiKey.startsWith('eyJ') && apiKey.split('.').length === 3;

  const headers = { accept: 'application/json' };
  if (isBearerToken) {
    headers.Authorization = `Bearer ${apiKey}`;
  } else {
    url.searchParams.set('api_key', apiKey);
  }

  return enqueue(async () => {
    // AbortController als Zeitlimit: Ein hängender Aufruf darf den Sync-Lauf
    // nicht endlos blockieren.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    let response;
    try {
      response = await fetch(url, { headers, signal: controller.signal });
    } catch (error) {
      // Netzwerkfehler oder Zeitüberschreitung.
      throw new TmdbError(
        error.name === 'AbortError'
          ? 'TMDB hat nicht rechtzeitig geantwortet.'
          : `TMDB nicht erreichbar: ${error.message}`,
        503,
      );
    } finally {
      clearTimeout(timeout);
    }

    // 429 = Rate Limit. TMDB schickt ein Retry-After-Header; wir warten
    // einmalig und versuchen es erneut. Schlägt es dann wieder fehl, geben wir auf.
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('retry-after')) || 2;
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      response = await fetch(url, { headers });
    }

    if (!response.ok) {
      // TMDB liefert Fehler als JSON mit status_message – die ist deutlich
      // aussagekräftiger als der reine Statuscode.
      let message = `TMDB-Fehler ${response.status}`;
      try {
        const body = await response.json();
        if (body?.status_message) message = body.status_message;
      } catch {
        /* Antwort war kein JSON – dann bleibt es bei der generischen Meldung */
      }

      // Den häufigsten Fall übersetzen, damit im UI nicht "Invalid API key"
      // auf Englisch steht.
      if (response.status === 401) {
        message = 'TMDB-API-Key ungültig. Bitte in den Einstellungen prüfen.';
      }

      throw new TmdbError(message, response.status);
    }

    return response.json();
  });
}

// --------------------------------------------------------------------------
// Konkrete Endpunkte
// --------------------------------------------------------------------------

/**
 * Prüft einen API-Key, indem der Konfigurations-Endpunkt aufgerufen wird.
 * Genutzt vom Setup-Assistenten, damit der Benutzer sofort Rückmeldung bekommt,
 * statt erst bei der ersten Suche zu scheitern.
 *
 * @param {string} apiKey Zu prüfender Schlüssel
 * @returns {Promise<boolean>} true, wenn er funktioniert
 */
export async function testApiKey(apiKey) {
  await tmdbFetch('/configuration', {}, { apiKey });
  return true;
}

/**
 * Volltextsuche über Serien UND Filme gleichzeitig ("multi").
 *
 * @param {string} query Suchbegriff
 * @param {object} [opts]
 * @param {string} [opts.language] Metadatensprache
 * @param {number} [opts.page]     Seitenzahl (TMDB liefert 20 Treffer je Seite)
 * @returns {Promise<object>} Rohantwort mit results/page/total_pages
 */
export function searchMulti(query, opts = {}) {
  return tmdbFetch('/search/multi', {
    query,
    language: opts.language,
    page: opts.page || 1,
    // Erwachseneninhalte ausblenden.
    include_adult: false,
  });
}

/**
 * Holt die vollständigen Details einer Serie oder eines Films.
 *
 * `append_to_response` ist der wichtigste Trick hier: Damit liefert TMDB
 * mehrere Endpunkte in EINER Antwort. Wir hängen an:
 *   - watch/providers -> die Streaming-Verfügbarkeit (der Kern von Streamo)
 *   - external_ids    -> IMDb-/TVDB-IDs für Deeplinks
 *   - aggregate_credits/credits -> Besetzung
 * Das spart drei zusätzliche HTTP-Aufrufe pro Serie.
 *
 * @param {number} tmdbId
 * @param {'tv'|'movie'} [mediaType]
 * @param {object} [opts]
 * @param {string} [opts.language]
 * @returns {Promise<object>}
 */
export function getDetails(tmdbId, mediaType = 'tv', opts = {}) {
  const credits = mediaType === 'tv' ? 'aggregate_credits' : 'credits';

  return tmdbFetch(`/${mediaType}/${tmdbId}`, {
    language: opts.language,
    append_to_response: `watch/providers,external_ids,${credits}`,
  });
}

/**
 * Holt NUR die Verfügbarkeiten. Wird vom Sync-Lauf benutzt, wenn die
 * Metadaten noch frisch sind und nur die Anbieter geprüft werden müssen.
 *
 * Antwortstruktur von TMDB:
 *   { id: 1399, results: { DE: { link, flatrate: [...], rent: [...] }, US: {…} } }
 *
 * @param {number} tmdbId
 * @param {'tv'|'movie'} [mediaType]
 * @returns {Promise<object>}
 */
export function getWatchProviders(tmdbId, mediaType = 'tv') {
  // Kein language-Parameter: Dieser Endpunkt ist sprachunabhängig.
  return tmdbFetch(`/${mediaType}/${tmdbId}/watch/providers`);
}

/**
 * Holt den Katalog aller Streaming-Anbieter einer Region.
 * Das ist die Liste, aus der der Benutzer im UI seine Abos anklickt
 * (public/js/views/providers.js -> Tabelle user_providers).
 *
 * @param {'tv'|'movie'} [mediaType] Anbieter unterscheiden sich je Medientyp
 * @param {object} [opts]
 * @param {string} [opts.region]   ISO-3166-1, z. B. "DE"
 * @param {string} [opts.language]
 * @returns {Promise<object>}
 */
export function getProviderCatalog(mediaType = 'tv', opts = {}) {
  return tmdbFetch(`/watch/providers/${mediaType}`, {
    watch_region: opts.region,
    language: opts.language,
  });
}

/**
 * Holt alle Episoden einer Staffel in einem Aufruf.
 * Verknüpfung: Das Ergebnis füllt die Tabelle `episodes` (src/store.js).
 *
 * @param {number} tmdbId
 * @param {number} seasonNumber
 * @param {object} [opts]
 * @param {string} [opts.language]
 * @returns {Promise<object>} mit .episodes-Array
 */
export function getSeason(tmdbId, seasonNumber, opts = {}) {
  return tmdbFetch(`/tv/${tmdbId}/season/${seasonNumber}`, {
    language: opts.language,
  });
}

/**
 * "Was kann ich mit meinen Abos schauen?" – der Discover-Endpunkt.
 *
 * Das ist die Funktion, die die verknüpften Anbieter tatsächlich ausnutzt:
 * Man übergibt die Provider-IDs aus `user_providers`, und TMDB liefert nur
 * Titel zurück, die in der eigenen Region bei genau diesen Anbietern laufen.
 *
 * @param {object} opts
 * @param {'tv'|'movie'} [opts.mediaType]
 * @param {number[]} [opts.providerIds] IDs aus user_providers
 * @param {string} [opts.region]
 * @param {string} [opts.language]
 * @param {string} [opts.sortBy]     z. B. "popularity.desc", "vote_average.desc"
 * @param {number|string} [opts.genres] Komma-getrennte TMDB-Genre-IDs
 * @param {number} [opts.page]
 * @param {number} [opts.minVotes]   Mindestanzahl Bewertungen gegen Ausreißer
 * @returns {Promise<object>}
 */
export function discover(opts = {}) {
  const mediaType = opts.mediaType === 'movie' ? 'movie' : 'tv';

  return tmdbFetch(`/discover/${mediaType}`, {
    language: opts.language,
    watch_region: opts.region,
    // Komma = ODER-Verknüpfung: "läuft bei mindestens einem meiner Anbieter".
    // (Eine Pipe "|" wäre hier gleichbedeutend; TMDB nutzt Komma für OR bei
    // with_watch_providers.)
    with_watch_providers: opts.providerIds?.length ? opts.providerIds.join('|') : undefined,
    // Nur Abo-Inhalte: Leih- und Kaufangebote helfen nicht, wenn man nach
    // "was ist in meinem Abo drin" fragt.
    with_watch_monetization_types: opts.providerIds?.length ? 'flatrate' : undefined,
    with_genres: opts.genres,
    sort_by: opts.sortBy || 'popularity.desc',
    'vote_count.gte': opts.minVotes ?? 50,
    page: opts.page || 1,
    include_adult: false,
  });
}

/**
 * Aktuell angesagte Titel (Startseite, wenn die Bibliothek noch leer ist).
 * @param {object} [opts]
 * @param {'tv'|'movie'|'all'} [opts.mediaType]
 * @param {'day'|'week'} [opts.window]
 * @param {string} [opts.language]
 * @returns {Promise<object>}
 */
export function getTrending(opts = {}) {
  const mediaType = opts.mediaType || 'tv';
  const window = opts.window === 'day' ? 'day' : 'week';

  return tmdbFetch(`/trending/${mediaType}/${window}`, { language: opts.language });
}

/**
 * Ähnliche Titel zu einer Serie ("weil du X gesehen hast").
 * @param {number} tmdbId
 * @param {'tv'|'movie'} [mediaType]
 * @param {object} [opts]
 * @returns {Promise<object>}
 */
export function getRecommendations(tmdbId, mediaType = 'tv', opts = {}) {
  return tmdbFetch(`/${mediaType}/${tmdbId}/recommendations`, {
    language: opts.language,
  });
}

/**
 * Genre-Liste für die Filterleiste.
 * @param {'tv'|'movie'} [mediaType]
 * @param {object} [opts]
 * @returns {Promise<object>} mit .genres = [{id, name}]
 */
export function getGenres(mediaType = 'tv', opts = {}) {
  return tmdbFetch(`/genre/${mediaType}/list`, { language: opts.language });
}

/**
 * Holt eine offizielle Filmreihe ("Collection") mit allen ihren Teilen.
 *
 * TMDB pflegt für zusammengehörige Filme solche Reihen – "Kingsman",
 * "Der Herr der Ringe", "John Wick". Bei den Details eines Films steht die
 * zugehörige Reihe im Feld `belongs_to_collection`; von dort führt der Weg
 * hierher.
 *
 * Verknüpfung: Das Ergebnis füllt die Tabellen `collections` und
 * `collection_items` (src/collections.js).
 *
 * @param {number} collectionId TMDB-Kennung der Reihe
 * @param {object} [opts]
 * @param {string} [opts.language]
 * @returns {Promise<object>} mit .parts = die einzelnen Filme
 */
export function getCollection(collectionId, opts = {}) {
  return tmdbFetch(`/collection/${collectionId}`, { language: opts.language });
}

/**
 * Sucht nach Filmreihen anhand ihres Namens.
 *
 * Gebraucht, wenn jemand eine Reihe hinzufügen möchte, ohne erst einen ihrer
 * Filme zu suchen – "Kingsman" eingeben und die Reihe bekommen.
 *
 * @param {string} query
 * @param {object} [opts]
 * @param {string} [opts.language]
 * @returns {Promise<object>} mit .results = [{id, name, poster_path, …}]
 */
export function searchCollections(query, opts = {}) {
  return tmdbFetch('/search/collection', {
    query,
    language: opts.language,
  });
}

/**
 * Vereinheitlicht einen TMDB-Listeneintrag zu der Form, die das Frontend
 * erwartet.
 *
 * TMDB benennt dieselben Dinge je nach Medientyp unterschiedlich (name/title,
 * first_air_date/release_date). Hier wird das einmal geglättet, damit sich das
 * UI nicht darum kümmern muss.
 *
 * Diese Funktion steht bewusst hier und nicht in einer Route: Sie wird von
 * mehreren Stellen gebraucht, die dieselbe Form liefern müssen, damit das
 * Frontend überall dieselbe Kachel zeichnen kann.
 *
 * Verwendet von:
 *   - src/routes/search.js  -> Suche, Entdecken, Trending
 *   - src/recommend.js      -> persönliche Empfehlungen
 *
 * @param {object} item Eintrag aus results[]
 * @param {'tv'|'movie'} [forcedType] Medientyp, falls der Eintrag keinen trägt
 *   (nur /search/multi liefert media_type mit; /discover und /trending nicht)
 * @returns {object|null} null, wenn der Eintrag kein Film und keine Serie ist
 */
export function normalizeListItem(item, forcedType) {
  const mediaType = item.media_type || forcedType;

  // /search/multi liefert auch Personen ("person") – die filtern wir raus.
  if (mediaType !== 'tv' && mediaType !== 'movie') return null;

  const isTv = mediaType === 'tv';

  return {
    tmdbId: item.id,
    mediaType,
    title: isTv ? item.name : item.title,
    originalTitle: isTv ? item.original_name : item.original_title,
    overview: item.overview || '',
    posterPath: item.poster_path,
    backdropPath: item.backdrop_path,
    // Nur das Jahr, mehr braucht die Kachel nicht.
    year: (isTv ? item.first_air_date : item.release_date)?.slice(0, 4) || null,
    voteAverage: item.vote_average ?? null,
    // Bei Listeneinträgen liefert TMDB nur Genre-IDs, keine Namen. Die
    // Auflösung passiert im Frontend über die Liste aus /api/search/genres.
    genreIds: item.genre_ids || [],
    popularity: item.popularity ?? 0,
  };
}
