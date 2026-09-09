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
import { isSupported, hasPlatformAuthenticator, usePasskey } from '../passkey.js';

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
              email: data.email,
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

        field(
          'email',
          'E-Mail (optional)',
          { type: 'email', autocomplete: 'email', placeholder: 'max@example.de' },
          'Nur als zweiter Anmeldename. Streamo verschickt keine E-Mails und braucht keinen Mailserver.',
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
  // Einladung einlösen
  // ------------------------------------------------------------------------
  // Der Bildschirm für Leute, die einen Einladungslink bekommen haben.
  // Bewusst kurz: Benutzername, Passwort, fertig. Kein TMDB-Zugang, keine
  // Region, keine Erklärungen – all das ist auf dieser Instanz längst
  // eingerichtet.
  if (mode === 'invite') {
    const form = el(
      'form',
      {
        onSubmit: async (event) => {
          event.preventDefault();
          render(messageSlot);

          const data = Object.fromEntries(new FormData(form).entries());
          const button = form.querySelector('button[type=submit]');

          button.disabled = true;
          button.textContent = 'Konto wird angelegt …';

          try {
            await api.auth.register({
              username: data.username,
              password: data.password,
              displayName: data.displayName,
              invite: options.token,
            });

            await refreshStatus();
            toast('Willkommen bei Streamo!', 'success');

            // Direkt zur Anbieter-Auswahl – ohne verknüpfte Abos wäre
            // Streamo nur halb nützlich.
            startRouter();
            navigateTo('/providers');
          } catch (error) {
            render(messageSlot, errorBox(error.message));
            button.disabled = false;
            button.textContent = 'Konto anlegen';
          }
        },
      },
      [
        field('username', 'Benutzername', {
          required: true,
          minlength: 3,
          autocomplete: 'username',
          placeholder: 'z. B. lisa',
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

        field('displayName', 'Anzeigename (optional)', { placeholder: 'Lisa' }),

        messageSlot,

        el('button.btn.btn-primary', {
          type: 'submit',
          text: 'Konto anlegen',
          style: { width: '100%', height: '42px' },
        }),
      ],
    );

    render(
      container,
      el('div.auth-screen', {}, [
        el('div.auth-box', {}, [
          el('div.auth-logo', {}, [el('span.brand-mark', { text: 'S' }), 'Du bist eingeladen']),
          el('p.auth-sub', {
            text: 'Leg dir ein Konto an – mehr braucht es nicht. Alles Weitere ist schon eingerichtet.',
          }),
          form,

          el('p.hint', {
            style: { marginTop: '18px', marginBottom: 0 },
            text: 'Du brauchst keinen eigenen Zugang zu einer Filmdatenbank und musst nichts installieren. Sobald du angemeldet bist, klickst du nur noch deine Streaming-Abos an.',
          }),
        ]),
      ]),
    );
    return;
  }

  // ------------------------------------------------------------------------
  // Der zweite Faktor beim Anmelden
  // ------------------------------------------------------------------------
  // Erreicht man nur aus der Anmeldemaske heraus: Das Passwort hat gestimmt,
  // aber eine Sitzung gibt es noch nicht. options.pendingToken ist der Beleg
  // dafür, er gilt fünf Minuten.
  //
  // Angenommen wird beides – der sechsstellige Code aus der App und ein
  // Ersatzcode. Deshalb steht hier nur ein Feld statt zweier: Wer sein
  // Telefon verloren hat, ist ohnehin in Not und soll nicht auch noch den
  // richtigen Reiter suchen müssen.
  if (mode === 'twofactor') {
    const form = el(
      'form',
      {
        onSubmit: async (event) => {
          event.preventDefault();
          render(messageSlot);

          const data = Object.fromEntries(new FormData(form).entries());
          const button = form.querySelector('button[type=submit]');

          button.disabled = true;
          button.textContent = 'Wird geprüft …';

          try {
            const result = await api.auth.loginTwoFactor(options.pendingToken, data.code);

            await refreshStatus();

            // Ein verbrauchter Ersatzcode ist eine Nachricht wert: Er ist
            // jetzt weg, und irgendwann sind alle aufgebraucht.
            if (result.usedBackupCode) {
              toast(
                `Ersatzcode verwendet. Es sind noch ${result.backupCodesLeft} übrig.`,
                'info',
              );
            }

            startRouter();
          } catch (error) {
            render(messageSlot, errorBox(error.message));

            // Ist der Zwischen-Token verfallen – abgelaufen oder zu viele
            // Fehlversuche –, hilft kein weiterer Code. Dann zurück zur
            // Anmeldung, sonst tippt man ins Leere.
            if (error.code === 'pending_expired' || error.code === 'too_many_attempts') {
              setTimeout(() => render_(container, { ...options, mode: 'login' }), 2200);
              return;
            }

            button.disabled = false;
            button.textContent = 'Bestätigen';

            // Für den nächsten Versuch leeren und den Fokus zurückgeben.
            const input = form.querySelector('#code');
            input.value = '';
            input.focus();
          }
        },
      },
      [
        field(
          'code',
          'Code aus deiner App',
          {
            required: true,
            // inputmode statt type="number": Auf dem Telefon erscheint die
            // Zifferntastatur, aber ohne die Pfeilchen zum Hoch- und
            // Runterzählen, die bei einem Code sinnlos sind. Und ein
            // Ersatzcode enthält Buchstaben, wäre mit type="number" also
            // gar nicht eingebbar.
            inputmode: 'numeric',
            autocomplete: 'one-time-code',
            placeholder: '123456',
            // Der Browser soll nichts vorschlagen und nichts korrigieren.
            autocapitalize: 'characters',
            spellcheck: 'false',
            style: { fontSize: '20px', letterSpacing: '3px', textAlign: 'center' },
          },
          'Sechs Ziffern. Du kannst hier auch einen deiner Ersatzcodes eingeben.',
        ),

        messageSlot,

        el('button.btn.btn-primary', {
          type: 'submit',
          text: 'Bestätigen',
          style: { width: '100%', height: '42px' },
        }),
      ],
    );

    render(
      container,
      el('div.auth-screen', {}, [
        el('div.auth-box', {}, [
          el('div.auth-logo', {}, [el('span.brand-mark', { text: 'S' }), 'Noch ein Schritt']),
          el('p.auth-sub', {
            text: 'Dein Passwort stimmt. Gib jetzt den Code aus deiner Authenticator-App ein.',
          }),
          form,

          el('p.auth-switch', {}, [
            el('a', {
              href: '#',
              text: 'Abbrechen',
              onClick: (event) => {
                event.preventDefault();
                render_(container, { ...options, mode: 'login' });
              },
            }),
          ]),
        ]),
      ]),
    );

    // Der Fokus gehört sofort ins Feld – man hat den Code schon im Blick.
    form.querySelector('#code').focus();
    return;
  }

  // ------------------------------------------------------------------------
  // Konto selbst anlegen
  // ------------------------------------------------------------------------
  // Erreichbar über den Verweis unter der Anmeldemaske. Bis dahin gab es nur
  // zwei Wege zu einem Konto: die Ersteinrichtung (genau einmal je Instanz)
  // und einen Einladungslink. Wer weder das eine noch das andere hatte, stand
  // vor einer Anmeldemaske ohne Ausweg.
  //
  // Ob es dabei einen Einladungscode braucht, entscheidet die Instanz über
  // ALLOW_REGISTRATION. Ist die Registrierung offen, reichen Name und
  // Passwort; sonst erscheint zusätzlich ein Feld für den Code. Dieses Feld
  // ist der eigentliche Gewinn gegenüber vorher: Wer den Code als Text
  // bekommen hat statt als Link, konnte ihn bisher nirgends eingeben.
  if (mode === 'register') {
    const open = state.allowRegistration;

    const form = el(
      'form',
      {
        onSubmit: async (event) => {
          event.preventDefault();
          render(messageSlot);

          const data = Object.fromEntries(new FormData(form).entries());
          const button = form.querySelector('button[type=submit]');

          button.disabled = true;
          button.textContent = 'Konto wird angelegt …';

          try {
            await api.auth.register({
              username: data.username,
              password: data.password,
              email: data.email,
              displayName: data.displayName,
              // Leere Eingabe als "keine Einladung" durchreichen, sonst
              // prüfte der Server einen leeren Token.
              invite: data.invite?.trim() || undefined,
            });

            await refreshStatus();
            toast('Willkommen bei Streamo!', 'success');

            // Direkt zur Anbieter-Auswahl – ohne verknüpfte Abos wäre
            // Streamo nur halb nützlich.
            startRouter();
            navigateTo('/providers');
          } catch (error) {
            render(messageSlot, errorBox(error.message));
            button.disabled = false;
            button.textContent = 'Konto anlegen';
          }
        },
      },
      [
        field('username', 'Benutzername', {
          required: true,
          minlength: 3,
          autocomplete: 'username',
          placeholder: 'z. B. lisa',
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

        field(
          'email',
          'E-Mail (optional)',
          { type: 'email', autocomplete: 'email', placeholder: 'lisa@example.de' },
          'Nur als zweiter Anmeldename. Streamo verschickt keine E-Mails.',
        ),

        field('displayName', 'Anzeigename (optional)', { placeholder: 'Lisa' }),

        // Nur nötig, solange die Registrierung nicht offen steht.
        !open &&
          field(
            'invite',
            'Einladungscode',
            { required: true, placeholder: 'Code aus der Einladung' },
            'Auf dieser Instanz braucht es eine Einladung. Hast du einen Link bekommen, kannst du ihn auch einfach öffnen.',
          ),

        messageSlot,

        el('button.btn.btn-primary', {
          type: 'submit',
          text: 'Konto anlegen',
          style: { width: '100%', height: '42px' },
        }),
      ],
    );

    render(
      container,
      el('div.auth-screen', {}, [
        el('div.auth-box', {}, [
          el('div.auth-logo', {}, [el('span.brand-mark', { text: 'S' }), 'Konto anlegen']),
          el('p.auth-sub', {
            text: open
              ? 'Zwei Angaben, dann gehören alle deine Streaming-Abos an einen Ort.'
              : 'Für ein Konto auf dieser Instanz brauchst du eine Einladung.',
          }),
          form,

          // Zurück zur Anmeldung. Der Wechsel geschieht ohne Neuladen –
          // beide Masken liegen in derselben Datei.
          el('p.auth-switch', {}, [
            'Du hast schon ein Konto? ',
            el('a', {
              href: '#',
              text: 'Anmelden',
              onClick: (event) => {
                event.preventDefault();
                render_(container, { ...options, mode: 'login' });
              },
            }),
          ]),
        ]),
      ]),
    );
    return;
  }

  // ------------------------------------------------------------------------
  // Anmeldung
  // ------------------------------------------------------------------------

  /**
   * Meldet mit einem Passkey an.
   *
   * Zwei Schritte, siehe public/js/passkey.js:
   *   1. Aufgabe vom Server holen
   *   2. Vom Gerät unterschreiben lassen und zurückschicken
   *
   * Ein Benutzername wird nicht übergeben – der Browser zeigt alle für diese
   * Domain gespeicherten Passkeys zur Auswahl.
   *
   * @param {HTMLButtonElement} button Der Knopf, der gerade gedrückt wurde
   */
  const loginWithPasskey = async (button) => {
    render(messageSlot);

    const label = button.textContent;
    button.disabled = true;
    button.textContent = 'Warte auf dein Gerät …';

    try {
      const options = await api.auth.passkeyLoginOptions();
      const response = await usePasskey(options);

      await api.auth.passkeyLoginVerify(response);
      await refreshStatus();

      startRouter();
    } catch (error) {
      render(messageSlot, errorBox(error.message));
      button.disabled = false;
      button.textContent = label;
    }
  };

  const passkeyButton = el('button.btn.btn-primary', {
    type: 'button',
    // Der endgültige Text wird unten gesetzt, sobald bekannt ist, ob das
    // Gerät einen eingebauten Sensor hat.
    text: '🔑 Mit Passkey anmelden',
    style: { width: '100%', height: '42px' },
    onClick: (event) => loginWithPasskey(event.currentTarget),
  });

  // Der Passkey-Bereich wird erst eingeblendet, wenn feststeht, dass er
  // funktionieren kann – ein Knopf, der beim Klick scheitert, ist ärgerlicher
  // als gar keiner.
  const passkeySlot = el('div', { hidden: true }, [
    passkeyButton,
    // Trenner zwischen den beiden Wegen.
    el(
      'div',
      {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          margin: '20px 0 16px',
          color: 'var(--text-faint)',
          fontSize: '13px',
        },
      },
      [
        el('div', { style: { flex: '1', height: '1px', background: 'var(--surface-3)' } }),
        el('span', { text: 'oder mit Passwort' }),
        el('div', { style: { flex: '1', height: '1px', background: 'var(--surface-3)' } }),
      ],
    ),
  ]);

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
          const result = await api.auth.login(data.username, data.password);

          // Ist der zweite Faktor eingeschaltet, ist noch keine Sitzung
          // entstanden – es fehlt der Code aus der App. Der Server hat dafür
          // einen kurzlebigen Zwischen-Token mitgeschickt.
          if (result.needsTwoFactor) {
            render_(container, {
              ...options,
              mode: 'twofactor',
              pendingToken: result.pendingToken,
            });
            return;
          }

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
      field('username', 'Benutzername oder E-Mail', {
        required: true,
        autocomplete: 'username',
      }),
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
        passkeySlot,
        form,

        // Der Weg zu einem eigenen Konto. Er steht hier immer, auch wenn die
        // Registrierung nicht offen ist: Dann verlangt die nächste Maske
        // einen Einladungscode. Den Verweis in dem Fall zu verstecken wäre
        // schlechter – wer einen Code hat, fände sonst nirgends ein Feld
        // dafür und wüsste nicht, was er damit anfangen soll.
        el('p.auth-switch', {}, [
          'Noch kein Konto? ',
          el('a', {
            href: '#',
            text: 'Konto erstellen',
            onClick: (event) => {
              event.preventDefault();
              render_(container, { ...options, mode: 'register' });
            },
          }),
        ]),
      ]),
    ]),
  );

  // ------------------------------------------------------------------------
  // Passkey-Bereich nachträglich einblenden.
  //
  // Nachträglich, weil zwei Auskünfte nötig sind, die beide asynchron kommen:
  // vom Server (ist die Adresse geeignet?) und vom Browser (gibt es hier
  // überhaupt einen Sensor?). Die Anmeldemaske soll darauf nicht warten.
  // ------------------------------------------------------------------------
  (async () => {
    if (!isSupported()) return;

    try {
      const availability = await api.auth.passkeyAvailable();
      if (!availability.available) return;

      // Beschriftung an das Gerät anpassen: "Windows Hello" ist für die
      // meisten Menschen greifbarer als das Wort "Passkey".
      if (await hasPlatformAuthenticator()) {
        const isWindows = navigator.userAgent.includes('Windows');
        const isApple = /Mac|iPhone|iPad/.test(navigator.userAgent);

        passkeyButton.textContent = isWindows
          ? '🔑 Mit Windows Hello anmelden'
          : isApple
            ? '🔑 Mit Touch ID oder Face ID anmelden'
            : '🔑 Mit Passkey anmelden';
      }

      passkeySlot.hidden = false;
    } catch {
      // Kein Grund für eine Fehlermeldung – der Passwortweg steht ja bereit.
    }
  })();
}

// Der Router ruft einheitlich `render` auf; intern heißt die Funktion
// render_, weil `render` bereits aus ui.js importiert ist.
export { render_ as render };
