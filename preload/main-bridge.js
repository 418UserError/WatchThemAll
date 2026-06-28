/**
 * WatchThemAll — Main Bridge (popup window preload)
 *
 * Stripped to the absolute minimum. No getters, no method shorthand,
 * no arrow functions, no optional chaining in exposed values.
 * Two separate contextBridge calls for chrome + wtAPI.
 */

var contextBridge = require('electron').contextBridge;
var ipcRenderer = require('electron').ipcRenderer;

// ── Storage ───────────────────────────────────────────────────
function storageGet(defaults) {
  return ipcRenderer.invoke('storage:get', defaults);
}
function storageSet(obj) {
  return ipcRenderer.invoke('storage:set', obj);
}

// ── Tabs ──────────────────────────────────────────────────────
function tabsCreate(opts) {
  if (opts && opts.url) return ipcRenderer.invoke('open-embed', opts.url);
  return Promise.resolve();
}

// ── Providers JSON cache ──────────────────────────────────────
var _providersJson = null;
var _providersReady = false;
ipcRenderer.invoke('read-providers-json').then(function(data) {
  _providersJson = data;
  _providersReady = true;
}).catch(function(err) {
  console.error('[WTA bridge] providers.json load failed:', err);
});

function readProvidersJson() {
  if (_providersReady) return Promise.resolve(_providersJson);
  return ipcRenderer.invoke('read-providers-json');
}

// ── Expose under safe names (window.chrome is pre-existing in Chromium) ─
contextBridge.exposeInMainWorld('__wtaChrome', {
  storage: {
    local: {
      get: storageGet,
      set: storageSet,
    },
  },
  tabs: {
    create: tabsCreate,
  },
  runtime: {
    id: 'watchthemall',
  },
});

contextBridge.exposeInMainWorld('__wtaAPI', {
  readProvidersJson: readProvidersJson,
  openEmbed: function(url) {
    return ipcRenderer.invoke('open-embed', url);
  },
  exportData: function() {
    return ipcRenderer.invoke('export-data');
  },
  importData: function(payload) {
    return ipcRenderer.invoke('import-data', payload);
  },
  getDataDir: function() {
    return ipcRenderer.invoke('get-data-dir');
  },
  onMenuAction: function(callback) {
    ipcRenderer.on('menu-action', function(event, action) { callback(action); });
  },
  onNavigateTab: function(callback) {
    ipcRenderer.on('navigate-tab', function(event, tab) { callback(tab); });
  },
  onDataImported: function(callback) {
    ipcRenderer.on('data-imported', function() { callback(); });
  },
});
