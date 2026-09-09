/**
 * ---------------------------------------------------------------------------
 * src/store.js – Die Brücke zwischen TMDB und der lokalen Datenbank
 * ---------------------------------------------------------------------------
 * Rolle im Gesamtsystem:
 *   src/tmdb.js holt Rohdaten, src/db.js kennt die Tabellen – dieses Modul
 *   dazwischen übersetzt das eine ins andere und ist damit der Ort, an dem
 *   "eine Serie kommt in meine Datenbank" tatsächlich passiert.
 *
 *   Alle Funktionen hier sind idempotent: Man kann sie beliebig oft mit
 *   denselben Daten aufrufen, es entstehen keine Duplikate. Das ist die
 *   Voraussetzung dafür, dass der Hintergrund-Sync (src/sync.js) einfach
 *   stumpf über alle Serien laufen kann.
 *
 * Verknüpfungen zu anderen Dateien:
 *   - src/tmdb.js          -> Datenquelle
 *   - src/db.js            -> Zieltabellen shows, episodes, availability, providers
 *   - src/routes/library.js-> ruft ensureShow beim Hinzufügen zur Bibliothek
 *   - src/routes/shows.js  -> ruft refreshShow / loadSeason für die Detailseite
 *   - src/sync.js          -> ruft refreshAvailability im Hintergrund
 * ---------------------------------------------------------------------------
 */

import { get, all, run, transaction } from './db.js';
import * as tmdb from './tmdb.js';
// Fasst Anbieter-Varianten zusammen ("Netflix basic with Ads" -> "Netflix").
import { mergeProviders, mergeOffers } from './providers-canonical.js';

/**
 * Die fünf Angebotsarten, die TMDB im /watch/providers-Endpunkt liefert.
 * Die Reihenfolge ist bewusst gewählt: Sie entspricht der Priorität in der
 * Anzeige – "im Abo enthalten" steht immer vor "kostenlos mit Werbung" und
 * das wiederum vor "leihen/kaufen".
 * Verknüpfung: Diese Strings sind exakt die im CHECK-Constraint von
 * availability.offer_type erlaubten Werte (src/db.js).
 */
export const OFFER_TYPES = ['flatrate', 'free', 'ads', 'rent', 'buy'];

/**
 * Wie lange gelten zwischengespeicherte Daten als "frisch"?
 * Metadaten (Titel, Poster, Staffelzahl) ändern sich selten, Verfügbarkeiten
 * dagegen ständig – deshalb zwei unterschiedliche Werte.
 */
const METADATA_TTL_HOURS = 24 * 7; // eine Woche
const AVAILABILITY_TTL_HOURS = 24; // ein Tag

/**
 * Prüft, ob ein ISO-Zeitstempel jünger ist als die angegebene Stundenzahl.
 * @param {string|null} timestamp SQLite-Zeitstempel ("YYYY-MM-DD HH:MM:SS", UTC)
 * @param {number} hours
 * @returns {boolean} true = noch frisch, kein neuer API-Aufruf nötig
 */
function isFresh(timestamp, hours) {
  if (!timestamp) return false;

  // SQLite speichert ohne Zeitzonenkennung, meint aber UTC. Das "Z" hängen wir
  // an, damit Date es nicht als Ortszeit interpretiert und wir je nach Server-
  // Zeitzone stundenweise danebenliegen.
  const parsed = Date.parse(timestamp.replace(' ', 'T') + 'Z');
  if (Number.isNaN(parsed)) return false;

  return Date.now() - parsed < hours * 3_600_000;
}

// --------------------------------------------------------------------------
// Serien / Filme
// --------------------------------------------------------------------------

/**
 * Sucht eine Serie im lokalen Cache.
 * @param {number} tmdbId
 * @param {'tv'|'movie'} mediaType
 * @returns {object|undefined} Zeile aus `shows`
 */
export function findShow(tmdbId, mediaType = 'tv') {
  return get('SELECT * FROM shows WHERE tmdb_id = ? AND media_type = ?', tmdbId, mediaType);
}

/**
 * Lädt eine Serie über die interne ID.
 * @param {number} showId shows.id
 * @returns {object|undefined}
 */
export function findShowById(showId) {
  return get('SELECT * FROM shows WHERE id = ?', showId);
}

