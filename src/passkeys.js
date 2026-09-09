/**
 * ---------------------------------------------------------------------------
 * src/passkeys.js – Anmeldung mit Passkeys (WebAuthn / FIDO2)
 * ---------------------------------------------------------------------------
 * Rolle im Gesamtsystem:
 *   Ergänzt die Anmeldung per Passwort um Passkeys. Beide Wege bestehen
 *   nebeneinander: Wer seinen Passkey verliert, kommt weiterhin mit Benutzername
 *   bzw. E-Mail und Passwort hinein – genau deshalb ist "nur Passkeys" hier
 *   bewusst NICHT umgesetzt.
 *
 * Was ist ein Passkey?
 *   Ein Schlüsselpaar, das im Gerät entsteht (Windows Hello, Face ID,
 *   Fingerabdruck, YubiKey). Der private Teil verlässt das Gerät nie; Streamo
 *   speichert nur den öffentlichen Teil. Beim Anmelden schickt der Server eine
 *   Zufallsaufgabe ("Challenge"), das Gerät unterschreibt sie nach einer
 *   biometrischen Bestätigung, und der Server prüft die Unterschrift.
 *   Es gibt also kein Geheimnis, das man abfangen oder aus der Datenbank
 *   stehlen könnte.
 *
 * Warum eine Fremdbibliothek (@simplewebauthn/server)?
 *   Der Rest von Streamo kommt fast ohne Abhängigkeiten aus. Bei WebAuthn wäre
 *   das die falsche Sparsamkeit: Die Prüfung umfasst CBOR-Dekodierung,
 *   COSE-Schlüssel, Signaturprüfung und ein Dutzend Sicherheitsbedingungen.
 *   Selbst geschriebene Kryptografie an dieser Stelle wäre fahrlässig.
 *
 * WICHTIG – zwei Voraussetzungen des Browsers, die man nicht umgehen kann:
 *   1. HTTPS. Über http:// funktionieren Passkeys nicht (Ausnahme: localhost).
 *   2. Ein Hostname. Eine IP-Adresse ist als "Relying Party ID" nicht erlaubt,
 *      http://192.168.1.50:3000 scheidet also aus.
 *   Sind sie nicht erfüllt, blendet Streamo den Passkey-Knopf aus und der
 *   Passwortweg bleibt. Siehe getWebAuthnContext() unten.
 *
 * Verknüpfungen zu anderen Dateien:
 *   - src/db.js            -> Tabelle `credentials` (die öffentlichen Schlüssel)
 *   - src/auth.js          -> createSession() nach erfolgreicher Prüfung
 *   - src/routes/auth.js   -> die HTTP-Endpunkte, die diese Funktionen nutzen
 *   - public/js/views/auth.js -> der "Mit Passkey anmelden"-Knopf
 * ---------------------------------------------------------------------------
 */

import crypto from 'node:crypto';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';

import config from './config.js';
import { all, get, run } from './db.js';

/** Anzeigename der Anwendung im Systemdialog ("… möchte einen Passkey anlegen"). */
const RP_NAME = 'Streamo';

/** Wie lange ist eine Challenge gültig? Eine Minute reicht reichlich. */
const CHALLENGE_TTL_MS = 60_000;

/** Name des kurzlebigen Cookies, das eine laufende Passkey-Anmeldung zuordnet. */
export const FLOW_COOKIE = 'streamo_webauthn';

// --------------------------------------------------------------------------
// Zwischenspeicher für Challenges.
//
// Zwischen "Aufgabe stellen" und "Antwort prüfen" liegen zwei HTTP-Aufrufe.
// Die Challenge muss dazwischen serverseitig liegen – würde der Client sie
// selbst zurückschicken, könnte ein Angreifer sich eine eigene ausdenken.
//
// Eine Map im Arbeitsspeicher genügt: Die Einträge leben höchstens eine
// Minute, und Streamo läuft als einzelner Prozess. Nach einem Neustart müsste
// man den Anmeldeversuch wiederholen – das ist zumutbar und passiert praktisch
// nie, weil zwischen den beiden Aufrufen nur Sekunden liegen.
// --------------------------------------------------------------------------
/** @type {Map<string, {challenge: string, userId: number|null, expiresAt: number}>} */
const challenges = new Map();

/**
 * Entfernt abgelaufene Challenges. Wird bei jedem neuen Vorgang aufgerufen,
 * damit die Map nicht unbegrenzt wächst.
 */
