/**
 * ---------------------------------------------------------------------------
 * public/js/views/calendar.js – Der Kalender
 * ---------------------------------------------------------------------------
 * Adresse: /calendar
 *
 * Ein Monatsraster, in dem JEDER Tag steht – auch die leeren. Genau das macht
 * einen Kalender aus: Man sieht nicht nur, was ansteht, sondern auch, wann
 * nichts ansteht. Eine reine Terminliste beantwortet die Frage "habe ich am
 * Samstag etwas vor?" nicht.
 *
 * Drei Arten von Terminen, alle aus Daten, die Streamo schon hat:
 *   📺 was du dir vorgenommen hast (der Termin von der Merkliste)
 *   ⏳ was bald eine Plattform verlässt
 *   🎬 wann die nächste Episode erscheint
 *
 * Alle Termine kommen in EINEM Aufruf (ein Jahr voraus, vier Wochen zurück).
 * Das Blättern zwischen Monaten filtert danach nur noch lokal – kein
 * Nachladen, kein Warten.
 *
 * Verknüpfungen:
 *   - api.calendar.*  -> src/routes/calendar.js
 *   - src/calendar.js -> sammelt die Termine, baut den Feed
 * ---------------------------------------------------------------------------
 */

import { api } from '../api.js';
import {
  el,
  render,
  toast,
  formatDate,
  copyToClipboard,
  askConfirm,
  modal,
} from '../ui.js';
import { navigateTo } from '../router.js';

/** Die Spaltenköpfe. Montag zuerst – so ist es hierzulande üblich. */
const WOCHENTAGE = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

/**
 * Ein Datum als "YYYY-MM-DD", ohne Zeitzonenverschiebung.
 *
 * toISOString() rechnet nach UTC um – abends in Deutschland ergäbe das den
 * falschen Tag. Deshalb von Hand zusammengesetzt.
 *
 * @param {Date} date
 * @returns {string}
 */
function isoTag(date) {
  const monat = String(date.getMonth() + 1).padStart(2, '0');
  const tag = String(date.getDate()).padStart(2, '0');

  return `${date.getFullYear()}-${monat}-${tag}`;
}

/**
 * Baut die Tage eines Monatsrasters – immer volle Wochen.
 *
 * Das Raster beginnt am Montag vor (oder auf) dem Monatsersten und endet am
 * Sonntag nach dem Monatsletzten. Die Tage der Nachbarmonate stehen mit drin,
 * nur blasser: Ohne sie hätte die erste Zeile Löcher.
 *
 * @param {number} jahr
 * @param {number} monat 0 = Januar
 * @returns {Date[]}
 */
