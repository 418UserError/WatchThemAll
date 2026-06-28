/**
 * ReelVault — episode-browser.js
 * Fetches canonical episode listings from TVmaze API (free, no key required).
 * TV series only. Matches by title + IMDB verification.
 */

const TVMAZE_BASE = 'https://api.tvmaze.com';

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
 * @param {string} title
 * @param {string} imdbId  — e.g. "tt0898266"
 * @returns {Promise<{id:number, name:string}|null>}
 */
async function findShow(title, imdbId) {
  // Try singlesearch first (best for exact titles)
  const show = await tvGet(`/singlesearch/shows?q=${encodeURIComponent(title)}`);
  if (show && show.externals && show.externals.imdb === imdbId) {
    return { id: show.id, name: show.name };
  }

  // Fallback: search endpoint (returns array)
  const results = await tvGet(`/search/shows?q=${encodeURIComponent(title)}`);
  if (results && Array.isArray(results)) {
    for (const entry of results) {
      const s = entry.show;
      if (s && s.externals && s.externals.imdb === imdbId) {
        return { id: s.id, name: s.name };
      }
    }
    // No IMDB match — return first result with reasonable title similarity
    if (results.length > 0 && results[0].show) {
      const first = results[0].show;
      const score = titleSimilarity(title, first.name);
      if (score >= 0.7) {
        return { id: first.id, name: first.name };
      }
    }
  }
  return null;
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
  const episodes = await tvGet(`/shows/${showId}/episodes`);
  if (!episodes || !Array.isArray(episodes)) return [];
  return episodes.map(ep => ({
    season: ep.season,
    episode: ep.number,
    name: ep.name || '',
    airdate: ep.airdate || null,
  })).sort((a, b) => a.season - b.season || a.episode - b.episode);
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
