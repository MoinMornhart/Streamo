/**
 * ---------------------------------------------------------------------------
 * public/js/i18n/en/einstellungen.js – Englisch: die Einstellungsseite
 * ---------------------------------------------------------------------------
 * Konto, Sprache, Passkeys, Aussehen, Zwei-Faktor, Benutzerverwaltung,
 * Einladungen, TMDB-Zugang, Abgleich und Datenexport (views/settings.js).
 *
 * Aufbau wie in basis.js: deutscher Text als Schlüssel, {0} … als
 * Platzhalter.
 *
 * Verknüpfungen:
 *   - public/js/i18n/en.js -> führt alle Teile zusammen
 * ---------------------------------------------------------------------------
 */

export default {
  // --- Konto und Sprache -------------------------------------------------------------
  'Angemeldet als {0}': 'Signed in as {0}',
  Anzeigename: 'Display name',
  'Damit kannst du dich zusätzlich zum Benutzernamen anmelden. Streamo verschickt keine E-Mails – ein Mailserver ist nicht nötig. Leer lassen entfernt die Adresse.':
    "Lets you sign in with it in addition to your username. Streamo sends no emails – no mail server needed. Leaving it empty removes the address.",
  Region: 'Region',
  'Bestimmt, welche Streaming-Anbieter angeboten werden und für welches Land die Verfügbarkeit gilt.':
    'Decides which streaming providers are offered and which country availability applies to.',
  'Sprache von Titeln, Beschreibungen und Postern.': 'Language of titles, descriptions and posters.',
  'Sprache der Oberfläche': 'Interface language',
  'Menüs, Knöpfe und Meldungen. Gilt für dein Konto auf allen Geräten.':
    'Menus, buttons and messages. Applies to your account on all devices.',
  'Konto speichern': 'Save account',
  'Gespeichert. Die neue Region gilt ab sofort.': 'Saved. The new region applies right away.',

  // --- Passkeys ------------------------------------------------------------------------
  'Melde dich mit Fingerabdruck, Gesicht oder Geräte-PIN an, statt ein Passwort einzutippen. Der Schlüssel bleibt auf deinem Gerät.':
    'Sign in with your fingerprint, face or device PIN instead of typing a password. The key stays on your device.',
  'Dein Browser unterstützt keine Passkeys.': 'Your browser does not support passkeys.',
  'Passkeys sind hier nicht verfügbar': 'Passkeys are not available here',
  'Streamo nimmt die Adresse "{0}://{1}" wahr': 'Streamo sees the address "{0}://{1}"',
  '(über einen Reverse Proxy).': '(through a reverse proxy).',
  'Windows-PC': 'Windows PC',
  'Android-Handy': 'Android phone',
  'Dieses Gerät': 'This device',
  'Passkey anlegen': 'Create passkey',
  'Wie soll dieses Gerät heißen?': 'What should this device be called?',
  'Ein sprechender Name hilft später beim Aufräumen – etwa "Laptop" oder "Handy".':
    'A descriptive name helps when tidying up later – say "Laptop" or "Phone".',
  'Passkey angelegt.': 'Passkey created.',
  '+ Passkey hinzufügen': '+ Add passkey',
  'Noch kein Passkey eingerichtet.': 'No passkey set up yet.',
  'Angelegt am {0}': 'Created on {0}',
  'zuletzt benutzt {0}': 'last used {0}',
  'noch nicht benutzt': 'not used yet',
  'wird zwischen Geräten synchronisiert': 'synced between devices',
  Umbenennen: 'Rename',
  'Passkey umbenennen': 'Rename passkey',
  'Neuer Name': 'New name',
  'Passkey „{0}" entfernen?': 'Remove passkey "{0}"?',
  'Mit diesem Gerät kannst du dich danach nicht mehr ohne Passwort anmelden.':
    "You won't be able to sign in on this device without a password afterwards.",
  'Passkey entfernt.': 'Passkey removed.',
  'Du kannst das Passwort entfernen und dich nur noch per Passkey anmelden. Achtung: Verlierst du dann alle Passkeys, kommst du nicht mehr in dein Konto.':
    "You can remove the password and sign in with passkeys only. Careful: if you then lose all passkeys, you can't get into your account any more.",
  'Passwort entfernen': 'Remove password',
  'Danach kommst du nur noch per Passkey in dein Konto. Verlierst du alle Passkeys, gibt es keinen Weg zurück.':
    "Afterwards you can only get into your account with a passkey. If you lose all passkeys, there's no way back.",
  'Zur Bestätigung dein aktuelles Passwort': 'Your current password, to confirm',
  'Passwort entfernt. Ab jetzt nur noch Passkey.': 'Password removed. Passkey only from now on.',
  'Passkeys konnten nicht geladen werden.': 'Passkeys could not be loaded.',

  // --- Aussehen ----------------------------------------------------------------------------
  'Eigene Farbe wählen': 'Pick your own colour',
  Aussehen: 'Appearance',
  'Gilt nur für dein Konto. Die Änderung ist sofort zu sehen – Speichern ist nicht nötig.':
    'Applies to your account only. You see the change right away – no need to save.',
  Akzentfarbe: 'Accent colour',
  eigene: 'custom',
  Grundton: 'Base tone',
  'Schwarz passt besser zu kräftigen Akzentfarben – und auf einem OLED-Bildschirm bleiben die Pixel dort tatsächlich aus.':
    'Black suits strong accent colours better – and on an OLED screen those pixels really stay off.',
  Zurücksetzen: 'Reset',

  // --- Zwei-Faktor-Anmeldung ----------------------------------------------------------------
  'Zwei-Faktor-Anmeldung': 'Two-factor sign-in',
  'Zusätzlich zum Passwort ein Code aus einer App auf deinem Telefon. Selbst wer dein Passwort kennt, kommt damit nicht in dein Konto.':
    "A code from an app on your phone in addition to the password. Even someone who knows your password can't get into your account.",
  '✓ Eingeschaltet': '✓ On',
  'seit {0}': 'since {0}',
  'Noch {0} von 10 Ersatzcodes übrig.': '{0} of 10 backup codes left.',
  'Die Ersatzcodes gehen zur Neige. Erzeuge einen neuen Satz, solange du noch Zugriff hast.':
    'You are running out of backup codes. Create a new set while you still have access.',
  'Neue Ersatzcodes': 'New backup codes',
  'Die bisherigen Ersatzcodes verlieren damit ihre Gültigkeit.': 'The previous backup codes stop working.',
  'Zur Sicherheit dein Passwort': 'Your password, to be safe',
  'Neue Codes erzeugen': 'Create new codes',
  Ausschalten: 'Turn off',
  'Zwei-Faktor-Anmeldung ausschalten': 'Turn off two-factor sign-in',
  'Danach reicht wieder das Passwort allein, um in dein Konto zu kommen.':
    'Afterwards the password alone is enough to get into your account again.',
  'Zur Bestätigung dein Passwort': 'Your password, to confirm',
  'Zwei-Faktor-Anmeldung ausgeschaltet.': 'Two-factor sign-in turned off.',
  'Zurzeit ausgeschaltet.': 'Currently off.',
  Einrichten: 'Set up',
  'Wird vorbereitet …': 'Preparing …',
  'Installiere eine Authenticator-App, falls noch keine da ist – etwa':
    "Install an authenticator app if you don't have one yet – for example",
  'Auf dem Telefon:': 'On the phone:',
  // Steht allein zwischen den beiden App-Links "Aegis oder Google Authenticator".
  oder: 'or',
  'In der App öffnen': 'Open in the app',
  'Am Rechner: dieses Geheimnis in der App eintragen.': 'On a computer: enter this secret in the app.',
  Kopieren: 'Copy',
  'Geheimnis kopiert.': 'Secret copied.',
  'Kopieren nicht möglich.': 'Copying is not possible.',
  'Gib den Code ein, den die App jetzt anzeigt:': 'Enter the code the app shows now:',
  Einschalten: 'Turn on',
  'Zwei-Faktor-Anmeldung eingeschaltet.': 'Two-factor sign-in turned on.',
  'Deine Ersatzcodes': 'Your backup codes',
  'Bewahre sie an einem sicheren Ort auf – ausgedruckt oder im Passwortmanager. Jeder gilt einmal. Ohne sie kommst du nicht mehr in dein Konto, wenn das Telefon weg ist. Du siehst sie nur dieses eine Mal.':
    "Keep them somewhere safe – printed or in a password manager. Each works once. Without them you can't get into your account if your phone is gone. You only see them this one time.",
  'Codes kopieren': 'Copy codes',
  'Kopieren nicht möglich': 'Copying is not possible',
  'Ich habe sie gesichert': "I've saved them",
  'Zustand konnte nicht geladen werden.': 'Status could not be loaded.',

  // --- Benutzerverwaltung ------------------------------------------------------------------------
  Benutzer: 'Users',
  'Wer hat hier ein Konto, wann war er zuletzt da – und wer darf verwalten.':
    'Who has an account here, when they were last around – and who may manage.',
  '{0} {1} in der Bibliothek': '{0} {1} in the library',
  'der gesamte Sehfortschritt': 'all watch progress',
  'verknüpfte Abos, Bewertungen und Erfolge': 'connected subscriptions, ratings and achievements',
  'eigene Filmreihen und Freundschaften': 'own collections and friendships',
  'Konto „{0}" löschen?': 'Delete account "{0}"?',
  'Das lässt sich nicht rückgängig machen. Gelöscht werden: {0}.': 'This cannot be undone. Deleted will be: {0}.',
  'Tipp zur Bestätigung „{0}" ein': 'Type "{0}" to confirm',
  'Endgültig löschen': 'Delete permanently',
  'Konto {0} gelöscht': 'Account {0} deleted',
  '– mit {0} Titeln.': '– with {0} titles.',
  Admin: 'Admin',
  // Kennzeichen am eigenen Konto in der Benutzerliste.
  du: 'you',
  'Zwei-Faktor-Anmeldung aktiv': 'Two-factor sign-in active',
  '{0} aktive Anmeldung{1}': '{0} active session{1}',
  '● angemeldet': '● signed in',
  'zuletzt da {0}': 'last seen {0}',
  'war noch nie angemeldet': 'has never signed in',
  'dabei seit {0}': 'member since {0}',
  'Die eigenen Rechte kann man sich nicht selbst nehmen.': "You can't take away your own rights.",
  'Adminrechte vergeben oder entziehen': 'Grant or revoke admin rights',
  '{0} ist jetzt Administrator.': '{0} is now an administrator.',
  '{0} ist jetzt ein gewöhnlicher Benutzer.': '{0} is now a regular user.',
  'Konto {0} endgültig löschen': 'Permanently delete account {0}',
  'Benutzer konnten nicht geladen werden.': 'Users could not be loaded.',

  // --- Passwort ---------------------------------------------------------------------------------
  'Passwort ändern': 'Change password',
  'Aktuelles Passwort': 'Current password',
  'Neues Passwort': 'New password',
  'Mindestens 8 Zeichen. Alle anderen Geräte werden abgemeldet.': 'At least 8 characters. All other devices will be signed out.',
  'Passwort geändert.': 'Password changed.',

  // --- Einladungen und Registrierung --------------------------------------------------------------
  'Freunde einladen': 'Invite friends',
  'Erzeuge einen Link und schick ihn weiter. Wer ihn öffnet, legt sich ein Konto an – ohne eigenen Zugang zu einer Filmdatenbank, ohne Installation. Dein TMDB-Zugang gilt für alle Konten dieser Instanz.':
    'Create a link and send it on. Whoever opens it creates an account – no film database access of their own, nothing to install. Your TMDB access applies to every account on this instance.',
  'Registrierung offen. Jeder, der die Adresse kennt, kann sich ein Konto anlegen.':
    'Registration open. Anyone who knows the address can create an account.',
  'Registrierung geschlossen. Ab jetzt nur noch mit Einladung.': 'Registration closed. Invitation only from now on.',
  'Registrierung ohne Einladung erlauben': 'Allow registration without an invitation',
  'Standardmäßig aus. Der Grund: Sobald Streamo aus dem Internet erreichbar ist, könnte sonst jeder, der die Adresse findet, ein Konto anlegen – und deinen TMDB-Zugang mitbenutzen. Mit Einladung entscheidest du, wer hereinkommt.':
    'Off by default. The reason: once Streamo is reachable from the internet, anyone who finds the address could otherwise create an account – and use your TMDB access. With invitations you decide who gets in.',
  'Zurzeit gilt die Vorgabe aus der .env (ALLOW_REGISTRATION). Sobald du hier umlegst, gilt deine Einstellung – ohne dass du an den Server musst.':
    "The default from the .env (ALLOW_REGISTRATION) currently applies. As soon as you switch it here, your setting applies – no need to touch the server.",
  'Einladung zu Streamo': 'Invitation to Streamo',
  'Ich lade dich zu meinem Streamo ein. Damit siehst du, wo du unsere Serien streamen kannst.':
    "I'm inviting you to my Streamo. It shows you where you can stream our shows.",
  '+ Einladung erzeugen': '+ Create invitation',
  'Einmal nutzbar, sieben Tage gültig': 'Single use, valid for seven days',
  'Dauerhafter Link': 'Permanent link',
  'Unbegrenzt nutzbar und ohne Ablaufdatum – für die ganze Familie': 'Unlimited use and no expiry – for the whole family',
  'Dauerhaften Link erzeugen?': 'Create a permanent link?',
  'Er kann von beliebig vielen Personen benutzt werden und läuft nie ab. Gib ihn nur weiter, wem du vertraust.':
    'Any number of people can use it and it never expires. Only give it to people you trust.',
  'Link erzeugen': 'Create link',
  'Noch keine Einladungen erzeugt.': 'No invitations created yet.',
  'unbegrenzt nutzbar': 'unlimited use',
  'noch {0}× nutzbar': '{0}× left',
  'gültig bis {0}': 'valid until {0}',
  'ohne Ablauf': 'no expiry',
  '{0}× eingelöst': 'redeemed {0}×',
  Teilen: 'Share',
  'Einladung widerrufen': 'Revoke invitation',

  // --- TMDB-Zugang -------------------------------------------------------------------------------
  'Nur ausfüllen, um den Schlüssel zu ersetzen': 'Only fill in to replace the key',
  'Schlüssel von themoviedb.org einfügen': 'Paste the key from themoviedb.org',
  'TMDB-Zugang': 'TMDB access',
  'Streamo holt Metadaten und Streaming-Verfügbarkeit von TMDB. Der Schlüssel ist kostenlos: themoviedb.org → Einstellungen → API. Es funktionieren sowohl der „API Read Access Token" als auch der klassische „API Key".':
    'Streamo gets metadata and streaming availability from TMDB. The key is free: themoviedb.org → Settings → API. Both the "API Read Access Token" and the classic "API key" work.',
  '✓ Ein Schlüssel ist hinterlegt.': '✓ A key is set.',
  '⚠ Es ist kein Schlüssel hinterlegt.': '⚠ No key is set.',
  'Er wird hier nicht angezeigt – er liegt auf dem Server und bleibt dort.':
    "It isn't shown here – it lives on the server and stays there.",
  'Schlüssel ersetzen': 'Replace key',
  'API-Key': 'API key',
  'Schlüssel testen': 'Test key',
  'Bitte erst einen Schlüssel eingeben.': 'Please enter a key first.',
  'Schlüssel speichern': 'Save key',
  'Schlüssel gespeichert.': 'Key saved.',

  // --- Abgleich ----------------------------------------------------------------------------------
  // Ein Platzhalter statt "{0}{1}": Zwei aneinanderstoßende Platzhalter sind
  // mehrdeutig – "nie" wurde in "n" und "ie" zerschnitten.
  'Letzter Abgleich: {0}': 'Last sync: {0}',
  'Abgleich läuft … {0} von {1}': 'Syncing … {0} of {1}',
  'Letzter Abgleich: {0} – {1}': 'Last sync: {0} – {1}',
  'Abgleich abgeschlossen.': 'Sync finished.',
  Abgleich: 'Sync',
  'Wie oft abgleichen?': 'How often to sync?',
  'Der automatische Abgleich ist jetzt abgeschaltet.': 'Automatic sync is now turned off.',
  'Streamo gleicht ab jetzt {0} ab.': 'Streamo now syncs {0}.',
  'Jede Stunde': 'Every hour',
  'jede Stunde': 'every hour',
  'Alle 3 Stunden': 'Every 3 hours',
  'Alle 6 Stunden': 'Every 6 hours',
  'Alle 12 Stunden': 'Every 12 hours',
  'alle 3 Stunden': 'every 3 hours',
  'alle 6 Stunden': 'every 6 hours',
  'alle 12 Stunden': 'every 12 hours',
  'Einmal täglich': 'Once a day',
  'einmal täglich': 'once a day',
  'Gar nicht': 'Never',
  'Abgeglichen wird nur, was in einer Bibliothek steht. Bei 300 Titeln sind das rund 20 Sekunden Arbeit je Durchgang – stündlich ist also unbedenklich.':
    "Only titles that are in a library get synced. With 300 titles that's about 20 seconds of work per run – so hourly is harmless.",
  'Der automatische Abgleich ist abgeschaltet.': 'Automatic sync is turned off.',
  'Streamo prüft jede Stunde automatisch, wo deine Serien gerade laufen.':
    'Streamo automatically checks every hour where your shows are streaming.',
  'Streamo prüft alle {0} Stunden automatisch, wo deine Serien gerade laufen.':
    'Streamo automatically checks every {0} hours where your shows are streaming.',
  'Du kannst den Abgleich auch sofort starten.': 'You can also start the sync right away.',
  'Verfügbarkeit abgleichen': 'Sync availability',
  'Prüft für alle Titel deiner Bibliothek, wo sie gerade laufen': 'Checks where all titles in your library are streaming',
  'Abgleich gestartet …': 'Sync started …',
  'Alles abgleichen': 'Sync everything',
  'Zusätzlich Metadaten und Anbieter-Katalog': 'Also metadata and the provider catalogue',
  'Vollständiger Abgleich gestartet …': 'Full sync started …',

  // --- Daten -------------------------------------------------------------------------------------
  Daten: 'Data',
  'Der Export enthält deine Bibliothek, deine Abos und deinen Sehfortschritt als JSON – ideal als Backup oder für den Umzug auf eine andere Installation.':
    'The export contains your library, subscriptions and watch progress as JSON – ideal as a backup or for moving to another installation.',
  '↓ Bibliothek exportieren': '↓ Export library',
  'Export einlesen': 'Import an export',
  'Vorhandene Einträge werden aktualisiert, nichts wird gelöscht. Die Metadaten holt der nächste Abgleich nach.':
    'Existing entries are updated, nothing is deleted. The next sync fetches the metadata.',
  Importieren: 'Import',
  'Bitte erst eine Datei auswählen.': 'Please choose a file first.',
  '{0} Einträge und {1} Anbieter importiert.': '{0} entries and {1} providers imported.',
  'Die Datei ist kein gültiges JSON.': 'The file is not valid JSON.',
  'Streamo {0}': 'Streamo {0}',
};
