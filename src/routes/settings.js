/**
 * ---------------------------------------------------------------------------
 * src/routes/settings.js – Einstellungen, Abgleich, Sessions
 * ---------------------------------------------------------------------------
 * Eingehängt in src/server.js unter /api/settings.
 *
 * Endpunkte:
 *   GET    /api/settings           – aktuelle Einstellungen (Key maskiert)
 *   PUT    /api/settings           – Region/Sprache ändern (jeder für sich)
 *   PUT    /api/settings/global    – TMDB-Key & globale Defaults (nur Admin)
 *   POST   /api/settings/test-key  – API-Key prüfen, ohne ihn zu speichern
 *   POST   /api/settings/sync      – Abgleich sofort starten (nur Admin)
 *   GET    /api/settings/sync      – Protokoll der letzten Läufe
 *   GET    /api/settings/sessions  – meine aktiven Anmeldungen
 *   DELETE /api/settings/sessions  – alle anderen Geräte abmelden
 *
 * Verknüpfungen:
 *   - src/db.js   -> getSetting/setSetting (Tabelle settings)
 *   - src/tmdb.js -> testApiKey()
 *   - src/sync.js -> runSync() für den manuellen Abgleich
 *   - src/auth.js -> listSessions / destroyAllSessions
 * ---------------------------------------------------------------------------
 */

import express from 'express';
import config from '../config.js';
import { all, run, getSetting, setSetting } from '../db.js';
import { requireAuth, requireAdmin, listSessions, createSession, setSessionCookie, destroyAllSessions } from '../auth.js';
import * as tmdb from '../tmdb.js';
import { getRuntimeSettings } from '../tmdb.js';
import { runSync, getSyncState } from '../sync.js';

const router = express.Router();
router.use(requireAuth);

/**
 * Maskiert einen API-Key für die Anzeige: "eyJhbGciOi…9f3a".
 * Der vollständige Schlüssel verlässt den Server nie – so kann man im UI
 * sehen, dass einer hinterlegt ist, ohne ihn versehentlich zu teilen
 * (Screenshot, Screensharing).
 *
 * @param {string} key
 * @returns {string|null}
 */
function maskKey(key) {
  if (!key) return null;
  if (key.length <= 12) return '••••••••';
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

/**
 * GET /api/settings
 * Alles, was die Einstellungsseite anzeigt.
 */
router.get('/', (req, res) => {
  const runtime = getRuntimeSettings(req.user);

  res.json({
    user: {
      username: req.user.username,
      // Ohne dieses Feld stand das E-Mail-Eingabefeld auf der
      // Einstellungsseite immer leer, egal ob eine Adresse hinterlegt war –
      // das Frontend liest genau hier.
      email: req.user.email || null,
      displayName: req.user.display_name,
      isAdmin: Boolean(req.user.is_admin),
      region: req.user.region || runtime.region,
      language: req.user.language || runtime.language,
    },
    global: {
      // Nur Admins sehen überhaupt, ob und welcher Key gesetzt ist.
      apiKey: req.user.is_admin ? maskKey(runtime.apiKey) : null,
      hasApiKey: Boolean(runtime.apiKey),
      region: getSetting('region', config.region),
      language: getSetting('language', config.language),
      allowRegistration: config.allowRegistration,
      syncIntervalHours: config.syncIntervalHours,
    },
    sync: getSyncState(),
    version: config.version,
  });
});

/**
 * PUT /api/settings
 * Persönliche Einstellungen. Body: { region?, language?, displayName? }
 *
 * Die Region ist die wichtigste Einstellung überhaupt: Sie entscheidet,
 * welche Anbieter im Katalog stehen und welche Verfügbarkeiten geladen werden.
 */
router.put('/', (req, res) => {
  const updates = [];
  const params = [];

  if (req.body?.region) {
    // ISO-3166-1 alpha-2: genau zwei Buchstaben.
    const region = String(req.body.region).toUpperCase().trim();
    if (!/^[A-Z]{2}$/.test(region)) {
      return res.status(400).json({ error: 'Region muss ein Länderkürzel wie "DE" sein.' });
    }
    updates.push('region = ?');
    params.push(region);
  }

  if (req.body?.language) {
    updates.push('language = ?');
    params.push(String(req.body.language).trim());
  }

  if (req.body?.displayName !== undefined) {
    updates.push('display_name = ?');
    params.push(String(req.body.displayName).trim().slice(0, 60));
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'Keine Änderungen übergeben.' });
  }

  params.push(req.user.id);
  run(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, ...params);

  res.json({ ok: true });
});

