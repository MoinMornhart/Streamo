/**
 * ---------------------------------------------------------------------------
 * public/js/passkey.js – Die Browser-Seite der Passkey-Anmeldung
 * ---------------------------------------------------------------------------
 * Rolle im Gesamtsystem:
 *   Vermittelt zwischen der Streamo-API und der eingebauten WebAuthn-
 *   Schnittstelle des Browsers (`navigator.credentials`).
 *
 * Warum hier keine Bibliothek?
 *   Auf dem Server steckt mit @simplewebauthn/server bewusst eine geprüfte
 *   Bibliothek, weil dort Signaturen kryptografisch verifiziert werden. Im
 *   Browser passiert nichts dergleichen: Hier werden nur Felder zwischen
 *   Base64URL-Text und Byte-Puffern umgerechnet, weil JSON keine Binärdaten
 *   kennt. Das sind die knapp hundert Zeilen unten – und Streamo bleibt ohne
 *   Build-Schritt.
 *
 * Ablauf (beide Male zwei Schritte, siehe src/passkeys.js):
 *   Anlegen:   POST …/register/options  ->  navigator.credentials.create()
 *              ->  POST …/register/verify
 *   Anmelden:  POST …/login/options     ->  navigator.credentials.get()
 *              ->  POST …/login/verify
 *
 * Verknüpfungen:
 *   - src/routes/auth.js       -> die vier Endpunkte
 *   - public/js/views/auth.js  -> "Mit Passkey anmelden"
 *   - public/js/views/settings.js -> Passkeys verwalten
 * ---------------------------------------------------------------------------
 */

/**
 * Wandelt Base64URL-Text in einen Byte-Puffer.
 *
 * Base64URL ist die URL-taugliche Variante von Base64: "-" statt "+", "_"
 * statt "/", und ohne die Auffüllzeichen "=". Der Browser erwartet an den
 * betreffenden Stellen echte Binärdaten, deshalb die Rückrechnung.
 *
 * @param {string} value Base64URL-kodierter Text
 * @returns {ArrayBuffer}
 */
function fromBase64Url(value) {
  // Zurück zum Standard-Alphabet und auf ein Vielfaches von 4 auffüllen,
  // denn atob() besteht darauf.
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');

  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes.buffer;
}

/**
 * Wandelt einen Byte-Puffer in Base64URL-Text.
 * @param {ArrayBuffer} buffer
 * @returns {string}
 */
