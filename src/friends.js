/**
 * ---------------------------------------------------------------------------
 * src/friends.js – Freunde und gemeinsames Schauen
 * ---------------------------------------------------------------------------
 * Rolle im Gesamtsystem:
 *   Verbindet die Konten einer Instanz miteinander. Das eigentliche Ziel ist
 *   nicht die Freundesliste an sich, sondern die Frage, die man sich an einem
 *   gemeinsamen Abend stellt:
 *
 *     "Was können wir zusammen schauen?"
 *
 *   Die Antwort darauf ist der Kern dieser Datei (findCommonGround weiter
 *   unten). Sie ergibt sich aus dem, was Streamo ohnehin weiß: den Abos
 *   beider Personen und ihren beiden Listen.
 *
 * Wie werden Freundschaften gespeichert?
 *   Als EINE Zeile in der Richtung der Anfrage. Beim Lesen wird deshalb immer
 *   in beide Richtungen gesucht. Zwei Zeilen je Freundschaft wären einfacher
 *   abzufragen, aber schwerer konsistent zu halten – bei jedem Annehmen und
 *   Entfernen müsste man beide pflegen.
 *
 * Zur Privatsphäre:
 *   Freunde sehen voneinander die Bibliothek mit Status und Bewertungen. Sie
 *   sehen NICHT die persönlichen Notizen zu einem Titel – die sind für einen
 *   selbst gedacht.
 *
 * Verknüpfungen zu anderen Dateien:
 *   - src/db.js              -> Tabellen `friendships` und `recommendations`
 *   - src/store.js           -> buildAvailabilityView für die Verfügbarkeit
 *   - src/routes/friends.js  -> die HTTP-Endpunkte
 *   - public/js/views/friends.js -> die Anzeige
 * ---------------------------------------------------------------------------
 */

import { all, get, run } from './db.js';
import { buildAvailabilityView, getSubscribedProviderIds } from './store.js';

/**
 * Sucht ein Konto anhand des Anmeldenamens oder der E-Mail.
 *
 * Gebraucht beim Stellen einer Freundschaftsanfrage. Zurück kommt nur, was
 * für die Anzeige nötig ist – nie der Passwort-Hash.
 *
 * @param {string} identifier
 * @returns {object|undefined}
 */
export function findUserByName(identifier) {
  const value = String(identifier || '').trim();
  if (!value) return undefined;

  return get(
    `SELECT id, username, display_name
       FROM users
      WHERE username = ? OR email = ? COLLATE NOCASE`,
    value,
    value,
  );
}

/**
 * Ermittelt den Stand zwischen zwei Konten.
 *
 * Sucht in beide Richtungen, weil eine Freundschaft nur einmal gespeichert
 * wird – in der Richtung, in der angefragt wurde.
 *
 * @param {number} userId
 * @param {number} otherId
 * @returns {{status: 'none'|'pending'|'accepted', direction: 'outgoing'|'incoming'|null}}
 */
export function getFriendshipStatus(userId, otherId) {
  const row = get(
    `SELECT user_id, friend_id, status
       FROM friendships
      WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)`,
    userId,
    otherId,
    otherId,
    userId,
  );

  if (!row) return { status: 'none', direction: null };

  return {
    status: row.status,
    // Wer hat angefragt? Entscheidet, ob man annehmen kann oder warten muss.
    direction: row.user_id === userId ? 'outgoing' : 'incoming',
  };
}

/**
 * Stellt eine Freundschaftsanfrage.
 *
 * Sonderfall: Hat die andere Person bereits angefragt, wird die Anfrage
 * sofort angenommen, statt eine zweite in die Gegenrichtung anzulegen. Zwei
 * Menschen, die einander gleichzeitig anfragen, sind sich offensichtlich
 * einig – da wäre eine Rückfrage albern.
 *
 * @param {number} userId
 * @param {number} friendId
 * @returns {{status: string, message: string}}
 * @throws {Error} bei ungültigen Angaben
 */
