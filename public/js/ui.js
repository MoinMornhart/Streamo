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
// Übersetzung der sichtbaren Texte und Gebietsschema für Datumsangaben.
import { tr, locale } from './i18n.js';

/**
 * Attribute, deren Wert sichtbarer Text ist und deshalb übersetzt wird.
 * Bewusst ohne "alt": Dort stehen fast immer Titel und Anbieternamen.
 */
const TRANSLATED_ATTRIBUTES = new Set(['title', 'placeholder', 'aria-label']);

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
  // Übersetzung: Sichtbare Texte laufen durch tr() (public/js/i18n.js). Bei
  // Deutsch gibt tr() den Text unverändert zurück; bei Englisch schlägt es im
  // Wörterbuch nach. So müssen die Ansichten selbst nichts davon wissen.
  // "div.card.big" -> Tag "div", Klassen "card big"
  const [tagName, ...classes] = tag.split('.');
  const node = document.createElement(tagName);
  if (classes.length) node.className = classes.join(' ');

  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;

    if (key === 'text') {
      // textContent statt innerHTML: Serientitel kommen aus einer fremden API
      // und könnten sonst Markup einschleusen.
      node.textContent = tr(String(value));
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
    } else if (TRANSLATED_ATTRIBUTES.has(key)) {
      // Tooltips, Platzhalter und Beschriftungen für Screenreader sind
      // ebenso sichtbarer Text wie der Inhalt selbst.
      node.setAttribute(key, tr(String(value)));
    } else if (key in node && key !== 'list') {
      // Echte Eigenschaften (value, checked, disabled, hidden …) direkt setzen.
      node[key] = value;
    } else {
      node.setAttribute(key, value);
    }
  }

  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(tr(String(child))));
  }

  return node;
}

/**
 * Ersetzt den Inhalt eines Behälters.
 * @param {HTMLElement} container
 * @param {...(Node|null|false)} nodes
 */
export function render(container, ...nodes) {
  // (Übersetzt wird schon beim Bauen in el() – hier nur einhängen.)
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
 * Legt einen Text in die Zwischenablage – auch dort, wo das eigentlich nicht
 * vorgesehen ist.
 *
 * navigator.clipboard gibt es nur in einem "sicheren Kontext", also unter
 * HTTPS oder auf localhost. Wer Streamo im Heimnetz unter einer nackten
 * IP-Adresse aufruft, hat den nicht – und genau dort wurde bisher nur ein
 * nacktes prompt() angezeigt.
 *
 * Deshalb der zweite Weg: ein unsichtbares Textfeld, dessen Inhalt markiert
 * und über den alten execCommand('copy') kopiert wird. Der Befehl gilt als
 * veraltet, funktioniert aber in jedem Browser und ohne sicheren Kontext.
 *
 * @param {string} text
 * @returns {Promise<boolean>} true, wenn es geklappt hat
 */
export async function copyToClipboard(text) {
  // Der moderne Weg, wenn er zur Verfügung steht.
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fällt durch zum zweiten Weg – z. B. wenn die Berechtigung fehlt.
    }
  }

  try {
    const helper = document.createElement('textarea');
    helper.value = text;

    // Außerhalb des Sichtfelds, aber im Dokument: Ein Element, das gar nicht
    // dargestellt wird, lässt sich nicht markieren.
    helper.style.position = 'fixed';
    helper.style.top = '-1000px';
    helper.setAttribute('readonly', '');

    document.body.append(helper);
    helper.select();
    helper.setSelectionRange(0, text.length); // iOS braucht das ausdrücklich

    const ok = document.execCommand('copy');
    helper.remove();

    return ok;
  } catch {
    return false;
  }
}

