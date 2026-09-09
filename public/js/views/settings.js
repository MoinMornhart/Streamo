/**
 * ---------------------------------------------------------------------------
 * public/js/views/settings.js – Einstellungen
 * ---------------------------------------------------------------------------
 * Adresse: /settings
 *
 * Vier Bereiche:
 *   1. Konto        – Anzeigename, Region, Sprache, Passwort
 *   2. TMDB         – der API-Key (nur für Administratoren)
 *   3. Abgleich     – Hintergrundsynchronisation starten und beobachten
 *   4. Daten        – Export und Import der Bibliothek
 *
 * Verknüpfungen:
 *   - api.settings.*      -> src/routes/settings.js
 *   - api.auth.changePassword() -> src/routes/auth.js
 *   - api.library.import()      -> src/routes/library.js
 * ---------------------------------------------------------------------------
 */

import { api } from '../api.js';
import {
  el,
  render,
  toast,
  timeAgo,
  errorBox,
  formatDate,
  copyToClipboard,
  // Fenster im Stil der Seite statt der grauen Browser-Dialoge.
  askText,
  askConfirm,
  shareSheet,
} from '../ui.js';
import { refreshStatus } from '../app.js';
import { isSupported, hasPlatformAuthenticator, createPasskey } from '../passkey.js';
// Farbschema: anwenden, merken, auswaehlen. Siehe public/js/theme.js.
import {
  ACCENT_PRESETS,
  BASE_PRESETS,
  DEFAULT_THEME,
  applyTheme,
  loadTheme,
  saveTheme,
} from '../theme.js';

/** Dieselben Listen wie im Einrichtungsassistenten (views/auth.js). */
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

const LANGUAGES = [
  ['de-DE', 'Deutsch'],
  ['en-US', 'Englisch'],
  ['fr-FR', 'Französisch'],
  ['it-IT', 'Italienisch'],
  ['es-ES', 'Spanisch'],
  ['nl-NL', 'Niederländisch'],
];

/**
 * Baut ein Auswahlfeld.
 * @param {string} id
 * @param {[string,string][]} entries
 * @param {string} selected
 * @returns {HTMLElement}
 */
function select(id, entries, selected) {
  return el(
    'select',
    { id },
    entries.map(([value, text]) => el('option', { value, text, selected: value === selected })),
  );
}

/**
 * Zeichnet die Einstellungsseite.
 * @param {HTMLElement} container
 */
