/**
 * ---------------------------------------------------------------------------
 * desktop/main.js – Der Hauptprozess der Streamo-Desktop-App
 * ---------------------------------------------------------------------------
 * Rolle im Gesamtsystem:
 *   Die Desktop-App ist kein zweites Streamo. Sie verbindet sich mit deinem
 *   Server im Netz und zeigt dessen Oberfläche in einem eigenen Fenster – dazu
 *   Dinge, die eine Webseite im Browser nicht kann:
 *
 *     - ein Symbol im Infobereich (Tray), das im Hintergrund weiterläuft
 *     - Windows-Benachrichtigungen, wenn eine neue Episode erschienen ist
 *     - Start zusammen mit Windows
 *     - ein globales Tastenkürzel für die Suche (Strg+Umschalt+S)
 *     - Vertrauen für ein selbstsigniertes Zertifikat, ohne jedes Mal eine
 *       Warnung wegklicken zu müssen – dadurch funktionieren hier auch
 *       Passkeys, wenn der Browser sie ablehnen würde
 *
 * Aufbau eines Electron-Programms – zwei getrennte Welten:
 *   - HAUPTPROZESS (diese Datei): darf ans Betriebssystem, kennt aber kein
 *     Fenster-DOM. Hier laufen Tray, Benachrichtigungen, Einstellungen.
 *   - RENDERER (die angezeigte Seite): das ist deine Streamo-Oberfläche vom
 *     Server. Sie ist bewusst vom System abgeschottet (contextIsolation),
 *     damit eine fremde Webseite niemals an dein Dateisystem käme.
 *   Verbunden werden beide ausschließlich über desktop/preload.js.
 *
 * Verknüpfungen:
 *   - desktop/preload.js        -> die schmale Brücke zwischen beiden Welten
 *   - desktop/renderer/connect.html -> Bildschirm "Mit Server verbinden"
 *   - src/routes/*.js (Server)  -> die API, die hier abgefragt wird
 * ---------------------------------------------------------------------------
 */

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  Notification,
  ipcMain,
  shell,
  globalShortcut,
  dialog,
  nativeImage,
  // Zugriff auf den Zwischenspeicher - beim Start wird er geleert, damit die
  // Oberflaeche nach einem Server-Update sicher die neue ist.
  session,
} = require('electron');

const path = require('node:path');
const fs = require('node:fs');

// Selbstaktualisierung über die GitHub-Veröffentlichungen. Siehe den
// Abschnitt "Updates" weiter unten.
const { autoUpdater } = require('electron-updater');

// ==========================================================================
// Sprache: Deutsch oder Englisch, nach dem Betriebssystem
// ==========================================================================
// Das Programmfenster zeigt die Weboberfläche, und die hat ihren eigenen
// Umschalter (public/js/i18n.js). Tray-Menü, Benachrichtigungen und
// Update-Dialoge zeichnet dagegen Electron selbst – sie richten sich nach der
// Sprache des Systems: Deutsch auf einem deutschen Windows, sonst Englisch.
//
// Schlüssel ist der deutsche Text, wie er im Code steht; {name} sind
// Platzhalter für eingesetzte Werte. Dasselbe Prinzip wie im Wörterbuch der
// Weboberfläche, nur klein genug für eine Datei.
const EN = {
  'Streamo öffnen': 'Open Streamo',
  Weiterschauen: 'Continue watching',
  'Meine Bibliothek': 'My library',
  Entdecken: 'Discover',
  'Bei neuen Episoden benachrichtigen': 'Notify me about new episodes',
  'Mit Windows starten': 'Start with Windows',
  'Beim Schließen im Hintergrund lassen': 'Keep running in the background when closed',
  'Update installieren und neu starten': 'Install update and restart',
  'Nach Updates suchen': 'Check for updates',
  'Update-Protokoll öffnen': 'Open update log',
  'Anderen Server verbinden …': 'Connect to another server …',
  Beenden: 'Quit',
  'Streamo ist unter {url} nicht erreichbar ({reason}).': 'Streamo is not reachable at {url} ({reason}).',
  '1 ungesehene Episode': '1 unwatched episode',
  '{n} ungesehene Episoden': '{n} unwatched episodes',
  ' · läuft bei {where}': ' · on {where}',
  'Streamo wird aktualisiert': 'Streamo is updating',
  'Version {version} wird im Hintergrund geladen.': 'Version {version} is downloading in the background.',
  'Streamo ist auf dem neuesten Stand.': 'Streamo is up to date.',
  'Installierte Version: {version}': 'Installed version: {version}',
  'Alles klar': 'OK',
  'Update bereit': 'Update ready',
  'Streamo {version} ist fertig heruntergeladen.': 'Streamo {version} has finished downloading.',
  'Beim Neustart wird es installiert. Du kannst auch später neu starten – dann geschieht es automatisch beim nächsten Beenden.':
    'It will be installed on restart. You can also restart later – then it happens automatically the next time you quit.',
  'Jetzt neu starten': 'Restart now',
  Später: 'Later',
  'Die Suche nach Updates ist fehlgeschlagen.': 'Checking for updates failed.',
  'Im Entwicklungsmodus gibt es keine Updates.': 'There are no updates in development mode.',
  'Bitte gib die Adresse deines Servers ein.': 'Please enter the address of your server.',
  'Die Adresse muss mit http:// oder https:// beginnen.': 'The address must start with http:// or https://.',
  'Der Server antwortet mit Fehler {status}.': 'The server responds with error {status}.',
  'Unter dieser Adresse antwortet kein Streamo.': 'No Streamo answers at this address.',
  'Keine Verbindung: {reason}. Läuft der Server, und stimmt die Adresse?':
    'No connection: {reason}. Is the server running, and is the address right?',
};