export function requestFriendship(userId, friendId) {
  if (userId === friendId) {
    throw new Error('Mit dir selbst kannst du dich nicht befreunden.');
  }

  const existing = getFriendshipStatus(userId, friendId);

  if (existing.status === 'accepted') {
    throw new Error('Ihr seid bereits befreundet.');
  }

  if (existing.status === 'pending') {
    if (existing.direction === 'outgoing') {
      throw new Error('Du hast bereits angefragt. Warte auf die Antwort.');
    }

    // Die andere Person hat zuerst angefragt – dann jetzt einfach annehmen.
    acceptFriendship(userId, friendId);
    return { status: 'accepted', message: 'Ihr seid jetzt befreundet.' };
  }

  run(
    "INSERT INTO friendships (user_id, friend_id, status) VALUES (?,?,'pending')",
    userId,
    friendId,
  );

  return { status: 'pending', message: 'Anfrage verschickt.' };
}

/**
 * Nimmt eine Anfrage an.
 *
 * @param {number} userId Wer nimmt an (der Empfänger der Anfrage)
 * @param {number} requesterId Wer hatte angefragt
 * @returns {boolean} false, wenn es gar keine offene Anfrage gab
 */
export function acceptFriendship(userId, requesterId) {
  const result = run(
    `UPDATE friendships
        SET status = 'accepted', accepted_at = datetime('now')
      WHERE user_id = ? AND friend_id = ? AND status = 'pending'`,
    requesterId,
    userId,
  );

  return Number(result.changes) > 0;
}

/**
 * Lehnt eine Anfrage ab oder beendet eine Freundschaft.
 *
 * Beides ist derselbe Vorgang: Die Zeile verschwindet. Eine Ablehnung wird
 * bewusst nicht gespeichert – sie müsste sonst irgendwann wieder verfallen,
 * und sie würde eine spätere erneute Anfrage blockieren.
 *
 * @param {number} userId
 * @param {number} otherId
 * @returns {boolean}
 */
export function removeFriendship(userId, otherId) {
  const result = run(
    `DELETE FROM friendships
      WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)`,
    userId,
    otherId,
    otherId,
    userId,
  );

  return Number(result.changes) > 0;
}

/**
 * Listet Freunde und offene Anfragen.
 *
 * @param {number} userId
 * @returns {{friends: object[], incoming: object[], outgoing: object[]}}
 */
export function listFriends(userId) {
  /**
   * Holt die Gegenseite einer Beziehung – egal in welcher Richtung sie
   * gespeichert wurde.
   *
   * CASE im SELECT: Ist der Benutzer der Anfragende, interessiert der
   * friend_id-Eintrag, sonst der user_id-Eintrag.
   *
   * @param {string} condition zusätzliche WHERE-Bedingung
   * @param {...any} params
   * @returns {object[]}
   */
  const query = (condition, ...params) =>
    all(
      `SELECT u.id, u.username, u.display_name, f.status, f.created_at, f.accepted_at,
              -- Wie viele Titel hat die Person auf ihrer Liste? Nur die Zahl,
              -- nicht die Titel selbst – die gibt es erst im Profil.
              (SELECT COUNT(*) FROM library l WHERE l.user_id = u.id) AS library_count
         FROM friendships f
         JOIN users u
           ON u.id = CASE WHEN f.user_id = ? THEN f.friend_id ELSE f.user_id END
        WHERE ${condition}
        ORDER BY u.display_name, u.username`,
      userId,
      ...params,
    );

  return {
    // Bestätigte Freundschaften, in beide Richtungen.
    friends: query(
      "(f.user_id = ? OR f.friend_id = ?) AND f.status = 'accepted'",
      userId,
      userId,
    ),

    // Anfragen an mich – die kann ich annehmen.
    incoming: query("f.friend_id = ? AND f.status = 'pending'", userId),

    // Meine Anfragen – da heißt es warten.
    outgoing: query("f.user_id = ? AND f.status = 'pending'", userId),
  };
}

