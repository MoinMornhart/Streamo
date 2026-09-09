/**
 * ---------------------------------------------------------------------------
 * src/routes/friends.js – Freunde, gemeinsames Schauen, Empfehlungen
 * ---------------------------------------------------------------------------
 * Eingehängt in src/server.js unter /api/friends.
 *
 * Endpunkte:
 *   GET    /api/friends                  – Freunde und offene Anfragen
 *   POST   /api/friends/request          – Anfrage stellen (per Benutzername)
 *   POST   /api/friends/:id/accept       – Anfrage annehmen
 *   DELETE /api/friends/:id              – ablehnen oder Freundschaft beenden
 *   GET    /api/friends/:id/library      – die Bibliothek eines Freundes
 *   GET    /api/friends/:id/together     – "Was können wir zusammen schauen?"
 *   POST   /api/friends/:id/recommend    – einen Titel empfehlen
 *   GET    /api/friends/recommendations  – meine erhaltenen Empfehlungen
 *   POST   /api/friends/recommendations/read – als gelesen markieren
 *   DELETE /api/friends/recommendations/:id  – eine Empfehlung entfernen
 *
 * Verknüpfungen:
 *   - src/friends.js -> die eigentliche Logik
 *   - src/store.js   -> ensureShow beim Empfehlen eines noch unbekannten Titels
 *   - public/js/views/friends.js -> die Anzeige
 * ---------------------------------------------------------------------------
 */

import express from 'express';
import { requireAuth } from '../auth.js';
import { get } from '../db.js';
import { getRuntimeSettings } from '../tmdb.js';
import { ensureShow } from '../store.js';

import {
  findUserByName,
  getFriendshipStatus,
  requestFriendship,
  acceptFriendship,
  removeFriendship,
  listFriends,
  areFriends,
  getFriendLibrary,
  findCommonGround,
  recommend,
  getRecommendations,
  countUnread,
  markRead,
  dismissRecommendation,
} from '../friends.js';

const router = express.Router();
router.use(requireAuth);

/**
 * Kurzprofil eines Kontos für die Anzeige über einer Freundesliste.
 *
 * Liefert bewusst nur den Namen – alles Weitere steht in den Daten, die der
 * jeweilige Endpunkt ohnehin zurückgibt.
 *
 * @param {number} userId
 * @returns {{id: number, username: string, displayName: string|null}|null}
 */
function getFriendSummary(userId) {
  const row = get('SELECT id, username, display_name FROM users WHERE id = ?', userId);

  if (!row) return null;

  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
  };
}

/**
 * GET /api/friends
 * Freunde, eingehende und ausgehende Anfragen, plus die Zahl ungelesener
 * Empfehlungen für den Zähler in der Navigation.
 */
router.get('/', (req, res) => {
  res.json({
    ...listFriends(req.user.id),
    unreadRecommendations: countUnread(req.user.id),
  });
});

/**
 * GET /api/friends/recommendations
 * Die Empfehlungen, die ich bekommen habe.
 *
 * Steht VOR der Route mit :id, sonst würde Express "recommendations" als
 * Kennung eines Freundes deuten.
 */
router.get('/recommendations', (req, res) => {
  const { region } = getRuntimeSettings(req.user);

  res.json({ recommendations: getRecommendations(req.user.id, region) });
});

/**
 * POST /api/friends/recommendations/read
 * Markiert Empfehlungen als gelesen. Body: { id? } – ohne id: alle.
 */
router.post('/recommendations/read', (req, res) => {
  markRead(req.user.id, req.body?.id ? Number(req.body.id) : undefined);
  res.json({ ok: true, unread: countUnread(req.user.id) });
});

/**
 * DELETE /api/friends/recommendations/:id
 * Entfernt eine Empfehlung aus der eigenen Liste.
 */
router.delete('/recommendations/:id', (req, res) => {
  const removed = dismissRecommendation(req.user.id, Number(req.params.id));

  if (!removed) return res.status(404).json({ error: 'Diese Empfehlung gibt es nicht.' });

  res.json({ ok: true });
});

