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
  parseCookies,
  requireAuth,
  setEmail,
  hasPassword,
  // Entscheidet, ob eine Einladung noetig ist - Datenbank sticht .env.
  isRegistrationOpen,
} from '../auth.js';

// Die Passkey-Logik (WebAuthn) steckt vollständig in src/passkeys.js – hier
// werden nur die HTTP-Endpunkte darum herum gebaut.
import {
  FLOW_COOKIE,
  getWebAuthnContext,
  createRegistrationOptions,
  verifyRegistration,
  createAuthenticationOptions,
  verifyAuthentication,
  listCredentials,
  renameCredential,
  deleteCredential,
  countCredentials,
} from '../passkeys.js';

// Einladungen: der Weg, jemanden ohne eigenen TMDB-Zugang mitmachen zu lassen.
import { checkInvite, consumeInvite } from '../invites.js';

// Zwei-Faktor-Anmeldung. Die Rechnung dahinter steht in src/totp.js, die
// Verwaltung (Ersatzcodes, halbfertige Anmeldungen) in src/twofactor.js.
import {
  requiresTwoFactor,
  createPendingLogin,
  completePendingLogin,
  getTwoFactorState,
  beginTwoFactorSetup,
  enableTwoFactor,
  disableTwoFactor,
  replaceBackupCodes,
} from '../twofactor.js';

import { run, get } from '../db.js';

// Bremse gegen Durchprobieren. Haengt gezielt an den Endpunkten, an denen
// Geheimnisse geprueft werden - siehe src/ratelimit.js.
import { limitFailures } from '../ratelimit.js';

/**
 * Die Bremse fuer die Anmeldung.
 *
 * Zehn Fehlversuche je Viertelstunde und Absender. Grosszuegig genug, dass
 * niemand mit einem vergessenen Passwort davon merkt, und eng genug, dass
 * Durchprobieren sinnlos wird: Bei zehn Versuchen pro Viertelstunde dauert
 * ein Woerterbuchangriff Jahre.
 *
 * Erfolgreiche Anmeldungen setzen den Zaehler zurueck.
 */
const loginLimit = limitFailures({
  name: 'login',
  max: 10,
  windowMs: 15 * 60_000,
  message: 'Zu viele Anmeldeversuche. Bitte warte einen Moment.',
});

/**
 * Die Bremse fuer den zweiten Faktor.
 *
 * Enger als bei der Anmeldung: Ein sechsstelliger Code hat nur eine Million
 * Moeglichkeiten. src/twofactor.js begrenzt zwar schon die Versuche je
 * angefangener Anmeldung, aber man kann beliebig viele davon beginnen.
 */
const codeLimit = limitFailures({
  name: 'login2fa',
  max: 10,
  windowMs: 15 * 60_000,
  message: 'Zu viele Code-Versuche. Bitte warte einen Moment.',
});

/**
 * Die Bremse fuers Anlegen von Konten.
 *
 * Schuetzt zwei Dinge: das Durchprobieren von Einladungscodes und, bei
 * offener Registrierung, das massenhafte Anlegen von Konten.
 */
