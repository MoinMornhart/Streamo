/**
 * ---------------------------------------------------------------------------
 * public/js/views/achievements.js – Erfolge
 * ---------------------------------------------------------------------------
 * Adresse: /achievements
 *
 * Zeigt, was man schon geschafft hat und woran man noch arbeiten kann.
 * Verdiente Erfolge stehen oben, die offenen darunter – bei letzteren mit
 * Fortschrittsbalken, sofern sich einer berechnen lässt.
 *
 * Serien-Erfolge bleiben verborgen, solange sie nicht verdient sind: Der
 * Titel ist jeweils eine Anspielung auf die Serie, und vorab gelesen wäre
 * die Pointe verschenkt.
 *
 * Verknüpfungen:
 *   - api.achievements.list() -> src/routes/achievements.js
 *   - src/achievements.js     -> dort stehen die Erfolge selbst
 * ---------------------------------------------------------------------------
 */

import { api } from '../api.js';
import { el, render, empty, formatDate } from '../ui.js';

/**
 * Baut die Kachel für einen einzelnen Erfolg.
 *
 * @param {object} achievement Eintrag aus /api/achievements
 * @param {boolean} unlocked   Bereits verdient?
 * @returns {HTMLElement}
 */
function achievementCard(achievement, unlocked) {
  const progress = achievement.progress;

  // Anteil in Prozent, gedeckelt – sonst würde der Balken bei Übererfüllung
  // aus der Kachel laufen.
  const percent =
    progress && progress.goal > 0
      ? Math.min(100, Math.round((progress.current / progress.goal) * 100))
      : 0;

  return el(
    'div.achievement' + (unlocked ? '.unlocked' : ''),
    { title: achievement.description },
    [
      el('div.achievement-icon', { text: achievement.icon }),

      el('div.achievement-body', {}, [
        el('div.achievement-title', { text: achievement.title }),
        el('div.achievement-desc', { text: achievement.description }),

        // Fortschritt nur bei offenen Erfolgen – bei erledigten wäre er
        // überflüssig und würde die Kachel unruhig machen.
        !unlocked &&
          progress &&
          el('div', { style: { marginTop: '8px' } }, [
            el('div.progress-bar', {}, [el('span', { style: { width: `${percent}%` } })]),
            el('div.achievement-progress', {
              text: `${progress.current} von ${progress.goal}${progress.unit ? ` ${progress.unit}` : ''}`,
            }),
          ]),

        unlocked &&
          achievement.earnedAt &&
          el('div.achievement-date', {
            text: `Erreicht am ${formatDate(String(achievement.earnedAt).slice(0, 10))}`,
          }),
      ]),
    ],
  );
}

/**
 * Zeichnet die Erfolgsseite.
 * @param {HTMLElement} container
 */
export async function render_(container) {
  const data = await api.achievements.list();

  const percent = data.total > 0 ? Math.round((data.earnedCount / data.total) * 100) : 0;

  render(
    container,

    el('div.view-header', {}, [
      el('div', {}, [
        el('h1', { text: 'Erfolge', style: { marginBottom: '2px' } }),
        el('p.muted', {
          style: { margin: 0 },
          text: `${data.earnedCount} von ${data.total} freigeschaltet (${percent} %)`,
        }),
      ]),
    ]),

    // Gesamtfortschritt als breiter Balken über allem.
    el('div', { style: { marginBottom: '26px' } }, [
      el('div.progress-bar', { style: { height: '8px' } }, [
        el('span', { style: { width: `${percent}%` } }),
      ]),
    ]),

    // --- Verdiente Erfolge ---
    data.earned.length > 0 &&
      el('section', { style: { marginBottom: '34px' } }, [
        el('h2', { text: `Freigeschaltet (${data.earned.length})` }),
        el(
          'div.achievement-grid',
          {},
          data.earned.map((a) => achievementCard(a, true)),
        ),
      ]),

    // --- Offene Erfolge ---
    data.locked.length > 0 &&
      el('section', {}, [
        el('h2', { text: `Noch offen (${data.locked.length})` }),
        el(
          'div.achievement-grid',
          {},
          data.locked.map((a) => achievementCard(a, false)),
        ),
      ]),

    data.earned.length === 0 &&
      data.locked.length === 0 &&
      empty('🏆', 'Noch keine Erfolge', 'Sieh dir etwas an, dann füllt sich diese Seite.'),
  );
}

export { render_ as render };
