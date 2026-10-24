# Stand: Streamo (Übergabe 2026-10-24)

## Was es ist
Selbst gehostete Serien- und Filmdatenbank: zeigt bei jedem Titel, **wo** er läuft und ob er im eigenen Streaming-Abo
steckt. Weboberfläche (Node/Express) plus Windows-App (Electron-Hülle). Läuft bei Philip zu Hause (Proxmox-LXC oder Raspberry Pi).
Hinweis: Streamo ist **nicht** die geplante App „BearLive“ (Live-Shorts für Twitch/Kick) – das ist ein anderes Projekt.

## Aktueller Stand (v1.4.1 auf main, Release v1.4.1 vom 15.09.2026)
- Bibliothek, Merkliste, Fortschritt je Episode, Bewertungen, Filmreihen, Empfehlungen aus der eigenen Bibliothek
- Kalender (Monatsraster, Sehpläne mit Uhrzeit, „läuft bald aus“), Kalender-Abo (auch für ToDoch)
- Mehrere Benutzer, Freunde, Einladungen, Admin-Benutzerverwaltung, Registrierung umschaltbar
- Anmeldung: Passwort, Passkey (WebAuthn), Zwei-Faktor (TOTP); HTTPS direkt ohne Reverse Proxy möglich
- Deutsch/Englisch umschaltbar, Handy-Ansicht, Webseite auf GitHub Pages (moinmornhart.github.io/Streamo)
- Windows-App aktualisiert sich selbst (electron-updater), Server per Befehl `update` / `streamo`
- Tests: `npm run test:all` (laut PR #14: 651 Prüfungen grün)

## Zuletzt gemacht
- 2026-10-24 SessionStart-Hook für Cloud-Sitzungen (`.claude/hooks/skills-cloud.sh`, installiert Philips Skills)
- 2026-09-16 bis 09-26 VibeWorks-Repo-Check und Lighthouse-Check eingerichtet/aktualisiert
- 2026-09-15 Abhängigkeiten aktualisiert, Dependabot (1.4.1)
- 2026-09-11 Webseite auf GitHub Pages (1.4.0), Kalender-Abo für ToDoch (1.3.9), Englisch (1.3.5)
- 2026-09-10 Raspberry-Pi-Installer (1.3.0)

## Offen / Nächste Schritte
- **Offene PRs (nicht gemergt):**
  - #14 (Branch `claude/confident-pascal-864jyn`, 19.10.): Repo-Check aufgeräumt, Abhängigkeiten, Lücken → wäre 1.4.2;
    erledigt laut Beschreibung #3, #4, #5, #11 und überholt #13, #8, #7
  - #12 (`fix/security-ratelimit-cookies`, 17.10.): Rate-Limit-Umgehung über X-Forwarded-For schließen, Cookie/Secret-Hygiene
  - #6 (VibeWorks „Müll entfernen“) – kollidiert mit #12, beide löschen `x/secret.key`; nur eins davon nehmen
  - Dependabot #13, #8, #7 (durch #14 überholt)
  - Branch `sicherheit/fixes-2026-10-18` (ohne PR): entfernt `x/secret.key` aus Git, ergänzt `.gitignore`
- **Bekanntes Problem:** `x/secret.key` liegt im öffentlichen Repo (eingecheckt am 09.09.2026). Unklar, ob diese Datei
  irgendwo produktiv genutzt wird (Streamo selbst nutzt `DATA_DIR/secret.key`). Nach dem Entfernen ggf. Session-Secret wechseln.
- Offene Issues: #15 und #11 (Sicherheitslücken electron), #5 (Repo-Check-Befunde), #4 (Geheimnis-Fehlalarm), #3 (Updates)
- Empfohlene Reihenfolge (Vorschlag, nicht von Philip entschieden): #12 und #14 prüfen/mergen, #6 und Dependabot-PRs schließen.

## Wichtige Infos
- Technik: Node.js ≥ 22.13 (eingebautes `node:sqlite`), Express 5, @simplewebauthn/server; Daten in `DATA_DIR` (SQLite)
- Start: `npm install --omit=dev && npm start` (Entwicklung: `npm run dev`), Port **3000** (HTTPS optional 3443)
- Konfiguration über `.env` (Vorlage `.env.example`); TMDB-API-Schlüssel bleibt auf dem Server
- Installation: Proxmox-Einzeiler `scripts/streamo.sh`, Linux/Pi `scripts/install/streamo-install.sh`
- Windows-App in `desktop/`, gebaut per Workflow `desktop.yml`; nur die neueste Release bleibt stehen
- Webseite: `npm run site` (Workflow `pages.yml`); VibeWorks-Workflows `vibeworks-*.yml` nicht anfassen
- Versionsschema: letzte Stelle läuft 0–9 (1.3.9 → 1.4.0); Commit-Texte auf Deutsch mit Versionsnummer

## Philips Vorgaben
- Repo **öffentlich** (MoinMornhart/Streamo), Lizenz MIT
- Update-Funktion: ja (Desktop-App und Server-Befehl `update`)
- Git-Texte: Philip hat bei den Sicherheits-Fixes (18./19.10.2026) „Verfasst mit Claude 🤖“ in Commit-Texten festgelegt (in den Sicherheits-Commits so umgesetzt)
- Keine Geheimnisse ins Repo; lokaler Ordner `C:\Projekte\Streamo` und GitHub sollen gleich sein

---
Diese Datei wird beim Arbeiten aktuell gehalten: nach jedem größeren Schritt „Aktueller Stand“ und „Offen“ anpassen.