function toBase64Url(buffer) {
  const bytes = new Uint8Array(buffer);

  // String.fromCharCode mit dem Spread-Operator würde bei großen Puffern die
  // Argumentgrenze sprengen, deshalb die Schleife.
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Sagt, ob der Browser Passkeys überhaupt kennt.
 *
 * Zusätzlich zur Server-Prüfung (HTTPS, Hostname – siehe src/passkeys.js):
 * Ein sehr alter Browser hat `navigator.credentials` schlicht nicht.
 *
 * @returns {boolean}
 */
export function isSupported() {
  return Boolean(
    window.PublicKeyCredential &&
      navigator.credentials &&
      typeof navigator.credentials.create === 'function',
  );
}

/**
 * Sagt, ob das Gerät selbst einen Passkey erzeugen kann – also Windows Hello,
 * Touch ID, Face ID oder ein Fingerabdrucksensor vorhanden ist.
 *
 * Damit lässt sich der Knopf passend beschriften: "Mit Windows Hello anmelden"
 * ist verständlicher als "Passkey verwenden". Ohne Plattform-Sensor bleibt
 * immer noch ein Sicherheitsschlüssel oder das Handy per QR-Code.
 *
 * @returns {Promise<boolean>}
 */
export async function hasPlatformAuthenticator() {
  if (!isSupported()) return false;

  try {
    return await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

/**
 * Übersetzt die Fehler von navigator.credentials in verständliche Sätze.
 *
 * Die Originalmeldungen sind für Endanwender unbrauchbar ("The operation
 * either timed out or was not allowed") und je nach Browser verschieden.
 *
 * @param {Error} error
 * @returns {string}
 */
function explainError(error) {
  switch (error.name) {
    case 'NotAllowedError':
      // Deckt zwei Fälle ab, die der Browser aus Datenschutzgründen bewusst
      // nicht unterscheidet: abgebrochen oder Zeit abgelaufen.
      return 'Abgebrochen. Bestätige den Dialog deines Geräts, um fortzufahren.';

    case 'InvalidStateError':
      // Tritt auf, wenn excludeCredentials greift – auf diesem Gerät gibt es
      // für dieses Konto bereits einen Passkey.
      return 'Für dieses Konto ist auf diesem Gerät bereits ein Passkey hinterlegt.';

    case 'NotSupportedError':
      return 'Dein Gerät unterstützt diese Art von Passkey nicht.';

    case 'SecurityError':
      // Fast immer: falsche Domain oder fehlendes HTTPS.
      return 'Passkeys sind unter dieser Adresse nicht erlaubt. Streamo muss über HTTPS und einen Hostnamen erreichbar sein.';

    case 'AbortError':
      return 'Der Vorgang wurde abgebrochen.';

    default:
      return error.message || 'Der Passkey konnte nicht verwendet werden.';
  }
}

/**
 * Bereitet die Server-Optionen für navigator.credentials.create() auf.
 *
 * Der Server schickt alles als JSON, also als Text. Die WebAuthn-Schnittstelle
 * erwartet an mehreren Stellen Byte-Puffer – genau die werden hier umgewandelt.
 *
 * @param {object} options Antwort von /register/options
 * @returns {PublicKeyCredentialCreationOptions}
 */
function prepareCreateOptions(options) {
  return {
    ...options,
    challenge: fromBase64Url(options.challenge),
    user: {
      ...options.user,
      id: fromBase64Url(options.user.id),
    },
    // Bereits vorhandene Passkeys, damit der Browser kein Duplikat anlegt.
    excludeCredentials: (options.excludeCredentials || []).map((credential) => ({
      ...credential,
      id: fromBase64Url(credential.id),
    })),
  };
}

/**
 * Legt einen neuen Passkey an.
 *
 * @param {object} options Antwort von POST /api/auth/passkey/register/options
 * @returns {Promise<object>} Die Antwort, die an /register/verify geht
 * @throws {Error} mit einer verständlichen Meldung
 */
export async function createPasskey(options) {
  let credential;

  try {
    credential = await navigator.credentials.create({
      publicKey: prepareCreateOptions(options),
    });
  } catch (error) {
    throw new Error(explainError(error));
  }

  if (!credential) throw new Error('Es wurde kein Passkey erzeugt.');

  const response = credential.response;

  return {
    id: credential.id,
    rawId: toBase64Url(credential.rawId),
    type: credential.type,
    // Manche Browser liefern das Feld nicht – dann bleibt es leer, was der
    // Server verkraftet.
    clientExtensionResults: credential.getClientExtensionResults?.() ?? {},
    // authenticatorAttachment sagt, ob der Passkey im Gerät liegt
    // ("platform") oder auf einem Sicherheitsschlüssel ("cross-platform").
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
    response: {
      clientDataJSON: toBase64Url(response.clientDataJSON),
      attestationObject: toBase64Url(response.attestationObject),
      // Optionale Zusatzangaben; ältere Browser kennen die Methoden nicht.
      transports: response.getTransports?.() ?? [],
      publicKeyAlgorithm: response.getPublicKeyAlgorithm?.(),
      publicKey: response.getPublicKey?.() ? toBase64Url(response.getPublicKey()) : undefined,
      authenticatorData: response.getAuthenticatorData?.()
        ? toBase64Url(response.getAuthenticatorData())
        : undefined,
    },
  };
}

/**
 * Meldet sich mit einem vorhandenen Passkey an.
 *
 * @param {object} options Antwort von POST /api/auth/passkey/login/options
 * @returns {Promise<object>} Die Antwort, die an /login/verify geht
 * @throws {Error} mit einer verständlichen Meldung
 */
export async function usePasskey(options) {
  let credential;

  try {
    credential = await navigator.credentials.get({
      publicKey: {
        ...options,
        challenge: fromBase64Url(options.challenge),
        // Leer oder nicht vorhanden: Der Browser zeigt alle für diese Domain
        // gespeicherten Passkeys zur Auswahl – Anmeldung ohne Benutzernamen.
        allowCredentials: (options.allowCredentials || []).map((c) => ({
          ...c,
          id: fromBase64Url(c.id),
        })),
      },
    });
  } catch (error) {
    throw new Error(explainError(error));
  }

  if (!credential) throw new Error('Es wurde kein Passkey ausgewählt.');

  const response = credential.response;

  return {
    id: credential.id,
    rawId: toBase64Url(credential.rawId),
    type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults?.() ?? {},
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
    response: {
      clientDataJSON: toBase64Url(response.clientDataJSON),
      authenticatorData: toBase64Url(response.authenticatorData),
      signature: toBase64Url(response.signature),
      // Bei auffindbaren Passkeys steckt hier die Benutzerkennung – damit
      // findet der Server das Konto, ohne dass ein Name eingegeben wurde.
      userHandle: response.userHandle ? toBase64Url(response.userHandle) : undefined,
    },
  };
}
