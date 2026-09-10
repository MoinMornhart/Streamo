# Streamo auf dem Raspberry Pi

Ein Raspberry Pi ist für Streamo fast ideal: Er läuft rund um die Uhr, braucht kaum Strom, und mehr als das tut ein Streamo-Server ohnehin nicht. Die Datenbank ist eine einzige Datei, und die Arbeit besteht darin, stündlich ein paar Anfragen an TMDB zu schicken.

---

## In einem Satz

```bash
sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/MoinMornhart/Streamo/main/scripts/install/streamo-install.sh)"
```

Nach zwei bis fünf Minuten läuft Streamo unter `http://<pi-adresse>:3000`. Der Befehl richtet alles ein: Node.js, einen eigenen Systembenutzer, den Dienst, die Konsolenbefehle.

Es ist derselbe Installer, der auch im Proxmox-Container läuft – er kommt ohne Proxmox aus und funktioniert auf jedem Debian- oder Ubuntu-System.

---

## Vorher: die richtige Fassung von Raspberry Pi OS

**Nimm die 64-Bit-Fassung.** Das ist die einzige Entscheidung, die vorher wichtig ist.

Der Grund liegt bei Node.js: Streamo braucht dessen eingebautes Modul `node:sqlite`, und das ist erst ab Node 22.13 ohne Zusatzflag nutzbar. Für 64-Bit-Systeme (`arm64`) gibt es Node 24; für 32-Bit (`armhf`) endet die Reihe bei Node 22 – NodeSource führt für `node_24.x` dort überhaupt kein `nodejs`-Paket mehr, und `nodejs.org` liefert für Node 24 kein `armv7l`-Archiv.

Der Installer erkennt das und wählt die passende Reihe:

| Architektur | System | Node |
| --- | --- | --- |
| `arm64` | Raspberry Pi OS 64-bit | 24 |
| `armhf` | Raspberry Pi OS 32-bit | 22 |
| `amd64` | gewöhnlicher Server | 24 |

Beides funktioniert. 64 Bit ist trotzdem die bessere Wahl – dort bekommst du weiterhin neue Node-Versionen.

Welche Fassung läuft bei dir?

```bash
dpkg --print-architecture     # arm64 oder armhf
```

Bei allem anderen (`armel`, `i386`, `riscv64`) bricht der Installer mit einer Ansage ab, statt es zu versuchen und später an einer kryptischen `apt`-Meldung zu scheitern.

---

## Welcher Pi?

| Modell | Taugt es? |
| --- | --- |
| **Pi 5** | reichlich; auch mit großer Bibliothek zügig |
| **Pi 4 (2 GB und mehr)** | die vernünftige Wahl |
| **Pi 3B+** | funktioniert; die Ersteinrichtung dauert länger |
| **Pi Zero 2 W** | geht, ist aber zäh – vor allem `npm install` |
| **Pi 1, Pi Zero (erste Fassung)** | nein: `armel` ohne Node-Pakete |

Streamo selbst braucht im Betrieb wenig – ein paar Dutzend Megabyte Arbeitsspeicher und im Leerlauf praktisch keine Rechenzeit. Anstrengend ist nur die Installation, weil `npm install` Abhängigkeiten übersetzt.

---

## Nach der Installation

