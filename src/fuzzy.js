/**
 * ---------------------------------------------------------------------------
 * src/fuzzy.js – Suche, die Tippfehler verzeiht
 * ---------------------------------------------------------------------------
 * Rolle im Gesamtsystem:
 *   Wer "Kingsmann" tippt, meint "Kingsman". Wer "Braking Bad" schreibt, sucht
 *   "Breaking Bad". Ohne Nachsicht bekommt man in beiden Fällen eine leere
 *   Trefferliste – und das ist die ärgerlichste Antwort überhaupt, weil man
 *   den Fehler selbst nicht sieht.
 *
 *   Dieses Modul liefert die Bausteine dafür:
 *     - normalize()   räumt einen Suchbegriff auf (Umlaute, Sonderzeichen)
 *     - distance()    misst, wie weit zwei Wörter auseinanderliegen
 *     - similarity()  daraus ein Wert zwischen 0 und 1
 *     - variants()    plausible Schreibweisen für einen zweiten Versuch
 *     - rank()        sortiert Treffer nach Ähnlichkeit zum Suchbegriff
 *
 * Zwei Einsatzorte:
 *   - src/routes/search.js  -> bei erfolgloser TMDB-Suche einen zweiten
 *     Versuch mit bereinigtem Begriff starten
 *   - src/routes/library.js -> die Suche in der eigenen Bibliothek, die
 *     ganz ohne TMDB auskommt und deshalb beliebig nachsichtig sein darf
 * ---------------------------------------------------------------------------
 */

/**
 * Räumt einen Text für den Vergleich auf.
 *
 * Kleinschreibung, Umlaute ausgeschrieben, Akzente entfernt, alles außer
 * Buchstaben und Ziffern zu einfachen Leerzeichen. Damit gelten "Spider-Man",
 * "spider man" und "SPIDERMAN" als dasselbe.
 *
 * @param {string} text
 * @returns {string}
 */
export function normalize(text) {
  return String(text || '')
    .toLowerCase()
    // Deutsche Umlaute ausschreiben – "Hoehle" soll "Höhle" finden.
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    // Akzente abtrennen und wegwerfen: "Amélie" wird zu "amelie".
    // NFD zerlegt Buchstaben in Grundzeichen plus Akzent, der dann im
    // Unicode-Block "Combining Diacritical Marks" liegt.
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    // Alles Übrige zu Leerzeichen, Mehrfache zusammenfassen.
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Berechnet die Levenshtein-Distanz: Wie viele einzelne Änderungen
 * (einfügen, löschen, ersetzen) trennen zwei Zeichenketten?
 *
 * "kingsman" und "kingsmann" haben Distanz 1 – ein Zeichen zu viel.
 *
 * Umgesetzt mit nur zwei Zeilen der Matrix statt der vollständigen: Für den
 * Wert einer Zelle braucht man nur die Zeile darüber. Das spart bei langen
 * Titeln deutlich Speicher und ist genauso schnell.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} Anzahl nötiger Änderungen
 */
export function distance(a, b) {
  const s = String(a || '');
  const t = String(b || '');

  if (s === t) return 0;
  if (s.length === 0) return t.length;
  if (t.length === 0) return s.length;

  // Vorherige Zeile der Matrix: die Distanzen zum leeren Präfix.
  let previous = Array.from({ length: t.length + 1 }, (_, i) => i);
  let current = new Array(t.length + 1);

  for (let i = 1; i <= s.length; i++) {
    current[0] = i;

    for (let j = 1; j <= t.length; j++) {
      // Stimmen die Zeichen überein, kostet dieser Schritt nichts.
      const substitution = previous[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1);
      const insertion = current[j - 1] + 1;
      const deletion = previous[j] + 1;

      current[j] = Math.min(substitution, insertion, deletion);
    }

    // Zeilen tauschen statt neu anzulegen.
    [previous, current] = [current, previous];
  }

  return previous[t.length];
}

/**
 * Ähnlichkeit zweier Texte als Wert zwischen 0 und 1.
 *
 * 1 bedeutet gleich, 0 bedeutet völlig verschieden. Beide Texte werden vorher
 * normalisiert, damit Groß-/Kleinschreibung und Bindestriche keine Rolle
 * spielen.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function similarity(a, b) {
  const left = normalize(a);
  const right = normalize(b);

  if (left === right) return 1;
  if (!left || !right) return 0;

  const longest = Math.max(left.length, right.length);

  return 1 - distance(left, right) / longest;
}

/**
 * Prüft, ob ein Titel zu einem Suchbegriff passt – nachsichtig.
 *
 * Fünf Wege führen zum Treffer, vom Sicheren zum Unsichersten:
 *
 *   1. Der Titel enthält den Begriff wörtlich ("king" in "Kingsman").
 *   2. Jedes Wort des Begriffs kommt im Titel vor, egal in welcher
 *      Reihenfolge ("man spider" findet "Spider-Man").
 *   3. Ohne jede Leerstelle betrachtet steckt der Begriff im Titel –
 *      so findet "spiderman" auch "Spider-Man: No Way Home".
 *   4. Der ganze Begriff ähnelt dem Titel genug.
 *   5. Ein einzelnes Wort des Titels ähnelt einem Wort des Begriffs stark –
 *      damit findet "kingsmann" auch "Kingsman: The Secret Service".
 *
 * @param {string} title Der zu prüfende Titel
 * @param {string} query Was gesucht wurde
 * @param {number} [threshold] Ab welcher Ähnlichkeit gilt es als Treffer
 * @returns {boolean}
 */
