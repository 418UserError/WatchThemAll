/**
 * WatchThemAll — Test Suite
 *
 * Run with: node --test test/
 */

const { describe, it, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const TEST_DIR = path.join(ROOT, '.test-tmp');
const SRC_DIR = path.join(ROOT, 'src');

function cleanTestDir() {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEST_DIR, { recursive: true });
}

// Load a source file, return an object with its top-level declarations.
// Uses a sandboxed VM context to avoid polluting global scope.
function loadModule(filename, extraGlobals = {}) {
  const filePath = path.join(SRC_DIR, filename);
  const code = fs.readFileSync(filePath, 'utf-8');

  const sandbox = {
    // Browser-like globals the scripts expect
    fetch: async () => ({ json: async () => ({}) }),
    URL,          // needed by Schema.buildUrl for URL validation
    setTimeout,   // used by some modules
    clearTimeout,
    Date,         // used by makeBookmarkId
    Math,         // used by crc32
    ...extraGlobals,
    console,  // pass through

    // Capture class/function declarations
    __exports: {},
  };

  // Wrap in an IIFE that captures top-level declarations
  const wrapped = `
    (function() {
      ${code}
      // Capture all declared identifiers to __exports
      __exports.SegmentConfig = typeof SegmentConfig !== 'undefined' ? SegmentConfig : undefined;
      __exports.Schema = typeof Schema !== 'undefined' ? Schema : undefined;
      __exports.Bookmark = typeof Bookmark !== 'undefined' ? Bookmark : undefined;
      __exports.WatchlistItem = typeof WatchlistItem !== 'undefined' ? WatchlistItem : undefined;
      __exports.imdbType = typeof imdbType !== 'undefined' ? imdbType : undefined;
      __exports.parseProviderTemplate = typeof parseProviderTemplate !== 'undefined' ? parseProviderTemplate : undefined;
      __exports.extractRootUrl = typeof extractRootUrl !== 'undefined' ? extractRootUrl : undefined;
      __exports.esc = typeof esc !== 'undefined' ? esc : undefined;
      __exports.makeBookmarkId = typeof makeBookmarkId !== 'undefined' ? makeBookmarkId : undefined;
      __exports.crc32 = typeof crc32 !== 'undefined' ? crc32 : undefined;
      __exports.legacyToTemplate = typeof legacyToTemplate !== 'undefined' ? legacyToTemplate : undefined;
      __exports.schemaFromCatalog = typeof schemaFromCatalog !== 'undefined' ? schemaFromCatalog : undefined;
      __exports.fetchTmdbId = typeof fetchTmdbId !== 'undefined' ? fetchTmdbId : undefined;
    })();
  `;

  const ctx = vm.createContext(sandbox);
  const script = new vm.Script(wrapped, { filename });
  script.runInContext(ctx);

  return sandbox.__exports;
}

// ── JSON Store (built-in, no deps) ────────────────────────────

const DEFAULTS = {
  vidsrc_schemas: [],
  vidsrc_bookmarks: [],
  vidsrc_form_state: {},
  vidsrc_history: [],
  vidsrc_availability: {},
  vidsrc_active_providers: null,
  vidsrc_provider_catalog: null,
  vidsrc_provider_health: {},
  vidsrc_watchlist_items: [],
  vidsrc_watchlist_last_check: 0,
  vidsrc_watchlist_deleted: [],
};

function createStore(dataDir) {
  const dataFile = path.join(dataDir, 'watchthemall.json');
  let _store = null;

  function load() {
    if (_store) return _store;
    fs.mkdirSync(dataDir, { recursive: true });
    if (fs.existsSync(dataFile)) {
      _store = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(dataFile, 'utf-8')) };
    } else {
      _store = { ...DEFAULTS };
      flush();
    }
    return _store;
  }

  function flush() {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = dataFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(_store, null, 2), 'utf-8');
    fs.renameSync(tmp, dataFile);
  }

  return {
    get(key, defaultVal) { const s = load(); return (key in s) ? s[key] : defaultVal; },
    set(key, value) { const s = load(); s[key] = value; flush(); },
    getMany(defaults) {
      const s = load();
      const out = {};
      for (const [k, dv] of Object.entries(defaults)) out[k] = (k in s) ? s[k] : dv;
      return out;
    },
    setMany(obj) { const s = load(); Object.assign(s, obj); flush(); },
    get dataFile() { return dataFile; },
  };
}

