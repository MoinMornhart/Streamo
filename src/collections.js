/**
 * ---------------------------------------------------------------------------
 * src/collections.js – Filmreihen
 * ---------------------------------------------------------------------------
 * Rolle im Gesamtsystem:
 *   Bündelt zusammengehörige Filme. Zwei Arten, die sich dieselben Tabellen
 *   teilen und sich nur darin unterscheiden, welche Spalte gefüllt ist:
 *
 *     Offizielle Reihen (collections.tmdb_id gesetzt)
 *       Kommen von TMDB: "Kingsman", "Der Herr der Ringe", "John Wick".
 *       Sie gehören niemandem, jeder sieht dieselbe. Erkannt werden sie
 *       automatisch: Bei den Details eines Films steht die zugehörige Reihe
 *       im Feld `belongs_to_collection`.
 *
 *     Eigene Reihen (collections.user_id gesetzt)
 *       Selbst zusammengestellt und selbst sortiert – etwa "Was man für
 *       Spider-Man: Brand New Day gesehen haben sollte". Jeder Eintrag kann
 *       eine Notiz tragen ("nur die Nachspannszene nötig").
 *
 * Verknüpfungen zu anderen Dateien:
 *   - src/db.js            -> Tabellen `collections` und `collection_items`
 *   - src/tmdb.js          -> getCollection(), searchCollections()
 *   - src/store.js         -> upsertShow() für die Filme einer Reihe
 *   - src/routes/collections.js -> die HTTP-Endpunkte
 *   - public/js/views/collections.js -> die Anzeige
 * ---------------------------------------------------------------------------
 */

import crypto from 'node:crypto';
import { all, get, run, transaction } from './db.js';
import * as tmdb from './tmdb.js';
import { upsertShow, findShow, buildAvailabilityView, getSubscribedProviderIds } from './store.js';

/**
 * Findet eine offizielle Reihe im lokalen Bestand.
 * @param {number} tmdbId
 * @returns {object|undefined} Zeile aus `collections`
 */
export function findOfficialCollection(tmdbId) {
  return get('SELECT * FROM collections WHERE tmdb_id = ?', tmdbId);
}

/**
 * Holt eine offizielle Reihe von TMDB und legt sie mitsamt ihren Filmen ab.
 *
 * Idempotent: Ein zweiter Aufruf frischt nur auf. Die Reihenfolge richtet sich
 * nach dem Erscheinungsdatum – das ist bei TMDB-Reihen die sinnvolle Vorgabe,
 * denn eine erzählte Chronologie kennt TMDB nicht.
 *
 * @param {number} tmdbId Kennung der Reihe bei TMDB
 * @param {object} opts
 * @param {string} opts.language
 * @param {string} opts.region Für die Verfügbarkeit der einzelnen Filme
 * @param {object} [opts.data] Bereits vorliegende TMDB-Antwort. Wer sie schon
 *   hat, erspart sich den Aufruf – und Tests kommen damit ohne Netzwerk und
 *   ohne API-Key aus.
 * @returns {Promise<object>} die gespeicherte Zeile aus `collections`
 */
