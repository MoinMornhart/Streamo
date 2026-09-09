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
import { el, render, toast, timeAgo, errorBox } from '../ui.js';
import { refreshStatus } from '../app.js';

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

  const accountCard = el('div.card', { style: { marginBottom: '20px' } }, [
    el('h2', { text: 'Konto' }),
    el('p.muted.small', { text: `Angemeldet als ${data.user.username}` }),

    el('div.field', {}, [el('label', { for: 'displayName', text: 'Anzeigename' }), displayNameInput]),

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
