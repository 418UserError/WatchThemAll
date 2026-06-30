/**
 * WatchThemAll — Electron main process
 *
 * Desktop application for navigating video embed pages, bookmarking
 * series, and tracking new episode releases. Ported from ReelVault
 * Chrome extension with full feature parity + desktop enhancements.
 *
 * Features:
 *   - Resizable management window (remembers size/position)
 *   - Dedicated embed player windows with edge navigation buttons
 *   - Application menu (File, Edit, View, Help)
 *   - Keyboard shortcuts for all tabs and common actions
 *   - Background watchlist checking with system notifications
 *   - System tray for quick access
 *   - JSON file storage (zero external dependencies)
 */

const { app, BrowserWindow, ipcMain, Menu, Tray, Notification, dialog, session } = require('electron');
const path = require('path');
const fs = require('fs');

const APP_NAME = 'WatchThemAll';
const APP_VERSION = app.getVersion();

// ── Browser Identity Spoofing ─────────────────────────────────
// Providers block requests with "Electron" in the User-Agent.
// We spoof a standard Chrome UA so all API calls (health probes,
// IMDB searches, TVmaze, TMDB, GitHub) look like regular Chrome.
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

function setupBrowserIdentity() {
  const ses = session.defaultSession;

  // Override User-Agent at the session level
  ses.setUserAgent(CHROME_UA);

  // Strip Electron-revealing headers from every HTTP request
  ses.webRequest.onBeforeSendHeaders(
    { urls: ['http://*/*', 'https://*/*'] },
    (details, callback) => {
      delete details.requestHeaders['Sec-CH-UA'];
      delete details.requestHeaders['Sec-CH-UA-Arch'];
      delete details.requestHeaders['Sec-CH-UA-Bitness'];
      delete details.requestHeaders['Sec-CH-UA-Full-Version'];
      delete details.requestHeaders['Sec-CH-UA-Full-Version-List'];
      delete details.requestHeaders['Sec-CH-UA-Mobile'];
      delete details.requestHeaders['Sec-CH-UA-Model'];
      delete details.requestHeaders['Sec-CH-UA-Platform'];
      delete details.requestHeaders['Sec-CH-UA-Platform-Version'];
      callback({ requestHeaders: details.requestHeaders });
    }
  );
}

// Call after app is ready — session API requires it
let _identitySetup = false;
function ensureBrowserIdentity() {
  if (_identitySetup) return;
  _identitySetup = true;
  setupBrowserIdentity();
}

// ── JSON File Store ───────────────────────────────────────────
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

let _store = null;

function loadStore() {
  if (_store) return _store;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(DATA_FILE)) {
      _store = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')) };
    } else {
      _store = { ...DEFAULTS };
      flushStore();
    }
  } catch (err) {
    console.error(`${APP_NAME}: failed to load store:`, err.message);
    _store = { ...DEFAULTS };
  }
  return _store;
}

function flushStore() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(_store, null, 2), 'utf-8');
    fs.renameSync(tmp, DATA_FILE);
  } catch (err) {
    console.error(`${APP_NAME}: failed to flush store:`, err.message);
  }
}

// ── Window State ──────────────────────────────────────────────
const WIN_STATE_FILE = path.join(DATA_DIR, 'window-state.json');

function loadWindowState() {
  try {
    if (fs.existsSync(WIN_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(WIN_STATE_FILE, 'utf-8'));
    }
  } catch (_) {}
  return { width: 1024, height: 680, x: undefined, y: undefined };
}

function saveWindowState(win) {
  try {
    const bounds = win.getBounds();
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(WIN_STATE_FILE, JSON.stringify(bounds, null, 2), 'utf-8');
  } catch (_) {}
}

// ── Window References ─────────────────────────────────────────
let mainWindow = null;
let tray = null;
const embedWindows = new Map();

// ── Background Watchlist Check ────────────────────────────────
let watchlistTimer = null;
const WATCHLIST_CHECK_INTERVAL = 60 * 60 * 1000; // every hour

async function runBackgroundWatchlistCheck() {
  // Skip if main window is open (popup handles its own check)
  if (mainWindow && !mainWindow.isDestroyed()) return;

  const store = loadStore();
  const items = store.vidsrc_watchlist_items || [];
  if (!items.length) return;

  // Find items with pending updates
  const pending = items.filter(w => w.hasUpdate);
  if (pending.length === 0) return;

  // Show notification
  const count = pending.length;
  const label = count === 1 ? pending[0].name : `${count} series`;
  try {
    const notif = new Notification({
      title: 'WatchThemAll — New Episodes',
      body: `${label} ${count === 1 ? 'has' : 'have'} new content available.`,
      urgency: 'normal',
    });
    notif.on('click', () => {
      if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
      mainWindow.focus();
      mainWindow.webContents.send('navigate-tab', 'watchlist');
    });
    notif.show();
  } catch (_) { /* notifications may be disabled */ }
}

