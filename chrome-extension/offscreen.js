// Offscreen document: hosts one Tesseract.js worker, loaded entirely from the
// extension package (no CDN). Digits-only whitelist.
/* global Tesseract */

let workerPromise = null;

function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const worker = await Tesseract.createWorker('eng', 1 /* OEM.LSTM_ONLY */, {
        workerPath: chrome.runtime.getURL('vendor/tesseract/worker.min.js'),
        corePath: chrome.runtime.getURL('vendor/tesseract/core/'),
        langPath: chrome.runtime.getURL('vendor/tesseract/lang'),
        workerBlobURL: false,
        gzip: true,
        cacheMethod: 'none',
      });
      await worker.setParameters({
        tessedit_char_whitelist: '0123456789',
        tessedit_pageseg_mode: '7', // single text line
      });
      return worker;
    })().catch((e) => { workerPromise = null; throw e; });
  }
  return workerPromise;
}

let queue = Promise.resolve();

async function recognizeAll(images) {
  const worker = await getWorker();
  const out = [];
  for (const img of images) {
    let { data } = await worker.recognize(img);
    let text = (data.text || '').trim();
    let confidence = data.confidence || 0;
    if (!/\d/.test(text)) {
      // Second chance: sparse-text mode finds digits that are not centred.
      await worker.setParameters({ tessedit_pageseg_mode: '11' });
      ({ data } = await worker.recognize(img));
      await worker.setParameters({ tessedit_pageseg_mode: '7' });
      text = (data.text || '').trim();
      confidence = data.confidence || 0;
    }
    out.push({ text, confidence });
  }
  return out;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen' || msg.type !== 'ocr') return false;
  // Serialise jobs: one worker, one recognition at a time.
  queue = queue.then(() => recognizeAll(msg.images || []))
    .then((results) => sendResponse({ results }), (e) => sendResponse({ error: String((e && e.message) || e) }));
  return true;
});
