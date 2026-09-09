#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# tests/update.test.sh – Test des Update-Vorgangs
# ---------------------------------------------------------------------------
# Ausführen:  npm run test:update      (oder: bash tests/update.test.sh)
#
# Getestet wird scripts/streamo-update.sh – also genau das, was hinter dem
# Befehl "update" im Container steckt. Damit das ohne echten Server geht,
# baut der Test eine vollständige Attrappe auf:
#
#   - ein lokales Git-Repository mit zwei Ständen (Version 1.0.0 und 1.1.0)
#   - eine "Installation" davon, die auf dem alten Stand steht,
#     mitsamt Datenbank und .env
#   - Platzhalter für systemctl, journalctl, npm, chown und curl, die nichts
#     tun, aber protokollieren, dass sie aufgerufen wurden
#
# Über die Variable HEALTH_OK wird gesteuert, ob der simulierte Dienst nach
# dem Update antwortet. So lässt sich der wichtigste Zweig überhaupt prüfen:
# der automatische Rollback, wenn ein Update den Dienst lahmlegt.
#
# Geprüft wird unter anderem, dass Datenbank und .env in JEDEM Fall
# unangetastet bleiben – ein Update, das Daten verliert, wäre der schlimmste
# denkbare Fehler dieses Skripts.
# ---------------------------------------------------------------------------

# Kein "set -e": Der Test soll alle Prüfungen durchlaufen und am Ende zählen,
# statt beim ersten Fehlschlag abzubrechen.
set -uo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
LAB="$(mktemp -d)/updatelab"

pass=0; fail=0
check() { # label expected_substring actual
  if grep -qF -- "$2" <<<"$3"; then echo "  ok   $1"; pass=$((pass+1));
  else echo "  FAIL $1"; echo "       erwartet enthalten: $2"; fail=$((fail+1)); fi
}

rm -rf "$LAB"; mkdir -p "$LAB/stubs"

# ---------------------------------------------------------------------------
# Stubs für Systembefehle, die es hier nicht gibt bzw. nichts tun sollen.
# HEALTH_OK steuert, ob der simulierte Dienst antwortet.
# ---------------------------------------------------------------------------
cat >"$LAB/stubs/systemctl" <<'EOF'
#!/usr/bin/env bash
echo "[stub systemctl] $*" >>"$STUB_LOG"
exit 0
EOF
cat >"$LAB/stubs/journalctl" <<'EOF'
#!/usr/bin/env bash
echo "simulierte Protokollzeile: Error: kaputt"
exit 0
EOF
cat >"$LAB/stubs/npm" <<'EOF'
#!/usr/bin/env bash
echo "[stub npm] $*" >>"$STUB_LOG"
exit 0
EOF
cat >"$LAB/stubs/chown" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat >"$LAB/stubs/curl" <<'EOF'
#!/usr/bin/env bash
# Simuliert den Health-Check. HEALTH_OK=1 -> Dienst antwortet.
if [[ "${HEALTH_OK:-1}" == "1" ]]; then echo '{"status":"ok"}'; exit 0; fi
exit 7
EOF
cat >"$LAB/stubs/hostname" <<'EOF'
#!/usr/bin/env bash
echo "192.168.1.50"
EOF

# Nur unter Git Bash / MSYS auf Windows: Dort ist "node" die Windows-Binärdatei
# und versteht die POSIX-Pfade (/c/Users/…) nicht, mit denen dieser Test
# arbeitet. Der Wrapper schreibt sie in Windows-Schreibweise um, damit auch
# die Versionsanzeige geprüft wird statt nur ihr Rückfall auf "?".
# Auf Linux – also im Container und in der CI – wird er nicht angelegt.
case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*)
    REAL_NODE="$(command -v node)"
    cat >"$LAB/stubs/node" <<EOF
#!/usr/bin/env bash
args=()
for a in "\$@"; do
  args+=("\$(sed -E 's|/([a-zA-Z])/|\\U\\1:/|g' <<<"\$a")")
done
exec "$REAL_NODE" "\${args[@]}"
EOF
    ;;
esac

chmod +x "$LAB/stubs/"*

export PATH="$LAB/stubs:$PATH"
export STUB_LOG="$LAB/stub.log"
: >"$STUB_LOG"

# ---------------------------------------------------------------------------
# Ein "Remote"-Repo mit zwei Ständen aufbauen.
# ---------------------------------------------------------------------------
REMOTE="$LAB/remote"
mkdir -p "$REMOTE/scripts"
cd "$REMOTE"
git init -q -b main
git config user.email t@t.de; git config user.name Test
# Fuer den Test wird NUR der root-Check deaktiviert - Git Bash laeuft nicht
# als root. Der Check selbst wird in Test 0 am Originalskript geprueft.
sed 's|if \[\[ "$EUID" -ne 0 \]\]; then|if false; then|' \
  "$SRC/scripts/streamo-update.sh" > scripts/streamo-update.sh
mkdir -p scripts/install
cp "$SRC/scripts/install/install-commands.sh" scripts/install/
echo '{"name":"streamo","version":"1.0.0"}' > package.json
printf 'node_modules/\ndata/\n.env\n' > .gitignore
git add -A && git commit -qm "v1.0.0"
V1="$(git rev-parse HEAD)"

echo '{"name":"streamo","version":"1.1.0"}' > package.json
echo "// neu" > neue-datei.js
git add -A && git commit -qm "v1.1.0: neue Funktion"
V2="$(git rev-parse HEAD)"