/**
 * POST /api/friends/request
 * Stellt eine Freundschaftsanfrage. Body: { username }
 *
 * Gesucht wird per Anmeldename oder E-Mail. Gibt es das Konto nicht, kommt
 * dieselbe Meldung wie bei einem Tippfehler – aus der Antwort soll sich nicht
 * ablesen lassen, welche Konten auf dieser Instanz existieren.
 */
router.post('/request', (req, res) => {
  const target = findUserByName(req.body?.username);

  if (!target) {
    return res.status(404).json({
      error: 'Unter diesem Namen gibt es hier niemanden.',
    });
  }

  try {
    const result = requestFriendship(req.user.id, target.id);

    res.json({
      ok: true,
      ...result,
      friend: {
        id: target.id,
        username: target.username,
        displayName: target.display_name,
      },
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * POST /api/friends/:id/accept
 * Nimmt eine eingegangene Anfrage an.
 */
router.post('/:id/accept', (req, res) => {
  const accepted = acceptFriendship(req.user.id, Number(req.params.id));

  if (!accepted) {
    return res.status(404).json({ error: 'Es gibt keine offene Anfrage von dieser Person.' });
  }

  res.json({ ok: true });
});

/**
 * DELETE /api/friends/:id
 * Lehnt eine Anfrage ab oder beendet eine Freundschaft – beides derselbe
 * Vorgang, siehe src/friends.js.
 */
router.delete('/:id', (req, res) => {
  const removed = removeFriendship(req.user.id, Number(req.params.id));

  if (!removed) return res.status(404).json({ error: 'Da gibt es nichts zu beenden.' });

  res.json({ ok: true });
});

/**
 * GET /api/friends/:id/library
 * Die Bibliothek eines Freundes – ohne dessen persönliche Notizen.
 */
router.get('/:id/library', (req, res) => {
  const friendId = Number(req.params.id);

  if (!areFriends(req.user.id, friendId)) {
    return res.status(403).json({
      error: 'Die Bibliothek siehst du erst, wenn ihr befreundet seid.',
    });
  }

  const { region } = getRuntimeSettings(req.user);

  res.json({
    friend: getFriendSummary(friendId),
    entries: getFriendLibrary(friendId, req.user.id, region),
  });
});

/**
 * GET /api/friends/:id/together
 * "Was können wir zusammen schauen?" – der eigentliche Zweck der Freundesliste.
 */
router.get('/:id/together', (req, res) => {
  const friendId = Number(req.params.id);

  if (!areFriends(req.user.id, friendId)) {
    return res.status(403).json({
      error: 'Vorschläge gibt es erst, wenn ihr befreundet seid.',
    });
  }

  const { region } = getRuntimeSettings(req.user);

  res.json({
    friend: getFriendSummary(friendId),
    region,
    ...findCommonGround(req.user.id, friendId, region),
  });
});

/**
 * POST /api/friends/:id/recommend
 * Empfiehlt einem Freund einen Titel.
 * Body: { tmdbId, mediaType?, message? }
 *
 * Der Titel muss nicht in der eigenen Bibliothek stehen – man darf auch
 * empfehlen, was man selbst nur kennt.
 */
router.post('/:id/recommend', async (req, res, next) => {
  const friendId = Number(req.params.id);
  const tmdbId = Number(req.body?.tmdbId);
  const mediaType = req.body?.mediaType === 'movie' ? 'movie' : 'tv';

  if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
    return res.status(400).json({ error: 'Ungültige TMDB-Kennung.' });
  }

  const { region, language } = getRuntimeSettings(req.user);

  try {
    // Holt Metadaten und Verfügbarkeit, falls der Titel noch unbekannt ist.
    const show = await ensureShow(tmdbId, mediaType, { region, language });

    recommend(req.user.id, friendId, show.id, req.body?.message);

    res.json({ ok: true, title: show.title });
  } catch (error) {
    // "Nicht befreundet" ist eine Eingabefrage, kein Serverfehler.
    if (error.message.includes('Freunde')) {
      return res.status(403).json({ error: error.message });
    }
    next(error);
  }
});

export default router;
