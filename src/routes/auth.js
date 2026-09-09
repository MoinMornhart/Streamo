/**
 * ---------------------------------------------------------------------------
 * src/routes/auth.js – Registrierung, Anmeldung, Ersteinrichtung
 * ---------------------------------------------------------------------------
 * Eingehängt in src/server.js unter dem Präfix /api/auth.
 *
 * Endpunkte:
 *   GET  /api/auth/status    – Wer bin ich? Muss noch eingerichtet werden?
 *   POST /api/auth/setup     – Ersteinrichtung: erster Benutzer + TMDB-Key
 *   POST /api/auth/login     – Anmelden, setzt das Session-Cookie
 *   POST /api/auth/logout    – Abmelden, löscht Session und Cookie
 *   POST /api/auth/register  – Weitere Benutzer (nur wenn freigeschaltet)
 *   POST /api/auth/password  – Eigenes Passwort ändern
 *
 * Verknüpfungen:
 *   - src/auth.js      -> Passwort-Hashing, Sessions, Cookies
 *   - src/db.js        -> setSetting() für den TMDB-Key aus dem Setup
 *   - src/tmdb.js      -> testApiKey(), damit das Setup den Key sofort prüft
 *   - public/js/views/login.js -> das Frontend zu diesen Endpunkten
 * ---------------------------------------------------------------------------
 */

import express from 'express';
import config from '../config.js';
import { getSetting, setSetting } from '../db.js';
import * as tmdb from '../tmdb.js';
import {
  createUser,
  countUsers,
  getUserByUsername,
  getUserById,
  verifyPassword,
  hashPassword,
  createSession,
  destroySession,
  destroyAllSessions,
  pruneSessions,
  setSessionCookie,
  clearSessionCookie,
  requireAuth,
} from '../auth.js';
import { run } from '../db.js';

const router = express.Router();

/**
 * Ermittelt die IP des Aufrufers für das Session-Protokoll.
 * Hinter einem Reverse Proxy steht die echte IP in X-Forwarded-For; ohne
 * TRUST_PROXY darf dieser Header nicht geglaubt werden, weil ihn jeder Client
 * frei setzen kann.
 * @param {import('express').Request} req
 * @returns {string|null}
 */
