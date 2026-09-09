/**
 * ---------------------------------------------------------------------------
 * src/server.js – Einstiegspunkt von Streamo
 * ---------------------------------------------------------------------------
 * Startet den HTTP-Server, hängt alle Routen ein und liefert das Frontend aus.
 * Das ist die Datei, die `npm start` und der systemd-Dienst aufrufen.
 *
 * Aufbau (die Reihenfolge der Middleware ist wichtig und von oben nach unten
 * genau so gemeint):
 *   1. JSON-Body lesen
 *   2. Angemeldeten Benutzer an req.user hängen
 *   3. Sicherheits-Header setzen
 *   4. /api/* – die Programmierschnittstelle
 *   5. public/ – statische Dateien (HTML, CSS, JS)
 *   6. Fallback auf index.html, damit Deeplinks funktionieren
 *   7. Zentraler Fehler-Handler
 *
 * Verknüpfungen zu allen anderen Dateien:
 *   - src/config.js       -> Port, Host, Verzeichnisse
 *   - src/db.js           -> wird durch den Import initialisiert (Schema anlegen)
 *   - src/auth.js         -> attachUser als globale Middleware
 *   - src/routes/*.js     -> die einzelnen API-Bereiche
 *   - src/sync.js         -> Hintergrundabgleich
 *   - public/index.html   -> die Oberfläche
 * ---------------------------------------------------------------------------
 */

import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import config from './config.js';
import { attachUser, pruneSessions } from './auth.js';
import { hasApiKey } from './tmdb.js';
import { startSyncScheduler, stopSyncScheduler } from './sync.js';
// Nur gebraucht, wenn ENABLE_HTTPS gesetzt ist – siehe startServer() unten.
import { getTlsOptions } from './tls.js';

// Routen-Module. Jedes bringt einen eigenen express.Router mit.
import authRoutes from './routes/auth.js';
import providerRoutes from './routes/providers.js';
import searchRoutes from './routes/search.js';
import libraryRoutes from './routes/library.js';
import showRoutes from './routes/shows.js';
import settingsRoutes from './routes/settings.js';
import statsRoutes from './routes/stats.js';

const app = express();

// --------------------------------------------------------------------------
// 0. Reverse-Proxy-Unterstützung
// Nur wenn TRUST_PROXY=true gesetzt ist, glaubt Express den X-Forwarded-*-
// Headern. Ohne Proxy davor wäre das eine Sicherheitslücke, weil jeder Client
// seine Herkunft frei behaupten könnte.
// --------------------------------------------------------------------------
if (config.trustProxy) app.set('trust proxy', 1);

// Express verrät sonst per X-Powered-By, womit der Dienst läuft. Kein echtes
// Risiko, aber es gibt keinen Grund, es zu erzählen.
app.disable('x-powered-by');

// --------------------------------------------------------------------------
// 1. JSON-Körper einlesen.
// Das Limit von 5 MB ist großzügig für API-Aufrufe, aber notwendig für den
// Import einer großen Bibliothek über POST /api/library/import.
// --------------------------------------------------------------------------
app.use(express.json({ limit: '5mb' }));

// --------------------------------------------------------------------------
// 2. Session auflösen.
// Läuft für JEDEN Request und setzt req.user (oder null). Blockiert nichts –
// das übernehmen requireAuth/requireAdmin in den einzelnen Routen.
// --------------------------------------------------------------------------
app.use(attachUser);

