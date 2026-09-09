# Quickstart – Streamo auf Proxmox

Diese Anleitung bringt Streamo in etwa fünf Minuten auf deinen Proxmox-Server. Du brauchst dafür keine Vorkenntnisse zu LXC, Node.js oder systemd.

---

## Der eine Befehl

Öffne die **Shell deines Proxmox-Hosts** – entweder über die Weboberfläche (Node auswählen → `>_ Shell`) oder per SSH als `root` – und füge ein:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/MoinMornhart/Streamo/main/scripts/streamo.sh)"
```

> **Wichtig:** Das gehört auf den Proxmox-**Host**, nicht in einen bestehenden Container und nicht in eine VM. Das Skript prüft das und bricht sonst mit einem Hinweis ab.

---

## Was dann passiert

Das Skript führt dich durch vier Schritte:

### 1. Standard oder Erweitert

```
  Wie möchtest du installieren?

    1  Standard – 2 Kerne, 2048 MB RAM, 8 GB, DHCP
    2  Erweitert – alle Werte selbst festlegen
```

**Standard** ist für die allermeisten Fälle richtig. Wähle **Erweitert**, wenn du eine feste IP-Adresse, eine bestimmte Container-ID, einen anderen Hostnamen oder SSH-Zugang im Container möchtest.

### 2. Speicherort

Wenn dein Server mehrere Speicher hat (z. B. `local` und `local-lvm`), fragt das Skript zweimal:

- **Template-Speicher** – wohin das Debian-Image geladen wird (meist `local`)
- **Container-Speicher** – wo die Festplatte des Containers liegt (meist `local-lvm`)

Gibt es jeweils nur eine Möglichkeit, wird sie ohne Rückfrage genommen.

### 3. Automatischer Ablauf

```
 ✓ Proxmox VE 8 erkannt.
 ✓ Template-Speicher: local
 ✓ Container-Speicher: local-lvm
 ✓ Template-Liste aktualisiert
 ✓ Template geladen
 ✓ Container 104 angelegt
 ✓ Container läuft und ist online
 ✓ Streamo installiert
```

Im Hintergrund geschieht dabei: unprivilegierter LXC-Container anlegen und starten, Node.js 24 installieren, Streamo nach `/opt/streamo` klonen, Konfiguration mit zufälligem Session-Secret erzeugen, systemd-Dienst einrichten und auf Erreichbarkeit prüfen.

### 4. Die Adresse

```
 ════════════════════════════════════════════════════════════
  Streamo läuft.

  Weboberfläche   http://192.168.1.114:3000
  Container-ID    104
  Ressourcen      2 Kerne · 2048 MB RAM · 8 GB
 ════════════════════════════════════════════════════════════
```

---

## Einrichtung im Browser

### Schritt 1 – TMDB-Key besorgen

Streamo bezieht Metadaten und Streaming-Verfügbarkeit von TMDB. Der Zugang ist kostenlos:

1. Konto anlegen auf [themoviedb.org](https://www.themoviedb.org/signup)
2. Auf [themoviedb.org/settings/api](https://www.themoviedb.org/settings/api) einen Key beantragen
3. Als Verwendungszweck genügt **Personal / Education**; bei „Application URL" darfst du eine beliebige Adresse eintragen
4. Kopiere entweder den **API Read Access Token** (lang, beginnt mit `eyJ`) oder den **API Key** (32 Zeichen) – Streamo erkennt beides automatisch

### Schritt 2 – Konto anlegen

Öffne `http://<container-ip>:3000`. Der Assistent fragt nach:

- **Benutzername und Passwort** – dein Konto auf dieser Installation. Es hat nichts mit deinen Streaming-Diensten zu tun.
- **TMDB-API-Key** – aus Schritt 1. Der Schlüssel wird sofort geprüft, ein Tippfehler fällt also gleich auf. Du kannst das Feld auch leer lassen und später nachtragen.
- **Region** – entscheidet, welche Anbieter angeboten werden und für welches Land die Verfügbarkeit gilt.

