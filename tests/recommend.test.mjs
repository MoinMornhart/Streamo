/**
 * ---------------------------------------------------------------------------
 * tests/recommend.test.mjs – Persönliche Empfehlungen
 * ---------------------------------------------------------------------------
 * Ausführen:  npm run test:recommend
 *
 * Eine Empfehlung ist ein Versprechen: "Das passt zu dir." Wenn sie das nicht
 * einlöst, ist sie schlimmer als gar keine. Deshalb wird hier vor allem
 * geprüft, was NICHT vorgeschlagen werden darf:
 *
 *   - nichts, was schon in der Bibliothek steht (auch nicht von der Merkliste)
 *   - nichts, das aus einer abgebrochenen Serie abgeleitet wurde
 *   - nichts, das aus einer schlecht bewerteten Serie abgeleitet wurde
 *
 * Der zweite wichtige Punkt ist die Reihenfolge: Ein Titel, der zu mehreren
 * Lieblingsserien passt, muss über einem stehen, der nur zu einer passt.
 * Genau das unterscheidet eine Empfehlung von einer Zufallsliste.
 *
 * Es wird kein einziger echter TMDB-Aufruf gemacht. Stattdessen bekommt
 * getPersonalRecommendations über opts.client einen nachgebauten Zugang
 * untergeschoben, der feste Antworten liefert und mitzählt, wie oft er
 * gefragt wurde – daran lässt sich auch der Zwischenspeicher prüfen.
 * ---------------------------------------------------------------------------
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamo-recommend-'));
process.env.DATA_DIR = tempDir;

const { db, run, get } = await import('../src/db.js');
const { buildTasteProfile, getPersonalRecommendations, clearRecommendationCache } = await import(
  '../src/recommend.js'
);

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

console.log('\nStreamo – Persönliche Empfehlungen\n');

// ===========================================================================
// Ausgangslage
// ===========================================================================

run("INSERT INTO users (username, password_hash, region) VALUES ('anna','x:y','DE')");
run("INSERT INTO users (username, password_hash, region) VALUES ('neu','x:y','DE')");

const anna = get("SELECT id FROM users WHERE username='anna'").id;
const neuling = get("SELECT id FROM users WHERE username='neu'").id;

/**
 * Legt eine Serie oder einen Film an und hängt ihn in Annas Bibliothek.
 *
 * Direkt über SQL statt über store.upsertShow – der würde TMDB-Details
 * erwarten, und hier geht es nur um die Zeilen in der Datenbank.
 *
 * @param {object} spec
 * @returns {number} die interne show_id
 */
function addToLibrary(spec) {
  run(
    `INSERT INTO shows (tmdb_id, media_type, title, genres, vote_average)
     VALUES (?,?,?,?,?)`,
    spec.tmdbId,
    spec.mediaType || 'tv',
    spec.title,
    JSON.stringify(spec.genres || []),
    spec.voteAverage ?? 8.0,
  );

  const showId = get(
    'SELECT id FROM shows WHERE tmdb_id = ? AND media_type = ?',
    spec.tmdbId,
    spec.mediaType || 'tv',
  ).id;

  run(
    'INSERT INTO library (user_id, show_id, status, rating, favorite) VALUES (?,?,?,?,?)',
    spec.userId ?? anna,
    showId,
    spec.status,
    spec.rating ?? null,
    spec.favorite ? 1 : 0,
  );

  return showId;
}

// Annas Bibliothek: bewusst mit allen Sonderfällen bestückt.
addToLibrary({ tmdbId: 1396, title: 'Breaking Bad', status: 'completed', rating: 10, genres: ['Krimi', 'Drama'] });
addToLibrary({ tmdbId: 1399, title: 'Game of Thrones', status: 'completed', rating: 9, genres: ['Drama', 'Fantasy'] });
addToLibrary({ tmdbId: 66732, title: 'Stranger Things', status: 'watching', favorite: 1, genres: ['Mystery', 'Drama'] });

// Diese drei dürfen KEINE Empfehlungen auslösen:
addToLibrary({ tmdbId: 999001, title: 'Nur vorgemerkt', status: 'watchlist', genres: ['Drama'] });
addToLibrary({ tmdbId: 999002, title: 'Abgebrochen', status: 'dropped', genres: ['Horror'] });
addToLibrary({ tmdbId: 999003, title: 'Fand ich schlecht', status: 'completed', rating: 3, genres: ['Western'] });

// ===========================================================================
// Geschmacksprofil
// ===========================================================================
console.log('Geschmacksprofil');