function rasterTage(jahr, monat) {
  const erster = new Date(jahr, monat, 1);

  // getDay() liefert 0 für Sonntag. Für eine Woche ab Montag muss daraus 6
  // werden – daher die Verschiebung.
  const versatz = (erster.getDay() + 6) % 7;

  const start = new Date(jahr, monat, 1 - versatz);
  const tage = [];

  // Der letzte Tag des Monats. Tag 0 des Folgemonats ist genau der.
  const letzterImMonat = new Date(jahr, monat + 1, 0);

  // So lange volle Wochen anhängen, bis der Monat abgedeckt ist. Das ergibt je
  // nach Monat vier bis sechs Zeilen – eine feste Zahl würde entweder Tage
  // abschneiden oder eine leere Zeile erzeugen.
  //
  // Sechs Wochen sind die Obergrenze: Ein Monat hat höchstens 31 Tage, davor
  // liegen höchstens sechs Versatztage. Die Schranke steht trotzdem da, damit
  // ein Denkfehler im Datumsvergleich nicht in einer Endlosschleife endet.
  const cursor = new Date(start);

  for (let woche = 0; woche < 6; woche++) {
    for (let i = 0; i < 7; i++) {
      tage.push(new Date(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }

    // Fertig, sobald der letzte angehängte Tag den Monatsletzten erreicht hat.
    // Bei einem Februar, der genau vier Wochen füllt, hört es hier auf –
    // sonst hinge eine komplett fremde Woche darunter.
    if (tage[tage.length - 1] >= letzterImMonat) break;
  }

  return tage;
}

/**
 * Zeichnet den Kalender.
 * @param {HTMLElement} container
 */
export async function render_(container) {
  const data = await api.calendar.get();

  // Termine nach Tag bündeln – einmal, nicht bei jedem Monatswechsel.
  const nachTag = new Map();

  for (const event of data.events) {
    if (!nachTag.has(event.date)) nachTag.set(event.date, []);
    nachTag.get(event.date).push(event);
  }

  const heute = isoTag(new Date());

  // Welcher Monat gerade gezeigt wird.
  let jahr = new Date().getFullYear();
  let monat = new Date().getMonth();

  const gitterSlot = el('div');
  const titelSlot = el('h2', { style: { margin: 0, minWidth: '190px' } });

  // ------------------------------------------------------------------------
  // Das Abonnement – als Fenster, nicht als Kasten
  // ------------------------------------------------------------------------
  // Vorher stand das alles ausgebreitet über dem Kalender und hat die halbe
  // Seite belegt. Man richtet es aber genau einmal ein; danach ist es nur noch
  // im Weg. Deshalb ein kleiner Knopf, der bei Bedarf ein Fenster öffnet.
  const abonnieren = async () => {
    await modal({
      title: 'In deinem Kalender',
      subtitle:
        'Einmal abonnieren, danach hält sich der Kalender von selbst aktuell. Neue Termine erscheinen automatisch.',
      wide: true,
      body: (close) => {
        const urlField = el('input', {
          value: data.subscription.url,
          readonly: true,
          onClick: (event) => event.currentTarget.select(),
          style: { width: '100%', fontSize: '13px' },
        });

        return [
          el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, [
            // webcal:// öffnet Apple Kalender und Outlook direkt als
            // Abonnement – ein Klick statt "Ablage → Neues Kalenderabonnement".
            el('a.btn.btn-primary', {
              href: data.subscription.webcal,
              text: 'Jetzt abonnieren',
              title: 'Öffnet dein Kalenderprogramm (Apple Kalender, Outlook …)',
              style: { flex: '1 1 160px', textAlign: 'center' },
              onClick: () => setTimeout(() => close(), 300),
            }),

            el('button.btn.btn-ghost', {
              text: 'Adresse kopieren',
              style: { flex: '1 1 160px' },
              onClick: async (event) => {
                const ok = await copyToClipboard(data.subscription.url);

                if (ok) {
                  event.currentTarget.textContent = '✓ Kopiert';
                  toast('Adresse kopiert – in deinem Kalender einfügen.', 'success');
                } else {
                  urlField.select();
                  toast('Kopieren nicht möglich – die Adresse ist markiert, Strg+C.', 'info');
                }
              },
            }),
          ]),

          el('div.field', { style: { marginTop: '16px' } }, [
            el('label', { text: 'Adresse zum Abonnieren' }),
            urlField,
            el('div.hint', {
              text: 'Apple Kalender: Ablage → Neues Kalenderabonnement. Google Kalender: Weitere Kalender → Per URL. Am iPhone: Einstellungen → Kalender → Accounts → Account hinzufügen → Andere → Kalenderabo.',
            }),
          ]),

          // Die Adresse ist der einzige Nachweis – wer sie hat, sieht die
          // Termine. Deshalb ein Weg, sie zu entwerten.
          el('p.hint', {
            style: { marginTop: '14px' },
            text: 'Ein Kalenderprogramm kann sich nicht anmelden – deshalb steckt der Nachweis in der Adresse. Wer sie kennt, sieht, was du dir vorgenommen hast. Gib sie nicht weiter.',
          }),

          el('div.modal-actions', {}, [
            el('button.btn.btn-sm.btn-danger', {
              text: 'Neue Adresse erzeugen',
              title: 'Bestehende Abonnements laufen danach ins Leere',
              style: { marginRight: 'auto' },
              onClick: async () => {
                const sure = await askConfirm({
                  title: 'Neue Adresse erzeugen?',
                  text: 'Alle Kalender, die den bisherigen Link abonniert haben, zeigen danach nichts mehr an. Du müsstest sie neu abonnieren.',
                  confirmLabel: 'Neu erzeugen',
                  danger: true,
                });

                if (!sure) return;

                try {
                  const result = await api.calendar.reset();
                  data.subscription = result.subscription;
                  urlField.value = result.subscription.url;
                  toast('Neue Adresse erzeugt. Bestehende Abos musst du erneuern.', 'success');
                } catch (error) {
                  toast(error.message, 'error');
                }
              },
            }),
            el('button.btn.btn-ghost', { text: 'Schließen', onClick: () => close() }),
          ]),
        ];
      },
    });
  };

  // ------------------------------------------------------------------------
  // Das Monatsraster
  // ------------------------------------------------------------------------
  /** Zeichnet den gerade gewählten Monat. */
  const zeichneMonat = () => {
    titelSlot.textContent = new Date(jahr, monat, 1).toLocaleDateString('de-DE', {
      month: 'long',
      year: 'numeric',
    });

    const tage = rasterTage(jahr, monat);

    render(
      gitterSlot,

      // Die Spaltenköpfe stehen außerhalb des Rasters, damit sie beim Blättern
      // nicht mitwandern.
      el(
        'div.cal-weekdays',
        {},
        WOCHENTAGE.map((tag) => el('div', { text: tag })),
      ),

      el(
        'div.cal-grid',
        {},
        tage.map((datum) => {
          const iso = isoTag(datum);
          const events = nachTag.get(iso) ?? [];

          // Tage der Nachbarmonate blasser: Sie gehören zur Woche, aber nicht
          // zum Monat.
          const fremd = datum.getMonth() !== monat;

          return el(
            `div.cal-cell${fremd ? '.other-month' : ''}${iso === heute ? '.today' : ''}`,
            {},
            [
              el('div.cal-date', { text: String(datum.getDate()) }),

              // Die Termine des Tages. Der volle Text steht im Tooltip – in
              // einer Zelle ist kein Platz für "Ocean's 11, 12 und 13".
              ...events.map((event) =>
                el(`div.cal-chip.${event.kind}`, {
                  text: event.summary,
                  title: `${event.summary}\n${event.description}`,
                  onClick: event.showId ? () => navigateTo('/library') : undefined,
                }),
              ),
            ],
          );
        }),
      ),
    );
  };

  /**
   * Blättert um Monate weiter.
   * @param {number} schritte negativ = zurück
   */
  const blaettern = (schritte) => {
    const ziel = new Date(jahr, monat + schritte, 1);

    jahr = ziel.getFullYear();
    monat = ziel.getMonth();

    zeichneMonat();
  };

  render(
    container,

    // Eine schmale Kopfzeile: Titel, Blättern, und der Abo-Knopf klein rechts.
    el('div.cal-header', {}, [
      el('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } }, [
        el('button.btn.btn-sm.btn-ghost', {
          text: '‹',
          title: 'Voriger Monat',
          'aria-label': 'Voriger Monat',
          onClick: () => blaettern(-1),
        }),
        titelSlot,
        el('button.btn.btn-sm.btn-ghost', {
          text: '›',
          title: 'Nächster Monat',
          'aria-label': 'Nächster Monat',
          onClick: () => blaettern(1),
        }),
        el('button.btn.btn-sm.btn-ghost', {
          text: 'Heute',
          onClick: () => {
            jahr = new Date().getFullYear();
            monat = new Date().getMonth();
            zeichneMonat();
          },
        }),
      ]),

      el('button.btn.btn-sm.btn-ghost', {
        text: '📅 Abonnieren',
        title: 'In Apple Kalender, Google Kalender oder Thunderbird einbinden',
        onClick: abonnieren,
      }),
    ]),

    // Eine Legende, damit die Farbstreifen sprechen.
    el('div.cal-legend', {}, [
      el('span', {}, [el('i.dot.planned'), 'Vorgemerkt']),
      el('span', {}, [el('i.dot.expiring'), 'Läuft aus']),
      el('span', {}, [el('i.dot.episode'), 'Neue Episode']),
    ]),

    gitterSlot,

    data.events.length === 0 &&
      el('p.muted.small', {
        style: { marginTop: '16px' },
        text: 'Noch nichts eingetragen. Trag bei einem Titel auf deiner Merkliste ein, wann du ihn sehen willst – auslaufende Angebote und neue Episoden erscheinen von selbst.',
      }),
  );

  zeichneMonat();
}

export { render_ as render };
