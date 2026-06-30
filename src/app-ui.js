/**
 * WatchThemAll v2 — app-ui.js
 * Unified dashboard UI controller: master-detail layout, modal flows,
 * filter-based navigation. No more tab panels.
 */
class AppUI {
  constructor(storage) {
    this.storage = storage;
    this.schemas = [];
    this.bookmarks = [];
    this.history = [];
    this.availCache = {};
    this.watchlist = [];
    this.wlLastCheck = 0;
    this.wlChecking = false;
    this.wlEpisodeCache = new Map();
    this._wlCountdownTimers = new Map();
    this.wlDeleted = new Set();
    this.providerCatalog = [];
    this._searchCache = new Map();

    // UI state
    this.activeFilter = 'all';
    this.selectedItem = null; // { type: 'bookmark'|'watchlist'|'history', ref: bookmark|watchlistItem|historyEntry }
    this.selectedBookmark = null;
    this.selectedWatchlistItem = null;

    // Add modal state
    this._bmPending = null;
    this._bmAbort = null;
    this._wlAbort = null;

    // Shortcut references
    this.$ = (s) => document.querySelector(s);
    this.$$ = (s) => document.querySelectorAll(s);
  }

  /* ═════════════════════════════════════════════════════════════
     INIT
     ═════════════════════════════════════════════════════════════ */
  async init() {
    window.__diag?.('AppUI.init() starting');

    this._bindHeader();
    this._bindFilters();
    this._bindSidebarAdd();
    this._bindProviders();
    this._bindGlobalSearch();
    this._bindModal();
    this._bindEditModal();
    this._bindKeyboard();

    // Load data
    try { await this._loadCatalog(); } catch (e) { window.__diag_err?.('_loadCatalog', e); }
    window.__diag?.('catalog loaded: ' + (this.providerCatalog?.length || 0));

    try { await this._loadAndRender(); } catch (e) { window.__diag_err?.('_loadAndRender', e); }
    window.__diag?.('_loadAndRender done');

    this._setupIPCListeners();

    // Set data dir in status bar
    if (window.wtAPI) {
      try {
        const dir = await window.wtAPI.getDataDir();
        const el = this.$('#status-left');
        if (el) { el.textContent = dir; el.title = dir; }
      } catch (_) { /* non-critical */ }
    }

    window.__diag?.('init() complete');
  }

  /* ═════════════════════════════════════════════════════════════
     DATA LOADING
     ═════════════════════════════════════════════════════════════ */
  async _loadAndRender() {
    const { schemas, bookmarks } = await this.storage.loadAll();

    let activeIds = await this.storage.loadActiveProviderIds();
    if (!activeIds || !activeIds.length) {
      activeIds = ['cinemaos', 'screenscape', 'vidsrc-me', 'vidsrc-to'];
      await this.storage.saveActiveProviderIds(activeIds);
    }

    this.schemas = [];
    for (const pid of activeIds) {
      const entry = this.providerCatalog.find(p => p.id === pid);
      if (entry) this.schemas.push(schemaFromCatalog(entry));
    }
    if (!this.schemas.length && schemas.length) this.schemas = schemas;
    if (!this.schemas.length) this.schemas = DEFAULT_SCHEMAS;

    this.bookmarks = bookmarks;

    // Migrate orphan bookmarks
    const activeSchemaIds = new Set(this.schemas.map(s => s.schemaId));
    let migrated = false;
    for (const bm of this.bookmarks) {
      if (!activeSchemaIds.has(bm.schemaId) && this.schemas.length) {
        bm.schemaId = this.schemas[0].schemaId;
        migrated = true;
      }
    }
    if (migrated) await this.storage.saveAll(this.schemas, this.bookmarks);

    // Sample data if empty
    if (!this.bookmarks.length && this.schemas.length) {
      this.bookmarks.push(new Bookmark({
        bookmarkId: 'sample_tbbt', name: 'The Big Bang Theory',
        imdb: 'tt0898266', schemaId: this.schemas[0].schemaId,
        type: 'tv', lastSeason: 1, lastEpisode: 1,
      }));
    }

    this.availCache = await this.storage.loadAvailabilityCache();
    this.history = await this.storage.loadHistory();

    const wlData = await this.storage.loadWatchlist();
    this.watchlist = wlData.items || [];
    this.wlLastCheck = wlData.lastCheck || 0;
    this.wlDeleted = await this.storage.loadDeletedWatchlistIds();

    await this._autoSyncBookmarksToWatchlist();

    this._refreshAll();
    this._fetchMissingCovers();
    this._probeProviders();
    if (this.activeFilter === 'tracked') this._syncWatchlist();
  }

  async _loadCatalog() {
    const cached = await this._loadCachedCatalog();
    if (cached && cached.length) {
      this.providerCatalog = cached;
    } else {
      try {
        const fresh = await this._fetchProvidersFromGitHub();
        if (fresh && fresh.length > 0) {
          this.providerCatalog = fresh;
          await this._saveCachedCatalog(fresh);
        }
      } catch (_) { /* network error */ }
    }

    if (!this.providerCatalog) this.providerCatalog = [];
    try {
      const bundled = await window.wtAPI.readProvidersJson();
      const existingIds = new Set(this.providerCatalog.map(p => p.id));
      for (const p of bundled) {
        if (!existingIds.has(p.id)) this.providerCatalog.push(p);
      }
    } catch (_) { /* no bundled */ }

    if (!this.providerCatalog.length) this.providerCatalog = [];
  }

  async _loadCachedCatalog() {
    const { vidsrc_provider_catalog: data } = await chrome.storage.local.get({ vidsrc_provider_catalog: null });
    if (!data || data._ver !== 2) return null;
    if (Date.now() - data.ts > 604800000) return null;
    return data.providers;
  }