export async function ensureOfficialCollection(tmdbId, opts) {
  const data = opts.data ?? (await tmdb.getCollection(tmdbId, { language: opts.language }));

  // --- Die Reihe selbst ----------------------------------------------------
  run(
    `INSERT INTO collections (tmdb_id, name, description, poster_path, backdrop_path, order_type)
     VALUES (?,?,?,?,?, 'release')
     -- Die WHERE-Bedingung muss hier wiederholt werden: Der Index auf tmdb_id
     -- ist ein TEILWEISER (nur wo tmdb_id NOT NULL), und SQLite erkennt ihn
     -- ohne diesen Zusatz nicht als den gemeinten – die Anweisung scheitert
     -- dann mit "ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE
     -- constraint".
     ON CONFLICT(tmdb_id) WHERE tmdb_id IS NOT NULL DO UPDATE SET
        name          = excluded.name,
        description   = excluded.description,
        poster_path   = excluded.poster_path,
        backdrop_path = excluded.backdrop_path,
        updated_at    = datetime('now')`,
    tmdbId,
    data.name || 'Unbenannte Reihe',
    data.overview || null,
    data.poster_path || null,
    data.backdrop_path || null,
  );

  const collection = findOfficialCollection(tmdbId);

  // --- Die Filme darin -----------------------------------------------------
  // Nach Erscheinungsdatum sortieren. Filme ohne Datum (angekündigte Teile)
  // wandern ans Ende, statt die Reihenfolge durcheinanderzubringen.
  const parts = [...(data.parts || [])].sort((a, b) => {
    const dateA = a.release_date || '9999-12-31';
    const dateB = b.release_date || '9999-12-31';
    return dateA.localeCompare(dateB);
  });

  transaction(() => {
    // Alte Zuordnung verwerfen: Nimmt TMDB einen Film aus der Reihe heraus,
    // soll er auch hier verschwinden.
    run('DELETE FROM collection_items WHERE collection_id = ?', collection.id);

    parts.forEach((part, index) => {
      // Die Filme landen im gemeinsamen Metadaten-Cache. upsertShow erwartet
      // die Form der TMDB-Detailantwort; die Listeneinträge einer Reihe haben
      // weniger Felder, aber alle nötigen.
      const show = upsertShow(part, 'movie');

      run(
        `INSERT INTO collection_items (collection_id, show_id, position)
         VALUES (?,?,?)
         ON CONFLICT(collection_id, show_id) DO UPDATE SET position = excluded.position`,
        collection.id,
        show.id,
        index,
      );
    });
  });

  return findOfficialCollection(tmdbId);
}

/**
 * Legt eine eigene Reihe an.
 *
 * @param {number} userId
 * @param {object} params
 * @param {string} params.name
 * @param {string} [params.description] Wofür ist die Reihe gedacht?
 * @returns {object} die neue Zeile aus `collections`
 * @throws {Error} bei leerem Namen
 */
export function createCustomCollection(userId, { name, description }) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('Die Reihe braucht einen Namen.');

  const result = run(
    `INSERT INTO collections (user_id, name, description, order_type)
     VALUES (?,?,?, 'custom')`,
    userId,
    trimmed.slice(0, 120),
    String(description || '').trim().slice(0, 2000) || null,
  );

  return get('SELECT * FROM collections WHERE id = ?', Number(result.lastInsertRowid));
}

/**
 * Lädt eine Reihe samt ihrer Titel.
 *
 * Jeder Titel bekommt seine Streaming-Verfügbarkeit mit – so sieht man auf
 * einen Blick, welche Teile einer Reihe man gerade sehen kann und welche
 * nicht. Genau das ist bei einer Reihe die interessante Frage.
 *
 * @param {number} collectionId Interne Kennung
 * @param {object} ctx
 * @param {number} ctx.userId
 * @param {string} ctx.region
 * @returns {object|null} Reihe mit .items, oder null wenn es sie nicht gibt
 */
export function getCollection(collectionId, ctx) {
  const collection = get('SELECT * FROM collections WHERE id = ?', collectionId);
  if (!collection) return null;

  // Eigene Reihen sind privat. Offizielle (user_id IS NULL) sieht jeder.
  if (collection.user_id !== null && collection.user_id !== ctx.userId) return null;

  const subscribed = getSubscribedProviderIds(ctx.userId);

  const rows = all(
    `SELECT ci.position, ci.note,
            s.id AS show_id, s.tmdb_id, s.media_type, s.title, s.overview,
            s.poster_path, s.first_air_date, s.runtime, s.vote_average,
            -- Steht der Titel auf meiner Liste, und habe ich ihn gesehen?
            l.status AS library_status
       FROM collection_items ci
       JOIN shows s ON s.id = ci.show_id
       LEFT JOIN library l ON l.show_id = s.id AND l.user_id = ?
      WHERE ci.collection_id = ?
      ORDER BY ci.position, s.first_air_date`,
    ctx.userId,
    collectionId,
  );

  const items = rows.map((row) => ({
    position: row.position,
    note: row.note,
    showId: row.show_id,
    tmdbId: row.tmdb_id,
    mediaType: row.media_type,
    title: row.title,
    overview: row.overview,
    posterPath: row.poster_path,
    year: row.first_air_date?.slice(0, 4) || null,
    runtime: row.runtime,
    voteAverage: row.vote_average,
    inLibrary: row.library_status !== null,
    libraryStatus: row.library_status,
    watched: row.library_status === 'completed',
    availability: buildAvailabilityView(row.show_id, ctx.region, subscribed),
  }));

  // Wie weit ist man durch? Bei einer Reihe die naheliegendste Kennzahl.
  const watchedCount = items.filter((item) => item.watched).length;

  return {
    id: collection.id,
    tmdbId: collection.tmdb_id,
    isCustom: collection.user_id !== null,
    name: collection.name,
    description: collection.description,
    posterPath: collection.poster_path,
    backdropPath: collection.backdrop_path,
    orderType: collection.order_type,
    createdAt: collection.created_at,
    items,
    progress: {
      watched: watchedCount,
      total: items.length,
      percent: items.length > 0 ? Math.round((watchedCount / items.length) * 100) : 0,
    },
    // Gesamtlaufzeit in Minuten – "13 Stunden am Stück" ist eine Ansage.
    totalRuntime: items.reduce((sum, item) => sum + (item.runtime || 0), 0),
  };
}

