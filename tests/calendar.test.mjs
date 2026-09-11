/**
 * ---------------------------------------------------------------------------
 * tests/calendar.test.mjs – Der Kalender und sein Abonnement
 * ---------------------------------------------------------------------------
 * Ausführen:  npm run test:calendar
 *
 * Zwei Dinge werden hier geprüft, und beide aus gutem Grund.
 *
 * ERSTENS: Was gehört überhaupt in den Kalender? Ein Termin, der dort nichts
 * verloren hat, ist schlimmer als einer, der fehlt – man schaltet die
 * Benachrichtigungen ab und verpasst dann alles. Deshalb: keine Episoden
 * abgebrochener Serien, keine schon gesehenen Folgen, keine Ablaufdaten von
 * Titeln, die gar nicht in der eigenen Bibliothek stehen.
 *
 * ZWEITENS: Das iCalendar-Format. Es sieht harmlos aus, hat aber Regeln, an
 * denen ein selbstgebauter Feed zuverlässig scheitert:
 *
 *   - Zeilenenden müssen CRLF sein, nicht LF.
 *   - Zeilen dürfen höchstens 75 OKTETTE lang sein – nicht 75 Zeichen. Ein
 *     "ü" belegt zwei, ein Emoji vier.
 *   - Beim Umbrechen darf kein Mehrbyte-Zeichen zerrissen werden.
 *   - Komma, Semikolon und Backslash haben eigene Bedeutung und müssen
 *     maskiert werden. Sonst ist "Ocean's 11, 12 & 13" nach dem Komma zu Ende.
 *   - Bei ganztägigen Terminen ist DTEND der FOLGENDE Tag; das Ende ist
 *     ausschließend gemeint.
 *
 * Ein Kalenderprogramm meldet solche Fehler nicht. Es zeigt den Termin einfach
 * nicht an – oder gar nichts mehr.
 * ---------------------------------------------------------------------------
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamo-calendar-'));
process.env.DATA_DIR = tempDir;

const { db, run, get } = await import('../src/db.js');
const calendar = await import('../src/calendar.js');

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

/** Ein Tag, um so viele Tage verschoben, als "YYYY-MM-DD". */
const tag = (days) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

console.log('\nStreamo – Kalender\n');

// ===========================================================================
// Ausgangslage
// ===========================================================================

run("INSERT INTO users (username, password_hash, region) VALUES ('morni','x:y','DE')");
run("INSERT INTO users (username, password_hash, region) VALUES ('fremd','x:y','DE')");

const morni = get("SELECT id FROM users WHERE username = 'morni'").id;
const fremd = get("SELECT id FROM users WHERE username = 'fremd'").id;

/**
 * Legt eine Serie an und hängt sie in eine Bibliothek.
 * @param {object} spec
 * @returns {number} show_id
 */
function anlegen(spec) {
  run(
    'INSERT INTO shows (tmdb_id, media_type, title) VALUES (?,?,?)',
    spec.tmdbId,
    spec.mediaType || 'tv',
    spec.title,
  );

  const showId = get('SELECT id FROM shows WHERE tmdb_id = ?', spec.tmdbId).id;

  if (spec.status) {
    run(
      'INSERT INTO library (user_id, show_id, status, planned_for) VALUES (?,?,?,?)',
      spec.userId ?? morni,
      showId,
      spec.status,
      spec.plannedFor ?? null,
    );
  }

  return showId;
}

// ===========================================================================
// Der Token
// ===========================================================================
console.log('Die Abonnement-Adresse');

const token = calendar.getCalendarToken(morni);

check('Ein Token entsteht beim ersten Abruf', typeof token === 'string' && token.length >= 20, true);
check('Ein zweiter Abruf liefert denselben', calendar.getCalendarToken(morni), token);
check('Er führt zum richtigen Konto', calendar.findUserByCalendarToken(token)?.id, morni);
check('Ein erfundener Token führt nirgendwohin', calendar.findUserByCalendarToken('erfunden'), null);
check('Ein leerer auch nicht', calendar.findUserByCalendarToken(''), null);