/**
 * Schreibt die TMDB-Details in die Tabelle `shows` – anlegen oder aktualisieren.
 *
 * Die Feldnamen unterscheiden sich zwischen Serien und Filmen (name/title,
 * first_air_date/release_date, episode_run_time/runtime). Diese Funktion
 * vereinheitlicht sie, damit der Rest der Anwendung nicht ständig zwischen
 * beiden Medientypen unterscheiden muss.
 *
 * @param {object} details Antwort von tmdb.getDetails()
 * @param {'tv'|'movie'} mediaType
 * @returns {object} die gespeicherte Zeile aus `shows`
 */
export function upsertShow(details, mediaType = 'tv') {
  const isTv = mediaType === 'tv';

  // --- Felder normalisieren ------------------------------------------------
  const title = isTv ? details.name : details.title;
  const originalTitle = isTv ? details.original_name : details.original_title;
  const firstAirDate = isTv ? details.first_air_date : details.release_date;
  const lastAirDate = isTv ? details.last_air_date : details.release_date;

  // Serien liefern ein Array möglicher Episodenlängen (z. B. [42, 45]);
  // wir nehmen den ersten Wert als Richtwert für die Statistik.
  const runtime = isTv
    ? Array.isArray(details.episode_run_time)
      ? details.episode_run_time[0] ?? null
      : null
    : details.runtime ?? null;

  // Genres werden als JSON-Array von Namen abgelegt (siehe shows.genres).
  const genres = JSON.stringify((details.genres || []).map((g) => g.name));

  // Bei Filmen gibt es keine Staffeln – 1 Staffel / 1 "Episode" macht die
  // Fortschrittsanzeige im UI einheitlich benutzbar.
  const seasons = isTv ? details.number_of_seasons ?? null : 1;
  const episodes = isTv ? details.number_of_episodes ?? null : 1;

  run(
    `INSERT INTO shows (
        tmdb_id, media_type, title, original_title, overview,
        poster_path, backdrop_path, first_air_date, last_air_date, status,
        genres, number_of_seasons, number_of_episodes, vote_average, runtime,
        metadata_updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'))
     ON CONFLICT(tmdb_id, media_type) DO UPDATE SET
        title              = excluded.title,
        original_title     = excluded.original_title,
        overview           = excluded.overview,
        poster_path        = excluded.poster_path,
        backdrop_path      = excluded.backdrop_path,
        first_air_date     = excluded.first_air_date,
        last_air_date      = excluded.last_air_date,
        status             = excluded.status,
        genres             = excluded.genres,
        number_of_seasons  = excluded.number_of_seasons,
        number_of_episodes = excluded.number_of_episodes,
        vote_average       = excluded.vote_average,
        runtime            = excluded.runtime,
        metadata_updated_at = datetime('now')`,
    details.id,
    mediaType,
    title || '(ohne Titel)',
    originalTitle ?? null,
    details.overview ?? null,
    details.poster_path ?? null,
    details.backdrop_path ?? null,
    firstAirDate || null,
    lastAirDate || null,
    details.status ?? null,
    genres,
    seasons,
    episodes,
    details.vote_average ?? null,
    runtime,
  );

  return findShow(details.id, mediaType);
}

// --------------------------------------------------------------------------
// Verfügbarkeit – "wo kann ich das streamen?"
// --------------------------------------------------------------------------

/**
 * Speichert die Verfügbarkeiten einer Serie für EINE Region.
 *
 * Ablauf in einer Transaktion:
 *   1. Alte Zeilen dieser Serie+Region löschen (ein Anbieter, der die Serie
 *      verloren hat, muss verschwinden – ein reines UPSERT würde ihn stehen
 *      lassen und dauerhaft falsche Treffer liefern).
 *   2. Für jede Angebotsart alle Anbieter einfügen.
 *   3. availability_updated_at der Serie fortschreiben.
 *
 * @param {number} showId  shows.id
 * @param {string} region  ISO-3166-1, z. B. "DE"
 * @param {object} regionData Der Regionsblock aus der TMDB-Antwort:
 *        { link, flatrate: [{provider_id, provider_name, logo_path, display_priority}], … }
 * @returns {number} Anzahl gespeicherter Angebote
 */