function clientIp(req) {
  if (config.trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    // Der Header kann eine Kette sein ("client, proxy1, proxy2") – der erste
    // Eintrag ist der ursprüngliche Client.
    if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress ?? null;
}

/**
 * GET /api/auth/status
 *
 * Der erste Aufruf des Frontends. Entscheidet, welcher Bildschirm erscheint:
 *   needsSetup === true  -> Einrichtungsassistent
 *   user === null        -> Login-Maske
 *   sonst                -> die App
 */
router.get('/status', (req, res) => {
  const userCount = countUsers();

  res.json({
    // Noch kein Benutzer angelegt = frische Installation.
    needsSetup: userCount === 0,
    // Ist ein TMDB-Key hinterlegt? Ohne ihn funktioniert Suche und
    // Verfügbarkeit nicht; das Frontend zeigt dann einen Hinweisbanner.
    hasApiKey: tmdb.hasApiKey(),
    // Dürfen sich weitere Personen registrieren?
    allowRegistration: config.allowRegistration,
    // req.user kommt aus der globalen Middleware attachUser (src/auth.js).
    user: req.user,
    version: config.version,
    // Vorbelegung für die Auswahlfelder im Setup.
    defaults: {
      region: getSetting('region', config.region),
      language: getSetting('language', config.language),
    },
  });
});

/**
 * POST /api/auth/setup
 *
 * Die Ersteinrichtung. Läuft nur, solange es KEINEN Benutzer gibt – danach
 * ist der Endpunkt dauerhaft gesperrt, damit niemand über das offene Netz
 * einen zweiten Admin nachschieben kann.
 *
 * Body: { username, password, displayName?, apiKey?, region?, language? }
 */
router.post('/setup', async (req, res) => {
  if (countUsers() > 0) {
    return res
      .status(409)
      .json({ error: 'Streamo ist bereits eingerichtet.', code: 'already_setup' });
  }

  const { username, password, displayName, apiKey, region, language } = req.body ?? {};

  try {
    // Falls ein API-Key mitgeschickt wurde: erst prüfen, dann speichern.
    // So merkt der Benutzer einen Tippfehler sofort und nicht erst später.
    if (apiKey) {
      await tmdb.testApiKey(String(apiKey).trim());
      setSetting('tmdb_api_key', String(apiKey).trim());
    }

    if (region) setSetting('region', String(region).toUpperCase());
    if (language) setSetting('language', String(language));

    // Der allererste Benutzer bekommt automatisch Adminrechte.
    const user = await createUser({ username, password, displayName, isAdmin: true });

    // Region/Sprache des Setups auch am Benutzer hinterlegen.
    run(
      'UPDATE users SET region = ?, language = ? WHERE id = ?',
      String(region || config.region).toUpperCase(),
      String(language || config.language),
      user.id,
    );

    // Merker, dass der Assistent durch ist (nur informativ).
    setSetting('setup_complete', '1');

    // Direkt anmelden – der Benutzer soll nicht sofort noch ein Login sehen.
    const token = createSession(user.id, {
      userAgent: req.headers['user-agent'],
      ip: clientIp(req),
    });
    setSessionCookie(res, token);

    res.json({ ok: true, user: getUserById(user.id) });
  } catch (error) {
    // TmdbError trägt einen eigenen Status (z. B. 401 bei falschem Key).
    res.status(error.status || 400).json({ error: error.message });
  }
});

/**
 * POST /api/auth/login
 * Body: { username, password }
 */
router.post('/login', async (req, res) => {
  const { username, password } = req.body ?? {};

  const user = getUserByUsername(username);

  // Wichtig: Bei unbekanntem Benutzer wird trotzdem eine Passwortprüfung
  // gegen einen Dummy-Hash ausgeführt. Sonst wäre an der Antwortzeit
  // erkennbar, welche Benutzernamen existieren.
  const stored = user?.password_hash ?? 'aa:' + '0'.repeat(128);
  const ok = await verifyPassword(String(password ?? ''), stored);

  if (!user || !ok) {
    // Bewusst dieselbe Meldung für "Benutzer unbekannt" und "Passwort falsch".
    return res
      .status(401)
      .json({ error: 'Benutzername oder Passwort ist falsch.', code: 'bad_credentials' });
  }

  // Gute Gelegenheit, alte Sessions loszuwerden.
  pruneSessions();

  const token = createSession(user.id, {
    userAgent: req.headers['user-agent'],
    ip: clientIp(req),
  });
  setSessionCookie(res, token);

  res.json({ ok: true, user: getUserById(user.id) });
});

/**
 * POST /api/auth/logout
 * Löscht die aktuelle Session serverseitig UND das Cookie im Browser.
 */
router.post('/logout', (req, res) => {
  destroySession(req.sessionToken);
  clearSessionCookie(res);
  res.json({ ok: true });
});

/**
 * POST /api/auth/register
 * Nur erreichbar, wenn ALLOW_REGISTRATION=true in der .env steht.
 * Body: { username, password, displayName? }
 */
router.post('/register', async (req, res) => {
  if (!config.allowRegistration) {
    return res.status(403).json({
      error: 'Registrierung ist auf dieser Instanz deaktiviert.',
      code: 'registration_disabled',
    });
  }

  const { username, password, displayName } = req.body ?? {};

  try {
    const user = await createUser({ username, password, displayName, isAdmin: false });

    const token = createSession(user.id, {
      userAgent: req.headers['user-agent'],
      ip: clientIp(req),
    });
    setSessionCookie(res, token);

    res.json({ ok: true, user });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * POST /api/auth/password
 * Ändert das eigene Passwort.
 * Body: { currentPassword, newPassword }
 *
 * Nach der Änderung werden ALLE Sessions verworfen und eine neue erzeugt:
 * Wer das Passwort wechselt, will typischerweise auch fremde Anmeldungen
 * loswerden.
 */
router.post('/password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body ?? {};

  const full = getUserByUsername(req.user.username);
  const ok = await verifyPassword(String(currentPassword ?? ''), full.password_hash);

  if (!ok) {
    return res.status(403).json({ error: 'Aktuelles Passwort ist falsch.' });
  }
  if (String(newPassword ?? '').length < 8) {
    return res.status(400).json({ error: 'Neues Passwort muss mindestens 8 Zeichen haben.' });
  }

  run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(newPassword), req.user.id);

  destroyAllSessions(req.user.id);

  const token = createSession(req.user.id, {
    userAgent: req.headers['user-agent'],
    ip: clientIp(req),
  });
  setSessionCookie(res, token);

  res.json({ ok: true });
});

export default router;
