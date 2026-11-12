/**
 * Matching.gs — tolerant SKU matching.
 *
 * Lesson from a real team script: an exact filename/keyword match breaks as soon as one
 * person types one character differently. Here a typed SKU is matched in three steps,
 * and only against the SKUs on the same PO, which keeps the fuzzy step safe:
 *
 *   1. exact        "FW-7160"  = "FW-7160"
 *   2. normalized   "fw7160", "FW 7160", "FW-716O" (letter O)  ->  "FW-7160"
 *   3. fuzzy        "FW-1760" (swapped), "FW-716" (cut off)    ->  "FW-7160"
 *                   only if exactly one SKU on the PO is that close
 */

/** Uppercase, drop everything except letters/digits, read letter O as zero. */
function normalizeSku_(sku) {
  return String(sku || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/O/g, '0');
}

/**
 * Edit distance where a swap of two neighbouring characters counts as one edit
 * (optimal string alignment / restricted Damerau-Levenshtein).
 */
function editDistance_(a, b) {
  const m = a.length, n = b.length;
  const d = [];
  for (let i = 0; i <= m; i++) {
    d.push(new Array(n + 1).fill(0));
    d[i][0] = i;
  }
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[m][n];
}

/**
 * Decides which of `candidates` (real SKUs) the `typed` SKU refers to.
 * @return {{sku: string|null, method: string, distance: number, candidates: string[]}}
 *         method is 'exact' | 'normalized' | 'fuzzy' | 'ambiguous' | 'none'
 */
function matchSku_(typed, candidates, maxEdits) {
  const raw = String(typed || '').trim();
  if (candidates.indexOf(raw) !== -1) {
    return { sku: raw, method: 'exact', distance: 0, candidates: [raw] };
  }

  const key = normalizeSku_(raw);
  const sameKey = candidates.filter(c => normalizeSku_(c) === key);
  if (sameKey.length === 1) return { sku: sameKey[0], method: 'normalized', distance: 0, candidates: sameKey };
  if (sameKey.length > 1) return { sku: null, method: 'ambiguous', distance: 0, candidates: sameKey };

  let best = Infinity;
  let closest = [];
  candidates.forEach(c => {
    const dist = editDistance_(key, normalizeSku_(c));
    if (dist < best) { best = dist; closest = [c]; }
    else if (dist === best) closest.push(c);
  });
  if (best <= maxEdits && closest.length === 1) {
    return { sku: closest[0], method: 'fuzzy', distance: best, candidates: closest };
  }
  if (best <= maxEdits) return { sku: null, method: 'ambiguous', distance: best, candidates: closest };
  return { sku: null, method: 'none', distance: best, candidates: [] };
}