// --------------------------------------------------------------------------
// 3. Sicherheits-Header.
// Bewusst von Hand statt per helmet – es sind vier Zeilen und spart eine
// weitere Abhängigkeit.
// --------------------------------------------------------------------------
app.use((req, res, next) => {
  // Verhindert, dass der Browser den Inhaltstyp "errät" (MIME-Sniffing).
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Streamo darf nicht in fremde Seiten eingebettet werden (Clickjacking).
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  // Beim Klick auf externe Anbieter-Links nur die Herkunft übermitteln,
  // nicht den vollständigen Pfad mit Serien-IDs.
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Content Security Policy: Skripte nur aus dem eigenen Ursprung, Bilder
  // zusätzlich von image.tmdb.org (dort liegen Poster und Anbieter-Logos).
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "img-src 'self' https://image.tmdb.org data:",
      // 'unsafe-inline' für Styles, weil das Frontend Fortschrittsbalken und
      // Hintergrundbilder über style-Attribute setzt.
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'self'",
    ].join('; '),
  );
  next();
});

// --------------------------------------------------------------------------
// 4. Die API.
// Jeder Router hängt unter seinem Präfix; welche Endpunkte es gibt, steht im
// Kopf der jeweiligen Datei.
// --------------------------------------------------------------------------
app.use('/api/auth', authRoutes); //       Anmeldung und Ersteinrichtung
app.use('/api/providers', providerRoutes); // Streaming-Anbieter verknüpfen
app.use('/api/search', searchRoutes); //   Suchen und Entdecken
app.use('/api/library', libraryRoutes); // Die persönliche Serien-Datenbank
app.use('/api/shows', showRoutes); //      Detailseite, Staffeln, Fortschritt
app.use('/api/settings', settingsRoutes); // Einstellungen und Abgleich
app.use('/api/stats', statsRoutes); //     Auswertungen

/**
 * GET /api/health
 * Ein einfacher Lebenszeichen-Endpunkt ohne Anmeldung. Genutzt vom
 * Proxmox-Installationsskript, um zu prüfen, ob der Dienst hochgekommen ist,
 * und von Überwachungswerkzeugen wie Uptime Kuma.
 */
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    version: config.version,
    hasApiKey: hasApiKey(),
    // Sekunden seit Prozessstart – praktisch, um Neustarts zu erkennen.
    uptime: Math.round(process.uptime()),
  });
});

// Unbekannte API-Pfade sollen sauberes JSON liefern, nicht die HTML-Seite.
// Ohne diese Regel würde der SPA-Fallback weiter unten auch bei Tippfehlern
// in der URL index.html zurückgeben – und das Frontend bekäme HTML, wo es
// JSON erwartet.
app.use('/api', (req, res) => {
  res.status(404).json({ error: `Unbekannter Endpunkt: ${req.method} ${req.originalUrl}` });
});

// --------------------------------------------------------------------------
// 5. Das Frontend als statische Dateien.
// --------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// index.html mit Versionskennung ausliefern.
//
// Das Problem: Nach einem Update hat der Browser CSS und JavaScript noch aus
// seinem Zwischenspeicher – man sieht die alte Oberfläche und wundert sich,
// warum die Änderungen fehlen. "no-cache" allein hilft nur für die Zukunft,
// nicht gegen bereits gespeicherte Dateien.
//
// Deshalb bekommen die Verweise in index.html eine Kennung angehängt
// (…/styles.css?v=1a2b3c). Sie ändert sich, sobald sich eine dieser Dateien
// ändert – für den Browser ist das dann eine andere Adresse, die er neu holen
// muss. Der alte Zwischenspeicher wird damit wirkungslos.
// ---------------------------------------------------------------------------

/**
 * Berechnet die Kennung aus den Änderungszeitpunkten der Frontend-Dateien.
 *
 * Beim Start einmal ermittelt: Innerhalb eines laufenden Prozesses ändern
 * sich die Dateien nicht, und nach einem Update startet der Dienst ohnehin neu.
 *
 * @returns {string} kurze Kennung, z. B. "k3f9a2"
 */
function computeAssetVersion() {
  const files = [
    'css/styles.css',
    'js/app.js',
    'js/api.js',
    'js/ui.js',
    'js/router.js',
    'js/passkey.js',
  ];

  let newest = 0;
  for (const file of files) {
    try {
      const stat = fs.statSync(path.join(config.publicDir, file));
      if (stat.mtimeMs > newest) newest = stat.mtimeMs;
    } catch {
      /* Datei fehlt – dann zählt sie eben nicht mit */
    }
  }

  // Zur Basis 36, das ergibt eine kurze Zeichenfolge aus Ziffern und Buchstaben.
  return Math.round(newest).toString(36);
}

