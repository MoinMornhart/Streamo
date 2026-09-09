#!/usr/bin/env bash

# ---------------------------------------------------------------------------
# install-commands.sh – Die Konsolenbefehle im Container einrichten
# ---------------------------------------------------------------------------
# Legt drei Dinge an:
#
#   /usr/local/bin/update          Kurzbefehl: aktualisiert Streamo
#   /usr/local/bin/streamo-update  Derselbe Befehl unter sprechendem Namen
#   /usr/local/bin/streamo         Kleines Verwaltungswerkzeug
#                                  (status, logs, restart, update, info)
#
# Dazu eine Begrüßung beim Anmelden (MOTD), die diese Befehle nennt – sonst
# weiß nach ein paar Monaten niemand mehr, dass es sie gibt.
#
# Warum eine eigene Datei? Sie wird an ZWEI Stellen gebraucht:
#   - streamo-install.sh  bei der Erstinstallation
#   - streamo-update.sh   bei jedem Update
# Der zweite Aufruf macht die Sache selbstheilend: Eine ältere Installation,
# die den Befehl "update" noch nicht kennt, bekommt ihn beim nächsten Update
# automatisch dazu.
#
# Alle erzeugten Dateien sind bewusst dünne Hüllen. Die eigentliche Logik
# steht in /opt/streamo/scripts/streamo-update.sh und wird damit bei jedem
# Update mit aktualisiert.
# ---------------------------------------------------------------------------

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/streamo}"
SERVICE_NAME="streamo"

# ===========================================================================
# 1. Der Kurzbefehl "update"
# ===========================================================================
# Kein Symlink, sondern eine kleine Hülle: So kann sie prüfen, ob das
# eigentliche Skript überhaupt vorhanden ist, und sonst eine verständliche
# Meldung ausgeben statt "No such file or directory".
cat >/usr/local/bin/update <<EOF
#!/usr/bin/env bash
# Aktualisiert Streamo. Erzeugt von install-commands.sh – nicht von Hand
# ändern, die Datei wird bei jedem Update neu geschrieben.
# Die eigentliche Arbeit macht ${APP_DIR}/scripts/streamo-update.sh.
set -euo pipefail

UPDATE_SCRIPT="${APP_DIR}/scripts/streamo-update.sh"

if [[ ! -f "\$UPDATE_SCRIPT" ]]; then
  echo "Das Update-Skript fehlt: \$UPDATE_SCRIPT" >&2
  echo "Streamo neu installieren:" >&2
  echo '  bash -c "\$(curl -fsSL https://raw.githubusercontent.com/MoinMornhart/Streamo/main/scripts/install/streamo-install.sh)"' >&2
  exit 1
fi

# "\$@" reicht alle Optionen durch: update --check, update --force, update -y
exec bash "\$UPDATE_SCRIPT" "\$@"
EOF

chmod +x /usr/local/bin/update

# ===========================================================================
# 2. Derselbe Befehl unter dem sprechenden Namen
# ===========================================================================
# "update" ist kurz, aber sehr allgemein. Wer in einem Jahr in der History
# sucht, findet unter "streamo-update" eher, was gemeint war.
cp /usr/local/bin/update /usr/local/bin/streamo-update
chmod +x /usr/local/bin/streamo-update

# ===========================================================================
# 3. Das Verwaltungswerkzeug "streamo"
# ===========================================================================
# Fasst die Befehle zusammen, die man sonst mit systemctl und journalctl
# tippen müsste.
cat >/usr/local/bin/streamo <<EOF
#!/usr/bin/env bash
# Verwaltung von Streamo. Erzeugt von install-commands.sh.
set -euo pipefail

APP_DIR="${APP_DIR}"
SERVICE="${SERVICE_NAME}"

GN=\$'\033[1;92m'
YW=\$'\033[33m'
BL=\$'\033[36m'
CL=\$'\033[m'

# Port aus der Konfiguration lesen, falls er vom Standard abweicht.
port() {
  local p
  p="\$(grep -E '^PORT=' "\$APP_DIR/.env" 2>/dev/null | cut -d= -f2 | tr -d ' \r' || true)"
  echo "\${p:-3000}"
}

