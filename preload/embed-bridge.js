/**
 * WatchThemAll — Embed Bridge (player window preload)
 *
 * Runs in every embed BrowserWindow. Injects:
 * 1. Edge navigation buttons (prev/next episode, prev/next season)
 * 2. Watch progress tracking (updates bookmark.lastSeason/lastEpisode)
 * 3. Watch history recording (10s minimum, dedup, status tracking)
 * 4. Fullscreen-aware visibility
 *
 * All DOM manipulation runs directly in the preload context.
 * Storage goes through IPC to the main process.
 *
 * This is a direct port of the ReelVault content.js, adapted
 * for Electron's preload model.
 */

const { contextBridge, ipcRenderer } = require('electron');

// ── Storage helpers (preload scope — direct IPC) ──────────────
// Wrapped in try/catch so storage failures don't break the page.

async function storageGet(keys) {
  try {
    return await ipcRenderer.invoke('storage:get', keys);
  } catch (err) {
    console.error('WTA embed: storageGet failed:', err.message);
    return keys; // return defaults on failure
  }
}

async function storageSet(obj) {
  try {
    return await ipcRenderer.invoke('storage:set', obj);
  } catch (err) {
    console.error('WTA embed: storageSet failed:', err.message);
  }
}

// ── Expose chrome.storage.local to the page world ─────────────
// So page scripts can access storage if needed.
contextBridge.exposeInMainWorld('chrome', {
  storage: {
    local: {
      async get(keys) { return ipcRenderer.invoke('storage:get', keys); },
      async set(obj)  { return ipcRenderer.invoke('storage:set', obj); },
    },
  },
  runtime: {
    get id() { return 'watchthemall'; },
  },
});

// ── Inject CSS ────────────────────────────────────────────────
// Matches the ReelVault content.css — glass-morphism buttons,
// fullscreen hiding, responsive positioning.

(function injectCSS() {
  const style = document.createElement('style');
  style.textContent = `
    /* WatchThemAll — Edge Navigation Buttons */
    .wta-nav-btn {
      position: fixed !important;
      z-index: 2147483647 !important;
      min-width: 60px !important;
      height: 34px !important;
      padding: 4px 10px !important;
      background: rgba(15, 15, 25, 0.65) !important;
      backdrop-filter: blur(12px) saturate(140%) !important;
      -webkit-backdrop-filter: blur(12px) saturate(140%) !important;
      border: 1px solid rgba(255, 255, 255, 0.08) !important;
      border-radius: 10px !important;
      color: #ededf5 !important;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif !important;
      font-size: 12px !important;
      font-weight: 600 !important;
      cursor: pointer !important;
      opacity: 0.35 !important;
      margin: 0 !important;
      transition: opacity 180ms ease, background 180ms ease, border-color 180ms ease, box-shadow 180ms ease, transform 150ms ease !important;
      -webkit-appearance: none !important;
      appearance: none !important;
      outline: none !important;
    }
    .wta-nav-btn:hover {
      opacity: 1 !important;
      background: rgba(15, 15, 25, 0.88) !important;
      border-color: rgba(255, 255, 255, 0.16) !important;
      box-shadow: 0 0 18px rgba(255,255,255,0.05), 0 0 40px rgba(99, 102, 241, 0.08) !important;
    }
    .wta-nav-btn:active {
      transform: scale(0.94) !important;
    }
    /* Hide buttons in fullscreen */
    .wta-nav-btn.wta-fullscreen-hidden {
      opacity: 0 !important;
      pointer-events: none !important;
    }
  `;
  document.head.appendChild(style);
})();

// ── Content Script ────────────────────────────────────────────
// Runs immediately in the preload context.