const ASSET_VERSION = computeAssetVersion();

/**
 * Liefert index.html aus und hängt die Versionskennung an die Verweise.
 *
 * Die Datei wird bei jeder Anfrage frisch gelesen. Das kostet praktisch
 * nichts (sie ist wenige Kilobyte groß und liegt im Dateisystem-Cache des
 * Betriebssystems) und erspart eine Sonderbehandlung nach Updates.
 */
function sendIndex(req, res) {
  try {
    const html = fs
      .readFileSync(path.join(config.publicDir, 'index.html'), 'utf8')
      // Nur eigene Verweise auf CSS und JS bekommen die Kennung – externe
      // Adressen und das eingebettete Favicon bleiben unangetastet.
      .replace(/(href|src)="(\/(?:css|js)\/[^"]+)"/g, `$1="$2?v=${ASSET_VERSION}"`);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(html);
  } catch (error) {
    res.status(500).send('index.html konnte nicht gelesen werden.');
  }
}

// Vor express.static eingehängt, sonst käme die unveränderte Datei zuerst.
app.get(['/', '/index.html'], sendIndex);

/**
 * Liefert die JavaScript-Module aus und hängt die Versionskennung auch an
 * ihre gegenseitigen Importe.
 *
 * Warum das nötig ist: Die Kennung in index.html erreicht nur app.js. Diese
 * Datei lädt aber per `import` weitere Module nach (router.js, ui.js, die
 * Ansichten …), und für die gilt wieder die alte, zwischengespeicherte
 * Adresse. Ohne diese Umschreibung bekäme man nach einem Update eine neue
 * app.js, die weiterhin alte Module benutzt – ein Zustand, der schwerer zu
 * durchschauen ist als ein durchgehend alter Stand.
 *
 * Ersetzt wird nur in `from '…'` und `import('…')` mit relativem Pfad. Alles
 * andere bleibt unangetastet.
 */
