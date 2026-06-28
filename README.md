# WatchThemAll — Desktop Stream Navigator

Cross-platform desktop app (Windows, macOS, Linux) for navigating video embed pages, bookmarking series, auto-tracking watch progress, and monitoring new episode releases. Built with Electron.

**A faithful port of the [ReelVault](https://github.com/PredixCode/ReelVault) Chrome extension with 100% feature parity plus desktop-only enhancements.**

---

## Architecture

```
WatchThemAll/
├── main.js                     Electron main process (menus, windows, IPC, storage)
├── package.json                Zero runtime deps (only electron + electron-builder)
├── preload/
│   ├── main-bridge.js          chrome.* API shim → IPC (storage, tabs, runtime)
│   └── embed-bridge.js         1:1 port of content.js — edge buttons, tracking, history
├── src/                        Ported ReelVault code (8 files identical, 2 adapted)
│   ├── popup.html              Management UI (4 tabs)
│   ├── popup.css               Dark indigo theme (responsive for desktop)
│   ├── popup.js                Entry point + desktop IPC listeners
│   ├── popup-ui.js             3 lines changed (chrome.tabs.create → wtAPI.openEmbed)
│   ├── storage.js              Unchanged — uses chrome.storage.local shim
│   ├── models.js               Unchanged — Schema, Bookmark, SegmentConfig, WatchlistItem
│   ├── availability.js         Unchanged — TVmaze episode data
│   ├── watchlist.js            Unchanged — Series release tracker
│   ├── parser.js               Unchanged — IMDB type mapping
│   ├── provider-parser.js      Unchanged — TypeScript template → urlTemplate
│   ├── providers.json          Unchanged — Bundled provider catalog
│   └── content.css             Reference copy (embedded inline in embed-bridge)
├── icons/
├── scripts/
│   └── build.py                electron-builder packaging
└── test/
    └── tests.js                25 tests (JSON store, models, parsers)
```

### Dependency flow

```
main.js (Electron)
  ├── IPC handlers: storage:get/set, open-embed, read-providers-json, export-data
  ├── Background watchlist check (hourly, with native notifications)
  ├── Application menu + keyboard shortcuts
  └── System tray

preload/main-bridge.js
  └── contextBridge → exposes chrome.storage.local, chrome.tabs, chrome.runtime, wtAPI

src/popup.html
  └── models.js → parser.js → provider-parser.js → storage.js
      → availability.js → watchlist.js → popup-ui.js → popup.js
      (8 unchanged files, popup-ui.js has 3 adapted lines)

preload/embed-bridge.js (player windows)
  └── Injects vidsrc-nav-* buttons, runs MutationObserver,
      records watch history, handles fullscreen detection.
      Direct IPC for storage:get/set.
```

---

## Running

```bash
# Install (downloads Electron ~100MB)
npm install

# Launch
npm start

# Run tests
node --test test/

# Package for distribution
npx electron-builder --linux    # AppImage + .deb
npx electron-builder --win      # NSIS installer
npx electron-builder --mac      # DMG
```

---

## Desktop-Only Features

| Feature | ReelVault Extension | WatchThemAll Desktop |
|---|---|---|
| Window size | Fixed 420px popup | Resizable (440–∞ px) |
| Persistent window state | No (destroyed on blur) | Yes (remembers size + position) |
| Application menu | No | File, Edit, View, Help |
| Keyboard shortcuts | No | Ctrl+1–4 (tabs), Ctrl+N (bookmark), Ctrl+F (search), Esc (close form) |
| System tray | No | Quick restore, Quit |
| Background checks | No (only on popup open) | Hourly watchlist check + native OS notifications |
| Data export | No | File → Export Data (Ctrl+Shift+E) → JSON backup |
| Version footer | No | Subtle footer with version number |
| Player windows | Chrome tabs | Dedicated resizeable Electron windows |
| Window reuse | New tab per click | Reuses window for same URL, new window per different URL |

---

## What Changed from ReelVault

Only **3 lines** in the shared codebase needed changes:

```diff
- const resp = await fetch(chrome.runtime.getURL('providers.json'));
- const bundled = await resp.json();
+ const bundled = await window.wtAPI.readProvidersJson();

- if (url) chrome.tabs.create({ url });
+ if (url) window.wtAPI.openEmbed(url);   (×2 occurrences)
```

All 29 `chrome.storage.local.get/set` calls across `storage.js` and `popup-ui.js` work unchanged through the preload shim. The content script (417 lines, 5 URL parsers, episode-aware buttons, watch tracking, history recording) is ported 1:1 into `preload/embed-bridge.js`.

---

## Storage

All data persists to a single JSON file at:

- **Windows:** `%APPDATA%/WatchThemAll/data/watchthemall.json`
- **macOS:** `~/Library/Application Support/WatchThemAll/data/watchthemall.json`
- **Linux:** `~/.config/WatchThemAll/data/watchthemall.json`

Same key space as ReelVault's `chrome.storage.local`. Data can be imported/exported via the File menu. Compatible with ReelVault's storage format — you can migrate data between extension and desktop app by copying the JSON.

---

## Permissions

No browser permissions needed. The app makes network requests to:
- `api.tvmaze.com` — episode data, watchlist tracking
- `v3.sg.media-imdb.com` — IMDB search suggestions
- `api.themoviedb.org` — TMDB ID lookup
- `raw.githubusercontent.com` — Provider catalog sync

No telemetry. No data leaves your machine except these API calls.

---

## Tests

```
$ node --test test/
✔ JSON Store (5 tests)
✔ Data Models (11 tests)
✔ IMDB Parser (5 tests)
✔ Provider Parser (4 tests)

25/25 passing
```

Covers: atomic JSON file writes, persistence across reloads, `Schema.buildUrl()` with all template types, `Bookmark`/`WatchlistItem` data models, IMDB type mapping, and provider TypeScript template parsing.
