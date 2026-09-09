/**
 * ---------------------------------------------------------------------------
 * desktop/tools/make-icons.mjs – Erzeugt die Programmsymbole
 * ---------------------------------------------------------------------------
 * Ausführen:  node desktop/tools/make-icons.mjs
 *
 * Legt an:
 *   desktop/assets/icon.png  (256×256, für Linux und das Tray-Symbol)
 *   desktop/assets/icon.ico  (Windows – enthält 16, 32, 48, 64, 128, 256 px)
 *
 * Warum von Hand statt mit einer Bildbibliothek?
 *   Für ein Symbol aus einem Farbverlauf und einem Buchstaben lohnt keine
 *   Abhängigkeit wie sharp oder canvas – beide brauchen native Bausteine und
 *   würden den Bau des Installers unnötig zerbrechlich machen. PNG lässt sich
 *   mit dem in Node eingebauten zlib in wenigen Zeilen schreiben, und das
 *   ICO-Format ist im Grunde nur ein Verzeichnis mit PNG-Dateien darin.
 *
 * Das Symbol: ein violettes Quadrat mit abgerundeten Ecken und einem weißen
 * "S" – passend zum Logo der Weboberfläche (public/index.html).
 * ---------------------------------------------------------------------------
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.join(__dirname, '..', 'assets');

// --------------------------------------------------------------------------
// Der Buchstabe "S".
//
// Nicht als Pixelmuster und nicht aus einer Schriftart, sondern gerechnet:
// Ein "S" besteht aus zwei Kreisbögen, die punktsymmetrisch zueinander liegen.
// Der untere ist exakt der obere, um 180 Grad gedreht – genau diese Symmetrie
// macht die Form aus.
//
// Der Vorteil gegenüber einem Pixelmuster: Die Kanten liegen an beliebigen
// Stellen, nicht auf einem groben Raster. Zusammen mit dem Supersampling
// weiter unten ergibt das saubere Rundungen in jeder Größe.
//
// Winkel in Grad, Standardkonvention: 0 = rechts, gegen den Uhrzeigersinn.
// --------------------------------------------------------------------------

/**
 * Der Buchstabe als Muster, 20 Spalten × 28 Zeilen.
 *
 * Fein genug, dass die Rundungen zusammen mit dem Supersampling weiter unten
 * glatt erscheinen. Zwei Versuche mit gerechneten Kreisbögen sahen entweder
 * wie eine Acht oder wie ein C aus – ein sorgfältig gesetztes Muster ist hier
 * schlicht das verlässlichere Werkzeug und lässt sich außerdem direkt lesen.
 */
const LETTER_S = [
  '.......######.......',
  '.....##########.....',
  '...####......####...',
  '..###..........###..',
  '..##............##..',
  '.###.............##.',
  '.##..............##.',
  '.##.................',
  '.##.................',
  '.###................',
  '.###................',
  '..####..............',
  '...#####............',
  '....########........',
  '.......########.....',
  '.........#######....',
  '............#####...',
  '..............####..',
  '................###.',
  '.................##.',
  '.................##.',
  '.##..............##.',
  '.##..............##.',
  '.###............###.',
  '..###..........###..',
  '...####......####...',
  '.....##########.....',
  '.......######.......',
];

/**
 * Erzeugt die Bilddaten für eine Kantenlänge.
 *
 * @param {number} size Kantenlänge in Pixeln
 * @returns {Buffer} RGBA-Daten, 4 Byte je Pixel
 */
function drawIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);

  // Eckenradius wie im Web-Logo: gut ein Fünftel der Kantenlänge.
  const radius = size * 0.22;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const offset = (y * size + x) * 4;

      // --- Abgerundete Ecken -----------------------------------------------
      // Für jede Ecke prüfen, ob der Punkt außerhalb des Viertelkreises liegt.
      // Ist er das, bleibt das Pixel durchsichtig.
      let inside = true;

      for (const [cornerX, cornerY] of [
        [radius, radius],
        [size - radius, radius],
        [radius, size - radius],
        [size - radius, size - radius],
      ]) {
        const outsideX = cornerX === radius ? x < radius : x > size - radius;
        const outsideY = cornerY === radius ? y < radius : y > size - radius;

        if (outsideX && outsideY) {
          const dx = x + 0.5 - cornerX;
          const dy = y + 0.5 - cornerY;
          if (Math.sqrt(dx * dx + dy * dy) > radius) inside = false;
        }
      }

      if (!inside) {
        // Vollständig durchsichtig – Alpha bleibt 0.
        continue;
      }

      // --- Hintergrund: Verlauf von Violett nach Pink ------------------------
      // Diagonal, damit er dem Web-Logo entspricht
      // (linear-gradient(135deg, #6c5ce7, #a55eea) in public/css/styles.css).
      const t = (x / size + y / size) / 2;

      pixels[offset] = Math.round(0x6c + (0xa5 - 0x6c) * t); // Rot
      pixels[offset + 1] = Math.round(0x5c + (0x5e - 0x5c) * t); // Grün
      pixels[offset + 2] = Math.round(0xe7 + (0xea - 0xe7) * t); // Blau
      pixels[offset + 3] = 255; // undurchsichtig
    }
  }

  // --- Der Buchstabe ------------------------------------------------------
  // Das Muster wird mittig platziert und füllt etwa 58 % der Höhe.
  const letterWidth = LETTER_S[0].length;
  const letterHeight = LETTER_S.length;

  const scale = (size * 0.58) / letterHeight;
  const offsetX = (size - letterWidth * scale) / 2;
  const offsetY = (size - letterHeight * scale) / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const offset = (y * size + x) * 4;

      // Nur dort zeichnen, wo der Hintergrund sichtbar ist – damit der
      // Buchstabe nicht über die abgerundeten Ecken hinausragt.
      if (pixels[offset + 3] === 0) continue;

      // Von der Pixelposition zurück auf die Zelle im Muster rechnen.
      // Diese Richtung (Bild -> Muster) statt umgekehrt vermeidet Lücken:
      // Bei einer Vergrößerung bekäme sonst nicht jedes Bildpixel einen Wert.
      const col = Math.floor((x + 0.5 - offsetX) / scale);
      const row = Math.floor((y + 0.5 - offsetY) / scale);

      if (row < 0 || row >= letterHeight || col < 0 || col >= letterWidth) continue;
      if (LETTER_S[row][col] !== '#') continue;

      pixels[offset] = 255;
      pixels[offset + 1] = 255;
      pixels[offset + 2] = 255;
      pixels[offset + 3] = 255;
    }
  }

  return pixels;
}

/**
 * Verpackt RGBA-Daten in eine PNG-Datei.
 *
 * Aufbau einer PNG: die Signatur, dann eine Folge von "Chunks". Jeder Chunk
 * besteht aus Länge, Typ, Daten und einer CRC-Prüfsumme. Wir brauchen genau
 * drei: IHDR (Kopfdaten), IDAT (die komprimierten Pixel) und IEND (Ende).
 *
 * @param {number} size Kantenlänge
 * @param {Buffer} pixels RGBA-Daten
 * @returns {Buffer} vollständige PNG-Datei
 */