### Schritt 3 – Abos verknüpfen

Direkt danach landest du auf der Anbieter-Seite. Klick alles an, was du abonniert hast, und drücke **Auswahl speichern**.

Ab jetzt weiß Streamo, was du ohne Zusatzkosten sehen kannst: Serien in deinen Abos bekommen im Raster ein grünes Abzeichen, und die Startseite zeigt nur noch, was für dich tatsächlich abrufbar ist.

### Schritt 4 – Serien hinzufügen

Suchfeld oben, Titel eingeben, **+ Hinzufügen**. Streamo holt dann Metadaten und Verfügbarkeit und legt beides lokal ab.

Hast du bereits eine Liste bei Trakt, Serienjunkies oder in einer Tabelle? Unter *Einstellungen → Daten* kannst du eine JSON-Datei importieren; das Format steht im README.

---

## Erweiterte Installation

### Andere Ressourcen ohne Dialog

Alle Vorgaben lassen sich als Umgebungsvariablen setzen:

```bash
var_cpu=4 var_ram=4096 var_disk=16 \
  bash -c "$(curl -fsSL https://raw.githubusercontent.com/MoinMornhart/Streamo/main/scripts/streamo.sh)"
```

| Variable | Vorgabe | Bedeutung |
| --- | --- | --- |
| `var_cpu` | `2` | CPU-Kerne |
| `var_ram` | `2048` | Arbeitsspeicher in MB |
| `var_disk` | `8` | Festplatte in GB |
| `var_version` | `13` | Debian-Version |
| `var_unprivileged` | `1` | `0` für einen privilegierten Container |
| `REPO_URL` | – | Eigener Fork statt des Originals |
| `REPO_BRANCH` | `main` | Anderer Branch |

### Wie viel braucht Streamo wirklich?

Die Vorgaben haben bewusst Reserve. Im Betrieb sieht es so aus:

| | Ruhe | Beim Abgleich |
| --- | --- | --- |
| Arbeitsspeicher | ~90 MB | ~150 MB |
| CPU | nahe 0 % | kurzzeitig 1 Kern |
| Festplatte | ~250 MB inkl. System | +15 MB je 1000 Titel |

512 MB RAM und 4 GB Platte reichen also aus. Zwei Kerne beschleunigen nur den ersten Abgleich einer großen Bibliothek.

---

## Betrieb

### Aktualisieren – ein Wort

Im Container:

```bash
update
```

Oder direkt vom Proxmox-Host, ohne sich einzuloggen:

```bash
pct exec <CTID> -- update
```

Der Befehl sieht zuerst nach, ob es überhaupt etwas Neues gibt, zeigt die
Änderungen, sichert die Datenbank und spielt das Update ein. Startet der
Dienst danach nicht sauber, wird **automatisch der vorherige Stand
wiederhergestellt** – Streamo läuft dann in der alten Version weiter, statt
kaputt liegenzubleiben.

| Befehl | Wirkung |
| --- | --- |
| `update` | Aktualisieren, mit einer Rückfrage |
| `update --check` | Nur nachsehen. Ändert nichts. |
| `update --yes` | Ohne Rückfrage, z. B. für einen Cronjob |
| `update --force` | Neu installieren, auch wenn die Version aktuell ist |

### Alle weiteren Befehle

Im Container – `streamo` allein zeigt die Übersicht:

```bash
streamo status     # Läuft der Dienst?
streamo logs       # Protokoll live mitlesen
streamo restart    # Neu starten
streamo config     # .env bearbeiten, startet danach automatisch neu
streamo domain <d> # Domain eintragen – nötig für Passkeys hinter einem Proxy
streamo backup     # Datenbank und Konfiguration sichern
streamo info       # Version, Adresse, Zustand
```

Vom Proxmox-Host aus, `<CTID>` durch deine Container-ID ersetzen:

```bash
pct enter <CTID>                # Konsole im Container öffnen
pct exec <CTID> -- update       # Aktualisieren
pct exec <CTID> -- streamo info # Version und Adresse
```

Beim Anmelden im Container erscheint eine kurze Übersicht mit Version,
Adresse und Dienstzustand – und dem Hinweis auf `update`.

### Nachts von selbst aktualisieren

```bash
pct exec <CTID> -- bash -c "echo '30 4 * * * root /usr/local/bin/update --yes >/var/log/streamo-update.log 2>&1' > /etc/cron.d/streamo-update"
```

Das ist ungefährlich: Schlägt ein Update fehl, stellt Streamo selbstständig die
vorherige Version wieder her.

### Konfiguration ändern

```bash
pct exec <CTID> -- nano /opt/streamo/.env
pct exec <CTID> -- systemctl restart streamo
```

### Sicherung

Die gesamte Installation steckt in `/opt/streamo/data`:

```bash
pct exec <CTID> -- tar czf /tmp/streamo-backup.tar.gz -C /opt/streamo data
pct pull <CTID> /tmp/streamo-backup.tar.gz ./streamo-backup.tar.gz
```

Oder ganz klassisch über *Datacenter → Backup* eine Sicherung des Containers einplanen.

---

## Reverse Proxy mit HTTPS

Wenn Streamo über eine eigene Domain erreichbar sein soll, etwa mit dem Nginx Proxy Manager:

1. Im Proxy einen Host anlegen, Ziel `http://<container-ip>:3000`, Websockets nicht nötig
2. Zertifikat über Let's Encrypt ausstellen
3. Im Container `TRUST_PROXY=true` setzen:

```bash
pct exec <CTID> -- sed -i 's/^TRUST_PROXY=.*/TRUST_PROXY=true/' /opt/streamo/.env
pct exec <CTID> -- systemctl restart streamo
```

Das bewirkt zweierlei: Session-Cookies werden als `Secure` markiert (nur noch über HTTPS übertragen), und die echte Client-IP wird aus `X-Forwarded-For` gelesen statt der Proxy-Adresse.

> Streamo direkt ins Internet zu stellen, ohne HTTPS davor, ist keine gute Idee – dann liefen Passwort und Session-Cookie im Klartext über die Leitung.

---

## Wenn etwas schiefgeht

**„Das ist kein Proxmox-VE-Host"**
Du bist in einem Container oder einer VM gelandet. Geh in der Proxmox-Oberfläche eine Ebene höher: nicht den Container auswählen, sondern den Node darüber, und dort `>_ Shell` öffnen.

**„Der Container hat nach 60 Sekunden keine Netzwerkverbindung"**
Meistens stimmt die Bridge nicht. Prüfe unter *Node → System → Network*, wie deine Bridge heißt (üblich ist `vmbr0`), und wiederhole die Installation über den erweiterten Weg mit dem richtigen Namen.

**Installation bricht ab**
Das Skript bietet dann an, den halb fertigen Container zu löschen. Bestätige das und starte neu – so bleibt keine belegte ID zurück.

**Die Oberfläche zeigt „Es ist kein TMDB-API-Key hinterlegt"**
Erwartetes Verhalten, solange kein Schlüssel eingetragen ist. *Einstellungen → TMDB-Zugang* nachholen.

**Der Dienst startet nicht**

```bash
pct exec <CTID> -- journalctl -u streamo -n 50 --no-pager
```

Die häufigste Ursache ist eine zu alte Node-Version. Prüfen mit:

```bash
pct exec <CTID> -- node -v
```

Es muss mindestens `v23.4` sein, weil Streamo das eingebaute `node:sqlite` verwendet.

---

## Deinstallieren

```bash
pct stop <CTID>
pct destroy <CTID>
```

Damit ist alles weg – Streamo hinterlässt nichts auf dem Proxmox-Host.