/**
 * Listet alle Reihen, die für einen Benutzer sichtbar sind.
 *
 * Das sind seine eigenen und die offiziellen, zu denen er mindestens einen
 * Film in der Bibliothek hat. Ohne diese Einschränkung stünden dort alle je
 * abgerufenen Reihen – auch solche, die ihn nie interessiert haben.
 *
 * @param {number} userId
 * @returns {object[]}
 */
export function listCollections(userId) {
  const rows = all(
    `SELECT c.*,
            (SELECT COUNT(*) FROM collection_items ci
              WHERE ci.collection_id = c.id) AS item_count,
            -- Wie viele Teile hat der Benutzer schon gesehen?
            (SELECT COUNT(*) FROM collection_items ci
               JOIN library l ON l.show_id = ci.show_id AND l.user_id = ?
              WHERE ci.collection_id = c.id AND l.status = 'completed') AS watched_count,
            -- Und wie viele stehen überhaupt auf seiner Liste? Entscheidet
            -- unten darüber, ob eine offizielle Reihe angezeigt wird.
            (SELECT COUNT(*) FROM collection_items ci
               JOIN library l ON l.show_id = ci.show_id AND l.user_id = ?
              WHERE ci.collection_id = c.id) AS owned_count
       FROM collections c
      WHERE c.user_id = ? OR c.user_id IS NULL
      ORDER BY c.user_id IS NULL, c.updated_at DESC`,
    // Drei Platzhalter: zweimal in den Unterabfragen (gesehen / besessen),
    // einmal in der WHERE-Bedingung. Die Zählung von item_count braucht
    // keinen, sie ist unabhängig vom Benutzer.
    userId,
    userId,
    userId,
  );

  return rows
    .filter((row) => row.user_id !== null || row.owned_count > 0)
    .map((row) => ({
      id: row.id,
      tmdbId: row.tmdb_id,
      isCustom: row.user_id !== null,
      name: row.name,
      description: row.description,
      posterPath: row.poster_path,
      orderType: row.order_type,
      itemCount: row.item_count,
      ownedCount: row.owned_count,
      progress: {
        watched: row.watched_count,
        total: row.item_count,
        percent: row.item_count > 0 ? Math.round((row.watched_count / row.item_count) * 100) : 0,
      },
    }));
}

/**
 * Nimmt einen Titel in eine eigene Reihe auf.
 *
 * Neue Einträge landen am Ende. Umsortiert wird getrennt über reorderItems().
 *
 * @param {number} collectionId
 * @param {number} showId  Kennung aus `shows`, nicht die von TMDB
 * @param {string} [note]  Hinweis zu diesem Eintrag
 * @returns {boolean} false, wenn der Titel schon drin war
 */
export function addItem(collectionId, showId, note) {
  const nextPosition =
    (get(
      'SELECT COALESCE(MAX(position), -1) AS max FROM collection_items WHERE collection_id = ?',
      collectionId,
    ).max ?? -1) + 1;

  const result = run(
    `INSERT INTO collection_items (collection_id, show_id, position, note)
     VALUES (?,?,?,?)
     -- Ein zweiter Versuch aktualisiert nur die Notiz, statt zu scheitern.
     ON CONFLICT(collection_id, show_id) DO UPDATE SET note = excluded.note`,
    collectionId,
    showId,
    nextPosition,
    String(note || '').trim().slice(0, 500) || null,
  );

  run("UPDATE collections SET updated_at = datetime('now') WHERE id = ?", collectionId);

  return Number(result.changes) > 0;
}