const profile = buildTasteProfile(anna);
const seedTitles = profile.seeds.map((seed) => seed.title);

check('Drei Titel taugen als Grundlage', profile.seeds.length, 3);
check('Die Merkliste zählt nicht – gesehen hat man sie ja nicht', seedTitles.includes('Nur vorgemerkt'), false);
check('Abgebrochenes zählt nicht', seedTitles.includes('Abgebrochen'), false);
check('Schlecht Bewertetes zählt nicht', seedTitles.includes('Fand ich schlecht'), false);

check('Die 10 von 10 steht vorn', profile.seeds[0].title, 'Breaking Bad');

/** Holt das Gewicht eines Titels aus dem Profil. */
const gewicht = (title) => profile.seeds.find((seed) => seed.title === title).weight;

check('Eine 10 wiegt schwerer als eine 9', gewicht('Breaking Bad') > gewicht('Game of Thrones'), true);
check(
  'Und schwerer als ein Favorit ohne Bewertung – eine Zahl ist deutlicher',
  gewicht('Breaking Bad') > gewicht('Stranger Things'),
  true,
);
check(
  'Ein Favorit ohne Bewertung zählt trotzdem',
  seedTitles.includes('Stranger Things'),
  true,
);

check(
  'Drama kommt in drei Titeln vor und führt die Genres an',
  profile.genres[0].name,
  'Drama',
);

check(
  'Auch die Merkliste steht auf der Ausschlussliste – vorschlagen muss man sie nicht mehr',
  profile.inLibrary.has('tv:999001'),
  true,
);
check('Und Abgebrochenes ebenso', profile.inLibrary.has('tv:999002'), true);

console.log('\nEine leere Bibliothek');

const leer = buildTasteProfile(neuling);
check('Keine Saatkörner', leer.seeds.length, 0);
check('Keine Genres', leer.genres.length, 0);

console.log('\nNur auf Filme eingeschränkt');

addToLibrary({ tmdbId: 550, mediaType: 'movie', title: 'Fight Club', status: 'completed', rating: 9, genres: ['Drama'] });

const nurFilme = buildTasteProfile(anna, { mediaType: 'movie' });
check('Es bleibt der eine Film', nurFilme.seeds.map((s) => s.title), ['Fight Club']);
check(
  'Die Ausschlussliste umfasst trotzdem beide Typen – sonst käme eine Serie doppelt',
  nurFilme.inLibrary.has('tv:1396'),
  true,
);

// ===========================================================================
// Der nachgebaute TMDB-Zugang
// ===========================================================================

/**
 * Baut einen TMDB-Ersatz mit festen Antworten.
 *
 * @param {object} responses tmdbId -> Liste roher Einträge
 * @returns {object} mit denselben Methoden, die src/recommend.js aufruft
 */
function fakeClient(responses) {
  const calls = { recommendations: [], discover: 0, genres: 0 };

  return {
    calls,

    async getRecommendations(tmdbId) {
      calls.recommendations.push(tmdbId);

      // Ein Saatkorn ohne hinterlegte Antwort wirft – so lässt sich prüfen,
      // dass ein Ausfall die übrigen nicht mitreißt.
      if (!(tmdbId in responses)) throw new Error('TMDB kennt diesen Titel nicht');

      return { results: responses[tmdbId] };
    },

    async getGenres() {
      calls.genres++;
      return { genres: [{ id: 18, name: 'Drama' }, { id: 80, name: 'Krimi' }] };
    },

    async discover() {
      calls.discover++;
      return { results: [] };
    },
  };
}

/** Ein vollständiger roher TMDB-Serieneintrag. */
const raw = (id, name, extra = {}) => ({
  id,
  name,
  poster_path: `/p${id}.jpg`,
  overview: '',
  first_air_date: '2015-01-01',
  vote_average: 8,
  genre_ids: [18],
  ...extra,
});

// ===========================================================================
// Vorschläge
// ===========================================================================
console.log('\nVorschläge zusammenstellen');

clearRecommendationCache();

// Der Aufbau ist so gewählt, dass genau ein Titel von zwei Saatkörnern
// empfohlen wird: "Better Call Saul" steht bei Breaking Bad auf Platz 1 und
// bei Game of Thrones auf Platz 2. Er muss die Liste anführen – obwohl
// "Sopranos" bei Breaking Bad ebenfalls weit oben steht, aber eben nur dort.
const client = fakeClient({
  1396: [raw(60059, 'Better Call Saul'), raw(1400, 'Sopranos')],
  1399: [raw(1402, 'The Walking Dead'), raw(60059, 'Better Call Saul')],
  66732: [],
});

