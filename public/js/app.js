/**
 * ---------------------------------------------------------------------------
 * public/js/app.js – Einstiegspunkt des Frontends
 * ---------------------------------------------------------------------------
 * Ablauf beim Laden der Seite:
 *   1. /api/auth/status abfragen: Muss eingerichtet werden? Wer ist angemeldet?
 *   2. Je nach Antwort den Einrichtungsassistenten, die Anmeldung oder die
 *      eigentliche Anwendung anzeigen.
 *   3. Kopfzeile befüllen, Routen registrieren, Router starten.
 *
 * Diese Datei hält außerdem den einzigen globalen Zustand: das Objekt `state`
 * mit dem angemeldeten Benutzer. Alles andere lädt jede Ansicht selbst.
 *
 * Verknüpfungen:
 *   - public/js/api.js      -> Serverzugriff
 *   - public/js/router.js   -> Routentabelle
 *   - public/js/views/*.js  -> die einzelnen Ansichten
 *   - index.html            -> die Elemente, die hier befüllt werden
 * ---------------------------------------------------------------------------
 */

import { api } from './api.js';
import { render, viewRoot, loading, toast, banner, el } from './ui.js';
import { route, startRouter, navigateTo, resolve } from './router.js';
// Farbschema: Das im Browser gemerkte wendet bereits index.html an, hier
// kommt das am Konto hinterlegte hinterher.
import { applyTheme, saveTheme } from './theme.js';

/**
 * Der gemeinsame Zustand.
 * Absichtlich klein gehalten: nur was wirklich seitenübergreifend gebraucht
 * wird. Ansichten laden ihre Daten jeweils frisch.
 */
export const state = {
  /** Der angemeldete Benutzer oder null */
  user: null,
  /** Ist ein TMDB-Key hinterlegt? Steuert den Hinweisbanner. */
  hasApiKey: false,
  /** Streamo-Version, für den Footer */
  version: '',
  /** Die eigene Watch-Region, z. B. "DE" */
  region: 'DE',
  /**
   * Darf sich jede Person selbst ein Konto anlegen?
   *
   * Kommt aus ALLOW_REGISTRATION in der .env (siehe src/config.js). Steuert,
   * ob der Anmeldebildschirm ein Feld für einen Einladungscode verlangt:
   * Ist die Registrierung offen, reichen Name und Passwort; sonst braucht es
   * eine Einladung von der Person, die Streamo betreibt.
   */
  allowRegistration: false,
};

/**
 * Zeichnet Kopfzeile und Fußzeile passend zum Anmeldezustand.
 * Wird nach jeder Anmeldung und Abmeldung erneut aufgerufen.
 */
export function updateChrome() {
  const topbar = document.getElementById('topbar');
  const footer = document.getElementById('footer');
  const mobileNav = document.getElementById('mobile-nav');

  // Ohne Anmeldung gibt es weder Navigation noch Fußzeile – der
  // Anmeldebildschirm soll aufgeräumt sein.
  topbar.hidden = !state.user;
  footer.hidden = !state.user;

  // Die untere Leiste wird per CSS nur auf Telefonen angezeigt; hier geht es
  // allein darum, sie ohne Anmeldung ganz aus dem Weg zu haben.
  mobileNav.hidden = !state.user;

  if (!state.user) return;

  const name = state.user.display_name || state.user.username;

  // Der Kreis oben rechts zeigt den ersten Buchstaben des Namens.
  document.getElementById('user-initial').textContent = name.charAt(0).toUpperCase();
  document.getElementById('user-name').textContent = name;
  document.getElementById('user-region').textContent = `Region ${state.region}`;
  document.getElementById('footer-version').textContent = `v${state.version}`;

  // Hinweis, solange kein TMDB-Key hinterlegt ist. Ohne ihn funktionieren
  // Suche und Verfügbarkeit nicht – das muss sichtbar sein.
  if (!state.hasApiKey) {
    banner('Es ist kein TMDB-API-Key hinterlegt. Ohne ihn bleiben Suche und Streaming-Anbieter leer.', {
      label: 'Jetzt eintragen',
      href: '/settings',
    });
  } else {
    banner(null);
  }
}

/**
 * Fragt den Anmeldezustand beim Server ab und aktualisiert `state`.
 * @returns {Promise<object>} die Antwort von /api/auth/status
 */
