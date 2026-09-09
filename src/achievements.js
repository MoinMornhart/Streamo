/**
 * ---------------------------------------------------------------------------
 * src/achievements.js – Erfolge
 * ---------------------------------------------------------------------------
 * Rolle im Gesamtsystem:
 *   Belohnt, was man in Streamo ohnehin tut: Serien zu Ende schauen, die
 *   Bibliothek pflegen, Abos verknüpfen. Manche Erfolge hängen an einer
 *   bestimmten Serie ("alles von Dr. House gesehen"), andere an Mengen oder
 *   an der Art, wie jemand schaut.
 *
 * Warum stehen die Erfolge im Code und nicht in der Datenbank?
 *   Weil sie zum Programm gehören wie ein Menütext. In der Datenbank steht
 *   nur, WER WELCHEN Erfolg WANN bekommen hat. Neue Erfolge kommen so mit
 *   einem Update dazu, ohne dass jemand Datensätze pflegen müsste – und beim
 *   nächsten Nachrechnen werden sie rückwirkend vergeben.
 *
 * Wann wird geprüft?
 *   Nach jeder Handlung, die etwas verändern könnte: Episode abgehakt,
 *   Status geändert, Serie hinzugefügt, Anbieter verknüpft. Die Prüfung
 *   läuft vollständig auf der lokalen Datenbank, kostet also keine
 *   TMDB-Aufrufe und dauert wenige Millisekunden.
 *
 * Verknüpfungen zu anderen Dateien:
 *   - src/db.js                 -> Tabelle `user_achievements`
 *   - src/routes/shows.js       -> prüft nach dem Abhaken von Episoden
 *   - src/routes/library.js     -> prüft nach Änderungen an der Bibliothek
 *   - src/routes/providers.js   -> prüft nach dem Verknüpfen von Abos
 *   - src/routes/achievements.js-> liefert die Liste ans Frontend
 *   - public/js/views/achievements.js -> die Anzeige
 * ---------------------------------------------------------------------------
 */

import { all, get, run } from './db.js';

/**
 * Serien-Erfolge: Wer eine dieser Serien vollständig gesehen hat, bekommt
 * den zugehörigen Titel.
 *
 * Der Schlüssel ist die TMDB-ID der Serie. "Vollständig" heißt: Der
 * Bibliothekseintrag steht auf "completed", oder alle bekannten Episoden
 * sind abgehakt.
 *
 * Die Titel spielen jeweils auf die Serie an – das ist der Reiz daran.
 */
const SHOW_ACHIEVEMENTS = [
  { id: 'house', tmdbId: 1408, title: 'Regelbrecher', icon: '💊',
    description: 'Alles von Dr. House gesehen. Everybody lies – aber du hast durchgehalten.' },
  { id: 'breaking_bad', tmdbId: 1396, title: 'Heisenberg', icon: '🧪',
    description: 'Breaking Bad vollständig gesehen. Say my name.' },
  { id: 'got', tmdbId: 1399, title: 'Der Eiserne Thron', icon: '🐉',
    description: 'Game of Thrones bis zum Ende. Auch durch die letzte Staffel.' },
  { id: 'sopranos', tmdbId: 1398, title: 'Familienoberhaupt', icon: '🍝',
    description: 'Die Sopranos komplett gesehen.' },
  { id: 'the_wire', tmdbId: 1438, title: 'Alle Ecken abgeklappert', icon: '🚔',
    description: 'The Wire vollständig gesehen.' },
  { id: 'simpsons', tmdbId: 456, title: 'Ay Caramba', icon: '🍩',
    description: 'Alle Simpsons gesehen. Das sind über 700 Episoden.' },
  { id: 'friends', tmdbId: 1668, title: 'Der siebte Freund', icon: '☕',
    description: 'Friends komplett gesehen. I’ll be there for you.' },
  { id: 'office_us', tmdbId: 2316, title: 'Weltbester Chef', icon: '📎',
    description: 'The Office vollständig gesehen.' },
  { id: 'walking_dead', tmdbId: 1402, title: 'Überlebender', icon: '🧟',
    description: 'The Walking Dead durchgestanden.' },
  { id: 'stranger_things', tmdbId: 66732, title: 'Aus der Anderswelt', icon: '🔦',
    description: 'Stranger Things vollständig gesehen.' },
  { id: 'sherlock', tmdbId: 19885, title: 'Höchst deduktiv', icon: '🔎',
    description: 'Sherlock komplett gesehen.' },
  { id: 'rick_morty', tmdbId: 60625, title: 'Wubba Lubba Dub Dub', icon: '🥒',
    description: 'Rick and Morty vollständig gesehen.' },
  { id: 'dark', tmdbId: 70523, title: 'Die Frage ist nicht wer, sondern wann', icon: '🕳️',
    description: 'Dark komplett gesehen – und hoffentlich verstanden.' },
  { id: 'chernobyl', tmdbId: 87108, title: 'Was kostet eine Lüge?', icon: '☢️',
    description: 'Chernobyl vollständig gesehen.' },
  { id: 'better_call_saul', tmdbId: 60059, title: 'Ist es rechtens?', icon: '⚖️',
    description: 'Better Call Saul komplett gesehen.' },
  { id: 'twin_peaks', tmdbId: 1920, title: 'Die Eulen sind nicht, was sie scheinen', icon: '🦉',
    description: 'Twin Peaks vollständig gesehen.' },
  { id: 'x_files', tmdbId: 4087, title: 'Die Wahrheit ist irgendwo da draußen', icon: '👽',
    description: 'Akte X komplett gesehen.' },
  { id: 'lost', tmdbId: 4607, title: 'Nicht alle Fragen beantwortet', icon: '🏝️',
    description: 'Lost bis zum Ende gesehen.' },
];

