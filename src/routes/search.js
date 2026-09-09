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
import { getRuntimeSettings, normalizeListItem } from '../tmdb.js';
// Baut aus der eigenen Bibliothek persoenliche Vorschlaege.
import { getPersonalRecommendations } from '../recommend.js';
// Sucht in Filmreihen, Freunden und Leuten - ohne TMDB, also sofort.
import { quickSearch } from '../quicksearch.js';
// Macht die Suche nachsichtig gegenueber Tippfehlern.
import { variants, rank } from '../fuzzy.js';

const router = express.Router();
router.use(requireAuth);

/**
 * Kurzname für die gemeinsame Aufbereitung aus src/tmdb.js. Sie steht dort,
 * weil auch src/recommend.js dieselbe Form erzeugen muss – das Frontend
 * zeichnet für Suche, Entdecken und Empfehlungen dieselbe Kachel.
 */
const normalizeItem = normalizeListItem;

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
 * GET /api/search/quick?q=kingsman
 *
 * Sucht in allem, was Streamo selbst weiß: Filmreihen, Freunde und andere
 * Leute auf dieser Instanz. Kein TMDB – die Antwort kommt deshalb sofort und
 * funktioniert auch ohne API-Schlüssel.
 *
 * Gedacht für das Menü unter der Suchleiste und für die Freundessuche: Man
 * tippt, und die Treffer erscheinen beim Tippen. Die Serien und Filme kommen
 * getrennt über /api/search nach, weil die einen Netzaufruf brauchen.
 */
router.get('/quick', (req, res, next) => {
  try {
    res.json(quickSearch(req.user.id, String(req.query.q ?? '')));
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/search/for-you?mediaType=tv&limit=20
 *
 * Die persönliche Empfehlungsleiste über "Entdecken": Was passt zu dem, was
 * ich schon gesehen habe?
 *
 * Anders als /discover entsteht die Antwort aus den eigenen Daten – aus
 * Bewertungen, Favoriten und abgehakten Folgen. Die Rechnung dahinter steht
 * in src/recommend.js; hier wird nur noch der Bibliotheks-Zustand angeheftet,
 * damit die Kacheln denselben Knopf bekommen wie überall sonst.
 *
 * Der Endpunkt antwortet nie mit einem Fehler, wenn die Bibliothek leer ist –
 * dann kommt eine leere Liste mit einem erklärenden `reason`, den das
 * Frontend anzeigt.
 */
router.get('/for-you', async (req, res, next) => {
  const { region, language } = getRuntimeSettings(req.user);

  try {
    const data = await getPersonalRecommendations(req.user.id, {
      // Ohne Angabe werden Serien UND Filme gemischt.
      mediaType: req.query.mediaType,
      region,
      language,
      limit: Math.min(Number(req.query.limit) || 20, 40),
    });

    res.json({
      ...data,
      results: markLibraryState(data.results, req.user.id),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/search/top?mediaType=movie
 *
 * Die zwei Bestenlisten für die Startseite:
 *
 *   week – was gerade läuft. Kommt von /trending, also aus dem tatsächlichen
 *          Verhalten der TMDB-Nutzer dieser Woche.
 *   year – die besten Titel des laufenden Jahres. Sortiert nach Bewertung,
 *          nicht nach Beliebtheit: "top" soll hier heißen "am besten", nicht
 *          "am meisten angeklickt".
 *
 * Beim Jahr ist die Mindestanzahl an Bewertungen entscheidend. Ohne sie steht
 * ein Film mit vier Stimmen und 10,0 ganz oben – ein Zufall, keine Bestenliste.
 * 500 ist hoch genug, dass nur Titel mit echtem Publikum durchkommen.
 *
 * Beide Listen ignorieren die eigenen Abos bewusst: Es geht um die Frage
 * "was ist gerade gut?", nicht um "was habe ich schon bezahlt". Wo ein Titel
 * läuft, zeigen die Anbieter-Logos auf der Kachel ohnehin.
 */
router.get('/top', async (req, res, next) => {
  const { language, region } = getRuntimeSettings(req.user);
  const mediaType = req.query.mediaType === 'tv' ? 'tv' : 'movie';

  // Das laufende Jahr. Im Januar ist die Liste noch dünn – dann lieber das
  // Vorjahr zeigen, sonst stehen dort drei Filme.
  const now = new Date();
  const year = now.getMonth() < 2 ? now.getFullYear() - 1 : now.getFullYear();

  try {
    // Nacheinander statt parallel: src/tmdb.js drosselt ohnehin auf einen
    // Aufruf alle 60 ms, ein Schwall brächte nur Fehler statt Tempo.
    const week = await tmdb.getTrending({ mediaType, window: 'week', language });

    const yearBest = await tmdb.discover({
      mediaType,
      language,
      region,
      year,
      sortBy: 'vote_average.desc',
      minVotes: 500,
    });

    /**
     * Bringt eine TMDB-Antwort in die Form, die das Frontend erwartet.
     * @param {object} data
     * @returns {object[]}
     */
    const shape = (data) =>
      markLibraryState(
        (data.results || []).map((item) => normalizeItem(item, mediaType)).filter(Boolean),
        req.user.id,
      );

    res.json({
      mediaType,
      year,
      week: shape(week),
      yearBest: shape(yearBest),
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
