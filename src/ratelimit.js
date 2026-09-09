/**
 * ---------------------------------------------------------------------------
 * src/ratelimit.js – Bremse gegen Durchprobieren
 * ---------------------------------------------------------------------------
 * Rolle im Gesamtsystem:
 *   Bis hierher konnte man Passwörter unbegrenzt oft raten. Das ist die
 *   klassische Lücke einer selbst gehosteten Anwendung im Internet: Die
 *   Anmeldung selbst ist korrekt gebaut – scrypt, zufälliges Salz, Vergleich
 *   in gleichbleibender Zeit –, aber gegen zehntausend Versuche pro Minute
 *   hilft das nur begrenzt.
 *
 *   scrypt bremst zwar von sich aus (jeder Versuch kostet Rechenzeit), doch
 *   genau das ist der zweite Grund für diese Datei: Ohne Begrenzung lässt
 *   sich der Server über die Anmeldung lahmlegen. Jeder Versuch belegt
 *   kurzzeitig Arbeitsspeicher und einen Kern; ein paar hundert gleichzeitige
 *   Anfragen genügen.
 *
 * Wie es funktioniert:
 *   Ein Zähler je Absender und Endpunkt, in einem gleitenden Zeitfenster. Wer
 *   zu oft danebenliegt, bekommt 429 und muss warten. Erfolgreiche Anmeldungen
 *   setzen den Zähler zurück – wer sein Passwort kennt, soll nie etwas davon
 *   merken.
 *
 * Bewusst im Arbeitsspeicher und nicht in der Datenbank:
 *   Es sind Sekundenwerte. Nach einem Neustart ist der Zähler leer – das ist
 *   hinnehmbar, denn ein Neustart dauert länger als das Zeitfenster. Dafür
 *   kostet es keinen Schreibzugriff je Anfrage.
 *
 * Verknüpfungen:
 *   - src/routes/auth.js -> Anmeldung, zweiter Faktor, Registrierung
 *   - src/server.js      -> nichts; die Bremse hängt gezielt an einzelnen
 *                           Endpunkten, nicht global
 * ---------------------------------------------------------------------------
 */

import config from './config.js';

/**
 * Die Zähler.
 *
 * Schlüssel: "endpunkt|absender". Wert: die Zeitpunkte der Fehlversuche im
 * aktuellen Fenster.
 *
 * @type {Map<string, number[]>}
 */
const buckets = new Map();

/**
 * Wann zuletzt aufgeräumt wurde.
 *
 * Aufgeräumt wird nebenbei bei jedem Aufruf, nicht über einen Zeitgeber: Ein
 * Zeitgeber hielte den Prozess wach, und die Map ist klein.
 */
let lastSweep = Date.now();

/**
 * Entfernt Einträge, deren Fenster abgelaufen ist.
 *
 * Ohne das wüchse die Map mit jeder neuen Absenderadresse – bei einer
 * Anwendung im offenen Netz ist das ein langsames Speicherleck.
 *
 * @param {number} windowMs
 */
function sweep(windowMs) {
  const now = Date.now();

  // Höchstens einmal pro Minute; öfter lohnt sich der Durchlauf nicht.
  if (now - lastSweep < 60_000) return;
  lastSweep = now;

  for (const [key, hits] of buckets) {
    const frisch = hits.filter((zeit) => now - zeit < windowMs);

    if (frisch.length === 0) buckets.delete(key);
    else buckets.set(key, frisch);
  }
}

/**
 * Ermittelt den Absender einer Anfrage.
 *
 * Hinter einem Reverse Proxy steht die echte Adresse in X-Forwarded-For. Ohne
 * TRUST_PROXY darf dieser Header NICHT geglaubt werden – sonst setzt jeder
 * Angreifer bei jedem Versuch eine andere Adresse und die Bremse greift nie.
 *
 * @param {import('express').Request} req
 * @returns {string}
 */
function absender(req) {
  if (config.trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];

    // Der Header kann eine Kette sein ("client, proxy1"); der erste Eintrag
    // ist der ursprüngliche Client.
    if (typeof forwarded === 'string' && forwarded.trim()) {
      return forwarded.split(',')[0].trim();
    }
  }

  return req.socket?.remoteAddress ?? 'unbekannt';
}

/**
 * Baut eine Middleware, die zu häufige Versuche abweist.
 *
 * Gezählt werden nur FEHLVERSUCHE: Die Middleware lässt die Anfrage
 * zunächst durch und sieht sich danach den Status an. Ein Tippfehler beim
 * Passwort zählt, eine erfolgreiche Anmeldung setzt den Zähler zurück.
 *
 * @param {object} options
 * @param {string} options.name  Kennung des Endpunkts, z. B. "login"
 * @param {number} options.max   Erlaubte Fehlversuche im Fenster
 * @param {number} options.windowMs Länge des Fensters in Millisekunden
 * @param {string} [options.message] Was der Absender zu lesen bekommt
 * @returns {import('express').RequestHandler}
 */
export function limitFailures({ name, max, windowMs, message }) {
  return (req, res, next) => {
    sweep(windowMs);

    const key = `${name}|${absender(req)}`;
    const now = Date.now();

    const hits = (buckets.get(key) ?? []).filter((zeit) => now - zeit < windowMs);

    if (hits.length >= max) {
      // Wie lange noch? Der älteste Versuch im Fenster bestimmt das.
      const frei = Math.ceil((windowMs - (now - hits[0])) / 1000);

      // Retry-After ist der vorgesehene Weg, das mitzuteilen – manche
      // Clients werten ihn aus, statt stur weiterzuprobieren.
      res.setHeader('Retry-After', String(frei));

      return res.status(429).json({
        error:
          message ??
          `Zu viele Versuche. Bitte warte ${frei} Sekunden.`,
        code: 'rate_limited',
        retryAfter: frei,
      });
    }

    // Die Antwort abwarten und erst dann entscheiden, ob dieser Versuch
    // zählt. res.on('finish') feuert, nachdem der Status feststeht.
    res.on('finish', () => {
      // 401 = falsche Anmeldedaten, 403 = abgelehnt, 400 = unbrauchbare
      // Eingabe. Alles davon ist ein Fehlversuch.
      if (res.statusCode === 401 || res.statusCode === 403 || res.statusCode === 400) {
        const aktuell = (buckets.get(key) ?? []).filter((zeit) => Date.now() - zeit < windowMs);
        aktuell.push(Date.now());
        buckets.set(key, aktuell);
        return;
      }

      // Erfolg: Zähler zurücksetzen. Wer sein Passwort kennt, soll von der
      // Bremse nie etwas merken – auch nicht nach ein paar Vertippern.
      if (res.statusCode < 400) buckets.delete(key);
    });

    next();
  };
}

/**
 * Leert alle Zähler. Nur für Tests.
 */
export function resetLimits() {
  buckets.clear();
}
