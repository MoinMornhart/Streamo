/**
 * ---------------------------------------------------------------------------
 * src/db.js – SQLite-Datenbank, Schema und Zugriffs-Helfer
 * ---------------------------------------------------------------------------
 * Rolle im Gesamtsystem:
 *   Streamo speichert ALLES lokal in einer einzigen SQLite-Datei
 *   (DATA_DIR/streamo.db). Kein externer Datenbankserver, kein Docker-Compose –
 *   die Datei kann man kopieren und hat damit ein vollständiges Backup.
 *
 *   Verwendet wird `node:sqlite`, das seit Node 22.5 mitgelieferte, eingebaute
 *   SQLite-Modul. Vorteil gegenüber better-sqlite3: keine native Kompilierung,
 *   damit installiert `npm install` im LXC in Sekunden und ohne Build-Tools.
 *
 * Verknüpfungen zu anderen Dateien:
 *   - src/config.js       -> liefert config.databaseFile (Speicherort)
 *   - src/auth.js         -> Tabellen `users` und `sessions`
 *   - src/routes/*.js     -> alle Lese-/Schreibzugriffe laufen über db/get/all/run
 *   - src/tmdb.js         -> Tabelle `settings` (TMDB-Key zur Laufzeit)
 *   - src/sync.js         -> Tabellen `availability`, `shows`, `sync_log`
 *
 * Datenmodell in Kurzform (Details am jeweiligen CREATE TABLE):
 *
 *   users ──< sessions                     (ein Benutzer, viele Anmeldungen)
 *   users ──< user_providers >── providers  (die verknüpften Streaming-Abos)
 *   users ──< library >── shows             (die persönliche Serien-Datenbank)
 *   shows ──< episodes ──< watched_episodes (Fortschritt je Episode)
 *   shows ──< availability >── providers    (wo läuft die Serie gerade?)
 * ---------------------------------------------------------------------------
 */

import { DatabaseSync } from 'node:sqlite';
import config from './config.js';

// --------------------------------------------------------------------------
// Verbindung öffnen.
// node:sqlite arbeitet synchron. Das ist für Streamo völlig ausreichend:
// SQLite-Abfragen auf lokaler NVMe/SSD liegen im Mikrosekundenbereich, und
// die einzigen wirklich langsamen Operationen (TMDB-Aufrufe) sind ohnehin
// asynchron und laufen außerhalb der Datenbank.
// --------------------------------------------------------------------------
export const db = new DatabaseSync(config.databaseFile);

// --------------------------------------------------------------------------
// PRAGMA-Einstellungen – müssen VOR dem Anlegen der Tabellen gesetzt werden.
// --------------------------------------------------------------------------

// WAL (Write-Ahead Logging): Leser blockieren Schreiber nicht mehr. Dadurch
// kann der Hintergrund-Sync (src/sync.js) schreiben, während das UI liest.
db.exec('PRAGMA journal_mode = WAL');

// NORMAL statt FULL: deutlich weniger fsync-Aufrufe. Bei einem Stromausfall
// kann höchstens die letzte Transaktion fehlen – für einen Serien-Tracker ein
// akzeptabler Tausch gegen spürbar mehr Schreibgeschwindigkeit.
db.exec('PRAGMA synchronous = NORMAL');

// Fremdschlüssel sind in SQLite standardmäßig AUS. Ohne diese Zeile würden
// alle "REFERENCES … ON DELETE CASCADE" unten wirkungslos bleiben und beim
// Löschen eines Benutzers Karteileichen zurückbleiben.
db.exec('PRAGMA foreign_keys = ON');

// Wartet bis zu 5 Sekunden, statt sofort "database is locked" zu werfen, wenn
// Sync und UI-Request gleichzeitig schreiben wollen.
db.exec('PRAGMA busy_timeout = 5000');

/**
 * ---------------------------------------------------------------------------
 * Das Schema.
 * ---------------------------------------------------------------------------
 * Wird bei jedem Start ausgeführt. Alle Anweisungen sind "IF NOT EXISTS",
 * damit der Aufruf idempotent ist: beim ersten Start wird angelegt, bei jedem
 * weiteren passiert nichts. Spätere Schemaänderungen laufen über die
 * Migrations-Liste weiter unten (PRAGMA user_version).
 */
