/**
 * ---------------------------------------------------------------------------
 * src/address.js – Unter welcher Adresse ist Streamo erreichbar?
 * ---------------------------------------------------------------------------
 * Rolle im Gesamtsystem:
 *   Die Domain steckt an mehr Stellen, als man denkt: Passkeys sind fest an
 *   sie gebunden, Kalender-Abo, Einladungen und geteilte Listen verschicken
 *   sie als Link, ein selbst erzeugtes Zertifikat ist auf sie ausgestellt.
 *   Und ob Streamo den Kopfzeilen eines Reverse Proxys glauben darf, hängt
 *   daran, wie es erreicht wird.
 *
 *   Bisher hat jede dieser Stellen die Adresse selbst aus der Anfrage
 *   geraten – sechsmal derselbe Code –, und fest einstellen ließ sie sich nur
 *   über die .env. Nach einem Domainwechsel musste man also auf den Server.
 *   Jetzt beantwortet diese Datei die Frage an einer Stelle, und die
 *   Einstellungsseite kann die Antwort ändern.
 *
 * Woher die Adresse kommt, in dieser Reihenfolge:
 *   1. Einstellungen -> "Adresse & Domain" (Tabelle settings, public_origin)
 *   2. .env: WEBAUTHN_ORIGIN, WEBAUTHN_RP_ID – dort hat sie früher
 *      "streamo domain" eingetragen
 *   3. Die Anfrage selbst – wie bisher, wenn nirgends etwas steht
 *
 *   Für den Reverse Proxy gilt dasselbe: Einstellungen (trust_proxy) vor
 *   TRUST_PROXY aus der .env. Wie bei Registrierung und Abgleichstakt sticht
 *   die Datenbank die .env.
 *
 * Gelesen wird bei jedem Aufruf frisch aus der Datenbank, ohne
 * Zwischenspeicher. Eine Abfrage auf eine Tabelle mit einer Handvoll Zeilen
 * kostet Mikrosekunden, und so wirkt eine Änderung sofort – auch eine, die
 * "streamo domain" auf der Konsole am laufenden Dienst vorbei schreibt.
 *
 * Verknüpfungen:
 *   - src/db.js              -> getSetting/setSetting, Tabelle credentials
 *   - src/passkeys.js        -> rpID und Origin
 *   - src/routes/calendar.js, collections.js, invites.js, public.js
 *                            -> die Links, die Streamo verschickt
 *   - src/server.js          -> "trust proxy", HSTS, Startbanner
 *   - src/ratelimit.js, src/auth.js, src/routes/auth.js
 *                            -> Absenderadresse, Secure-Cookie
 *   - src/tls.js             -> Hostname des selbst erzeugten Zertifikats
 *   - src/routes/settings.js -> /api/settings/address für die Oberfläche
 *   - scripts/domain.mjs     -> "streamo domain" auf der Konsole
 * ---------------------------------------------------------------------------
 */

import config from './config.js';
import { get, getSetting, setSetting } from './db.js';

/** Schlüssel in der Tabelle settings. */
const ORIGIN_KEY = 'public_origin';
const PROXY_KEY = 'trust_proxy';

/**
 * Eine Eingabe, mit der sich nichts anfangen lässt.
 *
 * Status 400, damit der zentrale Fehler-Handler in src/server.js den Text
 * unverändert an die Oberfläche weitergibt – er ist genau die Auskunft, die
 * man zum Korrigieren braucht.
 */
export class AddressError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'AddressError';
    this.status = 400;
  }
}

/**
 * Macht aus einer eingetippten Domain eine saubere Adresse.
 *
 * Großzügig bei der Form, streng beim Inhalt: "Streamo.Example.de",
 * "https://streamo.example.de/" und "streamo.example.de" ergeben dasselbe.
 * Ein Pfad dagegen wird abgelehnt statt still abgeschnitten – Streamo läuft
 * immer an der Wurzel einer Domain, und wer "/streamo" einträgt, hat etwas
 * anderes vor, als hier herauskäme.
 *
 * Ohne Schema ist https gemeint: Eine Domain trägt man fast immer für
 * Passkeys ein, und die gibt es nur über HTTPS. Wer bewusst http will (etwa
 * ein Name im Heimnetz ohne Zertifikat), schreibt es davor.
 *
 * @param {string|null|undefined} input
 * @returns {{origin: string, hostname: string, protocol: 'http'|'https'}|null}
 *          null bei leerer Eingabe – das heißt "nichts fest eintragen"
 * @throws {AddressError}
 */
