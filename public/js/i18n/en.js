/**
 * ---------------------------------------------------------------------------
 * public/js/i18n/en.js – Das englische Wörterbuch, zusammengeführt
 * ---------------------------------------------------------------------------
 * Das Wörterbuch ist nach Bereichen auf mehrere Dateien verteilt, damit man
 * einen Text schnell findet und Änderungen überschaubar bleiben:
 *
 *   en/basis.js          Navigation, Bausteine, Anmeldung, Kalender
 *   en/ansichten.js      Bibliothek, Detailseite, Reihen, Freunde, Start …
 *   en/einstellungen.js  die Einstellungsseite
 *   en/server.js         Meldungen und Texte, die der Server schickt
 *                        (Fehler, Erfolge, Kalendereinträge, Begründungen)
 *
 * Steht derselbe deutsche Text in zwei Teilen, gewinnt der spätere – das
 * sollte aber nicht vorkommen; tests/i18n.test.mjs prüft darauf.
 *
 * Verknüpfungen:
 *   - public/js/i18n.js -> lädt dieses Wörterbuch
 * ---------------------------------------------------------------------------
 */

import basis from './en/basis.js';
import ansichten from './en/ansichten.js';
import einstellungen from './en/einstellungen.js';
import server from './en/server.js';

/** Die Teile einzeln – für den Test auf doppelte Schlüssel. */
export const PARTS = { basis, ansichten, einstellungen, server };

export default { ...basis, ...ansichten, ...einstellungen, ...server };
