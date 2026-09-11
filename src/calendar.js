/**
 * ---------------------------------------------------------------------------
 * src/calendar.js – Der Kalender und sein Abonnement
 * ---------------------------------------------------------------------------
 * Rolle im Gesamtsystem:
 *   Streamo weiß drei Dinge, die in einen Kalender gehören:
 *
 *     1. Wann du dir vorgenommen hast, etwas zu sehen (library.planned_for)
 *     2. Wann ein Titel eine Plattform verlässt (availability_until)
 *     3. Wann die nächste Episode erscheint (episodes.air_date)
 *
 *   Alle drei sind Termine. Sie nur in Streamo anzuzeigen hieße, dass man
 *   Streamo aufmachen muss, um sie zu sehen – und genau dann fällt einem so
 *   ein Termin nicht ein. Deshalb der Weg in den eigenen Kalender.
 *
 * Wie das Abonnement funktioniert:
 *   Ein Kalenderprogramm meldet sich nicht an. Es ruft in festen Abständen
 *   eine Adresse ab und erwartet dort eine Datei im iCalendar-Format
 *   (RFC 5545). Der Nachweis muss deshalb IN der Adresse stehen – daher der
 *   Token. Wer die Adresse hat, sieht die Termine; sie ist so
 *   schutzbedürftig wie ein Passwort und lässt sich jederzeit neu erzeugen.
 *
 * Warum selbst gebaut statt einer Bibliothek?
 *   Das Format ist einfach – Schlüssel-Wert-Zeilen zwischen BEGIN und END.
 *   Die Tücken liegen in Details, die eine Bibliothek einem abnehmen würde,
 *   die aber allesamt in wenigen Zeilen zu erledigen sind: Zeilenenden mit
 *   CRLF, Umbruch langer Zeilen nach 75 Oktetten, Maskierung von Komma,
 *   Semikolon und Backslash. Genau die sind unten einzeln kommentiert.
 *
 * Verknüpfungen:
 *   - src/db.js            -> library, availability_until, episodes, users
 *   - src/routes/public.js -> liefert den Feed ohne Anmeldung aus
 *   - src/routes/calendar.js -> Token holen und neu erzeugen
 *   - public/js/views/calendar.js -> der Reiter in der Oberfläche
 * ---------------------------------------------------------------------------
 */

import crypto from 'node:crypto';
import { all, get, run } from './db.js';
// Sehplaene liefern wiederkehrende Termine - siehe src/watchplan.js.
import { parseWeekdays, nextOccurrences } from './watchplan.js';
// Dieselbe Übersetzung wie im Browser: Der Feed geht an ein Kalenderprogramm,
// dort gibt es kein el(), das übersetzen könnte. Die Datei kommt ohne DOM aus.
import { translate } from '../public/js/i18n.js';

/**
 * Wie weit der Kalender in die Zukunft blickt.
 *
 * Ein Jahr reicht: Weiter im Voraus gibt es weder Ausstrahlungstermine noch
 * Ankündigungen, dass etwas eine Plattform verlässt.
 */
const HORIZON_DAYS = 365;

/**
 * Wie weit er zurückblickt.
 *
 * Vergangene Termine gehören dazu – ein Kalender, in dem letzte Woche leer
 * ist, wirkt kaputt. Vier Wochen genügen.
 */
const PAST_DAYS = 28;

// ===========================================================================
// Der Token
// ===========================================================================

/**
 * Liefert den Kalender-Token eines Kontos und erzeugt ihn beim ersten Mal.
 *
 * Erst bei Bedarf: Wer den Kalender nie abonniert, hat auch keinen Token, der
 * irgendwo herumliegen könnte.
 *
 * @param {number} userId
 * @returns {string}
 */
export function getCalendarToken(userId) {
  const row = get('SELECT calendar_token FROM users WHERE id = ?', userId);

  if (row?.calendar_token) return row.calendar_token;

  return resetCalendarToken(userId);
}

/**
 * Erzeugt einen neuen Token. Alle bestehenden Abonnements laufen danach ins
 * Leere – das ist der Weg, eine versehentlich weitergegebene Adresse zu
 * entwerten.
 *
 * @param {number} userId
 * @returns {string}
 */
export function resetCalendarToken(userId) {
  // base64url, damit der Token ohne Umkodierung in eine Adresse passt.
  const token = crypto.randomBytes(24).toString('base64url');

  run('UPDATE users SET calendar_token = ? WHERE id = ?', token, userId);

  return token;
}

