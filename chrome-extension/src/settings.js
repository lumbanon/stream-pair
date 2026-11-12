// Shared defaults and the list of content-script files (used by the popup for
// re-injection). Loaded by the content script, popup, gallery and worker.
(() => {
  const SP = (globalThis.SP = globalThis.SP || {});
  if (SP.DEFAULT_SETTINGS) return;

  SP.DEFAULT_SETTINGS = Object.freeze({
    // Matching
    mode: 'auto',            // 'identical' | 'complement' | 'auto'
    hashType: 'dhash',       // 'dhash' | 'phash'
    hashThreshold: 6,        // max Hamming distance (0..64) for "same picture"
    histMin: 0.6,            // min colour-histogram intersection (0..1)
    pictureMax: 34,          // max shift-tolerant picture distance (0..255) for "same picture"
                             // (real cards: identical 5-29, different 42+)

    // Grid
    autoGrid: true,
    rows: 4,
    cols: 6,
    ocrEnabled: true,

    // Capture
    fps: 4,                  // target analysis rate (tab-capture is capped at ~2/s by Chrome)
    frameDiff: 1.2,          // mean abs grey diff (0..255) below which a frame is "unchanged"

    // Reveal detection (see memory.js)
    insetFrac: 0.12,         // ignore this fraction of each tile edge (borders, glow)
    revealDiff: 22,          // grey diff vs. the tile's own face-down look that means "flipped"
    backHistMin: 0.7,        // hist similarity to face-down look that still counts as "back"
    stableDiff: 6,           // grey diff between consecutive frames that counts as "not moving"
    stableFrames: 2,         // consecutive still frames before a reveal is trusted
    emptyStd: 7,             // tile grey std-dev below this + background colour = removed tile
    matchPersistMs: 6000,    // a pair that stays face-up this long is treated as matched
    pairWindowMs: 2500,      // two reveals this close together belong to the same guess

    // Learning
    recordNonPairs: true,

    // UI
    showPanel: true,
    debug: false,
  });

  SP.CONTENT_FILES = [
    'src/settings.js', 'src/hash.js', 'src/grid.js', 'src/capture.js', 'src/ocr.js',
    'src/memory.js', 'src/learner.js', 'src/matcher.js', 'src/overlay.js',
    'src/selector.js', 'src/content.js',
  ];

  SP.loadSettings = async function loadSettings() {
    const { settings } = await chrome.storage.local.get('settings');
    return { ...SP.DEFAULT_SETTINGS, ...(settings || {}) };
  };

  SP.saveSettings = async function saveSettings(patch) {
    const cur = await SP.loadSettings();
    const next = { ...cur, ...patch };
    await chrome.storage.local.set({ settings: next });
    return next;
  };
})();
