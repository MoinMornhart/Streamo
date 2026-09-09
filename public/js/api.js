/**
 * ---------------------------------------------------------------------------
 * public/js/api.js – Der einzige Weg des Frontends zum Server
 * ---------------------------------------------------------------------------
 * Kapselt fetch() so, dass jede Ansicht nur noch `api.library.list()` o. Ä.
 * aufrufen muss. Fehler kommen einheitlich als ApiError zurück, damit die
 * Views sie an einer Stelle behandeln können.
 *
 * Verknüpfungen zum Backend (jede Methode nennt ihren Endpunkt):
 *   api.auth.*      -> src/routes/auth.js
 *   api.providers.* -> src/routes/providers.js
 *   api.search.*    -> src/routes/search.js
 *   api.library.*   -> src/routes/library.js
 *   api.shows.*     -> src/routes/shows.js
 *   api.settings.*  -> src/routes/settings.js
 *   api.stats.*     -> src/routes/stats.js
 * ---------------------------------------------------------------------------
 */

/**
 * Fehler eines API-Aufrufs. Trägt den HTTP-Status mit, damit Views z. B.
 * "412 = kein API-Key" gezielt abfangen können.
 */
export class ApiError extends Error {
  /**
   * @param {string} message Meldung vom Server (bereits auf Deutsch)
   * @param {number} status  HTTP-Status
   * @param {string} [code]  Maschinenlesbarer Code, z. B. "unauthenticated"
   */
  constructor(message, status, code) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Führt einen Aufruf gegen die eigene API aus.
 *
 * @param {string} path   z. B. "/api/library"
 * @param {object} [options]
 * @param {string} [options.method] GET (Default), POST, PATCH, PUT, DELETE
 * @param {object} [options.body]   wird zu JSON serialisiert
 * @param {object} [options.query]  Query-Parameter; leere Werte entfallen
 * @returns {Promise<any>} die geparste Antwort
 * @throws {ApiError}
 */
async function request(path, options = {}) {
  const url = new URL(path, window.location.origin);

  // Query-Parameter anhängen und dabei leere Werte auslassen, damit keine
  // "?status=" in der URL landen.
  for (const [key, value] of Object.entries(options.query || {})) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }

  const init = {
    method: options.method || 'GET',
    headers: {},
    // Das Session-Cookie muss mitgeschickt werden. "same-origin" ist zwar der
    // Standard moderner Browser, aber explizit ist hier besser als implizit.
    credentials: 'same-origin',
  };

  if (options.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }

  const response = await fetch(url, init);

  // 204 = erfolgreich, aber ohne Inhalt.
  if (response.status === 204) return null;

  // Antworten sind normalerweise JSON. Wenn nicht (z. B. eine Fehlerseite des
  // Reverse Proxy), soll das nicht in einem kryptischen Parser-Fehler enden.
  let data;
  const contentType = response.headers.get('content-type') || '';

  if (contentType.includes('application/json')) {
    data = await response.json();
  } else {
    data = { error: (await response.text()).slice(0, 200) };
  }

  if (!response.ok) {
    throw new ApiError(
      data?.error || `Fehler ${response.status}`,
      response.status,
      data?.code,
    );
  }

  return data;
}

/**
 * Baut eine vollständige Bild-URL aus einem TMDB-Pfad.
 *
 * TMDB liefert nur Teilpfade wie "/abc123.jpg". Die Größe wählt der Client –
 * kleine Poster im Raster, große auf der Detailseite. Das spart Datenvolumen
 * und ist der Grund, warum diese Funktion existiert statt fester URLs.
 *
 * @param {string|null} path TMDB-Pfad (poster_path, logo_path, backdrop_path)
 * @param {'w92'|'w154'|'w185'|'w300'|'w342'|'w500'|'w780'|'w1280'|'original'} [size]
 * @returns {string|null} null, wenn kein Pfad vorhanden ist
 */
export function img(path, size = 'w342') {
  if (!path) return null;
  return `https://image.tmdb.org/t/p/${size}${path}`;
}

/**
 * Die gebündelte Schnittstelle. Jede Gruppe entspricht einer Datei unter
 * src/routes/ im Backend.
 */
