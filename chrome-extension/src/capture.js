// Frame capture: locate the stream <video>, map the saved board area onto it,
// and produce cropped ImageData frames.
//
// Area format (saved per site): { anchor: 'video' | 'element' | 'viewport', x, y, w, h }
// ('element' areas also carry { selector, loose } to find the board container
// again on pages that draw the board as HTML, like the streampairs.com host screen.)
// where x/y/w/h are fractions of the *rendered video picture* (the video
// content box, letterboxing removed) or of the viewport when no video was
// found. Because the picture box is recomputed every frame, the area keeps
// lining up through theater mode, fullscreen, resizing and scrolling.
(() => {
  const SP = (globalThis.SP = globalThis.SP || {});
  if (SP.capture) return;

  const MAX_W = 1280;         // analysis width cap (CPU); high enough for small cards on dense boards
  const TAB_MIN_INTERVAL = 520; // Chrome allows ~2 captureVisibleTab calls per second

  /** Largest visible, playing-capable <video> on the page. */
  function findVideo() {
    let best = null, bestArea = 0;
    for (const v of document.querySelectorAll('video')) {
      if (!v.videoWidth || !v.videoHeight) continue;
      const r = v.getBoundingClientRect();
      const w = Math.min(r.right, innerWidth) - Math.max(r.left, 0);
      const h = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
      const a = Math.max(0, w) * Math.max(0, h);
      if (a > bestArea) { bestArea = a; best = v; }
    }
    return best;
  }

  /**
   * Viewport rect of the actual video picture inside the <video> element,
   * honouring object-fit (contain = letterboxed, cover = cropped, fill =
   * stretched). Assumes the default centred object-position.
   */
  function videoContentRect(v) {
    const r = v.getBoundingClientRect();
    const vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || !vh || !r.width || !r.height) return r;
    const fit = getComputedStyle(v).objectFit;
    if (fit === 'fill') return r;
    const scale = fit === 'cover' ? Math.max(r.width / vw, r.height / vh) : Math.min(r.width / vw, r.height / vh);
    const w = vw * scale, h = vh * scale;
    return { left: r.left + (r.width - w) / 2, top: r.top + (r.height - h) / 2, width: w, height: h };
  }

  // ---- element anchor (pages that render the board as HTML, e.g. the
  // streampairs.com host screen). The area is stored relative to the board's
  // container element, so it survives scrolling and responsive re-layout.

  const OWN_ROOT = 'stream-pairs-helper-root';
  const cssIdent = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, '\\$&'));
  const goodClass = (c) => /^[A-Za-z_][\w-]*$/.test(c) && c.length < 60;

  /** Structural CSS path: stops at a unique id, otherwise tag.classes:nth-of-type(n) up to <body>. */
  function cssPath(el) {
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && e !== document.body && e !== document.documentElement; e = e.parentElement) {
      if (e.id && document.querySelectorAll(`#${cssIdent(e.id)}`).length === 1) { parts.unshift(`#${cssIdent(e.id)}`); break; }
      let p = e.tagName.toLowerCase();
      const cls = Array.from(e.classList).filter(goodClass).slice(0, 3);
      if (cls.length) p += cls.map((c) => `.${cssIdent(c)}`).join('');
      const parent = e.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((s) => s.tagName === e.tagName);
        if (same.length > 1) p += `:nth-of-type(${same.indexOf(e) + 1})`;
      }
      parts.unshift(p);
    }
    return parts.join(' > ');
  }

  /** Looser selector (tag + classes of the element itself) used if the path breaks. */
  function looseSelector(el) {
    const cls = Array.from(el.classList).filter(goodClass).slice(0, 3);
    return el.tagName.toLowerCase() + cls.map((c) => `.${cssIdent(c)}`).join('');
  }

  /**
   * Smallest element (from the one under the selection centre, walking up)
   * whose box covers >= 90% of the selection without being far bigger than it.
   */
  function pickContainer(vr) {
    const cx = vr.left + vr.width / 2, cy = vr.top + vr.height / 2;
    const start = document.elementsFromPoint(cx, cy).find((e) => !e.closest(`#${OWN_ROOT}`));
    const selArea = vr.width * vr.height;
    for (let e = start; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
      const r = e.getBoundingClientRect();
      const ix = Math.max(0, Math.min(vr.left + vr.width, r.right) - Math.max(vr.left, r.left));
      const iy = Math.max(0, Math.min(vr.top + vr.height, r.bottom) - Math.max(vr.top, r.top));
      if (ix * iy >= 0.9 * selArea) return r.width * r.height <= 4 * selArea ? e : null;
    }
    return null;
  }

  let cachedEl = null, cachedSel = '';
  function resolveElement(area) {
    if (cachedEl && cachedSel === area.selector && cachedEl.isConnected) return cachedEl;
    let el = null;
    try { el = document.querySelector(area.selector); } catch (e) { el = null; }
    if (!el && area.loose) {
      let best = 0;
      try {
        for (const c of document.querySelectorAll(area.loose)) {
          const r = c.getBoundingClientRect();
          if (r.width * r.height > best) { best = r.width * r.height; el = c; }
        }
      } catch (e) { el = null; }
    }
    cachedEl = el; cachedSel = area.selector;
    return el;
  }

  function anchorRect(area) {
    const anchor = area.anchor;
    if (anchor === 'video') {
      const v = findVideo();
      if (v) return { rect: videoContentRect(v), video: v };
      return null;
    }
    if (anchor === 'element') {
      const el = resolveElement(area);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return r.width && r.height ? { rect: r, video: null } : null;
    }
    return { rect: { left: 0, top: 0, width: innerWidth, height: innerHeight }, video: null };
  }

  /** Board area in viewport CSS pixels, or null if the anchor is missing. */
  function areaViewportRect(area) {
    if (!area) return null;
    const a = anchorRect(area);
    if (!a) return null;
    const { rect } = a;
    return {
      left: rect.left + area.x * rect.width,
      top: rect.top + area.y * rect.height,
      width: area.w * rect.width,
      height: area.h * rect.height,
    };
  }

  /** Viewport rect -> area fractions relative to the best anchor. */
  function rectToArea(vr) {
    const v = findVideo();
    if (v) {
      const c = videoContentRect(v);
      const ix = Math.max(0, Math.min(vr.left + vr.width, c.left + c.width) - Math.max(vr.left, c.left));
      const iy = Math.max(0, Math.min(vr.top + vr.height, c.top + c.height) - Math.max(vr.top, c.top));
      // Use the video as anchor if most of the selection lies on it.
      if (ix * iy > 0.6 * vr.width * vr.height) {
        const cl = (val) => Math.max(0, Math.min(1, val));
        const x = cl((vr.left - c.left) / c.width), y = cl((vr.top - c.top) / c.height);
        return {
          anchor: 'video',
          x, y,
          w: cl((vr.left + vr.width - c.left) / c.width) - x,
          h: cl((vr.top + vr.height - c.top) / c.height) - y,
        };
      }
    }
    const el = pickContainer(vr);
    if (el) {
      const r = el.getBoundingClientRect();
      return {
        anchor: 'element',
        selector: cssPath(el),
        loose: looseSelector(el),
        x: (vr.left - r.left) / r.width,
        y: (vr.top - r.top) / r.height,
        w: vr.width / r.width,
        h: vr.height / r.height,
      };
    }
    return { anchor: 'viewport', x: vr.left / innerWidth, y: vr.top / innerHeight, w: vr.width / innerWidth, h: vr.height / innerHeight };
  }

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8ClampedArray(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /** 40x24 grey miniature of the whole crop for the cheap "did anything change" test. */
  function miniature(img) {
    return SP.hash.sampleGray(img, { x: 0, y: 0, w: img.width, h: img.height }, 40, 24);
  }

  class Capturer {
    /**
     * opts: getArea(), getFps(), onFrame(frame) (may be async),
     *       onError(err), beforeTabCapture(), afterTabCapture()
     */
    constructor(opts) {
      this.o = opts;
      this.running = false;
      this.videoTainted = false;
      this.source = null;
      this.canvas = null;
      this.timer = null;
    }

    start() {
      if (this.running) return;
      this.running = true;
      this.loop();
    }

    stop() {
      this.running = false;
      clearTimeout(this.timer);
    }

    async loop() {
      if (!this.running) return;
      const t0 = performance.now();
      try {
        const frame = await this.grab();
        if (frame) await this.o.onFrame(frame);
      } catch (e) {
        this.o.onError && this.o.onError(e);
      }
      if (!this.running) return;
      const fps = Math.max(1, Math.min(10, this.o.getFps ? this.o.getFps() : 4));
      let interval = 1000 / fps;
      if (this.source === 'tab') interval = Math.max(interval, TAB_MIN_INTERVAL);
      const wait = Math.max(30, interval - (performance.now() - t0));
      this.timer = setTimeout(() => this.loop(), wait);
    }

    ensureCanvas(w, h) {
      if (!this.canvas) this.canvas = new OffscreenCanvas(w, h);
      if (this.canvas.width !== w) this.canvas.width = w;
      if (this.canvas.height !== h) this.canvas.height = h;
      return this.canvas.getContext('2d', { willReadFrequently: true });
    }

    async grab() {
      if (document.visibilityState !== 'visible') return null;
      const area = this.o.getArea();
      if (!area) return null;
      if (area.anchor === 'video' && !this.videoTainted) {
        const v = findVideo();
        if (!v) return null; // video temporarily missing (ad/navigation)
        try {
          return this.grabVideo(v, area);
        } catch (e) {
          // A cross-origin video taints the canvas: getImageData throws.
          if (e && e.name === 'SecurityError') this.videoTainted = true;
          else throw e;
        }
      }
      return this.grabTab(area);
    }

    /**
     * Draw the board straight out of the <video> element. Area fractions map
     * to intrinsic video pixels, so devicePixelRatio, page zoom and player
     * size are irrelevant here, and our overlay is never in the picture.
     */
    grabVideo(v, area) {
      const sx = area.x * v.videoWidth, sy = area.y * v.videoHeight;
      const sw = Math.max(1, area.w * v.videoWidth), sh = Math.max(1, area.h * v.videoHeight);
      const scale = Math.min(1, MAX_W / sw);
      const dw = Math.max(1, Math.round(sw * scale)), dh = Math.max(1, Math.round(sh * scale));
      const ctx = this.ensureCanvas(dw, dh);
      ctx.drawImage(v, sx, sy, sw, sh, 0, 0, dw, dh);
      const imageData = ctx.getImageData(0, 0, dw, dh);
      this.source = 'video';
      return { imageData, canvas: this.canvas, width: dw, height: dh, source: 'video', t: Date.now() };
    }

    /**
     * Fallback: screenshot the visible tab (service worker), cropped there.
     * We send the area in CSS pixels plus innerWidth; the worker derives the
     * screenshot/CSS ratio from the image width, which folds devicePixelRatio
     * and browser zoom into one factor.
     */
    async grabTab(area) {
      const r = areaViewportRect(area);
      if (!r || r.width < 4 || r.height < 4) return null;
      if (this.o.beforeTabCapture) await this.o.beforeTabCapture();
      let res;
      try {
        res = await chrome.runtime.sendMessage({
          type: 'captureCrop',
          rect: { x: r.left, y: r.top, w: r.width, h: r.height },
          viewport: { w: innerWidth, h: innerHeight },
          maxW: MAX_W,
        });
      } finally {
        if (this.o.afterTabCapture) this.o.afterTabCapture();
      }
      if (!res || res.error) throw new Error((res && res.error) || 'Tab capture failed');
      const imageData = new ImageData(b64ToBytes(res.data), res.w, res.h);
      const ctx = this.ensureCanvas(res.w, res.h);
      ctx.putImageData(imageData, 0, 0);
      this.source = 'tab';
      return { imageData, canvas: this.canvas, width: res.w, height: res.h, source: 'tab', t: Date.now() };
    }
  }

  SP.capture = { findVideo, videoContentRect, areaViewportRect, rectToArea, miniature, Capturer };
})();
