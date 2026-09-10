#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# tests/install-arch.test.sh – Architektur und Node-Reihe
# ---------------------------------------------------------------------------
# Ausführen:  npm run test:arch
#
# Geprüft wird die Entscheidung, die ganz am Anfang der Installation fällt:
# Welche Node-Reihe wird installiert, und wann bricht das Skript lieber ab?
#
# Warum das einen eigenen Test verdient:
#
#   Auf einem 32-Bit-Raspberry-Pi gibt es kein Node 24. Die Paketliste von
#   NodeSource enthält dort für node_24.x überhaupt kein nodejs-Paket, und
#   nodejs.org liefert für Node 24 kein armv7l-Archiv mehr. Ohne
#   Fallunterscheidung bricht die Installation mit "Unable to locate package
#   nodejs" ab – und zwar erst NACH dem Eintragen der Paketquelle, was die
#   Ursache schwer erkennbar macht.
#
#   Node 22 gibt es dagegen weiterhin für armhf, und 22.13 genügt: Ab dieser
#   Version ist node:sqlite ohne --experimental-sqlite nutzbar.
#
# Der Test führt das Installationsskript NICHT aus – es würde Pakete
# installieren und einen Dienst einrichten. Stattdessen wird der
# Entscheidungsteil herausgelöst und mit vorgetäuschten Architekturen
# durchgespielt.
# ---------------------------------------------------------------------------

set -uo pipefail

SCRIPT="$(dirname "${BASH_SOURCE[0]}")/../scripts/install/streamo-install.sh"

failures=0
checks=0

# ---------------------------------------------------------------------------
# Vergleicht zwei Werte.
# $1 Beschreibung, $2 erhalten, $3 erwartet
# ---------------------------------------------------------------------------
check() {
  checks=$((checks + 1))

  if [[ "$2" == "$3" ]]; then
    echo "  ok   $1"
  else
    failures=$((failures + 1))
    echo "  FAIL $1"
    echo "       erwartet: $3"
    echo "       erhalten: $2"
  fi
}

echo ""
echo "Streamo – Architektur und Node-Reihe"
echo ""

# ---------------------------------------------------------------------------
# Den Entscheidungsteil herauslösen
# ---------------------------------------------------------------------------
# Von der Zeile mit HOST_ARCH bis zum Ende des case-Blocks. dpkg wird dabei
# durch eine Attrappe ersetzt, die die gewünschte Architektur meldet.
extract_case() {
  sed -n '/^HOST_ARCH=/,/^esac$/p' "$SCRIPT"
}

# ---------------------------------------------------------------------------
# Spielt die Entscheidung für eine Architektur durch.
# $1 Architektur -> gibt NODE_MAJOR aus, oder "ABBRUCH"
# ---------------------------------------------------------------------------
VORGETAEUSCHTE_ARCH=""

entscheide() {
  VORGETAEUSCHTE_ARCH="$1"
  local ausgabe

  ausgabe="$(
    # Die Attrappe ersetzt dpkg. Ohne "export -f" - siehe die Begruendung
    # weiter unten bei der Versionspruefung.
    dpkg() { echo "${VORGETAEUSCHTE_ARCH}"; }

    # shellcheck disable=SC1090
    eval "$(extract_case)" 2>/dev/null && echo "NODE_MAJOR=$NODE_MAJOR"
  )" || true

  if [[ "$ausgabe" == *"NODE_MAJOR="* ]]; then
    echo "${ausgabe##*NODE_MAJOR=}"
  else
    echo "ABBRUCH"
  fi
}

echo "Welche Node-Reihe je Architektur?"

check "amd64 bekommt Node 24" "$(entscheide amd64)" "24"
check "arm64 (Raspberry Pi, 64 Bit) bekommt Node 24" "$(entscheide arm64)" "24"
check "armhf (Raspberry Pi, 32 Bit) bekommt Node 22" "$(entscheide armhf)" "22"

echo ""
echo "Was nicht unterstützt wird"

check "armel bricht ab, statt es zu versuchen" "$(entscheide armel)" "ABBRUCH"
check "i386 ebenso" "$(entscheide i386)" "ABBRUCH"
check "riscv64 ebenso" "$(entscheide riscv64)" "ABBRUCH"

echo ""
echo "Die Abbruchmeldung"

meldung="$(
  VORGETAEUSCHTE_ARCH="armel"
  dpkg() { echo "${VORGETAEUSCHTE_ARCH}"; }
  eval "$(extract_case)" 2>&1 || true
)"

check "nennt die erkannte Architektur" \
  "$(echo "$meldung" | grep -c 'armel')" "1"

check "verweist auf die 64-Bit-Fassung von Raspberry Pi OS" \
  "$(echo "$meldung" | grep -ci '64-Bit')" "1"

# ---------------------------------------------------------------------------
# Die Mindestversion
# ---------------------------------------------------------------------------
echo ""
echo "Wann gilt ein vorhandenes Node als tauglich?"

# node_taugt() aus dem Skript herauslösen und mit vorgetäuschten Versionen
# aufrufen.
extract_taugt() {
  sed -n '/^node_taugt() {/,/^}$/p' "$SCRIPT"
}

# Die vorgetäuschte Version steht in einer gewöhnlichen Variablen, nicht in
# einer lokalen: Eine mit "export -f" exportierte Funktion wird in einer
# frischen Shell neu geparst, und dort ist eine lokale Variable nicht bekannt –
# unter "set -u" endet das in "unbound variable".
VORGETAEUSCHTE_VERSION=""

taugt() {
  VORGETAEUSCHTE_VERSION="$1"

  (
    node() { echo "v${VORGETAEUSCHTE_VERSION}"; }
    command() { [[ "${2:-}" == "node" ]] && return 0; return 1; }

    eval "$(extract_taugt)"
    node_taugt && echo "ja" || echo "nein"
  )
}

check "Node 24.8 taugt" "$(taugt 24.8.0)" "ja"
check "Node 23.4 taugt" "$(taugt 23.4.0)" "ja"
check "Node 22.19 taugt – das ist der 32-Bit-Fall" "$(taugt 22.19.0)" "ja"
check "Node 22.13 ist die Untergrenze" "$(taugt 22.13.0)" "ja"
check "Node 22.12 taugt nicht – dort braucht node:sqlite noch ein Flag" "$(taugt 22.12.0)" "nein"
check "Node 22.5 taugt nicht" "$(taugt 22.5.0)" "nein"
check "Node 20 taugt nicht" "$(taugt 20.19.0)" "nein"

echo ""

if [[ "$failures" -eq 0 ]]; then
  echo "Alle $checks Prüfungen bestanden."
  exit 0
else
  echo "$failures von $checks fehlgeschlagen."
  exit 1
fi
