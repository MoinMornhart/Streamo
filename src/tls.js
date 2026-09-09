/**
 * ---------------------------------------------------------------------------
 * src/tls.js – HTTPS ohne Reverse Proxy
 * ---------------------------------------------------------------------------
 * Rolle im Gesamtsystem:
 *   Streamo läuft normalerweise auf HTTP, und ein Reverse Proxy (Nginx Proxy
 *   Manager, Traefik) kümmert sich um das Zertifikat. Wer keinen Proxy
 *   betreibt, hat trotzdem einen guten Grund für HTTPS: Ohne verschlüsselte
 *   Verbindung verweigert der Browser Passkeys – siehe src/passkeys.js.
 *
 *   Dieses Modul liefert deshalb auf Wunsch ein Zertifikat: entweder ein
 *   eigenes aus der Konfiguration, oder ein selbst erzeugtes.
 *
 * Wie wird das selbstsignierte Zertifikat erzeugt?
 *   Über das Kommandozeilenwerkzeug `openssl`. Node bringt zwar Kryptografie
 *   mit, aber keine Möglichkeit, ein X.509-Zertifikat auszustellen; eine
 *   Bibliothek dafür wäre eine weitere Abhängigkeit. openssl liegt auf jedem
 *   Debian- und Ubuntu-System ohnehin vor, auch im Streamo-Container.
 *
 * Was der Browser dazu sagt:
 *   Ein selbstsigniertes Zertifikat kennt keine Zertifizierungsstelle, also
 *   warnt der Browser beim ersten Aufruf. Nach dem Bestätigen der Ausnahme
 *   gilt die Verbindung als sicher, und Passkeys funktionieren. Die
 *   Desktop-App kann das Zertifikat auf Wunsch dauerhaft akzeptieren, ganz
 *   ohne Warnung (siehe desktop/main.js).
 *
 * Verknüpfungen:
 *   - src/config.js  -> https, httpsPort, tlsCertFile, tlsKeyFile, tlsHostname
 *   - src/server.js  -> startet damit einen HTTPS-Server
 *   - src/passkeys.js-> der eigentliche Grund, warum es dieses Modul gibt
 * ---------------------------------------------------------------------------
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import config from './config.js';

/** Wohin ein selbst erzeugtes Zertifikat geschrieben wird. */
const CERT_FILE = path.join(config.dataDir, 'cert.pem');
const KEY_FILE = path.join(config.dataDir, 'key.pem');

/** Gültigkeitsdauer eines selbst erzeugten Zertifikats in Tagen. */
const VALID_DAYS = 3650; // zehn Jahre – es soll niemanden überraschen

/**
 * Erzeugt ein selbstsigniertes Zertifikat für den eingestellten Hostnamen.
 *
 * Wichtig ist der Eintrag "subjectAltName": Moderne Browser sehen den
 * klassischen "Common Name" nicht mehr an. Fehlt der alternative Name, gilt
 * das Zertifikat als ungültig, egal wie richtig alles andere ist.
 *
 * Zusätzlich zum Hostnamen kommen "localhost" und "127.0.0.1" mit hinein,
 * damit der Zugriff direkt auf dem Server ebenfalls funktioniert.
 *
 * @param {string} hostname z. B. "streamo.local"
 * @throws {Error} wenn openssl fehlt oder scheitert
 */
function generateSelfSigned(hostname) {
  console.log(`[tls] Erzeuge selbstsigniertes Zertifikat für "${hostname}" …`);

  // -subj setzt die Angaben zum Inhaber, ohne dass openssl interaktiv fragt.
  // -nodes lässt den privaten Schlüssel unverschlüsselt – sonst müsste beim
  // Start jedes Mal ein Passwort eingegeben werden, was einen Dienst
  // unbrauchbar macht.
  const args = [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    String(VALID_DAYS),
    '-subj',
    `/CN=${hostname}/O=Streamo/C=DE`,
    '-addext',
    `subjectAltName=DNS:${hostname},DNS:localhost,IP:127.0.0.1`,
    '-keyout',
    KEY_FILE,
    '-out',
    CERT_FILE,
  ];

  try {
    // execFileSync statt execSync: Die Argumente werden als Liste übergeben
    // und nicht von einer Shell interpretiert. Ein Hostname mit Sonderzeichen
    // kann so keine Befehle einschleusen.
    execFileSync('openssl', args, { stdio: 'pipe' });
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(
        'Für HTTPS wird "openssl" gebraucht, es ist aber nicht installiert. ' +
          'Nachinstallieren mit: apt-get install -y openssl',
      );
    }

    throw new Error(
      `Das Zertifikat konnte nicht erzeugt werden: ${error.stderr?.toString().trim() || error.message}`,
    );
  }

  // Der private Schlüssel darf nur dem Dienstbenutzer gehören.
  fs.chmodSync(KEY_FILE, 0o600);

  console.log(`[tls] Zertifikat angelegt: ${CERT_FILE}`);
  console.log(`[tls] Gültig für: ${hostname}, localhost, 127.0.0.1`);
}

/**
 * Liefert Zertifikat und Schlüssel für den HTTPS-Server.
 *
 * Reihenfolge:
 *   1. Eigene Dateien aus TLS_CERT_FILE / TLS_KEY_FILE
 *   2. Bereits erzeugtes Zertifikat in DATA_DIR
 *   3. Neu erzeugen
 *
 * @returns {{cert: Buffer, key: Buffer, selfSigned: boolean}}
 * @throws {Error} wenn nichts davon gelingt
 */
export function getTlsOptions() {
  // --- 1. Eigene Dateien --------------------------------------------------
  if (config.tlsCertFile && config.tlsKeyFile) {
    if (!fs.existsSync(config.tlsCertFile)) {
      throw new Error(`Zertifikat nicht gefunden: ${config.tlsCertFile}`);
    }
    if (!fs.existsSync(config.tlsKeyFile)) {
      throw new Error(`Privater Schlüssel nicht gefunden: ${config.tlsKeyFile}`);
    }

    return {
      cert: fs.readFileSync(config.tlsCertFile),
      key: fs.readFileSync(config.tlsKeyFile),
      selfSigned: false,
    };
  }

  // --- 2./3. Selbst erzeugtes Zertifikat ----------------------------------
  if (!fs.existsSync(CERT_FILE) || !fs.existsSync(KEY_FILE)) {
    generateSelfSigned(config.tlsHostname);
  }

  return {
    cert: fs.readFileSync(CERT_FILE),
    key: fs.readFileSync(KEY_FILE),
    selfSigned: true,
  };
}

/**
 * Löscht ein selbst erzeugtes Zertifikat, damit beim nächsten Start ein neues
 * entsteht. Nötig, wenn sich der Hostname geändert hat – ein Zertifikat für
 * den falschen Namen weist der Browser ab.
 *
 * @returns {boolean} true, wenn etwas gelöscht wurde
 */
export function resetSelfSignedCertificate() {
  let removed = false;

  for (const file of [CERT_FILE, KEY_FILE]) {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      removed = true;
    }
  }

  return removed;
}
