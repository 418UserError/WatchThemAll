/**
 * ReelVault — provider-parser.js
 * Parses tmdb-embed-providers TypeScript URL templates into ReelVault Schema format.
 */

/**
 * Parse a provider URL template string into a urlTemplate string.
 * @param {string} template
 * @returns {string|null} urlTemplate
 */
function parseProviderTemplate(template) {
  if (!template) return null;

  // Extract the key name for the ID parameter from query format templates
  let idKey = 'imdb';
  const idMatch = template.match(/[?&]([^=&]+)=\$\{n\(id\)\}/);
  if (idMatch) idKey = idMatch[1];

  // Replace placeholders with our template variables
  return template
    .replace(/\$\{n\(id\)\}/g, `{${idKey}}`)
    .replace(/\$\{s\}/g, '{season}')
    .replace(/\$\{e\}/g, '{episode}');
}

/**
 * Extract the root URL from a provider template.
 * Everything up to and including the path before the ID placeholder.
 */
function extractRootUrl(movieTemplate, tvTemplate) {
  // Use movie template first, fallback to TV
  const tpl = movieTemplate || tvTemplate;
  if (!tpl) return '';

  let clean = tpl.replace(/\$\{n\(id\)\}/g, 'IMDBID');
  clean = clean.replace(/\$\{s\}/g, '1').replace(/\$\{e\}/g, '1');
  clean = clean.replace(/\?.*$/, ''); // strip query string

  let url;
  try { url = new URL(clean); } catch (_) { return ''; }

  const parts = url.pathname.split('/').filter(Boolean);
  const imdbIdx = parts.findIndex(p => p === 'IMDBID');

  if (imdbIdx === -1) return url.origin + '/';

  // Root is everything up to but not including the segment that precedes IMDBID
  const rootParts = parts.slice(0, imdbIdx - 1 >= 0 ? imdbIdx - 1 : 0);
  return url.origin + '/' + (rootParts.length ? rootParts.join('/') + '/' : '');
}
