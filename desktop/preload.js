/**
 * ---------------------------------------------------------------------------
 * desktop/preload.js – Die Brücke zwischen App und angezeigter Seite
 * ---------------------------------------------------------------------------
 * Rolle im Gesamtsystem:
 *   Das Fenster zeigt eine Seite, die von deinem Server kommt. Diese Seite
 *   darf unter keinen Umständen an Node.js, das Dateisystem oder das
 *   Betriebssystem herankommen – sonst hätte jeder, der den Server
 *   kontrolliert, auch Zugriff auf den PC.
 *
 *   Electron trennt beide Welten deshalb strikt (contextIsolation). Diese
 *   Datei ist die einzige erlaubte Verbindung: Sie stellt genau vier
 *   Funktionen bereit, mehr nicht.
 *
 * Wichtig: Was hier nicht steht, kann die Seite nicht aufrufen. Deshalb ist
 * die Liste bewusst kurz und enthält nur, was der Verbindungsbildschirm
 * (renderer/connect.html) tatsächlich braucht. Die Streamo-Oberfläche selbst
 * benutzt sie gar nicht – sie merkt nicht einmal, dass sie in einer App läuft.
 *
 * Verknüpfungen:
 *   - desktop/main.js               -> die Gegenstellen der ipcMain.handle(…)
 *   - desktop/renderer/connect.html -> der einzige Nutzer dieser Brücke
 * ---------------------------------------------------------------------------
 */

const { contextBridge, ipcRenderer } = require('electron');

// contextBridge legt das Objekt im Fenster als `window.streamoDesktop` ab –
// aber in einer abgeschotteten Form: Die Seite bekommt Kopien der Werte, nie
// Verweise auf echte Node-Objekte.
contextBridge.exposeInMainWorld('streamoDesktop', {
  /**
   * Prüft, ob unter einer Adresse ein Streamo-Server antwortet.
   * @param {string} url z. B. "https://streamo.example.de"
   * @returns {Promise<{ok: boolean, error?: string, version?: string, hasApiKey?: boolean}>}
   */
  testConnection: (url) => ipcRenderer.invoke('streamo:test-connection', url),

  /**
   * Speichert die Adresse und lädt die Streamo-Oberfläche.
   * @param {string} url
   * @param {boolean} allowSelfSigned Selbstsigniertes Zertifikat akzeptieren
   * @returns {Promise<{ok: boolean}>}
   */
  connect: (url, allowSelfSigned) =>
    ipcRenderer.invoke('streamo:connect', url, allowSelfSigned),

  /**
   * Liest die gespeicherten Einstellungen, um die Felder vorzubelegen.
   * @returns {Promise<{serverUrl: string, allowSelfSignedCert: boolean, version: string}>}
   */
  getSettings: () => ipcRenderer.invoke('streamo:get-settings'),

  /**
   * Kennzeichen, an dem eine Seite erkennen kann, dass sie in der Desktop-App
   * läuft. Wird derzeit nicht gebraucht, ist aber der saubere Weg, falls die
   * Weboberfläche später etwas anders darstellen soll.
   */
  isDesktopApp: true,
});