/**
 * Öffnet ein Fenster im Stil der Seite.
 *
 * Der Baustein hinter allen Dialogen in Streamo. Er ersetzt window.prompt und
 * window.confirm, denn die zeichnet der Browser: grau, eckig, mit englischen
 * Knöpfen auf manchen Systemen – und vor allem in einer Gestaltung, die mit
 * der übrigen Oberfläche nichts zu tun hat. Wer sich eine Akzentfarbe
 * ausgesucht hat, soll sie auch hier sehen.
 *
 * Was der Dialog von sich aus richtig macht:
 *   - Escape schließt ihn, ein Klick auf den dunklen Hintergrund auch.
 *   - Der Fokus springt hinein und kehrt danach dorthin zurück, wo er war.
 *   - Beim Schließen räumt er seinen Tastatur-Merker wieder ab.
 *
 * @param {object} options
 * @param {string} options.title Überschrift
 * @param {string} [options.subtitle] Erklärender Satz darunter
 * @param {(close: (value?: any) => void) => (HTMLElement|null)[]} options.body
 *   Baut den Inhalt. Bekommt die Schließen-Funktion, damit ein eigener Knopf
 *   den Dialog mit einem Ergebnis beenden kann.
 * @param {boolean} [options.wide] Breiteres Fenster, z. B. für Trefferlisten
 * @returns {Promise<any>} das an close() übergebene Ergebnis, sonst null
 */
export function modal({ title, subtitle, body, wide = false }) {
  return new Promise((resolve) => {
    // Wohin der Fokus zurückkehrt. Ohne das landet er nach dem Schließen am
    // Seitenanfang und die Tastaturbedienung beginnt von vorn.
    const previouslyFocused = document.activeElement;

    let settled = false;

    /**
     * Schließt den Dialog und liefert ein Ergebnis.
     * @param {any} [value]
     */
    const close = (value = null) => {
      if (settled) return; // z. B. Escape während einer laufenden Aktion
      settled = true;

      overlay.remove();
      document.removeEventListener('keydown', onKey);

      if (previouslyFocused?.focus) previouslyFocused.focus();

      resolve(value);
    };

    const onKey = (event) => {
      if (event.key === 'Escape') close(null);
    };

    const box = el(`div.modal-box${wide ? '.wide' : ''}`, {}, [
      el('h3', { text: title, style: { margin: '0 0 4px' } }),
      subtitle && el('p.muted', { style: { margin: '0 0 16px', fontSize: '13px' }, text: subtitle }),
      ...body(close),
    ]);

    const overlay = el(
      'div.modal-overlay',
      {
        onClick: (event) => {
          // Nur der Klick auf den Hintergrund selbst schließt – nicht einer,
          // der aus dem Kasten kommt und nur nach oben durchgereicht wird.
          if (event.target === overlay) close(null);
        },
      },
      [box],
    );

    document.addEventListener('keydown', onKey);
    document.body.append(overlay);

    // Das erste Eingabefeld bekommt den Fokus, sonst der Kasten selbst.
    const firstField = box.querySelector('input, textarea, select, button');
    firstField?.focus();
  });
}

/**
 * Fragt nach einem Text – der Ersatz für window.prompt.
 *
 * @param {object} options
 * @param {string} options.title
 * @param {string} [options.label] Beschriftung über dem Feld
 * @param {string} [options.hint] Kleingedrucktes darunter
 * @param {string} [options.value] Vorbelegung
 * @param {string} [options.placeholder]
 * @param {string} [options.confirmLabel] Beschriftung des Knopfes
 * @returns {Promise<string|null>} null, wenn abgebrochen wurde
 */
export function askText({
  title,
  label,
  hint,
  value = '',
  placeholder = '',
  confirmLabel = 'Weiter',
  type = 'text',
  subtitle,
}) {
  return modal({
    title,
    subtitle,
    body: (close) => {
      const input = el('input', {
        value,
        placeholder,
        type,
        // Bei einer Passwortabfrage soll der Browser das gespeicherte
        // Passwort anbieten – hier wird ja das aktuelle verlangt.
        autocomplete: type === 'password' ? 'current-password' : 'off',
        style: { width: '100%' },
        // Enter bestätigt – bei einem einzelnen Feld erwartet man das.
        onKeyDown: (event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            close(input.value);
          }
        },
      });

      return [
        el('div.field', {}, [label && el('label', { text: label }), input, hint && el('div.hint', { text: hint })]),

        el('div.modal-actions', {}, [
          el('button.btn.btn-ghost', { text: 'Abbrechen', onClick: () => close(null) }),
          el('button.btn.btn-primary', { text: confirmLabel, onClick: () => close(input.value) }),
        ]),
      ];
    },
  });
}

