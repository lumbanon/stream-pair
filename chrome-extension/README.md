# Stream Pairs Helper (Chrome extension)

A local memory aid for **Stream Pairs** (streampairs.com by Onrizon), played through a
Twitch / YouTube / Kick stream. It watches the board in the video, remembers every tile
that gets flipped, and lists the pairs you can type in chat, e.g. `[7,30] [2,15]`.

- Manifest V3, plain JavaScript, no build step.
- Everything runs on your machine. No AI/LLM, no paid APIs, no network calls.
  Tesseract.js (OCR) ships inside the extension under `vendor/`.
- **It never types or sends anything into chat.** It only shows the pairs and gives you copy buttons.

## Install ("Load unpacked")

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and pick the `chrome-extension` folder (the one containing `manifest.json`).
4. Pin "Stream Pairs Helper" from the puzzle-piece menu.
5. Reload any stream tab that was already open. **Do this every time you reload or
   update the extension.** Otherwise the old copy's overlay stays on the page and ends up
   in the screenshots.

## Use

1. Open the stream and wait for the Stream Pairs board, ideally with all tiles face-down.
2. Click the extension icon, then **Select Board Area**. The popup closes. Drag a rectangle
   around the tile grid (dashed border, live size; Esc cancels). Tight or with a little
   margin both work. Scanning starts on its own, and the area is saved for that site.
   Check that the panel header shows the right rows×cols (e.g. `6×9`). If it doesn't,
   untick **Auto-detect**, enter rows and cols in the popup, and press **Re-detect**.
3. The floating panel shows:
   - **Ready pairs (known):** both tiles seen. **Copy** puts `7 30` on the clipboard.
   - **Half-known:** one tile seen, partner not yet. In complement levels the expected
     partner's picture is shown if it has been learned.
4. Tiles on the video get a thumbnail of what was under them. The two tiles of each known
   pair share a colour.
5. On a new level the memory resets by itself when the board turns face-down again or the
   layout changes. **New Level** forces it.

Popup buttons: **Show Area** flashes the saved border. **Reset Area** clears it for this
site. **Start/Stop** scanning. **Teach mode**: click two tiles to save them as a pair.
**Edit numbers**: click a tile to fix its number. **Debug** opens the debug panel.

## Testing on your own host screen (streampairs.com/en/system)

The extension also runs on `https://streampairs.com/*`, so you can host a game and check
that it works without a stream:

1. Open `https://streampairs.com/en/system` and start a game, so the board is on screen.
2. Click the extension icon. This also gives the tab the `activeTab` grant the screenshot
   capture needs. Then click **Select Board Area** and drag around the cards.
3. Flip cards from your own chat (or the game's test input) and watch the overlay and
   panel fill in.

How it differs from a stream:
- The host page draws the board as HTML (cards with a CSS flip), not as a video, so
  frames come from `captureVisibleTab` at about **2 fps**. That is enough for flips that
  stay visible for a second or more.
- The area is stored relative to the **board's container element** (found under your
  selection), not the window. Scrolling and resizing keep it lined up.
- If you reload the tab, click the extension icon once more before scanning. The
  `activeTab` grant does not survive a reload.
- Keep the floating panel off the board. It is hidden for the instant of each
  screenshot, which can flicker if it overlaps.

## How it works

| Module | Job |
|---|---|
| `src/capture.js` | Finds the largest `<video>`, maps the saved area onto the rendered picture (letterboxing removed), and crops frames by drawing the video into an `OffscreenCanvas`. If the canvas is tainted, it falls back to `chrome.tabs.captureVisibleTab` (cropped in the service worker). |
| `src/grid.js` | Splits the board into tiles: manual rows × cols, or auto-detection from foreground row/column projections, with an edge-periodicity fallback. |
| `src/ocr.js` + `offscreen.js` | Binarises each face-down tile and reads its number with the bundled Tesseract.js (digits-only whitelist). Falls back to reading order if OCR fails. |
| `src/hash.js` | dHash and pHash (64-bit), a 64-bin colour histogram, thumbnails, and per-tile signatures. |
| `src/memory.js` | Tile state machine `hidden → flipping → revealed → hidden / matched / gone`. Fingerprints an item only after the flip has settled. |
| `src/learner.js` | Pairs up the two reveals of each guess and stores the outcome in IndexedDB (complement pairs and non-pairs). |
| `src/matcher.js` | Identical matching (Hamming distance ≤ threshold and similar histograms), complement matching through learned pairs, and greedy assignment. |
| `src/overlay.js` | Shadow-DOM board layer, floating panel and debug panel. |
| `src/selector.js` | The drag-to-select border. |
| `src/content.js` | Controller that wires the modules together. |
| `background.js` | Tab-capture fallback, pair-DB access, and the offscreen OCR document. |
| `gallery/` | Pair database gallery: delete wrong entries, export/import JSON. |

