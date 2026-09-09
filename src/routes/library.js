/**
 * ---------------------------------------------------------------------------
 * src/routes/library.js – Die persönliche Serien-Datenbank
 * ---------------------------------------------------------------------------
 * Eingehängt in src/server.js unter /api/library.
 *
 * Hier entsteht der zweite Teil des Projektwunsches: "dadurch eine Datenbank
 * an Serien, die ich sehen kann, und ich sehe immer, wo ich sie streamen kann".
 * Jeder Eintrag der Antwort trägt deshalb NICHT nur die Metadaten, sondern
 * auch die aktuellen Streaming-Angebote und die Markierung, ob sie in einem
 * der verknüpften Abos enthalten sind.
 *
 * Endpunkte:
 *   GET    /api/library           – Bibliothek lesen, mit Filtern und Sortierung
 *   POST   /api/library           – Serie/Film aufnehmen
 *   PATCH  /api/library/:showId   – Status, Bewertung, Favorit, Notiz ändern
 *   DELETE /api/library/:showId   – Eintrag entfernen
 *   GET    /api/library/export    – vollständiger JSON-Export (Backup/Umzug)
 *   POST   /api/library/import    – Import eines solchen Exports
 *
 * Verknüpfungen:
 *   - src/store.js -> ensureShow() lädt die Serie beim Hinzufügen von TMDB
 *   - src/db.js    -> Tabellen library, shows, availability, watched_episodes
 *   - public/js/views/library.js -> die Bibliotheksansicht im Frontend
 * ---------------------------------------------------------------------------
 */

import express from 'express';
import { all, get, run, transaction } from '../db.js';
import { requireAuth } from '../auth.js';
import { getRuntimeSettings } from '../tmdb.js';
// Ein neuer Bibliothekseintrag oder ein Statuswechsel kann einen Erfolg
// freischalten – etwa "erste Serie vollständig gesehen".
import { checkAchievements } from '../achievements.js';
// Fuer die Gruppierung nach Filmreihen (?group=collections).
import { findCollectionForShow } from '../collections.js';
import {
  ensureShow,
  findShow,
  buildAvailabilityView,
  getSubscribedProviderIds,
  getProgress,
} from '../store.js';

const router = express.Router();
router.use(requireAuth);

/**
 * Erlaubte Sortierungen. Als feste Zuordnung (Whitelist), NICHT als
 * durchgereichter String: Der Wert landet direkt im ORDER BY und wäre sonst
 * eine SQL-Injection-Lücke.
 */
const SORT_OPTIONS = {
  added: 'l.added_at DESC',
  title: 's.title COLLATE NOCASE ASC',
  rating: 'l.rating DESC NULLS LAST, s.vote_average DESC',
  tmdb: 's.vote_average DESC',
  year: 's.first_air_date DESC',
  updated: 'l.updated_at DESC',
};

/**
 * Setzt einen Bibliothekseintrag aus den Datenbankzeilen zusammen und reichert
 * ihn um Verfügbarkeit und Sehfortschritt an.
 *
 * @param {object} row  Ergebniszeile aus dem JOIN library+shows
 * @param {object} ctx  Kontext
 * @param {number} ctx.userId
 * @param {string} ctx.region
 * @param {Set<number>} ctx.subscribed IDs aus user_providers
 * @returns {object} Objekt in der Form, die das Frontend rendert
 */