/**
 * Lässt aus einer Liste auswählen.
 *
 * Ersetzt die Konstruktion, die vorher an mehreren Stellen stand: eine
 * nummerierte Liste in einem prompt() und die Bitte, eine Zahl einzutippen.
 * Das war fehleranfällig (was passiert bei "3a"?) und sah aus wie 1998.
 *
 * @template T
 * @param {object} options
 * @param {string} options.title
 * @param {string} [options.subtitle]
 * @param {T[]} options.items
 * @param {(item: T) => {title: string, subtitle?: string, image?: string|null}} options.describe
 *   Wie soll ein Eintrag aussehen?
 * @returns {Promise<T|null>} der gewählte Eintrag, oder null bei Abbruch
 */
export function askChoice({ title, subtitle, items, describe }) {
  return modal({
    title,
    subtitle,
    wide: true,
    body: (close) => [
      el(
        'div.choice-list',
        {},
        items.map((item) => {
          const info = describe(item);

          return el(
            'button.choice-hit',
            { type: 'button', onClick: () => close(item) },
            [
              // Ein Bild, wo es eines gibt – bei einer Filmreihe erkennt man
              // am Poster sofort, ob es die richtige ist.
              info.image
                ? el('img', { src: info.image, alt: '', loading: 'lazy' })
                : el('span.choice-placeholder', { text: info.title.charAt(0).toUpperCase() }),

              el('span', { style: { minWidth: 0 } }, [
                el('div', { text: info.title }),
                info.subtitle && el('div.muted.small', { text: info.subtitle }),
              ]),
            ],
          );
        }),
      ),

      el('div.modal-actions', {}, [
        el('button.btn.btn-ghost', { text: 'Abbrechen', onClick: () => close(null) }),
      ]),
    ],
  });
}

/**
 * Stellt eine Ja/Nein-Frage – der Ersatz für window.confirm.
 *
 * @param {object} options
 * @param {string} options.title
 * @param {string} [options.text] Erklärung darunter
 * @param {string} [options.confirmLabel]
 * @param {boolean} [options.danger] Roter Bestätigungsknopf bei Löschvorgängen
 * @returns {Promise<boolean>}
 */
export async function askConfirm({ title, text, confirmLabel = 'Ja', danger = false }) {
  const answer = await modal({
    title,
    subtitle: text,
    body: (close) => [
      el('div.modal-actions', {}, [
        el('button.btn.btn-ghost', { text: 'Abbrechen', onClick: () => close(false) }),
        el(`button.btn.${danger ? 'btn-danger' : 'btn-primary'}`, {
          text: confirmLabel,
          onClick: () => close(true),
        }),
      ]),
    ],
  });

  return answer === true;
}

