#!/usr/bin/env bash

# ---------------------------------------------------------------------------
# streamo-install.sh – Installation INNERHALB des Containers
# ---------------------------------------------------------------------------
# Dieses Skript wird nicht direkt aufgerufen, sondern von scripts/streamo.sh
# in den frisch angelegten LXC-Container kopiert und dort ausgeführt.
#
# Es lässt sich aber auch von Hand auf jedem Debian- oder Ubuntu-System
# verwenden, um Streamo zu installieren:
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/MoinMornhart/Streamo/main/scripts/install/streamo-install.sh)"
#
# Schritte:
#   1. Systempakete aktualisieren, Werkzeuge nachinstallieren
#   2. Node.js 24 LTS aus dem NodeSource-Repository
#   3. Systembenutzer "streamo" anlegen (der Dienst läuft nicht als root)
#   4. Anwendung nach /opt/streamo klonen und Abhängigkeiten installieren
#   5. Konfiguration /opt/streamo/.env mit zufälligem Session-Secret
#   6. systemd-Dienst einrichten, starten und auf Erreichbarkeit prüfen
#   7. Hilfsbefehl "streamo-update" für spätere Aktualisierungen
# ---------------------------------------------------------------------------

set -euo pipefail

# Woher kommen die Quellen? Von scripts/streamo.sh als Umgebungsvariable
# gesetzt; die Vorgaben hier greifen bei direktem Aufruf.
REPO_URL="${REPO_URL:-https://github.com/MoinMornhart/Streamo}"
REPO_BRANCH="${REPO_BRANCH:-main}"

# Wohin wird installiert?
APP_DIR="/opt/streamo"
DATA_DIR="/opt/streamo/data"
SERVICE_USER="streamo"
# ---------------------------------------------------------------------------
# Welche Node-Reihe? Das haengt von der Architektur ab.
# ---------------------------------------------------------------------------
# Auf einem gewoehnlichen Server (amd64) und auf einem Raspberry Pi mit
# 64-Bit-System (arm64) gibt es Node 24 bei NodeSource.
#
# Auf einem 32-Bit-System (armhf) NICHT: Die Paketliste von node_24.x enthaelt
# dort ueberhaupt kein nodejs-Paket, und nodejs.org liefert fuer Node 24 auch
# kein armv7l-Archiv mehr. Node 22 gibt es dagegen weiterhin fuer armhf - und
# 22 genuegt, denn Streamo braucht mindestens 22.5 fuer das eingebaute Modul
# node:sqlite.
#
# Ohne diese Unterscheidung bricht die Installation auf einem 32-Bit-Pi mit
# "Unable to locate package nodejs" ab - und zwar erst nach dem
# Paketquellen-Eintrag, was die Ursache schwer erkennbar macht.
HOST_ARCH="$(dpkg --print-architecture 2>/dev/null || echo unknown)"

case "$HOST_ARCH" in
  amd64 | arm64)
    NODE_MAJOR="24"
    ;;
  armhf)
    NODE_MAJOR="22"
    ;;
  *)
    # Auf allem anderen (armel, i386, riscv64 …) gibt es keine passenden
    # Pakete. Lieber jetzt mit einer klaren Ansage abbrechen als spaeter mit
    # einer kryptischen apt-Meldung.
    echo ""
    echo "  Diese Architektur wird nicht unterstuetzt: ${HOST_ARCH}"
    echo ""
    echo "  Streamo braucht Node.js 22.5 oder neuer. Fertige Pakete gibt es"
    echo "  fuer amd64, arm64 und armhf."
    echo ""
    echo "  Auf einem Raspberry Pi: Nimm Raspberry Pi OS in der 64-Bit-Fassung."
    echo ""
    exit 1
    ;;
esac

# Farben für die Ausgabe (identisch zu scripts/streamo.sh)
GN=$'\033[1;92m'
YW=$'\033[33m'
RD=$'\033[01;31m'
CL=$'\033[m'

msg_info() { echo -ne " ${YW}▶${CL} $1..."; }
msg_ok() { echo -e "\r\033[K ${GN}✓${CL} $1"; }
msg_error() { echo -e "\r\033[K ${RD}✗ $1${CL}"; }

# DEBIAN_FRONTEND=noninteractive verhindert, dass apt mitten in der
# Installation nach Konfigurationsentscheidungen fragt und hängen bleibt.
export DEBIAN_FRONTEND=noninteractive

# ===========================================================================
# 1. Systempakete
# ===========================================================================
msg_info "System wird aktualisiert"
apt-get update -qq >/dev/null
apt-get install -y -qq \
  curl \
  ca-certificates \
  gnupg \
  git \
  sudo \
  >/dev/null
