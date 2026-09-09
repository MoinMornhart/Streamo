# Streamo

**Alle Streaming-Abos an einem Ort.** Streamo ist eine selbst gehostete Web-Anwendung, in der du deine Streaming-Anbieter verknüpfst, deine eigene Serien-Datenbank aufbaust und bei jedem Titel sofort siehst, **wo du ihn streamen kannst** – und ob er in einem deiner Abos schon enthalten ist.

---

## Schnellstart auf Proxmox

Ein Befehl in der **Shell deines Proxmox-Hosts**. Er legt einen LXC-Container an, installiert alles und nennt dir am Ende die Adresse:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/MoinMornhart/Streamo/main/scripts/streamo.sh)"
```

Nach zwei bis vier Minuten läuft Streamo unter `http://<container-ip>:3000`.

Die ausführliche Anleitung mit allen Optionen steht in **[docs/QUICKSTART.md](docs/QUICKSTART.md)**.

| Vorgabe | Wert |
| --- | --- |
| Betriebssystem | Debian 13 (LXC, unprivilegiert) |
| CPU | 2 Kerne |
| Arbeitsspeicher | 2048 MB |
| Festplatte | 8 GB |
| Netzwerk | DHCP an `vmbr0` |
| Port | 3000 |
| Autostart | ja |

Alle Werte lassen sich im Installationsdialog unter „Erweitert" ändern.

---

## Streamo für den PC