app.get(/^\/js\/.*\.js$/, (req, res, next) => {
  // Den angefragten Pfad in einen Dateipfad übersetzen und dabei sicherstellen,
  // dass er das öffentliche Verzeichnis nicht verlässt (Verzeichniswechsel
  // über "../" wäre sonst ein Weg, beliebige Dateien auszulesen).
  const relative = decodeURIComponent(req.path).replace(/^\/+/, '');
  const filePath = path.resolve(config.publicDir, relative);

  if (!filePath.startsWith(path.resolve(config.publicDir))) {
    return res.status(403).end();
  }

  let source;
  try {
    source = fs.readFileSync(filePath, 'utf8');
  } catch {
    // Datei gibt es nicht – der reguläre Weg soll darüber entscheiden.
    return next();
  }

  const withVersion = source
    // import … from './datei.js'   /   export … from '../datei.js'
    .replace(/(from\s+['"])(\.\.?\/[^'"]+\.js)(['"])/g, `$1$2?v=${ASSET_VERSION}$3`)
    // await import('./views/home.js')
    .replace(/(import\(\s*['"])(\.\.?\/[^'"]+\.js)(['"])/g, `$1$2?v=${ASSET_VERSION}$3`);

  res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(withVersion);
});

app.use(
  express.static(config.publicDir, {
    /**
     * Cache-Control für alle Dateien der Oberfläche.
     *
     * "no-cache" heißt entgegen dem Namen NICHT "nicht zwischenspeichern",
     * sondern "vor jeder Verwendung nachfragen, ob es noch aktuell ist".
     * Express schickt zu jeder Datei einen ETag mit; der Browser hängt ihn an
     * die nächste Anfrage, und der Server antwortet mit einem winzigen
     * "304 Not Modified", wenn sich nichts geändert hat. Der Inhalt selbst
     * geht also nur dann über die Leitung, wenn er wirklich neu ist.
     *
     * Vorher stand hier "max-age=3600" für CSS und JavaScript. Das hatte eine
     * unangenehme Folge: Nach einem "update" sah man bis zu einer Stunde lang
     * weiter die alte Oberfläche, weil der Browser gar nicht erst nachfragte.
     * Bei einer Anwendung, die sich selbst aktualisiert, ist das der falsche
     * Tausch – die paar eingesparten Anfragen wiegen den Ärger nicht auf.
     */
    setHeaders(res) {
      res.setHeader('Cache-Control', 'no-cache');
    },
  }),
);

// --------------------------------------------------------------------------
// 6. SPA-Fallback.
// Streamo bildet seine Ansichten über die Adresszeile ab (/library, /search,
// /show/tv/1399). Diese Pfade gibt es auf der Festplatte nicht – der Server
// liefert deshalb für alles Übrige index.html aus, und das Frontend
// entscheidet anhand der URL, was es anzeigt.
// --------------------------------------------------------------------------
app.get(/.*/, (req, res) => {
  sendIndex(req, res);
});

// --------------------------------------------------------------------------
// 7. Zentraler Fehler-Handler.
// Alles, was eine Route per next(error) weiterreicht oder was in einer
// async-Route wirft, landet hier. Vier Parameter sind Pflicht – daran
// erkennt Express eine Fehler-Middleware.
// --------------------------------------------------------------------------
app.use((error, req, res, next) => {
  // TmdbError (src/tmdb.js) bringt einen passenden Status mit, z. B.
  // 412 = "kein API-Key" oder 401 = "Key ungültig".
  const status = error.status && error.status >= 400 && error.status < 600 ? error.status : 500;

  // Echte Serverfehler protokollieren; erwartete Zustände (fehlender Key,
  // ungültige Eingabe) müllen das Log nicht voll.
  if (status >= 500) {
    console.error('[error]', req.method, req.originalUrl, error);
  }

  res.status(status).json({
    error: error.message || 'Unerwarteter Fehler.',
    code: error.name === 'TmdbError' ? 'tmdb_error' : undefined,
  });
});

// --------------------------------------------------------------------------
// Start
// --------------------------------------------------------------------------

// Abgelaufene Sessions aufräumen, bevor es losgeht.
const pruned = pruneSessions();
if (pruned > 0) console.log(`[start] ${pruned} abgelaufene Sitzungen entfernt.`);

/**
 * Startet den HTTP- bzw. HTTPS-Server.
 *
 * Ohne ENABLE_HTTPS läuft schlicht ein HTTP-Server – der Normalfall, wenn ein
 * Reverse Proxy davorsteht und sich um das Zertifikat kümmert.
 *
 * Mit ENABLE_HTTPS kommt ein zweiter Server hinzu: HTTPS auf dem eigenen Port,
 * und der HTTP-Port leitet nur noch dorthin um. So landet niemand versehentlich
 * auf der unverschlüsselten Fassung – was besonders wichtig ist, weil Passkeys
 * genau daran scheitern würden.
 *
 * @returns {import('node:http').Server} der Server, der die Anwendung bedient
 */
function startServer() {
  if (!config.https) {
    return app.listen(config.port, config.host, onListening);
  }

  // Zertifikat besorgen bzw. erzeugen (src/tls.js).
  let tls;
  try {
    tls = getTlsOptions();
  } catch (error) {
    console.error('');
    console.error(`[tls] HTTPS konnte nicht eingerichtet werden: ${error.message}`);
    console.error('[tls] Streamo startet stattdessen mit HTTP.');
    console.error('');
    return app.listen(config.port, config.host, onListening);
  }

  const httpsServer = https.createServer({ cert: tls.cert, key: tls.key }, app);
  httpsServer.listen(config.httpsPort, config.host, onListening);

  // Der HTTP-Port leitet auf HTTPS um – ein eigener, winziger Server, der die
  // Express-Anwendung gar nicht erst zu sehen bekommt.
  http
    .createServer((req, res) => {
      // Den Host aus der Anfrage übernehmen, aber den Port ersetzen. So
      // funktioniert die Umleitung unabhängig davon, unter welchem Namen
      // Streamo aufgerufen wurde.
      const host = String(req.headers.host || config.tlsHostname).split(':')[0];

      res.writeHead(301, {
        Location: `https://${host}:${config.httpsPort}${req.url}`,
      });
      res.end();
    })
    .listen(config.port, config.host, () => {
      console.log(`[tls] Port ${config.port} leitet auf HTTPS um.`);
    });

  if (tls.selfSigned) {
    console.log('');
    console.log('  Hinweis: Das Zertifikat ist selbstsigniert. Der Browser zeigt beim');
    console.log('  ersten Aufruf eine Warnung – einmal bestätigen, dann funktionieren');
    console.log('  auch Passkeys. Die Desktop-App akzeptiert es ohne Rückfrage.');
    console.log('');
  }

  return httpsServer;
}

/** Wird aufgerufen, sobald der Server lauscht – gibt den Startbanner aus. */
function onListening() {
  console.log('');
  console.log('  ███████╗████████╗██████╗ ███████╗ █████╗ ███╗   ███╗ ██████╗');
  console.log('  ██╔════╝╚══██╔══╝██╔══██╗██╔════╝██╔══██╗████╗ ████║██╔═══██╗');
  console.log('  ███████╗   ██║   ██████╔╝█████╗  ███████║██╔████╔██║██║   ██║');
  console.log('  ╚════██║   ██║   ██╔══██╗██╔══╝  ██╔══██║██║╚██╔╝██║██║   ██║');
  console.log('  ███████║   ██║   ██║  ██║███████╗██║  ██║██║ ╚═╝ ██║╚██████╔╝');
  console.log('  ╚══════╝   ╚═╝   ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚═╝     ╚═╝ ╚═════╝');
  console.log('');
  // Bei HTTPS gilt der andere Port, und der Hostname aus dem Zertifikat ist
  // die Adresse, die tatsächlich funktioniert – eine IP würde das Zertifikat
  // nicht abdecken.
  const scheme = config.https ? 'https' : 'http';
  const shownHost = config.https
    ? config.tlsHostname
    : config.host === '0.0.0.0'
      ? 'localhost'
      : config.host;
  const shownPort = config.https ? config.httpsPort : config.port;

  console.log(`  Version   ${config.version}`);
  console.log(`  Adresse   ${scheme}://${shownHost}:${shownPort}`);
  console.log(`  Daten     ${config.dataDir}`);
  console.log(`  Region    ${config.region}   Sprache ${config.language}`);
  console.log(`  TMDB-Key  ${hasApiKey() ? 'hinterlegt' : 'FEHLT – im Setup eintragen'}`);
  console.log(
    `  Passkeys  ${config.https || config.trustProxy ? 'möglich' : 'erst mit HTTPS und einem Hostnamen'}`,
  );
  console.log('');

  // Erst starten, wenn der Server wirklich lauscht.
  startSyncScheduler();
}

const server = startServer();

/**
 * Geordnetes Herunterfahren.
 *
 * systemd schickt beim Stoppen SIGTERM, Strg+C in der Konsole SIGINT. In
 * beiden Fällen sollen laufende Anfragen zu Ende bedient und der Sync-Timer
 * gestoppt werden, damit der Prozess sich sauber beendet.
 */
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`\n[stop] ${signal} empfangen – fahre herunter …`);
    stopSyncScheduler();

    server.close(() => {
      console.log('[stop] Auf Wiedersehen.');
      process.exit(0);
    });

    // Notbremse: Falls eine Verbindung hängt, nach 10 Sekunden hart beenden.
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