/**
 * Entfernt einen Titel aus einer Reihe.
 * @param {number} collectionId
 * @param {number} showId
 * @returns {boolean}
 */
export function removeItem(collectionId, showId) {
  const result = run(
    'DELETE FROM collection_items WHERE collection_id = ? AND show_id = ?',
    collectionId,
    showId,
  );

  run("UPDATE collections SET updated_at = datetime('now') WHERE id = ?", collectionId);

  return Number(result.changes) > 0;
}

/**
 * Setzt die Reihenfolge neu.
 *
 * Erwartet die vollständige Liste der Kennungen in der gewünschten Ordnung.
 * Die Positionen werden dabei durchnummeriert, sodass keine Lücken bleiben –
 * das erspart beim nächsten Einfügen jede Sonderbehandlung.
 *
 * @param {number} collectionId
 * @param {number[]} showIds
 * @returns {number} Anzahl neu einsortierter Einträge
 */
export function reorderItems(collectionId, showIds) {
  return transaction(() => {
    let position = 0;

    for (const showId of showIds) {
      const result = run(
        'UPDATE collection_items SET position = ? WHERE collection_id = ? AND show_id = ?',
        position,
        collectionId,
        Number(showId),
      );

      // Nur mitzählen, was es wirklich gibt – eine unbekannte Kennung im
      // Aufruf soll die übrigen Positionen nicht verschieben.
      if (Number(result.changes) > 0) position++;
    }

    run(
      "UPDATE collections SET order_type = 'custom', updated_at = datetime('now') WHERE id = ?",
      collectionId,
    );

    return position;
  });
}

/**
 * Prüft, ob eine Reihe dem Benutzer gehört und geändert werden darf.
 *
 * Offizielle Reihen sind für alle sichtbar, aber unveränderlich – sie kommen
 * von TMDB und würden beim nächsten Abgleich ohnehin überschrieben.
 *
 * @param {number} collectionId
 * @param {number} userId
 * @returns {object|null} die Reihe, oder null wenn nicht erlaubt
 */
export function getEditableCollection(collectionId, userId) {
  const collection = get(
    'SELECT * FROM collections WHERE id = ? AND user_id = ?',
    collectionId,
    userId,
  );

  return collection ?? null;
}

/**
 * Prüft, ob eine Reihe geteilt werden darf.
 *
 * Bewusst großzügiger als getEditableCollection. Ursprünglich ließen sich nur
 * eigene Reihen teilen, mit der Begründung, eine offizielle TMDB-Reihe kenne
 * der Empfänger ohnehin. Das war falsch gedacht: Wer einen Link verschickt,
 * teilt keine Neuigkeit, sondern einen Vorschlag – "schau dir die Reihe an,
 * am besten in dieser Reihenfolge". Ob TMDB die Liste kennt, spielt dafür
 * keine Rolle. In der Oberfläche fehlte deshalb bei genau den Reihen ein
 * Teilen-Knopf, die man am ehesten weiterschickt.
 *
 * Erlaubt sind daher:
 *   - die eigenen Reihen (user_id = ich)
 *   - die offiziellen Reihen von TMDB (user_id IS NULL)
 *
 * Nicht erlaubt sind fremde eigene Reihen anderer Leute.
 *
 * @param {number} collectionId
 * @param {number} userId
 * @returns {object|null} die Reihe, oder null wenn nicht erlaubt
 */
export function getShareableCollection(collectionId, userId) {
  const collection = get(
    'SELECT * FROM collections WHERE id = ? AND (user_id = ? OR user_id IS NULL)',
    collectionId,
    userId,
  );

  return collection ?? null;
}

// --------------------------------------------------------------------------
// Teilen
// --------------------------------------------------------------------------

