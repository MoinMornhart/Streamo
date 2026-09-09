/**
 * ---------------------------------------------------------------------------
 * src/routes/shows.js – Detailseite, Staffeln, Sehfortschritt, Verfügbarkeit
 * ---------------------------------------------------------------------------
 * Eingehängt in src/server.js unter /api/shows.
 *
 * Endpunkte:
 *   POST /api/shows/availability             – Batch: "wo laufen diese Titel?"
 *   GET  /api/shows/:mediaType/:tmdbId       – alles zu einem Titel
 *   GET  /api/shows/:mediaType/:tmdbId/season/:n – Episoden einer Staffel
 *   POST /api/shows/:showId/watched          – Episode(n) ab-/anhaken
 *   POST /api/shows/:showId/refresh          – Daten sofort neu von TMDB holen
 *
 * Verknüpfungen:
 *   - src/store.js -> ensureShow, loadSeason, buildAvailabilityView, getProgress
 *   - src/db.js    -> Tabellen episodes und watched_episodes
 *   - public/js/views/detail.js -> die Detailansicht im Frontend
 * ---------------------------------------------------------------------------
 */

import express from 'express';
import { all, get, run, transaction } from '../db.js';
import { requireAuth } from '../auth.js';
import * as tmdb from '../tmdb.js';
import { getRuntimeSettings } from '../tmdb.js';
// Nach dem Abhaken von Episoden kann ein Erfolg dazukommen – siehe unten.
import { checkAchievements } from '../achievements.js';

// Gehört ein Film zu einer Reihe, wird sie beim Öffnen der Detailseite
// einmalig übernommen – siehe unten bei GET /:mediaType/:tmdbId.
import { ensureOfficialCollection, findOfficialCollection, findCollectionForShow } from '../collections.js';

import {
  ensureShow,
  findShow,
  findShowById,
  loadSeason,
  buildAvailabilityView,
  getSubscribedProviderIds,
  getProgress,
  refreshAvailability,
} from '../store.js';

const router = express.Router();
router.use(requireAuth);

/**
 * POST /api/shows/availability
 *
 * Der Endpunkt, der die Anbieter-Logos in Such- und Trefferlisten nachlädt.
 * Body: { items: [{ tmdbId, mediaType }, …] }
 *
 * Warum als POST und nicht GET? Die Liste kann 20 und mehr Einträge umfassen –
 * das wäre eine unangenehm lange URL. Der Aufruf ist trotzdem lesend.
 *
 * Ablauf je Eintrag:
 *   1. Steht die Serie schon lokal mit frischer Verfügbarkeit? -> aus der DB.
 *   2. Sonst genau EIN TMDB-Aufruf (/watch/providers) und speichern.
 * Titel, die TMDB noch gar nicht kennt, werden dabei als schlanke Zeile in
 * `shows` angelegt, damit die Verfügbarkeit einen Fremdschlüssel bekommt.
 */
