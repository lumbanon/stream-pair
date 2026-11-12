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
//   { type: 'reveal',  tile, t }     hidden/flipping -> revealed (fingerprint saved)
//   { type: 'hide',    tile, t }     revealed -> hidden (wrong guess flipped back)
//   { type: 'matched', tile, t }     revealed -> matched/gone
//   { type: 'unmatch', tile, t }     a "matched by persistence" tile flipped back after all
//   { type: 'levelReset', t }        the whole board went face-down again
//   { type: 'boardChanging', t }     many tiles changed at once; analysis frozen
//   { type: 'boardResumed', t }      ...it settled and is still the same board
//   { type: 'boardReplaced', t }     ...it settled into something else (level end / new level)
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

  /** Fraction of sampled RGB triplets that differ clearly from the backdrop colour. */
  function coverage(rgb, bg) {
    if (!bg) return 1;
    let on = 0;
    const n = rgb.length / 3;
    for (let k = 0; k < rgb.length; k += 3) {
      if (Math.abs(rgb[k] - bg[0]) + Math.abs(rgb[k + 1] - bg[1]) + Math.abs(rgb[k + 2] - bg[2]) > 60) on++;
    }
    return on / (n || 1);
  }

  const CARD_MIN = 0.5;   // inset area at least half "not backdrop" = a card is there
  const EMPTY_MAX = 0.25; // at most a quarter "not backdrop" = no card (removed / edge-on)

  class LevelMemory {
    constructor() {
      this.levelId = 0;
      this.grid = null;
      this.tiles = [];
      this.bg = null;
      this.globalBack = null;
      this.resetVotes = 0;
      this.frozen = false;
      this.lastSettleCheck = 0;
    }

    reset(grid, frame, S) {
      this.levelId++;
      this.grid = grid;
      this.resetVotes = 0;
      this.frozen = false;
      this.tiles = grid.cells.map((cell, i) => ({
        i, cell,
        num: i + 1, numSource: 'order',
        state: 'hidden',
        stable: 0, prevSig: null, lastSig: null,
        backRef: null, lastBack: true,
        fp: null, thumb: null,
        flipStart: 0, revealedAt: 0, matchedAt: 0, matchedBy: null, silent: false, emptySince: 0,
        debug: { backDiff: 0, backHist: 0, prevDiff: 0, cover: 0 },
      }));
      if (frame) this.calibrate(frame, S);
    }

    rectPx(tile, frame, inset) {
      return SP.grid.cellToPx(tile.cell, frame.width, frame.height, inset);
    }

    sigOf(tile, frame, S) {
      const r = this.rectPx(tile, frame, S.insetFrac);
      const rgb = H().sampleRGB(frame.imageData, r, 16, 16);
      const sig = H().signature(frame.imageData, r);
      sig.cover = coverage(rgb, this.bg);
      return sig;
    }

    /**
     * Pixel rect of the CARD inside a cell, for fingerprinting.
     *
     * Grid cells come from projections and can be off by a few pixels per
     * column/row; two copies of the same item would then be hashed with
     * different framing (a few % shift flips many hash bits). So we locate
     * the card itself: sample the cell at 32x32, mark samples that differ
     * from the backdrop, and take the first/last row and column that are
     * mostly card. The fingerprint is taken from that box, shrunk by
     * insetFrac. Falls back to the cell if no clear card box is found.
     */
    cardRectPx(tile, frame, S) {
      // Clip the cell to the image so sample coordinates map back correctly.
      const raw = this.rectPx(tile, frame, 0);
      const cx0 = Math.max(0, raw.x), cy0 = Math.max(0, raw.y);
      const cell = {
        x: cx0, y: cy0,
        w: Math.max(1, Math.min(raw.x + raw.w, frame.width) - cx0),
        h: Math.max(1, Math.min(raw.y + raw.h, frame.height) - cy0),
      };
      const N = 32;
      const rgb = H().sampleRGB(frame.imageData, cell, N, N);
      const colOn = new Float32Array(N), rowOn = new Float32Array(N);
      const bg = this.bg;
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          const k = (y * N + x) * 3;
          const on = !bg || Math.abs(rgb[k] - bg[0]) + Math.abs(rgb[k + 1] - bg[1]) + Math.abs(rgb[k + 2] - bg[2]) > 60;
          if (on) { colOn[x]++; rowOn[y]++; }
        }
      }
      const first = (a) => a.findIndex((v) => v / N >= 0.5);
      const last = (a) => { for (let i = a.length - 1; i >= 0; i--) if (a[i] / N >= 0.5) return i; return -1; };
      const x0 = first(colOn), x1 = last(colOn), y0 = first(rowOn), y1 = last(rowOn);
      let box = cell;
      if (x0 >= 0 && y0 >= 0 && x1 - x0 + 1 >= N * 0.5 && y1 - y0 + 1 >= N * 0.5) {
        box = {
          x: cell.x + (x0 / N) * cell.w, y: cell.y + (y0 / N) * cell.h,
          w: ((x1 - x0 + 1) / N) * cell.w, h: ((y1 - y0 + 1) / N) * cell.h,
        };
      }
      const ix = box.w * S.insetFrac, iy = box.h * S.insetFrac;
      return {
        x: Math.round(box.x + ix), y: Math.round(box.y + iy),
        w: Math.max(1, Math.round(box.w - 2 * ix)), h: Math.max(1, Math.round(box.h - 2 * iy)),
      };
    }

    /**
     * Learn what "face-down" looks like at the start of a level.
     *
     * Each tile keeps its OWN face-down reference (backRef), because every
     * back shows a different number. To decide which tiles are face-down
     * right now, we compare each tile's colour histogram with the median
     * histogram of all tiles: at level start most tiles are backs, so the
     * median is a clean model of a back even if a few tiles are open.
     * Tiles that do not look like a back are NOT assumed solved: the level is
     * often calibrated while a guess is on screen (or mid-flip). They start in
     * 'flipping' with `silent` set, so their picture is still remembered once
     * it settles, but they never produce pair events (we did not see the
     * guess start). If they stay up they become matched; if they flip back
     * they simply become hidden-and-remembered.
     */
    calibrate(frame, S) {
      // Backdrop colour for "tile removed" detection. Prefer the one chosen by
      // grid detection (robust to tight borders), else ask the detector.
      const det = this.grid.bg ? null : SP.grid.detect(frame.imageData);
      this.bg = this.grid.bg || (det && det.bg) || SP.grid.estimateBackground(frame.imageData);
      const sigs = this.tiles.map((t) => this.sigOf(t, frame, S));
      this.globalBack = medianHist(sigs.map((s) => s.hist));
      this.tiles.forEach((t, k) => {
        const sig = sigs[k];
        t.prevSig = t.lastSig = sig;
        if (H().histSim(sig.hist, this.globalBack) >= S.backHistMin) {
          t.backRef = sig;
          t.state = 'hidden';
        } else {
          t.state = 'flipping';
          t.flipStart = Date.now();
          t.silent = true;
        }
      });
    }

    isEmpty(sig, S) {
      return sig.cover <= EMPTY_MAX || (sig.std < S.emptyStd && H().colorDist(sig.mean, this.bg) < 45);
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
      const r = this.cardRectPx(t, frame, S);
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
     *  1. sig = 16x16 grey + histogram of the tile (borders trimmed), plus
     *     `cover` = how much of it is not backdrop colour.
     *  2. prevDiff = grey difference to the previous frame. Below stableDiff
     *     the tile is "still"; `stable` counts consecutive still frames.
     *  3. back = isBack(). A tile that stops looking like its back is
     *     flipping. We do NOT fingerprint immediately: the flip animation
     *     shows squashed/blurred intermediate pictures. Only after
     *     `stableFrames` still frames (2-3 frames ~ 0.5-1 s) is the picture
     *     considered settled and fingerprinted. Tab screenshots arrive only
     *     every ~0.5 s, so there ONE still frame (two identical consecutive
     *     captures) is enough; waiting longer would miss short reveals.
     *     Only a real card (cover >= 0.5) is ever fingerprinted.
     *     "Empty backdrop" must persist for 1.5 s before a tile counts as
     *     removed, because a card seen edge-on mid-flip also looks empty.
     *  4. A revealed tile that settles back into its face-down look was a
     *     wrong guess (hide). One that turns into empty backdrop, or stays up
     *     longer than matchPersistMs, was a correct pair (matched).
     *
     * Board changes: a guess flips 2 tiles (a few if guesses overlap). When
     * many tiles change in the same step (level-complete screen, the next
     * level's board, an animation over the board), per-tile analysis is
     * frozen so nothing on that screen is mistaken for a reveal. Once the
     * board has settled, evaluateBoard() decides: same board -> resume,
     * something else -> 'boardReplaced' (the controller then waits for a new
     * face-down board and starts the next level).
     */
    update(frame, t, S, reuse) {
      const events = [];
      const need = frame && frame.source === 'tab' ? Math.min(S.stableFrames, 1) : S.stableFrames;

      // Pass 1: signatures, stability, how many tiles are moving right now.
      let changing = 0;
      for (const tile of this.tiles) {
        let sig, prevDiff;
        if (reuse && tile.lastSig) {
          sig = tile.lastSig;
          prevDiff = 0;
        } else {
          sig = this.sigOf(tile, frame, S);
          prevDiff = tile.prevSig ? H().mad(sig.gray, tile.prevSig.gray) : 255;
        }
        tile.prevSig = sig;
        tile.lastSig = sig;
        tile.stable = prevDiff < S.stableDiff ? tile.stable + 1 : 0;
        tile.debug.prevDiff = prevDiff;
        tile.debug.cover = sig.cover;
        if (!reuse && prevDiff >= 2 * S.stableDiff) changing++;
      }

      const n = this.tiles.length;
      if (n && changing >= Math.max(5, 0.25 * n)) {
        if (!this.frozen) events.push({ type: 'boardChanging', t });
        this.frozen = true;
        this.lastSettleCheck = t;
      }

      if (this.frozen) {
        const settled = this.tiles.filter((x) => x.stable >= need).length;
        if (settled >= 0.85 * n && t - this.lastSettleCheck >= 1000) {
          this.lastSettleCheck = t;
          if (this.evaluateBoard(frame, S) >= 0.3) {
            events.push({ type: 'boardReplaced', t });
          } else {
            this.frozen = false;
            events.push({ type: 'boardResumed', t });
          }
        }
        return events;
      }

      // Pass 2: per-tile state machine.
      let backCount = 0, resurrected = 0, solved = 0;
      for (const tile of this.tiles) {
        const sig = tile.lastSig;
        const settled = tile.stable >= need;
        const back = this.isBack(tile, sig, S);
        tile.lastBack = back;
        if (back) backCount++;
        if (!back && this.isEmpty(sig, S)) tile.emptySince = tile.emptySince || t;
        else tile.emptySince = 0;
        const removed = !!tile.emptySince && t - tile.emptySince >= 1500;
        const card = sig.cover >= CARD_MIN;

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
                tile.silent = false;
              } else if (tile.emptySince) {
                // Edge-on mid-flip or removed: wait until it is clearly one or the other.
                if (removed) {
                  tile.state = 'gone';
                  tile.matchedAt = t;
                  tile.matchedBy = 'removed';
                  if (!tile.silent) events.push({ type: 'matched', tile: tile.i, t });
                  tile.silent = false;
                }
              } else if (card) {
                tile.state = 'revealed';
                tile.revealedAt = t;
                this.captureFingerprint(tile, frame, S);
                if (!tile.silent) events.push({ type: 'reveal', tile: tile.i, t });
                tile.silent = false;
              }
              // Neither a card nor empty (dimmed / checked-off solved card,
              // placeholder, effect drawn over it). Wait a while, then take it
              // out of play so it cannot block anything forever.
              else if (t - tile.flipStart > 8000) {
                tile.state = 'matched';
                tile.matchedAt = t;
                tile.matchedBy = 'unclear';
                tile.silent = false;
              }
            }
            break;
          }

          case 'revealed':
            if (!settled) {
              // A face-up card that keeps moving (match animation) is solved.
              if (t - tile.revealedAt > S.matchPersistMs + 4000) {
                tile.state = 'matched';
                tile.matchedAt = t;
                tile.matchedBy = 'persist';
                events.push({ type: 'matched', tile: tile.i, t });
              }
              break;
            }
            if (back) {
              tile.state = 'hidden';
              events.push({ type: 'hide', tile: tile.i, t });
            } else if (removed) {
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
            if (removed) {
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
      if (n && backCount >= 0.9 * n && resurrected >= Math.max(2, 0.5 * solved)) this.resetVotes++;
      else this.resetVotes = 0;
      if (this.resetVotes >= 3) {
        this.resetVotes = 0;
        events.push({ type: 'levelReset', t });
      }
      return events;
    }

    /**
     * After a mass change has settled: what fraction of tiles now contradicts
     * what we believe about them?
     *   hidden  but no longer looks like its back
     *   revealed/matched but shows a different picture than remembered
     *   matched but face-down again
     *   gone    but a card (or anything) is drawn there now
     * Tiles mid-flip are not counted. >= 30% contradictions = not the same board.
     */
    evaluateBoard(frame, S) {
      let counted = 0, bad = 0;
      for (const t of this.tiles) {
        const sig = t.lastSig;
        if (!sig || t.state === 'flipping') continue;
        counted++;
        const back = this.isBack(t, sig, S);
        if (t.state === 'hidden') {
          if (t.backRef && !back) bad++;
        } else if (t.state === 'gone') {
          if (sig.cover >= CARD_MIN) bad++;
        } else if (back) {
          if (t.state === 'matched') bad++; // revealed -> back is a normal flip
        } else if (t.fp && sig.cover >= CARD_MIN) {
          const cur = H().fingerprint(frame.imageData, this.cardRectPx(t, frame, S));
          const r = H().compare(cur, t.fp, { ...S, histMin: 0 });
          if (r.t != null ? r.t > 1.5 * (S.pictureMax || 34) : r.d > 2 * S.hashThreshold + 4) bad++;
        } else if (sig.cover < CARD_MIN && !this.isEmpty(sig, S)) {
          bad++;
        }
      }
      return counted ? bad / counted : 0;
    }

    /** Tiles whose item we know and that are still in play. */
    rememberedTiles() {
      return this.tiles.filter((t) => t.fp && t.state !== 'matched' && t.state !== 'gone');
    }
  }

  /**
   * Does `frame` show a board of mostly FACE-DOWN cards laid out as `grid`?
   * Face-down backs look alike (same colours, only the number differs), so
   * most cells must be close to the median cell histogram AND be card-like.
   * Used to avoid starting a level on a level-complete / menu screen.
   */
  LevelMemory.looksFaceDown = function looksFaceDown(frame, grid, S) {
    if (!grid || !grid.cells.length) return false;
    const bg = grid.bg || SP.grid.estimateBackground(frame.imageData);
    const sigs = grid.cells.map((cell) => {
      const r = SP.grid.cellToPx(cell, frame.width, frame.height, S.insetFrac);
      const sig = H().signature(frame.imageData, r);
      sig.cover = coverage(H().sampleRGB(frame.imageData, r, 16, 16), bg);
      return sig;
    });
    const med = medianHist(sigs.map((s) => s.hist));
    const alike = sigs.filter((s) => s.cover >= CARD_MIN && H().histSim(s.hist, med) >= S.backHistMin).length;
    return alike >= 0.6 * sigs.length;
  };

  SP.LevelMemory = LevelMemory;
})();