export function matches(title, query, threshold = 0.72) {
  const normalizedTitle = normalize(title);
  const normalizedQuery = normalize(query);

  if (!normalizedQuery) return true;
  if (!normalizedTitle) return false;

  // 1. Wörtlich enthalten – der häufigste Fall.
  if (normalizedTitle.includes(normalizedQuery)) return true;

  const queryWords = normalizedQuery.split(' ').filter(Boolean);
  const titleWords = normalizedTitle.split(' ').filter(Boolean);

  // 2. Alle Suchwörter kommen vor, Reihenfolge egal.
  if (queryWords.every((word) => normalizedTitle.includes(word))) return true;

  // 3. Beide Seiten ohne Leerzeichen betrachten.
  //    Wo im Titel eine Wortgrenze steht, ist reine Auslegungssache: TMDB
  //    schreibt "Spider-Man", getippt wird "spiderman". Genauso umgekehrt bei
  //    "spider man" gegen den Titel "Spiderman". Presst man beide Seiten
  //    zusammen, verschwindet die Frage.
  const compactTitle = normalizedTitle.replace(/ /g, '');
  const compactQuery = normalizedQuery.replace(/ /g, '');

  if (compactTitle.includes(compactQuery)) return true;

  // 4. Der ganze Begriff ist nah genug am ganzen Titel.
  if (similarity(normalizedTitle, normalizedQuery) >= threshold) return true;

  // 5. Jedes Suchwort findet ein ähnliches Wort im Titel.
  //    Kurze Wörter (bis drei Zeichen) müssen exakt stimmen – bei "die" und
  //    "der" wäre alles andere zu großzügig.
  return queryWords.every((queryWord) =>
    titleWords.some((titleWord) => {
      if (queryWord.length <= 3) return titleWord === queryWord;
      return similarity(titleWord, queryWord) >= threshold;
    }),
  );
}

/**
 * Erzeugt plausible Schreibvarianten eines Suchbegriffs.
 *
 * Gedacht für einen zweiten Versuch bei TMDB, wenn der erste nichts gebracht
 * hat. Die Varianten sind nach Erfolgsaussicht sortiert; jede kostet einen
 * API-Aufruf, deshalb sind es bewusst wenige.
 *
 * @param {string} query
 * @returns {string[]} Varianten OHNE den ursprünglichen Begriff
 */
export function variants(query) {
  const original = String(query || '').trim();
  const result = new Set();

  if (!original) return [];

  const normalized = normalize(original);

  // Bereinigt: ohne Sonderzeichen. Findet "spider man" für "Spider-Man!".
  if (normalized && normalized !== original.toLowerCase()) {
    result.add(normalized);
  }

  // Doppelte Buchstaben auf einen reduzieren. Das ist der mit Abstand
  // häufigste Tippfehler im Deutschen: "Kingsmann" -> "kingsman",
  // "Braking Badd" -> "braking bad".
  const collapsed = normalized.replace(/(.)\1+/g, '$1');
  if (collapsed !== normalized) result.add(collapsed);

  // Nur das längste Wort. Bei "Kingsmann Golden Circel" ist ein einzelnes
  // langes Wort oft richtig geschrieben und reicht TMDB als Anhaltspunkt.
  const words = normalized.split(' ').filter((word) => word.length > 3);
  if (words.length > 1) {
    const longest = words.reduce((a, b) => (b.length > a.length ? b : a));
    result.add(longest);
  }

  // Ohne den letzten Buchstaben – fängt ein verrutschtes Zeichen am Ende ab.
  if (normalized.length > 5) {
    result.add(normalized.slice(0, -1));
  }

  // Den ursprünglichen Begriff nicht noch einmal suchen.
  result.delete(original.toLowerCase());
  result.delete(original);

  return [...result];
}

/**
 * Sortiert Treffer nach Ähnlichkeit zum Suchbegriff.
 *
 * Nötig, weil die Varianten-Suche Ergebnisse liefert, die zwar irgendwie
 * passen, aber unterschiedlich gut. Was dem Getippten am nächsten kommt,
 * gehört nach oben.
 *
 * @template T
 * @param {T[]} items
 * @param {string} query
 * @param {(item: T) => string} getTitle Wie kommt man an den Titel?
 * @returns {T[]} neue, sortierte Liste
 */
export function rank(items, query, getTitle = (item) => item.title) {
  // Ein Treffer in einem einzelnen Wort zählt etwas weniger als ein Treffer
  // im ganzen Titel. Ohne diesen Abschlag stünde "The Kingsman Documentary"
  // gleichauf mit "Kingsman" – beide enthalten das gesuchte Wort exakt, aber
  // gemeint war natürlich der Film, der genau so heißt.
  const WORD_PENALTY = 0.9;

  return [...items]
    .map((item) => {
      const title = getTitle(item);

      // Ähnlichkeit zum ganzen Titel …
      const wholeScore = similarity(title, query);

      // … und zum besten einzelnen Wort darin. Der zweite Wert rettet Titel
      // mit langem Untertitel: "Kingsman: The Secret Service" ähnelt als
      // Ganzes kaum noch "kingsman", das erste Wort aber sehr wohl.
      const wordScore = Math.max(
        0,
        ...normalize(title)
          .split(' ')
          .map((word) => similarity(word, query)),
      );

      return {
        item,
        score: Math.max(wholeScore, wordScore * WORD_PENALTY),
        // Bei Gleichstand gewinnt der kürzere Titel: Er trägt weniger
        // Beiwerk und ist damit näher an dem, was getippt wurde.
        length: normalize(title).length,
      };
    })
    .sort((a, b) => b.score - a.score || a.length - b.length)
    .map(({ item }) => item);
}