msg_ok "System aktualisiert"

# ===========================================================================
# 2. Node.js
# ===========================================================================
# Warum NodeSource statt der Debian-Pakete? Debian liefert eine ältere
# Node-Version aus. Streamo braucht das eingebaute Modul node:sqlite, und das
# ist erst ab Node 22.13 ohne Zusatzflag nutzbar (in 22.5 kam es hinzu, aber
# nur hinter --experimental-sqlite; freigeschaltet wurde es in 23.4 und
# rückwirkend in 22.13).
#
# 22.13 ist deshalb die Untergrenze – nicht 23. Auf einem 32-Bit-Raspberry-Pi
# gibt es nämlich gar kein Node 24, dort wird die 22er-Reihe installiert. Eine
# Prüfung auf ">= 23" hätte ein völlig taugliches Node 22.19 verworfen und
# stattdessen erfolglos Node 24 nachzuinstallieren versucht.
node_taugt() {
  command -v node >/dev/null 2>&1 || return 1

  local version major minor
  version="$(node -v | tr -d 'v')"
  major="${version%%.*}"
  minor="$(echo "$version" | cut -d. -f2)"

  # Ab 23 in jedem Fall; bei 22 erst ab 22.13.
  [[ "$major" -ge 23 ]] && return 0
  [[ "$major" -eq 22 && "$minor" -ge 13 ]] && return 0

  return 1
}

if node_taugt; then
  msg_ok "Node.js $(node -v) ist bereits installiert"
else
  msg_info "Node.js ${NODE_MAJOR} wird installiert"

  # Signierschlüssel von NodeSource ablegen …
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg

  # … und die Paketquelle eintragen. signed-by bindet die Quelle an genau
  # diesen Schlüssel, damit sie keine anderen Pakete signieren kann.
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    >/etc/apt/sources.list.d/nodesource.list

  apt-get update -qq >/dev/null
  apt-get install -y -qq nodejs >/dev/null

  msg_ok "Node.js $(node -v) installiert"
fi

# ===========================================================================
# 3. Dienstbenutzer
# ===========================================================================
# Der Dienst läuft NICHT als root. Sollte je eine Lücke in Streamo oder einer
# Abhängigkeit auftauchen, ist der Schaden auf dieses eine Verzeichnis begrenzt.
if id "$SERVICE_USER" &>/dev/null; then
  msg_ok "Benutzer ${SERVICE_USER} existiert bereits"
else
  msg_info "Systembenutzer ${SERVICE_USER} wird angelegt"
  # --system      : Systemkonto (keine reguläre Benutzer-ID)
  # --shell nologin : keine Anmeldung möglich
  # --home        : Heimatverzeichnis = Anwendungsverzeichnis
  useradd --system --shell /usr/sbin/nologin --home-dir "$APP_DIR" "$SERVICE_USER"
  msg_ok "Benutzer ${SERVICE_USER} angelegt"
fi

# ===========================================================================
# 4. Anwendung holen
# ===========================================================================
# ---------------------------------------------------------------------------
# Git erlauben, in diesem Verzeichnis zu arbeiten.
#
# /opt/streamo gehört dem Dienstbenutzer "streamo", ausgeführt wird aber als
# root. Seit Version 2.35 verweigert Git in dieser Lage jede Operation mit
# "detected dubious ownership in repository" – eine Schutzmaßnahme gegen
# untergeschobene Repositories in fremden Verzeichnissen.
#
# Ohne diese Zeile scheitern "git fetch" und damit jedes Update. Die Angabe
# beschränkt die Ausnahme auf genau dieses eine Verzeichnis.
# ---------------------------------------------------------------------------
git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true

if [[ -d "$APP_DIR/.git" ]]; then
  msg_info "Vorhandene Installation wird aktualisiert"

  # Fehler werden protokolliert statt verschluckt. Vorher stand hier
  # ">/dev/null 2>&1", wodurch ein gescheitertes git das Skript wortlos
  # beendete – man sah nur "wird aktualisiert…" und war zurück im Prompt.
  if ! git -C "$APP_DIR" fetch --depth 1 origin "$REPO_BRANCH" >/tmp/streamo-git.log 2>&1 ||
    ! git -C "$APP_DIR" reset --hard "origin/${REPO_BRANCH}" >>/tmp/streamo-git.log 2>&1; then
    msg_error "Die neue Version konnte nicht geholt werden."
    echo "   Meldung von git:"
    sed 's/^/     /' /tmp/streamo-git.log | tail -10
    exit 1
  fi

  msg_ok "Quellen aktualisiert"
