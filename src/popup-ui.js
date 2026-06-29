/**
 * ReelVault — popup-ui.js
 * UI controller: tabs, forms, rendering, event binding. No data logic.
 */
class PopupUI {
  constructor(storage) {
    this.storage = storage;
    this.schemas    = [];
    this.bookmarks  = [];
    this.history    = [];
    this.availCache = {};
    this.activeTab  = 'bookmarks';
    this.bmFilter   = 'all';
    this.watchlist  = [];         // WatchlistItem[]
    this.wlLastCheck = 0;        // timestamp
    this.wlChecking  = false;    // prevent concurrent checks
    this.wlEpisodeCache = new Map();  // showId → {ts, episodes, showInfo}
    this._wlCountdownTimers = new Map(); // watchId → intervalId
    this.wlDeleted   = new Set();   // IDs manually removed from watchlist
  }

  /* ── DOM refs ──────────────────────────────────────────────── */
  $ = (s) => document.querySelector(s);
  $$ = (s) => document.querySelectorAll(s);

  /* ── Init ──────────────────────────────────────────────────── */
  async init() {
    window.__diag?.('PopupUI.init() starting');
    this._bindTabs();
    this._bindBookmarkForm();
    this._bindFilterBar();
    this._bindFormAutoSave();
    this._bindHistoryClear();
    this._bindWatchlist();
    this._bindTabSearches();
    this._bindDataBar();
    this._listenForDataImported();

    // Load catalog (best-effort — failure must not block the rest)
    window.__diag?.('_loadCatalog starting...');
    try { await this._loadCatalog(); } catch (e) {
      window.__diag_err?.('_loadCatalog', e);
      console.error('[WTA] _loadCatalog failed:', e);
      this.providerCatalog = [];
    }
    window.__diag?.('_loadCatalog done. providerCatalog.length=' + (this.providerCatalog?.length || 0));

    // Load data and render (MUST run regardless of catalog state)
    window.__diag?.('_loadAndRender starting...');
    try { await this._loadAndRender(); } catch (e) {
      window.__diag_err?.('_loadAndRender', e);
      console.error('[WTA] _loadAndRender failed:', e);
    }
    window.__diag?.('_loadAndRender done. schemas=' + (this.schemas?.length||0) + ' bookmarks=' + (this.bookmarks?.length||0) + ' watchlist=' + (this.watchlist?.length||0));

    // Show data file location for debugging
    if (window.wtAPI) {
      try {
        const dir = await window.wtAPI.getDataDir();
        window.__diag?.('Data dir: ' + dir);
      } catch(_) {}
    }

    window.__diag?.('_restoreFormState starting...');
    await this._restoreFormState();
    window.__diag?.('init() complete');
  }

  /* ═════════════════════════════════════════════════════════════
     DATA
     ═════════════════════════════════════════════════════════════ */
  async _loadAndRender() {
    const { schemas, bookmarks } = await this.storage.loadAll();

    // Build schemas from active provider IDs + catalog
    let activeIds = await this.storage.loadActiveProviderIds();
    if (!activeIds || !activeIds.length) {
      activeIds = ['cinemaos', 'screenscape', 'vidsrc-me', 'vidsrc-to'];
      await this.storage.saveActiveProviderIds(activeIds);
    }

    // Build Schema objects from catalog for active IDs
    this.schemas = [];
    for (const pid of activeIds) {
      const entry = this.providerCatalog.find(p => p.id === pid);
      if (entry) {
        this.schemas.push(schemaFromCatalog(entry));
      }
    }

    // Fallback: if catalog didn't have them, use stored schemas
    if (!this.schemas.length && schemas.length) {
      this.schemas = schemas;
    }
    // Last resort: hardcoded defaults
    if (!this.schemas.length) {
      this.schemas = DEFAULT_SCHEMAS;
    }

    this.bookmarks = bookmarks;
    // Auto-migrate bookmarks whose schema no longer exists
    const activeSchemaIds = new Set(this.schemas.map(s => s.schemaId));
    let migrated = false;
    for (const bm of this.bookmarks) {
      if (!activeSchemaIds.has(bm.schemaId) && this.schemas.length) {
        bm.schemaId = this.schemas[0].schemaId;
        migrated = true;
      }
    }
    if (migrated) await this.storage.saveAll(this.schemas, this.bookmarks);

    if (!this.bookmarks.length && this.schemas.length) {
      this.bookmarks.push(new Bookmark({
        bookmarkId: 'sample_tbbt', name: 'The Big Bang Theory',
        imdb: 'tt0898266', schemaId: this.schemas[0].schemaId,
        type: 'tv', lastSeason: 1, lastEpisode: 1,
      }));
    }

    // Load cached availability
    this.availCache = await this.storage.loadAvailabilityCache();

    // Load watch history
    this.history = await this.storage.loadHistory();

    // Load watchlist
    const wlData = await this.storage.loadWatchlist();
    this.watchlist = wlData.items || [];
    this.wlLastCheck = wlData.lastCheck || 0;
    this.wlDeleted = await this.storage.loadDeletedWatchlistIds();

    // Auto-sync: add TV bookmarks to watchlist if not already tracked
    await this._autoSyncBookmarksToWatchlist();

    this._refresh();
    this._fetchMissingCovers();
  }

  /** Fetch covers for bookmarks that don't have one yet, and TMDB IDs for TV bookmarks. */
  async _fetchMissingCovers() {
    const needCover = this.bookmarks.filter(b => !b.imageUrl);
    const needTmdb = this.bookmarks.filter(b => b.type === 'tv' && !b.tmdbId);
    if (!needCover.length && !needTmdb.length) return;
    let changed = false;

    // Fetch covers
    for (const bm of needCover) {
      try {
        const resp = await fetch('https://v3.sg.media-imdb.com/suggestion/x/' + bm.imdb + '.json');
        if (!resp.ok) continue;
        const data = await resp.json();
        const hit = (data.d || []).find(it => it.id === bm.imdb);
        if (hit?.i?.imageUrl) {
          bm.imageUrl = hit.i.imageUrl;
          changed = true;
        }
        if (hit?.s && !bm.stars) { bm.stars = hit.s; changed = true; }
        if (hit?.q && !bm.category) { bm.category = hit.q; changed = true; }
      } catch (_) { /* skip */ }
    }

    // Fetch TMDB IDs for TV bookmarks that don't have one
    for (const bm of needTmdb) {
      try {
        const tid = await fetchTmdbId(bm.imdb);
        if (tid) {
          bm.tmdbId = tid;
          changed = true;
        }
      } catch (_) { /* skip */ }
    }

    if (changed) {
      await this.storage.saveAll(this.schemas, this.bookmarks);
      this._renderBookmarks();
    }
  }

  /** Auto-add TV bookmarks to watchlist if not already tracked. */
  async _autoSyncBookmarksToWatchlist() {
    const tvBookmarks = this.bookmarks.filter(b => b.type === 'tv');
    if (!tvBookmarks.length) return;
    let changed = false;

    for (const bm of tvBookmarks) {
      // Find TVmaze showId first — needed for duplicate detection
      let showId = null;
      try {
        const show = await findShow(bm.name, bm.imdb);
        if (show) showId = show.id;
      } catch (_) { /* skip */ }
      if (!showId) continue;

      // Robust duplicate check: match by bookmarkId, imdb, OR showId
      // Also skip if the bookmark was explicitly deleted from watchlist
      const exists = this.watchlist.some(w =>
        (w.bookmarkId && w.bookmarkId === bm.bookmarkId) ||
        (w.imdb && bm.imdb && w.imdb === bm.imdb) ||
        (w.showId && w.showId === showId)
      );
      if (exists) continue;
      if (this.wlDeleted.has(bm.bookmarkId) || this.wlDeleted.has(String(showId))) continue;

      const item = new WatchlistItem({
        watchId: makeBookmarkId(),
        name: bm.name,
        imdb: bm.imdb,
        showId,
        source: 'bookmark',
        bookmarkId: bm.bookmarkId,
        imageUrl: bm.imageUrl || null,
      });
      this.watchlist.push(item);
      changed = true;
    }

    if (changed) {
      // Dedup safeguard — remove any entries with duplicate watchId before saving
      const seen = new Set();
      this.watchlist = this.watchlist.filter(w => {
        if (seen.has(w.watchId)) return false;
        seen.add(w.watchId);
        return true;
      });
      await this.storage.saveWatchlist(this.watchlist, this.wlLastCheck);
    }
  }

  /* ═════════════════════════════════════════════════════════════
     TABS
     ═════════════════════════════════════════════════════════════ */
  _bindTabs() {
    this.$$('.tab-btn').forEach(b => b.addEventListener('click', () => this._switchTab(b.dataset.tab)));
  }

