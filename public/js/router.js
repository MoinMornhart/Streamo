/**
 * ---------------------------------------------------------------------------
 * public/js/router.js – Adressleisten-Routing ohne Framework
 * ---------------------------------------------------------------------------
 * Streamo hat echte URLs (/library, /show/tv/1399) statt Rautenzeichen. Das
 * funktioniert, weil der Server für jeden unbekannten Pfad index.html
 * ausliefert (SPA-Fallback in src/server.js) und dieser Router danach anhand
 * der Adresse entscheidet, welche Ansicht gezeichnet wird.
 *
 * Verknüpfungen:
 *   - public/js/app.js     -> registriert die Routen und startet den Router
 *   - public/js/views/*.js -> die Funktionen, die hier hinterlegt werden
 *   - index.html           -> Verweise mit data-link werden abgefangen
 * ---------------------------------------------------------------------------
 */

/**
 * Die Routentabelle.
 * @type {{pattern: RegExp, keys: string[], handler: Function}[]}
 */
const routes = [];

/** Die zuletzt gezeichnete Ansicht – verhindert doppeltes Rendern. */
let currentPath = null;

/**
 * Registriert eine Route.
 *
 * Das Muster wird in einen regulären Ausdruck übersetzt:
 *   "/show/:mediaType/:tmdbId"  ->  /^\/show\/([^/]+)\/([^/]+)$/
 * Die Namen der Platzhalter merken wir uns in `keys`, damit der Handler ein
 * benanntes Objekt bekommt statt eines Arrays.
 *
 * @param {string} pattern z. B. "/library" oder "/show/:mediaType/:tmdbId"
 * @param {(params: Record<string,string>, query: URLSearchParams) => void} handler
 */
export function route(pattern, handler) {
  const keys = [];

  const regex = new RegExp(
    '^' +
      pattern
        // Schrägstriche und Punkte im Muster maskieren.
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        // :name in eine Fanggruppe umwandeln und den Namen merken.
        .replace(/\/:(\w+)/g, (_, key) => {
          keys.push(key);
          return '/([^/]+)';
        }) +
      '$',
  );

  routes.push({ pattern: regex, keys, handler });
}

/**
 * Wechselt auf einen Pfad, ohne die Seite neu zu laden.
 *
 * @param {string} path Zielpfad, z. B. "/library?status=watching"
 * @param {object} [options]
 * @param {boolean} [options.replace] true = keinen neuen Verlaufseintrag
 *   anlegen (nützlich bei Weiterleitungen, damit "Zurück" nicht hängen bleibt)
 */
export function navigateTo(path, options = {}) {
  if (options.replace) {
    window.history.replaceState({}, '', path);
  } else {
    window.history.pushState({}, '', path);
  }
  resolve();
}

/**
 * Sucht die passende Route zur aktuellen Adresse und ruft ihren Handler auf.
 * @param {boolean} [force] true = auch neu zeichnen, wenn der Pfad gleich blieb
 */
export function resolve(force = false) {
  const path = window.location.pathname;
  const query = new URLSearchParams(window.location.search);

  // Der volle Schlüssel enthält auch die Query, damit ein Wechsel von
  // /library?status=watching zu /library?status=completed neu zeichnet.
  const key = path + window.location.search;
  if (!force && key === currentPath) return;
  currentPath = key;

  // Navigationspunkt in der Kopfzeile markieren.
  for (const link of document.querySelectorAll('#topbar nav a')) {
    // Die Startseite "/" ist nur bei exakter Übereinstimmung aktiv, sonst
    // wäre sie auf jeder Seite markiert (jeder Pfad beginnt mit "/").
    const href = link.getAttribute('href');
    link.classList.toggle('active', href === '/' ? path === '/' : path.startsWith(href));
  }

  // Nach oben scrollen – sonst landet man auf der neuen Seite mittendrin.
  window.scrollTo(0, 0);

  for (const { pattern, keys, handler } of routes) {
    const match = path.match(pattern);
    if (!match) continue;

    // Fanggruppen den Platzhalternamen zuordnen und URL-Kodierung auflösen.
    const params = Object.fromEntries(
      keys.map((k, i) => [k, decodeURIComponent(match[i + 1])]),
    );

    handler(params, query);
    return;
  }

  // Keine Route passt -> 404-Ansicht.
  import('./ui.js').then(({ render, viewRoot, empty, el }) => {
    render(
      viewRoot(),
      empty('🧭', 'Seite nicht gefunden', `Für "${path}" gibt es hier nichts.`, el('a.btn.btn-primary', { href: '/', 'data-link': '', text: 'Zur Startseite' })),
    );
  });
}

/**
 * Startet den Router: fängt Klicks auf interne Verweise ab und reagiert auf
 * die Vor-/Zurück-Knöpfe des Browsers.
 */
export function startRouter() {
  // Ein einziger Listener am Dokument statt eines pro Verweis. Das funktioniert
  // auch für Verweise, die erst später erzeugt werden (Ereignis-Delegation).
  document.addEventListener('click', (event) => {
    const link = event.target.closest('a[data-link]');
    if (!link) return;

    // Mit gedrückter Steuerungs-/Befehlstaste oder mittlerer Maustaste will
    // der Benutzer einen neuen Tab – das darf der Router nicht abfangen.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;

    event.preventDefault();
    navigateTo(link.getAttribute('href'));
  });

  // Vor/Zurück im Browser.
  window.addEventListener('popstate', () => resolve());

  // Global verfügbar machen, damit auch Bausteine in ui.js navigieren können,
  // ohne den Router importieren zu müssen (vermeidet einen Importkreis).
  window.navigateTo = navigateTo;

  resolve();
}
