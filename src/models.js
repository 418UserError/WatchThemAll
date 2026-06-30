/**
 * ReelVault — models.js
 * Schema and Bookmark data classes. Pure logic, no DOM or storage.
 */

/* ── SegmentConfig ────────────────────────────────────────────── */
class SegmentConfig {
  /** @param {{ urlTemplate:string }} */
  constructor({ urlTemplate = '' } = {}) {
    /**
     * URL template with placeholders:
     *   {rootUrl}  — replaced with Schema.rootUrl
     *   {imdb}     — IMDB ID (e.g. tt0898266)
     *   {tmdb}     — TMDB numeric ID (falls back to IMDB if tmdbId is null)
     *   {season}   — season number
     *   {episode}  — episode number
     * Examples:
     *   "{rootUrl}tv/{imdb}/{season}/{episode}"
     *   "{rootUrl}movie/{imdb}"
     *   "{rootUrl}{tmdb}/{season}/{episode}"
     *   "{rootUrl}?video_id={imdb}&s={season}&e={episode}"
     */
    this.urlTemplate = urlTemplate;
  }
}

/* ── Schema (Provider) ────────────────────────────────────────── */
class Schema {
  /** @param {{ schemaId:string, name:string, rootUrl:string, tv:SegmentConfig|null, movie:SegmentConfig|null }} */
  constructor({ schemaId, name, rootUrl, tv, movie }) {
    this.schemaId = schemaId;
    this.name     = name;
    this.rootUrl  = rootUrl.endsWith('/') ? rootUrl : rootUrl + '/';
    this.tv       = tv    ? new SegmentConfig(tv)    : null;
    this.movie    = movie ? new SegmentConfig(movie) : null;
  }

  /** Build a full URL for the given bookmark via template replacement. */
  buildUrl(bookmark) {
    const cfg = bookmark.type === 'movie' ? this.movie : this.tv;
    if (!cfg || !cfg.urlTemplate) return null;

    const tmdbId = bookmark.tmdbId || bookmark.imdb;

    let url = cfg.urlTemplate
      .replace(/\{rootUrl\}/g, this.rootUrl)
      .replace(/\{imdb\}/g, bookmark.imdb || '')
      .replace(/\{tmdb\}/g, tmdbId || '')
      .replace(/\{season\}/g, bookmark.lastSeason || '')
      .replace(/\{episode\}/g, bookmark.lastEpisode || '');

    // Clean up accidental double slashes (but not the protocol:// one)
    url = url.replace(/([^:])\/\//g, '$1/');
    // Clean up stray slash before query string (rootUrl normalization artifact)
    url = url.replace(/\/\?/g, '?');

    try { new URL(url); return url; } catch (_) { return null; }
  }
}

/* ── Bookmark ─────────────────────────────────────────────────── */
class Bookmark {
  constructor({ bookmarkId, name, imdb, schemaId, type, lastSeason = null, lastEpisode = null, imageUrl = null, stars = null, category = null, tmdbId = null }) {
    this.bookmarkId = bookmarkId;
    this.name       = name;
    this.imdb       = imdb;
    this.schemaId   = schemaId;
    this.type       = type;
    this.lastSeason  = (type === 'tv') ? (lastSeason || 1) : null;
    this.lastEpisode = (type === 'tv') ? (lastEpisode || 1) : null;
    this.imageUrl   = imageUrl || null;
    this.stars      = stars || null;
    this.category   = category || null;
    this.tmdbId     = tmdbId || null;
  }

