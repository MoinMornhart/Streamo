/**
 * ---------------------------------------------------------------------------
 * public/js/views/library.js – Die persönliche Serien-Datenbank
 * ---------------------------------------------------------------------------
 * Adresse: /library?status=watching&provider=8&onlyMine=1
 *
 * Alle Filter stehen in der URL. Damit ist jede Ansicht der Bibliothek
 * verlinkbar ("meine Netflix-Serien, die ich gerade schaue") und der
 * Zurück-Knopf verhält sich, wie man es erwartet.
 *
 * Die Verfügbarkeitsdaten kommen hier direkt aus der Serverantwort – anders
 * als bei der Suche muss nichts nachgeladen werden, weil sie für Titel der
 * eigenen Bibliothek bereits in der Datenbank stehen (Tabelle availability,
 * gepflegt vom Hintergrundabgleich in src/sync.js).
 *
 * Verknüpfungen:
 *   - api.library.list()   -> src/routes/library.js
 *   - api.providers.mine() -> src/routes/providers.js (für den Anbieterfilter)
 * ---------------------------------------------------------------------------
 */

import { api, img } from '../api.js';
import { el, render, posterCard, empty, toast, STATUS_LABELS } from '../ui.js';
import { navigateTo } from '../router.js';

/**
 * Zeichnet die Bibliothek.
 * @param {HTMLElement} container
 * @param {object} _params
 * @param {URLSearchParams} query Die aktiven Filter
 */
