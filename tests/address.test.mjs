/**
 * ---------------------------------------------------------------------------
 * tests/address.test.mjs – Adresse & Domain
 * ---------------------------------------------------------------------------
 * Ausführen:  npm run test:address
 *
 * Seit sich die Domain in den Einstellungen eintragen lässt, hängt viel an
 * src/address.js: Passkeys, die Links in Kalender, Einladungen und geteilten
 * Listen, der Proxy-Schalter und das selbst erzeugte Zertifikat. Geprüft wird:
 *
 *   - Eingaben werden sauber ("Streamo.Example.de/" -> https://streamo.example.de),
 *     Unbrauchbares wird abgelehnt statt still verbogen
 *   - die Rangfolge: Einstellungen vor .env vor der Anfrage
 *   - Kopfzeilen eines Proxys gelten nur mit eingeschaltetem Schalter
 *   - Passkeys nehmen die eingetragene Domain – und sagen, wenn man unter
 *     der falschen Adresse unterwegs ist
 *   - die Rückfrage vor dem Speichern nennt betroffene Passkeys und eine
 *     abreißende Anmeldung über http://
 *   - das selbst erzeugte Zertifikat folgt der Domain (nur mit openssl)
 * ---------------------------------------------------------------------------
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamo-address-'));
process.env.DATA_DIR = tempDir;
// Streamo macht in diesem Test selbst HTTPS – nur so wird das Zertifikat
// überhaupt angefasst. Proxy und Domain aus der .env bleiben leer.
process.env.ENABLE_HTTPS = 'true';
process.env.TLS_HOSTNAME = 'streamo.local';
delete process.env.TRUST_PROXY;
delete process.env.WEBAUTHN_ORIGIN;
delete process.env.WEBAUTHN_RP_ID;

const { run } = await import('../src/db.js');
const address = await import('../src/address.js');
const { getWebAuthnContext } = await import('../src/passkeys.js');
const tls = await import('../src/tls.js');

let failures = 0;
let checks = 0;

/**
 * Vergleicht zwei Werte strukturell.
 * @param {string} label
 * @param {any} actual
 * @param {any} expected
 */
function check(label, actual, expected) {
  checks++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    `${ok ? '  ok  ' : '  FAIL'} ${label}` +
      (ok
        ? ''
        : `\n        erwartet: ${JSON.stringify(expected)}\n        erhalten: ${JSON.stringify(actual)}`),
  );
}

/** Fehlermeldung einer Funktion, oder null, wenn sie nicht wirft. */
function errorOf(fn) {
  try {
    fn();
    return null;
  } catch (error) {
    return error.message;
  }
}

/**
 * Eine Anfrage, wie Express sie liefert – nur mit dem, was hier gebraucht wird.
 * @param {string} host
 * @param {object} [extra] weitere Kopfzeilen, protocol
 */
function request(host, { protocol = 'http', ...headers } = {}) {
  return { protocol, headers: { host, ...headers }, socket: { remoteAddress: '10.0.0.5' } };
}

console.log('');
console.log('Streamo – Adresse & Domain');

// ===========================================================================
console.log('\nEingaben');
// ===========================================================================
check(
  'Großschreibung und Schrägstrich am Ende',
  address.parseDomain('Streamo.Example.de/'),
  { origin: 'https://streamo.example.de', hostname: 'streamo.example.de', protocol: 'https' },
);
check('Ohne Schema ist https gemeint', address.parseDomain('streamo.example.de').origin, 'https://streamo.example.de');
check('http bleibt http', address.parseDomain('http://streamo.lan:3000').origin, 'http://streamo.lan:3000');
check('Standardport fällt weg', address.parseDomain('https://x.de:443').origin, 'https://x.de');
check('Leer heißt: nichts eintragen', address.parseDomain('   '), null);
check('Ein Pfad wird abgelehnt', errorOf(() => address.parseDomain('x.de/streamo')), 'Bitte nur die Domain eintragen, ohne Pfad – etwa streamo.example.de.');
check('Fremdes Schema wird abgelehnt', errorOf(() => address.parseDomain('ftp://x.de')), 'Die Adresse muss mit https:// oder http:// beginnen.');
check('Zugangsdaten werden abgelehnt', errorOf(() => address.parseDomain('user:pw@x.de')), 'Zugangsdaten gehören nicht in die Adresse.');
check('Fehler tragen Status 400', (() => { try { address.parseDomain('x.de?a=1'); } catch (e) { return e.status; } })(), 400);

