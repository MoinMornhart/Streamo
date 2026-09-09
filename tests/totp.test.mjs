/**
 * ---------------------------------------------------------------------------
 * tests/totp.test.mjs – Die Einmalcodes der Zwei-Faktor-Anmeldung
 * ---------------------------------------------------------------------------
 * Ausführen:  npm run test:totp
 *
 * Hier wird selbstgeschriebene Sicherheitstechnik geprüft, und dafür reicht
 * "sieht plausibel aus" nicht. Zum Glück ist das gar nicht nötig: RFC 4226
 * (HOTP) und RFC 6238 (TOTP) bringen offizielle Testvektoren mit – feste
 * Paare aus Eingabe und erwartetem Code. Stimmen die, rechnet Streamo
 * dasselbe wie jede Authenticator-App der Welt.
 *
 * Genauso wichtig ist die andere Richtung: Ein Prüfverfahren, das alles
 * durchwinkt, wäre schlimmer als keines. Der zweite Teil prüft deshalb, dass
 * falsche Codes, alte Codes und leere Eingaben abgelehnt werden.
 * ---------------------------------------------------------------------------
 */

import {
  base32Encode,
  base32Decode,
  generateSecret,
  generateCode,
  verifyCode,
  buildOtpAuthUrl,
  formatSecret,
  generateBackupCodes,
  normalizeBackupCode,
  hashBackupCode,
  TIME_STEP_SECONDS,
} from '../src/totp.js';

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

console.log('\nStreamo – Einmalcodes (TOTP)\n');

// ===========================================================================
// Base32
// ===========================================================================
console.log('Base32 (RFC 4648, Testvektoren aus Abschnitt 10)');

// Die Norm listet diese Paare ausdrücklich auf. Wir lassen das Auffüllen mit
// "=" weg, deshalb sind die erwarteten Werte hier ohne.
const base32Cases = [
  ['', ''],
  ['f', 'MY'],
  ['fo', 'MZXQ'],
  ['foo', 'MZXW6'],
  ['foob', 'MZXW6YQ'],
  ['fooba', 'MZXW6YTB'],
  ['foobar', 'MZXW6YTBOI'],
];

for (const [plain, encoded] of base32Cases) {
  check(`"${plain}" wird zu "${encoded}"`, base32Encode(Buffer.from(plain)), encoded);
}

for (const [plain, encoded] of base32Cases) {
  check(`"${encoded}" wird wieder zu "${plain}"`, base32Decode(encoded).toString(), plain);
}

console.log('\nBase32 verzeiht, was Menschen tippen');

check('Kleinbuchstaben gehen auch', base32Decode('mzxw6ytboi').toString(), 'foobar');
check('Leerzeichen stören nicht', base32Decode('MZXW 6YTB OI').toString(), 'foobar');
check('Bindestriche auch nicht', base32Decode('MZXW-6YTB-OI').toString(), 'foobar');
check('Angehängte Gleichheitszeichen werden übergangen', base32Decode('MZXW6===').toString(), 'foo');

let threw = false;
try {
  base32Decode('MZXW1!');
} catch {
  threw = true;
}
check('Ein unmögliches Zeichen wird gemeldet, nicht verschluckt', threw, true);

// ===========================================================================
// Die offiziellen TOTP-Testvektoren
// ===========================================================================
console.log('\nTestvektoren aus RFC 6238 (Anhang B)');

// Die Norm rechnet mit dem Geheimnis "12345678901234567890" als ASCII-Bytes.
// In Base32 – der Form, in der Streamo Geheimnisse hält – ist das:
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