export function parseDomain(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;

  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new AddressError(`„${raw}“ ist keine gültige Adresse.`);
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new AddressError('Die Adresse muss mit https:// oder http:// beginnen.');
  }

  if (url.username || url.password) {
    throw new AddressError('Zugangsdaten gehören nicht in die Adresse.');
  }

  if (url.pathname !== '/' || url.search || url.hash) {
    throw new AddressError('Bitte nur die Domain eintragen, ohne Pfad – etwa streamo.example.de.');
  }

  return {
    // origin lässt den Standardport weg: "https://x.de:443" wird "https://x.de".
    origin: url.origin,
    hostname: url.hostname,
    protocol: url.protocol === 'https:' ? 'https' : 'http',
  };
}

/**
 * Wie parseDomain(), aber ohne zu werfen – für Werte, die schon gespeichert
 * sind. Ein unbrauchbarer Eintrag (von Hand in der Datenbank oder der .env)
 * soll Streamo nicht lahmlegen, sondern wie "nicht eingetragen" wirken.
 *
 * @param {string|null} value
 */
function parseStored(value) {
  try {
    return parseDomain(value);
  } catch {
    return null;
  }
}

/**
 * Steht Streamo hinter einem Reverse Proxy, dessen Kopfzeilen es glauben darf?
 *
 * Davon hängt ab, ob X-Forwarded-For (Absender für die Anmeldebremse),
 * X-Forwarded-Proto (HTTPS-Erkennung, Secure-Cookie, HSTS) und
 * X-Forwarded-Host gelesen werden. Ohne Proxy davor wäre das eine Lücke:
 * Jeder könnte seine Herkunft frei behaupten.
 *
 * @returns {boolean}
 */
export function trustsProxy() {
  const stored = getSetting(PROXY_KEY, null);
  if (stored === null) return config.trustProxy;
  return stored === '1';
}

/**
 * Die in den Einstellungen eingetragene Adresse, ohne Rückfall auf die .env.
 * @returns {{origin: string, hostname: string, protocol: string}|null}
 */
export function storedAddress() {
  return parseStored(getSetting(ORIGIN_KEY, null));
}

/**
 * Die fest eingetragene Adresse – aus den Einstellungen oder der .env.
 *
 * null heißt: Nichts steht fest, die Adresse kommt aus der jeweiligen
 * Anfrage. So verhält sich Streamo, solange niemand eine Domain einträgt –
 * genau wie vor dieser Datei.
 *
 * @returns {{origin: string, hostname: string, protocol: string, rpID: string,
 *            source: 'einstellungen'|'.env'}|null}
 */
export function configuredAddress() {
  const stored = storedAddress();
  if (stored) return { ...stored, rpID: stored.hostname, source: 'einstellungen' };

  return envAddress();
}

/**
 * Die Adresse aus der .env, falls dort eine steht.
 *
 * Die .env kennt zwei getrennte Werte. WEBAUTHN_RP_ID darf dort von der
 * Domain der Adresse abweichen (etwa "example.de" für
 * "https://streamo.example.de") – das bleibt so erlaubt.
 */
function envAddress() {
  const fromEnv = parseStored(config.webauthnOrigin);
  if (!fromEnv) return null;

  return { ...fromEnv, rpID: config.webauthnRpId || fromEnv.hostname, source: '.env' };
}

/**
 * Die Domain, an die Passkeys gebunden werden ("Relying Party ID").
 *
 * Fest eingetragen, sonst WEBAUTHN_RP_ID allein (die .env erlaubt das ohne
 * WEBAUTHN_ORIGIN), sonst der Hostname der Anfrage.
 *
 * @param {{rpID: string}|null} fixed       configuredAddress() oder ein Vorschlag
 * @param {{hostname: string}} seen         requestAddress()
 * @returns {string}
 */
export function rpIdOf(fixed, seen) {
  return fixed?.rpID || config.webauthnRpId || seen.hostname;
}