  /** Human-readable position label. */
  get positionLabel() {
    if (this.type === 'movie') return '';
    if (this.lastSeason && this.lastEpisode) {
      return `S${String(this.lastSeason).padStart(2, '0')}E${String(this.lastEpisode).padStart(2, '0')}`;
    }
    return '\u2014';
  }
}

/* ── Legacy migration ─────────────────────────────────────────── */
/**
 * Convert an old-style segment config to a urlTemplate string.
 * Handles both suffix and query formats. Used by schemaFromCatalog()
 * and storage.js for auto-migration of stored schemas.
 *
 * @param {{ segment?:string, format:'query'|'suffix', seasonKey?:string, episodeKey?:string, imdbKey?:string, queryPrefix?:string }} seg
 * @param {'tv'|'movie'} type
 * @returns {string} urlTemplate
 */
function legacyToTemplate(seg, type) {
  if (!seg || !seg.format) {
    // Bare-minimum fallback: segment path + IMDB ID
    const segment = seg?.segment || '';
    const tmpl = '{rootUrl}' + segment + '/{imdb}';
    if (type === 'tv') return tmpl + '/{season}/{episode}';
    return tmpl;
  }

  const idKey = (seg.imdbKey === 'tmdb') ? 'tmdb' : 'imdb';
  const id = `{${idKey}}`;
  let tmpl = '{rootUrl}' + (seg.segment || '');

  if (seg.format === 'query') {
    tmpl += '?';
    if (seg.queryPrefix) tmpl += seg.queryPrefix + '&';
    tmpl += (seg.imdbKey || 'imdb') + '=' + id;
    if (type === 'tv' && seg.seasonKey && seg.episodeKey) {
      tmpl += '&' + seg.seasonKey + '={season}&' + seg.episodeKey + '={episode}';
    }
  } else {
    // suffix format
    if (seg.segment && !tmpl.endsWith('/')) tmpl += '/';
    tmpl += id;
    if (type === 'tv') {
      tmpl += '/{season}/{episode}';
    }
  }
  return tmpl;
}

/** Build a Schema instance from a catalog entry (providers.json format). */
function schemaFromCatalog(entry) {
  return new Schema({
    schemaId: entry.id,
    name: entry.name,
    rootUrl: entry.rootUrl,
    tv: entry.tv ? {
      urlTemplate: entry.tv.urlTemplate || legacyToTemplate(entry.tv, 'tv'),
    } : null,
    movie: entry.movie ? {
      urlTemplate: entry.movie.urlTemplate || legacyToTemplate(entry.movie, 'movie'),
    } : null,
  });
}

/* ── Factory helpers ──────────────────────────────────────────── */
function crc32(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36).padStart(6, '0');
}

function makeBookmarkId() { return crc32(Date.now().toString(36) + Math.random().toString(36)); }

/** HTML-escape a string for safe innerHTML injection. Escapes & < > " ' */
function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}

/* ── TMDB ID lookup ───────────────────────────────────────────── */
const TMDB_API_KEY = '1f54bd990f1cdfb230adb312546d765d'; // free dev key, replace if rate-limited

/**
 * Fetch TMDB numeric ID from an IMDB ID (e.g. tt0898266 -> 1418).
 * Uses TMDB's /find endpoint. Returns null on failure.
 */
