/**
 * ---------------------------------------------------------------------------
 * public/js/views/collections.js – Filmreihen
 * ---------------------------------------------------------------------------
 * Adressen:
 *   /collections      – Übersicht aller Reihen
 *   /collections/:id  – eine Reihe mit ihren Filmen in der richtigen Ordnung
 *
 * Zwei Arten von Reihen, die hier nebeneinanderstehen:
 *   - Offizielle von TMDB ("Kingsman"). Sie erscheinen von selbst, sobald man
 *     einen ihrer Filme öffnet, und lassen sich nicht verändern.
 *   - Eigene ("Vorwissen für Spider-Man: Brand New Day"). Frei
 *     zusammenstellbar, frei sortierbar, mit Notiz je Eintrag.
 *
 * Verknüpfungen:
 *   - api.collections.* -> src/routes/collections.js
 *   - src/collections.js -> die Logik dahinter
 * ---------------------------------------------------------------------------
 */

import { api, img } from '../api.js';
import {
  el,
  render,
  empty,
  toast,
  formatRuntime,
  errorBox,
  announceAchievements,
  // Der Dialog zum Weiterschicken – WhatsApp, Telegram, E-Mail, Kopieren.
  shareSheet,
} from '../ui.js';
import { navigateTo } from '../router.js';

/**
 * Baut die Kachel einer Reihe für die Übersicht.
 * @param {object} collection Eintrag aus /api/collections
 * @returns {HTMLElement}
 */
function collectionCard(collection) {
  const poster = img(collection.posterPath, 'w342');
  const percent = collection.progress.percent;

  return el(
    'div.poster-card',
    {
      onClick: () => navigateTo(`/collections/${collection.id}`),
      title: collection.name,
    },
    [
      el('div.poster-wrap', {}, [
        poster
          ? el('img', { src: poster, alt: collection.name, loading: 'lazy' })
          : el('div.poster-placeholder', { text: collection.name }),

        // Eigene Reihen kennzeichnen – sonst weiß man nicht, welche man
        // bearbeiten kann.
        collection.isCustom && el('span.corner-badge', { text: 'Eigene' }),

        // Vollständig gesehen: das gleiche grüne Abzeichen wie bei Titeln,
        // die im eigenen Abo laufen.
        percent === 100 && el('span.corner-badge.included', { text: '✓ Komplett' }),
      ]),

      el('div.poster-title', { text: collection.name }),

      el('div.poster-meta', {}, [
        el('span', {
          text: `${collection.itemCount} ${collection.itemCount === 1 ? 'Teil' : 'Teile'}`,
        }),
        collection.progress.watched > 0 &&
          el('span', { text: `${collection.progress.watched} gesehen` }),
      ]),

      collection.itemCount > 0 &&
        el('div.progress-bar', { title: `${percent} % gesehen` }, [
          el('span', { style: { width: `${percent}%` } }),
        ]),
    ],
  );
}

/**
 * Zeichnet die Übersicht aller Reihen.
 * @param {HTMLElement} container
 */
