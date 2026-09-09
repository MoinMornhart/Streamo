/**
 * ---------------------------------------------------------------------------
 * public/js/views/auth.js – Anmeldung und Ersteinrichtung
 * ---------------------------------------------------------------------------
 * Zwei Bildschirme in einer Datei, weil sie sich Layout und Logik teilen:
 *
 *   mode "login" – Benutzername und Passwort  -> POST /api/auth/login
 *   mode "setup" – der Einrichtungsassistent  -> POST /api/auth/setup
 *
 * Der Assistent erscheint automatisch, solange kein einziger Benutzer
 * existiert (public/js/app.js prüft das über /api/auth/status).
 *
 * Verknüpfungen:
 *   - public/js/api.js  -> api.auth.*
 *   - src/routes/auth.js -> die Gegenstellen
 * ---------------------------------------------------------------------------
 */

import { api } from '../api.js';
import { el, render, toast, errorBox } from '../ui.js';
import { state, refreshStatus } from '../app.js';
import { startRouter, navigateTo } from '../router.js';

/**
 * Die Regionen, die im Auswahlfeld angeboten werden.
 * Bewusst kurz gehalten: Diese Länder decken den deutschsprachigen Raum und
 * die häufigsten Fälle ab. Jede andere ISO-3166-1-Kennung lässt sich später
 * in den Einstellungen von Hand eintragen.
 */
const REGIONS = [
  ['DE', 'Deutschland'],
  ['AT', 'Österreich'],
  ['CH', 'Schweiz'],
  ['GB', 'Großbritannien'],
  ['US', 'USA'],
  ['FR', 'Frankreich'],
  ['IT', 'Italien'],
  ['ES', 'Spanien'],
  ['NL', 'Niederlande'],
  ['PL', 'Polen'],
];

/** Die Sprachen für Titel und Beschreibungen (TMDB-Sprachkennungen). */
const LANGUAGES = [
  ['de-DE', 'Deutsch'],
  ['en-US', 'Englisch'],
  ['fr-FR', 'Französisch'],
  ['it-IT', 'Italienisch'],
  ['es-ES', 'Spanisch'],
  ['nl-NL', 'Niederländisch'],
];

/**
 * Zeichnet den Anmelde- oder Einrichtungsbildschirm.
 *
 * @param {HTMLElement} container Der Bereich, in den gezeichnet wird
 * @param {object} [options]
 * @param {'login'|'setup'} [options.mode]
 * @param {object} [options.defaults] Vorbelegung aus /api/auth/status
 */
