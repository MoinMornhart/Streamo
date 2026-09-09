/**
 * ---------------------------------------------------------------------------
 * public/js/views/home.js – Startseite "Entdecken"
 * ---------------------------------------------------------------------------
 * Beantwortet die Frage, für die Streamo gebaut wurde: "Was kann ich mit
 * meinen Abos gerade schauen?"
 *
 * Aufbau der Seite:
 *   1. Fortsetzen – Serien mit Status "watching" aus der eigenen Bibliothek
 *   2. In deinen Abos – Discover, gefiltert auf die verknüpften Anbieter
 *   3. Angesagt – TMDB-Trending als Rückfall, wenn noch keine Abos verknüpft
 *      sind
 *
 * Verknüpfungen:
 *   - api.library.list()      -> src/routes/library.js
 *   - api.search.discover()   -> src/routes/search.js (nutzt user_providers)
 *   - api.providers.mine()    -> src/routes/providers.js
 * ---------------------------------------------------------------------------
 */

import { api } from '../api.js';
import { el, render, posterGrid, empty, enrichWithAvailability, loading } from '../ui.js';

/**
 * Baut einen Abschnitt mit Überschrift und Poster-Raster.
 * @param {string} title
 * @param {object[]} items
 * @param {HTMLElement} [action] optionaler Verweis rechts neben der Überschrift
 * @returns {HTMLElement|null} null, wenn es nichts anzuzeigen gibt
 */
function section(title, items, action) {
  if (!items || items.length === 0) return null;

  return el('section', { style: { marginBottom: '38px' } }, [
    el('div.view-header', { style: { marginBottom: '14px' } }, [
      el('h2', { text: title, style: { margin: 0 } }),
      action,
    ]),
    posterGrid(items),
  ]);
}

/**
 * Zeichnet die Startseite.
 * @param {HTMLElement} container
 */
export async function render_(container) {
  // Drei unabhängige Abfragen parallel – so ist die Seite nach der langsamsten
  // da statt nach der Summe aller drei.
  const [watchingResult, providersResult] = await Promise.all([
    api.library.list({ status: 'watching', sort: 'updated' }),
    api.providers.mine(),
  ]);

  const watching = watchingResult.entries;
  const hasProviders = providersResult.providers.length > 0;

  // Der Bereich für die Empfehlungen wird zuerst leer eingehängt und danach
  // gefüllt – so erscheint "Fortsetzen" sofort.
  const discoverSlot = el('section', { style: { marginBottom: '38px' } }, [loading('Suche Titel in deinen Abos …')]);

  // ------------------------------------------------------------------------
  // Grundgerüst zeichnen
  // ------------------------------------------------------------------------
  const parts = [];

  // Begrüßung mit Hinweis, worauf gefiltert wird.
  parts.push(
    el('div.view-header', {}, [
      el('div', {}, [
        el('h1', { text: 'Entdecken', style: { marginBottom: '4px' } }),
        el('p.muted', {
          style: { margin: 0 },
          text: hasProviders
            ? `Gefiltert auf deine ${providersResult.providers.length} verknüpften Anbieter.`
            : 'Verknüpfe deine Streaming-Abos, damit Streamo weiß, was du sehen kannst.',
        }),
      ]),
      !hasProviders &&
        el('a.btn.btn-primary', {
          href: '/providers',
          'data-link': '',
          text: 'Anbieter verknüpfen',
        }),
    ]),
  );

  const continueSection = section(
    'Weiterschauen',
    watching,
    el('a', { href: '/library?status=watching', 'data-link': '', text: 'Alle anzeigen', class: 'small' }),
  );
  if (continueSection) parts.push(continueSection);

  parts.push(discoverSlot);

  render(container, ...parts);

  // Verfügbarkeiten für "Weiterschauen" kommen bereits aus der Bibliothek
  // (dort sind sie gespeichert) – hier ist also kein Nachladen nötig.

  // ------------------------------------------------------------------------
  // Empfehlungen nachladen
  // ------------------------------------------------------------------------
  try {
    // Ohne verknüpfte Abos ergibt der Abo-Filter keinen Sinn – dann zeigen wir
    // die allgemein angesagten Serien.
    const data = hasProviders
      ? await api.search.discover({ mediaType: 'tv', sort: 'popularity.desc' })
      : await api.search.trending('tv');

    const items = data.results.slice(0, 24);

    if (items.length === 0) {
      render(
        discoverSlot,
        empty(
          '🍿',
          'Nichts gefunden',
          hasProviders
            ? 'Bei deinen Anbietern hat TMDB gerade nichts im Angebot. Prüfe deine Region in den Einstellungen.'
            : 'Verknüpfe zuerst deine Streaming-Abos.',
        ),
      );
      return;
    }

    const grid = posterGrid(items);

    render(
      discoverSlot,
      el('div.view-header', { style: { marginBottom: '14px' } }, [
        el('h2', {
          text: hasProviders ? 'In deinen Abos' : 'Gerade angesagt',
          style: { margin: 0 },
        }),
        el('a', {
          href: '/library',
          'data-link': '',
          text: 'Meine Bibliothek',
          class: 'small',
        }),
      ]),
      grid,
    );

    // Die Anbieter-Logos auf den Kacheln nachreichen. Bei Discover-Treffern
    // wissen wir zwar bereits, dass sie in einem Abo laufen – aber nicht in
    // welchem, und genau das soll die Kachel zeigen.
    enrichWithAvailability(items, grid);
  } catch (error) {
    render(discoverSlot, empty('⚠️', 'Empfehlungen nicht verfügbar', error.message));
  }
}

export { render_ as render };
