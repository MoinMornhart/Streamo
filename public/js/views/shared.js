/**
 * ---------------------------------------------------------------------------
 * public/js/views/shared.js – Eine geteilte Liste ansehen
 * ---------------------------------------------------------------------------
 * Adresse: /s/<token>
 *
 * Die einzige Ansicht, die OHNE Anmeldung funktioniert. Wer per WhatsApp einen
 * Link bekommt, soll die Liste einfach sehen können – ohne Konto, ohne
 * Registrierung, ohne Hürde.
 *
 * Entsprechend sparsam ist sie: Titel, Reihenfolge und Notizen. Sie verrät
 * nicht, wer die Liste erstellt hat, was diese Person gesehen hat oder welche
 * Abos sie besitzt (siehe src/routes/public.js).
 *
 * Am Ende steht ein dezenter Hinweis auf Streamo – wer die Liste nützlich
 * findet, soll wissen, woher sie kommt.
 *
 * Verknüpfungen:
 *   - api.shared.get() -> GET /api/public/collections/:token
 *   - src/collections.js -> getSharedCollection()
 * ---------------------------------------------------------------------------
 */

import { api, img } from '../api.js';
import { el, render, empty, formatRuntime } from '../ui.js';
// Übersetzt Texte, die am Baustein el() vorbei direkt ins DOM geschrieben werden.
import { tr } from '../i18n.js';

/**
 * Baut die Zeile eines Titels in der geteilten Liste.
 *
 * Bewusst ohne Verknüpfung zur eigenen Bibliothek: Der Betrachter hat
 * womöglich gar kein Konto, und ein Knopf, der ihn zur Anmeldung zwingt,
 * wäre an dieser Stelle eine Zumutung.
 *
 * @param {object} item
 * @param {number} index
 * @returns {HTMLElement}
 */
function itemRow(item, index) {
  const poster = img(item.posterPath, 'w154');

  return el(
    'div',
    {
      style: {
        display: 'flex',
        gap: '14px',
        padding: '12px',
        borderRadius: 'var(--radius)',
        background: 'var(--surface)',
        border: '1px solid var(--surface-3)',
        marginBottom: '10px',
        alignItems: 'flex-start',
      },
    },
    [
      el('div', {
        style: {
          fontSize: '20px',
          fontWeight: '700',
          color: 'var(--text-faint)',
          minWidth: '28px',
          textAlign: 'center',
          paddingTop: '4px',
        },
        text: String(index + 1),
      }),

      el('div', { style: { width: '62px', flexShrink: '0' } }, [
        poster
          ? el('img', {
              src: poster,
              alt: item.title,
              loading: 'lazy',
              style: { borderRadius: '7px', width: '100%' },
            })
          : el('div.poster-placeholder', {
              style: { height: '93px', borderRadius: '7px' },
              text: item.title,
            }),
      ]),

      el('div', { style: { flex: '1', minWidth: '0' } }, [
        el('div', { style: { fontWeight: '600' }, text: item.title }),

        el('div.muted.small', {
          text: [
            item.year,
            item.runtime ? formatRuntime(item.runtime) : null,
            item.voteAverage > 0 ? `★ ${item.voteAverage.toFixed(1)}` : null,
          ]
            .filter(Boolean)
            .join(' · '),
        }),

        // Die Notiz ist meist der eigentliche Grund, warum die Liste geteilt
        // wurde – deshalb steht sie deutlich hervorgehoben.
        item.note &&
          el('div', {
            style: {
              marginTop: '7px',
              padding: '8px 11px',
              borderRadius: '7px',
              background: 'var(--surface-2)',
              fontSize: '13px',
            },
            text: item.note,
          }),
      ]),
    ],
  );
}

/**
 * Zeichnet die geteilte Liste.
 *
 * @param {HTMLElement} container
 * @param {{token: string}} params
 */
export async function render_(container, params) {
  let collection;

  try {
    collection = await api.shared.get(params.token);
  } catch (error) {
    render(
      container,
      el('div.auth-screen', {}, [
        el('div.auth-box', {}, [
          el('div.auth-logo', {}, [el('span.brand-mark', { text: 'S' }), 'Streamo']),
          el('h2', { text: 'Liste nicht gefunden' }),
          el('p.muted', { text: error.message }),
          el('a.btn.btn-primary', {
            href: '/',
            'data-link': '',
            text: 'Zu Streamo',
            style: { marginTop: '12px' },
          }),
        ]),
      ]),
    );
    return;
  }

  // Der Seitentitel wird gesetzt, damit ein geteilter Link im Browser-Tab
  // und in der Verlaufsliste erkennbar bleibt.
  document.title = tr(`${collection.name} · Streamo`);

  render(
    container,

    el('div', { style: { maxWidth: '760px', margin: '0 auto' } }, [
      // Kopfbereich – ohne Navigation, denn der Betrachter ist nicht angemeldet.
      el(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '11px',
            marginBottom: '24px',
            paddingBottom: '18px',
            borderBottom: '1px solid var(--surface-3)',
          },
        },
        [
          el('span.brand-mark', { text: 'S' }),
          el('div', {}, [
            el('div', { style: { fontWeight: '700' }, text: 'Streamo' }),
            el('div.muted.small', { text: 'Geteilte Liste' }),
          ]),
        ],
      ),

      el('h1', { text: collection.name, style: { marginBottom: '6px' } }),

      el('p.muted', {
        style: { marginTop: 0 },
        text: [
          `${collection.items.length} ${collection.items.length === 1 ? 'Titel' : 'Titel'}`,
          collection.totalRuntime > 0 ? formatRuntime(collection.totalRuntime) : null,
        ]
          .filter(Boolean)
          .join(' · '),
      }),

      collection.description &&
        el('div.card', { style: { marginBottom: '22px' } }, [
          el('p', { style: { margin: 0 }, text: collection.description }),
        ]),

      collection.items.length > 0
        ? el('div', {}, collection.items.map(itemRow))
        : empty('📽️', 'Diese Liste ist leer', 'Es wurden noch keine Titel aufgenommen.'),

      // Hinweis auf Streamo – zurückhaltend, aber auffindbar.
      el(
        'div',
        {
          style: {
            marginTop: '34px',
            paddingTop: '22px',
            borderTop: '1px solid var(--surface-3)',
            textAlign: 'center',
          },
        },
        [
          el('p.muted.small', {
            text: 'Diese Liste wurde mit Streamo erstellt – der Serien- und Filmverwaltung, die immer zeigt, wo du streamen kannst.',
          }),
          el('a', {
            href: 'https://github.com/MoinMornhart/Streamo',
            target: '_blank',
            rel: 'noopener noreferrer',
            class: 'small',
            text: 'Streamo selbst betreiben',
          }),
        ],
      ),
    ]),
  );
}

export { render_ as render };