/**
 * Prüft, ob zwei Konten befreundet sind.
 *
 * Steht vor jedem Zugriff auf fremde Daten: Ohne bestätigte Freundschaft
 * sieht niemand die Bibliothek eines anderen.
 *
 * @param {number} userId
 * @param {number} otherId
 * @returns {boolean}
 */
export function areFriends(userId, otherId) {
  return getFriendshipStatus(userId, otherId).status === 'accepted';
}

/**
 * Die Bibliothek eines Freundes.
 *
 * Ohne persönliche Notizen – die sind für einen selbst gedacht und gehen
 * niemanden sonst etwas an. Status und Bewertung dagegen sind genau das,
 * weswegen man in die Liste eines Freundes schaut.
 *
 * @param {number} friendId Wessen Bibliothek
 * @param {number} viewerId Wer schaut (für "habe ich das auch?")
 * @param {string} region
 * @returns {object[]}
 */
export function getFriendLibrary(friendId, viewerId, region) {
  const subscribed = getSubscribedProviderIds(viewerId);

  const rows = all(
    `SELECT l.status, l.rating, l.favorite, l.updated_at,
            s.id AS show_id, s.tmdb_id, s.media_type, s.title, s.poster_path,
            s.first_air_date, s.vote_average,
            -- Steht der Titel auch auf MEINER Liste?
            mine.status AS my_status
       FROM library l
       JOIN shows s ON s.id = l.show_id
       LEFT JOIN library mine ON mine.show_id = s.id AND mine.user_id = ?
      WHERE l.user_id = ?
      ORDER BY l.updated_at DESC`,
    viewerId,
    friendId,
  );

  return rows.map((row) => ({
    showId: row.show_id,
    tmdbId: row.tmdb_id,
    mediaType: row.media_type,
    title: row.title,
    posterPath: row.poster_path,
    year: row.first_air_date?.slice(0, 4) || null,
    voteAverage: row.vote_average,
    // Was der Freund damit macht.
    friendStatus: row.status,
    friendRating: row.rating,
    friendFavorite: Boolean(row.favorite),
    // Und was ich damit mache.
    inMyLibrary: row.my_status !== null,
    myStatus: row.my_status,
    // Die Verfügbarkeit richtet sich nach MEINEN Abos – ich will ja wissen,
    // ob ich es sehen kann.
    availability: buildAvailabilityView(row.show_id, region, subscribed),
  }));
}

/**
 * Beantwortet die Frage: "Was können wir zusammen schauen?"
 *
 * Das Herzstück dieser Datei. Zusammengetragen werden drei Dinge, die sich
 * aus dem ergeben, was Streamo ohnehin weiß:
 *
 *   1. Titel, die BEIDE auf der Liste haben und noch keiner gesehen hat.
 *      Der eindeutigste Fall – da sind sich beide schon einig.
 *
 *   2. Titel von der Liste des einen, die der andere noch nicht kennt und
 *      die bei einem Abo laufen, das mindestens einer von beiden hat.
 *
 *   3. Was der Freund hoch bewertet hat und ich noch nicht kenne.
 *
 * Bei allem gilt: Nur was auch abrufbar ist. Ein Vorschlag, den man nirgends
 * sehen kann, ist kein Vorschlag.
 *
 * @param {number} userId
 * @param {number} friendId
 * @param {string} region
 * @returns {object}
 */
