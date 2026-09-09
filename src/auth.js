/**
 * ---------------------------------------------------------------------------
 * src/auth.js – Passwörter, Sessions und Zugriffsschutz
 * ---------------------------------------------------------------------------
 * Rolle im Gesamtsystem:
 *   Streamo ist eine persönliche Datenbank – die Bibliothek, die Abos und der
 *   Sehfortschritt gehören genau einer Person. Diese Datei sorgt dafür, dass
 *   nur angemeldete Benutzer an ihre eigenen Daten kommen.
 *
 *   Bewusst OHNE externe Bibliotheken: Passwort-Hashing über das eingebaute
 *   `node:crypto` (scrypt), Sessions über einen Zufallstoken in einem
 *   HttpOnly-Cookie plus einer Zeile in der Tabelle `sessions`.
 *
 * Verknüpfungen zu anderen Dateien:
 *   - src/db.js            -> Tabellen `users` und `sessions`
 *   - src/config.js        -> sessionDays, trustProxy, allowRegistration
 *   - src/routes/auth.js   -> ruft createUser / verifyPassword / createSession
 *   - src/server.js        -> hängt attachUser als globale Middleware ein
 *   - alle anderen Routen  -> schützen sich mit requireAuth / requireAdmin
 * ---------------------------------------------------------------------------
 */

import crypto from 'node:crypto';
import config from './config.js';
import { get, run, all, getSetting } from './db.js';

// --------------------------------------------------------------------------
// Konstanten für das Passwort-Hashing.
// --------------------------------------------------------------------------

/** Name des Cookies, in dem der Session-Token steckt. */
export const SESSION_COOKIE = 'streamo_session';

/** Länge des Zufalls-Salts je Passwort in Bytes. */
const SALT_BYTES = 16;

/** Länge des abgeleiteten Schlüssels in Bytes (64 = 512 Bit). */
const KEY_BYTES = 64;

/**
 * scrypt-Kostenparameter. N=16384 ist die Node-Voreinstellung und braucht
 * ~16 MB Speicher pro Hash-Vorgang. Das bremst Brute-Force-Angriffe massiv
 * aus, kostet beim normalen Login aber nur wenige Dutzend Millisekunden.
 */
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/**
 * Hasht ein Passwort mit einem frischen Zufalls-Salt.
 *
 * Rückgabeformat: "salt:hash", beides hex-kodiert. Das Salt wird mitgespeichert,
 * weil es zum Prüfen wieder gebraucht wird – es ist kein Geheimnis, sondern
 * verhindert nur, dass zwei gleiche Passwörter denselben Hash ergeben und dass
 * vorberechnete Rainbow-Tables funktionieren.
 *
 * @param {string} password Klartext-Passwort
 * @returns {Promise<string>} Wert für users.password_hash
 */
export function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(SALT_BYTES);

    crypto.scrypt(password, salt, KEY_BYTES, SCRYPT_OPTIONS, (err, derivedKey) => {
      if (err) return reject(err);
      resolve(`${salt.toString('hex')}:${derivedKey.toString('hex')}`);
    });
  });
}

/**
 * Prüft ein Passwort gegen einen gespeicherten Hash.
 *
 * Der Vergleich läuft über crypto.timingSafeEqual, nicht über "===". Ein
 * normaler String-Vergleich bricht beim ersten unterschiedlichen Zeichen ab;
 * aus den minimal unterschiedlichen Antwortzeiten ließe sich der Hash Zeichen
 * für Zeichen erraten (Timing-Angriff).
 *
 * @param {string} password Eingegebenes Klartext-Passwort
 * @param {string} stored   Wert aus users.password_hash ("salt:hash")
 * @returns {Promise<boolean>}
 */
export function verifyPassword(password, stored) {
  return new Promise((resolve) => {
    // Defekte oder fehlende Hashes gelten als "passt nicht", statt zu werfen.
    if (typeof stored !== 'string' || !stored.includes(':')) return resolve(false);

    const [saltHex, keyHex] = stored.split(':');
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(keyHex, 'hex');

    // Länge vorab prüfen: timingSafeEqual wirft bei ungleich langen Puffern.
    if (expected.length !== KEY_BYTES) return resolve(false);

    crypto.scrypt(password, salt, KEY_BYTES, SCRYPT_OPTIONS, (err, derivedKey) => {
      if (err) return resolve(false);
      resolve(crypto.timingSafeEqual(expected, derivedKey));
    });
  });
}

// --------------------------------------------------------------------------
// Benutzerverwaltung
// --------------------------------------------------------------------------