/**
 * PUT /api/settings/global
 * Instanzweite Einstellungen. Body: { apiKey?, region?, language? }
 * Nur für Admins – der TMDB-Key gilt für alle Benutzer dieser Installation.
 */
router.put('/global', requireAdmin, async (req, res, next) => {
  try {
    if (req.body?.apiKey !== undefined) {
      const key = String(req.body.apiKey).trim();

      if (key === '') {
        // Leerer Wert = Key entfernen (zurück auf den Wert aus der .env).
        setSetting('tmdb_api_key', null);
      } else {
        // Erst prüfen, dann speichern – ein kaputter Key würde sonst die
        // ganze Instanz lahmlegen.
        await tmdb.testApiKey(key);
        setSetting('tmdb_api_key', key);
      }
    }

    if (req.body?.region) setSetting('region', String(req.body.region).toUpperCase().trim());
    if (req.body?.language) setSetting('language', String(req.body.language).trim());

    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/settings/test-key
 * Prüft einen Schlüssel, ohne ihn zu speichern. Body: { apiKey }
 */
router.post('/test-key', requireAdmin, async (req, res) => {
  try {
    await tmdb.testApiKey(String(req.body?.apiKey ?? '').trim());
    res.json({ ok: true, message: 'Der Schlüssel funktioniert.' });
  } catch (error) {
    res.status(error.status || 400).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/settings/sync
 * Startet den Abgleich sofort. Body: { kind?: 'availability'|'metadata'|'full' }
 *
 * Der Aufruf wartet NICHT auf das Ende – ein voller Lauf kann bei großen
 * Bibliotheken Minuten dauern. Der Fortschritt wird über GET /api/settings/sync
 * abgefragt.
 */
router.post('/sync', requireAdmin, (req, res) => {
  const kind = ['availability', 'metadata', 'full'].includes(req.body?.kind)
    ? req.body.kind
    : 'availability';

  // Bewusst ohne await: sofort antworten, im Hintergrund weiterarbeiten.
  // Der catch verhindert eine unbehandelte Promise-Ablehnung.
  runSync(kind).catch(() => {});

  res.json({ ok: true, started: kind });
});

/**
 * GET /api/settings/sync
 * Zustand und Protokoll der letzten zehn Läufe.
 */
router.get('/sync', (req, res) => {
  res.json({
    state: getSyncState(),
    log: all('SELECT * FROM sync_log ORDER BY started_at DESC LIMIT 10'),
  });
});

/**
 * GET /api/settings/sessions
 * Meine aktiven Anmeldungen. Die aktuelle wird markiert, damit man sie im UI
 * nicht versehentlich für ein fremdes Gerät hält.
 */
router.get('/sessions', (req, res) => {
  const sessions = listSessions(req.user.id).map((s) => ({
    ...s,
    // Den Token selbst nie ausliefern – nur die Info "das bist du gerade".
    id: undefined,
    current: s.id === req.sessionToken,
  }));

  res.json({ sessions });
});

/**
 * DELETE /api/settings/sessions
 * Meldet alle Geräte ab und stellt für den aktuellen Browser sofort eine
 * frische Session aus, damit man nicht sich selbst aussperrt.
 */
router.delete('/sessions', (req, res) => {
  destroyAllSessions(req.user.id);

  const token = createSession(req.user.id, {
    userAgent: req.headers['user-agent'],
    ip: null,
  });
  setSessionCookie(res, token);

  res.json({ ok: true });
});

export default router;
