/**
 * ---------------------------------------------------------------------------
 * public/js/ui.js – Wiederverwendbare Bausteine der Oberfläche
 * ---------------------------------------------------------------------------
 * Enthält alles, was in mehreren Ansichten gebraucht wird: das Erzeugen von
 * DOM-Elementen, die Poster-Kachel, Toasts, Ladeanzeigen und Formatierer.
 *
 * Bewusst ohne Framework. Die Funktion el() unten ersetzt JSX in etwa 20
 * Zeilen und reicht für eine Anwendung dieser Größe vollkommen aus.
 *
 * Verknüpfungen:
 *   - public/js/api.js       -> img() für die Bild-URLs
 *   - public/js/views/*.js   -> alle Ansichten bauen damit ihr Markup
 *   - public/css/styles.css  -> die hier vergebenen Klassennamen
 * ---------------------------------------------------------------------------
 */

import { img } from './api.js';

/**
 * Erzeugt ein DOM-Element.
 *
 * @param {string} tag       Tag-Name, optional mit Klassen: "div.card.big"
 * @param {object} [props]   Attribute und Eigenschaften. Sonderfälle:
 *                           - text:    setzt textContent (XSS-sicher)
 *                           - html:    setzt innerHTML (nur für eigenes Markup!)
 *                           - onClick: hängt einen Klick-Listener an
 *                           - style:   Objekt mit CSS-Eigenschaften
 *                           - dataset: Objekt mit data-Attributen
 * @param {(Node|string|null|false)[]} [children] Kindelemente; false/null
 *                           werden übersprungen, damit `cond && el(...)`
 *                           direkt im Aufruf funktioniert.
 * @returns {HTMLElement}
 */
export function el(tag, props = {}, children = []) {
  // "div.card.big" -> Tag "div", Klassen "card big"
  const [tagName, ...classes] = tag.split('.');
  const node = document.createElement(tagName);
  if (classes.length) node.className = classes.join(' ');

  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;

    if (key === 'text') {
      // textContent statt innerHTML: Serientitel kommen aus einer fremden API
      // und könnten sonst Markup einschleusen.
      node.textContent = String(value);
    } else if (key === 'html') {
      node.innerHTML = value;
    } else if (key === 'onClick') {
      node.addEventListener('click', value);
    } else if (key === 'onInput') {
      node.addEventListener('input', value);
    } else if (key === 'onChange') {
      node.addEventListener('change', value);
    } else if (key === 'onSubmit') {
      node.addEventListener('submit', value);
    } else if (key === 'style' && typeof value === 'object') {
      Object.assign(node.style, value);
    } else if (key === 'dataset') {
      Object.assign(node.dataset, value);
    } else if (key === 'className') {
      node.className = value;
    } else if (key in node && key !== 'list') {
      // Echte Eigenschaften (value, checked, disabled, hidden …) direkt setzen.
      node[key] = value;
    } else {
      node.setAttribute(key, value);
    }
  }

  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }

  return node;
}

/**
 * Ersetzt den Inhalt eines Behälters.
 * @param {HTMLElement} container
 * @param {...(Node|null|false)} nodes
 */
export function render(container, ...nodes) {
  container.replaceChildren(...nodes.flat().filter(Boolean));
}

/** Der Hauptbereich, in den alle Ansichten rendern (siehe index.html). */
export const viewRoot = () => document.getElementById('view');

// --------------------------------------------------------------------------
// Rückmeldungen
// --------------------------------------------------------------------------

/**
 * Zeigt eine kurze Einblendung unten rechts.
 * @param {string} message
 * @param {'info'|'success'|'error'} [type]
 * @param {number} [ms] Anzeigedauer
 */
export function toast(message, type = 'info', ms = 3200) {
  const node = el(`div.toast.${type}`, { text: message });
  document.getElementById('toasts').append(node);

  // Ausblenden und danach aus dem DOM entfernen, damit sich keine
  // unsichtbaren Knoten ansammeln.
  setTimeout(() => {
    node.style.transition = 'opacity .25s, transform .25s';
    node.style.opacity = '0';
    node.style.transform = 'translateX(24px)';
    setTimeout(() => node.remove(), 260);
  }, ms);
}

/**
 * Ladeanzeige für eine ganze Ansicht.
 * @param {string} [message]
 * @returns {HTMLElement}
 */
export function loading(message = 'Lädt …') {
  return el('div.loading-screen', {}, [el('div.spinner'), el('p', { text: message })]);
}

/**
 * Leerzustand mit Symbol, Text und optionaler Aktion.
 * @param {string} icon    Emoji als Symbol
 * @param {string} title
 * @param {string} [text]
 * @param {HTMLElement} [action] z. B. ein Knopf
 * @returns {HTMLElement}
 */
