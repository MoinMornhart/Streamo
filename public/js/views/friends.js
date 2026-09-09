/**
 * ---------------------------------------------------------------------------
 * public/js/views/friends.js – Freunde
 * ---------------------------------------------------------------------------
 * Adressen:
 *   /friends       – Freundesliste, offene Anfragen, erhaltene Empfehlungen
 *   /friends/:id   – ein Freund: "Was können wir zusammen schauen?"
 *
 * Der eigentliche Zweck steht auf der zweiten Seite. Die Freundesliste selbst
 * ist nur der Weg dorthin: Interessant wird es, wenn Streamo aus zwei Listen
 * und zwei Abo-Sammlungen ableitet, was man gemeinsam sehen kann.
 *
 * Verknüpfungen:
 *   - api.friends.* -> src/routes/friends.js
 *   - src/friends.js -> die Logik dahinter
 * ---------------------------------------------------------------------------
 */

import { api, img } from '../api.js';
import { el, render, empty, toast, posterCard, timeAgo, errorBox, STATUS_LABELS } from '../ui.js';
import { navigateTo } from '../router.js';

/**
 * Zeigt einen Namen an – bevorzugt den Anzeigenamen.
 * @param {object} person
 * @returns {string}
 */
function nameOf(person) {
  return person.display_name || person.displayName || person.username;
}

/**
 * Baut die Zeile einer Person in der Freundesliste.
 *
 * @param {object} person
 * @param {object} actions Knöpfe rechts
 * @param {string} [subtitle]
 * @returns {HTMLElement}
 */
function personRow(person, actions, subtitle) {
  const name = nameOf(person);

  return el(
    'div',
    {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: '13px',
        padding: '13px',
        borderRadius: 'var(--radius)',
        background: 'var(--surface)',
        border: '1px solid var(--surface-3)',
        marginBottom: '9px',
      },
    },
    [
      // Anfangsbuchstabe als Bild-Ersatz – Streamo kennt keine Profilbilder.
      el('div', {
        style: {
          width: '40px',
          height: '40px',
          borderRadius: '50%',
          background: 'linear-gradient(135deg, var(--accent), #a55eea)',
          display: 'grid',
          placeItems: 'center',
          fontWeight: '700',
          color: '#fff',
          flexShrink: '0',
        },
        text: name.charAt(0).toUpperCase(),
      }),

      el('div', { style: { flex: '1', minWidth: '0' } }, [
        el('div', { style: { fontWeight: '600' }, text: name }),
        el('div.muted.small', { text: subtitle || `@${person.username}` }),
      ]),

      actions,
    ],
  );
}

/**
 * Zeichnet die Freundesliste.
 * @param {HTMLElement} container
 */