const SCHEMA = `
-- ===========================================================================
-- users – Personen, die sich an dieser Streamo-Instanz anmelden können.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Anmeldename, case-insensitiv eindeutig (COLLATE NOCASE), damit sich
  -- "Max" und "max" nicht als zwei Konten anlegen lassen.
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  -- Anzeigename im UI; darf Leerzeichen und Umlaute enthalten.
  display_name  TEXT,
  -- scrypt-Hash des Passworts, Format "salt:hash" (siehe src/auth.js).
  -- Klartext-Passwörter werden nie gespeichert.
  password_hash TEXT NOT NULL,
  -- 1 = darf globale Einstellungen (TMDB-Key) ändern und Benutzer verwalten.
  -- Der erste angelegte Benutzer wird im Setup automatisch Admin.
  is_admin      INTEGER NOT NULL DEFAULT 0,
  -- Persönliche Watch-Region (ISO-3166-1). Überschreibt config.region und
  -- bestimmt, welche Streaming-Anbieter für diesen Benutzer relevant sind.
  region        TEXT,
  -- Persönliche Metadaten-Sprache (ISO-639-1 + Land), z. B. "de-DE".
  language      TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

-- ===========================================================================
-- credentials – Passkeys. Verknüpfung: credentials.user_id -> users.id
-- ===========================================================================
-- Ein Passkey ist ein Schlüsselpaar, das im Gerät des Benutzers entsteht
-- (Windows Hello, Face ID, Android, oder ein Sicherheitsschlüssel wie YubiKey).
-- Der PRIVATE Teil verlässt dieses Gerät nie. Streamo speichert deshalb nur
-- den öffentlichen Teil – selbst wenn jemand diese Datenbank vollständig
-- stiehlt, kann er sich damit nicht anmelden. Genau das ist der Vorteil
-- gegenüber einem Passwort-Hash.
CREATE TABLE IF NOT EXISTS credentials (
  -- Die vom Gerät vergebene Anmeldedaten-Kennung, Base64URL-kodiert.
  -- Sie ist global eindeutig und wird beim Anmelden vom Browser mitgeschickt.
  id            TEXT PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Der öffentliche Schlüssel im COSE-Format, Base64URL-kodiert.
  public_key    TEXT NOT NULL,
  -- Signaturzähler des Geräts. Steigt bei jeder Anmeldung. Fällt er, ist das
  -- ein Hinweis auf einen geklonten Schlüssel – die Bibliothek prüft das.
  -- Moderne Plattform-Passkeys melden hier oft dauerhaft 0, das ist normal.
  counter       INTEGER NOT NULL DEFAULT 0,
  -- Wie ist das Gerät erreichbar? JSON-Array wie ["internal","hybrid"].
  -- Der Browser nutzt das beim nächsten Mal, um passende Hinweise zu zeigen
  -- ("Passkey von einem anderen Gerät verwenden").
  transports    TEXT,
  -- Vom Benutzer vergebener Name, damit er in der Liste weiß, welches Gerät
  -- gemeint ist: "Arbeitslaptop", "iPhone", "YubiKey am Schlüsselbund".
  name          TEXT,
  -- 1 = auffindbarer Passkey (Resident Key). Nur damit ist eine Anmeldung
  -- ganz ohne Benutzernamen möglich.
  discoverable  INTEGER NOT NULL DEFAULT 0,
  -- Woher stammt der Schlüssel? "platform" = im Gerät (Windows Hello),
  -- "cross-platform" = externer Sicherheitsschlüssel.
  device_type   TEXT,
  -- 1 = der Passkey wird zwischen Geräten synchronisiert (iCloud, Google).
  backed_up     INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_credentials_user ON credentials(user_id);

-- ===========================================================================
-- sessions – aktive Anmeldungen. Verknüpfung: sessions.user_id -> users.id
-- ===========================================================================
-- Warum eine Tabelle statt eines rein signierten Cookies? Damit "Abmelden"
-- und "Alle Geräte abmelden" wirklich wirken: Wir löschen einfach die Zeile.
CREATE TABLE IF NOT EXISTS sessions (
  -- Zufälliger 256-Bit-Token (hex). Steht so auch im Cookie "streamo_session".
  id         TEXT PRIMARY KEY,
  -- ON DELETE CASCADE: Wird ein Benutzer gelöscht, verschwinden automatisch
  -- alle seine Sessions – niemand bleibt mit einem toten Token angemeldet.
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Ablaufzeitpunkt als ISO-String. Abgelaufene Sessions werden beim Start
  -- und bei jedem Login aufgeräumt (src/auth.js -> pruneSessions).
  expires_at TEXT NOT NULL,
  -- Rein informativ, damit man in den Einstellungen sieht, welches Gerät das war.
  user_agent TEXT,
  ip         TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- ===========================================================================
-- settings – globale Schlüssel/Wert-Einstellungen, die im UI änderbar sind.
-- ===========================================================================
-- Bekannte Schlüssel:
--   tmdb_api_key    – überschreibt config.tmdbApiKey zur Laufzeit
--   region          – Fallback-Region, wenn der Benutzer keine eigene hat
--   language        – Fallback-Sprache
--   setup_complete  – "1", sobald der Einrichtungsassistent durchlaufen wurde
--   last_sync_at    – Zeitstempel des letzten erfolgreichen Sync-Laufs
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===========================================================================
-- providers – der Katalog aller Streaming-Anbieter (Quelle: TMDB/JustWatch).
-- ===========================================================================
-- Wird beim ersten Aufruf von /api/providers und bei jedem Sync aufgefrischt.
CREATE TABLE IF NOT EXISTS providers (
  -- TMDB-Provider-ID, z. B. 8 = Netflix, 337 = Disney+, 9 = Amazon Prime Video.
  -- Wir übernehmen die TMDB-ID direkt als Primärschlüssel, damit Antworten der
  -- API ohne Übersetzungstabelle zugeordnet werden können.
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  -- Pfad zum Logo auf image.tmdb.org, z. B. "/t2yyOv40HZeVlLjYsCsPHnWLk4W.jpg".
  -- Die vollständige URL baut das Frontend in public/js/api.js zusammen.
  logo_path     TEXT,
  -- Sortiergewicht von TMDB: kleinere Zahl = in der Region populärer.
  display_priority INTEGER,
  -- Region, für die dieser Katalogeintrag gilt. Netflix hat in DE und US
  -- dieselbe ID, aber unterschiedliche Prioritäten – deshalb Teil des Index.
  region        TEXT NOT NULL DEFAULT 'DE',
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_providers_region ON providers(region, display_priority);

-- ===========================================================================
-- user_providers – DIE VERKNÜPFUNG "meine Abos".
-- ===========================================================================
-- Das ist die Kern-Tabelle für den Wunsch "alle Streaminganbieter verknüpfen":
-- Jede Zeile bedeutet "Benutzer X hat ein Abo bei Anbieter Y".
-- Zusammengesetzter Primärschlüssel = jede Kombination höchstens einmal.
CREATE TABLE IF NOT EXISTS user_providers (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Kein FK auf providers(id): Der Anbieter-Katalog wird bei jedem Sync neu
  -- befüllt, und ein Abo soll nicht verschwinden, nur weil TMDB einen Anbieter
  -- kurzzeitig nicht mehr für die Region ausliefert.
  provider_id INTEGER NOT NULL,
  -- Denormalisierte Kopie von Name/Logo. Damit bleibt die Abo-Liste auch dann
  -- anzeigbar, wenn der Katalog gerade leer oder die TMDB-API nicht erreichbar ist.
  name        TEXT,
  logo_path   TEXT,
  -- Reihenfolge in der UI-Anzeige, per Drag&Drop änderbar.
  sort_order  INTEGER NOT NULL DEFAULT 0,
  added_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, provider_id)
);

-- ===========================================================================
-- shows – der Metadaten-Cache für Serien und Filme.
-- ===========================================================================
-- Absichtlich NICHT pro Benutzer: Wenn zwei Personen dieselbe Serie tracken,
-- werden die Metadaten nur einmal gespeichert und einmal aktualisiert.
CREATE TABLE IF NOT EXISTS shows (
  -- Eigene interne ID. Alle anderen Tabellen zeigen hierauf, nicht auf die
  -- TMDB-ID – so bleiben Fremdschlüssel stabil, falls später eine zweite
  -- Metadatenquelle dazukommt.
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  tmdb_id        INTEGER NOT NULL,
  -- 'tv' oder 'movie'. Zusammen mit tmdb_id eindeutig, weil TMDB Serien und
  -- Filme in getrennten ID-Räumen führt (es gibt tv/1399 UND movie/1399).
  media_type     TEXT NOT NULL DEFAULT 'tv',
  title          TEXT NOT NULL,
  original_title TEXT,
  overview       TEXT,
  -- Bildpfade relativ zu image.tmdb.org (siehe providers.logo_path).
  poster_path    TEXT,
  backdrop_path  TEXT,
  -- Erstausstrahlung bzw. Kinostart, ISO-Datum "YYYY-MM-DD".
  first_air_date TEXT,
  last_air_date  TEXT,
  -- TMDB-Status: "Returning Series", "Ended", "Canceled", "Released" …
  status         TEXT,
  -- Genres als JSON-Array von Strings, z. B. ["Drama","Sci-Fi"].
  -- JSON statt eigener Tabelle, weil Genres nur angezeigt und gefiltert,
  -- aber nie einzeln verknüpft werden.
  genres         TEXT,
  number_of_seasons  INTEGER,
  number_of_episodes INTEGER,
  -- Durchschnittliche TMDB-Bewertung 0–10.
  vote_average   REAL,
  -- Laufzeit einer Episode bzw. des Films in Minuten – Basis für die
  -- Statistik "so viel Lebenszeit hast du investiert".
  runtime        INTEGER,
  -- Wann wurden die Metadaten zuletzt von TMDB geholt? Steuert, ob der
  -- Sync-Lauf diesen Eintrag überhaupt anfassen muss.
  metadata_updated_at     TEXT,
  -- Wann wurde zuletzt geprüft, wo die Serie läuft? Getrennt vom obigen Feld,
  -- weil Verfügbarkeiten sich viel häufiger ändern als Titel und Poster.
  availability_updated_at TEXT,
  -- Zu welcher offiziellen Filmreihe gehört dieser Titel? Kommt bei Filmen
  -- aus dem TMDB-Feld "belongs_to_collection", bei Serien immer NULL.
  -- Verknüpfung: collections.tmdb_id (siehe src/collections.js).
  collection_tmdb_id INTEGER,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tmdb_id, media_type)
);

-- ===========================================================================
-- library – DIE persönliche Serien-Datenbank. users <-> shows
-- ===========================================================================
-- Jede Zeile heißt: "Benutzer X hat Serie Y auf seiner Liste".
CREATE TABLE IF NOT EXISTS library (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Wird eine Serie aus dem Cache entfernt, verschwindet auch der
  -- Bibliothekseintrag – ein Eintrag ohne Metadaten wäre wertlos.
  show_id    INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  -- Sehstatus. Erlaubte Werte (per CHECK erzwungen, damit ein Tippfehler im
  -- Frontend nicht stillschweigend Müll speichert):
  --   watchlist  – will ich sehen
  --   watching   – schaue ich gerade
  --   completed  – durchgesehen
  --   paused     – abgebrochen/pausiert
  --   dropped    – aufgegeben
  status     TEXT NOT NULL DEFAULT 'watchlist'
             CHECK (status IN ('watchlist','watching','completed','paused','dropped')),
  -- Eigene Bewertung 1–10, NULL = nicht bewertet.
  rating     INTEGER CHECK (rating IS NULL OR (rating >= 1 AND rating <= 10)),
  -- 1 = Favorit (Herz-Symbol im UI).
  favorite   INTEGER NOT NULL DEFAULT 0,
  -- Freitext-Notiz des Benutzers.
  notes      TEXT,
  added_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Eine Serie kann pro Benutzer nur einmal in der Bibliothek stehen.
  UNIQUE (user_id, show_id)
);
CREATE INDEX IF NOT EXISTS idx_library_user_status ON library(user_id, status);

-- ===========================================================================
-- episodes – Episodenliste je Serie. Verknüpfung: episodes.show_id -> shows.id
-- ===========================================================================
-- Wird erst geladen, wenn jemand die Detailseite einer Serie öffnet
-- (Lazy Loading), damit der Import nicht tausende API-Aufrufe auslöst.
CREATE TABLE IF NOT EXISTS episodes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  show_id        INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  -- TMDB-ID der Episode; nützlich für spätere Abgleiche, aber nicht der PK.
  tmdb_id        INTEGER,
  -- Staffel 0 ist bei TMDB die Sammlung der Specials.
  season_number  INTEGER NOT NULL,
  episode_number INTEGER NOT NULL,
  name           TEXT,
  overview       TEXT,
  air_date       TEXT,
  runtime        INTEGER,
  still_path     TEXT,
  -- Eine Episodennummer existiert je Serie und Staffel genau einmal.
  UNIQUE (show_id, season_number, episode_number)
);
CREATE INDEX IF NOT EXISTS idx_episodes_show ON episodes(show_id, season_number, episode_number);

-- ===========================================================================
-- watched_episodes – Fortschritt. users <-> episodes
-- ===========================================================================
-- Jede Zeile heißt: "Benutzer X hat Episode Y gesehen".
CREATE TABLE IF NOT EXISTS watched_episodes (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  -- show_id ist hier bewusst redundant gespeichert: Damit lässt sich der
  -- Fortschritt einer Serie ohne JOIN über episodes zählen, was die
  -- Bibliotheks-Übersicht deutlich beschleunigt.
  show_id    INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  watched_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, episode_id)
);
CREATE INDEX IF NOT EXISTS idx_watched_user_show ON watched_episodes(user_id, show_id);

-- ===========================================================================
-- availability – WO läuft die Serie? shows <-> providers
-- ===========================================================================
-- Das ist die zweite Kern-Tabelle des Projekts: Sie beantwortet die Frage
-- "wo kann ich das streamen?". Befüllt wird sie aus dem TMDB-Endpunkt
-- /watch/providers (Datenquelle dahinter: JustWatch).
CREATE TABLE IF NOT EXISTS availability (
  show_id      INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  -- Verfügbarkeit ist länderspezifisch – dieselbe Serie läuft in DE bei
  -- Netflix und in AT bei Sky. Deshalb ist die Region Teil des Schlüssels.
  region       TEXT NOT NULL,
  provider_id  INTEGER NOT NULL,
  -- Art des Angebots:
  --   flatrate – im Abo enthalten  (das, was uns am meisten interessiert)
  --   free     – kostenlos, ohne Werbung
  --   ads      – kostenlos, mit Werbung
  --   rent     – Leihe
  --   buy      – Kauf
  offer_type   TEXT NOT NULL
               CHECK (offer_type IN ('flatrate','free','ads','rent','buy')),
  -- Denormalisierte Anbieterdaten, damit die Anzeige auch ohne JOIN und ohne
  -- vollständigen Katalog funktioniert (gleiche Begründung wie user_providers).
  name         TEXT,
  logo_path    TEXT,
  display_priority INTEGER,
  -- Deeplink zur Anbieter-/JustWatch-Seite; TMDB liefert einen Link pro
  -- Region, nicht pro Anbieter – siehe src/tmdb.js.
  link         TEXT,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (show_id, region, provider_id, offer_type)
);
CREATE INDEX IF NOT EXISTS idx_availability_lookup ON availability(show_id, region);
CREATE INDEX IF NOT EXISTS idx_availability_provider ON availability(region, provider_id);

-- ===========================================================================
-- sync_log – Protokoll der Hintergrundläufe (src/sync.js).
-- ===========================================================================
-- Wird auf der Einstellungsseite angezeigt: "letzter Abgleich vor 3 Stunden,
-- 42 Serien aktualisiert". Ohne dieses Protokoll wäre der Sync eine Blackbox.
CREATE TABLE IF NOT EXISTS sync_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 'availability' | 'metadata' | 'providers' | 'full'
  kind        TEXT NOT NULL,
  started_at  TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  -- 1 = erfolgreich, 0 = mit Fehler abgebrochen
  ok          INTEGER,
  -- Anzahl der verarbeiteten Datensätze
  items       INTEGER DEFAULT 0,
  -- Fehlermeldung oder Kurzbericht
  detail      TEXT
);
`;

