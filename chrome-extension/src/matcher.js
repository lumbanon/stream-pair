// Pair finding over the tiles remembered in the current level.
//
// Identical mode:  X and Y pair if their fingerprints are near each other
//                  (hash Hamming <= threshold AND histogram similar).
// Complement mode: X and Y pair if some learned entry {a, b} has X~a and
//                  Y~b, or X~b and Y~a.
// Auto:            both; identical candidates win ties.
//
// A greedy assignment (best score first, each tile used once) turns the
// candidate list into a clean list of pairs to type.
(() => {
  const SP = (globalThis.SP = globalThis.SP || {});
  if (SP.matcher) return;

  const COLORS = ['#ff4d4f', '#40a9ff', '#73d13d', '#ffc53d', '#b37feb', '#36cfc9',
    '#ff85c0', '#ff9c6e', '#95de64', '#69c0ff', '#ffd666', '#5cdbd3', '#d3adf7', '#ffa940'];

  function vetoed(x, y, nonPairs, pairSeen, S) {
    const c = SP.hash.compare;
    return nonPairs.some((e) => (e.timesSeen || 1) >= pairSeen &&
      ((c(e.a, x.fp, S).near && c(e.b, y.fp, S).near) || (c(e.a, y.fp, S).near && c(e.b, x.fp, S).near)));
  }

  /**
   * tiles:  memory.rememberedTiles() (have fp, still in play)
   * db:     { pairs, nonPairs } from the learner cache
   * Returns { known: [{a, b, kind, score, color}], half: [{tile, partnerThumb, kind}] }
   * where a/b are tile objects.
   */
  function findPairs(tiles, db, S) {
    const c = SP.hash.compare;
    const mode = S.mode || 'auto';
    const cands = [];

    if (mode === 'identical' || mode === 'auto') {
      for (let i = 0; i < tiles.length; i++) {
        for (let j = i + 1; j < tiles.length; j++) {
          const r = c(tiles[i].fp, tiles[j].fp, S);
          if (r.near) cands.push({ a: tiles[i], b: tiles[j], kind: 'identical', score: (r.t != null ? r.t / 4 : r.d) - 4 * r.h });
        }
      }
    }

    // For each tile, which learned entries/sides it resembles.
    const sideHits = new Map(); // tile.i -> [{ entry, side: 'a'|'b', d }]
    if (mode === 'complement' || mode === 'auto') {
      for (const t of tiles) {
        const hits = [];
        for (const e of db.pairs || []) {
          const ra = c(e.a, t.fp, S), rb = c(e.b, t.fp, S);
          if (ra.near) hits.push({ entry: e, side: 'a', d: ra.t != null ? ra.t / 4 : ra.d });
          if (rb.near) hits.push({ entry: e, side: 'b', d: rb.t != null ? rb.t / 4 : rb.d });
        }
        if (hits.length) sideHits.set(t.i, hits);
      }
      for (let i = 0; i < tiles.length; i++) {
        const hi = sideHits.get(tiles[i].i);
        if (!hi) continue;
        for (let j = 0; j < tiles.length; j++) {
          if (i === j) continue;
          const hj = sideHits.get(tiles[j].i);
          if (!hj) continue;
          for (const x of hi) {
            if (x.side !== 'a') continue; // tile i plays side a, tile j side b
            const y = hj.find((h) => h.entry === x.entry && h.side === 'b');
            if (!y) continue;
            const seen = x.entry.timesSeen || 1;
            if (vetoed(tiles[i], tiles[j], db.nonPairs || [], seen, S)) continue;
            // Lower = better. Frequently confirmed pairs get a bonus.
            cands.push({ a: tiles[i], b: tiles[j], kind: 'complement', score: x.d + y.d - Math.min(6, Math.log2(1 + seen)) + 2 });
          }
        }
      }
    }

    cands.sort((p, q) => p.score - q.score);
    const used = new Set();
    const known = [];
    for (const p of cands) {
      if (used.has(p.a.i) || used.has(p.b.i)) continue;
      used.add(p.a.i); used.add(p.b.i);
      known.push(p);
    }
    known.sort((p, q) => Math.min(p.a.num, p.b.num) - Math.min(q.a.num, q.b.num));
    known.forEach((p, k) => { p.color = COLORS[k % COLORS.length]; });

    // Half-known: seen tile, partner not seen yet. In complement mode we may
    // already know what the partner looks like from the DB.
    const half = [];
    for (const t of tiles) {
      if (used.has(t.i)) continue;
      const hits = sideHits.get(t.i);
      let partnerThumb = null;
      if (hits && hits.length) {
        const best = hits.slice().sort((p, q) => p.d - q.d)[0];
        partnerThumb = (best.side === 'a' ? best.entry.b : best.entry.a).thumb || null;
      }
      half.push({ tile: t, partnerThumb, kind: partnerThumb ? 'complement' : 'unknown' });
    }
    half.sort((p, q) => p.tile.num - q.tile.num);
    return { known, half };
  }

  /** Plain, message-safe summary for the popup. */
  function summarize(result) {
    return {
      known: result.known.map((p) => {
        const [x, y] = p.a.num <= p.b.num ? [p.a, p.b] : [p.b, p.a];
        return { a: x.num, b: y.num, kind: p.kind, color: p.color, thumbA: x.thumb, thumbB: y.thumb };
      }),
      half: result.half.map((h) => ({ num: h.tile.num, thumb: h.tile.thumb, partnerThumb: h.partnerThumb, kind: h.kind })),
    };
  }

  SP.matcher = { findPairs, summarize, COLORS };
})();