# ---------------------------------------------------------------------------
# Die "Installation": Clone auf dem alten Stand, mit Datenbank und .env.
# ---------------------------------------------------------------------------
setup_install() {
  rm -rf "$LAB/app"
  git clone -q "$REMOTE" "$LAB/app"
  git -C "$LAB/app" reset -q --hard "$V1"
  mkdir -p "$LAB/app/data"
  echo "ORIGINAL-DATENBANK" > "$LAB/app/data/streamo.db"
  printf 'PORT=3000\nTMDB_API_KEY=geheim\n' > "$LAB/app/.env"
}

run_update() {
  APP_DIR="$LAB/app" DATA_DIR="$LAB/app/data" SERVICE_USER="$(id -un)" \
    bash "$LAB/app/scripts/streamo-update.sh" "$@" 2>&1
}

echo ""
echo "Test 0: Ohne root-Rechte wird abgebrochen (Originalskript)"
out="$(bash "$SRC/scripts/streamo-update.sh" --check 2>&1)"
check "verlangt root" "Bitte als root" "$out"
check "nennt den Weg vom Proxmox-Host" "pct exec" "$out"

echo ""
echo "Test 1: --check meldet die neue Version, ohne etwas zu ändern"
setup_install
out="$(run_update --check)"
check "erkennt neue Version" "Eine neue Version ist verfügbar" "$out"
check "zeigt die Änderungen an" "v1.1.0: neue Funktion" "$out"
check "sagt, dass nichts verändert wurde" "Nur geprüft" "$out"
check "Installation steht noch auf v1.0.0" "$V1" "$(git -C "$LAB/app" rev-parse HEAD)"

echo ""
echo "Test 2: Update wird eingespielt"
setup_install
out="$(HEALTH_OK=1 run_update --yes)"
check "Sicherung wurde angelegt" "Sicherung angelegt" "$out"
check "Quellen aktualisiert" "Quellen aktualisiert (Version 1.1.0)" "$out"
check "Dienst läuft" "Dienst läuft" "$out"
check "meldet Erfolg" "Streamo ist aktuell" "$out"
check "zeigt alte Version" "Version:   1.0.0" "$out"
check "zeigt neue Version" "1.1.0" "$out"
check "Repo steht auf der neuen Version" "$V2" "$(git -C "$LAB/app" rev-parse HEAD)"
check "Datenbank unverändert" "ORIGINAL-DATENBANK" "$(cat "$LAB/app/data/streamo.db")"
check ".env unangetastet" "TMDB_API_KEY=geheim" "$(cat "$LAB/app/.env")"
check "Sicherungsdatei existiert" "streamo.db.backup" "$(ls "$LAB/app/data")"
check "Dienst wurde gestoppt und gestartet" "stop streamo" "$(cat "$STUB_LOG")"

echo ""
echo "Test 3: Zweiter Lauf meldet 'schon aktuell'"
out="$(run_update --yes)"
check "erkennt aktuellen Stand" "bereits auf dem neuesten Stand" "$out"
check "nennt die Version" "Version 1.1.0" "$out"

echo ""
echo "Test 4: Rollback, wenn der Dienst nach dem Update nicht antwortet"
setup_install
out="$(HEALTH_OK=0 HEALTH_TIMEOUT=2 run_update --yes)"
check "meldet den Fehlstart" "antwortet nach dem Update nicht" "$out"
check "zeigt das Protokoll" "simulierte Protokollzeile" "$out"
check "setzt zurück" "Vorheriger Stand wiederhergestellt" "$out"
check "nennt die alte Version" "Version 1.0.0" "$out"
check "Repo ist zurück auf v1.0.0" "$V1" "$(git -C "$LAB/app" rev-parse HEAD)"
check "Datenbank wiederhergestellt" "ORIGINAL-DATENBANK" "$(cat "$LAB/app/data/streamo.db")"
check "verweist auf die Fehlermeldung" "issues" "$out"

echo ""
echo "Test 5: Keine Git-Installation -> verständliche Meldung"
rm -rf "$LAB/plain"; mkdir -p "$LAB/plain"
out="$(APP_DIR="$LAB/plain" bash "$LAB/app/scripts/streamo-update.sh" --check 2>&1)"
check "erkennt fehlendes Git-Repo" "keine Git-Installation" "$out"

echo ""
echo "Test 6: Ein vorbelegtes STREAMO_UPDATE_REEXEC zerstört nichts"
# Regression: Das Skript kopiert sich vor dem Lauf nach /tmp und räumt die
# Kopie danach weg. Stand STREAMO_UPDATE_REEXEC=1 schon in der Umgebung, lief
# es ohne Kopie – und der Aufräum-Trap löschte das Originalskript im
# Repository. Danach war "update" unbrauchbar.
setup_install
size_before="$(wc -c <"$LAB/app/scripts/streamo-update.sh")"
STREAMO_UPDATE_REEXEC=1 run_update --check >/dev/null 2>&1
size_after="$(wc -c <"$LAB/app/scripts/streamo-update.sh")"
check "Originalskript ist unversehrt" "$size_before" "$size_after"
check "Originalskript ist nicht leer" "1" "$([[ "$size_after" -gt 100 ]] && echo 1 || echo 0)"

echo ""
echo "Test 7: Es bleiben keine Kopien in /tmp liegen"
before="$(ls /tmp/streamo-update-* 2>/dev/null | wc -l)"
setup_install
run_update --check >/dev/null
after="$(ls /tmp/streamo-update-* 2>/dev/null | wc -l)"
check "keine Restdateien" "$before" "$after"

echo ""
if [[ $fail -eq 0 ]]; then echo "Alle $pass Prüfungen bestanden."; else echo "$fail von $((pass+fail)) fehlgeschlagen."; fi
exit $((fail > 0 ? 1 : 0))