function pruneChallenges() {
  const now = Date.now();
  for (const [key, value] of challenges) {
    if (value.expiresAt < now) challenges.delete(key);
  }
}

/**
 * Legt eine Challenge ab und gibt den Zuordnungsschlüssel zurück, der als
 * kurzlebiges Cookie zum Client geht.
 *
 * @param {string} challenge Die Zufallsaufgabe von SimpleWebAuthn
 * @param {number|null} userId Bei der Registrierung bekannt, beim Anmelden nicht
 * @returns {string} Zuordnungsschlüssel für das Cookie
 */
function storeChallenge(challenge, userId = null) {
  pruneChallenges();

  const flowId = crypto.randomBytes(24).toString('base64url');
  challenges.set(flowId, { challenge, userId, expiresAt: Date.now() + CHALLENGE_TTL_MS });

  return flowId;
}

/**
 * Holt eine Challenge ab und löscht sie sofort.
 *
 * Das Löschen ist sicherheitsrelevant: Jede Challenge darf genau einmal
 * verwendet werden. Sonst könnte eine abgefangene Antwort erneut eingespielt
 * werden (Replay-Angriff).
 *
 * @param {string} flowId
 * @returns {{challenge: string, userId: number|null}|null}
 */
function takeChallenge(flowId) {
  if (!flowId) return null;

  const entry = challenges.get(flowId);
  challenges.delete(flowId);

  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry;
}

/**
 * Ermittelt, unter welcher Adresse Streamo gerade erreicht wird, und ob
 * Passkeys dort überhaupt funktionieren können.
 *
 * Die "Relying Party ID" (rpID) ist die Domain, an die ein Passkey gebunden
 * wird. Sie muss exakt zur aufgerufenen Adresse passen, sonst weigert sich der
 * Browser. Deshalb wird sie standardmäßig aus der Anfrage abgeleitet und ist
 * per WEBAUTHN_RP_ID fest einstellbar.
 *
 * Achtung bei einem Wechsel: Passkeys sind an die rpID gebunden. Zieht Streamo
 * auf eine andere Domain um, müssen alle Passkeys neu angelegt werden. Das ist
 * kein Fehler, sondern genau der Schutz, der Phishing unmöglich macht.
 *
 * @param {import('express').Request} req
 * @returns {{rpID: string, origin: string, available: boolean, reason: string|null}}
 */
export function getWebAuthnContext(req) {
  // Hinter einem Reverse Proxy steht das echte Schema in X-Forwarded-Proto.
  // Ohne TRUST_PROXY darf dieser Header nicht geglaubt werden.
  const forwardedProto = config.trustProxy ? req.headers['x-forwarded-proto'] : null;
  const protocol = String(forwardedProto || req.protocol || 'http').split(',')[0].trim();

  // Der Host inklusive Port, z. B. "streamo.example.com" oder "localhost:3000".
  const forwardedHost = config.trustProxy ? req.headers['x-forwarded-host'] : null;
  const hostHeader = String(forwardedHost || req.headers.host || '').split(',')[0].trim();

  // Die rpID ist der Hostname OHNE Port.
  // Bei IPv6 in eckigen Klammern ("[::1]:3000") würde ein simples split(':')
  // scheitern, deshalb die Fallunterscheidung.
  let hostname;
  if (hostHeader.startsWith('[')) {
    hostname = hostHeader.slice(0, hostHeader.indexOf(']') + 1);
  } else {
    hostname = hostHeader.split(':')[0];
  }

  const rpID = config.webauthnRpId || hostname;
  const origin = config.webauthnOrigin || `${protocol}://${hostHeader}`;

  // --- Prüfen, ob der Browser hier überhaupt mitspielt --------------------
  const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';

  // Eine IP-Adresse ist als rpID nicht zulässig. Der Test deckt IPv4 und die
  // eckige-Klammer-Schreibweise von IPv6 ab.
  const isIpAddress = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.startsWith('[');

  // Kommt die Anfrage erkennbar über einen Reverse Proxy? Dann liegt bei
  // einem Problem fast immer eine Fehlkonfiguration vor und nicht ein
  // grundsätzlich ungeeigneter Zugang – die Hinweise unten unterscheiden das.
  const behindProxy = Boolean(
    req.headers['x-forwarded-for'] || req.headers['x-forwarded-proto'] || req.headers['x-forwarded-host'],
  );

  let reason = null;

  if (!hostHeader) {
    reason = 'Die Adresse konnte nicht bestimmt werden.';
  } else if (isIpAddress) {
    // Der häufigste Fall in der Praxis: Ein Reverse Proxy leitet zwar von
    // einer Domain weiter, schickt aber seine eigene Adresse im Host-Header.
    // Streamo sieht dann eine IP, obwohl der Browser eine Domain aufgerufen
    // hat. Der alte Hinweis "richte einen Hostnamen ein" führte hier in die
    // Irre – der Hostname existiert ja bereits.
    reason = behindProxy
      ? `Streamo sieht als Adresse "${hostname}" statt deiner Domain. Dein Reverse Proxy reicht den Host-Header nicht durch. ` +
        'Setze in der .env TRUST_PROXY=true und zusätzlich WEBAUTHN_RP_ID sowie WEBAUTHN_ORIGIN auf deine Domain.'
      : 'Passkeys funktionieren nicht über eine IP-Adresse. Richte einen Hostnamen ein, zum Beispiel streamo.deine-domain.de.';
  } else if (protocol !== 'https' && !isLocalhost) {
    reason = behindProxy
      ? 'Streamo hält die Verbindung für unverschlüsselt. Wenn dein Reverse Proxy HTTPS ausliefert, setze in der .env TRUST_PROXY=true.'
      : 'Passkeys brauchen HTTPS. Stelle einen Reverse Proxy mit Zertifikat davor oder aktiviere HTTPS in Streamo (ENABLE_HTTPS=true).';
  }

  return {
    rpID,
    origin,
    available: reason === null,
    reason,
    // Für die Anzeige auf der Einstellungsseite: Was sieht Streamo eigentlich?
    // Ohne diese Angabe rätselt man bei einem Proxy-Problem im Dunkeln.
    detectedHost: hostHeader,
    detectedProtocol: protocol,
    behindProxy,
  };
}

