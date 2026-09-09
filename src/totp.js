/**
 * ---------------------------------------------------------------------------
 * src/totp.js – Zwei-Faktor-Anmeldung mit Einmalcodes
 * ---------------------------------------------------------------------------
 * Rolle im Gesamtsystem:
 *   Ein Passwort kann gestohlen werden, ohne dass man es merkt. Der zweite
 *   Faktor sorgt dafür, dass ein gestohlenes Passwort allein nicht reicht:
 *   Zusätzlich braucht es einen sechsstelligen Code, den eine App auf dem
 *   Telefon alle 30 Sekunden neu erzeugt.
 *
 *   Wichtig: Streamo verschickt dafür nichts und ruft nichts ab. Server und
 *   App teilen sich ein Geheimnis, das einmal beim Einrichten übertragen
 *   wird; danach rechnen beide unabhängig voneinander dasselbe aus. Deshalb
 *   funktioniert das auch, wenn das Telefon im Flugmodus ist.
 *
 * Das Verfahren (TOTP, RFC 6238):
 *   1. Die aktuelle Uhrzeit wird in 30-Sekunden-Schritte seit 1970 geteilt.
 *      Diese Zahl ist der "Zähler".
 *   2. Über den Zähler wird mit dem gemeinsamen Geheimnis eine HMAC-SHA1
 *      Prüfsumme gebildet (das ist HOTP, RFC 4226).
 *   3. Aus der Prüfsumme werden vier Bytes an einer Stelle herausgegriffen,
 *      die im letzten Byte steht ("dynamic truncation"), und daraus die
 *      letzten sechs Dezimalstellen genommen.
 *
 * Warum selbst geschrieben und nicht als Bibliothek?
 *   Anders als bei Passkeys ist hier keine Kryptografie zu erfinden: node:crypto
 *   liefert HMAC-SHA1 fertig, der Rest ist Byte-Schieberei nach einer klar
 *   beschriebenen Norm. Und diese Norm bringt offizielle Testvektoren mit, an
 *   denen sich die Umsetzung beweisen lässt – siehe tests/totp.test.mjs.
 *
 * Verknüpfungen:
 *   - src/db.js            -> Spalten users.totp_secret / totp_enabled,
 *                             Tabelle totp_backup_codes (Migration 8)
 *   - src/routes/auth.js   -> Anmeldung in zwei Schritten, Ein- und Ausschalten
 *   - public/js/views/settings.js -> die Einrichtung in der Oberfläche
 * ---------------------------------------------------------------------------
 */

import crypto from 'node:crypto';

// ===========================================================================
// Base32 – das Alphabet der Authenticator-Apps
// ===========================================================================
// Das Geheimnis wird als Base32 ausgetauscht (RFC 4648), weil man es notfalls
// abtippen können muss: Es gibt keine Kleinbuchstaben, keine 0/1/8, also nichts,
// was man mit O, I oder B verwechseln kann.

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Wandelt Bytes in eine Base32-Zeichenkette.
 *
 * Gearbeitet wird mit einem Bit-Puffer: Bytes wandern zu je 8 Bit hinein,
 * heraus kommen Gruppen zu je 5 Bit – denn 32 Zeichen fassen genau 5 Bit.
 *
 * Das übliche Auffüllen mit "=" am Ende lassen wir weg. Die Norm erlaubt das,
 * und Authenticator-Apps stören sich an den Gleichheitszeichen eher, als dass
 * sie ihnen nützen.
 *
 * @param {Buffer} buffer
 * @returns {string}
 */
export function base32Encode(buffer) {
  let bits = 0; // wie viele Bits liegen gerade im Puffer
  let value = 0; // der Puffer selbst
  let output = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;

    // Solange mindestens 5 Bit bereitliegen, ein Zeichen ausgeben.
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  // Ein Rest von weniger als 5 Bit wird rechts mit Nullen aufgefüllt.
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

/**
 * Wandelt eine Base32-Zeichenkette zurück in Bytes.
 *
 * Nachsichtig gegenüber dem, was Menschen eintippen: Leerzeichen und
 * Bindestriche werden ignoriert, Kleinbuchstaben akzeptiert, angehängte
 * Gleichheitszeichen übergangen.
 *
 * @param {string} text
 * @returns {Buffer}
 * @throws wenn ein Zeichen nicht zum Alphabet gehört
 */
export function base32Decode(text) {
  const cleaned = String(text || '')
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/=+$/, '');

  let bits = 0;
  let value = 0;
  const bytes = [];

  for (const character of cleaned) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) throw new Error(`Ungültiges Zeichen im Geheimnis: ${character}`);

    value = (value << 5) | index;
    bits += 5;

    // Sobald ein volles Byte beisammen ist, herausschreiben.
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  // Übrige Bits sind Auffüllung und werden verworfen.
  return Buffer.from(bytes);
}

