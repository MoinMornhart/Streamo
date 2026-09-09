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
import { getSharedCollection } from '../collections.js';

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

export default router;