function buildEntry(row, ctx) {
  // Wo läuft die Serie? Rein aus der lokalen Tabelle `availability` – kein
  // API-Aufruf, deshalb ist die Bibliotheksansicht auch offline schnell.
  const availability = buildAvailabilityView(row.show_id, ctx.region, ctx.subscribed);

  const progress = getProgress(ctx.userId, {
    id: row.show_id,
    number_of_episodes: row.number_of_episodes,
  });

  return {
    // --- Bibliotheksdaten (Tabelle library) ---------------------------------
    showId: row.show_id,
    status: row.status,
    rating: row.rating,
    favorite: Boolean(row.favorite),
    notes: row.notes,
    addedAt: row.added_at,
    updatedAt: row.updated_at,

    // --- Metadaten (Tabelle shows) ------------------------------------------
    tmdbId: row.tmdb_id,
    mediaType: row.media_type,
    title: row.title,
    overview: row.overview,
    posterPath: row.poster_path,
    backdropPath: row.backdrop_path,
    year: row.first_air_date?.slice(0, 4) || null,
    showStatus: row.status_text,
    // genres steht als JSON-Text in der Spalte; defensiv parsen, damit ein
    // beschädigter Wert nicht die ganze Antwort zerstört.
    genres: (() => {
      try {
        return JSON.parse(row.genres || '[]');
      } catch {
        return [];
      }
    })(),
    seasons: row.number_of_seasons,
    episodes: row.number_of_episodes,
    voteAverage: row.vote_average,
    runtime: row.runtime,

    // --- Abgeleitetes --------------------------------------------------------
    availability,
    progress,
    availabilityUpdatedAt: row.availability_updated_at,
  };
}

/**
 * GET /api/library
 *
 * Query-Parameter (alle optional, beliebig kombinierbar):
 *   status    watchlist|watching|completed|paused|dropped
 *   mediaType tv|movie
 *   provider  Anbieter-ID – nur Titel, die dort gerade laufen
 *   onlyMine  "1" – nur Titel, die in einem meiner Abos enthalten sind
 *   favorite  "1" – nur Favoriten
 *   genre     Genre-Name (Textsuche im JSON-Feld)
 *   q         Suchbegriff im Titel
 *   sort      added|title|rating|tmdb|year|updated
 */
