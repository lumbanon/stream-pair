// AUTOPLAY-TEST — temporary test helper. Delete this file (and the lines
// marked AUTOPLAY-TEST elsewhere) to remove it completely.
//
// Lets the helper play YOUR OWN hosted game, so it can advance through levels
// and learn their pair patterns. Guesses are sent as chat messages from your
// own Twitch account to your own channel (they show up in Chatterino like any
// message).
//
// Safeguards, enforced in code:
//  - off by default; must be switched on in the popup
//  - only runs while the board comes from the streampairs.com host screen
//    (that screen exists only for the host of the game)
//  - the token is validated with Twitch; we only ever JOIN and post to the
//    token owner's own channel, never any other
//  - only messages of the form "<number> <number>" can be sent
//  - at least 1.5 s between messages, whatever the interval setting
//
// One file, three contexts:
//  - service worker (importScripts): Twitch chat connection + token check
//  - content script: picks the next guess from the helper's memory
//  - popup: token / enable / interval form
(() => {
  const SP = (globalThis.SP = globalThis.SP || {});
  if (SP.autoplay) return;

  const KEY = 'autoplay';
  const GUESS_RE = /^\d{1,3} \d{1,3}$/;
  const MIN_GAP_MS = 1500;
  const isWorker = typeof document === 'undefined' && typeof importScripts === 'function';
  const isPopup = !isWorker && location.protocol === 'chrome-extension:' && !!document.getElementById('autoplay');
  const isContent = !isWorker && !isPopup && location.protocol === 'https:';

  const loadCfg = async () => ({ enabled: false, intervalSec: 5, token: '', login: '', ...((await chrome.storage.local.get(KEY))[KEY] || {}) });
  const saveCfg = async (patch) => {
    const cfg = { ...(await loadCfg()), ...patch };
    await chrome.storage.local.set({ [KEY]: cfg });
    return cfg;
  };
  const cleanToken = (t) => String(t || '').trim().replace(/^oauth:/i, '');

  // ------------------------------------------------------------------ worker
  if (isWorker) {
    /** Ask Twitch who owns the token and what it may do. */
    async function validate(token) {
      const r = await fetch('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: `OAuth ${cleanToken(token)}` } });
      if (r.status === 401) return { ok: false, error: 'Twitch says this token is invalid or expired.' };
      if (!r.ok) return { ok: false, error: `Twitch validate failed (${r.status}).` };
      const j = await r.json();
      const scopes = j.scopes || [];
      const missing = ['chat:read', 'chat:edit'].filter((s) => !scopes.includes(s));
      if (missing.length) return { ok: false, error: `Token is missing scope(s): ${missing.join(', ')}` };
      return { ok: true, login: String(j.login || '').toLowerCase(), expiresIn: j.expires_in };
    }

    // Minimal Twitch IRC-over-WebSocket client.
    let ws = null, joined = null, wsLogin = '', lastSentAt = 0;
    function connect(token, login) {
      if (ws && ws.readyState === WebSocket.OPEN && wsLogin === login && joined) return joined;
      if (ws) { try { ws.close(); } catch (e) { /* ignore */ } }
      wsLogin = login;
      joined = new Promise((resolve, reject) => {
        const sock = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
        ws = sock;
        const timer = setTimeout(() => reject(new Error('Twitch chat: connection timed out')), 10000);
        sock.onopen = () => {
          sock.send(`PASS oauth:${token}`);
          sock.send(`NICK ${login}`);
          sock.send(`JOIN #${login}`);
        };
        sock.onmessage = (ev) => {
          for (const line of String(ev.data).split('\r\n')) {
            if (!line) continue;
            if (line.startsWith('PING')) sock.send(`PONG${line.slice(4)}`);
            else if (line.includes(` JOIN #${login}`)) { clearTimeout(timer); resolve(); }
            else if (/NOTICE \* :(Login authentication failed|Improperly formatted auth)/.test(line)) {
              clearTimeout(timer);
              reject(new Error('Twitch rejected the token'));
            }
          }
        };
        sock.onerror = () => { clearTimeout(timer); reject(new Error('Twitch chat connection failed')); };
        sock.onclose = () => { if (ws === sock) { ws = null; joined = null; } };
      });
      joined.catch(() => { joined = null; });
      return joined;
    }

    async function say(text, sender) {
      const cfg = await loadCfg();
      if (!cfg.enabled) return { ok: false, error: 'Auto-play is switched off.' };
      if (!cfg.token || !cfg.login) return { ok: false, error: 'No validated token. Save one in the popup.' };
      if (!GUESS_RE.test(text)) return { ok: false, error: 'Only "<number> <number>" guesses can be sent.' };
      const from = sender && sender.tab && sender.tab.url ? new URL(sender.tab.url).hostname : '';
      if (!/(^|\.)streampairs\.com$/.test(from)) return { ok: false, error: 'Auto-play only works from the streampairs.com host screen.' };
      const wait = lastSentAt + MIN_GAP_MS - Date.now();
      if (wait > 0) return { ok: false, error: 'Too soon after the previous message.' };
      await connect(cleanToken(cfg.token), cfg.login);
      ws.send(`PRIVMSG #${cfg.login} :${text}`);
      lastSentAt = Date.now();
      return { ok: true };
    }

    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || (msg.type !== 'autoplay:validate' && msg.type !== 'autoplay:say')) return false;
      const job = msg.type === 'autoplay:validate' ? validate(msg.token) : say(String(msg.text || ''), sender);
      job.then(sendResponse, (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
      return true;
    });
    SP.autoplay = { worker: true };
    return;
  }

  // ------------------------------------------------------------------ popup
  if (isPopup) {
    const $ = (id) => document.getElementById(id);
    const show = (cfg, note) => {
      $('apEnabled').checked = !!cfg.enabled;
      $('apInterval').value = cfg.intervalSec;
      $('apStatus').textContent = note || (cfg.login
        ? `Token OK: posts as ${cfg.login} to #${cfg.login} only.`
        : 'No token saved. Needs a Twitch token with scopes chat:read and chat:edit.');
    };
    loadCfg().then((cfg) => show(cfg));
    $('apSave').addEventListener('click', async () => {
      const token = cleanToken($('apToken').value);
      if (!token) { show(await loadCfg(), 'Paste a token first.'); return; }
      $('apStatus').textContent = 'Checking token with Twitch…';
      const r = await chrome.runtime.sendMessage({ type: 'autoplay:validate', token });
      if (!r || !r.ok) { show(await loadCfg(), (r && r.error) || 'Validation failed.'); return; }
      $('apToken').value = '';
      show(await saveCfg({ token, login: r.login }));
    });
    $('apEnabled').addEventListener('change', async (e) => {
      const cfg = await loadCfg();
      if (e.target.checked && !cfg.login) { e.target.checked = false; show(cfg, 'Save a valid token first.'); return; }
      show(await saveCfg({ enabled: e.target.checked }));
    });
    $('apInterval').addEventListener('change', async (e) => {
      show(await saveCfg({ intervalSec: Math.max(2, Math.min(60, Number(e.target.value) || 5)) }));
    });
    SP.autoplay = { popup: true };
    return;
  }

  // ------------------------------------------------------------------ content
  if (!isContent) return;
  const onHostScreen = /(^|\.)streampairs\.com$/.test(location.hostname);

  const st = { cfg: null, level: -1, tried: new Set(), lastSent: 0, lastBusy: 0, sending: false, backoffUntil: 0, note: '' };
  loadCfg().then((c) => { st.cfg = c; });
  chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch[KEY]) st.cfg = { ...st.cfg, ...ch[KEY].newValue }; });

  const pairKey = (a, b) => (a.i < b.i ? `${a.i}/${b.i}` : `${b.i}/${a.i}`);
  const shuffle = (arr) => { for (let i = arr.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };

  /**
   * Next guess, from the helper's memory:
   *  1. a known pair (both cards seen and matching)
   *  2. two never-seen cards (reveals the most per guess)
   *  3. the last unseen card with a half-known one
   *  4. two half-known cards that were not tried together yet
   * Never repeats a combination already tried in this level.
   */
  function choose(C) {
    const fresh = (a, b) => a && b && a !== b && !st.tried.has(pairKey(a, b));
    for (const p of C.result.known) if (fresh(p.a, p.b)) return [p.a, p.b];
    const tiles = C.memory.tiles;
    const unseen = shuffle(tiles.filter((t) => t.state === 'hidden' && !t.fp));
    const half = C.result.half.map((h) => h.tile);
    for (let i = 0; i < unseen.length; i++) for (let j = i + 1; j < unseen.length; j++) if (fresh(unseen[i], unseen[j])) return [unseen[i], unseen[j]];
    for (const u of unseen) for (const h of half) if (fresh(u, h)) return [u, h];
    for (let i = 0; i < half.length; i++) for (let j = i + 1; j < half.length; j++) if (fresh(half[i], half[j])) return [half[i], half[j]];
    return null;
  }

  /** Called by content.js after each analysed frame. Returns a status note for the panel. */
  async function tick(C) {
    const cfg = st.cfg;
    if (!cfg || !cfg.enabled) return '';
    if (!onHostScreen) return 'Auto-play: only on the streampairs.com host screen';
    if (!C.running || !C.grid || C.memory.frozen) return 'Auto-play: waiting for a board';
    const now = Date.now();
    if (C.memory.levelId !== st.level) { st.level = C.memory.levelId; st.tried.clear(); }
    const last = st.note ? ` (last: ${st.note.replace(/^Auto-play /, '')})` : '';
    // Let the previous guess finish: nothing face-up or flipping, then a short pause.
    const busy = C.memory.tiles.filter((t) => t.state === 'flipping' || t.state === 'revealed');
    if (busy.length) {
      st.lastBusy = now;
      return `Auto-play: waiting for card${busy.length > 1 ? 's' : ''} ${busy.slice(0, 4).map((t) => t.num).join(', ')} to settle${last}`;
    }
    if (st.sending) return 'Auto-play: sending…';
    if (now < st.backoffUntil) return `${st.note} · retry in ${Math.ceil((st.backoffUntil - now) / 1000)} s`;
    const due = Math.max(st.lastBusy + 1500, st.lastSent + (cfg.intervalSec || 5) * 1000);
    if (now < due) return `Auto-play: next guess in ${Math.ceil((due - now) / 1000)} s${last}`;
    const g = choose(C);
    if (!g) {
      return C.result.stuck && C.result.stuck.length
        ? 'Auto-play stuck: teach the cards under "Needs teaching"'
        : 'Auto-play: nothing left to try in this level';
    }
    const text = `${g[0].num} ${g[1].num}`;
    st.sending = true;
    try {
      const r = await chrome.runtime.sendMessage({ type: 'autoplay:say', text });
      if (r && r.ok) {
        st.tried.add(pairKey(g[0], g[1]));
        st.lastSent = Date.now();
        st.note = `Auto-play sent "${text}"`;
      } else {
        st.backoffUntil = Date.now() + 15000;
        st.note = `Auto-play paused: ${(r && r.error) || 'send failed'}`;
      }
    } catch (e) {
      st.backoffUntil = Date.now() + 15000;
      st.note = `Auto-play paused: ${String((e && e.message) || e)}`;
    } finally {
      st.sending = false;
    }
    return st.note;
  }

  SP.autoplay = { tick };
})();
