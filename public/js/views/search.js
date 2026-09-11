/**
 * ---------------------------------------------------------------------------
 * public/js/views/search.js – Suchergebnisse
 * ---------------------------------------------------------------------------
 * Adresse: /search?q=breaking+bad
 *
 * Der Suchbegriff steht in der URL. Dadurch ist eine Suche verlinkbar, der
 * Zurück-Knopf funktioniert, und ein Neuladen zeigt dieselben Treffer.
 *
 * Jeder Treffer bekommt einen Knopf "Hinzufügen", der die Serie in die eigene
 * Datenbank aufnimmt (POST /api/library). Direkt danach lädt Streamo die
 * Streaming-Verfügbarkeit nach und blendet die Anbieter-Logos ein.
 *
 * Verknüpfungen:
 *   - api.search.query()  -> src/routes/search.js
 *   - api.library.add()   -> src/routes/library.js
 *   - ui.enrichWithAvailability() -> POST /api/shows/availability
 * ---------------------------------------------------------------------------
 */

import { api } from '../api.js';
import { el, render, posterCard, empty, toast, enrichWithAvailability } from '../ui.js';
// Übersetzt Texte, die am Baustein el() vorbei direkt ins DOM geschrieben werden.
import { tr } from '../i18n.js';

/**
 * Zeichnet die Suchergebnisse.
 * @param {HTMLElement} container
 * @param {object} _params ungenutzt (die Route hat keine Platzhalter)
 * @param {URLSearchParams} query enthält q und optional page
 */
export async function render_(container, _params, query) {
  const term = query.get('q') || '';

  // Die Suchleiste in der Kopfzeile mit dem Begriff füllen, damit sichtbar
  // bleibt, wonach gesucht wurde – auch nach einem Neuladen.
  document.getElementById('global-search-input').value = term;

  if (!term) {
    render(container, empty('🔍', 'Wonach suchst du?', 'Gib oben einen Serien- oder Filmtitel ein.'));
    return;
  }

  const data = await api.search.query(term);

  if (data.results.length === 0) {
    render(
      container,
      el('h1', { text: `Suche: ${term}` }),
      empty('🤷', 'Keine Treffer', `Zu "${term}" hat TMDB nichts gefunden. Vielleicht ein Tippfehler?`),
    );
    return;
  }

  /**
   * Baut den Aktionsknopf unter einer Kachel.
   *
   * Er ändert nach dem Klick sein Aussehen, ohne dass die ganze Liste neu
   * gezeichnet wird – das würde die Scrollposition zerstören.
   *
   * @param {object} item
   * @returns {HTMLElement}
   */
  const addButton = (item) => {
    const button = el('button.btn.btn-sm', {
      style: { width: '100%', marginTop: '7px' },
      text: item.inLibrary ? '✓ In der Bibliothek' : '+ Hinzufügen',
      disabled: item.inLibrary,
      onClick: async (event) => {
        // Der Klick darf nicht bis zur Kachel durchschlagen, sonst öffnet sich
        // gleichzeitig die Detailseite.
        event.stopPropagation();

        button.disabled = true;
        button.textContent = tr('Wird geladen …');

        try {
          await api.library.add(item.tmdbId, item.mediaType, 'watchlist');
          button.textContent = tr('✓ In der Bibliothek');
          item.inLibrary = true;
          toast(`„${item.title}" ist jetzt in deiner Bibliothek.`, 'success');
        } catch (error) {
          button.disabled = false;
          button.textContent = tr('+ Hinzufügen');
          toast(error.message, 'error');
        }
      },
    });

    return button;
  };

  const grid = el(
    'div.grid',
    {},
    data.results.map((item) => posterCard(item, { action: addButton(item) })),
  );

  render(
    container,
    el('div.view-header', {}, [
      el('div', {}, [
        el('h1', { text: `Suche: ${term}`, style: { marginBottom: '2px' } }),
        el('p.muted', {
          style: { margin: 0 },
          // Hat erst eine korrigierte Schreibweise Treffer gebracht, muss das
          // sichtbar sein: Sonst wundert man sich, warum "Kingsmann" plötzlich
          // "Kingsman" zeigt. Das Feld correctedFrom liefert src/routes/search.js.
          text: data.correctedFrom
            ? `Nichts zu „${term}" gefunden – hier sind die Treffer für „${data.correctedFrom}"`
            : `${data.totalResults ?? data.results.length} Treffer`,
        }),
      ]),
    ]),
    grid,
  );

  // Anbieter-Logos nachreichen. Beim Neuzeichnen braucht jede Kachel einen
  // frisch erzeugten Knopf – deshalb buildOptions statt eines festen Objekts.
  enrichWithAvailability(data.results, grid, {
    buildOptions: (item) => ({ action: addButton(item) }),
  });
}

export { render_ as render };
