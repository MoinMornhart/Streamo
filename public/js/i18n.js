/**
 * ---------------------------------------------------------------------------
 * public/js/i18n.js – Die Oberfläche auf Deutsch oder Englisch
 * ---------------------------------------------------------------------------
 * Der Grundgedanke:
 *   Der Code bleibt deutsch. Jeder sichtbare Text steht weiterhin genau so im
 *   Quelltext, wie ihn eine deutschsprachige Person liest – und dient
 *   gleichzeitig als Schlüssel für die Übersetzung. Das Wörterbuch
 *   (public/js/i18n/en.js) ordnet jedem deutschen Text sein englisches
 *   Gegenstück zu.
 *
 *   Übersetzt wird an EINER Stelle: in el() (public/js/ui.js), durch das
 *   praktisch jeder Text der Oberfläche läuft – Beschriftungen, Knöpfe,
 *   Tooltips, Platzhalter, Einblendungen, Fehlermeldungen vom Server. Die
 *   Ansichten müssen dafür nicht umgeschrieben werden.
 *
 *   Fehlt ein Eintrag, bleibt der deutsche Text stehen. Schlimmstenfalls ist
 *   also etwas nicht übersetzt – kaputt geht nichts. Und bei Deutsch als
 *   Sprache ist das Ganze abgeschaltet: translate() gibt den Text unverändert
 *   zurück, ohne ein einziges Mal nachzuschlagen.
 *
 * Texte mit eingesetzten Werten:
 *   "Noch 5 Tage" steht so nicht im Wörterbuch, sondern als Muster
 *   "Noch {0} Tage" -> "{0} days left". Die Platzhalter werden zu
 *   Fanggruppen; was sie auffangen, wird selbst wieder übersetzt (aus
 *   "Mo, Do" wird so "Mon, Thu"). Spezifischere Muster – mit mehr festem
 *   Text – werden zuerst probiert.
 *
 * Zusammengesetzte Texte:
 *   "2008 · 5 Staffeln · Beendet" entsteht aus mehreren Teilen, die erst im
 *   Code zusammengeklebt werden. Findet sich weder ein Eintrag noch ein
 *   Muster, wird an Trennzeichen (" · ", ", " …) zerlegt und stückweise
 *   übersetzt – aber nur, wenn wirklich JEDES Stück mit Buchstaben eine
 *   Übersetzung hat. Sonst bliebe ein deutsch-englisches Mischmasch.
 *
 * Wo die Sprache herkommt (in dieser Reihenfolge):
 *   1. aus dem Konto (Spalte users.ui_language, Migration 14) – gesetzt
 *      unter Einstellungen -> Konto, reist zu anderen Geräten mit
 *   2. aus dem Browser-Speicher (localStorage "streamo.lang") – gilt schon
 *      auf dem Anmeldebildschirm, bevor jemand angemeldet ist
 *   3. aus der Spracheinstellung des Browsers (navigator.languages)
 *
 * Der Server benutzt dieselbe Datei:
 *   Der Kalender-Feed für Apple und Google Kalender wird auf dem Server
 *   gebaut (src/routes/public.js). Dort gibt es kein el() – deshalb ist
 *   translate() eine reine Funktion ohne DOM-Zugriff und nimmt die Sprache
 *   als Parameter.
 *
 * Verknüpfungen:
 *   - public/js/i18n/en.js    -> das englische Wörterbuch
 *   - public/js/ui.js         -> el() übersetzt Texte und Attribute
 *   - public/js/app.js        -> setzt die Sprache beim Start
 *   - public/js/views/settings.js, views/auth.js -> die Umschalter
 *   - src/routes/public.js    -> Kalender-Feed in der Sprache des Kontos
 *   - tests/i18n.test.mjs     -> prüft Nachschlagen, Muster und Rückfall
 * ---------------------------------------------------------------------------
 */

import EN from './i18n/en.js';

/** Die wählbaren Sprachen der Oberfläche: [Kürzel, Name in der Sprache selbst]. */
export const UI_LANGUAGES = [
  ['de', 'Deutsch'],
  ['en', 'English'],
];

/** Wörterbücher je Sprache. Deutsch braucht keines – es ist die Quelle. */
const DICTIONARIES = { en: EN };

/** Schlüssel im localStorage – derselbe, den das Skript im <head> liest. */
const STORAGE_KEY = 'streamo.lang';

/**
 * Trennzeichen, an denen zusammengesetzte Texte zerlegt werden dürfen.
 * Längere zuerst, damit " · " nicht als ", " missverstanden wird.
 */
const SEPARATORS = [' · ', ' – ', ' — ', ' | ', ', ', ': '];

/** Die aktuell eingestellte Sprache. */
let current = 'de';

/**
 * Aufbereitete Wörterbücher, je Sprache einmal gebaut:
 * { exact: Map, patterns: [...], cache: Map }
 */
const compiled = new Map();