### Area storage
The area is saved as fractions of the **rendered video picture**, not page pixels. So it
lines up after theater mode, fullscreen, window resizes and scrolling, and at any stream
resolution. The video path reads pixels at the video's own resolution, so
`devicePixelRatio` and page zoom don't matter. The screenshot path scales by
`screenshotWidth / innerWidth`, which covers both. If you select an area that isn't on a
video, it is stored relative to the window instead.

### Frame rate
The video path runs at the **fps** setting (default 4). Chrome limits
`captureVisibleTab` to about 2 calls per second, so the screenshot fallback runs at
about 2 fps. A frame is analysed only if a 40×24 grey miniature differs from the last
analysed frame by more than `frameDiff`.

### Level types
- **Identical:** two tiles match when their *picture distance* ≤ **Picture distance**
  (default 34) and their colours are similar (≥ *Colour similarity*). Picture distance
  compares a 16×16 colour thumbnail of each card at small offsets (up to about 12% of the
  card) and keeps the best match. So the same picture still matches when one copy is
  framed differently, for example a face-up card drawn enlarged or caught mid-animation.
  On real Stream Pairs cards, identical items measured 5–29 and different items 42 or
  more. *Hash distance* is only used for pairs saved by older versions of the extension.
- **Later levels with more, smaller cards:** grids up to 20×20 are detected, and
  analysis runs at up to 1280 px wide. Tested on boards from 6×9 up to 12×16, with cards
  down to about 50 px. If later boards are bigger than the first one, draw the board
  area with some margin: auto-detection handles a margin fine.
- **Complement** (basketball ↔ net): learned from the game itself. Whenever both tiles
  of a guess end up matched (they stay up or are removed) and they look different, the
  pair `{hashA, hashB, thumbA, thumbB, timesSeen}` is saved. When both flip back, they
  can be saved as a non-pair. Remembered tiles X and Y are suggested when some saved pair
  has X≈A and Y≈B (or the reverse).
- **Auto** tries both, preferring identical matches. A level is treated as identical once
  an identical match has been confirmed in it, or once 3 or more identical pairs are on
  the board. From then on, auto-learned complement pairs are ignored in that level
  (pairs you taught still count). Leftover cards that are each other's closest picture
  are offered as **likely** pairs.

Only complement pairs go into the database. Identical levels need no learning, so the
gallery stays empty while you play them. To keep the database clean:
- Nothing is learned in a level once one identical pair has been confirmed, and anything
  learned earlier in that level is undone.
- A guess that overlaps other guesses in time is skipped, because it is unclear which two
  cards belonged together.
- Non-pairs are recorded only in levels already known to be complement levels.

### Level changes
A guess flips two cards. When many cards change at once (the level-complete screen, the
next board), analysis pauses until the screen settles. Then one of two things happens:
- **Same board:** analysis resumes.
- **Something else:** memory is cleared, and the next level starts when a board of
  face-down cards appears. Menu and transition screens are never remembered as cards.

To start on whatever is on screen, press **New level**.