/**
 * Öffnet einen Dialog zum Weiterschicken eines Links.
 *
 * Warum überhaupt ein eigener Dialog? Weil die Teilen-Auswahl des Systems
 * (navigator.share) nur unter HTTPS und praktisch nur auf Mobilgeräten
 * existiert. Am Rechner und im Heimnetz unter einer IP-Adresse gibt es sie
 * nicht – dort blieb bisher nur ein prompt()-Fenster, aus dem man den Link
 * von Hand herauskopieren musste.
 *
 * Die Knöpfe hier sind deshalb ganz normale Links auf die Weiterleitungs-
 * Adressen der Dienste. Die funktionieren überall: am Rechner öffnet sich
 * WhatsApp Web, auf dem Handy die App.
 *
 * @param {object} options
 * @param {string} options.url   Der zu teilende Link
 * @param {string} options.title Überschrift des Dialogs
 * @param {string} options.text  Begleittext für die Nachricht
 */export async function shareSheet({ url, title, text }) {
  // Wenn das System eine eigene Auswahl mitbringt, ist sie die bessere: Dort
  // stehen alle installierten Apps, nicht nur die drei, die wir kennen.
  if (navigator.share) {
    try {
      await navigator.share({ title, text, url });
      return;
    } catch (error) {
      // Ein Abbruch ist kein Fehler – wer die Auswahl schließt, wollte eben
      // doch nicht teilen. Nur bei echten Problemen unseren Dialog zeigen.
      if (error.name === 'AbortError') return;
    }
  }

  const message = `${text} ${url}`;

  await modal({
    title,
    subtitle: 'Wer den Link hat, sieht die Liste – ohne Konto und ohne Anmeldung.',
    body: (close) => {
      /**
       * Ein Knopf, der zu einem Dienst führt.
       * @param {string} label Beschriftung
       * @param {string} href  Zieladresse des Dienstes
       * @returns {HTMLElement}
       */
      const target = (label, href) =>
        el('a.btn.btn-ghost', {
          href,
          target: '_blank',
          rel: 'noopener noreferrer',
          text: label,
          style: { flex: '1 1 130px', textAlign: 'center' },
          // Nach dem Klick ist die Aufgabe erledigt – Fenster zu.
          onClick: () => setTimeout(() => close(), 150),
        });

      // Das Feld mit dem Link. readonly, damit niemand versehentlich
      // hineintippt, aber markierbar – manche kopieren lieber selbst.
      const linkField = el('input', {
        value: url,
        readonly: true,
        onClick: (event) => event.currentTarget.select(),
        style: { width: '100%', fontSize: '13px' },
      });

      const copyButton = el('button.btn.btn-primary', {
        type: 'button',
        text: 'Link kopieren',
        style: { width: '100%' },
        onClick: async () => {
          const ok = await copyToClipboard(url);

          if (ok) {
            copyButton.textContent = tr('✓ Kopiert');
            toast('Link kopiert – jetzt einfach einfügen und verschicken.', 'success');
            setTimeout(() => close(), 800);
          } else {
            // Auch der zweite Weg kann scheitern. Dann wenigstens markieren,
            // damit Strg+C reicht.
            linkField.select();
            toast('Kopieren nicht möglich – der Link ist markiert, jetzt Strg+C.', 'info');
          }
        },
      });

      return [
        // Die Knöpfe für WhatsApp, Telegram und E-Mail sind ganz normale
        // Links auf die Weiterleitungs-Adressen der Dienste. Die funktionieren
        // überall: am Rechner öffnet sich WhatsApp Web, auf dem Handy die App.
        el('div.share-targets', {}, [
          target('WhatsApp', `https://wa.me/?text=${encodeURIComponent(message)}`),
          target(
            'Telegram',
            `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`,
          ),
          target(
            'E-Mail',
            `mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(message)}`,
          ),
        ]),

        el('div.field', { style: { marginTop: '18px' } }, [
          el('label', { text: 'Oder den Link selbst weitergeben' }),
          linkField,
        ]),

        copyButton,

        el('button.btn.btn-ghost', {
          type: 'button',
          text: 'Schließen',
          style: { width: '100%', marginTop: '8px' },
          onClick: () => close(),
        }),
      ];
    },
  });
}

/**
 * Meldet frisch freigeschaltete Erfolge.
 *
 * Bekommt die `unlocked`-Liste, die mehrere Endpunkte mitliefern (Episode
 * abhaken, Status ändern, Titel hinzufügen). Ist sie leer, passiert nichts –
 * das ist der Normalfall, deshalb kann man diese Funktion bedenkenlos nach
 * jeder Aktion aufrufen.
 *
 * Die Meldungen erscheinen nacheinander statt gleichzeitig: Wer nach dem
 * Abhaken der letzten Folge drei Erfolge auf einmal bekommt, soll jeden davon
 * einzeln wahrnehmen.
 *
 * @param {object[]|undefined} unlocked Einträge mit icon, title, description
 */
