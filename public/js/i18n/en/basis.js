/**
 * ---------------------------------------------------------------------------
 * public/js/i18n/en/basis.js – Englisch: Grundbausteine
 * ---------------------------------------------------------------------------
 * Navigation und feste Texte aus index.html, die Bausteine aus ui.js
 * (Status, Angebotsarten, Zeitangaben, Dialoge), die Anmeldung
 * (views/auth.js, passkey.js), der Kalender, Farben und Länder.
 *
 * Aufbau: links der deutsche Text genau so, wie er im Code steht – er ist
 * der Schlüssel –, rechts die Übersetzung. {0}, {1} … sind Platzhalter für
 * eingesetzte Werte; was dort steht, wird selbst wieder übersetzt.
 *
 * Verknüpfungen:
 *   - public/js/i18n/en.js -> führt alle Teile zusammen
 *   - public/js/i18n.js    -> schlägt hier nach
 * ---------------------------------------------------------------------------
 */

export default {
  // --- Navigation und index.html -------------------------------------------
  Entdecken: 'Discover',
  Bibliothek: 'Library',
  Anbieter: 'Providers',
  Statistik: 'Statistics',
  Reihen: 'Collections',
  Kalender: 'Calendar',
  Freunde: 'Friends',
  Erfolge: 'Achievements',
  Einstellungen: 'Settings',
  Abmelden: 'Sign out',
  Konto: 'Account',
  Suche: 'Search',
  // Kurz gehalten: Die englische Navigation ist breiter, und bei 1360 Pixeln
  // bleibt der Suche neben der mittigen Navigation nur wenig Platz.
  'Serie oder Film suchen …': 'Search shows & films …',
  'Streamo startet …': 'Streamo is starting …',
  '· Daten von': '· Data from',
  '· Streaming-Verfügbarkeit von': '· Streaming availability from',
  'Dieses Produkt verwendet die TMDB-API, ist aber weder von TMDB unterstützt noch zertifiziert.':
    'This product uses the TMDB API but is not endorsed or certified by TMDB.',
  'Region {0}': 'Region {0}',

  // --- app.js ------------------------------------------------------------------
  'Es ist kein TMDB-API-Key hinterlegt. Ohne ihn bleiben Suche und Streaming-Anbieter leer.':
    'No TMDB API key has been set. Without it, search and streaming providers stay empty.',
  'Jetzt eintragen': 'Add it now',
  'Das hat nicht geklappt': 'That did not work',
  'Erneut versuchen': 'Try again',
  'Liste wird geladen …': 'Loading list …',
  'Einladung wird geprueft …': 'Checking invitation …',
  'Einladung ungueltig': 'Invalid invitation',
  'Bitte die Person fragen, die dich eingeladen hat - sie kann einen neuen Link erzeugen.':
    'Please ask the person who invited you – they can create a new link.',
  'Abgemeldet.': 'Signed out.',
  'Keine Verbindung': 'No connection',
  'Streamo konnte den Server nicht erreichen: {0}': 'Streamo could not reach the server: {0}',
  'Neu laden': 'Reload',
  'Fehler {0}': 'Error {0}',

  // --- router.js -----------------------------------------------------------------
  'Seite nicht gefunden': 'Page not found',
  'Für "{0}" gibt es hier nichts.': 'There is nothing here for "{0}".',
  'Zur Startseite': 'Go to the start page',

  // --- ui.js: Dialoge, Teilen, Ladeanzeigen ---------------------------------------
  Weiter: 'Continue',
  Abbrechen: 'Cancel',
  Ja: 'Yes',
  Schließen: 'Close',
  'Lädt …': 'Loading …',
  'Wer den Link hat, sieht die Liste – ohne Konto und ohne Anmeldung.':
    'Anyone with the link can see the list – no account, no sign-in.',
  'Link kopieren': 'Copy link',
  '✓ Kopiert': '✓ Copied',
  'Link kopiert – jetzt einfach einfügen und verschicken.': 'Link copied – just paste it and send it.',
  'Kopieren nicht möglich – der Link ist markiert, jetzt Strg+C.':
    'Copying is not possible here – the link is selected, press Ctrl+C.',
  'E-Mail': 'Email',
  'Oder den Link selbst weitergeben': 'Or pass on the link yourself',
  'ERFOLG FREIGESCHALTET': 'ACHIEVEMENT UNLOCKED',

  // --- ui.js: Zeit und Dauer -------------------------------------------------------
  '{0} Std. {1} Min.': '{0} h {1} min',
  '{0} Min.': '{0} min',
  '{0} Std.': '{0} h',
  '⏰ überfällig': '⏰ overdue',
  '📅 Heute': '📅 Today',
  '📅 Morgen': '📅 Tomorrow',
  'gerade eben': 'just now',
  nie: 'never',
  'vor {0} Min.': '{0} min ago',
  'vor {0} Std.': '{0} h ago',
  'vor {0} Tagen': '{0} days ago',

  // --- ui.js: Status und Angebote -----------------------------------------------------
  'Will ich sehen': 'Want to watch',
  'Schaue ich': 'Watching',
  Gesehen: 'Watched',
  Pausiert: 'Paused',
  Abgebrochen: 'Dropped',
  'Im Abo enthalten': 'Included in subscription',
  Kostenlos: 'Free',
  'Kostenlos mit Werbung': 'Free with ads',
  Leihen: 'Rent',
  Kaufen: 'Buy',
  'Im Abo': 'Included',
  'Bei {0} nur noch bis zum {1}': 'On {0} only until {1}',
  'Letzter Tag': 'Last day',
  'Noch 1 Tag': '1 day left',
  'Noch {0} Tage': '{0} days left',
  '{0}/{1} Episoden': '{0}/{1} episodes',

  // --- passkey.js ----------------------------------------------------------------------
  'Abgebrochen. Bestätige den Dialog deines Geräts, um fortzufahren.':
    "Cancelled. Confirm your device's prompt to continue.",
  'Für dieses Konto ist auf diesem Gerät bereits ein Passkey hinterlegt.':
    'This device already holds a passkey for this account.',
  'Dein Gerät unterstützt diese Art von Passkey nicht.': 'Your device does not support this kind of passkey.',
  'Passkeys sind unter dieser Adresse nicht erlaubt. Streamo muss über HTTPS und einen Hostnamen erreichbar sein.':
    'Passkeys are not allowed at this address. Streamo has to be reachable via HTTPS and a host name.',
  'Der Vorgang wurde abgebrochen.': 'The operation was cancelled.',
  'Der Passkey konnte nicht verwendet werden.': 'The passkey could not be used.',
  'Es wurde kein Passkey erzeugt.': 'No passkey was created.',
  'Es wurde kein Passkey ausgewählt.': 'No passkey was selected.',

  // --- theme.js --------------------------------------------------------------------------
  Violett: 'Violet',
  Rot: 'Red',
  Grün: 'Green',
  Blau: 'Blue',
  Türkis: 'Turquoise',
  Dunkelblau: 'Dark blue',
  Schwarz: 'Black',

  // --- Länder und Inhaltssprachen (Einrichtung und Einstellungen) --------------------------
  Deutschland: 'Germany',
  Österreich: 'Austria',
  Schweiz: 'Switzerland',
  Großbritannien: 'United Kingdom',
  Frankreich: 'France',
  Italien: 'Italy',
  Spanien: 'Spain',
  Niederlande: 'Netherlands',
  Polen: 'Poland',
  Deutsch: 'German',
  Englisch: 'English',
  Französisch: 'French',
  Italienisch: 'Italian',
  Spanisch: 'Spanish',
  Niederländisch: 'Dutch',

  // --- views/auth.js: Einrichtung, Einladung, Anmeldung --------------------------------------
  'Wird eingerichtet …': 'Setting up …',
  'Willkommen bei Streamo!': 'Welcome to Streamo!',
  'Streamo einrichten': 'Set up Streamo',
  Benutzername: 'Username',
  'z. B. max': 'e.g. max',
  Passwort: 'Password',
  'Mindestens 8 Zeichen.': 'At least 8 characters.',
  'E-Mail (optional)': 'Email (optional)',
  'Nur als zweiter Anmeldename. Streamo verschickt keine E-Mails und braucht keinen Mailserver.':
    'Only used as a second sign-in name. Streamo sends no emails and needs no mail server.',
  'Anzeigename (optional)': 'Display name (optional)',
  'Max Mustermann': 'Jane Doe',
  'TMDB-API-Key': 'TMDB API key',
  'API Read Access Token oder API Key': 'API Read Access Token or API key',
  'Kostenlos unter themoviedb.org → Einstellungen → API. Beide Schlüsselarten funktionieren. Kann auch später eingetragen werden.':
    'Free at themoviedb.org → Settings → API. Both kinds of key work. You can also add it later.',
  'Deine Region': 'Your region',
  'Sprache der Inhalte': 'Content language',
  'Noch drei Angaben, dann gehören alle deine Streaming-Abos an einen Ort.':
    'Three more details, and all your streaming subscriptions live in one place.',
  'Konto wird angelegt …': 'Creating account …',
  'Konto anlegen': 'Create account',
  'z. B. lisa': 'e.g. lisa',
  'Du bist eingeladen': "You're invited",
  'Leg dir ein Konto an – mehr braucht es nicht. Alles Weitere ist schon eingerichtet.':
    "Create an account – that's all it takes. Everything else is already set up.",
  'Du brauchst keinen eigenen Zugang zu einer Filmdatenbank und musst nichts installieren. Sobald du angemeldet bist, klickst du nur noch deine Streaming-Abos an.':
    "You don't need your own film database access and nothing has to be installed. Once you're signed in, just tick your streaming subscriptions.",
  'Wird geprüft …': 'Checking …',
  'Ersatzcode verwendet. Es sind noch {0} übrig.': 'Backup code used. {0} left.',
  Bestätigen: 'Confirm',
  'Code aus deiner App': 'Code from your app',
  'Sechs Ziffern. Du kannst hier auch einen deiner Ersatzcodes eingeben.':
    'Six digits. You can also enter one of your backup codes here.',
  'Noch ein Schritt': 'One more step',
  'Dein Passwort stimmt. Gib jetzt den Code aus deiner Authenticator-App ein.':
    'Your password is correct. Now enter the code from your authenticator app.',
  'Nur als zweiter Anmeldename. Streamo verschickt keine E-Mails.':
    'Only used as a second sign-in name. Streamo sends no emails.',
  Einladungscode: 'Invitation code',
  'Code aus der Einladung': 'Code from the invitation',
  'Auf dieser Instanz braucht es eine Einladung. Hast du einen Link bekommen, kannst du ihn auch einfach öffnen.':
    'This instance requires an invitation. If you received a link, you can simply open it.',
  'Zwei Angaben, dann gehören alle deine Streaming-Abos an einen Ort.':
    'Two details, and all your streaming subscriptions live in one place.',
  'Für ein Konto auf dieser Instanz brauchst du eine Einladung.':
    'You need an invitation for an account on this instance.',
  'Du hast schon ein Konto?': 'Already have an account?',
  Anmelden: 'Sign in',
  'Warte auf dein Gerät …': 'Waiting for your device …',
  '🔑 Mit Passkey anmelden': '🔑 Sign in with a passkey',
  'oder mit Passwort': 'or with a password',
  'Anmelden …': 'Signing in …',
  'Benutzername oder E-Mail': 'Username or email',
  'Alle Abos an einem Ort. Melde dich an.': 'All your subscriptions in one place. Sign in.',
  'Noch kein Konto?': 'No account yet?',
  'Konto erstellen': 'Create account',
  '🔑 Mit Windows Hello anmelden': '🔑 Sign in with Windows Hello',
  '🔑 Mit Touch ID oder Face ID anmelden': '🔑 Sign in with Touch ID or Face ID',

  // --- views/achievements.js -------------------------------------------------------------------
  'Erreicht am {0}': 'Unlocked on {0}',
  // Vorlage für t() in views/achievements.js – benannte Platzhalter, also nie ein Muster.
  '{current} von {goal}': '{current} of {goal}',
  '{0} von {1} freigeschaltet ({2} %)': '{0} of {1} unlocked ({2} %)',
  'Freigeschaltet ({0})': 'Unlocked ({0})',
  'Noch offen ({0})': 'Still open ({0})',
  'Noch keine Erfolge': 'No achievements yet',
  'Sieh dir etwas an, dann füllt sich diese Seite.': 'Watch something and this page will fill up.',

  // --- views/calendar.js -------------------------------------------------------------------------
  Mo: 'Mon',
  Di: 'Tue',
  Mi: 'Wed',
  Do: 'Thu',
  Fr: 'Fri',
  Sa: 'Sat',
  So: 'Sun',
  'In deinem Kalender': 'In your calendar',
  'Einmal abonnieren, danach hält sich der Kalender von selbst aktuell. Neue Termine erscheinen automatisch.':
    'Subscribe once and the calendar keeps itself up to date. New dates appear automatically.',
  '🍎 Apple Kalender': '🍎 Apple Calendar',
  'Öffnet Apple Kalender (Mac, iPhone, iPad)': 'Opens Apple Calendar (Mac, iPhone, iPad)',
  '📆 Google Kalender': '📆 Google Calendar',
  'Öffnet Google Kalender im Browser': 'Opens Google Calendar in the browser',
  'Öffnet Outlook im Browser': 'Opens Outlook in the browser',
  'Passiert beim Klick nichts? Dann ist auf diesem Gerät kein Kalenderprogramm dafür eingerichtet – nimm die Adresse unten und füge sie von Hand ein. Das funktioniert überall.':
    "Nothing happens when you click? Then no calendar app is set up for it on this device – take the address below and add it by hand. That works everywhere.",
  'Adresse kopieren': 'Copy address',
  'Adresse kopiert – in deinem Kalender einfügen.': 'Address copied – paste it into your calendar.',
  'Kopieren nicht möglich – die Adresse ist markiert, Strg+C.':
    'Copying is not possible here – the address is selected, press Ctrl+C.',
  'Adresse zum Abonnieren': 'Subscription address',
  'Apple Kalender: Ablage → Neues Kalenderabonnement. Google Kalender: Weitere Kalender → Per URL. Am iPhone: Einstellungen → Kalender → Accounts → Account hinzufügen → Andere → Kalenderabo.':
    'Apple Calendar: File → New Calendar Subscription. Google Calendar: Other calendars → From URL. On iPhone: Settings → Calendar → Accounts → Add Account → Other → Add Subscribed Calendar.',
  'Ein Kalenderprogramm kann sich nicht anmelden – deshalb steckt der Nachweis in der Adresse. Wer sie kennt, sieht, was du dir vorgenommen hast. Gib sie nicht weiter.':
    "A calendar app can't sign in – so the proof is part of the address. Anyone who knows it can see what you have planned. Don't share it.",
  'Neue Adresse erzeugen': 'Create a new address',
  'Bestehende Abonnements laufen danach ins Leere': 'Existing subscriptions will stop working',
  'Neue Adresse erzeugen?': 'Create a new address?',
  'Alle Kalender, die den bisherigen Link abonniert haben, zeigen danach nichts mehr an. Du müsstest sie neu abonnieren.':
    'All calendars subscribed to the old link will stop showing anything. You would have to subscribe again.',
  'Neu erzeugen': 'Create new',
  'Neue Adresse erzeugt. Bestehende Abos musst du erneuern.':
    'New address created. You need to renew existing subscriptions.',
  'Voriger Monat': 'Previous month',
  'Nächster Monat': 'Next month',
  Heute: 'Today',
  '📅 Abonnieren': '📅 Subscribe',
  'In Apple Kalender, Google Kalender oder Thunderbird einbinden':
    'Add to Apple Calendar, Google Calendar or Thunderbird',
  Vorgemerkt: 'Planned',
  'Läuft aus': 'Leaving soon',
  'Neue Episode': 'New episode',
  Sehplan: 'Watch plan',
  'Noch nichts eingetragen. Trag bei einem Titel auf deiner Merkliste ein, wann du ihn sehen willst – auslaufende Angebote und neue Episoden erscheinen von selbst.':
    'Nothing planned yet. Set a date on a title in your watchlist – leaving titles and new episodes appear on their own.',
};