// ===========================================================================
console.log('\nOhne eingetragene Domain: wie bisher aus der Anfrage');
// ===========================================================================
check('Nichts fest eingetragen', address.configuredAddress(), null);
check('Link aus der Anfrage', address.publicBaseUrl(request('192.168.1.20:3000')), 'http://192.168.1.20:3000');
check('Proxy-Schalter steht auf der .env-Vorgabe (aus)', address.trustsProxy(), false);
check(
  'Ohne Schalter werden X-Forwarded-* nicht geglaubt',
  address.publicBaseUrl(request('10.0.0.2:3000', { 'x-forwarded-host': 'boese.example', 'x-forwarded-proto': 'https' })),
  'http://10.0.0.2:3000',
);

address.saveAddress({ trustProxy: true });
check('Schalter an', address.trustsProxy(), true);
check(
  'Mit Schalter gilt, was der Proxy meldet',
  address.publicBaseUrl(request('10.0.0.2:3000', { 'x-forwarded-host': 'streamo.example.de', 'x-forwarded-proto': 'https' })),
  'https://streamo.example.de',
);
check('Nur den Schalter speichern lässt die Domain in Ruhe', address.storedAddress(), null);

// ===========================================================================
console.log('\nMit eingetragener Domain');
// ===========================================================================
address.saveAddress({ domain: 'neu.example.de' });
check('Gespeichert, aus den Einstellungen', address.configuredAddress()?.source, 'einstellungen');
check('Links nehmen die Domain – auch beim Aufruf über die IP', address.publicBaseUrl(request('192.168.1.20:3000')), 'https://neu.example.de');
check('Die Domain ohne Angabe lässt den Proxy-Schalter stehen', address.trustsProxy(), true);

let ctx = getWebAuthnContext(request('192.168.1.20:3000', { 'x-forwarded-for': '1.2.3.4', 'x-forwarded-proto': 'https' }));
check('Passkeys: rpID ist die Domain', ctx.rpID, 'neu.example.de');
check('Passkeys: Origin ist die Domain', ctx.origin, 'https://neu.example.de');
check('Passkeys: verfügbar, auch wenn der Proxy den Host verschluckt', ctx.available, true);

ctx = getWebAuthnContext(request('alt.example.de', { 'x-forwarded-for': '1.2.3.4', 'x-forwarded-proto': 'https' }));
check('Passkeys: unter der alten Domain nicht verfügbar', ctx.available, false);
check(
  'Passkeys: sagt, wo es richtig wäre',
  ctx.reason,
  'Passkeys gelten für https://neu.example.de, du bist aber über https://alt.example.de hier. Ruf Streamo unter https://neu.example.de auf.',
);

address.saveAddress({ domain: 'http://streamo.lan' });
ctx = getWebAuthnContext(request('streamo.lan'));
check('Passkeys: mit http-Adresse nicht verfügbar', ctx.available, false);

// ===========================================================================
console.log('\nRückfrage vor dem Speichern');
// ===========================================================================
address.saveAddress({ domain: 'neu.example.de', trustProxy: false });
run("INSERT INTO users (username, password_hash) VALUES ('anna', 'x'), ('ben', 'x')");
run("INSERT INTO credentials (id, user_id, public_key) VALUES ('a1', 1, 'k'), ('a2', 1, 'k'), ('b1', 2, 'k')");

let preview = address.previewAddressChange(request('neu.example.de', { protocol: 'https' }), { domain: 'anders.example.de' });
check('Passkeys betroffen: Anzahl, Personen, von, nach', preview.passkeys, { count: 3, users: 2, from: 'neu.example.de', to: 'anders.example.de' });

preview = address.previewAddressChange(request('neu.example.de', { protocol: 'https' }), { domain: 'https://NEU.example.de/' });
check('Gleiche Domain anders geschrieben: keine Passkeys betroffen', preview.passkeys, null);

preview = address.previewAddressChange(request('192.168.1.20:3000'), { domain: 'neu.example.de', trustProxy: true });
check('Proxy einschalten über http: Warnung', preview.insecureLogin, true);

preview = address.previewAddressChange(request('neu.example.de', { protocol: 'https' }), { domain: 'neu.example.de', trustProxy: true });
check('Proxy einschalten über https: keine Warnung', preview.insecureLogin, false);