  _switchTab(tab) {
    this.activeTab = tab;
    this.$$('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    this.$('#tab-schemas').classList.toggle('active', tab === 'schemas');
    this.$('#tab-bookmarks').classList.toggle('active', tab === 'bookmarks');
    this.$('#tab-watchlist').classList.toggle('active', tab === 'watchlist');
    this.$('#tab-history').classList.toggle('active', tab === 'history');
    this.storage.saveFormState({ _tab: tab });
    this._refresh();

    // Desktop: auto-focus the tab's search field
    const searchMap = {
      schemas: '#schema-search',
      bookmarks: '#bm-filter-search',
      watchlist: '#wl-filter-search',
      history: '#hist-search',
    };
    const sel = searchMap[tab];
    if (sel) {
      setTimeout(() => {
        const input = document.querySelector(sel);
        if (input && document.activeElement !== input) input.focus();
      }, 50);
    }
  }

  _refresh() {
    if (this.activeTab === 'schemas')   this._renderSchemas();
    if (this.activeTab === 'bookmarks') this._renderBookmarks();
    if (this.activeTab === 'watchlist') { this._renderWatchlist(); this._syncWatchlist(); }
    if (this.activeTab === 'history')   this._renderHistory();
  }

  /* ═════════════════════════════════════════════════════════════
     PROVIDER CATALOG (live-fetched from GitHub)
     ═════════════════════════════════════════════════════════════ */
  /** Load catalog from GitHub fetch, bundled providers, or cache. Fetches only if cache is stale. */
  async _loadCatalog() {
    // 1. Try cached catalog from storage (24h TTL, checked inside)
    const cached = await this._loadCachedCatalog();
    if (cached && cached.length) {
      this.providerCatalog = cached;
    } else {
      // 2. Cache miss or stale — fetch fresh from GitHub
      try {
        const fresh = await this._fetchProvidersFromGitHub();
        if (fresh && fresh.length > 0) {
          this.providerCatalog = fresh;
          await this._saveCachedCatalog(fresh);
        }
      } catch (_) { /* network error — no providers available yet */ }
    }

    // 3. Merge bundled providers (tested defaults not in GitHub list)
    // Ensure catalog is always an array before merging
    if (!this.providerCatalog) this.providerCatalog = [];
    try {
      const bundled = await window.wtAPI.readProvidersJson();
      const existingIds = new Set(this.providerCatalog.map(p => p.id));
      for (const p of bundled) {
        if (!existingIds.has(p.id)) {
          this.providerCatalog.push(p);
        }
      }
    } catch (_) { /* no bundled fallback */ }

    if (!this.providerCatalog.length) {
      this.providerCatalog = [];
    }

    // 4. Health-check providers (lazy — only probe unchecked or >1h old)
    this._probeProviders();
  }

  async _probeProviders() {
    const { vidsrc_provider_health: health } = await chrome.storage.local.get({ vidsrc_provider_health: {} });
    const now = Date.now();

    for (const p of this.providerCatalog) {
      const h = health[p.id];
      if (h && (now - h.ts) < 86400000) {
        p._alive = h.alive;
        continue;
      }
      // Probe asynchronously — don't block UI
      this._probeOne(p);
    }
  }

  async _probeOne(provider) {
    // Simple check: HEAD the provider's base origin
    try {
      const root = new URL(provider.rootUrl);
      const probeUrl = root.origin + '/';
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 8000);
      const resp = await fetch(probeUrl, { method: 'HEAD', signal: ctrl.signal });
      provider._alive = resp.ok;
    } catch (_) {
      provider._alive = false;
    }

    const { vidsrc_provider_health: current } = await chrome.storage.local.get({ vidsrc_provider_health: {} });
    current[provider.id] = { ts: Date.now(), alive: provider._alive };
    await chrome.storage.local.set({ vidsrc_provider_health: current });
    if (this.activeTab === 'schemas') this._renderSchemas();
  }

  async _fetchProvidersFromGitHub() {
    const url = 'https://raw.githubusercontent.com/Astralchemist/tmdb-embed-providers/main/src/providers.ts';
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const ts = await resp.text();
    return this._parseProvidersTS(ts);
  }

