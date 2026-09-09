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
  // Fenster im Stil der Seite statt der grauen Browser-Dialoge.
  askConfirm,
  modal,
} from '../ui.js';

/**
 * Die Wochentage für den Sehplan.
 *
 * 1 = Montag bis 7 = Sonntag nach ISO-8601 – dieselbe Zählung wie in der
 * Datenbank und in src/watchplan.js. Montag zuerst, so ist es hierzulande
 * üblich.
 */
const WOCHENTAGE = [
  [1, 'Mo'],
  [2, 'Di'],
  [3, 'Mi'],
  [4, 'Do'],
  [5, 'Fr'],
  [6, 'Sa'],
  [7, 'So'],
];

/**
 * Fasst einen Sehplan in einer Zeile zusammen: "Mo, Do · 2 Folgen".
 *
 * @param {object} plan
 * @returns {string}
 */
function planKurz(plan) {
  const tage = plan.weekdays
    .map((nummer) => WOCHENTAGE.find(([n]) => n === nummer)?.[1])
    .filter(Boolean)
    .join(', ');

  const folgen = `${plan.episodesPerRun} ${plan.episodesPerRun === 1 ? 'Folge' : 'Folgen'}`;

  return `${tage} · ${folgen}`;
}

/**
 * Baut den Verfügbarkeits-Block: "Wo kann ich das sehen?"
 *
 * Die Angebote sind nach Art gruppiert. Angebote bei einem eigenen Abo werden
 * grün umrandet und mit dem Zusatz "dein Abo" versehen – das ist die konkrete
 * Antwort auf die Ausgangsfrage des Projekts.
 *
 * Ein bekanntes Enddatum ("noch 5 Tage") steht als Zusatz am jeweiligen
 * Anbieter. Es kommt nicht von TMDB - dort gibt es kein solches Feld -,
 * sondern wurde von Hand eingetragen.
 *
 * @param {object} availability Ergebnis von buildAvailabilityView (Server)
 * @param {string} region       Für welches Land die Angaben gelten
 * @param {Function} [onSetUntil] Öffnet den Dialog zum Eintragen eines Datums
 * @returns {HTMLElement}
 */
