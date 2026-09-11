/**
 * ---------------------------------------------------------------------------
 * public/js/i18n/en/server.js – Englisch: Texte, die der Server schickt
 * ---------------------------------------------------------------------------
 * Der Server antwortet weiterhin auf Deutsch. Übersetzt wird dort, wo die
 * Texte sichtbar werden: im Browser, weil Fehlermeldungen als Einblendung
 * und Erfolge, Kalendereinträge und Empfehlungsgründe über el() laufen.
 * Nur der Kalender-Feed für Apple und Google Kalender wird auf dem Server
 * übersetzt (src/routes/public.js) – ein Kalenderprogramm hat kein el().
 *
 * Herkunft der Einträge:
 *   Fehlermeldungen  -> src/routes/*.js, src/auth.js, src/invites.js,
 *                       src/twofactor.js, src/passkeys.js, src/tmdb.js …
 *   Erfolge          -> src/achievements.js
 *   Kalender         -> src/calendar.js
 *   Empfehlungen     -> src/recommend.js
 *
 * Verknüpfungen:
 *   - public/js/i18n/en.js -> führt alle Teile zusammen
 * ---------------------------------------------------------------------------
 */

export default {
  // --- Anmeldung, Konten, Passkeys ----------------------------------------------------
  'Benutzername muss mindestens 3 Zeichen haben.': 'Username must be at least 3 characters.',
  'Passwort muss mindestens 8 Zeichen haben.': 'Password must be at least 8 characters.',
  'Dieser Benutzername ist bereits vergeben.': 'This username is already taken.',
  'Das sieht nicht nach einer E-Mail-Adresse aus.': "That doesn't look like an email address.",
  'Diese E-Mail-Adresse wird bereits verwendet.': 'This email address is already in use.',
  'Nicht angemeldet.': 'Not signed in.',
  'Dafür brauchst du Administratorrechte.': 'You need administrator rights for that.',
  'Zu viele Anmeldeversuche. Bitte warte einen Moment.': 'Too many sign-in attempts. Please wait a moment.',
  'Zu viele Code-Versuche. Bitte warte einen Moment.': 'Too many code attempts. Please wait a moment.',
  'Zu viele Versuche. Bitte warte eine Weile.': 'Too many attempts. Please wait a while.',
  'Zu viele Versuche. Bitte warte {0} Sekunden.': 'Too many attempts. Please wait {0} seconds.',
  'Streamo ist bereits eingerichtet.': 'Streamo is already set up.',
  'Benutzername oder Passwort ist falsch.': 'Username or password is wrong.',
  'Das Passwort stimmt nicht.': 'The password is wrong.',
  'Der zweite Faktor ist nicht eingeschaltet.': 'The second factor is not turned on.',
  'Für ein Konto auf dieser Instanz brauchst du eine Einladung. Frag die Person, die Streamo betreibt.':
    'You need an invitation for an account on this instance. Ask the person who runs Streamo.',
  'Aktuelles Passwort ist falsch.': 'Current password is wrong.',
  'Neues Passwort muss mindestens 8 Zeichen haben.': 'New password must be at least 8 characters.',
  'Passkey nicht gefunden.': 'Passkey not found.',
  'Das ist dein letzter Anmeldeweg. Lege vorher ein Passwort oder einen weiteren Passkey an.':
    'This is your last way to sign in. Create a password or another passkey first.',
  'Lege zuerst einen Passkey an, sonst kommst du nicht mehr in dein Konto.':
    "Create a passkey first, otherwise you can't get into your account any more.",
  'Die Adresse konnte nicht bestimmt werden.': 'The address could not be determined.',
  'Passkeys funktionieren nicht über eine IP-Adresse. Richte einen Hostnamen ein, zum Beispiel streamo.deine-domain.de.':
    "Passkeys don't work via an IP address. Set up a host name, for example streamo.your-domain.com.",
  'Streamo hält die Verbindung für unverschlüsselt. Wenn dein Reverse Proxy HTTPS ausliefert, setze in der .env TRUST_PROXY=true.':
    'Streamo considers the connection unencrypted. If your reverse proxy serves HTTPS, set TRUST_PROXY=true in the .env.',
  'Passkeys brauchen HTTPS. Stelle einen Reverse Proxy mit Zertifikat davor oder aktiviere HTTPS in Streamo (ENABLE_HTTPS=true).':
    'Passkeys need HTTPS. Put a reverse proxy with a certificate in front or enable HTTPS in Streamo (ENABLE_HTTPS=true).',
  'Der Vorgang ist abgelaufen. Bitte versuche es noch einmal.': 'The operation has expired. Please try again.',
  'Der Vorgang gehört zu einem anderen Konto.': 'The operation belongs to another account.',
  'Der Passkey konnte nicht überprüft werden.': 'The passkey could not be verified.',
  'Unbenanntes Gerät': 'Unnamed device',
  'Der Anmeldevorgang ist abgelaufen. Bitte versuche es noch einmal.': 'The sign-in has expired. Please try again.',
  'Dieser Passkey ist hier nicht hinterlegt.': 'This passkey is not registered here.',
  'Die Anmeldung konnte nicht bestätigt werden.': 'The sign-in could not be confirmed.',
  'Das zugehörige Konto existiert nicht mehr.': 'The associated account no longer exists.',

  // --- Zwei-Faktor ----------------------------------------------------------------------------
  'Die Anmeldung ist abgelaufen. Bitte melde dich noch einmal an.': 'The sign-in has expired. Please sign in again.',
  'Zu viele Fehlversuche. Bitte melde dich noch einmal an.': 'Too many failed attempts. Please sign in again.',
  'Der Code stimmt nicht. Achte darauf, den aktuellen zu nehmen.': 'The code is wrong. Make sure to use the current one.',
  'Der zweite Faktor ist bereits eingeschaltet.': 'The second factor is already turned on.',
  'Es wurde noch keine Einrichtung begonnen.': 'No setup has been started yet.',
  'Der Code stimmt nicht. Prüfe, ob die Uhrzeit deines Telefons richtig geht.':
    "The code is wrong. Check that your phone's clock is correct.",

  // --- Einladungen ---------------------------------------------------------------------------
  'Kein Einladungscode angegeben.': 'No invitation code given.',
  'Diese Einladung gibt es nicht.': 'This invitation does not exist.',
  'Diese Einladung wurde bereits verwendet.': 'This invitation has already been used.',
  'Diese Einladung ist abgelaufen.': 'This invitation has expired.',

  // --- Einstellungen und Verwaltung -------------------------------------------------------------
  'Region muss ein Länderkürzel wie "DE" sein.': 'Region must be a country code like "DE".',
  'Die Akzentfarbe muss eine Farbe wie "#f39c12" sein.': 'The accent colour must be a colour like "#f39c12".',
  'Unbekannter Grundton.': 'Unknown base tone.',
  'Unbekannte Sprache.': 'Unknown language.',
  'Keine Änderungen übergeben.': 'No changes given.',
  'Der Takt muss zwischen 0 (aus) und 168 Stunden liegen.': 'The interval must be between 0 (off) and 168 hours.',
  'Der Schlüssel funktioniert.': 'The key works.',
  'Dieses Konto gibt es nicht.': 'This account does not exist.',
  'Du kannst dir die Adminrechte nicht selbst nehmen. Lass das jemand anderen tun.':
    "You can't remove your own admin rights. Let someone else do it.",
  'Das ist der einzige Administrator. Gib zuerst jemand anderem die Rechte.':
    'This is the only administrator. Give someone else the rights first.',
  'Du kannst dein eigenes Konto hier nicht löschen. Lass das jemand anderen mit Adminrechten tun.':
    "You can't delete your own account here. Let someone else with admin rights do it.",
  'Zur Bestätigung muss der Benutzername „{0}" genau so eingegeben werden.':
    'To confirm, the username "{0}" must be entered exactly like that.',

  // --- TMDB und Abgleich ------------------------------------------------------------------------
  'Kein TMDB-API-Key hinterlegt. Trage ihn in den Einstellungen ein.': 'No TMDB API key set. Add it in the settings.',
  'Kein TMDB-API-Key hinterlegt.': 'No TMDB API key set.',
  'TMDB hat nicht rechtzeitig geantwortet.': "TMDB didn't respond in time.",
  'TMDB nicht erreichbar: {0}': 'TMDB not reachable: {0}',
  'TMDB-Fehler {0}': 'TMDB error {0}',
  'TMDB-API-Key ungültig. Bitte in den Einstellungen prüfen.': 'TMDB API key invalid. Please check it in the settings.',
  'Es läuft bereits ein Abgleich.': 'A sync is already running.',
  '{0} Einträge aktualisiert.': '{0} entries updated.',
  '{0} aktualisiert, {1} Probleme: {2}': '{0} updated, {1} problems: {2}',
  'Fehlgeschlagen: {0}': 'Failed: {0}',
  'Unerwarteter Fehler. Details stehen im Protokoll des Servers.': 'Unexpected error. Details are in the server log.',
  'Unerwarteter Fehler.': 'Unexpected error.',
  'Unbekannter Endpunkt: {0} {1}': 'Unknown endpoint: {0} {1}',
  '(ohne Titel)': '(untitled)',

  // --- Bibliothek, Titel, Sehpläne ----------------------------------------------------------------
  'Ungültige TMDB-ID.': 'Invalid TMDB ID.',
  'Ungültige TMDB-Kennung.': 'Invalid TMDB ID.',
  'Nicht in deiner Bibliothek.': 'Not in your library.',
  'Unbekannter Status.': 'Unknown status.',
  'Bewertung muss zwischen 1 und 10 liegen.': 'Rating must be between 1 and 10.',
  'Bitte ein Datum im Format JJJJ-MM-TT angeben.': 'Please enter a date in the format YYYY-MM-DD.',
  'Ungültige Importdatei.': 'Invalid import file.',
  'Serie unbekannt.': 'Unknown show.',
  'Episode unbekannt.': 'Unknown episode.',
  'Es fehlt der Anbieter.': 'The provider is missing.',
  'Das Datum liegt in der Vergangenheit.': 'The date is in the past.',
  'Ein Sehplan geht nur bei Serien.': 'Watch plans only work for shows.',
  'Nimm die Serie zuerst in deine Bibliothek auf.': 'Add the show to your library first.',
  'Wähle mindestens einen Wochentag.': 'Pick at least one weekday.',
  'Zwischen 1 und 20 Folgen je Termin.': 'Between 1 and 20 episodes each time.',
  'Ungültige Anbieter-ID.': 'Invalid provider ID.',

  // --- Filmreihen ---------------------------------------------------------------------------------
  'Unbenannte Reihe': 'Untitled collection',
  'Die Reihe braucht einen Namen.': 'The collection needs a name.',
  'Ungültige Kennung der Filmreihe.': 'Invalid collection ID.',
  'Diese Filmreihe gibt es nicht.': 'This collection does not exist.',
  'Diese Reihe gehört dir nicht. Offizielle Filmreihen lassen sich nicht ändern.':
    "This collection isn't yours. Official collection can't be changed.",
  'Der Name darf nicht leer sein.': 'The name must not be empty.',
  'Diese Reihe gehört dir nicht.': "This collection isn't yours.",
  'Der Titel ist nicht in dieser Reihe.': 'The title is not in this collection.',
  'Diese Reihe gibt es nicht, oder sie gehört jemand anderem.': "This collection doesn't exist, or it belongs to someone else.",
  'Nur die Freigabe deiner eigenen Reihen lässt sich zurücknehmen.': 'You can only withdraw sharing for your own collections.',
  'Diese Reihe gehört dir nicht. Offizielle Filmreihen lassen sich nicht umsortieren.':
    "This collection isn't yours. Official collection can't be reordered.",
  'Diese Liste gibt es nicht (mehr). Vielleicht wurde die Freigabe zurückgenommen.':
    "This list doesn't exist (any more). Maybe sharing was withdrawn.",

  // --- Freunde ----------------------------------------------------------------------------------
  'Mit dir selbst kannst du dich nicht befreunden.': "You can't befriend yourself.",
  'Ihr seid bereits befreundet.': "You're already friends.",
  'Du hast bereits angefragt. Warte auf die Antwort.': "You've already sent a request. Wait for the answer.",
  'Anfrage verschickt.': 'Request sent.',
  'Empfehlen kannst du nur an Freunde.': 'You can only recommend to friends.',
  'Diese Empfehlung gibt es nicht.': 'This recommendation does not exist.',
  'Unter diesem Namen gibt es hier niemanden.': "There's nobody here by that name.",
  'Es gibt keine offene Anfrage von dieser Person.': "There's no open request from this person.",
  'Da gibt es nichts zu beenden.': "There's nothing to end.",
  'Die Bibliothek siehst du erst, wenn ihr befreundet seid.': "You'll only see the library once you're friends.",
  'Vorschläge gibt es erst, wenn ihr befreundet seid.': "Suggestions only appear once you're friends.",

  // --- Empfehlungen (src/recommend.js) ---------------------------------------------------------------
  'Sieh dir ein paar Serien oder Filme an, dann entsteht hier eine Empfehlung.':
    'Watch a few shows or films and a recommendation appears here.',
  'deinen Vorlieben ({0})': 'your taste ({0})',
  'Zu deinen Titeln hat TMDB nichts Passendes gefunden.': "TMDB didn't find anything matching your titles.",
  'Passt zu deiner Bibliothek': 'Fits your library',
  'Weil du {0} gesehen hast': 'Because you watched {0}',
  'Weil du {0} und {1} gesehen hast': 'Because you watched {0} and {1}',
  'Weil du {0}, {1} und {2} weitere gesehen hast': 'Because you watched {0}, {1} and {2} more',

  // --- Kalender (src/calendar.js) ---------------------------------------------------------------------
  'Du hast dir vorgenommen, {0} zu sehen.': 'You planned to watch {0}.',
  'dem Anbieter': 'the provider',
  'diese Serie': 'this show',
  'diesen Film': 'this film',
  '⏳ Letzter Tag: {0}': '⏳ Last day: {0}',
  'Letzter Tag: {0}': 'Last day: {0}',
  '„{0}" verlässt {1} nach diesem Tag.': '"{0}" leaves {1} after this day.',
  '{0} erscheint heute.': '{0} is released today.',
  'Nach deinem Sehplan. Streamo hakt die Folgen an diesem Tag automatisch ab.':
    'Per your watch plan. Streamo ticks off the episodes automatically on this day.',
  '{0}: {1} Folge': '{0}: {1} episode',
  '{0}: {1} Folgen': '{0}: {1} episodes',
  'Geplante Titel, auslaufende Angebote und neue Episoden aus Streamo.':
    'Planned titles, leaving offers and new episodes from Streamo.',
  'Streamo – {0}': 'Streamo – {0}',
  'Dieser Kalender existiert nicht (mehr).': "This calendar doesn't exist (any more).",

  // --- Erfolge (src/achievements.js) -----------------------------------------------------------------
  Regelbrecher: 'Rule Breaker',
  'Alles von Dr. House gesehen. Everybody lies – aber du hast durchgehalten.':
    'Watched all of House. Everybody lies – but you stuck with it.',
  Heisenberg: 'Heisenberg',
  'Breaking Bad vollständig gesehen. Say my name.': 'Watched all of Breaking Bad. Say my name.',
  'Der Eiserne Thron': 'The Iron Throne',
  'Game of Thrones bis zum Ende. Auch durch die letzte Staffel.': 'Game of Thrones to the end. Even through the final season.',
  Familienoberhaupt: 'Head of the Family',
  'Die Sopranos komplett gesehen.': 'Watched all of The Sopranos.',
  'Alle Ecken abgeklappert': 'Worked Every Corner',
  'The Wire vollständig gesehen.': 'Watched all of The Wire.',
  'Ay Caramba': 'Ay Caramba',
  'Alle Simpsons gesehen. Das sind über 700 Episoden.': "Watched all of The Simpsons. That's over 700 episodes.",
  'Der siebte Freund': 'The Seventh Friend',
  'Friends komplett gesehen. I’ll be there for you.': 'Watched all of Friends. I’ll be there for you.',
  'Weltbester Chef': "World's Best Boss",
  'The Office vollständig gesehen.': 'Watched all of The Office.',
  Überlebender: 'Survivor',
  'The Walking Dead durchgestanden.': 'Made it through The Walking Dead.',
  'Aus der Anderswelt': 'From the Upside Down',
  'Stranger Things vollständig gesehen.': 'Watched all of Stranger Things.',
  'Höchst deduktiv': 'Most Deductive',
  'Sherlock komplett gesehen.': 'Watched all of Sherlock.',
  'Wubba Lubba Dub Dub': 'Wubba Lubba Dub Dub',
  'Rick and Morty vollständig gesehen.': 'Watched all of Rick and Morty.',
  'Die Frage ist nicht wer, sondern wann': "The Question Isn't Who, But When",
  'Dark komplett gesehen – und hoffentlich verstanden.': 'Watched all of Dark – and hopefully understood it.',
  'Was kostet eine Lüge?': 'What Is the Cost of Lies?',
  'Chernobyl vollständig gesehen.': 'Watched all of Chernobyl.',
  'Ist es rechtens?': 'Is It Legal?',
  'Better Call Saul komplett gesehen.': 'Watched all of Better Call Saul.',
  'Die Eulen sind nicht, was sie scheinen': 'The Owls Are Not What They Seem',
  'Twin Peaks vollständig gesehen.': 'Watched all of Twin Peaks.',
  'Die Wahrheit ist irgendwo da draußen': 'The Truth Is Out There',
  'Akte X komplett gesehen.': 'Watched all of The X-Files.',
  'Nicht alle Fragen beantwortet': 'Not Every Question Answered',
  'Lost bis zum Ende gesehen.': 'Watched Lost to the end.',
  'Der Anfang': 'The Beginning',
  'Die erste Serie in die Bibliothek aufgenommen.': 'Added the first show to your library.',
  'Die erste Episode abgehakt.': 'Ticked off the first episode.',
  Durchgezogen: 'Saw It Through',
  'Die erste Serie vollständig gesehen.': 'Watched the first show completely.',
  Sammler: 'Collector',
  '25 Titel in der Bibliothek.': '25 titles in the library.',
  Archivar: 'Archivist',
  '100 Titel in der Bibliothek.': '100 titles in the library.',
  Hundertmarke: 'The Hundred Mark',
  '100 Episoden gesehen.': '100 episodes watched.',
  Tausendsassa: 'Jack of All Trades',
  '1000 Episoden gesehen.': '1000 episodes watched.',
  Serienjunkie: 'Series Junkie',
  '10 Serien vollständig gesehen.': '10 shows watched completely.',
  Legende: 'Legend',
  '50 Serien vollständig gesehen.': '50 shows watched completely.',
  'Ein ganzer Tag': 'A Whole Day',
  '24 Stunden Sehzeit zusammen.': '24 hours of watch time in total.',
  'Eine ganze Woche': 'A Whole Week',
  '7 Tage Sehzeit zusammen. Das sind 168 Stunden.': "7 days of watch time in total. That's 168 hours.",
  'Ein ganzer Monat': 'A Whole Month',
  '30 Tage reine Sehzeit. Beeindruckend und beunruhigend zugleich.': '30 days of pure watch time. Impressive and worrying at once.',
  Tage: 'days',
  Durchgesuchtet: 'Binged',
  '10 Episoden an einem einzigen Tag abgehakt.': '10 episodes ticked off in a single day.',
  Nachtschicht: 'Night Shift',
  '25 Episoden an einem einzigen Tag. Respekt.': '25 episodes in a single day. Respect.',
  Marathonläufer: 'Marathon Runner',
  'Eine Serie mit mehr als 100 Episoden vollständig gesehen.': 'Watched a show with more than 100 episodes completely.',
  'Gut versorgt': 'Well Supplied',
  'Drei Streaming-Abos verknüpft.': 'Connected three streaming subscriptions.',
  'Abo-Sammler': 'Subscription Collector',
  'Sechs Streaming-Abos verknüpft. Rechnest du das mal zusammen?': 'Connected six streaming subscriptions. Ever added that up?',
  Lückenlos: 'No Gaps',
  'Jeder Titel deiner Watchlist läuft bei einem deiner Anbieter.': 'Every title on your watchlist streams on one of your providers.',
  Kritiker: 'Critic',
  '25 Titel bewertet.': '25 titles rated.',
  Perfektionist: 'Perfectionist',
  'Fünf Serien mit voller Punktzahl bewertet.': 'Gave five shows full marks.',
  Konsequent: 'Decisive',
  'Fünf Serien abgebrochen. Auch das ist eine Entscheidung.': 'Dropped five shows. That is a decision too.',
  'Noch verborgen': 'Still hidden',
  'Sieh eine bestimmte Serie vollständig, um diesen Erfolg freizuschalten.': 'Watch a particular show completely to unlock this achievement.',
};