export function empty(icon, title, text, action) {
  return el('div.empty', {}, [
    el('div.empty-icon', { text: icon }),
    el('h2', { text: title }),
    text && el('p', { text }),
    action,
  ]);
}

/**
 * Fehlerkasten für Formulare und fehlgeschlagene Ladevorgänge.
 * @param {string} message
 * @returns {HTMLElement}
 */
export function errorBox(message) {
  return el('div.error-box', { text: message });
}

/**
 * Blendet das gelbe Hinweisband oben ein oder aus.
 * @param {string|null} message null blendet es aus
 * @param {{label: string, href: string}} [link] optionaler Verweis
 */
export function banner(message, link) {
  const node = document.getElementById('banner');

  if (!message) {
    node.hidden = true;
    return;
  }

  render(
    node,
    el('span', { text: message }),
    // data-link sorgt dafür, dass der Router den Klick abfängt.
    link && el('a', { href: link.href, text: link.label, 'data-link': '' }),
  );
  node.hidden = false;
}

// --------------------------------------------------------------------------
// Formatierer
// --------------------------------------------------------------------------

/**
 * Wandelt Minuten in eine lesbare Dauer: 1520 -> "25 Std. 20 Min."
 * @param {number} minutes
 * @returns {string}
 */
export function formatRuntime(minutes) {
  if (!minutes) return '–';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h} Std. ${m} Min.` : `${m} Min.`;
}

/**
 * Formatiert ein ISO-Datum ("2024-03-15") auf Deutsch ("15. März 2024").
 * @param {string|null} iso
 * @returns {string}
 */
export function formatDate(iso) {
  if (!iso) return '–';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * Relative Zeitangabe für "zuletzt aktualisiert vor …".
 * @param {string|null} iso
 * @returns {string}
 */
export function timeAgo(iso) {
  if (!iso) return 'nie';

  // SQLite-Zeitstempel ("2026-09-09 12:30:00") sind UTC ohne Kennzeichnung.
  const normalized = iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z';
  const then = Date.parse(normalized);
  if (Number.isNaN(then)) return iso;

  const seconds = Math.round((Date.now() - then) / 1000);

  if (seconds < 60) return 'gerade eben';
  if (seconds < 3600) return `vor ${Math.floor(seconds / 60)} Min.`;
  if (seconds < 86400) return `vor ${Math.floor(seconds / 3600)} Std.`;
  if (seconds < 2592000) return `vor ${Math.floor(seconds / 86400)} Tagen`;
  return formatDate(normalized.slice(0, 10));
}

/**
 * Übersetzt die internen Statuswerte in Beschriftungen.
 * Die Schlüssel entsprechen exakt dem CHECK-Constraint von library.status
 * (siehe src/db.js).
 */
export const STATUS_LABELS = {
  watchlist: 'Will ich sehen',
  watching: 'Schaue ich',
  completed: 'Gesehen',
  paused: 'Pausiert',
  dropped: 'Abgebrochen',
};

/**
 * Beschriftungen der Angebotsarten aus availability.offer_type.
 */
export const OFFER_LABELS = {
  flatrate: 'Im Abo enthalten',
  free: 'Kostenlos',
  ads: 'Kostenlos mit Werbung',
  rent: 'Leihen',
  buy: 'Kaufen',
};

// --------------------------------------------------------------------------
// Zusammengesetzte Bausteine
// --------------------------------------------------------------------------

/**
 * Die Poster-Kachel – der meistgenutzte Baustein der ganzen Anwendung.
 *
 * Sie zeigt auf einen Blick:
 *   - Poster und Titel
 *   - ob der Titel in einem eigenen Abo enthalten ist (grünes Eck-Abzeichen)
 *   - bei welchen Anbietern er läuft (Logo-Leiste unten links)
 *   - den Sehfortschritt (Balken unter dem Poster)
 *
 * @param {object} item Normalisierter Eintrag aus Suche oder Bibliothek
 * @param {object} [options]
 * @param {(item: object) => void} [options.onClick] Standard: Detailseite öffnen
 * @param {HTMLElement} [options.action] zusätzlicher Knopf unter dem Titel
 * @returns {HTMLElement}
 */
export function posterCard(item, options = {}) {
  const poster = img(item.posterPath, 'w342');

  // --- Anbieter-Logos ------------------------------------------------------
  // availability wird bei Suchergebnissen erst nachgeladen; deshalb kann das
  // Feld hier fehlen. Die Kachel muss auch ohne funktionieren.
  const offers = item.availability?.offers?.flatrate || [];
  const providerStrip = offers.length
    ? el(
        'div.provider-strip',
        {},
        // Höchstens vier Logos, sonst wird die Kachel unruhig.
        offers.slice(0, 4).map((offer) =>
          el(
            `div.provider-logo${offer.subscribed ? '.subscribed' : ''}`,
            { title: offer.name },
            [img(offer.logo_path, 'w92') ? el('img', { src: img(offer.logo_path, 'w92'), alt: offer.name, loading: 'lazy' }) : null],
          ),
        ),
      )
    : null;

  // --- Eck-Abzeichen -------------------------------------------------------
  // Priorität: "in deinem Abo" schlägt "in der Bibliothek", weil das die
  // handlungsrelevantere Information ist.
  let badge = null;
  if (item.availability?.isIncluded) {
    badge = el('span.corner-badge.included', { text: 'Im Abo' });
  } else if (item.inLibrary) {
    badge = el('span.corner-badge.in-library', { text: '✓' });
  }

  const progress = item.progress;

  return el(
    'div.poster-card',
    {
      onClick: () => {
        if (options.onClick) options.onClick(item);
        else window.navigateTo(`/show/${item.mediaType}/${item.tmdbId}`);
      },
      title: item.title,
    },
    [
      el('div.poster-wrap', {}, [
        poster
          ? el('img', { src: poster, alt: item.title, loading: 'lazy' })
          : el('div.poster-placeholder', { text: item.title }),
        badge,
        providerStrip,
      ]),

      el('div.poster-title', { text: item.title }),

      el('div.poster-meta', {}, [
        item.year && el('span', { text: item.year }),
        item.voteAverage > 0 && el('span', { text: `★ ${item.voteAverage.toFixed(1)}` }),
      ]),

      // Fortschrittsbalken nur, wenn tatsächlich etwas gesehen wurde.
      progress?.watched > 0 &&
        el('div.progress-bar', { title: `${progress.watched}/${progress.total} Episoden` }, [
          el('span', { style: { width: `${progress.percent}%` } }),
        ]),

      options.action,
    ],
  );
}

/**
 * Baut ein Raster aus Poster-Kacheln.
 * @param {object[]} items
 * @param {object} [options] wird an posterCard durchgereicht
 * @returns {HTMLElement}
 */
export function posterGrid(items, options = {}) {
  return el(
    'div.grid',
    {},
    items.map((item) => posterCard(item, options)),
  );
}

/**
 * Lädt die Streaming-Verfügbarkeit für eine Trefferliste nach und aktualisiert
 * das bereits gezeichnete Raster.
 *
 * Warum nachträglich? Die Suche selbst soll sofort erscheinen. Die Anbieter-
 * Logos brauchen einen TMDB-Aufruf pro Titel und trudeln deshalb eine halbe
 * Sekunde später ein – gefühlt bleibt die Suche dadurch schnell.
 *
 * @param {object[]} items    Die angezeigten Einträge (werden ergänzt)
 * @param {HTMLElement} container Das Raster, das neu gezeichnet wird
 * @param {object} [options]  wird an posterCard durchgereicht. Sonderfall:
 *   options.buildOptions – eine Funktion (item) => options. Nötig, wenn jede
 *   Kachel ein eigenes Element bekommt (z. B. einen "Hinzufügen"-Knopf), denn
 *   ein DOM-Element kann nicht in zwei Kacheln gleichzeitig hängen und müsste
 *   beim Neuzeichnen frisch erzeugt werden.
 */
export async function enrichWithAvailability(items, container, options = {}) {
  if (items.length === 0) return;

  const { api } = await import('./api.js');

  try {
    const data = await api.shows.availability(
      items.map((i) => ({
        tmdbId: i.tmdbId,
        mediaType: i.mediaType,
        title: i.title,
        posterPath: i.posterPath,
      })),
    );

    // Ergebnisse den Einträgen zuordnen (Schlüssel: "tv:1399").
    for (const item of items) {
      item.availability = data.availability[`${item.mediaType}:${item.tmdbId}`] || null;
    }

    // Nur neu zeichnen, wenn der Container noch im Dokument hängt – der
    // Benutzer könnte inzwischen weitergeklickt haben.
    if (container.isConnected) {
      render(
        container,
        ...items.map((item) =>
          posterCard(item, options.buildOptions ? options.buildOptions(item) : options),
        ),
      );
    }
  } catch {
    // Verfügbarkeit ist eine Zusatzinformation. Schlägt der Aufruf fehl,
    // bleiben die Kacheln eben ohne Logos – kein Grund für eine Fehlermeldung.
  }
}