/**
 * Macht aus einem Wörterbuch Nachschlagetabelle und Musterliste.
 *
 * @param {string} lang
 * @returns {{exact: Map<string,string>, patterns: object[], cache: Map<string,string>}}
 */
function compile(lang) {
  if (compiled.has(lang)) return compiled.get(lang);

  const dictionary = DICTIONARIES[lang] || {};
  const exact = new Map();
  const patterns = [];

  for (const [source, target] of Object.entries(dictionary)) {
    // Zwei Arten von Platzhaltern mit verschiedener Aufgabe:
    //   {0}, {1} …        -> Muster: greifen bei jedem Text, der passt
    //   {current}, {goal} -> Vorlage NUR für t(): wird ausschließlich exakt
    //                        nachgeschlagen, nie als Muster.
    // Der Unterschied ist wichtig. "{current} von {goal}" als Muster würde
    // jeden Text mit einem "von" darin zerlegen – aus der Fußzeile "Daten von
    // TMDB" würde "Daten of TMDB".
    const isPattern = /\{\d+\}/.test(source) && !/\{[^\d}]\w*\}/.test(source);
    if (!isPattern) {
      exact.set(source, target);
      continue;
    }

    // "Noch {0} Tage" -> /^Noch ([\s\S]+?) Tage$/ mit den Namen ["0"].
    const names = [];
    const regex = source
      .split(/(\{\w+\})/)
      .map((part) => {
        const placeholder = part.match(/^\{(\w+)\}$/);
        if (placeholder) {
          names.push(placeholder[1]);
          return '([\\s\\S]+?)';
        }
        return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('');

    patterns.push({
      regex: new RegExp(`^${regex}$`),
      names,
      target,
      // Wie viel fester Text im Muster steckt – mehr heißt spezifischer.
      weight: source.replace(/\{\w+\}/g, '').length,
    });
  }

  patterns.sort((a, b) => b.weight - a.weight);

  const result = { exact, patterns, cache: new Map() };
  compiled.set(lang, result);
  return result;
}

/**
 * Schlägt einen Text nach – exakt, dann über Muster, dann zerlegt.
 *
 * @param {string} text
 * @param {object} table Ergebnis von compile()
 * @param {number} depth Rekursionstiefe (Muster übersetzen ihre Fanggruppen)
 * @returns {string} die Übersetzung, oder der Text unverändert
 */
function lookup(text, table, depth) {
  const exact = table.exact.get(text);
  if (exact !== undefined) return exact;

  // Leerraum am Rand gehört nicht zum Schlüssel ("Noch kein Konto? ").
  const trimmed = text.trim();
  if (trimmed !== text && trimmed) {
    const inner = table.exact.get(trimmed);
    if (inner !== undefined) return text.replace(trimmed, inner);
  }

  if (depth > 3) return text;

  for (const pattern of table.patterns) {
    const match = text.match(pattern.regex);
    if (!match) continue;

    const captured = pattern.names.map((_, index) => match[index + 1]);
    const translated = captured.map((value) => lookup(value, table, depth + 1));

    // Ein kurzes Muster wie "{0} einzeln" passt auch auf einen langen,
    // zusammengesetzten Text und schluckt dann alles davor als Platzhalter:
    // "19 Einträge · 2 Filmreihen · 14 einzeln". Bliebe das Geschluckte
    // deutsch, entstünde Mischmasch. Deshalb: Enthält ein Platzhalter ein
    // Trennzeichen, muss er vollständig übersetzt worden sein – sonst gilt
    // das Muster nicht, und es geht mit dem Zerlegen weiter.
    const swallowed = captured.some(
      (value, index) =>
        SEPARATORS.some((separator) => value.includes(separator)) &&
        /[A-Za-zÄÖÜäöüß]/.test(value) &&
        translated[index] === value,
    );
    if (swallowed) continue;

    let out = pattern.target;
    pattern.names.forEach((name, index) => {
      out = out.split(`{${name}}`).join(translated[index]);
    });
    return out;
  }

  /**
   * Übersetzt Stücke einzeln und fügt sie wieder zusammen – aber nur, wenn
   * jedes Stück mit Buchstaben eine Übersetzung hat.
   * @param {string[]} parts
   * @param {string} glue
   * @returns {string|null}
   */
  const joinIfComplete = (parts, glue) => {
    const translated = parts.map((part) => lookup(part, table, depth + 1));
    const complete = parts.every(
      (part, index) => !/[A-Za-zÄÖÜäöüß]/.test(part) || translated[index] !== part,
    );
    return complete ? translated.join(glue) : null;
  };

  for (const separator of SEPARATORS) {
    if (!text.includes(separator)) continue;
    const joined = joinIfComplete(text.split(separator), separator);
    if (joined !== null) return joined;
  }

  // Mehrere Sätze hintereinander ("Der Abgleich ist aus. Du kannst …"):
  // Satz für Satz, das Satzzeichen bleibt am jeweiligen Satz.
  const sentences = text.split(/(?<=[.!?…])\s+(?=\S)/);
  if (sentences.length > 1) {
    const joined = joinIfComplete(sentences, ' ');
    if (joined !== null) return joined;
  }

  return text;
}

/**
 * Übersetzt einen Text in eine bestimmte Sprache.
 *
 * Reine Funktion ohne DOM – auch vom Server benutzbar.
 *
 * @param {*} text     Der deutsche Text (andere Werte kommen unverändert zurück)
 * @param {string} [lang] Zielsprache, sonst die eingestellte
 * @returns {*}
 */
export function translate(text, lang = current) {
  if (lang === 'de' || typeof text !== 'string' || !text.trim()) return text;
  if (!DICTIONARIES[lang]) return text;

  const table = compile(lang);
  const cached = table.cache.get(text);
  if (cached !== undefined) return cached;

  const result = lookup(text, table, 0);

  // Der Zwischenspeicher darf nicht unbegrenzt wachsen – Titel, Namen und
  // Beschreibungen laufen ja ebenfalls hier durch.
  if (table.cache.size > 5000) table.cache.clear();
  table.cache.set(text, result);

  return result;
}

/**
 * Kurzform für die Oberfläche: in die eingestellte Sprache.
 * @param {*} text
 * @returns {*}
 */
export const tr = (text) => translate(text, current);

/**
 * Übersetzt eine Vorlage und setzt Werte ein.
 *
 * Für Stellen, an denen ein Text erst im Code zusammengesetzt wird und das
 * Ergebnis zu allgemein für ein Muster wäre:
 *   t('{done} von {total}', { done: 3, total: 10 })
 *
 * @param {string} template deutsche Vorlage mit {name}-Platzhaltern
 * @param {object} [values]
 * @returns {string}
 */
export function t(template, values = {}) {
  let out = translate(template, current);
  for (const [name, value] of Object.entries(values)) {
    out = out.split(`{${name}}`).join(String(value));
  }
  return out;
}

/** @returns {string} die eingestellte Sprache ("de" oder "en") */
export function getLanguage() {
  return current;
}

/**
 * Stellt die Sprache um und merkt sie sich im Browser.
 * @param {string} lang
 * @returns {string} die tatsächlich gesetzte Sprache
 */
export function setLanguage(lang) {
  current = UI_LANGUAGES.some(([code]) => code === lang) ? lang : 'de';

  try {
    localStorage.setItem(STORAGE_KEY, current);
  } catch {
    /* Privates Fenster o. Ä. – dann gilt die Sprache eben nur bis zum Neuladen. */
  }

  if (typeof document !== 'undefined') document.documentElement.lang = current;
  return current;
}

/**
 * Welche Sprache gilt, solange niemand angemeldet ist?
 * Erst die gemerkte, dann die des Browsers, sonst Deutsch.
 * @returns {string}
 */
export function detectLanguage() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (UI_LANGUAGES.some(([code]) => code === stored)) return stored;
  } catch {
    /* kein Zugriff auf den Speicher */
  }

  const preferred = typeof navigator !== 'undefined' ? navigator.languages || [navigator.language] : [];
  for (const entry of preferred) {
    const code = String(entry || '').slice(0, 2).toLowerCase();
    if (UI_LANGUAGES.some(([known]) => known === code)) return code;
  }

  return 'de';
}

