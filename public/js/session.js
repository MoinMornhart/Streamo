/**
 * ---------------------------------------------------------------------------
 * public/js/session.js – der gemeinsame Zustand der Oberfläche
 * ---------------------------------------------------------------------------
 * Wer ist angemeldet, ist ein TMDB-Key hinterlegt, welche Version läuft –
 * dazu die Kopfzeile, die das anzeigt. Gebraucht von app.js und von den
 * Ansichten, die nach einer Anmeldung oder Änderung den Zustand neu holen.
 *
 * Warum eine eigene Datei: Das stand früher in app.js, und die Ansichten
 * importierten es von dort. app.js lädt aber seinerseits die Ansichten – ein
 * Kreis (app.js -> views/auth.js -> app.js). Zur Laufzeit war das harmlos,
 * weil die Ansichten erst nachgeladen werden, wenn app.js längst fertig ist.
 * Es hätte aber genügt, eine Ansicht einmal statt per import() direkt
 * einzubinden, und sie hätte auf ein halb ausgeführtes app.js getroffen.
 * Hier hängt nichts an den Ansichten, also kann kein Kreis entstehen.
 *
 * Verknüpfungen:
 *   - public/js/app.js            -> holt den Zustand beim Start, Abmelden
 *   - public/js/views/auth.js     -> nach Anmeldung, Einrichtung, Einladung
 *   - public/js/views/settings.js -> nach Änderungen am eigenen Konto
 *   - index.html                  -> die Elemente der Kopfzeile
 * ---------------------------------------------------------------------------
 */

import { api } from './api.js';
import { banner, languageSwitch } from './ui.js';
// Farbschema: Das im Browser gemerkte wendet bereits index.html an, hier
// kommt das am Konto hinterlegte hinterher.
import { applyTheme, saveTheme } from './theme.js';
// Sprache der Oberfläche: setzen, erkennen, feste Texte übersetzen.
import { setLanguage, detectLanguage, translateStatic, tr } from './i18n.js';

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

  // Der Umschalter Deutsch / English neben dem Kontokreis – einmal einsetzen.
  // Die Wahl landet am Konto (PUT /api/settings { uiLanguage }, Migration 14)
  // und gilt damit auch auf den anderen Geräten.
  const langSlot = document.getElementById('lang-switch-slot');
  if (langSlot && !langSlot.hasChildNodes()) {
    langSlot.append(
      languageSwitch({ short: true, persist: (code) => api.settings.update({ uiLanguage: code }) }),
    );
  }

  // Auf dem Telefon teilt sich die Suche die Kopfzeile mit Sprachumschalter
  // und Kontokreis. Der volle Platzhalter würde dort abgeschnitten – also
  // die kurze Fassung.
  if (window.matchMedia('(max-width: 720px)').matches) {
    document.getElementById('global-search-input').placeholder = tr('Suchen …');
  }

  const name = state.user.display_name || state.user.username;

  // Der Kreis oben rechts zeigt den ersten Buchstaben des Namens.
  document.getElementById('user-initial').textContent = name.charAt(0).toUpperCase();
  document.getElementById('user-name').textContent = name;
  document.getElementById('user-region').textContent = tr(`Region ${state.region}`);
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

/** Wurden die festen Texte aus index.html schon übersetzt? */
let staticTranslated = false;

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

  // Die Sprache der Oberfläche: am Konto hinterlegt, sonst die im Browser
  // gemerkte oder die des Browsers (siehe public/js/i18n.js). Sie muss stehen,
  // bevor die erste Ansicht gezeichnet wird – el() übersetzt beim Bauen.
  setLanguage(status.user?.ui_language || detectLanguage());

  // Die festen Texte aus index.html (Navigation, Menü, Fußzeile) entstehen
  // nicht über el(). Einmal übersetzen genügt: Ein Sprachwechsel lädt neu.
  if (!staticTranslated) {
    translateStatic(document.body);
    staticTranslated = true;
  }

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