// ── Store Tests ───────────────────────────────────────────────
describe('JSON Store', () => {
  let store;
  beforeEach(() => { cleanTestDir(); store = createStore(TEST_DIR); });
  afterEach(() => cleanTestDir());

  it('returns defaults for unset keys', () => {
    assert.deepStrictEqual(store.getMany({ vidsrc_bookmarks: [] }), { vidsrc_bookmarks: [] });
  });

  it('persists and retrieves values', () => {
    store.setMany({ vidsrc_bookmarks: [{ name: 'Test' }] });
    assert.equal(store.getMany({ vidsrc_bookmarks: [] }).vidsrc_bookmarks[0].name, 'Test');
  });

  it('survives store reload', () => {
    store.setMany({ vidsrc_form_state: { _tab: 'watchlist' } });
    const s2 = createStore(TEST_DIR);
    assert.deepStrictEqual(s2.getMany({ vidsrc_form_state: {} }).vidsrc_form_state, { _tab: 'watchlist' });
  });

  it('handles null defaults', () => {
    assert.equal(store.getMany({ vidsrc_active_providers: null }).vidsrc_active_providers, null);
  });

  it('creates data file on first write', () => {
    store.get('vidsrc_bookmarks', []);
    assert.ok(fs.existsSync(store.dataFile));
  });
});

// ── Models Tests ──────────────────────────────────────────────
describe('Data Models', () => {
  let Schema, SegmentConfig, Bookmark, WatchlistItem;

  before(() => {
    const exports = loadModule('models.js');
    SegmentConfig = exports.SegmentConfig;
    Schema = exports.Schema;
    Bookmark = exports.Bookmark;
    WatchlistItem = exports.WatchlistItem;
  });

  it('SegmentConfig stores urlTemplate', () => {
    const cfg = new SegmentConfig({ urlTemplate: '{rootUrl}tv/{imdb}/{season}/{episode}' });
    assert.equal(cfg.urlTemplate, '{rootUrl}tv/{imdb}/{season}/{episode}');
  });

  it('Schema.buildUrl — suffix TV', () => {
    const s = new Schema({
      schemaId: 'x', name: 'X', rootUrl: 'https://x.com/embed/',
      tv: new SegmentConfig({ urlTemplate: '{rootUrl}tv/{imdb}/{season}/{episode}' }),
    });
    assert.equal(s.buildUrl({ imdb: 'tt0898266', type: 'tv', lastSeason: 3, lastEpisode: 5 }),
      'https://x.com/embed/tv/tt0898266/3/5');
  });

  it('Schema.buildUrl — movie', () => {
    const s = new Schema({
      schemaId: 'x', name: 'X', rootUrl: 'https://x.com/',
      movie: new SegmentConfig({ urlTemplate: '{rootUrl}movie/{imdb}' }),
    });
    assert.equal(s.buildUrl({ imdb: 'tt0133093', type: 'movie' }),
      'https://x.com/movie/tt0133093');
  });

  it('Schema.buildUrl — query format (cleans /?)', () => {
    const s = new Schema({
      schemaId: 'x', name: 'X', rootUrl: 'https://x.com/',
      tv: new SegmentConfig({ urlTemplate: '{rootUrl}?imdb={imdb}&s={season}&e={episode}' }),
    });
    // buildUrl cleans stray slash before question mark: /? → ?
    assert.equal(s.buildUrl({ imdb: 'tt0898266', type: 'tv', lastSeason: 2, lastEpisode: 12 }),
      'https://x.com?imdb=tt0898266&s=2&e=12');
  });

  it('Schema.buildUrl — {tmdb} with null falls back to imdb', () => {
    const s = new Schema({
      schemaId: 'x', name: 'X', rootUrl: 'https://x.com/',
      tv: new SegmentConfig({ urlTemplate: '{rootUrl}{tmdb}/{season}/{episode}' }),
    });
    assert.equal(s.buildUrl({ imdb: 'tt0898266', tmdbId: null, type: 'tv', lastSeason: 1, lastEpisode: 1 }),
      'https://x.com/tt0898266/1/1');
  });

  it('Schema.buildUrl — cleans double slashes', () => {
    const s = new Schema({
      schemaId: 'x', name: 'X', rootUrl: 'https://x.com/',
      tv: new SegmentConfig({ urlTemplate: '{rootUrl}/tv/{imdb}/{season}/{episode}' }),
    });
    const u = s.buildUrl({ imdb: 'tt0898266', type: 'tv', lastSeason: 1, lastEpisode: 1 });
    assert.ok(!u.includes('//tv'));
    assert.equal(u, 'https://x.com/tv/tt0898266/1/1');
  });

  it('Schema.buildUrl — returns null for missing config', () => {
    const s = new Schema({ schemaId: 'x', name: 'X', rootUrl: 'https://x.com/' });
    assert.equal(s.buildUrl({ imdb: 'tt0898266', type: 'tv', lastSeason: 1, lastEpisode: 1 }), null);
  });

  it('Bookmark creates with explicit ID', () => {
    const bm = new Bookmark({
      bookmarkId: 'test-bm-123',
      name: 'Breaking Bad', imdb: 'tt0903747', type: 'tv', schemaId: 'x',
      lastSeason: 1, lastEpisode: 1,
    });
    assert.equal(bm.name, 'Breaking Bad');
    assert.equal(bm.bookmarkId, 'test-bm-123');
  });

  it('Bookmark.positionLabel — TV', () => {
    const bm = new Bookmark({
      name: 'X', imdb: 'tt0000000', type: 'tv', schemaId: 'x',
      lastSeason: 3, lastEpisode: 12,
    });
    assert.equal(bm.positionLabel, 'S03E12');
  });

  it('Bookmark.positionLabel — movie empty', () => {
    const bm = new Bookmark({ name: 'X', imdb: 'tt0000000', type: 'movie', schemaId: 'x' });
    assert.equal(bm.positionLabel, '');
  });

  it('WatchlistItem default hasUpdate is false', () => {
    const w = new WatchlistItem({ watchId: 'x', name: 'X', showId: 1, source: 'custom' });
    assert.equal(w.hasUpdate, false);
  });
});

