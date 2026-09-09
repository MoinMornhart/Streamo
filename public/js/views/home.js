/**
 * ---------------------------------------------------------------------------
 * public/js/views/home.js – Startseite "Entdecken"
 * ---------------------------------------------------------------------------
 * Beantwortet die Frage, für die Streamo gebaut wurde: "Was kann ich mit
 * meinen Abos gerade schauen?"
 *
 * Aufbau der Seite:
 *   1. Fortsetzen – Serien mit Status "watching" aus der eigenen Bibliothek
 *   2. Für dich – Vorschläge aus dem, was man schon gesehen hat
 *   3. In deinen Abos – Discover, gefiltert auf die verknüpften Anbieter
 *   4. Angesagt – TMDB-Trending als Rückfall, wenn noch keine Abos verknüpft
 *      sind
 *
 * Der Unterschied zwischen 2 und 3: "In deinen Abos" zeigt, was gerade
 * populär ist – für alle dasselbe. "Für dich" rechnet aus der eigenen
 * Bibliothek, den Bewertungen und den abgehakten Folgen und ist für jeden
 * ein anderes Ergebnis.
 *
 * Verknüpfungen:
 *   - api.library.list()      -> src/routes/library.js
 *   - api.search.forYou()     -> src/routes/search.js -> src/recommend.js
 *   - api.search.discover()   -> src/routes/search.js (nutzt user_providers)
 *   - api.providers.mine()    -> src/routes/providers.js
 * ---------------------------------------------------------------------------
 */

import { api } from '../api.js';
import { el, render, posterGrid, empty, enrichWithAvailability, loading } from '../ui.js';

/**
 * Baut einen Abschnitt mit Überschrift und Poster-Raster.
 * @param {string} title
 * @param {object[]} items
 * @param {HTMLElement} [action] optionaler Verweis rechts neben der Überschrift
 * @returns {HTMLElement|null} null, wenn es nichts anzuzeigen gibt
 */
function section(title, items, action) {
  if (!items || items.length === 0) return null;

  return el('section', { style: { marginBottom: '38px' } }, [
    el('div.view-header', { style: { marginBottom: '14px' } }, [
      el('h2', { text: title, style: { margin: 0 } }),
      action,
    ]),
    posterGrid(items),
  ]);
}

/**
 * Füllt die Leiste "Für dich".
 *
 * Läuft getrennt vom Rest der Seite, weil dahinter ein gutes Dutzend
 * TMDB-Aufrufe stecken (siehe src/recommend.js). Der Server hält das Ergebnis
 * zwischen, solange sich die Bibliothek nicht ändert – beim zweiten Aufruf ist
 * es also sofort da.
 *
 * Drei mögliche Ausgänge:
 *   - Vorschläge da  -> Raster mit Begründung auf jeder Kachel
 *   - Bibliothek leer -> freundlicher Hinweis, was zu tun ist
 *   - Fehler          -> der Bereich verschwindet lautlos; die Startseite
 *                        funktioniert auch ohne ihn
 *
 * @param {HTMLElement} slot Der vorbereitete Platzhalter
 */