(async function () {
  'use strict';

  const url = new URL(window.location.href);

  /* ── URL parsing ──────────────────────────────────────────── */
  function tryParse(parser) {
    const r = parser();
    return (r && r.parsedId) ? r : null;
  }

  function parseQueryParams() {
    let parsedId = url.searchParams.get('imdb') || url.searchParams.get('id') || url.searchParams.get('video_id');
    if (!parsedId) {
      for (const [key, val] of url.searchParams) {
        if (/^(season|s|se|episode|e|ep)$/.test(key)) continue;
        if (/^tt\d{7,}$/.test(val) || /^\d+$/.test(val)) { parsedId = val; break; }
      }
    }
    if (!parsedId) return null;
    const s = parseInt(url.searchParams.get('season') || url.searchParams.get('s') || url.searchParams.get('se'));
    const e = parseInt(url.searchParams.get('episode') || url.searchParams.get('e') || url.searchParams.get('ep'));
    return { parsedId, season: isNaN(s) ? null : s, episode: isNaN(e) ? null : e, navMode: 'query' };
  }

  function parseTtPath() {
    const parts = url.pathname.split('/').filter(Boolean);
    const idx = parts.findIndex(p => /^tt\d{7,}$/.test(p));
    if (idx < 0 || idx + 2 >= parts.length) return null;
    return { parsedId: parts[idx], season: parseInt(parts[idx+1]), episode: parseInt(parts[idx+2]), navMode: 'path', parts, idx };
  }

  function parseSuffixPath() {
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    if (parts.length >= 3) {
      const s = parseInt(parts[parts.length-2]);
      const e = parseInt(parts[parts.length-1]);
      if (!isNaN(s) && !isNaN(e)) {
        return { parsedId: parts[parts.length-3], season: s, episode: e, navMode: 'suffix', parts, idx: parts.length - 3 };
      }
    }
    const id = parts[parts.length-1];
    if (id && id.length >= 4) return { parsedId: id, season: null, episode: null, navMode: 'suffix' };
    return null;
  }

  function parseHybridQuery() {
    for (const [, val] of url.searchParams) {
      const parts = val.split('/');
      if (parts.length === 3 && !isNaN(parseInt(parts[1])) && !isNaN(parseInt(parts[2]))) {
        return { parsedId: parts[0], season: parseInt(parts[1]), episode: parseInt(parts[2]), navMode: 'hybrid' };
      }
    }
    return null;
  }

  function parseHyphenPath() {
    const parts = url.pathname.split('/').filter(Boolean);
    if (!parts.length) return null;
    const last = parts[parts.length-1];
    const m = last.match(/^(tt\d{7,}|\d+)-(\d+)-(\d+)$/);
    if (!m) return null;
    const id = m[1];
    const season = parseInt(m[2]);
    const episode = parseInt(m[3]);
    if (!/^tt\d{7,}$/.test(id) && !/^\d+$/.test(id)) return null;
    return { parsedId: id, season, episode, navMode: 'hyphen', parts, idx: parts.length - 1 };
  }

  const parsed = tryParse(parseQueryParams)
    || tryParse(parseTtPath)
    || tryParse(parseHybridQuery)
    || tryParse(parseHyphenPath)
    || tryParse(parseSuffixPath);

  if (!parsed) return; // Not an embed page — exit silently

  const { parsedId, season, episode, navMode, parts, idx } = parsed;
  const isMovie = season === null || isNaN(season);

  /* ── Bookmark lookup ──────────────────────────────────────── */
  function findBookmark(bookmarks, id) {
    let bm = bookmarks.find(b => b.imdb === id || b.tmdbId === id);
    if (bm) return bm;
    if (/^\d+$/.test(id)) {
      bm = bookmarks.find(b => b.tmdbId === id);
      if (bm) return bm;
    }
    return null;
  }

  /* ── Load bookmarks ───────────────────────────────────────── */
  const data = await storageGet({
    vidsrc_bookmarks: [],
    vidsrc_history: [],
  });

  const bookmarks = data.vidsrc_bookmarks || [];
  let history = data.vidsrc_history || [];
  let trackedBookmark = findBookmark(bookmarks, parsedId);

  /* ── Build navigation URL ─────────────────────────────────── */
  function buildNavUrl(navSeason, navEpisode) {
    if (navMode === 'path' && parts && idx !== undefined) {
      const p = [...parts];
      p[idx+1] = String(navSeason);
      p[idx+2] = String(navEpisode);
      return url.origin + '/' + p.join('/') + url.search + url.hash;
    }
    if (navMode === 'suffix' && parts && idx !== undefined) {
      const p = [...parts];
      p[idx+1] = String(navSeason);
      p[idx+2] = String(navEpisode);
      return url.origin + '/' + p.join('/') + url.search + url.hash;
    }
    if (navMode === 'hyphen' && parts && idx !== undefined) {
      const p = [...parts];
      const idPart = p[idx].split('-')[0];
      p[idx] = `${idPart}-${navSeason}-${navEpisode}`;
      return url.origin + '/' + p.join('/') + url.search + url.hash;
    }
    if (navMode === 'query') {
      const newUrl = new URL(url);
      newUrl.searchParams.set('season', navSeason);
      newUrl.searchParams.set('episode', navEpisode);
      return newUrl.href;
    }
    return url.href;
  }

  function navigateTo(navSeason, navEpisode) {
    if (!trackedBookmark) return;
    const dest = buildNavUrl(navSeason, navEpisode);
    location.assign(dest);
  }

  /* ── Create DOM buttons ───────────────────────────────────── */
  function createButton(id, text, cssProps) {
    if (document.getElementById(id)) return document.getElementById(id);
    const btn = document.createElement('button');
    btn.id = id;
    btn.className = 'wta-nav-btn';
    btn.textContent = text;
    Object.assign(btn.style, cssProps);
    btn.addEventListener('mouseenter', () => {
      btn.style.opacity = '1';
      btn.style.background = 'rgba(15, 15, 25, 0.88)';
      btn.style.borderColor = 'rgba(255, 255, 255, 0.16)';
      btn.style.boxShadow = '0 0 18px rgba(255,255,255,0.05), 0 0 40px rgba(99, 102, 241, 0.08)';
    });
    btn.addEventListener('mouseleave', () => {
      if (btn.classList.contains('wta-fullscreen-hidden')) return;
      btn.style.opacity = '0.35';
      btn.style.background = 'rgba(15, 15, 25, 0.65)';
      btn.style.borderColor = 'rgba(255, 255, 255, 0.08)';
      btn.style.boxShadow = 'none';
    });
    btn.addEventListener('mousedown', () => { btn.style.transform = 'scale(0.94)'; });
    btn.addEventListener('mouseup', () => { btn.style.transform = 'scale(1)'; });
    document.body.appendChild(btn);
    return btn;
  }

  /* ── Fullscreen detection ─────────────────────────────────── */
  function isFullscreen() {
    return !!(document.fullscreenElement
      || document.webkitFullscreenElement
      || document['mozFullScreenElement']);
  }

  function updateButtonVisibility() {
    const hidden = isFullscreen();
    ['wta-prev-ep', 'wta-next-ep', 'wta-prev-season', 'wta-next-season'].forEach(id => {
      const btn = document.getElementById(id);
      if (btn) {
        if (hidden) {
          btn.classList.add('wta-fullscreen-hidden');
        } else {
          btn.classList.remove('wta-fullscreen-hidden');
          btn.style.opacity = '0.35';
          btn.style.pointerEvents = 'auto';
        }
      }
    });
  }

  /* ── Build buttons ────────────────────────────────────────── */
  function buildButtons() {
    if (document.getElementById('wta-next-ep')) return;
    if (!trackedBookmark || trackedBookmark.type !== 'tv') return;

    const shared = {
      position: 'fixed',
      zIndex: '2147483647',
      minWidth: '60px',
      height: '34px',
      padding: '4px 10px',
    };

    createButton('wta-prev-ep', '\u25C0\uFE0E Ep', {
      ...shared, left: '4px', top: '50%', marginTop: '-17px',
    }).addEventListener('click', () => {
      const s = season || trackedBookmark.lastSeason || 1;
      const e = (episode || trackedBookmark.lastEpisode || 1) - 1;
      if (e > 0) navigateTo(s, e);
    });

    createButton('wta-next-ep', 'Ep \u25B6\uFE0E', {
      ...shared, right: '4px', top: '50%', marginTop: '-17px',
    }).addEventListener('click', () => {
      const s = season || trackedBookmark.lastSeason || 1;
      const e = (episode || trackedBookmark.lastEpisode || 1) + 1;
      navigateTo(s, e);
    });

    createButton('wta-prev-season', '\u25B2\uFE0E S', {
      ...shared, left: '4px', top: '50%', marginTop: '25px',
    }).addEventListener('click', () => {
      const s = (season || trackedBookmark.lastSeason || 1) - 1;
      if (s > 0) navigateTo(s, 1);
    });

    createButton('wta-next-season', 'S \u25BC\uFE0E', {
      ...shared, right: '4px', top: '50%', marginTop: '25px',
    }).addEventListener('click', () => {
      const s = (season || trackedBookmark.lastSeason || 1) + 1;
      navigateTo(s, 1);
    });
  }

  /* ── Watch tracking ───────────────────────────────────────── */
  async function updateTracking() {
    if (!trackedBookmark || isMovie) return;
    const curS = season != null && !isNaN(season) ? season : null;
    const curE = episode != null && !isNaN(episode) ? episode : null;
    if (curS === null || curE === null) return;
    if (trackedBookmark.lastSeason === curS && trackedBookmark.lastEpisode === curE) return;

    trackedBookmark.lastSeason = curS;
    trackedBookmark.lastEpisode = curE;

    const idx = bookmarks.findIndex(b =>
      b.imdb === trackedBookmark.imdb || b.bookmarkId === trackedBookmark.bookmarkId);
    if (idx >= 0) {
      bookmarks[idx].lastSeason = curS;
      bookmarks[idx].lastEpisode = curE;
    }
    await storageSet({ vidsrc_bookmarks: bookmarks });
  }

  /* ── Watch history ────────────────────────────────────────── */
  let historyRecorded = false;
  const MIN_WATCH_SECONDS = 10;
  const pageEntered = Date.now();

  async function recordWatchHistory() {
    if (historyRecorded) return;
    const elapsed = Math.floor((Date.now() - pageEntered) / 1000);
    if (elapsed < MIN_WATCH_SECONDS) return;

    // Re-fetch bookmarks to find the correct entry
    const fresh = await storageGet({ vidsrc_bookmarks: [], vidsrc_history: [] });
    const freshBookmarks = fresh.vidsrc_bookmarks || [];
    history = fresh.vidsrc_history || [];
    const lookupBm = findBookmark(freshBookmarks, parsedId);
    if (!lookupBm) return;

    const curS = season != null && !isNaN(season) ? season : null;
    const curE = episode != null && !isNaN(episode) ? episode : null;

    const existingIdx = history.findIndex(e =>
      e.imdb === lookupBm.imdb &&
      e.type === lookupBm.type &&
      e.season === curS &&
      e.episode === curE &&
      (Date.now() - e.watchedAt) < 7200000
    );

    if (existingIdx >= 0) {
      history[existingIdx].watchedAt = Date.now();
      history[existingIdx].status = 'watching';
      const [entry] = history.splice(existingIdx, 1);
      history.unshift(entry);
    } else {
      // Mark previous episodes as watched
      if (lookupBm.type === 'tv' && curS && curE) {
        let prevIdx = -1, prevKey = 0;
        const curKey = curS * 10000 + curE;
        for (let i = 0; i < history.length; i++) {
          const e = history[i];
          if (e.imdb === lookupBm.imdb && e.type === 'tv' && e.season && e.episode) {
            const key = e.season * 10000 + e.episode;
            if (key < curKey && key > prevKey && e.status === 'watching') {
              prevKey = key; prevIdx = i;
            }
          }
        }
        if (prevIdx >= 0) history[prevIdx].status = 'watched';
      }

      history.unshift({
        historyId: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        imdb: lookupBm.imdb,
        name: lookupBm.name,
        type: lookupBm.type,
        imageUrl: lookupBm.imageUrl || null,
        season: curS,
        episode: curE,
        watchedAt: Date.now(),
        status: 'watching',
      });
    }

    if (history.length > 200) history.length = 200;
    historyRecorded = true;

    // Retry up to 5 times
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await storageSet({ vidsrc_history: history });
        return;
      } catch (_) {
        await new Promise(r => setTimeout(r, 200));
      }
    }
    historyRecorded = false; // give up — allow retry on next trigger
  }

  /* ── Init ─────────────────────────────────────────────────── */
  if (!isMovie && trackedBookmark) {
    buildButtons();
    updateTracking();

    // MutationObserver — rebuild buttons if DOM is replaced (SPA navigation)
    const observer = new MutationObserver(() => {
      if (!document.getElementById('wta-next-ep')) {
        storageGet({ vidsrc_bookmarks: [] }).then(d => {
          const fresh = d.vidsrc_bookmarks || [];
          trackedBookmark = findBookmark(fresh, parsedId);
          if (trackedBookmark) buildButtons();
        });
      }
      updateButtonVisibility();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  // History recording triggers
  setTimeout(recordWatchHistory, 15000);
  let histInterval = setInterval(recordWatchHistory, 10000);

  document.addEventListener('visibilitychange', () => {
    updateButtonVisibility();
    if (document.visibilityState === 'hidden') recordWatchHistory();
  });

  window.addEventListener('pagehide', () => {
    recordWatchHistory();
    clearInterval(histInterval);
  });

  window.addEventListener('beforeunload', () => {
    recordWatchHistory();
    clearInterval(histInterval);
  });

  // Fullscreen listeners
  document.addEventListener('fullscreenchange', updateButtonVisibility);
  document.addEventListener('webkitfullscreenchange', updateButtonVisibility);
  document.addEventListener('mozfullscreenchange', updateButtonVisibility);

  // Initial fullscreen check (video players may enter fullscreen after load)
  setTimeout(updateButtonVisibility, 1000);
  setTimeout(updateButtonVisibility, 3000);

})();
