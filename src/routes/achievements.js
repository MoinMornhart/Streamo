/**
 * ---------------------------------------------------------------------------
 * src/routes/achievements.js – Erfolge abrufen
 * ---------------------------------------------------------------------------
 * Eingehängt in src/server.js unter /api/achievements.
 *
 * Endpunkte:
 *   GET  /api/achievements        – alle Erfolge mit Zustand und Fortschritt
 *   POST /api/achievements/check  – Prüfung von Hand anstoßen
 *
 * Der zweite ist vor allem nach einem Update nützlich: Neue Erfolge werden
 * dann rückwirkend vergeben, ohne dass man erst wieder etwas abhaken müsste.
 *
 * Verknüpfungen:
 *   - src/achievements.js -> die Definitionen und die Prüflogik
 *   - public/js/views/achievements.js -> die Anzeige
 * ---------------------------------------------------------------------------
 */

import express from 'express';
import { requireAuth } from '../auth.js';
import { listAchievements, checkAchievements } from '../achievements.js';

const router = express.Router();
router.use(requireAuth);

/**
 * GET /api/achievements
 *
 * Prüft vor der Ausgabe einmal nach. So sieht man auch dann sofort den
 * richtigen Stand, wenn ein Erfolg durch ein Update neu dazugekommen ist
 * oder Daten importiert wurden.
 */
router.get('/', (req, res) => {
  checkAchievements(req.user.id);
  res.json(listAchievements(req.user.id));
});

/**
 * POST /api/achievements/check
 * Stößt die Prüfung an und meldet, was dabei neu dazugekommen ist.
 */
router.post('/check', (req, res) => {
  const unlocked = checkAchievements(req.user.id);
  res.json({ ok: true, unlocked });
});

export default router;