async function renderOverview(container) {
  const data = await api.collections.list();

  const custom = data.collections.filter((c) => c.isCustom);
  const official = data.collections.filter((c) => !c.isCustom);

  /**
   * Legt eine neue eigene Reihe an und springt hinein.
   */
  const createCollection = async () => {
    const name = window.prompt(
      'Wie soll die Reihe heißen?',
      'Vorwissen für …',
    );
    if (!name) return;

    const description = window.prompt(
      'Kurze Beschreibung (optional) – wofür ist die Reihe gedacht?',
      '',
    );

    try {
      const created = await api.collections.create(name, description || undefined);
      toast('Reihe angelegt.', 'success');
      navigateTo(`/collections/${created.id}`);
    } catch (error) {
      toast(error.message, 'error');
    }
  };

  /**
   * Sucht offizielle Reihen bei TMDB und übernimmt die gewählte.
   */
  const importCollection = async () => {
    const query = window.prompt('Nach welcher Filmreihe suchst du?', 'Kingsman');
    if (!query) return;

    try {
      const found = await api.collections.search(query);

      if (found.results.length === 0) {
        toast(`Keine Filmreihe zu „${query}" gefunden.`, 'error');
        return;
      }

      // Bei einem eindeutigen Treffer direkt übernehmen, sonst zur Auswahl
      // stellen. Eine Liste in einem prompt() ist unschön, aber ohne eigenes
      // Auswahlfenster der direkteste Weg.
      let chosen = found.results[0];

      if (found.results.length > 1) {
        const list = found.results
          .slice(0, 9)
          .map((row, index) => `${index + 1}. ${row.name}`)
          .join('\n');

        const answer = window.prompt(`Welche Reihe?\n\n${list}\n\nNummer eingeben:`, '1');
        if (!answer) return;

        chosen = found.results[Number(answer) - 1];
        if (!chosen) return toast('Ungültige Auswahl.', 'error');
      }

      const result = await api.collections.import(chosen.tmdbId);
      toast(`„${result.collection.name}" übernommen.`, 'success');
      navigateTo(`/collections/${result.collection.id}`);
    } catch (error) {
      toast(error.message, 'error');
    }
  };

  render(
    container,

    el('div.view-header', {}, [
      el('div', {}, [
        el('h1', { text: 'Filmreihen', style: { marginBottom: '2px' } }),
        el('p.muted', {
          style: { margin: 0 },
          text: 'Zusammengehörige Filme in der richtigen Reihenfolge – offizielle Reihen und deine eigenen.',
        }),
      ]),
      el('div', { style: { display: 'flex', gap: '9px' } }, [
        el('button.btn.btn-ghost', { text: '+ Offizielle Reihe', onClick: importCollection }),
        el('button.btn.btn-primary', { text: '+ Eigene Reihe', onClick: createCollection }),
      ]),
    ]),

    // --- Eigene Reihen ---
    custom.length > 0 &&
      el('section', { style: { marginBottom: '34px' } }, [
        el('h2', { text: `Deine Reihen (${custom.length})` }),
        el('div.grid', {}, custom.map(collectionCard)),
      ]),

    // --- Offizielle Reihen ---
    official.length > 0 &&
      el('section', {}, [
        el('h2', { text: `Offizielle Filmreihen (${official.length})` }),
        el('p.muted.small', {
          text: 'Erscheinen von selbst, sobald du einen Film daraus öffnest.',
        }),
        el('div.grid', {}, official.map(collectionCard)),
      ]),

    data.collections.length === 0 &&
      empty(
        '🎬',
        'Noch keine Filmreihen',
        'Offizielle Reihen wie Kingsman erscheinen automatisch, sobald du einen Film daraus öffnest. Oder stell dir selbst eine zusammen – etwa als Vorwissen-Liste.',
        el('button.btn.btn-primary', { text: '+ Eigene Reihe anlegen', onClick: createCollection }),
      ),
  );
}

/**
 * Zeichnet eine einzelne Reihe mit ihren Filmen.
 *
 * @param {HTMLElement} container
 * @param {string} id Kennung der Reihe
 */