export function saveAvailability(showId, region, regionData) {
  return transaction(() => {
    // 1. Aufräumen
    run('DELETE FROM availability WHERE show_id = ? AND region = ?', showId, region);

    let inserted = 0;

    // TMDB liefert genau einen Deeplink pro Region (die JustWatch-Seite),
    // nicht pro Anbieter. Wir hängen ihn an jede Zeile, damit das Frontend
    // ohne Zusatzabfrage verlinken kann.
    const link = regionData?.link ?? null;

    // 2. Einfügen, gruppiert nach Angebotsart
    for (const offerType of OFFER_TYPES) {
      // Varianten desselben Dienstes zusammenfassen. Läuft eine Serie bei
      // "Netflix basic with Ads", soll sie unter "Netflix" erscheinen –
      // sonst würde sie bei jemandem mit Netflix-Abo nicht als enthalten
      // erkannt, obwohl er sie sehen kann.
      const offers = mergeOffers(regionData?.[offerType]);
      if (offers.length === 0) continue;

      for (const offer of offers) {
        run(
          `INSERT INTO availability (
              show_id, region, provider_id, offer_type,
              name, logo_path, display_priority, link, updated_at
           ) VALUES (?,?,?,?,?,?,?,?, datetime('now'))
           ON CONFLICT(show_id, region, provider_id, offer_type) DO UPDATE SET
              name = excluded.name,
              logo_path = excluded.logo_path,
              display_priority = excluded.display_priority,
              link = excluded.link,
              updated_at = excluded.updated_at`,
          showId,
          region,
          offer.provider_id,
          offerType,
          offer.provider_name ?? null,
          offer.logo_path ?? null,
          offer.display_priority ?? null,
          link,
        );
        inserted++;
      }
    }

    // 3. Zeitstempel setzen – auch wenn nichts gefunden wurde. Sonst würde der
    //    Sync bei Serien ohne Angebot bei jedem Lauf erneut nachfragen.
    run("UPDATE shows SET availability_updated_at = datetime('now') WHERE id = ?", showId);

    return inserted;
  });
}

/**
 * Liest die gespeicherten Verfügbarkeiten einer Serie.
 *
 * @param {number} showId
 * @param {string} region
 * @returns {object[]} Zeilen aus `availability`, sortiert nach Angebotsart
 *   (Abo zuerst) und dann nach Anbieter-Popularität
 */
export function getAvailability(showId, region) {
  return all(
    `SELECT provider_id, offer_type, name, logo_path, display_priority, link, updated_at
       FROM availability
      WHERE show_id = ? AND region = ?
      -- CASE bildet die Reihenfolge aus OFFER_TYPES in SQL nach, damit die
      -- Sortierung serverseitig passt und das Frontend nichts nachsortieren muss.
      ORDER BY CASE offer_type
                 WHEN 'flatrate' THEN 0
                 WHEN 'free'     THEN 1
                 WHEN 'ads'      THEN 2
                 WHEN 'rent'     THEN 3
                 WHEN 'buy'      THEN 4
                 ELSE 5 END,
               COALESCE(display_priority, 9999),
               name`,
    showId,
    region,
  );
}

/**
 * Baut aus den flachen availability-Zeilen die Struktur, die das Frontend
 * anzeigt, und markiert dabei die Anbieter, die der Benutzer abonniert hat.
 *
 * Das ist die konkrete Umsetzung von "ich sehe immer, wo ich die Serie
 * streamen kann – und ob sie in meinem Abo drin ist".
 *
 * @param {number} showId
 * @param {string} region
 * @param {Set<number>} subscribedIds provider_id-Werte aus user_providers
 * @returns {{
 *   link: string|null,
 *   offers: Record<string, object[]>,
 *   included: object[],
 *   bestOffer: object|null,
 *   isIncluded: boolean
 * }}
 */
export function buildAvailabilityView(showId, region, subscribedIds = new Set()) {
  const rows = getAvailability(showId, region);

  /** Nach Angebotsart gruppiert: { flatrate: [...], rent: [...] } */
  const offers = {};
  /** Nur die Anbieter, bei denen der Benutzer ein Abo hat. */
  const included = [];
  let link = null;

  for (const row of rows) {
    link ||= row.link;

    // Jede Zeile bekommt die Information, ob sie zu einem Abo des Benutzers
    // gehört. Das Frontend hebt diese Kacheln farblich hervor.
    const entry = { ...row, subscribed: subscribedIds.has(row.provider_id) };

    (offers[row.offer_type] ||= []).push(entry);

    // "Im Abo enthalten" zählt nur bei flatrate/free/ads – bei rent/buy müsste
    // man trotz Abo extra zahlen.
    if (entry.subscribed && ['flatrate', 'free', 'ads'].includes(row.offer_type)) {
      included.push(entry);
    }
  }

  return {
    link,
    offers,
    included,
    // Der erste Treffer aus einem eigenen Abo, sonst das erste Abo-Angebot
    // überhaupt – das ist es, was auf der Kachel als Logo erscheint.
    bestOffer: included[0] || offers.flatrate?.[0] || null,
    isIncluded: included.length > 0,
  };
}