/**
 * Die Adresse, unter der diese eine Anfrage angekommen ist – so, wie
 * Streamo sie sieht.
 *
 * Hinter einem Proxy weiß das nur die Anfrage selbst, und auch nur dann,
 * wenn der Proxy es mitteilt. Ohne trustsProxy() werden die
 * Weiterleitungs-Kopfzeilen nicht geglaubt; sie ließen sich sonst fälschen.
 *
 * @param {import('express').Request} req
 * @returns {{protocol: string, host: string, hostname: string, viaProxy: boolean}}
 *          host mit Port ("localhost:3000"), hostname ohne
 */
export function requestAddress(req) {
  const proxy = trustsProxy();

  const forwardedProto = proxy ? req.headers['x-forwarded-proto'] : null;
  const protocol = String(forwardedProto || req.protocol || 'http').split(',')[0].trim();

  const forwardedHost = proxy ? req.headers['x-forwarded-host'] : null;
  const host = String(forwardedHost || req.headers.host || '').split(',')[0].trim();

  // Bei IPv6 in eckigen Klammern ("[::1]:3000") würde ein simples
  // split(':') scheitern, deshalb die Fallunterscheidung.
  const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];

  return {
    protocol,
    host,
    hostname,
    // Kommt die Anfrage erkennbar über einen Proxy? Unabhängig davon, ob
    // Streamo ihm glaubt – genau dieser Unterschied ist bei der Fehlersuche
    // die wichtigste Auskunft.
    viaProxy: Boolean(
      req.headers['x-forwarded-for'] || req.headers['x-forwarded-proto'] || req.headers['x-forwarded-host'],
    ),
  };
}

/**
 * Der Anfang aller Links, die Streamo nach außen gibt.
 *
 * Mit eingetragener Domain immer diese – auch wenn man selbst gerade über
 * die IP im Heimnetz angemeldet ist. Sonst bekäme die Freundin per WhatsApp
 * einen Link auf 192.168.1.20, mit dem sie draußen nichts anfangen kann.
 *
 * @param {import('express').Request} req
 * @returns {string} z. B. "https://streamo.example.de" – ohne Schrägstrich am Ende
 */
export function publicBaseUrl(req) {
  const fixed = configuredAddress();
  if (fixed) return fixed.origin;

  const { protocol, host } = requestAddress(req);
  return `${protocol}://${host}`;
}

/**
 * Hostname für ein selbst erzeugtes Zertifikat.
 *
 * Eine in den Einstellungen eingetragene Domain geht vor, sonst gilt
 * TLS_HOSTNAME wie bisher. WEBAUTHN_ORIGIN aus der .env zählt hier bewusst
 * nicht mit: Es wurde nie fürs Zertifikat benutzt, und eine bestehende
 * Installation soll nicht beim nächsten Neustart plötzlich ein Zertifikat
 * für einen anderen Namen bekommen.
 *
 * @returns {string}
 */
export function certificateHostname() {
  return storedAddress()?.hostname || config.tlsHostname;
}

/**
 * Wie viele Passkeys es gibt – und von wie vielen Personen.
 *
 * Ein Passkey weiß selbst nicht, für welche Domain er angelegt wurde; die
 * Tabelle credentials speichert das nicht. Bei einem Wechsel ist deshalb
 * die ehrliche Auskunft: Alle vorhandenen gehören zur bisherigen Adresse.
 *
 * @returns {{count: number, users: number}}
 */
function passkeyCount() {
  const row = get('SELECT COUNT(*) AS count, COUNT(DISTINCT user_id) AS users FROM credentials');
  return { count: Number(row?.count ?? 0), users: Number(row?.users ?? 0) };
}

/**
 * Alles, was die Karte "Adresse & Domain" in den Einstellungen zeigt.
 *
 * @param {import('express').Request} req
 */
export function getAddressState(req) {
  const stored = storedAddress();
  const fixed = configuredAddress();
  const seen = requestAddress(req);

  return {
    // Was im Eingabefeld steht: nur der Wert aus den Einstellungen. Ein Wert
    // aus der .env erscheint darunter als Herkunft, nicht im Feld – sonst
    // würde ein unverändertes Speichern ihn stillschweigend übernehmen.
    domain: stored?.origin ?? '',
    source: fixed?.source ?? 'automatisch',
    effective: publicBaseUrl(req),
    rpID: rpIdOf(fixed, seen),
    detected: `${seen.protocol}://${seen.host}`,
    viaProxy: seen.viaProxy,
    trustProxy: trustsProxy(),
    trustProxySource: getSetting(PROXY_KEY, null) === null ? '.env' : 'einstellungen',
    // Macht Streamo selbst HTTPS, und mit welchem Zertifikat?
    https: config.https,
    ownCertificate: Boolean(config.tlsCertFile && config.tlsKeyFile),
    certificateHostname: certificateHostname(),
    passkeys: passkeyCount(),
  };
}