async function renderDetail(container, id) {
  const collection = await api.collections.get(id);

  /** Zeichnet die Seite nach einer Änderung neu. */
  const reload = () => renderDetail(container, id);

  /**
   * Baut die Zeile eines Films in der Reihe.
   *
   * Nummeriert, damit die Ordnung sofort erkennbar ist – bei einer Reihe ist
   * genau das die zentrale Information.
   *
   * @param {object} item
   * @param {number} index
   * @returns {HTMLElement}
   */
  const itemRow = (item, index) => {
    const poster = img(item.posterPath, 'w154');

    // Wo läuft der Film? Bei einer Reihe die zweitwichtigste Frage – man will
    // wissen, ob man alle Teile überhaupt sehen kann.
    const offers = item.availability?.offers?.flatrate || [];

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
        // Nummer
        el('div', {
          style: {
            fontSize: '20px',
            fontWeight: '700',
            color: item.watched ? 'var(--success)' : 'var(--text-faint)',
            minWidth: '30px',
            textAlign: 'center',
            paddingTop: '4px',
          },
          text: item.watched ? '✓' : String(index + 1),
        }),

        // Poster
        el(
          'div',
          {
            style: { width: '62px', flexShrink: '0', cursor: 'pointer' },
            onClick: () => navigateTo(`/show/${item.mediaType}/${item.tmdbId}`),
          },
          [
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
          ],
        ),

        // Angaben
        el('div', { style: { flex: '1', minWidth: '0' } }, [
          el('div', {
            style: { fontWeight: '600', cursor: 'pointer' },
            text: item.title,
            onClick: () => navigateTo(`/show/${item.mediaType}/${item.tmdbId}`),
          }),

          el('div.muted.small', {
            text: [
              item.year,
              item.runtime ? formatRuntime(item.runtime) : null,
              item.voteAverage > 0 ? `★ ${item.voteAverage.toFixed(1)}` : null,
            ]
              .filter(Boolean)
              .join(' · '),
          }),

          // Notiz – der eigentliche Wert einer Vorwissen-Liste.
          item.note &&
            el('div', {
              style: {
                marginTop: '6px',
                padding: '7px 10px',
                borderRadius: '7px',
                background: 'var(--surface-2)',
                fontSize: '13px',
              },
              text: item.note,
            }),

          // Wo läuft er?
          offers.length > 0
            ? el(
                'div',
                { style: { display: 'flex', gap: '5px', marginTop: '8px', flexWrap: 'wrap' } },
                offers.slice(0, 5).map((offer) =>
                  el(
                    `div.provider-logo${offer.subscribed ? '.subscribed' : ''}`,
                    { title: offer.subscribed ? `${offer.name} – dein Abo` : offer.name },
                    [
                      img(offer.logo_path, 'w92') &&
                        el('img', { src: img(offer.logo_path, 'w92'), alt: offer.name }),
                    ],
                  ),
                ),
              )
            : el('div.muted.small', {
                style: { marginTop: '8px' },
                text: 'Derzeit in keinem Abo verfügbar',
              }),
        ]),

        // Einzeln hinzufügen – für alle Reihen, auch die offiziellen.
        // Steht getrennt von den Sortier-Knöpfen, weil es eine andere Art von
        // Aktion ist: Die eine ändert die Reihe, die andere die eigene Liste.
        el('div', { style: { display: 'flex', flexDirection: 'column', gap: '5px' } }, [
          item.inLibrary
            ? el('span.muted.small', {
                style: { textAlign: 'center', padding: '6px 0', whiteSpace: 'nowrap' },
                text: item.watched ? '✓ gesehen' : '✓ auf Liste',
              })
            : el('button.btn.btn-sm', {
                text: '+',
                title: 'In die Bibliothek aufnehmen',
                style: { minWidth: '34px' },
                onClick: async (event) => {
                  event.currentTarget.disabled = true;

                  try {
                    const result = await api.library.add(item.tmdbId, item.mediaType, 'watchlist');
                    toast(`„${item.title}" hinzugefügt.`, 'success');
                    announceAchievements(result.unlocked);
                    reload();
                  } catch (error) {
                    toast(error.message, 'error');
                    event.currentTarget.disabled = false;
                  }
                },
              }),
        ]),

        // Sortieren und Entfernen – nur bei eigenen Reihen.
        collection.isCustom &&
          el('div', { style: { display: 'flex', flexDirection: 'column', gap: '5px' } }, [
            el('button.btn.btn-sm.btn-ghost', {
              text: '↑',
              title: 'Nach oben',
              disabled: index === 0,
              onClick: async () => {
                // Die Reihenfolge wird vollständig neu geschickt – der Server
                // nummeriert daraufhin durch.
                const ids = collection.items.map((i) => i.showId);
                [ids[index - 1], ids[index]] = [ids[index], ids[index - 1]];

                try {
                  await api.collections.reorder(collection.id, ids);
                  reload();
                } catch (error) {
                  toast(error.message, 'error');
                }
              },
            }),
            el('button.btn.btn-sm.btn-ghost', {
              text: '↓',
              title: 'Nach unten',
              disabled: index === collection.items.length - 1,
              onClick: async () => {
                const ids = collection.items.map((i) => i.showId);
                [ids[index], ids[index + 1]] = [ids[index + 1], ids[index]];

                try {
                  await api.collections.reorder(collection.id, ids);
                  reload();
                } catch (error) {
                  toast(error.message, 'error');
                }
              },
            }),
            el('button.btn.btn-sm.btn-danger', {
              text: '×',
              title: 'Aus der Reihe entfernen',
              onClick: async () => {
                try {
                  await api.collections.removeItem(collection.id, item.showId);
                  reload();
                } catch (error) {
                  toast(error.message, 'error');
                }
              },
            }),
          ]),
      ],
    );
  };

  /**
   * Gibt die Reihe frei und bietet an, den Link zu verschicken.
   *
   * Auf dem Handy öffnet navigator.share die gewohnte Teilen-Auswahl des
   * Systems – dort erscheinen WhatsApp, Signal, Telegram, Mail und alles
   * andere, was installiert ist. Auf dem Rechner gibt es diese Auswahl meist
   * nicht; dort wird der Link in die Zwischenablage gelegt.
   *
   * @param {object} coll Die Reihe
   */
  const shareCollection = async (coll) => {
    try {
      const { url } = await api.collections.share(coll.id);

      const count = coll.items?.length ?? coll.itemCount ?? 0;

      // Der Text, der in der Nachricht vor dem Link steht.
      const text =
        `Diese Liste solltest du dir ansehen: „${coll.name}"` +
        (count > 0 ? ` (${count} Titel)` : '');

      // Alles Weitere übernimmt der gemeinsame Dialog aus ui.js: Er nutzt die
      // Teilen-Auswahl des Systems, wenn es sie gibt, und bietet sonst
      // WhatsApp, Telegram, E-Mail und einen Kopier-Knopf an.
      await shareSheet({ url, title: `„${coll.name}" teilen`, text });
    } catch (error) {
      toast(error.message, 'error');
    }
  };

  /**
   * Sucht einen Film und nimmt ihn in die Reihe auf.
   */
  const addFilm = async () => {
    const query = window.prompt('Welchen Titel möchtest du aufnehmen?');
    if (!query) return;

    try {
      const found = await api.search.query(query);
      const results = found.results.slice(0, 9);

      if (results.length === 0) return toast('Nichts gefunden.', 'error');

      let chosen = results[0];

      if (results.length > 1) {
        const list = results
          .map((row, index) => `${index + 1}. ${row.title}${row.year ? ` (${row.year})` : ''}`)
          .join('\n');

        const answer = window.prompt(`Welchen?\n\n${list}\n\nNummer eingeben:`, '1');
        if (!answer) return;

        chosen = results[Number(answer) - 1];
        if (!chosen) return toast('Ungültige Auswahl.', 'error');
      }

      // Die Notiz ist der Grund, warum eine Vorwissen-Liste nützlich ist.
      const note = window.prompt(
        `Hinweis zu „${chosen.title}" (optional):\nz. B. „nur die Nachspannszene nötig"`,
        '',
      );

      await api.collections.addItem(collection.id, chosen.tmdbId, chosen.mediaType, note || undefined);
      toast(`„${chosen.title}" aufgenommen.`, 'success');
      reload();
    } catch (error) {
      toast(error.message, 'error');
    }
  };

  render(
    container,

    el('a', {
      href: '/collections',
      'data-link': '',
      class: 'muted small',
      text: '← Alle Filmreihen',
      style: { display: 'inline-block', marginBottom: '14px' },
    }),

    el('div.view-header', {}, [
      el('div', {}, [
        el('h1', { text: collection.name, style: { marginBottom: '4px' } }),
        el('p.muted', {
          style: { margin: 0 },
          text: [
            `${collection.items.length} ${collection.items.length === 1 ? 'Teil' : 'Teile'}`,
            `${collection.progress.watched} gesehen`,
            collection.totalRuntime > 0
              ? `${formatRuntime(collection.totalRuntime)} am Stück`
              : null,
          ]
            .filter(Boolean)
            .join(' · '),
        }),
      ]),

      el('div', { style: { display: 'flex', gap: '9px', flexWrap: 'wrap' } }, [
        // Die ganze Reihe auf die Liste setzen – der naheliegende Schritt,
        // nachdem man sie entdeckt hat. Nur anbieten, wenn überhaupt etwas
        // fehlt; sonst wäre der Knopf wirkungslos.
        collection.items.some((item) => !item.inLibrary) &&
          el('button.btn.btn-primary', {
            text: `+ Alle ${collection.items.filter((i) => !i.inLibrary).length} zur Bibliothek`,
            title: 'Nimmt alle noch fehlenden Teile in deine Bibliothek auf',
            onClick: async (event) => {
              event.currentTarget.disabled = true;
              event.currentTarget.textContent = 'Wird hinzugefügt …';

              try {
                const result = await api.collections.addToLibrary(collection.id);

                toast(
                  result.added === 0
                    ? 'Alle Teile waren bereits in deiner Bibliothek.'
                    : `${result.added} ${result.added === 1 ? 'Teil' : 'Teile'} hinzugefügt.`,
                  'success',
                );

                announceAchievements(result.unlocked);
                reload();
              } catch (error) {
                toast(error.message, 'error');
                reload();
              }
            },
          }),

        collection.isCustom &&
          el('button.btn.btn-ghost', { text: '+ Titel aufnehmen', onClick: addFilm }),

        // Teilen – für ALLE Reihen, auch die offiziellen von TMDB.
        //
        // Früher stand hier "collection.isCustom &&", mit der Begründung, eine
        // offizielle Reihe kenne der Empfänger ohnehin. Das war falsch
        // gedacht: Wer einen Link verschickt, teilt keine Neuigkeit, sondern
        // einen Vorschlag – "schau dir Kingsman an, am besten in dieser
        // Reihenfolge". Ausgerechnet bei den Reihen, die man am ehesten
        // weiterschickt, fehlte deshalb der Knopf.
        el('button.btn.btn-ghost', {
          text: '↗ Teilen',
          title: 'Einen Link erzeugen, den du per WhatsApp weiterschicken kannst',
          onClick: () => shareCollection(collection),
        }),

        collection.isCustom &&
          el('button.btn.btn-danger', {
            text: 'Reihe löschen',
            onClick: async () => {
              if (!window.confirm(`„${collection.name}" wirklich löschen? Die Filme selbst bleiben erhalten.`))
                return;

              try {
                await api.collections.remove(collection.id);
                toast('Reihe gelöscht.');
                navigateTo('/collections');
              } catch (error) {
                toast(error.message, 'error');
              }
            },
          }),
      ]),
    ]),

    // Beschreibung – bei eigenen Reihen die Stelle für "wofür ist das gut".
    collection.description &&
      el('div.card', { style: { marginBottom: '20px' } }, [
        el('p', { style: { margin: 0 }, text: collection.description }),
      ]),

    // Fortschritt über die ganze Reihe.
    collection.items.length > 0 &&
      el('div', { style: { marginBottom: '22px' } }, [
        el('div.progress-bar', { style: { height: '8px' } }, [
          el('span', { style: { width: `${collection.progress.percent}%` } }),
        ]),
      ]),

    // Die Filme in ihrer Ordnung.
    collection.items.length > 0
      ? el('div', {}, collection.items.map(itemRow))
      : empty(
          '📽️',
          'Noch keine Titel',
          collection.isCustom
            ? 'Nimm Filme auf und bring sie in die Reihenfolge, in der man sie sehen sollte.'
            : 'Diese Reihe ist leer.',
          collection.isCustom
            ? el('button.btn.btn-primary', { text: '+ Titel aufnehmen', onClick: addFilm })
            : null,
        ),

    // Bei eigenen Reihen erklären, wie sortiert wird.
    collection.isCustom &&
      collection.items.length > 1 &&
      el('p.hint', {
        style: { marginTop: '16px' },
        text: 'Mit den Pfeilen änderst du die Reihenfolge. Sie bestimmt, in welcher Ordnung die Titel gesehen werden sollten.',
      }),
  );
}

/**
 * Einstiegspunkt der Ansicht.
 *
 * Der Router liefert bei /collections/:id die Kennung in params mit; ohne sie
 * ist die Übersicht gemeint.
 *
 * @param {HTMLElement} container
 * @param {{id?: string}} params
 */
export async function render_(container, params) {
  try {
    if (params?.id) {
      await renderDetail(container, params.id);
    } else {
      await renderOverview(container);
    }
  } catch (error) {
    render(container, errorBox(error.message));
  }
}

export { render_ as render };
