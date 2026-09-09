/**
 * ---------------------------------------------------------------------------
 * src/routes/invites.js – Einladungen verwalten
 * ---------------------------------------------------------------------------
 * Eingehängt in src/server.js unter /api/invites.
 *
 * Endpunkte:
 *   GET    /api/invites          – alle Einladungen (nur Admin)
 *   POST   /api/invites          – neue Einladung erzeugen (nur Admin)
 *   DELETE /api/invites/:token   – widerrufen (nur Admin)
 *   GET    /api/invites/check/:token – Gültigkeit prüfen (OHNE Anmeldung)
 *
 * Der letzte Endpunkt ist bewusst offen: Der Anmeldebildschirm muss schon
 * vor dem Ausfüllen wissen, ob die Einladung taugt – sonst füllt jemand ein
 * Formular aus und erfährt erst danach, dass der Link abgelaufen ist.
 *
 * Verknüpfungen:
 *   - src/invites.js -> die Logik
 *   - src/routes/auth.js -> die Registrierung, die eine Einladung einlöst
 *   - public/js/views/settings.js -> die Verwaltung
 * ---------------------------------------------------------------------------
 */

import express from 'express';
import config from '../config.js';
import { requireAdmin } from '../auth.js';
import { createInvite, listInvites, revokeInvite, checkInvite, pruneInvites } from '../invites.js';

const router = express.Router();

/**
 * Baut den vollständigen Einladungslink.
 *
 * Wie beim Teilen von Listen: Nur die Anfrage kennt die Adresse, unter der
 * Streamo von außen erreichbar ist. Ohne TRUST_PROXY werden die
 * Weiterleitungs-Kopfzeilen ignoriert, weil sie sich fälschen ließen.
 *
 * @param {import('express').Request} req
 * @param {string} token
 * @returns {string}
 */
function buildInviteUrl(req, token) {
  const forwardedProto = config.trustProxy ? req.headers['x-forwarded-proto'] : null;
  const protocol = String(forwardedProto || req.protocol || 'http').split(',')[0].trim();

  const forwardedHost = config.trustProxy ? req.headers['x-forwarded-host'] : null;
  const host = String(forwardedHost || req.headers.host || '').split(',')[0].trim();

  return `${protocol}://${host}/einladung/${token}`;
}

/**
 * GET /api/invites/check/:token
 *
 * Prüft eine Einladung – ohne Anmeldung, denn wer sie einlöst, hat ja noch
 * kein Konto. Zurück kommt nur, ob sie gilt und woran es sonst liegt; nie,
 * wer sie erstellt hat oder wie oft sie schon benutzt wurde.
 *
 * Steht VOR der Admin-Prüfung weiter unten.
 */
router.get('/check/:token', (req, res) => {
  const result = checkInvite(req.params.token);

  res.json({ valid: result.valid, reason: result.reason });
});

// Ab hier nur noch für Administratoren – Einladungen auszustellen ist die
// Entscheidung dessen, der die Instanz betreibt.
router.use(requireAdmin);

/**
 * GET /api/invites
 * Alle Einladungen mit ihrem Zustand.
 */
router.get('/', (req, res) => {
  res.json({
    invites: listInvites().map((invite) => ({
      ...invite,
      url: buildInviteUrl(req, invite.token),
    })),
  });
});

/**
 * POST /api/invites
 * Erzeugt eine Einladung. Body: { note?, uses?, days? }
 *
 * Vorgabe: einmal nutzbar, sieben Tage gültig – der häufigste Fall ist, einer
 * bestimmten Person einen Link zu schicken.
 */
router.post('/', (req, res) => {
  // Bei der Gelegenheit aufräumen, damit die Liste nicht zuwächst.
  pruneInvites();

  const invite = createInvite(req.user.id, {
    note: req.body?.note,
    // null bedeutet ausdrücklich "unbegrenzt" – deshalb die Unterscheidung
    // zwischen null und undefined.
    uses: req.body?.uses === null ? null : req.body?.uses,
    days: req.body?.days === null ? null : req.body?.days,
  });

  res.json({
    ok: true,
    token: invite.token,
    url: buildInviteUrl(req, invite.token),
    usesLeft: invite.uses_left,
    expiresAt: invite.expires_at,
  });
});

/**
 * DELETE /api/invites/:token
 * Widerruft eine Einladung. Der Link führt danach ins Leere.
 */
router.delete('/:token', (req, res) => {
  if (!revokeInvite(req.params.token)) {
    return res.status(404).json({ error: 'Diese Einladung gibt es nicht.' });
  }

  res.json({ ok: true });
});

export default router;
