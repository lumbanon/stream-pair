// Per-level tile memory and the reveal-detection state machine.
//
// Tile states:
//   hidden    face-down (looks like its own face-down reference)
//   flipping  changed away from face-down, waiting for the picture to settle
//   revealed  face-up and settled; its item fingerprint has been stored
//   matched   stayed face-up long enough (or vanished) -> solved
//   gone      replaced by empty board background (solved + removed)
//
// Events emitted by update():
//   { type: 'reveal',  tile, t }   hidden/flipping -> revealed (fingerprint saved)
//   { type: 'hide',    tile, t }   revealed -> hidden (wrong guess flipped back)
//   { type: 'matched', tile, t }   revealed -> matched/gone
//   { type: 'unmatch', tile, t }   a "matched by persistence" tile flipped back after all
//   { type: 'levelReset', t }      the whole board went face-down again
(() => {
  const SP = (globalThis.SP = globalThis.SP || {});
  if (SP.LevelMemory) return;
  const H = () => SP.hash;

  /** Element-wise median of histograms = "what most tiles look like". */
  function medianHist(hists) {
    const out = new Float32Array(64);
    const col = new Array(hists.length);
    for (let b = 0; b < 64; b++) {
      for (let i = 0; i < hists.length; i++) col[i] = hists[i][b];
      col.sort((x, y) => x - y);
      out[b] = col[(col.length / 2) | 0] || 0;
    }
    const s = out.reduce((a, v) => a + v, 0) || 1;
    for (let b = 0; b < 64; b++) out[b] /= s;
    return out;
  }

  class LevelMemory {
    constructor() {
      this.levelId = 0;
      this.grid = null;
      this.tiles = [];
      this.bg = null;
      this.globalBack = null;
      this.resetVotes = 0;
    }

    reset(grid, frame, S) {
      this.levelId++;
      this.grid = grid;
      this.resetVotes = 0;
      this.tiles = grid.cells.map((cell, i) => ({
        i, cell,
        num: i + 1, numSource: 'order',
        state: 'hidden',
        stable: 0, prevSig: null, lastSig: null,
        backRef: null, lastBack: true,
        fp: null, thumb: null,
        flipStart: 0, revealedAt: 0, matchedAt: 0, matchedBy: null,
        debug: { backDiff: 0, backHist: 0, prevDiff: 0 },
      }));
      if (frame) this.calibrate(frame, S);
    }

    rectPx(tile, frame, inset) {
      return SP.grid.cellToPx(tile.cell, frame.width, frame.height, inset);
    }

    /**
     * Learn what "face-down" looks like at the start of a level.
     *
     * Each tile keeps its OWN face-down reference (backRef), because every
     * back shows a different number. To decide which tiles are face-down
     * right now, we compare each tile's colour histogram with the median
     * histogram of all tiles: at level start most tiles are backs, so the
     * median is a clean model of a back even if a few tiles are open.
     * Tiles that do not look like a back (joining mid-level) are recorded as
     * already solved, silently, so they never create bogus pair events.
     */
    calibrate(frame, S) {
      this.bg = SP.grid.estimateBackground(frame.imageData);
      const sigs = this.tiles.map((t) => H().signature(frame.imageData, this.rectPx(t, frame, S.insetFrac)));
      this.globalBack = medianHist(sigs.map((s) => s.hist));
      this.tiles.forEach((t, k) => {
        const sig = sigs[k];
        t.prevSig = t.lastSig = sig;
        if (H().histSim(sig.hist, this.globalBack) >= S.backHistMin) {
          t.backRef = sig;
          t.state = 'hidden';
        } else if (this.isEmpty(sig, S)) {
          t.state = 'gone';
        } else {
          t.state = 'matched';
          t.matchedBy = 'calibration';
          this.captureFingerprint(t, frame, S);
        }
      });
    }

    isEmpty(sig, S) {
      return sig.std < S.emptyStd && H().colorDist(sig.mean, this.bg) < 45;
    }

    /**
     * Does the tile currently look face-down?
     * With a per-tile reference: small grey difference AND similar colours.
     * Without one yet: similar colours to the global "typical back".
     */
    isBack(t, sig, S) {
      if (t.backRef) {
        const d = H().mad(sig.gray, t.backRef.gray);
        const h = H().histSim(sig.hist, t.backRef.hist);
        t.debug.backDiff = d;
        t.debug.backHist = h;
        return d < S.revealDiff && h >= S.backHistMin;
      }
      const h = H().histSim(sig.hist, this.globalBack);
      t.debug.backDiff = -1;
      t.debug.backHist = h;
      return h >= S.backHistMin + 0.05;
    }

    captureFingerprint(t, frame, S) {
      const r = this.rectPx(t, frame, S.insetFrac);
      t.fp = H().fingerprint(frame.imageData, r);
      t.thumb = H().thumbnail(frame.canvas, r, 48);
    }

    /** Force a fingerprint now (Teach mode on a tile that is face-up). */
    captureNow(i, frame, S) {
      const t = this.tiles[i];
      if (t && frame) this.captureFingerprint(t, frame, S);
      return t;
    }

    /**
     * Run one analysis step.
     *
     * reuse = true means the capture loop saw no visible change since the last
     * processed frame: signatures are reused and every tile simply gets one
     * more "still" frame, which costs almost nothing.
     *
     * Reveal detection, per tile:
     *  1. sig = 16x16 grey + histogram of the tile (borders trimmed).
     *  2. prevDiff = grey difference to the previous frame. Below stableDiff
     *     the tile is "still"; `stable` counts consecutive still frames.
     *  3. back = isBack(). A tile that stops looking like its back is
     *     flipping. We do NOT fingerprint immediately: the flip animation
     *     shows squashed/blurred intermediate pictures. Only after
     *     `stableFrames` still frames (2-3 frames ~ 0.5-1 s) is the picture
     *     considered settled and fingerprinted.
     *  4. A revealed tile that settles back into its face-down look was a
     *     wrong guess (hide). One that turns into empty backdrop, or stays up
     *     longer than matchPersistMs, was a correct pair (matched).
     */
    update(frame, t, S, reuse) {
      const events = [];
      let backCount = 0, resurrected = 0, solved = 0;
      for (const tile of this.tiles) {
        let sig, prevDiff;
        if (reuse && tile.lastSig) {
          sig = tile.lastSig;
          prevDiff = 0;
        } else {
          sig = H().signature(frame.imageData, this.rectPx(tile, frame, S.insetFrac));
          prevDiff = tile.prevSig ? H().mad(sig.gray, tile.prevSig.gray) : 255;
        }
        tile.prevSig = sig;
        tile.lastSig = sig;
        tile.stable = prevDiff < S.stableDiff ? tile.stable + 1 : 0;
        tile.debug.prevDiff = prevDiff;
        const settled = tile.stable >= S.stableFrames;
        const back = this.isBack(tile, sig, S);
        tile.lastBack = back;
        if (back) backCount++;

        switch (tile.state) {
          case 'hidden':
            if (!back) {
              tile.state = 'flipping';
              tile.flipStart = t;
            } else if (settled && !tile.backRef) {
              tile.backRef = sig; // first clean look at this back
            }
            break;

          case 'flipping': {
            // Animated items may never be perfectly still: accept after 4 s.
            const forced = t - tile.flipStart > 4000;
            if (settled || forced) {
              if (back) {
                tile.state = 'hidden';
              } else if (this.isEmpty(sig, S)) {
                tile.state = 'gone';
                tile.matchedAt = t;
                tile.matchedBy = 'removed';
                events.push({ type: 'matched', tile: tile.i, t });
              } else {
                tile.state = 'revealed';
                tile.revealedAt = t;
                this.captureFingerprint(tile, frame, S);
                events.push({ type: 'reveal', tile: tile.i, t });
              }
            }
            break;
          }

          case 'revealed':
            if (!settled) break;
            if (back) {
              tile.state = 'hidden';
              events.push({ type: 'hide', tile: tile.i, t });
            } else if (this.isEmpty(sig, S)) {
              tile.state = 'gone';
              tile.matchedAt = t;
              tile.matchedBy = 'removed';
              events.push({ type: 'matched', tile: tile.i, t });
            } else if (t - tile.revealedAt > S.matchPersistMs) {
              tile.state = 'matched';
              tile.matchedAt = t;
              tile.matchedBy = 'persist';
              events.push({ type: 'matched', tile: tile.i, t });
            }
            break;

          case 'matched':
            solved++;
            if (!settled) break;
            if (this.isEmpty(sig, S)) {
              tile.state = 'gone';
            } else if (back) {
              if (tile.matchedBy === 'persist' && t - tile.matchedAt < 20000) {
                // It was only slow to flip back: undo the match.
                tile.state = 'hidden';
                events.push({ type: 'unmatch', tile: tile.i, t });
                events.push({ type: 'hide', tile: tile.i, t });
              } else {
                resurrected++;
              }
            }
            break;

          case 'gone':
            solved++;
            if (settled && back) resurrected++;
            break;
        }
      }

      // New level: (nearly) every tile is face-down again, including tiles
      // that were already solved. Require it on 3 consecutive steps.
      const n = this.tiles.length;
      if (n && backCount >= 0.9 * n && resurrected >= Math.max(2, 0.5 * solved)) this.resetVotes++;
      else this.resetVotes = 0;
      if (this.resetVotes >= 3) {
        this.resetVotes = 0;
        events.push({ type: 'levelReset', t });
      }
      return events;
    }

    /** Tiles whose item we know and that are still in play. */
    rememberedTiles() {
      return this.tiles.filter((t) => t.fp && t.state !== 'matched' && t.state !== 'gone');
    }
  }

  SP.LevelMemory = LevelMemory;
})();
