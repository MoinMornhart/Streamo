/**
 * ---------------------------------------------------------------------------
 * public/js/views/calendar.js – Der Kalender
 * ---------------------------------------------------------------------------
 * Adresse: /calendar
 *
 * Zeigt, was ansteht, und bietet an, das Ganze im eigenen Kalender zu
 * abonnieren – Apple Kalender, Google Kalender, Thunderbird.
 *
 * Drei Arten von Terminen, die alle aus Streamo selbst stammen:
 *   📺 was du dir vorgenommen hast (der Termin von der Merkliste)
 *   ⏳ was bald eine Plattform verlässt
 *   🎬 wann die nächste Episode erscheint
 *
 * Gruppiert nach Tag statt als Monatsraster: Ein Monat mit vier Einträgen ist
 * zu 90 % leer, und die Frage lautet ohnehin "was kommt als Nächstes" und
 * nicht "wie sieht der 17. aus".
 *
 * Verknüpfungen:
 *   - api.calendar.*  -> src/routes/calendar.js
 *   - src/calendar.js -> sammelt die Termine, baut den Feed
 * ---------------------------------------------------------------------------
 */

import { api } from '../api.js';
import { el, render, empty, toast, formatDate, copyToClipboard, askConfirm } from '../ui.js';
import { navigateTo } from '../router.js';

/** Wie ein Tag über einer Gruppe steht. */
const TAGES_FORMAT = { weekday: 'long', day: 'numeric', month: 'long' };

/**
 * Beschriftet einen Tag so, wie man ihn nennen würde.
 * @param {string} iso "YYYY-MM-DD"
 * @returns {string}
 */
function tagesTitel(iso) {
  const target = new Date(`${iso}T00:00:00`);

  const heute = new Date();
  heute.setHours(0, 0, 0, 0);

  const tage = Math.round((target - heute) / 86_400_000);

  if (tage === 0) return 'Heute';
  if (tage === 1) return 'Morgen';
  if (tage === -1) return 'Gestern';

  return target.toLocaleDateString('de-DE', TAGES_FORMAT);
}

/**
 * Zeichnet den Kalender.
 * @param {HTMLElement} container
 */
export async function render_(container) {
  const data = await api.calendar.get();

  // ------------------------------------------------------------------------
  // Termine nach Tag bündeln
  // ------------------------------------------------------------------------
  const nachTag = new Map();

  for (const event of data.events) {
    if (!nachTag.has(event.date)) nachTag.set(event.date, []);
    nachTag.get(event.date).push(event);
  }

  const heute = new Date().toISOString().slice(0, 10);

  // ------------------------------------------------------------------------
  // Der Kasten zum Abonnieren
  // ------------------------------------------------------------------------
  const urlField = el('input', {
    value: data.subscription.url,
    readonly: true,
    onClick: (event) => event.currentTarget.select(),
    style: { width: '100%', fontSize: '13px' },
  });

  const aboCard = el('div.card', { style: { marginBottom: '24px' } }, [
    el('h2', { text: 'In deinem Kalender' }),
    el('p.muted.small', {
      text: 'Abonniere den Kalender einmal, danach hält er sich von selbst aktuell. Neue Termine erscheinen automatisch – du musst nichts weiter tun.',
    }),

    el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', margin: '14px 0' } }, [
      // webcal:// öffnet Apple Kalender und Outlook direkt als Abonnement.
      // Ein Klick statt "Ablage -> Neues Kalenderabonnement -> Adresse
      // einfügen".
      el('a.btn.btn-primary', {
        href: data.subscription.webcal,
        text: 'Jetzt abonnieren',
        title: 'Öffnet dein Kalenderprogramm (Apple Kalender, Outlook …)',
      }),

      el('button.btn.btn-ghost', {
        text: 'Adresse kopieren',
        onClick: async (event) => {
          const ok = await copyToClipboard(data.subscription.url);

          if (ok) {
            event.currentTarget.textContent = '✓ Kopiert';
            toast('Adresse kopiert – in deinem Kalender einfügen.', 'success');
          } else {
            urlField.select();
            toast('Kopieren nicht möglich – die Adresse ist markiert, jetzt Strg+C.', 'info');
          }
        },
      }),
    ]),

    el('div.field', {}, [
      el('label', { text: 'Adresse zum Abonnieren' }),
      urlField,
      el('div.hint', {
        text: 'Apple Kalender: Ablage → Neues Kalenderabonnement. Google Kalender: Weitere Kalender → Per URL. Am iPhone: Einstellungen → Kalender → Accounts → Account hinzufügen → Andere → Kalenderabo.',
      }),
    ]),

    // Die Adresse ist der einzige Nachweis – wer sie hat, sieht die Termine.
    // Deshalb ein Weg, sie zu entwerten.
    el('div.error-box', { style: { marginTop: '16px' } }, [
      el('strong', { text: 'Die Adresse ist wie ein Passwort' }),
      el('p', {
        style: { margin: '6px 0 10px' },
        text: 'Ein Kalenderprogramm kann sich nicht anmelden – deshalb steckt der Nachweis in der Adresse. Wer sie kennt, sieht, was du dir vorgenommen hast. Gib sie nicht weiter.',
      }),
      el('button.btn.btn-sm.btn-danger', {
        text: 'Neue Adresse erzeugen',
        title: 'Bestehende Abonnements laufen danach ins Leere',
        onClick: async () => {
          const sure = await askConfirm({
            title: 'Neue Adresse erzeugen?',
            text: 'Alle Kalender, die den bisherigen Link abonniert haben, zeigen danach nichts mehr an. Du musst sie neu abonnieren.',
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
    ]),
  ]);

  // ------------------------------------------------------------------------
  // Die Terminliste
  // ------------------------------------------------------------------------
  const liste =
    nachTag.size === 0
      ? empty(
          '📅',
          'Noch nichts geplant',
          'Trag bei einem Titel auf deiner Merkliste ein, wann du ihn sehen willst – dann steht er hier. Auslaufende Angebote und neue Episoden erscheinen von selbst.',
          el('a.btn.btn-primary', { href: '/library?status=watchlist', 'data-link': '', text: 'Zur Merkliste' }),
        )
      : el(
          'div',
          {},
          [...nachTag.entries()].map(([datum, events]) =>
            el('section.cal-day' + (datum === heute ? '.today' : ''), {}, [
              el('div.cal-day-head', {}, [
                el('h3', { text: tagesTitel(datum), style: { margin: 0 } }),
                el('span.muted.small', { text: formatDate(datum) }),
              ]),

              ...events.map((event) =>
                el(
                  `div.cal-event.${event.kind}`,
                  {
                    // Zum Titel springen, wenn er zu einem gehört.
                    onClick: event.showId ? () => navigateTo('/library') : undefined,
                    style: event.showId ? { cursor: 'pointer' } : {},
                  },
                  [
                    el('div', {}, [
                      el('div.cal-event-title', { text: event.summary }),
                      el('div.muted.small', { text: event.description }),
                    ]),
                  ],
                ),
              ),
            ]),
          ),
        );

  render(
    container,

    el('div.view-header', {}, [
      el('div', {}, [
        el('h1', { text: 'Kalender', style: { marginBottom: '2px' } }),
        el('p.muted', {
          style: { margin: 0 },
          text: 'Was du dir vorgenommen hast, was bald ausläuft und wann neue Episoden kommen.',
        }),
      ]),
    ]),

    aboCard,
    liste,
  );
}

export { render_ as render };