export function findCommonGround(userId, friendId, region) {
  // Die Abos beider Seiten zusammengelegt: Was einer von beiden hat, können
  // wir gemeinsam sehen – man schaut ja zusammen auf einem Gerät.
  const myProviders = getSubscribedProviderIds(userId);
  const theirProviders = getSubscribedProviderIds(friendId);
  const combined = new Set([...myProviders, ...theirProviders]);

  // Ohne Abos gibt es nichts zu filtern; dann werden alle Titel betrachtet.
  const providerFilter =
    combined.size > 0
      ? `AND EXISTS (
           SELECT 1 FROM availability a
            WHERE a.show_id = s.id AND a.region = ?
              AND a.offer_type IN ('flatrate','free','ads')
              AND a.provider_id IN (${[...combined].map(() => '?').join(',')})
         )`
      : '';

  const providerParams = combined.size > 0 ? [region, ...combined] : [];

  /**
   * Baut einen Vorschlag für die Antwort auf.
   * @param {object} row
   * @returns {object}
   */
  const toSuggestion = (row) => ({
    showId: row.show_id,
    tmdbId: row.tmdb_id,
    mediaType: row.media_type,
    title: row.title,
    posterPath: row.poster_path,
    year: row.first_air_date?.slice(0, 4) || null,
    voteAverage: row.vote_average,
    friendRating: row.friend_rating ?? null,
    // Verfügbarkeit über die zusammengelegten Abos: Grün heißt hier "einer
    // von uns beiden hat das".
    availability: buildAvailabilityView(row.show_id, region, combined),
  });

  // --- 1. Beide auf der Liste, keiner hat es gesehen -----------------------
  const bothWant = all(
    `SELECT s.id AS show_id, s.tmdb_id, s.media_type, s.title, s.poster_path,
            s.first_air_date, s.vote_average, theirs.rating AS friend_rating
       FROM library mine
       JOIN library theirs ON theirs.show_id = mine.show_id AND theirs.user_id = ?
       JOIN shows s ON s.id = mine.show_id
      WHERE mine.user_id = ?
        AND mine.status IN ('watchlist','watching')
        AND theirs.status IN ('watchlist','watching')
        ${providerFilter}
      ORDER BY s.vote_average DESC
      LIMIT 30`,
    friendId,
    userId,
    ...providerParams,
  );

  // --- 2. Von seiner Liste, für mich neu ----------------------------------
  const fromTheirList = all(
    `SELECT s.id AS show_id, s.tmdb_id, s.media_type, s.title, s.poster_path,
            s.first_air_date, s.vote_average, theirs.rating AS friend_rating
       FROM library theirs
       JOIN shows s ON s.id = theirs.show_id
      WHERE theirs.user_id = ?
        AND theirs.status IN ('watchlist','watching')
        -- Was ich schon kenne, ist kein Vorschlag.
        AND NOT EXISTS (
          SELECT 1 FROM library mine
           WHERE mine.show_id = s.id AND mine.user_id = ?
        )
        ${providerFilter}
      ORDER BY s.vote_average DESC
      LIMIT 30`,
    friendId,
    userId,
    ...providerParams,
  );

  // --- 3. Seine Lieblinge, die ich nicht kenne ----------------------------
  const theirFavourites = all(
    `SELECT s.id AS show_id, s.tmdb_id, s.media_type, s.title, s.poster_path,
            s.first_air_date, s.vote_average, theirs.rating AS friend_rating
       FROM library theirs
       JOIN shows s ON s.id = theirs.show_id
      WHERE theirs.user_id = ?
        AND theirs.status = 'completed'
        -- Nur wirklich Gemochtes: ab 8 von 10 oder als Favorit markiert.
        AND (theirs.rating >= 8 OR theirs.favorite = 1)
        AND NOT EXISTS (
          SELECT 1 FROM library mine
           WHERE mine.show_id = s.id AND mine.user_id = ?
        )
        ${providerFilter}
      ORDER BY theirs.rating DESC, s.vote_average DESC
      LIMIT 30`,
    friendId,
    userId,
    ...providerParams,
  );

  return {
    // Wie viele Abos habt ihr zusammen? Erklärt, worauf gefiltert wurde.
    providerCount: combined.size,
    bothWant: bothWant.map(toSuggestion),
    fromTheirList: fromTheirList.map(toSuggestion),
    theirFavourites: theirFavourites.map(toSuggestion),
  };
}

// --------------------------------------------------------------------------
// Empfehlungen
// --------------------------------------------------------------------------