export async function render_(container) {
  const data = await api.settings.get();

  // ========================================================================
  // 1. Konto
  // ========================================================================
  const displayNameInput = el('input', { value: data.user.displayName || '', id: 'displayName' });
  const regionSelect = select('region', REGIONS, data.user.region);
  const languageSelect = select('language', LANGUAGES, data.user.language);

  // Die E-Mail ist optional und dient nur als zweiter Anmeldename.
  const emailInput = el('input', {
    type: 'email',
    value: data.user.email || '',
    id: 'email',
    placeholder: 'max@example.de',
  });

  const accountCard = el('div.card', { style: { marginBottom: '20px' } }, [
    el('h2', { text: 'Konto' }),
    el('p.muted.small', { text: `Angemeldet als ${data.user.username}` }),

    el('div.field', {}, [el('label', { for: 'displayName', text: 'Anzeigename' }), displayNameInput]),

    el('div.field', {}, [
      el('label', { for: 'email', text: 'E-Mail (optional)' }),
      emailInput,
      el('div.hint', {
        text: 'Damit kannst du dich zusätzlich zum Benutzernamen anmelden. Streamo verschickt keine E-Mails – ein Mailserver ist nicht nötig. Leer lassen entfernt die Adresse.',
      }),
    ]),

    el('div.field', {}, [
      el('label', { for: 'region', text: 'Region' }),
      regionSelect,
      el('div.hint', {
        text: 'Bestimmt, welche Streaming-Anbieter angeboten werden und für welches Land die Verfügbarkeit gilt.',
      }),
    ]),

    el('div.field', {}, [
      el('label', { for: 'language', text: 'Sprache der Inhalte' }),
      languageSelect,
      el('div.hint', { text: 'Sprache von Titeln, Beschreibungen und Postern.' }),
    ]),

    el('button.btn.btn-primary', {
      text: 'Konto speichern',
      onClick: async (event) => {
        event.target.disabled = true;
        try {
          await api.settings.update({
            displayName: displayNameInput.value,
            region: regionSelect.value,
            language: languageSelect.value,
          });

          // Die E-Mail hat einen eigenen Endpunkt, weil sie eigene Prüfungen
          // hat (Format, Eindeutigkeit) und eigene Fehlermeldungen liefert.
          // Nur schicken, wenn sie sich tatsächlich geändert hat.
          const email = emailInput.value.trim();
          if (email !== (data.user.email || '')) {
            await api.auth.setEmail(email);
            data.user.email = email || null;
          }

          // Region wirkt sich auf die ganze Oberfläche aus – Zustand neu laden.
          await refreshStatus();
          toast('Gespeichert. Die neue Region gilt ab sofort.', 'success');
        } catch (error) {
          toast(error.message, 'error');
        } finally {
          event.target.disabled = false;
        }
      },
    }),
  ]);

  // ========================================================================
  // 1b. Passkeys
  // ========================================================================
  // Ein Passkey ersetzt das Passwort durch Fingerabdruck, Gesicht oder PIN.
  // Der private Schlüssel bleibt im Gerät – Streamo speichert nur den
  // öffentlichen Teil und kann deshalb nichts verraten, was zum Anmelden
  // reicht. Details in src/passkeys.js.
  const passkeyList = el('div');
  const passkeyCard = el('div.card', { style: { marginBottom: '20px' } }, [
    el('h2', { text: 'Passkeys' }),
    el('p.muted.small', {
      text: 'Melde dich mit Fingerabdruck, Gesicht oder Geräte-PIN an, statt ein Passwort einzutippen. Der Schlüssel bleibt auf deinem Gerät.',
    }),
    passkeyList,
  ]);

  /**
   * Zeichnet die Passkey-Liste samt Knöpfen neu.
   * Wird nach jeder Änderung erneut aufgerufen, damit die Anzeige stimmt.
   */
  const drawPasskeys = async () => {
    // Erst klären, ob Passkeys hier überhaupt möglich sind. Die Gründe kommen
    // vom Server (HTTPS, Hostname) und vom Browser (Unterstützung).
    let availability = { available: false, reason: 'Dein Browser unterstützt keine Passkeys.' };

    if (isSupported()) {
      try {
        availability = await api.auth.passkeyAvailable();
      } catch (error) {
        availability = { available: false, reason: error.message };
      }
    }

    if (!availability.available) {
      render(
        passkeyList,
        el('div.error-box', { style: { marginBottom: '12px' } }, [
          el('strong', { text: 'Passkeys sind hier nicht verfügbar' }),
          el('p', { style: { margin: '6px 0 0' }, text: availability.reason }),
        ]),

        // Was sieht der Server? Bei einem Proxy-Problem ist genau das die
        // Information, die zur Lösung führt – ohne sie rätselt man herum.
        availability.detectedHost &&
          el('p.hint', {
            style: { margin: 0 },
            text:
              `Streamo nimmt die Adresse "${availability.detectedProtocol}://${availability.detectedHost}" wahr` +
              (availability.behindProxy ? ' (über einen Reverse Proxy).' : '.'),
          }),
      );
      return;
    }

    const data = await api.auth.passkeys();

    /**
     * Legt einen neuen Passkey an: Aufgabe holen, Gerät fragen, Antwort prüfen.
     * @param {HTMLButtonElement} button
     */
    const addPasskey = async (button) => {
      // Ein sprechender Name hilft später beim Aufräumen. Vorschlag aus dem
      // Betriebssystem, damit man nicht selbst überlegen muss.
      const suggestion = navigator.userAgent.includes('Windows')
        ? 'Windows-PC'
        : /Mac/.test(navigator.userAgent)
          ? 'Mac'
          : /Android/.test(navigator.userAgent)
            ? 'Android-Handy'
            : /iPhone|iPad/.test(navigator.userAgent)
              ? 'iPhone'
              : 'Dieses Gerät';

      const name = await askText({
        title: 'Passkey anlegen',
        label: 'Wie soll dieses Gerät heißen?',
        value: suggestion,
        hint: 'Ein sprechender Name hilft später beim Aufräumen – etwa "Laptop" oder "Handy".',
        confirmLabel: 'Weiter',
      });
      if (name === null) return; // abgebrochen

      button.disabled = true;
      button.textContent = 'Warte auf dein Gerät …';

      try {
        const options = await api.auth.passkeyRegisterOptions();
        const response = await createPasskey(options);

        await api.auth.passkeyRegisterVerify(response, name);
        toast('Passkey angelegt.', 'success');
        drawPasskeys();
      } catch (error) {
        toast(error.message, 'error');
        button.disabled = false;
        button.textContent = '+ Passkey hinzufügen';
      }
    };

    render(
      passkeyList,

      // --- Die vorhandenen Passkeys ---
      data.passkeys.length === 0
        ? el('p.muted', {
            style: { margin: '14px 0' },
            text: 'Noch kein Passkey eingerichtet.',
          })
        : el(
            'div',
            { style: { margin: '14px 0' } },
            data.passkeys.map((passkey) =>
              el(
                'div',
                {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                    padding: '11px 0',
                    borderBottom: '1px solid var(--surface-3)',
                  },
                },
                [
                  el('span', { text: passkey.device_type === 'multiDevice' ? '☁️' : '🔑' }),

                  el('div', { style: { flex: '1', minWidth: '0' } }, [
                    el('div', { style: { fontWeight: '550' }, text: passkey.name }),
                    el('div.muted.small', {
                      text:
                        `Angelegt am ${formatDate(passkey.created_at?.slice(0, 10))}` +
                        (passkey.last_used_at
                          ? ` · zuletzt benutzt ${timeAgo(passkey.last_used_at)}`
                          : ' · noch nicht benutzt') +
                        // Synchronisierte Passkeys liegen zusätzlich in der
                        // iCloud- bzw. Google-Kette. Das ist bequem, aber gut
                        // zu wissen.
                        (passkey.backed_up ? ' · wird zwischen Geräten synchronisiert' : ''),
                    }),
                  ]),

                  el('button.btn.btn-sm.btn-ghost', {
                    text: 'Umbenennen',
                    onClick: async () => {
                      const name = await askText({
                        title: 'Passkey umbenennen',
                        label: 'Neuer Name',
                        value: passkey.name,
                      });
                      if (name === null) return;
                      try {
                        await api.auth.renamePasskey(passkey.id, name);
                        drawPasskeys();
                      } catch (error) {
                        toast(error.message, 'error');
                      }
                    },
                  }),

                  el('button.btn.btn-sm.btn-danger', {
                    text: 'Entfernen',
                    onClick: async () => {
                      const sure = await askConfirm({
                        title: `Passkey „${passkey.name}" entfernen?`,
                        text: 'Mit diesem Gerät kannst du dich danach nicht mehr ohne Passwort anmelden.',
                        confirmLabel: 'Entfernen',
                        danger: true,
                      });

                      if (!sure) return;
                      try {
                        await api.auth.deletePasskey(passkey.id);
                        toast('Passkey entfernt.');
                        drawPasskeys();
                      } catch (error) {
                        toast(error.message, 'error');
                      }
                    },
                  }),
                ],
              ),
            ),
          ),

      el('button.btn.btn-primary', {
        text: '+ Passkey hinzufügen',
        onClick: (event) => addPasskey(event.currentTarget),
      }),

      // --- Passwort abschalten ---
      // Nur anbieten, wenn es einen Passkey gibt UND noch ein Passwort da ist.
      // Sonst wäre es entweder unmöglich oder würde aussperren.
      data.passkeys.length > 0 &&
        data.hasPassword &&
        el('div', { style: { marginTop: '18px' } }, [
          el('p.hint', {
            text: 'Du kannst das Passwort entfernen und dich nur noch per Passkey anmelden. Achtung: Verlierst du dann alle Passkeys, kommst du nicht mehr in dein Konto.',
          }),
          el('button.btn.btn-sm.btn-ghost', {
            text: 'Passwort entfernen',
            onClick: async () => {
              const current = await askText({
                title: 'Passwort entfernen',
                subtitle:
                  'Danach kommst du nur noch per Passkey in dein Konto. Verlierst du alle Passkeys, gibt es keinen Weg zurück.',
                label: 'Zur Bestätigung dein aktuelles Passwort',
                type: 'password',
                confirmLabel: 'Passwort entfernen',
              });

              if (!current) return;

              try {
                await api.auth.removePassword(current);
                toast('Passwort entfernt. Ab jetzt nur noch Passkey.', 'success');
                drawPasskeys();
              } catch (error) {
                toast(error.message, 'error');
              }
            },
          }),
        ]),
    );
  };

  // Die Liste lädt im Hintergrund nach, damit die Einstellungsseite sofort da ist.
  drawPasskeys().catch(() =>
    render(passkeyList, el('p.muted', { text: 'Passkeys konnten nicht geladen werden.' })),
  );

  // ========================================================================
  // 1a. Aussehen
  // ========================================================================
  // Streamo war violett, weil sich irgendjemand einmal für Violett
  // entscheiden musste. Hier wählt jede Person ihre eigene Farbe – die
  // Einstellung gilt nur für ihr Konto, nicht für die ganze Instanz.
  //
  // Angewendet wird sie sofort und ohne Neuladen: Das ganze Stylesheet hängt
  // an CSS-Variablen, ein Thema ist deshalb nur das Überschreiben einiger
  // dieser Variablen am <html>-Element (siehe public/js/theme.js).
  let theme = loadTheme();

  /** Die Kästchen zur Farbauswahl, damit sich ihre Markierung setzen lässt. */
  const swatches = [];

  /**
   * Übernimmt eine Änderung: sofort anwenden, im Browser merken, am Konto
   * speichern.
   *
   * Zwei Ablagen mit Absicht – der Browser weiß es beim nächsten Start sofort
   * (ohne violettes Aufblitzen), das Konto trägt es auf andere Geräte.
   *
   * @param {object} changes z. B. { accent: '#f39c12' }
   */
  const setTheme = async (changes) => {
    theme = applyTheme({ ...theme, ...changes });
    saveTheme(theme);

    // Markierung nachziehen.
    for (const { node, value } of swatches) {
      node.classList.toggle('active', value === theme.accent);
    }
    for (const button of baseButtons) {
      button.classList.toggle('active', button.dataset.base === theme.base);
    }

    colorInput.value = theme.accent;

    try {
      await api.settings.update({ theme });
    } catch {
      // Das Speichern am Konto ist die Kür. Klappt es nicht, gilt die Farbe
      // trotzdem – sie steht ja schon im Browser. Eine Fehlermeldung wäre
      // hier lauter, als der Ausfall es verdient.
    }
  };

  // --- Die vorgegebenen Farben ---
  const swatchRow = el(
    'div.swatches',
    {},
    ACCENT_PRESETS.map(([value, name]) => {
      const node = el('button.swatch' + (value === theme.accent ? '.active' : ''), {
        type: 'button',
        title: name,
        'aria-label': name,
        style: { background: value },
        onClick: () => setTheme({ accent: value }),
      });

      swatches.push({ node, value });
      return node;
    }),
  );

  // --- Der freie Farbwähler ---
  // Für alle, denen acht Vorgaben nicht reichen. "input" statt "change",
  // damit man die Farbe schon beim Ziehen wirken sieht.
  const colorInput = el('input', {
    type: 'color',
    value: theme.accent,
    title: 'Eigene Farbe wählen',
    onInput: (event) => setTheme({ accent: event.target.value }),
  });

  // --- Der Grundton ---
  const baseButtons = BASE_PRESETS.map(([value, name]) =>
    el('button.chip' + (value === theme.base ? '.active' : ''), {
      type: 'button',
      text: name,
      'data-base': value,
      onClick: () => setTheme({ base: value }),
    }),
  );

  const appearanceCard = el('div.card', { style: { marginBottom: '20px' } }, [
    el('h2', { text: 'Aussehen' }),
    el('p.muted.small', {
      text: 'Gilt nur für dein Konto. Die Änderung ist sofort zu sehen – Speichern ist nicht nötig.',
    }),

    el('div.field', {}, [
      el('label', { text: 'Akzentfarbe' }),
      el('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' } }, [
        swatchRow,
        el('div', { style: { display: 'flex', alignItems: 'center', gap: '7px' } }, [
          colorInput,
          el('span.hint', { text: 'eigene' }),
        ]),
      ]),
    ]),

    el('div.field', {}, [
      el('label', { text: 'Grundton' }),
      el('div', { style: { display: 'flex', gap: '7px', flexWrap: 'wrap' } }, baseButtons),
      el('div.hint', {
        text: 'Schwarz passt besser zu kräftigen Akzentfarben – und auf einem OLED-Bildschirm bleiben die Pixel dort tatsächlich aus.',
      }),
    ]),

    el('button.btn.btn-sm.btn-ghost', {
      text: 'Zurücksetzen',
      onClick: () => setTheme(DEFAULT_THEME),
    }),
  ]);

  // ========================================================================
  // 1c. Zwei-Faktor-Anmeldung
  // ========================================================================
  // Ein Passwort kann gestohlen werden, ohne dass man es merkt. Der zweite
  // Faktor sorgt dafür, dass ein gestohlenes Passwort allein nicht reicht:
  // zusätzlich braucht es einen sechsstelligen Code, den eine App auf dem
  // Telefon alle 30 Sekunden neu erzeugt.
  //
  // Streamo verschickt dafür nichts und ruft nichts ab – Server und App
  // teilen sich ein Geheimnis und rechnen danach unabhängig dasselbe aus.
  // Deshalb funktioniert es auch im Flugmodus. Das Verfahren steht in
  // src/totp.js, die Endpunkte in src/routes/auth.js.
  const twoFactorBody = el('div');

  const twoFactorCard = el('div.card', { style: { marginBottom: '20px' } }, [
    el('h2', { text: 'Zwei-Faktor-Anmeldung' }),
    el('p.muted.small', {
      text: 'Zusätzlich zum Passwort ein Code aus einer App auf deinem Telefon. Selbst wer dein Passwort kennt, kommt damit nicht in dein Konto.',
    }),
    twoFactorBody,
  ]);

  /**
   * Zeichnet den Bereich neu – je nachdem, ob der zweite Faktor an oder aus
   * ist. Wird nach jeder Änderung erneut aufgerufen.
   */
  const drawTwoFactor = async () => {
    const state = await api.auth.twoFactor.state();

    // ----------------------------------------------------------------------
    // Eingeschaltet
    // ----------------------------------------------------------------------
    if (state.enabled) {
      render(
        twoFactorBody,

        el('p', {}, [
          el('strong', { text: '✓ Eingeschaltet' }),
          state.enabledAt ? el('span.muted.small', { text: ` seit ${formatDate(state.enabledAt)}` }) : null,
        ]),

        // Der Zähler ist wichtiger, als er aussieht: Wer alle Ersatzcodes
        // verbraucht hat und das Telefon verliert, kommt nicht mehr hinein.
        el('p.muted.small', {
          text: `Noch ${state.backupCodesLeft} von 10 Ersatzcodes übrig.`,
        }),

        state.backupCodesLeft <= 2 &&
          el('p.hint', {
            style: { color: 'var(--warning, #f6b93b)' },
            text: 'Die Ersatzcodes gehen zur Neige. Erzeuge einen neuen Satz, solange du noch Zugriff hast.',
          }),

        el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '12px' } }, [
          el('button.btn.btn-sm.btn-ghost', {
            text: 'Neue Ersatzcodes',
            onClick: async () => {
              const password = await askText({
                title: 'Neue Ersatzcodes',
                subtitle: 'Die bisherigen Ersatzcodes verlieren damit ihre Gültigkeit.',
                label: 'Zur Sicherheit dein Passwort',
                type: 'password',
                confirmLabel: 'Neue Codes erzeugen',
              });

              if (password === null) return;

              try {
                const result = await api.auth.twoFactor.newBackupCodes(password);
                showBackupCodes(result.backupCodes);
                drawTwoFactor();
              } catch (error) {
                toast(error.message, 'error');
              }
            },
          }),

          el('button.btn.btn-sm.btn-danger', {
            text: 'Ausschalten',
            onClick: async () => {
              const password = await askText({
                title: 'Zwei-Faktor-Anmeldung ausschalten',
                subtitle: 'Danach reicht wieder das Passwort allein, um in dein Konto zu kommen.',
                label: 'Zur Bestätigung dein Passwort',
                type: 'password',
                confirmLabel: 'Ausschalten',
              });

              if (password === null) return;

              try {
                await api.auth.twoFactor.disable(password);
                toast('Zwei-Faktor-Anmeldung ausgeschaltet.');
                drawTwoFactor();
              } catch (error) {
                toast(error.message, 'error');
              }
            },
          }),
        ]),
      );
      return;
    }

    // ----------------------------------------------------------------------
    // Ausgeschaltet – der Weg zum Einrichten
    // ----------------------------------------------------------------------
    render(
      twoFactorBody,
      el('p.muted.small', { text: 'Zurzeit ausgeschaltet.' }),
      el('button.btn.btn-primary.btn-sm', {
        text: 'Einrichten',
        onClick: (event) => startSetup(event.currentTarget),
      }),
    );
  };

  /**
   * Führt durch die Einrichtung.
   *
   * Zwei Schritte mit Absicht: Erst wird das Geheimnis herausgegeben, dann
   * muss ein gültiger Code beweisen, dass die App es wirklich bekommen hat.
   * Ohne diesen Beweis könnte man sich beim Übertragen vertun und wäre
   * anschließend aus dem eigenen Konto ausgesperrt.
   *
   * @param {HTMLButtonElement} button
   */
  const startSetup = async (button) => {
    button.disabled = true;
    button.textContent = 'Wird vorbereitet …';

    let setup;
    try {
      setup = await api.auth.twoFactor.setup();
    } catch (error) {
      toast(error.message, 'error');
      button.disabled = false;
      button.textContent = 'Einrichten';
      return;
    }

    const codeInput = el('input', {
      inputmode: 'numeric',
      autocomplete: 'one-time-code',
      placeholder: '123456',
      style: { fontSize: '19px', letterSpacing: '3px', textAlign: 'center' },
    });

    render(
      twoFactorBody,

      el('ol.setup-steps', {}, [
        el('li', {}, [
          'Installiere eine Authenticator-App, falls noch keine da ist – etwa ',
          el('strong', { text: 'Aegis' }),
          ', ',
          el('strong', { text: '2FAS' }),
          ' oder ',
          el('strong', { text: 'Google Authenticator' }),
          '.',
        ]),

        el('li', {}, [
          // Auf dem Telefon öffnet dieser Verweis die App direkt. Am Rechner
          // passiert nichts – dort ist das Abtippen darunter der Weg.
          'Auf dem Telefon: ',
          el('a', {
            href: setup.otpauthUrl,
            text: 'In der App öffnen',
            style: { fontWeight: '600' },
          }),
          el('br'),
          'Am Rechner: dieses Geheimnis in der App eintragen.',

          el('div.secret-box', {}, [
            el('code', { text: setup.formatted }),
            el('button.btn.btn-sm.btn-ghost', {
              text: 'Kopieren',
              onClick: async () => {
                const ok = await copyToClipboard(setup.secret);
                toast(ok ? 'Geheimnis kopiert.' : 'Kopieren nicht möglich.', ok ? 'success' : 'error');
              },
            }),
          ]),
        ]),

        el('li', {}, [
          'Gib den Code ein, den die App jetzt anzeigt:',
          el('div.field', { style: { maxWidth: '220px', marginTop: '8px' } }, [codeInput]),
        ]),
      ]),

      el('div', { style: { display: 'flex', gap: '8px' } }, [
        el('button.btn.btn-primary', {
          text: 'Einschalten',
          onClick: async (event) => {
            event.currentTarget.disabled = true;

            try {
              const result = await api.auth.twoFactor.enable(codeInput.value);

              // Die Ersatzcodes gibt es genau einmal zu sehen. Deshalb ein
              // eigener Kasten, den man nicht übersieht – und kein Toast,
              // der nach drei Sekunden weg wäre.
              showBackupCodes(result.backupCodes);
              toast('Zwei-Faktor-Anmeldung eingeschaltet.', 'success');
              drawTwoFactor();
            } catch (error) {
              toast(error.message, 'error');
              event.currentTarget.disabled = false;
              codeInput.value = '';
              codeInput.focus();
            }
          },
        }),

        el('button.btn.btn-ghost', {
          text: 'Abbrechen',
          onClick: () => drawTwoFactor(),
        }),
      ]),
    );

    codeInput.focus();
  };

  /**
   * Zeigt die Ersatzcodes an.
   *
   * Sie erscheinen genau einmal: Danach liegen nur noch ihre Prüfsummen in
   * der Datenbank, niemand kann sie erneut anzeigen. Deshalb ein Dialog, der
   * stehen bleibt, bis man ihn schließt – und ein Knopf zum Kopieren.
   *
   * @param {string[]} codes
   */
  const showBackupCodes = (codes) => {
    const text = codes.join('\n');

    const overlay = el(
      'div.modal-overlay',
      {
        onClick: (event) => {
          if (event.target === overlay) overlay.remove();
        },
      },
      [
        el('div.modal-box', {}, [
          el('h3', { text: 'Deine Ersatzcodes', style: { margin: '0 0 4px' } }),
          el('p.muted', {
            style: { margin: '0 0 14px', fontSize: '13px' },
            text: 'Bewahre sie an einem sicheren Ort auf – ausgedruckt oder im Passwortmanager. Jeder gilt einmal. Ohne sie kommst du nicht mehr in dein Konto, wenn das Telefon weg ist. Du siehst sie nur dieses eine Mal.',
          }),

          el('div.backup-codes', {}, codes.map((code) => el('code', { text: code }))),

          el('button.btn.btn-primary', {
            text: 'Codes kopieren',
            style: { width: '100%', marginTop: '16px' },
            onClick: async (event) => {
              const ok = await copyToClipboard(text);
              event.currentTarget.textContent = ok ? '✓ Kopiert' : 'Kopieren nicht möglich';
            },
          }),

          el('button.btn.btn-ghost', {
            text: 'Ich habe sie gesichert',
            style: { width: '100%', marginTop: '8px' },
            onClick: () => overlay.remove(),
          }),
        ]),
      ],
    );

    document.body.append(overlay);
  };

  // Im Hintergrund laden, damit die Einstellungsseite sofort steht.
  drawTwoFactor().catch(() =>
    render(twoFactorBody, el('p.muted', { text: 'Zustand konnte nicht geladen werden.' })),
  );

  // ========================================================================
  // 1d. Benutzer (nur Administratoren)
  // ========================================================================
  // Bis hierher gab es keine Übersicht darüber, wer auf dieser Instanz
  // überhaupt ein Konto hat. Wer eine Einladung verschickt, will aber sehen,
  // ob sie angekommen ist – und Adminrechte ließen sich nur über die Konsole
  // vergeben (streamo admin <name>).
  const userList = el('div');

  const usersCard =
    data.user.isAdmin &&
    el('div.card', { style: { marginBottom: '20px' } }, [
      el('h2', { text: 'Benutzer' }),
      el('p.muted.small', {
        text: 'Wer hat hier ein Konto, wann war er zuletzt da – und wer darf verwalten.',
      }),
      userList,
    ]);

  /**
   * Löscht ein Konto – nach ausdrücklicher Bestätigung.
   *
   * Der Benutzername muss abgetippt werden. Das ist keine Sicherheitsmaßnahme
   * (wer hier steht, hat ohnehin Adminrechte), sondern eine gegen Versehen:
   * Ein Klick daneben löscht sonst die Bibliothek einer anderen Person, und
   * rückgängig machen lässt sich das nicht.
   *
   * @param {object} user Eintrag aus /api/settings/users
   */
  const deleteUser = async (user) => {
    // Zuerst sagen, was verloren geht – nicht erst hinterher.
    const verluste = [
      user.libraryCount > 0
        ? `${user.libraryCount} ${user.libraryCount === 1 ? 'Titel' : 'Titel'} in der Bibliothek`
        : null,
      'der gesamte Sehfortschritt',
      'verknüpfte Abos, Bewertungen und Erfolge',
      'eigene Filmreihen und Freundschaften',
    ].filter(Boolean);

    const typed = await askText({
      title: `Konto „${user.username}" löschen?`,
      subtitle: `Das lässt sich nicht rückgängig machen. Gelöscht werden: ${verluste.join(', ')}.`,
      label: `Tipp zur Bestätigung „${user.username}" ein`,
      placeholder: user.username,
      confirmLabel: 'Endgültig löschen',
    });

    // Abgebrochen.
    if (typed === null) return;

    try {
      const result = await api.settings.deleteUser(user.id, typed.trim());

      toast(
        `Konto ${result.username} gelöscht` +
          (result.removed.library > 0 ? ` – mit ${result.removed.library} Titeln.` : '.'),
        'success',
      );

      drawUsers();
    } catch (error) {
      toast(error.message, 'error');
    }
  };

  /**
   * Zeichnet die Benutzerliste neu.
   * Nach jeder Änderung erneut aufgerufen, damit die Anzeige stimmt.
   */
  const drawUsers = async () => {
    let result;

    try {
      result = await api.settings.users();
    } catch (error) {
      render(userList, errorBox(error.message));
      return;
    }

    render(
      userList,
      el(
        'div.user-list',
        {},
        result.users.map((user) => {
          const name = user.displayName && user.displayName !== user.username
            ? `${user.displayName} (${user.username})`
            : user.username;

          return el('div.user-row', {}, [
            // --- Wer ---
            el('div', { style: { minWidth: 0 } }, [
              el('div', { style: { display: 'flex', alignItems: 'center', gap: '7px', flexWrap: 'wrap' } }, [
                el('strong', { text: name }),
                user.isAdmin && el('span.badge.badge-accent', { text: 'Admin' }),
                user.isSelf && el('span.badge', { text: 'du' }),
                // Ein eingeschalteter zweiter Faktor ist eine gute Nachricht
                // und darf sichtbar sein – das Geheimnis natürlich nicht.
                user.twoFactor && el('span.badge', { title: 'Zwei-Faktor-Anmeldung aktiv', text: '🔐' }),
                user.activeSessions > 0 &&
                  el('span.badge.badge-online', {
                    title: `${user.activeSessions} aktive Anmeldung${user.activeSessions === 1 ? '' : 'en'}`,
                    text: '● angemeldet',
                  }),
              ]),

              el('div.muted.small', {
                text: [
                  user.lastLoginAt
                    ? `zuletzt da ${timeAgo(user.lastLoginAt)}`
                    : 'war noch nie angemeldet',
                  `dabei seit ${formatDate(user.createdAt.slice(0, 10))}`,
                  `${user.libraryCount} ${user.libraryCount === 1 ? 'Titel' : 'Titel'} in der Bibliothek`,
                ].join(' · '),
              }),
            ]),

            // --- Adminrechte ---
            // Das eigene Konto lässt sich nicht umschalten: Der Schalter wäre
            // sofort weg und man käme nur noch über die Konsole zurück. Der
            // Server lehnt das ebenfalls ab, das hier ist nur die freundliche
            // Variante davon.
            el('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', flex: '0 0 auto' } }, [
              el('label.toggle-row', {}, [
                el('input', {
                  type: 'checkbox',
                  checked: user.isAdmin,
                  disabled: user.isSelf,
                  title: user.isSelf
                    ? 'Die eigenen Rechte kann man sich nicht selbst nehmen.'
                    : 'Adminrechte vergeben oder entziehen',
                  onChange: async (event) => {
                    const makeAdmin = event.currentTarget.checked;

                    try {
                      await api.settings.setUserAdmin(user.id, makeAdmin);
                      toast(
                        makeAdmin
                          ? `${user.username} ist jetzt Administrator.`
                          : `${user.username} ist jetzt ein gewöhnlicher Benutzer.`,
                        'success',
                      );
                      drawUsers();
                    } catch (error) {
                      // Zurückspringen, sonst zeigt der Schalter etwas an, das
                      // nicht gespeichert wurde.
                      event.currentTarget.checked = !makeAdmin;
                      toast(error.message, 'error');
                    }
                  },
                }),
                el('span.small', { text: 'Admin' }),
              ]),

              // Konto löschen. Das eigene bleibt außen vor – dabei würde man
              // sich mitten im Vorgang die eigene Sitzung entziehen.
              !user.isSelf &&
                el('button.btn.btn-sm.btn-danger', {
                  text: 'Löschen',
                  title: `Konto ${user.username} endgültig löschen`,
                  onClick: () => deleteUser(user),
                }),
            ]),
          ]);
        }),
      ),
    );
  };

  if (data.user.isAdmin) {
    drawUsers().catch(() =>
      render(userList, el('p.muted', { text: 'Benutzer konnten nicht geladen werden.' })),
    );
  }

  // ========================================================================
  // 2. Passwort
  // ========================================================================
  const currentPw = el('input', { type: 'password', autocomplete: 'current-password' });
  const newPw = el('input', { type: 'password', autocomplete: 'new-password', minlength: 8 });

  const passwordCard = el('div.card', { style: { marginBottom: '20px' } }, [
    el('h2', { text: 'Passwort ändern' }),
    el('div.field', {}, [el('label', { text: 'Aktuelles Passwort' }), currentPw]),
    el('div.field', {}, [
      el('label', { text: 'Neues Passwort' }),
      newPw,
      el('div.hint', { text: 'Mindestens 8 Zeichen. Alle anderen Geräte werden abgemeldet.' }),
    ]),
    el('button.btn', {
      text: 'Passwort ändern',
      onClick: async (event) => {
        event.target.disabled = true;
        try {
          await api.auth.changePassword(currentPw.value, newPw.value);
          currentPw.value = '';
          newPw.value = '';
          toast('Passwort geändert.', 'success');
        } catch (error) {
          toast(error.message, 'error');
        } finally {
          event.target.disabled = false;
        }
      },
    }),
  ]);

  // ========================================================================
  // 2b. Einladungen (nur Administratoren)
  // ========================================================================
  // Der einfache Weg, Freunde mitmachen zu lassen: Sie bekommen ein Konto
  // auf DIESER Instanz statt einer eigenen Installation. Damit brauchen sie
  // keinen eigenen TMDB-Zugang – der gilt für die ganze Instanz und ist
  // längst hinterlegt – und müssen nichts einrichten.
  const inviteList = el('div');

  const inviteCard =
    data.user.isAdmin &&
    el('div.card', { style: { marginBottom: '20px' } }, [
      el('h2', { text: 'Freunde einladen' }),
      el('p.muted.small', {
        text: 'Erzeuge einen Link und schick ihn weiter. Wer ihn öffnet, legt sich ein Konto an – ohne eigenen Zugang zu einer Filmdatenbank, ohne Installation. Dein TMDB-Zugang gilt für alle Konten dieser Instanz.',
      }),
      inviteList,

      // ----------------------------------------------------------------
      // Der Schalter für die offene Registrierung
      // ----------------------------------------------------------------
      // Er steht hier und nicht in einem eigenen Kasten, weil er dieselbe
      // Frage beantwortet: Wie kommen andere Leute an ein Konto? Entweder
      // über eine Einladung (oben) – oder eben ohne.
      el('hr', {
        style: { border: 'none', borderTop: '1px solid var(--surface-3)', margin: '20px 0 16px' },
      }),

      el('label.toggle-row', {}, [
        el('input', {
          type: 'checkbox',
          checked: data.global.allowRegistration,
          onChange: async (event) => {
            const open = event.currentTarget.checked;

            try {
              await api.settings.updateGlobal({ allowRegistration: open });

              // Der Anmeldebildschirm entscheidet anhand dieses Werts, ob er
              // ein Feld für den Einladungscode zeigt – also neu einlesen.
              await refreshStatus();

              toast(
                open
                  ? 'Registrierung offen. Jeder, der die Adresse kennt, kann sich ein Konto anlegen.'
                  : 'Registrierung geschlossen. Ab jetzt nur noch mit Einladung.',
                open ? 'info' : 'success',
              );
            } catch (error) {
              // Zurückspringen, sonst zeigt der Schalter etwas an, das nicht
              // gespeichert wurde.
              event.currentTarget.checked = !open;
              toast(error.message, 'error');
            }
          },
        }),
        el('span', {}, [
          el('strong', { text: 'Registrierung ohne Einladung erlauben' }),
          el('div.hint', {
            style: { marginTop: '2px' },
            text: 'Standardmäßig aus. Der Grund: Sobald Streamo aus dem Internet erreichbar ist, könnte sonst jeder, der die Adresse findet, ein Konto anlegen – und deinen TMDB-Zugang mitbenutzen. Mit Einladung entscheidest du, wer hereinkommt.',
          }),
          data.global.allowRegistrationSource === 'env' &&
            el('div.hint', {
              style: { marginTop: '4px' },
              text: 'Zurzeit gilt die Vorgabe aus der .env (ALLOW_REGISTRATION). Sobald du hier umlegst, gilt deine Einstellung – ohne dass du an den Server musst.',
            }),
        ]),
      ]),
    ]);

  /**
   * Zeichnet die Einladungsliste neu.
   */
  const drawInvites = async () => {
    let data;

    try {
      data = await api.invites.list();
    } catch (error) {
      render(inviteList, errorBox(error.message));
      return;
    }

    /**
     * Erzeugt eine Einladung und bietet an, sie zu verschicken.
     * @param {object} options
     */
    const create = async (options) => {
      try {
        const invite = await api.invites.create(options);

        // Direkt zum Verschicken anbieten – der Link ist ja der Zweck.
        //
        // Derselbe Dialog wie beim Teilen einer Filmreihe: Er nimmt die
        // Teilen-Auswahl des Systems, wenn es sie gibt, und bietet sonst
        // WhatsApp, Telegram, E-Mail und einen Kopier-Knopf an. Vorher stand
        // hier ein nacktes prompt(), sobald die Zwischenablage nicht zur
        // Verfügung stand – und die gibt es nur unter HTTPS.
        await shareSheet({
          url: invite.url,
          title: 'Einladung zu Streamo',
          text: 'Ich lade dich zu meinem Streamo ein. Damit siehst du, wo du unsere Serien streamen kannst.',
        });

        drawInvites();
      } catch (error) {
        toast(error.message, 'error');
      }
    };

    render(
      inviteList,

      el('div', { style: { display: 'flex', gap: '9px', flexWrap: 'wrap', margin: '14px 0' } }, [
        el('button.btn.btn-primary', {
          text: '+ Einladung erzeugen',
          title: 'Einmal nutzbar, sieben Tage gültig',
          onClick: () => create({}),
        }),
        el('button.btn.btn-ghost', {
          text: 'Dauerhafter Link',
          title: 'Unbegrenzt nutzbar und ohne Ablaufdatum – für die ganze Familie',
          onClick: async () => {
            const sure = await askConfirm({
              title: 'Dauerhaften Link erzeugen?',
              text: 'Er kann von beliebig vielen Personen benutzt werden und läuft nie ab. Gib ihn nur weiter, wem du vertraust.',
              confirmLabel: 'Link erzeugen',
            });

            if (sure) create({ uses: null, days: null });
          },
        }),
      ]),

      data.invites.length === 0
        ? el('p.muted.small', { style: { margin: 0 }, text: 'Noch keine Einladungen erzeugt.' })
        : el(
            'div',
            {},
            data.invites.map((invite) =>
              el(
                'div',
                {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: '11px',
                    padding: '10px 0',
                    borderTop: '1px solid var(--surface-3)',
                  },
                },
                [
                  el('span', { text: invite.usable ? '🎟️' : '⌛' }),

                  el('div', { style: { flex: '1', minWidth: '0' } }, [
                    el('div', {
                      style: {
                        fontFamily: 'ui-monospace, monospace',
                        fontSize: '12.5px',
                        wordBreak: 'break-all',
                      },
                      text: invite.url,
                    }),
                    el('div.muted.small', {
                      text: [
                        invite.usesLeft === null
                          ? 'unbegrenzt nutzbar'
                          : `noch ${invite.usesLeft}× nutzbar`,
                        invite.expiresAt
                          ? `gültig bis ${formatDate(invite.expiresAt.slice(0, 10))}`
                          : 'ohne Ablauf',
                        invite.usedCount > 0 ? `${invite.usedCount}× eingelöst` : null,
                        invite.expired ? 'ABGELAUFEN' : null,
                      ]
                        .filter(Boolean)
                        .join(' · '),
                    }),
                  ]),

                  invite.usable &&
                    el('button.btn.btn-sm.btn-ghost', {
                      text: 'Teilen',
                      // Statt nur zu kopieren: derselbe Dialog wie überall
                      // sonst, mit WhatsApp, Telegram, E-Mail und Kopieren.
                      onClick: () =>
                        shareSheet({
                          url: invite.url,
                          title: 'Einladung zu Streamo',
                          text: 'Ich lade dich zu meinem Streamo ein. Damit siehst du, wo du unsere Serien streamen kannst.',
                        }),
                    }),

                  el('button.btn.btn-sm.btn-danger', {
                    text: '×',
                    title: 'Einladung widerrufen',
                    onClick: async () => {
                      try {
                        await api.invites.revoke(invite.token);
                        drawInvites();
                      } catch (error) {
                        toast(error.message, 'error');
                      }
                    },
                  }),
                ],
              ),
            ),
          ),
    );
  };

  if (data.user.isAdmin) {
    drawInvites().catch(() => {});
  }

  // ========================================================================
  // 3. TMDB-Key (nur Administratoren)
  // ========================================================================
  const apiKeyInput = el('input', {
    type: 'password',
    placeholder: data.global.hasApiKey ? data.global.apiKey : 'Noch kein Schlüssel hinterlegt',
    autocomplete: 'off',
  });

  const tmdbCard =
    data.user.isAdmin &&
    el('div.card', { style: { marginBottom: '20px' } }, [
      el('h2', { text: 'TMDB-Zugang' }),
      el('p.muted.small', {
        text: 'Streamo holt Metadaten und Streaming-Verfügbarkeit von TMDB. Der Schlüssel ist kostenlos: themoviedb.org → Einstellungen → API. Es funktionieren sowohl der „API Read Access Token" als auch der klassische „API Key".',
      }),

      el('div.field', {}, [el('label', { text: 'API-Key' }), apiKeyInput]),

      el('div', { style: { display: 'flex', gap: '9px' } }, [
        el('button.btn.btn-ghost', {
          text: 'Schlüssel testen',
          onClick: async (event) => {
            if (!apiKeyInput.value.trim()) return toast('Bitte erst einen Schlüssel eingeben.', 'error');
            event.target.disabled = true;
            try {
              await api.settings.testKey(apiKeyInput.value.trim());
              toast('Der Schlüssel funktioniert.', 'success');
            } catch (error) {
              toast(error.message, 'error');
            } finally {
              event.target.disabled = false;
            }
          },
        }),
        el('button.btn.btn-primary', {
          text: 'Schlüssel speichern',
          onClick: async (event) => {
            event.target.disabled = true;
            try {
              await api.settings.updateGlobal({ apiKey: apiKeyInput.value.trim() });
              apiKeyInput.value = '';
              await refreshStatus();
              toast('Schlüssel gespeichert.', 'success');
            } catch (error) {
              toast(error.message, 'error');
            } finally {
              event.target.disabled = false;
            }
          },
        }),
      ]),
    ]);

  // ========================================================================
  // 4. Abgleich
  // ========================================================================
  const syncStatusLine = el('p.muted.small', {
    text: `Letzter Abgleich: ${timeAgo(data.sync.lastRunAt)}${data.sync.lastResult ? ` – ${data.sync.lastResult}` : ''}`,
  });

  /**
   * Fragt den Fortschritt in Abständen ab, solange ein Lauf aktiv ist.
   * Ein einfacher Zeitgeber genügt – für Live-Aktualisierung über WebSockets
   * gibt es hier keinen Anlass.
   */
  const pollSync = () => {
    const timer = setInterval(async () => {
      try {
        const status = await api.settings.syncStatus();

        if (status.state.running) {
          syncStatusLine.textContent = `Abgleich läuft … ${status.state.done} von ${status.state.total}`;
        } else {
          clearInterval(timer);
          syncStatusLine.textContent = `Letzter Abgleich: ${timeAgo(status.state.lastRunAt)} – ${status.state.lastResult ?? 'fertig'}`;
          toast('Abgleich abgeschlossen.', 'success');
        }
      } catch {
        clearInterval(timer);
      }
    }, 2000);
  };

  const syncCard =
    data.user.isAdmin &&
    el('div.card', { style: { marginBottom: '20px' } }, [
      el('h2', { text: 'Abgleich' }),
      el('p.muted.small', {
        text: `Streamo prüft alle ${data.global.syncIntervalHours} Stunden automatisch, wo deine Serien gerade laufen. Du kannst den Abgleich auch sofort starten.`,
      }),
      syncStatusLine,

      el('div', { style: { display: 'flex', gap: '9px', flexWrap: 'wrap' } }, [
        el('button.btn', {
          text: 'Verfügbarkeit abgleichen',
          title: 'Prüft für alle Titel deiner Bibliothek, wo sie gerade laufen',
          onClick: async () => {
            await api.settings.startSync('availability');
            syncStatusLine.textContent = 'Abgleich gestartet …';
            pollSync();
          },
        }),
        el('button.btn.btn-ghost', {
          text: 'Alles abgleichen',
          title: 'Zusätzlich Metadaten und Anbieter-Katalog',
          onClick: async () => {
            await api.settings.startSync('full');
            syncStatusLine.textContent = 'Vollständiger Abgleich gestartet …';
            pollSync();
          },
        }),
      ]),
    ]);

  // Läuft beim Öffnen der Seite bereits ein Abgleich? Dann direkt beobachten.
  if (data.sync.running) pollSync();

  // ========================================================================
  // 5. Daten sichern und einlesen
  // ========================================================================
  const importInput = el('input', { type: 'file', accept: 'application/json' });
  const importMessage = el('div');

  const dataCard = el('div.card', {}, [
    el('h2', { text: 'Daten' }),
    el('p.muted.small', {
      text: 'Der Export enthält deine Bibliothek, deine Abos und deinen Sehfortschritt als JSON – ideal als Backup oder für den Umzug auf eine andere Installation.',
    }),

    el('div', { style: { display: 'flex', gap: '9px', marginBottom: '18px' } }, [
      el('a.btn.btn-ghost', { href: api.library.exportUrl, text: '↓ Bibliothek exportieren' }),
    ]),

    el('div.field', {}, [
      el('label', { text: 'Export einlesen' }),
      importInput,
      el('div.hint', {
        text: 'Vorhandene Einträge werden aktualisiert, nichts wird gelöscht. Die Metadaten holt der nächste Abgleich nach.',
      }),
    ]),

    importMessage,

    el('button.btn', {
      text: 'Importieren',
      onClick: async (event) => {
        const file = importInput.files?.[0];
        if (!file) return toast('Bitte erst eine Datei auswählen.', 'error');

        event.target.disabled = true;
        render(importMessage);

        try {
          // FileReader ist hier nicht nötig – File.text() liefert direkt ein
          // Promise auf den Inhalt.
          const payload = JSON.parse(await file.text());
          const result = await api.library.import(payload);

          toast(
            `${result.imported} Einträge und ${result.providersImported} Anbieter importiert.`,
            'success',
          );
        } catch (error) {
          render(
            importMessage,
            errorBox(
              error instanceof SyntaxError
                ? 'Die Datei ist kein gültiges JSON.'
                : error.message,
            ),
          );
        } finally {
          event.target.disabled = false;
        }
      },
    }),
  ]);

  render(
    container,
    el('h1', { text: 'Einstellungen' }),
    accountCard,
    appearanceCard,
    inviteCard,
    usersCard,
    passkeyCard,
    // Direkt hinter den Passkeys: Beide beantworten dieselbe Frage – wie
    // komme ich sicher in mein Konto.
    twoFactorCard,
    tmdbCard,
    syncCard,
    passwordCard,
    dataCard,
    el('p.muted.small', {
      style: { marginTop: '22px', textAlign: 'center' },
      text: `Streamo ${data.version}`,
    }),
  );
}

export { render_ as render };
