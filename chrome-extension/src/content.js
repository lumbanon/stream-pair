// Controller: wires capture -> grid/OCR -> memory -> learner -> matcher -> overlay,
// and answers popup messages. Never types or sends anything into chat.
(() => {
  const SP = globalThis.SP;
  if (!SP) return;

  // When the extension is reloaded/updated, Chrome leaves the OLD copy of this
  // script running in open tabs, disconnected from the extension, with its
  // overlay still on the page. That stale overlay would also end up inside
  // our tab screenshots. So: stop any previous controller we can reach, tell
  // other copies to shut down, and remove any UI they left behind.
  if (SP.controller) { try { SP.controller.shutdown && SP.controller.shutdown(); } catch (e) { /* dead */ } }
  window.dispatchEvent(new CustomEvent('stream-pairs-helper:shutdown'));
  document.querySelectorAll('#stream-pairs-helper-root').forEach((n) => n.remove());

  /** False once this copy has been disconnected from the extension. */
  const alive = () => { try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; } };

  const host = location.hostname.replace(/^www\./, '');
  const AREA_KEY = `area:${host}`;

  const C = {
    S: { ...SP.DEFAULT_SETTINGS },
    area: null,
    running: false,
    grid: null,
    memory: new SP.LevelMemory(),
    learner: new SP.Learner(),
    lastMini: null,
    lastFrame: null,
    result: { known: [], half: [] },
    summary: { known: [], half: [] },
    status: 'idle',
    info: '',
    interactive: null, // null | 'teach' | 'edit'
    selected: [],
    ocrLevel: -1,
    layoutVotes: 0,
    lastLayoutCheck: 0,
    forceStart: false,     // "New level" button: start even if the board is not face-down
    lastStartTry: 0,
    waitReason: 'first frame',
    lastError: '',
    rafOn: false,
    dead: false,
  };
  SP.controller = C;

  function shutdown() {
    if (C.dead) return;
    C.dead = true;
    C.running = false;
    C.rafOn = false;
    capturer.stop();
    overlay.destroy();
    window.removeEventListener('stream-pairs-helper:shutdown', shutdown);
  }
  C.shutdown = () => shutdown();

  const overlay = new SP.Overlay({
    onTileClick: (i) => onTileClick(i),
    // "Needs teaching" list: click two cards there to save them as a pair.
    onTeachPick: async (i) => {
      const prev = C.interactive;
      C.interactive = 'teach';
      try { await onTileClick(i); } finally { if (prev !== 'teach') C.interactive = prev; }
      renderUI();
    },
    onAction: (name) => onAction(name),
    onSetting: (k, v) => SP.saveSettings({ [k]: v }),
  });

  const capturer = new SP.capture.Capturer({
    getArea: () => C.area,
    getFps: () => C.S.fps,
    onFrame: (f) => onFrame(f),
    onError: (e) => {
      const msg = String((e && e.message) || e);
      if (msg !== C.lastError) {
        C.lastError = msg;
        console.warn('[Stream Pairs Helper]', msg);
        if (/activeTab|permission|Cannot access/i.test(msg)) setStatus('capture blocked: click the extension icon once, then Start');
        else setStatus(`capture error: ${msg.slice(0, 60)}`);
      }
    },
    // Our own overlay must not end up inside a tab screenshot.
    beforeTabCapture: () => new Promise((res) => {
      overlay.setCaptureHidden(true);
      requestAnimationFrame(() => requestAnimationFrame(res));
    }),
    afterTabCapture: () => overlay.setCaptureHidden(false),
  });

  function setStatus(s) { C.status = s; renderUI(); }

  // ---------------------------------------------------------------- frames

  async function onFrame(frame) {
    C.lastError = '';
    // Cheap change test on a 40x24 miniature against the last PROCESSED frame,
    // so slow drifts still accumulate into a change eventually.
    const mini = SP.capture.miniature(frame.imageData);
    const diff = C.lastMini ? SP.hash.mad(mini, C.lastMini) : Infinity;
    const changed = diff > C.S.frameDiff;
    if (changed) { C.lastMini = mini; C.lastFrame = frame; }

    const t = Date.now();
    if (!C.grid) { await tryStartLevel(frame, t); return; }

    const events = C.memory.update(changed ? frame : C.lastFrame, t, C.S, !changed);
    if (events.some((e) => e.type === 'levelReset')) {
      await startLevel(frame, null, 'board reset detected');
      return;
    }
    if (events.some((e) => e.type === 'boardReplaced')) {
      waitForBoard('level finished or board changed');
      return;
    }
    if (C.memory.frozen) {
      C.status = 'board changing… (paused)';
      renderUI(frame);
      return;
    }
    if (events.length) {
      C.learner.onEvents(events, C.memory, C.S);
      recompute(); // matches only change when a tile changes state
    }

    // Layout change check (auto grid only): a different tile count, seen twice.
    if (changed && C.S.autoGrid && t - C.lastLayoutCheck > 4000) {
      C.lastLayoutCheck = t;
      const g = SP.grid.detect(frame.imageData);
      const anyGone = C.memory.tiles.some((x) => x.state === 'gone');
      const differs = g && (g.rows !== C.grid.rows || g.cols !== C.grid.cols);
      if (differs && (!anyGone || g.cells.length > C.grid.cells.length)) {
        if (++C.layoutVotes >= 2) { waitForBoard('new layout detected'); return; }
      } else C.layoutVotes = 0;
    }

    const tilesInPlay = C.memory.tiles.filter((x) => x.state !== 'matched' && x.state !== 'gone').length;
    C.status = `${frame.source === 'video' ? 'video' : 'tab'} · ${C.grid.rows}×${C.grid.cols} · ${tilesInPlay} left`;
    renderUI(frame);
    // AUTOPLAY-TEST: test auto-play on your own hosted game (src/autoplay.js)
    if (SP.autoplay && SP.autoplay.tick) {
      SP.autoplay.tick(C).then((note) => { if (note !== C.apNote) { C.apNote = note; renderUI(); } }, () => {});
    }
  }

  /** Forget the current board and wait until a new face-down board is visible. */
  function waitForBoard(reason) {
    C.grid = null;
    C.waitReason = reason;
    C.lastStartTry = 0;
    C.result = { known: [], half: [] };
    C.summary = { known: [], half: [] };
    C.learner.resetLevel();
    overlay.renderTiles([], C.result, {});
    C.status = 'waiting for the next board…';
    renderUI();
  }

  /**
   * Start a level only on a board of mostly face-down cards, so a
   * level-complete / menu screen is never taken for a board (its graphics
   * would otherwise be "revealed" and remembered). Checked at most once a
   * second. "New level" (forceStart) skips the check.
   */
  async function tryStartLevel(frame, t) {
    if (!C.forceStart && t - C.lastStartTry < 1000) return;
    C.lastStartTry = t;
    let g = C.S.autoGrid ? SP.grid.detect(frame.imageData) : null;
    if (!g && !C.S.autoGrid) g = SP.grid.uniform(C.S.rows, C.S.cols);
    if (!C.forceStart && !(g && SP.LevelMemory.looksFaceDown(frame, g, C.S))) {
      overlay.renderTiles([], { known: [], half: [] }, {});
      C.status = 'waiting for a face-down board…';
      C.info = 'Waiting for a board of face-down cards. Press "New level" to start on the current screen anyway.';
      renderUI(frame);
      return;
    }
    const reason = C.forceStart ? 'started manually' : C.waitReason;
    C.forceStart = false;
    C.waitReason = 'board reset detected';
    await startLevel(frame, g, reason);
  }

  async function startLevel(frame, grid, reason) {
    let g = grid;
    if (!g && C.S.autoGrid) g = SP.grid.detect(frame.imageData);
    if (!g) {
      g = SP.grid.uniform(C.S.rows, C.S.cols);
      if (C.S.autoGrid) C.info = 'Auto grid failed, using rows × cols from the popup.';
    } else C.info = '';
    C.grid = g;
    C.layoutVotes = 0;
    C.memory.reset(g, frame, C.S);
    C.learner.resetLevel();
    C.selected = [];
    recompute();
    overlay.toast(`New level (${reason}): ${g.rows}×${g.cols} grid`);
    renderUI(frame);
    if (C.S.ocrEnabled) runOcr(frame);
  }

  /**
   * Read the printed number of every face-down tile once per level.
   * Crops are prepared synchronously (the capture canvas is reused by the
   * next frame), then recognised in the offscreen document.
   */
  async function runOcr(frame) {
    const level = C.memory.levelId;
    const tiles = C.memory.tiles;
    const images = tiles.map((t) => (t.state === 'hidden'
      ? SP.ocr.prepareTile(frame.canvas, SP.grid.cellToPx(t.cell, frame.width, frame.height, 0.06))
      : null));
    const jobs = images.map((img, i) => ({ img, i })).filter((j) => j.img);
    if (!jobs.length) return;
    C.info = 'Reading tile numbers (OCR)…';
    renderUI();
    try {
      const res = await SP.ocr.recognize(jobs.map((j) => j.img));
      if (C.memory.levelId !== level) return;
      const raw = tiles.map(() => null);
      jobs.forEach((j, k) => { raw[j.i] = res[k]; });
      const nums = SP.ocr.assignNumbers(raw);
      tiles.forEach((t, i) => { if (t.numSource !== 'manual') { t.num = nums[i].num; t.numSource = nums[i].source; } });
      const ocrd = nums.filter((n) => n.source === 'ocr').length;
      C.info = ocrd ? `OCR read ${ocrd}/${tiles.length} numbers. Use "Edit #" to fix any.` : 'OCR failed, using reading order (1..N). Use "Edit #" to fix.';
    } catch (e) {
      C.info = `OCR unavailable (${String(e.message || e).slice(0, 50)}), using reading order.`;
    }
    recompute();
    renderUI();
  }

  function recompute() {
    if (!C.grid) { C.result = { known: [], half: [] }; C.summary = { known: [], half: [] }; return; }
    C.result = SP.matcher.findPairs(C.memory.rememberedTiles(),
      { pairs: C.learner.pairs, nonPairs: C.learner.nonPairs, levelIdentical: C.learner.stats.identical > 0 }, C.S, C.memory.tiles);
    C.summary = SP.matcher.summarize(C.result);
  }

  function renderUI(frame) {
    overlay.renderPanel({
      status: C.status, running: C.running, mode: C.S.mode, interactive: C.interactive,
      debug: C.S.debug, info: [C.info, C.apNote].filter(Boolean).join(' · '), // apNote: AUTOPLAY-TEST
      summary: C.summary, selected: C.selected,
    });
    if (C.grid) overlay.renderTiles(C.memory.tiles, C.result, { interactive: !!C.interactive, selected: C.selected });
    if (C.S.debug && C.grid) {
      const m = C.memory;
      overlay.renderDebug(m.tiles, frame || C.lastFrame, C.S,
        `grid ${C.grid.rows}×${C.grid.cols} (${C.grid.source}) · bg rgb(${(m.bg || []).map((v) => v | 0).join(',')}) · ` +
        `capture: ${capturer.source || '-'}${capturer.videoTainted ? ' (video tainted)' : ''} · learned pairs ${C.learner.pairs.length}` +
        ` · this level: ${C.learner.stats.identical} identical / ${C.learner.stats.complement} complement matches`);
    }
  }

  // Keep the board layer glued to the video every animation frame.
  function rafLoop() {
    if (!C.rafOn) return;
    if (!alive()) { shutdown(); return; }
    const now = performance.now();
    if (now - (C.lastForeignCheck || 0) > 2000) {
      C.lastForeignCheck = now;
      if (overlay.foreignRoots().length) {
        // A pre-update copy that cannot be shut down from here. Its overlay
        // would pollute our screenshots, so make the user reload the tab.
        if (!C.staleWarned) overlay.toast('An old copy of the extension is still on this page. Press F5 to reload the tab.', 8000);
        C.staleWarned = true;
        C.info = 'Old extension copy detected on this page: reload the tab (F5), otherwise detection will be wrong.';
        renderUI();
      } else if (C.staleWarned) {
        C.staleWarned = false;
        if (C.info.startsWith('Old extension copy')) { C.info = ''; renderUI(); }
      }
    }
    overlay.place(SP.capture.areaViewportRect(C.area));
    requestAnimationFrame(rafLoop);
  }
  function ensureRaf() { if (!C.rafOn) { C.rafOn = true; requestAnimationFrame(rafLoop); } }

  // ---------------------------------------------------------------- actions

  function start() {
    if (!C.area) { overlay.toast('Select the board area first'); return false; }
    C.running = true;
    overlay.setPanelVisible(C.S.showPanel);
    overlay.setDebugVisible(C.S.debug);
    ensureRaf();
    capturer.start();
    setStatus('starting…');
    return true;
  }

  function stop() {
    C.running = false;
    capturer.stop();
    setStatus('stopped');
  }

  function newLevel() {
    C.grid = null; // next frame calls tryStartLevel()
    C.forceStart = true;
    C.lastMini = null;
    if (!C.running) start();
  }

  async function selectArea() {
    overlay.ensure();
    const r = await SP.selectArea(overlay.root);
    if (!r) { overlay.toast('Selection cancelled'); return; }
    C.area = SP.capture.rectToArea(r);
    await chrome.storage.local.set({ [AREA_KEY]: C.area });
    overlay.toast(`Board area saved for ${host} (${{ video: 'relative to video', element: 'relative to the board element' }[C.area.anchor] || 'relative to window'})`);
    showArea(2500);
    C.grid = null;
    start();
  }

  function showArea(ms = 3000) {
    if (!C.area) { overlay.toast('No board area saved for this site'); return; }
    ensureRaf();
    overlay.showArea(true);
    clearTimeout(C.areaTimer);
    C.areaTimer = setTimeout(() => overlay.showArea(false), ms);
  }

  async function resetArea() {
    stop();
    C.area = null;
    C.grid = null;
    await chrome.storage.local.remove(AREA_KEY);
    overlay.place(null);
    overlay.toast('Board area cleared');
  }

  /** Download exactly what the analyser sees (for tuning / bug reports). */
  async function saveCrop() {
    const f = C.lastFrame;
    if (!f) { overlay.toast('No frame captured yet'); return; }
    const blob = await f.canvas.convertToBlob({ type: 'image/png' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const g = C.grid ? `${C.grid.rows}x${C.grid.cols}` : 'nogrid';
    a.href = url;
    a.download = `stream-pairs-crop-${f.source}-${f.width}x${f.height}-${g}.png`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function onAction(name) {
    if (name === 'toggleRun') C.running ? stop() : start();
    else if (name === 'newLevel') newLevel();
    else if (name === 'teach' || name === 'edit') {
      C.interactive = C.interactive === name ? null : name;
      C.selected = [];
      if (C.interactive === 'teach') overlay.toast('Teach: click the two tiles of a pair (they must be face-up or remembered)');
      if (C.interactive === 'edit') overlay.toast('Edit #: click a tile to type its number');
      renderUI();
    } else if (name === 'debug') SP.saveSettings({ debug: !C.S.debug });
    else if (name === 'hidePanel') SP.saveSettings({ showPanel: false });
    else if (name === 'saveCrop') saveCrop();
  }

  async function onTileClick(i) {
    const t = C.memory.tiles[i];
    if (!t) return;
    if (C.interactive === 'edit') {
      const v = prompt(`Number printed on this tile (currently ${t.num}):`, String(t.num));
      if (v == null) return;
      const n = parseInt(v, 10);
      if (!Number.isFinite(n)) return;
      const clash = C.memory.tiles.find((x) => x !== t && x.num === n);
      if (clash) { clash.num = t.num; clash.numSource = 'manual'; }
      t.num = n;
      t.numSource = 'manual';
      recompute();
      renderUI();
      return;
    }
    if (C.interactive === 'teach') {
      if (!t.fp || t.state === 'revealed' || t.state === 'matched') {
        if (!t.lastBack && C.lastFrame) C.memory.captureNow(i, C.lastFrame, C.S);
      }
      if (!t.fp) { overlay.toast(`Tile ${t.num}: no picture captured yet (wait until it is face-up)`); return; }
      if (C.selected.includes(i)) C.selected = C.selected.filter((x) => x !== i);
      else C.selected.push(i);
      if (C.selected.length === 2) {
        const [a, b] = C.selected.map((k) => C.memory.tiles[k]);
        const r = await C.learner.teach(a, b);
        overlay.toast(r && !r.error ? `Saved pair ${a.num} ↔ ${b.num}${r.merged ? ' (already known, +1)' : ''}` : 'Could not save pair');
        C.selected = [];
        recompute();
      }
      renderUI();
    }
  }

  // ---------------------------------------------------------------- messaging

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.to !== 'content') return;
    (async () => {
      switch (msg.type) {
        case 'ping': return { ok: true };
        case 'getStatus': return {
          host, hasArea: !!C.area, area: C.area, running: C.running, status: C.status, info: C.info,
          grid: C.grid ? { rows: C.grid.rows, cols: C.grid.cols, source: C.grid.source } : null,
          summary: C.summary, interactive: C.interactive, hasVideo: !!SP.capture.findVideo(),
        };
        case 'selectArea': selectArea(); return { ok: true };
        case 'showArea': showArea(); return { ok: !!C.area };
        case 'resetArea': await resetArea(); return { ok: true };
        case 'start': return { ok: start() };
        case 'stop': stop(); return { ok: true };
        case 'newLevel': newLevel(); return { ok: true };
        case 'regrid': C.grid = null; C.forceStart = true; return { ok: true };
        case 'action': onAction(msg.name); return { ok: true };
        default: return { error: 'unknown message' };
      }
    })().then(sendResponse, (e) => sendResponse({ error: String(e) }));
    return true;
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes.settings) {
      const prev = C.S;
      C.S = { ...SP.DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
      overlay.setPanelVisible(C.S.showPanel && (C.running || prev.showPanel !== C.S.showPanel));
      overlay.setDebugVisible(C.S.debug);
      const gridChanged = prev.autoGrid !== C.S.autoGrid || (!C.S.autoGrid && (prev.rows !== C.S.rows || prev.cols !== C.S.cols));
      if (gridChanged) { C.grid = null; C.forceStart = true; }
      recompute();
      renderUI();
    }
    if (changes.dbVersion) C.learner.refresh().then(() => { recompute(); renderUI(); });
    if (changes[AREA_KEY]) { C.area = changes[AREA_KEY].newValue || null; C.grid = null; }
  });

  // Pause analysis while the tab is hidden; capture() already skips frames.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') C.lastMini = null; });

  window.addEventListener('stream-pairs-helper:shutdown', shutdown);

  (async () => {
    C.S = await SP.loadSettings();
    const st = await chrome.storage.local.get(AREA_KEY);
    C.area = st[AREA_KEY] || null;
    await C.learner.refresh();
  })();
})();
