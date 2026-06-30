/**
 * ReelVault — episode-browser.js
 * Fetches canonical episode listings from TVmaze API (free, no key required).
 * TV series only. Matches by title + IMDB verification.
 */

const TVMAZE_BASE = 'https://api.tvmaze.com';

// ── In-memory caches (prevent rate limiting) ──────────────────
const _findShowCache = new Map();   // key: imdbId → { ts, result }
const _episodeCache = new Map();    // key: showId → { ts, episodes }
const FIND_SHOW_TTL = 60 * 60 * 1000;      // 1 hour
const EPISODE_CACHE_TTL = 30 * 60 * 1000;  // 30 minutes

/** GET from TVmaze, return parsed JSON or null on failure. */
async function tvGet(path) {
  try {
    const resp = await fetch(TVMAZE_BASE + path);
    if (!resp.ok) return null;
    return resp.json();
  } catch (_) { return null; }
}

/**
 * Find a show on TVmaze by title, verify it matches the expected IMDB ID.
 * Results cached by IMDB ID for 1 hour.
 * @param {string} title
 * @param {string} imdbId  — e.g. "tt0898266"
 * @returns {Promise<{id:number, name:string}|null>}
 */
async function findShow(title, imdbId) {
  // Check cache
  const cached = _findShowCache.get(imdbId);
  if (cached && (Date.now() - cached.ts) < FIND_SHOW_TTL) {
    return cached.result;
  }

  let result = null;

  // Try singlesearch first (best for exact titles)
  let show = await tvGet(`/singlesearch/shows?q=${encodeURIComponent(title)}`);
  if (show && show.externals && show.externals.imdb === imdbId) {
    result = { id: show.id, name: show.name };
  }

  // Fallback: try with shortened title (before colon or dash)
  if (!result) {
    const cutIdx = Math.min(
      title.indexOf(':') > 0 ? title.indexOf(':') : Infinity,
      title.indexOf(' - ') > 0 ? title.indexOf(' - ') : Infinity
    );
    if (cutIdx < Infinity) {
      const shortTitle = title.substring(0, cutIdx).trim();
      show = await tvGet(`/singlesearch/shows?q=${encodeURIComponent(shortTitle)}`);
      if (show && show.externals && show.externals.imdb === imdbId) {
        result = { id: show.id, name: show.name };
      }
    }
  }

  // Fallback: search endpoint
  if (!result) {
    const results = await tvGet(`/search/shows?q=${encodeURIComponent(title)}`);
    if (results && Array.isArray(results)) {
      for (const entry of results) {
        const s = entry.show;
        if (s && s.externals && s.externals.imdb === imdbId) {
          result = { id: s.id, name: s.name };
          break;
        }
      }
      if (!result && results.length > 0 && results[0].show) {
        const first = results[0].show;
        const score = titleSimilarity(title, first.name);
        if (score >= 0.7) {
          result = { id: first.id, name: first.name };
        }
      }
    }
  }

  // Cache result (only cache successes — failures retry next time)
  if (result) {
    _findShowCache.set(imdbId, { ts: Date.now(), result });
  }
  return result;
}

function titleSimilarity(needle, haystack) {
  const nw = needle.toLowerCase().split(/\s+/).filter(w => w.length > 1);
  const hw = haystack.toLowerCase();
  const hits = nw.filter(w => hw.includes(w));
  return hits.length / nw.length;
}

/**
 * Fetch all episodes for a TV show.
 * @returns {Promise<Array<{season:number, episode:number, name:string}>>}
 */
async function fetchEpisodes(showId) {
  // Check cache
  const cached = _episodeCache.get(showId);
  if (cached && (Date.now() - cached.ts) < EPISODE_CACHE_TTL) {
    return cached.episodes;
  }

  const episodes = await tvGet(`/shows/${showId}/episodes`);
  if (!episodes || !Array.isArray(episodes)) return [];
  const result = episodes.map(ep => ({
    season: ep.season,
    episode: ep.number,
    name: ep.name || '',
    airdate: ep.airdate || null,
  })).sort((a, b) => a.season - b.season || a.episode - b.episode);

  _episodeCache.set(showId, { ts: Date.now(), episodes: result });
  return result;
}

/**
 * Main entry point — fetch episode browser data for a TV bookmark.
 * @param {{name:string, imdb:string}} bookmark
 * @returns {Promise<{found:boolean, showName?:string, showId?:number, episodes?:Array, error?:string}>}
 */
async function checkAvailability(bookmark) {
  if (!bookmark.imdb) return { found: false, error: 'No IMDB ID' };

  const show = await findShow(bookmark.name, bookmark.imdb);
  if (!show) return { found: false, error: 'Show not found on TVmaze' };

  const episodes = await fetchEpisodes(show.id);
  return {
    found: episodes.length > 0,
    showName: show.name,
    showId: show.id,
    episodes,
  };
}