Neben der Weboberfläche gibt es eine Windows-App: **[Installer herunterladen](https://github.com/MoinMornhart/Streamo/releases)**

Sie zeigt dieselbe Oberfläche in einem eigenen Programmfenster und kann dazu, was der Browser nicht kann: im Infobereich weiterlaufen, bei neuen Episoden benachrichtigen, mit Windows starten und die Suche per `Strg`+`Umschalt`+`S` öffnen. Details in [desktop/README.md](desktop/README.md).

Die App hält sich selbst aktuell: Sie sieht kurz nach dem Start und danach alle vier Stunden nach, lädt im Hintergrund und fragt dann, ob neu gestartet werden soll. Wer ablehnt, bekommt das Update beim nächsten Beenden. Beim Start leert sie außerdem einmal ihren Zwischenspeicher – sonst könnte sie nach einem Server-Update noch die alte Oberfläche zeigen.

> Auf der Download-Seite steht immer nur die neueste Version; ältere räumt der Bau-Workflow weg. Für die Selbstaktualisierung ist das ohne Belang – sie liest ohnehin immer die neueste.

---

## Anmelden – Passwort oder Passkey

Drei Wege, die nebeneinander bestehen:

| Weg | Womit |
| --- | --- |
| Benutzername + Passwort | funktioniert immer, überall |
| E-Mail + Passwort | die E-Mail ist optional und dient nur als zweiter Anmeldename |
| **Passkey** | Windows Hello, Face ID, Fingerabdruck oder Sicherheitsschlüssel |

Bei einem Passkey entsteht ein Schlüsselpaar auf deinem Gerät. Der private Teil verlässt es nie – Streamo speichert nur den öffentlichen. Selbst wer die gesamte Datenbank stiehlt, kann sich damit nicht anmelden.

Eingerichtet werden Passkeys unter *Einstellungen → Passkeys*. Du kannst mehrere anlegen (Rechner, Handy, Sicherheitsschlüssel) und danach optional das Passwort entfernen – Streamo lässt das nur zu, solange mindestens ein Passkey übrig bleibt.

> **Streamo verschickt keine E-Mails** und braucht keinen Mailserver. Die Adresse ist ausschließlich ein zweiter Anmeldename.

### Ein Konto anlegen

Drei Wege dorthin:

| Weg | Wann |
| --- | --- |
| Einrichtungsassistent | einmalig, beim allerersten Start – dieses Konto wird Administrator |
| Einladungs**link** | einfach öffnen, Name und Passwort eintragen, fertig |
| *Konto erstellen* auf dem Anmeldebildschirm | mit dem Einladungs**code**, oder ganz ohne, wenn die Registrierung offen steht |

Ob ein Code nötig ist, entscheidet die Instanz. Standardmäßig ja – siehe [Konfiguration](#konfiguration). Umschalten kannst du das unter *Einstellungen → Freunde einladen* oder mit `streamo registration offen`.

Wer eingeladen wird, braucht **keinen eigenen TMDB-Zugang**: Der gilt für die ganze Instanz und ist längst hinterlegt. Genau deshalb gibt es Einladungen – sonst müsste sich jeder erst bei einer Filmdatenbank anmelden und dort seine Adresse angeben.

### Zwei-Faktor-Anmeldung

Zusätzlich zum Passwort ein sechsstelliger Code aus einer Authenticator-App – Aegis, 2FAS, Google Authenticator oder was auch immer TOTP beherrscht. Selbst wer dein Passwort kennt, kommt damit nicht in dein Konto.

Streamo verschickt dafür nichts und ruft nichts ab. Server und App teilen sich beim Einrichten ein Geheimnis und rechnen danach unabhängig voneinander dasselbe aus – das funktioniert auch im Flugmodus. Das Verfahren ist TOTP nach RFC 6238; die Umsetzung in `src/totp.js` wird gegen die offiziellen Testvektoren der Norm geprüft (`npm run test:totp`).

Eingerichtet wird das unter *Einstellungen → Zwei-Faktor-Anmeldung*, in zwei Schritten: Erst bekommt die App das Geheimnis, dann muss ein gültiger Code beweisen, dass sie es wirklich hat. Ohne diesen Beweis könnte man sich beim Übertragen vertun und wäre anschließend ausgesperrt.

Dazu gibt es zehn **Ersatzcodes**. Sie erscheinen genau einmal – danach liegen nur noch ihre Prüfsummen in der Datenbank, niemand kann sie erneut anzeigen, auch der Betreiber nicht. Bewahre sie auf: Weil Streamo keine E-Mails verschickt, gibt es ohne sie keinen Weg zurück, wenn das Telefon verloren geht. Jeder Code gilt einmal.

Passkeys brauchen keinen zweiten Faktor – sie sind selbst schon zwei (das Gerät plus Fingerabdruck oder PIN) und werden deshalb nicht zusätzlich nach einem Code gefragt.

### Voraussetzungen für Passkeys

Zwei Regeln setzt der Browser, an denen sich nichts ändern lässt:

1. **HTTPS ist Pflicht.** Über `http://` funktionieren Passkeys nicht (Ausnahme: `localhost`).
2. **Ein Hostname ist Pflicht.** Eine IP-Adresse ist nicht erlaubt – `https://192.168.1.50:3000` scheidet also aus.

Sind sie nicht erfüllt, blendet Streamo den Passkey-Knopf aus und nennt auf der Einstellungsseite den Grund. Der Passwortweg bleibt in jedem Fall.

**So erfüllst du sie:**

**Mit Reverse Proxy und eigener Domain** (empfohlen): Nginx Proxy Manager, Traefik o. Ä. mit Let's-Encrypt-Zertifikat, Ziel `http://<container-ip>:3000`. Danach im Container **einen Befehl**:

```bash
streamo domain streamo.deine-domain.de
```

Der trägt `TRUST_PROXY`, `WEBAUTHN_RP_ID` und `WEBAUTHN_ORIGIN` ein und startet den Dienst neu. Nötig ist er, weil viele Proxys den `Host`-Header nicht durchreichen, sondern ihre eigene Adresse schicken – Streamo sähe dann eine IP statt deiner Domain und würde Passkeys ablehnen. Die Einstellungsseite zeigt dir unter *Passkeys*, welche Adresse Streamo tatsächlich wahrnimmt.

**Ohne Proxy, mit eigenem HTTPS**: `ENABLE_HTTPS=true` und `TLS_HOSTNAME=streamo.local` in der `.env`. Streamo erzeugt dann ein selbstsigniertes Zertifikat, und der HTTP-Port leitet auf HTTPS um. Im Browser musst du das Zertifikat einmal bestätigen – die Desktop-App akzeptiert es auf Wunsch ohne Rückfrage.

> Ziehst du Streamo später auf eine andere Domain um, werden alle Passkeys ungültig. Das ist kein Fehler, sondern genau der Mechanismus, der Passkeys phishing-sicher macht: Sie sind fest an eine Domain gebunden. Das Passwort funktioniert weiterhin.

---

## Was Streamo kann

**Anbieter verknüpfen**
Klick die Dienste an, die du abonniert hast – Netflix, Disney+, Prime Video, WOW, Paramount+, Apple TV+, MagentaTV und über hundert weitere, je nach Region. Streamo weiß danach, was du ohne Zusatzkosten sehen kannst.

**Deine Serien-Datenbank**
Suche Serien und Filme und leg sie auf deine Liste. Fünf Zustände (*Will ich sehen, Schaue ich, Gesehen, Pausiert, Abgebrochen*), eigene Bewertung, Favoriten und Notizen.

**Immer sehen, wo es läuft**
Jede Kachel zeigt die Anbieter-Logos direkt auf dem Poster. Grün umrandet heißt: in deinem Abo enthalten. Auf der Detailseite steht die vollständige Aufstellung, getrennt nach Abo, kostenlos, Leihe und Kauf, mit Deeplink zum Anbieter.

**Episoden-Fortschritt**
Staffeln und Episoden abhaken, einzeln, staffelweise oder „alles bis hierhin". Der Status wechselt automatisch von *Will ich sehen* auf *Schaue ich* und am Ende auf *Gesehen*.

**Entdecken statt suchen**
Die Startseite zeigt, was gerade in deinen Abos läuft – gefiltert auf genau die Dienste, für die du bezahlst.

**Für dich – Empfehlungen aus der eigenen Bibliothek**
Über den populären Titeln steht eine Leiste, die für jede Person anders aussieht. Sie entsteht aus dem, was du selbst gesehen hast: Eine 10 von 10 zählt mehr als eine 6, ein Favorit mehr als ein Nebenbei-Titel, eine durchgesehene Serie mehr als eine angefangene. Was auf der Merkliste liegt, zählt nicht – gesehen hast du es ja noch nicht; Abgebrochenes und schlecht Bewertetes ebenso wenig. Jede Kachel sagt, warum sie da ist: *„Weil du Breaking Bad gesehen hast."*

**Suche, die Tippfehler verzeiht**
„Kingsmann" findet *Kingsman*, „Braking Bad" findet *Breaking Bad*, „spiderman" findet *Spider-Man*. Umlaute und Akzente sind egal. Bringt die Suche bei TMDB nichts, fasst Streamo mit bereinigten Schreibweisen nach und sagt dazu, wonach es tatsächlich gesucht hat.

**Filmreihen, ein- und ausklappbar**
In der Bibliothek lassen sich Titel nach Reihen gruppieren. Eingeklappt belegt eine achtteilige Reihe eine Zeile: drei Kacheln nebeneinander, ein Pfeil rechts blättert weiter. Ausgeklappt steht alles auf einmal da. Welche Reihen offen sind, merkt sich der Browser – genauso wie die zuletzt gesetzten Filter.

**Listen teilen**
Jede Reihe – die eigenen wie die offiziellen von TMDB – lässt sich über einen Link weitergeben, per WhatsApp, Telegram, E-Mail oder einfach kopiert. Wer den Link öffnet, sieht die Liste ohne Konto und ohne Anmeldung. Was der Ersteller gesehen hat und welche Abos er besitzt, steht dort nicht.

**Auswertung, die eine Frage beantwortet**
Wie verteilen sich deine Serien auf die Abos? Bei welchem Dienst läuft nichts von deiner Liste (Kündigungskandidat)? Welches zusätzliche Abo würde dir am meisten freischalten? Und wie viel Lebenszeit hast du eigentlich investiert?

**Automatischer Abgleich**
Streamo prüft alle 12 Stunden, wo deine Serien inzwischen laufen. Streaming-Rechte wandern ständig – du merkst es, ohne nachzusehen.

**Mehrere Personen**
Optional. Jede Person hat eigene Abos, eigene Bibliothek, eigenen Fortschritt und eigene Region. Wer sie einlädt, sieht unter *Einstellungen → Benutzer*, wer ein Konto hat, wann er zuletzt da war und ob gerade jemand angemeldet ist – und kann dort Adminrechte vergeben.

**Freunde**
Seht euch gegenseitig die Listen an und lasst Streamo ausrechnen, was ihr *zusammen* schauen könnt: auf Grundlage eurer beider Abos und dessen, was ihr euch vorgenommen habt. Dazu Empfehlungen mit einem Satz Begründung – das ist der Unterschied zwischen „schau dir das an" und einem Link.

**Dein Farbschema**
Streamo war violett, weil sich irgendjemand einmal für Violett entscheiden musste. Jede Person wählt ihre eigene Akzentfarbe – acht Vorgaben oder ein freier Farbwähler – und dazu einen Grundton: Dunkelblau oder echtes Schwarz. Die Einstellung gilt für dein Konto, nicht für die ganze Instanz, und reist zu deinen anderen Geräten mit.

---

## Woher kommen die Daten?

Streamo meldet sich **nicht** bei Netflix, Disney+ und Co. an und braucht **keine Zugangsdaten** fremder Dienste. Solche Schnittstellen gibt es nicht öffentlich, und Passwörter anderer Anbieter gehören nicht in eine selbst gehostete Anwendung.

Stattdessen:

1. Du hinterlegst **welche Abos du hast** (ein Klick pro Dienst).
2. Streamo holt die **Verfügbarkeitsdaten von JustWatch** – über die kostenlose TMDB-API. Das ist dieselbe Quelle, die auch die großen Vergleichsportale nutzen.
3. Beides wird abgeglichen: Du siehst bei jedem Titel, wo er läuft und ob er in *deinem* Abo drin ist.

Das Ergebnis ist dasselbe, nur ohne Passwort-Weitergabe.

**Du brauchst dafür einen kostenlosen TMDB-API-Key:** [themoviedb.org/settings/api](https://www.themoviedb.org/settings/api) → Konto anlegen → API beantragen (Verwendungszweck „Personal / Education" genügt) → Schlüssel kopieren. Sowohl der *API Read Access Token* als auch der klassische *API Key* funktionieren. Du kannst ihn beim Einrichten oder später unter *Einstellungen* eintragen.

---

## Manuelle Installation

Falls du kein Proxmox nutzt. Voraussetzung: **Node.js 23.4 oder neuer** (wegen des eingebauten `node:sqlite`-Moduls; Node 24 LTS wird empfohlen).

```bash
git clone https://github.com/MoinMornhart/Streamo.git
cd Streamo
npm install --omit=dev
cp .env.example .env      # optional, es geht auch ohne
npm start
```

Streamo läuft dann auf <http://localhost:3000>. Beim ersten Aufruf führt dich ein Assistent durch die Einrichtung.

Auf jedem Debian- oder Ubuntu-Server geht auch das Installationsskript direkt, ohne Proxmox:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/MoinMornhart/Streamo/main/scripts/install/streamo-install.sh)"
```

Es installiert Node.js, legt einen eigenen Dienstbenutzer an und richtet einen systemd-Dienst ein.

---

## Konfiguration

Alle Werte stehen in `.env` (Vorlage: [`.env.example`](.env.example)). Jeder hat eine sinnvolle Vorgabe – eine leere Datei funktioniert.

| Variable | Vorgabe | Bedeutung |
| --- | --- | --- |
| `PORT` | `3000` | Port der Weboberfläche |
| `HOST` | `0.0.0.0` | Bind-Adresse; `127.0.0.1` = nur lokal |
| `DATA_DIR` | `./data` | Speicherort der SQLite-Datenbank |
| `SESSION_SECRET` | *(automatisch)* | Signatur der Anmeldesitzungen |
| `TMDB_API_KEY` | – | Dein TMDB-Schlüssel; auch im UI setzbar |
| `STREAMO_REGION` | `DE` | Land, für das die Verfügbarkeit gilt |
| `STREAMO_LANGUAGE` | `de-DE` | Sprache von Titeln und Beschreibungen |
| `SYNC_INTERVAL_HOURS` | `12` | Takt des Hintergrundabgleichs; `0` = aus |
| `ALLOW_REGISTRATION` | `false` | Dürfen sich weitere Personen ohne Einladung registrieren? |
| `TRUST_PROXY` | `false` | `true`, wenn ein HTTPS-Proxy davorsteht |

Nach Änderungen: `systemctl restart streamo`

> `ALLOW_REGISTRATION` steht mit Absicht auf `false`: Sobald Streamo aus dem Internet erreichbar ist, könnte sonst jeder, der die Adresse findet, ein Konto anlegen – und deinen TMDB-Zugang mitbenutzen. Der Normalfall ist deshalb die Einladung.
>
> Umschalten lässt sich das auch ohne Server-Zugang, unter *Einstellungen → Freunde einladen* oder mit `streamo registration offen`. Der so gespeicherte Wert sticht die `.env`.

---

## Aufbau des Projekts

```
Streamo/
├── src/                    Server (Node.js + Express)
│   ├── server.js           Einstiegspunkt, Middleware, Routen einhängen
│   ├── config.js           Konfiguration aus .env
│   ├── db.js               SQLite-Schema und Zugriffs-Helfer
│   ├── auth.js             Passwörter (scrypt), Sessions, Zugriffsschutz
│   ├── passkeys.js         WebAuthn – Anmelden ohne Passwort
│   ├── totp.js             Einmalcodes nach RFC 6238 (zweiter Faktor)
│   ├── twofactor.js        Ersatzcodes und halbfertige Anmeldungen
│   ├── tmdb.js             TMDB-Client inkl. Verfügbarkeitsdaten
│   ├── store.js            Brücke zwischen TMDB und Datenbank
│   ├── sync.js             Hintergrundabgleich
│   ├── fuzzy.js            Suche, die Tippfehler verzeiht
│   ├── quicksearch.js      Eine Suche über Reihen, Freunde und Leute
│   ├── recommend.js        "Für dich" – Vorschläge aus der eigenen Bibliothek
│   ├── collections.js      Filmreihen, eigene wie offizielle
│   ├── friends.js          Freundschaften und gemeinsames Schauen
│   ├── achievements.js     Erfolge
│   ├── invites.js          Einladungslinks
│   └── routes/             Die API, ein Modul je Bereich
├── public/                 Frontend – reine ES-Module, kein Build nötig
│   ├── index.html
│   ├── css/styles.css
│   └── js/
│       ├── api.js          Der einzige Weg zum Server
│       ├── ui.js           Bausteine (Poster-Kachel, Dialoge, Formatierer)
│       ├── theme.js        Akzentfarbe und Grundton
│       ├── router.js       Routing über die Adressleiste
│       ├── app.js          Einstiegspunkt, globaler Zustand
│       └── views/          Eine Datei je Ansicht
├── desktop/                Die Windows-App (Electron)
├── scripts/
│   ├── streamo.sh          Proxmox-Installer (LXC anlegen)
│   ├── streamo-update.sh   Update mit Rollback
│   ├── make-admin.mjs      Adminrechte auf der Konsole vergeben
│   ├── registration.mjs    Offene Registrierung ein- und ausschalten
│   └── install/            Installation im Container
├── tests/                  Über 400 Prüfungen, ohne Test-Framework
└── docs/QUICKSTART.md      Ausführliche Anleitung
```

Der gesamte Code ist durchgehend auf Deutsch kommentiert – jede Verknüpfung zwischen Tabellen, Endpunkten und Ansichten ist an Ort und Stelle erklärt.

### Technische Entscheidungen

- **Zwei npm-Abhängigkeiten**: `express` und `@simplewebauthn/server`. Passwort-Hashing, Sessions, `.env`-Parsing und der Cookie-Umgang sind mit Bordmitteln von Node gelöst. Die Ausnahme sind Passkeys – bei WebAuthn selbst geschriebene Kryptografie wäre fahrlässig.
- **Der zweite Faktor dagegen ist selbst geschrieben** (`src/totp.js`), und das ist kein Widerspruch: Hier gibt es nichts zu erfinden. `node:crypto` liefert HMAC-SHA1 fertig, der Rest ist Byte-Schieberei nach einer klar beschriebenen Norm – und RFC 6238 bringt offizielle Testvektoren mit, gegen die `npm run test:totp` prüft.
- **SQLite über `node:sqlite`** – seit Node 22.5 eingebaut. Keine native Kompilierung, kein Datenbankserver. Die gesamte Installation ist eine Datei plus ein Verzeichnis.
- **Kein Frontend-Build.** Die Oberfläche besteht aus nativen ES-Modulen. Kein Webpack, kein `npm run build`, kein Bundle – Dateien kopieren genügt.
- **Kein Test-Framework.** Die Tests unter `tests/` sind gewöhnliche Skripte, die etwas tun und das Ergebnis vergleichen. `npm run test:all` führt sie alle aus. Über 400 Prüfungen, keine einzige Abhängigkeit dafür.
- **Alle Filter stehen in der URL.** Jede Ansicht der Bibliothek ist verlinkbar, der Zurück-Knopf funktioniert. Die zuletzt benutzten merkt sich der Browser zusätzlich.
- **Keine Browser-Dialoge.** Kein `prompt()`, kein `confirm()` – alle Fenster sind Teil der Oberfläche und tragen deine Akzentfarbe.

---

## Datensicherung

Alles Wichtige liegt in einem Verzeichnis:

```bash
# Sicherung
cp -r /opt/streamo/data ~/streamo-backup

# In der Oberfläche: Einstellungen → Daten → Bibliothek exportieren
# ergibt eine JSON-Datei mit Bibliothek, Abos und Fortschritt.
```

Der Container lässt sich natürlich auch klassisch über die Proxmox-Sicherung (vzdump) sichern.

---

## Aktualisieren

Im Container genügt ein Wort:

```bash
update
```

Vom Proxmox-Host aus, ohne sich einzuloggen:

```bash
pct exec <CTID> -- update
```

Was dabei passiert:

1. Nachsehen, ob es überhaupt eine neue Version gibt – wenn nicht, ist nach einer Sekunde Schluss
2. Die Änderungen der neuen Version anzeigen und einmal nachfragen
3. Sicherungskopie der Datenbank anlegen (die letzten fünf bleiben erhalten)
4. Dienst anhalten, neue Version holen, Abhängigkeiten installieren
5. Dienst starten und prüfen, ob er wirklich antwortet
6. **Antwortet er nicht, wird automatisch der vorherige Stand wiederhergestellt** – Code und Datenbank. Streamo läuft dann in der alten Version weiter, statt kaputt liegenzubleiben.

Deine Datenbank (`data/`) und deine Konfiguration (`.env`) bleiben in jedem Fall unberührt.

Optionen:

| Befehl | Wirkung |
| --- | --- |
| `update` | Aktualisieren, mit Rückfrage |
| `update --check` | Nur nachsehen, ob es etwas Neues gibt. Ändert nichts. |
| `update --yes` | Ohne Rückfrage – für Cronjobs und Automatisierung |
| `update --force` | Auch bei aktueller Version neu installieren (Reparatur) |

`streamo-update` ist derselbe Befehl unter sprechendem Namen.

### Weitere Befehle im Container

```bash
streamo                    # zeigt alle Befehle
streamo status             # Läuft der Dienst?
streamo logs               # Protokoll live mitlesen
streamo restart            # Neu starten
streamo config             # .env bearbeiten, startet danach automatisch neu
streamo domain <d>         # Domain eintragen – nötig für Passkeys hinter einem Proxy
streamo admin <name>       # Adminrechte vergeben (ohne Namen: alle Konten auflisten)
streamo registration offen # Konto ohne Einladung erlauben (oder: zu)
streamo backup             # Datenbank und Konfiguration sichern
streamo info               # Version, Adresse, Zustand
```

Beim Anmelden im Container begrüßt dich eine Übersicht mit Version, Adresse und Dienstzustand.

Die beiden mittleren Befehle lösen ein Henne-Ei-Problem: Adminrechte bekommt automatisch nur das allererste Konto aus dem Einrichtungsassistenten, und den Schalter für die offene Registrierung sehen nur Administratoren. Wer später über eine Einladung dazugekommen ist, käme also an beides nicht heran.

`streamo admin` ohne Namen listet alle Konten mit ihrem Rang. Der letzte Administrator kann sich nicht selbst entmachten – sonst könnte niemand mehr den TMDB-Zugang ändern oder Einladungen erzeugen.

### Automatisch aktualisieren

Wer will, lässt Streamo sich nachts selbst aktualisieren:

```bash
pct exec <CTID> -- bash -c "echo '30 4 * * * root /usr/local/bin/update --yes >/var/log/streamo-update.log 2>&1' > /etc/cron.d/streamo-update"
```

Durch den automatischen Rollback ist das ungefährlich: Sollte ein Update den Dienst lahmlegen, steht am Morgen wieder die funktionierende Vorversion.

---

## Fehlersuche

**Die Oberfläche ist nicht erreichbar**

```bash
pct exec <CTID> -- systemctl status streamo
pct exec <CTID> -- journalctl -u streamo -n 50
```

**Suche liefert nichts / Anbieterliste ist leer**
Meistens fehlt der TMDB-API-Key oder er ist falsch. *Einstellungen → TMDB-Zugang → Schlüssel testen* sagt dir, woran es liegt.

**Es werden die falschen Anbieter angezeigt**
Prüfe deine Region unter *Einstellungen → Konto*. Sie entscheidet, welcher Länder-Katalog und welche Verfügbarkeiten gelten.

**Verfügbarkeit wirkt veraltet**
*Einstellungen → Abgleich → Verfügbarkeit abgleichen* stößt den Lauf sofort an. Auf der Detailseite gibt es dafür den Knopf *Aktualisieren*.

---

## Hinweise

Dieses Produkt verwendet die TMDB-API, ist aber weder von TMDB unterstützt noch zertifiziert. Die Streaming-Verfügbarkeit stammt von JustWatch.

Streamo speichert keine Zugangsdaten fremder Dienste und stellt keine Inhalte bereit – es zeigt lediglich, wo Inhalte legal verfügbar sind.

## Lizenz

MIT – siehe [LICENSE](LICENSE).
