// Image fingerprinting: box-averaged resampling, dHash, pHash, colour
// histograms and small per-tile "signatures" used by reveal detection.
//
// Everything here works on plain ImageData so it runs in the content script,
// the service worker (for DB de-duplication) and extension pages alike.
(() => {
  const SP = (globalThis.SP = globalThis.SP || {});
  if (SP.hash) return;

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  /**
   * Resample `rect` (pixel coords) of `img` into an outW x outH RGB grid.
   *
   * Each output cell is the *average* of the source pixels it covers (a box
   * filter), not a single picked pixel. Averaging removes most video
   * compression noise and makes the result nearly independent of capture
   * resolution, which keeps the hashes below stable between frames and between
   * streams. Large cells are sub-sampled on a ~4x4 lattice to stay cheap.
   */
  function sampleRGB(img, rect, outW, outH) {
    const { data, width, height } = img;
    // Intersect with the image (a cell can poke past the crop edge when the
    // border is drawn tightly). Clamping only the origin would SHIFT the
    // sampled region instead of trimming it.
    const rx = clamp(rect.x, 0, width - 1);
    const ry = clamp(rect.y, 0, height - 1);
    const rw = Math.max(1, Math.min(rect.x + rect.w, width) - rx);
    const rh = Math.max(1, Math.min(rect.y + rect.h, height) - ry);
    const out = new Float32Array(outW * outH * 3);
    const cw = rw / outW;
    const ch = rh / outH;
    for (let oy = 0; oy < outH; oy++) {
      const sy0 = Math.floor(ry + oy * ch);
      const sy1 = Math.min(height, Math.max(sy0 + 1, Math.floor(ry + (oy + 1) * ch)));
      const stepY = Math.max(1, ((sy1 - sy0) / 4) | 0);
      for (let ox = 0; ox < outW; ox++) {
        const sx0 = Math.floor(rx + ox * cw);
        const sx1 = Math.min(width, Math.max(sx0 + 1, Math.floor(rx + (ox + 1) * cw)));
        const stepX = Math.max(1, ((sx1 - sx0) / 4) | 0);
        let r = 0, g = 0, b = 0, n = 0;
        for (let y = sy0; y < sy1; y += stepY) {
          let k = (y * width + sx0) * 4;
          for (let x = sx0; x < sx1; x += stepX, k += stepX * 4) {
            r += data[k]; g += data[k + 1]; b += data[k + 2]; n++;
          }
        }
        const o = (oy * outW + ox) * 3;
        if (n) { out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; }
      }
    }
    return out;
  }

  /** RGB triplets -> luma (ITU-R BT.601 weights). */
  function toGray(rgb) {
    const n = rgb.length / 3;
    const g = new Float32Array(n);
    for (let i = 0, k = 0; i < n; i++, k += 3) g[i] = 0.299 * rgb[k] + 0.587 * rgb[k + 1] + 0.114 * rgb[k + 2];
    return g;
  }

  function sampleGray(img, rect, w, h) { return toGray(sampleRGB(img, rect, w, h)); }

  const HEX = '0123456789abcdef';
  function bitsToHex(bits) {
    let s = '';
    for (let i = 0; i < bits.length; i += 4) s += HEX[(bits[i] << 3) | (bits[i + 1] << 2) | (bits[i + 2] << 1) | bits[i + 3]];
    return s;
  }

  /**
   * dHash ("difference hash"), 64 bits.
   * Shrink to 9x8 grey, then for each row emit 1 if a pixel is darker than its
   * right neighbour. It encodes the *gradient structure* of the picture, so it
   * survives brightness/contrast shifts, mild blur and re-encoding, but changes
   * a lot when the depicted object changes.
   *
   * Variant: a bit is 1 only if the right neighbour is brighter by more than
   * DHASH_EPS grey levels. Plain "<" makes every flat area (plain tile
   * backgrounds are common) a coin flip decided by compression noise; the
   * dead-zone makes flat areas consistently 0.
   */
  const DHASH_EPS = 3;
  function dHash(img, rect) {
    const g = sampleGray(img, rect, 9, 8);
    const bits = new Uint8Array(64);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits[y * 8 + x] = g[y * 9 + x + 1] - g[y * 9 + x] > DHASH_EPS ? 1 : 0;
    return bitsToHex(bits);
  }

  /**
   * Vertical dHash: same idea down the columns (8x9 grey, top vs bottom).
   * Plain dHash only sees left/right gradients, so pictures made of
   * horizontal bands (many flags: Belarus, Russia, Netherlands...) all hash
   * to 0000000000000000 and become indistinguishable. Comparing both
   * directions fixes that.
   */
  function dHashV(img, rect) {
    const g = sampleGray(img, rect, 8, 9);
    const bits = new Uint8Array(64);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits[y * 8 + x] = g[(y + 1) * 8 + x] - g[y * 8 + x] > DHASH_EPS ? 1 : 0;
    return bitsToHex(bits);
  }

  // Cosine table for a 32-point DCT-II, only the first 8 frequencies are needed.
  const DCT_N = 32;
  const DCT_K = 8;
  const COS = (() => {
    const t = new Float32Array(DCT_K * DCT_N);
    for (let u = 0; u < DCT_K; u++) for (let x = 0; x < DCT_N; x++) t[u * DCT_N + x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * DCT_N));
    return t;
  })();

  /**
   * pHash ("perceptual hash"), 64 bits.
   * Shrink to 32x32 grey, take the 2-D DCT, keep the 8x8 lowest frequencies
   * (overall shape and layout of the picture) and emit 1 for every coefficient
   * above their median. More robust than dHash to small shifts/crops, a bit
   * more expensive. The DCT is separable: rows first, then columns.
   */
  function pHash(img, rect) {
    const g = sampleGray(img, rect, DCT_N, DCT_N);
    const tmp = new Float32Array(DCT_N * DCT_K); // [y][u]
    for (let y = 0; y < DCT_N; y++) {
      for (let u = 0; u < DCT_K; u++) {
        let s = 0;
        for (let x = 0; x < DCT_N; x++) s += g[y * DCT_N + x] * COS[u * DCT_N + x];
        tmp[y * DCT_K + u] = s;
      }
    }
    const coef = new Float32Array(DCT_K * DCT_K); // [v][u]
    for (let v = 0; v < DCT_K; v++) {
      for (let u = 0; u < DCT_K; u++) {
        let s = 0;
        for (let y = 0; y < DCT_N; y++) s += tmp[y * DCT_K + u] * COS[v * DCT_N + y];
        coef[v * DCT_K + u] = s;
      }
    }
    // Median excluding the DC term (it is just the average brightness).
    const sorted = Array.from(coef.subarray(1)).sort((a, b) => a - b);
    const med = sorted[(sorted.length / 2) | 0];
    const bits = new Uint8Array(64);
    for (let i = 0; i < 64; i++) bits[i] = coef[i] > med ? 1 : 0;
    return bitsToHex(bits);
  }

  const POP4 = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];
  /** Hamming distance between two 16-char hex hashes (0..64). Missing = 64. */
  function hamming(a, b) {
    if (!a || !b || a.length !== b.length) return 64;
    let d = 0;
    for (let i = 0; i < a.length; i++) d += POP4[parseInt(a[i], 16) ^ parseInt(b[i], 16)];
    return d;
  }

  /** 4x4x4-bin RGB histogram (64 bins, sums to 1) from sampled RGB triplets. */
  function histogram(rgb) {
    const h = new Float32Array(64);
    const n = rgb.length / 3;
    for (let k = 0; k < rgb.length; k += 3) {
      const bin = ((rgb[k] >> 6) << 4) | ((rgb[k + 1] >> 6) << 2) | (rgb[k + 2] >> 6);
      h[bin] += 1;
    }
    for (let i = 0; i < 64; i++) h[i] /= n || 1;
    return h;
  }

  /** Histogram intersection: 1 = identical colour distribution, 0 = disjoint. */
  function histSim(a, b) {
    if (!a || !b) return 0;
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] < b[i] ? a[i] : b[i];
    return s;
  }

  /** Mean absolute difference between two equal-length arrays. */
  function mad(a, b) {
    if (!a || !b || a.length !== b.length) return 255;
    let s = 0;
    for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
    return s / a.length;
  }

  function meanStd(arr) {
    let m = 0;
    for (let i = 0; i < arr.length; i++) m += arr[i];
    m /= arr.length || 1;
    let v = 0;
    for (let i = 0; i < arr.length; i++) v += (arr[i] - m) ** 2;
    return { mean: m, std: Math.sqrt(v / (arr.length || 1)) };
  }

  /**
   * Cheap per-frame signature of one tile, used by the reveal state machine:
   * a 16x16 grey thumbnail (for "did it change / is it still moving"), a
   * colour histogram (for "does it still look like a face-down back"), the
   * mean colour and grey std-dev (for "is it now empty background").
   */
  function signature(img, rect) {
    const rgb = sampleRGB(img, rect, 16, 16);
    const gray = toGray(rgb);
    let r = 0, g = 0, b = 0;
    for (let k = 0; k < rgb.length; k += 3) { r += rgb[k]; g += rgb[k + 1]; b += rgb[k + 2]; }
    const n = rgb.length / 3;
    return { gray, hist: histogram(rgb), mean: [r / n, g / n, b / n], std: meanStd(gray).std };
  }

  const round4 = (h) => Array.from(h, (v) => Math.round(v * 10000) / 10000);

  /** Item fingerprint saved when a tile is revealed. JSON-serialisable. */
  function fingerprint(img, rect) {
    return {
      dhash: dHash(img, rect),
      dhashv: dHashV(img, rect),
      phash: pHash(img, rect),
      hist: round4(histogram(sampleRGB(img, rect, 24, 24))),
    };
  }

  /** Small JPEG data URL of `rect` from a canvas/OffscreenCanvas (DOM only). */
  function thumbnail(source, rect, size = 48) {
    if (typeof document === 'undefined') return null;
    const c = document.createElement('canvas');
    const ar = rect.w / rect.h || 1;
    c.width = ar >= 1 ? size : Math.round(size * ar);
    c.height = ar >= 1 ? Math.round(size / ar) : size;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, rect.x, rect.y, rect.w, rect.h, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.8);
  }

  /**
   * Distance between two fingerprints under the active settings.
   * Returns { d: hamming, h: histSim, near: boolean }.
   */
  function compare(a, b, S) {
    const type = S.hashType || 'dhash';
    let d = hamming(a && a[type], b && b[type]);
    // dHash: average the horizontal and vertical distances when both exist
    // (entries saved by older versions only have the horizontal one).
    if (type === 'dhash' && a && b && a.dhashv && b.dhashv) d = Math.round((d + hamming(a.dhashv, b.dhashv)) / 2);
    const h = histSim(a && a.hist, b && b.hist);
    return { d, h, near: d <= S.hashThreshold && h >= S.histMin };
  }

  function colorDist(a, b) {
    if (!a || !b) return 999;
    return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
  }

  SP.hash = {
    sampleRGB, sampleGray, toGray, dHash, dHashV, pHash, hamming, histogram, histSim,
    mad, meanStd, signature, fingerprint, thumbnail, compare, colorDist,
  };
})();