function startWatchlistTimer() {
  if (watchlistTimer) clearInterval(watchlistTimer);
  watchlistTimer = setInterval(runBackgroundWatchlistCheck, WATCHLIST_CHECK_INTERVAL);
  // Run once 10s after startup
  setTimeout(runBackgroundWatchlistCheck, 10000);
}

// ── Application Menu ──────────────────────────────────────────
function buildMenu() {
  const isMac = process.platform === 'darwin';

  const template = [
    // File
    {
      label: 'File',
      submenu: [
        {
          label: 'New Bookmark',
          accelerator: 'CmdOrCtrl+N',
          click: () => mainWindow?.webContents.send('menu-action', 'new-bookmark'),
        },
        {
          label: 'New Watchlist Item',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => mainWindow?.webContents.send('menu-action', 'new-watchlist'),
        },
        { type: 'separator' },
        {
          label: 'Export Data',
          accelerator: 'CmdOrCtrl+Shift+E',
          click: async () => {
            const store = loadStore();
            const payload = {
              version: 1,
              exportedAt: new Date().toISOString(),
              data: {
                vidsrc_bookmarks: store.vidsrc_bookmarks || [],
                vidsrc_watchlist_items: store.vidsrc_watchlist_items || [],
                vidsrc_history: store.vidsrc_history || [],
                vidsrc_active_providers: store.vidsrc_active_providers || [],
                vidsrc_schemas: store.vidsrc_schemas || [],
              },
            };
            const json = JSON.stringify(payload, null, 2);
            const { filePath } = await dialog.showSaveDialog(mainWindow, {
              title: 'Export WatchThemAll Data',
              defaultPath: `watchthemall-${new Date().toISOString().slice(0,10)}.json`,
              filters: [{ name: 'JSON', extensions: ['json'] }],
            });
            if (filePath) fs.writeFileSync(filePath, json, 'utf-8');
          },
        },
        { type: 'separator' },
        {
          label: 'Import Data',
          accelerator: 'CmdOrCtrl+Shift+I',
          click: async () => {
            const { filePaths } = await dialog.showOpenDialog(mainWindow, {
              title: 'Import WatchThemAll Data',
              filters: [{ name: 'JSON', extensions: ['json'] }],
              properties: ['openFile'],
            });
            if (!filePaths || !filePaths.length) return;
            try {
              const raw = fs.readFileSync(filePaths[0], 'utf-8');
              const imported = JSON.parse(raw);
              const ok = await ipcMain.emit ? true : false;
              // Invoke the handler directly
              const result = await (async () => {
                if (!imported || !imported.data) return false;
                const store = loadStore();
                const { data } = imported;
                // ... same merge logic as import-data handler
                if (Array.isArray(data.vidsrc_bookmarks)) {
                  const ids = new Set((store.vidsrc_bookmarks||[]).map(b=>b.bookmarkId));
                  for (const bm of data.vidsrc_bookmarks) if (!ids.has(bm.bookmarkId)) { store.vidsrc_bookmarks.push(bm); ids.add(bm.bookmarkId); }
                }
                if (Array.isArray(data.vidsrc_watchlist_items)) {
                  const ids = new Set((store.vidsrc_watchlist_items||[]).map(w=>w.watchId));
                  for (const wl of data.vidsrc_watchlist_items) if (!ids.has(wl.watchId)) { store.vidsrc_watchlist_items.push(wl); ids.add(wl.watchId); }
                }
                if (Array.isArray(data.vidsrc_history)) {
                  const ids = new Set((store.vidsrc_history||[]).map(h=>h.historyId));
                  for (const h of data.vidsrc_history) if (!ids.has(h.historyId)) { store.vidsrc_history.push(h); ids.add(h.historyId); }
                }
                if (Array.isArray(data.vidsrc_schemas)) {
                  const ids = new Set((store.vidsrc_schemas||[]).map(s=>s.schemaId));
                  for (const s of data.vidsrc_schemas) if (!ids.has(s.schemaId)) { store.vidsrc_schemas.push(s); ids.add(s.schemaId); }
                }
                if (Array.isArray(data.vidsrc_active_providers)) {
                  const existing = new Set(store.vidsrc_active_providers || []);
                  for (const pid of data.vidsrc_active_providers) existing.add(pid);
                  store.vidsrc_active_providers = [...existing];
                }
                flushStore();
                return true;
              })();
              if (result && mainWindow) {
                mainWindow.webContents.send('data-imported');
              }
            } catch (err) {
              dialog.showErrorBox('Import Failed', err.message);
            }
          },
        },
        { type: 'separator' },
        isMac ? { role: 'close', label: 'Close Window' } : { role: 'quit', label: 'Quit' },
      ],
    },
    // Edit
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    // View
    {
      label: 'View',
      submenu: [
        {
          label: 'Providers',
          accelerator: 'CmdOrCtrl+1',
          click: () => mainWindow?.webContents.send('navigate-tab', 'schemas'),
        },
        {
          label: 'Bookmarks',
          accelerator: 'CmdOrCtrl+2',
          click: () => mainWindow?.webContents.send('navigate-tab', 'bookmarks'),
        },
        {
          label: 'Watchlist',
          accelerator: 'CmdOrCtrl+3',
          click: () => mainWindow?.webContents.send('navigate-tab', 'watchlist'),
        },
        {
          label: 'History',
          accelerator: 'CmdOrCtrl+4',
          click: () => mainWindow?.webContents.send('navigate-tab', 'history'),
        },
        { type: 'separator' },
        { role: 'reload', label: 'Reload' },
        { role: 'toggleDevTools', label: 'Developer Tools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
      ],
    },
    // Help
    {
      label: 'Help',
      submenu: [
        {
          label: `About ${APP_NAME}`,
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: `About ${APP_NAME}`,
              message: APP_NAME,
              detail: `Version ${APP_VERSION}\n\nCross-platform desktop app for navigating video embed pages, bookmarking series, and tracking new episode releases.\n\nPorted from the ReelVault browser extension.`,
            });
          },
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// ── IPC Handlers ──────────────────────────────────────────────

ipcMain.handle('storage:get', (_event, defaults) => {
  const store = loadStore();
  const result = {};
  for (const [key, defaultVal] of Object.entries(defaults)) {
    result[key] = (key in store) ? store[key] : defaultVal;
  }
  console.log('[WTA main] storage:get keys:', Object.keys(defaults), '→ returning', Object.keys(result).length, 'keys');
  return result;
});

ipcMain.handle('storage:set', (_event, obj) => {
  const store = loadStore();
  Object.assign(store, obj);
  flushStore();
  console.log('[WTA main] storage:set keys:', Object.keys(obj));
  return true;
});

ipcMain.handle('open-embed', (_event, url) => {
  // Reuse window if exact same URL is already open
  let embedWin = embedWindows.get(url);
  if (embedWin && !embedWin.isDestroyed()) {
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
      sandbox: true,
    },
  });

  embedWin.loadURL(url);
  embedWin.show();
  embedWin.focus();

  // Handle load failures — show a reload prompt
  embedWin.webContents.on('did-fail-load', (_event, errorCode, errorDesc, validatedURL) => {
    if (errorCode === -3 || errorCode === -105 || errorCode === -106) return; // aborted/navigation, ignore
    try {
      embedWin.webContents.executeJavaScript(`
        if (document.body && !document.getElementById('wta-error-overlay')) {
          var d = document.createElement('div');
          d.id = 'wta-error-overlay';
          d.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;background:rgba(0,0,0,0.85);color:#fff;font-family:system-ui,sans-serif;font-size:14px;text-align:center;padding:20px';
          d.innerHTML = '<div style="font-size:18px;font-weight:600">Failed to load player</div><div style="color:#999;font-size:12px">The embed provider may be unavailable</div><button onclick="location.reload()" style="padding:8px 24px;background:#6366f1;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600">Retry</button><button onclick="window.close()" style="padding:8px 24px;background:transparent;color:#999;border:1px solid #444;border-radius:6px;cursor:pointer;font-size:13px">Close</button>';
          document.body.appendChild(d);
        }
      `).catch(() => {});
    } catch (_) {}
  });

  // Block ALL popups from player windows — no ads, no popups.
  embedWin.webContents.setWindowOpenHandler(() => {
    return { action: 'deny' };
  });

  embedWin.on('closed', () => {
    embedWindows.delete(url);
  });

  embedWindows.set(url, embedWin);
  return true;
});

ipcMain.handle('read-providers-json', () => {
  const filePath = path.join(__dirname, 'src', 'providers.json');
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
});

// export-data — returns all data as JSON in shared sync format
ipcMain.handle('export-data', () => {
  const store = loadStore();
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    data: {
      vidsrc_bookmarks: store.vidsrc_bookmarks || [],
      vidsrc_watchlist_items: store.vidsrc_watchlist_items || [],
      vidsrc_history: store.vidsrc_history || [],
      vidsrc_active_providers: store.vidsrc_active_providers || [],
      vidsrc_schemas: store.vidsrc_schemas || [],
    },
  };
  return payload;
});

