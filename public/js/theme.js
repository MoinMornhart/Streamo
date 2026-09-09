/**
 * ---------------------------------------------------------------------------
 * public/js/theme.js – Das Aussehen anpassen
 * ---------------------------------------------------------------------------
 * Rolle im Gesamtsystem:
 *   Streamo war violett, weil irgendjemand sich einmal für Violett entscheiden
 *   musste. Warum sollte das für alle gelten? Hier kann jede Person ihre
 *   eigene Farbe wählen – und zwischen einem dunkelblauen und einem schwarzen
 *   Grundton umschalten.
 *
 * Wie es funktioniert:
 *   Das ganze Stylesheet arbeitet mit CSS-Variablen (--accent, --bg,
 *   --surface …), die in public/css/styles.css unter :root stehen. Ein Thema
 *   ist deshalb nichts weiter als das Überschreiben einiger dieser Variablen
 *   am <html>-Element. Kein zweites Stylesheet, kein Neuladen.
 *
 *   Aus einer einzigen gewählten Farbe werden drei abgeleitet:
 *     --accent       die Farbe selbst (Knöpfe, aktive Reiter)
 *     --accent-soft  eine hellere Fassung für Text auf dunklem Grund
 *     --accent-glow  eine durchscheinende Fassung für Schatten und Ringe
 *   Sonst müsste man drei Farben aussuchen, die zueinander passen – das ist
 *   Arbeit, die niemand machen will.
 *
 * Wo das Thema liegt:
 *   In zwei Ablagen, mit Absicht.
 *     - localStorage: sofort verfügbar, noch bevor der Server antwortet. Ohne
 *       das würde die Seite kurz violett aufblitzen und dann umspringen.
 *     - Beim Benutzerkonto auf dem Server: damit dieselbe Farbe auch am
 *       Telefon gilt und ein neuer Browser sie mitbringt.
 *
 * Verknüpfungen:
 *   - public/css/styles.css       -> die Variablen, die hier gesetzt werden
 *   - public/js/app.js            -> wendet das Thema beim Start an
 *   - public/js/views/settings.js -> die Auswahl in der Oberfläche
 *   - src/routes/settings.js      -> speichert es am Konto (Spalte users.theme)
 * ---------------------------------------------------------------------------
 */

/** Wo das Thema im Browser liegt. */
const STORAGE_KEY = 'streamo.theme';

/**
 * Die Farben zur Auswahl.
 *
 * Bewusst eine überschaubare Liste kräftiger Töne, die auf dunklem Grund
 * lesbar bleiben. Wer etwas anderes will, nimmt den freien Farbwähler –
 * deshalb muss diese Liste nicht vollständig sein, sondern gut.
 */
export const ACCENT_PRESETS = [
  ['#6c5ce7', 'Violett'],
  ['#f39c12', 'Orange'],
  ['#e74c3c', 'Rot'],
  ['#00b894', 'Grün'],
  ['#0984e3', 'Blau'],
  ['#e84393', 'Pink'],
  ['#00cec9', 'Türkis'],
  ['#fdcb6e', 'Gold'],
];

/**
 * Die Grundtöne.
 *
 * "nacht" ist das gewohnte Dunkelblau, "schwarz" ein echtes Schwarz – auf
 * einem OLED-Bildschirm bleiben die Pixel dort tatsächlich aus, und mit einer
 * kräftigen Akzentfarbe wirkt es deutlich kontrastreicher.
 */
export const BASE_PRESETS = [
  ['nacht', 'Dunkelblau'],
  ['schwarz', 'Schwarz'],
];

/** Womit Streamo startet, solange nichts gewählt wurde. */
export const DEFAULT_THEME = { accent: '#6c5ce7', base: 'nacht' };

/**
 * Zerlegt eine Farbe wie "#f39c12" in ihre drei Anteile.
 *
 * @param {string} hex
 * @returns {{r: number, g: number, b: number}}
 */