export async function refreshStatus() {
  const status = await api.auth.status();

  state.user = status.user;
  state.hasApiKey = status.hasApiKey;
  state.version = status.version;
  state.region = status.user?.region || status.defaults.region;
  state.allowRegistration = Boolean(status.allowRegistration);

  // Das am Konto hinterlegte Farbschema anwenden – so gilt dieselbe Farbe
  // auch in einem Browser, in dem sie noch nie eingestellt wurde.
  //
  // Das kleine Stück Code im <head> von index.html hat vorher schon das
  // gemerkte Thema aus dem localStorage angewendet, damit nichts aufblitzt.
  // Hier kommt es nur noch vom Server hinterher.
  if (status.user?.theme) {
    try {
      const theme = JSON.parse(status.user.theme);
      applyTheme(theme);
      saveTheme(theme);
    } catch {
      /* Unbrauchbarer Eintrag – dann bleibt es beim gemerkten Thema. */
    }
  }

  updateChrome();
  return status;
}

// --------------------------------------------------------------------------
// Routentabelle
// Jede Zeile verknüpft eine Adresse mit einer Ansicht. Die Ansichten werden
// per dynamischem import() geladen – so lädt der Browser nur den Code, der
// tatsächlich gebraucht wird.
// --------------------------------------------------------------------------

/**
 * Hilfsfunktion: zeigt eine Ladeanzeige, lädt das Modul und ruft es auf.
 * Fehler landen in einer Meldung statt in der Konsole.
 *
 * @param {() => Promise<{render: Function}>} loader dynamischer Import
 * @returns {(params: object, query: URLSearchParams) => void}
 */
function view(loader) {
  return async (params, query) => {
    // Ohne Anmeldung führt jeder Pfad zur Anmeldung – der Server würde die
    // API-Aufrufe ohnehin mit 401 ablehnen.
    if (!state.user) {
      const mod = await import('./views/auth.js');
      mod.render(viewRoot());
      return;
    }

    render(viewRoot(), loading());

    try {
      const mod = await loader();
      await mod.render(viewRoot(), params, query);
    } catch (error) {
      // 401 bedeutet: Die Sitzung ist abgelaufen. Zustand neu holen und den
      // Anmeldebildschirm zeigen, statt eine Fehlermeldung anzuzeigen.
      if (error.status === 401) {
        await refreshStatus();
        resolve(true);
        return;
      }

      render(
        viewRoot(),
        el('div.card', {}, [
          el('h2', { text: 'Das hat nicht geklappt' }),
          el('p.muted', { text: error.message }),
          el('button.btn.btn-primary', {
            text: 'Erneut versuchen',
            onClick: () => resolve(true),
          }),
        ]),
      );
    }
  };
}

// --------------------------------------------------------------------------
// Die einzige Adresse, die OHNE Anmeldung funktioniert: eine geteilte Liste.
//
// Sie umgeht bewusst die Hülle view(), denn die würde jeden nicht angemeldeten
// Besucher zur Anmeldemaske schicken. Wer per WhatsApp einen Link bekommt,
// soll die Liste einfach sehen – ohne Konto, ohne Hürde.
// --------------------------------------------------------------------------
route('/s/:token', async (params) => {
  render(viewRoot(), loading('Liste wird geladen …'));

  const mod = await import('./views/shared.js');
  await mod.render(viewRoot(), params);
});

// Eine Einladung einloesen - ebenfalls ohne Anmeldung erreichbar.
route('/einladung/:token', async (params) => {
  render(viewRoot(), loading('Einladung wird geprueft …'));

  const mod = await import('./views/auth.js');

  // Erst pruefen, ob die Einladung ueberhaupt taugt. Sonst fuellt jemand
  // das Formular aus und erfaehrt danach, dass der Link abgelaufen ist.
  try {
    const check = await api.auth.checkInvite(params.token);

    if (!check.valid) {
      render(
        viewRoot(),
        el('div.auth-screen', {}, [
          el('div.auth-box', {}, [
            el('div.auth-logo', {}, [el('span.brand-mark', { text: 'S' }), 'Streamo']),
            el('h2', { text: 'Einladung ungueltig' }),
            el('p.muted', { text: check.reason }),
            el('p.hint', { text: 'Bitte die Person fragen, die dich eingeladen hat - sie kann einen neuen Link erzeugen.' }),
          ]),
        ]),
      );
      return;
    }
  } catch (error) {
    render(viewRoot(), el('div.auth-screen', {}, [el('div.auth-box', {}, [el('p', { text: error.message })])]));
    return;
  }

  mod.render(viewRoot(), { mode: 'invite', token: params.token });
});