/**
 * Die übrigen Erfolge – sie hängen an Zahlen und Verhalten, nicht an einer
 * bestimmten Serie.
 *
 * Jeder Eintrag bringt eine `check`-Funktion mit, die eine Zusammenfassung
 * der Nutzerdaten bekommt und true zurückgibt, wenn der Erfolg verdient ist.
 * `progress` liefert optional den Fortschritt für die Anzeige ("7 von 25").
 */
const GENERAL_ACHIEVEMENTS = [
  // --- Einstieg -------------------------------------------------------------
  {
    id: 'first_show',
    title: 'Der Anfang',
    icon: '🌱',
    description: 'Die erste Serie in die Bibliothek aufgenommen.',
    check: (s) => s.libraryCount >= 1,
    progress: (s) => ({ current: Math.min(s.libraryCount, 1), goal: 1 }),
  },
  {
    id: 'first_episode',
    title: 'Pilotfolge',
    icon: '▶️',
    description: 'Die erste Episode abgehakt.',
    check: (s) => s.watchedEpisodes >= 1,
    progress: (s) => ({ current: Math.min(s.watchedEpisodes, 1), goal: 1 }),
  },
  {
    id: 'first_completed',
    title: 'Durchgezogen',
    icon: '🏁',
    description: 'Die erste Serie vollständig gesehen.',
    check: (s) => s.completedCount >= 1,
    progress: (s) => ({ current: Math.min(s.completedCount, 1), goal: 1 }),
  },

  // --- Sammler --------------------------------------------------------------
  {
    id: 'collector_25',
    title: 'Sammler',
    icon: '📚',
    description: '25 Titel in der Bibliothek.',
    check: (s) => s.libraryCount >= 25,
    progress: (s) => ({ current: s.libraryCount, goal: 25 }),
  },
  {
    id: 'collector_100',
    title: 'Archivar',
    icon: '🗄️',
    description: '100 Titel in der Bibliothek.',
    check: (s) => s.libraryCount >= 100,
    progress: (s) => ({ current: s.libraryCount, goal: 100 }),
  },

  // --- Vielseher ------------------------------------------------------------
  {
    id: 'episodes_100',
    title: 'Hundertmarke',
    icon: '💯',
    description: '100 Episoden gesehen.',
    check: (s) => s.watchedEpisodes >= 100,
    progress: (s) => ({ current: s.watchedEpisodes, goal: 100 }),
  },
  {
    id: 'episodes_1000',
    title: 'Tausendsassa',
    icon: '🎖️',
    description: '1000 Episoden gesehen.',
    check: (s) => s.watchedEpisodes >= 1000,
    progress: (s) => ({ current: s.watchedEpisodes, goal: 1000 }),
  },
  {
    id: 'completed_10',
    title: 'Serienjunkie',
    icon: '🍿',
    description: '10 Serien vollständig gesehen.',
    check: (s) => s.completedCount >= 10,
    progress: (s) => ({ current: s.completedCount, goal: 10 }),
  },
  {
    id: 'completed_50',
    title: 'Legende',
    icon: '👑',
    description: '50 Serien vollständig gesehen.',
    check: (s) => s.completedCount >= 50,
    progress: (s) => ({ current: s.completedCount, goal: 50 }),
  },

  // --- Zeit -----------------------------------------------------------------
  {
    id: 'day_watched',
    title: 'Ein ganzer Tag',
    icon: '🌗',
    description: '24 Stunden Sehzeit zusammen.',
    check: (s) => s.watchedMinutes >= 1440,
    progress: (s) => ({ current: Math.round(s.watchedMinutes / 60), goal: 24, unit: 'Std.' }),
  },
  {
    id: 'week_watched',
    title: 'Eine ganze Woche',
    icon: '🌘',
    description: '7 Tage Sehzeit zusammen. Das sind 168 Stunden.',
    check: (s) => s.watchedMinutes >= 10080,
    progress: (s) => ({ current: Math.round(s.watchedMinutes / 60), goal: 168, unit: 'Std.' }),
  },
  {
    id: 'month_watched',
    title: 'Ein ganzer Monat',
    icon: '🌑',
    description: '30 Tage reine Sehzeit. Beeindruckend und beunruhigend zugleich.',
    check: (s) => s.watchedMinutes >= 43200,
    progress: (s) => ({ current: Math.round(s.watchedMinutes / 1440), goal: 30, unit: 'Tage' }),
  },

  // --- Verhalten ------------------------------------------------------------
  {
    id: 'binge_10',
    title: 'Durchgesuchtet',
    icon: '🔥',
    description: '10 Episoden an einem einzigen Tag abgehakt.',
    check: (s) => s.maxEpisodesOneDay >= 10,
    progress: (s) => ({ current: s.maxEpisodesOneDay, goal: 10 }),
  },
  {
    id: 'binge_25',
    title: 'Nachtschicht',
    icon: '🌙',
    description: '25 Episoden an einem einzigen Tag. Respekt.',
    check: (s) => s.maxEpisodesOneDay >= 25,
    progress: (s) => ({ current: s.maxEpisodesOneDay, goal: 25 }),
  },
  {
    id: 'marathon_show',
    title: 'Marathonläufer',
    icon: '🏃',
    description: 'Eine Serie mit mehr als 100 Episoden vollständig gesehen.',
    check: (s) => s.longestCompleted >= 100,
    progress: (s) => ({ current: s.longestCompleted, goal: 100 }),
  },

  // --- Abos -----------------------------------------------------------------
  {
    id: 'providers_3',
    title: 'Gut versorgt',
    icon: '📡',
    description: 'Drei Streaming-Abos verknüpft.',
    check: (s) => s.providerCount >= 3,
    progress: (s) => ({ current: s.providerCount, goal: 3 }),
  },
  {
    id: 'providers_6',
    title: 'Abo-Sammler',
    icon: '💸',
    description: 'Sechs Streaming-Abos verknüpft. Rechnest du das mal zusammen?',
    check: (s) => s.providerCount >= 6,
    progress: (s) => ({ current: s.providerCount, goal: 6 }),
  },
  {
    id: 'all_covered',
    title: 'Lückenlos',
    icon: '✅',
    description: 'Jeder Titel deiner Watchlist läuft bei einem deiner Anbieter.',
    // Mindestens fünf Titel, sonst wäre der Erfolg zu billig.
    check: (s) => s.watchlistCount >= 5 && s.uncoveredCount === 0,
  },

  // --- Pflege ---------------------------------------------------------------
  {
    id: 'critic',
    title: 'Kritiker',
    icon: '⭐',
    description: '25 Titel bewertet.',
    check: (s) => s.ratedCount >= 25,
    progress: (s) => ({ current: s.ratedCount, goal: 25 }),
  },
  {
    id: 'perfectionist',
    title: 'Perfektionist',
    icon: '🎯',
    description: 'Fünf Serien mit voller Punktzahl bewertet.',
    check: (s) => s.perfectRatings >= 5,
    progress: (s) => ({ current: s.perfectRatings, goal: 5 }),
  },
  {
    id: 'dropout',
    title: 'Konsequent',
    icon: '🚪',
    description: 'Fünf Serien abgebrochen. Auch das ist eine Entscheidung.',
    check: (s) => s.droppedCount >= 5,
    progress: (s) => ({ current: s.droppedCount, goal: 5 }),
  },
];