/**
 * Das Gebietsschema für Datumsangaben.
 * Englisch als en-GB: Tag vor Monat und Wochenbeginn am Montag, wie im
 * Kalender – US-Schreibweise wäre für eine europäische Instanz verwirrend.
 * @param {string} [lang]
 * @returns {string}
 */
export function locale(lang = current) {
  return lang === 'en' ? 'en-GB' : 'de-DE';
}

/**
 * Übersetzt fest in index.html stehende Texte (Navigation, Menüs, Fußzeile).
 *
 * Die entstehen nicht über el() und würden sonst deutsch bleiben. Einmal
 * beim Start aufgerufen genügt – ein Sprachwechsel lädt die Seite neu.
 *
 * @param {HTMLElement} root
 */
export function translateStatic(root) {
  if (current === 'de' || typeof document === 'undefined' || !root) return;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    // Im HTML stehen Zeilenumbrüche und Einrückung mitten im Text. Für das
    // Nachschlagen zählt nur der Inhalt; der Leerraum am Rand bleibt, damit
    // der Abstand zu benachbarten Links erhalten bleibt.
    const core = node.nodeValue.replace(/\s+/g, ' ').trim();
    if (!core) continue;
    const translated = tr(core);
    if (translated === core) continue;
    const lead = /^\s/.test(node.nodeValue) ? ' ' : '';
    const tail = /\s$/.test(node.nodeValue) ? ' ' : '';
    node.nodeValue = lead + translated + tail;
  }

  for (const element of root.querySelectorAll('[placeholder], [title], [aria-label]')) {
    for (const attribute of ['placeholder', 'title', 'aria-label']) {
      const value = element.getAttribute(attribute);
      if (value) element.setAttribute(attribute, tr(value));
    }
  }
}
