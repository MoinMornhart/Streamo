#!/usr/bin/env bash

# ---------------------------------------------------------------------------
# streamo-update.sh – Streamo aktualisieren
# ---------------------------------------------------------------------------
# Aufruf im Container – alle drei Varianten machen dasselbe:
#
#   update                  (der kurze Weg)
#   streamo-update
#   bash /opt/streamo/scripts/streamo-update.sh
#
# Optionen:
#   --check     Nur nachsehen, ob es etwas Neues gibt. Ändert nichts.
#   --force     Auch dann aktualisieren, wenn die Version schon aktuell ist
#               (nützlich, wenn eine Installation kaputt ist).
#   --yes, -y   Keine Rückfrage stellen (für Automatisierung und Cronjobs).
#
# Ablauf:
#   1. Prüfen, ob es überhaupt eine neue Version gibt
#   2. Sicherungskopie der Datenbank anlegen (die letzten fünf bleiben)
#   3. Dienst anhalten, neue Quellen holen, Abhängigkeiten installieren
#   4. Dienst starten und prüfen, ob er antwortet
#   5. Antwortet er NICHT: automatisch auf den vorherigen Stand zurück
#
# Unangetastet bleiben in jedem Fall: /opt/streamo/data (die Datenbank) und
# /opt/streamo/.env (deine Konfiguration). Beide stehen in .gitignore und
# werden von "git reset --hard" nicht berührt.
# ---------------------------------------------------------------------------

set -euo pipefail

# ---------------------------------------------------------------------------
# Sich selbst aus dem Weg gehen.
#
# Dieses Skript liegt IM Repository, das es gleich aktualisiert. Würde es
# direkt von dort laufen, könnte bash mitten im Lauf eine veränderte Datei
# nachladen und an einer sinnlosen Stelle weitermachen – ein bekannter und
# sehr unangenehmer Fehler. Deshalb kopiert sich das Skript zuerst nach /tmp
# und startet sich von dort neu. Die Umgebungsvariable verhindert, dass das
# endlos passiert.
# ---------------------------------------------------------------------------
if [[ "${STREAMO_UPDATE_REEXEC:-}" != "1" ]]; then
  SELF_COPY="$(mktemp /tmp/streamo-update-XXXXXX.sh)"
  cp "${BASH_SOURCE[0]}" "$SELF_COPY"

  # Beide Variablen werden an den Kindprozess vererbt: die eine sagt ihm,
  # dass er die Kopie ist, die andere, welche Datei er am Ende aufräumen darf.
  export STREAMO_UPDATE_REEXEC=1
  export STREAMO_UPDATE_SELF_COPY="$SELF_COPY"

  # exec ersetzt den laufenden Prozess – kein zusätzlicher Prozess bleibt übrig.
  exec bash "$SELF_COPY" "$@"
fi

# ---------------------------------------------------------------------------
# Die Kopie in /tmp nach dem Lauf wieder entfernen, egal wie es ausgeht.
#
# Aufgeräumt wird ausschließlich die Datei, die dieser Lauf selbst angelegt
# hat, und nur wenn ihr Pfad zum erwarteten Muster passt. Ohne diese beiden
# Bedingungen würde ein von außen gesetztes STREAMO_UPDATE_REEXEC=1 dazu
# führen, dass sich das ORIGINALSKRIPT im Repository selbst löscht – der Weg
# in eine kaputte Installation.
# ---------------------------------------------------------------------------
if [[ "${STREAMO_UPDATE_SELF_COPY:-}" == /tmp/streamo-update-*.sh ]]; then
  trap 'rm -f "$STREAMO_UPDATE_SELF_COPY"' EXIT
fi

# ===========================================================================
# Einstellungen
# ===========================================================================
APP_DIR="${APP_DIR:-/opt/streamo}"
DATA_DIR="${DATA_DIR:-${APP_DIR}/data}"
SERVICE_USER="${SERVICE_USER:-streamo}"
SERVICE_NAME="streamo"
BRANCH="${REPO_BRANCH:-main}"

