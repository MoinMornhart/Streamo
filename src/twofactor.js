/**
 * ---------------------------------------------------------------------------
 * src/twofactor.js – Zwei-Faktor-Anmeldung, die Verwaltungsseite
 * ---------------------------------------------------------------------------
 * Rolle im Gesamtsystem:
 *   src/totp.js rechnet die Codes aus – reine Mathematik, ohne Datenbank.
 *   Diese Datei ist die Schicht darüber: Sie merkt sich, wer den zweiten
 *   Faktor eingeschaltet hat, verwaltet die Ersatzcodes und hält die
 *   halbfertigen Anmeldungen fest, die zwischen Passwort und Code entstehen.
 *
 * Der Ablauf einer Anmeldung mit zweitem Faktor:
 *
 *   1. Benutzername und Passwort werden geprüft wie immer.
 *   2. Ist der zweite Faktor eingeschaltet, entsteht KEINE Sitzung. Stattdessen
 *      wird ein kurzlebiger Zwischen-Token ausgegeben ("die Person kennt das
 *      Passwort, mehr nicht").
 *   3. Mit diesem Token und dem Code aus der App kommt der zweite Aufruf.
 *      Erst wenn der Code stimmt, entsteht die Sitzung.
 *
 * Warum nicht einfach die Sitzung anlegen und den Code danach abfragen? Weil
 * die Sitzung dann bereits gültig wäre. Wer das Passwort hat, käme mit einer
 * abgefangenen Sitzungskennung am zweiten Faktor vorbei. Die halbfertige
 * Anmeldung ist deshalb ausdrücklich KEINE Sitzung.
 *
 * Verknüpfungen:
 *   - src/totp.js        -> Codes erzeugen und prüfen
 *   - src/db.js          -> users.totp_* und Tabelle totp_backup_codes
 *   - src/routes/auth.js -> die Endpunkte darüber
 * ---------------------------------------------------------------------------
 */

import crypto from 'node:crypto';
import { get, all, run } from './db.js';
import {
  generateSecret,
  verifyCode,
  buildOtpAuthUrl,
  formatSecret,
  generateBackupCodes,
  hashBackupCode,
} from './totp.js';

// ===========================================================================
// Halbfertige Anmeldungen
// ===========================================================================

/**
 * Wie lange zwischen Passwort und Code vergehen darf.
 *
 * Fünf Minuten sind reichlich, um das Telefon zu entsperren und sechs Ziffern
 * abzutippen – und kurz genug, dass ein liegengebliebener Token nichts wert
 * ist.
 */
const PENDING_TTL_MS = 5 * 60 * 1000;

/**
 * token -> { userId, expiresAt, attempts }
 *
 * Bewusst nur im Arbeitsspeicher und nicht in der Datenbank: Diese Einträge
 * leben Minuten, nicht Tage. Ein Neustart des Servers macht eine gerade
 * begonnene Anmeldung ungültig – dann tippt man Benutzername und Passwort
 * eben noch einmal. Dafür kann nichts liegen bleiben, was aufgeräumt werden
 * müsste.
 *
 * @type {Map<string, {userId: number, expiresAt: number, attempts: number}>}
 */
const pendingLogins = new Map();

/**
 * Wie oft ein Code zu einer halbfertigen Anmeldung falsch sein darf.
 *
 * Sechs Ziffern sind eine Million Möglichkeiten – ohne Begrenzung ließe sich
 * das durchprobieren. Nach fünf Fehlversuchen verfällt der Token und die
 * Anmeldung beginnt von vorn, also mit einer erneuten Passwortprüfung.
 */
const MAX_ATTEMPTS = 5;

/**
 * Entfernt abgelaufene Einträge.
 *
 * Wird bei jedem Zugriff nebenbei mitgemacht, statt einen Zeitgeber laufen zu
 * lassen: Es sind wenige Einträge, und ein Zeitgeber hielte den Prozess wach.
 */
function prunePending() {
  const now = Date.now();

  for (const [token, entry] of pendingLogins) {
    if (entry.expiresAt <= now) pendingLogins.delete(token);
  }
}

/**
 * Hält fest, dass jemand das Passwort richtig eingegeben hat – mehr nicht.
 *
 * @param {number} userId
 * @returns {string} Der Zwischen-Token für den zweiten Schritt
 */
export function createPendingLogin(userId) {
  prunePending();

  const token = crypto.randomBytes(32).toString('base64url');

  pendingLogins.set(token, {
    userId,
    expiresAt: Date.now() + PENDING_TTL_MS,
    attempts: 0,
  });

  return token;
}