case "\${1:-help}" in
  status)
    systemctl status "\$SERVICE" --no-pager
    ;;

  logs)
    # -f folgt dem Protokoll live; mit Strg+C beenden.
    journalctl -u "\$SERVICE" -f
    ;;

  restart)
    systemctl restart "\$SERVICE"
    echo -e " \${GN}Streamo neu gestartet.\${CL}"
    ;;

  stop)
    systemctl stop "\$SERVICE"
    echo -e " \${YW}Streamo angehalten.\${CL}"
    ;;

  start)
    systemctl start "\$SERVICE"
    echo -e " \${GN}Streamo gestartet.\${CL}"
    ;;

  update)
    shift
    exec /usr/local/bin/update "\$@"
    ;;

  config)
    # Öffnet die Konfiguration und startet danach neu, falls sie sich
    # geändert hat – sonst vergisst man den Neustart und wundert sich.
    before="\$(md5sum "\$APP_DIR/.env" 2>/dev/null || true)"
    \${EDITOR:-nano} "\$APP_DIR/.env"
    after="\$(md5sum "\$APP_DIR/.env" 2>/dev/null || true)"
    if [[ "\$before" != "\$after" ]]; then
      systemctl restart "\$SERVICE"
      echo -e " \${GN}Konfiguration gespeichert, Streamo neu gestartet.\${CL}"
    fi
    ;;

  domain)
    # Trägt die öffentliche Domain ein – der Weg, um Passkeys hinter einem
    # Reverse Proxy zum Laufen zu bringen.
    #
    # Warum drei Werte statt einem? TRUST_PROXY sorgt dafür, dass Streamo den
    # Weiterleitungs-Kopfzeilen des Proxys glaubt. Viele Proxys reichen den
    # Host-Header aber gar nicht durch, sondern schicken ihre eigene Adresse.
    # Deshalb werden WEBAUTHN_RP_ID und WEBAUTHN_ORIGIN zusätzlich fest
    # eingetragen: Damit steht die Domain unabhängig davon fest, was der Proxy
    # meldet.
    domain="\${2:-}"

    if [[ -z "\$domain" ]]; then
      echo ""
      echo "  Aufruf: streamo domain <deine-domain>"
      echo ""
      echo "  Beispiel:"
      echo -e "    \${GN}streamo domain streamo.example.de\${CL}"
      echo ""
      echo "  Trägt die Domain ein, unter der Streamo von außen erreichbar ist."
      echo "  Nötig, damit Passkeys hinter einem Reverse Proxy funktionieren."
      echo ""
      exit 1
    fi

    # Ein versehentlich mitkopiertes "https://" oder ein Schrägstrich am Ende
    # würde die Domain unbrauchbar machen – beides wird still entfernt.
    domain="\${domain#http://}"
    domain="\${domain#https://}"
    domain="\${domain%%/*}"

    # Bestehende Einträge entfernen, damit nichts doppelt in der Datei steht.
    sed -i '/^TRUST_PROXY=/d;/^WEBAUTHN_RP_ID=/d;/^WEBAUTHN_ORIGIN=/d' "\$APP_DIR/.env"

    {
      echo ""
      echo "# Von 'streamo domain' gesetzt am \$(date -Iseconds)"
      echo "TRUST_PROXY=true"
      echo "WEBAUTHN_RP_ID=\$domain"
      echo "WEBAUTHN_ORIGIN=https://\$domain"
    } >>"\$APP_DIR/.env"

    systemctl restart "\$SERVICE"

    echo ""
    echo -e " \${GN}Domain eingetragen:\${CL} \$domain"
    echo -e "   TRUST_PROXY=true"
    echo -e "   WEBAUTHN_RP_ID=\$domain"
    echo -e "   WEBAUTHN_ORIGIN=https://\$domain"
    echo ""
    echo -e " Passkeys sollten jetzt unter \${BL}https://\$domain\${CL} funktionieren."
    echo -e " Prüfen kannst du das unter Einstellungen -> Passkeys."
    echo ""
    ;;

  backup)
    # Sichert Datenbank und Konfiguration in ein Archiv.
    target="/root/streamo-backup-\$(date +%Y%m%d-%H%M%S).tar.gz"
    tar czf "\$target" -C "\$APP_DIR" data .env 2>/dev/null
    echo -e " \${GN}Sicherung angelegt:\${CL} \$target"
    ;;

  info)
    version="\$(node -p "require('\$APP_DIR/package.json').version" 2>/dev/null || echo '?')"
    ip="\$(hostname -I | awk '{print \$1}')"
    echo ""
    echo -e "  \${BL}Streamo\${CL} \$version"
    echo -e "  Adresse     http://\$ip:\$(port)"
    echo -e "  Verzeichnis \$APP_DIR"
    echo -e "  Daten       \$APP_DIR/data"
    echo -e "  Zustand     \$(systemctl is-active "\$SERVICE")"
    echo -e "  Node.js     \$(node -v)"
    echo ""
    ;;

  *)
    echo ""
    echo -e "  \${BL}Streamo\${CL} – Verwaltung"
    echo ""
    echo -e "  \${GN}update\${CL}            Auf die neueste Version bringen"
    echo -e "  \${GN}update --check\${CL}    Nur nachsehen, ob es etwas Neues gibt"
    echo ""
    echo -e "  \${GN}streamo status\${CL}    Läuft der Dienst?"
    echo -e "  \${GN}streamo logs\${CL}      Protokoll live mitlesen"
    echo -e "  \${GN}streamo restart\${CL}   Neu starten"
    echo -e "  \${GN}streamo config\${CL}    Konfiguration bearbeiten"
    echo -e "  \${GN}streamo domain\${CL} <d> Domain eintragen (nötig für Passkeys)"
    echo -e "  \${GN}streamo backup\${CL}    Datenbank sichern"
    echo -e "  \${GN}streamo info\${CL}      Version und Adresse anzeigen"
    echo ""
    ;;
