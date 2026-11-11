// Service worker: tab screenshots (fallback capture), the pair database, and
// the offscreen document that hosts Tesseract.js.
importScripts('src/settings.js', 'src/hash.js', 'src/learner.js');

const SP = globalThis.SP;
const db = new SP.PairDB();

// ------------------------------------------------------------ tab capture

function bytesToB64(bytes) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s);
}

/**
 * Screenshot the visible tab and crop it to the board.
 * rect/viewport are CSS pixels; the screenshot is in device pixels. The ratio
 * image.width / viewport.w covers devicePixelRatio AND page zoom at once.
 */
async function captureCrop(msg, sender) {
  const tab = sender.tab;
  if (!tab) return { error: 'no tab' };
  if (!tab.active) return { error: 'tab not active' };
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 90 });
  const blob = await (await fetch(dataUrl)).blob();
  const full = await createImageBitmap(blob);
  const k = full.width / msg.viewport.w;
  const sx = Math.max(0, Math.round(msg.rect.x * k));
  const sy = Math.max(0, Math.round(msg.rect.y * k));
  const sw = Math.max(1, Math.min(full.width - sx, Math.round(msg.rect.w * k)));
  const sh = Math.max(1, Math.min(full.height - sy, Math.round(msg.rect.h * k)));
  const scale = Math.min(1, (msg.maxW || 960) / sw);
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(full, sx, sy, sw, sh, 0, 0, w, h);
  full.close();
  const img = ctx.getImageData(0, 0, w, h);
  return { w, h, data: bytesToB64(new Uint8Array(img.data.buffer)) };
}

// ------------------------------------------------------------ OCR (offscreen)

let creating = null;
async function ensureOffscreen() {
  const url = chrome.runtime.getURL('offscreen.html');
  const ctxs = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
  if (ctxs.length) return;
  if (!creating) {
    creating = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['WORKERS'],
      justification: 'Run the bundled Tesseract.js OCR worker to read tile numbers locally.',
    }).finally(() => { creating = null; });
  }
  await creating;
}

async function ocr(images) {
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'ocr', images });
  return res || { error: 'no response from OCR document' };
}

// ------------------------------------------------------------ messages

async function dedupeSettings() {
  const S = await SP.loadSettings();
  return { hashType: S.hashType, hashThreshold: S.hashThreshold, histMin: S.histMin };
}

function bump() { return chrome.storage.local.set({ dbVersion: Date.now() }); }

async function handle(msg, sender) {
  switch (msg.type) {
    case 'captureCrop': return captureCrop(msg, sender);
    case 'ocr': return ocr(msg.images);
    case 'db:all': return { pairs: await db.all('pairs'), nonPairs: await db.all('nonpairs') };
    case 'db:count': return { pairs: await db.count('pairs'), nonPairs: await db.count('nonpairs') };
    case 'db:add': {
      const r = await db.add(msg.store === 'nonpairs' ? 'nonpairs' : 'pairs', msg.entry, await dedupeSettings());
      await bump();
      return r;
    }
    case 'db:unlearn': await db.unlearn(msg.store || 'pairs', msg.id); await bump(); return { ok: true };
    case 'db:remove': await db.remove(msg.store || 'pairs', msg.id); await bump(); return { ok: true };
    default: return undefined;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen' || msg.to === 'content') return false;
  const known = ['captureCrop', 'ocr', 'db:all', 'db:count', 'db:add', 'db:unlearn', 'db:remove'];
  if (!known.includes(msg.type)) return false;
  handle(msg, sender).then(sendResponse, (e) => sendResponse({ error: String((e && e.message) || e) }));
  return true;
});
