/**
 * ---------------------------------------------------------------------------
 * tests/migration.test.mjs – Schema-Migration bestehender Installationen
 * ---------------------------------------------------------------------------
 * Ausführen:  npm run test:migration
 *
 * Wenn jemand "update" ausführt, trifft neuer Code auf eine ALTE Datenbank
 * voller echter Daten. Dieser Test baut genau diese Situation nach: Er erzeugt
 * eine Datenbank im Zustand vor der Passkey-Erweiterung, füllt sie mit
 * Benutzer, Bibliothek, Abos und Sehfortschritt, und lässt dann die Migration
 * darüberlaufen.
 *
 * Geprüft wird zweierlei:
 *   1. Das Schema wird korrekt erweitert (E-Mail-Spalte, Passkey-Tabelle).
 *   2. KEIN einziger vorhandener Datensatz geht verloren.
 *
 * Punkt 2 ist der eigentliche Grund für diesen Test. Ein Update, das die
 * Bibliothek löscht, wäre der schlimmste denkbare Fehler – und ein Fehler,
 * den man erst bemerkt, wenn es zu spät ist.
 *
 * Verknüpfungen:
 *   - src/db.js -> das MIGRATIONS-Array und PRAGMA user_version
 * ---------------------------------------------------------------------------
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let failures = 0;
let checks = 0;

/**
 * Vergleicht zwei Werte und protokolliert das Ergebnis.
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

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamo-migration-'));
process.env.DATA_DIR = tempDir;

console.log('\nStreamo – Migration einer bestehenden Installation\n');

// ===========================================================================
// Schritt 1: Eine Datenbank im ALTEN Zustand aufbauen
// ===========================================================================
// Der Import legt zunächst das aktuelle Schema an. Danach wird gezielt
// zurückgebaut, bis die Datenbank aussieht wie vor der Passkey-Erweiterung.
console.log('Ausgangslage: Installation mit Daten, Schema-Version 1');

const { db, run, get, all } = await import('../src/db.js');

run(
  `INSERT INTO users (username, display_name, password_hash, is_admin, region, language)
   VALUES ('morni','Morni','salt:hash',1,'DE','de-DE')`,
);
const userId = get("SELECT id FROM users WHERE username='morni'").id;

run('INSERT INTO user_providers (user_id, provider_id, name) VALUES (?,8,?)', userId, 'Netflix');
run('INSERT INTO user_providers (user_id, provider_id, name) VALUES (?,337,?)', userId, 'Disney Plus');

run(
  `INSERT INTO shows (tmdb_id, media_type, title, number_of_episodes)
   VALUES (1396,'tv','Breaking Bad',62)`,
);
const showId = get('SELECT id FROM shows WHERE tmdb_id=1396').id;

run(
  "INSERT INTO library (user_id, show_id, status, rating, favorite) VALUES (?,?,'watching',9,1)",
  userId,
  showId,
);
run(
  `INSERT INTO availability (show_id, region, provider_id, offer_type, name)
   VALUES (?,'DE',8,'flatrate','Netflix')`,
  showId,
);
run(
  "INSERT INTO episodes (show_id, season_number, episode_number, name) VALUES (?,1,1,'Pilot')",
  showId,
);
const episodeId = get('SELECT id FROM episodes WHERE show_id = ?', showId).id;
run(
  'INSERT INTO watched_episodes (user_id, episode_id, show_id) VALUES (?,?,?)',
  userId,
  episodeId,
  showId,
);
run(
  "INSERT INTO sessions (id, user_id, expires_at) VALUES ('token-alt', ?, datetime('now','+30 days'))",
  userId,
);

// Jetzt auf den alten Stand zurückbauen.
db.exec('DROP INDEX IF EXISTS idx_users_email');
db.exec('ALTER TABLE users DROP COLUMN email');
db.exec('DROP TABLE IF EXISTS credentials');
db.exec('PRAGMA user_version = 1');

check('Schema steht auf Version 1', db.prepare('PRAGMA user_version').get().user_version, 1);
check(
  'Die E-Mail-Spalte fehlt noch',
  db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'email'),
  false,
);

// Änderungen aus dem WAL in die Hauptdatei schreiben, damit der zweite
// Verbindungsaufbau denselben Stand sieht.
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
db.close();

// ===========================================================================
// Schritt 2: Das Update – neuer Code trifft auf die alte Datenbank
// ===========================================================================
console.log('\nNach dem Update');

// Ein frischer Import mit eigenem Modul-Cache. Der Zeitstempel im Query-String
// zwingt Node dazu, src/db.js wirklich neu auszuwerten und damit die
// Migrationen erneut zu durchlaufen.
const fresh = await import(`../src/db.js?migrated=${Date.now()}`);

check('Schema steht jetzt auf Version 2', fresh.db.prepare('PRAGMA user_version').get().user_version, 2);

check(
  'Die E-Mail-Spalte ist dazugekommen',
  fresh.db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'email'),
  true,
);

check(
  'Die Passkey-Tabelle wurde angelegt',
  fresh.db
    .prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='credentials'")
    .get().n,
  1,
);

check(
  'Der eindeutige Index auf die E-Mail existiert',
  fresh.db
    .prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='index' AND name='idx_users_email'")
    .get().n,
  1,
);

// ===========================================================================
// Schritt 3: Und das Wichtigste – nichts ist verloren gegangen
// ===========================================================================
console.log('\nBestehende Daten');

const user = fresh.get('SELECT * FROM users WHERE username = ?', 'morni');
check('Der Benutzer ist noch da', user?.username, 'morni');
check('Sein Anzeigename ist unverändert', user?.display_name, 'Morni');
check('Seine Adminrechte sind unverändert', user?.is_admin, 1);
check('Sein Passwort-Hash ist unverändert', user?.password_hash, 'salt:hash');
check('Die neue E-Mail-Spalte ist leer', user?.email, null);

check('Beide Abos sind erhalten', fresh.all('SELECT * FROM user_providers').length, 2);
check('Der Bibliothekseintrag ist erhalten', fresh.get('SELECT COUNT(*) n FROM library').n, 1);
check('Die Bewertung ist erhalten', fresh.get('SELECT rating FROM library').rating, 9);
check('Die Serie ist erhalten', fresh.get('SELECT title FROM shows').title, 'Breaking Bad');
check('Die Verfügbarkeit ist erhalten', fresh.get('SELECT COUNT(*) n FROM availability').n, 1);
check('Der Sehfortschritt ist erhalten', fresh.get('SELECT COUNT(*) n FROM watched_episodes').n, 1);
check(
  'Die Anmeldung bleibt bestehen (kein erneutes Login nötig)',
  fresh.get('SELECT COUNT(*) n FROM sessions').n,
  1,
);

// ===========================================================================
// Schritt 4: Ein zweites Update darf nichts mehr tun
// ===========================================================================
console.log('\nWiederholtes Update');

const again = await import(`../src/db.js?migrated=${Date.now()}-2`);
check('Version bleibt bei 2', again.db.prepare('PRAGMA user_version').get().user_version, 2);
check('Keine doppelten Benutzer', again.get('SELECT COUNT(*) n FROM users').n, 1);
check('Bibliothek unverändert', again.get('SELECT COUNT(*) n FROM library').n, 1);

// ===========================================================================
// Ergebnis
// ===========================================================================
console.log('');
console.log(
  failures === 0
    ? `Alle ${checks} Prüfungen bestanden.\n`
    : `${failures} von ${checks} Prüfungen fehlgeschlagen.\n`,
);

// Aufräumen. Unter Windows lässt sich eine geöffnete Datei nicht löschen,
// deshalb erst alle Verbindungen schließen.
for (const mod of [fresh, again]) {
  try {
    mod.db.close();
  } catch {
    /* war schon geschlossen */
  }
}

try {
  fs.rmSync(tempDir, { recursive: true, force: true });
} catch {
  console.log(`  (Hinweis: Temp-Verzeichnis blieb liegen: ${tempDir})`);
}

process.exit(failures === 0 ? 0 : 1);
