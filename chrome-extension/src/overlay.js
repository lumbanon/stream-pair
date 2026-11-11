// On-page UI, isolated in a shadow root so site CSS cannot interfere:
//  - board layer drawn exactly over the board area (thumbnails, pair colours)
//  - floating panel with ready-to-type pairs and copy buttons
//  - debug panel with every tile crop, state, OCR number, hash and metrics
// Nothing here ever touches the chat box.
(() => {
  const SP = (globalThis.SP = globalThis.SP || {});
  if (SP.Overlay) return;

  const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
  .board { position: fixed; pointer-events: none; }
  .board.hidden-for-capture { visibility: hidden; }
  .tile { position: absolute; border: 2px solid transparent; border-radius: 4px; pointer-events: none; }
  .board.interactive .tile { pointer-events: auto; cursor: pointer; border-color: rgba(255,255,255,.35); }
  .board.interactive .tile:hover { background: rgba(255,255,255,.12); }
  .tile.seen { border-color: rgba(255,255,255,.55); border-style: dotted; }
  .tile.half { border-color: #fff; border-style: dashed; }
  .tile.pair { border-width: 3px; box-shadow: 0 0 0 1px rgba(0,0,0,.6), 0 0 8px currentColor; }
  .tile.selected { box-shadow: 0 0 0 3px #fff, 0 0 12px #fff; }
  .tile.solved { opacity: .25; }
  .tile .num { position: absolute; left: 2px; bottom: 2px; font: 700 11px/1 system-ui; color: #fff;
    background: rgba(0,0,0,.65); padding: 2px 4px; border-radius: 3px; }
  .tile.pair .num { color: #000; }
  .tile .num.guess { font-style: italic; }
  .tile img.th { position: absolute; right: 2px; top: 2px; width: 38%; max-width: 56px; border-radius: 3px;
    border: 1px solid rgba(0,0,0,.6); background: #000; }
  .area-outline { position: fixed; border: 2px dashed #00e5ff; box-shadow: 0 0 0 9999px rgba(0,0,0,.35);
    pointer-events: none; display: none; }
  .area-outline.on { display: block; }
  .panel, .debug { position: fixed; pointer-events: auto; background: rgba(18,18,24,.94); color: #eee;
    border: 1px solid #444; border-radius: 8px; font-size: 12px; box-shadow: 0 4px 18px rgba(0,0,0,.5); }
  .panel { right: 16px; top: 80px; width: 250px; }
  .panel .hdr, .debug .hdr { display: flex; align-items: center; gap: 6px; padding: 6px 8px; cursor: move;
    border-bottom: 1px solid #333; font-weight: 700; user-select: none; }
  .hdr .grow { flex: 1; }
  .hdr .st { font-weight: 400; color: #9aa; font-size: 11px; }
  .panel .body { padding: 6px 8px 8px; max-height: 60vh; overflow: auto; }
  .panel.min .body { display: none; }
  button, select, input { font: inherit; font-size: 12px; color: #eee; background: #2a2a35; border: 1px solid #555;
    border-radius: 4px; padding: 2px 6px; }
  button:hover { background: #3a3a48; }
  button.on { background: #1677ff; border-color: #1677ff; }
  .row { display: flex; gap: 4px; flex-wrap: wrap; margin: 4px 0; align-items: center; }
  .sec { margin: 8px 0 2px; color: #9aa; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
  .prow { display: flex; align-items: center; gap: 4px; padding: 2px 0; }
  .prow .sw { width: 10px; height: 10px; border-radius: 2px; flex: none; }
  .prow .lbl { font-weight: 700; min-width: 54px; }
  .prow img { width: 22px; height: 22px; object-fit: cover; border-radius: 3px; background: #000; }
  .prow .kind { color: #889; font-size: 10px; flex: 1; }
  .empty { color: #778; font-style: italic; }
  .debug { left: 16px; top: 80px; width: 520px; max-height: 75vh; display: none; }
  .debug.on { display: block; }
  .debug .body { overflow: auto; max-height: calc(75vh - 34px); padding: 6px 8px; }
  .debug table { border-collapse: collapse; width: 100%; font: 11px/1.3 ui-monospace, Consolas, monospace; }
  .debug td, .debug th { border-bottom: 1px solid #333; padding: 2px 4px; text-align: left; vertical-align: middle; }
  .debug canvas { width: 40px; height: 40px; background: #000; display: block; }
  .debug .tune { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px 8px; margin-bottom: 6px; }
  .debug .tune label { display: flex; flex-direction: column; font-size: 10px; color: #9aa; }
  .debug .tune input { width: 100%; }
  .st-hidden { color: #8c8; } .st-flipping { color: #fc6; } .st-revealed { color: #6cf; }
  .st-matched, .st-gone { color: #777; }
  .toast { position: fixed; left: 50%; bottom: 40px; transform: translateX(-50%); background: rgba(0,0,0,.85);
    color: #fff; padding: 8px 14px; border-radius: 6px; font-size: 13px; pointer-events: none; opacity: 0;
    transition: opacity .2s; }
  .toast.on { opacity: 1; }
  `;

  const TUNE_KEYS = [
    ['hashThreshold', 'hash ≤', 1], ['histMin', 'hist ≥', 0.05], ['revealDiff', 'revealDiff', 1],
    ['backHistMin', 'backHist ≥', 0.05], ['stableDiff', 'stableDiff', 0.5], ['stableFrames', 'stableFrames', 1],
    ['emptyStd', 'emptyStd', 0.5], ['matchPersistMs', 'persist ms', 500], ['insetFrac', 'inset', 0.02],
    ['pairWindowMs', 'pair win ms', 250], ['frameDiff', 'frameDiff', 0.1], ['fps', 'fps', 1],
  ];

  function el(tag, attrs = {}, kids = []) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    for (const k of kids) if (k) e.append(k);
    return e;
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* fall through */ }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }

  function makeDraggable(box, handle) {
    let sx, sy, ox, oy, drag = false;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.closest('button,select,input')) return;
      drag = true;
      const r = box.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!drag) return;
      box.style.left = `${Math.max(0, Math.min(innerWidth - 40, ox + e.clientX - sx))}px`;
      box.style.top = `${Math.max(0, Math.min(innerHeight - 20, oy + e.clientY - sy))}px`;
      box.style.right = 'auto';
    });
    window.addEventListener('mouseup', () => { drag = false; });
  }

  class Overlay {
    /** cb: { onTileClick(i), onAction(name, value), onSetting(key, value) } */
    constructor(cb) {
      this.cb = cb;
      this.host = null;
      this.tileEls = [];
      this.lastPanelKey = '';
      this.debugRows = [];
      this.lastDebug = 0;
    }

    ensure() {
      if (this.host && this.host.isConnected) return;
      this.host = el('div', { id: 'stream-pairs-helper-root' });
      this.host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646;';
      this.shadow = this.host.attachShadow({ mode: 'open' });
      this.shadow.append(el('style', { text: CSS }));
      this.board = el('div', { class: 'board' });
      this.outline = el('div', { class: 'area-outline' });
      this.toastEl = el('div', { class: 'toast' });
      this.buildPanel();
      this.buildDebug();
      this.panel.style.display = 'none'; // shown by setPanelVisible() once scanning starts
      this.shadow.append(this.outline, this.board, this.panel, this.debug, this.toastEl);
      this.tileEls = [];
      this.mount();
      document.addEventListener('fullscreenchange', () => this.mount());
    }

    /** In fullscreen only the fullscreen element's subtree is painted. */
    mount() {
      const fs = document.fullscreenElement;
      const parent = fs && fs.tagName !== 'VIDEO' ? fs : document.documentElement;
      if (this.host.parentNode !== parent) parent.append(this.host);
    }

    get root() { this.ensure(); return this.shadow; }

    buildPanel() {
      this.statusEl = el('span', { class: 'st', text: 'idle' });
      this.minBtn = el('button', { text: '–', title: 'Minimise', onclick: () => this.panel.classList.toggle('min') });
      const hdr = el('div', { class: 'hdr' }, [el('span', { text: 'Stream Pairs' }), this.statusEl, el('span', { class: 'grow' }), this.minBtn,
        el('button', { text: '×', title: 'Hide panel (re-open from popup)', onclick: () => this.cb.onAction('hidePanel') })]);
      this.modeSel = el('select', { onchange: (e) => this.cb.onSetting('mode', e.target.value) }, [
        el('option', { value: 'auto', text: 'Auto' }), el('option', { value: 'identical', text: 'Identical' }),
        el('option', { value: 'complement', text: 'Complement' })]);
      this.teachBtn = el('button', { text: 'Teach', title: 'Click two tiles to save them as a pair', onclick: () => this.cb.onAction('teach') });
      this.editBtn = el('button', { text: 'Edit #', title: 'Click a tile to correct its number', onclick: () => this.cb.onAction('edit') });
      this.debugBtn = el('button', { text: 'Debug', onclick: () => this.cb.onAction('debug') });
      this.runBtn = el('button', { text: 'Start', onclick: () => this.cb.onAction('toggleRun') });
      this.pairsEl = el('div');
      this.halfEl = el('div');
      this.infoEl = el('div', { class: 'empty' });
      const body = el('div', { class: 'body' }, [
        el('div', { class: 'row' }, [this.runBtn, this.modeSel, el('button', { text: 'New level', onclick: () => this.cb.onAction('newLevel') })]),
        el('div', { class: 'row' }, [this.teachBtn, this.editBtn, this.debugBtn]),
        this.infoEl,
        el('div', { class: 'sec', text: 'Ready pairs (known)' }), this.pairsEl,
        el('div', { class: 'sec', text: 'Half-known (partner unseen)' }), this.halfEl,
      ]);
      this.panel = el('div', { class: 'panel' }, [hdr, body]);
      makeDraggable(this.panel, hdr);
    }

    buildDebug() {
      this.tuneInputs = {};
      const tune = el('div', { class: 'tune' }, TUNE_KEYS.map(([key, label, step]) => {
        const inp = el('input', { type: 'number', step: String(step), onchange: (e) => this.cb.onSetting(key, Number(e.target.value)) });
        this.tuneInputs[key] = inp;
        return el('label', {}, [document.createTextNode(label), inp]);
      }));
      this.debugInfo = el('div', { class: 'empty' });
      this.debugTable = el('table');
      const hdr = el('div', { class: 'hdr' }, [el('span', { text: 'Debug' }), el('span', { class: 'grow' }),
        el('button', { text: '×', onclick: () => this.cb.onAction('debug') })]);
      this.debug = el('div', { class: 'debug' }, [hdr, el('div', { class: 'body' }, [tune, this.debugInfo, this.debugTable])]);
      makeDraggable(this.debug, hdr);
    }

    toast(msg, ms = 2200) {
      this.ensure();
      this.toastEl.textContent = msg;
      this.toastEl.classList.add('on');
      clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(() => this.toastEl.classList.remove('on'), ms);
    }

    /** Called every animation frame with the board's viewport rect (or null). */
    place(rect) {
      this.ensure();
      const s = this.board.style;
      if (!rect) { if (s.display !== 'none') s.display = 'none'; return; }
      const v = [`${rect.left}px`, `${rect.top}px`, `${rect.width}px`, `${rect.height}px`];
      if (s.left !== v[0] || s.top !== v[1] || s.width !== v[2] || s.height !== v[3] || s.display === 'none') {
        s.display = 'block'; s.left = v[0]; s.top = v[1]; s.width = v[2]; s.height = v[3];
      }
      if (this.outlineOn) {
        const o = this.outline.style;
        o.left = v[0]; o.top = v[1]; o.width = v[2]; o.height = v[3];
      }
    }

    showArea(on) { this.ensure(); this.outlineOn = on; this.outline.classList.toggle('on', on); }

    setCaptureHidden(h) { if (this.board) this.board.classList.toggle('hidden-for-capture', h); }

    setPanelVisible(v) { this.ensure(); this.panel.style.display = v ? '' : 'none'; }

    setDebugVisible(v) { this.ensure(); this.debug.classList.toggle('on', v); }

    /** Board layer: one element per tile, positioned in % of the board. */
    renderTiles(tiles, result, ui) {
      this.ensure();
      if (this.tileEls.length !== tiles.length) {
        this.board.textContent = '';
        this.tileEls = tiles.map((t) => {
          const num = el('span', { class: 'num' });
          const img = el('img', { class: 'th', alt: '' });
          img.style.display = 'none';
          const d = el('div', { class: 'tile', onclick: () => this.cb.onTileClick(t.i) }, [img, num]);
          this.board.append(d);
          return { d, num, img, key: '' };
        });
      }
      this.board.classList.toggle('interactive', !!ui.interactive);
      const pairOf = new Map();
      for (const p of result.known) { pairOf.set(p.a.i, p); pairOf.set(p.b.i, p); }
      const halfSet = new Set(result.half.map((h) => h.tile.i));
      tiles.forEach((t, k) => {
        const e = this.tileEls[k];
        const p = pairOf.get(t.i);
        const solved = t.state === 'matched' || t.state === 'gone';
        const cls = ['tile', p ? 'pair' : halfSet.has(t.i) ? 'half' : t.fp && !solved ? 'seen' : '',
          solved ? 'solved' : '', ui.selected && ui.selected.includes(t.i) ? 'selected' : ''].join(' ');
        const key = `${cls}|${p ? p.color : ''}|${t.num}|${t.numSource}|${t.thumb ? t.thumb.length : 0}|${t.cell.x},${t.cell.y}`;
        if (key === e.key) return;
        e.key = key;
        e.d.className = cls;
        const s = e.d.style;
        s.left = `${t.cell.x * 100}%`; s.top = `${t.cell.y * 100}%`;
        s.width = `${t.cell.w * 100}%`; s.height = `${t.cell.h * 100}%`;
        s.borderColor = p ? p.color : '';
        s.color = p ? p.color : '';
        e.num.textContent = String(t.num);
        e.num.classList.toggle('guess', t.numSource === 'order');
        e.num.style.background = p ? p.color : '';
        if (t.thumb && !solved) { e.img.src = t.thumb; e.img.style.display = ''; } else e.img.style.display = 'none';
      });
    }

    /** Floating panel (rebuilt only when its content changes). */
    renderPanel(st) {
      this.ensure();
      this.statusEl.textContent = st.status || '';
      this.runBtn.textContent = st.running ? 'Stop' : 'Start';
      this.runBtn.classList.toggle('on', st.running);
      if (this.modeSel.value !== st.mode) this.modeSel.value = st.mode;
      this.teachBtn.classList.toggle('on', st.interactive === 'teach');
      this.editBtn.classList.toggle('on', st.interactive === 'edit');
      this.debugBtn.classList.toggle('on', !!st.debug);
      this.infoEl.textContent = st.info || '';
      const key = JSON.stringify([st.summary.known.map((p) => [p.a, p.b, p.color, p.kind]), st.summary.half.map((h) => [h.num, !!h.partnerThumb])]);
      if (key === this.lastPanelKey) return;
      this.lastPanelKey = key;
      this.pairsEl.textContent = '';
      this.halfEl.textContent = '';
      if (!st.summary.known.length) this.pairsEl.append(el('div', { class: 'empty', text: 'none yet' }));
      for (const p of st.summary.known) {
        const btn = el('button', { text: 'Copy', title: `Copy "${p.a} ${p.b}"` });
        btn.addEventListener('click', async () => {
          const ok = await copyText(`${p.a} ${p.b}`);
          btn.textContent = ok ? 'Copied' : 'Failed';
          setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
        });
        const sw = el('span', { class: 'sw' });
        sw.style.background = p.color;
        this.pairsEl.append(el('div', { class: 'prow' }, [sw, el('span', { class: 'lbl', text: `[${p.a},${p.b}]` }),
          p.thumbA ? el('img', { src: p.thumbA }) : null, p.thumbB ? el('img', { src: p.thumbB }) : null,
          el('span', { class: 'kind', text: p.kind }), btn]));
      }
      if (!st.summary.half.length) this.halfEl.append(el('div', { class: 'empty', text: 'none' }));
      for (const h of st.summary.half) {
        this.halfEl.append(el('div', { class: 'prow' }, [el('span', { class: 'lbl', text: `[${h.num},?]` }),
          h.thumb ? el('img', { src: h.thumb }) : null,
          h.partnerThumb ? el('span', { class: 'kind', text: '→' }) : null,
          h.partnerThumb ? el('img', { src: h.partnerThumb, title: 'Partner (from learned pairs)' }) : null,
          el('span', { class: 'kind', text: h.partnerThumb ? 'partner known' : '' })]));
      }
    }

    /** Debug table: live crop + numbers per tile. Throttled to 2/s. */
    renderDebug(tiles, frame, S, info) {
      if (!this.debug || !this.debug.classList.contains('on')) return;
      const now = performance.now();
      if (now - this.lastDebug < 500) return;
      this.lastDebug = now;
      for (const [key] of TUNE_KEYS) {
        const inp = this.tuneInputs[key];
        if (this.shadow.activeElement !== inp && String(S[key]) !== inp.value) inp.value = String(S[key]);
      }
      this.debugInfo.textContent = info || '';
      if (this.debugRows.length !== tiles.length) {
        this.debugTable.textContent = '';
        this.debugTable.append(el('tr', {}, ['crop', '#', 'state', 'dhash / phash', 'backΔ', 'backH', 'Δprev', 'stbl', 'item'].map((h) => el('th', { text: h }))));
        this.debugRows = tiles.map(() => {
          const cv = el('canvas', { width: '40', height: '40' });
          const cells = Array.from({ length: 7 }, () => el('td'));
          const item = el('img');
          item.style.cssText = 'width:32px;height:32px;object-fit:cover;display:none';
          const tr = el('tr', {}, [el('td', {}, [cv]), ...cells, el('td', {}, [item])]);
          this.debugTable.append(tr);
          return { cv, cells, item };
        });
      }
      tiles.forEach((t, k) => {
        const row = this.debugRows[k];
        if (frame) {
          const r = SP.grid.cellToPx(t.cell, frame.width, frame.height, S.insetFrac);
          const ctx = row.cv.getContext('2d');
          ctx.clearRect(0, 0, 40, 40);
          try { ctx.drawImage(frame.canvas, r.x, r.y, r.w, r.h, 0, 0, 40, 40); } catch (e) { /* ignore */ }
        }
        const d = t.debug;
        const vals = [`${t.num}${t.numSource === 'ocr' ? '' : t.numSource === 'manual' ? ' (m)' : ' (o)'}`, t.state,
          t.fp ? `${t.fp.dhash} / ${t.fp.phash}` : '—', d.backDiff < 0 ? 'n/a' : d.backDiff.toFixed(1), d.backHist.toFixed(2),
          d.prevDiff >= 255 ? '—' : d.prevDiff.toFixed(1), String(t.stable)];
        vals.forEach((v, j) => { if (row.cells[j].textContent !== v) row.cells[j].textContent = v; });
        row.cells[1].className = `st-${t.state}`;
        if (t.thumb) { if (row.item.src !== t.thumb) row.item.src = t.thumb; row.item.style.display = ''; } else row.item.style.display = 'none';
      });
    }
  }

  SP.Overlay = Overlay;
  SP.copyText = copyText;
})();
