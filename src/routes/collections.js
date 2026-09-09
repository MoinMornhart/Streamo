/**
 * ---------------------------------------------------------------------------
 * src/routes/collections.js – Filmreihen
 * ---------------------------------------------------------------------------
 * Eingehängt in src/server.js unter /api/collections.
 *
 * Endpunkte:
 *   GET    /api/collections              – alle sichtbaren Reihen
 *   POST   /api/collections              – eigene Reihe anlegen
 *   GET    /api/collections/search?q=    – offizielle Reihen bei TMDB suchen
 *   POST   /api/collections/import       – offizielle Reihe übernehmen
 *   GET    /api/collections/:id          – eine Reihe mit allen Titeln
 *   PATCH  /api/collections/:id          – Name und Beschreibung ändern
 *   DELETE /api/collections/:id          – eigene Reihe löschen
 *   POST   /api/collections/:id/items    – Titel aufnehmen
 *   DELETE /api/collections/:id/items/:showId – Titel entfernen
 *   PUT    /api/collections/:id/order    – Reihenfolge festlegen
 *
 * Verknüpfungen:
 *   - src/collections.js -> die eigentliche Logik
 *   - src/store.js       -> ensureShow() beim Aufnehmen eines Titels
 *   - public/js/views/collections.js -> die Anzeige
 * ---------------------------------------------------------------------------
 */

import express from 'express';
import { requireAuth } from '../auth.js';
import { getRuntimeSettings } from '../tmdb.js';
import * as tmdb from '../tmdb.js';
import { ensureShow, findShowById } from '../store.js';
import { run } from '../db.js';

import {
  listCollections,
  getCollection,
  createCustomCollection,
  ensureOfficialCollection,
  findOfficialCollection,
  getEditableCollection,
  addItem,
  removeItem,
  reorderItems,
} from '../collections.js';

const router = express.Router();
router.use(requireAuth);

/**
 * GET /api/collections
 * Alle Reihen, die für diesen Benutzer sichtbar sind.
 */
router.get('/', (req, res) => {
  res.json({ collections: listCollections(req.user.id) });
});

/**
 * GET /api/collections/search?q=Kingsman
 *
 * Sucht offizielle Reihen bei TMDB. Steht VOR der Route mit :id, sonst würde
 * Express "search" als Kennung deuten.
 */