// Schema anlegen bzw. sicherstellen, dass es vorhanden ist.
db.exec(SCHEMA);

/**
 * ---------------------------------------------------------------------------
 * Migrationen
 * ---------------------------------------------------------------------------
 * SQLite merkt sich in `PRAGMA user_version` eine frei wählbare Zahl. Wir
 * nutzen sie als Schema-Versionsnummer: Jede Funktion im Array unten hebt das
 * Schema um genau eine Version an und wird nur einmal ausgeführt.
 *
 * Anlegen einer neuen Migration: einfach eine weitere Funktion ans ENDE des
 * Arrays hängen – niemals bestehende Einträge ändern oder umsortieren, sonst
 * laufen bereits migrierte Installationen auseinander.
 */
const MIGRATIONS = [
  // Version 1 -> Basisschema. Es ist bereits durch SCHEMA oben angelegt,
  // dieser Eintrag hebt nur den Zähler an, damit künftige Migrationen eine
  // definierte Ausgangslage haben.
  () => {},

  // -------------------------------------------------------------------------
  // Version 2 -> Passkeys und E-Mail-Adressen
  // -------------------------------------------------------------------------
  // Ab hier kann man sich auf zwei Wegen anmelden: mit Benutzername bzw.
  // E-Mail und Passwort wie bisher, ODER mit einem Passkey (WebAuthn/FIDO2,
  // also Windows Hello, Face ID, Fingerabdruck oder ein Sicherheitsschlüssel).
  //
  // Die Spalte `email` kommt per ALTER TABLE dazu. Bestehende Konten behalten
  // NULL – die E-Mail ist optional und dient nur als zweiter Anmeldename.
  () => {
    // Die Tabellen werden bei einer NEUEN Installation bereits durch SCHEMA
    // angelegt. Deshalb wird hier geprüft, ob die Spalte schon existiert –
    // sonst würde ALTER TABLE mit "duplicate column name" scheitern.
    const columns = db.prepare('PRAGMA table_info(users)').all();

    if (!columns.some((c) => c.name === 'email')) {
      db.exec('ALTER TABLE users ADD COLUMN email TEXT');
    }

    // Teilweiser eindeutiger Index: E-Mail-Adressen müssen eindeutig sein,
    // aber beliebig viele Konten dürfen gar keine haben (NULL). Ein normaler
    // UNIQUE-Index würde in SQLite zwar auch mehrere NULL erlauben, der
    // WHERE-Zusatz macht die Absicht aber unmissverständlich.
    db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL',
    );
  },

  // -------------------------------------------------------------------------
  // Version 3 -> Erfolge
  // -------------------------------------------------------------------------
  // Gespeichert wird nur, WER WELCHEN Erfolg WANN bekommen hat. Was es für
  // Erfolge gibt, steht im Code (src/achievements.js) – so kommen neue mit
  // einem Update dazu, ohne dass jemand Datensätze pflegen müsste.
  () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_achievements (
        user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        -- Die Kennung aus src/achievements.js, z. B. "house" oder "binge_10".
        -- Bewusst Text und kein Fremdschlüssel: Die Erfolge leben im Code.
        achievement_id TEXT NOT NULL,
        earned_at      TEXT NOT NULL DEFAULT (datetime('now')),
        -- Jeder Erfolg wird je Person höchstens einmal vergeben.
        PRIMARY KEY (user_id, achievement_id)
      );
      CREATE INDEX IF NOT EXISTS idx_achievements_user ON user_achievements(user_id);
    `);
  },

  // -------------------------------------------------------------------------
  // Version 4 -> Filmreihen
  // -------------------------------------------------------------------------
  // Zwei Arten von Reihen, die sich dieselben Tabellen teilen:
  //
  //   1. Offizielle Reihen von TMDB ("Kingsman", "Der Herr der Ringe").
  //      Sie haben eine tmdb_id und gehören niemandem – jeder sieht dieselbe.
  //
  //   2. Eigene Reihen ("Vorwissen für Spider-Man: Brand New Day").
  //      Sie haben eine user_id und eine selbst bestimmte Reihenfolge.
  //
  // Der Unterschied steckt allein darin, welche der beiden Spalten gefüllt
  // ist. Alles andere – Titel, Beschreibung, die Liste der Filme – funktioniert
  // für beide gleich, und das Frontend muss nur an wenigen Stellen unterscheiden.
  () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS collections (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,

        -- Gesetzt bei offiziellen Reihen von TMDB, sonst NULL.
        -- Der eindeutige Index weiter unten verhindert Doppelte.
        tmdb_id       INTEGER,

        -- Gesetzt bei eigenen Reihen, sonst NULL. Wird das Konto gelöscht,
        -- verschwinden die eigenen Reihen mit; die offiziellen bleiben, weil
        -- dort NULL steht und die Bedingung nie zutrifft.
        user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,

        name          TEXT NOT NULL,
        -- Bei eigenen Reihen die Stelle für "Das braucht man vorher".
        description   TEXT,
        poster_path   TEXT,
        backdrop_path TEXT,

        -- Wonach richtet sich die Reihenfolge? Nur zur Anzeige gedacht:
        --   release    – nach Erscheinungsdatum (Vorgabe bei TMDB-Reihen)
        --   chronology – nach der erzählten Zeit
        --   custom     – von Hand sortiert
        order_type    TEXT NOT NULL DEFAULT 'release'
                      CHECK (order_type IN ('release','chronology','custom')),

        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Eine offizielle Reihe wird nur einmal gespeichert. Der WHERE-Zusatz
      -- schließt eigene Reihen aus, bei denen tmdb_id NULL ist – sonst dürfte
      -- es nur eine einzige eigene Reihe geben.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_collections_tmdb
        ON collections(tmdb_id) WHERE tmdb_id IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_collections_user ON collections(user_id);

      -- Welche Titel gehören zu einer Reihe, und in welcher Ordnung?
      CREATE TABLE IF NOT EXISTS collection_items (
        collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
        -- Zeigt auf den Metadaten-Cache, nicht auf die Bibliothek: Eine Reihe
        -- darf Filme enthalten, die man selbst gar nicht auf der Liste hat.
        show_id       INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE,

        -- Position in der Reihe, beginnend bei 0. Lücken sind erlaubt und
        -- werden beim Umsortieren ohnehin neu vergeben.
        position      INTEGER NOT NULL DEFAULT 0,

        -- Freitext je Eintrag – gedacht für Hinweise wie "nur die erste
        -- halbe Stunde nötig" oder "Nachspann nicht überspringen".
        note          TEXT,

        added_at      TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (collection_id, show_id)
      );

      CREATE INDEX IF NOT EXISTS idx_collection_items_order
        ON collection_items(collection_id, position);
    `);

    // Zu welcher offiziellen Reihe gehört ein Film? TMDB liefert das bei den
    // Filmdetails im Feld `belongs_to_collection`. Wir merken es uns hier,
    // damit die Detailseite die Reihe nachladen kann, ohne die vollständige
    // TMDB-Antwort noch einmal zu holen.
    //
    // Die Prüfung ist nötig, weil das Schema bei einer NEUEN Installation
    // bereits die Spalte enthält – ALTER TABLE würde dann scheitern.
    const columns = db.prepare('PRAGMA table_info(shows)').all();

    if (!columns.some((c) => c.name === 'collection_tmdb_id')) {
      db.exec('ALTER TABLE shows ADD COLUMN collection_tmdb_id INTEGER');
    }

    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_shows_collection
         ON shows(collection_tmdb_id) WHERE collection_tmdb_id IS NOT NULL`,
    );
  },

  // -------------------------------------------------------------------------
  // Version 5 -> Reihen teilen
  // -------------------------------------------------------------------------
  // Eine eigene Reihe lässt sich über einen Link weitergeben – etwa per
  // WhatsApp: "Das solltest du vorher gesehen haben". Wer den Link hat, sieht
  // die Liste, ohne ein Konto zu brauchen.
  //
  // Der Token ist ein zufälliger, nicht erratbarer Wert. Solange er NULL ist,
  // ist die Reihe privat; das Teilen lässt sich jederzeit widerrufen, indem
  // er wieder auf NULL gesetzt wird. Ein neuer Link entwertet den alten.
  () => {
    const columns = db.prepare('PRAGMA table_info(collections)').all();

    if (!columns.some((c) => c.name === 'share_token')) {
      db.exec('ALTER TABLE collections ADD COLUMN share_token TEXT');
    }

    if (!columns.some((c) => c.name === 'shared_at')) {
      db.exec('ALTER TABLE collections ADD COLUMN shared_at TEXT');
    }

    // Teilweise eindeutig: Beliebig viele Reihen dürfen ungeteilt sein (NULL),
    // aber ein vergebener Token gehört zu genau einer Reihe.
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_collections_share
         ON collections(share_token) WHERE share_token IS NOT NULL`,
    );
  },

  // -------------------------------------------------------------------------
  // Version 6 -> Freunde
  // -------------------------------------------------------------------------
  // Freundschaften und Empfehlungen zwischen Konten derselben Instanz.
  //
  // Wozu? Damit man sieht, was Freunde schauen, und vor allem: was man
  // ZUSAMMEN sehen kann. Die interessante Frage bei einem gemeinsamen Abend
  // ist ja nicht "was läuft", sondern "was läuft bei einem Dienst, den einer
  // von uns beiden hat, und interessiert uns beide".
  () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS friendships (
        -- Wer hat angefragt?
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        -- Und wen?
        friend_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

        -- pending  – angefragt, noch nicht beantwortet
        -- accepted – beide sind befreundet
        -- Abgelehnte Anfragen werden gelöscht statt gespeichert: Eine Ablehnung
        -- muss man nicht aufbewahren, und sie soll eine erneute Anfrage später
        -- nicht blockieren.
        status      TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','accepted')),

        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        accepted_at TEXT,

        -- Eine Beziehung wird EINMAL gespeichert, in der Richtung der Anfrage.
        -- Beim Lesen wird deshalb immer in beide Richtungen gesucht – siehe
        -- src/friends.js. Der umgekehrte Weg (zwei Zeilen je Freundschaft)
        -- wäre einfacher zu lesen, aber schwerer konsistent zu halten.
        PRIMARY KEY (user_id, friend_id),

        -- Niemand ist mit sich selbst befreundet.
        CHECK (user_id != friend_id)
      );

      CREATE INDEX IF NOT EXISTS idx_friendships_friend ON friendships(friend_id, status);

      -- Einen Titel weiterempfehlen: "Das musst du sehen."
      CREATE TABLE IF NOT EXISTS recommendations (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        from_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        to_user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        show_id      INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE,

        -- Ein paar Worte dazu, warum. Genau das macht eine Empfehlung aus.
        message      TEXT,

        -- Wurde sie schon gelesen? Steuert den Zähler in der Kopfzeile.
        seen         INTEGER NOT NULL DEFAULT 0,
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),

        -- Denselben Titel nicht zweimal an dieselbe Person – eine erneute
        -- Empfehlung frischt die vorhandene auf, statt sie zu verdoppeln.
        UNIQUE (from_user_id, to_user_id, show_id)
      );

      CREATE INDEX IF NOT EXISTS idx_recommendations_to
        ON recommendations(to_user_id, seen);
    `);
  },

  // -------------------------------------------------------------------------
  // Version 7 -> Einladungen
  // -------------------------------------------------------------------------
  // Damit Freunde mitmachen können, ohne sich mit TMDB, Installation oder
  // Servern zu befassen: Der Betreiber erzeugt einen Link, der Empfänger legt
  // sich damit ein Konto an. Mehr braucht es nicht – der TMDB-Zugang gilt für
  // die ganze Instanz und ist längst hinterlegt.
  //
  // Ein Einladungslink ist bewusst kein dauerhaft offenes Tor: Er lässt sich
  // auf eine Anzahl Nutzungen begrenzen und läuft ab.
  () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS invites (
        -- Zufälliger Token, steht so im Link.
        token       TEXT PRIMARY KEY,

        -- Wer hat eingeladen? Nach dem Löschen des Kontos bleibt die
        -- Einladung gültig – sie gehört zur Instanz, nicht zur Person.
        created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,

        -- Frei wählbare Notiz ("für Lisa"), damit man später weiß, wem man
        -- welchen Link gegeben hat.
        note        TEXT,

        -- Wie oft darf der Link noch benutzt werden? NULL = unbegrenzt.
        uses_left   INTEGER,
        -- Wie oft wurde er schon benutzt? Nur zur Anzeige.
        used_count  INTEGER NOT NULL DEFAULT 0,

        -- Ablaufzeitpunkt als ISO-String. NULL = läuft nie ab.
        expires_at  TEXT,

        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_invites_creator ON invites(created_by);
    `);
  },

  // -------------------------------------------------------------------------
  // Version 8 -> Zwei-Faktor-Anmeldung
  // -------------------------------------------------------------------------
  // Ein Passwort kann gestohlen werden, ohne dass man es merkt. Der zweite
  // Faktor sorgt dafür, dass ein gestohlenes Passwort allein nicht reicht:
  // zusätzlich braucht es einen sechsstelligen Code aus einer App auf dem
  // Telefon, der alle 30 Sekunden wechselt.
  //
  // Streamo verschickt dafür nichts und ruft nichts ab. Server und App teilen
  // sich ein Geheimnis, das einmal beim Einrichten übertragen wird; danach
  // rechnen beide unabhängig dasselbe aus. Das Verfahren steht in src/totp.js.
  //
  // Freiwillig: Wer keinen zweiten Faktor will, merkt von alledem nichts.
  // Passkeys bleiben davon unberührt – sie sind selbst schon zwei Faktoren
  // (Gerät plus Fingerabdruck oder PIN) und verlangen deshalb keinen Code.
  () => {
    // ALTER TABLE kennt kein "IF NOT EXISTS". Deshalb erst nachsehen, welche
    // Spalten es schon gibt – sonst scheitert die Migration mit "duplicate
    // column name", sobald sie ein zweites Mal über dieselbe Datenbank läuft.
    // Genauso halten es die Migrationen 2, 5 und 6 weiter oben.
    const columns = db.prepare('PRAGMA table_info(users)').all();
    const has = (name) => columns.some((column) => column.name === name);

    // Das gemeinsame Geheimnis, Base32. NULL = nie eingerichtet.
    if (!has('totp_secret')) {
      db.exec('ALTER TABLE users ADD COLUMN totp_secret TEXT');
    }

    // Erst 1, wenn die Einrichtung mit einem gültigen Code bestätigt wurde.
    // Zwei Spalten statt einer, damit ein angefangenes, aber nie bestätigtes
    // Geheimnis niemanden aussperrt: Es steht dann zwar da, gilt aber nicht.
    if (!has('totp_enabled')) {
      db.exec('ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0');
    }

    // Wann eingeschaltet? Nur zur Anzeige in den Einstellungen.
    if (!has('totp_enabled_at')) {
      db.exec('ALTER TABLE users ADD COLUMN totp_enabled_at TEXT');
    }

    db.exec(`
      -- Ersatzcodes für den Fall, dass das Telefon weg ist.
      --
      -- Ohne sie wäre ein verlorenes Telefon gleichbedeutend mit einem
      -- verlorenen Konto: Streamo verschickt keine E-Mails, es gäbe also
      -- keinen Weg zurück.
      CREATE TABLE IF NOT EXISTS totp_backup_codes (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,

        -- Verknüpfung zu users. Beim Löschen des Kontos verschwinden die
        -- Codes mit.
        user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

        -- SHA-256 des Codes, nie der Klartext. Ein Ersatzcode ist ein
        -- Passwort; im Klartext gespeichert wäre er wertlos als Schutz.
        code_hash TEXT NOT NULL,

        -- Wann verbraucht? NULL = noch nutzbar. Jeder Code gilt genau einmal,
        -- deshalb wird er nicht gelöscht, sondern entwertet: So lässt sich in
        -- den Einstellungen anzeigen, wie viele noch übrig sind.
        used_at   TEXT,

        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Beim Anmelden wird nach Benutzer und Prüfsumme gesucht.
      CREATE INDEX IF NOT EXISTS idx_backup_codes_user
        ON totp_backup_codes(user_id, code_hash);
    `);
  },

  // -------------------------------------------------------------------------
  // Version 9 -> Eigenes Farbschema je Konto
  // -------------------------------------------------------------------------
  // Streamo war violett, weil sich irgendjemand einmal für Violett entscheiden
  // musste. Warum sollte das für alle gelten? Jede Person wählt jetzt ihre
  // eigene Akzentfarbe und einen Grundton (dunkelblau oder schwarz).
  //
  // Gespeichert wird das an zwei Stellen: im localStorage des Browsers, damit
  // es beim nächsten Start sofort da ist und nichts violett aufblitzt – und
  // hier am Konto, damit dieselbe Farbe auch am Telefon gilt.
  //
  // Als JSON in einer Spalte statt zwei einzelner Spalten: Es ist eine
  // Anzeigeeinstellung, nach der nie gesucht oder sortiert wird, und
  // wahrscheinlich kommt später noch etwas dazu.
  //
  // Verknüpfung: public/js/theme.js liest und schreibt das Format,
  // src/routes/settings.js reicht es durch.
  () => {
    const columns = db.prepare('PRAGMA table_info(users)').all();

    if (!columns.some((column) => column.name === 'theme')) {
      db.exec('ALTER TABLE users ADD COLUMN theme TEXT');
    }
  },

  // -------------------------------------------------------------------------
  // Version 10 -> "Verfügbar bis": wann ein Titel eine Plattform verlässt
  // -------------------------------------------------------------------------
  // Die wichtigste Angabe vorweg: TMDB liefert kein Ablaufdatum. Je Anbieter
  // kommen genau vier Felder zurück – logo_path, provider_id, provider_name
  // und display_priority. Kein Enddatum, in keiner Form. Nachgeprüft in der
  // API-Referenz, nicht aus dem Gedächtnis behauptet.
  //
  // Bekannt wird ein solches Datum also nur, wenn es jemand einträgt – etwa
  // weil Netflix "Letzter Tag: 30. September" anzeigt oder es in der Presse
  // stand. Genau dafür ist diese Tabelle da.
  //
  // Warum eine eigene Tabelle statt einer Spalte in `availability`?
  // Weil src/store.js -> saveAvailability() bei jedem Abgleich zuerst
  // "DELETE FROM availability WHERE show_id = ? AND region = ?" ausführt und
  // danach neu einfügt. Eine Spalte dort wäre stündlich weg. Hier überlebt
  // der Eintrag jeden Abgleich.
  //
  // Der Eintrag gilt für die ganze Instanz, nicht je Person: "Bis wann läuft
  // das bei Netflix" ist eine Tatsache über die Plattform, keine persönliche
  // Einstellung. Wer ihn einträgt, hilft allen anderen mit.
  //
  // Verknüpfungen:
  //   - src/store.js -> buildAvailabilityView() hängt das Datum an die Angebote
  //   - src/routes/shows.js -> Eintragen und Löschen
  //   - public/js/views/detail.js -> die Anzeige samt Countdown
  () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS availability_until (
        show_id     INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE,

        -- Dieselbe Aufteilung wie in availability: Ein Titel kann in
        -- Deutschland im Oktober verschwinden und in Österreich bleiben.
        region      TEXT NOT NULL,
        provider_id INTEGER NOT NULL,

        -- Das Datum selbst, als ISO-Tag (YYYY-MM-DD). Bewusst ohne Uhrzeit:
        -- Anbieter nennen einen Tag, keine Minute.
        available_until TEXT NOT NULL,

        -- Wer hat es eingetragen? Nur zur Anzeige ("von morni ergänzt").
        -- Beim Löschen des Kontos bleibt der Eintrag – die Information über
        -- die Plattform ist ja weiterhin richtig.
        noted_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
        noted_at    TEXT NOT NULL DEFAULT (datetime('now')),

        -- Ein Datum je Titel, Region und Anbieter. Ob der Titel dort im Abo
        -- steckt oder zur Leihe steht, spielt keine Rolle: Er verschwindet
        -- als Ganzes von der Plattform.
        PRIMARY KEY (show_id, region, provider_id)
      );

      -- Für die Abfrage "was läuft demnächst aus?" über alle Titel hinweg.
      CREATE INDEX IF NOT EXISTS idx_until_date
        ON availability_until(available_until);
    `);
  },

  // -------------------------------------------------------------------------
  // Version 11 -> Ein geplanter Termin auf der Merkliste
  // -------------------------------------------------------------------------
  // "Will ich sehen" ist eine Absicht ohne Zeitpunkt. Bei drei Titeln geht das
  // gut, bei dreißig wird die Liste zum Friedhof guter Vorsätze.
  //
  // Deshalb darf man einen Termin dazuschreiben – Freitagabend, das Wochenende,
  // wenn die letzte Staffel erscheint. Ausdrücklich freiwillig: Ohne Datum
  // verhält sich die Merkliste wie bisher, und es gibt keinen Hinweis, dass da
  // etwas fehlen würde.
  //
  // Die Spalte hängt an `library` und nicht an `shows`: Der Termin gehört einer
  // Person. Zwei Leute können dieselbe Serie auf der Liste haben und sie zu
  // verschiedenen Zeiten sehen wollen.
  //
  // Verknüpfungen:
  //   - src/routes/library.js -> setzen über PATCH, sortieren über ?sort=planned
  //   - public/js/views/detail.js -> das Feld dazu
  //   - public/js/ui.js -> die Anzeige auf der Kachel
  () => {
    const columns = db.prepare('PRAGMA table_info(library)').all();

    if (!columns.some((column) => column.name === 'planned_for')) {
      // ISO-Tag (YYYY-MM-DD), NULL = kein Termin. Bewusst ohne Uhrzeit:
      // "Freitag" ist die Genauigkeit, in der man so etwas plant.
      db.exec('ALTER TABLE library ADD COLUMN planned_for TEXT');
    }

    // Für die Sortierung "als Nächstes dran".
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_library_planned ON library(user_id, planned_for)',
    );
  },

  // -------------------------------------------------------------------------
  // Version 12 -> Kalender-Abonnement
  // -------------------------------------------------------------------------
  // Damit die geplanten Termine, auslaufende Titel und neue Episoden im
  // eigenen Kalender stehen – Apple Kalender, Google Kalender, Thunderbird,
  // was auch immer. Das geht über einen ICS-Feed, den man einmal abonniert
  // und der sich danach von selbst aktualisiert.
  //
  // Ein Kalenderprogramm meldet sich nicht an: Es ruft stumpf eine Adresse ab.
  // Der Nachweis muss deshalb IN der Adresse stehen – daher dieser Token. Er
  // ist damit so schutzbedürftig wie ein Passwort, weshalb er
  //   - erst entsteht, wenn jemand den Kalender wirklich abonnieren will,
  //   - sich jederzeit neu erzeugen lässt (alte Abos laufen dann ins Leere).
  //
  // Verknüpfungen:
  //   - src/calendar.js -> baut den Feed
  //   - src/routes/public.js -> liefert ihn ohne Anmeldung aus
  //   - public/js/views/calendar.js -> der Reiter dazu
  () => {
    const columns = db.prepare('PRAGMA table_info(users)').all();

    if (!columns.some((column) => column.name === 'calendar_token')) {
      db.exec('ALTER TABLE users ADD COLUMN calendar_token TEXT');
    }

    // Eindeutig, aber nur dort, wo einer gesetzt ist: Die allermeisten Konten
    // haben keinen, und NULL soll nicht mit NULL kollidieren.
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_calendar_token
        ON users(calendar_token) WHERE calendar_token IS NOT NULL
    `);
  },

  // -------------------------------------------------------------------------
  // Version 13 -> Sehpläne ("jeden Montag zwei Folgen")
  // -------------------------------------------------------------------------
  // So schaut man Serien tatsächlich: nicht irgendwann, sondern in einem
  // Rhythmus. Montags zwei Folgen, sonntags eine, jeden zweiten Abend drei.
  //
  // Ein Sehplan nimmt einem die Buchführung ab: An den festgelegten Tagen
  // hakt Streamo die nächsten Folgen selbst ab. Wer an einem Abend mehr
  // schaut, hakt zusätzlich von Hand ab – der Plan macht danach einfach dort
  // weiter, wo man steht, und zählt nichts doppelt. Genau deshalb merkt sich
  // der Plan NICHT, bei welcher Folge er ist, sondern nimmt jedes Mal die
  // nächsten ungesehenen.
  //
  // Verknüpfungen:
  //   - src/watchplan.js -> die Logik, das automatische Abhaken
  //   - src/routes/shows.js -> anlegen und ändern
  //   - src/calendar.js -> die kommenden Termine im Kalender
  //   - public/js/views/detail.js -> die Einstellung dazu
  () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS watch_plans (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,

        -- Ein Plan gehört einer Person und einer Serie. Zwei Leute können
        -- dieselbe Serie in unterschiedlichem Takt schauen.
        user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        show_id  INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE,

        -- An welchen Wochentagen? Als Komma-Liste von Zahlen, 1 = Montag bis
        -- 7 = Sonntag (ISO-8601). Eine Liste statt eines Bitfelds, weil man
        -- sie in der Datenbank lesen kann, ohne zu rechnen: "1,4" ist
        -- offensichtlich Montag und Donnerstag.
        weekdays TEXT NOT NULL,

        -- Wie viele Folgen an so einem Tag.
        episodes_per_run INTEGER NOT NULL DEFAULT 1
                         CHECK (episodes_per_run BETWEEN 1 AND 20),

        -- Pausieren, ohne den Plan zu verlieren – etwa im Urlaub.
        active   INTEGER NOT NULL DEFAULT 1,

        -- Der letzte Tag, an dem der Plan gelaufen ist. Verhindert, dass ein
        -- Montag zweimal abgehakt wird, und erlaubt das Nachholen: War der
        -- Server am Montag aus, wird am Dienstag nachgeholt.
        last_run_on TEXT,

        created_at TEXT NOT NULL DEFAULT (datetime('now')),

        -- Ein Plan je Person und Serie.
        UNIQUE (user_id, show_id)
      );

      -- Für den Durchlauf "welche Pläne sind heute fällig?".
      CREATE INDEX IF NOT EXISTS idx_watch_plans_active
        ON watch_plans(active, last_run_on);
    `);
  },

  // -------------------------------------------------------------------------
  // Version 14 -> Sprache der Oberfläche je Konto
  // -------------------------------------------------------------------------
  // "de" oder "en". Getrennt von users.language, der Sprache der INHALTE:
  // Die bestimmt, in welcher Sprache TMDB Titel und Beschreibungen liefert,
  // diese hier nur Menüs, Knöpfe und Meldungen. Beides kann auseinanderfallen
  // – englische Oberfläche, deutsche Serientitel ist ein üblicher Wunsch.
  //
  // NULL heißt "nicht festgelegt": Dann gilt, was der Browser sich gemerkt
  // hat oder als Sprache meldet (public/js/i18n.js -> detectLanguage).
  //
  // Verknüpfungen:
  //   - src/auth.js -> getUserBySession() liefert das Feld mit
  //   - src/routes/settings.js -> PUT /api/settings { uiLanguage }
  //   - src/routes/public.js -> Kalender-Feed in dieser Sprache
  //   - public/js/app.js -> stellt die Oberfläche beim Start danach ein
  () => {
    const columns = db.prepare('PRAGMA table_info(users)').all();

    // ALTER TABLE kennt kein IF NOT EXISTS – deshalb vorher nachsehen, wie in
    // den Migrationen 2, 5 und 6.
    if (!columns.some((column) => column.name === 'ui_language')) {
      db.exec('ALTER TABLE users ADD COLUMN ui_language TEXT');
    }
  },

  // -------------------------------------------------------------------------
  // Version 15 -> Uhrzeit für Sehplan und Merklisten-Termin
  // -------------------------------------------------------------------------
  // "Montags um 20:15 zwei Folgen" statt nur "montags zwei Folgen". Mit
  // Uhrzeit wird im Kalender ein Termin mit Anfang und Ende daraus; wie lange
  // er geht, ergibt sich aus der Länge der Folgen bzw. des Films.
  //
  // Format "HH:MM". NULL heißt ohne Uhrzeit – dann bleibt alles ganztägig
  // wie bisher.
  //
  // Verknüpfungen:
  //   - src/watchplan.js -> watch_plans.watch_time; abgehakt wird erst nach
  //                         dem Termin
  //   - src/routes/library.js -> library.planned_time zum Merklisten-Termin
  //   - src/calendar.js -> Termine mit Anfang und Ende, auch im Feed
  () => {
    // ALTER TABLE kennt kein IF NOT EXISTS – deshalb vorher nachsehen.
    const planColumns = db.prepare('PRAGMA table_info(watch_plans)').all();
    if (!planColumns.some((column) => column.name === 'watch_time')) {
      db.exec('ALTER TABLE watch_plans ADD COLUMN watch_time TEXT');
    }

    const libraryColumns = db.prepare('PRAGMA table_info(library)').all();
    if (!libraryColumns.some((column) => column.name === 'planned_time')) {
      db.exec('ALTER TABLE library ADD COLUMN planned_time TEXT');
    }
  },
];

/**
 * Die Schemaversion, auf die dieser Programmstand die Datenbank bringt.
 * Entspricht der Anzahl der Migrationen. Exportiert, damit Tests dagegen
 * prüfen können, ohne bei jeder neuen Migration angepasst werden zu müssen.
 */
export const SCHEMA_VERSION = MIGRATIONS.length;

/**
 * Führt alle noch nicht angewendeten Migrationen der Reihe nach aus.
 * Wird direkt beim Import dieses Moduls aufgerufen.
 */
function runMigrations() {
  // PRAGMA-Abfragen liefern eine Zeile mit dem Wert unter dem Pragma-Namen.
  const current = db.prepare('PRAGMA user_version').get().user_version ?? 0;

  for (let version = current; version < MIGRATIONS.length; version++) {
    MIGRATIONS[version]();
    // Achtung: PRAGMA akzeptiert keine gebundenen Parameter, deshalb wird die
    // Zahl direkt interpoliert. Sie stammt aus einem Schleifenzähler und nicht
    // aus Benutzereingaben – hier gibt es also kein Injection-Risiko.
    db.exec(`PRAGMA user_version = ${version + 1}`);
  }
}

runMigrations();

// --------------------------------------------------------------------------
// Bequeme Kurzformen für die Routen.
// node:sqlite kennt nur prepare().get()/all()/run(); diese drei Helfer sparen
// in den Route-Dateien viel Wiederholung.
// --------------------------------------------------------------------------

/**
 * Liefert die ERSTE Zeile einer Abfrage oder undefined.
 * @param {string} sql SQL mit ?-Platzhaltern
 * @param {...any} params Werte für die Platzhalter (immer gebunden, nie
 *   per String-Verkettung – das ist der Schutz gegen SQL-Injection)
 * @returns {object|undefined}
 */
export function get(sql, ...params) {
  return db.prepare(sql).get(...params);
}

/**
 * Liefert ALLE Zeilen einer Abfrage als Array.
 * @param {string} sql
 * @param {...any} params
 * @returns {object[]}
 */
export function all(sql, ...params) {
  return db.prepare(sql).all(...params);
}

/**
 * Führt eine schreibende Anweisung aus (INSERT/UPDATE/DELETE).
 * @param {string} sql
 * @param {...any} params
 * @returns {{changes: number|bigint, lastInsertRowid: number|bigint}}
 */
export function run(sql, ...params) {
  return db.prepare(sql).run(...params);
}

/**
 * Führt eine Funktion in einer Transaktion aus.
 *
 * Entweder alle Schreibvorgänge darin gelten, oder keiner. Genutzt z. B. beim
 * Speichern der Verfügbarkeiten: Erst werden die alten Zeilen einer Serie
 * gelöscht, dann die neuen eingefügt – bräche es dazwischen ab, stünde die
 * Serie ohne jede Verfügbarkeit da.
 *
 * @template T
 * @param {() => T} fn Auszuführende Arbeit
 * @returns {T} Rückgabewert von fn
 */
export function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    // ROLLBACK darf selbst nicht werfen und den ursprünglichen Fehler
    // verschlucken – z. B. wenn die Transaktion schon abgebrochen wurde.
    try {
      db.exec('ROLLBACK');
    } catch {
      /* bewusst ignoriert */
    }
    throw error;
  }
}

// --------------------------------------------------------------------------
// Zugriff auf die Tabelle `settings`.
// Diese beiden Funktionen sind die einzige erlaubte Art, globale
// Einstellungen zu lesen/schreiben (genutzt von src/tmdb.js, routes/setup.js
// und routes/settings.js).
// --------------------------------------------------------------------------

/**
 * Liest eine globale Einstellung.
 * @param {string} key
 * @param {string|null} fallback Wert, wenn der Schlüssel fehlt
 * @returns {string|null}
 */
export function getSetting(key, fallback = null) {
  const row = get('SELECT value FROM settings WHERE key = ?', key);
  return row?.value ?? fallback;
}

/**
 * Schreibt eine globale Einstellung (UPSERT).
 * ON CONFLICT aktualisiert den vorhandenen Schlüssel, statt zu scheitern.
 * @param {string} key
 * @param {string|number|null} value
 */
export function setSetting(key, value) {
  run(
    `INSERT INTO settings (key, value, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                    updated_at = excluded.updated_at`,
    key,
    value === null || value === undefined ? null : String(value),
  );
}

export default db;
