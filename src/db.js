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
