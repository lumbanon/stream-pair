// Pair learning.
//
//  - SP.PairDB: IndexedDB store of learned pairs / non-pairs. Lives in the
//    extension origin (service worker, popup, gallery), so the knowledge is
//    shared across every stream and site and survives browser restarts.
//  - SP.Learner: content-side logic that watches reveal events, groups the
//    two tiles of each guess, and reports outcomes to the service worker.
//
// Entry shape: { id, a: {dhash, phash, hist, thumb}, b: {...}, timesSeen,
//                source: 'auto' | 'teach' | 'import', created, updated }
// Pairs are symmetric: (a,b) and (b,a) are the same entry.
(() => {
  const SP = (globalThis.SP = globalThis.SP || {});
  if (SP.PairDB) return;

  const DB_NAME = 'stream-pairs';
  const DB_VERSION = 1;
  const STORES = ['pairs', 'nonpairs'];
  const DEDUPE = { hashType: 'dhash', hashThreshold: 6, histMin: 0.6, pictureMax: 34 };

  function req(r) {
    return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  }

  function side(fp, thumb) {
    return { dhash: fp.dhash, dhashv: fp.dhashv || null, phash: fp.phash, hist: Array.from(fp.hist), tiny: fp.tiny || null, thumb: thumb || null };
  }

  /** Does entry e describe the same pair as (a, b), in either order? */
  function samePair(e, a, b, S) {
    const c = SP.hash.compare;
    return (c(e.a, a, S).near && c(e.b, b, S).near) || (c(e.a, b, S).near && c(e.b, a, S).near);
  }

  class PairDB {
    constructor() { this.dbp = null; }

    open() {
      if (this.dbp) return this.dbp;
      this.dbp = new Promise((res, rej) => {
        const r = indexedDB.open(DB_NAME, DB_VERSION);
        r.onupgradeneeded = () => {
          for (const s of STORES) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s, { keyPath: 'id', autoIncrement: true });
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      return this.dbp;
    }

    async tx(store, mode, fn) {
      const db = await this.open();
      const t = db.transaction(store, mode);
      const done = new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
      const out = await fn(t.objectStore(store));
      await done;
      return out;
    }

    all(store = 'pairs') { return this.tx(store, 'readonly', (s) => req(s.getAll())); }
    count(store = 'pairs') { return this.tx(store, 'readonly', (s) => req(s.count())); }
    remove(store, id) { return this.tx(store, 'readwrite', (s) => req(s.delete(id))); }
    clear(store) { return this.tx(store, 'readwrite', (s) => req(s.clear())); }

    /**
     * Insert a pair, or bump timesSeen of an existing equivalent entry.
     * Returns { id, merged }.
     */
    async add(store, entry, S = DEDUPE) {
      const existing = await this.all(store);
      const now = Date.now();
      const hit = existing.find((e) => samePair(e, entry.a, entry.b, S));
      if (hit) {
        hit.timesSeen = (hit.timesSeen || 1) + (entry.timesSeen || 1);
        hit.updated = now;
        if (entry.source === 'teach') hit.source = 'teach';
        hit.a.thumb = hit.a.thumb || entry.a.thumb;
        hit.b.thumb = hit.b.thumb || entry.b.thumb;
        await this.tx(store, 'readwrite', (s) => req(s.put(hit)));
        return { id: hit.id, merged: true };
      }
      const rec = { a: entry.a, b: entry.b, timesSeen: entry.timesSeen || 1, source: entry.source || 'auto', created: entry.created || now, updated: now };
      const id = await this.tx(store, 'readwrite', (s) => req(s.add(rec)));
      return { id, merged: false };
    }

    /** Undo one observation (a "match" that turned out to be wrong). */
    async unlearn(store, id) {
      const e = await this.tx(store, 'readonly', (s) => req(s.get(id)));
      if (!e) return;
      e.timesSeen = (e.timesSeen || 1) - 1;
      if (e.timesSeen <= 0 && e.source !== 'teach') await this.remove(store, id);
      else await this.tx(store, 'readwrite', (s) => req(s.put(e)));
    }

    async exportJSON() {
      const strip = (e) => { const { id, ...rest } = e; return rest; };
      return {
        format: 'stream-pairs-helper-db',
        version: 1,
        exported: new Date().toISOString(),
        pairs: (await this.all('pairs')).map(strip),
        nonPairs: (await this.all('nonpairs')).map(strip),
      };
    }

    async importJSON(obj, S = DEDUPE) {
      if (!obj || obj.format !== 'stream-pairs-helper-db') throw new Error('Not a Stream Pairs Helper export');
      let n = 0;
      for (const e of obj.pairs || []) { if (e.a && e.b) { await this.add('pairs', { ...e, source: e.source || 'import' }, S); n++; } }
      for (const e of obj.nonPairs || []) { if (e.a && e.b) await this.add('nonpairs', e, S); }
      return n;
    }
  }

  /**
   * Watches reveal/hide/matched events and learns from guesses.
   *
   * Viewers type two numbers per guess and the game flips both tiles at
   * (almost) the same moment. So a reveal is linked to the closest other
   * unlinked reveal within pairWindowMs. When both tiles of a guess have an
   * outcome:
   *   both matched      -> they are a pair. If their pictures differ (not an
   *                        identical pair) it is a complement relationship:
   *                        store it in the pair DB.
   *   both flipped back -> optionally store as a known NON-pair.
   *
   * Safety rules (wrong entries make the helper suggest wrong pairs):
   *  - Ambiguous guesses are never learned: if more than two reveals overlap
   *    in time (several viewers guessing at once) we cannot tell which two
   *    tiles belonged together.
   *  - A level is either "identical" or "complement". As soon as one
   *    identical pair is confirmed in a level, nothing more is learned in
   *    that level and any complement pair learned earlier in it is undone.
   *  - Non-pairs are only recorded once the level is known to be a
   *    complement level (in identical levels they carry no information).
   */
  class Learner {
    constructor() {
      this.open = [];
      this.learnedByTile = new Map();
      this.pairs = [];
      this.nonPairs = [];
      this.stats = { identical: 0, complement: 0, skipped: 0 };
    }

    async refresh() {
      try {
        const r = await chrome.runtime.sendMessage({ type: 'db:all' });
        if (r && !r.error) { this.pairs = r.pairs || []; this.nonPairs = r.nonPairs || []; }
      } catch (e) { /* worker restarting; keep cache */ }
    }

    resetLevel() {
      this.open = [];
      this.learnedByTile.clear();
      this.stats = { identical: 0, complement: 0, skipped: 0 };
    }

    onEvents(events, memory, S) {
      for (const e of events) {
        if (e.type === 'reveal') {
          const rec = { tile: e.tile, t: e.t, result: null, partner: null, ambiguous: false };
          const overlap = this.open.filter((o) => !o.result && o.tile !== e.tile && Math.abs(o.t - e.t) <= S.pairWindowMs);
          let best = null;
          for (const o of overlap) {
            if (o.partner) continue;
            if (!best || Math.abs(o.t - e.t) < Math.abs(best.t - e.t)) best = o;
          }
          if (overlap.length >= 2) {
            rec.ambiguous = true;
            for (const o of overlap) { o.ambiguous = true; if (o.partner) o.partner.ambiguous = true; }
          }
          if (best) { best.partner = rec; rec.partner = best; }
          this.open.push(rec);
        } else if (e.type === 'hide' || e.type === 'matched') {
          const rec = [...this.open].reverse().find((o) => o.tile === e.tile && !o.result);
          if (!rec) continue;
          rec.result = e.type;
          if (rec.partner && rec.partner.result) this.resolve(rec, rec.partner, memory, S);
        } else if (e.type === 'unmatch') {
          const id = this.learnedByTile.get(e.tile);
          if (id != null) {
            for (const [k, v] of this.learnedByTile) if (v === id) this.learnedByTile.delete(k);
            chrome.runtime.sendMessage({ type: 'db:unlearn', store: 'pairs', id }).then(() => this.refresh()).catch(() => {});
          }
        }
      }
      const now = Date.now();
      this.open = this.open.filter((o) => now - o.t < 60000 && !(o.result && (!o.partner || o.partner.result)));
    }

    /** Undo every complement pair learned in this level (it was an identical level). */
    retractLevel() {
      const ids = new Set(this.learnedByTile.values());
      this.learnedByTile.clear();
      for (const id of ids) chrome.runtime.sendMessage({ type: 'db:unlearn', store: 'pairs', id }).catch(() => {});
      if (ids.size) setTimeout(() => this.refresh(), 300);
    }

    resolve(a, b, memory, S) {
      const tA = memory.tiles[a.tile], tB = memory.tiles[b.tile];
      if (!tA || !tB || !tA.fp || !tB.fp) return;
      const identical = SP.hash.compare(tA.fp, tB.fp, S).near;
      const ambiguous = a.ambiguous || b.ambiguous;
      if (a.result === 'matched' && b.result === 'matched') {
        if (identical) {
          this.stats.identical++;
          if (this.stats.identical === 1) this.retractLevel();
          return;
        }
        if (this.stats.identical > 0 || ambiguous) { this.stats.skipped++; return; }
        this.stats.complement++;
        this.save('pairs', tA, tB, 'auto');
      } else if (a.result === 'hide' && b.result === 'hide') {
        if (S.recordNonPairs && this.stats.complement > 0 && this.stats.identical === 0 && !ambiguous && !identical) {
          this.save('nonpairs', tA, tB, 'auto');
        }
      }
    }

    async save(store, tA, tB, source) {
      const entry = { a: side(tA.fp, tA.thumb), b: side(tB.fp, tB.thumb), source };
      try {
        const r = await chrome.runtime.sendMessage({ type: 'db:add', store, entry });
        if (r && r.id != null && store === 'pairs' && source === 'auto') {
          this.learnedByTile.set(tA.i, r.id);
          this.learnedByTile.set(tB.i, r.id);
        }
        await this.refresh();
        return r;
      } catch (e) {
        return { error: String(e) };
      }
    }

    /** Teach mode: the user says these two tiles are a pair. */
    teach(tA, tB) { return this.save('pairs', tA, tB, 'teach'); }
  }

  SP.PairDB = PairDB;
  SP.Learner = Learner;
})();
