/**
 * ---------------------------------------------------------------------------
 * public/js/views/detail.js – Detailseite einer Serie oder eines Films
 * ---------------------------------------------------------------------------
 * Adresse: /show/tv/1399
 *
 * Die wichtigste Seite der Anwendung. Sie zeigt:
 *   - Titelbild, Beschreibung, Genres, Bewertung
 *   - WO der Titel läuft, getrennt nach Abo / kostenlos / leihen / kaufen,
 *     mit grüner Hervorhebung für die eigenen Abos
 *   - Status, Bewertung, Favorit, Notiz
 *   - Staffeln und Episoden mit Abhak-Funktion
 *   - Empfehlungen
 *
 * Verknüpfungen:
 *   - api.shows.detail()     -> src/routes/shows.js
 *   - api.shows.season()     -> Episoden einer Staffel (Lazy Loading)
 *   - api.shows.setWatched() -> Tabelle watched_episodes
 *   - api.library.*          -> Aufnahme in die Bibliothek und Änderungen
 * ---------------------------------------------------------------------------
 */

import { api, img } from '../api.js';
import {
  el,
  render,
  loading,
  toast,
  posterGrid,
  formatDate,
  formatRuntime,
  timeAgo,
  STATUS_LABELS,
  announceAchievements,
  OFFER_LABELS,
} from '../ui.js';

/**
 * Baut den Verfügbarkeits-Block: "Wo kann ich das sehen?"
 *
 * Die Angebote sind nach Art gruppiert. Angebote bei einem eigenen Abo werden
 * grün umrandet und mit dem Zusatz "dein Abo" versehen – das ist die konkrete
 * Antwort auf die Ausgangsfrage des Projekts.
 *
 * @param {object} availability Ergebnis von buildAvailabilityView (Server)
 * @param {string} region       Für welches Land die Angaben gelten
 * @returns {HTMLElement}
 */
function availabilityBlock(availability, region) {
  const groups = Object.entries(availability.offers || {});

  if (groups.length === 0) {
    return el('div.card', {}, [
      el('h2', { text: 'Wo kann ich das sehen?' }),
      el('p.muted', {
        text: `Für ${region} kennt JustWatch derzeit kein Streaming-Angebot. Vielleicht läuft der Titel im linearen Fernsehen oder ist noch nicht erschienen.`,
      }),
    ]);
  }

  return el('div.availability-section', {}, [
    el('div.view-header', { style: { marginBottom: '12px' } }, [
      el('h2', { text: 'Wo kann ich das sehen?', style: { margin: 0 } }),
      el('span.muted.small', { text: `Region ${region}` }),
    ]),

    ...groups.map(([offerType, offers]) =>
      el('div.offer-group', {}, [
        el('h3', { text: OFFER_LABELS[offerType] || offerType }),
        el(
          'div.offer-list',
          {},
          offers.map((offer) =>
            // Der Link führt zur JustWatch-Seite des Titels. TMDB liefert
            // genau einen Link pro Region, keinen je Anbieter – deshalb landen
            // alle Kacheln auf derselben Übersicht.
            el(
              `a.offer${offer.subscribed ? '.subscribed' : ''}`,
              {
                href: offer.link || '#',
                target: '_blank',
                rel: 'noopener noreferrer',
                title: `${offer.name} – bei JustWatch öffnen`,
              },
              [
                img(offer.logo_path, 'w92') &&
                  el('img', { src: img(offer.logo_path, 'w92'), alt: offer.name }),
                el('span', { text: offer.name }),
                // Nur bei Abo-Angeboten sinnvoll: Bei "leihen" hilft ein Abo nicht.
                offer.subscribed &&
                  ['flatrate', 'free', 'ads'].includes(offerType) &&
                  el('span.offer-tag', { text: 'dein Abo' }),
              ],
            ),
          ),
        ),
      ]),
    ),
  ]);
}

/**
 * Baut den Bereich mit Staffeln und Episoden.
 *
 * Episoden werden erst beim Anklicken einer Staffel geladen (ein Aufruf je
 * Staffel, danach lokal gespeichert). Das hält die Detailseite schnell, auch
 * bei Serien mit 20 Staffeln.
 *
 * @param {object} data Antwort von api.shows.detail()
 * @param {object} refs Veränderliche Verweise, u. a. der Fortschrittsbalken
 * @returns {HTMLElement}
 */