  _parseProvidersTS(ts) {
    const providers = [];

    // Extract each provider block from the TypeScript source
    const blockRe = /\{\s*\n?\s*id:\s*'([^']+)',\s*\n?\s*label:\s*'([^']+)',[\s\S]*?buildMovieUrl:\s*\([^)]*\)\s*=>\s*`([^`]+)`[\s\S]*?buildTvUrl:\s*\([^)]*\)\s*=>\s*`([^`]+)`[\s\S]*?\}/g;

    let match;
    while ((match = blockRe.exec(ts)) !== null) {
      const [, id, label, movieTpl, tvTpl] = match;

      const movieUrl = parseProviderTemplate(movieTpl.trim());
      const tvUrl = parseProviderTemplate(tvTpl.trim());
      const rootUrl = extractRootUrl(movieTpl.trim(), tvTpl.trim());

      if (!movieUrl && !tvUrl) continue;

      providers.push({
        id,
        name: label,
        rootUrl,
        tv: tvUrl ? { urlTemplate: tvUrl } : null,
        movie: movieUrl ? { urlTemplate: movieUrl } : null,
        tier: ts.includes(`id: '${id}'`) && ts.indexOf(`id: '${id}'`) < ts.indexOf('// Extras') ? 'core' : 'extras',
      });
    }

    return providers;
  }

  async _loadCachedCatalog() {
    const { vidsrc_provider_catalog: data } = await chrome.storage.local.get({ vidsrc_provider_catalog: null });
    if (!data || data._ver !== 2) return null;
    if (Date.now() - data.ts > 604800000) return null;
    return data.providers;
  }

  async _saveCachedCatalog(providers) {
    await chrome.storage.local.set({
      vidsrc_provider_catalog: { _ver: 2, ts: Date.now(), providers }
    });
  }

  _renderSchemas() {
    const list = this.$('#schemas-list'), empty = this.$('#no-schemas');
    if (!this.providerCatalog || !this.providerCatalog.length) {
      list.innerHTML = '';
      empty.textContent = 'Provider catalog unavailable';
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');

    const activeIds = new Set(this.schemas.map(s => s.schemaId));
    // Active: use schema order (matches bookmark dropdown)
    let active = this.schemas
      .map(s => this.providerCatalog.find(p => p.id === s.schemaId))
      .filter(Boolean);
    // Available: catalog entries not in active set
    let available = this.providerCatalog.filter(p => !activeIds.has(p.id));

    // Filter by search query
    const query = (this.$('#schema-search')?.value || '').trim().toLowerCase();
    if (query) {
      active = active.filter(p => p.name.toLowerCase().includes(query) || p.id.includes(query));
      available = available.filter(p => p.name.toLowerCase().includes(query) || p.id.includes(query));
    }

    let html = '';

    if (active.length) {
      html += '<div class="avail-season-label" style="margin-bottom:6px">Active</div>';
      html += active.map(p => this._providerRow(p, true, active.length)).join('');
    }
    if (available.length) {
      html += `<div class="avail-season-label" style="margin-top:${active.length ? '12' : '0'}px;margin-bottom:6px">Available</div>`;
      html += available.map(p => this._providerRow(p, false, active.length)).join('');
    }

    list.innerHTML = html;

    list.querySelectorAll('.provider-toggle').forEach(btn => {
      btn.addEventListener('click', () => this._toggleProvider(btn.dataset.pid));
    });
  }

  _providerRow(provider, isActive, activeCount) {
    const types = [];
    if (provider.tv) types.push('📺');
    if (provider.movie) types.push('🎬');
    const typeStr = types.length ? types.join(' ') : '';
    const isLast = isActive && activeCount <= 1;
    const healthIcon = provider._alive === false ? ' ⚠' : '';
    return `<div class="schema-row-item${isActive ? ' schema-active' : ''}"${provider._alive === false && !isActive ? ' style="opacity:0.5"' : ''}>
      <div class="schema-info">
        <div class="schema-name">${esc(provider.name)}${healthIcon} <span style="font-size:10px">${typeStr}</span></div>
        <div class="schema-meta">${esc(provider.rootUrl)}</div>
      </div>
      <button class="provider-toggle" data-pid="${esc(provider.id)}" title="${isLast ? 'Cannot disable last provider' : isActive ? 'Disable' : 'Enable'} provider"${isLast ? ' disabled style="opacity:0.3;cursor:not-allowed"' : ''}>${isActive ? '✓' : '+'}</button>
    </div>`;
  }

  async _toggleProvider(providerId) {
    const activeIds = new Set(this.schemas.map(s => s.schemaId));
    if (activeIds.has(providerId)) {
      // Prevent disabling the last active provider
      if (activeIds.size <= 1) return;
      this.schemas = this.schemas.filter(s => s.schemaId !== providerId);
      // Don't delete bookmarks — they'll just use another provider
    } else {
      const entry = this.providerCatalog.find(p => p.id === providerId);
      if (entry) this.schemas.push(schemaFromCatalog(entry));
    }
    await this.storage.saveAll(this.schemas, this.bookmarks);
    await this.storage.saveActiveProviderIds(this.schemas.map(s => s.schemaId));
    this._renderSchemas();
  }

  /* ═════════════════════════════════════════════════════════════
     BOOKMARK FORM (search → pick → season → confirm)
     ═════════════════════════════════════════════════════════════ */
  _bindBookmarkForm() {
    this.$('#bm-toggle-btn').addEventListener('click', () => {
      const form = this.$('#bm-form-wrap');
      const show = form.style.display === 'none';
      form.style.display = show ? '' : 'none';
      this.$('#bm-toggle-btn').classList.toggle('active', show);
      if (show) { this._resetBookmarkForm(); this.$('#bm-search').focus(); }
    });
    this.$('#bm-cancel-btn').addEventListener('click', () => this._hideBookmarkForm());

    // Auto-search as user types
    let timer = null;
    this.$('#bm-search').addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => this._bmDoSearch(), 400);
    });

    // Back button: return to search
    this.$('#bm-back-btn').addEventListener('click', () => {
      this.$('#bm-step-search').style.display = '';
      this.$('#bm-step-season').style.display = 'none';
    });

    // Confirm: create bookmark with season/episode
    this.$('#bm-confirm-btn').addEventListener('click', () => this._bmConfirm());
  }

  _bindFilterBar() {
    this.$$('.bm-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.bmFilter = btn.dataset.filter;
        this._renderBookmarks();
      });
    });
  }

  _resetBookmarkForm() {
    this.$('#bm-step-search').style.display = '';
    this.$('#bm-step-season').style.display = 'none';
    this.$('#bm-search').value = '';
    this.$('#bm-search-status').textContent = '';
    this.$('#bm-search-results').innerHTML = '';
    this.$('#bm-season').value = '1';
    this.$('#bm-episode').value = '1';
  }

  _hideBookmarkForm() {
    this.$('#bm-form-wrap').style.display = 'none';
    this.$('#bm-toggle-btn').classList.remove('active');
    this._resetBookmarkForm();
  }

  /* ── Step 1: Search IMDB ───────────────────────────────────── */
  _bmDoSearch() {
    const q = this.$('#bm-search').value.trim();
    if (!q) { this.$('#bm-search-results').innerHTML = ''; this.$('#bm-search-status').textContent = ''; return; }
    this._bmAbort?.abort();
    this._bmAbort = new AbortController();

    // In-memory cache (5 min TTL) — IMDB suggestions don't change often
    if (!this._searchCache) this._searchCache = new Map();
    const cached = this._searchCache.get(q.toLowerCase());
    if (cached && Date.now() - cached.ts < 300000) {
      this.$('#bm-search-status').textContent = '';
      this._bmRenderResults(cached.items);
      return;
    }

    this.$('#bm-search-status').textContent = 'Searching…';
    this.$('#bm-search-results').innerHTML = '';
    fetch('https://v3.sg.media-imdb.com/suggestion/x/' + encodeURIComponent(q) + '.json', { signal: this._bmAbort.signal })
      .then(r => r.ok ? r.json() : Promise.reject(r))
      .then(data => {
        const items = (data.d || []).slice(0, 6);
        this._searchCache.set(q.toLowerCase(), { ts: Date.now(), items });
        if (!items.length) { this.$('#bm-search-status').textContent = 'No results.'; return; }
        this.$('#bm-search-status').textContent = '';
        this._bmRenderResults(items);
      })
      .catch(err => { if (err.name !== 'AbortError') this.$('#bm-search-status').textContent = 'Search failed.'; });
  }

  _bmRenderResults(items) {
    const container = this.$('#bm-search-results');
    container.innerHTML = items.map(it => {
      const type = imdbType(it.qid);
      const badge = type === 'movie' ? '🎬' : '📺';
      const title = esc(it.l || 'Unknown');
      const imageUrl = it.i?.imageUrl || null;
      const stars = esc(it.s || '');
      const cat = esc(it.q || '');
      return `<div class="search-result" style="cursor:pointer" data-imdb="${esc(it.id)}" data-title="${title}" data-type="${type}" data-image="${imageUrl ? esc(imageUrl) : ''}" data-stars="${stars}" data-cat="${cat}">
        ${imageUrl ? `<img src="${esc(imageUrl)}" class="sr-thumb" onerror="this.style.display='none'" loading="lazy">` : ''}
        <div>
          <div class="sr-title">${badge} ${title} ${it.y?'('+it.y+')':''}</div>
          ${stars ? '<div class="sr-meta">' + stars + (cat ? ' · ' + cat : '') + '</div>' : ''}
        </div></div>`;
    }).join('');
    container.querySelectorAll('.search-result').forEach(row => {
      row.addEventListener('click', () => {
        this._bmPick(row.dataset.imdb, row.dataset.title, row.dataset.type, row.dataset.image || null, row.dataset.stars || '', row.dataset.cat || '');
      });
    });
  }

  /* ── Step 2: Season/Episode prompt ─────────────────────────── */
  _bmPick(imdb, title, type, imageUrl, stars, cat) {
    this._bmPending = { imdb, title, type, imageUrl, stars, cat };
    if (type === 'movie') {
      this._bmCreate(null, null); // movies skip season prompt
    } else {
      this.$('#bm-step-search').style.display = 'none';
      this.$('#bm-step-season').style.display = '';
      this.$('#bm-pick-hint').innerHTML = `<span style="color:#4caf84">📺</span> <b>${esc(title)}</b> · ${esc(imdb)}`;
    }
  }

  /* ── Confirm & create ──────────────────────────────────────── */
  async _bmConfirm() {
    const season = parseInt(this.$('#bm-season').value, 10) || 1;
    const episode = parseInt(this.$('#bm-episode').value, 10) || 1;
    this._bmCreate(season, episode);
  }

  async _bmCreate(season, episode) {
    const { imdb, title, type, imageUrl, stars, cat } = this._bmPending;
    const schemaId = this.schemas.length ? this.schemas[0].schemaId : null;
    if (!schemaId) return;

    // Fetch TMDB ID for TV shows (needed by CinemaOS etc.)
    let tmdbId = null;
    if (type === 'tv') {
      tmdbId = await fetchTmdbId(imdb);
    }

    this.bookmarks.push(new Bookmark({
      bookmarkId: makeBookmarkId(), name: title, imdb, schemaId, type,
      lastSeason: type === 'tv' ? (season || 1) : null,
      lastEpisode: type === 'tv' ? (episode || 1) : null,
      imageUrl: imageUrl || null,
      stars: stars || null,
      category: cat || null,
      tmdbId,
    }));
    await this.storage.saveAll(this.schemas, this.bookmarks);

    // For TV shows: seed history with "watching" at the starting episode
    if (type === 'tv' && season && episode) {
      const { vidsrc_history: stored } = await chrome.storage.local.get({ vidsrc_history: [] });
      const history = stored || [];
      const now = Date.now();
      const curS = season;
      const curE = episode;

      // Check if this exact episode already recorded
      const exists = history.some(e =>
        e.imdb === imdb && e.type === 'tv' &&
        e.season === curS && e.episode === curE
      );

      if (!exists) {
        history.unshift({
          historyId: now.toString(36) + Math.random().toString(36).slice(2, 6),
          imdb, name: title, type: 'tv',
          imageUrl: imageUrl || null,
          season: curS,
          episode: curE,
          watchedAt: now,
          status: 'watching',
        });

        // Mark any previous episodes for this show as watched
        const curKey = curS * 10000 + curE;
        for (const e of history) {
          if (e.imdb === imdb && e.type === 'tv' && e.season && e.episode) {
            const key = e.season * 10000 + e.episode;
            if (key < curKey && e.status === 'watching') {
              e.status = 'watched';
            }
          }
        }

        if (history.length > 2000) history.length = 2000;
        await chrome.storage.local.set({ vidsrc_history: history });
        // Reload history into UI state so episode browser reflects it immediately
        this.history = history;
      }
    }

    this._hideBookmarkForm();
    this._renderBookmarks();
  }

  async _changeBookmarkSchema(bookmarkId, newSchemaId) {
    const bm = this.bookmarks.find(b => b.bookmarkId === bookmarkId);
    if (!bm) return;
    bm.schemaId = newSchemaId;
    await this.storage.saveAll(this.schemas, this.bookmarks);
    this._renderBookmarks();
  }

  async _deleteBookmark(bookmarkId) {
    this.bookmarks = this.bookmarks.filter(b => b.bookmarkId !== bookmarkId);
    await this.storage.saveAll(this.schemas, this.bookmarks);
    // Clean up cached availability
    delete this.availCache[bookmarkId];
    await this.storage.clearAvailability(bookmarkId);
    this._refresh();
  }

  /* ═════════════════════════════════════════════════════════════
     HISTORY TAB
     ═════════════════════════════════════════════════════════════ */
  _renderHistory() {
    const list = this.$('#history-list'), empty = this.$('#no-history');
    if (!this.history.length) { list.innerHTML = ''; empty.classList.remove('hidden'); return; }
    empty.classList.add('hidden');

    // Filter by search query
    const query = (this.$('#hist-search')?.value || '').trim().toLowerCase();
    let filtered = this.history;
    if (query) {
      filtered = this.history.filter(entry => {
        const pos = entry.type === 'tv' && entry.season
          ? `s${String(entry.season).padStart(2,'0')}e${String(entry.episode || 1).padStart(2,'0')}`
          : '';
        return entry.name.toLowerCase().includes(query) || pos.includes(query);
      });
    }

    list.innerHTML = filtered.map(entry => {
      const thumb = entry.imageUrl
        ? `<img src="${esc(entry.imageUrl)}" class="bm-thumb" onerror="this.style.display='none'" loading="lazy">`
        : '';
      const pos = entry.type === 'tv' && entry.season
        ? `S${String(entry.season).padStart(2,'0')}E${String(entry.episode || 1).padStart(2,'0')}`
        : '';
      const timeAgo = this._formatTimeAgo(entry.watchedAt);
      return `<div class="bookmark-row">
        ${thumb}
        <div class="bm-info">
          <div class="bm-name" title="${esc(entry.name)}">${esc(entry.name)}</div>
          <div class="bm-meta">${pos ? pos + ' · ' : ''}${timeAgo}${entry.status === 'watching' ? ' · <span style="color:#2dd4bf;font-weight:600">watching</span>' : ''}</div>
        </div>
        <button class="bm-go" data-imdb="${esc(entry.imdb)}" data-type="${esc(entry.type)}" data-season="${entry.season || ''}" data-episode="${entry.episode || ''}" title="Resume">▶</button>
        <button class="bm-del hist-del-btn" data-hid="${esc(entry.historyId)}" title="Delete">✕</button>
      </div>`;
    }).join('');

    // Bind resume buttons — look up the matching bookmark for correct schema + tmdbId
    list.querySelectorAll('.bm-go').forEach(btn => {
      btn.addEventListener('click', () => {
        const imdb = btn.dataset.imdb;
        const type = btn.dataset.type;
        const season = parseInt(btn.dataset.season) || 1;
        const episode = parseInt(btn.dataset.episode) || 1;
        const bm = this.bookmarks.find(b => b.imdb === imdb);
        if (!bm) return;
        const schema = this.schemas.find(s => s.schemaId === bm.schemaId);
        if (!schema) return;
        const url = schema.buildUrl({
          imdb: bm.imdb, tmdbId: bm.tmdbId, type,
          lastSeason: type === 'tv' ? season : null,
          lastEpisode: type === 'tv' ? episode : null,
        });
        if (url) window.wtAPI.openEmbed(url);
      });
    });
  }

  _formatTimeAgo(timestamp) {
    const diff = Math.floor((Date.now() - timestamp) / 1000);
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
    return new Date(timestamp).toLocaleDateString();
  }

  async _clearHistory() {
    await this.storage.clearHistory();
    this.history = [];
    const search = this.$('#hist-search');
    if (search) search.value = '';
    this._renderHistory();
  }

  async _deleteHistoryEntry(historyId) {
    this.history = this.history.filter(h => h.historyId !== historyId);
    const { vidsrc_history: stored } = await chrome.storage.local.get({ vidsrc_history: [] });
    const updated = (stored || []).filter(h => h.historyId !== historyId);
    await chrome.storage.local.set({ vidsrc_history: updated });
    this._renderHistory();
  }

  /** Bind history clear button, search input, and individual delete (called once in init) */
  _bindHistoryClear() {
    const btn = this.$('#hist-clear-btn');
    if (btn) btn.addEventListener('click', () => this._clearHistory());
    const search = this.$('#hist-search');
    if (search) search.addEventListener('input', () => this._renderHistory());
    // Delegated handler for individual history entry delete
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.hist-del-btn');
      if (btn) this._deleteHistoryEntry(btn.dataset.hid);
    });
  }

  /** Bind tab-local search filter inputs. */
  _bindTabSearches() {
    const schemaSearch = this.$('#schema-search');
    if (schemaSearch) schemaSearch.addEventListener('input', () => this._renderSchemas());

    const bmSearch = this.$('#bm-filter-search');
    if (bmSearch) bmSearch.addEventListener('input', () => this._renderBookmarks());

    const wlSearch = this.$('#wl-filter-search');
    if (wlSearch) wlSearch.addEventListener('input', () => this._renderWatchlist());
  }

  /* ═════════════════════════════════════════════════════════════
     EPISODE BROWSER (unified — used by Bookmarks & Watchlist)
     ═════════════════════════════════════════════════════════════ */

  /**
   * Shared episode grid renderer. Handles countdown box, season grouping,
   * aired/future coloring, watched/watching overlays, and close button.
   *
   * @param {HTMLElement} container
   * @param {object} opts
   * @param {Array}    opts.episodes     — [{season, episode, name, airdate}]
   * @param {object}   opts.showInfo     — {name, status, nextEpisode:{season, episode, name, airdate}}
   * @param {string}   opts.imdb         — IMDB ID for watched-status key
   * @param {Schema}   opts.schema       — for building provider episode URLs (null if unavailable)
   * @param {string}   opts.closeHandler — function name on 'this' to call on close (e.g. '_dismissAvailability')
   * @param {string}   opts.closeId      — ID passed to the close handler (bookmarkId or watchId)
   * @param {string}   opts.countdownId  — unique ID for the live countdown timer element
   * @param {string}   opts.ariaLabel    — data attribute used for DOM queries (e.g. data-bid, data-wid)
   * @param {string}   opts.source       — 'bookmark' | 'watchlist' (affects panel class + row class)
   */
  _renderEpisodeGrid(container, opts) {
    const {
      episodes, showInfo, imdb, schema, closeHandler, closeId,
      countdownId, ariaLabel, source,
    } = opts;

    const today = new Date().toISOString().slice(0, 10);
    const { watched, watching } = this._watchedEpisodeSet();

    // Find next upcoming episode — prefer showInfo.nextEpisode, then scan airdates
    let nextEp = showInfo?.nextEpisode || null;
    if (!nextEp) {
      for (const ep of episodes) {
        if (ep.airdate && ep.airdate > today) {
          if (!nextEp || ep.airdate < nextEp.airdate ||
              (ep.airdate === nextEp.airdate && (ep.season < nextEp.season ||
               (ep.season === nextEp.season && ep.episode < nextEp.episode)))) {
            nextEp = ep;
          }
        }
      }
    }

    /** True if ep comes strictly before ref in season/episode order. */
    const isBefore = (ep, ref) =>
      ep.season < ref.season || (ep.season === ref.season && ep.episode < ref.episode);

    /** True if ep is the same season+episode as ref. */
    const isSame = (ep, ref) =>
      ep.season === ref.season && ep.episode === ref.episode;

    // Build episode URL helper
    const buildUrl = (season, episode) => {
      if (!imdb || !schema) return '#';
      return schema.buildUrl({
        imdb, tmdbId: null, type: 'tv',
        lastSeason: season, lastEpisode: episode,
      }) || '#';
    };

    let html = '';

    // Countdown box
    if (nextEp) {
      html += `<div class="wl-countdown-box" data-countdown-wid="${countdownId}">
        <div class="wl-cd-label">S${String(nextEp.season).padStart(2,'0')}E${String(nextEp.episode).padStart(2,'0')} · ${esc(nextEp.name || 'TBA')}</div>
        <div class="wl-cd-airdate">${nextEp.airdate || 'TBA'}</div>
        <div class="wl-cd-timer" id="wl-cd-timer-${countdownId}">--</div>
      </div>`;
    }

    // Header
    html += '<div class="avail-header">';
    html += `<span class="avail-title">${esc(showInfo?.name || '')}</span>`;
    html += `<span class="avail-meta">${episodes.length} episodes</span>`;
    html += '</div>';

    // Group by season
    const bySeason = new Map();
    for (const ep of episodes) {
      if (!bySeason.has(ep.season)) bySeason.set(ep.season, []);
      bySeason.get(ep.season).push(ep);
    }

    for (const [season, eps] of [...bySeason.entries()].sort((a, b) => a - b)) {
      const sorted = eps.sort((a, b) => a.episode - b.episode);
      html += `<div class="avail-season"><div class="avail-season-label">Season ${season}</div><div class="avail-ep-grid">`;

      for (const ep of sorted) {
        let isAired, isNext, isFuture;
        if (nextEp) {
          // Positional logic: everything before nextEp = aired, nextEp = next, after = future
          isNext = isSame(ep, nextEp);
          isAired = !isNext && isBefore(ep, nextEp);
          isFuture = !isAired && !isNext;
        } else {
          // Fallback: airdate-based. Null airdate = aired (unknown but exists).
          isAired = !ep.airdate || ep.airdate <= today;
          isFuture = !!ep.airdate && ep.airdate > today;
          isNext = false;
        }

        const epUrl = isAired ? buildUrl(season, ep.episode) : '#';

        let epClass = 'avail-ep-btn ';
        if (isAired) epClass += 'wl-ep-aired';
        else if (isNext) epClass += 'wl-ep-next';
        else epClass += 'wl-ep-future';

        const key = imdb ? `${imdb}|${season}|${ep.episode}` : '';
        if (key && watching.has(key)) epClass += ' avail-ep-watching';
        else if (key && watched.has(key)) epClass += ' avail-ep-watched';

        const statusLabel = key && watching.has(key) ? ' · WATCHING'
          : (key && watched.has(key) ? ' · WATCHED' : '');
        const title = `S${String(season).padStart(2,'0')}E${String(ep.episode).padStart(2,'0')} · ${esc(ep.name || '')}${ep.airdate ? ' · ' + ep.airdate : ''}${statusLabel}`;

        if (isAired) {
          html += `<a class="${epClass}" href="${esc(epUrl)}" target="_blank" title="${title}">${ep.episode}</a>`;
        } else {
          html += `<span class="${epClass}" title="${title}">${ep.episode}</span>`;
        }
      }
      html += '</div></div>';
    }

    // Close button
    html += `<button class="avail-dismiss" data-dismiss="${ariaLabel}" data-dismiss-id="${closeId}">Close</button>`;

    container.innerHTML = html;

    // Bind close
    const closeBtn = container.querySelector('.avail-dismiss');
    if (closeBtn && closeHandler) {
      closeBtn.addEventListener('click', () => this[closeHandler](closeId));
    }

    // Start countdown timer
    if (nextEp) this._startEpCountdown(countdownId, nextEp.airdate);
  }

  /** Start a live countdown timer for the next episode airdate. */
  _startEpCountdown(countdownId, airdate) {
    this._stopEpCountdown(countdownId);
    const timerEl = document.getElementById(`wl-cd-timer-${countdownId}`);
    if (!timerEl || !airdate) return;

    const update = () => {
      const now = new Date();
      const target = new Date(airdate + 'T00:00:00');
      const diff = target - now;
      if (diff <= 0) {
        timerEl.textContent = 'Airing now!';
        clearInterval(this._wlCountdownTimers.get(countdownId));
        this._wlCountdownTimers.delete(countdownId);
        return;
      }
      const d = Math.floor(diff / 86400000);
      const h = Math.floor((diff % 86400000) / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      timerEl.textContent = `${d}d ${String(h).padStart(2,'0')}h ${String(m).padStart(2,'0')}m ${String(s).padStart(2,'0')}s`;
    };

    update();
    const id = setInterval(update, 1000);
    this._wlCountdownTimers.set(countdownId, id);
  }

  _stopEpCountdown(countdownId) {
    const id = this._wlCountdownTimers.get(countdownId);
    if (id) { clearInterval(id); this._wlCountdownTimers.delete(countdownId); }
  }

  /* ── Bookmark episode browser (uses shared renderer) ────────── */

  async _checkAvailability(bookmarkId) {
    const bm = this.bookmarks.find(b => b.bookmarkId === bookmarkId);
    if (!bm || bm.type !== 'tv') return;

    // Show loading state
    let container = document.querySelector(`.bm-availability[data-bid="${bookmarkId}"]`);
    if (container) {
      container.innerHTML = '<div class="avail-loading">Loading episodes…</div>';
    } else {
      const row = document.querySelector(`.bookmark-row[data-bid="${bookmarkId}"]`);
      if (row) {
        const div = document.createElement('div');
        div.className = 'bm-availability';
        div.dataset.bid = bookmarkId;
        div.innerHTML = '<div class="avail-loading">Loading episodes…</div>';
        row.insertAdjacentElement('afterend', div);
        row.classList.add('bm-row-expanded');
        container = div;
      }
    }
    if (!container) return;

    // Fetch via availability.js (finds show on TVmaze, fetches episodes)
    const data = await checkAvailability(bm);
    const episodes = (data.episodes || []).map(ep => ({
      season: ep.season,
      episode: ep.episode,
      name: ep.name || '',
      airdate: ep.airdate || null,
    }));

    // Save to cache
    await this.storage.saveAvailability(bookmarkId, { ...data, episodes });
    this.availCache[bookmarkId] = { ts: Date.now(), data: { ...data, episodes } };

    // Also cache showId for cross-reference with watchlist
    if (data.showId) {
      this._bmShowIds = this._bmShowIds || {};
      this._bmShowIds[bookmarkId] = data.showId;
    }

    // Replace check button with persistent indicator
    const btn = document.querySelector(`.bm-check[data-bid="${bookmarkId}"]`);
    if (btn) {
      const newBtn = document.createElement('button');
      newBtn.dataset.bid = bookmarkId;
      const epCount = episodes.length;
      newBtn.className = 'bm-avail-indicator avail-indicator-expand';
      newBtn.title = `${epCount} episodes — click to browse`;
      newBtn.textContent = '☰';
      newBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._toggleAvailability(bookmarkId);
      });
      btn.replaceWith(newBtn);
    }

    // Fetch show info for countdown (non-blocking — render what we have first)
    let showInfo = null;
    if (data.showId) {
      try {
        const cached = this.wlEpisodeCache.get(data.showId);
        if (cached?.showInfo) {
          showInfo = cached.showInfo;
        } else {
          showInfo = await wlFetchShowInfo(data.showId);
          if (showInfo) {
            cached?.episodes
              ? this.wlEpisodeCache.set(data.showId, { ...cached, showInfo })
              : this.wlEpisodeCache.set(data.showId, { ts: Date.now(), episodes, showInfo });
          }
        }
      } catch (_) { /* no countdown — still usable */ }
    }

    // Look up watchlist item — only merge if series is in BOTH bookmark + watchlist
    const wlItem = this.watchlist.find(w =>
      (w.imdb && w.imdb === bm.imdb) ||
      (data.showId && w.showId === data.showId)
    );

    let finalEpisodes = episodes;
    let finalShowInfo = showInfo || { name: bm.name };

    if (wlItem) {
      // ── Series is in BOTH → merge episodes, trust watchlist for future boundary ──
      let wlEpisodes = null;
      const wlCached = this.wlEpisodeCache.get(wlItem.showId);
      if (wlCached?.episodes) {
        wlEpisodes = wlCached.episodes;
      } else {
        try {
          wlEpisodes = await wlFetchEpisodes(wlItem.showId);
          if (wlEpisodes && data.showId) {
            const cached = this.wlEpisodeCache.get(data.showId) || {};
            this.wlEpisodeCache.set(data.showId, { ...cached, ts: Date.now(), episodes: wlEpisodes });
          }
        } catch (_) { /* keep bookmark episodes */ }
      }

      // Use larger episode set
      if (wlEpisodes && wlEpisodes.length > episodes.length) {
        finalEpisodes = wlEpisodes;
      }

      // Trust watchlist for next episode boundary (source of truth)
      if (wlItem.nextEpisodeAirdate) {
        finalShowInfo.nextEpisode = {
          season: wlItem.lastKnownSeason,
          episode: wlItem.lastKnownEpisode + 1,
          name: wlItem.nextEpisodeInfo || '',
          airdate: wlItem.nextEpisodeAirdate,
        };
      }
    }
    // else: BOOKMARK ONLY — use bookmark data as-is, no watchlist override

    // Render with shared renderer
    const schema = this.schemas.find(s => s.schemaId === bm.schemaId);
    this._renderEpisodeGrid(container, {
      episodes: finalEpisodes,
      showInfo: finalShowInfo,
      imdb: bm.imdb,
      schema: schema || null,
      closeHandler: '_dismissAvailability',
      closeId: bookmarkId,
      countdownId: `bm-${bookmarkId}`,
      ariaLabel: 'bid',
      source: 'bookmark',
    });
  }

  /** Toggle cached TV episode browser (expand/collapse). */
  _toggleAvailability(bookmarkId) {
    const existing = document.querySelector(`.bm-availability[data-bid="${bookmarkId}"]`);
    if (existing) {
      this._stopEpCountdown(`bm-${bookmarkId}`);
      existing.remove();
      const row = document.querySelector(`.bookmark-row[data-bid="${bookmarkId}"]`);
      if (row) row.classList.remove('bm-row-expanded');
      return;
    }

    const cached = this.availCache[bookmarkId];
    if (!cached || !cached.data || !cached.data.episodes) return;

    const row = document.querySelector(`.bookmark-row[data-bid="${bookmarkId}"]`);
    if (!row) return;

    const div = document.createElement('div');
    div.className = 'bm-availability';
    div.dataset.bid = bookmarkId;
    row.insertAdjacentElement('afterend', div);
    row.classList.add('bm-row-expanded');

    // Re-render using cached data
    const bm = this.bookmarks.find(b => b.bookmarkId === bookmarkId);
    const schema = bm ? this.schemas.find(s => s.schemaId === bm.schemaId) : null;

    // Try to get showInfo from wlEpisodeCache
    this._bmShowIds = this._bmShowIds || {};
    const showId = this._bmShowIds[bookmarkId];
    let showInfo = null;
    if (showId) {
      const wlCached = this.wlEpisodeCache.get(showId);
      showInfo = wlCached?.showInfo || null;
    }

    let finalEpisodes = cached.data.episodes;
    let finalShowInfo = showInfo || { name: bm?.name || '' };

    // Look up watchlist item — only merge if in BOTH
    const wlItem = this.watchlist.find(w =>
      (bm?.imdb && w.imdb === bm.imdb) || (showId && w.showId === showId)
    );
    if (wlItem) {
      // ── Series in BOTH → merge episodes (use larger set from cache), trust watchlist boundary ──
      const wlCached = this.wlEpisodeCache.get(wlItem.showId);
      if (wlCached?.episodes && wlCached.episodes.length > finalEpisodes.length) {
        finalEpisodes = wlCached.episodes;
      }

      if (wlItem.nextEpisodeAirdate) {
        finalShowInfo.nextEpisode = {
          season: wlItem.lastKnownSeason,
          episode: wlItem.lastKnownEpisode + 1,
          name: wlItem.nextEpisodeInfo || '',
          airdate: wlItem.nextEpisodeAirdate,
        };
      }
    }
    // else: BOOKMARK ONLY — use cached data as-is

    this._renderEpisodeGrid(div, {
      episodes: finalEpisodes,
      showInfo: finalShowInfo,
      imdb: bm?.imdb || null,
      schema: schema || null,
      closeHandler: '_dismissAvailability',
      closeId: bookmarkId,
      countdownId: `bm-${bookmarkId}`,
      ariaLabel: 'bid',
      source: 'bookmark',
    });
  }

  _dismissAvailability(bookmarkId) {
    this._stopEpCountdown(`bm-${bookmarkId}`);
    const container = document.querySelector(`.bm-availability[data-bid="${bookmarkId}"]`);
    if (container) container.remove();
    const row = document.querySelector(`.bookmark-row[data-bid="${bookmarkId}"]`);
    if (row) row.classList.remove('bm-row-expanded');
  }

  /** Build Sets of "imdb|season|episode" for watching and watched episodes. */
  _watchedEpisodeSet() {
    const watched = new Set();
    const watching = new Set();
    for (const h of this.history) {
      if (h.type !== 'tv' || !h.season || !h.episode) continue;
      const key = `${h.imdb}|${h.season}|${h.episode}`;
      if (h.status === 'watching') {
        watching.add(key);
      } else {
        watched.add(key);  // 'watched' or legacy entries without status
      }
    }
    return { watched, watching };
  }

  async _editPosition(bookmarkId) {
    const bm = this.bookmarks.find(b => b.bookmarkId === bookmarkId);
    if (!bm || bm.type !== 'tv') return;

    const badge = document.querySelector(`.bm-pos-badge[data-bid="${bookmarkId}"]`);
    if (!badge) return;

    // Already in edit mode — don't re-trigger
    if (badge.querySelector('input')) return;

    const oldHtml = badge.innerHTML;
    const s = bm.lastSeason || 1;
    const e = bm.lastEpisode || 1;

    badge.innerHTML = `S ‎ <input type="number" class="bm-edit-input" value="${s}" min="1" style="width:28px">
                       <span style="color:var(--muted);margin:0 1px">‎ E ‎</span>
                       <input type="number" class="bm-edit-input" value="${e}" min="1" style="width:28px">`;

    const inputs = badge.querySelectorAll('input');
    const save = () => {
      const ns = parseInt(inputs[0].value, 10) || 1;
      const ne = parseInt(inputs[1].value, 10) || 1;
      if (ns !== bm.lastSeason || ne !== bm.lastEpisode) {
        bm.lastSeason = ns;
        bm.lastEpisode = ne;
        this.storage.saveAll(this.schemas, this.bookmarks).then(() => this._renderBookmarks());
      } else {
        badge.innerHTML = oldHtml;
      }
    };

    inputs[0].focus();
    inputs.forEach(inp => {
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
    });

    // Click outside the badge to save
    const outside = (e) => {
      if (!badge.contains(e.target)) {
        save();
        document.removeEventListener('click', outside, true);
      }
    };
    setTimeout(() => document.addEventListener('click', outside, true), 0);
  }

  _goToBookmark(bm) {
    const schema = this.schemas.find(s => s.schemaId === bm.schemaId);
    if (!schema) return;
    const url = schema.buildUrl(bm);
    if (url) window.wtAPI.openEmbed(url);
  }

  _renderBookmarks() {
    const list = this.$('#bookmarks-list'), empty = this.$('#no-bookmarks');
    const filterBar = this.$('#bm-filter-bar');

    const hasTv = this.bookmarks.some(b => b.type === 'tv');
    const hasMovie = this.bookmarks.some(b => b.type === 'movie');
    filterBar.style.display = (hasTv && hasMovie) ? '' : 'none';

    if (this.bmFilter !== 'all' && !this.bookmarks.some(b => b.type === this.bmFilter)) {
      this.bmFilter = 'all';
    }

    this.$$('.bm-filter-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.filter === this.bmFilter);
    });

    const filtered = this.bmFilter === 'all'
      ? this.bookmarks
      : this.bookmarks.filter(b => b.type === this.bmFilter);

    // Filter by search query (name or IMDB ID)
    const query = (this.$('#bm-filter-search')?.value || '').trim().toLowerCase();
    const displayed = query
      ? filtered.filter(b => b.name.toLowerCase().includes(query) || b.imdb.toLowerCase().includes(query))
      : filtered;

    if (!displayed.length) {
      list.innerHTML = '';
      empty.textContent = query ? 'No bookmarks match your search' : (this.bmFilter === 'tv' ? 'No TV series bookmarked' : 'No movies bookmarked');
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');

    list.innerHTML = displayed.map(bm => {
      const pos = bm.positionLabel;
      const thumb = bm.imageUrl ? `<img src="${esc(bm.imageUrl)}" class="bm-thumb" onerror="this.style.display='none'" loading="lazy">` : '';
      const posBadge = pos ? `<span class="bm-pos-badge" data-bid="${bm.bookmarkId}">${pos}</span>` : '';
      const cached = this.availCache[bm.bookmarkId];

      // Episode browser button — TV only
      let availBtn = '';
      if (bm.type === 'tv') {
        if (cached && cached.data.found) {
          const epCount = (cached.data.episodes && cached.data.episodes.length) || 0;
          availBtn = `<button class="bm-avail-indicator avail-indicator-expand" data-bid="${bm.bookmarkId}" title="${epCount} episodes — click to browse">☰</button>`;
        } else {
          availBtn = `<button class="bm-check" data-bid="${bm.bookmarkId}" title="Browse episodes">☰</button>`;
        }
      }

      return `<div class="bookmark-row" data-bid="${bm.bookmarkId}">
        ${thumb}
        <div class="bm-info">
          <div class="bm-name" title="${esc(bm.name)}">${esc(bm.name)}</div>
          <div class="bm-meta">
            <select class="bm-schema-select" data-bid="${bm.bookmarkId}">${this.schemas.map(s => `<option value="${s.schemaId}"${s.schemaId===bm.schemaId?' selected':''}>${esc(s.name)}</option>`).join('')}</select>
          </div>
        </div>
        ${posBadge}
        ${availBtn}
        <button class="bm-go" data-bid="${bm.bookmarkId}" title="Resume">▶</button>
        <button class="bm-del" data-bid="${bm.bookmarkId}" title="Delete">✕</button></div>`;
    }).join('');

    // Episode browser button (first-time) — fetch episodes
    list.querySelectorAll('.bm-check').forEach(btn =>
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._checkAvailability(btn.dataset.bid);
      }));

    // Cached indicator — toggle episode browser
    list.querySelectorAll('.bm-avail-indicator').forEach(btn =>
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._toggleAvailability(btn.dataset.bid);
      }));

    list.querySelectorAll('.bm-go').forEach(btn =>
      btn.addEventListener('click', () => {
        const bm = this.bookmarks.find(b => b.bookmarkId === btn.dataset.bid);
        if (bm) this._goToBookmark(bm);
      }));
    list.querySelectorAll('.bm-del').forEach(btn =>
      btn.addEventListener('click', () => this._deleteBookmark(btn.dataset.bid)));
    list.querySelectorAll('.bm-schema-select').forEach(sel =>
      sel.addEventListener('change', () => this._changeBookmarkSchema(sel.dataset.bid, sel.value)));

    // Click badge to edit season/episode inline
    list.querySelectorAll('.bm-pos-badge').forEach(badge => {
      badge.style.cursor = 'pointer';
      badge.title = 'Click to edit season/episode';
      badge.addEventListener('click', (e) => {
        e.stopPropagation();
        this._editPosition(badge.dataset.bid);
      });
    });
  }

  /* ═════════════════════════════════════════════════════════════
     FORM STATE PERSISTENCE
     ═════════════════════════════════════════════════════════════ */
  _bindFormAutoSave() {
    const FIELDS = { bm_search:'#bm-search', bm_season:'#bm-season', bm_episode:'#bm-episode' };
    Object.values(FIELDS).forEach(sel => {
      const el = this.$(sel);
      if (el) { el.addEventListener('input', () => this._saveFormState(FIELDS)); el.addEventListener('change', () => this._saveFormState(FIELDS)); }
    });
  }

  async _saveFormState(fieldMap) {
    const state = {};
    Object.entries(fieldMap).forEach(([k, sel]) => { const el = this.$(sel); if (el) state[k] = el.value; });
    await this.storage.saveFormState(state);
  }

  async _restoreFormState() {
    const state = await this.storage.loadFormState();
    const map = { bm_search: '#bm-search', bm_season: '#bm-season', bm_episode: '#bm-episode' };
    Object.entries(map).forEach(([k, sel]) => {
      const el = this.$(sel);
      if (el && state[k] !== undefined) el.value = state[k];
    });
    // Restore last active tab
    if (state._tab && ['schemas', 'bookmarks', 'watchlist', 'history'].includes(state._tab)) {
      this.activeTab = state._tab;
      this.$$('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === state._tab));
      this.$('#tab-schemas').classList.toggle('active', state._tab === 'schemas');
      this.$('#tab-bookmarks').classList.toggle('active', state._tab === 'bookmarks');
      this.$('#tab-watchlist').classList.toggle('active', state._tab === 'watchlist');
      this.$('#tab-history').classList.toggle('active', state._tab === 'history');
      this._refresh();
    }
  }

  /* ═════════════════════════════════════════════════════════════
     WATCHLIST TAB
     ═════════════════════════════════════════════════════════════ */

  _bindWatchlist() {
    // Toggle custom series search form
    this.$('#wl-toggle-btn').addEventListener('click', () => {
      const form = this.$('#wl-form-wrap');
      const show = form.style.display === 'none';
      form.style.display = show ? '' : 'none';
      this.$('#wl-toggle-btn').classList.toggle('active', show);
      if (show) { this._resetWlForm(); this.$('#wl-search').focus(); }
    });
    this.$('#wl-cancel-btn').addEventListener('click', () => this._hideWlForm());

    // Force check all series now
    this.$('#wl-check-all-btn').addEventListener('click', () => this._wlCheckAll());

    // Search-as-you-type for TVmaze
    let timer = null;
    this.$('#wl-search').addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => this._wlDoSearch(), 400);
    });

    // Dismiss update badge (mark as seen)
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.wl-dismiss-btn');
      if (btn) this._wlDismissUpdate(btn.dataset.wid);
    });

    // Remove watchlist item
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.wl-del-btn');
      if (btn) this._wlRemove(btn.dataset.wid);
    });

    // Click watchlist row → toggle episode browser
    document.addEventListener('click', (e) => {
      // Don't trigger if clicking a button inside the row
      if (e.target.closest('button')) return;
      const row = e.target.closest('.wl-row');
      if (row && row.dataset.wid) this._wlToggleEpisodeBrowser(row.dataset.wid);
    });

    // Close episode browser
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.wl-ep-close');
      if (btn) this._wlDismissEpisodeBrowser(btn.dataset.closeWid);
    });
  }

  /**
   * Run batch update check if cooldown expired.
   * Called when switching to watchlist tab.
   */
  async _syncWatchlist() {
    if (this.wlChecking) return;
    if (!this.watchlist.length) { this.$('#wl-sync-status').textContent = ''; return; }
    this.wlChecking = true;

    try {
      const now = Date.now();
      const needsCheck = (now - this.wlLastCheck) >= WL_COOLDOWN_MS;
      if (needsCheck) {
        this.$('#wl-sync-status').textContent = 'Checking…';
        const count = await wlRunBatchCheck(this.watchlist);
        this.wlLastCheck = now;
        await this.storage.saveWatchlist(this.watchlist, this.wlLastCheck);
        this.$('#wl-sync-status').textContent = count > 0
          ? `Updated ${count} ${count === 1 ? 'series' : 'series'}`
          : 'Up to date';
      } else {
        const mins = Math.floor((WL_COOLDOWN_MS - (now - this.wlLastCheck)) / 60000);
        this.$('#wl-sync-status').textContent = mins > 0
          ? `Next check in ~${mins}m`
          : 'Up to date';
      }
    } finally {
      this.wlChecking = false;
      if (this.activeTab === 'watchlist') this._renderWatchlist();
    }
  }

  /* ── Custom series search ──────────────────────────────────── */

  _resetWlForm() {
    this.$('#wl-search').value = '';
    this.$('#wl-search-status').textContent = '';
    this.$('#wl-search-results').innerHTML = '';
  }

  _hideWlForm() {
    this.$('#wl-form-wrap').style.display = 'none';
    this.$('#wl-toggle-btn').classList.remove('active');
    this._resetWlForm();
  }

  async _wlDoSearch() {
    const q = this.$('#wl-search').value.trim();
    if (!q) {
      this.$('#wl-search-results').innerHTML = '';
      this.$('#wl-search-status').textContent = '';
      return;
    }

    this._wlAbort?.abort();
    this._wlAbort = new AbortController();

    this.$('#wl-search-status').textContent = 'Searching…';
    this.$('#wl-search-results').innerHTML = '';
    try {
      const results = await wlSearchShows(q);
      if (this._wlAbort.signal.aborted) return;
      this.$('#wl-search-status').textContent = results.length ? '' : 'No results.';
      this._wlRenderResults(results);
    } catch (err) {
      if (err.name !== 'AbortError') {
        this.$('#wl-search-status').textContent = 'Search failed.';
      }
    }
  }

  _wlRenderResults(results) {
    const container = this.$('#wl-search-results');
    container.innerHTML = results.map(s => {
      const imageUrl = s.imageUrl || '';
      const typeBadge = s.type === 'Animation' ? ' 🎨' : s.type === 'Documentary' ? ' 📄' : '';
      const statusBadge = s.status === 'Ended' ? ' (ended)' : '';
      return `<div class="wl-search-result" style="cursor:pointer" data-showid="${s.showId}" data-name="${esc(s.name)}" data-image="${esc(imageUrl)}">
        ${imageUrl ? `<img src="${esc(imageUrl)}" class="wl-sr-thumb" onerror="this.style.display='none'" loading="lazy">` : ''}
        <div>
          <div class="sr-title">📺 ${esc(s.name)}${typeBadge}${statusBadge}</div>
          ${s.premiered ? `<div class="sr-meta">Since ${s.premiered}</div>` : ''}
        </div></div>`;
    }).join('');

    container.querySelectorAll('.wl-search-result').forEach(row => {
      row.addEventListener('click', () => this._wlAdd(row.dataset.showid, row.dataset.name, row.dataset.image || null));
    });
  }

  async _wlAdd(showId, name, imageUrl) {
    const sid = parseInt(showId, 10);
    // Prevent duplicates
    if (this.watchlist.some(w => w.showId === sid)) {
      this._hideWlForm();
      return;
    }

    const item = new WatchlistItem({
      watchId: makeBookmarkId(),
      name: name,
      showId: sid,
      source: 'custom',
      imageUrl: imageUrl || null,
    });

    // Fetch initial episode data to set baseline
    try {
      await wlCheckItem(item);
      item.hasUpdate = false;   // baseline — no "update" on first add
      item.updateType = null;
    } catch (_) { /* added with zero state; will be checked on next cycle */ }

    this.watchlist.push(item);
    await this.storage.saveWatchlist(this.watchlist, this.wlLastCheck);
    this._hideWlForm();
    this._renderWatchlist();
  }

  /* ── Dismiss update badge ──────────────────────────────────── */

  async _wlDismissUpdate(watchId) {
    const item = this.watchlist.find(w => w.watchId === watchId);
    if (!item) return;
    item.hasUpdate = false;
    item.updateType = null;
    await this.storage.saveWatchlist(this.watchlist, this.wlLastCheck);
    this._renderWatchlist();
  }

  /* ── Remove from watchlist ─────────────────────────────────── */

  async _wlRemove(watchId) {
    const item = this.watchlist.find(w => w.watchId === watchId);
    if (item) {
      // Remember deletion so auto-sync doesn't re-add it
      if (item.bookmarkId) {
        this.wlDeleted.add(item.bookmarkId);
        await this.storage.addDeletedWatchlistId(item.bookmarkId);
      }
      if (item.showId) {
        const sid = String(item.showId);
        this.wlDeleted.add(sid);
        await this.storage.addDeletedWatchlistId(sid);
      }
    }
    this.watchlist = this.watchlist.filter(w => w.watchId !== watchId);
    await this.storage.saveWatchlist(this.watchlist, this.wlLastCheck);
    this._renderWatchlist();
  }

  /* ── Episode browser (watchlist — uses shared renderer) ────── */

  async _wlToggleEpisodeBrowser(watchId) {
    // Dismiss if already open
    const existing = document.querySelector(`.wl-episode-browser[data-wid="${watchId}"]`);
    if (existing) { this._wlDismissEpisodeBrowser(watchId); return; }

    const w = this.watchlist.find(w => w.watchId === watchId);
    if (!w) return;

    const row = document.querySelector(`.wl-row[data-wid="${watchId}"]`);
    if (!row) return;

    // Insert loading panel
    const panel = document.createElement('div');
    panel.className = 'wl-episode-browser';
    panel.dataset.wid = watchId;
    panel.innerHTML = '<div class="avail-loading">Loading episodes…</div>';
    row.insertAdjacentElement('afterend', panel);
    row.classList.add('wl-row-expanded');

    // Fetch episodes + show info
    let episodes, showInfo;
    const cached = this.wlEpisodeCache.get(w.showId);
    if (cached && (Date.now() - cached.ts) < 600000 && cached.episodes && cached.showInfo) {
      episodes = cached.episodes;
      showInfo = cached.showInfo;
    } else {
      try {
        const [epData, si] = await Promise.all([
          wlFetchEpisodes(w.showId),
          wlFetchShowInfo(w.showId),
        ]);
        episodes = epData;
        showInfo = si;
        this.wlEpisodeCache.set(w.showId, { ts: Date.now(), episodes, showInfo });
      } catch (_) {
        panel.innerHTML = '<div class="avail-badge avail-unavailable">✕ Failed to load episodes</div>';
        return;
      }
    }

    if (!episodes || !episodes.length) {
      panel.innerHTML = '<div class="avail-badge avail-unavailable">✕ No episodes found</div>';
      return;
    }

    // Merge watchlist item's nextEpisodeAirdate into showInfo (source of truth)
    if (showInfo && w.nextEpisodeAirdate && (!showInfo.nextEpisode || showInfo.nextEpisode.airdate !== w.nextEpisodeAirdate)) {
      showInfo.nextEpisode = {
        season: w.lastKnownSeason,
        episode: w.lastKnownEpisode + 1,
        name: w.nextEpisodeInfo || '',
        airdate: w.nextEpisodeAirdate,
      };
    }

    // Use the first available schema for building episode URLs
    const schema = this.schemas.length ? this.schemas[0] : null;
    const imdb = showInfo?.imdb || w.imdb || null;

    this._renderEpisodeGrid(panel, {
      episodes,
      showInfo: showInfo || { name: w.name },
      imdb,
      schema,
      closeHandler: '_wlDismissEpisodeBrowser',
      closeId: watchId,
      countdownId: `wl-${watchId}`,
      ariaLabel: 'wid',
      source: 'watchlist',
    });
  }

  _wlDismissEpisodeBrowser(watchId) {
    this._stopEpCountdown(`wl-${watchId}`);
    const panel = document.querySelector(`.wl-episode-browser[data-wid="${watchId}"]`);
    if (panel) panel.remove();
    const row = document.querySelector(`.wl-row[data-wid="${watchId}"]`);
    if (row) row.classList.remove('wl-row-expanded');
  }

  /* ── Force check all series now ────────────────────────────── */

  async _wlCheckAll() {
    if (this.wlChecking) return;
    if (!this.watchlist.length) return;

    this.wlChecking = true;
    const btn = this.$('#wl-check-all-btn');
    const status = this.$('#wl-sync-status');
    btn.classList.add('wl-spinning');
    btn.disabled = true;
    status.textContent = `Checking ${this.watchlist.length} series…`;

    try {
      // Bypass cooldown — check ALL items, force re-check
      const count = await wlRunBatchCheck(this.watchlist, this.watchlist.length, true);
      this.wlLastCheck = Date.now();
      await this.storage.saveWatchlist(this.watchlist, this.wlLastCheck);

      const withUpdates = this.watchlist.filter(w => w.hasUpdate).length;
      status.textContent = count > 0
        ? `Checked ${count} · ${withUpdates} ${withUpdates === 1 ? 'update' : 'updates'}`
        : 'All up to date';
    } catch (_) {
      status.textContent = 'Check failed';
    } finally {
      btn.classList.remove('wl-spinning');
      btn.disabled = false;
      this.wlChecking = false;
      if (this.activeTab === 'watchlist') this._renderWatchlist();
    }
  }

  /* ── Render watchlist ──────────────────────────────────────── */

  _renderWatchlist() {
    const list = this.$('#watchlist-items'), empty = this.$('#no-watchlist');

    if (!this.watchlist.length) {
      list.innerHTML = '';
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');

    // Filter by search query
    const query = (this.$('#wl-filter-search')?.value || '').trim().toLowerCase();
    const filtered = query
      ? this.watchlist.filter(w => w.name.toLowerCase().includes(query))
      : this.watchlist;

    if (!filtered.length) {
      list.innerHTML = '';
      empty.textContent = query ? 'No series match your search' : 'No series tracked. Search to add a TV show.';
      empty.classList.remove('hidden');
      return;
    }

    // Sort: items with updates first, then by name
    const sorted = [...filtered].sort((a, b) => {
      if (a.hasUpdate && !b.hasUpdate) return -1;
      if (!a.hasUpdate && b.hasUpdate) return 1;
      return a.name.localeCompare(b.name);
    });

    list.innerHTML = sorted.map(w => {
      const thumb = w.imageUrl
        ? `<img src="${esc(w.imageUrl)}" class="bm-thumb" onerror="this.style.display='none'" loading="lazy">`
        : '';
      const pos = w.lastKnownSeason ? w.positionLabel : '';
      const nextStr = w.nextLabel;
      const cdn = w.countdownLabel;

      // Update badge
      let updateBadge = '';
      if (w.hasUpdate) {
        updateBadge = `<span class="wl-update-badge">
          ${w.updateLabel}
          <button class="wl-dismiss-btn" data-wid="${w.watchId}" title="Dismiss">✕</button>
        </span>`;
      }

      return `<div class="bookmark-row wl-row${w.hasUpdate ? ' wl-has-update' : ''}" data-wid="${w.watchId}">
        ${thumb}
        <div class="bm-info">
          <div class="bm-name" title="${esc(w.name)}">${esc(w.name)}</div>
          <div class="bm-meta">
            ${pos ? `<span class="wl-pos-label">${pos}</span>` : '<span style="color:var(--text-tertiary)">—</span>'}
            ${nextStr ? ` · <span class="wl-next-label">${esc(nextStr)}</span>` : (w.listeningLabel ? ` · <span style="color:var(--text-tertiary);font-style:italic">${esc(w.listeningLabel)}</span>` : '')}
            ${w.showStatus !== 'Running' && w.showStatus !== 'Unknown' ? ` · <span style="color:var(--text-tertiary)">${esc(w.showStatus)}</span>` : ''}
            ${cdn ? ` · <span class="wl-countdown">⏱ ${esc(cdn)}</span>` : ''}
          </div>
        </div>
        ${updateBadge}
        <button class="wl-del-btn" data-wid="${w.watchId}" title="Stop tracking">✕</button>
      </div>`;
    }).join('');

    // Update tab badge
    const wlTabBtn = this.$('.tab-btn[data-tab="watchlist"]');
    if (wlTabBtn) {
      const updateCount = this.watchlist.filter(w => w.hasUpdate).length;
      wlTabBtn.textContent = updateCount > 0 ? `Watchlist (${updateCount})` : 'Watchlist';
      wlTabBtn.style.color = updateCount > 0 ? 'var(--warning)' : '';
    }
  }

  /* ═════════════════════════════════════════════════════════════
     DATA EXPORT / IMPORT
     ═════════════════════════════════════════════════════════════ */
  _bindDataBar() {
    this.$('#export-btn')?.addEventListener('click', () => this._exportData());
    this.$('#import-btn')?.addEventListener('click', () => this.$('#import-file')?.click());
    this.$('#import-file')?.addEventListener('change', (e) => this._importData(e));
  }

  _listenForDataImported() {
    // Called when File → Import from menu completes
    if (window.wtAPI) {
      window.wtAPI.onDataImported?.(async () => {
        await this._loadAndRender();
      });
    }
  }

  async _exportData() {
    if (!window.wtAPI) return;
    const payload = await window.wtAPI.exportData();
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `watchthemall-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async _importData(event) {
    const file = event.target.files?.[0];
    if (!file || !window.wtAPI) return;
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      await window.wtAPI.importData(payload);
      event.target.value = '';
      await this._loadAndRender();
    } catch (err) {
      console.error('Import failed:', err);
    }
  }
}