function toRgb(hex) {
  const cleaned = String(hex || '').replace('#', '').trim();

  // Kurzschreibweise "#f80" auf "#ff8800" aufziehen.
  const full =
    cleaned.length === 3
      ? cleaned
          .split('')
          .map((character) => character + character)
          .join('')
      : cleaned;

  return {
    r: parseInt(full.slice(0, 2), 16) || 0,
    g: parseInt(full.slice(2, 4), 16) || 0,
    b: parseInt(full.slice(4, 6), 16) || 0,
  };
}

/**
 * Hellt eine Farbe auf, indem sie mit Weiß gemischt wird.
 *
 * Gebraucht für --accent-soft: Die reine Akzentfarbe ist als Textfarbe auf
 * dunklem Grund oft zu dunkel, gerade bei Violett und Blau.
 *
 * @param {string} hex
 * @param {number} amount 0 = unverändert, 1 = weiß
 * @returns {string}
 */
function lighten(hex, amount) {
  const { r, g, b } = toRgb(hex);
  const mix = (value) => Math.round(value + (255 - value) * amount);

  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

/**
 * Prüft, ob eine Zeichenkette eine brauchbare Farbe ist.
 *
 * Wichtig, weil der Wert aus dem localStorage oder vom Server kommt und dort
 * auch Unsinn stehen könnte. Eine ungültige Farbe würde das halbe Layout
 * unsichtbar machen.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isValidColor(value) {
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(value || '').trim());
}

/**
 * Bringt ein beliebiges Objekt auf ein gültiges Thema.
 *
 * @param {object} [theme]
 * @returns {{accent: string, base: string}}
 */
export function normalizeTheme(theme) {
  const accent = isValidColor(theme?.accent) ? theme.accent.toLowerCase() : DEFAULT_THEME.accent;

  const base = BASE_PRESETS.some(([value]) => value === theme?.base)
    ? theme.base
    : DEFAULT_THEME.base;

  return { accent, base };
}

/**
 * Wendet ein Thema sofort an.
 *
 * Gesetzt wird direkt am <html>-Element: Von dort erben alle CSS-Variablen
 * nach unten, und was hier steht, sticht die Vorgaben aus :root.
 *
 * @param {object} theme
 * @returns {{accent: string, base: string}} das tatsächlich angewendete Thema
 */
export function applyTheme(theme) {
  const { accent, base } = normalizeTheme(theme);
  const root = document.documentElement;

  root.style.setProperty('--accent', accent);
  // 32 % Weiß dazu – hell genug für Text, ohne blass zu wirken.
  root.style.setProperty('--accent-soft', lighten(accent, 0.32));

  const { r, g, b } = toRgb(accent);
  root.style.setProperty('--accent-glow', `rgba(${r}, ${g}, ${b}, 0.35)`);
  // Noch zarter, für Verläufe hinter Karten.
  root.style.setProperty('--accent-veil', `rgba(${r}, ${g}, ${b}, 0.1)`);

  // Den Grundton als Attribut, nicht als Variable: Daran hängen im
  // Stylesheet gleich mehrere Werte (Hintergrund und drei Flächenstufen),
  // die zusammengehören.
  root.setAttribute('data-base', base);

  return { accent, base };
}

/**
 * Liest das im Browser gemerkte Thema.
 *
 * @returns {{accent: string, base: string}}
 */
export function loadTheme() {
  try {
    return normalizeTheme(JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'));
  } catch {
    // Privates Fenster, blockierte Website-Daten, kaputter Eintrag – in allen
    // Fällen gilt eben die Vorgabe.
    return { ...DEFAULT_THEME };
  }
}

/**
 * Merkt sich ein Thema im Browser.
 *
 * @param {object} theme
 */
export function saveTheme(theme) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeTheme(theme)));
  } catch {
    /* nicht schreibbar – dann gilt es nur für diese Sitzung */
  }
}

/**
 * Wendet das gemerkte Thema an. Wird ganz früh beim Start aufgerufen.
 *
 * @returns {{accent: string, base: string}}
 */
export function initTheme() {
  return applyTheme(loadTheme());
}