router.get('/', (req, res) => {
  const { region } = getRuntimeSettings(req.user);
  const subscribed = getSubscribedProviderIds(req.user.id);

  // Bedingungen und Parameter werden parallel aufgebaut, damit jeder Wert
  // gebunden (?) und nie in den SQL-String geschrieben wird.
  const conditions = ['l.user_id = ?'];
  const params = [req.user.id];

  if (req.query.status) {
    conditions.push('l.status = ?');
    params.push(String(req.query.status));
  }

  if (req.query.mediaType) {
    conditions.push('s.media_type = ?');
    params.push(String(req.query.mediaType));
  }

  if (req.query.favorite === '1') {
    conditions.push('l.favorite = 1');
  }

  if (req.query.q) {
    // LIKE mit %…% und COLLATE NOCASE = einfache Teilstringsuche ohne
    // Groß-/Kleinschreibung. Für ein paar hundert Einträge völlig ausreichend.
    conditions.push('(s.title LIKE ? COLLATE NOCASE OR s.original_title LIKE ? COLLATE NOCASE)');
    const like = `%${String(req.query.q)}%`;
    params.push(like, like);
  }

  if (req.query.genre) {
    // genres ist ein JSON-Array von Namen – eine Textsuche darauf ist der
    // pragmatische Weg, ohne eine eigene Genre-Tabelle einzuführen.
    conditions.push('s.genres LIKE ?');
    params.push(`%"${String(req.query.genre)}"%`);
  }

  // Filter "läuft bei einem bestimmten Anbieter": EXISTS statt JOIN, damit
  // eine Serie mit mehreren Angeboten nicht mehrfach in der Liste auftaucht.
  if (req.query.provider) {
    conditions.push(`EXISTS (
      SELECT 1 FROM availability a
       WHERE a.show_id = l.show_id AND a.region = ? AND a.provider_id = ?
         AND a.offer_type IN ('flatrate','free','ads')
    )`);
    params.push(region, Number(req.query.provider));
  }

  // Filter "nur was in meinen Abos enthalten ist".
  if (req.query.onlyMine === '1' && subscribed.size > 0) {
    // Die IDs kommen aus der eigenen Datenbank und sind Zahlen; trotzdem
    // erzeugen wir für jede einen Platzhalter statt sie einzusetzen.
    const placeholders = [...subscribed].map(() => '?').join(',');
    conditions.push(`EXISTS (
      SELECT 1 FROM availability a
       WHERE a.show_id = l.show_id AND a.region = ?
         AND a.offer_type IN ('flatrate','free','ads')
         AND a.provider_id IN (${placeholders})
    )`);
    params.push(region, ...subscribed);
  }

  const orderBy = SORT_OPTIONS[String(req.query.sort)] || SORT_OPTIONS.added;

  const rows = all(
    `SELECT l.show_id, l.status, l.rating, l.favorite, l.notes,
            l.added_at, l.updated_at,
            s.tmdb_id, s.media_type, s.title, s.overview, s.poster_path,
            s.backdrop_path, s.first_air_date, s.status AS status_text, s.genres,
            s.number_of_seasons, s.number_of_episodes, s.vote_average, s.runtime,
            s.availability_updated_at
       FROM library l
       JOIN shows s ON s.id = l.show_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY ${orderBy}`,
    ...params,
  );

  const entries = rows.map((row) => buildEntry(row, { userId: req.user.id, region, subscribed }));

  // -------------------------------------------------------------------------
  // Gruppierung nach Filmreihen
  // -------------------------------------------------------------------------
  // Mit ?group=collections werden Titel, die zu derselben Reihe gehören, zu
  // einer Kachel zusammengefasst. Wer acht Marvel-Filme auf der Liste hat,
  // sieht dann eine Gruppe statt acht einzelner Poster.
  //
  // Titel ohne Reihe bleiben einzeln – sie zwanghaft irgendwo einzusortieren
  // würde die Übersicht eher verschlechtern.
  if (req.query.group === 'collections') {
    const groups = new Map();
    const singles = [];

    for (const entry of entries) {
      // Zu welcher Reihe gehört der Titel? Die Zuordnung steht in `shows`
      // und stammt aus dem TMDB-Feld belongs_to_collection.
      const collection = findCollectionForShow(entry.showId, req.user.id);

      if (!collection) {
        singles.push(entry);
        continue;
      }

      if (!groups.has(collection.id)) {
        groups.set(collection.id, {
          collectionId: collection.id,
          name: collection.name,
          // Wie viele Teile hat die Reihe insgesamt? Interessant ist ja
          // gerade, wie viele davon einem noch fehlen.
          totalParts: collection.total,
          items: [],
        });
      }

      groups.get(collection.id).items.push(entry);
    }

    const groupList = [...groups.values()]
      .map((group) => ({
        ...group,
        // Innerhalb der Gruppe nach der Reihenfolge der Reihe sortieren,
        // nicht nach dem Zeitpunkt des Hinzufügens.
        items: group.items.sort((a, b) => (a.year ?? '').localeCompare(b.year ?? '')),
        ownedParts: group.items.length,
        watchedParts: group.items.filter((item) => item.status === 'completed').length,
        // Das Poster der Reihe: das des ersten Teils, den man besitzt.
        posterPath: group.items[0]?.posterPath ?? null,
      }))
      // Größere Gruppen zuerst – sie sind die interessanteren.
      .sort((a, b) => b.ownedParts - a.ownedParts || a.name.localeCompare(b.name));

    return res.json({
      region,
      total: entries.length,
      grouped: true,
      groups: groupList,
      // Alles, was zu keiner Reihe gehört.
      singles,
    });
  }

  res.json({
    region,
    total: entries.length,
    grouped: false,
    entries,
  });
});

/**
 * POST /api/library
 * Nimmt eine Serie oder einen Film in die Bibliothek auf.
 * Body: { tmdbId, mediaType?, status? }
 *
 * Ablauf:
 *   1. ensureShow() holt Metadaten UND Verfügbarkeit von TMDB (src/store.js)
 *      und legt sie in `shows` + `availability` ab.
 *   2. Der Bibliothekseintrag verknüpft Benutzer und Serie.
 */