/**
 * Empfiehlt einem Freund einen Titel.
 *
 * @param {number} fromUserId
 * @param {number} toUserId
 * @param {number} showId
 * @param {string} [message] Ein paar Worte dazu – das macht die Empfehlung aus
 * @returns {boolean}
 * @throws {Error} wenn die beiden nicht befreundet sind
 */
export function recommend(fromUserId, toUserId, showId, message) {
  if (!areFriends(fromUserId, toUserId)) {
    throw new Error('Empfehlen kannst du nur an Freunde.');
  }

  run(
    `INSERT INTO recommendations (from_user_id, to_user_id, show_id, message)
     VALUES (?,?,?,?)
     -- Dieselbe Empfehlung noch einmal frischt die vorhandene auf und stellt
     -- sie wieder auf ungelesen – wer nachhakt, will ja gehört werden.
     ON CONFLICT(from_user_id, to_user_id, show_id) DO UPDATE SET
        message = excluded.message,
        seen = 0,
        created_at = datetime('now')`,
    fromUserId,
    toUserId,
    showId,
    String(message || '').trim().slice(0, 500) || null,
  );

  return true;
}

/**
 * Die Empfehlungen, die ich bekommen habe.
 *
 * @param {number} userId
 * @param {string} region
 * @returns {object[]}
 */
export function getRecommendations(userId, region) {
  const subscribed = getSubscribedProviderIds(userId);

  const rows = all(
    `SELECT r.id, r.message, r.seen, r.created_at,
            u.id AS from_id, u.username, u.display_name,
            s.id AS show_id, s.tmdb_id, s.media_type, s.title, s.poster_path,
            s.first_air_date, s.vote_average,
            mine.status AS my_status
       FROM recommendations r
       JOIN users u ON u.id = r.from_user_id
       JOIN shows s ON s.id = r.show_id
       LEFT JOIN library mine ON mine.show_id = s.id AND mine.user_id = r.to_user_id
      WHERE r.to_user_id = ?
      ORDER BY r.seen, r.created_at DESC`,
    userId,
  );

  return rows.map((row) => ({
    id: row.id,
    message: row.message,
    seen: Boolean(row.seen),
    createdAt: row.created_at,
    from: {
      id: row.from_id,
      username: row.username,
      displayName: row.display_name,
    },
    showId: row.show_id,
    tmdbId: row.tmdb_id,
    mediaType: row.media_type,
    title: row.title,
    posterPath: row.poster_path,
    year: row.first_air_date?.slice(0, 4) || null,
    voteAverage: row.vote_average,
    inMyLibrary: row.my_status !== null,
    availability: buildAvailabilityView(row.show_id, region, subscribed),
  }));
}

/**
 * Zählt ungelesene Empfehlungen – für den Zähler in der Navigation.
 * @param {number} userId
 * @returns {number}
 */
export function countUnread(userId) {
  return get(
    'SELECT COUNT(*) AS n FROM recommendations WHERE to_user_id = ? AND seen = 0',
    userId,
  ).n;
}

/**
 * Markiert Empfehlungen als gelesen.
 * @param {number} userId
 * @param {number} [recommendationId] Ohne Angabe: alle
 */
export function markRead(userId, recommendationId) {
  if (recommendationId) {
    run(
      'UPDATE recommendations SET seen = 1 WHERE id = ? AND to_user_id = ?',
      recommendationId,
      userId,
    );
  } else {
    run('UPDATE recommendations SET seen = 1 WHERE to_user_id = ?', userId);
  }
}

/**
 * Entfernt eine Empfehlung – etwa, wenn man sie abgearbeitet hat.
 * @param {number} userId Der Empfänger
 * @param {number} recommendationId
 * @returns {boolean}
 */
export function dismissRecommendation(userId, recommendationId) {
  const result = run(
    'DELETE FROM recommendations WHERE id = ? AND to_user_id = ?',
    recommendationId,
    userId,
  );

  return Number(result.changes) > 0;
}