const neuerToken = calendar.resetCalendarToken(morni);

check('Neu erzeugen ergibt einen anderen', neuerToken !== token, true);
check('Der alte führt danach ins Leere', calendar.findUserByCalendarToken(token), null);
check('Der neue funktioniert', calendar.findUserByCalendarToken(neuerToken)?.id, morni);

// ===========================================================================
// Was in den Kalender gehört
// ===========================================================================
console.log('\nWas hineingehört');

// 1. Ein vorgemerkter Titel mit Termin.
anlegen({ tmdbId: 1, mediaType: 'movie', title: 'Der Pate', status: 'watchlist', plannedFor: tag(2) });

// 2. Eine laufende Serie, die bald eine Plattform verlässt.
const bb = anlegen({ tmdbId: 2, title: 'Breaking Bad', status: 'watching' });
run(
  'INSERT INTO availability (show_id,region,provider_id,offer_type,name) VALUES (?,?,?,?,?)',
  bb, 'DE', 8, 'flatrate', 'Netflix',
);
run(
  'INSERT INTO availability_until (show_id,region,provider_id,available_until) VALUES (?,?,?,?)',
  bb, 'DE', 8, tag(5),
);

// 3. Eine neue Episode dieser Serie.
run(
  'INSERT INTO episodes (show_id,tmdb_id,season_number,episode_number,name,air_date) VALUES (?,?,?,?,?,?)',
  bb, 900, 6, 1, 'Die neue Folge', tag(9),
);

let events = calendar.collectEvents(morni, 'DE');

check('Drei Termine', events.length, 3);
check('nach Datum sortiert', events.map((e) => e.kind), ['planned', 'expiring', 'episode']);
check('der vorgemerkte Film', events[0].summary, '📺 Der Pate');
check('das Auslaufen nennt den Anbieter', events[1].description.includes('Netflix'), true);
check('die Episode trägt ihre Nummer', events[2].summary, '🎬 Breaking Bad S06E01');

// ===========================================================================
// Was NICHT hineingehört
// ===========================================================================
console.log('\nWas draußen bleiben muss');

// Eine abgebrochene Serie – ihre neuen Folgen sind kein Termin.
const weg = anlegen({ tmdbId: 3, title: 'Abgebrochenes', status: 'dropped' });
run(
  'INSERT INTO episodes (show_id,tmdb_id,season_number,episode_number,air_date) VALUES (?,?,?,?,?)',
  weg, 901, 2, 1, tag(4),
);

// Ein Titel, der jemand anderem gehört – dessen Ablaufdatum geht mich nichts an.
const fremdShow = anlegen({ tmdbId: 4, title: 'Fremde Serie', status: 'watching', userId: fremd });
run(
  'INSERT INTO availability_until (show_id,region,provider_id,available_until) VALUES (?,?,?,?)',
  fremdShow, 'DE', 8, tag(6),
);

// Eine bereits gesehene Folge.
run(
  'INSERT INTO episodes (show_id,tmdb_id,season_number,episode_number,air_date) VALUES (?,?,?,?,?)',
  bb, 902, 6, 2, tag(11),
);
const gesehen = get('SELECT id FROM episodes WHERE tmdb_id = 902').id;
run(
  'INSERT INTO watched_episodes (user_id, episode_id, show_id) VALUES (?,?,?)',
  morni,
  gesehen,
  bb,
);

events = calendar.collectEvents(morni, 'DE');
const titel = events.map((e) => e.title);

check('Es bleiben drei Termine', events.length, 3);
check('keine Folge einer abgebrochenen Serie', titel.includes('Abgebrochenes'), false);
check('kein fremdes Ablaufdatum', titel.includes('Fremde Serie'), false);
check(
  'keine schon gesehene Folge',
  events.filter((e) => e.kind === 'episode').length,
  1,
);