/**
 * Was ein Speichern auslösen würde – bevor gespeichert wird.
 *
 * Die Oberfläche fragt das vorab und zeigt daraus eine Rückfrage. Zwei Dinge
 * lassen sich danach nicht einfach zurückdrehen, ohne dass es jemand merkt:
 *
 *   - Passkeys sind an die Domain gebunden. Unter einer neuen gehen die
 *     vorhandenen nicht mehr; das Passwort schon.
 *   - Mit dem Proxy-Schalter bekommt das Anmelde-Cookie das Merkmal
 *     "Secure" und kommt dann nur noch über https:// an. Wer gerade über
 *     http:// im Heimnetz angemeldet ist, kann sich so nicht mehr anmelden.
 *
 * @param {import('express').Request} req
 * @param {{domain?: string, trustProxy?: boolean}} body
 * @throws {AddressError} bei einer unbrauchbaren Domain
 */
export function previewAddressChange(req, { domain, trustProxy } = {}) {
  const next = parseDomain(domain);
  const now = getAddressState(req);
  const seen = requestAddress(req);

  // Die rpID nach dem Speichern. Ohne eingetragene Domain fällt Streamo auf
  // die .env bzw. die Anfrage zurück – dieselbe Kette wie in passkeys.js.
  const nextFixed = next ? { ...next, rpID: next.hostname } : envAddress();
  const nextRpID = rpIdOf(nextFixed, seen);

  const passkeys =
    now.passkeys.count > 0 && nextRpID !== now.rpID
      ? { ...now.passkeys, from: now.rpID, to: nextRpID }
      : null;

  // Ist der Browser gerade über https verbunden? Solange der Schalter aus
  // ist, glaubt Streamo X-Forwarded-Proto nicht und sieht deshalb "http",
  // auch wenn der Proxy längst HTTPS ausliefert. Für diese eine Frage zählt
  // aber, was nach dem Umlegen gälte – also der Header, so wie er ankommt.
  // Wer ihn fälscht, schadet höchstens sich selbst: Er unterdrückt eine
  // Warnung, die für ihn gedacht war.
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const browserOnHttps = seen.protocol === 'https' || forwardedProto === 'https';

  const willTrustProxy = trustProxy === undefined ? now.trustProxy : Boolean(trustProxy);
  const insecureLogin = willTrustProxy && !now.trustProxy && !browserOnHttps;

  return {
    origin: next?.origin ?? null,
    passkeys,
    insecureLogin,
    // Hinweis, wenn es nach dem Speichern über http weitergeht: Links
    // funktionieren dann, Passkeys nicht.
    plainHttp: next?.protocol === 'http',
  };
}

/**
 * Speichert Domain und Proxy-Schalter.
 *
 * Eine leere Domain entfernt den Eintrag: Danach gilt wieder, was in der
 * .env steht, oder die Adresse aus der Anfrage.
 *
 * @param {{domain?: string, trustProxy?: boolean}} body
 * @returns {{origin: string|null}}
 * @throws {AddressError}
 */
export function saveAddress({ domain, trustProxy } = {}) {
  // Erst prüfen, dann schreiben – sonst bliebe bei einer kaputten Eingabe
  // womöglich nur die Hälfte gespeichert.
  const parsed = parseDomain(domain);

  // Nur anfassen, was mitgeschickt wurde. Eine Anfrage, die bloß den
  // Proxy-Schalter umlegt, soll die Domain nicht nebenbei löschen.
  if (domain !== undefined) setSetting(ORIGIN_KEY, parsed ? parsed.origin : null);
  if (trustProxy !== undefined) setSetting(PROXY_KEY, trustProxy ? '1' : '0');

  return { origin: storedAddress()?.origin ?? null };
}