/**
 * Findet das Konto zu einem Token.
 *
 * @param {string} token
 * @returns {object|null}
 */
export function findUserByCalendarToken(token) {
  if (!token) return null;

  return (
    get(
      // ui_language: In dieser Sprache stehen die Termine im Feed.
      'SELECT id, username, display_name, region, ui_language FROM users WHERE calendar_token = ?',
      String(token),
    ) ?? null
  );
}

// ===========================================================================
// Die Termine
// ===========================================================================

/**
 * Sammelt alle Termine eines Kontos.
 *
 * @param {number} userId
 * @param {string} region Für die anbieterabhängigen Termine
 * @returns {Array<{
 *   uid: string, date: string, kind: string,
 *   title: string, summary: string, description: string, showId: number|null
 * }>} nach Datum sortiert
 */
export function collectEvents(userId, region) {
  const from = shiftDay(-PAST_DAYS);
  const to = shiftDay(HORIZON_DAYS);

  const events = [];

  // -------------------------------------------------------------------------
  // 1. Was man sich vorgenommen hat
  // -------------------------------------------------------------------------
  for (const row of all(
    `SELECT l.show_id, l.planned_for, s.title, s.media_type
       FROM library l
       JOIN shows s ON s.id = l.show_id
      WHERE l.user_id = ?
        AND l.planned_for IS NOT NULL
        AND l.planned_for BETWEEN ? AND ?`,
    userId,
    from,
    to,
  )) {
    events.push({
      // Die Kennung muss über Abrufe hinweg gleich bleiben. Sonst legt das
      // Kalenderprogramm bei jeder Aktualisierung einen neuen Eintrag an,
      // statt den vorhandenen zu ersetzen.
      uid: `plan-${row.show_id}`,
      date: row.planned_for,
      kind: 'planned',
      title: row.title,
      summary: `📺 ${row.title}`,
      description: `Du hast dir vorgenommen, ${row.media_type === 'tv' ? 'diese Serie' : 'diesen Film'} zu sehen.`,
      showId: row.show_id,
    });
  }

  // -------------------------------------------------------------------------
  // 2. Was bald eine Plattform verlässt
  // -------------------------------------------------------------------------
  // Nur für Titel, die in der eigenen Bibliothek stehen – dass irgendein Film
  // Netflix verlässt, ist kein Termin für mich.
  for (const row of all(
    `SELECT u.show_id, u.available_until, u.provider_id, s.title,
            -- Den Anbieternamen aus der Verfügbarkeit ziehen; in
            -- availability_until steht nur die Kennung.
            (SELECT a.name FROM availability a
              WHERE a.show_id = u.show_id AND a.region = u.region
                AND a.provider_id = u.provider_id
              LIMIT 1) AS provider_name
       FROM availability_until u
       JOIN shows s ON s.id = u.show_id
       JOIN library l ON l.show_id = u.show_id AND l.user_id = ?
      WHERE u.region = ?
        AND u.available_until BETWEEN ? AND ?`,
    userId,
    region,
    from,
    to,
  )) {
    const provider = row.provider_name || 'dem Anbieter';

    events.push({
      uid: `until-${row.show_id}-${row.provider_id}`,
      date: row.available_until,
      kind: 'expiring',
      title: row.title,
      summary: `⏳ Letzter Tag: ${row.title}`,
      description: `„${row.title}" verlässt ${provider} nach diesem Tag.`,
      showId: row.show_id,
    });
  }

  // -------------------------------------------------------------------------
  // 3. Neue Episoden
  // -------------------------------------------------------------------------
  // Nur von Serien, die man gerade schaut oder sehen will – bei einer
  // abgebrochenen Serie ist eine neue Folge kein Termin.
  //
  // Und nur, was noch nicht gesehen ist: Bei einer Serie, die man nachholt,
  // stünden sonst hundert alte Ausstrahlungstermine im Kalender.
  for (const row of all(
    `SELECT e.show_id, e.air_date, e.season_number, e.episode_number, e.name,
            s.title
       FROM episodes e
       JOIN shows s ON s.id = e.show_id
       JOIN library l ON l.show_id = e.show_id AND l.user_id = ?
      WHERE l.status IN ('watching','watchlist')
        AND e.air_date IS NOT NULL
        AND e.air_date BETWEEN ? AND ?
        AND NOT EXISTS (
          SELECT 1 FROM watched_episodes w
           WHERE w.user_id = l.user_id AND w.episode_id = e.id
        )
      ORDER BY e.air_date`,
    userId,
    // Ausstrahlungen erst ab heute: Was schon lief, ist Rückstand und kein
    // Termin. Deshalb hier bewusst NICHT `from`.
    today(),
    to,
  )) {
    const nummer = `S${String(row.season_number).padStart(2, '0')}E${String(row.episode_number).padStart(2, '0')}`;

    events.push({
      uid: `ep-${row.show_id}-${row.season_number}-${row.episode_number}`,
      date: row.air_date,
      kind: 'episode',
      title: row.title,
      summary: `🎬 ${row.title} ${nummer}`,
      description: row.name ? `${nummer} – ${row.name}` : `${nummer} erscheint heute.`,
      showId: row.show_id,
    });
  }

  // -------------------------------------------------------------------------
  // 4. Die Sehpläne
  // -------------------------------------------------------------------------
  // "Jeden Montag zwei Folgen" ist ein wiederkehrender Termin – und genau der
  // gehört in einen Kalender. Anders als die drei Punkte davor steht er nicht
  // als Datum in einer Tabelle, sondern muss aus dem Rhythmus gerechnet werden.
  //
  // Bewusst ohne echte Wiederholungsregel (RRULE) im ICS: Eine Serie ist
  // irgendwann zu Ende, und ein Kalendereintrag, der bis in alle Ewigkeit
  // "zwei Folgen" behauptet, wäre falsch. Deshalb eine begrenzte Zahl
  // einzelner Termine – so weit, wie die Serie überhaupt reicht.
  for (const row of all(
    `SELECT p.show_id, p.weekdays, p.episodes_per_run, s.title,
            -- Wie viele ungesehene Folgen gibt es überhaupt noch? Mehr
            -- Termine als Folgen wären eine Luftbuchung.
            (SELECT COUNT(*) FROM episodes e
              WHERE e.show_id = p.show_id
                AND e.season_number > 0
                AND (e.air_date IS NULL OR e.air_date <= date('now'))
                AND NOT EXISTS (
                  SELECT 1 FROM watched_episodes w
                   WHERE w.user_id = p.user_id AND w.episode_id = e.id
                )) AS offen
       FROM watch_plans p
       JOIN shows s ON s.id = p.show_id
      WHERE p.user_id = ? AND p.active = 1`,
    userId,
  )) {
    const weekdays = parseWeekdays(row.weekdays);
    if (weekdays.length === 0 || row.offen === 0) continue;

    // So viele Termine, wie die verbleibenden Folgen hergeben – höchstens
    // aber ein halbes Jahr voraus, sonst füllt eine lange Serie den Kalender.
    const termine = Math.min(Math.ceil(row.offen / row.episodes_per_run), 26);

    for (const datum of nextOccurrences(weekdays, termine)) {
      events.push({
        // Das Datum gehört in die Kennung: Jeder Termin ist ein eigener
        // Eintrag, und ohne das Datum hätten alle dieselbe.
        uid: `sehplan-${row.show_id}-${datum}`,
        date: datum,
        kind: 'schedule',
        title: row.title,
        summary: `📅 ${row.title}: ${row.episodes_per_run} ${row.episodes_per_run === 1 ? 'Folge' : 'Folgen'}`,
        description: `Nach deinem Sehplan. Streamo hakt die Folgen an diesem Tag automatisch ab.`,
        showId: row.show_id,
      });
    }
  }

  return events.sort((a, b) => a.date.localeCompare(b.date));
}

