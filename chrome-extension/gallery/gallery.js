// Pair database gallery: review, delete, export and import learned pairs.
const SP = globalThis.SP;
const db = new SP.PairDB();
const $ = (id) => document.getElementById(id);

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

const bump = () => chrome.storage.local.set({ dbVersion: Date.now() });
const msg = (t) => { $('msg').textContent = t; };

function img(side) {
  return side && side.thumb ? el('img', { src: side.thumb, title: side.dhash }) : el('div', { class: 'noimg', text: '?' });
}

function card(store, e) {
  const del = el('button', { text: 'Delete' });
  del.addEventListener('click', async () => {
    await db.remove(store, e.id);
    await bump();
    render();
  });
  const when = new Date(e.updated || e.created || Date.now()).toLocaleString();
  return el('div', { class: 'card' }, [
    el('div', { class: 'imgs' }, [img(e.a), el('span', { text: '↔' }), img(e.b)]),
    el('div', { class: 'meta' }, [el('span', { text: `seen ×${e.timesSeen || 1}` }), el('span', { text: e.source || 'auto' })]),
    el('div', { class: 'meta' }, [el('span', { text: when })]),
    el('div', { class: 'hash', text: `${e.a.dhash} ↔ ${e.b.dhash}` }),
    del,
  ]);
}

async function render() {
  const [pairs, nonPairs] = await Promise.all([db.all('pairs'), db.all('nonpairs')]);
  const sort = $('sort').value;
  const key = { updated: (e) => e.updated || 0, times: (e) => e.timesSeen || 0, created: (e) => e.created || 0 }[sort];
  pairs.sort((a, b) => key(b) - key(a));
  $('pairCount').textContent = `(${pairs.length})`;
  $('nonCount').textContent = `(${nonPairs.length})`;
  const pg = $('pairs');
  pg.textContent = '';
  if (!pairs.length) pg.append(el('div', { class: 'muted', text: 'Nothing learned yet. Watch a complement level, or use Teach mode.' }));
  pairs.forEach((e) => pg.append(card('pairs', e)));
  const ng = $('nonpairs');
  ng.textContent = '';
  nonPairs.sort((a, b) => (b.updated || 0) - (a.updated || 0)).forEach((e) => ng.append(card('nonpairs', e)));
}

$('sort').addEventListener('change', render);

$('export').addEventListener('click', async () => {
  const data = await db.exportJSON();
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: `stream-pairs-db-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  msg(`Exported ${data.pairs.length} pairs and ${data.nonPairs.length} non-pairs.`);
});

$('import').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  try {
    const obj = JSON.parse(await file.text());
    const S = await SP.loadSettings();
    const n = await db.importJSON(obj, S);
    await bump();
    msg(`Imported ${n} pairs (duplicates were merged).`);
  } catch (e) {
    msg(`Import failed: ${e.message || e}`);
  }
  render();
});

$('clearNon').addEventListener('click', async () => {
  if (!confirm('Delete all recorded non-pairs?')) return;
  await db.clear('nonpairs');
  await bump();
  render();
});

$('clearAll').addEventListener('click', async () => {
  if (!confirm('Delete ALL learned pairs and non-pairs? Consider exporting first.')) return;
  await db.clear('pairs');
  await db.clear('nonpairs');
  await bump();
  render();
});

chrome.storage.onChanged.addListener((c, area) => { if (area === 'local' && c.dbVersion) render(); });
render();