// --------------------------------------------------------------------------
// Registrierung – einen neuen Passkey hinzufügen
// --------------------------------------------------------------------------

/**
 * Erzeugt die Aufgabe für "neuen Passkey anlegen".
 *
 * Der Benutzer ist dabei bereits angemeldet (per Passwort oder mit einem
 * anderen Passkey) – man legt Passkeys immer aus einer bestehenden Sitzung
 * heraus an, sonst könnte jeder Fremde einen Schlüssel auf ein fremdes Konto
 * legen.
 *
 * @param {object} user Der angemeldete Benutzer (req.user)
 * @param {import('express').Request} req
 * @returns {Promise<{options: object, flowId: string}>}
 */
export async function createRegistrationOptions(user, req) {
  const { rpID } = getWebAuthnContext(req);

  // Bereits vorhandene Passkeys ausschließen. Der Browser weigert sich dann,
  // auf demselben Gerät einen zweiten anzulegen, und sagt das auch verständlich
  // ("Sie haben hier bereits einen Passkey") – besser als ein stiller Duplikat.
  const existing = all('SELECT id, transports FROM credentials WHERE user_id = ?', user.id);

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,

    // Die Benutzerkennung, die im Gerät gespeichert wird. Bewusst die interne
    // ID und nicht der Benutzername: Sie ändert sich nie, während ein
    // Anzeigename jederzeit umbenannt werden darf.
    userID: new TextEncoder().encode(String(user.id)),
    userName: user.email || user.username,
    userDisplayName: user.display_name || user.username,

    // Keine Attestation anfordern. Sie würde Herstellerinformationen des
    // Geräts offenlegen, für eine private Instanz keinen Nutzen bringen und
    // manche Browser zu einem zusätzlichen Warndialog veranlassen.
    attestationType: 'none',

    excludeCredentials: existing.map((c) => ({
      id: c.id,
      transports: c.transports ? JSON.parse(c.transports) : undefined,
    })),

    authenticatorSelection: {
      // "preferred": Der Passkey wird nach Möglichkeit im Gerät hinterlegt
      // (auffindbar). Nur dann ist später eine Anmeldung ganz ohne Eingabe
      // eines Benutzernamens möglich. "required" würde ältere
      // Sicherheitsschlüssel mit wenig Speicher ausschließen.
      residentKey: 'preferred',
      // Biometrie oder PIN verlangen, wo vorhanden. Ein Passkey ohne jede
      // Nutzerprüfung wäre nur ein Besitzfaktor.
      userVerification: 'preferred',
    },
  });

  return { options, flowId: storeChallenge(options.challenge, user.id) };
}