function seasonsBlock(data, refs) {
  const show = data.show;

  // Filme und Serien ohne Staffelangabe bekommen diesen Block gar nicht.
  if (show.mediaType !== 'tv' || !show.seasons) return el('div');

  // Staffelnummern 1..n. Specials (Staffel 0) blenden wir aus – sie
  // verwirren die Fortschrittsrechnung mehr, als sie nützen.
  const seasonNumbers = Array.from({ length: show.seasons }, (_, i) => i + 1);

  const episodeSlot = el('div.episode-list');
  const tabs = el('div.season-tabs');

  /**
   * Lädt eine Staffel und zeichnet ihre Episoden.
   * @param {number} seasonNumber
   */
  const loadSeason = async (seasonNumber) => {
    // Aktiven Reiter markieren.
    for (const tab of tabs.children) {
      tab.classList.toggle('active', Number(tab.dataset.season) === seasonNumber);
    }

    render(episodeSlot, loading(`Staffel ${seasonNumber} wird geladen …`));

    try {
      const season = await api.shows.season(show.mediaType, show.tmdbId, seasonNumber);

      // Knopf "ganze Staffel abhaken" – der schnellste Weg, eine bereits
      // gesehene Serie nachzutragen.
      const allWatched = season.episodes.every((ep) => ep.watched || ep.upcoming);

      const seasonAction = el('button.btn.btn-sm.btn-ghost', {
        text: allWatched ? 'Staffel zurücksetzen' : 'Ganze Staffel abhaken',
        onClick: async () => {
          try {
            const result = await api.shows.setWatched(show.showId, {
              seasonNumber,
              watched: !allWatched,
            });
            refs.updateProgress(result.progress);
            announceAchievements(result.unlocked);
            loadSeason(seasonNumber); // neu zeichnen
          } catch (error) {
            toast(error.message, 'error');
          }
        },
      });

      render(
        episodeSlot,
        el(
          'div',
          { style: { display: 'flex', justifyContent: 'flex-end', marginBottom: '8px' } },
          [seasonAction],
        ),
        ...season.episodes.map((ep) => {
          const check = el(
            `button.episode-check${ep.watched ? '.checked' : ''}`,
            {
              text: '✓',
              disabled: ep.upcoming,
              title: ep.upcoming ? 'Noch nicht ausgestrahlt' : 'Als gesehen markieren',
            },
          );

          const row = el(
            `div.episode${ep.watched ? '.watched' : ''}${ep.upcoming ? '.upcoming' : ''}`,
            {},
            [
              check,
              el('div.episode-number', { text: `S${ep.seasonNumber}E${ep.episodeNumber}` }),
              el('div.episode-body', {}, [
                el('div.episode-title', { text: ep.name || `Episode ${ep.episodeNumber}` }),
                el('div.episode-date', {
                  text: [
                    ep.airDate ? formatDate(ep.airDate) : 'Datum unbekannt',
                    ep.runtime ? `${ep.runtime} Min.` : null,
                  ]
                    .filter(Boolean)
                    .join(' · '),
                }),
              ]),
            ],
          );

          // Klick auf die Checkbox: einzelne Episode umschalten.
          check.addEventListener('click', async () => {
            if (ep.upcoming) return;

            const next = !ep.watched;
            // Sofort umschalten (optimistische Anzeige), damit sich das
            // Abhaken einer ganzen Staffel flüssig anfühlt.
            check.classList.toggle('checked', next);
            row.classList.toggle('watched', next);
            ep.watched = next;

            try {
              const result = await api.shows.setWatched(show.showId, {
                episodeId: ep.id,
                watched: next,
              });
              refs.updateProgress(result.progress);
              announceAchievements(result.unlocked);
            } catch (error) {
              // Fehlgeschlagen -> Anzeige zurückdrehen.
              check.classList.toggle('checked', !next);
              row.classList.toggle('watched', !next);
              ep.watched = !next;
              toast(error.message, 'error');
            }
          });

          // Klick auf die Zeile (nicht auf die Checkbox): alles bis hierhin
          // als gesehen markieren. Der schnelle Weg für Wiedereinsteiger.
          row.addEventListener('click', async (event) => {
            if (event.target === check || ep.upcoming) return;

            try {
              const result = await api.shows.setWatched(show.showId, {
                upToEpisodeId: ep.id,
                watched: true,
              });
              refs.updateProgress(result.progress);
              announceAchievements(result.unlocked);
              toast(`${result.affected} Episoden als gesehen markiert.`, 'success');
              loadSeason(seasonNumber);
            } catch (error) {
              toast(error.message, 'error');
            }
          });

          return row;
        }),
      );
    } catch (error) {
      render(episodeSlot, el('p.muted', { text: `Staffel nicht ladbar: ${error.message}` }));
    }
  };

  // Reiter für jede Staffel bauen.
  for (const number of seasonNumbers) {
    // Fortschritt je Staffel aus seasonStats, falls die Staffel schon einmal
    // geladen wurde.
    const stat = data.seasonStats.find((s) => s.season_number === number);
    const label =
      stat && stat.episode_count > 0
        ? `Staffel ${number} (${stat.watched_count}/${stat.episode_count})`
        : `Staffel ${number}`;

    tabs.append(
      el('button.chip', {
        text: label,
        dataset: { season: String(number) },
        onClick: () => loadSeason(number),
      }),
    );
  }

  // Die erste ungesehene Staffel automatisch öffnen – das ist meistens die,
  // die den Benutzer interessiert.
  const firstUnfinished =
    data.seasonStats.find((s) => s.watched_count < s.episode_count)?.season_number ?? 1;
  loadSeason(firstUnfinished);

  return el('section', { style: { marginTop: '30px' } }, [
    el('h2', { text: 'Episoden' }),
    tabs,
    episodeSlot,
  ]);
}