# Wie viele Datenbanksicherungen werden aufbewahrt?
KEEP_BACKUPS=5

# Wie lange (Sekunden) darf der Dienst nach dem Neustart brauchen?
HEALTH_TIMEOUT=45

# ===========================================================================
# Ausgabe
# ===========================================================================
GN=$'\033[1;92m'
YW=$'\033[33m'
RD=$'\033[01;31m'
BL=$'\033[36m'
DIM=$'\033[2m'
CL=$'\033[m'

msg_info() { echo -ne " ${YW}▶${CL} $1..."; }
msg_ok() { echo -e "\r\033[K ${GN}✓${CL} $1"; }
msg_error() { echo -e "\r\033[K ${RD}✗ $1${CL}"; }
msg_note() { echo -e " ${BL}ℹ${CL} $1"; }

# ===========================================================================
# Argumente auswerten
# ===========================================================================
CHECK_ONLY=0
FORCE=0
ASSUME_YES=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check | -c) CHECK_ONLY=1 ;;
    --force | -f) FORCE=1 ;;
    --yes | -y) ASSUME_YES=1 ;;
    --help | -h)
      # Die Kommentare am Dateianfang sind gleichzeitig die Hilfe – so kann
      # sie nicht veralten.
      sed -n '3,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      msg_error "Unbekannte Option: $1"
      echo "   Erlaubt sind: --check, --force, --yes, --help"
      exit 1
      ;;
  esac
  shift
done

# ===========================================================================
# Vorbedingungen
# ===========================================================================

# Root wird gebraucht: systemctl, npm-Installation und chown gehen sonst nicht.
if [[ "$EUID" -ne 0 ]]; then
  msg_error "Bitte als root ausführen."
  echo "   Im Container:      update"
  echo "   Vom Proxmox-Host:  pct exec <CTID> -- update"
  exit 1
fi

if [[ ! -d "$APP_DIR/.git" ]]; then
  msg_error "Unter ${APP_DIR} liegt keine Git-Installation von Streamo."
  msg_note "Wurde Streamo von Hand kopiert statt geklont? Dann bitte neu installieren:"
  echo "   bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/MoinMornhart/Streamo/main/scripts/install/streamo-install.sh)\""
  exit 1
fi

echo ""
echo -e " ${BL}Streamo aktualisieren${CL}"
echo ""

# ===========================================================================
# 1. Gibt es überhaupt etwas Neues?
# ===========================================================================
msg_info "Suche nach Aktualisierungen"

# ---------------------------------------------------------------------------
# Git erlauben, in diesem Verzeichnis zu arbeiten.
#
# /opt/streamo gehört dem Dienstbenutzer "streamo", das Update läuft aber als
# root. Seit Git 2.35 wird das als "dubious ownership" abgelehnt, und jede
# git-Operation scheitert. Die Ausnahme gilt nur für dieses Verzeichnis.
# ---------------------------------------------------------------------------
git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true

# Erst den aktuellen Stand merken – auf ihn wird notfalls zurückgerollt.
if ! CURRENT_COMMIT="$(git -C "$APP_DIR" rev-parse HEAD 2>/tmp/streamo-git.log)"; then
  msg_error "Das Repository unter ${APP_DIR} ist nicht lesbar."
  echo "   Meldung von git:"
  sed 's/^/     /' /tmp/streamo-git.log | tail -5
  exit 1
fi
CURRENT_VERSION="$(node -p "require('${APP_DIR}/package.json').version" 2>/dev/null || echo '?')"

# --depth 1 holt nur den neuesten Stand, nicht die ganze Geschichte.
# Fehler werden protokolliert statt verschluckt – ein stiller Abbruch an
# dieser Stelle ist praktisch nicht zu diagnostizieren.
if ! git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH" >/tmp/streamo-git.log 2>&1; then
  msg_error "Die Verbindung zum Repository ist fehlgeschlagen."
  echo "   Meldung von git:"
  sed 's/^/     /' /tmp/streamo-git.log | tail -8
  echo ""
  echo "   Läuft der Container online? Prüfe mit: ping -c1 github.com"
  exit 1
