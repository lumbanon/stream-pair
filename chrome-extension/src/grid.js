// Grid geometry: manual rows x cols, or auto-detection from projections.
//
// A grid is { rows, cols, source, cells: [{ i, r, c, x, y, w, h }] } where the
// cell rectangles are FRACTIONS (0..1) of the captured board crop. Storing
// fractions makes the grid independent of the capture resolution (video
// frame vs. screenshot, different stream qualities, window sizes).
(() => {
  const SP = (globalThis.SP = globalThis.SP || {});
  if (SP.grid) return;

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
   *    above it, merge runs split by tiny dips (dark artwork inside a tile),
   *    and drop slivers much narrower than the typical tile.
   *  - The result is validated: tiles in a grid are similar in size, so a
   *    high coefficient of variation means the projection was not a grid.
   *
   * Returns [[start, end], ...] in fractions, or null.
   */
  function segmentsFromProjection(proj) {
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
    const minGap = Math.max(1, Math.round(n * 0.012));
    const merged = [runs[0]];
    for (let k = 1; k < runs.length; k++) {
      const last = merged[merged.length - 1];
      if (runs[k][0] - last[1] < minGap) last[1] = runs[k][1];
      else merged.push(runs[k]);
    }
    const widths = merged.map((r) => r[1] - r[0]);
    const med = percentile(widths, 0.5);
    runs = merged.filter((r) => r[1] - r[0] >= 0.45 * med);
    if (runs.length < 2 || runs.length > 15) return null;
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
    const minLag = Math.max(3, Math.floor(n / 16));
    const maxLag = Math.floor(n / 2);
    let e0 = 0;
    for (let i = 0; i < n; i++) e0 += e[i] * e[i];
    if (!e0) return 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let s = 0;
      for (let i = 0; i + lag < n; i++) s += e[i] * e[i + lag];
      s /= e0 * ((n - lag) / n);
      if (s > best) { best = s; bestLag = lag; }
    }
    if (best < 0.25 || !bestLag) return 0;
    const count = Math.round(n / bestLag);
    return count >= 2 && count <= 15 ? count : 0;
  }

  /**
   * Auto-detect the tile grid from an ImageData of the board crop.
   *
   * 1. Estimate the backdrop colour from the crop border.
   * 2. Foreground mask: pixel colour differs from the backdrop by > 60
   *    (sum of |dR|+|dG|+|dB|).
   * 3. Column projection = fraction of foreground pixels in each column, row
   *    projection likewise. Tile columns/rows show up as plateaus.
   * 4. Segment each projection (segmentsFromProjection). If that fails for an
   *    axis, fall back to edge periodicity (countFromPeriodicity) and split
   *    that axis evenly.
   *
   * Works at a reduced resolution (~320 px wide) because only coarse
   * structure matters.
   */
  function detect(img) {
    const { data, width: W, height: H } = img;
    if (W < 20 || H < 20) return null;
    const bg = estimateBackground(img);
    const s = Math.max(1, Math.floor(W / 320));
    const nx = Math.floor(W / s), ny = Math.floor(H / s);
    const col = new Float32Array(nx), row = new Float32Array(ny);
    const colEdge = new Float32Array(nx), rowEdge = new Float32Array(ny);
    const lum = new Float32Array(nx * ny);
    for (let yi = 0; yi < ny; yi++) {
      const y = yi * s;
      for (let xi = 0; xi < nx; xi++) {
        const k = (y * W + xi * s) * 4;
        const r = data[k], g = data[k + 1], b = data[k + 2];
        lum[yi * nx + xi] = 0.299 * r + 0.587 * g + 0.114 * b;
        if (Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(b - bg[2]) > 60) { col[xi]++; row[yi]++; }
      }
    }
    for (let i = 0; i < nx; i++) col[i] /= ny;
    for (let i = 0; i < ny; i++) row[i] /= nx;
    for (let yi = 1; yi < ny; yi++) {
      for (let xi = 1; xi < nx; xi++) {
        const v = lum[yi * nx + xi];
        colEdge[xi] += Math.abs(v - lum[yi * nx + xi - 1]);
        rowEdge[yi] += Math.abs(v - lum[(yi - 1) * nx + xi]);
      }
    }

    let colSegs = segmentsFromProjection(col);
    let rowSegs = segmentsFromProjection(row);
    let source = 'auto-projection';
    if (!colSegs) {
      const n = countFromPeriodicity(colEdge);
      if (n) { colSegs = Array.from({ length: n }, (_, c) => [c / n, (c + 1) / n]); source = 'auto-periodic'; }
    }
    if (!rowSegs) {
      const n = countFromPeriodicity(rowEdge);
      if (n) { rowSegs = Array.from({ length: n }, (_, r) => [r / n, (r + 1) / n]); source = 'auto-periodic'; }
    }
    if (!colSegs || !rowSegs) return null;
    return { rows: rowSegs.length, cols: colSegs.length, source, cells: makeCells(colSegs, rowSegs), bg };
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
