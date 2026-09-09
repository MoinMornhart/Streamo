/**
 * ---------------------------------------------------------------------------
 * src/routes/search.js – Suchen, Entdecken, Trending
 * ---------------------------------------------------------------------------
 * Eingehängt in src/server.js unter /api/search.
 *
 * Endpunkte:
 *   GET /api/search?q=…            – Volltextsuche über Serien und Filme
 *   GET /api/search/discover       – "Was läuft in MEINEN Abos?"
 *   GET /api/search/trending       – Aktuell angesagt
 *   GET /api/search/genres         – Genre-Liste für die Filterleiste
 *
 * Verknüpfungen:
 *   - src/tmdb.js  -> die eigentlichen API-Aufrufe
 *   - src/db.js    -> Abgleich mit `library`, damit Treffer als "schon in
 *                     meiner Datenbank" markiert werden können
 *   - public/js/views/search.js -> das Frontend dazu
 *
 * Bewusste Entscheidung: Die Suche liefert KEINE Verfügbarkeiten mit. Dafür
 * bräuchte es einen TMDB-Aufruf pro Treffer, was jede Suche um Sekunden
 * verzögern würde. Stattdessen holt das Frontend sie direkt danach über
 * POST /api/shows/availability nach (siehe src/routes/shows.js) und blendet
 * die Anbieter-Logos nachträglich ein.
 * ---------------------------------------------------------------------------
 */

import express from 'express';
import { all } from '../db.js';
import { requireAuth } from '../auth.js';
import * as tmdb from '../tmdb.js';
import { getRuntimeSettings } from '../tmdb.js';
// Macht die Suche nachsichtig gegenueber Tippfehlern.
import { variants, rank } from '../fuzzy.js';

const router = express.Router();
router.use(requireAuth);

/**
 * Vereinheitlicht einen TMDB-Listeneintrag zu der Form, die das Frontend
 * erwartet. TMDB benennt dieselben Dinge je nach Medientyp unterschiedlich
 * (name/title, first_air_date/release_date) – hier wird das einmal geglättet,
 * damit sich das UI nicht darum kümmern muss.
 *
 * @param {object} item Eintrag aus results[]
 * @param {'tv'|'movie'} [forcedType] Medientyp, falls der Eintrag keinen trägt
 *   (nur /search/multi liefert media_type mit)
 * @returns {object|null} null, wenn der Eintrag kein Film/keine Serie ist
 */
