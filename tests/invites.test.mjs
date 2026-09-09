/**
 * ---------------------------------------------------------------------------
 * tests/invites.test.mjs – Einladungen
 * ---------------------------------------------------------------------------
 * Ausführen:  npm run test:invites
 *
 * Einladungen sind der Weg, jemanden mitmachen zu lassen, ohne dass er sich
 * mit TMDB, Servern oder Installation befassen muss. Entsprechend wichtig ist,
 * dass sie sich verhalten wie versprochen:
 *
 *   - Eine Einladung gilt begrenzt: nach Anzahl der Nutzungen und nach Zeit.
 *   - Aufgebrauchte und abgelaufene werden erkannt, nicht stillschweigend
 *     durchgewunken.
 *   - Widerrufen wirkt sofort.
 *
 * Der zweite Punkt ist der wichtigste. Eine Einladung, die versehentlich
 * unbegrenzt gilt, ist ein offenes Tor zur eigenen Instanz.
 * ---------------------------------------------------------------------------
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamo-invites-'));
process.env.DATA_DIR = tempDir;

const { db, run, get, all } = await import('../src/db.js');
const invites = await import('../src/invites.js');

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

console.log('\nStreamo – Einladungen\n');

run("INSERT INTO users (username, password_hash) VALUES ('morni','x:y')");
const admin = get("SELECT id FROM users WHERE username='morni'").id;

// ===========================================================================
// Erzeugen
// ===========================================================================
console.log('Erzeugen');

const invite = invites.createInvite(admin, { note: 'für Lisa' });

check('Ein Token wird vergeben', typeof invite.token === 'string' && invite.token.length >= 20, true);
check('Die Notiz ist gespeichert', invite.note, 'für Lisa');
check('Vorgabe: einmal nutzbar', invite.uses_left, 1);
check('Und mit Ablaufdatum', Boolean(invite.expires_at), true);
check('Noch nicht benutzt', invite.used_count, 0);

check('Zwei Einladungen haben verschiedene Token',
  invites.createInvite(admin, {}).token !== invite.token, true);

// ===========================================================================
// Prüfen und Einlösen
// ===========================================================================
console.log('\nEinlösen');

check('Die frische Einladung gilt', invites.checkInvite(invite.token).valid, true);

invites.consumeInvite(invite.token);

const used = invites.checkInvite(invite.token);
check('Nach dem Einlösen gilt sie nicht mehr', used.valid, false);
check('Mit passender Begründung', used.reason, 'Diese Einladung wurde bereits verwendet.');
check(
  'Die Nutzung wurde gezählt',
  get('SELECT used_count FROM invites WHERE token = ?', invite.token).used_count,
  1,
);

console.log('\nUnbekannte Token');

check('Ein erfundener Token gilt nicht', invites.checkInvite('erfunden').valid, false);
check('Ein leerer auch nicht', invites.checkInvite('').valid, false);
check('Und undefined ebenso wenig', invites.checkInvite(undefined).valid, false);

// ===========================================================================
// Mehrfach nutzbar
// ===========================================================================
console.log('\nMehrfach nutzbar');

const family = invites.createInvite(admin, { note: 'Familie', uses: 3 });

check('Dreimal nutzbar', family.uses_left, 3);

invites.consumeInvite(family.token);
check('Nach einmal noch gültig', invites.checkInvite(family.token).valid, true);
check(
  'Und zweimal übrig',
  get('SELECT uses_left FROM invites WHERE token = ?', family.token).uses_left,
  2,
);

invites.consumeInvite(family.token);
invites.consumeInvite(family.token);
check('Nach dreimal aufgebraucht', invites.checkInvite(family.token).valid, false);

// ===========================================================================
// Unbegrenzt
// ===========================================================================
console.log('\nUnbegrenzt');

const forever = invites.createInvite(admin, { uses: null, days: null });

check('Kein Nutzungslimit', forever.uses_left, null);
check('Kein Ablaufdatum', forever.expires_at, null);

for (let i = 0; i < 5; i++) invites.consumeInvite(forever.token);

check('Auch nach fünf Nutzungen gültig', invites.checkInvite(forever.token).valid, true);
check(
  'Die Nutzungen werden trotzdem gezählt',
  get('SELECT used_count FROM invites WHERE token = ?', forever.token).used_count,
  5,
);

// ===========================================================================
// Ablauf
// ===========================================================================
console.log('\nAblauf');

// Eine Einladung mit Ablauf in der Vergangenheit – so lässt sich der Fall
// prüfen, ohne warten zu müssen.
const expired = invites.createInvite(admin, {});
run(
  "UPDATE invites SET expires_at = datetime('now', '-1 day') WHERE token = ?",
  expired.token,
);

const expiredCheck = invites.checkInvite(expired.token);
check('Eine abgelaufene Einladung gilt nicht', expiredCheck.valid, false);
check('Mit passender Begründung', expiredCheck.reason, 'Diese Einladung ist abgelaufen.');

// ===========================================================================
// Verwalten
// ===========================================================================
console.log('\nVerwalten');

const list = invites.listInvites();
check('Alle Einladungen erscheinen in der Liste', list.length >= 5, true);

const foreverEntry = list.find((entry) => entry.token === forever.token);
check('Die unbegrenzte ist als nutzbar erkennbar', foreverEntry?.usable, true);
check('Und zeigt ihre Nutzungen', foreverEntry?.usedCount, 5);

const expiredEntry = list.find((entry) => entry.token === expired.token);
check('Die abgelaufene ist als solche erkennbar', expiredEntry?.expired, true);
check('Und nicht mehr nutzbar', expiredEntry?.usable, false);

check('Widerrufen funktioniert', invites.revokeInvite(forever.token), true);
check('Danach gilt sie nicht mehr', invites.checkInvite(forever.token).valid, false);
check('Ein zweites Widerrufen meldet, dass nichts da war', invites.revokeInvite(forever.token), false);

console.log('\nAufräumen');

const before = all('SELECT * FROM invites').length;
const pruned = invites.pruneInvites();

check('Abgelaufene und aufgebrauchte werden entfernt', pruned > 0, true);
check(
  'Es bleiben nur die nutzbaren',
  all('SELECT * FROM invites').length,
  before - pruned,
);
check(
  'Und die sind alle noch gültig',
  invites.listInvites().every((entry) => entry.usable),
  true,
);

// ===========================================================================
// Löschen des Erstellers
// ===========================================================================
console.log('\nLöschen des Erstellers');

const remaining = invites.createInvite(admin, { note: 'bleibt' });
run('DELETE FROM users WHERE id = ?', admin);

check(
  'Die Einladung überlebt – sie gehört zur Instanz, nicht zur Person',
  invites.checkInvite(remaining.token).valid,
  true,
);
check(
  'Der Ersteller ist dann unbekannt',
  get('SELECT created_by FROM invites WHERE token = ?', remaining.token).created_by,
  null,
);

// ===========================================================================
console.log('');
console.log(
  failures === 0
    ? `Alle ${checks} Prüfungen bestanden.\n`
    : `${failures} von ${checks} Prüfungen fehlgeschlagen.\n`,
);

db.close();
try {
  fs.rmSync(tempDir, { recursive: true, force: true });
} catch {
  /* Windows lässt geöffnete Dateien nicht löschen – unkritisch */
}

process.exit(failures === 0 ? 0 : 1);
