/**
 * ---------------------------------------------------------------------------
 * src/config.js – Zentrale Konfiguration von Streamo
 * ---------------------------------------------------------------------------
 * Rolle im Gesamtsystem:
 *   Diese Datei ist die EINZIGE Stelle, an der Umgebungsvariablen (.env bzw.
 *   echte Prozess-Umgebung) gelesen werden. Alle anderen Module importieren
 *   das fertige `config`-Objekt. Dadurch gibt es genau einen Ort, an dem man
 *   nachschlagen kann, welche Schrauben es gibt und was ihre Defaults sind.
 *
 * Verknüpfungen zu anderen Dateien:
 *   - .env / .env.example  -> liefert die Rohwerte (siehe loadDotEnv unten)
 *   - src/db.js            -> nutzt config.dataDir für den Speicherort der DB
 *   - src/auth.js          -> nutzt config.sessionSecret + config.trustProxy
 *   - src/tmdb.js          -> nutzt config.tmdbApiKey, region, language
 *   - src/sync.js          -> nutzt config.syncIntervalHours
 *   - src/server.js        -> nutzt config.host / config.port zum Binden
 * ---------------------------------------------------------------------------
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// --------------------------------------------------------------------------
// Projektwurzel bestimmen.
// import.meta.url ist die URL DIESER Datei (…/src/config.js). Wir gehen ein
// Verzeichnis nach oben und landen im Projektstamm. Das ist robuster als
// process.cwd(), weil der Dienst z. B. von systemd aus einem beliebigen
// Arbeitsverzeichnis gestartet werden kann.
// --------------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const ROOT_DIR = path.resolve(__dirname, '..');

/**
 * Minimaler .env-Parser.
 *
 * Warum selbst gebaut statt "dotenv"? Streamo soll mit genau EINER
 * npm-Abhängigkeit (express) auskommen, damit die Installation im LXC
 * schnell und offline-freundlich ist. Der Parser deckt alles ab, was in
 * .env.example vorkommt: Kommentarzeilen, leere Zeilen, KEY=VALUE und
 * optionale Anführungszeichen.
 *
 * Wichtig: Bereits gesetzte echte Umgebungsvariablen haben Vorrang. So kann
 * man im systemd-Service oder in Docker Werte überschreiben, ohne die Datei
 * anzufassen.
 *
 * @param {string} file – absoluter Pfad zur .env-Datei
 */
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return; // Kein .env vorhanden -> nur echte ENV nutzen

  const content = fs.readFileSync(file, 'utf8');

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();

    // Leerzeilen und Kommentare (# …) überspringen
    if (!line || line.startsWith('#')) continue;

    // Das erste "=" trennt Schlüssel von Wert. Werte dürfen selbst "="
    // enthalten (z. B. Base64-Secrets), deshalb indexOf statt split.
    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    // Umschließende Anführungszeichen entfernen: KEY="wert" oder KEY='wert'
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // Vorrang für bereits gesetzte Prozess-Umgebungsvariablen
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

// .env aus der Projektwurzel laden, bevor wir irgendwelche Werte auslesen.
loadDotEnv(path.join(ROOT_DIR, '.env'));

/**
 * Liest eine Umgebungsvariable als String und fällt auf den Default zurück,
 * wenn sie fehlt ODER leer ist (ein leerer String zählt als "nicht gesetzt",
 * weil .env.example die Schlüssel bereits leer vorbelegt).
 *
 * @param {string} key          Name der Umgebungsvariablen
 * @param {string} defaultValue Rückfallwert
 * @returns {string}
 */
function envString(key, defaultValue) {
  const value = process.env[key];
  return value === undefined || value === '' ? defaultValue : value;
}

/**
 * Liest eine Umgebungsvariable als Zahl. Ungültige Eingaben (z. B. "abc")
 * führen bewusst zum Default statt zu NaN, damit ein Tippfehler in .env den
 * Dienst nicht in einen kaputten Zustand bringt.
 *
 * @param {string} key
 * @param {number} defaultValue
 * @returns {number}
 */