async function renderOverview(container) {
  const data = await api.friends.list();
  const reload = () => renderOverview(container);

  /**
   * Stellt eine Freundschaftsanfrage.
   */
  const addFriend = async () => {
    const username = window.prompt(
      'Benutzername oder E-Mail der Person:\n(Sie muss ein Konto auf dieser Streamo-Instanz haben.)',
    );
    if (!username) return;

    try {
      const result = await api.friends.request(username);
      toast(result.message, 'success');
      reload();
    } catch (error) {
      toast(error.message, 'error');
    }
  };

  render(
    container,

    el('div.view-header', {}, [
      el('div', {}, [
        el('h1', { text: 'Freunde', style: { marginBottom: '2px' } }),
        el('p.muted', {
          style: { margin: 0 },
          text: 'Seht, was ihr zusammen schauen könnt – auf Grundlage eurer beider Abos und Listen.',
        }),
      ]),
      el('button.btn.btn-primary', { text: '+ Freund hinzufügen', onClick: addFriend }),
    ]),

    // --- Eingegangene Anfragen: das Dringendste zuerst ---
    data.incoming.length > 0 &&
      el('section', { style: { marginBottom: '30px' } }, [
        el('h2', { text: `Anfragen an dich (${data.incoming.length})` }),
        ...data.incoming.map((person) =>
          personRow(
            person,
            el('div', { style: { display: 'flex', gap: '7px' } }, [
              el('button.btn.btn-sm.btn-primary', {
                text: 'Annehmen',
                onClick: async () => {
                  try {
                    await api.friends.accept(person.id);
                    toast(`Ihr seid jetzt befreundet.`, 'success');
                    reload();
                  } catch (error) {
                    toast(error.message, 'error');
                  }
                },
              }),
              el('button.btn.btn-sm.btn-ghost', {
                text: 'Ablehnen',
                onClick: async () => {
                  try {
                    await api.friends.remove(person.id);
                    reload();
                  } catch (error) {
                    toast(error.message, 'error');
                  }
                },
              }),
            ]),
            `möchte sich mit dir verbinden · ${timeAgo(person.created_at)}`,
          ),
        ),
      ]),

    // --- Empfehlungen ---
    data.unreadRecommendations > 0 &&
      el('div.card', { style: { marginBottom: '26px' } }, [
        el('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } }, [
          el('span', { style: { fontSize: '24px' }, text: '💌' }),
          el('div', { style: { flex: '1' } }, [
            el('strong', {
              text: `${data.unreadRecommendations} neue ${data.unreadRecommendations === 1 ? 'Empfehlung' : 'Empfehlungen'}`,
            }),
            el('div.muted.small', { text: 'Deine Freunde haben dir etwas vorgeschlagen.' }),
          ]),
          el('a.btn.btn-primary.btn-sm', {
            href: '/friends/recommendations',
            'data-link': '',
            text: 'Ansehen',
          }),
        ]),
      ]),

    // --- Freunde ---
    data.friends.length > 0 &&
      el('section', { style: { marginBottom: '30px' } }, [
        el('h2', { text: `Deine Freunde (${data.friends.length})` }),
        ...data.friends.map((person) =>
          personRow(
            person,
            el('div', { style: { display: 'flex', gap: '7px' } }, [
              el('button.btn.btn-sm.btn-primary', {
                text: 'Zusammen schauen',
                onClick: () => navigateTo(`/friends/${person.id}`),
              }),
              el('button.btn.btn-sm.btn-ghost', {
                text: '×',
                title: 'Freundschaft beenden',
                onClick: async () => {
                  if (!window.confirm(`Freundschaft mit ${nameOf(person)} beenden?`)) return;
                  try {
                    await api.friends.remove(person.id);
                    toast('Freundschaft beendet.');
                    reload();
                  } catch (error) {
                    toast(error.message, 'error');
                  }
                },
              }),
            ]),
            `${person.library_count} Titel in der Bibliothek`,
          ),
        ),
      ]),

    // --- Eigene Anfragen, die noch offen sind ---
    data.outgoing.length > 0 &&
      el('section', {}, [
        el('h2', { text: 'Deine Anfragen' }),
        ...data.outgoing.map((person) =>
          personRow(
            person,
            el('button.btn.btn-sm.btn-ghost', {
              text: 'Zurückziehen',
              onClick: async () => {
                try {
                  await api.friends.remove(person.id);
                  reload();
                } catch (error) {
                  toast(error.message, 'error');
                }
              },
            }),
            `angefragt ${timeAgo(person.created_at)} · wartet auf Antwort`,
          ),
        ),
      ]),

    data.friends.length === 0 &&
      data.incoming.length === 0 &&
      data.outgoing.length === 0 &&
      empty(
        '👋',
        'Noch keine Freunde',
        'Wenn jemand anderes ein Konto auf dieser Streamo-Instanz hat, könnt ihr euch verbinden – und Streamo zeigt euch, was ihr gemeinsam sehen könnt.',
        el('button.btn.btn-primary', { text: '+ Freund hinzufügen', onClick: addFriend }),
      ),
  );
}

/**
 * Zeichnet "Was können wir zusammen schauen?" für einen Freund.
 *
 * @param {HTMLElement} container
 * @param {string} friendId
 */
