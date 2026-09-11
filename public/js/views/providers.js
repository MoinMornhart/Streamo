/**
 * ---------------------------------------------------------------------------
 * public/js/views/providers.js – Streaming-Anbieter verknüpfen
 * ---------------------------------------------------------------------------
 * Adresse: /providers
 *
 * Das ist die Seite, auf der die eigentliche "Verknüpfung" passiert: Man
 * klickt die Dienste an, die man abonniert hat, und Streamo weiß von da an,
 * welche Serien man ohne Zusatzkosten sehen kann.
 *
 * Wichtige Klarstellung zur Funktionsweise:
 *   Streamo meldet sich NICHT bei Netflix, Disney+ und Co. an. Es gibt keine
 *   offiziellen Programmierschnittstellen dafür, und Zugangsdaten fremder
 *   Dienste gehören nicht in eine selbst gehostete Anwendung. Stattdessen
 *   hinterlegt man hier, welche Abos man besitzt – und Streamo gleicht das
 *   mit den Verfügbarkeitsdaten von JustWatch (über TMDB) ab. Das Ergebnis ist
 *   dasselbe: Man sieht immer, wo ein Titel läuft und ob er im eigenen Abo
 *   enthalten ist.
 *
 * Verknüpfungen:
 *   - api.providers.catalog() -> src/routes/providers.js -> Tabelle providers
 *   - api.providers.setAll()  -> Tabelle user_providers
 * ---------------------------------------------------------------------------
 */

import { api, img } from '../api.js';
import { el, render, toast, empty, loading } from '../ui.js';
// Übersetzt Texte, die am Baustein el() vorbei direkt ins DOM geschrieben werden.
import { tr } from '../i18n.js';

/**
 * Zeichnet die Anbieter-Auswahl.
 * @param {HTMLElement} container
 */
export async function render_(container) {
  const data = await api.providers.catalog();

  /**
   * Die aktuell ausgewählten Anbieter-IDs. Wird beim Klicken verändert und
   * erst beim Speichern an den Server geschickt – so kann man in Ruhe
   * mehrere Kacheln anklicken.
   * @type {Set<number>}
   */
  const selected = new Set(data.providers.filter((p) => p.subscribed).map((p) => p.id));

  /** Merker für die Anzeige "x Anbieter verknüpft" und den Speichern-Knopf. */
  const counter = el('span.muted');
  const saveButton = el('button.btn.btn-primary', { text: 'Auswahl speichern', disabled: true });

  /** Aktualisiert Zähler und Speichern-Knopf nach jeder Änderung. */
  const updateHeader = () => {
    counter.textContent = tr(`${selected.size} von ${data.providers.length} Anbietern verknüpft`);
    saveButton.disabled = false;
  };
  counter.textContent = tr(`${selected.size} von ${data.providers.length} Anbietern verknüpft`);

  if (data.providers.length === 0) {
    render(
      container,
      empty(
        '📡',
        'Keine Anbieter gefunden',
        `Für die Region ${data.region} liefert TMDB keine Anbieterliste. Prüfe deinen API-Key und deine Region in den Einstellungen.`,
        el('a.btn.btn-primary', { href: '/settings', 'data-link': '', text: 'Zu den Einstellungen' }),
      ),
    );
    return;
  }

  // ------------------------------------------------------------------------
  // Suchfeld, um in einem Katalog mit über 100 Anbietern etwas zu finden.
  // ------------------------------------------------------------------------
  const gridSlot = el('div.provider-grid');

  /**
   * Zeichnet das Kachelraster, optional gefiltert.
   * @param {string} [filter] Suchbegriff
   */
  const drawGrid = (filter = '') => {
    const needle = filter.trim().toLowerCase();

    const visible = data.providers.filter(
      (p) => !needle || p.name.toLowerCase().includes(needle),
    );

    if (visible.length === 0) {
      render(gridSlot, el('p.muted', { text: `Kein Anbieter passt zu „${filter}".` }));
      return;
    }

    render(
      gridSlot,
      ...visible.map((provider) => {
        const tile = el(
          `div.provider-tile${selected.has(provider.id) ? '.selected' : ''}`,
          {
            title: provider.name,
            onClick: () => {
              // Umschalten und Kachel sofort visuell anpassen.
              if (selected.has(provider.id)) selected.delete(provider.id);
              else selected.add(provider.id);

              tile.classList.toggle('selected', selected.has(provider.id));
              updateHeader();
            },
          },
          [
            img(provider.logo_path, 'w154')
              ? el('img', {
                  src: img(provider.logo_path, 'w154'),
                  alt: provider.name,
                  loading: 'lazy',
                })
              : el('div', {
                  style: {
                    width: '54px',
                    height: '54px',
                    borderRadius: '13px',
                    background: 'var(--surface-2)',
                  },
                }),
            el('span', { text: provider.name }),
          ],
        );

        return tile;
      }),
    );
  };

  // ------------------------------------------------------------------------
  // Speichern
  // ------------------------------------------------------------------------
  saveButton.addEventListener('click', async () => {
    saveButton.disabled = true;
    saveButton.textContent = tr('Speichert …');

    try {
      await api.providers.setAll([...selected]);
      toast(`${selected.size} Anbieter verknüpft.`, 'success');
      saveButton.textContent = tr('Gespeichert ✓');

      // Nach kurzer Zeit zurück auf den normalen Text – der Knopf soll nicht
      // dauerhaft "Gespeichert" behaupten, wenn danach weitergeklickt wird.
      setTimeout(() => {
        saveButton.textContent = tr('Auswahl speichern');
      }, 2000);
    } catch (error) {
      toast(error.message, 'error');
      saveButton.disabled = false;
      saveButton.textContent = tr('Auswahl speichern');
    }
  });

  render(
    container,

    el('div.view-header', {}, [
      el('div', {}, [
        el('h1', { text: 'Streaming-Anbieter', style: { marginBottom: '2px' } }),
        counter,
      ]),
      el('div', { style: { display: 'flex', gap: '9px' } }, [
        // Katalog neu von TMDB holen – nötig, wenn ein neuer Dienst startet.
        el('button.btn.btn-ghost', {
          text: '↻ Katalog aktualisieren',
          onClick: async (event) => {
            event.target.disabled = true;
            event.target.textContent = tr('Lädt …');
            try {
              await api.providers.catalog(true);
              toast('Katalog aktualisiert.', 'success');
              window.location.reload();
            } catch (error) {
              toast(error.message, 'error');
              event.target.disabled = false;
              event.target.textContent = tr('↻ Katalog aktualisieren');
            }
          },
        }),
        saveButton,
      ]),
    ]),

    el('div.card', { style: { marginBottom: '20px' } }, [
      el('p', {
        style: { margin: 0 },
        text: `Klick die Dienste an, die du abonniert hast. Streamo markiert danach überall, welche Serien darin ohne Zusatzkosten enthalten sind – Region: ${data.region}.`,
      }),
      el('p.hint', {
        style: { marginBottom: 0 },
        text: 'Hinweis: Streamo meldet sich nicht bei den Diensten an und braucht keine Zugangsdaten. Es merkt sich nur, welche Abos du hast, und gleicht das mit den Verfügbarkeitsdaten von JustWatch ab.',
      }),
    ]),

    el('input', {
      type: 'search',
      placeholder: 'Anbieter suchen …',
      style: { marginBottom: '18px', maxWidth: '340px' },
      onInput: (event) => drawGrid(event.target.value),
    }),

    gridSlot,
  );

  drawGrid();
}

export { render_ as render };