/**
 * Holt eine Serie in den lokalen Cache, falls sie fehlt oder veraltet ist.
 *
 * Das ist die zentrale Einstiegsfunktion: Sie wird aufgerufen, wenn jemand
 * eine Serie zur Bibliothek hinzufügt oder die Detailseite öffnet.
 *
 * @param {number} tmdbId
 * @param {'tv'|'movie'} mediaType
 * @param {object} opts
 * @param {string} opts.region   Für welche Region die Verfügbarkeit gilt
 * @param {string} opts.language Metadatensprache
 * @param {boolean} [opts.force] Cache ignorieren und neu laden
 * @returns {Promise<object>} Zeile aus `shows`
 */
export async function ensureShow(tmdbId, mediaType, opts) {
  const existing = findShow(tmdbId, mediaType);

  // Alles frisch? Dann keinen API-Aufruf verschwenden.
  const metadataFresh = isFresh(existing?.metadata_updated_at, METADATA_TTL_HOURS);
  const availabilityFresh = isFresh(existing?.availability_updated_at, AVAILABILITY_TTL_HOURS);

  if (existing && metadataFresh && availabilityFresh && !opts.force) {
    return existing;
  }

  // Ein Aufruf, zwei Ergebnisse: Details und (per append_to_response)
  // die Verfügbarkeiten.
  const details = await tmdb.getDetails(tmdbId, mediaType, { language: opts.language });

  const show = upsertShow(details, mediaType);

  // Der angehängte Block heißt wörtlich "watch/providers" – Schrägstrich
  // inklusive, deshalb Klammer-Notation statt Punkt.
  const providerBlock = details['watch/providers']?.results ?? {};
  saveAvailability(show.id, opts.region, providerBlock[opts.region] ?? {});

  return findShowById(show.id);
}

/**
 * Frischt NUR die Verfügbarkeit einer bereits bekannten Serie auf.
 * Vom Sync-Lauf benutzt, weil dort die Metadaten meist noch gültig sind.
 *
 * @param {object} show Zeile aus `shows`
 * @param {string} region
 * @returns {Promise<number>} Anzahl gefundener Angebote
 */
export async function refreshAvailability(show, region) {
  const data = await tmdb.getWatchProviders(show.tmdb_id, show.media_type);
  return saveAvailability(show.id, region, data?.results?.[region] ?? {});
}

// --------------------------------------------------------------------------
// Episoden
// --------------------------------------------------------------------------

/**
 * Lädt eine Staffel von TMDB und schreibt sie in die Tabelle `episodes`.
 * Verknüpfung: episodes.show_id -> shows.id
 *
 * @param {object} show Zeile aus `shows`
 * @param {number} seasonNumber
 * @param {object} opts
 * @param {string} opts.language
 * @returns {Promise<object[]>} die gespeicherten Episoden
 */
export async function loadSeason(show, seasonNumber, opts = {}) {
  const season = await tmdb.getSeason(show.tmdb_id, seasonNumber, {
    language: opts.language,
  });

  transaction(() => {
    for (const ep of season.episodes || []) {
      run(
        `INSERT INTO episodes (
            show_id, tmdb_id, season_number, episode_number,
            name, overview, air_date, runtime, still_path
         ) VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(show_id, season_number, episode_number) DO UPDATE SET
            tmdb_id    = excluded.tmdb_id,
            name       = excluded.name,
            overview   = excluded.overview,
            air_date   = excluded.air_date,
            runtime    = excluded.runtime,
            still_path = excluded.still_path`,
        show.id,
        ep.id ?? null,
        // season_number aus der Antwort kann bei Specials abweichen – wir
        // nehmen den angefragten Wert, damit die Zuordnung eindeutig bleibt.
        seasonNumber,
        ep.episode_number,
        ep.name ?? null,
        ep.overview ?? null,
        ep.air_date || null,
        ep.runtime ?? null,
        ep.still_path ?? null,
      );
    }
  });

  return all(
    `SELECT * FROM episodes
      WHERE show_id = ? AND season_number = ?
      ORDER BY episode_number`,
    show.id,
    seasonNumber,
  );
}

