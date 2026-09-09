#!/usr/bin/env bash

# ---------------------------------------------------------------------------
# Streamo – Proxmox VE Installationsskript
# ---------------------------------------------------------------------------
# Aufruf auf der Shell des PROXMOX-HOSTS (nicht in einem Container):
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/MoinMornhart/Streamo/main/scripts/streamo.sh)"
#
# Was das Skript tut:
#   1. Prüft, dass es auf einem Proxmox-Host als root läuft
#   2. Fragt (optional) Ressourcen, Speicher und Netzwerk ab
#   3. Lädt bei Bedarf ein Debian-LXC-Template herunter
#   4. Legt einen unprivilegierten LXC-Container an und startet ihn
#   5. Installiert darin Node.js, Streamo und einen systemd-Dienst
#   6. Nennt am Ende die Adresse, unter der Streamo erreichbar ist
#
# Aufbau und Bedienung sind bewusst an die Proxmox VE Community Scripts
# angelehnt (github.com/community-scripts/ProxmoxVE), damit es sich vertraut
# anfühlt. Das Skript ist aber eigenständig: Es lädt keine externen
# Hilfsbibliotheken und funktioniert auch ohne deren Infrastruktur.
#
# Lizenz: MIT
# Quelle: https://github.com/MoinMornhart/Streamo
# ---------------------------------------------------------------------------

# set -e   : bricht bei jedem fehlgeschlagenen Kommando ab
# set -u   : unbelegte Variablen sind ein Fehler (fängt Tippfehler ab)
# set -o pipefail : eine Pipe schlägt fehl, sobald irgendein Glied fehlschlägt
set -euo pipefail

# ===========================================================================
# Grundeinstellungen – die "Vorgaben für den Server"
# ===========================================================================
# Diese Werte bestimmen, wie viel Leistung der Container beansprucht.
# Streamo ist sehr genügsam: Node.js im Leerlauf braucht rund 80 MB, die
# SQLite-Datenbank wächst pro 1000 Serien um etwa 15 MB. Die Vorgaben unten
# haben also reichlich Luft nach oben.

APP="Streamo"
APP_SLUG="streamo"

var_cpu="${var_cpu:-2}"                 # CPU-Kerne
var_ram="${var_ram:-2048}"              # Arbeitsspeicher in MB
var_disk="${var_disk:-8}"               # Festplatte in GB
var_os="${var_os:-debian}"              # Betriebssystem des Containers
var_version="${var_version:-13}"        # Debian-Version (13 = Trixie)
var_unprivileged="${var_unprivileged:-1}" # 1 = unprivilegiert (sicherer)

# Von wo werden die Anwendungsdateien geholt?
REPO_URL="${REPO_URL:-https://github.com/MoinMornhart/Streamo}"
REPO_BRANCH="${REPO_BRANCH:-main}"
INSTALL_SCRIPT_URL="${INSTALL_SCRIPT_URL:-https://raw.githubusercontent.com/MoinMornhart/Streamo/${REPO_BRANCH}/scripts/install/streamo-install.sh}"

# ===========================================================================
# Farben und Symbole für die Ausgabe
# ===========================================================================
# \033[…m sind ANSI-Sequenzen. RD = rot, GN = grün, YW = gelb, BL = blau,
# CL = zurücksetzen. Ohne CL am Ende bliebe das ganze Terminal eingefärbt.
RD=$'\033[01;31m'
GN=$'\033[1;92m'
YW=$'\033[33m'
BL=$'\033[36m'
DGN=$'\033[32m'
CL=$'\033[m'

CM="${GN}✓${CL}"   # erledigt
CROSS="${RD}✗${CL}" # fehlgeschlagen
INFO="${BL}ℹ${CL}"  # Hinweis

# ---------------------------------------------------------------------------
# msg_info / msg_ok / msg_error – einheitliche Statusmeldungen
# ---------------------------------------------------------------------------
# msg_info schreibt OHNE Zeilenumbruch, msg_ok überschreibt die Zeile danach
# mit dem Haken. Dadurch entsteht der aus den Community Scripts bekannte
# Effekt "Aufgabe läuft … → Aufgabe erledigt ✓".

