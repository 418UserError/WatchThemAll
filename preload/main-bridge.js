/**
 * WatchThemAll — Main Bridge (popup window preload)
 *
 * Exposes chrome.storage.local (get/set), chrome.tabs.create,
 * and chrome.runtime.getURL via contextBridge so the ported
 * ReelVault popup code runs with ZERO changes to storage.js.
 *
 * Also exposes wtAPI for the two operations without a direct
 * chrome.* equivalent: reading the bundled providers.json and
 * opening embed URLs.
 */

const { contextBridge, ipcRenderer } = require('electron');

// ── Providers JSON cache ──────────────────────────────────────
// Loaded asynchronously at preload init. The popup code calls
// wtAPI.readProvidersJson() which awaits the cached result.
let _providersJsonReady = false;
let _providersJson = null;

(async () => {
  try {
    _providersJson = await ipcRenderer.invoke('read-providers-json');
    _providersJsonReady = true;
  } catch (err) {
    console.error('WatchThemAll: failed to load providers.json:', err);
  }
})();

// ── chrome.storage.local shim ─────────────────────────────────
// The ported code calls:
//   await chrome.storage.local.get({ key: defaultVal, ... })
//   await chrome.storage.local.set({ key: value, ... })
//
// contextBridge wraps these in proxy functions. The main world
// calls them; the preload world forwards to main process via IPC.

const chromeStorageLocal = {
  get(defaults) {
    return ipcRenderer.invoke('storage:get', defaults);
  },
  set(obj) {
    return ipcRenderer.invoke('storage:set', obj);
  },
};

// ── chrome.tabs.create shim ───────────────────────────────────
const chromeTabs = {
  create(opts) {
    if (opts && opts.url) {
      return ipcRenderer.invoke('open-embed', opts.url);
    }
    return Promise.resolve();
  },
};

// ── chrome.runtime shim ───────────────────────────────────────
const chromeRuntime = {
  get id() { return 'watchthemall'; },
};

// ── Expose to main world ──────────────────────────────────────
contextBridge.exposeInMainWorld('chrome', {
  storage: {
    local: chromeStorageLocal,
  },
  tabs: chromeTabs,
  runtime: chromeRuntime,
});

// ── wtAPI — Electron-specific helpers ─────────────────────────
contextBridge.exposeInMainWorld('wtAPI', {
  // Returns the parsed providers.json object (already cached at preload init)
  async readProvidersJson() {
    if (_providersJsonReady) return _providersJson;
    return ipcRenderer.invoke('read-providers-json');
  },

  // Opens an embed URL in a dedicated player window
  openEmbed(url) {
    return ipcRenderer.invoke('open-embed', url);
  },

  // Export all data as JSON
  exportData() {
    return ipcRenderer.invoke('export-data');
  },

  // Import data from JSON payload
  importData(payload) {
    return ipcRenderer.invoke('import-data', payload);
  },

  // Get data directory path
  getDataDir() {
    return ipcRenderer.invoke('get-data-dir');
  },

  // Listen for menu/navigation events from main process
  onMenuAction(callback) {
    ipcRenderer.on('menu-action', (_event, action) => callback(action));
  },
  onNavigateTab(callback) {
    ipcRenderer.on('navigate-tab', (_event, tab) => callback(tab));
  },
  onDataImported(callback) {
    ipcRenderer.on('data-imported', () => callback());
  },
});