// ===========================================================================
// Die Codes selbst
// ===========================================================================

/** Wie lange ein Code gilt. 30 Sekunden ist der Wert, den alle Apps annehmen. */
export const TIME_STEP_SECONDS = 30;

/** Wie viele Stellen der Code hat. */
export const DIGITS = 6;

/**
 * Erzeugt ein neues Geheimnis.
 *
 * 20 Byte entsprechen der Empfehlung aus RFC 4226 für SHA-1 und ergeben eine
 * 32 Zeichen lange Base32-Kette – lang genug, um nicht erraten zu werden, und
 * kurz genug, um sie notfalls abzutippen.
 *
 * @returns {string} Base32
 */
export function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

/**
 * Rechnet einen Code für einen bestimmten Zähler aus (HOTP, RFC 4226).
 *
 * @param {Buffer} key    Das Geheimnis als Bytes
 * @param {number} counter Der Zählerstand
 * @returns {string} Code mit führenden Nullen, DIGITS Stellen lang
 */
function hotp(key, counter) {
  // Der Zähler wird als 8-Byte-Zahl in Big-Endian übergeben.
  const message = Buffer.alloc(8);

  // BigInt, weil ein Zählerstand die 32-Bit-Grenze überschreiten kann und
  // JavaScripts Bit-Operationen dort abschneiden würden.
  message.writeBigUInt64BE(BigInt(counter));

  const digest = crypto.createHmac('sha1', key).update(message).digest();

  // "Dynamic truncation": Die letzten vier Bit des letzten Bytes sagen, ab
  // welcher Stelle die vier auszuwertenden Bytes stehen.
  const offset = digest[digest.length - 1] & 0x0f;

  // Das oberste Bit wird ausmaskiert, damit die Zahl nicht negativ wird –
  // in der Norm ausdrücklich so vorgeschrieben.
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

/**
 * Rechnet den Code aus, der zu einem Zeitpunkt gilt.
 *
 * @param {string} secret Base32
 * @param {number} [forTime] Zeitpunkt in Millisekunden; Vorgabe: jetzt
 * @returns {string}
 */
export function generateCode(secret, forTime = Date.now()) {
  const counter = Math.floor(forTime / 1000 / TIME_STEP_SECONDS);
  return hotp(base32Decode(secret), counter);
}

/**
 * Prüft einen eingegebenen Code.
 *
 * Ein kleines Zeitfenster ist nötig: Die Uhr des Telefons weicht fast immer
 * ein paar Sekunden ab, und zwischen Ablesen und Eintippen vergeht Zeit.
 * Deshalb gelten neben dem aktuellen auch der vorige und der nächste
 * Zeitschritt – zusammen also ein Bereich von eineinhalb Minuten.
 *
 * Verglichen wird in gleichbleibender Zeit. Ein gewöhnlicher Vergleich bricht
 * beim ersten abweichenden Zeichen ab; aus den Laufzeitunterschieden ließe
 * sich der richtige Code Stelle für Stelle erraten.
 *
 * @param {string} secret Base32
 * @param {string} code   Was eingegeben wurde
 * @param {object} [opts]
 * @param {number} [opts.window] Wie viele Schritte in jede Richtung gelten
 * @param {number} [opts.forTime] Zeitpunkt in Millisekunden (für Tests)
 * @returns {boolean}
 */
export function verifyCode(secret, code, opts = {}) {
  const window = opts.window ?? 1;
  const forTime = opts.forTime ?? Date.now();

  // Menschen tippen Leerzeichen, Apps zeigen "123 456".
  const cleaned = String(code || '').replace(/\s/g, '');

  // Falsche Länge kann nie stimmen – und ein Vergleich verschieden langer
  // Puffer wäre ohnehin nicht in gleichbleibender Zeit möglich.
  if (cleaned.length !== DIGITS) return false;
  if (!secret) return false;

  const given = Buffer.from(cleaned);

  for (let step = -window; step <= window; step++) {
    const expected = Buffer.from(
      generateCode(secret, forTime + step * TIME_STEP_SECONDS * 1000),
    );

    if (crypto.timingSafeEqual(given, expected)) return true;
  }

  return false;
}

// ===========================================================================
// Einrichten
// ===========================================================================

/**
 * Baut die otpauth-Adresse, mit der sich eine Authenticator-App einrichten
 * lässt.
 *
 * Diese Adresse ist der Inhalt, den sonst ein QR-Code trägt. Auf dem Telefon
 * lässt sie sich antippen und öffnet die App direkt; am Rechner trägt man
 * stattdessen das Geheimnis von Hand ein.
 *
 * Der Kontoname enthält den Servernamen, damit in der App nicht nur "max"
 * steht, sondern erkennbar ist, wozu der Eintrag gehört.
 *
 * @param {object} params
 * @param {string} params.secret  Base32
 * @param {string} params.account Benutzername
 * @param {string} [params.issuer] Name der Instanz
 * @returns {string}
 */
export function buildOtpAuthUrl({ secret, account, issuer = 'Streamo' }) {
  // Der Doppelpunkt zwischen Herausgeber und Konto ist Teil des Formats;
  // beide Teile müssen einzeln kodiert werden, damit er erhalten bleibt.
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;

  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(TIME_STEP_SECONDS),
  });

  return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * Zerlegt ein Geheimnis in Vierergruppen.
 *
 * Nur fürs Auge: "JBSW Y3DP EHPK 3PXP" tippt sich deutlich zuverlässiger ab
 * als eine Kette aus 32 Zeichen.
 *
 * @param {string} secret
 * @returns {string}
 */