/**
 * Übersetzt einen Text in die Sprache des Systems und setzt Werte ein.
 *
 * Erst zur Laufzeit aufrufen, nicht beim Laden der Datei: app.getLocale()
 * liefert die Sprache verlässlich erst, wenn Electron bereit ist – und alle
 * Stellen, die L() benutzen, laufen ohnehin erst danach.
 *
 * @param {string} text     deutscher Text (Schlüssel in EN)
 * @param {object} [values] Werte für {name}-Platzhalter
 * @returns {string}
 */
function L(text, values = {}) {
  const german = String(app.getLocale() || 'de').toLowerCase().startsWith('de');
  let out = german ? text : EN[text] ?? text;
  for (const [name, value] of Object.entries(values)) {
    out = out.split(`{${name}}`).join(String(value));
  }
  return out;
}

// --------------------------------------------------------------------------
// Einstellungen der App.
//
// Bewusst eine schlichte JSON-Datei statt einer Bibliothek wie electron-store:
// Es sind fünf Werte, und die Datei liegt an einem Ort, den man notfalls von
// Hand aufmachen kann (unter Windows: %APPDATA%/Streamo/settings.json).
// --------------------------------------------------------------------------
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

/** Vorgaben, solange nichts eingestellt wurde. */
const DEFAULT_SETTINGS = {
  /** Adresse des Streamo-Servers, z. B. https://streamo.example.de */
  serverUrl: '',
  /** Beim Schließen des Fensters ins Tray statt beenden */
  minimizeToTray: true,
  /** Mit Windows starten */
  autoStart: false,
  /** Benachrichtigen, wenn eine neue Episode erschienen ist */
  notifyNewEpisodes: true,
  /** Abstand der Prüfung auf neue Episoden in Minuten */
  checkIntervalMinutes: 60,
  /** Zertifikatsfehler dieses Servers ignorieren (selbstsigniertes Zertifikat) */
  allowSelfSignedCert: false,
  /** Zuletzt genutzte Fenstergröße, damit sie beim nächsten Start wiederkommt */
  windowBounds: { width: 1280, height: 860 },
};

/** @type {typeof DEFAULT_SETTINGS} */
let settings = { ...DEFAULT_SETTINGS };

/**
 * Lädt die Einstellungen von der Festplatte.
 * Fehler werden verschluckt: Eine beschädigte Datei darf nicht dazu führen,
 * dass die App gar nicht mehr startet – dann gelten eben die Vorgaben.
 */
function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      settings = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
    }
  } catch (error) {
    console.error('Einstellungen nicht lesbar, verwende Vorgaben:', error.message);
  }
}

/**
 * Schreibt die Einstellungen zurück.
 * @param {Partial<typeof DEFAULT_SETTINGS>} [changes] Nur die geänderten Felder
 */
function saveSettings(changes = {}) {
  settings = { ...settings, ...changes };

  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch (error) {
    console.error('Einstellungen nicht speicherbar:', error.message);
  }
}

// --------------------------------------------------------------------------
// Zustand zur Laufzeit
// --------------------------------------------------------------------------

/** @type {BrowserWindow|null} */
let mainWindow = null;
/** @type {Tray|null} */
let tray = null;
/** @type {NodeJS.Timeout|null} Zeitgeber für die Episodenprüfung */
let episodeTimer = null;
/** Wird true, sobald der Benutzer wirklich beenden will (nicht nur schließen). */
let reallyQuitting = false;

/**
 * Merkt sich, welche Episoden bereits gemeldet wurden.
 * Ohne dieses Gedächtnis käme bei jeder Prüfung dieselbe Meldung erneut.
 * @type {Set<string>}
 */
const notifiedEpisodes = new Set();

// --------------------------------------------------------------------------
// Nur eine Instanz zulassen.
//
// Startet man Streamo ein zweites Mal, soll nicht ein zweites Fenster
// aufgehen, sondern das vorhandene nach vorn kommen. requestSingleInstanceLock
// liefert im zweiten Prozess false – der beendet sich dann sofort wieder.
// --------------------------------------------------------------------------
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showWindow();
  });
}

/**
 * Baut die vollständige URL zum Server, ggf. mit einem Pfad dahinter.
 * @param {string} [routePath] z. B. "/library"
 * @returns {string}
 */