export function render_(container, options = {}) {
  const mode = options.mode || 'login';
  const defaults = options.defaults || { region: 'DE', language: 'de-DE' };

  // Der Kasten, in den bei Fehlern eine Meldung geschrieben wird.
  const messageSlot = el('div');

  /**
   * Baut ein Eingabefeld mit Beschriftung und optionalem Hinweistext.
   * @param {string} name    Feldname (wird als id verwendet)
   * @param {string} label
   * @param {object} [attrs] weitere Attribute für <input>
   * @param {string} [hint]
   * @returns {HTMLElement}
   */
  const field = (name, label, attrs = {}, hint) =>
    el('div.field', {}, [
      el('label', { for: name, text: label }),
      el('input', { id: name, name, ...attrs }),
      hint && el('div.hint', { text: hint }),
    ]);

  /**
   * Baut ein Auswahlfeld.
   * @param {string} name
   * @param {string} label
   * @param {[string,string][]} entries [wert, beschriftung]
   * @param {string} selected
   * @returns {HTMLElement}
   */
  const select = (name, label, entries, selected) =>
    el('div.field', {}, [
      el('label', { for: name, text: label }),
      el(
        'select',
        { id: name, name },
        entries.map(([value, text]) =>
          el('option', { value, text, selected: value === selected }),
        ),
      ),
    ]);

  // ------------------------------------------------------------------------
  // Einrichtungsassistent
  // ------------------------------------------------------------------------
  if (mode === 'setup') {
    const form = el(
      'form',
      {
        onSubmit: async (event) => {
          event.preventDefault();
          render(messageSlot); // alte Fehlermeldung entfernen

          const data = Object.fromEntries(new FormData(form).entries());
          const button = form.querySelector('button[type=submit]');

          button.disabled = true;
          button.textContent = 'Wird eingerichtet …';

          try {
            await api.auth.setup({
              username: data.username,
              password: data.password,
              displayName: data.displayName,
              apiKey: data.apiKey,
              region: data.region,
              language: data.language,
            });

            // Zustand neu laden – jetzt sind wir angemeldet.
            await refreshStatus();
            toast('Willkommen bei Streamo!', 'success');

            // Direkt zur Anbieter-Auswahl: Ohne verknüpfte Abos wäre die
            // Anwendung nur halb nützlich, deshalb ist das der logische
            // nächste Schritt.
            startRouter();
            navigateTo('/providers');
          } catch (error) {
            render(messageSlot, errorBox(error.message));
            button.disabled = false;
            button.textContent = 'Streamo einrichten';
          }
        },
      },
      [
        field('username', 'Benutzername', {
          required: true,
          minlength: 3,
          autocomplete: 'username',
          placeholder: 'z. B. max',
        }),

        field(
          'password',
          'Passwort',
          {
            type: 'password',
            required: true,
            minlength: 8,
            autocomplete: 'new-password',
          },
          'Mindestens 8 Zeichen.',
        ),

        field('displayName', 'Anzeigename (optional)', { placeholder: 'Max Mustermann' }),

        el('hr', { style: { border: 'none', borderTop: '1px solid var(--surface-3)', margin: '22px 0' } }),

        field(
          'apiKey',
          'TMDB-API-Key',
          { placeholder: 'API Read Access Token oder API Key' },
          'Kostenlos unter themoviedb.org → Einstellungen → API. Beide Schlüsselarten funktionieren. Kann auch später eingetragen werden.',
        ),

        select('region', 'Deine Region', REGIONS, defaults.region),
        select('language', 'Sprache der Inhalte', LANGUAGES, defaults.language),

        messageSlot,

        el('button.btn.btn-primary', {
          type: 'submit',
          text: 'Streamo einrichten',
          style: { width: '100%', height: '42px' },
        }),
      ],
    );

    render(
      container,
      el('div.auth-screen', {}, [
        el('div.auth-box', {}, [
          el('div.auth-logo', {}, [el('span.brand-mark', { text: 'S' }), 'Streamo einrichten']),
          el('p.auth-sub', {
            text: 'Noch drei Angaben, dann gehören alle deine Streaming-Abos an einen Ort.',
          }),
          form,
        ]),
      ]),
    );
    return;
  }

  // ------------------------------------------------------------------------
  // Anmeldung
  // ------------------------------------------------------------------------
  const form = el(
    'form',
    {
      onSubmit: async (event) => {
        event.preventDefault();
        render(messageSlot);

        const data = Object.fromEntries(new FormData(form).entries());
        const button = form.querySelector('button[type=submit]');

        button.disabled = true;
        button.textContent = 'Anmelden …';

        try {
          await api.auth.login(data.username, data.password);
          await refreshStatus();

          // startRouter() zeichnet die Ansicht zur aktuellen Adresse. Nach dem
          // Anmelden landet man also dort, wo man hinwollte.
          startRouter();
        } catch (error) {
          render(messageSlot, errorBox(error.message));
          button.disabled = false;
          button.textContent = 'Anmelden';
        }
      },
    },
    [
      field('username', 'Benutzername', { required: true, autocomplete: 'username' }),
      field('password', 'Passwort', {
        type: 'password',
        required: true,
        autocomplete: 'current-password',
      }),
      messageSlot,
      el('button.btn.btn-primary', {
        type: 'submit',
        text: 'Anmelden',
        style: { width: '100%', height: '42px' },
      }),
    ],
  );

  render(
    container,
    el('div.auth-screen', {}, [
      el('div.auth-box', {}, [
        el('div.auth-logo', {}, [el('span.brand-mark', { text: 'S' }), 'Streamo']),
        el('p.auth-sub', { text: 'Alle Abos an einem Ort. Melde dich an.' }),
        form,
      ]),
    ]),
  );
}

// Der Router ruft einheitlich `render` auf; intern heißt die Funktion
// render_, weil `render` bereits aus ui.js importiert ist.
export { render_ as render };
