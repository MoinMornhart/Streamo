# Streamo für den PC

Die Desktop-App zeigt deine Streamo-Oberfläche in einem eigenen Programmfenster – und kann dabei ein paar Dinge, die eine Webseite im Browser nicht kann.

---

## Herunterladen

Fertige Installer für Windows liegen unter **[Releases](https://github.com/MoinMornhart/Streamo/releases)**:

1. `Streamo-Setup-<version>.exe` herunterladen (die jeweils oberste Veröffentlichung)
2. Ausführen und dem Installationsassistenten folgen
3. Beim ersten Start die Adresse deines Servers eintragen – dieselbe, die du im Browser aufrufst

> **Windows zeigt eine Warnung?** „Der Computer wurde durch Windows geschützt" erscheint, weil der Installer nicht signiert ist – ein Signaturzertifikat kostet mehrere hundert Euro im Jahr. Über *Weitere Informationen* → *Trotzdem ausführen* geht es weiter. Bei quelloffener Software ohne Firma dahinter ist das der Normalfall.

Gibt es noch keine Veröffentlichung, findest du den jeweils neuesten Bau unter [Actions → Desktop-App](https://github.com/MoinMornhart/Streamo/actions/workflows/desktop.yml) als Anhang am letzten grünen Lauf.

---

## Was die App zusätzlich kann

**Läuft im Hintergrund weiter**
Das Fenster schließen beendet nicht das Programm – es verschwindet in den Infobereich neben der Uhr. Über das Symbol dort kommst du jederzeit zurück.

**Benachrichtigt bei neuen Episoden**
Streamo prüft stündlich, ob bei deinen laufenden Serien etwas Neues erschienen ist, und meldet sich mit einer Windows-Benachrichtigung. Ein Klick darauf öffnet die Serie. Gezeigt wird auch gleich, bei welchem deiner Anbieter sie läuft.

**Startet mit Windows**
Optional, im Kontextmenü des Tray-Symbols. Beim Autostart öffnet sich kein Fenster – die App wartet unauffällig im Hintergrund.

**Tastenkürzel für die Suche**
`Strg` + `Umschalt` + `S` öffnet die Suche, egal was gerade im Vordergrund ist.

**Sprungziele im Tray-Menü**
Weiterschauen, Bibliothek und Entdecken direkt anspringen, ohne erst das Fenster zu suchen.

**Hält sich selbst aktuell**
Die App sieht regelmäßig nach, ob es eine neue Version gibt, lädt sie im Hintergrund und fragt dann, ob du neu starten möchtest. Lehnst du ab, wird sie beim nächsten Beenden installiert. Über das Tray-Menü kannst du auch von Hand suchen.

**Passkeys auch mit eigenem Zertifikat**
Läuft dein Streamo mit einem selbstsignierten Zertifikat, kannst du es hier einmalig bestätigen. Danach gilt die Verbindung als sicher – und Passkeys (Windows Hello) funktionieren, wo der Browser sie mit einer Zertifikatswarnung noch blockieren würde.

---

## Selbst bauen

Nötig ist Node.js 20 oder neuer.

```bash
cd desktop
npm install
npm start            # zum Ausprobieren, ohne Installer
npm run build:win    # erzeugt dist/Streamo-Setup-<version>.exe
```

Für Linux (`AppImage` und `.deb`) beziehungsweise macOS (`.dmg`):

```bash
npm run build:linux
npm run build:mac
```

> Gebaut wird jeweils nur für das System, auf dem der Befehl läuft. Einen Windows-Installer auf einem Linux-Rechner zu erzeugen ist zwar möglich, aber fehleranfällig – dafür ist der GitHub-Workflow da, der auf einem echten Windows-Rechner baut.

Das Programmsymbol wird gerechnet, nicht gezeichnet:

```bash
node tools/make-icons.mjs   # erzeugt assets/icon.png und assets/icon.ico
```

---

## Aufbau

```
desktop/
├── main.js                 Hauptprozess: Fenster, Tray, Benachrichtigungen
├── preload.js              Die einzige Brücke zwischen App und Webseite
├── renderer/
│   └── connect.html        "Mit Server verbinden" – der einzige eigene Bildschirm
├── tools/
│   └── make-icons.mjs      Erzeugt die Programmsymbole
└── assets/                 icon.png, icon.ico
```

### Warum so wenig?

Die App zeichnet die Oberfläche **nicht selbst nach**. Sie lädt die Weboberfläche vom Server – die ist bereits vollständig und wird bei jedem `update` auf dem Server mit aktualisiert. Eine zweite, nachgebaute Oberfläche müsste man doppelt pflegen, und sie würde bei jeder Serveränderung hinterherhinken.

Eigen ist nur, was der Browser nicht kann: Tray, Benachrichtigungen, Autostart, globale Tastenkürzel und der Verbindungsbildschirm.

### Sicherheit

Die angezeigte Seite kommt von einem Server. Sie läuft deshalb bewusst eingesperrt:

- `nodeIntegration: false` – kein Zugriff auf Node.js
- `contextIsolation: true` – kein Zugriff auf die Interna der App
- Alles, was die Seite überhaupt aufrufen kann, steht in `preload.js` – es sind genau drei Funktionen, und die braucht nur der Verbindungsbildschirm
- Verweise auf fremde Adressen (JustWatch, Anbieterseiten) öffnen im Systembrowser, nicht in diesem Fenster
- Ein selbstsigniertes Zertifikat wird nur akzeptiert, wenn du es erlaubt hast, und nur für genau den eingestellten Server

### Wo liegen die Einstellungen?

```
%APPDATA%\Streamo\settings.json      (Windows)
~/.config/Streamo/settings.json      (Linux)
~/Library/Application Support/Streamo/settings.json   (macOS)
```

Eine schlichte JSON-Datei mit Serveradresse, Fenstergröße und den Schaltern aus dem Tray-Menü. Bei Problemen kann man sie löschen – dann startet die App wieder mit dem Verbindungsbildschirm.

---

## Fehlersuche

**„Streamo ist unter … nicht erreichbar"**
Läuft der Server? Prüfe mit `pct exec <CTID> -- streamo info` die Adresse. Im Browser muss dieselbe Adresse funktionieren.

**Zertifikatsfehler**
Setz beim Verbinden den Haken „Selbstsigniertes Zertifikat akzeptieren".

**Keine Benachrichtigungen**
Windows muss sie für Streamo erlauben: *Einstellungen → System → Benachrichtigungen*. Außerdem meldet die App nur Serien mit dem TMDB-Status „Returning Series" – bei abgeschlossenen Serien sind ungesehene Episoden kein Neuzugang, sondern Rückstand.

**Passkeys funktionieren nicht**
Sie brauchen HTTPS und einen Hostnamen; über eine IP-Adresse gehen sie grundsätzlich nicht. Details im [Haupt-README](../README.md#passkeys).