/**
 * Gibt eine Reihe frei und liefert den Freigabe-Token.
 *
 * Wer den Link hat, sieht die Liste – ohne Konto, ohne Anmeldung. Deshalb ist
 * der Token 24 zufällige Bytes: nicht erratbar, auch nicht durch systematisches
 * Probieren.
 *
 * Ein bereits vergebener Token bleibt bestehen, damit ein einmal verschickter
 * Link nicht plötzlich ins Leere führt, nur weil jemand erneut auf "Teilen"
 * gedrückt hat.
 *
 * @param {number} collectionId
 * @param {boolean} [renew] true erzeugt einen neuen Token und entwertet damit
 *   alle bisher verschickten Links
 * @returns {string} der Token
 */
export function shareCollection(collectionId, renew = false) {
  const existing = get('SELECT share_token FROM collections WHERE id = ?', collectionId);

  if (existing?.share_token && !renew) return existing.share_token;

  // base64url, damit der Token ohne Umkodierung in eine Adresse passt.
  const token = crypto.randomBytes(24).toString('base64url');

  run(
    "UPDATE collections SET share_token = ?, shared_at = datetime('now') WHERE id = ?",
    token,
    collectionId,
  );

  return token;
}

/**
 * Widerruft die Freigabe. Verschickte Links führen danach ins Leere.
 * @param {number} collectionId
 */
export function unshareCollection(collectionId) {
  run(
    'UPDATE collections SET share_token = NULL, shared_at = NULL WHERE id = ?',
    collectionId,
  );
}

/**
 * Lädt eine geteilte Reihe über ihren Token – ohne Anmeldung.
 *
 * Bewusst sparsam: Es kommen nur die Titel, ihre Reihenfolge und die Notizen
 * zurück. KEINE Angaben darüber, was der Ersteller gesehen hat, welche Abos er
 * besitzt oder wie er heißt. Wer einen Link weitergibt, teilt eine Liste –
 * nicht seinen Sehverlauf.
 *
 * @param {string} token
 * @returns {object|null}
 */
export function getSharedCollection(token) {
  if (!token) return null;

  const collection = get('SELECT * FROM collections WHERE share_token = ?', String(token));
  if (!collection) return null;

  const rows = all(
    `SELECT ci.position, ci.note,
            s.tmdb_id, s.media_type, s.title, s.overview,
            s.poster_path, s.first_air_date, s.runtime, s.vote_average
       FROM collection_items ci
       JOIN shows s ON s.id = ci.show_id
      WHERE ci.collection_id = ?
      ORDER BY ci.position, s.first_air_date`,
    collection.id,
  );

  return {
    name: collection.name,
    description: collection.description,
    posterPath: collection.poster_path,
    backdropPath: collection.backdrop_path,
    sharedAt: collection.shared_at,
    items: rows.map((row) => ({
      position: row.position,
      note: row.note,
      tmdbId: row.tmdb_id,
      mediaType: row.media_type,
      title: row.title,
      overview: row.overview,
      posterPath: row.poster_path,
      year: row.first_air_date?.slice(0, 4) || null,
      runtime: row.runtime,
      voteAverage: row.vote_average,
    })),
    totalRuntime: rows.reduce((sum, row) => sum + (row.runtime || 0), 0),
  };
}

/**
 * Findet die offizielle Reihe zu einem Film, sofern es eine gibt.
 *
 * Wird auf der Detailseite gebraucht: "Teil 2 von 3 der Kingsman-Reihe".
 *
 * @param {number} showId
 * @param {number} userId
 * @returns {object|null}
 */
export function findCollectionForShow(showId, userId) {
  const row = get(
    `SELECT c.id, c.name, c.tmdb_id, ci.position,
            (SELECT COUNT(*) FROM collection_items x WHERE x.collection_id = c.id) AS total
       FROM collection_items ci
       JOIN collections c ON c.id = ci.collection_id
      WHERE ci.show_id = ?
        -- Offizielle Reihen zuerst; eigene nur, wenn sie dem Benutzer gehören.
        AND (c.user_id IS NULL OR c.user_id = ?)
      ORDER BY c.user_id IS NOT NULL
      LIMIT 1`,
    showId,
    userId,
  );

  if (!row) return null;

  return {
    id: row.id,
    tmdbId: row.tmdb_id,
    name: row.name,
    // Menschlich gezählt, also ab 1.
    part: row.position + 1,
    total: row.total,
  };
}
