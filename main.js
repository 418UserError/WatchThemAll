/**
 * WatchThemAll — Electron main process
 *
 * Owns the data store (plain JSON file), manages BrowserWindows,
 * and bridges IPC between renderer processes and storage.
 *
 * NO external storage dependencies — uses fs to read/write a single
 * JSON file in the user's app data directory. This avoids the ESM/CJS
 * issues that electron-store v8 has, and works identically on all platforms.
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

// ── JSON File Store ───────────────────────────────────────────
// Replaces chrome.storage.local / electron-store with a simple
// atomic JSON file. Same key space as ReelVault.

const DATA_DIR = path.join(app.getPath('userData'), 'data');
const DATA_FILE = path.join(DATA_DIR, 'watchthemall.json');

const DEFAULTS = {
  vidsrc_schemas: [],
  vidsrc_bookmarks: [],
  vidsrc_form_state: {},
  vidsrc_history: [],
  vidsrc_availability: {},
  vidsrc_active_providers: null,
  vidsrc_provider_catalog: null,
  vidsrc_provider_health: {},
  vidsrc_watchlist_items: [],
  vidsrc_watchlist_last_check: 0,
  vidsrc_watchlist_deleted: [],
};

let _store = null; // lazy-loaded, in-memory cache

function loadStore() {
  if (_store) return _store;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      _store = { ...DEFAULTS, ...JSON.parse(raw) };
    } else {
      _store = { ...DEFAULTS };
      flushStore();
    }
  } catch (err) {
    console.error('WatchThemAll: failed to load store, using defaults:', err.message);
    _store = { ...DEFAULTS };
  }
  return _store;
}

function flushStore() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    // Atomic write: write to temp file, then rename
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(_store, null, 2), 'utf-8');
    fs.renameSync(tmp, DATA_FILE);
  } catch (err) {
    console.error('WatchThemAll: failed to flush store:', err.message);
  }
}

// ── Window state persistence ──────────────────────────────────
const WIN_STATE_FILE = path.join(DATA_DIR, 'window-state.json');

function loadWindowState() {
  try {
    if (fs.existsSync(WIN_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(WIN_STATE_FILE, 'utf-8'));
    }
  } catch (_) { /* ignore */ }
  return { width: 520, height: 750, x: undefined, y: undefined };
}

function saveWindowState(win) {
  const bounds = win.getBounds();
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(WIN_STATE_FILE, JSON.stringify(bounds, null, 2), 'utf-8');
  } catch (_) { /* ignore */ }
}

// ── Window References ─────────────────────────────────────────
let mainWindow = null;
const embedWindows = new Map(); // baseKey → BrowserWindow

// ── IPC Handlers ──────────────────────────────────────────────

// storage:get — mirrors chrome.storage.local.get(defaults)
//   defaults: { key: defaultVal, ... }
//   returns: { key: storedVal_or_defaultVal, ... }
ipcMain.handle('storage:get', (_event, defaults) => {
  const store = loadStore();
  const result = {};
  for (const [key, defaultVal] of Object.entries(defaults)) {
    result[key] = (key in store) ? store[key] : defaultVal;
  }
  return result;
});

// storage:set — mirrors chrome.storage.local.set(obj)
ipcMain.handle('storage:set', (_event, obj) => {
  const store = loadStore();
  for (const [key, value] of Object.entries(obj)) {
    store[key] = value;
  }
  flushStore();
  return true;
});

// open-embed — opens an embed URL in a dedicated BrowserWindow
ipcMain.handle('open-embed', (_event, url) => {
  const urlObj = new URL(url);
  const baseKey = `${urlObj.protocol}//${urlObj.hostname}`;

  // Reuse window for same host
  let embedWin = embedWindows.get(baseKey);
  if (embedWin && !embedWin.isDestroyed()) {
    embedWin.loadURL(url);
    embedWin.focus();
    return true;
  }

  embedWin = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'WatchThemAll — Player',
    webPreferences: {
      preload: path.join(__dirname, 'preload', 'embed-bridge.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  embedWin.loadURL(url);

  embedWin.on('closed', () => {
    embedWindows.delete(baseKey);
  });

  embedWindows.set(baseKey, embedWin);
  return true;
});

// read-providers-json — reads and parses the bundled providers.json
ipcMain.handle('read-providers-json', () => {
  const filePath = path.join(__dirname, 'src', 'providers.json');
  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw);
});

// ── App Lifecycle ─────────────────────────────────────────────
function createMainWindow() {
  const state = loadWindowState();

  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 440,
    minHeight: 550,
    title: 'WatchThemAll',
    webPreferences: {
      preload: path.join(__dirname, 'preload', 'main-bridge.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'popup.html'));

  // Save window position/size on move/resize
  mainWindow.on('resize', () => saveWindowState(mainWindow));
  mainWindow.on('move', () => saveWindowState(mainWindow));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  // Pre-load the store to catch any file issues early
  loadStore();
  createMainWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});