/**
 * Prüft die Antwort des Geräts und speichert den öffentlichen Schlüssel.
 *
 * @param {object} user Der angemeldete Benutzer
 * @param {object} response Die Antwort aus dem Browser
 * @param {string} flowId Aus dem Cookie
 * @param {import('express').Request} req
 * @param {string} [deviceName] Vom Benutzer vergebener Name
 * @returns {Promise<object>} Der gespeicherte Eintrag aus `credentials`
 * @throws {Error} wenn die Prüfung fehlschlägt
 */
export async function verifyRegistration(user, response, flowId, req, deviceName) {
  const stored = takeChallenge(flowId);

  if (!stored) {
    throw new Error('Der Vorgang ist abgelaufen. Bitte versuche es noch einmal.');
  }
  // Die Challenge gehört zu einem anderen Konto – darf nie passieren, wäre
  // aber ein ernster Fehler, deshalb geprüft.
  if (stored.userId !== user.id) {
    throw new Error('Der Vorgang gehört zu einem anderen Konto.');
  }

  const { rpID, origin } = getWebAuthnContext(req);

  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge: stored.challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    // Auch bei der Registrierung darauf bestehen, dass das Gerät den Menschen
    // geprüft hat, sofern es das kann.
    requireUserVerification: false,
  });

  if (!verification.verified || !verification.registrationInfo) {
    throw new Error('Der Passkey konnte nicht überprüft werden.');
  }

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

  run(
    `INSERT INTO credentials (
        id, user_id, public_key, counter, transports, name,
        discoverable, device_type, backed_up
     ) VALUES (?,?,?,?,?,?,?,?,?)
     -- Sollte derselbe Schlüssel erneut ankommen, nur auffrischen statt
     -- mit einem Schlüsselverletzungsfehler abzubrechen.
     ON CONFLICT(id) DO UPDATE SET
        public_key = excluded.public_key,
        counter = excluded.counter,
        transports = excluded.transports`,
    credential.id,
    user.id,
    // Der öffentliche Schlüssel ist ein Byte-Array; Base64URL macht ihn in
    // SQLite und in JSON-Antworten handhabbar.
    Buffer.from(credential.publicKey).toString('base64url'),
    credential.counter ?? 0,
    credential.transports ? JSON.stringify(credential.transports) : null,
    (deviceName || '').trim().slice(0, 60) || 'Unbenanntes Gerät',
    // Ob der Schlüssel auffindbar ist, meldet der Browser nicht verlässlich.
    // Plattform-Passkeys sind es praktisch immer – das ist die brauchbarste
    // verfügbare Näherung.
    credentialDeviceType === 'multiDevice' || credential.transports?.includes('internal') ? 1 : 0,
    credentialDeviceType ?? null,
    credentialBackedUp ? 1 : 0,
  );

  return get('SELECT * FROM credentials WHERE id = ?', credential.id);
}

// --------------------------------------------------------------------------
// Anmeldung – mit einem vorhandenen Passkey
// --------------------------------------------------------------------------

/**
 * Erzeugt die Aufgabe für "mit Passkey anmelden".
 *
 * Der Benutzername wird NICHT gebraucht: Wird kein Konto übergeben, lässt der
 * Browser den Benutzer aus allen für diese Domain gespeicherten Passkeys
 * wählen. Das ist der bequemste Weg – ein Klick, ein Fingerabdruck, fertig.
 *
 * @param {import('express').Request} req
 * @param {string} [username] Optional: nur Passkeys dieses Kontos zulassen
 * @returns {Promise<{options: object, flowId: string}>}
 */
export async function createAuthenticationOptions(req, username) {
  const { rpID } = getWebAuthnContext(req);

  /** @type {{id: string, transports?: string[]}[]|undefined} */
  let allowCredentials;

  if (username) {
    // Ein Konto wurde genannt: nur dessen Passkeys anbieten.
    const user = get(
      'SELECT id FROM users WHERE username = ? OR email = ?',
      String(username).trim(),
      String(username).trim(),
    );

    if (user) {
      allowCredentials = all(
        'SELECT id, transports FROM credentials WHERE user_id = ?',
        user.id,
      ).map((c) => ({
        id: c.id,
        transports: c.transports ? JSON.parse(c.transports) : undefined,
      }));
    } else {
      // Unbekannter Benutzername: trotzdem eine gültige Aufgabe stellen, aber
      // ohne passende Schlüssel. Sonst könnte man an der Antwort ablesen,
      // welche Konten existieren.
      allowCredentials = [];
    }
  }

  const options = await generateAuthenticationOptions({
    rpID,
    allowCredentials,
    userVerification: 'preferred',
  });

  return { options, flowId: storeChallenge(options.challenge, null) };
}

