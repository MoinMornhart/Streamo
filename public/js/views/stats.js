/**
 * ---------------------------------------------------------------------------
 * public/js/views/stats.js – Auswertung der eigenen Bibliothek
 * ---------------------------------------------------------------------------
 * Adresse: /stats
 *
 * Beantwortet die Fragen, die sich aus der Verknüpfung von Bibliothek und
 * Abos ergeben:
 *   - Wie viele meiner Serien laufen bei welchem Anbieter?
 *   - Zahle ich für ein Abo, in dem nichts von meiner Liste steckt?
 *   - Welches zusätzliche Abo würde mir am meisten freischalten?
 *   - Wie viel Zeit habe ich mit Schauen verbracht?
 *
 * Die Balkendiagramme sind reines CSS – die Breite ist ein Prozentwert im
 * style-Attribut. Kein Diagramm-Framework nötig.
 *
 * Verknüpfungen:
 *   - api.stats.get() -> src/routes/stats.js
 * ---------------------------------------------------------------------------
 */

import { api, img } from '../api.js';
import { el, render, empty, posterGrid, STATUS_LABELS, formatRuntime } from '../ui.js';

/**
 * Baut eine Kennzahl-Kachel.
 * @param {string|number} value
 * @param {string} label
 * @returns {HTMLElement}
 */
function tile(value, label) {
  return el('div.stat-tile', {}, [
    el('div.stat-value', { text: String(value) }),
    el('div.stat-label', { text: label }),
  ]);
}

/**
 * Baut ein waagerechtes Balkendiagramm.
 * @param {{name: string, count: number, logo_path?: string}[]} rows
 * @param {string} emptyText Text, wenn es keine Daten gibt
 * @returns {HTMLElement}
 */
function barChart(rows, emptyText) {
  if (!rows || rows.length === 0) {
    return el('p.muted', { text: emptyText });
  }

  // Der längste Balken bestimmt die Skala. Math.max(…, 1) verhindert eine
  // Division durch null, wenn alle Werte 0 sind.
  const max = Math.max(...rows.map((r) => r.count), 1);

  return el(
    'div',
    {},
    rows.map((row) =>
      el('div.bar-row', {}, [
        el('div.bar-label', {}, [
          row.logo_path &&
            el('img', { src: img(row.logo_path, 'w92'), alt: '', loading: 'lazy' }),
          el('span', { text: row.name || `Anbieter ${row.provider_id}` }),
        ]),
        el('div.bar-track', {}, [
          el('div.bar-fill', { style: { width: `${(row.count / max) * 100}%` } }),
        ]),
        el('div.bar-value', { text: String(row.count) }),
      ]),
    ),
  );
}

/**
 * Zeichnet die Statistikseite.
 * @param {HTMLElement} container
 */
export async function render_(container) {
  const data = await api.stats.get();

  if (data.total === 0) {
    render(
      container,
      el('h1', { text: 'Statistik' }),
      empty(
        '📊',
        'Noch nichts auszuwerten',
        'Sobald Serien in deiner Bibliothek liegen, entsteht hier die Auswertung.',
        el('a.btn.btn-primary', { href: '/', 'data-link': '', text: 'Serien entdecken' }),
      ),
    );
    return;
  }

  // Anbieter, bei denen nichts aus der eigenen Liste läuft – die Kandidaten
  // zum Kündigen.
  const unusedProviders = data.byProvider.filter((p) => p.count === 0);

  render(
    container,

    el('h1', { text: 'Statistik' }),

    // --- Kennzahlen ---------------------------------------------------------
    el('div.stat-grid', {}, [
      tile(data.total, 'Titel in der Bibliothek'),
      tile(data.byStatus.watching || 0, STATUS_LABELS.watching),
      tile(data.byStatus.completed || 0, STATUS_LABELS.completed),
      tile(data.watchtime.episodes, 'Gesehene Episoden'),
      tile(`${data.watchtime.hours} Std.`, `Sehzeit (≈ ${data.watchtime.days} Tage)`),
      tile(data.byProvider.length, 'Verknüpfte Abos'),
    ]),

    // --- Verteilung auf die Abos -------------------------------------------
    el('div.card', { style: { marginBottom: '22px' } }, [
      el('h2', { text: 'Deine Bibliothek nach Anbieter' }),
      el('p.muted.small', {
        text: `So viele deiner Titel sind im jeweiligen Abo enthalten (Region ${data.region}).`,
      }),
      barChart(data.byProvider, 'Du hast noch keine Anbieter verknüpft.'),

      // Warnung bei ungenutzten Abos – der praktische Nutzen der ganzen Seite.
      unusedProviders.length > 0 &&
        el('div', { style: { marginTop: '16px' } }, [
          el('div.error-box', {
            text: `Bei ${unusedProviders.map((p) => p.name).join(', ')} läuft aktuell nichts aus deiner Bibliothek. Vielleicht lohnt sich das Abo gerade nicht.`,
          }),
        ]),
    ]),

    // --- Abo-Vorschläge -----------------------------------------------------
    data.suggestions.length > 0 &&
      el('div.card', { style: { marginBottom: '22px' } }, [
        el('h2', { text: 'Was würde ein weiteres Abo bringen?' }),
        el('p.muted.small', {
          text: 'Anbieter, die du nicht abonniert hast – mit der Zahl deiner Titel, die dort im Abo enthalten wären.',
        }),
        barChart(data.suggestions, 'Keine Vorschläge.'),
      ]),

    // --- Genres -------------------------------------------------------------
    data.topGenres.length > 0 &&
      el('div.card', { style: { marginBottom: '22px' } }, [
        el('h2', { text: 'Deine häufigsten Genres' }),
        barChart(data.topGenres, 'Keine Genre-Daten.'),
      ]),

    // --- Lücken -------------------------------------------------------------
    data.uncovered.length > 0 &&
      el('section', { style: { marginTop: '10px' } }, [
        el('h2', { text: `Nirgends in deinen Abos (${data.uncovered.length})` }),
        el('p.muted', {
          text: 'Diese Titel stehen auf deiner Liste, laufen aber bei keinem deiner Anbieter im Abo.',
        }),
        posterGrid(
          data.uncovered.map((row) => ({
            tmdbId: row.tmdb_id,
            mediaType: row.media_type,
            title: row.title,
            posterPath: row.poster_path,
            inLibrary: true,
          })),
        ),
      ]),
  );
}

export { render_ as render };