/**
 * Berechnet den Sehfortschritt eines Benutzers für eine Serie.
 *
 * Die Gesamtzahl kommt aus shows.number_of_episodes (von TMDB), nicht aus der
 * Tabelle `episodes` – dort stehen nur die Staffeln, die schon einmal geöffnet
 * wurden. Sonst stünde nach dem Abhaken von Staffel 1 fälschlich "100 %".
 *
 * @param {number} userId
 * @param {object} show Zeile aus `shows`
 * @returns {{watched: number, total: number, percent: number}}
 */
export function getProgress(userId, show) {
  const watched = get(
    'SELECT COUNT(*) AS n FROM watched_episodes WHERE user_id = ? AND show_id = ?',
    userId,
    show.id,
  ).n;

  const total = show.number_of_episodes || 0;

  return {
    watched,
    total,
    // Auf ganze Prozent gerundet und bei 100 gedeckelt: Wer Specials (Staffel 0)
    // mit abhakt, käme sonst rechnerisch über 100 %.
    percent: total > 0 ? Math.min(100, Math.round((watched / total) * 100)) : 0,
  };
}

// --------------------------------------------------------------------------
// Anbieter-Katalog
// --------------------------------------------------------------------------

/**
 * Holt den Anbieter-Katalog einer Region von TMDB und legt ihn in `providers` ab.
 *
 * Serien- und Film-Anbieter werden zusammengeführt, weil ein Abo bei Netflix
 * beides abdeckt – der Benutzer soll die Liste nicht zweimal durchgehen müssen.
 *
 * @param {string} region
 * @param {string} language
 * @returns {Promise<object[]>} der gespeicherte Katalog, sortiert nach Priorität
 */
export async function syncProviderCatalog(region, language) {
  // Beide Medientypen parallel holen – zwei unabhängige Aufrufe.
  const [tvCatalog, movieCatalog] = await Promise.all([
    tmdb.getProviderCatalog('tv', { region, language }),
    tmdb.getProviderCatalog('movie', { region, language }),
  ]);

  // Beide Listen in eine einheitliche Form bringen.
  const raw = [...(tvCatalog.results || []), ...(movieCatalog.results || [])].map(
    (provider) => ({
      id: provider.provider_id,
      name: provider.provider_name,
      logo_path: provider.logo_path,
      // display_priorities enthält je Land einen eigenen Wert; der ist
      // aussagekräftiger als die weltweite Vorgabe.
      display_priority:
        provider.display_priorities?.[region] ?? provider.display_priority ?? 9999,
    }),
  );

  // Varianten zusammenfassen: Aus "Netflix", "Netflix basic with Ads" und
  // "Netflix Standard with Ads" wird ein einziger Eintrag. Sonst stünde man
  // in der Anbieter-Auswahl vor drei Netflix-Kacheln und wüsste nicht,
  // welche gemeint ist.
  const merged = mergeProviders(raw);

  transaction(() => {
    // Region komplett neu aufbauen: Anbieter, die es nicht mehr gibt, sollen
    // auch nicht mehr zur Auswahl stehen.
    run('DELETE FROM providers WHERE region = ?', region);

    // mergeProviders() liefert ein fertig sortiertes Array.
    for (const p of merged) {
      run(
        `INSERT INTO providers (id, name, logo_path, display_priority, region, updated_at)
         VALUES (?,?,?,?,?, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            logo_path = excluded.logo_path,
            display_priority = excluded.display_priority,
            region = excluded.region,
            updated_at = excluded.updated_at`,
        p.id,
        p.name,
        p.logo_path,
        p.display_priority,
        region,
      );
    }
  });

  return all(
    `SELECT id, name, logo_path, display_priority
       FROM providers WHERE region = ?
      ORDER BY display_priority, name`,
    region,
  );
}

/**
 * Liefert die Provider-IDs, die ein Benutzer abonniert hat – als Set, weil
 * damit überall in O(1) geprüft werden kann, ob ein Angebot "meins" ist.
 * @param {number} userId
 * @returns {Set<number>}
 */
export function getSubscribedProviderIds(userId) {
  const rows = all('SELECT provider_id FROM user_providers WHERE user_id = ?', userId);
  return new Set(rows.map((r) => r.provider_id));
}