export async function render_(container, _params, query) {
  // Aktuelle Filter aus der Adresse lesen.
  const filters = {
    status: query.get('status') || '',
    mediaType: query.get('mediaType') || '',
    provider: query.get('provider') || '',
    onlyMine: query.get('onlyMine') || '',
    favorite: query.get('favorite') || '',
    genre: query.get('genre') || '',
    q: query.get('q') || '',
    sort: query.get('sort') || 'added',
  };

  /**
   * Ändert einen Filter und navigiert auf die neue Adresse.
   * Leere Werte werden entfernt, damit die URL nicht zumüllt.
   *
   * @param {object} changes z. B. { status: 'watching' }
   */
  const setFilter = (changes) => {
    const next = new URLSearchParams(window.location.search);

    for (const [key, value] of Object.entries(changes)) {
      if (value === '' || value === null) next.delete(key);
      else next.set(key, value);
    }

    const search = next.toString();
    navigateTo(`/library${search ? `?${search}` : ''}`);
  };

  // Bibliothek und Abo-Liste parallel holen.
  const [data, providersData] = await Promise.all([
    api.library.list(filters),
    api.providers.mine(),
  ]);

  // ------------------------------------------------------------------------
  // Statusreiter
  // ------------------------------------------------------------------------
  const statusChips = el('div', { style: { display: 'flex', gap: '7px', flexWrap: 'wrap' } }, [
    el('button.chip' + (filters.status === '' ? '.active' : ''), {
      text: 'Alle',
      onClick: () => setFilter({ status: '' }),
    }),
    // Object.entries über STATUS_LABELS: Die Reihenfolge dort entspricht dem
    // typischen Ablauf (will sehen -> schaue -> gesehen).
    ...Object.entries(STATUS_LABELS).map(([value, label]) =>
      el('button.chip' + (filters.status === value ? '.active' : ''), {
        text: label,
        onClick: () => setFilter({ status: value }),
      }),
    ),
  ]);

  // ------------------------------------------------------------------------
  // Filterleiste
  // ------------------------------------------------------------------------
  const filterBar = el('div.filters', {}, [
    // Anbieterfilter – gefüttert aus den verknüpften Abos.
    el(
      'select',
      {
        onChange: (event) => setFilter({ provider: event.target.value }),
        title: 'Nur Titel, die bei diesem Anbieter laufen',
      },
      [
        el('option', { value: '', text: 'Alle Anbieter' }),
        ...providersData.providers.map((p) =>
          el('option', {
            value: String(p.id),
            text: p.name || `Anbieter ${p.id}`,
            selected: filters.provider === String(p.id),
          }),
        ),
      ],
    ),

    el(
      'select',
      { onChange: (event) => setFilter({ mediaType: event.target.value }) },
      [
        el('option', { value: '', text: 'Serien & Filme' }),
        el('option', { value: 'tv', text: 'Nur Serien', selected: filters.mediaType === 'tv' }),
        el('option', { value: 'movie', text: 'Nur Filme', selected: filters.mediaType === 'movie' }),
      ],
    ),

    el(
      'select',
      { onChange: (event) => setFilter({ sort: event.target.value }) },
      [
        ['added', 'Zuletzt hinzugefügt'],
        ['updated', 'Zuletzt geändert'],
        ['title', 'Titel A–Z'],
        ['rating', 'Meine Bewertung'],
        ['tmdb', 'TMDB-Bewertung'],
        ['year', 'Erscheinungsjahr'],
      ].map(([value, text]) =>
        el('option', { value, text, selected: filters.sort === value }),
      ),
    ),

    // Umschalter: nur zeigen, was in einem eigenen Abo enthalten ist.
    el('button.chip' + (filters.onlyMine === '1' ? '.active' : ''), {
      text: '✓ In meinen Abos',
      title: 'Nur Titel, die du ohne Zusatzkosten sehen kannst',
      onClick: () => setFilter({ onlyMine: filters.onlyMine === '1' ? '' : '1' }),
    }),

    el('button.chip' + (filters.favorite === '1' ? '.active' : ''), {
      text: '♥ Favoriten',
      onClick: () => setFilter({ favorite: filters.favorite === '1' ? '' : '1' }),
    }),

    // Suchfeld innerhalb der Bibliothek (nicht bei TMDB).
    el('input', {
      type: 'search',
      placeholder: 'In der Bibliothek filtern …',
      value: filters.q,
      style: { minWidth: '200px' },
      onChange: (event) => setFilter({ q: event.target.value.trim() }),
    }),

    // Zurücksetzen erscheint nur, wenn überhaupt etwas gefiltert ist.
    Object.entries(filters).some(([k, v]) => v && k !== 'sort') &&
      el('button.btn.btn-sm.btn-ghost', {
        text: 'Filter zurücksetzen',
        onClick: () => navigateTo('/library'),
      }),
  ]);

  // ------------------------------------------------------------------------
  // Leerzustände – unterschiedlich, je nachdem ob die Bibliothek leer ist
  // oder nur der Filter nichts übrig lässt.
  // ------------------------------------------------------------------------
  if (data.entries.length === 0) {
    const isFiltered = Object.entries(filters).some(([k, v]) => v && k !== 'sort');

    render(
      container,
      el('div.view-header', {}, [el('h1', { text: 'Meine Bibliothek' })]),
      statusChips,
      filterBar,
      isFiltered
        ? empty(
            '🫙',
            'Nichts gefunden',
            'Mit diesen Filtern bleibt nichts übrig.',
            el('button.btn.btn-primary', {
              text: 'Filter zurücksetzen',
              onClick: () => navigateTo('/library'),
            }),
          )
        : empty(
            '📺',
            'Deine Bibliothek ist noch leer',
            'Such oben nach einer Serie und leg sie hier ab. Streamo merkt sich dann, wo du sie streamen kannst.',
            el('a.btn.btn-primary', { href: '/', 'data-link': '', text: 'Serien entdecken' }),
          ),
    );
    return;
  }

  // ------------------------------------------------------------------------
  // Kacheln mit Schnellaktionen
  // ------------------------------------------------------------------------

  /**
   * Baut die Aktionsleiste unter einer Kachel: Statuswechsel und Entfernen.
   * @param {object} entry Eintrag aus /api/library
   * @returns {HTMLElement}
   */
  const actions = (entry) =>
    el('div', { style: { display: 'flex', gap: '5px', marginTop: '7px' } }, [
      // Statuswechsel direkt im Raster – erspart den Umweg über die Detailseite.
      el(
        'select',
        {
          style: { flex: '1', height: '28px', fontSize: '12px', padding: '0 6px' },
          title: 'Status ändern',
          onClick: (event) => event.stopPropagation(), // Kachel nicht öffnen
          onChange: async (event) => {
            event.stopPropagation();
            try {
              await api.library.update(entry.showId, { status: event.target.value });
              toast(`Status: ${STATUS_LABELS[event.target.value]}`, 'success');
            } catch (error) {
              toast(error.message, 'error');
            }
          },
        },
        Object.entries(STATUS_LABELS).map(([value, label]) =>
          el('option', { value, text: label, selected: entry.status === value }),
        ),
      ),

      // Favoritenstern.
      el('button.btn.btn-sm', {
        text: entry.favorite ? '♥' : '♡',
        title: 'Favorit',
        style: { width: '30px', padding: '0' },
        onClick: async (event) => {
          event.stopPropagation();
          const next = !entry.favorite;
          try {
            await api.library.update(entry.showId, { favorite: next });
            entry.favorite = next;
            event.target.textContent = next ? '♥' : '♡';
          } catch (error) {
            toast(error.message, 'error');
          }
        },
      }),
    ]);

  const grid = el(
    'div.grid',
    {},
    data.entries.map((entry) => posterCard(entry, { action: actions(entry) })),
  );

  render(
    container,
    el('div.view-header', {}, [
      el('div', {}, [
        el('h1', { text: 'Meine Bibliothek', style: { marginBottom: '2px' } }),
        el('p.muted', {
          style: { margin: 0 },
          text:
            `${data.total} ${data.total === 1 ? 'Eintrag' : 'Einträge'}` +
            // Wie viele davon sind ohne Zusatzkosten sehbar? Das ist die
            // Kennzahl, die den Nutzen der Abo-Verknüpfung sichtbar macht.
            ` · ${data.entries.filter((e) => e.availability.isIncluded).length} in deinen Abos verfügbar`,
        }),
      ]),
      el('a.btn.btn-ghost.btn-sm', {
        href: api.library.exportUrl,
        text: '↓ Exportieren',
        title: 'Bibliothek als JSON sichern',
      }),
    ]),
    statusChips,
    filterBar,
    grid,
  );
}

export { render_ as render };