const registerLimit = limitFailures({
  name: 'register',
  max: 10,
  windowMs: 60 * 60_000,
  message: 'Zu viele Versuche. Bitte warte eine Weile.',
});

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

  // Können unter der aktuellen Adresse überhaupt Passkeys verwendet werden?
  // Das Frontend blendet den Knopf danach ein oder aus.
  const webauthn = getWebAuthnContext(req);

  res.json({
    passkeys: {
      available: webauthn.available,
      reason: webauthn.reason,
    },
    // Noch kein Benutzer angelegt = frische Installation.
    needsSetup: userCount === 0,
    // Ist ein TMDB-Key hinterlegt? Ohne ihn funktioniert Suche und
    // Verfügbarkeit nicht; das Frontend zeigt dann einen Hinweisbanner.
    hasApiKey: tmdb.hasApiKey(),
    // Dürfen sich weitere Personen registrieren?
    allowRegistration: isRegistrationOpen(),
    // Zustand des zweiten Faktors – nur für angemeldete Konten. Die
    // Einstellungsseite zeigt danach "eingeschaltet" oder "einrichten".
    twoFactor: req.user ? getTwoFactorState(req.user.id) : null,
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

  const { username, password, email, displayName, apiKey, region, language } = req.body ?? {};

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
    // Die E-Mail ist optional und dient nur als zweiter Anmeldename.
    const user = await createUser({ username, password, email, displayName, isAdmin: true });

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
router.post('/login', loginLimit, async (req, res) => {
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

  // ------------------------------------------------------------------------
  // Zweiter Faktor
  // ------------------------------------------------------------------------
  // Ist er eingeschaltet, entsteht hier bewusst noch KEINE Sitzung. Sonst
  // wäre die Anmeldung bereits gültig und der Code nur noch Zierde: Wer das
  // Passwort hat, käme mit einer abgefangenen Sitzungskennung daran vorbei.
  //
  // Stattdessen gibt es einen kurzlebigen Zwischen-Token, der nichts weiter
  // bedeutet als "diese Person kennt das Passwort". Erst der zweite Aufruf
  // auf /login/2fa macht daraus eine Sitzung.
  if (requiresTwoFactor(user.id)) {
    return res.json({
      ok: true,
      needsTwoFactor: true,
      pendingToken: createPendingLogin(user.id),
    });
  }

  const token = createSession(user.id, {
    userAgent: req.headers['user-agent'],
    ip: clientIp(req),
  });
  setSessionCookie(res, token);

  res.json({ ok: true, user: getUserById(user.id) });
});

/**
 * POST /api/auth/login/2fa
 *
 * Der zweite Schritt einer Anmeldung mit zweitem Faktor.
 * Body: { pendingToken, code }
 *
 * Angenommen werden der sechsstellige Code aus der Authenticator-App und die
 * Ersatzcodes. Ein Ersatzcode wird dabei verbraucht; die Antwort sagt das
 * ausdrücklich, damit die Oberfläche darauf hinweisen kann, wie viele noch
 * übrig sind.
 */
router.post('/login/2fa', codeLimit, (req, res) => {
  const { pendingToken, code } = req.body ?? {};

  const result = completePendingLogin(pendingToken, code);

  if (!result.ok) {
    return res.status(401).json({ error: result.error, code: result.code });
  }

  const token = createSession(result.userId, {
    userAgent: req.headers['user-agent'],
    ip: clientIp(req),
  });
  setSessionCookie(res, token);

  res.json({
    ok: true,
    user: getUserById(result.userId),
    // Damit die Oberfläche warnen kann: "Du hast einen Ersatzcode benutzt."
    usedBackupCode: Boolean(result.usedBackupCode),
    backupCodesLeft: getTwoFactorState(result.userId).backupCodesLeft,
  });
});

// ==========================================================================
// Zwei-Faktor-Anmeldung verwalten
// ==========================================================================
// Alle folgenden Endpunkte setzen eine bestehende Anmeldung voraus: Man
// richtet den zweiten Faktor für das eigene Konto ein, während man
// angemeldet ist.

/**
 * GET /api/auth/2fa
 * Zustand für die Einstellungsseite.
 */
router.get('/2fa', requireAuth, (req, res) => {
  res.json(getTwoFactorState(req.user.id));
});

/**
 * POST /api/auth/2fa/setup
 *
 * Beginnt die Einrichtung und gibt das Geheimnis EINMALIG heraus – als
 * otpauth-Adresse für die App und als abtippbare Zeichenfolge.
 *
 * Eingeschaltet ist danach noch nichts: Das geschieht erst über
 * /2fa/enable, nachdem ein gültiger Code bewiesen hat, dass die App das
 * Geheimnis wirklich hat. Ohne diesen Zwischenschritt könnte man sich beim
 * Übertragen vertun und wäre anschließend ausgesperrt.
 */
router.post('/2fa/setup', requireAuth, (req, res) => {
  try {
    res.json(beginTwoFactorSetup(req.user.id, req.user.username));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * POST /api/auth/2fa/enable
 * Body: { code }
 *
 * Schaltet ein und liefert die Ersatzcodes zurück – genau dieses eine Mal.
 * Danach liegen nur noch ihre Prüfsummen in der Datenbank; niemand kann sie
 * erneut anzeigen, auch der Betreiber nicht.
 */
router.post('/2fa/enable', requireAuth, (req, res) => {
  const result = enableTwoFactor(req.user.id, req.body?.code);

  if (!result.ok) return res.status(400).json({ error: result.error });

  res.json({ ok: true, backupCodes: result.backupCodes });
});

/**
 * POST /api/auth/2fa/disable
 * Body: { password }
 *
 * Ausschalten verlangt das Passwort. Der Grund: Wer sich an einem offen
 * stehenden Rechner zu schaffen macht, soll den Schutz nicht mit zwei Klicks
 * abräumen können.
 */
router.post('/2fa/disable', requireAuth, async (req, res) => {
  const stored = get('SELECT password_hash FROM users WHERE id = ?', req.user.id);

  // Konten, die ausschließlich über Passkeys angemeldet werden, haben keinen
  // Hash. Dort gibt es kein Passwort abzufragen.
  if (stored?.password_hash) {
    const ok = await verifyPassword(String(req.body?.password ?? ''), stored.password_hash);

    if (!ok) {
      return res.status(401).json({ error: 'Das Passwort stimmt nicht.' });
    }
  }

  disableTwoFactor(req.user.id);

  res.json({ ok: true });
});

/**
 * POST /api/auth/2fa/backup-codes
 * Body: { password }
 *
 * Erzeugt einen frischen Satz Ersatzcodes; die alten verlieren dabei ihre
 * Gültigkeit. Gedacht für den Fall, dass der Zettel verloren gegangen ist
 * oder die Codes zur Neige gehen.
 */
router.post('/2fa/backup-codes', requireAuth, async (req, res) => {
  if (!getTwoFactorState(req.user.id).enabled) {
    return res.status(400).json({ error: 'Der zweite Faktor ist nicht eingeschaltet.' });
  }

  const stored = get('SELECT password_hash FROM users WHERE id = ?', req.user.id);

  if (stored?.password_hash) {
    const ok = await verifyPassword(String(req.body?.password ?? ''), stored.password_hash);

    if (!ok) {
      return res.status(401).json({ error: 'Das Passwort stimmt nicht.' });
    }
  }

  res.json({ ok: true, backupCodes: replaceBackupCodes(req.user.id) });
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
router.post('/register', registerLimit, async (req, res) => {
  // Die E-Mail ist freiwillig und dient nur als zweiter Anmeldename – Streamo
  // verschickt keine Post und braucht keinen Mailserver. Sie hier
  // entgegenzunehmen ist wichtig, weil die Anmeldemaske Benutzername ODER
  // E-Mail akzeptiert: Wer sich mit einer E-Mail anmelden können will, muss
  // sie schon beim Anlegen des Kontos angeben dürfen.
  const { username, password, email, displayName, invite } = req.body ?? {};

  // Zwei Wege hinein: die offene Registrierung (falls freigeschaltet) oder
  // eine gültige Einladung. Die Einladung ist der übliche Fall – sie erlaubt
  // gezielt einer Person den Zutritt, ohne die Tür für alle zu öffnen.
  let inviteToken = null;

  if (invite) {
    const check = checkInvite(invite);

    if (!check.valid) {
      return res.status(403).json({ error: check.reason, code: 'invalid_invite' });
    }

    inviteToken = invite;
  } else if (!isRegistrationOpen()) {
    return res.status(403).json({
      error:
        'Für ein Konto auf dieser Instanz brauchst du eine Einladung. Frag die Person, die Streamo betreibt.',
      code: 'invite_required',
    });
  }

  try {
    const user = await createUser({ username, password, email, displayName, isAdmin: false });

    // Erst nach dem erfolgreichen Anlegen einlösen – scheitert die
    // Registrierung an einem belegten Namen, soll die Einladung nicht
    // verbraucht sein.
    if (inviteToken) consumeInvite(inviteToken);

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

// ===========================================================================
// Passkeys (WebAuthn)
// ===========================================================================
// Ablauf in beiden Fällen – Anlegen wie Anmelden – immer zwei Schritte:
//
//   1. "options": Der Server stellt eine Zufallsaufgabe und merkt sie sich.
//      Der Client bekommt einen Zuordnungsschlüssel als kurzlebiges Cookie.
//   2. "verify": Das Gerät hat die Aufgabe signiert, der Server prüft sie.
//
// Die Zwischenspeicherung erklärt src/passkeys.js ausführlich.

/**
 * Setzt das kurzlebige Cookie, das einen laufenden Passkey-Vorgang zuordnet.
 *
 * Max-Age=120: Der Vorgang dauert Sekunden. Ein kurzlebiges Cookie kann nicht
 * später missbraucht werden, und die Challenge dahinter verfällt ohnehin nach
 * einer Minute.
 *
 * @param {import('express').Response} res
 * @param {string} flowId
 */
function setFlowCookie(res, flowId) {
  const parts = [
    `${FLOW_COOKIE}=${flowId}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=120',
  ];
  if (config.trustProxy) parts.push('Secure');

  // append statt setHeader: Bei der Anmeldung wird gleich danach auch das
  // Session-Cookie gesetzt – setHeader würde es überschreiben.
  res.append('Set-Cookie', parts.join('; '));
}

/**
 * GET /api/auth/passkey/available
 *
 * Sagt dem Frontend, ob Passkeys unter der aktuellen Adresse funktionieren.
 * Ist das nicht der Fall (kein HTTPS, IP-Adresse statt Hostname), blendet das
 * Frontend den Passkey-Knopf aus und nennt auf der Einstellungsseite den Grund –
 * das ist deutlich freundlicher als ein Knopf, der beim Klick scheitert.
 */
router.get('/passkey/available', (req, res) => {
  const context = getWebAuthnContext(req);

  res.json({
    available: context.available,
    reason: context.reason,
    // Alles Weitere dient der Fehlersuche auf der Einstellungsseite: Man sieht
    // dort, welche Adresse Streamo tatsächlich wahrnimmt. Genau daran
    // scheitert es hinter einem falsch eingestellten Reverse Proxy.
    rpId: context.rpID,
    origin: context.origin,
    detectedHost: context.detectedHost,
    detectedProtocol: context.detectedProtocol,
    behindProxy: context.behindProxy,
  });
});

/**
 * POST /api/auth/passkey/register/options
 * Beginnt das Anlegen eines neuen Passkeys. Nur für angemeldete Benutzer.
 */
router.post('/passkey/register/options', requireAuth, async (req, res, next) => {
  const context = getWebAuthnContext(req);

  if (!context.available) {
    return res.status(400).json({ error: context.reason, code: 'webauthn_unavailable' });
  }

  try {
    const { options, flowId } = await createRegistrationOptions(req.user, req);
    setFlowCookie(res, flowId);
    res.json(options);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/auth/passkey/register/verify
 * Schließt das Anlegen ab. Body: { response, name }
 */
router.post('/passkey/register/verify', requireAuth, async (req, res) => {
  const cookies = parseCookies(req.headers.cookie);

  try {
    const credential = await verifyRegistration(
      req.user,
      req.body?.response,
      cookies[FLOW_COOKIE],
      req,
      req.body?.name,
    );

    res.json({
      ok: true,
      credential: {
        id: credential.id,
        name: credential.name,
        created_at: credential.created_at,
      },
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * POST /api/auth/passkey/login/options
 * Beginnt eine Anmeldung. Body: { username } – optional.
 *
 * Ohne Benutzernamen zeigt der Browser alle für diese Domain gespeicherten
 * Passkeys zur Auswahl. Das ist der übliche und bequemste Weg.
 */
router.post('/passkey/login/options', async (req, res, next) => {
  const context = getWebAuthnContext(req);

  if (!context.available) {
    return res.status(400).json({ error: context.reason, code: 'webauthn_unavailable' });
  }

  try {
    const { options, flowId } = await createAuthenticationOptions(req, req.body?.username);
    setFlowCookie(res, flowId);
    res.json(options);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/auth/passkey/login/verify
 * Schließt die Anmeldung ab und setzt das Session-Cookie. Body: { response }
 */
router.post('/passkey/login/verify', async (req, res) => {
  const cookies = parseCookies(req.headers.cookie);

  try {
    const user = await verifyAuthentication(req.body?.response, cookies[FLOW_COOKIE], req);

    pruneSessions();

    const token = createSession(user.id, {
      userAgent: req.headers['user-agent'],
      ip: clientIp(req),
    });
    setSessionCookie(res, token);

    res.json({ ok: true, user: getUserById(user.id) });
  } catch (error) {
    res.status(401).json({ error: error.message });
  }
});

/**
 * GET /api/auth/passkeys
 * Die eigenen Passkeys für die Einstellungsseite.
 */
router.get('/passkeys', requireAuth, (req, res) => {
  const full = getUserByUsername(req.user.username);

  res.json({
    passkeys: listCredentials(req.user.id),
    // Damit das Frontend warnen kann, bevor jemand seinen letzten Anmeldeweg
    // entfernt.
    hasPassword: hasPassword(full),
  });
});

/**
 * PATCH /api/auth/passkeys/:id
 * Benennt einen Passkey um. Body: { name }
 */
router.patch('/passkeys/:id', requireAuth, (req, res) => {
  const ok = renameCredential(req.user.id, req.params.id, req.body?.name);

  if (!ok) return res.status(404).json({ error: 'Passkey nicht gefunden.' });
  res.json({ ok: true });
});

/**
 * DELETE /api/auth/passkeys/:id
 * Entfernt einen Passkey.
 *
 * Der letzte Anmeldeweg darf nicht verschwinden: Wer kein Passwort gesetzt hat
 * und nur noch einen Passkey besitzt, würde sich sonst dauerhaft aussperren.
 */
router.delete('/passkeys/:id', requireAuth, (req, res) => {
  const full = getUserByUsername(req.user.username);

  if (!hasPassword(full) && countCredentials(req.user.id) <= 1) {
    return res.status(400).json({
      error:
        'Das ist dein letzter Anmeldeweg. Lege vorher ein Passwort oder einen weiteren Passkey an.',
      code: 'last_credential',
    });
  }

  const ok = deleteCredential(req.user.id, req.params.id);
  if (!ok) return res.status(404).json({ error: 'Passkey nicht gefunden.' });

  res.json({ ok: true });
});

/**
 * PUT /api/auth/email
 * Setzt oder entfernt die eigene E-Mail-Adresse. Body: { email }
 *
 * Sie dient nur als zweiter Anmeldename. Streamo verschickt keine E-Mails und
 * braucht dafür auch keinen Mailserver.
 */
router.put('/email', requireAuth, (req, res) => {
  try {
    setEmail(req.user.id, req.body?.email);
    res.json({ ok: true, user: getUserById(req.user.id) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * DELETE /api/auth/password
 * Entfernt das Passwort – ab dann geht die Anmeldung nur noch per Passkey.
 * Body: { currentPassword }
 *
 * Erlaubt nur, wenn mindestens ein Passkey vorhanden ist. Sonst wäre das Konto
 * nicht mehr erreichbar.
 */
router.delete('/password', requireAuth, async (req, res) => {
  const full = getUserByUsername(req.user.username);

  if (countCredentials(req.user.id) === 0) {
    return res.status(400).json({
      error: 'Lege zuerst einen Passkey an, sonst kommst du nicht mehr in dein Konto.',
      code: 'no_passkey',
    });
  }

  // Auch zum Entfernen ist das aktuelle Passwort nötig – sonst könnte jemand
  // mit einer übernommenen Sitzung den Passwortweg still abschalten.
  if (hasPassword(full)) {
    const ok = await verifyPassword(String(req.body?.currentPassword ?? ''), full.password_hash);
    if (!ok) return res.status(403).json({ error: 'Aktuelles Passwort ist falsch.' });
  }

  // Leerer String = "kein Passwort gesetzt", siehe hasPassword() in src/auth.js.
  run("UPDATE users SET password_hash = '' WHERE id = ?", req.user.id);

  res.json({ ok: true });
});

export default router;