function normalizeItem(item, forcedType) {
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

/**
 * Markiert Treffer, die bereits in der Bibliothek des Benutzers stehen.
 *
 * Ein einziger Datenbankzugriff für alle Treffer statt einer Abfrage je
 * Treffer: Wir holen alle Bibliothekseinträge des Benutzers als Menge von
 * "mediaType:tmdbId"-Schlüsseln.
 *
 * @param {object[]} items normalisierte Treffer
 * @param {number} userId
 * @returns {object[]} dieselben Treffer mit .inLibrary und .libraryStatus
 */
function markLibraryState(items, userId) {
  const rows = all(
    `SELECT s.tmdb_id, s.media_type, l.status
       FROM library l
       JOIN shows s ON s.id = l.show_id
      WHERE l.user_id = ?`,
    userId,
  );

  const index = new Map(rows.map((r) => [`${r.media_type}:${r.tmdb_id}`, r.status]));

  return items.map((item) => {
    const status = index.get(`${item.mediaType}:${item.tmdbId}`);
    return { ...item, inLibrary: status !== undefined, libraryStatus: status ?? null };
  });
}

/**
 * GET /api/search?q=Breaking+Bad&page=1
 * Volltextsuche. Leerer Suchbegriff gibt eine leere Liste zurück, statt die
 * API mit einer sinnlosen Anfrage zu belasten.
 */
router.get('/', async (req, res, next) => {
  const query = String(req.query.q ?? '').trim();
  const { language } = getRuntimeSettings(req.user);

  if (!query) return res.json({ results: [], page: 1, totalPages: 0 });

  const page = Number(req.query.page) || 1;

  try {
    const data = await tmdb.searchMulti(query, { language, page });

    let items = (data.results || [])
      .map((item) => normalizeItem(item))
      .filter(Boolean)
      // Treffer ohne Poster sind meistens Karteileichen; sie nach hinten zu
      // sortieren macht die erste Bildschirmseite deutlich brauchbarer.
      .sort((a, b) => (a.posterPath ? 0 : 1) - (b.posterPath ? 0 : 1));

    // ----------------------------------------------------------------------
    // Zweiter Versuch bei Tippfehlern
    // ----------------------------------------------------------------------
    // TMDB sucht exakt. Wer "Kingsmann" tippt, bekommt nichts – und sieht den
    // eigenen Fehler oft nicht. Deshalb wird bei einer leeren Trefferliste
    // mit bereinigten Schreibweisen nachgefasst: doppelte Buchstaben
    // reduziert, Sonderzeichen entfernt, notfalls nur das längste Wort.
    //
    // Nur bei der ersten Seite und nur, wenn wirklich nichts kam – jede
    // Variante kostet einen API-Aufruf.
    let correctedFrom = null;

    if (items.length === 0 && page === 1) {
      for (const variant of variants(query)) {
        const retry = await tmdb.searchMulti(variant, { language });

        const found = (retry.results || [])
          .map((item) => normalizeItem(item))
          .filter(Boolean);

        if (found.length > 0) {
          // Nach Ähnlichkeit zum URSPRÜNGLICH Getippten sortieren, nicht zur
          // Variante – der Benutzer hat ja das eine gemeint.
          items = rank(found, query).sort(
            (a, b) => (a.posterPath ? 0 : 1) - (b.posterPath ? 0 : 1),
          );

          // Das Frontend weist darauf hin, wonach tatsächlich gesucht wurde.
          correctedFrom = variant;
          break;
        }
      }
    }

    res.json({
      results: markLibraryState(items, req.user.id),
      page: data.page,
      totalPages: data.total_pages,
      totalResults: data.total_results,
      // Gesetzt, wenn erst eine korrigierte Schreibweise Treffer brachte.
      correctedFrom,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/search/discover
 *
 * Der Endpunkt, der die verknüpften Abos wirklich ausspielt: Standardmäßig
 * werden nur Titel gezeigt, die bei den eigenen Anbietern im Abo enthalten sind.
 *
 * Query-Parameter:
 *   mediaType  tv | movie             (Default: tv)
 *   providers  "8,337" oder leer      (leer = alle meine Abos)
 *   all        "1" = Abo-Filter aus   (dann kommt der ganze TMDB-Katalog)
 *   genres     "18,10765"             TMDB-Genre-IDs
 *   sort       popularity.desc | vote_average.desc | first_air_date.desc
 *   page       Seitenzahl
 */
router.get('/discover', async (req, res, next) => {
  const { region, language } = getRuntimeSettings(req.user);

  try {
    // Welche Anbieter sollen gelten? Entweder die explizit übergebenen …
    let providerIds;

    if (req.query.all === '1') {
      // … oder gar keine Einschränkung (der Benutzer will alles sehen).
      providerIds = [];
    } else if (req.query.providers) {
      providerIds = String(req.query.providers)
        .split(',')
        .map(Number)
        .filter(Number.isInteger);
    } else {
      // … oder standardmäßig alle verknüpften Abos aus user_providers.
      providerIds = all(
        'SELECT provider_id FROM user_providers WHERE user_id = ?',
        req.user.id,
      ).map((r) => r.provider_id);
    }

    const mediaType = req.query.mediaType === 'movie' ? 'movie' : 'tv';

    const data = await tmdb.discover({
      mediaType,
      providerIds,
      region,
      language,
      genres: req.query.genres,
      sortBy: req.query.sort,
      page: Number(req.query.page) || 1,
    });

    // Discover liefert kein media_type mit, weil der Endpunkt schon danach
    // getrennt ist – deshalb reichen wir ihn als forcedType durch.
    const items = (data.results || []).map((item) => normalizeItem(item, mediaType)).filter(Boolean);

    res.json({
      results: markLibraryState(items, req.user.id),
      page: data.page,
      totalPages: data.total_pages,
      // Damit das Frontend anzeigen kann: "gefiltert auf 4 deiner Anbieter".
      filteredByProviders: providerIds,
      region,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/search/trending?mediaType=tv&window=week
 * Füllt die Startseite, solange die eigene Bibliothek noch leer ist.
 */
router.get('/trending', async (req, res, next) => {
  const { language } = getRuntimeSettings(req.user);

  try {
    const mediaType = req.query.mediaType === 'movie' ? 'movie' : 'tv';

    const data = await tmdb.getTrending({
      mediaType,
      window: req.query.window === 'day' ? 'day' : 'week',
      language,
    });

    const items = (data.results || []).map((item) => normalizeItem(item, mediaType)).filter(Boolean);

    res.json({ results: markLibraryState(items, req.user.id) });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/search/genres?mediaType=tv
 * Liefert die Genre-Namen zu den IDs, die in den Trefferlisten stecken.
 */
router.get('/genres', async (req, res, next) => {
  const { language } = getRuntimeSettings(req.user);

  try {
    const mediaType = req.query.mediaType === 'movie' ? 'movie' : 'tv';
    const data = await tmdb.getGenres(mediaType, { language });
    res.json({ genres: data.genres || [] });
  } catch (error) {
    next(error);
  }
});

export default router;