check('Das Geheimnis der Norm in Base32', RFC_SECRET, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');

// Zeitpunkt (Sekunden seit 1970) -> erwarteter Code. Die Norm listet acht
// Stellen; Streamo nutzt sechs, deshalb stehen hier die letzten sechs davon.
//
//   Zeit          RFC (8 Stellen)   davon 6
//   59            94287082          287082
//   1111111109    07081804          081804
//   1111111111    14050471          050471
//   1234567890    89005924          005924
//   2000000000    69279037          279037
//   20000000000   65353130          353130
const rfcVectors = [
  [59, '287082'],
  [1111111109, '081804'],
  [1111111111, '050471'],
  [1234567890, '005924'],
  [2000000000, '279037'],
  [20000000000, '353130'],
];

for (const [seconds, expected] of rfcVectors) {
  check(
    `Sekunde ${seconds} ergibt ${expected}`,
    generateCode(RFC_SECRET, seconds * 1000),
    expected,
  );
}

// Der letzte Vektor liegt jenseits von 2^31 Sekunden. Er ist der Grund, warum
// der Zähler als BigInt gerechnet wird – mit gewöhnlichen Bit-Operationen
// wäre er abgeschnitten worden und der Code falsch.
check(
  'Auch jenseits der 32-Bit-Grenze stimmt der Code',
  generateCode(RFC_SECRET, 20000000000 * 1000),
  '353130',
);

// ===========================================================================
// Prüfen
// ===========================================================================
console.log('\nEinen eingegebenen Code prüfen');

const now = 1234567890 * 1000;

check(
  'Der richtige Code wird angenommen',
  verifyCode(RFC_SECRET, '005924', { forTime: now }),
  true,
);
check(
  'Mit Leerzeichen getippt ebenso',
  verifyCode(RFC_SECRET, '005 924', { forTime: now }),
  true,
);

check(
  'Der Code des vorigen Zeitschritts gilt noch – die Uhr des Telefons weicht ab',
  verifyCode(RFC_SECRET, generateCode(RFC_SECRET, now - TIME_STEP_SECONDS * 1000), {
    forTime: now,
  }),
  true,
);
check(
  'Und der des nächsten',
  verifyCode(RFC_SECRET, generateCode(RFC_SECRET, now + TIME_STEP_SECONDS * 1000), {
    forTime: now,
  }),
  true,
);

check(
  'Ein zwei Schritte alter Code nicht mehr',
  verifyCode(RFC_SECRET, generateCode(RFC_SECRET, now - 2 * TIME_STEP_SECONDS * 1000), {
    forTime: now,
  }),
  false,
);

console.log('\nWas abgelehnt werden muss');

check('Ein falscher Code', verifyCode(RFC_SECRET, '000000', { forTime: now }), false);
check('Ein zu kurzer', verifyCode(RFC_SECRET, '5924', { forTime: now }), false);
check('Ein zu langer', verifyCode(RFC_SECRET, '00592412', { forTime: now }), false);
check('Ein leerer', verifyCode(RFC_SECRET, '', { forTime: now }), false);
check('Gar keiner', verifyCode(RFC_SECRET, undefined, { forTime: now }), false);
check('Buchstaben statt Ziffern', verifyCode(RFC_SECRET, 'abcdef', { forTime: now }), false);
check('Ohne Geheimnis geht nichts', verifyCode('', '005924', { forTime: now }), false);
check('Und mit einem fremden Geheimnis auch nicht',
  verifyCode(generateSecret(), '005924', { forTime: now }), false);

// ===========================================================================
// Neue Geheimnisse
// ===========================================================================
console.log('\nNeue Geheimnisse');

const secret = generateSecret();

check('Sind 32 Zeichen lang', secret.length, 32);
check('Und enthalten nur das Base32-Alphabet', /^[A-Z2-7]+$/.test(secret), true);
check('Zwei hintereinander sind verschieden', generateSecret() !== generateSecret(), true);

check(
  'Ein frisches Geheimnis erzeugt einen Code, der sich selbst bestätigt',
  verifyCode(secret, generateCode(secret)),
  true,
);

// ===========================================================================
// Die Einrichtungsadresse
// ===========================================================================
console.log('\nDie Adresse für die Authenticator-App');

const url = buildOtpAuthUrl({ secret: 'ABCDEF', account: 'max', issuer: 'Streamo' });

check('Beginnt wie vorgeschrieben', url.startsWith('otpauth://totp/'), true);
check('Nennt Herausgeber und Konto', url.includes('Streamo:max'), true);
check('Enthält das Geheimnis', url.includes('secret=ABCDEF'), true);
check('Sechs Stellen', url.includes('digits=6'), true);
check('Alle 30 Sekunden', url.includes('period=30'), true);

const trickyUrl = buildOtpAuthUrl({ secret: 'ABCDEF', account: 'max mustermann' });
check(
  'Ein Leerzeichen im Namen wird kodiert',
  trickyUrl.includes('Streamo:max%20mustermann'),
  true,
);

check(
  'Das Geheimnis wird in Vierergruppen lesbar gemacht',
  formatSecret('JBSWY3DPEHPK3PXP'),
  'JBSW Y3DP EHPK 3PXP',
);

// ===========================================================================
// Ersatzcodes
// ===========================================================================
console.log('\nErsatzcodes für ein verlorenes Telefon');

const backupCodes = generateBackupCodes();

check('Es sind zehn', backupCodes.length, 10);
check('Alle im Format AAAA-BBBB', backupCodes.every((c) => /^[A-Z2-7]{4}-[A-Z2-7]{4}$/.test(c)), true);
check('Und alle verschieden', new Set(backupCodes).size, 10);

check(
  'Beim Vergleich fällt der Bindestrich weg',
  normalizeBackupCode('a3kp-9rtm'),
  'A3KP9RTM',
);
check('Leerzeichen ebenso', normalizeBackupCode('A3KP 9RTM'), 'A3KP9RTM');

check(
  'Derselbe Code ergibt denselben Speicherwert, egal wie getippt',
  hashBackupCode('a3kp-9rtm'),
  hashBackupCode('A3KP9RTM'),
);
check(
  'Verschiedene Codes ergeben verschiedene Werte',
  hashBackupCode('A3KP-9RTM') !== hashBackupCode('B3KP-9RTM'),
  true,
);
check(
  'Der Klartext taucht im Speicherwert nicht auf',
  hashBackupCode('A3KP-9RTM').includes('A3KP'),
  false,
);

// ===========================================================================
console.log('');
console.log(
  failures === 0
    ? `Alle ${checks} Prüfungen bestanden.\n`
    : `${failures} von ${checks} Prüfungen fehlgeschlagen.\n`,
);

process.exit(failures === 0 ? 0 : 1);
