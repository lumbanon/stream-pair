// Tile-number OCR (content side). The heavy lifting runs in the offscreen
// document (offscreen.js) with the locally bundled Tesseract.js; this file
// prepares the crops and turns raw OCR text into a consistent numbering.
(() => {
  const SP = (globalThis.SP = globalThis.SP || {});
  if (SP.ocr) return;

  /** Otsu's threshold on a 256-bin grey histogram. */
  function otsu(hist, total) {
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, thr = 127;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (!wB) continue;
      const wF = total - wB;
      if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) ** 2;
      if (between > best) { best = between; thr = t; }
    }
    return thr;
  }

  /**
   * Upscale the tile to ~80 px tall, binarise with Otsu and make sure the
   * result is dark digits on a white page (Tesseract's favourite input),
   * with a white margin. Returns a PNG data URL.
   */
  function prepareTile(source, rect) {
    const scale = Math.max(1, Math.min(5, 80 / rect.h));
    const w = Math.round(rect.w * scale), h = Math.round(rect.h * scale);
    const pad = 12;
    const c = document.createElement('canvas');
    c.width = w + pad * 2;
    c.height = h + pad * 2;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, rect.x, rect.y, rect.w, rect.h, pad, pad, w, h);
    const id = ctx.getImageData(pad, pad, w, h);
    const d = id.data;
    const n = w * h;
    const gray = new Uint8Array(n);
    const hist = new Uint32Array(256);
    for (let i = 0, k = 0; i < n; i++, k += 4) {
      const g = (0.299 * d[k] + 0.587 * d[k + 1] + 0.114 * d[k + 2]) | 0;
      gray[i] = g;
      hist[g]++;
    }
    const thr = otsu(hist, n);
    let dark = 0;
    for (let i = 0; i < n; i++) if (gray[i] <= thr) dark++;
    // Digits are the minority of pixels; if "dark" is the majority the
    // number is light-on-dark, so invert.
    const invert = dark > n / 2;
    for (let i = 0, k = 0; i < n; i++, k += 4) {
      let v = gray[i] <= thr ? 0 : 255;
      if (invert) v = 255 - v;
      d[k] = d[k + 1] = d[k + 2] = v;
      d[k + 3] = 255;
    }
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.putImageData(id, pad, pad);
    return c.toDataURL('image/png');
  }

  /** Send prepared images to the offscreen OCR engine. */
  async function recognize(images) {
    const res = await chrome.runtime.sendMessage({ type: 'ocr', images });
    if (!res || res.error) throw new Error((res && res.error) || 'OCR unavailable');
    return res.results; // [{ text, confidence }]
  }

  /**
   * Combine raw OCR reads into one number per tile.
   *
   * - A read is valid if it is 1-3 digits with confidence >= 40.
   * - Duplicate numbers keep only the most confident read.
   * - If fewer than 30% of tiles read cleanly, OCR is not trusted at all and
   *   reading order (1..N) is used.
   * - Otherwise missing tiles are filled from the dominant offset between
   *   OCR number and reading-order index (games usually number 1..N or
   *   0..N-1 in reading order), as long as that number is not taken.
   *
   * raw: array (length N) of {text, confidence} or null (tile not OCR'd).
   * Returns [{ num, source: 'ocr' | 'order' }].
   */
  function assignNumbers(raw) {
    const n = raw.length;
    const vals = raw.map((r) => {
      if (!r) return null;
      const m = String(r.text || '').replace(/\D+/g, ' ').trim().split(' ').filter(Boolean).sort((a, b) => b.length - a.length)[0];
      if (!m || m.length > 3 || r.confidence < 40) return null;
      const v = parseInt(m, 10);
      return Number.isFinite(v) ? { v, conf: r.confidence } : null;
    });
    const byNum = new Map();
    vals.forEach((x, i) => {
      if (!x) return;
      const prev = byNum.get(x.v);
      if (prev === undefined) byNum.set(x.v, i);
      else if (vals[prev].conf < x.conf) { vals[prev] = null; byNum.set(x.v, i); }
      else vals[i] = null;
    });
    const okCount = vals.filter(Boolean).length;
    if (okCount < Math.max(1, n * 0.3)) return raw.map((_, i) => ({ num: i + 1, source: 'order' }));

    const offsets = new Map();
    vals.forEach((x, i) => { if (x) offsets.set(x.v - i, (offsets.get(x.v - i) || 0) + 1); });
    let off = 1, bestC = 0;
    offsets.forEach((c, o) => { if (c > bestC) { bestC = c; off = o; } });
    const used = new Set(vals.filter(Boolean).map((x) => x.v));
    return vals.map((x, i) => {
      if (x) return { num: x.v, source: 'ocr' };
      let cand = i + off;
      if (used.has(cand)) { cand = 1; while (used.has(cand)) cand++; }
      used.add(cand);
      return { num: cand, source: 'order' };
    });
  }

  SP.ocr = { prepareTile, recognize, assignNumbers };
})();
