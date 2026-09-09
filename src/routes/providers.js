/**
 * ---------------------------------------------------------------------------
 * src/routes/providers.js – Streaming-Anbieter verknüpfen
 * ---------------------------------------------------------------------------
 * Eingehängt in src/server.js unter /api/providers.
 *
 * Das ist der Teil, der den ersten Wunsch erfüllt: "eine Website, bei der ich
 * alle Streaminganbieter verknüpfen kann". Die Verknüpfung selbst ist eine
 * Zeile in der Tabelle `user_providers` (users <-> providers).
 *
 * Endpunkte:
 *   GET    /api/providers            – Katalog aller Anbieter meiner Region
 *   GET    /api/providers/mine       – meine verknüpften Abos
 *   POST   /api/providers/mine       – Abo hinzufügen
 *   PUT    /api/providers/mine       – komplette Auswahl auf einmal setzen
 *   DELETE /api/providers/mine/:id   – Abo entfernen
 *
 * Verknüpfungen:
 *   - src/store.js -> syncProviderCatalog() holt den Katalog von TMDB
 *   - src/db.js    -> Tabellen providers und user_providers
 *   - public/js/views/providers.js -> die Anbieter-Auswahlseite im Frontend
 * ---------------------------------------------------------------------------
 */

import express from 'express';
import { all, get, run, transaction } from '../db.js';
import { requireAuth } from '../auth.js';
import { getRuntimeSettings } from '../tmdb.js';
import { syncProviderCatalog } from '../store.js';

const router = express.Router();

// Ab hier ist alles geschützt – Abos sind persönliche Daten.
router.use(requireAuth);

/**
 * GET /api/providers
 *
 * Liefert den Anbieter-Katalog der eigenen Region. Beim ersten Aufruf (oder
 * mit ?refresh=1) wird er von TMDB geholt und in `providers` zwischengespeichert;
 * danach kommt er aus der lokalen Datenbank und ist sofort da.
 *
 * Jeder Eintrag bekommt zusätzlich `subscribed: true|false`, damit das Frontend
 * die Kacheln direkt im richtigen Zustand rendern kann.
 */
router.get('/', async (req, res, next) => {
  const { region, language } = getRuntimeSettings(req.user);

  try {
    let catalog = all(
      `SELECT id, name, logo_path, display_priority
         FROM providers WHERE region = ?
        ORDER BY display_priority, name`,
      region,
    );

    // Katalog leer oder ausdrücklich angefordert -> von TMDB nachladen.
    if (catalog.length === 0 || req.query.refresh === '1') {
      catalog = await syncProviderCatalog(region, language);
    }

    // Meine Abos als Set – damit ist die Zuordnung unten O(1) statt O(n²).
    const mine = new Set(
      all('SELECT provider_id FROM user_providers WHERE user_id = ?', req.user.id).map(
        (r) => r.provider_id,
      ),
    );

    res.json({
      region,
      providers: catalog.map((p) => ({ ...p, subscribed: mine.has(p.id) })),
    });
  } catch (error) {
    next(error); // landet im zentralen Fehler-Handler in src/server.js
  }
});

/**
 * GET /api/providers/mine
 * Nur die verknüpften Abos, in der vom Benutzer gewählten Reihenfolge.
 */
router.get('/mine', (req, res) => {
  res.json({
    providers: all(
      `SELECT provider_id AS id, name, logo_path, sort_order, added_at
         FROM user_providers
        WHERE user_id = ?
        ORDER BY sort_order, name`,
      req.user.id,
    ),
  });
});

/**
 * POST /api/providers/mine
 * Verknüpft EINEN Anbieter mit dem Konto.
 * Body: { providerId, name?, logoPath? }
 *
 * Name und Logo werden mitgespeichert (denormalisiert), damit die Abo-Liste
 * auch dann vollständig aussieht, wenn der Katalog gerade nicht geladen werden
 * kann – siehe Kommentar an der Tabelle user_providers in src/db.js.
 */
router.post('/mine', (req, res) => {
  const providerId = Number(req.body?.providerId);

  if (!Number.isInteger(providerId) || providerId <= 0) {
    return res.status(400).json({ error: 'Ungültige Anbieter-ID.' });
  }

  // Name/Logo bevorzugt aus dem lokalen Katalog, sonst aus dem Request.
  const known = get('SELECT name, logo_path FROM providers WHERE id = ?', providerId);
  const name = known?.name ?? req.body?.name ?? null;
  const logoPath = known?.logo_path ?? req.body?.logoPath ?? null;

  // Ans Ende der Liste einsortieren.
  const nextOrder =
    (get(
      'SELECT COALESCE(MAX(sort_order), -1) AS max FROM user_providers WHERE user_id = ?',
      req.user.id,
    ).max ?? -1) + 1;

  run(
    `INSERT INTO user_providers (user_id, provider_id, name, logo_path, sort_order)
     VALUES (?,?,?,?,?)
     -- Doppelklick im UI soll keinen Fehler erzeugen, sondern die vorhandene
     -- Verknüpfung einfach auffrischen.
     ON CONFLICT(user_id, provider_id) DO UPDATE SET
        name = excluded.name,
        logo_path = excluded.logo_path`,
    req.user.id,
    providerId,
    name,
    logoPath,
    nextOrder,
  );

  res.json({ ok: true, providerId });
});

/**
 * PUT /api/providers/mine
 * Setzt die gesamte Abo-Auswahl auf einmal.
 * Body: { providerIds: number[] }
 *
 * Wird von der Anbieter-Seite benutzt, wenn man mehrere Kacheln anklickt und
 * dann "Speichern" drückt. In einer Transaktion, damit zwischendurch nie ein
 * Zustand mit halber Auswahl sichtbar wird.
 */
router.put('/mine', (req, res) => {
  const ids = Array.isArray(req.body?.providerIds) ? req.body.providerIds : null;

  if (!ids) {
    return res.status(400).json({ error: 'providerIds muss ein Array sein.' });
  }

  // Bereinigen: nur positive Ganzzahlen, keine Duplikate.
  const clean = [...new Set(ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))];

  transaction(() => {
    run('DELETE FROM user_providers WHERE user_id = ?', req.user.id);

    clean.forEach((providerId, index) => {
      const known = get('SELECT name, logo_path FROM providers WHERE id = ?', providerId);

      run(
        `INSERT INTO user_providers (user_id, provider_id, name, logo_path, sort_order)
         VALUES (?,?,?,?,?)`,
        req.user.id,
        providerId,
        known?.name ?? null,
        known?.logo_path ?? null,
        // Die Reihenfolge im Array ist die Anzeigereihenfolge.
        index,
      );
    });
  });

  res.json({ ok: true, count: clean.length });
});

/**
 * DELETE /api/providers/mine/:id
 * Löst die Verknüpfung zu einem Anbieter wieder.
 */
router.delete('/mine/:id', (req, res) => {
  const providerId = Number(req.params.id);

  const result = run(
    'DELETE FROM user_providers WHERE user_id = ? AND provider_id = ?',
    req.user.id,
    providerId,
  );

  res.json({ ok: true, removed: Number(result.changes) });
});

export default router;