router.get('/search', async (req, res, next) => {
  const query = String(req.query.q ?? '').trim();
  const { language } = getRuntimeSettings(req.user);

  if (!query) return res.json({ results: [] });

  try {
    const data = await tmdb.searchCollections(query, { language });

    res.json({
      results: (data.results || []).map((row) => ({
        tmdbId: row.id,
        name: row.name,
        overview: row.overview || '',
        posterPath: row.poster_path,
        backdropPath: row.backdrop_path,
        // Ist die Reihe schon übernommen? Dann kann das Frontend direkt
        // dorthin verlinken, statt sie erneut anzubieten.
        imported: Boolean(findOfficialCollection(row.id)),
      })),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/collections/import
 * Übernimmt eine offizielle Reihe von TMDB. Body: { tmdbId }
 *
 * Holt dabei auch alle Filme der Reihe in den Metadaten-Cache, damit die
 * Übersicht sofort vollständig ist.
 */
router.post('/import', async (req, res, next) => {
  const tmdbId = Number(req.body?.tmdbId);
  const { region, language } = getRuntimeSettings(req.user);

  if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
    return res.status(400).json({ error: 'Ungültige Kennung der Filmreihe.' });
  }

  try {
    const collection = await ensureOfficialCollection(tmdbId, { region, language });

    res.json({
      ok: true,
      collection: getCollection(collection.id, { userId: req.user.id, region }),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/collections
 * Legt eine eigene Reihe an. Body: { name, description? }
 */
router.post('/', (req, res) => {
  try {
    const collection = createCustomCollection(req.user.id, {
      name: req.body?.name,
      description: req.body?.description,
    });

    res.json({ ok: true, id: collection.id, name: collection.name });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * GET /api/collections/:id
 * Eine Reihe mit allen Titeln, Verfügbarkeit und Fortschritt.
 */
router.get('/:id', (req, res) => {
  const { region } = getRuntimeSettings(req.user);

  const collection = getCollection(Number(req.params.id), {
    userId: req.user.id,
    region,
  });

  if (!collection) return res.status(404).json({ error: 'Diese Filmreihe gibt es nicht.' });

  res.json(collection);
});

/**
 * PATCH /api/collections/:id
 * Ändert Name oder Beschreibung. Body: { name?, description? }
 *
 * Nur eigene Reihen: Offizielle kommen von TMDB und würden beim nächsten
 * Abgleich ohnehin überschrieben.
 */
router.patch('/:id', (req, res) => {
  const collection = getEditableCollection(Number(req.params.id), req.user.id);

  if (!collection) {
    return res.status(404).json({
      error: 'Diese Reihe gehört dir nicht. Offizielle Filmreihen lassen sich nicht ändern.',
    });
  }

  const updates = [];
  const params = [];

  if (req.body?.name !== undefined) {
    const name = String(req.body.name).trim();
    if (!name) return res.status(400).json({ error: 'Der Name darf nicht leer sein.' });
    updates.push('name = ?');
    params.push(name.slice(0, 120));
  }

  if (req.body?.description !== undefined) {
    updates.push('description = ?');
    params.push(String(req.body.description).trim().slice(0, 2000) || null);
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'Keine Änderungen übergeben.' });
  }

  updates.push("updated_at = datetime('now')");
  params.push(collection.id);

  run(`UPDATE collections SET ${updates.join(', ')} WHERE id = ?`, ...params);

  res.json({ ok: true });
});

/**
 * DELETE /api/collections/:id
 * Löscht eine eigene Reihe. Die Filme darin bleiben unangetastet – gelöscht
 * wird nur die Zusammenstellung.
 */
router.delete('/:id', (req, res) => {
  const collection = getEditableCollection(Number(req.params.id), req.user.id);

  if (!collection) {
    return res.status(404).json({ error: 'Diese Reihe gehört dir nicht.' });
  }

  // collection_items hängt per ON DELETE CASCADE daran.
  run('DELETE FROM collections WHERE id = ?', collection.id);

  res.json({ ok: true });
});

/**
 * POST /api/collections/:id/items
 * Nimmt einen Titel auf. Body: { tmdbId, mediaType?, note? }
 *
 * Der Titel muss nicht in der Bibliothek stehen – eine Reihe darf Filme
 * enthalten, die man noch gar nicht auf der Liste hat. Genau darum geht es ja
 * bei einer Vorwissen-Liste.
 */
router.post('/:id/items', async (req, res, next) => {
  const collection = getEditableCollection(Number(req.params.id), req.user.id);

  if (!collection) {
    return res.status(404).json({
      error: 'Diese Reihe gehört dir nicht. Offizielle Filmreihen lassen sich nicht ändern.',
    });
  }

  const tmdbId = Number(req.body?.tmdbId);
  const mediaType = req.body?.mediaType === 'tv' ? 'tv' : 'movie';

  if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
    return res.status(400).json({ error: 'Ungültige TMDB-Kennung.' });
  }

  const { region, language } = getRuntimeSettings(req.user);

  try {
    // Metadaten und Verfügbarkeit holen, falls der Titel noch unbekannt ist.
    const show = await ensureShow(tmdbId, mediaType, { region, language });

    addItem(collection.id, show.id, req.body?.note);

    res.json({ ok: true, showId: show.id, title: show.title });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/collections/:id/items/:showId
 * Nimmt einen Titel wieder heraus.
 */
router.delete('/:id/items/:showId', (req, res) => {
  const collection = getEditableCollection(Number(req.params.id), req.user.id);

  if (!collection) {
    return res.status(404).json({ error: 'Diese Reihe gehört dir nicht.' });
  }

  const removed = removeItem(collection.id, Number(req.params.showId));

  if (!removed) return res.status(404).json({ error: 'Der Titel ist nicht in dieser Reihe.' });

  res.json({ ok: true });
});

/**
 * PUT /api/collections/:id/order
 * Legt die Reihenfolge fest. Body: { showIds: number[] }
 *
 * Erwartet die vollständige Liste in der gewünschten Ordnung.
 */
router.put('/:id/order', (req, res) => {
  const collection = getEditableCollection(Number(req.params.id), req.user.id);

  if (!collection) {
    return res.status(404).json({
      error: 'Diese Reihe gehört dir nicht. Offizielle Filmreihen lassen sich nicht umsortieren.',
    });
  }

  const showIds = Array.isArray(req.body?.showIds) ? req.body.showIds : null;

  if (!showIds) {
    return res.status(400).json({ error: 'showIds muss ein Array sein.' });
  }

  const count = reorderItems(collection.id, showIds);

  res.json({ ok: true, ordered: count });
});

export default router;
