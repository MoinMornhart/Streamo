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
// Übersetzt Texte, die am Baustein el() vorbei direkt ins DOM geschrieben werden.
import { tr } from '../i18n.js';

// ===========================================================================
// Was sich die Bibliothek über Sitzungen hinweg merkt
// ===========================================================================
// Beides liegt im localStorage des Browsers, nicht auf dem Server: Es sind
// Bequemlichkeiten dieses einen Geräts, keine Daten, die zum Konto gehören.
// Am Telefon darf eine andere Ansicht eingestellt sein als am Rechner.

/** Die zuletzt benutzte Filterzeile, z. B. "status=watching&provider=8". */
const FILTER_KEY = 'streamo.library.filters';

/** Welche Filmreihen ausgeklappt sind – als JSON-Liste von Kennungen. */
const EXPANDED_KEY = 'streamo.library.expanded';

/**
 * Liest die gemerkte Filterzeile.
 *
 * In einem privaten Fenster oder bei blockierten Website-Daten wirft der
 * Zugriff. Dann gibt es eben keine gemerkten Filter – das ist kein Grund,
 * die ganze Bibliothek nicht anzuzeigen.
 *
 * @returns {string} leer, wenn nichts gemerkt ist
 */
function loadSavedFilters() {
  try {
    return localStorage.getItem(FILTER_KEY) || '';
  } catch {
    return '';
  }
}

/**
 * Merkt sich die Filterzeile.
 * @param {string} search z. B. "status=watching" – leer heißt "keine Filter"
 */
function saveFilters(search) {
  try {
    localStorage.setItem(FILTER_KEY, search);
  } catch {
    /* nicht schreibbar – dann eben ohne Gedächtnis */
  }
}

/**
 * Liest, welche Filmreihen ausgeklappt sein sollen.
 * @returns {Set<number>}
 */
