/**
 * ---------------------------------------------------------------------------
 * scripts/registration.mjs – Offene Registrierung ein- und ausschalten
 * ---------------------------------------------------------------------------
 * Aufruf im Container:
 *
 *   streamo registration            Zeigt den aktuellen Zustand
 *   streamo registration offen      Jeder kann sich ein Konto anlegen
 *   streamo registration zu         Nur noch mit Einladung
 *
 * Warum es das gibt, obwohl es dafür einen Schalter in der Oberfläche gibt:
 *   Der Schalter steht in der Karte "Freunde einladen", und die sehen nur
 *   Administratoren. Wer selbst kein Administrator ist, kommt also gar nicht
 *   an ihn heran – und wird auch keiner, ohne vorher auf den Server zu gehen.
 *   Ein Henne-Ei-Problem, das dieser Befehl auflöst.
 *
 * Der gespeicherte Wert überstimmt ALLOW_REGISTRATION aus der .env; beides
 * wertet isRegistrationOpen() in src/auth.js aus.
 *
 * Verknüpfungen:
 *   - src/db.js   -> Tabelle settings, Schlüssel "allow_registration"
 *   - src/auth.js -> isRegistrationOpen()
 *   - scripts/install/install-commands.sh -> das Kommando
 * ---------------------------------------------------------------------------
 */

import { getSetting, setSetting } from '../src/db.js';
import config from '../src/config.js';

const GN = '\x1b[32m';
const YW = '\x1b[33m';
const RD = '\x1b[31m';
const BL = '\x1b[36m';
const CL = '\x1b[0m';

/**
 * Ermittelt den geltenden Zustand und woher er stammt.
 *
 * Dieselbe Logik wie isRegistrationOpen() in src/auth.js – hier noch einmal,
 * weil zusätzlich die Herkunft interessiert. Ohne sie wäre nicht erkennbar,
 * ob gerade noch die Vorgabe aus der .env gilt oder eine bewusste
 * Entscheidung.
 *
 * @returns {{open: boolean, source: 'datenbank'|'.env'}}
 */
function currentState() {
  const stored = getSetting('allow_registration', null);

  if (stored === null) {
    return { open: config.allowRegistration, source: '.env' };
  }

  return { open: stored === '1' || stored === 'true', source: 'datenbank' };
}

/** Schreibt den Zustand lesbar auf die Konsole. */
function report() {
  const state = currentState();

  console.log('');
  console.log(`  ${BL}Registrierung${CL}`);
  console.log('');

  if (state.open) {
    console.log(`   ${GN}OFFEN${CL} – jeder, der die Adresse kennt, kann sich ein Konto anlegen.`);
  } else {
    console.log(`   ${YW}NUR MIT EINLADUNG${CL} – ohne Einladungscode geht kein Konto.`);
  }

  console.log(`   Festgelegt in: ${state.source}`);
  console.log('');
}

const argument = (process.argv[2] || '').toLowerCase();

// Ohne Argument nur berichten. Das ist die sichere Vorgabe: Ein Befehl, der
// bei einem Vertipper die Tür aufmacht, wäre schlecht gebaut.
if (!argument) {
  report();
  console.log(`  Öffnen:    ${GN}streamo registration offen${CL}`);
  console.log(`  Schließen: ${GN}streamo registration zu${CL}`);
  console.log('');
  process.exit(0);
}

// Deutsch und Englisch, weil beides naheliegt.
const OPEN_WORDS = ['offen', 'auf', 'open', 'on', 'an', 'true', '1'];
const CLOSED_WORDS = ['zu', 'geschlossen', 'closed', 'off', 'aus', 'false', '0'];

let open;

if (OPEN_WORDS.includes(argument)) open = true;
else if (CLOSED_WORDS.includes(argument)) open = false;
else {
  console.log('');
  console.log(`  ${RD}Unbekannte Angabe: "${argument}"${CL}`);
  console.log('');
  console.log(`  Öffnen:    ${GN}streamo registration offen${CL}`);
  console.log(`  Schließen: ${GN}streamo registration zu${CL}`);
  console.log('');
  process.exit(1);
}

setSetting('allow_registration', open ? '1' : '0');

console.log('');

if (open) {
  console.log(`  ${GN}✓${CL} Die Registrierung ist jetzt offen.`);
  console.log('');
  console.log('  Der Anmeldebildschirm zeigt ab sofort "Konto erstellen" ohne');
  console.log('  Feld für einen Einladungscode. Die Änderung gilt sofort,');
  console.log('  ein Neustart ist nicht nötig.');
  console.log('');
  console.log(`  ${YW}Bedenke:${CL} Wenn Streamo aus dem Internet erreichbar ist, kann sich`);
  console.log('  jetzt jeder ein Konto anlegen, der die Adresse kennt – und');
  console.log('  deinen TMDB-Zugang mitbenutzen.');
} else {
  console.log(`  ${GN}✓${CL} Die Registrierung ist jetzt geschlossen.`);
  console.log('');
  console.log('  Neue Konten entstehen nur noch über einen Einladungslink oder');
  console.log('  einen Einladungscode. Bestehende Konten bleiben unberührt.');
}

console.log('');