function encodePng(size, pixels) {
  /**
   * Berechnet die CRC-32-Prüfsumme, die jeder Chunk am Ende trägt.
   * @param {Buffer} data
   * @returns {number}
   */
  function crc32(data) {
    let crc = 0xffffffff;

    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) {
        // 0xEDB88320 ist das gespiegelte Standardpolynom für CRC-32.
        crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
      }
    }

    return (crc ^ 0xffffffff) >>> 0;
  }

  /**
   * Baut einen einzelnen Chunk.
   * @param {string} type Vier Buchstaben, z. B. "IHDR"
   * @param {Buffer} data
   * @returns {Buffer}
   */
  function chunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);

    const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);

    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typeAndData));

    return Buffer.concat([length, typeAndData, crc]);
  }

  // --- IHDR: Breite, Höhe, Bittiefe, Farbtyp ------------------------------
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); // Breite
  header.writeUInt32BE(size, 4); // Höhe
  header[8] = 8; // 8 Bit je Kanal
  header[9] = 6; // Farbtyp 6 = RGBA
  header[10] = 0; // Kompression: deflate (der einzige erlaubte Wert)
  header[11] = 0; // Filtermethode: Standard
  header[12] = 0; // kein Interlacing

  // --- IDAT: die Pixel ----------------------------------------------------
  // Jede Bildzeile beginnt in PNG mit einem Filter-Byte. 0 bedeutet "kein
  // Filter" – das kostet etwas Dateigröße, spart aber viel Code.
  const raw = Buffer.alloc(size * (size * 4 + 1));

  for (let y = 0; y < size; y++) {
    const target = y * (size * 4 + 1);
    raw[target] = 0;
    pixels.copy(raw, target + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    // Die feste PNG-Signatur.
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Verpackt mehrere PNG-Dateien in ein Windows-ICO.
 *
 * Ein ICO ist ein Verzeichnis: erst ein Kopf mit der Anzahl der Bilder, dann
 * je Bild ein Eintrag mit Maßen und Position, danach die Bilddaten selbst.
 * Seit Windows Vista dürfen die Bilder PNG-kodiert sein – genau das nutzen
 * wir, sonst müssten wir zusätzlich das alte BMP-Format schreiben.
 *
 * @param {{size: number, png: Buffer}[]} images
 * @returns {Buffer}
 */
function encodeIco(images) {
  const HEADER_SIZE = 6;
  const ENTRY_SIZE = 16;

  const header = Buffer.alloc(HEADER_SIZE);
  header.writeUInt16LE(0, 0); // reserviert, immer 0
  header.writeUInt16LE(1, 2); // Typ 1 = Symbol (2 wäre ein Mauszeiger)
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  const data = [];

  // Die Bilddaten beginnen hinter Kopf und allen Verzeichniseinträgen.
  let offset = HEADER_SIZE + images.length * ENTRY_SIZE;

  for (const image of images) {
    const entry = Buffer.alloc(ENTRY_SIZE);

    // 256 wird als 0 geschrieben – das Feld ist nur ein Byte breit.
    entry[0] = image.size >= 256 ? 0 : image.size; // Breite
    entry[1] = image.size >= 256 ? 0 : image.size; // Höhe
    entry[2] = 0; // Farben in der Palette (0 = keine Palette)
    entry[3] = 0; // reserviert
    entry.writeUInt16LE(1, 4); // Farbebenen
    entry.writeUInt16LE(32, 6); // Bit je Pixel
    entry.writeUInt32BE(0, 8); // Platzhalter, gleich überschrieben
    entry.writeUInt32LE(image.png.length, 8); // Größe der Bilddaten
    entry.writeUInt32LE(offset, 12); // Position der Bilddaten

    entries.push(entry);
    data.push(image.png);
    offset += image.png.length;
  }

  return Buffer.concat([header, ...entries, ...data]);
}

/**
 * Zeichnet das Symbol mit weichen Kanten.
 *
 * Verfahren: Supersampling. Das Bild entsteht in vierfacher Auflösung und
 * wird anschließend durch Mittelung auf die Zielgröße verkleinert. Aus einer
 * harten Treppenkante werden dabei Zwischentöne – der Buchstabe und die
 * abgerundeten Ecken wirken glatt.
 *
 * Der Umweg ist nötig, weil drawIcon() jedes Pixel entweder ganz setzt oder
 * gar nicht. Ohne ihn sieht besonders die Rundung des "S" stufig aus.
 *
 * @param {number} size Gewünschte Kantenlänge
 * @returns {Buffer} geglättete RGBA-Daten
 */
function drawIconSmooth(size) {
  const FACTOR = 4;
  const big = drawIcon(size * FACTOR);
  const out = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Die Summen je Farbkanal über den zugehörigen Block sammeln.
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let subY = 0; subY < FACTOR; subY++) {
        for (let subX = 0; subX < FACTOR; subX++) {
          const source = ((y * FACTOR + subY) * size * FACTOR + (x * FACTOR + subX)) * 4;
          const alpha = big[source + 3];

          // Farben mit dem Alphawert gewichten. Ohne diese Gewichtung würden
          // durchsichtige Pixel (deren Farbwerte 0 sind) die Kanten dunkel
          // einfärben – ein klassischer Fehler beim Verkleinern.
          r += big[source] * alpha;
          g += big[source + 1] * alpha;
          b += big[source + 2] * alpha;
          a += alpha;
        }
      }

      const target = (y * size + x) * 4;

      if (a === 0) {
        // Vollständig durchsichtiger Block – nichts zu tun.
        continue;
      }

      out[target] = Math.round(r / a);
      out[target + 1] = Math.round(g / a);
      out[target + 2] = Math.round(b / a);
      out[target + 3] = Math.round(a / (FACTOR * FACTOR));
    }
  }

  return out;
}

// ==========================================================================
// Erzeugen und schreiben
// ==========================================================================

fs.mkdirSync(ASSETS_DIR, { recursive: true });

// Diese Größen erwartet Windows im Explorer, in der Taskleiste und im
// Infobereich. Fehlt eine, skaliert Windows selbst – meist unschön.
const SIZES = [16, 32, 48, 64, 128, 256];

const images = SIZES.map((size) => ({
  size,
  png: encodePng(size, drawIconSmooth(size)),
}));

// Die 256er-Fassung dient zusätzlich als eigenständiges PNG für Linux und
// als Tray-Symbol.
const large = images.find((image) => image.size === 256);
fs.writeFileSync(path.join(ASSETS_DIR, 'icon.png'), large.png);

fs.writeFileSync(path.join(ASSETS_DIR, 'icon.ico'), encodeIco(images));

console.log('Symbole erzeugt:');
console.log(`  assets/icon.png  ${large.png.length} Bytes (256×256)`);
console.log(
  `  assets/icon.ico  ${fs.statSync(path.join(ASSETS_DIR, 'icon.ico')).size} Bytes ` +
    `(${SIZES.join(', ')} px)`,
);