/**
 * Prüft die Anmeldeantwort und gibt den zugehörigen Benutzer zurück.
 *
 * @param {object} response Die Antwort aus dem Browser
 * @param {string} flowId Aus dem Cookie
 * @param {import('express').Request} req
 * @returns {Promise<object>} Zeile aus `users`
 * @throws {Error} wenn die Prüfung fehlschlägt
 */
export async function verifyAuthentication(response, flowId, req) {
  const stored = takeChallenge(flowId);

  if (!stored) {
    throw new Error('Der Anmeldevorgang ist abgelaufen. Bitte versuche es noch einmal.');
  }

  // Der Browser schickt mit, welcher Schlüssel verwendet wurde. Darüber finden
  // wir den öffentlichen Schlüssel und damit das Konto.
  const credential = get('SELECT * FROM credentials WHERE id = ?', response.id);

  if (!credential) {
    throw new Error('Dieser Passkey ist hier nicht hinterlegt.');
  }

  const { rpID, origin } = getWebAuthnContext(req);

  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge: stored.challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    credential: {
      id: credential.id,
      publicKey: Buffer.from(credential.public_key, 'base64url'),
      counter: credential.counter,
      transports: credential.transports ? JSON.parse(credential.transports) : undefined,
    },
    requireUserVerification: false,
  });

  if (!verification.verified) {
    throw new Error('Die Anmeldung konnte nicht bestätigt werden.');
  }

  // Zähler fortschreiben. Er dient der Erkennung geklonter Sicherheitsschlüssel;
  // die Prüfung selbst macht die Bibliothek.
  run(
    "UPDATE credentials SET counter = ?, last_used_at = datetime('now') WHERE id = ?",
    verification.authenticationInfo.newCounter,
    credential.id,
  );

  const user = get(
    `SELECT id, username, email, display_name, is_admin, region, language,
            created_at, last_login_at
       FROM users WHERE id = ?`,
    credential.user_id,
  );

  if (!user) {
    // Der Fremdschlüssel mit ON DELETE CASCADE macht das eigentlich unmöglich.
    throw new Error('Das zugehörige Konto existiert nicht mehr.');
  }

  return user;
}

// --------------------------------------------------------------------------
// Verwaltung
// --------------------------------------------------------------------------

/**
 * Listet die Passkeys eines Benutzers für die Einstellungsseite.
 * Der öffentliche Schlüssel selbst wird nicht mit ausgeliefert – er wird im
 * Browser nicht gebraucht.
 *
 * @param {number} userId
 * @returns {object[]}
 */
export function listCredentials(userId) {
  return all(
    `SELECT id, name, device_type, backed_up, discoverable, created_at, last_used_at
       FROM credentials WHERE user_id = ?
      ORDER BY created_at DESC`,
    userId,
  );
}

/**
 * Benennt einen Passkey um.
 * @param {number} userId
 * @param {string} credentialId
 * @param {string} name
 * @returns {boolean} true, wenn ein Eintrag geändert wurde
 */
export function renameCredential(userId, credentialId, name) {
  const result = run(
    'UPDATE credentials SET name = ? WHERE id = ? AND user_id = ?',
    String(name || '').trim().slice(0, 60) || 'Unbenanntes Gerät',
    credentialId,
    userId,
  );
  return Number(result.changes) > 0;
}

/**
 * Entfernt einen Passkey.
 *
 * Die user_id steht bewusst in der WHERE-Bedingung: Ohne sie könnte jemand
 * mit einer gültigen Sitzung fremde Passkeys löschen, indem er deren Kennung
 * errät oder anderweitig erfährt.
 *
 * @param {number} userId
 * @param {string} credentialId
 * @returns {boolean}
 */
export function deleteCredential(userId, credentialId) {
  const result = run(
    'DELETE FROM credentials WHERE id = ? AND user_id = ?',
    credentialId,
    userId,
  );
  return Number(result.changes) > 0;
}

/**
 * Zählt die Passkeys eines Kontos. Wird gebraucht, um zu verhindern, dass
 * jemand seinen letzten Anmeldeweg entfernt.
 * @param {number} userId
 * @returns {number}
 */
export function countCredentials(userId) {
  return get('SELECT COUNT(*) AS n FROM credentials WHERE user_id = ?', userId).n;
}
