// Shared by autoAssign.js's live candidate ranking and evaluationMetrics.js's
// department-relative employee scoring: min-max normalizes a list of raw
// values onto [0,1]. A value the caller doesn't have data for yet (null), or
// a pool with fewer than two data points to compare, normalizes to 0.5 --
// neutral, neither rewarded nor punished, rather than an artificial best or
// worst (a lone data point would otherwise always min-max to "best").
function normalize(values) {
  const known = values.filter((v) => v !== null);
  if (known.length < 2) return values.map(() => 0.5);
  const min = Math.min(...known);
  const max = Math.max(...known);
  return values.map((v) => (v === null ? 0.5 : max > min ? (v - min) / (max - min) : 0.5));
}

module.exports = { normalize };