export function announceAchievements(unlocked) {
  if (!Array.isArray(unlocked) || unlocked.length === 0) return;

  unlocked.forEach((achievement, index) => {
    setTimeout(() => {
      const node = el('div.toast.success', {}, [
        el('div', { style: { display: 'flex', gap: '11px', alignItems: 'center' } }, [
          el('span', { style: { fontSize: '26px' }, text: achievement.icon || '🏆' }),
          el('div', {}, [
            el('div', {
              style: { fontWeight: '650', fontSize: '11px', color: 'var(--text-dim)' },
              text: 'ERFOLG FREIGESCHALTET',
            }),
            el('div', { style: { fontWeight: '600' }, text: achievement.title }),
            el('div', {
              style: { fontSize: '12.5px', color: 'var(--text-dim)', marginTop: '2px' },
              text: achievement.description,
            }),
          ]),
        ]),
      ]);

      // Anklickbar: führt zur Erfolgsseite.
      node.style.cursor = 'pointer';
      node.style.pointerEvents = 'auto';
      node.addEventListener('click', () => window.navigateTo('/achievements'));

      document.getElementById('toasts').append(node);

      // Länger stehen lassen als eine gewöhnliche Meldung – hier gibt es
      // etwas zu lesen, und es ist ein kleiner Moment der Belohnung.
      setTimeout(() => {
        node.style.transition = 'opacity .3s, transform .3s';
        node.style.opacity = '0';
        node.style.transform = 'translateX(24px)';
        setTimeout(() => node.remove(), 320);
      }, 6000);
    }, index * 900);
  });
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
 * Beschriftet einen geplanten Termin so, wie man ihn nennen würde.
 *
 * "Heute" und "Morgen" statt eines Datums, in der laufenden Woche der
 * Wochentag, sonst der Tag mit Monat. Ein vergangener Termin heißt
 * "überfällig" – das ist ehrlicher als ein Datum, bei dem man erst rechnen
 * muss, und genau die Titel will man ja wiederfinden.
 *
 * @param {string} iso "YYYY-MM-DD"
 * @returns {string}
 */
export function plannedLabel(iso) {
  const target = new Date(`${iso}T00:00:00`);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // In ganzen Tagen ab Mitternacht, nicht in 24-Stunden-Schritten: Wer abends
  // nachsieht, soll für morgen "Morgen" lesen und nicht schon "Heute".
  const days = Math.round((target - today) / 86_400_000);

  if (days < 0) return '⏰ überfällig';
  if (days === 0) return '📅 Heute';
  if (days === 1) return '📅 Morgen';

  // Innerhalb der nächsten Woche reicht der Wochentag – "Freitag" sagt mehr
  // als "12.9.", wenn es ohnehin bald ist.
  if (days < 7) {
    return `📅 ${target.toLocaleDateString(locale(), { weekday: 'long' })}`;
  }

  return `📅 ${target.toLocaleDateString(locale(), { day: 'numeric', month: 'short' })}`;
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
  // Das Gebietsschema folgt der Sprache der Oberfläche: "15. März 2024"
  // oder "15 March 2024".
  return date.toLocaleDateString(locale(), { day: 'numeric', month: 'long', year: 'numeric' });
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

  // --- "Läuft bald aus" ----------------------------------------------------
  // Die dringendste Information überhaupt, deshalb direkt auf dem Poster und
  // nicht erst auf der Detailseite: Wer die Bibliothek überfliegt, soll sehen,
  // was er diese Woche noch schauen sollte.
  //
  // Das Datum stammt nicht von TMDB – dort gibt es kein solches Feld –,
  // sondern wurde von Hand eingetragen (siehe src/routes/shows.js). Es gibt
  // es also nur zu wenigen Titeln, und die Kachel muss ohne genauso aussehen.
  const expiring = item.availability?.expiring;

  const expiryBadge = expiring
    ? el(
        // Ab drei Tagen wird es dringend – dann rot statt gelb.
        `span.expiry-badge${expiring.daysLeft <= 3 ? '.urgent' : ''}`,
        {
          title: `Bei ${expiring.providerName} nur noch bis zum ${formatDate(expiring.availableUntil)}`,
          text:
            expiring.daysLeft <= 0
              ? 'Letzter Tag'
              : expiring.daysLeft === 1
                ? 'Noch 1 Tag'
                : `Noch ${expiring.daysLeft} Tage`,
        },
      )
    : null;

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
        // Oben links: "Im Abo" sitzt oben rechts, die Anbieter-Logos unten
        // links – so verdeckt nichts etwas anderes.
        expiryBadge,
        providerStrip,
      ]),

      el('div.poster-title', { text: item.title }),

      el('div.poster-meta', {}, [
        item.year && el('span', { text: item.year }),
        item.voteAverage > 0 && el('span', { text: `★ ${item.voteAverage.toFixed(1)}` }),
      ]),

      // Ein geplanter Termin von der Merkliste ("Fr, 12. Sept.").
      //
      // Freiwillig – die allermeisten Einträge haben keinen, und ohne einen
      // sieht die Kachel aus wie immer. Wer einen gesetzt hat, sieht beim
      // Überfliegen, was als Nächstes drankommt.
      item.plannedFor && el('div.poster-planned', { text: plannedLabel(item.plannedFor) }),

      // Begründung einer persönlichen Empfehlung ("Weil du … gesehen hast").
      // Gesetzt wird sie von src/recommend.js; überall sonst fehlt das Feld
      // und die Zeile entfällt ersatzlos.
      item.reason &&
        el('div.poster-reason', {
          text: item.reason,
          // Der volle Text als Tooltip, weil die Zeile nach zwei Zeilen
          // abgeschnitten wird.
          title: item.reason,
        }),

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