/**
 * Schließt eine halbfertige Anmeldung ab.
 *
 * Der Token wird in jedem Fall entwertet, sobald der Code stimmt – so lässt
 * sich derselbe Token nicht zweimal einlösen.
 *
 * @param {string} token
 * @param {string} code Sechsstelliger Code oder ein Ersatzcode
 * @returns {{ok: true, userId: number} | {ok: false, error: string, code: string}}
 */
export function completePendingLogin(token, code) {
  prunePending();

  const entry = pendingLogins.get(String(token || ''));

  if (!entry) {
    return {
      ok: false,
      code: 'pending_expired',
      error: 'Die Anmeldung ist abgelaufen. Bitte melde dich noch einmal an.',
    };
  }

  const result = verifyForUser(entry.userId, code);

  if (!result.ok) {
    entry.attempts++;

    // Zu viele Fehlversuche: Der Token verfällt, die Anmeldung beginnt von
    // vorn – dann muss auch das Passwort wieder stimmen.
    if (entry.attempts >= MAX_ATTEMPTS) {
      pendingLogins.delete(token);

      return {
        ok: false,
        code: 'too_many_attempts',
        error: 'Zu viele Fehlversuche. Bitte melde dich noch einmal an.',
      };
    }

    return {
      ok: false,
      code: 'bad_code',
      error: 'Der Code stimmt nicht. Achte darauf, den aktuellen zu nehmen.',
    };
  }

  pendingLogins.delete(token);

  return { ok: true, userId: entry.userId, usedBackupCode: result.usedBackupCode };
}

/**
 * Verwirft alle halbfertigen Anmeldungen eines Benutzers.
 *
 * Wird beim Ausschalten des zweiten Faktors gebraucht: Ein Token, der auf
 * einen Code wartet, den es nicht mehr gibt, wäre eine Sackgasse.
 *
 * @param {number} userId
 */
export function clearPendingLogins(userId) {
  for (const [token, entry] of pendingLogins) {
    if (entry.userId === userId) pendingLogins.delete(token);
  }
}

// ===========================================================================
// Ein- und Ausschalten
// ===========================================================================

/**
 * Liest den Zustand des zweiten Faktors.
 *
 * Das Geheimnis selbst wird NICHT herausgegeben – es verlässt den Server nur
 * ein einziges Mal, nämlich beim Einrichten.
 *
 * @param {number} userId
 * @returns {{enabled: boolean, enabledAt: string|null, backupCodesLeft: number}}
 */
export function getTwoFactorState(userId) {
  const user = get(
    'SELECT totp_enabled, totp_enabled_at FROM users WHERE id = ?',
    userId,
  );

  const left = get(
    'SELECT COUNT(*) AS count FROM totp_backup_codes WHERE user_id = ? AND used_at IS NULL',
    userId,
  );

  return {
    enabled: Boolean(user?.totp_enabled),
    enabledAt: user?.totp_enabled_at ?? null,
    backupCodesLeft: left?.count ?? 0,
  };
}

/**
 * Beginnt die Einrichtung: erzeugt ein Geheimnis und gibt es einmalig heraus.
 *
 * Der zweite Faktor ist damit noch NICHT eingeschaltet. Das geschieht erst in
 * enableTwoFactor(), nachdem ein gültiger Code bewiesen hat, dass die App das
 * Geheimnis auch wirklich bekommen hat. Ohne diesen Zwischenschritt könnte
 * man sich beim Abtippen vertun und wäre anschließend ausgesperrt.
 *
 * Ein erneuter Aufruf erzeugt ein neues Geheimnis und verwirft das vorige –
 * gedacht für den Fall, dass die Einrichtung abgebrochen wurde.
 *
 * @param {number} userId
 * @param {string} username Für die Beschriftung in der Authenticator-App
 * @returns {{secret: string, formatted: string, otpauthUrl: string}}
 * @throws wenn der zweite Faktor bereits eingeschaltet ist
 */
export function beginTwoFactorSetup(userId, username) {
  const state = getTwoFactorState(userId);

  if (state.enabled) {
    throw new Error('Der zweite Faktor ist bereits eingeschaltet.');
  }

  const secret = generateSecret();

  run('UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?', secret, userId);

  return {
    secret,
    // In Vierergruppen, damit man es abtippen kann.
    formatted: formatSecret(secret),
    otpauthUrl: buildOtpAuthUrl({ secret, account: username }),
  };
}

/**
 * Schaltet den zweiten Faktor ein – nach Vorlage eines gültigen Codes.
 *
 * Erst hier entstehen die Ersatzcodes. Sie werden genau einmal im Klartext
 * zurückgegeben; danach liegen nur noch ihre Prüfsummen in der Datenbank und
 * niemand kann sie erneut anzeigen, auch der Betreiber nicht.
 *
 * @param {number} userId
 * @param {string} code Der Code aus der App
 * @returns {{ok: true, backupCodes: string[]} | {ok: false, error: string}}
 */