/**
 * Legt einen neuen Benutzer an.
 *
 * @param {object} params
 * @param {string} params.username     Anmeldename (eindeutig, case-insensitiv)
 * @param {string} params.password     Klartext-Passwort, mind. 8 Zeichen
 * @param {string} [params.email]      Optionale E-Mail als zweiter Anmeldename
 * @param {string} [params.displayName] Anzeigename; Default = username
 * @param {boolean} [params.isAdmin]   Adminrechte
 * @returns {Promise<object>} der angelegte Benutzer (ohne password_hash)
 * @throws {Error} bei zu kurzem Passwort oder belegtem Namen
 */
export async function createUser({
  username,
  password,
  email,
  displayName,
  isAdmin = false,
}) {
  const name = String(username || '').trim();

  if (name.length < 3) throw new Error('Benutzername muss mindestens 3 Zeichen haben.');
  if (String(password || '').length < 8)
    throw new Error('Passwort muss mindestens 8 Zeichen haben.');

  // Vorabprüfung für eine schöne Fehlermeldung. Der UNIQUE-Index in der
  // Datenbank bleibt die eigentliche Absicherung gegen Wettlaufsituationen.
  const existing = get('SELECT id FROM users WHERE username = ?', name);
  if (existing) throw new Error('Dieser Benutzername ist bereits vergeben.');

  const passwordHash = await hashPassword(password);

  const result = run(
    `INSERT INTO users (username, display_name, password_hash, is_admin, region, language)
     VALUES (?, ?, ?, ?, ?, ?)`,
    name,
    displayName?.trim() || name,
    passwordHash,
    isAdmin ? 1 : 0,
    // Neue Benutzer erben zunächst die globalen Vorgaben aus der .env.
    config.region,
    config.language,
  );

  const userId = Number(result.lastInsertRowid);

  // Die E-Mail erst danach setzen, damit ihre eigene Prüfung (Format,
  // Eindeutigkeit) greift, ohne den INSERT oben zu verkomplizieren.
  if (email) setEmail(userId, email);

  return getUserById(userId);
}

/**
 * Lädt einen Benutzer anhand seiner ID – ohne den Passwort-Hash, damit dieser
 * niemals versehentlich in einer JSON-Antwort landet.
 * @param {number} id
 * @returns {object|undefined}
 */
export function getUserById(id) {
  return get(
    `SELECT id, username, email, display_name, is_admin, region, language,
            created_at, last_login_at
       FROM users WHERE id = ?`,
    id,
  );
}

/**
 * Lädt einen Benutzer anhand seines Anmeldenamens ODER seiner E-Mail-Adresse –
 * hier MIT Hash, weil genau dieser für die Passwortprüfung gebraucht wird.
 *
 * Beide Felder werden akzeptiert, damit man sich mit dem eintippen kann, was
 * einem gerade einfällt. Der Vergleich ist dank COLLATE NOCASE auf der Spalte
 * unabhängig von Groß- und Kleinschreibung.
 *
 * @param {string} identifier Benutzername oder E-Mail
 * @returns {object|undefined}
 */
export function getUserByUsername(identifier) {
  const value = String(identifier || '').trim();
  if (!value) return undefined;

  return get(
    'SELECT * FROM users WHERE username = ? OR email = ? COLLATE NOCASE',
    value,
    value,
  );
}

/**
 * Setzt oder entfernt die E-Mail-Adresse eines Kontos.
 *
 * Die Adresse ist optional und dient ausschließlich als zweiter Anmeldename –
 * Streamo verschickt keine E-Mails und braucht keinen Mailserver.
 *
 * @param {number} userId
 * @param {string|null} email null oder leer entfernt die Adresse
 * @throws {Error} bei ungültigem Format oder wenn die Adresse belegt ist
 */
export function setEmail(userId, email) {
  const value = String(email ?? '').trim().toLowerCase();

  if (value === '') {
    run('UPDATE users SET email = NULL WHERE id = ?', userId);
    return;
  }

  // Bewusst eine sehr einfache Prüfung: "irgendwas@irgendwas.irgendwas".
  // Eine vollständige Validierung nach RFC 5322 ist berüchtigt kompliziert
  // und bringt hier nichts, weil die Adresse nie angeschrieben wird.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    throw new Error('Das sieht nicht nach einer E-Mail-Adresse aus.');
  }

  const taken = get('SELECT id FROM users WHERE email = ? AND id != ?', value, userId);
  if (taken) throw new Error('Diese E-Mail-Adresse wird bereits verwendet.');

  run('UPDATE users SET email = ? WHERE id = ?', value, userId);
}