// import-data — merges imported data into the store
ipcMain.handle('import-data', (_event, imported) => {
  const store = loadStore();
  if (!imported || !imported.data) return false;

  const { data } = imported;

  // Merge bookmarks by bookmarkId
  if (Array.isArray(data.vidsrc_bookmarks)) {
    const existingIds = new Set((store.vidsrc_bookmarks || []).map(b => b.bookmarkId));
    for (const bm of data.vidsrc_bookmarks) {
      if (!existingIds.has(bm.bookmarkId)) {
        store.vidsrc_bookmarks.push(bm);
        existingIds.add(bm.bookmarkId);
      }
    }
  }

  // Merge watchlist by watchId
  if (Array.isArray(data.vidsrc_watchlist_items)) {
    const existingIds = new Set((store.vidsrc_watchlist_items || []).map(w => w.watchId));
    for (const wl of data.vidsrc_watchlist_items) {
      if (!existingIds.has(wl.watchId)) {
        store.vidsrc_watchlist_items.push(wl);
        existingIds.add(wl.watchId);
      }
    }
  }

  // Merge history by historyId
  if (Array.isArray(data.vidsrc_history)) {
    const existingIds = new Set((store.vidsrc_history || []).map(h => h.historyId));
    for (const h of data.vidsrc_history) {
      if (!existingIds.has(h.historyId)) {
        store.vidsrc_history.push(h);
        existingIds.add(h.historyId);
      }
    }
  }

  // Merge schemas by schemaId
  if (Array.isArray(data.vidsrc_schemas)) {
    const existingIds = new Set((store.vidsrc_schemas || []).map(s => s.schemaId));
    for (const s of data.vidsrc_schemas) {
      if (!existingIds.has(s.schemaId)) {
        store.vidsrc_schemas.push(s);
        existingIds.add(s.schemaId);
      }
    }
  }

  // Merge active providers (unique)
  if (Array.isArray(data.vidsrc_active_providers)) {
    const existing = new Set(store.vidsrc_active_providers || []);
    for (const pid of data.vidsrc_active_providers) {
      existing.add(pid);
    }
    store.vidsrc_active_providers = [...existing];
  }

  flushStore();
  return true;
});