function availabilityBlock(availability, region, onSetUntil) {
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

                // Das bekannte Enddatum, falls jemand eines eingetragen hat.
                offer.availableUntil &&
                  el('span.offer-tag.until', {
                    text:
                      offer.daysLeft <= 0
                        ? 'letzter Tag'
                        : offer.daysLeft === 1
                          ? 'noch 1 Tag'
                          : `noch ${offer.daysLeft} Tage`,
                    title: `Bis ${formatDate(offer.availableUntil)}`,
                  }),
              ],
            ),
          ),
        ),
      ]),
    ),

    // ------------------------------------------------------------------
    // Ein Enddatum eintragen
    // ------------------------------------------------------------------
    // Der einzige Weg, an diese Information zu kommen: TMDB liefert kein
    // Ablaufdatum, in keiner Form. Bekannt wird es nur, wenn es jemand
    // irgendwo sieht – Netflix zeigt "Letzter Tag: 30. September", ein
    // Anbieter kündigt es an, es steht in der Presse.
    //
    // Der Eintrag gilt für alle auf dieser Instanz: Wann ein Titel eine
    // Plattform verlässt, ist eine Tatsache über die Plattform.
    onSetUntil &&
      el('button.btn.btn-sm.btn-ghost', {
        style: { marginTop: '12px' },
        text: '⏳ Enddatum eintragen',
        title: 'Bis wann läuft der Titel bei einem Anbieter?',
        onClick: () => onSetUntil(),
      }),
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

              // Das Terminfeld gehört nur zur Merkliste – nach einem
              // Statuswechsel muss die Leiste deshalb neu gezeichnet werden.
              renderActions();
            } catch (error) {
              toast(error.message, 'error');
            }
          },
        },
        Object.entries(STATUS_LABELS).map(([value, label]) =>
          el('option', { value, text: label, selected: data.library.status === value }),
        ),
      ),

      // --- Sehplan ---
      //
      // Nur bei Serien: Ein Film hat keine Folgen, die man in einem Rhythmus
      // abhaken könnte.
      show.mediaType === 'tv' &&
        el('button.btn', {
          text: data.plan ? `🔁 ${planKurz(data.plan)}` : '🔁 Sehplan',
          title: data.plan
            ? 'Rhythmus ändern oder Plan beenden'
            : 'Zum Beispiel: jeden Montag zwei Folgen – Streamo hakt sie dann selbst ab',
          onClick: () => sehplanEinstellen(),
        }),

      // --- Wann willst du es sehen? ---
      //
      // Nur bei "Will ich sehen", und ausdrücklich freiwillig: Ohne Datum
      // verhält sich die Merkliste wie bisher. Der Sinn ist, dass eine lange
      // Merkliste nicht zum Friedhof guter Vorsätze wird – mit Termin lässt
      // sie sich nach "als Nächstes dran" sortieren.
      data.library.status === 'watchlist' &&
        el('label.planned-field', { title: 'Freiwillig – leer lassen ist völlig in Ordnung.' }, [
          el('span.small.muted', { text: 'Sehen am' }),
          el('input', {
            type: 'date',
            value: data.library.planned_for ?? '',
            onChange: async (event) => {
              const value = event.target.value || null;

              try {
                await api.library.update(show.showId, { plannedFor: value });
                data.library.planned_for = value;

                toast(
                  value ? `Vorgemerkt für den ${formatDate(value)}.` : 'Termin entfernt.',
                  'success',
                );
              } catch (error) {
                toast(error.message, 'error');
                // Zurücksetzen, sonst zeigt das Feld etwas an, das nicht
                // gespeichert wurde.
                event.target.value = data.library.planned_for ?? '';
              }
            },
          }),
        ]),

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
            data.availability = result.availability;
            render(availabilitySlot, availabilityBlock(result.availability, data.region, setUntil));
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
          const sure = await askConfirm({
            title: `„${show.title}" entfernen?`,
            text: 'Dein Sehfortschritt und deine Bewertung gehen dabei verloren.',
            confirmLabel: 'Entfernen',
            danger: true,
          });

          if (!sure) return;
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

  /**
   * Stellt den Sehplan ein: "jeden Montag zwei Folgen".
   *
   * Streamo hakt an diesen Tagen die nächsten UNGESEHENEN Folgen ab. Der Plan
   * merkt sich nicht, wo er steht – wer zwischendurch selbst weiterschaut,
   * bekommt am nächsten Termin nicht dieselben Folgen noch einmal, sondern
   * die danach.
   */
  const sehplanEinstellen = async () => {
    // Ausgewählt ist, was schon eingestellt war – sonst müsste man den Plan
    // beim Ändern von vorn zusammenklicken.
    const gewaehlt = new Set(data.plan?.weekdays ?? []);

    const werte = await modal({
      title: 'Sehplan',
      subtitle:
        'An diesen Tagen hakt Streamo die nächsten Folgen selbst ab. Wenn du zwischendurch mehr schaust, macht der Plan einfach dort weiter, wo du stehst.',
      body: (close) => {
        // Die Wochentage als Umschalter. 1 = Montag bis 7 = Sonntag (ISO),
        // dieselbe Zählung wie in der Datenbank.
        const tagKnoepfe = WOCHENTAGE.map(([nummer, kurz]) =>
          el('button.chip' + (gewaehlt.has(nummer) ? '.active' : ''), {
            type: 'button',
            text: kurz,
            onClick: (event) => {
              if (gewaehlt.has(nummer)) gewaehlt.delete(nummer);
              else gewaehlt.add(nummer);

              event.currentTarget.classList.toggle('active', gewaehlt.has(nummer));
            },
          }),
        );

        const anzahl = el(
          'select',
          { style: { width: '100%' } },
          [1, 2, 3, 4, 5].map((n) =>
            el('option', {
              value: String(n),
              text: `${n} ${n === 1 ? 'Folge' : 'Folgen'}`,
              selected: (data.plan?.episodesPerRun ?? 1) === n,
            }),
          ),
        );

        return [
          el('div.field', {}, [
            el('label', { text: 'An welchen Tagen?' }),
            el('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } }, tagKnoepfe),
          ]),

          el('div.field', {}, [
            el('label', { text: 'Wie viele Folgen je Termin?' }),
            anzahl,
            el('div.hint', {
              text: 'Specials und noch nicht ausgestrahlte Folgen bleiben außen vor.',
            }),
          ]),

          el('div.modal-actions', {}, [
            // Nur anbieten, wenn es etwas zu beenden gibt.
            data.plan &&
              el('button.btn.btn-danger', {
                text: 'Plan beenden',
                style: { marginRight: 'auto' },
                onClick: () => close({ entfernen: true }),
              }),
            el('button.btn.btn-ghost', { text: 'Abbrechen', onClick: () => close(null) }),
            el('button.btn.btn-primary', {
              text: 'Speichern',
              onClick: () =>
                close({ weekdays: [...gewaehlt], episodesPerRun: Number(anzahl.value) }),
            }),
          ]),
        ];
      },
    });

    if (!werte) return;

    try {
      if (werte.entfernen) {
        await api.shows.deletePlan(show.showId);
        data.plan = null;
        toast('Sehplan beendet. Abgehakte Folgen bleiben abgehakt.', 'success');
      } else {
        const result = await api.shows.setPlan(show.showId, werte);
        data.plan = result.plan;
        toast(`Sehplan gesetzt: ${planKurz(result.plan)}.`, 'success');
      }

      renderActions();
    } catch (error) {
      toast(error.message, 'error');
    }
  };

  /**
   * Fragt nach Anbieter und Enddatum und trägt beides ein.
   *
   * Zwei Angaben in einem Fenster: bei welchem Anbieter, und bis wann. Zur
   * Auswahl stehen nur die Anbieter, bei denen der Titel tatsächlich läuft –
   * alles andere wäre eine Behauptung ins Blaue.
   */
  const setUntil = async () => {
    // Jeden Anbieter nur einmal anbieten, auch wenn er unter mehreren
    // Angebotsarten auftaucht (im Abo UND zur Leihe).
    const providers = [];
    const seen = new Set();

    for (const list of Object.values(data.availability.offers || {})) {
      for (const offer of list) {
        if (seen.has(offer.provider_id)) continue;
        seen.add(offer.provider_id);
        providers.push(offer);
      }
    }

    if (providers.length === 0) {
      toast('Für diesen Titel ist kein Anbieter bekannt.', 'error');
      return;
    }

    const values = await modal({
      title: 'Bis wann ist der Titel verfügbar?',
      subtitle:
        'Diese Angabe gibt es bei TMDB nicht – sie muss von Hand kommen, etwa aus dem Hinweis „Letzter Tag" beim Anbieter. Eingetragen gilt sie für alle auf dieser Instanz.',
      body: (close) => {
        const providerSelect = el(
          'select',
          { style: { width: '100%' } },
          providers.map((offer) =>
            el('option', {
              value: String(offer.provider_id),
              text: offer.name,
              selected: Boolean(offer.availableUntil),
            }),
          ),
        );

        // Ein vorhandenes Datum vorbelegen, damit man es korrigieren kann,
        // statt es neu zu suchen.
        const vorhanden = providers.find((offer) => offer.availableUntil);

        const dateInput = el('input', {
          type: 'date',
          value: vorhanden?.availableUntil ?? '',
          // Rückwirkend ergibt die Angabe keinen Sinn; der Server lehnt sie
          // ohnehin ab, aber der Kalender soll es gar nicht erst anbieten.
          min: new Date().toISOString().slice(0, 10),
          style: { width: '100%' },
        });

        return [
          el('div.field', {}, [el('label', { text: 'Anbieter' }), providerSelect]),
          el('div.field', {}, [
            el('label', { text: 'Letzter Tag' }),
            dateInput,
            el('div.hint', { text: 'Leer lassen und speichern entfernt ein vorhandenes Datum.' }),
          ]),
          el('div.modal-actions', {}, [
            el('button.btn.btn-ghost', { text: 'Abbrechen', onClick: () => close(null) }),
            el('button.btn.btn-primary', {
              text: 'Speichern',
              onClick: () =>
                close({ providerId: Number(providerSelect.value), until: dateInput.value }),
            }),
          ]),
        ];
      },
    });

    if (!values) return;

    try {
      const result = await api.shows.setAvailableUntil(
        show.showId,
        values.providerId,
        values.until || null,
      );

      // Die Antwort enthält die frische Verfügbarkeit – damit lässt sich der
      // Block neu zeichnen, ohne die ganze Seite zu laden.
      if (result.availability) data.availability = result.availability;

      render(availabilitySlot, availabilityBlock(data.availability, data.region, setUntil));

      toast(values.until ? 'Enddatum eingetragen.' : 'Enddatum entfernt.', 'success');
    } catch (error) {
      toast(error.message, 'error');
    }
  };

  const availabilitySlot = el('div', {}, [
    availabilityBlock(data.availability, data.region, setUntil),
  ]);

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

            // Gehört der Titel zu einer Filmreihe? Dann hierher verlinken –
            // bei einem mittleren Teil ist das oft genau die Frage, die man
            // gerade hat ("was kam davor?").
            data.collection &&
              el(
                'a',
                {
                  href: `/collections/${data.collection.id}`,
                  'data-link': '',
                  style: {
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '7px 13px',
                    marginBottom: '12px',
                    borderRadius: '999px',
                    background: 'var(--surface-2)',
                    border: '1px solid var(--surface-3)',
                    color: 'var(--text)',
                    fontSize: '13.5px',
                    textDecoration: 'none',
                  },
                },
                [
                  el('span', { text: '🎬' }),
                  el('span', {
                    text: `Teil ${data.collection.part} von ${data.collection.total} · ${data.collection.name}`,
                  }),
                ],
              ),

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