function serverUrl(routePath = '') {
  // Abschließenden Schrägstrich entfernen, damit nicht "…//library" entsteht.
  const base = settings.serverUrl.replace(/\/+$/, '');
  return base + routePath;
}

/**
 * Erzeugt das Programmsymbol.
 *
 * Liegt keine Symboldatei bei, wird eines aus einer eingebetteten PNG-Grafik
 * erzeugt – so startet die App auch dann mit einem sichtbaren Tray-Symbol,
 * wenn beim Bauen etwas gefehlt hat.
 *
 * @returns {Electron.NativeImage}
 */
function appIcon() {
  const iconPath = path.join(__dirname, 'assets', 'icon.png');

  if (fs.existsSync(iconPath)) {
    const image = nativeImage.createFromPath(iconPath);
    if (!image.isEmpty()) return image;
  }

  // Rückfall: ein violettes Quadrat mit "S", als Data-URL eingebettet.
  return nativeImage.createFromDataURL(
    'data:image/svg+xml;base64,' +
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">
           <rect width="64" height="64" rx="14" fill="#6c5ce7"/>
           <text x="32" y="46" font-size="40" font-family="sans-serif"
                 font-weight="700" fill="white" text-anchor="middle">S</text>
         </svg>`,
      ).toString('base64'),
  );
}

// ==========================================================================
// Das Hauptfenster
// ==========================================================================

/**
 * Legt das Hauptfenster an und lädt entweder den Verbindungsbildschirm oder
 * direkt die Streamo-Oberfläche vom Server.
 */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: settings.windowBounds.width,
    height: settings.windowBounds.height,
    minWidth: 900,
    minHeight: 600,
    // Zum Farbschema der Weboberfläche passend, damit beim Laden nicht kurz
    // eine weiße Fläche aufblitzt.
    backgroundColor: '#0b0e14',
    title: 'Streamo',
    icon: appIcon(),
    // Erst anzeigen, wenn Inhalt da ist (siehe ready-to-show weiter unten).
    show: false,

    webPreferences: {
      // Die geladene Seite kommt von einem Server. Sie darf unter keinen
      // Umständen an Node.js oder das Dateisystem herankommen.
      nodeIntegration: false,
      contextIsolation: true,
      // Die einzige erlaubte Brücke – siehe desktop/preload.js.
      preload: path.join(__dirname, 'preload.js'),
      // Eigene Sitzung, damit Anmeldung und Cookies der App unabhängig vom
      // System-Browser sind.
      partition: 'persist:streamo',
    },
  });

  // Fenstergröße merken, damit sie beim nächsten Start wiederkommt.
  mainWindow.on('resize', () => {
    if (!mainWindow.isMaximized()) {
      const [width, height] = mainWindow.getSize();
      saveSettings({ windowBounds: { width, height } });
    }
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // ------------------------------------------------------------------------
  // Tastenkürzel, die sonst am Menü hingen
  // ------------------------------------------------------------------------
  // Mit dem Standardmenü sind auch dessen Kürzel verschwunden. Kopieren und
  // Einfügen macht Chromium in Eingabefeldern von sich aus – Neuladen und die
  // Entwicklerwerkzeuge nicht. Beides ist zu nützlich, um es zu verlieren:
  // F5 hilft, wenn die Oberfläche einmal hängt, und ohne die Werkzeuge lässt
  // sich ein Anzeigefehler nicht untersuchen.
  //
  // before-input-event greift, bevor die Seite die Taste sieht.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;

    const neuLaden = input.key === 'F5' || (input.control && input.key.toLowerCase() === 'r');

    if (neuLaden) {
      // Ohne Zwischenspeicher – wer neu lädt, will den aktuellen Stand.
      mainWindow.webContents.reloadIgnoringCache();
      event.preventDefault();
      return;
    }

    if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  // ------------------------------------------------------------------------
  // Schließen bedeutet nicht beenden.
  // Mit aktiviertem Tray verschwindet das Fenster nur; die App läuft weiter
  // und kann weiter über neue Episoden benachrichtigen.
  // ------------------------------------------------------------------------
  mainWindow.on('close', (event) => {
    if (!reallyQuitting && settings.minimizeToTray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  // ------------------------------------------------------------------------
  // Externe Verweise im richtigen Browser öffnen.
  //
  // Die Detailseite verlinkt zu JustWatch und den Anbietern. Solche Seiten
  // gehören in den Systembrowser, nicht in dieses Fenster – dort hätte man
  // weder Adresszeile noch Lesezeichen und säße in einer Sackgasse.
  // ------------------------------------------------------------------------
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Dasselbe für gewöhnliche Klicks auf fremde Adressen.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!settings.serverUrl || !url.startsWith(serverUrl())) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  // ------------------------------------------------------------------------
  // Fehler beim Laden abfangen.
  // Ist der Server aus oder die Adresse falsch, soll nicht eine leere weiße
  // Seite dastehen, sondern der Verbindungsbildschirm mit einer Erklärung.
  // ------------------------------------------------------------------------
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, url) => {
    // -3 ist ein abgebrochener Ladevorgang (z. B. eine Weiterleitung) und
    // kein echter Fehler.
    if (errorCode === -3) return;

    showConnectScreen({
      error: L('Streamo ist unter {url} nicht erreichbar ({reason}).', { url, reason: errorDescription }),
    });
  });

  // Ohne hinterlegte Adresse zuerst nach dem Server fragen.
  if (settings.serverUrl) {
    mainWindow.loadURL(serverUrl());
  } else {
    showConnectScreen();
  }
}

/**
 * Zeigt den Verbindungsbildschirm.
 * @param {{error?: string}} [options]
 */
function showConnectScreen(options = {}) {
  if (!mainWindow) return;

  const file = path.join(__dirname, 'renderer', 'connect.html');

  // Die Fehlermeldung und die zuletzt genutzte Adresse werden als
  // Query-Parameter übergeben – einfacher als eine eigene Nachrichtenrunde.
  const params = new URLSearchParams();
  if (options.error) params.set('error', options.error);
  if (settings.serverUrl) params.set('url', settings.serverUrl);

  mainWindow.loadFile(file, { search: params.toString() });
}

/**
 * Holt das Fenster nach vorn – aus dem Tray, aus dem Hintergrund, egal woher.
 */
function showWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }

  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/**
 * Öffnet eine bestimmte Seite der Weboberfläche, z. B. "/library".
 * @param {string} routePath
 */
function openRoute(routePath) {
  if (!settings.serverUrl) {
    showConnectScreen();
    return;
  }

  showWindow();
  mainWindow.loadURL(serverUrl(routePath));
}

// ==========================================================================
// Tray-Symbol
// ==========================================================================

/**
 * Legt das Symbol im Infobereich an und baut sein Kontextmenü.
 * Wird nach jeder Einstellungsänderung erneut aufgerufen, damit die Haken
 * im Menü stimmen.
 */
function createTray() {
  if (!tray) {
    tray = new Tray(appIcon());
    tray.setToolTip('Streamo');

    // Doppelklick auf das Symbol holt das Fenster zurück – unter Windows die
    // erwartete Geste.
    tray.on('double-click', showWindow);
  }

  const menu = Menu.buildFromTemplate([
    { label: L('Streamo öffnen'), click: showWindow },
    { type: 'separator' },
    { label: L('Weiterschauen'), click: () => openRoute('/library?status=watching') },
    { label: L('Meine Bibliothek'), click: () => openRoute('/library') },
    { label: L('Entdecken'), click: () => openRoute('/') },
    { type: 'separator' },
    {
      label: L('Bei neuen Episoden benachrichtigen'),
      type: 'checkbox',
      checked: settings.notifyNewEpisodes,
      click: (item) => {
        saveSettings({ notifyNewEpisodes: item.checked });
        // Zeitgeber neu aufsetzen, damit die Änderung sofort greift.
        startEpisodeWatcher();
      },
    },
    {
      label: L('Mit Windows starten'),
      type: 'checkbox',
      checked: settings.autoStart,
      click: (item) => setAutoStart(item.checked),
    },
    {
      label: L('Beim Schließen im Hintergrund lassen'),
      type: 'checkbox',
      checked: settings.minimizeToTray,
      click: (item) => saveSettings({ minimizeToTray: item.checked }),
    },
    { type: 'separator' },

    // Steht ein Update bereit, tritt der Eintrag an die erste Stelle des
    // Update-Bereichs und sagt deutlich, was passiert.
    updateReady
      ? {
          label: L('Update installieren und neu starten'),
          click: () => {
            reallyQuitting = true;
            autoUpdater.quitAndInstall();
          },
        }
      : { label: L('Nach Updates suchen'), click: checkForUpdatesManually },

    // Der direkte Weg zum Protokoll. Wenn die Selbstaktualisierung wieder
    // einmal nicht tut, was sie soll, steht hier warum – ohne dass man erst
    // %APPDATA% suchen muss.
    {
      label: L('Update-Protokoll öffnen'),
      click: () => {
        // shell.openPath öffnet die Datei im Standardprogramm für .log,
        // meistens dem Editor. Gibt es sie noch nicht, wird sie leer
        // angelegt – eine Fehlermeldung wäre hier verwirrender.
        try {
          if (!fs.existsSync(UPDATE_LOG_FILE)) {
            fs.writeFileSync(UPDATE_LOG_FILE, 'Noch keine Einträge.\n', 'utf8');
          }
        } catch {
          /* nicht schreibbar – dann öffnet openPath eben nichts */
        }

        shell.openPath(UPDATE_LOG_FILE);
      },
    },

    { label: L('Anderen Server verbinden …'), click: () => showConnectScreen() },
    {
      label: L('Beenden'),
      click: () => {
        reallyQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(menu);
}

/**
 * Schaltet den Start mit dem Betriebssystem ein oder aus.
 *
 * setLoginItemSettings trägt die App unter Windows in die Registry ein
 * (HKCU\...\Run) und unter macOS in die Anmeldeobjekte. Unter Linux gibt es
 * keine einheitliche Entsprechung – dort bleibt die Einstellung wirkungslos,
 * deshalb der Hinweis in der Anleitung.
 *
 * @param {boolean} enabled
 */
function setAutoStart(enabled) {
  saveSettings({ autoStart: enabled });

  app.setLoginItemSettings({
    openAtLogin: enabled,
    // Beim automatischen Start direkt ins Tray, ohne Fenster.
    args: ['--hidden'],
  });
}

// ==========================================================================
// Benachrichtigung über neue Episoden
// ==========================================================================

/**
 * Fragt den Server, ob es bei den laufenden Serien neue Episoden gibt.
 *
 * Umgesetzt über die vorhandene API: Die Bibliothek mit Status "watching"
 * liefert für jede Serie den Fortschritt. Sind mehr Episoden erschienen als
 * gesehen wurden UND ist die Serie nicht abgeschlossen, gibt es etwas Neues.
 *
 * Die Anfrage läuft mit den Cookies der App-Sitzung. Ist niemand angemeldet,
 * antwortet der Server mit 401 – dann passiert einfach nichts.
 */
async function checkForNewEpisodes() {
  if (!settings.serverUrl || !settings.notifyNewEpisodes) return;

  try {
    // Die Anfrage muss aus der Sitzung des Fensters kommen, sonst fehlt das
    // Session-Cookie. net.fetch mit der Partition erledigt das.
    const { net } = require('electron');
    const { session } = require('electron');

    const response = await net.fetch(serverUrl('/api/library?status=watching'), {
      session: session.fromPartition('persist:streamo'),
    });

    if (!response.ok) return; // nicht angemeldet oder Server neu gestartet

    const data = await response.json();

    for (const entry of data.entries || []) {
      const progress = entry.progress;
      if (!progress || progress.total === 0) continue;

      // Es gibt ungesehene Episoden.
      const unseen = progress.total - progress.watched;
      if (unseen <= 0) continue;

      // Nur bei laufenden Serien melden – bei einer abgeschlossenen Serie
      // sind ungesehene Episoden schlicht Rückstand, keine Neuigkeit.
      const isRunning = entry.showStatus === 'Returning Series';
      if (!isRunning) continue;

      // Pro Serie und Episodenstand nur einmal melden.
      const key = `${entry.showId}:${progress.total}`;
      if (notifiedEpisodes.has(key)) continue;
      notifiedEpisodes.add(key);

      // Beim allerersten Durchlauf nach dem Start nicht benachrichtigen –
      // sonst prasseln beim Öffnen der App zwanzig Meldungen herein.
      if (notifiedEpisodes.size <= 1 && unseen > 3) continue;

      const where = entry.availability?.bestOffer?.name;

      new Notification({
        title: entry.title,
        body:
          (unseen === 1 ? L('1 ungesehene Episode') : L('{n} ungesehene Episoden', { n: unseen })) +
          (where ? L(' · läuft bei {where}', { where }) : ''),
        icon: appIcon(),
        silent: false,
      })
        .on('click', () => openRoute(`/show/${entry.mediaType}/${entry.tmdbId}`))
        .show();
    }
  } catch (error) {
    // Netzwerkfehler sind hier belanglos – beim nächsten Durchlauf erneut.
    console.error('Episodenprüfung fehlgeschlagen:', error.message);
  }
}

/**
 * Startet die regelmäßige Prüfung neu (oder stoppt sie).
 */
function startEpisodeWatcher() {
  if (episodeTimer) {
    clearInterval(episodeTimer);
    episodeTimer = null;
  }

  if (!settings.notifyNewEpisodes) return;

  const intervalMs = Math.max(15, settings.checkIntervalMinutes) * 60_000;

  // Erste Prüfung nach einer Minute – nicht sofort, damit die Anmeldung
  // Gelegenheit hat, sich zu setzen.
  setTimeout(checkForNewEpisodes, 60_000);

  episodeTimer = setInterval(checkForNewEpisodes, intervalMs);
}

// ==========================================================================
// Updates
// ==========================================================================
/**
 * Die App hält sich selbst aktuell.
 *
 * Woher kommen die Updates? Aus den Veröffentlichungen dieses
 * GitHub-Projekts. Der Bau-Workflow legt dort neben der .exe eine Datei
 * latest.yml ab, in der Version und Prüfsumme stehen – genau die liest
 * electron-updater aus.
 *
 * Ablauf: Kurz nach dem Start und danach alle paar Stunden wird nachgesehen.
 * Gibt es etwas Neues, lädt die App es im Hintergrund herunter und fragt
 * anschließend, ob jetzt neu gestartet werden soll. Wer ablehnt, bekommt das
 * Update beim nächsten regulären Beenden – ohne weitere Rückfrage.
 *
 * Wichtig zu wissen: Das aktualisiert NUR die Desktop-App. Der Server auf dem
 * Proxmox-Container bringt sich getrennt auf Stand (dort per "update").
 */

/** Wie oft wird nachgesehen? Vier Stunden sind ein guter Kompromiss. */
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

/** Merkt sich, ob ein Update bereits heruntergeladen und bereitgestellt ist. */
let updateReady = false;

/**
 * Wohin das Update-Protokoll geschrieben wird.
 *
 * Unter Windows: %APPDATA%/Streamo/update.log
 *
 * Warum überhaupt eine Datei? Weil eine fertig gebaute App keine Konsole hat.
 * Als die Selbstaktualisierung nicht funktionierte, war von außen überhaupt
 * nichts zu sehen: Die Suche läuft im Hintergrund, der Fehler landete in einem
 * console.error, das niemand je zu Gesicht bekam. Der eigentliche Grund – ein
 * Dateiname, der auf GitHub anders hieß als in der latest.yml – wäre in einer
 * einzigen Protokollzeile sofort sichtbar gewesen.
 *
 * Erreichbar über das Tray-Menü: "Update-Protokoll öffnen".
 */
const UPDATE_LOG_FILE = path.join(app.getPath('userData'), 'update.log');

/**
 * Schreibt eine Zeile ins Update-Protokoll – und zusätzlich auf die Konsole,
 * damit sie im Entwicklungsmodus dort auftaucht.
 *
 * Die Datei wird bei 256 KB von vorn begonnen. Ohne diese Grenze wüchse sie
 * über Monate unbemerkt, denn geschrieben wird alle vier Stunden.
 *
 * @param {string} level 'info' | 'warn' | 'error'
 * @param {string} message
 */
function updateLog(level, message) {
  const line = `${new Date().toISOString()} [${level}] ${message}`;

  if (level === 'error') console.error(`[update] ${message}`);
  else console.log(`[update] ${message}`);

  try {
    // Ab einer gewissen Größe von vorn anfangen. Das Alte ist dann weg –
    // aber für die Fehlersuche zählt ohnehin nur der letzte Versuch.
    if (fs.existsSync(UPDATE_LOG_FILE) && fs.statSync(UPDATE_LOG_FILE).size > 256 * 1024) {
      fs.writeFileSync(UPDATE_LOG_FILE, '');
    }

    fs.appendFileSync(UPDATE_LOG_FILE, `${line}\n`, 'utf8');
  } catch {
    // Ein nicht schreibbares Protokoll darf die App nicht aufhalten.
  }
}

/**
 * Richtet die Selbstaktualisierung ein.
 *
 * @param {boolean} [silent] true = keine Meldung, wenn es nichts Neues gibt.
 *   Beim automatischen Nachsehen im Hintergrund gewollt; beim Klick auf
 *   "Nach Updates suchen" nicht, dort will man eine Antwort.
 */
function setupUpdater() {
  // Updates werden von Hand bestätigt, nicht beim Beenden untergeschoben,
  // ohne dass jemand davon weiß.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  // electron-updater schreibt sein Innenleben in einen "logger", wenn man ihm
  // einen gibt: welche Adresse es abfragt, welche Version es dort findet, und
  // vor allem, woran ein Download scheitert. Genau diese Zeilen haben zuletzt
  // gefehlt. Die Schnittstelle verlangt die vier Methoden.
  autoUpdater.logger = {
    info: (message) => updateLog('info', String(message)),
    warn: (message) => updateLog('warn', String(message)),
    error: (message) => updateLog('error', String(message)),
    debug: () => {
      /* zu gesprächig – würde das Protokoll fluten */
    },
  };

  // In der Entwicklung (npm start) gibt es keine installierte Anwendung, die
  // sich ersetzen ließe – dann würde jeder Aufruf nur eine Fehlermeldung
  // erzeugen.
  if (!app.isPackaged) {
    updateLog('info', 'Entwicklungsmodus – Selbstaktualisierung ist aus.');
    return;
  }

  updateLog('info', `Start. Installierte Version: ${app.getVersion()}`);

  autoUpdater.on('update-available', (info) => {
    updateLog('info', `Neue Version verfügbar: ${info.version}`);

    new Notification({
      title: L('Streamo wird aktualisiert'),
      body: L('Version {version} wird im Hintergrund geladen.', { version: info.version }),
      icon: appIcon(),
    }).show();
  });

  autoUpdater.on('update-not-available', () => {
    updateLog('info', 'Streamo ist aktuell.');

    // Nur melden, wenn jemand ausdrücklich gefragt hat.
    if (manualUpdateCheck) {
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Streamo',
        message: L('Streamo ist auf dem neuesten Stand.'),
        detail: L('Installierte Version: {version}', { version: app.getVersion() }),
        buttons: [L('Alles klar')],
      });
      manualUpdateCheck = false;
    }
  });

  autoUpdater.on('download-progress', (progress) => {
    // Fortschritt in der Taskleiste anzeigen – dezenter als ein Fenster.
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setProgressBar(progress.percent / 100);
    }
  });

  autoUpdater.on('update-downloaded', async (info) => {
    updateReady = true;

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setProgressBar(-1); // Fortschrittsanzeige wieder ausblenden
    }

    // Tray-Menü neu aufbauen, damit der Eintrag "Update installieren"
    // erscheint.
    createTray();

    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: L('Update bereit'),
      message: L('Streamo {version} ist fertig heruntergeladen.', { version: info.version }),
      detail:
        L('Beim Neustart wird es installiert. Du kannst auch später neu starten – dann geschieht es automatisch beim nächsten Beenden.'),
      buttons: [L('Jetzt neu starten'), L('Später')],
      defaultId: 0,
      cancelId: 1,
    });

    if (response === 0) {
      // Der Merker verhindert, dass das Fenster beim Schließen nur ins Tray
      // wandert, statt die App wirklich zu beenden.
      reallyQuitting = true;
      autoUpdater.quitAndInstall();
    }
  });

  autoUpdater.on('error', (error) => {
    // Mit Stapelspur: Bei einem fehlgeschlagenen Download steht dort die
    // Adresse, die nicht erreichbar war – die entscheidende Information.
    updateLog('error', `Fehlgeschlagen: ${error?.stack || error?.message || error}`);

    if (manualUpdateCheck) {
      dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: 'Streamo',
        message: L('Die Suche nach Updates ist fehlgeschlagen.'),
        detail: String(error?.message ?? error),
        buttons: [L('Alles klar')],
      });
      manualUpdateCheck = false;
    }
  });

  // Erste Prüfung nach einer halben Minute – der Start soll nicht darauf
  // warten müssen.
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 30_000);

  setInterval(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, UPDATE_CHECK_INTERVAL_MS);

  console.log(`[update] Selbstaktualisierung aktiv (Version ${app.getVersion()}).`);
}

/** Wurde die Suche von Hand angestoßen? Steuert, ob eine Meldung erscheint. */
let manualUpdateCheck = false;

/**
 * Sucht auf Wunsch nach Updates – aufgerufen aus dem Tray-Menü.
 */
function checkForUpdatesManually() {
  if (!app.isPackaged) {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Streamo',
      message: L('Im Entwicklungsmodus gibt es keine Updates.'),
      buttons: [L('Alles klar')],
    });
    return;
  }

  if (updateReady) {
    reallyQuitting = true;
    autoUpdater.quitAndInstall();
    return;
  }

  manualUpdateCheck = true;
  autoUpdater.checkForUpdates().catch(() => {});
}

// ==========================================================================
// Nachrichten aus dem Verbindungsbildschirm
// ==========================================================================

/**
 * Prüft eine Serveradresse, indem /api/health abgefragt wird.
 * Aufgerufen aus renderer/connect.html über die Brücke in preload.js.
 */
ipcMain.handle('streamo:test-connection', async (event, url) => {
  const base = String(url || '').trim().replace(/\/+$/, '');

  if (!base) return { ok: false, error: L('Bitte gib die Adresse deines Servers ein.') };

  if (!/^https?:\/\//.test(base)) {
    return {
      ok: false,
      error: L('Die Adresse muss mit http:// oder https:// beginnen.'),
    };
  }

  try {
    const { net } = require('electron');
    const response = await net.fetch(`${base}/api/health`);

    if (!response.ok) {
      return { ok: false, error: L('Der Server antwortet mit Fehler {status}.', { status: response.status }) };
    }

    const health = await response.json();

    // Auf ein Feld prüfen, das nur Streamo liefert – sonst würde jede
    // beliebige Webseite als gültig durchgehen.
    if (health.status !== 'ok') {
      return { ok: false, error: L('Unter dieser Adresse antwortet kein Streamo.') };
    }

    return { ok: true, version: health.version, hasApiKey: health.hasApiKey, url: base };
  } catch (error) {
    return {
      ok: false,
      error: L('Keine Verbindung: {reason}. Läuft der Server, und stimmt die Adresse?', { reason: error.message }),
    };
  }
});

/**
 * Speichert die Adresse und lädt Streamo.
 */
ipcMain.handle('streamo:connect', async (event, url, allowSelfSigned) => {
  saveSettings({
    serverUrl: String(url).trim().replace(/\/+$/, ''),
    allowSelfSignedCert: Boolean(allowSelfSigned),
  });

  mainWindow.loadURL(serverUrl());
  startEpisodeWatcher();

  return { ok: true };
});

/** Liefert die aktuellen Einstellungen an den Verbindungsbildschirm. */
ipcMain.handle('streamo:get-settings', () => ({
  serverUrl: settings.serverUrl,
  allowSelfSignedCert: settings.allowSelfSignedCert,
  version: app.getVersion(),
}));

// ==========================================================================
// Zertifikate
// ==========================================================================
/**
 * Selbstsignierte Zertifikate zulassen – aber nur für den eingestellten Server
 * und nur, wenn der Benutzer das ausdrücklich erlaubt hat.
 *
 * Das ist der Grund, warum Passkeys in der Desktop-App auch dann funktionieren,
 * wenn im Browser eine Zertifikatswarnung stünde: Ein bestätigtes Zertifikat
 * gilt als sicherer Kontext.
 *
 * Wichtig ist die Einschränkung auf genau diesen einen Server. Ein pauschales
 * "alle Zertifikatsfehler ignorieren" wäre eine offene Tür.
 */
app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
  if (!settings.allowSelfSignedCert || !settings.serverUrl) {
    callback(false);
    return;
  }

  try {
    if (new URL(url).host === new URL(settings.serverUrl).host) {
      event.preventDefault();
      callback(true); // dieses eine Zertifikat akzeptieren
      return;
    }
  } catch {
    /* unlesbare Adresse – dann eben ablehnen */
  }

  callback(false);
});

// ==========================================================================
// Start und Ende
// ==========================================================================

app.whenReady().then(async () => {
  loadSettings();

  // Unter Windows sorgt die App-ID dafür, dass Benachrichtigungen den
  // richtigen Absender zeigen und nicht "electron.app.Electron".
  if (process.platform === 'win32') {
    app.setAppUserModelId('de.mornhart.streamo');
  }

  // ------------------------------------------------------------------------
  // Das Standardmenü entfernen
  // ------------------------------------------------------------------------
  // Ohne diesen Aufruf setzt Electron von sich aus ein Menü mit "Datei",
  // "Bearbeiten", "Ansicht", "Fenster" und "Hilfe" über die Seite. Es stammt
  // aus dem Baukasten und passt zu Streamo nicht: Es gibt keine Datei zu
  // öffnen, nichts zu drucken, und alles, was man wirklich braucht, steht im
  // Tray-Menü.
  //
  // Auf macOS bleibt das Menü stehen – dort gehört es in die Leiste am oberen
  // Bildschirmrand und ist Teil des Systems, nicht des Fensters. Es dort zu
  // entfernen würde auch Kopieren und Einfügen mitnehmen.
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
  }

  // ------------------------------------------------------------------------
  // Bei jedem Start mit frischen Dateien beginnen
  // ------------------------------------------------------------------------
  // Die App zeigt die Oberfläche vom Server an, und Chromium hebt deren
  // Dateien auf – JavaScript, Stylesheet, Bilder. Nach einem Update des
  // Servers lief die App deshalb unter Umständen tagelang mit der alten
  // Oberfläche weiter, obwohl der Server längst eine neue auslieferte. Von
  // außen sieht das aus, als wäre das Update nicht angekommen.
  //
  // Der Server hängt an seine Skript-Adressen zwar eine Versionsnummer
  // (siehe ASSET_VERSION in src/server.js), aber index.html selbst hat keine –
  // und genau die entscheidet, welche Versionen geladen werden.
  //
  // Einmal beim Start den Zwischenspeicher zu leeren kostet ein paar hundert
  // Kilobyte Nachladen und beseitigt die ganze Fehlerklasse. Angemeldet
  // bleibt man dabei: Das Sitzungs-Cookie liegt nicht im Zwischenspeicher,
  // sondern im Cookie-Speicher, und der wird hier nicht angefasst.
  try {
    await session.defaultSession.clearCache();
    console.log('[start] Zwischenspeicher geleert – die Oberfläche wird frisch geladen.');
  } catch (error) {
    // Kein Grund, deswegen nicht zu starten. Dann ist die Oberfläche eben
    // möglicherweise einen Stand alt.
    console.error('[start] Zwischenspeicher nicht leerbar:', error?.message ?? error);
  }

  createWindow();
  createTray();
  startEpisodeWatcher();
  setupUpdater();

  // Mit "--hidden" gestartet (Autostart): direkt ins Tray, ohne Fenster.
  if (process.argv.includes('--hidden')) {
    mainWindow.hide();
  }

  // Globales Tastenkürzel für die Suche. Schlägt die Registrierung fehl
  // (weil ein anderes Programm die Tastenkombination belegt), ist das kein
  // Grund für eine Fehlermeldung – die App funktioniert auch ohne.
  const registered = globalShortcut.register('CommandOrControl+Shift+S', () => {
    openRoute('/search');
  });

  if (!registered) {
    console.warn('Strg+Umschalt+S ist bereits belegt – Tastenkürzel nicht aktiv.');
  }

  // macOS: Klick aufs Dock-Symbol, wenn kein Fenster offen ist.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showWindow();
  });
});

// Unter Windows und Linux würde das Schließen des letzten Fensters die App
// normalerweise beenden. Mit Tray-Symbol ist das nicht gewollt.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !settings.minimizeToTray) {
    app.quit();
  }
});

app.on('before-quit', () => {
  reallyQuitting = true;
});

app.on('will-quit', () => {
  // Tastenkürzel wieder freigeben, sonst bleibt es systemweit belegt.
  globalShortcut.unregisterAll();
  if (episodeTimer) clearInterval(episodeTimer);
});
