/**
 * WatchThemAll — Embed Bridge (player window preload)
 *
 * Direct 1:1 port of ReelVault content.js for Electron.
 * Every feature preserved:
 *   - 5-strategy URL parsing (query, tt-path, hybrid, hyphen, suffix)
 *   - Episode-data-aware buttons (TVmaze fetch, cache-first, real episode bounds)
 *   - Dual-ID bookmark matching (IMDB + TMDB)
 *   - Watch progress tracking with proper query key reuse
 *   - Watch history recording (10s minimum, dedup, retry, status tracking)
 *   - Fullscreen detection with CSS class toggling
 *   - 200ms throttled MutationObserver for SPA DOM replacement
 *
 * Storage calls go through IPC to the main process instead of
 * chrome.storage.local. Everything else is identical DOM logic.
 */

const { contextBridge, ipcRenderer } = require('electron');

// ── Storage helpers (preload scope — direct IPC) ──────────────
// Wraps ipcRenderer.invoke to match chrome.storage.local API.
// Returns empty/defaults on failure so the page never breaks.

const S = {
  async get(keys) {
    try {
      return await ipcRenderer.invoke('storage:get', keys);
    } catch (_) {
      return {};
    }
  },
  async set(obj) {
    try {
      await ipcRenderer.invoke('storage:set', obj);
    } catch (_) { /* non-critical */ }
  },
};

// ── Expose chrome.storage.local to the page world ─────────────
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

// ── Inject content.css (exact ReelVault button styling) ───────
(function () {
  const s = document.createElement('style');
  s.textContent = '.vidsrc-nav-btn{position:fixed;z-index:2147483647;display:flex;flex-direction:row;align-items:center;justify-content:center;gap:6px;background:rgba(15,15,25,0.62);backdrop-filter:blur(14px) saturate(140%);-webkit-backdrop-filter:blur(14px) saturate(140%);border:1px solid rgba(255,255,255,0.07);border-radius:10px;cursor:pointer;user-select:none;-webkit-user-select:none;opacity:0.32;transition:opacity 200ms cubic-bezier(0.16,1,0.3,1),background 200ms cubic-bezier(0.16,1,0.3,1),border-color 200ms ease,box-shadow 200ms ease,transform 160ms cubic-bezier(0.16,1,0.3,1)}.vidsrc-nav-btn:hover{opacity:1;background:rgba(12,12,22,0.90);border-color:rgba(255,255,255,0.15);box-shadow:0 0 20px rgba(0,0,0,0.4),0 0 40px rgba(99,102,241,0.06);transform:scale(1.03)}.vidsrc-nav-btn:active{transform:scale(0.95)}.vidsrc-nav-btn.vidsrc-nav-hidden{opacity:0!important;pointer-events:none!important;transition:opacity 100ms ease}.vidsrc-nav-arrow{font-size:15px;line-height:1;color:#fff;text-shadow:0 1px 3px rgba(0,0,0,0.5);transition:transform 150ms cubic-bezier(0.16,1,0.3,1)}.vidsrc-nav-btn:hover .vidsrc-nav-arrow{transform:scale(1.10)}.vidsrc-nav-label{font-family:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;font-size:10.5px;font-weight:600;color:rgba(255,255,255,0.80);letter-spacing:0.3px;white-space:nowrap;transition:color 150ms ease}.vidsrc-nav-btn:hover .vidsrc-nav-label{color:rgba(255,255,255,0.96)}#vidsrc-prev-ep,#vidsrc-next-ep{width:auto;min-width:60px;height:34px;padding:4px 10px;flex-direction:row;gap:6px;border-radius:10px}#vidsrc-prev-ep .vidsrc-nav-arrow,#vidsrc-next-ep .vidsrc-nav-arrow{font-size:15px}#vidsrc-prev-season,#vidsrc-next-season{width:auto;min-width:96px;height:32px;padding:4px 12px;flex-direction:row;gap:7px;border-radius:10px}#vidsrc-prev-season .vidsrc-nav-arrow,#vidsrc-next-season .vidsrc-nav-arrow{font-size:13px}';
  document.head.appendChild(s);
})();

