/**
 * ---------------------------------------------------------------------------
 * src/routes/stats.js – Auswertungen über die eigene Serien-Datenbank
 * ---------------------------------------------------------------------------
 * Eingehängt in src/server.js unter /api/stats.
 *
 * Beantwortet Fragen wie: Wie viele Serien habe ich? Wie verteilen sie sich
 * auf meine Abos? Zahle ich für einen Dienst, bei dem nichts von meiner Liste
 * läuft? Wie viel Zeit habe ich mit Schauen verbracht?
 *
 * Alle Zahlen kommen ausschließlich aus der lokalen Datenbank – kein einziger
 * TMDB-Aufruf, die Seite ist deshalb sofort da.
 *
 * Verknüpfungen:
 *   - src/db.js -> library, shows, availability, user_providers, watched_episodes
 *   - public/js/views/stats.js -> die Auswertungsseite im Frontend
 * ---------------------------------------------------------------------------
 */

import express from 'express';
import { all, get } from '../db.js';
import { requireAuth } from '../auth.js';
import { getRuntimeSettings } from '../tmdb.js';

const router = express.Router();
router.use(requireAuth);

/**
 * GET /api/stats
 * Liefert alle Kennzahlen in einer Antwort.
 */
router.get('/', (req, res) => {
  const { region } = getRuntimeSettings(req.user);
  const userId = req.user.id;

  // --- Einträge je Status -------------------------------------------------
  // Basis für die fünf Kacheln am Kopf der Seite.
  const byStatus = all(
    'SELECT status, COUNT(*) AS count FROM library WHERE user_id = ? GROUP BY status',
    userId,
  );

  // --- Serien vs. Filme ---------------------------------------------------
  const byMediaType = all(
    `SELECT s.media_type, COUNT(*) AS count
       FROM library l JOIN shows s ON s.id = l.show_id
      WHERE l.user_id = ? GROUP BY s.media_type`,
    userId,
  );

  // --- Verteilung auf die Anbieter ----------------------------------------
  // Die zentrale Auswertung: Für jeden verknüpften Anbieter wird gezählt, wie
  // viele Titel der eigenen Bibliothek dort im Abo enthalten sind.
  // LEFT JOIN, damit auch Anbieter mit null Treffern erscheinen – genau die
  // sind ja die interessanten ("wofür zahle ich eigentlich?").
  const byProvider = all(
    `SELECT up.provider_id, up.name, up.logo_path,
            COUNT(DISTINCT l.show_id) AS count
       FROM user_providers up
       LEFT JOIN availability a
              ON a.provider_id = up.provider_id
             AND a.region = ?
             AND a.offer_type IN ('flatrate','free','ads')
       LEFT JOIN library l
              ON l.show_id = a.show_id
             AND l.user_id = ?
      WHERE up.user_id = ?
      GROUP BY up.provider_id, up.name, up.logo_path
      ORDER BY count DESC, up.name`,
    region,
    userId,
    userId,
  );

  // --- Titel ohne Abo-Abdeckung -------------------------------------------
  // "Diese Serien stehen auf meiner Liste, laufen aber bei keinem meiner
  // Anbieter" – die Lücke, die eine Abo-Entscheidung begründet.
  const uncovered = all(
    `SELECT s.id AS show_id, s.tmdb_id, s.media_type, s.title, s.poster_path
       FROM library l
       JOIN shows s ON s.id = l.show_id
      WHERE l.user_id = ?
        AND l.status IN ('watchlist','watching')
        AND NOT EXISTS (
          SELECT 1 FROM availability a
           JOIN user_providers up ON up.provider_id = a.provider_id AND up.user_id = ?
           WHERE a.show_id = l.show_id
             AND a.region = ?
             AND a.offer_type IN ('flatrate','free','ads')
        )
      ORDER BY l.added_at DESC
      LIMIT 50`,
    userId,
    userId,
    region,
  );

  // --- Anbieter-Vorschläge -------------------------------------------------
  // Umgekehrte Richtung: Bei welchen NICHT abonnierten Anbietern läuft am
  // meisten von meiner Liste? Das ist die Empfehlung "ein Monat Paramount+
  // würde dir 7 Serien freischalten".
  const suggestions = all(
    `SELECT a.provider_id, a.name, a.logo_path,
            COUNT(DISTINCT l.show_id) AS count
       FROM library l
       JOIN availability a ON a.show_id = l.show_id AND a.region = ?
      WHERE l.user_id = ?
        AND l.status IN ('watchlist','watching')
        AND a.offer_type IN ('flatrate','free','ads')
        -- Anbieter ausschließen, die ich bereits abonniert habe.
        AND a.provider_id NOT IN (
              SELECT provider_id FROM user_providers WHERE user_id = ?
        )
      GROUP BY a.provider_id, a.name, a.logo_path
      ORDER BY count DESC
      LIMIT 8`,
    region,
    userId,
    userId,
  );

  // --- Gesehene Episoden und investierte Zeit ------------------------------
  // Die Laufzeit kommt bevorzugt aus der Episode selbst; fehlt sie, wird die
  // durchschnittliche Serienlaufzeit genommen, und als letzter Rückfall 45
  // Minuten (ein üblicher Wert für eine Dramaserie).
  const watchtime = get(
    `SELECT COUNT(*) AS episodes,
            SUM(COALESCE(e.runtime, s.runtime, 45)) AS minutes
       FROM watched_episodes w
       JOIN episodes e ON e.id = w.episode_id
       JOIN shows s ON s.id = w.show_id
      WHERE w.user_id = ?`,
    userId,
  );

  // --- Häufigste Genres ----------------------------------------------------
  // genres steht als JSON-Text in der Spalte, deshalb wird hier in JavaScript
  // ausgezählt statt in SQL. Bei der zu erwartenden Größe (einige hundert
  // Zeilen) ist das völlig unkritisch.
  const genreRows = all(
    `SELECT s.genres FROM library l JOIN shows s ON s.id = l.show_id WHERE l.user_id = ?`,
    userId,
  );

  const genreCounts = new Map();
  for (const row of genreRows) {
    try {
      for (const genre of JSON.parse(row.genres || '[]')) {
        genreCounts.set(genre, (genreCounts.get(genre) || 0) + 1);
      }
    } catch {
      /* beschädigtes JSON überspringen */
    }
  }

  const topGenres = [...genreCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // --- Zuletzt hinzugefügt -------------------------------------------------
  const recent = all(
    `SELECT s.tmdb_id, s.media_type, s.title, s.poster_path, l.added_at, l.status
       FROM library l JOIN shows s ON s.id = l.show_id
      WHERE l.user_id = ?
      ORDER BY l.added_at DESC LIMIT 10`,
    userId,
  );

  res.json({
    region,
    // In ein Objekt umbauen: { watching: 4, completed: 12, … } lässt sich im
    // Frontend direkter ansprechen als ein Array.
    byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.count])),
    byMediaType: Object.fromEntries(byMediaType.map((r) => [r.media_type, r.count])),
    total: byStatus.reduce((sum, r) => sum + r.count, 0),
    byProvider,
    uncovered,
    suggestions,
    watchtime: {
      episodes: watchtime.episodes || 0,
      minutes: watchtime.minutes || 0,
      // Vorgerechnet, damit jede Oberfläche dieselbe Zahl anzeigt.
      hours: Math.round((watchtime.minutes || 0) / 60),
      days: Math.round(((watchtime.minutes || 0) / 1440) * 10) / 10,
    },
    topGenres,
    recent,
  });
});

export default router;
