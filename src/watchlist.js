/**
 * ReelVault — watchlist.js
 * Watchlist: track TV series for new seasons/episodes via TVmaze API.
 * Fetches on cooldown (max 1x/hour), processes at most 3 items per popup open.
 */

const TVMAZE_BASE_WL = 'https://api.tvmaze.com';
const WL_COOLDOWN_MS = 60 * 60 * 1000;        // 1 hour between full cycles
const WL_BATCH_SIZE = 3;                       // max items to check per popup open
const WL_REQUEST_DELAY_MS = 800;               // delay between API calls

/* ── TVmaze fetch helpers ─────────────────────────────────────── */

/** GET /path from TVmaze, return parsed JSON or null. */
async function wlGet(path) {
  try {
    const resp = await fetch(TVMAZE_BASE_WL + path);
    if (!resp.ok) return null;
    return resp.json();
  } catch (_) { return null; }
}

/**
 * Fetch show info with embedded next episode.
 * @returns {{ name:string, status:string, imageUrl:string|null, imdb:string|null, nextEpisode:object|null }|null}
 */
async function wlFetchShowInfo(showId) {
  const data = await wlGet(`/shows/${showId}?embed=nextepisode`);
  if (!data) return null;
  const nextEp = data._embedded && data._embedded.nextepisode ? {
    season: data._embedded.nextepisode.season,
    episode: data._embedded.nextepisode.number,
    name: data._embedded.nextepisode.name || '',
    airdate: data._embedded.nextepisode.airdate || null,
  } : null;
  return {
    name: data.name,
    status: data.status || 'Unknown',
    imageUrl: data.image ? (data.image.medium || null) : null,
    imdb: data.externals ? (data.externals.imdb || null) : null,
    nextEpisode: nextEp,
  };
}

/**
 * Fetch all episodes for a show, with airdate included.
 * @returns {Array<{season:number, episode:number, name:string, airdate:string|null}>}
 */
async function wlFetchEpisodes(showId) {
  const raw = await wlGet(`/shows/${showId}/episodes`);
  if (!raw || !Array.isArray(raw)) return [];
  return raw
    .filter(ep => ep.season != null && ep.number != null)
    .map(ep => ({
      season: ep.season,
      episode: ep.number,
      name: ep.name || '',
      airdate: ep.airdate || null,   // "YYYY-MM-DD" or null
    }))
    .sort((a, b) => a.season - b.season || a.episode - b.episode);
}

/**
 * Find the latest aired episode from an episode list.
 * "Aired" = airdate exists AND is <= today (UTC).
 * If all episodes are unaired (future), returns {season:0, episode:0}.
 */
function wlLatestAired(episodes) {
  const today = new Date().toISOString().slice(0, 10); // "2026-06-15"
  let latest = { season: 0, episode: 0, airdate: null };
  for (const ep of episodes) {
    if (ep.airdate && ep.airdate <= today) {
      if (ep.season > latest.season || (ep.season === latest.season && ep.episode > latest.episode)) {
        latest = { season: ep.season, episode: ep.episode, airdate: ep.airdate };
      }
    }
  }
  return latest;
}

/* ── Update check ─────────────────────────────────────────────── */

/**
 * Check a single watchlist item for new episodes.
 * @param {WatchlistItem} item
 * @returns {WatchlistItem} mutated item with updated fields
 */
async function wlCheckItem(item) {
  try {
    // Fetch show info (name, status, next episode) + all episodes
    const [info, episodes] = await Promise.all([
      wlFetchShowInfo(item.showId),
      wlFetchEpisodes(item.showId),
    ]);

    item.lastChecked = Date.now();
    if (info) {
      item.name = info.name;                    // keep name in sync
      item.showStatus = info.status;            // "Running", "Ended", etc.
      item.imageUrl = item.imageUrl || info.imageUrl;
    }

    // Determine next episode airdate
    if (info && info.nextEpisode) {
      const ne = info.nextEpisode;
      item.nextEpisodeAirdate = ne.airdate;
      item.nextEpisodeInfo = `S${String(ne.season).padStart(2,'0')}E${String(ne.episode).padStart(2,'0')} · ${ne.name || 'TBA'}`;
    } else {
      item.nextEpisodeAirdate = null;
      item.nextEpisodeInfo = info && info.status === 'Ended' ? 'Series ended' : null;
    }

    // Find latest aired episode
    const latest = wlLatestAired(episodes);

    // Compare with last known state
    if (latest.season > 0) {
      if (item.lastKnownSeason === 0) {
        // First check — everything is new, but label it appropriately
        item.hasUpdate = true;
        item.updateType = 'new_series';
      } else if (latest.season > item.lastKnownSeason) {
        item.hasUpdate = true;
        item.updateType = 'new_season';
      } else if (latest.season === item.lastKnownSeason && latest.episode > item.lastKnownEpisode) {
        item.hasUpdate = true;
        item.updateType = 'new_episode';
      }

      // Always update to latest known (even on first check — sets baseline)
      if (item.lastKnownSeason === 0 || latest.season > item.lastKnownSeason ||
          (latest.season === item.lastKnownSeason && latest.episode > item.lastKnownEpisode)) {
        item.lastKnownSeason = latest.season;
        item.lastKnownEpisode = latest.episode;
        item.lastKnownAirdate = latest.airdate;
      }
    }
  } catch (_) {
    item.lastChecked = Date.now();  // mark as checked even on failure
  }
  return item;
}

/* ── Batch check (rate-limited) ───────────────────────────────── */

/**
 * Check a batch of watchlist items with delays between each.
 * Mutates items in place. Returns the number checked.
 */
async function wlRunBatchCheck(items, maxItems = WL_BATCH_SIZE, force = false) {
  // Sort: update-needing items first, then least-recently-checked
  const sorted = [...items].sort((a, b) => {
    const aNeed = (a.hasUpdate || a.lastKnownSeason === 0) ? 0 : 1;
    const bNeed = (b.hasUpdate || b.lastKnownSeason === 0) ? 0 : 1;
    if (aNeed !== bNeed) return aNeed - bNeed;
    return (a.lastChecked || 0) - (b.lastChecked || 0);
  });

  const toCheck = sorted.slice(0, maxItems);
  let count = 0;

  for (const item of toCheck) {
    // Skip recently-checked items (within cooldown) unless forced or updates pending
    if (!force) {
      const recentlyChecked = (Date.now() - (item.lastChecked || 0)) < WL_COOLDOWN_MS;
      if (recentlyChecked && item.lastKnownSeason > 0 && !item.hasUpdate) continue;
    }

    await wlCheckItem(item);
    count++;

    if (count < toCheck.length) {
      await new Promise(r => setTimeout(r, WL_REQUEST_DELAY_MS));
    }
  }
  return count;
}

/* ── Search ───────────────────────────────────────────────────── */

/**
 * Search TVmaze for shows.
 * @returns {Array<{showId:number, name:string, imageUrl:string|null, premiered:string|null}>}
 */
async function wlSearchShows(query) {
  const results = await wlGet(`/search/shows?q=${encodeURIComponent(query)}`);
  if (!results || !Array.isArray(results)) return [];
  return results.slice(0, 8).map(entry => {
    const s = entry.show;
    return {
      showId: s.id,
      name: s.name || 'Unknown',
      imageUrl: s.image ? (s.image.medium || null) : null,
      premiered: s.premiered || null,
      status: s.status || 'Unknown',
      type: s.type || 'Scripted',
    };
  });
}

/* ── Exports are global (script tags, no bundler) ─────────────── */