console.log('\nEine andere Region');

check(
  'das deutsche Ablaufdatum gilt nicht in Österreich',
  calendar.collectEvents(morni, 'AT').some((e) => e.kind === 'expiring'),
  false,
);

console.log('\nAlte Ausstrahlungen');

run(
  'INSERT INTO episodes (show_id,tmdb_id,season_number,episode_number,air_date) VALUES (?,?,?,?,?)',
  bb, 903, 1, 1, tag(-200),
);

check(
  'was vor Monaten lief, ist Rückstand und kein Termin',
  calendar.collectEvents(morni, 'DE').length,
  3,
);

// ===========================================================================
// Das Format
// ===========================================================================
console.log('\nDas iCalendar-Format');

// Ein Titel mit genau den Zeichen, die Ärger machen.
const fies = "Ocean's 11, 12 & 13; ein absichtlich sehr langer Titel mit Umlauten wie Grün und Straße";

anlegen({ tmdbId: 5, mediaType: 'movie', title: fies, status: 'watchlist', plannedFor: tag(1) });

const ics = calendar.buildIcs(calendar.collectEvents(morni, 'DE'), {
  name: 'Streamo – Morni',
  baseUrl: 'https://streamo.example',
});

check('beginnt korrekt', ics.startsWith('BEGIN:VCALENDAR\r\n'), true);
check('endet korrekt', ics.endsWith('END:VCALENDAR\r\n'), true);
check('nennt eine Version', ics.includes('VERSION:2.0'), true);
check('trägt einen Namen für die App', ics.includes('X-WR-CALNAME:'), true);

const zeilen = ics.split('\r\n').filter(Boolean);

check(
  'jede Zeile endet mit CRLF – kein einzelnes LF',
  zeilen.every((z) => !z.includes('\n')),
  true,
);

check(
  'keine Zeile ist länger als 75 Oktette',
  zeilen.every((z) => Buffer.from(z, 'utf8').length <= 75),
  true,
);

check(
  'gleich viele BEGIN wie END',
  zeilen.filter((z) => z.startsWith('BEGIN:')).length,
  zeilen.filter((z) => z.startsWith('END:')).length,
);

check(
  'ein VEVENT je Termin',
  zeilen.filter((z) => z === 'BEGIN:VEVENT').length,
  4,
);

console.log('\nMaskierung');

// Die gefalteten Zeilen wieder zusammensetzen, so wie es ein Kalenderprogramm
// tut: Eine Zeile, die mit einem Leerzeichen beginnt, gehört an die vorige.
const entfaltet = ics.replace(/\r\n /g, '');

check('das Komma ist maskiert', entfaltet.includes("Ocean's 11\\, 12"), true);
check('das Semikolon auch', entfaltet.includes('13\\; ein'), true);
check('die Umlaute sind heil geblieben', entfaltet.includes('Grün und Straße'), true);

console.log('\nGanztägige Termine');

const dtstart = ics.match(/DTSTART;VALUE=DATE:(\d{8})/)?.[1];
const dtend = ics.match(/DTEND;VALUE=DATE:(\d{8})/)?.[1];

check('DTSTART ist ein reines Datum', /^\d{8}$/.test(dtstart ?? ''), true);
check(
  'DTEND ist der FOLGENDE Tag – das Ende ist ausschließend gemeint',
  Number(dtend) - Number(dtstart) >= 1,
  true,
);

const uids = [...ics.matchAll(/UID:(.+)/g)].map((m) => m[1].trim());

check('jeder Termin hat eine Kennung', uids.length, 4);
check('alle Kennungen sind verschieden', new Set(uids).size, uids.length);

// Stabil über Abrufe hinweg: Sonst legt das Kalenderprogramm bei jeder
// Aktualisierung neue Einträge an, statt die vorhandenen zu ersetzen.
const nochmal = calendar.buildIcs(calendar.collectEvents(morni, 'DE'), { name: 'Streamo' });
const uidsNochmal = [...nochmal.matchAll(/UID:(.+)/g)].map((m) => m[1].trim());