// ── Parser Tests ──────────────────────────────────────────────
describe('IMDB Parser', () => {
  let imdbType;
  before(() => { imdbType = loadModule('parser.js').imdbType; });

  it('tvSeries → tv', () => assert.equal(imdbType('tvSeries'), 'tv'));
  it('tvMiniSeries → tv', () => assert.equal(imdbType('tvMiniSeries'), 'tv'));
  it('movie → movie', () => assert.equal(imdbType('movie'), 'movie'));
  it('short → movie', () => assert.equal(imdbType('short'), 'movie'));
  it('unknown → tv (default)', () => assert.equal(imdbType('videoGame'), 'tv'));
});

// ── Provider Parser Tests ─────────────────────────────────────
describe('Provider Parser', () => {
  let parseProviderTemplate, extractRootUrl;
  before(() => {
    // provider-parser depends on models (SegmentConfig, Schema)
    // load models first into the same sandbox
    const combined = loadModule('models.js');
    const ppExports = loadModule('provider-parser.js', {
      SegmentConfig: combined.SegmentConfig,
      Schema: combined.Schema,
    });
    parseProviderTemplate = ppExports.parseProviderTemplate;
    extractRootUrl = ppExports.extractRootUrl;
  });

  it('parses suffix TV template → urlTemplate', () => {
    const r = parseProviderTemplate(
      '(id, s, e) => `https://vidsrc.to/embed/tv/${n(id)}/${s}/${e}`'
    );
    assert.ok(r);
    assert.ok(r.includes('{imdb}') || r.includes('{tmdb}'));
    assert.ok(r.includes('{season}'));
    assert.ok(r.includes('{episode}'));
  });

  it('parses query TV template → urlTemplate', () => {
    const r = parseProviderTemplate(
      '(id, s, e) => `https://x.com/embed?imdb=${n(id)}&s=${s}&e=${e}`'
    );
    assert.ok(r);
    assert.ok(r.includes('{imdb}'));
    assert.ok(r.includes('{season}'));
    assert.ok(r.includes('{episode}'));
  });

  it('parses movie template → urlTemplate', () => {
    const r = parseProviderTemplate(
      '(id) => `https://vidsrc.to/embed/movie/${n(id)}`'
    );
    assert.ok(r);
  });

  it('extractRootUrl from movie + TV templates', () => {
    const root = extractRootUrl(
      'https://vidsrc.to/embed/movie/${n(id)}',
      'https://vidsrc.to/embed/tv/${n(id)}/${s}/${e}'
    );
    // root includes the path up to the segment before the ID
    assert.equal(root, 'https://vidsrc.to/embed/');
  });
});
