/**
 * ---------------------------------------------------------------------------
 * src/routes/public.js – Was ohne Anmeldung erreichbar ist
 * ---------------------------------------------------------------------------
 * Eingehängt in src/server.js unter /api/public.
 *
 * Dies ist der EINZIGE Router ohne requireAuth. Alles hier ist für jeden
 * abrufbar, der die Adresse kennt – entsprechend sparsam sind die Antworten.
 *
 * Endpunkte:
 *   GET /api/public/collections/:token – eine geteilte Filmreihe
 *
 * Zum Datenschutz: Eine geteilte Reihe liefert die Titel, ihre Reihenfolge und
 * die Notizen. Sie verrät NICHT, wer sie erstellt hat, was diese Person gesehen
 * hat oder welche Abos sie besitzt. Wer einen Link per WhatsApp weitergibt,
 * teilt eine Liste – nicht seinen Sehverlauf.
 *
 * Verknüpfungen:
 *   - src/collections.js -> getSharedCollection()
 *   - public/js/views/shared.js -> die Ansicht dazu
 * ---------------------------------------------------------------------------
 */

import express from 'express';
import config from '../config.js';
import { getSharedCollection } from '../collections.js';
// Der Kalender zum Abonnieren - siehe src/calendar.js.
import { findUserByCalendarToken, collectEvents, buildIcs } from '../calendar.js';

const router = express.Router();

// Kein requireAuth – das ist hier der Sinn der Sache.

/**
 * GET /api/public/collections/:token
 *
 * Liefert eine geteilte Filmreihe. Der Token ist der einzige Nachweis; ist er
 * unbekannt oder wurde die Freigabe widerrufen, gibt es 404.
 *
 * Bewusst dieselbe Antwort für "gibt es nicht" und "nicht mehr geteilt": Aus
 * dem Unterschied ließe sich sonst ablesen, welche Token einmal gültig waren.
 */
router.get('/collections/:token', (req, res) => {
  const collection = getSharedCollection(req.params.token);

  if (!collection) {
    return res.status(404).json({
      error: 'Diese Liste gibt es nicht (mehr). Vielleicht wurde die Freigabe zurückgenommen.',
    });
  }

  // Suchmaschinen sollen geteilte Listen nicht indexieren. Wer den Link
  // weitergibt, meint einen bestimmten Empfänger – nicht die Öffentlichkeit.
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');

  res.json(collection);
});

/**
 * GET /api/public/calendar/:token.ics
 *
 * Der Kalender zum Abonnieren – für Apple Kalender, Google Kalender,
 * Thunderbird und alles andere, was iCalendar versteht.
 *
 * Warum ohne Anmeldung? Ein Kalenderprogramm meldet sich nicht an, es ruft in
 * festen Abständen eine Adresse ab. Der Nachweis steht deshalb im Token, und
 * der ist damit so schutzbedürftig wie ein Passwort. Er lässt sich in den
 * Einstellungen jederzeit neu erzeugen, wodurch alte Abonnements ins Leere
 * laufen.
 *
 * Der Token steht bewusst im PFAD und nicht als Query-Parameter: Manche
 * Kalenderprogramme schneiden beim Abonnieren alles nach dem "?" ab.
 */
router.get('/calendar/:token.ics', (req, res) => {
  // Express legt den Wert unter dem Namen ohne Endung ab.
  const token = req.params.token;

  const user = findUserByCalendarToken(token);

  if (!user) {
    // Text statt JSON: Hier landet ein Kalenderprogramm, kein Browser.
    return res.status(404).type('text/plain').send('Dieser Kalender existiert nicht (mehr).');
  }

  const region = String(user.region || 'DE').toUpperCase();
  const events = collectEvents(user.id, region);

  const name = `Streamo – ${user.display_name || user.username}`;

  // Die Adresse, unter der Streamo von außen erreichbar ist. Hinter einem
  // Proxy weiß das nur die Anfrage selbst; ohne TRUST_PROXY dürfen die
  // Weiterleitungs-Kopfzeilen nicht geglaubt werden, weil sie jeder setzen kann.
  const forwardedProto = config.trustProxy ? req.headers['x-forwarded-proto'] : null;
  const protocol = String(forwardedProto || req.protocol || 'http').split(',')[0].trim();

  const forwardedHost = config.trustProxy ? req.headers['x-forwarded-host'] : null;
  const host = String(forwardedHost || req.headers.host || '').split(',')[0].trim();

  const ics = buildIcs(events, {
    name,
    baseUrl: `${protocol}://${host}`,
    // Die Sprache der Oberfläche des Kontos (Migration 14); ohne Angabe Deutsch.
    lang: user.ui_language || 'de',
  });

  res.setHeader('X-Robots-Tag', 'noindex, nofollow');

  // Der Medientyp entscheidet, ob ein Kalenderprogramm die Datei annimmt.
  res.type('text/calendar; charset=utf-8');

  // Nicht zwischenspeichern: Der Kalender soll bei jedem Abruf den aktuellen
  // Stand liefern, sonst hängt er tagelang hinterher.
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');

  res.send(ics);
});

export default router;
