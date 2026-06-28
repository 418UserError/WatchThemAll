/**
 * ReelVault — storage.js
 * Thin wrapper around chrome.storage.local. All data flows through here.
 */
const K_SCHEMAS       = 'vidsrc_schemas';
const K_BOOKMARKS     = 'vidsrc_bookmarks';
const K_FORM          = 'vidsrc_form_state';
const K_AVAILABILITY  = 'vidsrc_availability';
const K_HISTORY       = 'vidsrc_history';
const K_ACTIVE_PIDS   = 'vidsrc_active_providers';
const K_WATCHLIST     = 'vidsrc_watchlist_items';
const K_WL_LAST_CHECK = 'vidsrc_watchlist_last_check';
const K_WL_DELETED    = 'vidsrc_watchlist_deleted';
const SCHEMA_VERSION  = 3;

function serializeSchema(s) {
  return {
    schemaId: s.schemaId, name: s.name, rootUrl: s.rootUrl,
    tv:    s.tv    ? { urlTemplate: s.tv.urlTemplate }    : null,
    movie: s.movie ? { urlTemplate: s.movie.urlTemplate } : null,
  };
}

class StorageManager {
  async loadAll() {
    const data = await chrome.storage.local.get({
      [K_SCHEMAS]: [],
      [K_BOOKMARKS]: [],
      vidsrc_schema_version: 0,
    });

    const schemas = this._reviveSchemas(data[K_SCHEMAS]);
    const bookmarks = this._reviveBookmarks(data[K_BOOKMARKS]);

    if (data.vidsrc_schema_version < SCHEMA_VERSION) {
      await chrome.storage.local.set({
        vidsrc_schema_version: SCHEMA_VERSION,
        [K_SCHEMAS]: schemas.map(serializeSchema),
      });
    }

    return { schemas, bookmarks };
  }

  async saveAll(schemas, bookmarks) {
    await chrome.storage.local.set({
      [K_SCHEMAS]:   schemas.map(serializeSchema),
      [K_BOOKMARKS]: bookmarks,
    });
  }

  /** Load persisted form state. */
  async loadFormState() {
    const { [K_FORM]: state } = await chrome.storage.local.get({ [K_FORM]: {} });
    return state || {};
  }

  /** Save form state. */
  async saveFormState(state) {
    await chrome.storage.local.set({ [K_FORM]: state });
  }

  /** Clear specific form keys. */
  async clearFormState(keys) {
    const state = await this.loadFormState();
    keys.forEach(k => delete state[k]);
    await this.saveFormState(state);
  }

  /* ── Availability cache ────────────────────────────────────── */

  /** Load the full availability cache. Returns { [bookmarkId]: { ts, data } } */
  async loadAvailabilityCache() {
    const { [K_AVAILABILITY]: cache } = await chrome.storage.local.get({ [K_AVAILABILITY]: {} });
    return cache || {};
  }

  /** Save episode browser data for a TV bookmark. */
  async saveAvailability(bookmarkId, data) {
    const cache = await this.loadAvailabilityCache();
    cache[bookmarkId] = {
      ts: Date.now(),
      data: {
        found: data.found,
        showName: data.showName || null,
        showId: data.showId || null,
        episodes: data.episodes || null,
        error: data.error || null,
      },
    };
    await chrome.storage.local.set({ [K_AVAILABILITY]: cache });
  }

  /** Remove cached availability for a bookmark. */
  async clearAvailability(bookmarkId) {
    const cache = await this.loadAvailabilityCache();
    delete cache[bookmarkId];
    await chrome.storage.local.set({ [K_AVAILABILITY]: cache });
  }

  /* ── Watch history ────────────────────────────────────────── */

  async loadHistory() {
    const { [K_HISTORY]: history } = await chrome.storage.local.get({ [K_HISTORY]: [] });
    return history || [];
  }

  async clearHistory() {
    await chrome.storage.local.set({ [K_HISTORY]: [] });
  }