/** Der heutige Tag als "YYYY-MM-DD". */
function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Ein Tag, um so viele Tage verschoben.
 * @param {number} days negativ = Vergangenheit
 * @returns {string} "YYYY-MM-DD"
 */
function shiftDay(days) {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

// ===========================================================================
// Das iCalendar-Format
// ===========================================================================

/**
 * Maskiert einen Text für ein iCalendar-Feld.
 *
 * Vier Zeichen haben im Format eine eigene Bedeutung und müssen mit einem
 * Backslash entwertet werden. Der Backslash selbst zuerst – sonst würde man
 * die eigenen Fluchtzeichen gleich wieder maskieren.
 *
 * Ein Titel wie "Ocean's 11, 12 & 13" wäre sonst nach dem Komma abgeschnitten.
 *
 * @param {string} text
 * @returns {string}
 */
function escapeText(text) {
  return String(text ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/**
 * Bricht eine Zeile nach 75 Oktetten um.
 *
 * Vorgeschrieben von RFC 5545. Die Fortsetzung beginnt mit einem Leerzeichen.
 * Gezählt wird in BYTES, nicht in Zeichen: Ein "ö" belegt zwei, ein Emoji
 * vier. Bei Zeichen zu zählen würde bei deutschen Titeln zu lange Zeilen
 * erzeugen – und ein mitten in einem Zeichen getrenntes Emoji hinterlässt in
 * manchen Kalendern ein Fragezeichen.
 *
 * @param {string} line
 * @returns {string[]} eine oder mehrere Zeilen
 */
function foldLine(line) {
  const bytes = Buffer.from(line, 'utf8');

  if (bytes.length <= 75) return [line];

  const parts = [];
  let start = 0;
  // Die erste Zeile darf 75 Oktette lang sein, jede Fortsetzung 74 – das
  // führende Leerzeichen zählt mit.
  let limit = 75;

  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);

    // Nicht mitten in einem Mehrbyte-Zeichen trennen: Folgebytes eines
    // UTF-8-Zeichens beginnen mit den Bits 10xxxxxx.
    while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) {
      end--;
    }

    parts.push((start === 0 ? '' : ' ') + bytes.subarray(start, end).toString('utf8'));

    start = end;
    limit = 74;
  }

  return parts;
}