  async _saveCachedCatalog(providers) {
    await chrome.storage.local.set({ vidsrc_provider_catalog: { _ver: 2, ts: Date.now(), providers } });
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
    const blockRe = /\{\s*\n?\s*id:\s*'([^']+)',\s*\n?\s*label:\s*'([^']+)',[\s\S]*?buildMovieUrl:\s*\([^)]*\)\s*=>\s*`([^`]+)`[\s\S]*?buildTvUrl:\s*\([^)]*\)\s*=>\s*`([^`]+)`[\s\S]*?\}/g;
    let match;
    while ((match = blockRe.exec(ts)) !== null) {
      const [, id, label, movieTpl, tvTpl] = match;
      const movieUrl = parseProviderTemplate(movieTpl.trim());
      const tvUrl = parseProviderTemplate(tvTpl.trim());
      const rootUrl = extractRootUrl(movieTpl.trim(), tvTpl.trim());
      if (!movieUrl && !tvUrl) continue;
      providers.push({
        id, name: label, rootUrl,
        tv: tvUrl ? { urlTemplate: tvUrl } : null,
        movie: movieUrl ? { urlTemplate: movieUrl } : null,
        tier: ts.includes(`id: '${id}'`) && ts.indexOf(`id: '${id}'`) < ts.indexOf('// Extras') ? 'core' : 'extras',
      });
    }
    return providers;
  }

  async _fetchMissingCovers() {
    const needCover = this.bookmarks.filter(b => !b.imageUrl);
    const needTmdb = this.bookmarks.filter(b => b.type === 'tv' && !b.tmdbId);
    if (!needCover.length && !needTmdb.length) return;
    let changed = false;

    for (const bm of needCover) {
      try {
        const resp = await fetch('https://v3.sg.media-imdb.com/suggestion/x/' + bm.imdb + '.json');
        if (!resp.ok) continue;
        const data = await resp.json();
        const hit = (data.d || []).find(it => it.id === bm.imdb);
        if (hit?.i?.imageUrl) { bm.imageUrl = hit.i.imageUrl; changed = true; }
        if (hit?.s && !bm.stars) { bm.stars = hit.s; changed = true; }
        if (hit?.q && !bm.category) { bm.category = hit.q; changed = true; }
      } catch (_) { /* skip */ }
    }

    for (const bm of needTmdb) {
      try {
        const tid = await fetchTmdbId(bm.imdb);
        if (tid) { bm.tmdbId = tid; changed = true; }
      } catch (_) { /* skip */ }
    }

    if (changed) {
      await this.storage.saveAll(this.schemas, this.bookmarks);
      this._renderItemList();
    }
  }

  async _autoSyncBookmarksToWatchlist() {
    const tvBookmarks = this.bookmarks.filter(b => b.type === 'tv');
    if (!tvBookmarks.length) return;
    let changed = false;

    for (const bm of tvBookmarks) {
      let showId = null;
      try {
        const show = await findShow(bm.name, bm.imdb);
        if (show) showId = show.id;
      } catch (_) { /* skip */ }
      if (!showId) continue;

      const exists = this.watchlist.some(w =>
        (w.bookmarkId && w.bookmarkId === bm.bookmarkId) ||
        (w.imdb && bm.imdb && w.imdb === bm.imdb) ||
        (w.showId && w.showId === showId)
      );
      if (exists) continue;
      if (this.wlDeleted.has(bm.bookmarkId) || this.wlDeleted.has(String(showId))) continue;

      const item = new WatchlistItem({
        watchId: makeBookmarkId(), name: bm.name, imdb: bm.imdb,
        showId, source: 'bookmark', bookmarkId: bm.bookmarkId,
        imageUrl: bm.imageUrl || null,
      });
      this.watchlist.push(item);
      changed = true;
    }

    if (changed) {
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
     REFRESH ALL VIEWS
     ═════════════════════════════════════════════════════════════ */
  _refreshAll() {
    this._renderItemList();
    this._renderMainPanel();
    this._renderStatusBar();
  }

  /* ═════════════════════════════════════════════════════════════
     HEADER BINDINGS
     ═════════════════════════════════════════════════════════════ */
  _bindHeader() {
    this.$('#hdr-add')?.addEventListener('click', () => this._openAddModal());
    this.$('#hdr-check-all')?.addEventListener('click', () => this._wlCheckAll());
    this.$('#hdr-export')?.addEventListener('click', () => this._exportData());
    this.$('#hdr-import')?.addEventListener('click', () => this.$('#import-file')?.click());
    this.$('#import-file')?.addEventListener('change', (e) => this._importData(e));
  }

  /* ═════════════════════════════════════════════════════════════
     FILTERS
     ═════════════════════════════════════════════════════════════ */
  _bindFilters() {
    this.$$('.filter-btn').forEach(btn => {
      btn.addEventListener('click', () => this._setFilter(btn.dataset.filter));
    });
  }

  _setFilter(filter) {
    this.activeFilter = filter;
    this.selectedItem = null;
    this.selectedBookmark = null;
    this.selectedWatchlistItem = null;

    this.$$('.filter-btn').forEach(b => b.classList.toggle('active', b.dataset.filter === filter));
    this.$$('.sb-item').forEach(b => b.classList.remove('selected'));

    this._renderItemList();
    this._renderMainPanel();

    if (filter === 'tracked') this._syncWatchlist();

    this.storage.saveFormState({ _filter: filter });
  }

  _bindSidebarAdd() {
    this.$('#sidebar-add-btn')?.addEventListener('click', () => this._openAddModal());
  }

  /* ═════════════════════════════════════════════════════════════
     PROVIDERS (collapsible sidebar section)
     ═════════════════════════════════════════════════════════════ */
  _bindProviders() {
    this.$('#providers-toggle')?.addEventListener('click', () => {
      const list = this.$('#providers-list');
      const btn = this.$('#providers-toggle');
      const show = list.style.display === 'none';
      list.style.display = show ? '' : 'none';
      btn.classList.toggle('open', show);
      if (show) this._renderProviders();
    });
  }

  _renderProviders() {
    const list = this.$('#providers-list');
    if (!list || !this.providerCatalog.length) return;

    const activeIds = new Set(this.schemas.map(s => s.schemaId));
    const sorted = [...this.providerCatalog].sort((a, b) => a.name.localeCompare(b.name));

    list.innerHTML = sorted.map(p => {
      const isActive = activeIds.has(p.id);
      const isLast = activeIds.size <= 1 && isActive;
      const healthClass = p._alive === true ? 'alive' : (p._alive === false ? 'dead' : 'unknown');
      return `<div class="provider-item">
        <span class="provider-item-health ${healthClass}"></span>
        <span class="provider-item-name">${esc(p.name)}</span>
        <button class="provider-item-toggle${isActive ? '' : ' off'}" data-pid="${esc(p.id)}"${isLast ? ' disabled' : ''}>${isActive ? 'On' : 'Off'}</button>
      </div>`;
    }).join('');

    list.querySelectorAll('.provider-item-toggle').forEach(btn => {
      btn.addEventListener('click', () => this._toggleProvider(btn.dataset.pid));
    });

    this.$('#providers-count').textContent = `${activeIds.size} active`;
  }

  async _toggleProvider(providerId) {
    const activeIds = new Set(this.schemas.map(s => s.schemaId));
    if (activeIds.has(providerId)) {
      if (activeIds.size <= 1) return; // can't disable last
      this.schemas = this.schemas.filter(s => s.schemaId !== providerId);
    } else {
      const entry = this.providerCatalog.find(p => p.id === providerId);
      if (entry) this.schemas.push(schemaFromCatalog(entry));
    }
    await this.storage.saveAll(this.schemas, this.bookmarks);
    await this.storage.saveActiveProviderIds(this.schemas.map(s => s.schemaId));

    // Migrate orphan bookmarks to first available provider
    const activeSchemaIds = new Set(this.schemas.map(s => s.schemaId));
    for (const bm of this.bookmarks) {
      if (!activeSchemaIds.has(bm.schemaId) && this.schemas.length) {
        bm.schemaId = this.schemas[0].schemaId;
      }
    }
    await this.storage.saveAll(this.schemas, this.bookmarks);

    this._renderProviders();
    this._renderStatusBar();
    this._renderItemList();
    if (this.selectedBookmark) this._renderBookmarkDetail(this.selectedBookmark);
  }

  async _probeProviders() {
    const { vidsrc_provider_health: health } = await chrome.storage.local.get({ vidsrc_provider_health: {} });
    const now = Date.now();

    for (const p of this.providerCatalog) {
      const h = health[p.id];
      if (h && (now - h.ts) < 3600000) {
        p._alive = h.alive;
        continue;
      }
      this._probeOne(p, health);
    }
  }

  async _probeOne(provider, health) {
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

    health[provider.id] = { ts: Date.now(), alive: provider._alive };
    await chrome.storage.local.set({ vidsrc_provider_health: health });

    // Refresh provider display if list is open
    if (this.$('#providers-list')?.style.display !== 'none') {
      this._renderProviders();
    }
  }

  /* ═════════════════════════════════════════════════════════════
     GLOBAL SEARCH
     ═════════════════════════════════════════════════════════════ */
  _bindGlobalSearch() {
    const input = this.$('#global-search');
    if (!input) return;
    let timer = null;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        this._renderItemList(input.value.trim().toLowerCase());
      }, 200);
    });
  }

  /* ═════════════════════════════════════════════════════════════
     ITEM LIST RENDERING
     ═════════════════════════════════════════════════════════════ */
  _getFilteredItems(searchQuery) {
    const q = searchQuery || (this.$('#global-search')?.value || '').trim().toLowerCase();

    if (this.activeFilter === 'history') {
      let items = this.history;
      if (q) items = items.filter(h => h.name.toLowerCase().includes(q));
      return { type: 'history', items };
    }

    if (this.activeFilter === 'tracked') {
      let items = [...this.watchlist];
      // Sort: updates first, then by name
      items.sort((a, b) => {
        if (a.hasUpdate && !b.hasUpdate) return -1;
        if (!a.hasUpdate && b.hasUpdate) return 1;
        return a.name.localeCompare(b.name);
      });
      if (q) items = items.filter(w => w.name.toLowerCase().includes(q));
      return { type: 'watchlist', items };
    }

    // Bookmarks filtered by type
    let items = [...this.bookmarks];
    if (this.activeFilter === 'tv') items = items.filter(b => b.type === 'tv');
    else if (this.activeFilter === 'movie') items = items.filter(b => b.type === 'movie');

    if (q) items = items.filter(b => b.name.toLowerCase().includes(q) || b.imdb.toLowerCase().includes(q));

    // For 'all' filter: also include watchlist-only items (not linked to bookmarks)
    if (this.activeFilter === 'all' && !q) {
      const bmImdbs = new Set(this.bookmarks.map(b => b.imdb));
      const bmBmIds = new Set(this.bookmarks.map(b => b.bookmarkId));
      const extraWl = this.watchlist.filter(w =>
        !bmImdbs.has(w.imdb) && !bmBmIds.has(w.bookmarkId)
      );
      return { type: 'bookmarks', items, extraWatchlist: extraWl };
    }

    return { type: 'bookmarks', items };
  }

  _renderItemList(searchQuery) {
    const list = this.$('#item-list');
    if (!list) return;

    const result = this._getFilteredItems(searchQuery);

    if (result.type === 'history') {
      if (!result.items.length) {
        list.innerHTML = `<div class="empty-state"><div class="empty-icon">◷</div><div class="empty-title">No history</div><div class="empty-desc">Watch a show to record it here</div></div>`;
        return;
      }
      list.innerHTML = result.items.map(entry => {
        const thumb = entry.imageUrl ? `<img src="${esc(entry.imageUrl)}" class="sb-thumb" onerror="this.style.display='none'" loading="lazy">` : '';
        const pos = entry.type === 'tv' && entry.season ? `S${String(entry.season).padStart(2,'0')}E${String(entry.episode||1).padStart(2,'0')}` : '';
        const timeAgo = this._formatTimeAgo(entry.watchedAt);
        return `<div class="sb-item" data-hid="${esc(entry.historyId)}" data-type="history">
          ${thumb}
          <div class="sb-info">
            <div class="sb-name">${esc(entry.name)}</div>
            <div class="sb-meta">${pos ? pos + ' · ' : ''}${timeAgo}${entry.status === 'watching' ? ' · <span style="color:#2dd4bf;font-weight:600">watching</span>' : ''}</div>
          </div>
          <button class="ghost-btn" style="font-size:10px;padding:2px 6px" data-hid-del="${esc(entry.historyId)}">✕</button>
        </div>`;
      }).join('');

      list.querySelectorAll('.sb-item[data-hid]').forEach(row => {
        row.addEventListener('click', (e) => {
          if (e.target.closest('button')) return;
          this._selectHistoryItem(row.dataset.hid);
        });
      });
      list.querySelectorAll('[data-hid-del]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this._deleteHistoryEntry(btn.dataset.hidDel);
        });
      });
      return;
    }

    // Watchlist-only items (tracked filter)
    if (result.type === 'watchlist') {
      const items = result.items || [];
      if (!items.length) {
        list.innerHTML = `<div class="empty-state"><div class="empty-icon">◎</div><div class="empty-title">No tracked series</div><div class="empty-desc">Bookmark a TV series to auto-track it, or add one manually</div></div>`;
        return;
      }
      list.innerHTML = items.map(w => this._renderSidebarWatchlistItem(w)).join('');
      list.querySelectorAll('.sb-item[data-wid]').forEach(row => {
        row.addEventListener('click', () => this._selectWatchlistItem(row.dataset.wid));
      });
      return;
    }

    // Bookmarks (all / tv / movie filters)
    const items = result.items || [];
    const extraWl = result.extraWatchlist || [];

    if (!items.length && !extraWl.length) {
      const filterLabels = { all: 'library', tv: 'TV series', movie: 'movies', tracked: 'tracked series' };
      const label = filterLabels[this.activeFilter] || 'items';
      list.innerHTML = `<div class="empty-state"><div class="empty-icon">📚</div><div class="empty-title">No ${label}</div><div class="empty-desc">${this.activeFilter === 'tracked' ? 'Bookmark a TV series to track it' : 'Click + Add to get started'}</div></div>`;
      return;
    }

    let html = '';

    // Section: Bookmarks
    if (items.length) {
      if (extraWl.length && this.activeFilter === 'all') {
        html += '<div style="font-size:10px;font-weight:600;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:0.5px;padding:4px 12px 2px">Library</div>';
      }
      html += items.map(bm => this._renderSidebarItem(bm, 'bookmark')).join('');
    }

    // Section: Watchlist-only (only when 'all' filter + no search query)
    if (extraWl.length) {
      html += '<div style="font-size:10px;font-weight:600;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:0.5px;padding:8px 12px 2px">Tracked</div>';
      html += extraWl.map(w => this._renderSidebarWatchlistItem(w)).join('');
    }

    list.innerHTML = html;

    // Bind clicks
    list.querySelectorAll('.sb-item[data-bid]').forEach(row => {
      row.addEventListener('click', () => this._selectBookmark(row.dataset.bid));
    });
    list.querySelectorAll('.sb-item[data-wid]').forEach(row => {
      row.addEventListener('click', () => this._selectWatchlistItem(row.dataset.wid));
    });
  }

  _renderSidebarItem(bm, source) {
    const pos = bm.positionLabel;
    const thumb = bm.imageUrl ? `<img src="${esc(bm.imageUrl)}" class="sb-thumb" onerror="this.style.display='none'" loading="lazy">` : '<div class="sb-thumb" style="background:var(--bg-elevated);display:flex;align-items:center;justify-content:center;font-size:11px;color:var(--text-tertiary)">?</div>';
    const typeIcon = bm.type === 'movie' ? '🎬' : '';
    const selected = this.selectedBookmark && this.selectedBookmark.bookmarkId === bm.bookmarkId;
    return `<div class="sb-item${selected?' selected':''}" data-bid="${bm.bookmarkId}" data-type="${source}">
      ${thumb}
      <div class="sb-info">
        <div class="sb-name">${esc(bm.name)}</div>
        <div class="sb-meta">${pos ? pos + ' · ' : ''}${typeIcon} ${esc(bm.category||'')}${bm.stars ? ' · ⭐' + bm.stars : ''}</div>
      </div>
    </div>`;
  }

  _renderSidebarWatchlistItem(w) {
    const pos = w.lastKnownSeason ? w.positionLabel : '';
    const thumb = w.imageUrl ? `<img src="${esc(w.imageUrl)}" class="sb-thumb" onerror="this.style.display='none'" loading="lazy">` : '<div class="sb-thumb" style="background:var(--bg-elevated);display:flex;align-items:center;justify-content:center;font-size:11px;color:var(--text-tertiary)">?</div>';
    const selected = this.selectedWatchlistItem && this.selectedWatchlistItem.watchId === w.watchId;
    const updateBadge = w.hasUpdate ? '<span class="sb-badge update">' + w.updateLabel + '</span>' : '';
    const endedBadge = w.showStatus === 'Ended' ? '<span class="sb-badge ended">Ended</span>' : '';
    const cdn = w.countdownLabel;
    return `<div class="sb-item${selected?' selected':''}" data-wid="${w.watchId}" data-type="watchlist">
      ${thumb}
      <div class="sb-info">
        <div class="sb-name">${esc(w.name)}</div>
        <div class="sb-meta">${pos ? pos + ' · ' : ''}${cdn ? '⏱ ' + cdn : w.listeningLabel} ${updateBadge}${endedBadge}</div>
      </div>
    </div>`;
  }

  /* ═════════════════════════════════════════════════════════════
     SELECTION
     ═════════════════════════════════════════════════════════════ */
  _selectBookmark(bookmarkId) {
    const bm = this.bookmarks.find(b => b.bookmarkId === bookmarkId);
    if (!bm) return;
    this.selectedItem = { type: 'bookmark', ref: bm };
    this.selectedBookmark = bm;
    this.selectedWatchlistItem = null;

    this.$$('.sb-item').forEach(el => el.classList.remove('selected'));
    const row = document.querySelector(`.sb-item[data-bid="${bookmarkId}"]`);
    if (row) row.classList.add('selected');

    this._renderMainPanel();
  }

  _selectWatchlistItem(watchId) {
    const w = this.watchlist.find(wl => wl.watchId === watchId);
    if (!w) return;
    this.selectedItem = { type: 'watchlist', ref: w };
    this.selectedWatchlistItem = w;
    this.selectedBookmark = null;

    this.$$('.sb-item').forEach(el => el.classList.remove('selected'));
    const row = document.querySelector(`.sb-item[data-wid="${watchId}"]`);
    if (row) row.classList.add('selected');

    this._renderMainPanel();
  }

  _selectHistoryItem(historyId) {
    const entry = this.history.find(h => h.historyId === historyId);
    if (!entry) return;

    // Try to find the matching bookmark
    const bm = this.bookmarks.find(b => b.imdb === entry.imdb);
    if (bm) {
      this._selectBookmark(bm.bookmarkId);
    }
  }

  /* ═════════════════════════════════════════════════════════════
     MAIN PANEL (Dashboard vs Detail)
     ═════════════════════════════════════════════════════════════ */
  _renderMainPanel() {
    if (this.selectedBookmark) {
      this._renderDetailView(this.selectedBookmark, 'bookmark');
    } else if (this.selectedWatchlistItem) {
      this._renderDetailView(this.selectedWatchlistItem, 'watchlist');
    } else {
      this._renderDashboard();
    }
  }

  /* ═════════════════════════════════════════════════════════════
     DASHBOARD
     ═════════════════════════════════════════════════════════════ */
  _renderDashboard() {
    this.$('#detail-view').style.display = 'none';
    this.$('#dashboard-view').style.display = '';

    const tvCount = this.bookmarks.filter(b => b.type === 'tv').length;
    const movieCount = this.bookmarks.filter(b => b.type === 'movie').length;
    const trackedCount = this.watchlist.length;

    this.$('#stat-tv').textContent = tvCount;
    this.$('#stat-movies').textContent = movieCount;
    this.$('#stat-tracked').textContent = trackedCount;

    // Upcoming episodes
    const upcoming = this.watchlist
      .filter(w => w.nextEpisodeAirdate && w.showStatus !== 'Ended')
      .sort((a, b) => (a.nextEpisodeAirdate || '').localeCompare(b.nextEpisodeAirdate || ''))
      .slice(0, 5);

    const upcomingList = this.$('#upcoming-list');
    if (upcoming.length) {
      upcomingList.innerHTML = upcoming.map(w => {
        const cdn = w.countdownLabel;
        const thumb = w.imageUrl ? `<img src="${esc(w.imageUrl)}" class="ui-thumb" onerror="this.style.display='none'" loading="lazy">` : '';
        return `<div class="upcoming-item" data-wid="${w.watchId}">
          ${thumb}
          <div class="ui-text">
            <div class="ui-name">${esc(w.name)}</div>
            <div class="ui-sub">${w.nextEpisodeInfo || ''} · ${w.nextEpisodeAirdate || ''}</div>
          </div>
          ${cdn ? `<span class="ui-countdown">${esc(cdn)}</span>` : ''}
        </div>`;
      }).join('');

      upcomingList.querySelectorAll('.upcoming-item').forEach(row => {
        row.addEventListener('click', () => this._selectWatchlistItem(row.dataset.wid));
      });
    } else {
      upcomingList.innerHTML = '<div class="empty-hint">No upcoming episodes</div>';
    }

    // Recently watched
    const recent = this.history.slice(0, 5);
    const recentList = this.$('#recent-list');
    if (recent.length) {
      recentList.innerHTML = recent.map(entry => {
        const thumb = entry.imageUrl ? `<img src="${esc(entry.imageUrl)}" class="ui-thumb" onerror="this.style.display='none'" loading="lazy">` : '';
        const pos = entry.type === 'tv' && entry.season ? `S${String(entry.season).padStart(2,'0')}E${String(entry.episode||1).padStart(2,'0')}` : '';
        const timeAgo = this._formatTimeAgo(entry.watchedAt);
        return `<div class="recent-item" data-hid="${esc(entry.historyId)}">
          ${thumb}
          <div class="ui-text">
            <div class="ui-name">${esc(entry.name)}</div>
            <div class="ui-sub">${pos ? pos + ' · ' : ''}${timeAgo}</div>
          </div>
        </div>`;
      }).join('');

      recentList.querySelectorAll('.recent-item').forEach(row => {
        row.addEventListener('click', () => this._selectHistoryItem(row.dataset.hid));
      });
    } else {
      recentList.innerHTML = '<div class="empty-hint">Nothing watched yet</div>';
    }

    // Updates
    const updates = this.watchlist.filter(w => w.hasUpdate);
    const updatesCard = this.$('#dash-updates-card');
    const updatesList = this.$('#updates-list');
    if (updates.length) {
      updatesCard.style.display = '';
      updatesList.innerHTML = updates.map(w => {
        return `<div class="upcoming-item" data-wid="${w.watchId}" style="cursor:pointer">
          <span class="sb-type-icon">◎</span>
          <div class="ui-text">
            <div class="ui-name">${esc(w.name)}</div>
            <div class="ui-sub">${w.updateLabel || 'Update'}</div>
          </div>
          <span class="ui-badge">NEW</span>
        </div>`;
      }).join('');
      updatesList.querySelectorAll('.upcoming-item').forEach(row => {
        row.addEventListener('click', () => this._selectWatchlistItem(row.dataset.wid));
      });
    } else {
      updatesCard.style.display = 'none';
    }
  }

  /* ═════════════════════════════════════════════════════════════
     DETAIL VIEW
     ═════════════════════════════════════════════════════════════ */
  async _renderDetailView(item, source) {
    this.$('#dashboard-view').style.display = 'none';
    this.$('#detail-view').style.display = '';

    if (source === 'bookmark') {
      await this._renderBookmarkDetail(item);
    } else if (source === 'watchlist') {
      await this._renderWatchlistDetail(item);
    }
  }

  async _renderBookmarkDetail(bm) {
    // Header
    this.$('#detail-thumb').src = bm.imageUrl || '';
    this.$('#detail-thumb').style.display = bm.imageUrl ? '' : 'none';
    this.$('#detail-title').textContent = bm.name;
    const metaParts = [];
    if (bm.type === 'tv' && bm.lastSeason) metaParts.push(`S${String(bm.lastSeason).padStart(2,'0')}E${String(bm.lastEpisode).padStart(2,'0')}`);
    if (bm.stars) metaParts.push(`⭐ ${bm.stars}`);
    if (bm.category) metaParts.push(bm.category);
    if (bm.type === 'movie') metaParts.push('🎬 Movie');
    else metaParts.push('📺 TV Series');
    this.$('#detail-meta').textContent = metaParts.join(' · ');

    // Provider select
    this._renderProviderSelect(bm.schemaId);

    // Play button
    const playBtn = this.$('#detail-play-btn');
    const newPlayBtn = playBtn.cloneNode(true);
    playBtn.parentNode.replaceChild(newPlayBtn, playBtn);
    newPlayBtn.addEventListener('click', () => this._playBookmark(bm));

    // TV vs Movie
    if (bm.type === 'tv') {
      this.$('#episode-browser').style.display = '';
      this.$('#movie-info').style.display = 'none';

      // Fetch/load episodes
      await this._loadEpisodesForBookmark(bm);

      // Edit position
      const editBtn = this.$('#detail-edit-pos');
      const newEditBtn = editBtn.cloneNode(true);
      editBtn.parentNode.replaceChild(newEditBtn, editBtn);
      newEditBtn.addEventListener('click', () => this._openEditModal(bm));

      // Delete
      const delBtn = this.$('#detail-delete');
      const newDelBtn = delBtn.cloneNode(true);
      delBtn.parentNode.replaceChild(newDelBtn, delBtn);
      newDelBtn.addEventListener('click', () => this._deleteBookmark(bm.bookmarkId));

    } else {
      this.$('#episode-browser').style.display = 'none';
      this.$('#movie-info').style.display = '';

      const poster = this.$('#movie-poster');
      poster.src = bm.imageUrl || '';
      poster.style.display = bm.imageUrl ? '' : 'none';

      // Delete movie
      const delBtn = this.$('#detail-delete-movie');
      const newDelBtn = delBtn.cloneNode(true);
      delBtn.parentNode.replaceChild(newDelBtn, delBtn);
      newDelBtn.addEventListener('click', () => this._deleteBookmark(bm.bookmarkId));
    }

    // Bind provider change
    this._bindProviderChange(bm);
  }

  async _renderWatchlistDetail(w) {
    // Header
    this.$('#detail-thumb').src = w.imageUrl || '';
    this.$('#detail-thumb').style.display = w.imageUrl ? '' : 'none';
    this.$('#detail-title').textContent = w.name;
    const metaParts = [];
    if (w.lastKnownSeason) metaParts.push(`S${String(w.lastKnownSeason).padStart(2,'0')}E${String(w.lastKnownEpisode).padStart(2,'0')}`);
    metaParts.push(w.showStatus);
    if (w.nextEpisodeAirdate) metaParts.push(`Next: ${w.nextEpisodeAirdate}`);
    this.$('#detail-meta').textContent = metaParts.join(' · ');

    // Provider select (use linked bookmark's schema if available)
    let schemaId = null;
    if (w.bookmarkId) {
      const bm = this.bookmarks.find(b => b.bookmarkId === w.bookmarkId);
      if (bm) schemaId = bm.schemaId;
    }
    if (!schemaId && this.schemas.length) schemaId = this.schemas[0].schemaId;
    this._renderProviderSelect(schemaId);

    // Play button
    const playBtn = this.$('#detail-play-btn');
    const newPlayBtn = playBtn.cloneNode(true);
    playBtn.parentNode.replaceChild(newPlayBtn, playBtn);

    if (w.imdb || (w.bookmarkId && this.bookmarks.find(b => b.bookmarkId === w.bookmarkId))) {
      newPlayBtn.addEventListener('click', () => {
        if (w.bookmarkId) {
          const bm = this.bookmarks.find(b => b.bookmarkId === w.bookmarkId);
          if (bm) { this._playBookmark(bm); return; }
        }
        if (w.imdb && w.lastKnownSeason) {
          const schema = this.schemas.length ? this.schemas[0] : null;
          if (schema) {
            const url = schema.buildUrl({
              imdb: w.imdb, tmdbId: null, type: 'tv',
              lastSeason: w.lastKnownSeason, lastEpisode: w.lastKnownEpisode,
            });
            if (url) window.wtAPI.openEmbed(url);
          }
        }
      });
    } else {
      newPlayBtn.style.opacity = '0.4';
    }

    // Episode browser
    this.$('#episode-browser').style.display = '';
    this.$('#movie-info').style.display = 'none';

    // Load episodes
    await this._loadEpisodesForWatchlist(w);

    // Delete (remove from watchlist)
    const delBtn = this.$('#detail-delete');
    const newDelBtn = delBtn.cloneNode(true);
    delBtn.parentNode.replaceChild(newDelBtn, delBtn);
    newDelBtn.textContent = 'Stop Tracking';
    newDelBtn.addEventListener('click', () => this._wlRemove(w.watchId));

    // Hide edit position for watchlist-only items
    this.$('#detail-edit-pos').style.display = w.bookmarkId ? '' : 'none';

    // Bind provider change if there's a linked bookmark
    if (w.bookmarkId) {
      const bm = this.bookmarks.find(b => b.bookmarkId === w.bookmarkId);
      if (bm) this._bindProviderChange(bm);
    }
  }

  _renderProviderSelect(currentSchemaId) {
    const sel = this.$('#detail-provider');
    sel.innerHTML = this.schemas.map(s =>
      `<option value="${s.schemaId}"${s.schemaId === currentSchemaId ? ' selected' : ''}>${esc(s.name)}</option>`
    ).join('');
  }

  _bindProviderChange(bm) {
    const sel = this.$('#detail-provider');
    const newSel = sel.cloneNode(true);
    sel.parentNode.replaceChild(newSel, sel);
    newSel.addEventListener('change', async () => {
      bm.schemaId = newSel.value;
      await this.storage.saveAll(this.schemas, this.bookmarks);
      this._renderItemList();
    });
  }

  /* ═════════════════════════════════════════════════════════════
     EPISODE LOADING
     ═════════════════════════════════════════════════════════════ */
  async _loadEpisodesForBookmark(bm) {
    const container = this.$('#episode-browser');
    container.innerHTML = '<div class="empty-hint">Loading episodes…</div>';

    let episodes, showInfo;

    // Check cache
    const cached = this.availCache[bm.bookmarkId];
    if (cached && cached.data && cached.data.episodes) {
      episodes = cached.data.episodes;
      showInfo = { name: bm.name };
      if (cached.data.showId) {
        const wlCached = this.wlEpisodeCache.get(cached.data.showId);
        if (wlCached?.showInfo) showInfo = wlCached.showInfo;
      }
    } else {
      // Fetch fresh
      const data = await checkAvailability(bm);
      episodes = (data.episodes || []).map(ep => ({
        season: ep.season, episode: ep.episode, name: ep.name || '', airdate: ep.airdate || null,
      }));
      showInfo = { name: data.showName || bm.name, showId: data.showId };

      await this.storage.saveAvailability(bm.bookmarkId, { ...data, episodes });
      this.availCache[bm.bookmarkId] = { ts: Date.now(), data: { ...data, episodes } };

      // Fetch show info for countdown
      if (data.showId) {
        try {
          const si = await wlFetchShowInfo(data.showId);
          if (si) {
            showInfo = si;
            this.wlEpisodeCache.set(data.showId, { ts: Date.now(), episodes, showInfo: si });
          }
        } catch (_) {}
      }
    }

    // Look up watchlist for merged data
    const wlItem = this.watchlist.find(w =>
      (w.imdb && w.imdb === bm.imdb) || (w.bookmarkId === bm.bookmarkId)
    );

    if (wlItem && wlItem.nextEpisodeAirdate) {
      if (!showInfo) showInfo = { name: bm.name };
      showInfo.nextEpisode = {
        season: wlItem.lastKnownSeason,
        episode: wlItem.lastKnownEpisode + 1,
        name: wlItem.nextEpisodeInfo || '',
        airdate: wlItem.nextEpisodeAirdate,
      };
    }

    const schema = this.schemas.find(s => s.schemaId === bm.schemaId);
    this._renderEpisodeGrid(container, {
      episodes, showInfo, imdb: bm.imdb, schema: schema || null,
      countdownId: `detail-${bm.bookmarkId}`,
    });
  }

  async _loadEpisodesForWatchlist(w) {
    const container = this.$('#episode-browser');
    container.innerHTML = '<div class="empty-hint">Loading episodes…</div>';

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
        container.innerHTML = '<div class="empty-hint">Failed to load episodes</div>';
        return;
      }
    }

    if (showInfo && w.nextEpisodeAirdate) {
      showInfo.nextEpisode = {
        season: w.lastKnownSeason,
        episode: w.lastKnownEpisode + 1,
        name: w.nextEpisodeInfo || '',
        airdate: w.nextEpisodeAirdate,
      };
    }

    const schema = this.schemas.length ? this.schemas[0] : null;
    const imdb = showInfo?.imdb || w.imdb || null;

    this._renderEpisodeGrid(container, {
      episodes, showInfo: showInfo || { name: w.name }, imdb, schema,
      countdownId: `detail-wl-${w.watchId}`,
    });
  }

  /* ═════════════════════════════════════════════════════════════
     EPISODE GRID RENDERER
     ═════════════════════════════════════════════════════════════ */
  _renderEpisodeGrid(container, opts) {
    const { episodes, showInfo, imdb, schema, countdownId } = opts;
    if (!episodes || !episodes.length) {
      container.innerHTML = '<div class="empty-hint">No episodes found</div>';
      return;
    }

    const today = new Date().toISOString().slice(0, 10);
    const { watched, watching } = this._watchedEpisodeSet();

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

    const isBefore = (ep, ref) => ep.season < ref.season || (ep.season === ref.season && ep.episode < ref.episode);
    const isSame = (ep, ref) => ep.season === ref.season && ep.episode === ref.episode;

    const buildUrl = (season, episode) => {
      if (!imdb || !schema) return '#';
      return schema.buildUrl({
        imdb, tmdbId: null, type: 'tv',
        lastSeason: season, lastEpisode: episode,
      }) || '#';
    };

    let html = '';

    // Countdown
    if (nextEp) {
      html += `<div class="ep-countdown" id="countdown-box-${countdownId}">
        <div class="cd-label">S${String(nextEp.season).padStart(2,'0')}E${String(nextEp.episode).padStart(2,'0')} · ${esc(nextEp.name || 'TBA')}</div>
        <div class="cd-airdate">${nextEp.airdate || 'TBA'}</div>
        <div class="cd-timer" id="cd-timer-${countdownId}">--</div>
      </div>`;
    }

    // Header
    html += '<div class="ep-header">';
    html += `<span class="ep-show-name" id="ep-show-name">${esc(showInfo?.name || '')}</span>`;
    html += `<span class="ep-count" id="ep-count">${episodes.length} episodes</span>`;
    html += '</div>';

    // Group by season
    const bySeason = new Map();
    for (const ep of episodes) {
      if (!bySeason.has(ep.season)) bySeason.set(ep.season, []);
      bySeason.get(ep.season).push(ep);
    }

    html += '<div class="ep-grid">';
    for (const [season, eps] of [...bySeason.entries()].sort((a, b) => a - b)) {
      const sorted = eps.sort((a, b) => a.episode - b.episode);
      html += `<div><div class="ep-season-label">Season ${season}</div><div class="ep-season-eps">`;

      for (const ep of sorted) {
        let isAired, isNext, isFuture;
        if (nextEp) {
          isNext = isSame(ep, nextEp);
          isAired = !isNext && isBefore(ep, nextEp);
          isFuture = !isAired && !isNext;
        } else {
          isAired = !ep.airdate || ep.airdate <= today;
          isFuture = !!ep.airdate && ep.airdate > today;
          isNext = false;
        }

        let epClass = 'ep-btn ';
        if (isAired) epClass += 'ep-aired';
        else if (isNext) epClass += 'ep-next';
        else epClass += 'ep-future';

        const key = imdb ? `${imdb}|${season}|${ep.episode}` : '';
        if (key && watching.has(key)) epClass += ' ep-watching';
        else if (key && watched.has(key)) epClass += ' ep-watched';

        const statusLabel = key && watching.has(key) ? ' · WATCHING'
          : (key && watched.has(key) ? ' · WATCHED' : '');
        const title = `S${String(season).padStart(2,'0')}E${String(ep.episode).padStart(2,'0')} · ${esc(ep.name || '')}${ep.airdate ? ' · ' + ep.airdate : ''}${statusLabel}`;

        if (isAired) {
          const epUrl = buildUrl(season, ep.episode);
          html += `<a class="${epClass}" href="${esc(epUrl)}" target="_blank" title="${title}" data-ep-url="${esc(epUrl)}">${ep.episode}</a>`;
        } else {
          html += `<span class="${epClass}" title="${title}">${ep.episode}</span>`;
        }
      }
      html += '</div></div>';
    }
    html += '</div>';

    container.innerHTML = html;

    // Intercept episode clicks to open in embed window
    container.querySelectorAll('a.ep-aired').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const url = link.dataset.epUrl || link.getAttribute('href');
        if (url && url !== '#' && window.wtAPI) window.wtAPI.openEmbed(url);
      });
    });

    // Start countdown
    if (nextEp) this._startEpCountdown(countdownId, nextEp.airdate);
  }

  _startEpCountdown(countdownId, airdate) {
    this._stopEpCountdown(countdownId);
    const timerEl = document.getElementById(`cd-timer-${countdownId}`);
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

  _watchedEpisodeSet() {
    const watched = new Set();
    const watching = new Set();
    for (const h of this.history) {
      if (h.type !== 'tv' || !h.season || !h.episode) continue;
      const key = `${h.imdb}|${h.season}|${h.episode}`;
      if (h.status === 'watching') watching.add(key);
      else watched.add(key);
    }
    return { watched, watching };
  }

  /* ═════════════════════════════════════════════════════════════
     PLAY
     ═════════════════════════════════════════════════════════════ */
  _playBookmark(bm) {
    const schema = this.schemas.find(s => s.schemaId === bm.schemaId);
    if (!schema) return;
    const url = schema.buildUrl(bm);
    if (url) window.wtAPI.openEmbed(url);
  }

  /* ═════════════════════════════════════════════════════════════
     DELETE
     ═════════════════════════════════════════════════════════════ */
  async _deleteBookmark(bookmarkId) {
    this.bookmarks = this.bookmarks.filter(b => b.bookmarkId !== bookmarkId);
    await this.storage.saveAll(this.schemas, this.bookmarks);
    delete this.availCache[bookmarkId];
    await this.storage.clearAvailability(bookmarkId);

    if (this.selectedBookmark && this.selectedBookmark.bookmarkId === bookmarkId) {
      this.selectedBookmark = null;
      this.selectedItem = null;
    }

    this._refreshAll();
  }

  async _deleteHistoryEntry(historyId) {
    this.history = this.history.filter(h => h.historyId !== historyId);
    const { vidsrc_history: stored } = await chrome.storage.local.get({ vidsrc_history: [] });
    const updated = (stored || []).filter(h => h.historyId !== historyId);
    await chrome.storage.local.set({ vidsrc_history: updated });
    this._renderItemList();
  }

  /* ═════════════════════════════════════════════════════════════
     WATCHLIST OPERATIONS
     ═════════════════════════════════════════════════════════════ */
  async _syncWatchlist() {
    if (this.wlChecking) return;
    if (!this.watchlist.length) { this._updateWlStatus(''); return; }
    this.wlChecking = true;

    try {
      const now = Date.now();
      const needsCheck = (now - this.wlLastCheck) >= WL_COOLDOWN_MS;
      if (needsCheck) {
        this._updateWlStatus('Checking…');
        const count = await wlRunBatchCheck(this.watchlist);
        this.wlLastCheck = now;
        await this.storage.saveWatchlist(this.watchlist, this.wlLastCheck);
        this._updateWlStatus(count > 0 ? `Updated ${count} series` : 'Up to date');
      } else {
        const mins = Math.floor((WL_COOLDOWN_MS - (now - this.wlLastCheck)) / 60000);
        this._updateWlStatus(mins > 0 ? `Next check in ~${mins}m` : 'Up to date');
      }
    } finally {
      this.wlChecking = false;
      this._renderItemList();
    }
  }

  async _wlCheckAll() {
    if (this.wlChecking || !this.watchlist.length) return;
    this.wlChecking = true;
    const hdrBtn = this.$('#hdr-check-all');
    hdrBtn.classList.add('spinning');
    this._updateWlStatus(`Checking ${this.watchlist.length} series…`);

    try {
      const count = await wlRunBatchCheck(this.watchlist, this.watchlist.length, true);
      this.wlLastCheck = Date.now();
      await this.storage.saveWatchlist(this.watchlist, this.wlLastCheck);

      const withUpdates = this.watchlist.filter(w => w.hasUpdate).length;
      this._updateWlStatus(`Checked ${count} · ${withUpdates} ${withUpdates === 1 ? 'update' : 'updates'}`);
    } catch (_) {
      this._updateWlStatus('Check failed');
    } finally {
      hdrBtn.classList.remove('spinning');
      this.wlChecking = false;
      this._refreshAll();
    }
  }

  _updateWlStatus(text) {
    const el = this.$('#status-wl-check');
    if (el) el.textContent = 'Watchlist: ' + (text || '--');
  }

  async _wlRemove(watchId) {
    const item = this.watchlist.find(w => w.watchId === watchId);
    if (item) {
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

    if (this.selectedWatchlistItem && this.selectedWatchlistItem.watchId === watchId) {
      this.selectedWatchlistItem = null;
      this.selectedItem = null;
    }
    this._refreshAll();
  }

  async _wlDismissUpdate(watchId) {
    const item = this.watchlist.find(w => w.watchId === watchId);
    if (!item) return;
    item.hasUpdate = false;
    item.updateType = null;
    await this.storage.saveWatchlist(this.watchlist, this.wlLastCheck);
    this._renderItemList();
    if (this.selectedWatchlistItem?.watchId === watchId) this._renderWatchlistDetail(item);
  }

  /* ═════════════════════════════════════════════════════════════
     MODAL: ADD TO LIBRARY
     ═════════════════════════════════════════════════════════════ */
  _bindModal() {
    this.$('#modal-close')?.addEventListener('click', () => this._closeAddModal());
    this.$('#add-cancel-btn')?.addEventListener('click', () => this._closeAddModal());
    this.$('#add-back-btn')?.addEventListener('click', () => this._addBackToSearch());
    this.$('#add-confirm-btn')?.addEventListener('click', () => this._addConfirm());

    // Tab switcher: Bookmark vs Track Series
    this.$$('.modal-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        this._addMode = tab.dataset.addMode;
        this.$$('.modal-tab').forEach(t => t.classList.toggle('active', t === tab));
        this._resetAddForm();
        const input = this.$('#add-search');
        if (input) {
          input.placeholder = this._addMode === 'track'
            ? 'Search TVmaze (e.g. Severance)…'
            : 'Search IMDB (e.g. Breaking Bad)…';
          input.focus();
        }
      });
    });

    const searchInput = this.$('#add-search');
    if (searchInput) {
      let timer = null;
      searchInput.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => this._addDoSearch(), 400);
      });
    }

    // Close on overlay click
    this.$('#add-modal')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) this._closeAddModal();
    });
  }

  _openAddModal() {
    this._addMode = 'bookmark';
    this.$$('.modal-tab').forEach(t => t.classList.toggle('active', t.dataset.addMode === 'bookmark'));
    this._resetAddForm();
    this.$('#add-modal').style.display = '';
    const input = this.$('#add-search');
    if (input) {
      input.placeholder = 'Search IMDB (e.g. Breaking Bad)…';
      input.focus();
    }
  }

  _closeAddModal() {
    this.$('#add-modal').style.display = 'none';
    this._resetAddForm();
  }

  _resetAddForm() {
    this.$('#add-step-search').style.display = '';
    this.$('#add-step-season').style.display = 'none';
    if (this.$('#add-search')) this.$('#add-search').value = '';
    if (this.$('#add-search-status')) this.$('#add-search-status').textContent = '';
    if (this.$('#add-search-results')) this.$('#add-search-results').innerHTML = '';
    if (this.$('#add-season')) this.$('#add-season').value = '1';
    if (this.$('#add-episode')) this.$('#add-episode').value = '1';
    this._bmPending = null;
    if (this._bmAbort) { this._bmAbort.abort(); this._bmAbort = null; }
  }

  _addDoSearch() {
    const q = this.$('#add-search').value.trim();
    if (!q) {
      this.$('#add-search-results').innerHTML = '';
      this.$('#add-search-status').textContent = '';
      return;
    }

    if (this._bmAbort) this._bmAbort.abort();
    this._bmAbort = new AbortController();

    // TVmaze search (track mode)
    if (this._addMode === 'track') {
      this.$('#add-search-status').textContent = 'Searching TVmaze…';
      this.$('#add-search-results').innerHTML = '';
      wlSearchShows(q).then(results => {
        if (this._bmAbort.signal.aborted) return;
        if (!results.length) { this.$('#add-search-status').textContent = 'No results.'; return; }
        this.$('#add-search-status').textContent = '';
        this._addRenderTrackResults(results);
      }).catch(err => {
        if (err.name !== 'AbortError') this.$('#add-search-status').textContent = 'Search failed.';
      });
      return;
    }

    // IMDB search (bookmark mode)
    const cached = this._searchCache.get(q.toLowerCase());
    if (cached && Date.now() - cached.ts < 300000) {
      this.$('#add-search-status').textContent = '';
      this._addRenderResults(cached.items);
      return;
    }

    this.$('#add-search-status').textContent = 'Searching…';
    this.$('#add-search-results').innerHTML = '';

    fetch('https://v3.sg.media-imdb.com/suggestion/x/' + encodeURIComponent(q) + '.json', { signal: this._bmAbort.signal })
      .then(r => r.ok ? r.json() : Promise.reject(r))
      .then(data => {
        const items = (data.d || []).slice(0, 8);
        this._searchCache.set(q.toLowerCase(), { ts: Date.now(), items });
        if (!items.length) { this.$('#add-search-status').textContent = 'No results.'; return; }
        this.$('#add-search-status').textContent = '';
        this._addRenderResults(items);
      })
      .catch(err => { if (err.name !== 'AbortError') this.$('#add-search-status').textContent = 'Search failed.'; });
  }

  _addRenderTrackResults(results) {
    const container = this.$('#add-search-results');
    container.innerHTML = results.map(s => {
      const imageUrl = s.imageUrl || '';
      const typeBadge = s.type === 'Animation' ? ' 🎨' : s.type === 'Documentary' ? ' 📄' : '';
      const statusBadge = s.status === 'Ended' ? ' (ended)' : s.status === 'Running' ? '' : '';
      return `<div class="search-result-item" style="cursor:pointer" data-showid="${s.showId}" data-name="${esc(s.name)}" data-image="${esc(imageUrl)}">
        ${imageUrl ? `<img src="${esc(imageUrl)}" class="sr-thumb" onerror="this.style.display='none'" loading="lazy">` : ''}
        <div class="sr-info">
          <div class="sr-title">📺 ${esc(s.name)}${typeBadge}${statusBadge ? ' · ' + statusBadge : ''}</div>
          ${s.premiered ? '<div class="sr-meta">Since ' + esc(s.premiered) + '</div>' : ''}
        </div>
      </div>`;
    }).join('');

    container.querySelectorAll('.search-result-item').forEach(row => {
      row.addEventListener('click', () => this._addTrackSeries(row.dataset.showid, row.dataset.name, row.dataset.image || null));
    });
  }

  async _addTrackSeries(showId, name, imageUrl) {
    const sid = parseInt(showId, 10);
    if (this.watchlist.some(w => w.showId === sid)) {
      this._closeAddModal();
      return;
    }

    const item = new WatchlistItem({
      watchId: makeBookmarkId(), name, showId: sid,
      source: 'custom', imageUrl: imageUrl || null,
    });

    try {
      await wlCheckItem(item);
      item.hasUpdate = false;
      item.updateType = null;
    } catch (_) { /* baseline will be set on next cycle */ }

    this.watchlist.push(item);
    await this.storage.saveWatchlist(this.watchlist, this.wlLastCheck);
    this._closeAddModal();
    this.selectedWatchlistItem = item;
    this.selectedItem = { type: 'watchlist', ref: item };
    this.selectedBookmark = null;
    this._refreshAll();
  }

  _addRenderResults(items) {
    const container = this.$('#add-search-results');
    container.innerHTML = items.map(it => {
      const type = imdbType(it.qid);
      const badge = type === 'movie' ? '🎬' : '📺';
      const title = esc(it.l || 'Unknown');
      const imageUrl = it.i?.imageUrl || null;
      const stars = esc(it.s || '');
      const cat = esc(it.q || '');
      return `<div class="search-result-item" data-imdb="${esc(it.id)}" data-title="${title}" data-type="${type}" data-image="${imageUrl ? esc(imageUrl) : ''}" data-stars="${stars}" data-cat="${cat}">
        ${imageUrl ? `<img src="${esc(imageUrl)}" class="sr-thumb" onerror="this.style.display='none'" loading="lazy">` : ''}
        <div class="sr-info">
          <div class="sr-title">${badge} ${title} ${it.y?'('+it.y+')':''}</div>
          ${stars ? '<div class="sr-meta">' + stars + (cat ? ' · ' + cat : '') + '</div>' : ''}
        </div>
      </div>`;
    }).join('');

    container.querySelectorAll('.search-result-item').forEach(row => {
      row.addEventListener('click', () => {
        this._addPick(row.dataset.imdb, row.dataset.title, row.dataset.type, row.dataset.image || null, row.dataset.stars || '', row.dataset.cat || '');
      });
    });
  }

  _addPick(imdb, title, type, imageUrl, stars, cat) {
    this._bmPending = { imdb, title, type, imageUrl, stars, cat };
    if (type === 'movie') {
      this._addCreate(null, null);
    } else {
      this.$('#add-step-search').style.display = 'none';
      this.$('#add-step-season').style.display = '';
      this.$('#add-pick-hint').innerHTML = `<span style="color:#4caf84">📺</span> <b>${esc(title)}</b> · ${esc(imdb)}`;
    }
  }

  _addBackToSearch() {
    this.$('#add-step-search').style.display = '';
    this.$('#add-step-season').style.display = 'none';
  }

  async _addConfirm() {
    const season = parseInt(this.$('#add-season').value, 10) || 1;
    const episode = parseInt(this.$('#add-episode').value, 10) || 1;
    this._addCreate(season, episode);
  }

  async _addCreate(season, episode) {
    const { imdb, title, type, imageUrl, stars, cat } = this._bmPending;
    const schemaId = this.schemas.length ? this.schemas[0].schemaId : null;
    if (!schemaId) return;

    let tmdbId = null;
    if (type === 'tv') {
      tmdbId = await fetchTmdbId(imdb);
    }

    const bm = new Bookmark({
      bookmarkId: makeBookmarkId(), name: title, imdb, schemaId, type,
      lastSeason: type === 'tv' ? (season || 1) : null,
      lastEpisode: type === 'tv' ? (episode || 1) : null,
      imageUrl: imageUrl || null,
      stars: stars || null,
      category: cat || null,
      tmdbId,
    });
    this.bookmarks.push(bm);
    await this.storage.saveAll(this.schemas, this.bookmarks);

    // Seed history for TV shows
    if (type === 'tv' && season && episode) {
      const { vidsrc_history: stored } = await chrome.storage.local.get({ vidsrc_history: [] });
      const history = stored || [];
      const now = Date.now();
      const curS = season;
      const curE = episode;

      const exists = history.some(e =>
        e.imdb === imdb && e.type === 'tv' && e.season === curS && e.episode === curE
      );

      if (!exists) {
        history.unshift({
          historyId: now.toString(36) + Math.random().toString(36).slice(2, 6),
          imdb, name: title, type: 'tv', imageUrl: imageUrl || null,
          season: curS, episode: curE, watchedAt: now, status: 'watching',
        });

        const curKey = curS * 10000 + curE;
        for (const e of history) {
          if (e.imdb === imdb && e.type === 'tv' && e.season && e.episode) {
            const key = e.season * 10000 + e.episode;
            if (key < curKey && e.status === 'watching') e.status = 'watched';
          }
        }

        if (history.length > 2000) history.length = 2000;
        await chrome.storage.local.set({ vidsrc_history: history });
        this.history = history;
      }
    }

    this._closeAddModal();
    this.selectedBookmark = bm;
    this.selectedItem = { type: 'bookmark', ref: bm };
    this.selectedWatchlistItem = null;
    this._refreshAll();
  }

  /* ═════════════════════════════════════════════════════════════
     EDIT POSITION MODAL
     ═════════════════════════════════════════════════════════════ */
  _bindEditModal() {
    this.$('#edit-modal-close')?.addEventListener('click', () => this._closeEditModal());
    this.$('#edit-cancel-btn')?.addEventListener('click', () => this._closeEditModal());
    this.$('#edit-save-btn')?.addEventListener('click', () => this._saveEditPosition());

    this.$('#edit-modal')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) this._closeEditModal();
    });
  }

  _openEditModal(bm) {
    this._editingBookmark = bm;
    this.$('#edit-hint').textContent = bm.name;
    this.$('#edit-season').value = bm.lastSeason || 1;
    this.$('#edit-episode').value = bm.lastEpisode || 1;
    this.$('#edit-modal').style.display = '';
    this.$('#edit-season').focus();
  }

  _closeEditModal() {
    this.$('#edit-modal').style.display = 'none';
    this._editingBookmark = null;
  }

  async _saveEditPosition() {
    const bm = this._editingBookmark;
    if (!bm) return;
    const ns = parseInt(this.$('#edit-season').value, 10) || 1;
    const ne = parseInt(this.$('#edit-episode').value, 10) || 1;
    bm.lastSeason = ns;
    bm.lastEpisode = ne;
    await this.storage.saveAll(this.schemas, this.bookmarks);
    this._closeEditModal();
    this._refreshAll();
  }

  /* ═════════════════════════════════════════════════════════════
     EXPORT / IMPORT
     ═════════════════════════════════════════════════════════════ */
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

  /* ═════════════════════════════════════════════════════════════
     STATUS BAR
     ═════════════════════════════════════════════════════════════ */
  _renderStatusBar() {
    const providerCount = this.schemas.length;
    const activeCount = this.providerCatalog.filter(p => {
      return this.schemas.some(s => s.schemaId === p.id);
    }).length;

    this.$('#status-providers').textContent = `${activeCount} active · ${this.providerCatalog.length} available`;
    this.$('#status-wl-check').textContent = 'Watchlist: ' + (this.watchlist.length ? `${this.watchlist.length} series` : '--');
  }

  /* ═════════════════════════════════════════════════════════════
     IPC LISTENERS
     ═════════════════════════════════════════════════════════════ */
  _setupIPCListeners() {
    if (!window.wtAPI) return;

    window.wtAPI.onMenuAction((action) => {
      if (action === 'new-bookmark') this._openAddModal();
      else if (action === 'new-watchlist') {
        this._setFilter('tracked');
        this._openAddModal();
      }
    });

    window.wtAPI.onNavigateTab((tab) => {
      const filterMap = {
        schemas: 'all',
        bookmarks: 'all',
        watchlist: 'tracked',
        history: 'history',
      };
      const filter = filterMap[tab] || 'all';
      this._setFilter(filter);
    });

    window.wtAPI.onDataImported?.(async () => {
      await this._loadAndRender();
    });
  }

  /* ═════════════════════════════════════════════════════════════
     KEYBOARD SHORTCUTS
     ═════════════════════════════════════════════════════════════ */
  _bindKeyboard() {
    document.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;

      // Ctrl+F: focus search
      if (mod && e.key === 'f') {
        e.preventDefault();
        this.$('#global-search')?.focus();
      }

      // Escape: close modals or deselect
      if (e.key === 'Escape') {
        if (this.$('#add-modal').style.display !== 'none') {
          this._closeAddModal();
          return;
        }
        if (this.$('#edit-modal').style.display !== 'none') {
          this._closeEditModal();
          return;
        }
        // Deselect
        this.selectedItem = null;
        this.selectedBookmark = null;
        this.selectedWatchlistItem = null;
        this.$$('.sb-item').forEach(el => el.classList.remove('selected'));
        this._renderMainPanel();
      }
    });
  }

  /* ═════════════════════════════════════════════════════════════
     HELPERS
     ═════════════════════════════════════════════════════════════ */
  _formatTimeAgo(timestamp) {
    const diff = Math.floor((Date.now() - timestamp) / 1000);
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
    return new Date(timestamp).toLocaleDateString();
  }
}