// get-data-dir — returns the data directory path (for UI footer)
ipcMain.handle('get-data-dir', () => {
  return DATA_DIR;
});

// ── Window Creation ───────────────────────────────────────────
function createMainWindow() {
  const state = loadWindowState();

  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 780,
    minHeight: 550,
    title: APP_NAME,
    webPreferences: {
      preload: path.join(__dirname, 'preload', 'main-bridge.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'app.html'));

  // Block ALL popups from the main window — embed windows are
  // only opened via the open-embed IPC handler.
  mainWindow.webContents.setWindowOpenHandler(() => {
    return { action: 'deny' };
  });

  mainWindow.on('resize', () => saveWindowState(mainWindow));
  mainWindow.on('move', () => saveWindowState(mainWindow));
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── App Lifecycle ─────────────────────────────────────────────
app.whenReady().then(() => {
  ensureBrowserIdentity();
  loadStore();
  buildMenu();
  createMainWindow();
  startWatchlistTimer();

  // Global safety net: close any untracked window immediately.
  // Only the main window and embed windows (opened via open-embed IPC)
  // are allowed to exist. Ads sometimes find ways to spawn windows
  // that bypass per-webContents handlers.
  // DISABLED for debugging player click issues
  /*
  app.on('browser-window-created', (_event, win) => {
    setImmediate(() => {
      if (win === mainWindow) return;
      let found = false;
      for (const [url, ew] of embedWindows) {
        if (ew === win) { found = true; break; }
      }
      if (!found && !win.isDestroyed()) {
        win.close();
      }
    });
  });
  */

  // System tray (optional — can be disabled from settings)
  try {
    tray = new Tray(path.join(__dirname, 'icons', 'icon16.png'));
    tray.setToolTip(APP_NAME);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: `Open ${APP_NAME}`, click: () => {
        if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
        mainWindow.focus();
      }},
      { type: 'separator' },
      { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
    ]));
    tray.on('click', () => {
      if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
      mainWindow.focus();
    });
  } catch (_) { /* tray icon may fail on some Linux DEs */ }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});

app.on('before-quit', () => {
  app.isQuitting = true;
  if (watchlistTimer) clearInterval(watchlistTimer);
});