async function loadForYou(slot) {
  try {
    // Ohne mediaType: Serien und Filme gemischt. Wer sich beides ansieht,
    // will hier auch beides vorgeschlagen bekommen.
    const data = await api.search.forYou({ limit: 18 });

    if (data.results.length === 0) {
      // `reason` erklärt, warum nichts da ist – meistens: noch nichts gesehen.
      // Den Hinweis zeigen wir nur, wenn überhaupt eine Erklärung mitkam.
      if (!data.reason) {
        slot.remove();
        return;
      }

      render(
        slot,
        el('div.view-header', { style: { marginBottom: '14px' } }, [
          el('h2', { text: 'Für dich', style: { margin: 0 } }),
        ]),
        empty('✨', 'Noch keine Empfehlungen', data.reason),
      );
      return;
    }

    const grid = posterGrid(data.results);

    render(
      slot,
      el('div.view-header', { style: { marginBottom: '14px' } }, [
        el('div', {}, [
          el('h2', { text: 'Für dich', style: { margin: 0 } }),
          el('p.muted', {
            style: { margin: '4px 0 0', fontSize: '13px' },
            // Nachvollziehbar machen, woher die Vorschläge kommen. Zwei Titel
            // reichen als Beleg, alles weitere macht die Zeile nur lang.
            text: data.basedOn?.length
              ? `Ausgehend von ${data.basedOn
                  .slice(0, 2)
                  .map((entry) => `„${entry.title}"`)
                  .join(', ')}${data.basedOn.length > 2 ? ` und ${data.basedOn.length - 2} weiteren` : ''}.`
              : 'Zusammengestellt aus deiner Bibliothek.',
          }),
        ]),
        el('a', {
          href: '/library?status=completed',
          'data-link': '',
          text: 'Was ich gesehen habe',
          class: 'small',
        }),
      ]),
      grid,
    );

    // Auch hier die Anbieter-Logos nachreichen: Ein Vorschlag nützt wenig,
    // wenn man nicht sieht, wo er läuft.
    enrichWithAvailability(data.results, grid);
  } catch {
    // Bewusst still: Die Startseite hat mit "Weiterschauen" und "In deinen
    // Abos" genug Inhalt. Eine Fehlermeldung an dieser Stelle wäre lauter,
    // als der Ausfall es verdient.
    slot.remove();
  }
}

/**
 * Zeichnet die Startseite.
 * @param {HTMLElement} container
 */
export async function render_(container) {
  // Drei unabhängige Abfragen parallel – so ist die Seite nach der langsamsten
  // da statt nach der Summe aller drei.
  const [watchingResult, providersResult] = await Promise.all([
    api.library.list({ status: 'watching', sort: 'updated' }),
    api.providers.mine(),
  ]);

  const watching = watchingResult.entries;
  const hasProviders = providersResult.providers.length > 0;

  // Der Bereich für die Empfehlungen wird zuerst leer eingehängt und danach
  // gefüllt – so erscheint "Fortsetzen" sofort.
  const discoverSlot = el('section', { style: { marginBottom: '38px' } }, [loading('Suche Titel in deinen Abos …')]);

  // Eigener Platzhalter für die persönlichen Vorschläge. Sie brauchen mehrere
  // TMDB-Aufrufe und dürfen deshalb nicht den Rest der Seite aufhalten – die
  // beiden Bereiche werden unabhängig voneinander nachgeladen.
  const forYouSlot = el('section', { style: { marginBottom: '38px' } }, [
    loading('Stelle Vorschläge für dich zusammen …'),
  ]);

  // ------------------------------------------------------------------------
  // Grundgerüst zeichnen
  // ------------------------------------------------------------------------
  const parts = [];

  // Begrüßung mit Hinweis, worauf gefiltert wird.
  parts.push(
    el('div.view-header', {}, [
      el('div', {}, [
        el('h1', { text: 'Entdecken', style: { marginBottom: '4px' } }),
        el('p.muted', {
          style: { margin: 0 },
          text: hasProviders
            ? `Gefiltert auf deine ${providersResult.providers.length} verknüpften Anbieter.`
            : 'Verknüpfe deine Streaming-Abos, damit Streamo weiß, was du sehen kannst.',
        }),
      ]),
      !hasProviders &&
        el('a.btn.btn-primary', {
          href: '/providers',
          'data-link': '',
          text: 'Anbieter verknüpfen',
        }),
    ]),
  );

  const continueSection = section(
    'Weiterschauen',
    watching,
    el('a', { href: '/library?status=watching', 'data-link': '', text: 'Alle anzeigen', class: 'small' }),
  );
  if (continueSection) parts.push(continueSection);

  // "Für dich" steht bewusst über "In deinen Abos": Was zu einem passt, ist
  // interessanter als was gerade alle sehen.
  parts.push(forYouSlot);
  parts.push(discoverSlot);

  render(container, ...parts);

  // Beide Bereiche gleichzeitig füllen. Ohne await – sie sollen sich
  // gegenseitig nicht ausbremsen, und Fehler fängt jeder für sich ab.
  loadForYou(forYouSlot);

  // Verfügbarkeiten für "Weiterschauen" kommen bereits aus der Bibliothek
  // (dort sind sie gespeichert) – hier ist also kein Nachladen nötig.

  // ------------------------------------------------------------------------
  // Empfehlungen nachladen
  // ------------------------------------------------------------------------
  try {
    // Ohne verknüpfte Abos ergibt der Abo-Filter keinen Sinn – dann zeigen wir
    // die allgemein angesagten Serien.
    const data = hasProviders
      ? await api.search.discover({ mediaType: 'tv', sort: 'popularity.desc' })
      : await api.search.trending('tv');

    const items = data.results.slice(0, 24);

    if (items.length === 0) {
      render(
        discoverSlot,
        empty(
          '🍿',
          'Nichts gefunden',
          hasProviders
            ? 'Bei deinen Anbietern hat TMDB gerade nichts im Angebot. Prüfe deine Region in den Einstellungen.'
            : 'Verknüpfe zuerst deine Streaming-Abos.',
        ),
      );
      return;
    }

    const grid = posterGrid(items);

    render(
      discoverSlot,
      el('div.view-header', { style: { marginBottom: '14px' } }, [
        el('h2', {
          text: hasProviders ? 'In deinen Abos' : 'Gerade angesagt',
          style: { margin: 0 },
        }),
        el('a', {
          href: '/library',
          'data-link': '',
          text: 'Meine Bibliothek',
          class: 'small',
        }),
      ]),
      grid,
    );

    // Die Anbieter-Logos auf den Kacheln nachreichen. Bei Discover-Treffern
    // wissen wir zwar bereits, dass sie in einem Abo laufen – aber nicht in
    // welchem, und genau das soll die Kachel zeigen.
    enrichWithAvailability(items, grid);
  } catch (error) {
    render(discoverSlot, empty('⚠️', 'Empfehlungen nicht verfügbar', error.message));
  }
}

export { render_ as render };