// ── Ad-blocking: inject kill script into PAGE context ─────────
(function injectAdBlocker() {
  var killScript = document.createElement('script');
  killScript.textContent = '(' + function() {
    'use strict';
    window.open = function() { return null; };

    var _formSubmit = HTMLFormElement.prototype.submit;
    HTMLFormElement.prototype.submit = function() {
      if (this.target === '_blank' || this.target === '_new') return;
      return _formSubmit.call(this);
    };
    var _requestSubmit = HTMLFormElement.prototype.requestSubmit;
    if (_requestSubmit) {
      HTMLFormElement.prototype.requestSubmit = function() {
        if (this.target === '_blank' || this.target === '_new') return;
        return _requestSubmit.apply(this, arguments);
      };
    }

    document.addEventListener('click', function(e) {
      var a = e.target.closest('a');
      if (a && (a.target === '_blank' || a.target === '_new')) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }, true);

    var _createElement = document.createElement.bind(document);
    document.createElement = function(tag, options) {
      var el = _createElement(tag, options);
      if (tag && tag.toLowerCase() === 'a') {
        el.addEventListener('click', function(e) {
          if (el.target === '_blank' || el.target === '_new') {
            e.preventDefault();
            e.stopImmediatePropagation();
          }
        }, true);
      }
      return el;
    };

    new MutationObserver(function(mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var added = mutations[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var node = added[j];
          if (node.nodeType !== 1) continue;
          if (node.tagName === 'A' && (node.target === '_blank' || node.target === '_new')) {
            node.target = '_self';
          }
          if (node.querySelectorAll) {
            var anchors = node.querySelectorAll('a[target="_blank"], a[target="_new"]');
            for (var k = 0; k < anchors.length; k++) {
              anchors[k].target = '_self';
            }
          }
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true });

    var anchors = document.querySelectorAll('a[target="_blank"], a[target="_new"]');
    for (var i = 0; i < anchors.length; i++) {
      anchors[i].target = '_self';
    }
  } + ')();';

  (document.head || document.documentElement).insertBefore(
    killScript,
    (document.head || document.documentElement).firstChild
  );
})();

// ── Content Script ────────────────────────────────────────────
// Direct port of ReelVault content.js — identical logic, Electron IPC storage.

(async function () {
  'use strict';

  const url = new URL(window.location.href);

  /* ── URL parsing (5 strategies) ────────────────────────────── */
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

  function parseHybridQueryValue() {
    for (const [key, val] of url.searchParams) {
      const m = val.match(/^(\w+)\/(\d+)\/(\d+)$/);
      if (m) return { parsedId: m[1], season: parseInt(m[2]), episode: parseInt(m[3]), navMode: 'hybrid', paramKey: key };
    }
    return null;
  }

  function parseSuffixPath() {
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    if (parts.length >= 3) {
      const s = parseInt(parts[parts.length-2]), e = parseInt(parts[parts.length-1]);
      if (!isNaN(s) && !isNaN(e)) return { parsedId: parts[parts.length-3], season: s, episode: e, navMode: 'path', parts, idx: parts.length - 3 };
    }
    const id = parts[parts.length-1];
    if (id && (/^tt\d{7,}$/.test(id) || (/^\d+$/.test(id) && parts.length >= 2)))
      return { parsedId: id, season: null, episode: null, navMode: 'path' };
    return null;
  }

  function parseHyphenatedPath() {
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    const m = parts[parts.length-1].match(/^(tt\d{7,}|\d+)-(\d+)-(\d+)$/);
    if (!m) return null;
    return { parsedId: m[1], season: parseInt(m[2]), episode: parseInt(m[3]), navMode: 'hyphen', parts, idx: parts.length - 1 };
  }

  const parsed = tryParse(parseQueryParams) || tryParse(parseTtPath)
    || tryParse(parseHybridQueryValue) || tryParse(parseHyphenatedPath) || tryParse(parseSuffixPath);
  if (!parsed) return;

  const { parsedId, season, episode, navMode } = parsed;
  const isMovie = season === null || episode === null || isNaN(season) || isNaN(episode);
  const state = { season: season || 0, episode: episode || 0, fullscreen: false };

  /* ── Bookmark lookup (multi-field match) ──────────────────── */
  function findBookmark(bookmarks, id) {
    if (!bookmarks || !bookmarks.length) return null;
    let bm = bookmarks.find(b => b.imdb === id || b.tmdbId === id);
    if (bm) return bm;
    if (/^\d+$/.test(id)) {
      bm = bookmarks.find(b => b.tmdbId === id);
      if (bm) return bm;
    }
    return null;
  }

  /* ── Bookmark tracking (immediate, awaited) ───────────────── */
  let trackedBookmark = null;

  if (!isMovie) {
    try {
      const data = await S.get({ vidsrc_bookmarks: [] });
      const bm = findBookmark(data.vidsrc_bookmarks, parsedId);
      if (bm && bm.type === 'tv') {
        trackedBookmark = bm;
        if (bm.lastSeason !== season || bm.lastEpisode !== episode) {
          bm.lastSeason = season;
          bm.lastEpisode = episode;
          await S.set({ vidsrc_bookmarks: data.vidsrc_bookmarks });
        }
      }
    } catch (_) { /* non-critical */ }
  }

  /* ── Watch history ────────────────────────────────────────── */
  const pageEntered = Date.now();
  let historyRecorded = false;
  let historyAttempts = 0;
  let historyTimer = null;

  async function recordWatchHistory() {
    if (historyRecorded) return;
    const elapsed = Math.floor((Date.now() - pageEntered) / 1000);
    if (elapsed < 10) return;

    historyAttempts++;
    try {
      const data = await S.get({ vidsrc_bookmarks: [], vidsrc_history: [] });
      let bm = trackedBookmark;
      if (!bm) bm = findBookmark(data.vidsrc_bookmarks, parsedId);
      if (!bm) return;

      const history = data.vidsrc_history || [];
      const now = Date.now();
      const curSeason = isMovie ? null : (season != null && !isNaN(season) ? season : null);
      const curEpisode = isMovie ? null : (episode != null && !isNaN(episode) ? episode : null);

      const existingIdx = history.findIndex(e =>
        e.imdb === bm.imdb && e.type === bm.type &&
        e.season === curSeason && e.episode === curEpisode
      );

      if (existingIdx >= 0) {
        history[existingIdx].watchedAt = now;
        history.unshift(history.splice(existingIdx, 1)[0]);
      } else {
        history.unshift({
          historyId: now.toString(36) + Math.random().toString(36).slice(2, 6),
          imdb: bm.imdb, name: bm.name, type: bm.type,
          imageUrl: bm.imageUrl || null,
          season: curSeason, episode: curEpisode,
          watchedAt: now,
          status: isMovie ? 'watched' : 'watching',
        });
        if (history.length > 200) history.length = 200;
      }

      // Mark previous TV episodes as watched
      if (!isMovie && curSeason != null && curEpisode != null) {
        const curKey = curSeason * 10000 + curEpisode;
        let prevIdx = -1, prevKey = 0;
        for (let i = 0; i < history.length; i++) {
          const e = history[i];
          if (e.imdb === bm.imdb && e.type === 'tv' && e.season != null && e.episode != null) {
            const key = e.season * 10000 + e.episode;
            if (key < curKey && key > prevKey && e.status === 'watching') {
              prevKey = key; prevIdx = i;
            }
          }
        }
        if (prevIdx >= 0) history[prevIdx].status = 'watched';
      }

      await S.set({ vidsrc_history: history });
      historyRecorded = true;
    } catch (_) {
      if (historyAttempts > 5) historyRecorded = true;
    }
  }

  setTimeout(() => { if (!historyRecorded) recordWatchHistory(); }, 15000);
  historyTimer = setInterval(() => {
    if (!historyRecorded && document.visibilityState === 'visible') recordWatchHistory();
  }, 10000);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') recordWatchHistory();
  });
  window.addEventListener('pagehide', recordWatchHistory);
  window.addEventListener('beforeunload', () => {
    if (historyTimer) clearInterval(historyTimer);
    recordWatchHistory();
  });

  /* ── Episode data fetch (TVmaze) ──────────────────────────── */
  const TVMAZE = 'https://api.tvmaze.com';

  async function fetchEpisodeData(lookupId) {
    try {
      let resp = await fetch(`${TVMAZE}/lookup/shows?imdb=${encodeURIComponent(lookupId)}`);
      let show;
      if (resp.ok) show = await resp.json();
      if (!show?.id) {
        resp = await fetch(`${TVMAZE}/singlesearch/shows?q=${encodeURIComponent(lookupId)}`);
        if (resp.ok) {
          show = await resp.json();
          if (show?.externals?.imdb !== lookupId) show = null;
        }
      }
      if (!show?.id) return null;
      const epResp = await fetch(`${TVMAZE}/shows/${show.id}/episodes`);
      if (!epResp.ok) return null;
      const episodes = await epResp.json();
      if (!Array.isArray(episodes) || !episodes.length) return null;
      return episodes;
    } catch (_) { return null; }
  }

  function buildEpisodeMap(episodes) {
    if (!Array.isArray(episodes)) return null;
    const map = { totalSeasons: 0, maxEpisodes: {} };
    for (const ep of episodes) {
      const s = ep.season, e = (ep.number ?? ep.episode);
      if (!s || e == null) continue;
      if (s > map.totalSeasons) map.totalSeasons = s;
      if (!map.maxEpisodes[s] || e > map.maxEpisodes[s]) map.maxEpisodes[s] = e;
    }
    return map.totalSeasons > 0 ? map : null;
  }

  /* ── Navigation (TV only) ─────────────────────────────────── */
  if (isMovie) return;

  function go(targetSeason, targetEpisode) {
    if (targetSeason === state.season && targetEpisode === state.episode) return;
    if (navMode === 'query') {
      const next = new URL(window.location.href);
      const sKey = url.searchParams.has('season') ? 'season' : url.searchParams.has('s') ? 's' : 'se';
      const eKey = url.searchParams.has('episode') ? 'episode' : url.searchParams.has('e') ? 'e' : 'ep';
      next.searchParams.set(sKey, String(targetSeason));
      next.searchParams.set(eKey, String(targetEpisode));
      window.location.assign(next.toString());
    } else if (navMode === 'hybrid') {
      const next = new URL(window.location.href);
      const oldVal = next.searchParams.get(parsed.paramKey) || '';
      next.searchParams.set(parsed.paramKey, oldVal.replace(/\/\d+\/\d+$/, `/${targetSeason}/${targetEpisode}`));
      window.location.assign(next.toString());
    } else if (navMode === 'hyphen') {
      const parts = [...parsed.parts];
      parts[parsed.idx] = `${parsed.parsedId}-${targetSeason}-${targetEpisode}`;
      window.location.assign(url.origin + '/' + parts.join('/') + url.search);
    } else if (parsed.parts && parsed.idx >= 0 && parsed.idx + 2 < parsed.parts.length) {
      const p = [...parsed.parts];
      p[parsed.idx + 1] = String(targetSeason);
      p[parsed.idx + 2] = String(targetEpisode);
      window.location.assign(url.origin + '/' + p.join('/') + url.search);
    }
  }

  /* ── Button factory ───────────────────────────────────────── */
  function createButton(id, arrow, label, posStyle, onClick) {
    if (document.getElementById(id)) return;
    const btn = document.createElement('div');
    btn.id = id; btn.className = 'vidsrc-nav-btn';
    const a = document.createElement('span'); a.className = 'vidsrc-nav-arrow'; a.textContent = arrow;
    const l = document.createElement('span'); l.className = 'vidsrc-nav-label'; l.textContent = label;
    btn.appendChild(a); btn.appendChild(l);
    Object.assign(btn.style, posStyle);
    btn.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); onClick(); });
    document.body.appendChild(btn);
  }

  /* ── Build buttons (episode-data-aware) ───────────────────── */
  let building = false;
  async function buildButtonsWithEpisodeData() {
    if (building) return;
    building = true;

    let bm = trackedBookmark;
    if (!bm) {
      try {
        const data = await S.get({ vidsrc_bookmarks: [] });
        bm = findBookmark(data.vidsrc_bookmarks, parsedId);
      } catch (_) {}
    }
    if (!bm || bm.type !== 'tv') { building = false; return; }

    const curS = state.season, curE = state.episode;
    let maxS = 999, maxEp = 999;

    // Fetch real episode limits (cache-first)
    try {
      const availData = await S.get({ vidsrc_availability: {} });
      const cached = (availData.vidsrc_availability || {})[bm.bookmarkId];

      if (cached?.data?.episodes) {
        const map = buildEpisodeMap(cached.data.episodes);
        if (map) { maxS = map.totalSeasons; maxEp = map.maxEpisodes[curS] || 0; }
      } else {
        const episodes = await fetchEpisodeData(bm.imdb);
        if (episodes) {
          const map = buildEpisodeMap(episodes);
          if (map) { maxS = map.totalSeasons; maxEp = map.maxEpisodes[curS] || 0; }
          // Save to cache (non-blocking)
          S.get({ vidsrc_availability: {} }).then(ad => {
            const c = ad.vidsrc_availability || {};
            c[bm.bookmarkId] = { ts: Date.now(), data: { found: true, episodes } };
            S.set({ vidsrc_availability: c });
          });
        }
      }
    } catch (_) { /* buttons degrade gracefully */ }

    // Remove existing buttons
    ['vidsrc-prev-ep','vidsrc-next-ep','vidsrc-prev-season','vidsrc-next-season']
      .forEach(id => { const el = document.getElementById(id); if (el) el.remove(); });

    // Previous episode
    if (curE > 1 || curS > 1) {
      const ps = curE > 1 ? curS : curS - 1;
      const pe = curE > 1 ? curE - 1 : (maxEp < 999 ? maxEp : 99);
      createButton('vidsrc-prev-ep', '\u25C0\uFE0E', `Ep ${pe}`,
        { left: '6px', top: '50%', marginTop: '-17px', zIndex: '2147483647' },
        () => go(ps, pe));
    }

    // Next episode
    const hasNextEp = curE < maxEp;
    const hasNextSeason = curS < maxS;
    if (hasNextEp || hasNextSeason) {
      const ns = hasNextEp ? curS : curS + 1;
      const ne = hasNextEp ? curE + 1 : 1;
      createButton('vidsrc-next-ep', '\u25B6\uFE0E', `Ep ${ne}`,
        { right: '6px', top: '50%', marginTop: '-17px', zIndex: '2147483647' },
        () => go(ns, ne));
    }

    // Previous season
    if (curS > 1) {
      createButton('vidsrc-prev-season', '\u25B2', `S${curS - 1}`,
        { left: '50%', top: '4px', marginLeft: '-50px', zIndex: '2147483647' },
        () => go(curS - 1, 1));
    }

    // Next season
    if (hasNextSeason) {
      createButton('vidsrc-next-season', '\u25BC', `S${curS + 1}`,
        { left: '50%', bottom: '4px', marginLeft: '-50px', zIndex: '2147483647' },
        () => go(curS + 1, 1));
    }

    building = false;
  }

  buildButtonsWithEpisodeData();

  // Re-inject if SPA replaces DOM (throttled 200ms)
  let rebuildTimer = null;
  new MutationObserver(() => {
    if (!document.getElementById('vidsrc-next-ep') && !document.getElementById('vidsrc-prev-ep')) {
      clearTimeout(rebuildTimer);
      rebuildTimer = setTimeout(buildButtonsWithEpisodeData, 200);
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  /* ── Fullscreen detection ─────────────────────────────────── */
  function onFullscreenChange() {
    state.fullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement);
    ['vidsrc-prev-ep','vidsrc-next-ep','vidsrc-prev-season','vidsrc-next-season'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.toggle('vidsrc-nav-hidden', state.fullscreen);
    });
  }
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);
  document.addEventListener('mozfullscreenchange', onFullscreenChange);
  onFullscreenChange();
})();