else
  msg_info "Streamo wird heruntergeladen"
  # --depth 1: nur der aktuelle Stand, keine Versionsgeschichte. Spart Platz
  # und Zeit; für ein Deployment braucht man die Historie nicht.
  git clone --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" "$APP_DIR" >/dev/null 2>&1
  msg_ok "Streamo heruntergeladen"
fi

msg_info "Abhängigkeiten werden installiert"
cd "$APP_DIR"
# --omit=dev: keine Entwicklungswerkzeuge auf dem Server.
# --no-audit / --no-fund: unterdrückt Ausgaben, die hier nur stören.
npm install --omit=dev --no-audit --no-fund --loglevel=error >/dev/null 2>&1
msg_ok "Abhängigkeiten installiert"

# ===========================================================================
# 5. Konfiguration
# ===========================================================================
mkdir -p "$DATA_DIR"

if [[ -f "$APP_DIR/.env" ]]; then
  msg_ok "Vorhandene Konfiguration bleibt unverändert"
else
  msg_info "Konfiguration wird erzeugt"

  # Ein zufälliges Session-Secret. openssl ist auf Debian immer vorhanden;
  # 48 Bytes ergeben 64 Base64-Zeichen.
  SESSION_SECRET="$(openssl rand -base64 48 | tr -d '\n')"

  cat >"$APP_DIR/.env" <<EOF
# Von streamo-install.sh erzeugt am $(date -Iseconds)
# Änderungen wirken nach: systemctl restart streamo

# Netzwerk
PORT=3000
HOST=0.0.0.0

# Speicherort der Datenbank
DATA_DIR=${DATA_DIR}

# Signatur der Anmeldesitzungen. NICHT teilen und nicht ändern, sonst werden
# alle Benutzer abgemeldet.
SESSION_SECRET=${SESSION_SECRET}

# TMDB-API-Key. Kann leer bleiben und beim ersten Start im Browser
# eingetragen werden: https://www.themoviedb.org/settings/api
TMDB_API_KEY=

# Region und Sprache
STREAMO_REGION=DE
STREAMO_LANGUAGE=de-DE

# Abgleich der Streaming-Verfügbarkeit alle 12 Stunden
SYNC_INTERVAL_HOURS=1

# Dürfen sich weitere Personen selbst registrieren?
ALLOW_REGISTRATION=false

# Auf true setzen, wenn ein Reverse Proxy mit HTTPS davorsteht
TRUST_PROXY=false
EOF

  msg_ok "Konfiguration erzeugt"
fi

# Rechte setzen: Alles gehört dem Dienstbenutzer, die .env darf nur er lesen
# (sie enthält Session-Secret und API-Key).
chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"
chmod 600 "$APP_DIR/.env"
chown "$SERVICE_USER:$SERVICE_USER" "$APP_DIR/.env"

# ===========================================================================
# 6. systemd-Dienst
# ===========================================================================
msg_info "systemd-Dienst wird eingerichtet"

cat >/etc/systemd/system/streamo.service <<EOF
[Unit]
Description=Streamo – alle Streaming-Abos an einem Ort
Documentation=${REPO_URL}
# Erst starten, wenn das Netzwerk steht – sonst schlägt der erste
# TMDB-Aufruf fehl.
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${APP_DIR}
ExecStart=/usr/bin/node ${APP_DIR}/src/server.js

# Bei einem Absturz automatisch neu starten, aber mit Pause, damit eine
# kaputte Konfiguration nicht zu einer Endlosschleife führt.
Restart=on-failure
RestartSec=10

# Ausgaben landen im journal: journalctl -u streamo -f
StandardOutput=journal
StandardError=journal
SyslogIdentifier=streamo

# --- Härtung -------------------------------------------------------------
# Diese Optionen schränken ein, was der Prozess überhaupt darf. Sie kosten
# nichts und begrenzen den Schaden, falls doch einmal etwas ausbricht.
NoNewPrivileges=true
# Eigenes /tmp, unsichtbar für andere Prozesse
PrivateTmp=true
# Das gesamte Dateisystem ist schreibgeschützt …
ProtectSystem=strict
# … mit genau einer Ausnahme: dem Datenverzeichnis.
ReadWritePaths=${DATA_DIR}
# Kein Zugriff auf fremde Heimatverzeichnisse
ProtectHome=true
# Kernel- und Systemeinstellungen sind tabu
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
# Nur die Adressfamilien, die tatsächlich gebraucht werden
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable streamo >/dev/null 2>&1
systemctl restart streamo

msg_ok "Dienst eingerichtet"