function envNumber(key, defaultValue) {
  const parsed = Number(envString(key, String(defaultValue)));
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

/**
 * Liest eine Umgebungsvariable als Boolean. Akzeptiert die üblichen
 * Schreibweisen, damit "1", "yes" oder "on" nicht überraschend false ergeben.
 *
 * @param {string} key
 * @param {boolean} defaultValue
 * @returns {boolean}
 */
function envBool(key, defaultValue) {
  const value = envString(key, String(defaultValue)).toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(value);
}

// --------------------------------------------------------------------------
// Datenverzeichnis auflösen und anlegen.
// Hier liegen: streamo.db (SQLite) und secret.key (Session-Signatur).
// Relative Pfade werden gegen die Projektwurzel aufgelöst, damit "./data"
// unabhängig vom Arbeitsverzeichnis immer dasselbe Verzeichnis meint.
// --------------------------------------------------------------------------
const dataDirRaw = envString('DATA_DIR', './data');
const dataDir = path.isAbsolute(dataDirRaw)
  ? dataDirRaw
  : path.resolve(ROOT_DIR, dataDirRaw);

// recursive: true legt auch verschachtelte Pfade an und wirft nicht, wenn das
// Verzeichnis bereits existiert.
fs.mkdirSync(dataDir, { recursive: true });

/**
 * Ermittelt das Secret zum Signieren der Session-Cookies.
 *
 * Reihenfolge:
 *   1. SESSION_SECRET aus der Umgebung (bevorzugt, z. B. per systemd)
 *   2. Bereits erzeugtes DATA_DIR/secret.key
 *   3. Neu erzeugen und in DATA_DIR/secret.key ablegen
 *
 * Punkt 3 ist der Grund, warum Streamo ohne jede Konfiguration startet: Beim
 * ersten Start entsteht automatisch ein zufälliges 64-Byte-Secret. Es wird mit
 * Dateirechten 0600 gespeichert, damit andere Benutzer des Systems es nicht
 * lesen und damit keine Sessions fälschen können.
 *
 * @returns {string} hex-kodiertes Secret
 */
function resolveSessionSecret() {
  const fromEnv = envString('SESSION_SECRET', '');
  if (fromEnv) return fromEnv;

  const secretFile = path.join(dataDir, 'secret.key');

  if (fs.existsSync(secretFile)) {
    const stored = fs.readFileSync(secretFile, 'utf8').trim();
    if (stored) return stored;
  }

  // 64 Byte Zufall -> 128 Hex-Zeichen. Deutlich mehr, als HMAC-SHA256 braucht.
  const generated = crypto.randomBytes(64).toString('hex');
  fs.writeFileSync(secretFile, generated, { mode: 0o600 });
  return generated;
}

/**
 * Das eingefrorene Konfigurationsobjekt, das der Rest der Anwendung benutzt.
 * Object.freeze verhindert, dass ein Modul versehentlich Werte zur Laufzeit
 * überschreibt – Konfiguration ist bewusst unveränderlich.
 *
 * Abgrenzung: Werte, die der Benutzer IM UI ändern kann (TMDB-Key, Region,
 * Sprache), landen zusätzlich in der Tabelle `settings` der Datenbank. Die DB
 * gewinnt zur Laufzeit; die Werte hier sind nur die Startvorgaben. Diese
 * Auflösung passiert in src/tmdb.js -> getRuntimeSettings().
 */
export const config = Object.freeze({
  // --- Netzwerk -----------------------------------------------------------
  /** TCP-Port des HTTP-Servers (src/server.js) */
  port: envNumber('PORT', 3000),
  /** Bind-Adresse. 0.0.0.0 = im ganzen LAN erreichbar, 127.0.0.1 = nur lokal */
  host: envString('HOST', '0.0.0.0'),
  /** true, wenn ein Reverse Proxy (nginx, Traefik, NPM) davorsteht */
  trustProxy: envBool('TRUST_PROXY', false),

  // --- Speicherorte -------------------------------------------------------
  /** Verzeichnis für streamo.db und secret.key */
  dataDir,
  /** Vollständiger Pfad zur SQLite-Datei (genutzt von src/db.js) */
  databaseFile: path.join(dataDir, 'streamo.db'),
  /** Verzeichnis mit dem Frontend, das Express statisch ausliefert */
  publicDir: path.join(ROOT_DIR, 'public'),

  // --- Sicherheit ---------------------------------------------------------
  /** HMAC-Schlüssel für Session-Cookies (src/auth.js) */
  sessionSecret: resolveSessionSecret(),
  /** Gültigkeitsdauer einer Session in Tagen */
  sessionDays: envNumber('SESSION_DAYS', 30),
  /** Dürfen sich fremde Personen selbst registrieren? */
  allowRegistration: envBool('ALLOW_REGISTRATION', false),

  // --- Passkeys (WebAuthn), siehe src/passkeys.js -------------------------
  /**
   * Die Domain, an die Passkeys gebunden werden ("Relying Party ID").
   * Leer lassen: Streamo leitet sie aus der aufgerufenen Adresse ab, was in
   * fast allen Fällen richtig ist. Fest eintragen sollte man sie, wenn
   * mehrere Hostnamen auf dieselbe Instanz zeigen – dann entscheidet dieser
   * Wert, unter welchem Namen die Passkeys gelten.
   *
   * Achtung: Ein späterer Wechsel macht alle vorhandenen Passkeys ungültig.
   * Das ist Absicht und der Grund, warum Passkeys phishing-sicher sind.
   */
  webauthnRpId: envString('WEBAUTHN_RP_ID', ''),
  /**
   * Die vollständige Adresse inklusive Schema, z. B. https://streamo.example.de.
   * Ebenfalls nur nötig, wenn die automatische Erkennung nicht passt.
   */
  webauthnOrigin: envString('WEBAUTHN_ORIGIN', ''),

  // --- HTTPS --------------------------------------------------------------
  /**
   * Streamo selbst per HTTPS ausliefern. Nur nötig, wenn KEIN Reverse Proxy
   * davorsteht, der das Zertifikat übernimmt – und dann vor allem deshalb,
   * weil Passkeys ohne HTTPS nicht funktionieren.
   *
   * Ist kein Zertifikat hinterlegt, erzeugt Streamo beim Start ein
   * selbstsigniertes (siehe src/tls.js). Der Browser zeigt dafür einmal eine
   * Warnung; die Desktop-App akzeptiert es ohne Rückfrage.
   */
  https: envBool('ENABLE_HTTPS', false),
  /** Port für HTTPS. Der HTTP-Port bleibt daneben bestehen und leitet um. */
  httpsPort: envNumber('HTTPS_PORT', 3443),
  /** Pfad zum Zertifikat im PEM-Format. Leer = selbst erzeugen. */
  tlsCertFile: envString('TLS_CERT_FILE', ''),
  /** Pfad zum privaten Schlüssel im PEM-Format. Leer = selbst erzeugen. */
  tlsKeyFile: envString('TLS_KEY_FILE', ''),
  /**
   * Hostname, auf den ein selbst erzeugtes Zertifikat ausgestellt wird.
   * Muss zu der Adresse passen, unter der Streamo aufgerufen wird.
   */
  tlsHostname: envString('TLS_HOSTNAME', 'streamo.local'),

  // --- TMDB / Streaming-Daten ---------------------------------------------
  /** API-Key oder v4-Read-Token für api.themoviedb.org (src/tmdb.js) */
  tmdbApiKey: envString('TMDB_API_KEY', ''),
  /** Standard-Watch-Region, bestimmt welche Anbieter angezeigt werden */
  region: envString('STREAMO_REGION', 'DE').toUpperCase(),
  /** Sprache für Titel, Beschreibungen und Poster */
  language: envString('STREAMO_LANGUAGE', 'de-DE'),

  // --- Hintergrundsynchronisation -----------------------------------------
  /** Abstand zwischen zwei Sync-Läufen in Stunden; 0 schaltet Sync ab */
  syncIntervalHours: envNumber('SYNC_INTERVAL_HOURS', 12),

  // --- Metadaten ----------------------------------------------------------
  /** Version, wird im UI-Footer und unter /api/health angezeigt */
  version: '1.1.9',
});

export default config;