export function enableTwoFactor(userId, code) {
  const user = get('SELECT totp_secret, totp_enabled FROM users WHERE id = ?', userId);

  if (!user?.totp_secret) {
    return { ok: false, error: 'Es wurde noch keine Einrichtung begonnen.' };
  }

  if (user.totp_enabled) {
    return { ok: false, error: 'Der zweite Faktor ist bereits eingeschaltet.' };
  }

  if (!verifyCode(user.totp_secret, code)) {
    return {
      ok: false,
      error: 'Der Code stimmt nicht. Prüfe, ob die Uhrzeit deines Telefons richtig geht.',
    };
  }

  run(
    "UPDATE users SET totp_enabled = 1, totp_enabled_at = datetime('now') WHERE id = ?",
    userId,
  );

  const backupCodes = replaceBackupCodes(userId);

  return { ok: true, backupCodes };
}

/**
 * Schaltet den zweiten Faktor wieder aus und räumt alles Zugehörige weg.
 *
 * @param {number} userId
 */
export function disableTwoFactor(userId) {
  run(
    'UPDATE users SET totp_secret = NULL, totp_enabled = 0, totp_enabled_at = NULL WHERE id = ?',
    userId,
  );

  // Die Ersatzcodes gehören zum abgeschalteten Faktor und wären sonst beim
  // erneuten Einschalten noch gültig – ohne dass jemand damit rechnet.
  run('DELETE FROM totp_backup_codes WHERE user_id = ?', userId);

  clearPendingLogins(userId);
}

// ===========================================================================
// Ersatzcodes
// ===========================================================================

/**
 * Erzeugt einen frischen Satz Ersatzcodes und wirft die alten weg.
 *
 * @param {number} userId
 * @returns {string[]} die Codes im Klartext – nur dieses eine Mal
 */
export function replaceBackupCodes(userId) {
  run('DELETE FROM totp_backup_codes WHERE user_id = ?', userId);

  const codes = generateBackupCodes();

  for (const code of codes) {
    run(
      'INSERT INTO totp_backup_codes (user_id, code_hash) VALUES (?, ?)',
      userId,
      hashBackupCode(code),
    );
  }

  return codes;
}

// ===========================================================================
// Prüfen
// ===========================================================================

/**
 * Prüft eine Eingabe gegen den zweiten Faktor eines Benutzers.
 *
 * Zwei Wege werden akzeptiert:
 *   - der sechsstellige Code aus der App
 *   - einer der Ersatzcodes; der wird dabei verbraucht
 *
 * @param {number} userId
 * @param {string} code
 * @returns {{ok: boolean, usedBackupCode?: boolean}}
 */
export function verifyForUser(userId, code) {
  const user = get('SELECT totp_secret, totp_enabled FROM users WHERE id = ?', userId);

  // Ohne eingeschalteten zweiten Faktor gibt es nichts zu prüfen. Das mit
  // "ok" zu beantworten wäre gefährlich – der Aufrufer würde eine Prüfung
  // annehmen, die gar nicht stattgefunden hat.
  if (!user?.totp_enabled || !user.totp_secret) return { ok: false };

  if (verifyCode(user.totp_secret, code)) {
    return { ok: true, usedBackupCode: false };
  }

  // Kein gültiger Zeitcode – vielleicht ein Ersatzcode.
  const hash = hashBackupCode(code);

  const match = get(
    `SELECT id FROM totp_backup_codes
      WHERE user_id = ? AND code_hash = ? AND used_at IS NULL`,
    userId,
    hash,
  );

  if (!match) return { ok: false };

  // Verbrauchen statt löschen: So lässt sich anzeigen, wie viele noch übrig
  // sind, und ein verbrauchter Code kann nicht erneut gelten.
  run("UPDATE totp_backup_codes SET used_at = datetime('now') WHERE id = ?", match.id);

  return { ok: true, usedBackupCode: true };
}

/**
 * Sagt, ob ein Benutzer beim Anmelden nach einem Code gefragt werden muss.
 *
 * @param {number} userId
 * @returns {boolean}
 */
export function requiresTwoFactor(userId) {
  const user = get('SELECT totp_enabled, totp_secret FROM users WHERE id = ?', userId);
  return Boolean(user?.totp_enabled && user.totp_secret);
}

/**
 * Listet die Ersatzcodes eines Benutzers – nur Zustand, nie im Klartext.
 *
 * Gedacht für die Einstellungsseite: "7 von 10 noch nutzbar".
 *
 * @param {number} userId
 * @returns {{total: number, left: number}}
 */
export function getBackupCodeState(userId) {
  const rows = all('SELECT used_at FROM totp_backup_codes WHERE user_id = ?', userId);

  return {
    total: rows.length,
    left: rows.filter((row) => row.used_at === null).length,
  };
}