async function renderTogether(container, friendId) {
  const data = await api.friends.together(friendId);
  const name = nameOf(data.friend);

  /**
   * Baut einen Abschnitt mit Vorschlägen.
   * @param {string} title
   * @param {string} explanation Warum stehen diese Titel hier?
   * @param {object[]} items
   * @returns {HTMLElement|null}
   */
  const section = (title, explanation, items) => {
    if (items.length === 0) return null;

    return el('section', { style: { marginBottom: '34px' } }, [
      el('h2', { style: { marginBottom: '3px' }, text: title }),
      el('p.muted.small', { style: { marginTop: 0 }, text: explanation }),
      el(
        'div.grid',
        {},
        items.map((item) =>
          posterCard(item, {
            // Die Bewertung des Freundes ist hier die entscheidende
            // Zusatzinformation – deshalb steht sie unter der Kachel.
            action: item.friendRating
              ? el('div.muted.small', {
                  style: { textAlign: 'center', marginTop: '5px' },
                  text: `${name}: ${item.friendRating}/10`,
                })
              : undefined,
          }),
        ),
      ),
    ]);
  };

  const nothing =
    data.bothWant.length === 0 &&
    data.fromTheirList.length === 0 &&
    data.theirFavourites.length === 0;

  render(
    container,

    el('a', {
      href: '/friends',
      'data-link': '',
      class: 'muted small',
      text: '← Alle Freunde',
      style: { display: 'inline-block', marginBottom: '14px' },
    }),

    el('div.view-header', {}, [
      el('div', {}, [
        el('h1', { text: `Zusammen mit ${name}`, style: { marginBottom: '2px' } }),
        el('p.muted', {
          style: { margin: 0 },
          text:
            data.providerCount > 0
              ? `Gefiltert auf eure ${data.providerCount} Abos zusammen – was einer von euch hat, könnt ihr gemeinsam sehen.`
              : 'Ihr habt noch keine Abos verknüpft, deshalb ist nicht gefiltert.',
        }),
      ]),
      el('a.btn.btn-ghost', {
        href: `/friends/${friendId}/library`,
        'data-link': '',
        text: `Bibliothek von ${name}`,
      }),
    ]),

    // Die drei Arten von Vorschlägen, vom Eindeutigsten zum Vagesten.
    section(
      'Wollt ihr beide sehen',
      'Steht bei euch beiden auf der Liste und ist bei einem eurer Abos abrufbar.',
      data.bothWant,
    ),

    section(
      `Von ${name}s Liste`,
      'Steht auf seiner Liste, kennst du noch nicht – und ihr könnt es sehen.',
      data.fromTheirList,
    ),

    section(
      `${name}s Lieblinge`,
      'Hat er vollständig gesehen und hoch bewertet. Du kennst es noch nicht.',
      data.theirFavourites,
    ),

    nothing &&
      empty(
        '🤔',
        'Noch keine Vorschläge',
        `Sobald ihr beide ein paar Titel auf eure Listen setzt und eure Abos verknüpft habt, findet Streamo hier Gemeinsamkeiten.`,
      ),
  );
}

/**
 * Zeichnet die Bibliothek eines Freundes.
 *
 * @param {HTMLElement} container
 * @param {string} friendId
 */
async function renderFriendLibrary(container, friendId) {
  const data = await api.friends.library(friendId);
  const name = nameOf(data.friend);

  render(
    container,

    el('a', {
      href: `/friends/${friendId}`,
      'data-link': '',
      class: 'muted small',
      text: '← Zurück',
      style: { display: 'inline-block', marginBottom: '14px' },
    }),

    el('div.view-header', {}, [
      el('div', {}, [
        el('h1', { text: `Bibliothek von ${name}`, style: { marginBottom: '2px' } }),
        el('p.muted', {
          style: { margin: 0 },
          text: `${data.entries.length} Titel · Verfügbarkeit bezogen auf DEINE Abos`,
        }),
      ]),
    ]),

    data.entries.length > 0
      ? el(
          'div.grid',
          {},
          data.entries.map((entry) =>
            posterCard(entry, {
              action: el('div.muted.small', {
                style: { textAlign: 'center', marginTop: '5px' },
                text:
                  (STATUS_LABELS[entry.friendStatus] || entry.friendStatus) +
                  (entry.friendRating ? ` · ${entry.friendRating}/10` : '') +
                  (entry.inMyLibrary ? ' · auch bei dir' : ''),
              }),
            }),
          ),
        )
      : empty('📭', 'Leere Bibliothek', `${name} hat noch keine Titel aufgenommen.`),
  );
}

/**
 * Zeichnet die erhaltenen Empfehlungen.
 * @param {HTMLElement} container
 */