route('/', view(() => import('./views/home.js')));
route('/search', view(() => import('./views/search.js')));
route('/library', view(() => import('./views/library.js')));
route('/providers', view(() => import('./views/providers.js')));
route('/stats', view(() => import('./views/stats.js')));
route('/achievements', view(() => import('./views/achievements.js')));
route('/collections', view(() => import('./views/collections.js')));
// Eine einzelne Filmreihe: /collections/12
route('/collections/:id', view(() => import('./views/collections.js')));
route('/friends', view(() => import('./views/friends.js')));
// /friends/recommendations und /friends/12 teilen sich dieselbe Route -
// die Ansicht unterscheidet anhand des Werts.
route('/friends/:id', view(() => import('./views/friends.js')));
// /friends/12/library
route('/friends/:id/:sub', view(() => import('./views/friends.js')));
route('/settings', view(() => import('./views/settings.js')));
// Detailseite: /show/tv/1399 – mediaType und tmdbId landen in params.
route('/show/:mediaType/:tmdbId', view(() => import('./views/detail.js')));

// --------------------------------------------------------------------------
// Ereignisse der Kopfzeile
// --------------------------------------------------------------------------

// Die Suchleiste schickt zur Suchansicht. Der Begriff steht in der URL, damit
// eine Suche verlinkbar und über "Zurück" wiederherstellbar ist.
document.getElementById('global-search').addEventListener('submit', (event) => {
  event.preventDefault();
  const query = document.getElementById('global-search-input').value.trim();
  if (query) navigateTo(`/search?q=${encodeURIComponent(query)}`);
});

// Konto-Menü auf- und zuklappen.
const menuButton = document.getElementById('user-menu-button');
const menu = document.getElementById('user-menu');

menuButton.addEventListener('click', (event) => {
  event.stopPropagation(); // sonst schließt der Dokument-Listener sofort wieder
  menu.hidden = !menu.hidden;
});

// Klick irgendwo anders schließt das Menü.
document.addEventListener('click', (event) => {
  if (!menu.hidden && !menu.contains(event.target)) menu.hidden = true;
});

// Abmelden.
document.getElementById('logout-button').addEventListener('click', async () => {
  try {
    await api.auth.logout();
  } catch {
    // Auch wenn der Server nicht antwortet: örtlich abmelden. Die Sitzung
    // läuft serverseitig ohnehin ab, und den Benutzer in einer scheinbar
    // angemeldeten Oberfläche stehenzulassen wäre schlimmer.
  }

  state.user = null;
  updateChrome();
  menu.hidden = true;

  // Zur Startseite und neu zeichnen. Das Erzwingen ist wichtig: Meldet man
  // sich ab, während man bereits auf "/" steht, hält der Router den Pfad für
  // unverändert und würde gar nichts tun – die Oberfläche bliebe stehen, bis
  // man die Seite von Hand neu lädt.
  window.history.pushState({}, '', '/');
  resolve(true);

  toast('Abgemeldet.');
});

// --------------------------------------------------------------------------
// Start
// --------------------------------------------------------------------------

/**
 * Startet die Anwendung. Läuft genau einmal beim Laden der Seite.
 */
async function boot() {
  try {
    const status = await refreshStatus();

    // Frische Installation -> Einrichtungsassistent. Mit einer Ausnahme:
    // Eine geteilte Liste soll auch dann sichtbar sein. Wer einen Link
    // bekommt, hat mit der Einrichtung dieser Instanz nichts zu tun.
    if (
      status.needsSetup &&
      !window.location.pathname.startsWith('/s/') &&
      !window.location.pathname.startsWith('/einladung/')
    ) {
      const mod = await import('./views/auth.js');
      mod.render(viewRoot(), { mode: 'setup', defaults: status.defaults });
      return;
    }

    startRouter();
  } catch (error) {
    // Kommt der Server gar nicht ans Telefon, hilft nur ein klarer Hinweis.
    render(
      viewRoot(),
      el('div.auth-screen', {}, [
        el('div.auth-box', {}, [
          el('h1', { text: 'Keine Verbindung' }),
          el('p.muted', {
            text: `Streamo konnte den Server nicht erreichen: ${error.message}`,
          }),
          el('button.btn.btn-primary', {
            text: 'Neu laden',
            onClick: () => window.location.reload(),
          }),
        ]),
      ]),
    );
  }
}

boot();