function loadExpanded() {
  try {
    const parsed = JSON.parse(localStorage.getItem(EXPANDED_KEY) || '[]');
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

/**
 * Merkt sich die ausgeklappten Filmreihen.
 * @param {Set<number>} ids
 */
function saveExpanded(ids) {
  try {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify([...ids]));
  } catch {
    /* siehe oben */
  }
}

/**
 * Baut den Abschnitt einer Filmreihe – ein- und ausklappbar.
 *
 * Zwei Darstellungen für dieselben Titel:
 *
 *   EINGEKLAPPT (Vorgabe): eine waagerechte Zeile, in der etwa drei Kacheln
 *     nebeneinander Platz haben. Rechts ein Pfeil, der zu den nächsten
 *     weiterschiebt. Auf dem Handy lässt sich stattdessen einfach wischen.
 *     So belegt eine achtteilige Reihe eine Zeile statt einer halben Seite.
 *
 *   AUSGEKLAPPT: das gewohnte Raster mit allen Teilen auf einmal.
 *
 * Welcher Zustand gilt, merkt sich der Browser je Reihe (siehe EXPANDED_KEY).
 * Umgeschaltet wird ohne Neuladen – die Seite neu zu zeichnen würde die
 * Scrollposition zerstören, und man klappt ja meist mehrere nacheinander auf.
 *
 * @param {object} group     Eine Gruppe aus data.groups
 * @param {Set<number>} expanded Die ausgeklappten Reihen (wird verändert)
 * @param {(entry: object) => HTMLElement} actions Baut die Knopfleiste einer Kachel
 * @returns {HTMLElement}
 */
function collectionSection(group, expanded, actions) {
  let isOpen = expanded.has(group.collectionId);

  // --- Die eingeklappte Zeile ----------------------------------------------
  // Die Kacheln liegen in einem waagerecht scrollbaren Streifen. Die Breite
  // einer Kachel legt das Stylesheet fest (.reel > *), damit genau drei
  // hineinpassen – auf schmalen Bildschirmen zwei.
  const reel = el(
    'div.reel',
    {},
    group.items.map((entry) => posterCard(entry, { action: actions(entry) })),
  );

  /**
   * Schiebt den Streifen um seine eigene Breite weiter.
   * @param {number} direction -1 = zurück, 1 = vor
   */
  const scrollReel = (direction) => {
    reel.scrollBy({ left: direction * reel.clientWidth, behavior: 'smooth' });
  };

  const prevButton = el('button.reel-arrow.prev', {
    type: 'button',
    text: '‹',
    title: 'Zurück',
    'aria-label': 'Vorherige Titel',
    onClick: () => scrollReel(-1),
  });

  const nextButton = el('button.reel-arrow.next', {
    type: 'button',
    text: '›',
    title: 'Weitere Titel',
    'aria-label': 'Weitere Titel',
    onClick: () => scrollReel(1),
  });

  /**
   * Blendet die Pfeile passend zur Scrollposition ein und aus.
   *
   * Ein Pfeil, der nichts mehr zu tun hat, ist irreführend – am linken Rand
   * gibt es kein Zurück, am rechten kein Weiter. Und passen ohnehin alle
   * Titel nebeneinander, braucht es überhaupt keine Pfeile.
   */
  const updateArrows = () => {
    // Ein Zahl-Puffer gegen Rundungsfehler: Browser liefern scrollLeft als
    // Bruchzahl, ein exakter Vergleich schlüge deshalb manchmal fehl.
    const atStart = reel.scrollLeft <= 2;
    const atEnd = reel.scrollLeft + reel.clientWidth >= reel.scrollWidth - 2;
    const fitsCompletely = reel.scrollWidth <= reel.clientWidth + 2;

    prevButton.hidden = fitsCompletely || atStart;
    nextButton.hidden = fitsCompletely || atEnd;
  };

  reel.addEventListener('scroll', updateArrows);

  // Beim Größerziehen des Fensters ändert sich, wie viel hineinpasst.
  window.addEventListener('resize', updateArrows);

  const reelWrap = el('div.reel-wrap', {}, [prevButton, reel, nextButton]);

  // --- Das ausgeklappte Raster ---------------------------------------------
  const grid = el(
    'div.grid',
    {},
    group.items.map((entry) => posterCard(entry, { action: actions(entry) })),
  );

  // --- Der Umschalter -------------------------------------------------------
  const toggle = el('button.collection-toggle', {
    type: 'button',
    onClick: () => {
      isOpen = !isOpen;

      if (isOpen) expanded.add(group.collectionId);
      else expanded.delete(group.collectionId);

      saveExpanded(expanded);
      applyState();
    },
  });

  /** Setzt Sichtbarkeit und Beschriftung passend zum aktuellen Zustand. */
  function applyState() {
    reelWrap.hidden = isOpen;
    grid.hidden = !isOpen;

    // Das Dreieck zeigt, was ein Klick bewirkt: nach rechts = aufklappen,
    // nach unten = zuklappen.
    toggle.textContent = tr(isOpen ? '▾' : '▸');
    toggle.title = tr(isOpen ? 'Reihe einklappen' : 'Reihe ausklappen');
    toggle.setAttribute('aria-expanded', String(isOpen));

    // Die Pfeile erst berechnen, wenn der Streifen sichtbar ist – an einem
    // ausgeblendeten Element sind alle Breiten null.
    if (!isOpen) updateArrows();
  }

  const section = el('section.collection-section', {}, [
    el('div.collection-head', {}, [
      toggle,

      // Die Überschrift klappt ebenfalls um – ein größeres Ziel als das
      // kleine Dreieck, gerade auf dem Handy.
      el('h2', {
        text: group.name,
        style: { margin: 0, cursor: 'pointer' },
        onClick: () => toggle.click(),
      }),

      el('span.muted.small', {
        text:
          `${group.ownedParts} von ${group.totalParts} Teilen` +
          (group.watchedParts > 0 ? ` · ${group.watchedParts} gesehen` : ''),
      }),

      // Führt zur Reihe selbst – dort stehen auch die Teile, die man
      // noch nicht hat.
      el('a', {
        href: `/collections/${group.collectionId}`,
        'data-link': '',
        class: 'small',
        text: 'Zur Reihe →',
      }),
    ]),

    reelWrap,
    grid,
  ]);

  applyState();

  // Noch einmal nachrechnen, sobald der Abschnitt wirklich im Dokument hängt:
  // Vorher sind clientWidth und scrollWidth null und die Pfeile lägen falsch.
  requestAnimationFrame(updateArrows);

  return section;
}

/**
 * Zeichnet die Bibliothek.
 * @param {HTMLElement} container
 * @param {object} _params
 * @param {URLSearchParams} query Die aktiven Filter
 */
export async function render_(container, _params, query) {
  // ------------------------------------------------------------------------
  // Die zuletzt benutzten Filter wiederherstellen
  // ------------------------------------------------------------------------
  // Die Filter stehen in der Adresse – das ist richtig so, denn dadurch ist
  // eine gefilterte Ansicht verlinkbar und der Zurück-Knopf funktioniert.
  // Nur waren sie damit auch sofort wieder weg: Ein Klick auf eine Serie und
  // zurück über "Bibliothek" in der Kopfzeile führte auf ein nacktes
  // /library, und man durfte alles neu einstellen.
  //
  // Deshalb wird die zuletzt benutzte Filterzeile gemerkt. Wird /library ohne
  // jeden Parameter aufgerufen, springt Streamo einmal auf die gemerkte
  // Adresse um. Eine Endlosschleife kann daraus nicht werden: Danach sind
  // Parameter vorhanden, und dieser Zweig greift nicht mehr.
  //
  // "Filter zurücksetzen" merkt sich ausdrücklich die leere Zeile – sonst
  // käme der alte Filter beim nächsten Aufruf zurück und das Zurücksetzen
  // wäre wirkungslos.
  if (query.toString() === '') {
    const saved = loadSavedFilters();

    if (saved) {
      navigateTo(`/library?${saved}`);
      return;
    }
  }

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
    // "collections" fasst Titel derselben Filmreihe zu einer Kachel zusammen.
    group: query.get('group') || '',
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

    // Merken, bevor navigiert wird – dann steht die Einstellung auch nach
    // einem Umweg über eine Detailseite wieder bereit.
    saveFilters(search);

    navigateTo(`/library${search ? `?${search}` : ''}`);
  };

  /**
   * Setzt alle Filter zurück – und merkt sich ausdrücklich, dass keine
   * gesetzt sind. Ohne dieses Merken käme beim nächsten Aufruf der alte
   * Filter zurück.
   */
  const resetFilters = () => {
    saveFilters('');
    navigateTo('/library');
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
        // Was als Nächstes dransteht. Titel ohne Termin rutschen ans Ende –
        // ohne Datum ist eben kein Datum, kein "sofort".
        ['planned', 'Geplanter Termin'],
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

    // Einzeln oder nach Filmreihen gruppiert. Wer acht Marvel-Filme auf der
    // Liste hat, sieht gruppiert eine Kachel statt acht.
    el('button.chip' + (filters.group === 'collections' ? '.active' : ''), {
      text: '🎬 Nach Reihen',
      title: 'Titel derselben Filmreihe zu einer Gruppe zusammenfassen',
      onClick: () =>
        setFilter({ group: filters.group === 'collections' ? '' : 'collections' }),
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
        onClick: resetFilters,
      }),
  ]);

  // ------------------------------------------------------------------------
  // Leerzustände – unterschiedlich, je nachdem ob die Bibliothek leer ist
  // oder nur der Filter nichts übrig lässt.
  // ------------------------------------------------------------------------
  // In der gruppierten Ansicht heißen die Felder anders – der Leerzustand
  // gilt aber für beide gleichermaßen.
  if (data.total === 0) {
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
              onClick: resetFilters,
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
          // Aussehen steht in styles.css (.tile-status): Ein Inline-Stil schlug
          // dort jede Regel und nahm dem Pfeil mit "padding: 0 6px" den Platz.
          class: 'tile-status',
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
            event.target.textContent = tr(next ? '♥' : '♡');
          } catch (error) {
            toast(error.message, 'error');
          }
        },
      }),
    ]);

  // -------------------------------------------------------------------------
  // Gruppierte Darstellung
  // -------------------------------------------------------------------------
  // Jede Filmreihe bekommt einen eigenen Abschnitt mit Überschrift; alles,
  // was zu keiner Reihe gehört, steht darunter. So bleibt die Reihenfolge
  // innerhalb einer Reihe sichtbar, was bei einer Reihe ja der Punkt ist.
  if (data.grouped) {
    const sections = [];

    // Welche Reihen waren zuletzt ausgeklappt? Die Vorgabe ist eingeklappt:
    // Der Sinn der Gruppierung ist ja, aus acht Kacheln eine Zeile zu machen.
    const expanded = loadExpanded();

    for (const group of data.groups) {
      sections.push(collectionSection(group, expanded, actions));
    }

    // Alles ohne Reihe.
    if (data.singles.length > 0) {
      sections.push(
        el('section', {}, [
          el('h2', {
            style: { marginBottom: '12px' },
            text: data.groups.length > 0 ? 'Einzelne Titel' : 'Deine Titel',
          }),
          el(
            'div.grid',
            {},
            data.singles.map((entry) => posterCard(entry, { action: actions(entry) })),
          ),
        ]),
      );
    }

    render(
      container,
      el('div.view-header', {}, [
        el('div', {}, [
          el('h1', { text: 'Meine Bibliothek', style: { marginBottom: '2px' } }),
          el('p.muted', {
            style: { margin: 0 },
            text: `${data.total} Einträge · ${data.groups.length} ${data.groups.length === 1 ? 'Filmreihe' : 'Filmreihen'} · ${data.singles.length} einzeln`,
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
      ...sections,
    );

    return;
  }

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