Öffne `http://<pi-adresse>:3000` im Browser. Der Assistent fragt nach Benutzername, Passwort, deinem TMDB-Schlüssel und der Region. Wie du an den Schlüssel kommst, steht im [Schnellstart](QUICKSTART.md#schritt-1--tmdb-key-besorgen).

Die IP-Adresse deines Pi:

```bash
hostname -I | awk '{print $1}'
```

### Feste Adresse vergeben

Nichts ist ärgerlicher als ein Server, der nach einem Neustart des Routers unter einer anderen Adresse steht. Zwei Wege:

- **Im Router** eine feste Zuordnung für die MAC-Adresse des Pi eintragen. Der saubere Weg – dort gehört es hin.
- **Über den Namen**: Raspberry Pi OS bringt Avahi mit, der Pi ist also als `http://raspberrypi.local:3000` erreichbar. Praktisch, aber nicht in jedem Netz zuverlässig.

---

## Die Befehle auf dem Pi

Dieselben wie im Container:

```bash
update                     # auf die neueste Version bringen
streamo status             # läuft der Dienst?
streamo logs               # Protokoll live mitlesen
streamo restart            # neu starten
streamo config             # .env bearbeiten, startet danach neu
streamo domain <d>         # Domain eintragen – nötig für Passkeys
streamo admin <name>       # Adminrechte vergeben
streamo registration offen # Konto ohne Einladung erlauben
streamo backup             # Datenbank und Konfiguration sichern
streamo info               # Version, Adresse, Zustand
```

---

## Was auf einem Pi anders ist

### Die SD-Karte

Der wunde Punkt jedes Pi. Streamo schreibt zwar wenig – die Datenbank ist eine Datei, und der stündliche Abgleich ändert nur ein paar Zeilen –, aber SD-Karten sterben trotzdem irgendwann.

Zwei Dinge, die helfen:

**Sichere regelmäßig.** Der Befehl dafür ist schon da:

```bash
streamo backup
```

Das legt ein Archiv unter `/root/` ab. Kopiere es weg, nicht nur auf dieselbe Karte. Automatisch, jede Nacht:

```bash
echo '0 3 * * * root /usr/local/bin/streamo backup' | sudo tee /etc/cron.d/streamo-backup
```

**Oder gleich auf eine SSD.** Ein Pi 4 oder 5 startet von USB, und eine kleine SSD kostet wenig. Wer den Pi ohnehin dauerhaft laufen lässt, spart sich damit den Kartentausch.

### Der Abgleich

Streamo prüft standardmäßig **stündlich**, wo deine Serien laufen. Auf einem Pi 3 oder einem Zero mit großer Bibliothek darf das ruhig seltener sein – der Takt lässt sich unter *Einstellungen → Abgleich* ändern, ohne an die `.env` zu gehen.

### Speicher

Bei einem Pi Zero 2 W oder einem Pi 3 mit 1 GB lohnt sich eine Auslagerungsdatei, sonst kann `npm install` scheitern:

```bash
sudo dphys-swapfile swapoff
sudo sed -i 's/^CONF_SWAPSIZE=.*/CONF_SWAPSIZE=1024/' /etc/dphys-swapfile
sudo dphys-swapfile setup && sudo dphys-swapfile swapon
```

Nach der Installation kann sie wieder kleiner werden – im Betrieb braucht Streamo sie nicht.

---

## Von außen erreichbar machen

Nur nötig, wenn du Streamo unterwegs benutzen oder Freunde einladen willst. **Passkeys brauchen es zwingend**: Sie funktionieren ausschließlich über HTTPS mit einem echten Hostnamen, nie über eine IP-Adresse.

Der übliche Weg ist ein Reverse Proxy mit Let's-Encrypt-Zertifikat – Nginx Proxy Manager, Caddy oder Traefik – der auf `http://<pi-adresse>:3000` zeigt. Danach im Pi **einen Befehl**:

```bash
sudo streamo domain streamo.deine-domain.de
```

Der trägt `TRUST_PROXY`, `WEBAUTHN_RP_ID` und `WEBAUTHN_ORIGIN` ein und startet den Dienst neu. Nötig ist er, weil viele Proxys den `Host`-Header nicht durchreichen: Streamo sähe sonst eine IP statt deiner Domain und würde Passkeys ablehnen.

> Der Port 3000 gehört **nicht** direkt ins Internet weitergeleitet. Ohne HTTPS davor gehen Passwort und Sitzung im Klartext über die Leitung.

Details und die Fehlersuche dazu stehen im [Haupt-README](../README.md#voraussetzungen-für-passkeys).

---

## Fehlersuche

**„Unable to locate package nodejs"**
Fast immer ein 32-Bit-System, auf dem Node 24 gesucht wurde. Ab Version 1.3.0 erkennt der Installer das selbst. Bei einer älteren Installation hilft ein erneuter Durchlauf mit der aktuellen Fassung.

**Der Dienst startet nicht**

```bash
streamo logs
sudo systemctl status streamo
```

Häufigste Ursache auf einem Pi: `npm install` wurde vom Kernel abgebrochen, weil der Speicher ausging. Im Protokoll steht dann `Killed`. Auslagerungsdatei vergrößern (siehe oben) und `update` erneut laufen lassen.

**Die Seite ist im Netz nicht erreichbar**
Standardmäßig lauscht Streamo auf allen Schnittstellen. Prüfe, ob der Dienst läuft und der Port offen ist:

```bash
streamo info
sudo ss -tlnp | grep 3000
```

**Die Installation dauert ewig**
Auf einem Pi Zero 2 W sind zehn Minuten normal, das meiste davon `npm install`. Das ist kein Fehler – nur einmalig.

---

## Was es sonst noch gibt

- [Schnellstart auf Proxmox](QUICKSTART.md) – die ausführliche Anleitung für den LXC-Container
- [Haupt-README](../README.md) – was Streamo kann, Konfiguration, Aufbau
- [Die Windows-App](../desktop/README.md) – eigenes Fenster, Tray, Benachrichtigungen
