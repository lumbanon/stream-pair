// Grid geometry: manual rows x cols, or auto-detection from projections.
//
// A grid is { rows, cols, source, cells: [{ i, r, c, x, y, w, h }] } where the
// cell rectangles are FRACTIONS (0..1) of the captured board crop. Storing
// fractions makes the grid independent of the capture resolution (video
// frame vs. screenshot, different stream qualities, window sizes).
(() => {
  const SP = (globalThis.SP = globalThis.SP || {});
  if (SP.grid) return;

  // Largest rows/cols count accepted. Later levels use more, smaller cards.
  const MAX_CELLS = 20;

  function makeCells(colSegs, rowSegs) {
    const cells = [];
    rowSegs.forEach((rs, r) => colSegs.forEach((cs, c) => {
      cells.push({ i: cells.length, r, c, x: cs[0], y: rs[0], w: cs[1] - cs[0], h: rs[1] - rs[0] });
    }));
    return cells;
  }

  /** Evenly split the area into rows x cols (reading order: left->right, top->bottom). */
  function uniform(rows, cols) {
    rows = Math.max(1, rows | 0);
    cols = Math.max(1, cols | 0);
    const cs = Array.from({ length: cols }, (_, c) => [c / cols, (c + 1) / cols]);
    const rs = Array.from({ length: rows }, (_, r) => [r / rows, (r + 1) / rows]);
    return { rows, cols, source: 'manual', cells: makeCells(cs, rs) };
  }

  /**
   * Background colour of the board = per-channel median of a ring of pixels
   * just inside the crop edge. The user draws the border around the board, so
   * the ring is mostly the board's backdrop rather than tiles.
   */
  function estimateBackground(img) {
    const { data, width: W, height: H } = img;
    const rs = [], gs = [], bs = [];
    const push = (x, y) => { const k = (y * W + x) * 4; rs.push(data[k]); gs.push(data[k + 1]); bs.push(data[k + 2]); };
    const mx = Math.max(1, Math.round(W * 0.01));
    const my = Math.max(1, Math.round(H * 0.01));
    const stepX = Math.max(1, (W / 120) | 0);
    const stepY = Math.max(1, (H / 120) | 0);
    for (let x = 0; x < W; x += stepX) { push(x, my); push(x, H - 1 - my); }
    for (let y = 0; y < H; y += stepY) { push(mx, y); push(W - 1 - mx, y); }
    const med = (a) => a.sort((p, q) => p - q)[(a.length / 2) | 0] || 0;
    return [med(rs), med(gs), med(bs)];
  }

  function smooth(p) {
    const o = new Float32Array(p.length);
    for (let i = 0; i < p.length; i++) {
      const a = p[i - 1] ?? p[i], b = p[i + 1] ?? p[i];
      o[i] = (a + 2 * p[i] + b) / 4;
    }
    return o;
  }

  function percentile(arr, q) {
    const s = Array.from(arr).sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(q * s.length))] || 0;
  }

  /**
   * Turn a 1-D "how much tile is in this column (or row)" projection into
   * tile segments.
   *
   *  - Columns that cross a column of tiles have a high foreground fraction;
   *    the gutters between tiles are mostly background, so they dip.
   *  - Threshold at 40% of the robust maximum (95th percentile), collect runs
   *    above it, merge runs split by dips narrower than minGapFrac of the
   *    axis (dark artwork inside a tile), and drop slivers much narrower than
   *    the typical tile. Real gutters can be very thin (Stream Pairs rows are
   *    ~1% of the board apart), so detect() tries several minGapFrac values
   *    and lets scoreGrid() choose.
   *  - The result is validated: tiles in a grid are similar in size, so a
   *    high coefficient of variation means the projection was not a grid.
   *
   * Returns [[start, end], ...] in fractions, or null.
   */
  function segmentsFromProjection(proj, minGapFrac = 0.012) {
    const n = proj.length;
    const p = smooth(proj);
    const top = percentile(p, 0.95);
    if (top < 0.08) return null;
    const thr = top * 0.4;
    let runs = [];
    let start = -1;
    for (let i = 0; i <= n; i++) {
      const on = i < n && p[i] > thr;
      if (on && start < 0) start = i;
      if (!on && start >= 0) { runs.push([start, i]); start = -1; }
    }
    if (!runs.length) return null;
    const minGap = Math.max(1, Math.round(n * minGapFrac));
    const merged = [runs[0]];
    for (let k = 1; k < runs.length; k++) {
      const last = merged[merged.length - 1];
      if (runs[k][0] - last[1] < minGap) last[1] = runs[k][1];
      else merged.push(runs[k]);
    }
    const widths = merged.map((r) => r[1] - r[0]);
    const med = percentile(widths, 0.5);
    runs = merged.filter((r) => r[1] - r[0] >= 0.45 * med);
    if (runs.length < 2 || runs.length > MAX_CELLS) return null;
    const ws = runs.map((r) => r[1] - r[0]);
    const { mean, std } = SP.hash.meanStd(ws);
    if (std / mean > 0.35) return null;
    return runs.map(([a, b]) => [a / n, b / n]);
  }

  /**
   * Fallback when tiles touch each other or have the same colour as the
   * backdrop: tile EDGES are still periodic. Build an edge-energy projection
   * (sum of |dI/dx| per column, or |dI/dy| per row), then find its dominant
   * period with autocorrelation. count = length / period, cells uniform.
   */
  function countFromPeriodicity(edge) {
    const n = edge.length;
    const { mean } = SP.hash.meanStd(edge);
    const e = edge.map((v) => v - mean);
    let best = 0, bestLag = 0;
    const minLag = Math.max(3, Math.floor(n / (MAX_CELLS + 1)));
    const maxLag = Math.floor(n / 2);
    let e0 = 0;
    for (let i = 0; i < n; i++) e0 += e[i] * e[i];
    if (!e0) return 0;
    const ac = new Float32Array(maxLag + 2);
    for (let lag = minLag; lag <= maxLag; lag++) {
      let s = 0;
      for (let i = 0; i + lag < n; i++) s += e[i] * e[i + lag];
      s /= e0 * ((n - lag) / n);
      ac[lag] = s;
      if (s > best) { best = s; bestLag = lag; }
    }
    if (best < 0.25 || !bestLag) return 0;
    // Multiples of the true period correlate as well as the period itself
    // (2x or 3x the tile pitch also lines tiles up). Prefer the SMALLEST lag
    // that is a local peak and nearly as strong as the best one.
    for (let lag = minLag + 1; lag < bestLag; lag++) {
      if (ac[lag] >= 0.85 * best && ac[lag] >= ac[lag - 1] && ac[lag] >= ac[lag + 1]) { bestLag = lag; break; }
    }
    const count = Math.round(n / bestLag);
    return count >= 2 && count <= MAX_CELLS ? count : 0;
  }

  /**
   * The two dominant colours of the crop (2-means on ~4000 sampled pixels,
   * seeded with the darkest and brightest sample). On a Stream Pairs board
   * these are typically "backdrop" and "tile face".
   */
  function dominantColors(img) {
    const { data, width: W, height: H } = img;
    const step = Math.max(1, Math.floor(Math.sqrt((W * H) / 4000)));
    const px = [];
    for (let y = 0; y < H; y += step) for (let x = 0; x < W; x += step) {
      const k = (y * W + x) * 4;
      px.push([data[k], data[k + 1], data[k + 2]]);
    }
    const lum = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
    let a = px[0], b = px[0];
    for (const c of px) { if (lum(c) < lum(a)) a = c; if (lum(c) > lum(b)) b = c; }
    let ca = a.slice(), cb = b.slice();
    for (let it = 0; it < 8; it++) {
      const sa = [0, 0, 0, 0], sb = [0, 0, 0, 0];
      for (const c of px) {
        const t = SP.hash.colorDist(c, ca) <= SP.hash.colorDist(c, cb) ? sa : sb;
        t[0] += c[0]; t[1] += c[1]; t[2] += c[2]; t[3]++;
      }
      if (sa[3]) ca = [sa[0] / sa[3], sa[1] / sa[3], sa[2] / sa[3]];
      if (sb[3]) cb = [sb[0] / sb[3], sb[1] / sb[3], sb[2] / sb[3]];
    }
    return [ca, cb];
  }

  /**
   * Plausibility score of a candidate grid. Real boards have:
   *  - tiles covering most of each axis (gutters are thin),
   *  - evenly sized tiles (low coefficient of variation),
   *  - roughly square tiles.
   * The classic failure (backdrop colour mistaken for tile colour) turns the
   * thin gutters into "tiles": coverage collapses and the score with it.
   */
  function scoreGrid(colSegs, rowSegs, W, H, periodic) {
    const axis = (segs) => {
      const w = segs.map((s) => s[1] - s[0]);
      const { mean, std } = SP.hash.meanStd(w);
      const cov = w.reduce((x, v) => x + v, 0);
      return { cov, cv: mean ? std / mean : 1, med: percentile(w, 0.5) };
    };
    const ax = axis(colSegs), ay = axis(rowSegs);
    const aspect = (ax.med * W) / (ay.med * H || 1);
    let score = Math.min(ax.cov, 0.97) + Math.min(ay.cov, 0.97) - ax.cv - ay.cv - 1.5 * Math.abs(Math.log(aspect || 1e-3));
    if (ax.cov < 0.45) score -= 2;
    if (ay.cov < 0.45) score -= 2;
    return score - 0.6 * periodic;
  }

  /**
   * Auto-detect the tile grid from an ImageData of the board crop.
   *
   * 1. Background candidates: the colour of a ring just inside the crop edge,
   *    plus the two dominant colours of the crop. The ring alone is NOT
   *    enough: when the border is drawn tightly around the tiles, the ring
   *    lies on the tiles and "background" would be the tile colour, which
   *    inverts everything (gutters detected as tiles).
   * 2. For each candidate: foreground mask = pixel differs from it by > 60
   *    (sum of |dR|+|dG|+|dB|); column projection = fraction of foreground
   *    pixels per column, row projection likewise. Tile columns/rows show up
   *    as plateaus separated by gutter dips.
   * 3. Segment each projection (segmentsFromProjection). If that fails for an
   *    axis, fall back to edge periodicity (countFromPeriodicity) and split
   *    that axis evenly.
   * 4. Keep the candidate with the best scoreGrid().
   *
   * Works at a reduced resolution (~320 px wide) because only coarse
   * structure matters.
   */
  function detect(img) {
    const { data, width: W, height: H } = img;
    if (W < 20 || H < 20) return null;
    // ~640 samples across: later levels have smaller cards and gutters only a
    // pixel or two wide at analysis resolution.
    const s = Math.max(1, Math.floor(W / 640));
    const nx = Math.floor(W / s), ny = Math.floor(H / s);

    // Edge-energy projections (independent of the background guess).
    const lum = new Float32Array(nx * ny);
    for (let yi = 0; yi < ny; yi++) for (let xi = 0; xi < nx; xi++) {
      const k = (yi * s * W + xi * s) * 4;
      lum[yi * nx + xi] = 0.299 * data[k] + 0.587 * data[k + 1] + 0.114 * data[k + 2];
    }
    const colEdge = new Float32Array(nx), rowEdge = new Float32Array(ny);
    for (let yi = 1; yi < ny; yi++) for (let xi = 1; xi < nx; xi++) {
      const v = lum[yi * nx + xi];
      colEdge[xi] += Math.abs(v - lum[yi * nx + xi - 1]);
      rowEdge[yi] += Math.abs(v - lum[(yi - 1) * nx + xi]);
    }
    const periodicSegs = (edge) => {
      const n = countFromPeriodicity(edge);
      return n ? Array.from({ length: n }, (_, i) => [i / n, (i + 1) / n]) : null;
    };

    const candidates = [estimateBackground(img), ...dominantColors(img)]
      .filter((c, i, arr) => arr.findIndex((o) => SP.hash.colorDist(o, c) < 30) === i);

    let best = null;
    for (const bg of candidates) {
      const col = new Float32Array(nx), row = new Float32Array(ny);
      for (let yi = 0; yi < ny; yi++) {
        for (let xi = 0; xi < nx; xi++) {
          const k = (yi * s * W + xi * s) * 4;
          if (Math.abs(data[k] - bg[0]) + Math.abs(data[k + 1] - bg[1]) + Math.abs(data[k + 2] - bg[2]) > 60) { col[xi]++; row[yi]++; }
        }
      }
      for (let i = 0; i < nx; i++) col[i] /= ny;
      for (let i = 0; i < ny; i++) row[i] /= nx;
      // Each axis: try several gutter widths, plus the periodicity fallback.
      const options = (proj, edge) => {
        const out = [];
        for (const g of [0.003, 0.008, 0.015, 0.025]) {
          const segs = segmentsFromProjection(proj, g);
          if (segs && !out.some((o) => o.segs.length === segs.length)) out.push({ segs, periodic: 0 });
        }
        const per = periodicSegs(edge);
        if (per) out.push({ segs: per, periodic: 1 });
        return out;
      };
      for (const cx of options(col, colEdge)) {
        for (const ry of options(row, rowEdge)) {
          const periodic = cx.periodic + ry.periodic;
          const score = scoreGrid(cx.segs, ry.segs, W, H, periodic);
          if (!best || score > best.score) {
            best = { score, colSegs: cx.segs, rowSegs: ry.segs, bg: bg.map((v) => Math.round(v)), source: periodic ? 'auto-periodic' : 'auto-projection' };
          }
        }
      }
    }
    if (!best) return null;
    return {
      rows: best.rowSegs.length, cols: best.colSegs.length, source: best.source,
      cells: makeCells(best.colSegs, best.rowSegs), bg: best.bg, score: Math.round(best.score * 100) / 100,
    };
  }

  /** Cell fraction rect -> pixel rect inside a W x H crop, shrunk by `inset`. */
  function cellToPx(cell, W, H, inset = 0) {
    const ix = cell.w * inset, iy = cell.h * inset;
    return {
      x: Math.round((cell.x + ix) * W),
      y: Math.round((cell.y + iy) * H),
      w: Math.max(1, Math.round((cell.w - 2 * ix) * W)),
      h: Math.max(1, Math.round((cell.h - 2 * iy) * H)),
    };
  }

  SP.grid = { uniform, detect, estimateBackground, cellToPx };
})();