async function fetchTmdbId(imdbId) {
  if (!imdbId) return null;
  try {
    const resp = await fetch(
      `https://api.themoviedb.org/3/find/${encodeURIComponent(imdbId)}?api_key=${TMDB_API_KEY}&external_source=imdb_id`
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    const tv = data.tv_results && data.tv_results[0];
    const movie = data.movie_results && data.movie_results[0];
    const result = tv || movie;
    return result ? String(result.id) : null;
  } catch (_) {
    return null;
  }
}

/* ── WatchlistItem ────────────────────────────────────────────── */
class WatchlistItem {
  constructor({
    watchId, name, imdb = null, showId, source = 'bookmark',
    bookmarkId = null, lastKnownSeason = 0, lastKnownEpisode = 0,
    lastKnownAirdate = null, nextEpisodeAirdate = null,
    nextEpisodeInfo = null, showStatus = 'Unknown',
    hasUpdate = false, updateType = null,
    addedAt = Date.now(), lastChecked = 0, imageUrl = null,
  }) {
    this.watchId = watchId;
    this.name = name;
    this.imdb = imdb;
    this.showId = showId;
    this.source = source;
    this.bookmarkId = bookmarkId;
    this.lastKnownSeason = lastKnownSeason;
    this.lastKnownEpisode = lastKnownEpisode;
    this.lastKnownAirdate = lastKnownAirdate;
    this.nextEpisodeAirdate = nextEpisodeAirdate;
    this.nextEpisodeInfo = nextEpisodeInfo;
    this.showStatus = showStatus;
    this.hasUpdate = hasUpdate;
    this.updateType = updateType;
    this.addedAt = addedAt;
    this.lastChecked = lastChecked;
    this.imageUrl = imageUrl;
  }

  /** Position label for last known episode. */
  get positionLabel() {
    if (!this.lastKnownSeason) return '\u2014';
    return `S${String(this.lastKnownSeason).padStart(2,'0')}E${String(this.lastKnownEpisode).padStart(2,'0')}`;
  }

  /** Update badge text. */
  get updateLabel() {
    if (!this.hasUpdate) return '';
    if (this.updateType === 'new_series') return 'New Series';
    if (this.updateType === 'new_season') return 'New Season';
    return 'New Ep';
  }

  /** Next episode display text. */
  get nextLabel() {
    if (this.nextEpisodeInfo) return this.nextEpisodeInfo;
    if (this.showStatus === 'Ended') return 'Ended';
    if (this.nextEpisodeAirdate) return `Next: ${this.nextEpisodeAirdate}`;
    return '';
  }

  /** Compact countdown label for the list row (e.g. "5h 30m"). */
  get countdownLabel() {
    if (!this.nextEpisodeAirdate) return '';
    const target = new Date(this.nextEpisodeAirdate + 'T00:00:00');
    const diff = target - Date.now();
    if (diff <= 0) return 'Now';
    const days = Math.floor(diff / 86400000);
    const hours = Math.floor((diff % 86400000) / 3600000);
    const mins = Math.floor((diff % 3600000) / 60000);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
  }

  /** Human-readable status for when no next episode is scheduled. */
  get listeningLabel() {
    if (this.showStatus === 'Ended') return 'Ended';
    if (this.nextEpisodeAirdate || this.nextEpisodeInfo) return ''; // has upcoming — no label needed
    if (this.lastKnownSeason === 0) return 'Listening for release';
    if (this.showStatus === 'Running') return 'Listening for new season';
    return 'Listening for new episodes';
  }
}

/* ── Default providers (hard fallback) ────────────────────────── */
const DEFAULT_SCHEMAS = [
  new Schema({ schemaId:'default_cinemaos',  name:'CinemaOS',    rootUrl:'https://cinemaos.tech/player',
    tv:{urlTemplate:'{rootUrl}{tmdb}/{season}/{episode}'},       movie:{urlTemplate:'{rootUrl}{imdb}'} }),
  new Schema({ schemaId:'default_screenscape',name:'ScreenScape',rootUrl:'https://screenscape.me/embed',
    tv:{urlTemplate:'{rootUrl}?type=tv&imdb={imdb}&s={season}&e={episode}'}, movie:{urlTemplate:'{rootUrl}?type=movie&imdb={imdb}'} }),
  new Schema({ schemaId:'default_vidsrcme',  name:'VidSrc Me',   rootUrl:'https://vidsrcme.ru/embed/',
    tv:{urlTemplate:'{rootUrl}tv?imdb={imdb}&season={season}&episode={episode}'}, movie:{urlTemplate:'{rootUrl}movie/{imdb}'} }),
  new Schema({ schemaId:'default_vidsrcin',  name:'VidSrc In',   rootUrl:'https://vidsrc.in/embed/',
    tv:{urlTemplate:'{rootUrl}tv/{imdb}/{season}/{episode}'},    movie:{urlTemplate:'{rootUrl}movie/{imdb}'} }),
  new Schema({ schemaId:'default_vidsrcto',  name:'VidSrc To',   rootUrl:'https://vidsrc.to/embed/',
    tv:{urlTemplate:'{rootUrl}tv/{imdb}/{season}/{episode}'},    movie:{urlTemplate:'{rootUrl}movie/{imdb}'} }),
  new Schema({ schemaId:'default_vidrock',   name:'VidRock',     rootUrl:'https://vidrock.ru/',
    tv:{urlTemplate:'{rootUrl}tv/{imdb}/{season}/{episode}'},    movie:{urlTemplate:'{rootUrl}movie/{imdb}'} }),
  new Schema({ schemaId:'default_autoembed', name:'AutoEmbed',   rootUrl:'https://autoembed.co/',
    tv:{urlTemplate:'{rootUrl}tv/tmdb/{tmdb}-{season}-{episode}'}, movie:{urlTemplate:'{rootUrl}movie/tmdb/{tmdb}'} }),
];
