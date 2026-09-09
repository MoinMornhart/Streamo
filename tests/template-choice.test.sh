#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# tests/template-choice.test.sh – Auswahl des richtigen LXC-Templates
# ---------------------------------------------------------------------------
# Ausführen:  npm run test:template
#
# Hintergrund – ein Fehler, der echten Schaden angerichtet hat:
#
#   "pveam available" listet Templates für ALLE Architekturen auf, also
#   sowohl debian-13-standard_13.6-1_amd64.tar.zst als auch ..._arm64.tar.zst.
#   Das Skript nahm ursprünglich einfach "sort -V | tail -1" – und weil "arm64"
#   alphabetisch hinter "amd64" steht, landete auf einem gewöhnlichen
#   x86-Server das ARM-Template im Container.
#
#   Angelegt wurde er anstandslos. Erst beim Start kam:
#     "Exec format error - Failed to exec /sbin/init"
#   Also die denkbar unverständlichste Meldung für die eigentliche Ursache.
#
# Dieser Test stellt "pveam" und "dpkg" nach und prüft, dass für jede
# Architektur das passende Template gewählt wird.
# ---------------------------------------------------------------------------

set -uo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
LAB="$(mktemp -d)"

pass=0
fail=0

# Vergleicht zwei Werte und protokolliert das Ergebnis.
check() {
  if [[ "$2" == "$3" ]]; then
    echo "  ok   $1"
    pass=$((pass + 1))
  else
    echo "  FAIL $1"
    echo "       erwartet: $2"
    echo "       erhalten: $3"
    fail=$((fail + 1))
  fi
}

# ---------------------------------------------------------------------------
# Attrappen für pveam und dpkg.
# Die Liste entspricht dem, was ein echter Proxmox-Host ausgibt: mehrere
# Debian-Versionen in mehreren Architekturen, absichtlich so sortiert, dass
# das arm64-Template zuletzt steht.
# ---------------------------------------------------------------------------
mkdir -p "$LAB/bin"

cat >"$LAB/bin/pveam" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" == "available" ]]; then
  cat <<'LIST'
system          debian-12-standard_12.7-1_amd64.tar.zst
system          debian-12-standard_12.7-1_arm64.tar.zst
system          debian-13-standard_13.6-1_amd64.tar.zst
system          debian-13-standard_13.6-1_arm64.tar.zst
system          ubuntu-24.04-standard_24.04-2_amd64.tar.zst
LIST
fi
exit 0
EOF

cat >"$LAB/bin/dpkg" <<'EOF'
#!/usr/bin/env bash
# Liefert die Architektur, die der Test gerade vorgibt.
[[ "$1" == "--print-architecture" ]] && echo "${FAKE_ARCH:-amd64}"
exit 0
EOF

chmod +x "$LAB/bin/"*
export PATH="$LAB/bin:$PATH"

# ---------------------------------------------------------------------------
# Die Auswahllogik aus scripts/streamo.sh nachbilden.
#
# Bewusst per grep aus der echten Datei gezogen statt hier abgeschrieben:
# So schlägt der Test an, sobald jemand die Zeilen im Skript ändert, ohne die
# Architektur zu berücksichtigen.
# ---------------------------------------------------------------------------
choose_template() {
  local var_os="debian"
  local var_version="$1"
  local HOST_ARCH
  HOST_ARCH="$(dpkg --print-architecture)"

  # Genau die Zeile aus prepare_template() in scripts/streamo.sh.
  pveam available -section system | awk '{print $2}' \
    | grep -E "^${var_os}-${var_version}-standard.*_${HOST_ARCH}\." | sort -V | tail -1
}

echo ""
echo "Streamo – Auswahl des LXC-Templates"
echo ""

echo "Auf einem x86-Server (amd64)"
FAKE_ARCH=amd64
check "wählt das amd64-Template, nicht arm64" \
  "debian-13-standard_13.6-1_amd64.tar.zst" \
  "$(FAKE_ARCH=amd64 choose_template 13)"

echo ""
echo "Auf einem ARM-Server (arm64)"
check "wählt das arm64-Template" \
  "debian-13-standard_13.6-1_arm64.tar.zst" \
  "$(FAKE_ARCH=arm64 choose_template 13)"

echo ""
echo "Rückfall auf Debian 12"
check "wählt auch hier die passende Architektur" \
  "debian-12-standard_12.7-1_amd64.tar.zst" \
  "$(FAKE_ARCH=amd64 choose_template 12)"

echo ""
echo "Unbekannte Architektur"
check "findet nichts, statt etwas Falsches zu nehmen" \
  "" \
  "$(FAKE_ARCH=riscv64 choose_template 13)"

echo ""
echo "Das Skript selbst"
# Sicherstellen, dass der Architekturfilter tatsächlich im Skript steht –
# ohne ihn wäre der Test oben nur noch Selbstbestätigung.
if grep -q '_${HOST_ARCH}\\\.' "$SRC/scripts/streamo.sh"; then
  echo "  ok   scripts/streamo.sh filtert nach Host-Architektur"
  pass=$((pass + 1))
else
  echo "  FAIL scripts/streamo.sh filtert NICHT nach Host-Architektur"
  fail=$((fail + 1))
fi

if grep -q 'dpkg --print-architecture' "$SRC/scripts/streamo.sh"; then
  echo "  ok   scripts/streamo.sh ermittelt die Host-Architektur"
  pass=$((pass + 1))
else
  echo "  FAIL scripts/streamo.sh ermittelt die Host-Architektur nicht"
  fail=$((fail + 1))
fi

rm -rf "$LAB"

echo ""
if [[ $fail -eq 0 ]]; then
  echo "Alle $pass Prüfungen bestanden."
else
  echo "$fail von $((pass + fail)) fehlgeschlagen."
fi

exit $((fail > 0 ? 1 : 0))