The pair database lives in the extension's IndexedDB, so it is shared across streams,
sites and levels, and grows as you watch. The popup shows "N pairs learned". Open the
gallery (popup footer, or the extension's Options) to review, delete, export or import it.

## Needs teaching
Sometimes every card in play has been seen but some still have no partner the helper
recognises. It can't tell which ones go together, because the pictures differ and no
learned pair covers them. Those cards are:
- listed under **Needs teaching** in the floating panel, with their pictures;
- outlined in orange on the board.

Click the two cards of a pair in that list to save them. You don't need Teach mode or
the board. A saved pair is remembered for good, and it counts in every mode, including
**Identical**.

## Test auto-play (temporary, your own game only)
For testing, the helper can play **your own hosted game**, so it moves through the
levels and learns each level's pairs. Guesses are posted from your Twitch account to your
own channel. They show up in Chatterino like any other message.

Safeguards built into `src/autoplay.js`:
- Off by default.
- Only runs while the board comes from the **streampairs.com host screen**.
- The token is checked with Twitch, and the helper only ever joins and posts to the
  **token owner's own channel**.
- Only messages shaped like `7 30` can be sent, with at least 1.5 s between messages.

How it picks the next guess, without repeating a combination it already tried in the
level:
1. A known pair.
2. Otherwise two never-seen cards, which reveals the most per guess.
3. Otherwise an unseen card with a half-known one.
4. Otherwise untried combinations of stuck cards.

It waits until the previous guess has flipped back or been matched. When it can't do
anything more, it tells you to use **Needs teaching**.

### Setup
1. Get a Twitch user access token with the scopes `chat:read` and `chat:edit`, the
   official way:
   1. Register an application at <https://dev.twitch.tv/console/apps>, with OAuth
      Redirect URL `http://localhost`.
   2. Open the following URL while logged in as your streaming account. Replace
      `YOUR_CLIENT_ID` with your app's client ID first:
      `https://id.twitch.tv/oauth2/authorize?response_type=token&client_id=YOUR_CLIENT_ID&redirect_uri=http://localhost&scope=chat%3Aread+chat%3Aedit`
   3. Approve the request. The browser then lands on `http://localhost/#access_token=...`
      (the page itself won't load). Copy the `access_token` value.
2. In the extension popup, find **Test auto-play**. Paste the token and click **Save
   token**. The popup checks it and shows which channel it will post to.
3. Tick **Auto-play on my streampairs.com host screen** and set the interval (default 5 s).
4. Start a game on `streampairs.com/en/system` and start scanning as usual.

The token is stored only in this browser's extension storage. To revoke it, go to
<https://www.twitch.tv/settings/connections>.

### Removing it
1. Delete `src/autoplay.js`.
2. Remove every line marked `AUTOPLAY-TEST`. Search for that word; it appears in
   `background.js`, `src/content.js`, `src/settings.js` and `popup/popup.html` (the
   `<section id="autoplay">` block).
3. Remove `"src/autoplay.js"` and `"https://id.twitch.tv/*"` from `manifest.json`.

## Tuning (Debug panel)
For every tile, the Debug panel shows the live crop, number (`(o)` = reading-order
guess, `(m)` = typed by you), state, dHash/pHash, and:

- **backΔ**: grey difference from the tile's own face-down look. It rises above
  `revealDiff` when the tile flips.
- **backH**: histogram similarity to the face-down look. It must stay ≥ `backHistMin`
  to count as face-down.
- **Δprev**: change since the previous frame. Below `stableDiff` counts as still.
  `stableFrames` still frames in a row mean the flip has settled.

Usual fixes:
- Reveals missed → lower `revealDiff`.
- Face-down tiles flicker to "flipping" → raise `revealDiff` or `stableDiff`.
- Correct pairs that stay up aren't marked matched → lower `matchPersistMs`.
- Wrong guesses get marked matched → raise `matchPersistMs`.
- Identical items not paired → raise *Hash distance* a little, or lower *Colour similarity*.
- Different items paired → lower *Hash distance*.
- Tile borders or highlight glow confuse things → raise `inset`.

## Permissions
`activeTab`, `scripting` and `storage` as requested, plus host permissions for
twitch.tv, youtube.com and kick.com. Two more notes:

- **`offscreen`** is the one extra permission. Tesseract.js needs a Web Worker plus
  WebAssembly. A content script can't start a worker from the extension's files, and an
  MV3 service worker can't create workers, so OCR runs in a hidden offscreen document.
- **Screenshot fallback:** `captureVisibleTab` needs the `activeTab` grant. Click the
  extension icon once on the stream tab, then Start. The grant lasts until the tab
  navigates. The normal video path doesn't need it.

## Limitations
- The board must be visible in the tab. Analysis pauses while the tab is hidden.
- Reveal timing is guessed from the video. With slow stream latency or heavy
  compression, tune the thresholds above.
- The grid auto-detector expects a regular grid that stands out from its backdrop. If it
  guesses wrong, untick **Auto-detect** and set rows × cols.

## Third-party
`vendor/tesseract/` contains [Tesseract.js](https://github.com/naptha/tesseract.js) 5.1.1
and tesseract.js-core 5.1.1 (Apache-2.0, see `vendor/tesseract/LICENSE`), plus the
`eng` LSTM `best_int` traineddata from `@tesseract.js-data/eng`.