fi

REMOTE_COMMIT="$(git -C "$APP_DIR" rev-parse "origin/${BRANCH}")"

if [[ "$CURRENT_COMMIT" == "$REMOTE_COMMIT" ]]; then
  msg_ok "Streamo ist bereits auf dem neuesten Stand (Version ${CURRENT_VERSION})"

  if [[ "$FORCE" != "1" ]]; then
    echo ""
    echo -e " ${DIM}Trotzdem neu installieren: update --force${CL}"
    echo ""
    exit 0
  fi

  msg_note "--force ist gesetzt – es wird trotzdem neu installiert."
else
  msg_ok "Eine neue Version ist verfügbar"

  # Was hat sich geändert? Die Betreffzeilen der neuen Commits anzeigen.
  echo ""
  echo -e " ${DIM}Änderungen:${CL}"
  git -C "$APP_DIR" log --oneline --no-decorate "${CURRENT_COMMIT}..${REMOTE_COMMIT}" 2>/dev/null \
    | head -15 | sed 's/^/   /' || echo "   (keine Auflistung verfügbar)"
  echo ""
fi

# Nur nachsehen? Dann sind wir hier fertig.
if [[ "$CHECK_ONLY" == "1" ]]; then
  msg_note "Nur geprüft – es wurde nichts verändert. Mit \"update\" einspielen."
  echo ""
  exit 0
fi

# Rückfrage, sofern nicht mit --yes unterdrückt und ein Terminal vorhanden ist.
# Die Prüfung auf ein Terminal ist wichtig, damit ein Cronjob nicht ewig auf
# eine Eingabe wartet, die nie kommt.
if [[ "$ASSUME_YES" != "1" && -t 0 ]]; then
  read -rp " Jetzt aktualisieren? [J/n] " answer
  if [[ "$answer" =~ ^[nN] ]]; then
    echo " Abgebrochen."
    exit 0
  fi
  echo ""
fi

# ===========================================================================
# 2. Datenbank sichern
# ===========================================================================
BACKUP_FILE=""

if [[ -f "$DATA_DIR/streamo.db" ]]; then
  msg_info "Datenbank wird gesichert"

  BACKUP_FILE="${DATA_DIR}/streamo.db.backup-$(date +%Y%m%d-%H%M%S)"
  cp "$DATA_DIR/streamo.db" "$BACKUP_FILE"

  # Alte Sicherungen aufräumen: nach Namen sortiert sind die neuesten unten,
  # deshalb behalten wir die letzten KEEP_BACKUPS und löschen den Rest.
  # shellcheck disable=SC2012
  ls -1 "${DATA_DIR}"/streamo.db.backup-* 2>/dev/null \
    | head -n -"${KEEP_BACKUPS}" \
    | xargs -r rm -f

  msg_ok "Sicherung angelegt: $(basename "$BACKUP_FILE")"
fi

# ===========================================================================
# 3. Aktualisieren
# ===========================================================================
msg_info "Dienst wird angehalten"
systemctl stop "$SERVICE_NAME" 2>/dev/null || true
msg_ok "Dienst angehalten"

msg_info "Neue Version wird geholt"
# reset --hard verwirft lokale Änderungen an den Programmdateien. Datenbank
# und .env sind davon nicht betroffen, weil sie in .gitignore stehen.
git -C "$APP_DIR" reset --hard "origin/${BRANCH}" >/dev/null 2>&1
NEW_VERSION="$(node -p "require('${APP_DIR}/package.json').version" 2>/dev/null || echo '?')"
msg_ok "Quellen aktualisiert (Version ${NEW_VERSION})"

msg_info "Abhängigkeiten werden installiert"
cd "$APP_DIR"
npm install --omit=dev --no-audit --no-fund --loglevel=error >/dev/null 2>&1
msg_ok "Abhängigkeiten installiert"

# Rechte wieder geradeziehen: git und npm haben als root geschrieben.
chown -R "${SERVICE_USER}:${SERVICE_USER}" "$APP_DIR"
[[ -f "$APP_DIR/.env" ]] && chmod 600 "$APP_DIR/.env"