/**
 * Sagt, ob ein Konto überhaupt ein Passwort hat.
 *
 * Ein leerer `password_hash` bedeutet "nur Passkey". Diesen Fall gibt es, wenn
 * jemand sein Passwort bewusst entfernt hat, nachdem er Passkeys eingerichtet
 * hat. Die Spalte bleibt dabei NOT NULL – ein leerer String ist der Marker,
 * und verifyPassword() lehnt ihn ohnehin immer ab, weil ihm der Doppelpunkt
 * zwischen Salt und Hash fehlt.
 *
 * @param {object} user Zeile aus `users` (mit password_hash)
 * @returns {boolean}
 */
export function hasPassword(user) {
  return Boolean(user?.password_hash && user.password_hash.includes(':'));
}

/**
 * Zählt alle Benutzer. Wird an zwei Stellen gebraucht:
 *   1. Setup-Erkennung: 0 Benutzer  ->  Einrichtungsassistent anzeigen
 *   2. Rechtevergabe: der allererste Benutzer wird automatisch Admin
 * @returns {number}
 */
export function countUsers() {
  return get('SELECT COUNT(*) AS n FROM users').n;
}

// --------------------------------------------------------------------------
// Sessions
// --------------------------------------------------------------------------

/**
 * Erzeugt eine neue Session und gibt den Token zurück, der ins Cookie gehört.
 *
 * @param {number} userId    Wem gehört die Session? (sessions.user_id)
 * @param {object} [meta]    Optionale Zusatzinfos zur Anzeige
 * @param {string} [meta.userAgent]
 * @param {string} [meta.ip]
 * @returns {string} Session-Token (256 Bit als Hex)
 */
export function createSession(userId, meta = {}) {
  // 32 Byte kryptografisch sicherer Zufall. Nicht erratbar, nicht ableitbar.
  const token = crypto.randomBytes(32).toString('hex');

  // Ablaufzeitpunkt = jetzt + config.sessionDays, als UTC-ISO-String, damit er
  // mit SQLites datetime('now') vergleichbar ist.
  const expires = new Date(Date.now() + config.sessionDays * 86_400_000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19);

  run(
    `INSERT INTO sessions (id, user_id, expires_at, user_agent, ip)
     VALUES (?, ?, ?, ?, ?)`,
    token,
    userId,
    expires,
    meta.userAgent ?? null,
    meta.ip ?? null,
  );

  // Bei der Gelegenheit den Anmeldezeitpunkt festhalten (Anzeige im Profil).
  run("UPDATE users SET last_login_at = datetime('now') WHERE id = ?", userId);

  return token;
}

/**
 * Löst einen Session-Token in den zugehörigen Benutzer auf.
 * Abgelaufene Sessions gelten als ungültig (Vergleich direkt in SQL).
 *
 * @param {string} token
 * @returns {object|undefined} Benutzer ohne Hash, oder undefined
 */
export function getUserBySession(token) {
  if (!token) return undefined;

  return get(
    // u.email muss mit dabei sein: An diesem Objekt hängt req.user, und jede
    // Route liest daraus. Fehlte das Feld, wirkte ein Konto überall so, als
    // hätte es keine E-Mail-Adresse – auch auf der Einstellungsseite.
    `SELECT u.id, u.username, u.email, u.display_name, u.is_admin,
            u.region, u.language,
            u.created_at, u.last_login_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.id = ?
        AND s.expires_at > datetime('now')`,
    token,
  );
}

/**
 * Beendet eine einzelne Session (normales Abmelden).
 * @param {string} token
 */
export function destroySession(token) {
  if (token) run('DELETE FROM sessions WHERE id = ?', token);
}

/**
 * Beendet ALLE Sessions eines Benutzers ("auf allen Geräten abmelden").
 * Wird außerdem nach einer Passwortänderung aufgerufen.
 * @param {number} userId
 */
export function destroyAllSessions(userId) {
  run('DELETE FROM sessions WHERE user_id = ?', userId);
}

/**
 * Räumt abgelaufene Sessions auf. Aufruf beim Serverstart und bei jedem Login,
 * damit die Tabelle nicht unbegrenzt wächst.
 * @returns {number} Anzahl gelöschter Zeilen
 */
export function pruneSessions() {
  return Number(run("DELETE FROM sessions WHERE expires_at <= datetime('now')").changes);
}

/**
 * Listet die aktiven Sessions eines Benutzers für die Einstellungsseite.
 * @param {number} userId
 * @returns {object[]}
 */
export function listSessions(userId) {
  return all(
    `SELECT id, created_at, expires_at, user_agent, ip
       FROM sessions
      WHERE user_id = ? AND expires_at > datetime('now')
      ORDER BY created_at DESC`,
    userId,
  );
}

// --------------------------------------------------------------------------
// Cookie-Hilfsfunktionen
// Express 5 bringt keinen Cookie-Parser mit; für ein einziges Cookie lohnt
// keine zusätzliche Abhängigkeit.
// --------------------------------------------------------------------------