check('und beim nächsten Abruf dieselben', uidsNochmal, uids);

// ===========================================================================
// Termine mit Uhrzeit
// ===========================================================================
// Mit Uhrzeit wird aus der Notiz ein Termin mit Anfang und Ende. Das Ende
// ergibt sich aus der Laufzeit – beim Film aus der Filmlänge.
console.log('\nTermine mit Uhrzeit');

run("INSERT INTO shows (tmdb_id, media_type, title, runtime) VALUES (7001,'movie','Lange Nacht',175)");
const langeNacht = get('SELECT id FROM shows WHERE tmdb_id = 7001').id;
run(
  "INSERT INTO library (user_id, show_id, status, planned_for, planned_time) VALUES (?,?,'watchlist',?,'20:15')",
  morni, langeNacht, tag(3),
);

// Einer, der über Mitternacht geht: 23:00 plus 150 Minuten.
run("INSERT INTO shows (tmdb_id, media_type, title, runtime) VALUES (7002,'movie','Spätvorstellung',150)");
const spaet = get('SELECT id FROM shows WHERE tmdb_id = 7002').id;
run(
  "INSERT INTO library (user_id, show_id, status, planned_for, planned_time) VALUES (?,?,'watchlist',?,'23:00')",
  morni, spaet, tag(3),
);

const mitUhrzeit = calendar.collectEvents(morni, 'DE').filter((event) => event.time);
const nachtTermin = mitUhrzeit.find((event) => event.title === 'Lange Nacht');
const spaetTermin = mitUhrzeit.find((event) => event.title === 'Spätvorstellung');

check('Der Termin trägt seine Uhrzeit', nachtTermin?.time, '20:15');
check('Die Dauer ist die Filmlänge', nachtTermin?.minutes, 175);
check('Er endet um 23:10', nachtTermin?.endTime, '23:10');
check('am selben Tag', nachtTermin?.endDate, tag(3));
check('Über Mitternacht endet er am Folgetag', spaetTermin?.endDate, tag(4));
check('um 01:30', spaetTermin?.endTime, '01:30');

const alleAmTag = calendar.collectEvents(morni, 'DE').filter((event) => event.date === tag(3));
check(
  'Am selben Tag in der Reihenfolge der Uhrzeit',
  alleAmTag.filter((event) => event.time).map((event) => event.time),
  ['20:15', '23:00'],
);

const icsZeit = calendar.buildIcs(mitUhrzeit, { name: 'Mit Uhrzeit' });
const kompakt = (datum) => datum.replace(/-/g, '');

check('DTSTART mit Uhrzeit, ohne Zeitzone', icsZeit.includes(`DTSTART:${kompakt(tag(3))}T201500\r\n`), true);
check('DTEND ist Anfang plus Laufzeit', icsZeit.includes(`DTEND:${kompakt(tag(3))}T231000\r\n`), true);
check('über Mitternacht auch im Feed', icsZeit.includes(`DTEND:${kompakt(tag(4))}T013000\r\n`), true);
check('kein reines Datum bei Terminen mit Uhrzeit', icsZeit.includes('DTSTART;VALUE=DATE:'), false);

const ohneUhrzeit = calendar.collectEvents(morni, 'DE').filter((event) => !event.time);
check(
  'Termine ohne Uhrzeit bleiben ganztägig',
  calendar.buildIcs(ohneUhrzeit, { name: 'Ganztägig' }).includes('DTSTART;VALUE=DATE:'),
  true,
);

console.log('\nEin leerer Kalender');

const leer = calendar.buildIcs([], { name: 'Leer' });

check('ist trotzdem gültig', leer.startsWith('BEGIN:VCALENDAR\r\n'), true);
check('und enthält keinen Termin', leer.includes('BEGIN:VEVENT'), false);

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