router.post('/availability', async (req, res, next) => {
  const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 40) : [];
  const { region } = getRuntimeSettings(req.user);
  const subscribed = getSubscribedProviderIds(req.user.id);

  try {
    /** @type {Record<string, object>} Schlüssel: "tv:1399" */
    const result = {};

    // Nacheinander statt parallel: src/tmdb.js drosselt ohnehin auf einen
    // Mindestabstand, und so bleibt die Reihenfolge der Aufrufe nachvollziehbar.
    for (const item of items) {
      const tmdbId = Number(item?.tmdbId);
      const mediaType = item?.mediaType === 'movie' ? 'movie' : 'tv';
      if (!Number.isInteger(tmdbId)) continue;

      const key = `${mediaType}:${tmdbId}`;

      let show = findShow(tmdbId, mediaType);

      // Noch nie gesehen -> Platzhalter anlegen. Der Titel wird nachgereicht,
      // sobald jemand die Detailseite öffnet (ensureShow).
      if (!show) {
        run(
          `INSERT INTO shows (tmdb_id, media_type, title, poster_path)
           VALUES (?,?,?,?)
           ON CONFLICT(tmdb_id, media_type) DO NOTHING`,
          tmdbId,
          mediaType,
          item.title || `TMDB ${tmdbId}`,
          item.posterPath ?? null,
        );
        show = findShow(tmdbId, mediaType);
      }

      // Verfügbarkeit älter als 24 Stunden oder noch nie geholt? Dann jetzt.
      const stale =
        !show.availability_updated_at ||
        Date.now() - Date.parse(show.availability_updated_at.replace(' ', 'T') + 'Z') >
          24 * 3_600_000;

      if (stale) {
        try {
          await refreshAvailability(show, region);
        } catch {
          // Ein einzelner Fehlschlag (z. B. Rate Limit) darf die ganze Liste
          // nicht kippen – der Eintrag bleibt dann eben ohne Logos.
        }
      }

      result[key] = buildAvailabilityView(show.id, region, subscribed);
    }

    res.json({ region, availability: result });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/shows/:mediaType/:tmdbId
 *
 * Alles, was die Detailseite braucht, in einer Antwort:
 * Metadaten, Verfügbarkeit, Bibliotheksstatus, Fortschritt, Staffelübersicht
 * und Empfehlungen.
 */
router.get('/:mediaType/:tmdbId', async (req, res, next) => {
  const mediaType = req.params.mediaType === 'movie' ? 'movie' : 'tv';
  const tmdbId = Number(req.params.tmdbId);
  const { region, language } = getRuntimeSettings(req.user);

  if (!Number.isInteger(tmdbId)) {
    return res.status(400).json({ error: 'Ungültige TMDB-ID.' });
  }

  try {
    // Holt die Serie in den Cache bzw. frischt sie auf, wenn sie veraltet ist.
    const show = await ensureShow(tmdbId, mediaType, { region, language });

    const subscribed = getSubscribedProviderIds(req.user.id);
    const availability = buildAvailabilityView(show.id, region, subscribed);

    // Bibliothekseintrag – null, wenn der Titel noch nicht aufgenommen wurde.
    const entry = get(
      // planned_for ist der freiwillige Termin von der Merkliste – ohne ihn
      // stünde das Feld auf der Detailseite immer leer, egal was gesetzt ist.
      'SELECT status, rating, favorite, notes, added_at, planned_for FROM library WHERE user_id = ? AND show_id = ?',
      req.user.id,
      show.id,
    );

    // Staffelübersicht mit Fortschritt je Staffel. Die Episodenzahlen kommen
    // aus `episodes` und stehen erst zur Verfügung, nachdem eine Staffel
    // einmal geöffnet wurde – bis dahin zeigt das UI nur die Staffelnummer.
    const seasons = all(
      `SELECT e.season_number,
              COUNT(*) AS episode_count,
              -- Unterabfrage statt JOIN, weil sonst die Zählung der Episoden
              -- durch die gesehenen Zeilen vervielfacht würde.
              (SELECT COUNT(*) FROM watched_episodes w
                JOIN episodes e2 ON e2.id = w.episode_id
               WHERE w.user_id = ? AND e2.show_id = e.show_id
                 AND e2.season_number = e.season_number) AS watched_count
         FROM episodes e
        WHERE e.show_id = ?
        GROUP BY e.season_number
        ORDER BY e.season_number`,
      req.user.id,
      show.id,
    );

    // ----------------------------------------------------------------------
    // Filmreihe
    // ----------------------------------------------------------------------
    // Gehört der Film zu einer offiziellen Reihe ("Kingsman", "John Wick"),
    // wird sie beim ersten Öffnen der Detailseite übernommen. Danach steht
    // sie unter /collections und die Detailseite zeigt "Teil 2 von 3".
    //
    // Der Aufruf kostet eine TMDB-Anfrage, aber nur ein einziges Mal je Reihe –
    // findOfficialCollection prüft vorher, ob sie schon da ist.
    let collection = null;

    try {
      if (show.collection_tmdb_id && !findOfficialCollection(show.collection_tmdb_id)) {
        await ensureOfficialCollection(show.collection_tmdb_id, { region, language });
      }

      collection = findCollectionForShow(show.id, req.user.id);
    } catch (error) {
      // Eine nicht ladbare Reihe darf die Detailseite nicht verhindern.
      console.error('[collections] Reihe nicht ladbar:', error.message);
    }

    // Empfehlungen sind ein Extra – wenn der Aufruf scheitert, soll die
    // Detailseite trotzdem erscheinen.
    let recommendations = [];
    try {
      const rec = await tmdb.getRecommendations(tmdbId, mediaType, { language });
      recommendations = (rec.results || []).slice(0, 12).map((item) => ({
        tmdbId: item.id,
        mediaType: item.media_type || mediaType,
        title: item.name || item.title,
        posterPath: item.poster_path,
        year: (item.first_air_date || item.release_date)?.slice(0, 4) || null,
        voteAverage: item.vote_average,
      }));
    } catch {
      /* bewusst ignoriert */
    }

    res.json({
      show: {
        showId: show.id,
        tmdbId: show.tmdb_id,
        mediaType: show.media_type,
        title: show.title,
        originalTitle: show.original_title,
        overview: show.overview,
        posterPath: show.poster_path,
        backdropPath: show.backdrop_path,
        firstAirDate: show.first_air_date,
        lastAirDate: show.last_air_date,
        status: show.status,
        genres: JSON.parse(show.genres || '[]'),
        seasons: show.number_of_seasons,
        episodes: show.number_of_episodes,
        voteAverage: show.vote_average,
        runtime: show.runtime,
      },
      availability,
      region,
      library: entry
        ? { ...entry, favorite: Boolean(entry.favorite), inLibrary: true }
        : { inLibrary: false },
      progress: getProgress(req.user.id, show),
      seasonStats: seasons,
      // null, wenn der Titel zu keiner Reihe gehoert.
      collection,
      recommendations,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/shows/:mediaType/:tmdbId/season/:seasonNumber
 *
 * Episoden einer Staffel, jeweils mit der Information, ob sie schon gesehen
 * wurde. Die Staffel wird beim ersten Aufruf von TMDB geladen und dann
 * dauerhaft lokal vorgehalten (Lazy Loading, siehe src/db.js -> episodes).
 */
router.get('/:mediaType/:tmdbId/season/:seasonNumber', async (req, res, next) => {
  const mediaType = req.params.mediaType === 'movie' ? 'movie' : 'tv';
  const tmdbId = Number(req.params.tmdbId);
  const seasonNumber = Number(req.params.seasonNumber);
  const { region, language } = getRuntimeSettings(req.user);

  try {
    const show = await ensureShow(tmdbId, mediaType, { region, language });

    // Schon lokal? Dann kein API-Aufruf.
    let episodes = all(
      'SELECT * FROM episodes WHERE show_id = ? AND season_number = ? ORDER BY episode_number',
      show.id,
      seasonNumber,
    );

    if (episodes.length === 0) {
      episodes = await loadSeason(show, seasonNumber, { language });
    }

    // Gesehen-Status in einem Zugriff für die ganze Staffel.
    const watchedIds = new Set(
      all(
        `SELECT w.episode_id FROM watched_episodes w
           JOIN episodes e ON e.id = w.episode_id
          WHERE w.user_id = ? AND e.show_id = ? AND e.season_number = ?`,
        req.user.id,
        show.id,
        seasonNumber,
      ).map((r) => r.episode_id),
    );

    res.json({
      showId: show.id,
      seasonNumber,
      episodes: episodes.map((ep) => ({
        id: ep.id,
        seasonNumber: ep.season_number,
        episodeNumber: ep.episode_number,
        name: ep.name,
        overview: ep.overview,
        airDate: ep.air_date,
        runtime: ep.runtime,
        stillPath: ep.still_path,
        watched: watchedIds.has(ep.id),
        // Episoden mit Ausstrahlungsdatum in der Zukunft werden im UI
        // ausgegraut und lassen sich nicht abhaken.
        upcoming: Boolean(ep.air_date && ep.air_date > new Date().toISOString().slice(0, 10)),
      })),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/shows/:showId/watched
 *
 * Markiert Episoden als gesehen oder ungesehen. Drei Aufrufvarianten:
 *   { episodeId: 42, watched: true }            – eine einzelne Episode
 *   { seasonNumber: 2, watched: true }          – eine ganze Staffel
 *   { upToEpisodeId: 42, watched: true }        – alles bis hierhin ("ich bin
 *                                                 hier eingestiegen")
 *
 * Verknüpfung: schreibt in watched_episodes (user_id, episode_id, show_id).
 */
router.post('/:showId/watched', (req, res) => {
  const showId = Number(req.params.showId);
  const watched = req.body?.watched !== false; // Default: als gesehen markieren

  const show = findShowById(showId);
  if (!show) return res.status(404).json({ error: 'Serie unbekannt.' });

  /** Die Episoden, die diese Aktion betrifft. */
  let targets = [];

  if (req.body?.episodeId !== undefined) {
    targets = all(
      'SELECT id FROM episodes WHERE id = ? AND show_id = ?',
      Number(req.body.episodeId),
      showId,
    );
  } else if (req.body?.seasonNumber !== undefined) {
    targets = all(
      'SELECT id FROM episodes WHERE show_id = ? AND season_number = ?',
      showId,
      Number(req.body.seasonNumber),
    );
  } else if (req.body?.upToEpisodeId !== undefined) {
    const marker = get('SELECT * FROM episodes WHERE id = ?', Number(req.body.upToEpisodeId));
    if (!marker) return res.status(404).json({ error: 'Episode unbekannt.' });

    // Alles vor der Marke: entweder eine frühere Staffel, oder dieselbe
    // Staffel bis einschließlich dieser Episodennummer.
    targets = all(
      `SELECT id FROM episodes
        WHERE show_id = ?
          AND (season_number < ?
               OR (season_number = ? AND episode_number <= ?))
          -- Specials (Staffel 0) beim Sammelabhaken auslassen, sonst wäre der
          -- Fortschritt sofort über 100 %.
          AND season_number > 0`,
      showId,
      marker.season_number,
      marker.season_number,
      marker.episode_number,
    );
  } else {
    return res.status(400).json({ error: 'episodeId, seasonNumber oder upToEpisodeId nötig.' });
  }

  transaction(() => {
    for (const ep of targets) {
      if (watched) {
        run(
          `INSERT INTO watched_episodes (user_id, episode_id, show_id)
           VALUES (?,?,?)
           ON CONFLICT(user_id, episode_id) DO NOTHING`,
          req.user.id,
          ep.id,
          showId,
        );
      } else {
        run(
          'DELETE FROM watched_episodes WHERE user_id = ? AND episode_id = ?',
          req.user.id,
          ep.id,
        );
      }
    }

    // Komfort: Wer die erste Episode abhakt, hat offensichtlich angefangen –
    // der Status springt automatisch von "watchlist" auf "watching".
    if (watched && targets.length > 0) {
      run(
        `UPDATE library SET status = 'watching', updated_at = datetime('now')
          WHERE user_id = ? AND show_id = ? AND status IN ('watchlist','paused')`,
        req.user.id,
        showId,
      );
    }
  });

  const progress = getProgress(req.user.id, show);

  // Und umgekehrt: Sind alle Episoden gesehen, gilt die Serie als beendet.
  if (progress.total > 0 && progress.watched >= progress.total) {
    run(
      `UPDATE library SET status = 'completed', updated_at = datetime('now')
        WHERE user_id = ? AND show_id = ? AND status != 'completed'`,
      req.user.id,
      showId,
    );
  }

  // Jetzt kann ein Erfolg dazugekommen sein – etwa, weil damit die letzte
  // Episode einer Serie gesehen wurde. Die Prüfung läuft ausschließlich auf
  // der lokalen Datenbank und kostet wenige Millisekunden.
  const unlocked = checkAchievements(req.user.id);

  res.json({ ok: true, affected: targets.length, progress, unlocked });
});

/**
 * POST /api/shows/:showId/refresh
 * Holt Metadaten und Verfügbarkeit sofort neu – der "Aktualisieren"-Knopf auf
 * der Detailseite, falls ein Anbieter gerade gewechselt hat.
 */
router.post('/:showId/refresh', async (req, res, next) => {
  const show = findShowById(Number(req.params.showId));
  if (!show) return res.status(404).json({ error: 'Serie unbekannt.' });

  const { region, language } = getRuntimeSettings(req.user);

  try {
    // force: true umgeht den Frische-Check in ensureShow.
    await ensureShow(show.tmdb_id, show.media_type, { region, language, force: true });

    const subscribed = getSubscribedProviderIds(req.user.id);

    res.json({
      ok: true,
      availability: buildAvailabilityView(show.id, region, subscribed),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/shows/:showId/until
 * Body: { providerId, availableUntil }   availableUntil = null löscht
 *
 * Trägt ein, bis wann ein Titel bei einem Anbieter läuft.
 *
 * Warum von Hand? Weil es keine andere Quelle gibt. TMDB liefert je Anbieter
 * genau vier Felder – logo_path, provider_id, provider_name und
 * display_priority – und kein Enddatum, in keiner Form. Bekannt wird so ein
 * Datum also nur, wenn es jemand sieht: Netflix zeigt "Letzter Tag: 30.
 * September", ein Anbieter kündigt es an, es steht in der Presse.
 *
 * Der Eintrag gilt für die ganze Instanz, nicht je Person: "Bis wann läuft
 * das bei Netflix" ist eine Tatsache über die Plattform, keine persönliche
 * Einstellung. Wer sie einträgt, hilft allen anderen mit – deshalb darf das
 * jedes angemeldete Konto und nicht nur ein Administrator.
 */
router.put('/:showId/until', (req, res) => {
  const show = findShowById(Number(req.params.showId));
  if (!show) return res.status(404).json({ error: 'Serie unbekannt.' });

  const { region } = getRuntimeSettings(req.user);

  const providerId = Number(req.body?.providerId);

  if (!Number.isInteger(providerId)) {
    return res.status(400).json({ error: 'Es fehlt der Anbieter.' });
  }

  const value = req.body?.availableUntil;

  // Leerer Wert = Eintrag entfernen. Das ist der Weg zurück, wenn sich ein
  // Datum als falsch herausstellt oder der Anbieter verlängert.
  if (value === null || value === undefined || value === '') {
    run(
      'DELETE FROM availability_until WHERE show_id = ? AND region = ? AND provider_id = ?',
      show.id,
      region,
      providerId,
    );

    return res.json({ ok: true, removed: true });
  }

  const date = String(value).slice(0, 10);

  // Format prüfen, statt zu hoffen. Ein "31.09.2026" oder "morgen" würde
  // sonst als Zeichenkette in der Datenbank landen und jede Berechnung
  // stillschweigend verfälschen.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) {
    return res.status(400).json({ error: 'Bitte ein Datum im Format JJJJ-MM-TT angeben.' });
  }

  // Ein Datum in der Vergangenheit ist keine Ankündigung, sondern ein
  // Tippfehler – und es würde ohnehin nie angezeigt.
  if (date < new Date().toISOString().slice(0, 10)) {
    return res.status(400).json({ error: 'Das Datum liegt in der Vergangenheit.' });
  }

  run(
    `INSERT INTO availability_until (show_id, region, provider_id, available_until, noted_by)
     VALUES (?,?,?,?,?)
     ON CONFLICT(show_id, region, provider_id) DO UPDATE SET
        available_until = excluded.available_until,
        noted_by        = excluded.noted_by,
        noted_at        = datetime('now')`,
    show.id,
    region,
    providerId,
    date,
    req.user.id,
  );

  res.json({
    ok: true,
    availability: buildAvailabilityView(show.id, region, getSubscribedProviderIds(req.user.id)),
  });
});

export default router;