const empfehlung = await getPersonalRecommendations(anna, { client, noCache: true, mediaType: 'tv' });
const titel = empfehlung.results.map((item) => item.title);

check('Es kommt etwas heraus', empfehlung.results.length > 0, true);
check(
  'Der Titel, zu dem zwei Lieblingsserien raten, steht vorn',
  titel[0],
  'Better Call Saul',
);
check('Die anderen sind auch dabei', titel.includes('The Walking Dead'), true);

check(
  'Die Begründung nennt beide Anlässe',
  empfehlung.results[0].reason,
  'Weil du „Breaking Bad“ und „Game of Thrones“ gesehen hast',
);
check(
  'Bei nur einem Anlass steht auch nur einer da',
  empfehlung.results.find((item) => item.title === 'Sopranos').reason,
  'Weil du „Breaking Bad“ gesehen hast',
);

check(
  'Die verwendeten Titel werden offengelegt',
  empfehlung.basedOn.map((entry) => entry.title).includes('Breaking Bad'),
  true,
);
check('Kein Grund zur Entschuldigung, es gibt ja Vorschläge', empfehlung.reason, null);

console.log('\nWas draußen bleiben muss');

clearRecommendationCache();

const mitBekanntem = fakeClient({
  1396: [
    // Steht schon in der Bibliothek (Merkliste) – darf nicht auftauchen.
    raw(999001, 'Nur vorgemerkt'),
    // Ohne Poster – sieht auf einer Kachel aus wie ein Fehler.
    raw(70000, 'Ohne Bild', { poster_path: null }),
    // Der einzige gültige Vorschlag.
    raw(70001, 'Etwas Neues'),
  ],
  1399: [],
  66732: [],
});

const gefiltert = await getPersonalRecommendations(anna, {
  client: mitBekanntem,
  noCache: true,
  mediaType: 'tv',
});

check(
  'Es bleibt genau der eine brauchbare Vorschlag',
  gefiltert.results.map((item) => item.title),
  ['Etwas Neues'],
);

console.log('\nWenn TMDB zu einem Titel nichts weiß');

clearRecommendationCache();

// Nur für Breaking Bad ist etwas hinterlegt; die beiden anderen Saatkörner
// lassen den nachgebauten Zugang werfen.
const mitAusfall = fakeClient({ 1396: [raw(70002, 'Trotzdem da')] });

const robust = await getPersonalRecommendations(anna, {
  client: mitAusfall,
  noCache: true,
  mediaType: 'tv',
});

check('Ein Ausfall reißt nicht alles mit', robust.results.map((item) => item.title), ['Trotzdem da']);
check('Alle drei Saatkörner wurden versucht', mitAusfall.calls.recommendations.length, 3);

// ===========================================================================
// Eine leere Bibliothek
// ===========================================================================
console.log('\nWer noch nichts gesehen hat');

clearRecommendationCache();

const stiller = fakeClient({});
const nichts = await getPersonalRecommendations(neuling, { client: stiller, noCache: true });

check('Bekommt keine Vorschläge', nichts.results.length, 0);
check('Aber eine Erklärung', typeof nichts.reason === 'string' && nichts.reason.length > 0, true);
check(
  'Und TMDB wird gar nicht erst gefragt',
  stiller.calls.recommendations.length,
  0,
);

// ===========================================================================
// Zwischenspeicher
// ===========================================================================
console.log('\nZwischenspeicher');

clearRecommendationCache();

const gezaehlt = fakeClient({ 1396: [raw(70003, 'Einmal geholt')], 1399: [], 66732: [] });

await getPersonalRecommendations(anna, { client: gezaehlt, mediaType: 'tv' });
const nachErstem = gezaehlt.calls.recommendations.length;

await getPersonalRecommendations(anna, { client: gezaehlt, mediaType: 'tv' });

check('Der zweite Aufruf fragt TMDB nicht noch einmal', gezaehlt.calls.recommendations.length, nachErstem);

// Eine Änderung an der Bibliothek muss den Zwischenspeicher entwerten – sonst
// bekäme man tagelang Vorschläge zu einer Serie, die man längst gesehen hat.
run("UPDATE library SET rating = 7, updated_at = datetime('now','+1 hour') WHERE user_id = ? AND rating = 10", anna);

await getPersonalRecommendations(anna, { client: gezaehlt, mediaType: 'tv' });

check(
  'Nach einer Änderung in der Bibliothek wird neu gerechnet',
  gezaehlt.calls.recommendations.length > nachErstem,
  true,
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
