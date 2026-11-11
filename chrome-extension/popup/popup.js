// Popup: area tools, settings, and the ready-to-type pair list.
// Talks to the content script of the active tab; never touches chat.
const SP = globalThis.SP;
const $ = (id) => document.getElementById(id);
const SUPPORTED = /^https:\/\/([^/]+\.)?(twitch\.tv|youtube\.com|kick\.com)\//;

let tab = null;
let settings = null;
const db = new SP.PairDB();

async function sendToTab(msg) {
  if (!tab) return null;
  try {
    return await chrome.tabs.sendMessage(tab.id, { to: 'content', ...msg });
  } catch (e) {
    return null;
  }
}

/** Content scripts are declared in the manifest; inject them if the tab predates the install. */
async function ensureContent() {
  const pong = await sendToTab({ type: 'ping' });
  if (pong && pong.ok) return true;
  if (!tab || !SUPPORTED.test(tab.url || '')) return false;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: SP.CONTENT_FILES });
    const again = await sendToTab({ type: 'ping' });
    return !!(again && again.ok);
  } catch (e) {
    return false;
  }
}

function setStatus(text, warn = false) {
  $('status').textContent = text;
  $('status').classList.toggle('warn', warn);
}

function el(tag, attrs = {}, kids = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else e.setAttribute(k, v);
  }
  for (const k of kids) if (k) e.append(k);
  return e;
}

let lastKey = '';
function renderPairs(summary) {
  const key = JSON.stringify(summary);
  if (key === lastKey) return;
  lastKey = key;
  const pairs = $('pairs');
  const half = $('half');
  pairs.textContent = '';
  half.textContent = '';
  if (!summary || !summary.known.length) pairs.append(el('div', { class: 'empty', text: 'No known pairs yet.' }));
  for (const p of (summary && summary.known) || []) {
    const btn = el('button', { text: 'Copy', title: `Copy "${p.a} ${p.b}"` });
    btn.addEventListener('click', async () => {
      await navigator.clipboard.writeText(`${p.a} ${p.b}`);
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
    });
    const sw = el('span', { class: 'sw' });
    sw.style.background = p.color;
    pairs.append(el('div', { class: 'pair' }, [sw, el('span', { class: 'lbl', text: `[${p.a},${p.b}]` }),
      p.thumbA ? el('img', { src: p.thumbA }) : null, p.thumbB ? el('img', { src: p.thumbB }) : null,
      el('span', { class: 'kind', text: `${p.kind} · known` }), btn]));
  }
  if (!summary || !summary.half.length) half.append(el('div', { class: 'empty', text: 'None.' }));
  for (const h of (summary && summary.half) || []) {
    half.append(el('div', { class: 'pair' }, [el('span', { class: 'lbl', text: `[${h.num},?]` }),
      h.thumb ? el('img', { src: h.thumb }) : null,
      h.partnerThumb ? el('img', { src: h.partnerThumb, title: 'Expected partner (learned)' }) : null,
      el('span', { class: 'kind', text: h.partnerThumb ? 'half-known · partner look known' : 'half-known' })]));
  }
}

async function refresh() {
  try {
    $('learned').textContent = `${await db.count('pairs')} pairs learned`;
  } catch (e) { /* ignore */ }
  const st = await sendToTab({ type: 'getStatus' });
  if (!st) {
    setStatus(SUPPORTED.test((tab && tab.url) || '') ? 'Page not ready. Reload the stream tab.' : 'Open a Twitch, YouTube or Kick stream tab.', true);
    renderPairs(null);
    return;
  }
  let s = st.running ? `Scanning · ${st.status}` : st.hasArea ? `Area saved for ${st.host}. Press Start.` : `No board area for ${st.host} yet.`;
  if (st.hasArea && st.area && st.area.anchor === 'video' && !st.hasVideo) s += ' (video not found)';
  setStatus(s + (st.info ? ` · ${st.info}` : ''));
  $('teach').classList.toggle('on', st.interactive === 'teach');
  $('edit').classList.toggle('on', st.interactive === 'edit');
  renderPairs(st.summary);
}

function bindSettings() {
  const checks = ['autoGrid', 'ocrEnabled', 'recordNonPairs', 'showPanel', 'debug'];
  const nums = ['rows', 'cols'];
  const selects = ['mode', 'hashType'];
  const ranges = ['hashThreshold', 'histMin'];
  const show = () => {
    checks.forEach((k) => { $(k).checked = !!settings[k]; });
    nums.forEach((k) => { $(k).value = settings[k]; });
    selects.forEach((k) => { $(k).value = settings[k]; });
    ranges.forEach((k) => { $(k).value = settings[k]; $(`${k}V`).textContent = settings[k]; });
  };
  show();
  const save = async (patch) => { settings = await SP.saveSettings(patch); show(); };
  checks.forEach((k) => $(k).addEventListener('change', (e) => save({ [k]: e.target.checked })));
  nums.forEach((k) => $(k).addEventListener('change', (e) => save({ [k]: Math.max(1, Math.min(15, parseInt(e.target.value, 10) || 1)) })));
  selects.forEach((k) => $(k).addEventListener('change', (e) => save({ [k]: e.target.value })));
  ranges.forEach((k) => {
    $(k).addEventListener('input', (e) => { $(`${k}V`).textContent = e.target.value; });
    $(k).addEventListener('change', (e) => save({ [k]: Number(e.target.value) }));
  });
}

async function main() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  settings = await SP.loadSettings();
  bindSettings();
  const ready = await ensureContent();

  $('select').addEventListener('click', async () => {
    if (!(await ensureContent())) { setStatus('Cannot run on this page.', true); return; }
    await sendToTab({ type: 'selectArea' });
    window.close(); // get out of the way so the board can be dragged
  });
  $('show').addEventListener('click', async () => {
    const r = await sendToTab({ type: 'showArea' });
    if (!r || !r.ok) setStatus('No board area saved for this site.', true);
  });
  $('reset').addEventListener('click', async () => { await sendToTab({ type: 'resetArea' }); refresh(); });
  $('start').addEventListener('click', async () => {
    const r = await sendToTab({ type: 'start' });
    if (!r || !r.ok) setStatus('Select the board area first.', true);
    refresh();
  });
  $('stop').addEventListener('click', async () => { await sendToTab({ type: 'stop' }); refresh(); });
  $('newLevel').addEventListener('click', async () => { await sendToTab({ type: 'newLevel' }); refresh(); });
  $('regrid').addEventListener('click', async () => { await sendToTab({ type: 'regrid' }); refresh(); });
  $('teach').addEventListener('click', async () => { await sendToTab({ type: 'action', name: 'teach' }); window.close(); });
  $('edit').addEventListener('click', async () => { await sendToTab({ type: 'action', name: 'edit' }); window.close(); });
  $('gallery').addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });

  if (!ready) setStatus(SUPPORTED.test((tab && tab.url) || '') ? 'Reload the stream tab to enable the helper.' : 'Open a Twitch, YouTube or Kick stream tab.', true);
  await refresh();
  setInterval(refresh, 1000);
}

main();