export function formatSecret(secret) {
  return String(secret || '').replace(/(.{4})/g, '$1 ').trim();
}

// ===========================================================================
// Ersatzcodes
// ===========================================================================

/**
 * Erzeugt Ersatzcodes für den Fall, dass das Telefon weg ist.
 *
 * Ohne sie wäre ein verlorenes Telefon gleichbedeutend mit einem verlorenen
 * Konto – und weil Streamo keine E-Mails verschickt, gäbe es keinen Weg
 * zurück. Jeder Code gilt genau einmal.
 *
 * Das Format (zweimal vier Zeichen mit Bindestrich) ist bewusst kurz genug
 * zum Aufschreiben. Verwendet wird dasselbe verwechslungsarme Alphabet wie
 * beim Geheimnis.
 *
 * @param {number} [count]
 * @returns {string[]} z. B. ["A3KP-9RTM", …]
 */
export function generateBackupCodes(count = 10) {
  const codes = [];

  for (let i = 0; i < count; i++) {
    // 5 Byte ergeben 8 Base32-Zeichen – ohne Auffüllrest.
    const raw = base32Encode(crypto.randomBytes(5)).slice(0, 8);
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4)}`);
  }

  return codes;
}

/**
 * Bringt einen Ersatzcode auf die Form, in der er gespeichert und verglichen
 * wird: Großbuchstaben, ohne Bindestriche und Leerzeichen.
 *
 * Nötig, weil niemand den Bindestrich zuverlässig mittippt.
 *
 * @param {string} code
 * @returns {string}
 */
export function normalizeBackupCode(code) {
  return String(code || '')
    .toUpperCase()
    .replace(/[\s-]/g, '');
}

/**
 * Bildet den Speicherwert eines Ersatzcodes.
 *
 * Ersatzcodes sind Passwörter und werden deshalb nicht im Klartext abgelegt.
 * Ein einfacher SHA-256 reicht hier aus – anders als bei einem Passwort ist
 * der Code zufällig und lang genug, dass sich Durchprobieren nicht lohnt;
 * das langsame Verfahren, das ein Passwort braucht, ist hier unnötig.
 *
 * @param {string} code
 * @returns {string} Hexadezimal
 */
export function hashBackupCode(code) {
  return crypto.createHash('sha256').update(normalizeBackupCode(code)).digest('hex');
}