  /* ── Active provider IDs ──────────────────────────────────── */

  async loadActiveProviderIds() {
    const { [K_ACTIVE_PIDS]: ids } = await chrome.storage.local.get({ [K_ACTIVE_PIDS]: null });
    return ids;
  }

  async saveActiveProviderIds(ids) {
    await chrome.storage.local.set({ [K_ACTIVE_PIDS]: ids });
  }

  /* ── Watchlist ────────────────────────────────────────────── */

  async loadWatchlist() {
    const data = await chrome.storage.local.get({
      [K_WATCHLIST]: [],
      [K_WL_LAST_CHECK]: 0,
    });
    return {
      items: (data[K_WATCHLIST] || []).map(w => new WatchlistItem(w)),
      lastCheck: data[K_WL_LAST_CHECK] || 0,
    };
  }

  async saveWatchlist(items, lastCheck) {
    // Dedup by watchId before saving
    const seen = new Set();
    const unique = [];
    for (const w of items) {
      if (seen.has(w.watchId)) continue;
      seen.add(w.watchId);
      unique.push(w);
    }
    const serialized = unique.map(w => ({
      watchId: w.watchId, name: w.name, imdb: w.imdb, showId: w.showId,
      source: w.source, bookmarkId: w.bookmarkId,
      lastKnownSeason: w.lastKnownSeason, lastKnownEpisode: w.lastKnownEpisode,
      lastKnownAirdate: w.lastKnownAirdate,
      nextEpisodeAirdate: w.nextEpisodeAirdate,
      nextEpisodeInfo: w.nextEpisodeInfo, showStatus: w.showStatus,
      hasUpdate: w.hasUpdate, updateType: w.updateType,
      addedAt: w.addedAt, lastChecked: w.lastChecked, imageUrl: w.imageUrl,
    }));
    await chrome.storage.local.set({
      [K_WATCHLIST]: serialized,
      [K_WL_LAST_CHECK]: lastCheck || Date.now(),
    });
  }

  /** Load set of deleted bookmark IDs (manually removed from watchlist). */
  async loadDeletedWatchlistIds() {
    const { [K_WL_DELETED]: ids } = await chrome.storage.local.get({ [K_WL_DELETED]: [] });
    return new Set(ids || []);
  }

  /** Remember a bookmark/show as deleted so auto-sync doesn't re-add it. */
  async addDeletedWatchlistId(id) {
    const ids = await this.loadDeletedWatchlistIds();
    ids.add(id);
    await chrome.storage.local.set({ [K_WL_DELETED]: [...ids] });
  }

  /** Re-hydrate plain objects into Schema instances. Auto-migrates old segment/format configs. */
  _reviveSchemas(raw) {
    return (raw || []).map(s => {
      // Convert old-format segment configs to urlTemplate if needed
      const tv = s.tv
        ? (s.tv.urlTemplate ? s.tv : { urlTemplate: legacyToTemplate(s.tv, 'tv') })
        : null;
      const movie = s.movie
        ? (s.movie.urlTemplate ? s.movie : { urlTemplate: legacyToTemplate(s.movie, 'movie') })
        : null;
      return new Schema({
        schemaId: s.schemaId, name: s.name, rootUrl: s.rootUrl || '',
        tv,
        movie,
      });
    });
  }

  /** Re-hydrate plain objects into Bookmark instances. */
  _reviveBookmarks(raw) {
    return (raw || []).filter(b => b && b.schemaId).map(b => new Bookmark({
      bookmarkId:  b.bookmarkId, name: b.name, imdb: b.imdb,
      schemaId:    b.schemaId, type: b.type || 'tv',
      lastSeason:  b.lastSeason, lastEpisode: b.lastEpisode,
      imageUrl:    b.imageUrl || null,
      stars:       b.stars || null,
      category:    b.category || null,
      tmdbId:      b.tmdbId || null,
    }));
  }
}