export const api = {
  // --- Anmeldung / Einrichtung  -> src/routes/auth.js ---------------------
  auth: {
    /** Wer bin ich, muss eingerichtet werden, gibt es einen API-Key? */
    status: () => request('/api/auth/status'),
    /** Ersteinrichtung: erster Admin + TMDB-Key + Region */
    setup: (body) => request('/api/auth/setup', { method: 'POST', body }),
    login: (username, password) =>
      request('/api/auth/login', { method: 'POST', body: { username, password } }),
    logout: () => request('/api/auth/logout', { method: 'POST' }),
    register: (body) => request('/api/auth/register', { method: 'POST', body }),
    changePassword: (currentPassword, newPassword) =>
      request('/api/auth/password', {
        method: 'POST',
        body: { currentPassword, newPassword },
      }),

    /** Entfernt das Passwort – danach geht nur noch der Passkey. */
    removePassword: (currentPassword) =>
      request('/api/auth/password', { method: 'DELETE', body: { currentPassword } }),

    /** Setzt oder entfernt die E-Mail (zweiter Anmeldename, kein Mailversand). */
    setEmail: (email) => request('/api/auth/email', { method: 'PUT', body: { email } }),

    // --- Passkeys  -> src/routes/auth.js, src/passkeys.js ------------------
    // Anlegen und Anmelden laufen jeweils in zwei Schritten: erst die Aufgabe
    // vom Server holen, dann die Antwort des Geräts zurückschicken. Warum das
    // so ist, steht in public/js/passkey.js.

    /** Funktionieren Passkeys unter dieser Adresse? (HTTPS + Hostname nötig) */
    passkeyAvailable: () => request('/api/auth/passkey/available'),

    /** Schritt 1 beim Anlegen eines Passkeys */
    passkeyRegisterOptions: () =>
      request('/api/auth/passkey/register/options', { method: 'POST' }),
    /** Schritt 2 beim Anlegen: Antwort des Geräts prüfen und speichern */
    passkeyRegisterVerify: (response, name) =>
      request('/api/auth/passkey/register/verify', { method: 'POST', body: { response, name } }),

    /** Schritt 1 beim Anmelden. Ohne username: Auswahl aller Passkeys */
    passkeyLoginOptions: (username) =>
      request('/api/auth/passkey/login/options', { method: 'POST', body: { username } }),
    /** Schritt 2 beim Anmelden: setzt bei Erfolg das Session-Cookie */
    passkeyLoginVerify: (response) =>
      request('/api/auth/passkey/login/verify', { method: 'POST', body: { response } }),

    /** Die eigenen Passkeys für die Einstellungsseite */
    passkeys: () => request('/api/auth/passkeys'),
    renamePasskey: (id, name) =>
      request(`/api/auth/passkeys/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: { name },
      }),
    deletePasskey: (id) =>
      request(`/api/auth/passkeys/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },

  // --- Streaming-Anbieter  -> src/routes/providers.js ---------------------
  providers: {
    /** Katalog aller Anbieter der eigenen Region, inkl. Markierung "abonniert" */
    catalog: (refresh = false) =>
      request('/api/providers', { query: { refresh: refresh ? '1' : '' } }),
    /** Nur meine verknüpften Abos */
    mine: () => request('/api/providers/mine'),
    /** Einen Anbieter verknüpfen */
    add: (providerId) =>
      request('/api/providers/mine', { method: 'POST', body: { providerId } }),
    /** Die komplette Auswahl auf einmal setzen (Speichern-Knopf) */
    setAll: (providerIds) =>
      request('/api/providers/mine', { method: 'PUT', body: { providerIds } }),
    /** Verknüpfung lösen */
    remove: (providerId) =>
      request(`/api/providers/mine/${providerId}`, { method: 'DELETE' }),
  },

  // --- Suchen und Entdecken  -> src/routes/search.js ----------------------
  search: {
    query: (q, page = 1) => request('/api/search', { query: { q, page } }),
    /** "Was läuft in meinen Abos?" */
    discover: (params) => request('/api/search/discover', { query: params }),
    trending: (mediaType = 'tv') => request('/api/search/trending', { query: { mediaType } }),
    genres: (mediaType = 'tv') => request('/api/search/genres', { query: { mediaType } }),
  },

  // --- Die persönliche Serien-Datenbank  -> src/routes/library.js ---------
  library: {
    list: (filters = {}) => request('/api/library', { query: filters }),
    add: (tmdbId, mediaType = 'tv', status = 'watchlist') =>
      request('/api/library', { method: 'POST', body: { tmdbId, mediaType, status } }),
    update: (showId, changes) =>
      request(`/api/library/${showId}`, { method: 'PATCH', body: changes }),
    remove: (showId) => request(`/api/library/${showId}`, { method: 'DELETE' }),
    /** Der Export ist eine normale URL – wird als Download verlinkt. */
    exportUrl: '/api/library/export',
    import: (payload) => request('/api/library/import', { method: 'POST', body: payload }),
  },

  // --- Detailseite und Fortschritt  -> src/routes/shows.js ----------------
  shows: {
    detail: (mediaType, tmdbId) => request(`/api/shows/${mediaType}/${tmdbId}`),
    season: (mediaType, tmdbId, seasonNumber) =>
      request(`/api/shows/${mediaType}/${tmdbId}/season/${seasonNumber}`),
    /** Episode, ganze Staffel oder "alles bis hierhin" ab-/anhaken */
    setWatched: (showId, payload) =>
      request(`/api/shows/${showId}/watched`, { method: 'POST', body: payload }),
    /** Verfügbarkeiten für eine Trefferliste nachladen */
    availability: (items) =>
      request('/api/shows/availability', { method: 'POST', body: { items } }),
    refresh: (showId) => request(`/api/shows/${showId}/refresh`, { method: 'POST' }),
  },

  // --- Einstellungen  -> src/routes/settings.js ---------------------------
  settings: {
    get: () => request('/api/settings'),
    update: (body) => request('/api/settings', { method: 'PUT', body }),
    updateGlobal: (body) => request('/api/settings/global', { method: 'PUT', body }),
    testKey: (apiKey) =>
      request('/api/settings/test-key', { method: 'POST', body: { apiKey } }),
    startSync: (kind = 'availability') =>
      request('/api/settings/sync', { method: 'POST', body: { kind } }),
    syncStatus: () => request('/api/settings/sync'),
    sessions: () => request('/api/settings/sessions'),
    logoutEverywhere: () => request('/api/settings/sessions', { method: 'DELETE' }),
  },

  // --- Auswertungen  -> src/routes/stats.js -------------------------------
  stats: {
    get: () => request('/api/stats'),
  },
};

export default api;