/**
 * Zerlegt den Cookie-Header in ein Objekt.
 * @param {string} [header] Inhalt von req.headers.cookie
 * @returns {Record<string,string>}
 */
export function parseCookies(header) {
  const out = {};
  if (!header) return out;

  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    // decodeURIComponent, weil Cookie-Werte prozentkodiert sein dürfen.
    const value = decodeURIComponent(part.slice(eq + 1).trim());
    if (key) out[key] = value;
  }
  return out;
}

/**
 * Setzt das Session-Cookie auf der Antwort.
 *
 * Verwendete Flags und ihr Zweck:
 *   HttpOnly – JavaScript im Browser kommt nicht an das Cookie heran; damit
 *              kann eine XSS-Lücke die Session nicht stehlen.
 *   SameSite=Lax – das Cookie wird bei fremden POST-Requests nicht
 *              mitgeschickt; das ist der CSRF-Schutz dieser Anwendung.
 *   Secure   – nur über HTTPS senden. Automatisch aktiv, wenn TRUST_PROXY=true
 *              gesetzt ist, denn dann steht ein TLS-Proxy davor. Im nackten
 *              LAN-Betrieb ohne HTTPS würde das Flag das Login unmöglich machen.
 *   Max-Age  – Lebensdauer in Sekunden, passend zu sessions.expires_at.
 *
 * @param {import('express').Response} res
 * @param {string} token
 */
export function setSessionCookie(res, token) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${config.sessionDays * 86_400}`,
  ];
  if (config.trustProxy) parts.push('Secure');

  res.setHeader('Set-Cookie', parts.join('; '));
}

/**
 * Löscht das Session-Cookie (Max-Age=0 weist den Browser an, es zu vergessen).
 * @param {import('express').Response} res
 */
export function clearSessionCookie(res) {
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
  );
}

// --------------------------------------------------------------------------
// Express-Middleware
// --------------------------------------------------------------------------

/**
 * Hängt den angemeldeten Benutzer an `req.user` – oder null, wenn niemand
 * angemeldet ist. Läuft global in src/server.js für JEDEN Request, blockiert
 * aber nichts. So können öffentliche Routen (Login, Health) trotzdem wissen,
 * wer da klopft.
 */
export function attachUser(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE];

  req.sessionToken = token || null;
  req.user = getUserBySession(token) || null;

  next();
}

/**
 * Schützt eine Route: ohne Anmeldung gibt es 401 und die Route wird nie
 * ausgeführt. Wird von allen /api/library-, /api/providers- und
 * /api/shows-Routen verwendet.
 */
export function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Nicht angemeldet.', code: 'unauthenticated' });
  }
  next();
}

/**
 * Wie requireAuth, verlangt zusätzlich Adminrechte. Schützt Aktionen, die die
 * ganze Instanz betreffen: globalen TMDB-Key ändern, Benutzer anlegen/löschen,
 * Sync manuell auslösen.
 */
export function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Nicht angemeldet.', code: 'unauthenticated' });
  }
  if (!req.user.is_admin) {
    return res
      .status(403)
      .json({ error: 'Dafür brauchst du Administratorrechte.', code: 'forbidden' });
  }
  next();
}

/**
 * Sagt, ob sich Personen ohne Einladung selbst ein Konto anlegen dürfen.
 *
 * Die Vorgabe ist NEIN, und das mit Absicht: Sobald Streamo aus dem Internet
 * erreichbar ist, könnte sonst jeder, der die Adresse findet, ein Konto
 * anlegen – und damit den TMDB-Zugang der Instanz mitbenutzen. Deshalb ist
 * die Einladung der Normalfall und die offene Registrierung die Ausnahme.
 *
 * Zwei Stellen können das entscheiden, in dieser Reihenfolge:
 *
 *   1. Die Einstellung `allow_registration` in der Datenbank. Sie lässt sich
 *      als Administrator in der Oberfläche umlegen (Einstellungen ->
 *      Registrierung) und gilt sofort.
 *   2. Ist dort nichts gesetzt, gilt ALLOW_REGISTRATION aus der .env.
 *
 * Die Datenbank sticht die .env, damit man dafür nicht auf den Server muss.
 *
 * Verknüpfungen:
 *   - src/routes/auth.js     -> /status meldet es, /register wertet es aus
 *   - src/routes/settings.js -> hier wird es umgelegt
 *
 * @returns {boolean}
 */
export function isRegistrationOpen() {
  const stored = getSetting('allow_registration', null);

  // Nichts gespeichert -> die Vorgabe aus der Umgebung.
  if (stored === null) return config.allowRegistration;

  return stored === '1' || stored === 'true';
}