// Der häufigste Fall beim Einrichten: Der Proxy liefert schon HTTPS aus, der
// Schalter ist aber noch aus – Streamo selbst sieht deshalb "http".
preview = address.previewAddressChange(
  request('neu.example.de', { 'x-forwarded-proto': 'https', 'x-forwarded-for': '1.2.3.4' }),
  { domain: 'neu.example.de', trustProxy: true },
);
check('Proxy einschalten, Proxy liefert schon HTTPS: keine Warnung', preview.insecureLogin, false);

check('Vorab-Prüfung speichert nichts', address.storedAddress()?.origin, 'https://neu.example.de');
check(
  'Vorab-Prüfung lehnt Unbrauchbares ab',
  errorOf(() => address.previewAddressChange(request('x'), { domain: 'x.de/pfad' })),
  'Bitte nur die Domain eintragen, ohne Pfad – etwa streamo.example.de.',
);

// ===========================================================================
console.log('\nZurück auf "nichts eingetragen"');
// ===========================================================================
address.saveAddress({ domain: '' });
check('Domain entfernt', address.configuredAddress(), null);
check('Links wieder aus der Anfrage', address.publicBaseUrl(request('192.168.1.20:3000')), 'http://192.168.1.20:3000');

// ===========================================================================
console.log('\nDie .env als Rückfall');
// ===========================================================================
// config.js liest die .env einmal beim Laden – deshalb ein eigener Prozess.
const envDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamo-address-env-'));
const here = path.dirname(fileURLToPath(import.meta.url));
const probe = execFileSync(
  process.execPath,
  [
    '--no-warnings',
    '--input-type=module',
    '-e',
    `const a = await import(${JSON.stringify(path.join(here, '../src/address.js'))});
     const before = a.configuredAddress();
     a.saveAddress({ domain: 'dashboard.example.de' });
     const after = a.configuredAddress();
     a.saveAddress({ domain: '' });
     const back = a.configuredAddress();
     console.log(JSON.stringify([before, after.origin, after.source, back.origin, back.rpID]));`,
  ],
  {
    env: {
      ...process.env,
      DATA_DIR: envDir,
      WEBAUTHN_ORIGIN: 'https://streamo.example.de',
      WEBAUTHN_RP_ID: 'example.de',
    },
  },
).toString();
const [envBefore, dashboardOrigin, dashboardSource, backOrigin, backRpId] = JSON.parse(probe);
check('.env gilt, solange in den Einstellungen nichts steht', envBefore.source, '.env');
check('.env darf eine abweichende rpID haben', envBefore.rpID, 'example.de');
check('Einstellungen stechen die .env', [dashboardOrigin, dashboardSource], ['https://dashboard.example.de', 'einstellungen']);
check('Leeren führt zurück auf die .env', [backOrigin, backRpId], ['https://streamo.example.de', 'example.de']);
fs.rmSync(envDir, { recursive: true, force: true });

// ===========================================================================
console.log('\nSelbst erzeugtes Zertifikat');
// ===========================================================================
let hasOpenssl = true;
try {
  execFileSync('openssl', ['version'], { stdio: 'ignore' });
} catch {
  hasOpenssl = false;
}

if (!hasOpenssl) {
  console.log('  (übersprungen – openssl fehlt)');
} else {
  // Die Meldungen von tls.js gehören nicht in die Testausgabe.
  const log = console.log;
  console.log = () => {};
  tls.getTlsOptions();
  const startHost = tls.certificateMatches('streamo.local');
  address.saveAddress({ domain: 'neu.example.de' });
  const renewed = tls.renewCertificateIfNeeded();
  const again = tls.renewCertificateIfNeeded();
  console.log = log;

  check('Beim Start auf TLS_HOSTNAME ausgestellt', startHost, true);
  check('Neue Domain: neu ausgestellt', renewed, { renewed: true, hostname: 'neu.example.de' });
  check('Und passt jetzt', tls.certificateMatches('neu.example.de'), true);
  check('Ein zweites Mal ist nichts zu tun', again.reason, 'passt');
}

// ---------------------------------------------------------------------------
fs.rmSync(tempDir, { recursive: true, force: true });

console.log('');
if (failures === 0) {
  console.log(`Alle ${checks} Prüfungen bestanden.`);
} else {
  console.log(`${failures} von ${checks} fehlgeschlagen.`);
  process.exit(1);
}