# ---------------------------------------------------------------------------
# Die Hilfsbefehle neu setzen.
#
# Das macht das Update selbstheilend: Eine Installation, die den kurzen
# Befehl "update" noch nicht kennt, bekommt ihn beim ersten Lauf des neuen
# Skripts automatisch dazu.
# ---------------------------------------------------------------------------
if [[ -f "$APP_DIR/scripts/install/install-commands.sh" ]]; then
  bash "$APP_DIR/scripts/install/install-commands.sh" >/dev/null 2>&1 || true
fi

# ===========================================================================
# 4. Starten und prüfen
# ===========================================================================
msg_info "Dienst wird gestartet"
systemctl start "$SERVICE_NAME"

# Den Port aus der Konfiguration lesen, falls er vom Standard abweicht.
PORT="$(grep -E '^PORT=' "$APP_DIR/.env" 2>/dev/null | cut -d= -f2 | tr -d ' \r' || true)"
PORT="${PORT:-3000}"

healthy=0
for _ in $(seq 1 "$HEALTH_TIMEOUT"); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 1
done

# ===========================================================================
# 5. Ergebnis – oder Rückabwicklung
# ===========================================================================
if [[ "$healthy" == "1" ]]; then
  msg_ok "Dienst läuft"

  echo ""
  echo -e " ${GN}Streamo ist aktuell.${CL}"

  # Versionssprung nur anzeigen, wenn sich die Nummer tatsächlich geändert
  # hat – bei einem "update --force" auf denselben Stand wäre "1.1.0 → 1.1.0"
  # nur verwirrend.
  if [[ "$CURRENT_VERSION" != "$NEW_VERSION" ]]; then
    echo -e "   Version:   ${CURRENT_VERSION} ${GN}→ ${NEW_VERSION}${CL}"
  else
    echo -e "   Version:   ${NEW_VERSION}"
  fi

  echo -e "   Adresse:   http://$(hostname -I | awk '{print $1}'):${PORT}"

  if [[ -n "$BACKUP_FILE" ]]; then
    echo -e "   ${DIM}Sicherung: ${BACKUP_FILE}${CL}"
  fi

  echo ""
  exit 0
fi

# --- Der Dienst antwortet nicht: zurück auf den alten Stand ----------------
msg_error "Der Dienst antwortet nach dem Update nicht."
echo ""
echo -e " ${DIM}Letzte Protokollzeilen:${CL}"
journalctl -u "$SERVICE_NAME" -n 20 --no-pager 2>/dev/null | sed 's/^/   /' || true
echo ""

msg_info "Es wird auf den vorherigen Stand zurückgesetzt"

systemctl stop "$SERVICE_NAME" 2>/dev/null || true

# Quellcode zurück auf den Commit von vorhin.
git -C "$APP_DIR" reset --hard "$CURRENT_COMMIT" >/dev/null 2>&1
cd "$APP_DIR"
npm install --omit=dev --no-audit --no-fund --loglevel=error >/dev/null 2>&1

# Die Datenbank NUR dann zurückspielen, wenn sie sich verändert hat – eine
# neue Version könnte eine Migration ausgeführt haben, die die alte Version
# nicht versteht.
if [[ -n "$BACKUP_FILE" && -f "$BACKUP_FILE" ]]; then
  cp "$BACKUP_FILE" "$DATA_DIR/streamo.db"
fi

chown -R "${SERVICE_USER}:${SERVICE_USER}" "$APP_DIR"
systemctl start "$SERVICE_NAME" 2>/dev/null || true

msg_ok "Vorheriger Stand wiederhergestellt (Version ${CURRENT_VERSION})"

echo ""
echo -e " ${YW}Das Update wurde rückgängig gemacht.${CL} Streamo läuft in der alten Version weiter."
echo -e " Bitte melde den Fehler mit den Protokollzeilen von oben:"
echo -e "   ${BL}https://github.com/MoinMornhart/Streamo/issues${CL}"
echo ""
exit 1
