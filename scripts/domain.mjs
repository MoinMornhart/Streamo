/**
 * ---------------------------------------------------------------------------
 * scripts/domain.mjs – Die Domain auf der Konsole eintragen
 * ---------------------------------------------------------------------------
 * Aufruf im Container:
 *
 *   streamo domain                      Zeigt, was gerade gilt
 *   streamo domain streamo.example.de   Domain eintragen
 *   streamo domain aus                  Keine Domain mehr fest eintragen
 *
 * Dasselbe wie das Feld unter Einstellungen -> Adresse & Domain, und es
 * schreibt auch an dieselbe Stelle (Tabelle settings). Früher landete die
 * Domain stattdessen in der .env. Das hätte sich mit der Oberfläche gebissen:
 * Der Wert aus den Einstellungen sticht die .env, ein späteres
 * "streamo domain" wäre also wirkungslos geblieben, sobald dort einmal etwas
 * gespeichert war.
 *
 * Wozu dann überhaupt noch der Befehl? Für den Fall, dass man gar nicht erst
 * an die Oberfläche kommt – etwa weil die alte Domain nicht mehr erreichbar
 * ist und die neue noch auf eine falsche Adresse zeigt.
 *
 * Wie früher schaltet das Eintragen auch "hinter einem Reverse Proxy" ein:
 * Der Befehl war immer der Weg, Passkeys hinter einem Proxy zum Laufen zu
 * bringen. Wer keinen Proxy hat, legt den Schalter in der Oberfläche um.
 *
 * Verknüpfungen:
 *   - src/address.js -> parseDomain, saveAddress, die Rangfolge der Quellen
 *   - scripts/install/install-commands.sh -> das Kommando, startet danach neu
 * ---------------------------------------------------------------------------
 */

import { configuredAddress, parseDomain, saveAddress, trustsProxy, AddressError } from '../src/address.js';
import { getSetting } from '../src/db.js';

const GN = '\x1b[32m';
const YW = '\x1b[33m';
const RD = '\x1b[31m';
const BL = '\x1b[36m';
const CL = '\x1b[0m';

/** Schreibt lesbar auf die Konsole, was gerade gilt und woher. */
function report() {
  const fixed = configuredAddress();
  const proxyFromDb = getSetting('trust_proxy', null) !== null;

  console.log('');
  console.log(`  ${BL}Adresse & Domain${CL}`);
  console.log('');

  if (fixed) {
    console.log(`   Domain:        ${GN}${fixed.origin}${CL}`);
    console.log(`   Festgelegt in: ${fixed.source === '.env' ? '.env (WEBAUTHN_ORIGIN)' : 'Einstellungen'}`);
  } else {
    console.log(`   Domain:        ${YW}keine${CL} – Streamo nimmt die Adresse, unter der es aufgerufen wird`);
  }

  console.log(`   Reverse Proxy: ${trustsProxy() ? 'ja' : 'nein'} (${proxyFromDb ? 'Einstellungen' : '.env'})`);
  console.log('');
}

const argument = (process.argv[2] || '').trim();

// Ohne Argument nur berichten.
if (!argument) {
  report();
  console.log(`  Eintragen: ${GN}streamo domain streamo.example.de${CL}`);
  console.log(`  Entfernen: ${GN}streamo domain aus${CL}`);
  console.log('');
  process.exit(0);
}

// Deutsch und Englisch, weil beides naheliegt.
const CLEAR_WORDS = ['aus', 'keine', 'off', 'none', 'auto', '-'];

try {
  if (CLEAR_WORDS.includes(argument.toLowerCase())) {
    // Nur die Domain entfernen. Der Proxy-Schalter bleibt, wie er ist – ob
    // ein Proxy davorsteht, hängt nicht davon ab, ob eine Domain eingetragen ist.
    saveAddress({ domain: '' });
  } else {
    // Erst prüfen, damit eine Fehlermeldung kommt, bevor irgendetwas gespeichert ist.
    parseDomain(argument);
    saveAddress({ domain: argument, trustProxy: true });
  }
} catch (error) {
  console.log('');
  console.log(`  ${RD}${error instanceof AddressError ? error.message : `Fehler: ${error.message}`}${CL}`);
  console.log('');
  process.exit(1);
}

report();

const fixed = configuredAddress();
if (fixed?.protocol === 'https') {
  console.log(`  Passkeys sollten jetzt unter ${BL}${fixed.origin}${CL} funktionieren.`);
  console.log('  Prüfen kannst du das unter Einstellungen -> Passkeys.');
  console.log('');
}
