/**
 * ---------------------------------------------------------------------------
 * src/routes/calendar.js – Der Kalender in der Oberfläche
 * ---------------------------------------------------------------------------
 * Eingehängt in src/server.js unter /api/calendar.
 *
 * Endpunkte:
 *   GET  /api/calendar        – die Termine und die Abonnement-Adresse
 *   POST /api/calendar/reset  – neue Adresse erzeugen, alte entwerten
 *
 * Der Feed selbst liegt bewusst woanders: in src/routes/public.js, denn ein
 * Kalenderprogramm meldet sich nicht an. Hier geht es nur um die Anzeige im
 * Browser und um die Verwaltung der Adresse.
 *
 * Verknüpfungen:
 *   - src/calendar.js -> sammelt die Termine und verwaltet den Token
 *   - public/js/views/calendar.js -> der Reiter dazu
 * ---------------------------------------------------------------------------
 */

import express from 'express';
import config from '../config.js';
import { requireAuth } from '../auth.js';
import { getRuntimeSettings } from '../tmdb.js';
import { collectEvents, getCalendarToken, resetCalendarToken } from '../calendar.js';

const router = express.Router();
router.use(requireAuth);

/**
 * Baut die vollständige Abonnement-Adresse.
 *
 * Sie muss von außen erreichbar sein – deshalb kommt sie aus der Anfrage und
 * nicht aus der Konfiguration. Hinter einem Reverse Proxy weiß Streamo selbst
 * nicht, unter welchem Namen es angesprochen wird; ohne TRUST_PROXY dürfen die
 * Weiterleitungs-Kopfzeilen aber nicht geglaubt werden, weil sie jeder setzen
 * kann.
 *
 * @param {import('express').Request} req
 * @param {string} token
 * @returns {string}
 */
function buildFeedUrl(req, token) {
  const forwardedProto = config.trustProxy ? req.headers['x-forwarded-proto'] : null;
  const protocol = String(forwardedProto || req.protocol || 'http').split(',')[0].trim();

  const forwardedHost = config.trustProxy ? req.headers['x-forwarded-host'] : null;
  const host = String(forwardedHost || req.headers.host || '').split(',')[0].trim();

  return `${protocol}://${host}/api/public/calendar/${token}.ics`;
}

/**
 * GET /api/calendar
 *
 * Die Termine der nächsten Zeit plus die Adresse zum Abonnieren.
 *
 * Der Token wird dabei erzeugt, falls es noch keinen gibt. Das ist der
 * pragmatische Weg: Wer diesen Reiter öffnet, will den Kalender – und ein
 * Token, der nie irgendwo steht, schützt niemanden.
 */
router.get('/', (req, res) => {
  const { region } = getRuntimeSettings(req.user);

  const token = getCalendarToken(req.user.id);
  const url = buildFeedUrl(req, token);

  res.json({
    events: collectEvents(req.user.id, region),

    subscription: {
      // Zum Anklicken im Browser und zum Kopieren.
      url,
      // webcal:// ist derselbe Feed, aber mit einem Schema, das Apple
      // Kalender und Outlook direkt als Abonnement öffnen – ein Klick statt
      // "Kalender -> Ablage -> Neues Kalenderabonnement -> Adresse einfügen".
      webcal: url.replace(/^https?:/, 'webcal:'),
    },

    region,
  });
});

/**
 * POST /api/calendar/reset
 *
 * Erzeugt eine neue Adresse. Alle bestehenden Abonnements laufen danach ins
 * Leere – gedacht für den Fall, dass die Adresse versehentlich weitergegeben
 * wurde. Sie ist so schutzbedürftig wie ein Passwort: Wer sie hat, sieht, was
 * man sich vorgenommen hat.
 */
router.post('/reset', (req, res) => {
  const token = resetCalendarToken(req.user.id);
  const url = buildFeedUrl(req, token);

  res.json({
    ok: true,
    subscription: { url, webcal: url.replace(/^https?:/, 'webcal:') },
  });
});

export default router;