# ===========================================================================
# 7. Konsolenbefehle
# ===========================================================================
# Richtet "update", "streamo-update" und "streamo" ein sowie die Begrüßung
# beim Anmelden. Die Logik dafür steht in einer eigenen Datei, weil sie auch
# bei jedem Update erneut ausgeführt wird – siehe scripts/install-commands.sh.
msg_info "Konsolenbefehle werden eingerichtet"

# ---------------------------------------------------------------------------
# Zuerst ein Notfall-"update" anlegen – noch bevor das eigentliche Skript
# läuft.
#
# Der Grund ist eine Falle, in die man sonst geraten kann: Schlägt die
# Einrichtung der Konsolenbefehle aus irgendeinem Grund fehl, fehlt
# ausgerechnet der Befehl, mit dem man das Problem beheben würde. Man sitzt
# dann in einem Container ohne den Weg hinaus.
#
# Diese Fassung kann nur das Nötigste: neueste Version holen, Abhängigkeiten
# installieren, Dienst neu starten. Sie wird gleich darunter durch die
# vollwertige Fassung ersetzt – existiert aber ab jetzt in jedem Fall.
# ---------------------------------------------------------------------------
cat >/usr/local/bin/update <<'FALLBACK'
#!/usr/bin/env bash
# Notfall-Fassung, angelegt von streamo-install.sh. Wird normalerweise sofort
# durch die vollwertige Fassung aus install-commands.sh ersetzt.
set -euo pipefail

echo "Streamo wird aktualisiert (Notfall-Fassung) …"

cd /opt/streamo
git fetch --depth 1 origin main
git reset --hard origin/main
npm install --omit=dev --no-audit --no-fund --loglevel=error
chown -R streamo:streamo /opt/streamo

# Die vollwertigen Befehle nachträglich einrichten, falls sie fehlen.
if [[ -f /opt/streamo/scripts/install/install-commands.sh ]]; then
  bash /opt/streamo/scripts/install/install-commands.sh
fi

systemctl restart streamo
echo "Fertig."
FALLBACK

chmod +x /usr/local/bin/update

# --- Jetzt die vollwertigen Befehle -----------------------------------------
if [[ -f "$APP_DIR/scripts/install/install-commands.sh" ]]; then
  # Ohne ">/dev/null": Ein Fehler soll sichtbar sein und nicht in der
  # Dunkelheit verschwinden. "|| true" verhindert, dass die gesamte
  # Installation daran scheitert – der Notfallbefehl von oben bleibt ja.
  if APP_DIR="$APP_DIR" bash "$APP_DIR/scripts/install/install-commands.sh" >/tmp/streamo-commands.log 2>&1; then
    msg_ok "Konsolenbefehle eingerichtet (update, streamo)"
  else
    msg_error "Die Konsolenbefehle konnten nicht vollständig eingerichtet werden."
    echo "   Meldung:"
    sed 's/^/     /' /tmp/streamo-commands.log | tail -10
    echo "   Der Befehl 'update' steht trotzdem zur Verfügung (Notfall-Fassung)."
  fi
else
  msg_error "install-commands.sh fehlt im heruntergeladenen Stand."
  echo "   'update' steht als Notfall-Fassung zur Verfügung und richtet die"
  echo "   übrigen Befehle beim ersten Lauf ein."
fi

# ===========================================================================
# 8. Erreichbarkeit prüfen
# ===========================================================================
msg_info "Warte auf den Dienst"

# Bis zu 30 Sekunden auf eine Antwort von /api/health warten. Der erste Start
# legt die Datenbank an, das dauert einen Moment.
ready=0
for _ in {1..30}; do
  if curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done

if [[ "$ready" == "1" ]]; then
  msg_ok "Streamo antwortet auf Port 3000"
else
  msg_error "Streamo antwortet nicht."
  echo ""
  echo "Die letzten Protokollzeilen:"
  journalctl -u streamo -n 30 --no-pager || true
  exit 1
fi

# Aufräumen: apt-Zwischenspeicher leeren, das spart im Container einige
# hundert Megabyte.
apt-get -y autoremove >/dev/null 2>&1 || true
apt-get -y autoclean >/dev/null 2>&1 || true

echo ""
echo -e " ${GN}Streamo ist installiert und läuft.${CL}"
echo -e " Adresse:       http://$(hostname -I | awk '{print $1}'):3000"
echo -e " Verzeichnis:   ${APP_DIR}"
echo -e " Daten:         ${DATA_DIR}"
echo ""
echo -e " ${YW}Befehle im Container${CL}"
echo -e "   update           Streamo auf die neueste Version bringen"
echo -e "   update --check   Nur nachsehen, ob es etwas Neues gibt"
echo -e "   streamo          Alle Verwaltungsbefehle anzeigen"
echo ""