async function renderRecommendations(container) {
  const data = await api.friends.recommendations();
  const reload = () => renderRecommendations(container);

  // Beim Öffnen gelten alle als gelesen – man hat sie ja jetzt gesehen.
  api.friends.markRead().catch(() => {});

  render(
    container,

    el('a', {
      href: '/friends',
      'data-link': '',
      class: 'muted small',
      text: '← Alle Freunde',
      style: { display: 'inline-block', marginBottom: '14px' },
    }),

    el('h1', { text: 'Empfehlungen für dich' }),

    data.recommendations.length > 0
      ? el(
          'div',
          {},
          data.recommendations.map((rec) =>
            el(
              'div',
              {
                style: {
                  display: 'flex',
                  gap: '14px',
                  padding: '13px',
                  borderRadius: 'var(--radius)',
                  background: 'var(--surface)',
                  border: `1px solid ${rec.seen ? 'var(--surface-3)' : 'var(--accent)'}`,
                  marginBottom: '10px',
                },
              },
              [
                el(
                  'div',
                  {
                    style: { width: '62px', flexShrink: '0', cursor: 'pointer' },
                    onClick: () => navigateTo(`/show/${rec.mediaType}/${rec.tmdbId}`),
                  },
                  [
                    img(rec.posterPath, 'w154')
                      ? el('img', {
                          src: img(rec.posterPath, 'w154'),
                          alt: rec.title,
                          style: { borderRadius: '7px', width: '100%' },
                        })
                      : el('div.poster-placeholder', {
                          style: { height: '93px', borderRadius: '7px' },
                          text: rec.title,
                        }),
                  ],
                ),

                el('div', { style: { flex: '1', minWidth: '0' } }, [
                  el('div.muted.small', {
                    text: `${nameOf(rec.from)} empfiehlt · ${timeAgo(rec.createdAt)}`,
                  }),
                  el('div', {
                    style: { fontWeight: '600', cursor: 'pointer', margin: '2px 0' },
                    text: rec.title + (rec.year ? ` (${rec.year})` : ''),
                    onClick: () => navigateTo(`/show/${rec.mediaType}/${rec.tmdbId}`),
                  }),

                  // Die Begründung ist das Wertvollste an einer Empfehlung.
                  rec.message &&
                    el('div', {
                      style: {
                        marginTop: '6px',
                        padding: '8px 11px',
                        borderRadius: '7px',
                        background: 'var(--surface-2)',
                        fontSize: '13px',
                      },
                      text: `„${rec.message}"`,
                    }),

                  el('div', { style: { display: 'flex', gap: '7px', marginTop: '9px' } }, [
                    rec.inMyLibrary
                      ? el('span.muted.small', {
                          style: { padding: '6px 0' },
                          text: '✓ schon auf deiner Liste',
                        })
                      : el('button.btn.btn-sm.btn-primary', {
                          text: '+ Zur Bibliothek',
                          onClick: async (event) => {
                            event.currentTarget.disabled = true;
                            try {
                              await api.library.add(rec.tmdbId, rec.mediaType, 'watchlist');
                              toast('Hinzugefügt.', 'success');
                              reload();
                            } catch (error) {
                              toast(error.message, 'error');
                            }
                          },
                        }),

                    el('button.btn.btn-sm.btn-ghost', {
                      text: 'Erledigt',
                      title: 'Empfehlung aus der Liste nehmen',
                      onClick: async () => {
                        try {
                          await api.friends.dismissRecommendation(rec.id);
                          reload();
                        } catch (error) {
                          toast(error.message, 'error');
                        }
                      },
                    }),
                  ]),
                ]),
              ],
            ),
          ),
        )
      : empty(
          '💌',
          'Keine Empfehlungen',
          'Wenn dir jemand etwas empfiehlt, steht es hier.',
        ),
  );
}

/**
 * Einstiegspunkt. Der Router liefert die Kennung bzw. den Unterpfad mit.
 *
 * @param {HTMLElement} container
 * @param {{id?: string, sub?: string}} params
 */
export async function render_(container, params) {
  try {
    if (params?.id === 'recommendations') {
      await renderRecommendations(container);
    } else if (params?.id && params?.sub === 'library') {
      await renderFriendLibrary(container, params.id);
    } else if (params?.id) {
      await renderTogether(container, params.id);
    } else {
      await renderOverview(container);
    }
  } catch (error) {
    render(container, errorBox(error.message));
  }
}

export { render_ as render };