router.post('/', async (req, res, next) => {
  const tmdbId = Number(req.body?.tmdbId);
  const mediaType = req.body?.mediaType === 'movie' ? 'movie' : 'tv';
  const status = req.body?.status || 'watchlist';

  if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
    return res.status(400).json({ error: 'Ungültige TMDB-ID.' });
  }

  const { region, language } = getRuntimeSettings(req.user);

  try {
    const show = await ensureShow(tmdbId, mediaType, { region, language });

    run(
      `INSERT INTO library (user_id, show_id, status)
       VALUES (?,?,?)
       -- Nochmal hinzufügen ändert nur den Status, statt zu scheitern.
       ON CONFLICT(user_id, show_id) DO UPDATE SET
          status = excluded.status,
          updated_at = datetime('now')`,
      req.user.id,
      show.id,
      status,
    );

    res.json({
      ok: true,
      showId: show.id,
      title: show.title,
      // "Der Anfang" wird schon mit dem ersten Eintrag verdient.
      unlocked: checkAchievements(req.user.id),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PATCH /api/library/:showId
 * Ändert einzelne Felder eines Eintrags.
 * Body: { status?, rating?, favorite?, notes? }
 *
 * Es werden nur die Felder angefasst, die im Body vorkommen – so kann das
 * Frontend z. B. nur den Favoritenstern umschalten, ohne die Notiz zu kennen.
 */
router.patch('/:showId', (req, res) => {
  const showId = Number(req.params.showId);

  const entry = get(
    'SELECT * FROM library WHERE user_id = ? AND show_id = ?',
    req.user.id,
    showId,
  );
  if (!entry) return res.status(404).json({ error: 'Nicht in deiner Bibliothek.' });

  const updates = [];
  const params = [];

  if (req.body?.status !== undefined) {
    const allowed = ['watchlist', 'watching', 'completed', 'paused', 'dropped'];
    if (!allowed.includes(req.body.status)) {
      return res.status(400).json({ error: 'Unbekannter Status.' });
    }
    updates.push('status = ?');
    params.push(req.body.status);
  }

  if (req.body?.rating !== undefined) {
    // null = Bewertung löschen; sonst auf 1–10 begrenzen (der CHECK in der
    // Datenbank würde sonst einen harten Fehler werfen).
    const rating = req.body.rating === null ? null : Number(req.body.rating);
    if (rating !== null && (!Number.isInteger(rating) || rating < 1 || rating > 10)) {
      return res.status(400).json({ error: 'Bewertung muss zwischen 1 und 10 liegen.' });
    }
    updates.push('rating = ?');
    params.push(rating);
  }

  if (req.body?.favorite !== undefined) {
    updates.push('favorite = ?');
    params.push(req.body.favorite ? 1 : 0);
  }

  if (req.body?.notes !== undefined) {
    updates.push('notes = ?');
    params.push(String(req.body.notes).slice(0, 5000)); // harte Obergrenze
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'Keine Änderungen übergeben.' });
  }

  updates.push("updated_at = datetime('now')");
  params.push(req.user.id, showId);

  run(
    `UPDATE library SET ${updates.join(', ')} WHERE user_id = ? AND show_id = ?`,
    ...params,
  );

  // Ein Statuswechsel auf "completed" schaltet unter Umständen einen
  // serienbezogenen Erfolg frei – etwa den für Dr. House.
  res.json({ ok: true, unlocked: checkAchievements(req.user.id) });
});

/**
 * DELETE /api/library/:showId
 *
 * Entfernt den Bibliothekseintrag und den zugehörigen Sehfortschritt.
 * Die Serie selbst bleibt in `shows` stehen – als Cache für andere Benutzer
 * und für den Fall, dass sie später erneut hinzugefügt wird.
 */
router.delete('/:showId', (req, res) => {
  const showId = Number(req.params.showId);

  transaction(() => {
    run('DELETE FROM library WHERE user_id = ? AND show_id = ?', req.user.id, showId);
    // Ohne diese Zeile bliebe der alte Fortschritt liegen und würde beim
    // erneuten Hinzufügen überraschend wieder auftauchen.
    run('DELETE FROM watched_episodes WHERE user_id = ? AND show_id = ?', req.user.id, showId);
  });

  res.json({ ok: true });
});

/**
 * GET /api/library/export
 *
 * Vollständiger Export als JSON: Bibliothek, Abos und Sehfortschritt.
 * Bewusst über TMDB-IDs statt interner IDs, damit der Export auch in eine
 * frische Streamo-Installation eingelesen werden kann.
 */
router.get('/export', (req, res) => {
  const library = all(
    `SELECT s.tmdb_id, s.media_type, s.title,
            l.status, l.rating, l.favorite, l.notes, l.added_at
       FROM library l JOIN shows s ON s.id = l.show_id
      WHERE l.user_id = ?`,
    req.user.id,
  );

  const providers = all(
    'SELECT provider_id, name FROM user_providers WHERE user_id = ? ORDER BY sort_order',
    req.user.id,
  );

  const watched = all(
    `SELECT s.tmdb_id, s.media_type, e.season_number, e.episode_number, w.watched_at
       FROM watched_episodes w
       JOIN episodes e ON e.id = w.episode_id
       JOIN shows s ON s.id = w.show_id
      WHERE w.user_id = ?`,
    req.user.id,
  );

  res.setHeader(
    'Content-Disposition',
    `attachment; filename="streamo-export-${new Date().toISOString().slice(0, 10)}.json"`,
  );

  res.json({
    streamoVersion: 1,
    exportedAt: new Date().toISOString(),
    user: req.user.username,
    providers,
    library,
    watched,
  });
});

/**
 * POST /api/library/import
 * Liest einen Export wieder ein.
 * Body: das JSON aus /api/library/export
 *
 * Metadaten werden dabei NICHT von TMDB nachgeladen (das wären bei großen
 * Bibliotheken hunderte Aufrufe). Stattdessen legt der Import Platzhalter an,
 * die der nächste Sync-Lauf (src/sync.js) mit echten Daten füllt.
 */
router.post('/import', (req, res) => {
  const payload = req.body;

  if (!payload || !Array.isArray(payload.library)) {
    return res.status(400).json({ error: 'Ungültige Importdatei.' });
  }

  let imported = 0;
  let providersImported = 0;

  transaction(() => {
    // --- Abos ---------------------------------------------------------------
    for (const p of payload.providers || []) {
      run(
        `INSERT INTO user_providers (user_id, provider_id, name)
         VALUES (?,?,?)
         ON CONFLICT(user_id, provider_id) DO NOTHING`,
        req.user.id,
        Number(p.provider_id),
        p.name ?? null,
      );
      providersImported++;
    }

    // --- Bibliothek ---------------------------------------------------------
    for (const item of payload.library) {
      const tmdbId = Number(item.tmdb_id ?? item.tmdbId);
      const mediaType = item.media_type ?? item.mediaType ?? 'tv';
      if (!Number.isInteger(tmdbId)) continue;

      // Platzhalter-Zeile in `shows`, falls die Serie hier noch unbekannt ist.
      // metadata_updated_at bleibt NULL – genau daran erkennt der Sync, dass
      // dieser Eintrag als Erstes aufgefrischt werden muss.
      run(
        `INSERT INTO shows (tmdb_id, media_type, title)
         VALUES (?,?,?)
         ON CONFLICT(tmdb_id, media_type) DO NOTHING`,
        tmdbId,
        mediaType,
        item.title || `TMDB ${tmdbId}`,
      );

      const show = findShow(tmdbId, mediaType);
      if (!show) continue;

      run(
        `INSERT INTO library (user_id, show_id, status, rating, favorite, notes)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(user_id, show_id) DO UPDATE SET
            status = excluded.status,
            rating = COALESCE(excluded.rating, library.rating),
            favorite = excluded.favorite,
            notes = COALESCE(excluded.notes, library.notes)`,
        req.user.id,
        show.id,
        item.status || 'watchlist',
        item.rating ?? null,
        item.favorite ? 1 : 0,
        item.notes ?? null,
      );
      imported++;
    }
  });

  res.json({ ok: true, imported, providersImported });
});

export default router;
