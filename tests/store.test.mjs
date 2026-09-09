/**
 * ---------------------------------------------------------------------------
 * tests/store.test.mjs – Test der Kernlogik ohne TMDB-Zugang
 * ---------------------------------------------------------------------------
 * Ausführen:  npm test
 *
 * Getestet wird genau das, was Streamo ausmacht: aus einer TMDB-Antwort wird
 * die Aussage „diese Serie läuft bei diesen Anbietern, und dieser gehört dir".
 * Die TMDB-Antworten sind hier fest hinterlegt, damit der Test ohne API-Key,
 * ohne Netzwerk und ohne Wartezeit läuft.
 *
 * Abgedeckt:
 *   - upsertShow: Feldzuordnung und Idempotenz
 *   - saveAvailability: Speichern, Aufräumen bei Anbieterwechsel
 *   - buildAvailabilityView: Abgleich mit den eigenen Abos
 *   - Trennung nach Region
 *   - getProgress: Fortschrittsberechnung
 *   - ON DELETE CASCADE: Löschen eines Benutzers räumt sauber auf
 *
 * Verknüpfungen:
 *   - src/store.js, src/db.js – die getesteten Module
 * ---------------------------------------------------------------------------
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Eine frische Datenbank in einem temporären Verzeichnis, damit der Test
// niemals die echten Daten anfasst. Muss VOR dem Import von src/db.js
// gesetzt werden, weil config.js die Variable beim Laden ausliest.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamo-test-'));
process.env.DATA_DIR = tempDir;

const { db, run, get, all } = await import('../src/db.js');
const store = await import('../src/store.js');

let failures = 0;
let checks = 0;

/**
 * Vergleicht zwei Werte strukturell und protokolliert das Ergebnis.
 * @param {string} label Beschreibung des Testfalls
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

console.log('\nStreamo – Test der Kernlogik\n');

// ===========================================================================
// Ausgangslage: ein Benutzer mit zwei Abos (Netflix = 8, Disney+ = 337)
// ===========================================================================
run("INSERT INTO users (username, password_hash, region) VALUES ('tester','x:y','DE')");
const userId = get("SELECT id FROM users WHERE username='tester'").id;
run('INSERT INTO user_providers (user_id, provider_id, name) VALUES (?,8,?)', userId, 'Netflix');
run('INSERT INTO user_providers (user_id, provider_id, name) VALUES (?,337,?)', userId, 'Disney Plus');

// ===========================================================================
// upsertShow – TMDB-Details in die Tabelle `shows`
// ===========================================================================
console.log('upsertShow');

const details = {
  id: 1396,
  name: 'Breaking Bad',
  original_name: 'Breaking Bad',
  overview: 'Ein Chemielehrer wird zum Drogenkoch.',
  poster_path: '/poster.jpg',
  first_air_date: '2008-01-20',
  last_air_date: '2013-09-29',
  status: 'Ended',
  genres: [{ name: 'Drama' }, { name: 'Krimi' }],
  number_of_seasons: 5,
  number_of_episodes: 62,
  vote_average: 8.9,
  // TMDB liefert bei Serien ein Array möglicher Episodenlängen.
  episode_run_time: [47],
};

const show = store.upsertShow(details, 'tv');

check('Titel wird aus "name" übernommen (Serie)', show.title, 'Breaking Bad');
check('Genres landen als JSON-Array', JSON.parse(show.genres), ['Drama', 'Krimi']);
check('Laufzeit aus episode_run_time[0]', show.runtime, 47);
check('Episodenzahl übernommen', show.number_of_episodes, 62);

store.upsertShow(details, 'tv');
check('Zweiter Aufruf erzeugt kein Duplikat', all('SELECT id FROM shows').length, 1);

// Filme benennen dieselben Felder anders – auch das muss passen.
const movie = store.upsertShow(
  {
    id: 550,
    title: 'Fight Club',
    original_title: 'Fight Club',
    release_date: '1999-10-15',
    genres: [{ name: 'Drama' }],
    runtime: 139,
    vote_average: 8.4,
  },
  'movie',
);
check('Film: Titel aus "title"', movie.title, 'Fight Club');
check('Film: Datum aus "release_date"', movie.first_air_date, '1999-10-15');
check('Film: Laufzeit direkt', movie.runtime, 139);
check('Film und Serie kollidieren nicht', all('SELECT id FROM shows').length, 2);

// ===========================================================================
// saveAvailability – der Regionsblock aus /watch/providers
// ===========================================================================
console.log('\nsaveAvailability');

const tmdbRegionBlock = {
  link: 'https://www.themoviedb.org/tv/1396/watch?locale=DE',
  flatrate: [
    { provider_id: 8, provider_name: 'Netflix', logo_path: '/nf.jpg', display_priority: 0 },
    { provider_id: 30, provider_name: 'WOW', logo_path: '/wow.jpg', display_priority: 12 },
  ],
  rent: [{ provider_id: 3, provider_name: 'Google Play', logo_path: '/gp.jpg', display_priority: 5 }],
  buy: [{ provider_id: 3, provider_name: 'Google Play', logo_path: '/gp.jpg', display_priority: 5 }],
};

check('Vier Angebote gespeichert', store.saveAvailability(show.id, 'DE', tmdbRegionBlock), 4);
check(
  'Zeitstempel wurde gesetzt',
  Boolean(store.findShowById(show.id).availability_updated_at),
  true,
);

// Ein Titel ganz ohne Angebot darf nicht scheitern.
check('Leerer Regionsblock ergibt 0 Angebote', store.saveAvailability(movie.id, 'DE', {}), 0);

// ===========================================================================
// buildAvailabilityView – der Abgleich mit den eigenen Abos
// ===========================================================================
console.log('\nbuildAvailabilityView – "wo kann ich das sehen?"');

const subscribed = store.getSubscribedProviderIds(userId);
check(
  'Abos werden geladen',
  [...subscribed].sort((a, b) => a - b),
  [8, 337],
);

const view = store.buildAvailabilityView(show.id, 'DE', subscribed);

check('Serie ist in einem eigenen Abo enthalten', view.isIncluded, true);
check('Bestes Angebot ist das eigene Abo', view.bestOffer.name, 'Netflix');
check('Nur Netflix zählt als "meins"', view.included.map((o) => o.name), ['Netflix']);
check(
  'Abo-Angebote nach Anbieter-Priorität sortiert',
  view.offers.flatrate.map((o) => o.name),
  ['Netflix', 'WOW'],
);
check('WOW ist korrekt als nicht abonniert markiert', view.offers.flatrate[1].subscribed, false);
check('Leihangebote stehen getrennt', view.offers.rent.map((o) => o.name), ['Google Play']);
check('Deeplink wurde übernommen', view.link, tmdbRegionBlock.link);

const noOffers = store.buildAvailabilityView(movie.id, 'DE', subscribed);
check('Ohne Angebot: isIncluded ist false', noOffers.isIncluded, false);
check('Ohne Angebot: bestOffer ist null', noOffers.bestOffer, null);

// ===========================================================================
// Rechtewechsel – der Grund für den Hintergrundabgleich
// ===========================================================================
console.log('\nRechtewechsel');

store.saveAvailability(show.id, 'DE', {
  link: tmdbRegionBlock.link,
  flatrate: [
    { provider_id: 9, provider_name: 'Amazon Prime Video', logo_path: '/pv.jpg', display_priority: 2 },
  ],
});

const afterSwitch = store.buildAvailabilityView(show.id, 'DE', subscribed);
check('Läuft nicht mehr in meinem Abo', afterSwitch.isIncluded, false);
check(
  'Der alte Netflix-Eintrag ist verschwunden',
  afterSwitch.offers.flatrate.map((o) => o.name),
  ['Amazon Prime Video'],
);
check(
  'Keine Karteileichen in der Tabelle',
  all('SELECT * FROM availability WHERE show_id = ?', show.id).length,
  1,
);

// ===========================================================================
// Regionen sind voneinander unabhängig
// ===========================================================================
console.log('\nRegionen');

store.saveAvailability(show.id, 'US', {
  flatrate: [{ provider_id: 8, provider_name: 'Netflix', logo_path: '/nf.jpg', display_priority: 0 }],
});

check(
  'DE bleibt unverändert',
  store.buildAvailabilityView(show.id, 'DE', subscribed).offers.flatrate.map((o) => o.name),
  ['Amazon Prime Video'],
);
check('US hat einen eigenen Datenstand', store.buildAvailabilityView(show.id, 'US', subscribed).isIncluded, true);

// ===========================================================================
// getProgress – Sehfortschritt
// ===========================================================================
console.log('\ngetProgress');

run('INSERT INTO library (user_id, show_id, status) VALUES (?,?,?)', userId, show.id, 'watching');

for (let episode = 1; episode <= 7; episode++) {
  run(
    'INSERT INTO episodes (show_id, season_number, episode_number, name) VALUES (?,1,?,?)',
    show.id,
    episode,
    `Episode ${episode}`,
  );
}

for (const ep of all('SELECT id FROM episodes WHERE show_id = ?', show.id).slice(0, 3)) {
  run('INSERT INTO watched_episodes (user_id, episode_id, show_id) VALUES (?,?,?)', userId, ep.id, show.id);
}

const progress = store.getProgress(userId, store.findShowById(show.id));
check('3 von 62 Episoden gesehen', [progress.watched, progress.total], [3, 62]);
check('Prozent auf ganze Zahl gerundet', progress.percent, 5);

const noEpisodes = store.getProgress(userId, { id: movie.id, number_of_episodes: 0 });
check('Keine Division durch null bei 0 Episoden', noEpisodes.percent, 0);

// ===========================================================================
// ON DELETE CASCADE – Löschen eines Benutzers
// ===========================================================================
console.log('\nFremdschlüssel');

run('DELETE FROM users WHERE id = ?', userId);

check('Abos wurden mitgelöscht', all('SELECT * FROM user_providers').length, 0);
check('Bibliothek wurde mitgelöscht', all('SELECT * FROM library').length, 0);
check('Fortschritt wurde mitgelöscht', all('SELECT * FROM watched_episodes').length, 0);
check('Serien bleiben als Cache erhalten', all('SELECT * FROM shows').length, 2);
check('Verfügbarkeiten bleiben erhalten', all('SELECT * FROM availability').length > 0, true);

// ===========================================================================
// Ergebnis
// ===========================================================================
console.log('');
if (failures === 0) {
  console.log(`Alle ${checks} Prüfungen bestanden.\n`);
} else {
  console.log(`${failures} von ${checks} Prüfungen fehlgeschlagen.\n`);
}

// Temporäre Datenbank aufräumen. Die Verbindung muss vorher geschlossen
// werden – Windows lässt eine geöffnete Datei nicht löschen. Schlägt das
// Aufräumen trotzdem fehl, ist das kein Grund, den Test als rot zu melden:
// es liegt nur eine Datei im Temp-Verzeichnis herum.
db.close();
try {
  fs.rmSync(tempDir, { recursive: true, force: true });
} catch (error) {
  console.log(`  (Hinweis: Temp-Verzeichnis blieb liegen: ${tempDir})`);
}

process.exit(failures === 0 ? 0 : 1);
