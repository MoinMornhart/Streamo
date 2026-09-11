/**
 * ---------------------------------------------------------------------------
 * site/build.mjs – Baut die Webseite für GitHub Pages
 * ---------------------------------------------------------------------------
 * Ergebnis: _site/ – veröffentlicht unter https://moinmornhart.github.io/Streamo/
 * durch den Workflow .github/workflows/pages.yml.
 *
 * Wie es funktioniert (derselbe Aufbau wie bei VibeWorks):
 *   - Jede Seite liegt als HTML-Schnipsel in site/pages/*.html. Ganz oben
 *     steht eine Kopfzeile als JSON-Kommentar: Zielpfad, Sprache, das
 *     Gegenstück in der anderen Sprache, Titel und Beschreibung.
 *   - Der Schnipsel wird in site/layout.html gesetzt – Kopf, Navigation und
 *     Fußzeile gibt es damit nur einmal.
 *   - {{name}} wird ersetzt: {{base}} ist der relative Weg zurück zur
 *     Wurzel ("./" oder "../"), damit die Seite in jedem Unterordner und auch
 *     lokal ohne Server funktioniert.
 *   - Bilder und Logo kommen aus dem Repository (docs/img), damit nichts
 *     doppelt gepflegt wird: Dieselben Bildschirmfotos zeigt auch das README.
 *
 * Ohne Abhängigkeiten. Aufruf: node site/build.mjs  (oder npm run site)
 * ---------------------------------------------------------------------------
 */

import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, '_site');
const pagesDir = path.join(root, 'site', 'pages');

/** Die Beschriftungen, die im Layout stehen – je Sprache einmal. */
const NAV = {
  de: {
    features: 'Funktionen',
    docs: 'Doku',
    switch: 'English',
    footer: 'Streamo · MIT-Lizenz · selbst gehostet, ohne Tracking',
    attribution: 'Nutzt die TMDB-API, ist aber nicht von TMDB unterstützt oder zertifiziert. Verfügbarkeiten von JustWatch.',
  },
  en: {
    features: 'Features',
    docs: 'Docs',
    switch: 'Deutsch',
    footer: 'Streamo · MIT license · self-hosted, no tracking',
    attribution: 'Uses the TMDB API but is not endorsed or certified by TMDB. Availability data from JustWatch.',
  },
};

/**
 * Ersetzt {{name}} durch den Wert – Unbekanntes bleibt stehen, damit ein
 * Tippfehler im Schnipsel sichtbar wird statt still zu verschwinden.
 * @param {string} text
 * @param {object} vars
 * @returns {string}
 */
const fill = (text, vars) => text.replace(/\{\{([\w.]+)\}\}/g, (match, key) => (key in vars ? vars[key] : match));

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const layout = readFileSync(path.join(root, 'site', 'layout.html'), 'utf8');

let count = 0;
for (const file of readdirSync(pagesDir).filter((name) => name.endsWith('.html'))) {
  const src = readFileSync(path.join(pagesDir, file), 'utf8');

  // Die Kopfzeile: <!-- {"path": "...", "lang": "de", ...} -->
  const head = src.match(/^<!--\s*(\{[\s\S]*?\})\s*-->/);
  if (!head) throw new Error(`${file}: Kopfzeile fehlt`);
  const meta = JSON.parse(head[1]);

  const depth = meta.path.split('/').length - 1;
  const nav = NAV[meta.lang];
  if (!nav) throw new Error(`${file}: unbekannte Sprache "${meta.lang}"`);

  const vars = {
    lang: meta.lang,
    title: meta.title,
    description: meta.description,
    base: depth ? '../'.repeat(depth) : './',
    // Die englischen Seiten liegen unter en/ – ihre Startseite also dort.
    home: meta.lang === 'en' ? 'en/' : '',
    // Bilder in der passenden Sprache: docs/img bzw. docs/img/en.
    img: meta.lang === 'en' ? 'images/en/' : 'images/',
    alt: meta.alt,
    altLang: meta.lang === 'en' ? 'de' : 'en',
    'nav.features': nav.features,
    'nav.docs': nav.docs,
    'nav.switch': nav.switch,
    'nav.footer': nav.footer,
    'nav.attribution': nav.attribution,
  };

  // Erst den Seiteninhalt füllen (dort stehen {{base}} und {{img}}), dann
  // ins Layout setzen.
  const body = fill(src.slice(head[0].length).trim(), vars);
  const html = fill(layout, { ...vars, body });

  const target = path.join(out, meta.path);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, html);
  count++;
}

// Stil und Skript, Bildschirmfotos (beide Sprachen) und das Logo.
cpSync(path.join(root, 'site', 'static'), out, { recursive: true });
cpSync(path.join(root, 'docs', 'img'), path.join(out, 'images'), { recursive: true });
cpSync(path.join(root, 'docs', 'img', 'logo.svg'), path.join(out, 'icon.svg'));

// GitHub Pages soll die Dateien unverändert ausliefern, nicht mit Jekyll.
writeFileSync(path.join(out, '.nojekyll'), '');

console.log(`Webseite gebaut: ${count} Seiten -> _site/`);
