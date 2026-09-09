/**
 * ---------------------------------------------------------------------------
 * src/invites.js – Einladungen
 * ---------------------------------------------------------------------------
 * Rolle im Gesamtsystem:
 *   Der einfachste Weg, jemanden mitmachen zu lassen. Der Betreiber erzeugt
 *   einen Link, der Empfänger legt sich damit ein Konto an – fertig.
 *
 *   Das ist ausdrücklich die Alternative dazu, dass sich jeder eine eigene
 *   Streamo-Instanz aufsetzt. Wer eingeladen wird, braucht:
 *
 *     - keinen eigenen TMDB-Zugang (der gilt für die ganze Instanz und ist
 *       längst hinterlegt; TMDB verlangt bei der Anmeldung eine Anschrift,
 *       was viele abschreckt)
 *     - keinen Server, keine Installation, keine Konfiguration
 *     - nur einen Benutzernamen und ein Passwort
 *
 * Warum nicht einfach die offene Registrierung (ALLOW_REGISTRATION)?
 *   Weil die für jeden gilt, der die Adresse kennt. Eine Einladung ist
 *   gezielt: begrenzte Anzahl Nutzungen, Ablaufdatum, jederzeit widerrufbar.
 *
 * Verknüpfungen zu anderen Dateien:
 *   - src/db.js            -> Tabelle `invites`
 *   - src/routes/auth.js   -> Registrierung per Einladung
 *   - src/routes/invites.js-> Verwaltung durch den Betreiber
 *   - public/js/views/auth.js -> der Anmeldebildschirm mit Einladung
 * ---------------------------------------------------------------------------
 */

import crypto from 'node:crypto';
import { all, get, run } from './db.js';

/**
 * Erzeugt eine Einladung.
 *
 * @param {number} userId Wer lädt ein
 * @param {object} [options]
 * @param {string} [options.note] Notiz, z. B. "für Lisa"
 * @param {number|null} [options.uses] Wie oft nutzbar; null = unbegrenzt
 * @param {number|null} [options.days] Gültigkeit in Tagen; null = unbegrenzt
 * @returns {object} die neue Einladung
 */
export function createInvite(userId, options = {}) {
  // 18 Byte ergeben 24 Zeichen in base64url – kurz genug zum Vorlesen,
  // lang genug, um nicht erraten zu werden.
  const token = crypto.randomBytes(18).toString('base64url');

  // Voreinstellung: einmal nutzbar, sieben Tage gültig. Das passt zum
  // häufigsten Fall – einer bestimmten Person einen Link schicken.
  const uses = options.uses === null ? null : Number(options.uses ?? 1);
  const days = options.days === null ? null : Number(options.days ?? 7);

  const expiresAt =
    days === null
      ? null
      : new Date(Date.now() + days * 86_400_000).toISOString().replace('T', ' ').slice(0, 19);

  run(
    `INSERT INTO invites (token, created_by, note, uses_left, expires_at)
     VALUES (?,?,?,?,?)`,
    token,
    userId,
    String(options.note || '').trim().slice(0, 120) || null,
    uses,
    expiresAt,
  );

  return get('SELECT * FROM invites WHERE token = ?', token);
}

/**
 * Prüft, ob eine Einladung noch gültig ist.
 *
 * Getrennt vom Einlösen, damit der Anmeldebildschirm schon vorher sagen kann,
 * woran es liegt – statt den Benutzer erst das Formular ausfüllen zu lassen.
 *
 * @param {string} token
 * @returns {{valid: boolean, reason: string|null, invite: object|null}}
 */
export function checkInvite(token) {
  if (!token) return { valid: false, reason: 'Kein Einladungscode angegeben.', invite: null };

  const invite = get('SELECT * FROM invites WHERE token = ?', String(token));

  if (!invite) {
    return { valid: false, reason: 'Diese Einladung gibt es nicht.', invite: null };
  }

  if (invite.uses_left !== null && invite.uses_left <= 0) {
    return { valid: false, reason: 'Diese Einladung wurde bereits verwendet.', invite };
  }

  // Der Vergleich läuft über SQLite, damit dieselbe Zeitbasis gilt wie beim
  // Speichern – ein Vergleich in JavaScript wäre je nach Zeitzone daneben.
  if (invite.expires_at) {
    const expired = get(
      "SELECT (? <= datetime('now')) AS expired",
      invite.expires_at,
    ).expired;

    if (expired) {
      return { valid: false, reason: 'Diese Einladung ist abgelaufen.', invite };
    }
  }

  return { valid: true, reason: null, invite };
}

/**
 * Löst eine Einladung ein – zu rufen NACH dem erfolgreichen Anlegen des Kontos.
 *
 * Zählt die Nutzung hoch und verringert das Restguthaben. Ein Link mit
 * unbegrenzten Nutzungen (uses_left IS NULL) bleibt unverändert gültig.
 *
 * @param {string} token
 */
export function consumeInvite(token) {
  run(
    `UPDATE invites
        SET used_count = used_count + 1,
            uses_left = CASE WHEN uses_left IS NULL THEN NULL ELSE uses_left - 1 END
      WHERE token = ?`,
    String(token),
  );
}

/**
 * Listet die Einladungen einer Instanz.
 *
 * @returns {object[]} mit dem Zustand jeder Einladung
 */
export function listInvites() {
  const rows = all(
    `SELECT i.*, u.username AS created_by_name,
            -- Ist sie abgelaufen? Der Vergleich in SQL, damit dieselbe
            -- Zeitbasis gilt wie beim Anlegen.
            CASE WHEN i.expires_at IS NOT NULL AND i.expires_at <= datetime('now')
                 THEN 1 ELSE 0 END AS expired
       FROM invites i
       LEFT JOIN users u ON u.id = i.created_by
      ORDER BY i.created_at DESC`,
  );

  return rows.map((row) => ({
    token: row.token,
    note: row.note,
    usesLeft: row.uses_left,
    usedCount: row.used_count,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    createdBy: row.created_by_name,
    expired: Boolean(row.expired),
    // Kann man sie noch benutzen?
    usable: !row.expired && (row.uses_left === null || row.uses_left > 0),
  }));
}

/**
 * Widerruft eine Einladung.
 * @param {string} token
 * @returns {boolean}
 */
export function revokeInvite(token) {
  return Number(run('DELETE FROM invites WHERE token = ?', String(token)).changes) > 0;
}

/**
 * Räumt abgelaufene und aufgebrauchte Einladungen weg.
 *
 * Wird beim Anlegen einer neuen aufgerufen, damit die Liste nicht zuwächst.
 * Abgelaufene aufzubewahren hätte keinen Nutzen – wer sie noch braucht,
 * erzeugt eine neue.
 *
 * @returns {number} Anzahl entfernter Einladungen
 */
export function pruneInvites() {
  return Number(
    run(
      `DELETE FROM invites
        WHERE (expires_at IS NOT NULL AND expires_at <= datetime('now'))
           OR (uses_left IS NOT NULL AND uses_left <= 0)`,
    ).changes,
  );
}