/**
 * Baut den vollständigen iCalendar-Text.
 *
 * @param {object[]} events aus collectEvents()
 * @param {object} options
 * @param {string} options.name Name des Kalenders in der App
 * @param {string} [options.baseUrl] Für Links zurück in die Anwendung
 * @returns {string}
 */
export function buildIcs(events, { name, baseUrl, lang = 'de' } = {}) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    // Pflichtangabe: Wer hat die Datei erzeugt.
    'PRODID:-//Streamo//Kalender//DE',
    // Termine gelten für sich, nicht als Serie.
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    // Apple Kalender und Google zeigen diesen Namen an, statt die Adresse.
    `X-WR-CALNAME:${escapeText(name)}`,
    `X-WR-CALDESC:${escapeText(translate('Geplante Titel, auslaufende Angebote und neue Episoden aus Streamo.', lang))}`,
    // Wie oft das Programm nachsehen soll. Beides angeben: Apple hält sich an
    // REFRESH-INTERVAL, ältere Programme an X-PUBLISHED-TTL.
    'REFRESH-INTERVAL;VALUE=DURATION:PT6H',
    'X-PUBLISHED-TTL:PT6H',
  ];

  // Zeitstempel der Erzeugung, in UTC ohne Trennzeichen – so verlangt es das
  // Format.
  const stamp = `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`;

  for (const event of events) {
    const day = event.date.replace(/-/g, '');

    // Ganztägige Termine: DTEND ist der FOLGENDE Tag, weil das Ende
    // ausschließend gemeint ist. Ohne das erscheint der Termin in manchen
    // Kalendern gar nicht, in anderen über zwei Tage.
    const nextDay = new Date(`${event.date}T00:00:00Z`);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);

    lines.push(
      'BEGIN:VEVENT',
      // Die Kennung muss stabil UND weltweit eindeutig sein. Der Domain-Teil
      // sorgt dafür, dass sie nicht mit der eines anderen Programms kollidiert.
      `UID:${event.uid}@streamo`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${day}`,
      `DTEND;VALUE=DATE:${nextDay.toISOString().slice(0, 10).replace(/-/g, '')}`,
      // Die Termine entstehen auf Deutsch (collectEvents) und werden erst hier
      // in die Sprache des Kontos gebracht – so bleibt collectEvents dieselbe
      // Quelle für den Reiter im Browser, der selbst übersetzt.
      `SUMMARY:${escapeText(translate(event.summary, lang))}`,
      `DESCRIPTION:${escapeText(translate(event.description, lang))}`,
      // Zurück in die Anwendung, direkt zum Titel.
      baseUrl && event.showId ? `URL:${baseUrl}/library` : null,
      // Ganztägig und ohne Belegung des Kalenders – es ist eine Notiz, kein
      // Termin, zu dem man irgendwo sein muss.
      'TRANSP:TRANSPARENT',
      'END:VEVENT',
    );
  }

  lines.push('END:VCALENDAR');

  // CRLF als Zeilenende, nicht LF – das schreibt RFC 5545 vor, und manche
  // Programme lehnen die Datei sonst kommentarlos ab.
  return lines
    .filter(Boolean)
    .flatMap((line) => foldLine(line))
    .join('\r\n')
    .concat('\r\n');
}
