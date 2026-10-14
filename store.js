/* =====================================================================
 *  FINANCE — store.js : local-first data layer (load after common.js)
 *   • month cache   : each visited month is kept in localStorage (5-min freshness) → no API call while fresh
 *   • optimistic    : add / edit / delete show instantly; saved to the sheet in the background
 *   • retry queue   : unsynced changes survive page reload; network errors retry, other errors are flagged
 *   • balances      : server balances + still-unsynced changes (never drifts)
 * ===================================================================== */
(function () {
  'use strict';
  if (typeof window === 'undefined' || !window.App) return;
  const A = window.App;

  const Q_KEY = 'finance_queue_v1', C_KEY = 'finance_txcache_v1', AN_PREFIX = 'finance_an_';
  const TTL = 5 * 60 * 1000, MAX_MONTHS = 8, RETRY_MS = 30000;

  const read = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (_) { return d; } };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* quota / private mode */ } };

  let queue = read(Q_KEY, []);          // [{id, kind:'save'|'delete', payload, item, old, state:'queued'|'failed', error}]
  let cache = read(C_KEY, {});          // {'YYYY-MM': {ts, items:[txn…]}}
  let running = false, inflight = null, retryTimer = null;

  const isTmp = (id) => String(id).indexOf('tmp_') === 0;
  const monthKey = (time) => String(time).slice(0, 7);
  const sortDesc = (items) => items.slice().sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const emit = () => window.dispatchEvent(new Event('finance:change'));
  const saveQ = () => write(Q_KEY, queue);
  const saveC = () => write(C_KEY, cache);
  const idle = () => !queue.some((o) => o.state === 'queued') && !inflight;
  const newTmp = () => 'tmp_' + Date.now().toString(36) + Math.floor(Math.random() * 1679616).toString(36);

  function invalidateAnalysis() {
    try { Object.keys(localStorage).filter((k) => k.indexOf(AN_PREFIX) === 0).forEach((k) => localStorage.removeItem(k)); } catch (_) {}
  }

  /* ----------------------------- month cache ----------------------------- */
  function cacheEntry(y, m) { return cache[y + '-' + A.pad(m + 1)] || null; }
  const isFresh = (e) => !!e && Date.now() - e.ts < TTL;

  function setMonth(key, items) {
    cache[key] = { ts: Date.now(), items: sortDesc(items) };
    const keys = Object.keys(cache).sort((a, b) => cache[b].ts - cache[a].ts);
    keys.slice(MAX_MONTHS).forEach((k) => delete cache[k]);
    saveC();
  }
  function cacheRemove(id) {
    Object.keys(cache).forEach((k) => { cache[k].items = cache[k].items.filter((t) => t.id !== id); });
  }
  function cacheAdd(item) {          // only months we already hold; others pick it up via mergeLocal on fetch
    const e = cache[monthKey(item.time)];
    if (e) e.items = sortDesc(e.items.concat([item]));
  }
  /** server list + every unsynced local change */
  function mergeLocal(key, serverItems) {
    let items = serverItems.slice();
    queue.forEach((op) => {
      if (op.kind === 'delete') items = items.filter((t) => t.id !== op.id);
      else { items = items.filter((t) => t.id !== op.item.id); if (monthKey(op.item.time) === key) items.push(op.item); }
    });
    return items;
  }

  /** Cached copy first is the caller's job; this fetches (waiting for unsynced changes first). */
  async function loadMonth(y, m, opts) {
    const key = y + '-' + A.pad(m + 1), e = cache[key];
    if (!(opts && opts.force) && isFresh(e)) return { items: e.items, fetched: false };
    await whenIdle(6000);
    const d = await A.call('list_transactions', A.monthBounds(y, m));
    setMonth(key, mergeLocal(key, d.transactions));
    return { items: cache[key].items, fetched: true };
  }

  /* ---------------------------- masters / balances ---------------------------- */
  function applyEffect(t, sign, d) {
    const add = (n, v) => { if (n) d[n] = (d[n] || 0) + v * sign; };
    if (t.type === 'Income') add(t.account, t.amount);
    else if (t.type === 'Transfer') { add(t.account, -t.amount); add(t.to_account, t.amount); }
    else add(t.account, -t.amount);
  }
  /** server truth + unsynced (non-failed) changes */
  function masters() {
    const base = A.cachedMasters() || { accounts: [], categories: [] };
    const d = {};
    queue.forEach((op) => {
      if (op.state === 'failed') return;
      if (op.old) applyEffect(op.old, -1, d);
      if (op.kind === 'save') applyEffect(op.item, 1, d);
    });
    return { accounts: base.accounts.map((a) => Object.assign({}, a, { balance: Math.round(((Number(a.balance) || 0) + (d[a.name] || 0)) * 100) / 100 })),
             categories: base.categories, ts: base.ts };
  }
  const mastersFresh = () => { const m = A.cachedMasters(); return !!m && Date.now() - (m.ts || 0) < TTL; };
  async function refreshMasters() { await A.refreshMasters(); emit(); return masters(); }

  /* ------------------------------ queue ops ------------------------------ */
  function opFor(id) { return queue.find((o) => o.id === id && o !== inflight); }

  function enqueue(op) { queue.push(op); afterChange(); }
  function afterChange() { saveQ(); saveC(); invalidateAnalysis(); emit(); run(); }

  function addTxn(f) {
    const item = Object.assign({}, f, { id: newTmp() });
    cacheAdd(item);
    enqueue({ id: item.id, kind: 'save', payload: Object.assign({}, f, { id: '' }), item, old: null, state: 'queued', error: '' });
    return item;
  }
  function editTxn(oldItem, f) {
    const item = Object.assign({}, f, { id: oldItem.id });
    cacheRemove(oldItem.id); cacheAdd(item);
    const op = opFor(oldItem.id);
    const payload = Object.assign({}, f, { id: isTmp(oldItem.id) ? '' : oldItem.id });
    if (op && op.kind === 'save') { op.item = item; op.payload = payload; op.state = 'queued'; op.error = ''; afterChange(); return item; }
    enqueue({ id: oldItem.id, kind: 'save', payload, item, old: isTmp(oldItem.id) ? null : clone(oldItem), state: 'queued', error: '' });
    return item;
  }
  function deleteTxn(item) {
    cacheRemove(item.id);
    const op = opFor(item.id);
    if (op && op.kind === 'save') {
      queue = queue.filter((o) => o !== op);
      if (isTmp(item.id)) { afterChange(); return; }          // never reached the sheet
      enqueue({ id: item.id, kind: 'delete', old: op.old || clone(item), state: 'queued', error: '' });
      return;
    }
    enqueue({ id: item.id, kind: 'delete', old: clone(item), state: 'queued', error: '' });
  }
  function retry(id) {
    const op = queue.find((o) => o.id === id && o.state === 'failed');
    if (op) { op.state = 'queued'; op.error = ''; afterChange(); }
  }
  const statusOf = (id) => { const o = queue.find((x) => x.id === id && x.kind === 'save'); return o ? (o.state === 'failed' ? 'failed' : 'queued') : null; };
  const errorOf = (id) => { const o = queue.find((x) => x.id === id && x.state === 'failed'); return o ? o.error : ''; };
  const pendingCount = () => queue.filter((o) => o.state === 'queued').length;

  function onSaved(op, realId) {
    queue = queue.filter((o) => o !== op);
    if (isTmp(op.id) && realId) {
      Object.keys(cache).forEach((k) => cache[k].items.forEach((t) => { if (t.id === op.id) t.id = realId; }));
      queue.forEach((o) => {       // later edits/deletes of the same new item now point to the real row
        if (o.id !== op.id) return;
        o.id = realId;
        if (o.item) o.item.id = realId;
        if (o.payload) o.payload.id = realId;
        if (o.kind === 'save' && !o.old) o.old = clone(Object.assign({}, op.item, { id: realId }));
      });
    }
  }

  async function run() {
    if (running) return;
    running = true;
    let stopped = false;
    try {
      for (;;) {
        const op = queue.find((o) => o.state === 'queued');
        if (!op) break;
        inflight = op; emit();
        try {
          if (op.kind === 'save') {
            const d = await A.call('save_transaction', op.payload);
            A.storeMasters(d); onSaved(op, d.saved_id);
          } else if (isTmp(op.id)) {
            queue = queue.filter((o) => o !== op);
          } else {
            try { A.storeMasters(await A.call('delete_transaction', { id: op.id })); }
            catch (e) { if (e.code !== 'not_found') throw e; }
            queue = queue.filter((o) => o !== op);
          }
        } catch (err) {
          if (err.code === 'network' || err.code === 'session_expired' || err.code === 'config') { stopped = true; if (err.code === 'network') A.toast('Offline — changes will sync when you are back online.', 'error'); break; }
          op.state = 'failed'; op.error = err.message || 'Could not save.';
          A.toast('Not saved: ' + op.error, 'error');
        }
        inflight = null; saveQ(); saveC(); emit();
      }
    } finally {
      inflight = null; running = false; saveQ(); saveC(); invalidateAnalysis(); emit();
    }
    if (stopped) { clearTimeout(retryTimer); retryTimer = setTimeout(run, RETRY_MS); }
  }
  const resume = () => { if (queue.some((o) => o.state === 'queued')) return run(); return Promise.resolve(); };
  window.addEventListener('online', resume);

  function whenIdle(maxMs) {
    if (idle()) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { window.removeEventListener('finance:change', check); clearTimeout(t); resolve(); };
      const check = () => { if (idle()) done(); };
      const t = setTimeout(done, maxMs || 6000);
      window.addEventListener('finance:change', check);
    });
  }

  /* ---------------------------- analysis cache ---------------------------- */
  const getAnalysis = (key) => read(AN_PREFIX + key, null);
  const setAnalysis = (key, data) => write(AN_PREFIX + key, { ts: Date.now(), data });

  A.store = { TTL, cacheEntry, isFresh, loadMonth, masters, mastersFresh, refreshMasters,
    addTxn, editTxn, deleteTxn, retry, statusOf, errorOf, pendingCount, resume, whenIdle,
    getAnalysis, setAnalysis, invalidateAnalysis };
})();
