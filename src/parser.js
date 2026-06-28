/**
 * ReelVault — parser.js
 * Maps IMDB suggestion API qid values to 'tv' or 'movie'.
 */

function imdbType(qid) {
  if (!qid) return 'tv';
  if (/^(tvSeries|tvMiniSeries|tvSpecial)$/i.test(qid)) return 'tv';
  if (/^(movie|short|video)$/i.test(qid)) return 'movie';
  return 'tv';
}
