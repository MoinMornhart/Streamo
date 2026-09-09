/**
 * ---------------------------------------------------------------------------
 * src/quicksearch.js – Eine Suche für alles
 * ---------------------------------------------------------------------------
 * Rolle im Gesamtsystem:
 *   Die Suchleiste oben fragte bisher ausschließlich TMDB. Wollte man eine
 *   eigene Filmreihe wiederfinden oder nachsehen, ob jemand schon als Freund
 *   eingetragen ist, musste man erst auf die passende Seite und dort noch
 *   einmal suchen. Zwei Suchfelder für eine Frage.
 *
 *   Dieses Modul beantwortet die Frage an einer Stelle: Was gibt es hier zu
 *   "kingsman" oder zu "lisa"? Filmreihen, Freunde, Leute – alles auf einmal.
 *
 * Was bewusst NICHT hier steht:
 *   Die Suche bei TMDB. Die dauert je nach Verbindung ein paar hundert
 *   Millisekunden und braucht einen API-Schlüssel; alles hier kommt dagegen
 *   aus der eigenen Datenbank und ist sofort da. Die Trennung erlaubt es, das
 *   Menü schon beim Tippen zu füllen, während die Filmtreffer nachkommen.
 *
 * Nachsichtig gegenüber Tippfehlern: Es wird dieselbe Logik verwendet wie in
 * der Bibliothek (src/fuzzy.js). "Kingsmann" findet die Reihe "Kingsman".
 *
 * Verknüpfungen:
 *   - src/fuzzy.js          -> matches() und rank()
 *   - src/collections.js    -> listCollections()
 *   - src/friends.js        -> listFriends()
 *   - src/db.js             -> Tabelle users für die Personensuche
 *   - src/routes/search.js  -> GET /api/search/quick
 *   - public/js/quicksearch.js -> das Menü unter der Suchleiste
 * ---------------------------------------------------------------------------
 */

import { all } from './db.js';
import { matches, rank } from './fuzzy.js';
import { listCollections } from './collections.js';
import { listFriends } from './friends.js';

/**
 * Wie viele Treffer je Gruppe höchstens zurückkommen.
 *
 * Das Menü unter der Suchleiste soll eine Auswahl zeigen, keine Liste. Wer
 * mehr sehen will, geht auf die Suchseite – dort steht alles.
 */
const LIMIT_PER_GROUP = 5;

/**
 * Sucht in allem, was Streamo selbst weiß.
 *
 * @param {number} userId Wer sucht?
 * @param {string} query Der Suchbegriff
 * @param {object} [opts]
 * @param {number} [opts.limit] Treffer je Gruppe
 * @returns {{
 *   collections: object[],
 *   friends: object[],
 *   people: object[]
 * }}
 */
export function quickSearch(userId, query, opts = {}) {
  const term = String(query || '').trim();
  const limit = opts.limit || LIMIT_PER_GROUP;

  // Ein leerer Begriff würde überall passen – dann lieber gar nichts zeigen,
  // statt eine willkürliche Auswahl.
  if (!term) return { collections: [], friends: [], people: [] };

  // -------------------------------------------------------------------------
  // Filmreihen
  // -------------------------------------------------------------------------
  // listCollections liefert genau die Reihen, die für diese Person sichtbar
  // sind: ihre eigenen und die offiziellen, zu denen sie mindestens einen
  // Film besitzt. Damit ist die Sichtbarkeitsfrage schon geklärt.
  const collections = rank(
    listCollections(userId).filter((collection) => matches(collection.name, term)),
    term,
    (collection) => collection.name,
  )
    .slice(0, limit)
    .map((collection) => ({
      id: collection.id,
      name: collection.name,
      isCustom: collection.isCustom,
      posterPath: collection.posterPath,
      itemCount: collection.itemCount,
      ownedCount: collection.ownedCount,
    }));

  // -------------------------------------------------------------------------
  // Freunde
  // -------------------------------------------------------------------------
  // Nur bestätigte Freundschaften. Offene Anfragen gehören auf die
  // Freundesseite, nicht in eine Trefferliste.
  // Einmal holen, dreimal verwenden: bestätigte Freunde für die Trefferliste,
  // offene Anfragen weiter unten für die Ausschlussliste.
  const relations = listFriends(userId);
  const accepted = relations.friends;

  const friends = accepted
    .filter((friend) => matches(friend.display_name || friend.username, term) ||
      matches(friend.username, term))
    .slice(0, limit)
    .map((friend) => ({
      id: friend.id,
      username: friend.username,
      displayName: friend.display_name,
      libraryCount: friend.library_count,
    }));

  // -------------------------------------------------------------------------
  // Andere Leute auf dieser Instanz
  // -------------------------------------------------------------------------
  // Damit man jemanden findet, den man noch NICHT als Freund hat – sonst
  // müsste man den Benutzernamen auswendig kennen und auf der Freundesseite
  // exakt eintippen.
  //
  // Was hier zurückkommt, ist bewusst das Minimum: Name und Anzeigename. Wer
  // nicht befreundet ist, sieht nichts über Bibliothek, Abos oder Aktivität.
  const alreadyKnown = new Set([
    userId,
    ...accepted.map((friend) => friend.id),
    // Auch offene Anfragen ausblenden – die stehen schon auf der
    // Freundesseite, und ein zweites "Anfragen" hilft niemandem.
    ...relations.incoming.map((entry) => entry.id),
    ...relations.outgoing.map((entry) => entry.id),
  ]);

  const people = all('SELECT id, username, display_name FROM users')
    .filter((person) => !alreadyKnown.has(person.id))
    .filter((person) => matches(person.display_name || person.username, term) ||
      matches(person.username, term))
    .slice(0, limit)
    .map((person) => ({
      id: person.id,
      username: person.username,
      displayName: person.display_name,
    }));

  return { collections, friends, people };
}