msg_info() {
  echo -ne " ${YW}▶${CL} $1..."
}

msg_ok() {
  # \r springt an den Zeilenanfang, \033[K löscht den Rest der Zeile.
  echo -e "\r\033[K ${CM} $1"
}

msg_error() {
  echo -e "\r\033[K ${CROSS} ${RD}$1${CL}"
}

msg_note() {
  echo -e " ${INFO} $1"
}

# ---------------------------------------------------------------------------
# header – das Logo beim Start
# ---------------------------------------------------------------------------
header() {
  clear
  cat <<"EOF"
   ____  _
  / ___|| |_ _ __ ___  __ _ _ __ ___   ___
  \___ \| __| '__/ _ \/ _` | '_ ` _ \ / _ \
   ___) | |_| | |  __/ (_| | | | | | | (_) |
  |____/ \__|_|  \___|\__,_|_| |_| |_|\___/

  Alle Streaming-Abos an einem Ort – LXC-Installer für Proxmox VE
EOF
  echo ""
}

# ---------------------------------------------------------------------------
# on_error – Aufräumen, wenn etwas schiefgeht
# ---------------------------------------------------------------------------
# Ohne diese Falle bliebe bei einem Abbruch ein halb angelegter Container
# zurück, der beim nächsten Versuch die ID blockiert.
CTID=""
CT_CREATED=0

on_error() {
  local exit_code=$?
  echo ""
  msg_error "Die Installation wurde abgebrochen (Code ${exit_code})."

  if [[ "$CT_CREATED" == "1" && -n "$CTID" ]]; then
    echo ""
    read -rp " Den unvollständigen Container ${CTID} jetzt löschen? [J/n] " answer
    if [[ ! "$answer" =~ ^[nN] ]]; then
      pct stop "$CTID" &>/dev/null || true
      pct destroy "$CTID" &>/dev/null || true
      msg_ok "Container ${CTID} entfernt."
    fi
  fi

  exit "$exit_code"
}
trap on_error ERR

# ===========================================================================
# Vorbedingungen prüfen
# ===========================================================================
check_environment() {
  # 1. Läuft das Skript als root? pct und pveam brauchen Root-Rechte.
  if [[ "$EUID" -ne 0 ]]; then
    msg_error "Bitte als root ausführen (oder mit sudo)."
    exit 1
  fi

  # 2. Sind wir wirklich auf einem Proxmox-Host? Ohne pveversion ist das
  #    entweder ein normaler Debian-Server oder – häufiger Fehler – bereits
  #    ein Container.
  if ! command -v pveversion &>/dev/null; then
    msg_error "Das ist kein Proxmox-VE-Host."
    msg_note "Führe dieses Skript auf der Shell des Proxmox-Servers aus, nicht in einem Container oder einer VM."
    exit 1
  fi

  # 3. Proxmox-Version prüfen. Getestet ist alles ab Version 8.
  local pve_version
  pve_version="$(pveversion | grep -oP 'pve-manager/\K[0-9]+' | head -1)"

  if [[ -z "$pve_version" ]] || ((pve_version < 8)); then
    msg_error "Proxmox VE 8 oder neuer wird benötigt (gefunden: ${pve_version:-unbekannt})."
    exit 1
  fi

  # 4. whiptail für die Dialoge. Auf Proxmox ist es standardmäßig vorhanden;
  #    falls nicht, läuft das Skript trotzdem mit den Vorgaben durch.
  if ! command -v whiptail &>/dev/null; then
    msg_note "whiptail fehlt – es werden die Standardwerte ohne Rückfrage verwendet."
    USE_DIALOG=0
  else
    USE_DIALOG=1
  fi

  msg_ok "Proxmox VE ${pve_version} erkannt."
}

# ---------------------------------------------------------------------------
# next_ctid – die nächste freie Container-ID finden
# ---------------------------------------------------------------------------
# pvesh get /cluster/nextid liefert die kleinste freie ID ab 100 und
# berücksichtigt dabei auch VMs, damit es keine Kollision gibt.
next_ctid() {
  pvesh get /cluster/nextid 2>/dev/null || echo "100"
}

# ---------------------------------------------------------------------------
# pick_storage – Speicherort auswählen
# ---------------------------------------------------------------------------
# Proxmox unterscheidet Speicher nach Inhaltstyp: "vztmpl" für LXC-Templates
# und "rootdir" für die Container-Festplatten. Beides kann auf demselben
# Speicher liegen, muss es aber nicht.
#
# $1 = Inhaltstyp (vztmpl | rootdir)
# $2 = Beschriftung für den Dialog
# Ergebnis steht danach in der globalen Variable STORAGE_RESULT.
pick_storage() {
  local content="$1"
  local label="$2"

  # pvesm status listet alle Speicher; wir filtern auf den passenden Typ.
  local candidates=()
  while read -r name type _ _ _ avail _; do
    candidates+=("$name" "$type – $((avail / 1024 / 1024)) GB frei")
  done < <(pvesm status -content "$content" 2>/dev/null | awk 'NR>1 {print $1, $2, $3, $4, $5, $6, $7}')

  local count=$((${#candidates[@]} / 2))

  if ((count == 0)); then
    msg_error "Kein Speicher vom Typ '${content}' gefunden."
    msg_note "Lege in der Proxmox-Oberflaeche unter Datacenter -> Storage einen Speicher an, der '${content}' erlaubt."
    exit 1
  fi

  # Genau ein Kandidat: ohne Rückfrage nehmen.
  if ((count == 1)); then
    STORAGE_RESULT="${candidates[0]}"
    return
  fi

  # Mehrere: auswählen lassen.
  if [[ "$USE_DIALOG" == "1" ]]; then
    STORAGE_RESULT="$(whiptail --backtitle "Streamo" \
      --title "Speicher für ${label}" \
      --menu "Wo soll ${label} abgelegt werden?" 16 68 6 \
      "${candidates[@]}" 3>&1 1>&2 2>&3)"
  else
    STORAGE_RESULT="${candidates[0]}"
  fi
}

# ===========================================================================
# Einstellungen abfragen
# ===========================================================================
# Zwei Wege: "Standard" nimmt alle Vorgaben von oben, "Erweitert" fragt jeden
# Wert einzeln ab. Genau wie bei den Community Scripts.
ask_settings() {
  CTID="$(next_ctid)"
  HOSTNAME="$APP_SLUG"
  DISK_SIZE="$var_disk"
  CORE_COUNT="$var_cpu"
  RAM_SIZE="$var_ram"
  BRIDGE="vmbr0"
  NET_CONFIG="dhcp"
  DNS_SERVER=""
  START_AFTER_CREATE="1"
  ENABLE_SSH="0"
  ROOT_PASSWORD=""

  if [[ "$USE_DIALOG" != "1" ]]; then
    msg_note "Standardeinstellungen werden verwendet."
    return
  fi

  local choice
  choice="$(whiptail --backtitle "Streamo" --title "$APP LXC" \
    --menu "Wie möchtest du installieren?" 14 68 2 \
    "1" "Standard – ${var_cpu} Kerne, ${var_ram} MB RAM, ${var_disk} GB, DHCP" \
    "2" "Erweitert – alle Werte selbst festlegen" \
    3>&1 1>&2 2>&3)" || exit 1

  if [[ "$choice" == "1" ]]; then
    msg_ok "Standardeinstellungen: ${var_cpu} Kerne · ${var_ram} MB RAM · ${var_disk} GB · DHCP"
    return
  fi

  # ---- Erweiterte Einrichtung ---------------------------------------------

  CTID="$(whiptail --backtitle "Streamo" --title "Container-ID" \
    --inputbox "Welche ID soll der Container bekommen?" 9 62 "$CTID" 3>&1 1>&2 2>&3)" || exit 1

  # Ist die ID schon vergeben? pct status endet mit 0, wenn es sie gibt.
  if pct status "$CTID" &>/dev/null; then
    msg_error "Die Container-ID ${CTID} ist bereits vergeben."
    exit 1
  fi

  HOSTNAME="$(whiptail --backtitle "Streamo" --title "Hostname" \
    --inputbox "Wie soll der Container heißen?" 9 62 "$HOSTNAME" 3>&1 1>&2 2>&3)" || exit 1

  CORE_COUNT="$(whiptail --backtitle "Streamo" --title "CPU-Kerne" \
    --inputbox "Wie viele Kerne? (Empfehlung: 2)" 9 62 "$CORE_COUNT" 3>&1 1>&2 2>&3)" || exit 1

  RAM_SIZE="$(whiptail --backtitle "Streamo" --title "Arbeitsspeicher" \
    --inputbox "Wie viel RAM in MB? (Empfehlung: 2048, Minimum: 512)" 9 62 "$RAM_SIZE" 3>&1 1>&2 2>&3)" || exit 1

  DISK_SIZE="$(whiptail --backtitle "Streamo" --title "Festplatte" \
    --inputbox "Wie groß in GB? (Empfehlung: 8)" 9 62 "$DISK_SIZE" 3>&1 1>&2 2>&3)" || exit 1

  BRIDGE="$(whiptail --backtitle "Streamo" --title "Netzwerkbrücke" \
    --inputbox "Welche Bridge? (meist vmbr0)" 9 62 "$BRIDGE" 3>&1 1>&2 2>&3)" || exit 1

  NET_CONFIG="$(whiptail --backtitle "Streamo" --title "IP-Adresse" \
    --inputbox "'dhcp' oder feste Adresse in CIDR-Schreibweise, z. B. 192.168.1.50/24" 9 68 "$NET_CONFIG" 3>&1 1>&2 2>&3)" || exit 1

  # Bei fester IP wird zusätzlich ein Gateway gebraucht – ohne das käme der
  # Container nicht ins Internet und könnte Node.js nicht installieren.
  if [[ "$NET_CONFIG" != "dhcp" ]]; then
    GATEWAY="$(whiptail --backtitle "Streamo" --title "Gateway" \
      --inputbox "IP-Adresse deines Routers, z. B. 192.168.1.1" 9 62 "" 3>&1 1>&2 2>&3)" || exit 1
  fi

  if whiptail --backtitle "Streamo" --title "SSH-Zugang" \
    --yesno "Soll der SSH-Zugang im Container aktiviert werden?" 9 62; then
    ENABLE_SSH="1"
    ROOT_PASSWORD="$(whiptail --backtitle "Streamo" --title "Root-Passwort" \
      --passwordbox "Passwort für den Benutzer root im Container" 9 62 3>&1 1>&2 2>&3)" || exit 1
  fi

  msg_ok "Einstellungen übernommen."
}

# ===========================================================================
# Template besorgen
# ===========================================================================
# Ein LXC-Container braucht ein Basis-Image ("Template"). Proxmox verwaltet
# die verfügbaren Images mit pveam.
prepare_template() {
  msg_info "Template-Liste wird aktualisiert"
  pveam update &>/dev/null
  msg_ok "Template-Liste aktualisiert"

  # Das neueste Debian-Standard-Template der gewünschten Version suchen.
  local template
  template="$(pveam available -section system | awk '{print $2}' \
    | grep -E "^${var_os}-${var_version}-standard" | sort -V | tail -1)"

  # Rückfall auf Debian 12, falls die gewünschte Version noch nicht in den
  # Spiegelservern liegt. So funktioniert das Skript auch auf älteren Hosts.
  if [[ -z "$template" ]]; then
    msg_note "Debian ${var_version} nicht verfügbar – weiche auf Debian 12 aus."
    template="$(pveam available -section system | awk '{print $2}' \
      | grep -E "^${var_os}-12-standard" | sort -V | tail -1)"
  fi

  if [[ -z "$template" ]]; then
    msg_error "Kein passendes ${var_os}-Template gefunden."
    exit 1
  fi

  TEMPLATE_FILE="$template"

  # Liegt es schon lokal? Dann sparen wir uns den Download (rund 130 MB).
  if pveam list "$TEMPLATE_STORAGE" 2>/dev/null | grep -q "$TEMPLATE_FILE"; then
    msg_ok "Template bereits vorhanden: ${TEMPLATE_FILE}"
  else
    msg_info "Template wird geladen: ${TEMPLATE_FILE}"
    pveam download "$TEMPLATE_STORAGE" "$TEMPLATE_FILE" &>/dev/null
    msg_ok "Template geladen"
  fi
}

# ===========================================================================
# Container anlegen
# ===========================================================================
create_container() {
  msg_info "Container ${CTID} wird angelegt"

  # Netzwerkzeile zusammenbauen. Format:
  #   name=eth0,bridge=vmbr0,ip=dhcp
  #   name=eth0,bridge=vmbr0,ip=192.168.1.50/24,gw=192.168.1.1
  local net="name=eth0,bridge=${BRIDGE},ip=${NET_CONFIG}"
  if [[ "$NET_CONFIG" != "dhcp" && -n "${GATEWAY:-}" ]]; then
    net="${net},gw=${GATEWAY}"
  fi

  # Die Optionen im Einzelnen:
  #   --features nesting=1  erlaubt es, im Container weitere Namensräume zu
  #                         öffnen. Node.js braucht das nicht zwingend, aber
  #                         ohne diese Option scheitern viele apt-Hooks.
  #   --onboot 1            startet den Container mit dem Host automatisch
  #   --unprivileged        Root im Container ist nicht Root auf dem Host
  pct create "$CTID" "${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE_FILE}" \
    --hostname "$HOSTNAME" \
    --cores "$CORE_COUNT" \
    --memory "$RAM_SIZE" \
    --swap 512 \
    --rootfs "${CONTAINER_STORAGE}:${DISK_SIZE}" \
    --net0 "$net" \
    --unprivileged "$var_unprivileged" \
    --features nesting=1 \
    --onboot 1 \
    --ostype "$var_os" \
    --description "Streamo – alle Streaming-Abos an einem Ort. ${REPO_URL}" \
    &>/dev/null

  CT_CREATED=1
  msg_ok "Container ${CTID} angelegt"

  # Root-Passwort setzen, falls SSH gewünscht ist.
  if [[ "$ENABLE_SSH" == "1" && -n "$ROOT_PASSWORD" ]]; then
    # chpasswd liest "benutzer:passwort" von der Standardeingabe – so taucht
    # das Passwort nicht in der Prozessliste auf.
    pct exec "$CTID" -- bash -c "echo 'root:${ROOT_PASSWORD}' | chpasswd" &>/dev/null || true
  fi

  msg_info "Container wird gestartet"
  pct start "$CTID"

  # Auf das Netzwerk warten. Ohne Verbindung schlägt apt sofort fehl, und die
  # Fehlermeldung wäre irreführend ("Paketquellen nicht erreichbar").
  local waited=0
  until pct exec "$CTID" -- ping -c1 -W1 deb.debian.org &>/dev/null; do
    sleep 2
    waited=$((waited + 2))
    if ((waited > 60)); then
      msg_error "Der Container hat nach 60 Sekunden keine Netzwerkverbindung."
      msg_note "Prüfe Bridge (${BRIDGE}) und IP-Konfiguration (${NET_CONFIG})."
      exit 1
    fi
  done

  msg_ok "Container läuft und ist online"
}

# ===========================================================================
# Streamo im Container installieren
# ===========================================================================
install_app() {
  msg_info "Streamo wird installiert (das dauert 2–4 Minuten)"

  # Das Installationsskript wird in den Container kopiert und dort ausgeführt.
  # Zwei Wege, damit es auch funktioniert, wenn das Skript lokal aus einem
  # geklonten Repository gestartet wurde:
  local local_installer
  local_installer="$(dirname "${BASH_SOURCE[0]}")/install/streamo-install.sh"

  if [[ -f "$local_installer" ]]; then
    # Fall 1: lokale Kopie vorhanden (Entwicklung / geklontes Repo)
    pct push "$CTID" "$local_installer" /tmp/streamo-install.sh
  else
    # Fall 2: über curl vom Repository holen (der Normalfall)
    pct exec "$CTID" -- bash -c "
      apt-get update -qq >/dev/null 2>&1
      apt-get install -y -qq curl ca-certificates >/dev/null 2>&1
      curl -fsSL '${INSTALL_SCRIPT_URL}' -o /tmp/streamo-install.sh
    "
  fi

  # Repository-Adresse und Branch als Umgebungsvariablen durchreichen, damit
  # sich auch ein Fork installieren lässt.
  pct exec "$CTID" -- bash -c "
    export REPO_URL='${REPO_URL}'
    export REPO_BRANCH='${REPO_BRANCH}'
    chmod +x /tmp/streamo-install.sh
    bash /tmp/streamo-install.sh
  "

  msg_ok "Streamo installiert"
}

# ===========================================================================
# Abschluss
# ===========================================================================
finish() {
  # IP-Adresse des Containers ermitteln. hostname -I liefert alle Adressen;
  # die erste ist die des Hauptinterfaces.
  local ip
  ip="$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{print $1}')"

  echo ""
  echo -e " ${GN}════════════════════════════════════════════════════════════${CL}"
  echo -e "  ${GN}Streamo läuft.${CL}"
  echo ""
  echo -e "  Weboberfläche   ${BL}http://${ip}:3000${CL}"
  echo -e "  Container-ID    ${DGN}${CTID}${CL}"
  echo -e "  Ressourcen      ${DGN}${CORE_COUNT} Kerne · ${RAM_SIZE} MB RAM · ${DISK_SIZE} GB${CL}"
  echo ""
  echo -e "  ${YW}Nächste Schritte${CL}"
  echo -e "   1. Öffne ${BL}http://${ip}:3000${CL} im Browser"
  echo -e "   2. Lege dein Konto an"
  echo -e "   3. Trage deinen TMDB-API-Key ein (kostenlos:"
  echo -e "      ${BL}https://www.themoviedb.org/settings/api${CL})"
  echo -e "   4. Klick deine Streaming-Abos an – fertig"
  echo ""
  echo -e "  ${YW}Nützliche Befehle${CL}"
  echo -e "   Konsole öffnen   ${DGN}pct enter ${CTID}${CL}"
  echo -e "   Dienst neu laden ${DGN}pct exec ${CTID} -- systemctl restart streamo${CL}"
  echo -e "   Protokoll ansehen ${DGN}pct exec ${CTID} -- journalctl -u streamo -f${CL}"
  echo -e "   Aktualisieren    ${DGN}pct exec ${CTID} -- streamo-update${CL}"
  echo -e " ${GN}════════════════════════════════════════════════════════════${CL}"
  echo ""
}

# ===========================================================================
# Ablauf
# ===========================================================================
main() {
  header
  check_environment
  ask_settings

  # Speicher auswählen: erst für das Template, dann für die Festplatte.
  pick_storage "vztmpl" "das LXC-Template"
  TEMPLATE_STORAGE="$STORAGE_RESULT"
  msg_ok "Template-Speicher: ${TEMPLATE_STORAGE}"

  pick_storage "rootdir" "die Container-Festplatte"
  CONTAINER_STORAGE="$STORAGE_RESULT"
  msg_ok "Container-Speicher: ${CONTAINER_STORAGE}"

  prepare_template
  create_container
  install_app
  finish
}

main "$@"
