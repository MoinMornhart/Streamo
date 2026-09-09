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
app.use(
  express.static(config.publicDir, {
    // index.html nie aus dem Cache: Sie enthält die Verweise auf die
    // JS-Dateien, und nach einem Update soll sofort die neue Version laden.
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      } else {
        // CSS/JS/Bilder dürfen eine Stunde im Browser bleiben.
        res.setHeader('Cache-Control', 'public, max-age=3600');
      }
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
  res.sendFile(path.join(config.publicDir, 'index.html'));
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
