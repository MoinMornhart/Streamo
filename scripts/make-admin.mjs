/**
 * ---------------------------------------------------------------------------
 * scripts/make-admin.mjs – Adminrechte vergeben und entziehen
 * ---------------------------------------------------------------------------
 * Aufruf im Container:
 *
 *   streamo admin morni            Adminrechte geben
 *   streamo admin morni --entzug   Adminrechte wieder nehmen
 *   streamo admin                  Alle Konten auflisten
 *
 * Warum es das gibt:
 *   Adminrechte bekommt automatisch nur das allererste Konto, das über den
 *   Einrichtungsassistenten entsteht. Wer später über eine Einladung dazukommt,
 *   ist ein gewöhnlicher Benutzer – und in der Oberfläche gibt es bewusst
 *   keinen Knopf, mit dem man sich selbst befördert.
 *
 *   Dieses Skript ist deshalb der vorgesehene Weg, und es läuft auf dem
 *   Server: Wer dort eine Shell hat, hat ohnehin Zugriff auf die Datenbank.
 *
 * Warum ein Skript und keine SQL-Zeile zum Kopieren:
 *   Eine SQL-Zeile aus einer Nachricht abzutippen geht schief – ein Tippfehler
 *   in der WHERE-Bedingung, und alle Konten sind Administratoren. Dieses
 *   Skript prüft vorher, ob es das Konto überhaupt gibt, und sagt hinterher,
 *   was sich geändert hat.
 *
 * Verknüpfungen:
 *   - src/db.js -> Tabelle users, Spalte is_admin
 *   - scripts/install/install-commands.sh -> das Kommando "streamo admin"
 *   - src/auth.js -> requireAdmin() wertet is_admin aus
 * ---------------------------------------------------------------------------
 */

import { get, all, run } from '../src/db.js';

// Farben für die Ausgabe, damit sich Wichtiges abhebt. Dieselben Kürzel wie
// in den Shell-Skripten daneben.
const GN = '\x1b[32m';
const RD = '\x1b[31m';
const BL = '\x1b[36m';
const CL = '\x1b[0m';

/**
 * Zeigt alle Konten mit ihrem Rang.
 *
 * Gedacht als Hilfe, wenn man den genauen Schreibweise des Benutzernamens
 * nicht mehr weiß – und als Kontrolle danach.
 */
function listUsers() {
  const users = all(
    `SELECT username, display_name, is_admin, created_at
       FROM users
      ORDER BY is_admin DESC, username`,
  );

  if (users.length === 0) {
    console.log('\n  Es gibt noch kein Konto. Richte Streamo zuerst im Browser ein.\n');
    return;
  }

  console.log('');
  console.log(`  ${BL}Konten auf dieser Instanz${CL}`);
  console.log('');

  for (const user of users) {
    const rank = user.is_admin ? `${GN}Administrator${CL}` : 'Benutzer';
    const name = user.display_name && user.display_name !== user.username
      ? `${user.username} (${user.display_name})`
      : user.username;

    console.log(`   ${user.is_admin ? '★' : ' '} ${name.padEnd(28)} ${rank}`);
  }

  console.log('');
  console.log(`  Rechte vergeben:  ${GN}streamo admin <benutzername>${CL}`);
  console.log(`  Rechte entziehen: ${GN}streamo admin <benutzername> --entzug${CL}`);
  console.log('');
}

// ---------------------------------------------------------------------------
// Aufruf auswerten
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);

// Der Schalter darf an jeder Stelle stehen; alles andere ist der Name.
const revoke = args.includes('--entzug') || args.includes('--revoke');
const username = args.find((argument) => !argument.startsWith('--'));

if (!username) {
  listUsers();
  process.exit(0);
}

const user = get('SELECT id, username, is_admin FROM users WHERE username = ?', username);

if (!user) {
  console.log('');
  console.log(`  ${RD}Ein Konto namens "${username}" gibt es nicht.${CL}`);
  console.log('');

  listUsers();
  process.exit(1);
}

// Nichts zu tun? Dann auch nichts schreiben – und das ehrlich sagen.
if (Boolean(user.is_admin) === !revoke) {
  console.log('');
  console.log(
    `  ${user.username} ist bereits ${user.is_admin ? 'Administrator' : 'ein gewöhnlicher Benutzer'}. Nichts geändert.`,
  );
  console.log('');
  process.exit(0);
}

// Der letzte Administrator darf sich nicht selbst entmachten: Sonst könnte
// niemand mehr den TMDB-Key ändern, Einladungen erzeugen oder den Abgleich
// starten – und zurück käme man nur noch über dieses Skript.
if (revoke) {
  const admins = get('SELECT COUNT(*) AS count FROM users WHERE is_admin = 1').count;

  if (admins <= 1) {
    console.log('');
    console.log(`  ${RD}Das ist der einzige Administrator.${CL}`);
    console.log('  Gib zuerst jemand anderem die Rechte, sonst bleibt niemand übrig.');
    console.log('');
    process.exit(1);
  }
}

run('UPDATE users SET is_admin = ? WHERE id = ?', revoke ? 0 : 1, user.id);

console.log('');
console.log(
  revoke
    ? `  ${GN}✓${CL} ${user.username} ist jetzt ein gewöhnlicher Benutzer.`
    : `  ${GN}✓${CL} ${user.username} ist jetzt Administrator.`,
);
console.log('');
console.log('  Die Änderung gilt sofort. In einer offenen Sitzung wird sie nach');
console.log('  dem nächsten Neuladen der Seite sichtbar.');
console.log('');