/**
 * Sammelt alle Kennzahlen, die für die Prüfung gebraucht werden – in einem
 * Durchgang statt einer Abfrage je Erfolg.
 *
 * @param {number} userId
 * @returns {object} Zusammenfassung für die check-Funktionen
 */
function collectStats(userId) {
  const one = (sql, ...params) => get(sql, ...params) ?? {};

  const library = one(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
       SUM(CASE WHEN status = 'dropped'   THEN 1 ELSE 0 END) AS dropped,
       SUM(CASE WHEN status = 'watchlist' THEN 1 ELSE 0 END) AS watchlist,
       SUM(CASE WHEN rating IS NOT NULL   THEN 1 ELSE 0 END) AS rated,
       SUM(CASE WHEN rating = 10          THEN 1 ELSE 0 END) AS perfect
     FROM library WHERE user_id = ?`,
    userId,
  );

  const watched = one(
    `SELECT COUNT(*) AS episodes,
            SUM(COALESCE(e.runtime, s.runtime, 45)) AS minutes
       FROM watched_episodes w
       JOIN episodes e ON e.id = w.episode_id
       JOIN shows s ON s.id = w.show_id
      WHERE w.user_id = ?`,
    userId,
  );

  // Der stärkste Tag: An welchem Datum wurden die meisten Episoden abgehakt?
  // date() schneidet die Uhrzeit ab, sodass nach Kalendertagen gruppiert wird.
  const bestDay = one(
    `SELECT COUNT(*) AS n
       FROM watched_episodes
      WHERE user_id = ?
      GROUP BY date(watched_at)
      ORDER BY n DESC
      LIMIT 1`,
    userId,
  );

  // Die längste vollständig gesehene Serie – für den Marathon-Erfolg.
  const longest = one(
    `SELECT MAX(s.number_of_episodes) AS n
       FROM library l JOIN shows s ON s.id = l.show_id
      WHERE l.user_id = ? AND l.status = 'completed'`,
    userId,
  );

  const providers = one(
    'SELECT COUNT(*) AS n FROM user_providers WHERE user_id = ?',
    userId,
  );

  // Wie viele Titel der Watchlist laufen bei KEINEM der eigenen Anbieter?
  const region = get('SELECT region FROM users WHERE id = ?', userId)?.region || 'DE';

  const uncovered = one(
    `SELECT COUNT(*) AS n
       FROM library l
      WHERE l.user_id = ?
        AND l.status IN ('watchlist','watching')
        AND NOT EXISTS (
          SELECT 1 FROM availability a
           JOIN user_providers up
             ON up.provider_id = a.provider_id AND up.user_id = l.user_id
          WHERE a.show_id = l.show_id
            AND a.region = ?
            AND a.offer_type IN ('flatrate','free','ads')
        )`,
    userId,
    region,
  );

  return {
    libraryCount: library.total ?? 0,
    completedCount: library.completed ?? 0,
    droppedCount: library.dropped ?? 0,
    watchlistCount: library.watchlist ?? 0,
    ratedCount: library.rated ?? 0,
    perfectRatings: library.perfect ?? 0,
    watchedEpisodes: watched.episodes ?? 0,
    watchedMinutes: watched.minutes ?? 0,
    maxEpisodesOneDay: bestDay.n ?? 0,
    longestCompleted: longest.n ?? 0,
    providerCount: providers.n ?? 0,
    uncoveredCount: uncovered.n ?? 0,
  };
}

/**
 * Ermittelt, welche Serien-Erfolge verdient sind.
 *
 * Eine Serie zählt als vollständig gesehen, wenn ihr Bibliothekseintrag auf
 * "completed" steht. Das ist der verlässlichste Maßstab: Streamo setzt diesen
 * Status automatisch, sobald alle Episoden abgehakt sind (siehe
 * src/routes/shows.js), und wer eine Serie vor Jahren gesehen hat, kann ihn
 * auch von Hand setzen, ohne jede Folge einzeln anzuklicken.
 *
 * @param {number} userId
 * @returns {Set<string>} die IDs der verdienten Serien-Erfolge
 */
function earnedShowAchievements(userId) {
  const completed = all(
    `SELECT s.tmdb_id
       FROM library l JOIN shows s ON s.id = l.show_id
      WHERE l.user_id = ? AND l.status = 'completed' AND s.media_type = 'tv'`,
    userId,
  );

  const completedIds = new Set(completed.map((row) => row.tmdb_id));

  return new Set(
    SHOW_ACHIEVEMENTS.filter((a) => completedIds.has(a.tmdbId)).map((a) => a.id),
  );
}

/**
 * Prüft alle Erfolge und trägt neu verdiente ein.
 *
 * Wird nach jeder relevanten Handlung aufgerufen. Der Aufruf ist billig
 * (etwa sechs Abfragen auf die lokale Datenbank) und darf deshalb großzügig
 * verwendet werden.
 *
 * Einmal vergebene Erfolge werden nie wieder entzogen – auch nicht, wenn
 * jemand später Serien aus der Bibliothek entfernt. Ein Erfolg ist eine
 * Erinnerung an etwas Geschafftes, keine laufende Zustandsanzeige.
 *
 * @param {number} userId
 * @returns {object[]} die NEU vergebenen Erfolge (für die Meldung im UI)
 */
export function checkAchievements(userId) {
  const stats = collectStats(userId);
  const earnedShows = earnedShowAchievements(userId);

  // Was hat der Benutzer bereits?
  const existing = new Set(
    all('SELECT achievement_id FROM user_achievements WHERE user_id = ?', userId).map(
      (row) => row.achievement_id,
    ),
  );

  const newlyEarned = [];

  /**
   * Trägt einen Erfolg ein, sofern er neu ist.
   * @param {object} achievement
   */
  const award = (achievement) => {
    if (existing.has(achievement.id)) return;

    run(
      `INSERT INTO user_achievements (user_id, achievement_id)
       VALUES (?, ?)
       -- Zwei gleichzeitige Anfragen könnten denselben Erfolg vergeben wollen.
       ON CONFLICT(user_id, achievement_id) DO NOTHING`,
      userId,
      achievement.id,
    );

    newlyEarned.push({
      id: achievement.id,
      title: achievement.title,
      icon: achievement.icon,
      description: achievement.description,
    });
  };

  for (const achievement of SHOW_ACHIEVEMENTS) {
    if (earnedShows.has(achievement.id)) award(achievement);
  }

  for (const achievement of GENERAL_ACHIEVEMENTS) {
    // Eine fehlerhafte check-Funktion darf nicht die ganze Handlung
    // scheitern lassen, die sie ausgelöst hat.
    try {
      if (achievement.check(stats)) award(achievement);
    } catch (error) {
      console.error(`[achievements] "${achievement.id}" nicht prüfbar:`, error.message);
    }
  }

  return newlyEarned;
}

/**
 * Liefert alle Erfolge mit ihrem Zustand für die Anzeige.
 *
 * Auch die noch nicht erreichten sind dabei – erst dadurch sieht man, worauf
 * man hinarbeiten kann. Bei Serien-Erfolgen bleibt der Titel allerdings
 * verborgen, solange er nicht verdient ist: Die Anspielung ist die halbe
 * Freude, und vorab gelesen wäre sie verschenkt.
 *
 * @param {number} userId
 * @returns {{earned: object[], locked: object[], total: number, earnedCount: number}}
 */
export function listAchievements(userId) {
  const stats = collectStats(userId);
  const earnedShows = earnedShowAchievements(userId);

  // Wann wurde was vergeben?
  const awardedAt = new Map(
    all(
      'SELECT achievement_id, earned_at FROM user_achievements WHERE user_id = ?',
      userId,
    ).map((row) => [row.achievement_id, row.earned_at]),
  );

  const earned = [];
  const locked = [];

  // --- Serien-Erfolge -------------------------------------------------------
  for (const achievement of SHOW_ACHIEVEMENTS) {
    const has = awardedAt.has(achievement.id) || earnedShows.has(achievement.id);

    if (has) {
      earned.push({
        ...achievement,
        kind: 'show',
        earnedAt: awardedAt.get(achievement.id) ?? null,
      });
    } else {
      locked.push({
        id: achievement.id,
        kind: 'show',
        icon: '🔒',
        // Der Serientitel wird genannt, der Erfolgstitel nicht – so weiß man,
        // was zu tun ist, ohne die Pointe zu kennen.
        title: 'Noch verborgen',
        description: 'Sieh eine bestimmte Serie vollständig, um diesen Erfolg freizuschalten.',
      });
    }
  }

  // --- Allgemeine Erfolge ---------------------------------------------------
  for (const achievement of GENERAL_ACHIEVEMENTS) {
    const has = awardedAt.has(achievement.id);

    let progress = null;
    try {
      progress = achievement.progress ? achievement.progress(stats) : null;
    } catch {
      /* Fortschritt ist nur Beiwerk */
    }

    const entry = {
      id: achievement.id,
      kind: 'general',
      title: achievement.title,
      icon: has ? achievement.icon : '🔒',
      description: achievement.description,
      progress,
      earnedAt: awardedAt.get(achievement.id) ?? null,
    };

    if (has) earned.push({ ...entry, icon: achievement.icon });
    else locked.push(entry);
  }

  // Die zuletzt verdienten zuerst – das ist die interessanteste Reihenfolge.
  earned.sort((a, b) => String(b.earnedAt ?? '').localeCompare(String(a.earnedAt ?? '')));

  return {
    earned,
    locked,
    total: SHOW_ACHIEVEMENTS.length + GENERAL_ACHIEVEMENTS.length,
    earnedCount: earned.length,
  };
}