/**
 * Zeichnet die Detailseite.
 * @param {HTMLElement} container
 * @param {{mediaType: string, tmdbId: string}} params aus der Adresse
 */
export async function render_(container, params) {
  const data = await api.shows.detail(params.mediaType, params.tmdbId);
  const show = data.show;

  // ------------------------------------------------------------------------
  // Fortschrittsanzeige – wird von den Episoden-Aktionen aktualisiert.
  // ------------------------------------------------------------------------
  const progressText = el('span.muted.small');
  const progressFill = el('span');

  const progressBox = el(
    'div',
    { style: { marginTop: '14px', maxWidth: '380px' } },
    [progressText, el('div.progress-bar', { style: { height: '6px' } }, [progressFill])],
  );

  /**
   * Schreibt einen neuen Fortschrittswert in die Anzeige.
   * @param {{watched:number,total:number,percent:number}} progress
   */
  const updateProgress = (progress) => {
    progressText.textContent = `${progress.watched} von ${progress.total || '?'} Episoden gesehen (${progress.percent} %)`;
    progressFill.style.width = `${progress.percent}%`;
  };
  updateProgress(data.progress);

  // ------------------------------------------------------------------------
  // Aktionsknöpfe: hinzufügen / Status / Favorit / entfernen
  // ------------------------------------------------------------------------
  const actionSlot = el('div.detail-actions');

  /** Zeichnet die Aktionsleiste passend zum aktuellen Bibliotheksstatus. */
  const renderActions = () => {
    if (!data.library.inLibrary) {
      render(
        actionSlot,
        el('button.btn.btn-primary', {
          text: '+ Zur Bibliothek hinzufügen',
          onClick: async (event) => {
            event.target.disabled = true;
            try {
              await api.library.add(show.tmdbId, show.mediaType, 'watchlist');
              data.library = { inLibrary: true, status: 'watchlist', favorite: false };
              renderActions();
              toast('Zur Bibliothek hinzugefügt.', 'success');
            } catch (error) {
              event.target.disabled = false;
              toast(error.message, 'error');
            }
          },
        }),
      );
      return;
    }

    render(
      actionSlot,
      // Statusauswahl
      el(
        'select',
        {
          style: { width: 'auto', height: '38px' },
          onChange: async (event) => {
            try {
              await api.library.update(show.showId, { status: event.target.value });
              data.library.status = event.target.value;
              toast(`Status: ${STATUS_LABELS[event.target.value]}`, 'success');
            } catch (error) {
              toast(error.message, 'error');
            }
          },
        },
        Object.entries(STATUS_LABELS).map(([value, label]) =>
          el('option', { value, text: label, selected: data.library.status === value }),
        ),
      ),

      // Favorit
      el('button.btn', {
        text: data.library.favorite ? '♥ Favorit' : '♡ Favorit',
        onClick: async (event) => {
          const next = !data.library.favorite;
          try {
            await api.library.update(show.showId, { favorite: next });
            data.library.favorite = next;
            event.target.textContent = next ? '♥ Favorit' : '♡ Favorit';
          } catch (error) {
            toast(error.message, 'error');
          }
        },
      }),

      // Eigene Bewertung 1–10
      el(
        'select',
        {
          style: { width: 'auto', height: '38px' },
          title: 'Meine Bewertung',
          onChange: async (event) => {
            const value = event.target.value === '' ? null : Number(event.target.value);
            try {
              await api.library.update(show.showId, { rating: value });
              toast(value ? `Bewertet mit ${value}/10.` : 'Bewertung entfernt.', 'success');
            } catch (error) {
              toast(error.message, 'error');
            }
          },
        },
        [
          el('option', { value: '', text: 'Bewerten …' }),
          ...Array.from({ length: 10 }, (_, i) => 10 - i).map((n) =>
            el('option', {
              value: String(n),
              text: `${n}/10`,
              selected: data.library.rating === n,
            }),
          ),
        ],
      ),

      // Verfügbarkeit sofort neu prüfen.
      el('button.btn.btn-ghost', {
        text: '↻ Aktualisieren',
        title: 'Streaming-Verfügbarkeit jetzt neu bei TMDB abfragen',
        onClick: async (event) => {
          event.target.disabled = true;
          event.target.textContent = 'Prüfe …';
          try {
            const result = await api.shows.refresh(show.showId);
            render(availabilitySlot, availabilityBlock(result.availability, data.region));
            toast('Verfügbarkeit aktualisiert.', 'success');
          } catch (error) {
            toast(error.message, 'error');
          } finally {
            event.target.disabled = false;
            event.target.textContent = '↻ Aktualisieren';
          }
        },
      }),

      // Entfernen
      el('button.btn.btn-danger', {
        text: 'Entfernen',
        onClick: async () => {
          if (!window.confirm(`„${show.title}" wirklich aus der Bibliothek entfernen?`)) return;
          try {
            await api.library.remove(show.showId);
            data.library = { inLibrary: false };
            renderActions();
            toast('Aus der Bibliothek entfernt.');
          } catch (error) {
            toast(error.message, 'error');
          }
        },
      }),
    );
  };

  const availabilitySlot = el('div', {}, [availabilityBlock(data.availability, data.region)]);

  renderActions();

  // ------------------------------------------------------------------------
  // Seite zusammensetzen
  // ------------------------------------------------------------------------
  const backdrop = img(show.backdropPath, 'w1280');

  render(
    container,

    // --- Kopfbereich mit Titelbild ---
    el(
      'div.detail-hero',
      // Das Hintergrundbild wird per style gesetzt, weil die URL erst zur
      // Laufzeit bekannt ist.
      backdrop ? { style: { backgroundImage: `url(${backdrop})` } } : {},
      [
        el('div.detail-hero-inner', {}, [
          el('div.detail-poster', {}, [
            img(show.posterPath, 'w342')
              ? el('img', { src: img(show.posterPath, 'w342'), alt: show.title })
              : el('div.poster-placeholder', { text: show.title }),
          ]),

          el('div.detail-info', {}, [
            el('h1', { text: show.title }),

            // Originaltitel nur zeigen, wenn er abweicht.
            show.originalTitle &&
              show.originalTitle !== show.title &&
              el('p.muted', { style: { marginTop: '-6px' }, text: show.originalTitle }),

            el('div.detail-meta', {}, [
              show.firstAirDate && el('span', { text: show.firstAirDate.slice(0, 4) }),
              show.mediaType === 'tv'
                ? el('span', {
                    text: `${show.seasons ?? '?'} Staffeln · ${show.episodes ?? '?'} Episoden`,
                  })
                : el('span', { text: formatRuntime(show.runtime) }),
              show.voteAverage > 0 && el('span', { text: `★ ${show.voteAverage.toFixed(1)}` }),
              show.status && el('span', { text: show.status }),
            ]),

            show.genres.length > 0 &&
              el('div.detail-meta', {}, [el('span', { text: show.genres.join(' · ') })]),

            el('p', { text: show.overview || 'Keine Beschreibung vorhanden.' }),

            actionSlot,

            // Fortschritt nur für Serien in der Bibliothek.
            show.mediaType === 'tv' && data.library.inLibrary && progressBox,
          ]),
        ]),
      ],
    ),

    // --- Wo kann ich das sehen? ---
    availabilitySlot,

    // Wann wurde die Verfügbarkeit zuletzt geprüft? Schafft Vertrauen in die
    // Angaben und erklärt, warum etwas eventuell veraltet ist.
    el('p.muted.small', {
      text: `Verfügbarkeit zuletzt geprüft: ${timeAgo(data.availability.offers && Object.values(data.availability.offers)[0]?.[0]?.updated_at)}`,
    }),

    // --- Episoden ---
    seasonsBlock(data, { updateProgress }),

    // --- Empfehlungen ---
    data.recommendations.length > 0 &&
      el('section', { style: { marginTop: '38px' } }, [
        el('h2', { text: 'Ähnliche Titel' }),
        posterGrid(data.recommendations),
      ]),
  );
}

export { render_ as render };