esac
EOF

chmod +x /usr/local/bin/streamo

# ===========================================================================
# 4. Begrüßung beim Anmelden
# ===========================================================================
# Alles in /etc/update-motd.d/ wird bei einer interaktiven Anmeldung
# ausgeführt und die Ausgabe angezeigt. Die Nummer im Dateinamen bestimmt die
# Reihenfolge.
mkdir -p /etc/update-motd.d

cat >/etc/update-motd.d/99-streamo <<EOF
#!/usr/bin/env bash
# Begrüßung im Streamo-Container. Erzeugt von install-commands.sh.

APP_DIR="${APP_DIR}"

version="\$(node -p "require('\$APP_DIR/package.json').version" 2>/dev/null || echo '')"
ip="\$(hostname -I 2>/dev/null | awk '{print \$1}')"
port="\$(grep -E '^PORT=' "\$APP_DIR/.env" 2>/dev/null | cut -d= -f2 | tr -d ' \r')"
port="\${port:-3000}"
state="\$(systemctl is-active streamo 2>/dev/null || echo unbekannt)"

# Grün, wenn der Dienst läuft, sonst rot – damit ein Problem sofort auffällt.
if [[ "\$state" == "active" ]]; then
  state_colored="\$(printf '\033[1;92m%s\033[m' "läuft")"
else
  state_colored="\$(printf '\033[01;31m%s\033[m' "\$state")"
fi

printf '\n'
printf '  \033[36mStreamo\033[m %s – Dienst: %s\n' "\$version" "\$state_colored"
printf '  Weboberfläche: \033[36mhttp://%s:%s\033[m\n' "\$ip" "\$port"
printf '\n'
printf '  \033[1;92mupdate\033[m aktualisiert Streamo · \033[1;92mstreamo\033[m zeigt alle Befehle\n'
printf '\n'
EOF

chmod +x /etc/update-motd.d/99-streamo

# Debian zeigt zusätzlich die statische /etc/motd an. Leeren, damit die
# Begrüßung nicht doppelt und mit veralteten Angaben erscheint.
: >/etc/motd 2>/dev/null || true

echo "Konsolenbefehle eingerichtet: update, streamo-update, streamo"
