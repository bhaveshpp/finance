/* =====================================================================
 *  FINANCE — common.js : config, API, session, cache, helpers, header/nav, bottom-sheet
 *  Only thing to configure: API_URL
 * ===================================================================== */
(function () {
  'use strict';

  /* ============ CONFIG: paste your Apps Script Web App URL ============ */
  const API_URL = 'https://script.google.com/macros/s/AKfycbxD0m_AOc0beP0CNDZWNZJNOK3DG2qn9O1hpyAGAQsZFrtMCztiIm-J9pcSiHfNcX_piA/exec';   // https://script.google.com/macros/s/XXXX/exec
  /* =================================================================== */

  const SESSION_KEY = 'finance_session_v1';
  const MASTERS_KEY = 'finance_masters_v1';
  const FLASH_KEY = 'finance_flash_v1';
  const TYPES = ['Income', 'Expense', 'Investment', 'Transfer'];

  /* ---------------------------- pure helpers ---------------------------- */
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const nowLocalInput = () => { const d = new Date(); return ymd(d) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()); };

  /** m = 0..11 → {from:'YYYY-MM-01', to:'YYYY-MM-last'} */
  function monthBounds(y, m) {
    const last = new Date(y, m + 1, 0).getDate();
    return { from: y + '-' + pad(m + 1) + '-01', to: y + '-' + pad(m + 1) + '-' + pad(last) };
  }
  function shiftMonth(y, m, delta) {
    const d = new Date(y, m + delta, 1);
    return { y: d.getFullYear(), m: d.getMonth() };
  }
  function money(n) {
    return Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }
  /** Income +200 (green) · Expense -200 (red) · Investment *200 (blue) · Transfer 200 (black) */
  function amountView(t) {
    const a = money(t.amount);
    if (t.type === 'Income') return { text: '+' + a, cls: 'amt-income' };
    if (t.type === 'Expense') return { text: '-' + a, cls: 'amt-expense' };
    if (t.type === 'Investment') return { text: '*' + a, cls: 'amt-invest' };
    return { text: a, cls: 'amt-transfer' };
  }
  function dayLabel(dateStr) {
    const p = dateStr.split('-').map(Number);
    return new Date(p[0], p[1] - 1, p[2]).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  }
  function timeLabel(timeStr) {
    const p = timeStr.slice(11, 16).split(':').map(Number);
    const h = p[0] % 12 || 12;
    return h + ':' + pad(p[1]) + ' ' + (p[0] < 12 ? 'AM' : 'PM');
  }
  /** list is already newest-first → [{date, items[]}] */
  function groupByDate(list) {
    const out = [];
    list.forEach((t) => {
      const d = t.time.slice(0, 10);
      if (!out.length || out[out.length - 1].date !== d) out.push({ date: d, items: [] });
      out[out.length - 1].items.push(t);
    });
    return out;
  }
  function totals(list) {
    const s = { Income: 0, Expense: 0, Investment: 0, Transfer: 0 };
    list.forEach((t) => { s[t.type] += Number(t.amount) || 0; });
    return s;
  }
  function shortDay(key) {            // 'YYYY-MM-DD' → '13 Oct, Tue'
    const p = key.split('-').map(Number);
    return new Date(p[0], p[1] - 1, p[2]).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', weekday: 'short' });
  }
  function monthName(key, long) {     // 'YYYY-MM' → 'Oct' / 'October 2026'
    const p = key.split('-').map(Number);
    return new Date(p[0], p[1] - 1, 1).toLocaleDateString('en-IN', long ? { month: 'long', year: 'numeric' } : { month: 'short' });
  }
  const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000) + 1;
  function initial(name) { return (Array.from(String(name || '?').trim())[0] || '?').toUpperCase(); }

  const pure = { pad, ymd, nowLocalInput, monthBounds, shiftMonth, money, amountView, dayLabel, timeLabel, groupByDate, totals, shortDay, monthName, daysBetween, initial, TYPES };
  if (typeof module !== 'undefined' && module.exports) module.exports = pure;
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  /* ------------------------------ DOM utils ------------------------------ */
  const $ = (id) => document.getElementById(id);

  /** Tiny DOM builder — text always inserted as text nodes (never innerHTML). */
  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach((k) => {
        const v = props[k];
        if (v == null || v === false) return;
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else if (k === 'value') n.value = v;
        else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), v);
        else n.setAttribute(k, v === true ? '' : v);
      });
    }
    kids.flat(Infinity).forEach((c) => { if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c))); });
    return n;
  }

  function toast(message, type = 'ok') {
    let box = $('toasts');
    if (!box) { box = el('div', { id: 'toasts', class: 'toasts' }); document.body.appendChild(box); }
    const t = el('div', { class: 'toast ' + (type === 'error' ? 'toast-err' : 'toast-ok'), text: message });
    box.appendChild(t);
    setTimeout(() => t.remove(), type === 'error' ? 4500 : 2500);
  }
  function flash(message, type = 'ok') { try { sessionStorage.setItem(FLASH_KEY, JSON.stringify({ message, type })); } catch (_) {} }
  function showFlash() {
    try {
      const raw = sessionStorage.getItem(FLASH_KEY);
      if (!raw) return;
      sessionStorage.removeItem(FLASH_KEY);
      const f = JSON.parse(raw);
      if (f && f.message) toast(f.message, f.type);
    } catch (_) {}
  }
  function setBusy(btn, busy) {
    btn.disabled = busy;
    btn.classList.toggle('busy', busy);
  }

  /* ------------------------------- Session ------------------------------- */
  let session = null;
  function loadSession() {
    try {
      const s = JSON.parse(localStorage.getItem(SESSION_KEY));
      if (s && s.username && s.token && s.exp > Date.now()) return s;
    } catch (_) {}
    return null;
  }
  function saveSession(s) { session = s; try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch (_) {} }
  function clearSession() { session = null; try { Object.keys(localStorage).filter((k) => k.indexOf('finance_') === 0 && k !== FLASH_KEY).forEach((k) => localStorage.removeItem(k)); } catch (_) {} }

  function requireLogin() {
    const s = loadSession();
    if (!s) { location.replace('index.html'); return null; }
    session = s;
    showFlash();
    return s;
  }
  function logout() {
    clearSession();
    flash('Logged out.');
    location.replace('index.html');
  }

  /* ---------------------------------- API ---------------------------------- */
  class ApiError extends Error { constructor(code, message) { super(message); this.code = code; } }

  async function api(action, payload = {}) {
    if (API_URL.indexOf('PASTE_') === 0) throw new ApiError('config', 'API_URL is not set in common.js yet.');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    let res;
    try {
      // text/plain = "simple" request → no CORS preflight (Apps Script cannot answer OPTIONS)
      res = await fetch(API_URL, {
        method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ action }, payload)), signal: ctrl.signal
      });
    } catch (_) { throw new ApiError('network', 'Network problem. Check internet and try again.'); }
    finally { clearTimeout(timer); }
    let data;
    try { data = await res.json(); } catch (_) { throw new ApiError('bad_response', 'Unexpected server response.'); }
    if (!data.success) {
      if (data.error === 'session_expired') { clearSession(); flash('Session expired. Please login again.', 'error'); location.replace('index.html'); }
      throw new ApiError(data.error || 'error', data.message || 'Something went wrong.');
    }
    return data;
  }
  function call(action, payload = {}) {
    if (!session) throw new ApiError('session_expired', 'Please login again.');
    return api(action, Object.assign({ username: session.username, token: session.token }, payload));
  }

  /* --------------------- Static data (accounts + categories) --------------------- */
  function cachedMasters() {
    try { const m = JSON.parse(localStorage.getItem(MASTERS_KEY)); if (m && m.accounts && m.categories) return m; } catch (_) {}
    return null;
  }
  function storeMasters(d) {
    const m = { accounts: d.accounts || [], categories: d.categories || [], ts: Date.now() };   // server truth (balances exclude unsynced changes)
    try { localStorage.setItem(MASTERS_KEY, JSON.stringify(m)); } catch (_) {}
    return m;
  }
  /** Fetches fresh accounts + categories from the sheet and stores them in localStorage. */
  async function refreshMasters() { return storeMasters(await call('bootstrap')); }

  /* --------------------------- Header + bottom nav --------------------------- */
  function mountHeader(title, onRefresh) {
    const host = $('hdr');
    const menu = el('div', { class: 'menu', hidden: true },
      el('div', { class: 'menu-note', text: (session && session.name) || '' }),
      el('button', { class: 'menu-item', type: 'button', text: '⟳  Refresh', onclick: () => { closeMenu(); onRefresh && onRefresh(); } }),
      el('button', { class: 'menu-item danger', type: 'button', text: '⎋  Logout', onclick: logout })
    );
    const avatar = el('button', { class: 'avatar', type: 'button', 'aria-label': 'Profile', text: initial(session && session.name) });
    function closeMenu() { menu.hidden = true; }
    avatar.addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; });
    menu.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('click', closeMenu);
    host.replaceChildren(el('div', { class: 'hdr-bar' }, el('h1', { class: 'hdr-title', text: title }), el('div', { class: 'menu-wrap' }, avatar, menu)));
  }

  function mountNav(active) {
    const items = [['home', 'home.html', '🏠', 'Home'], ['analysis', 'analysis.html', '📊', 'Analysis'], ['accounts', 'accounts.html', '🏦', 'Accounts'], ['categories', 'categories.html', '🏷️', 'Categories']];
    $('nav').replaceChildren(el('div', { class: 'nav-inner' }, ...items.map((i) => el('a', { class: 'nav-item' + (i[0] === active ? ' active' : ''), href: i[1] }, el('span', { class: 'nav-ico', text: i[2] }), el('span', { text: i[3] })))));
  }

  /* ------------------------------ Bar chart (SVG) ------------------------------ */
  /** series: [{key, income, expense, invest}] · group 'day' | 'month'. Scrolls sideways when wide. */
  function barChart(series, group) {
    const NS = 'http://www.w3.org/2000/svg';
    const gw = group === 'day' ? 30 : 46, bw = group === 'day' ? 8 : 11, H = 140, LBL = 18;
    const max = Math.max(1, ...series.map((s) => Math.max(s.income, s.expense, s.invest)));
    const svg = document.createElementNS(NS, 'svg');
    const W = series.length * gw + 8;
    svg.setAttribute('width', W); svg.setAttribute('height', H + LBL);
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + (H + LBL)); svg.setAttribute('role', 'img');
    const mk = (tag, attrs, text) => { const n = document.createElementNS(NS, tag); Object.keys(attrs).forEach((k) => n.setAttribute(k, attrs[k])); if (text != null) n.textContent = text; return n; };
    series.forEach((s, i) => {
      const g = mk('g', {});
      const label = group === 'day' ? shortDay(s.key) : monthName(s.key);
      g.append(mk('title', {}, label + ' — Income ' + money(s.income) + ', Expense ' + money(s.expense) + ', Invest ' + money(s.invest)));
      [['income', s.income], ['expense', s.expense], ['invest', s.invest]].forEach((b, k) => {
        const h = b[1] > 0 ? Math.max(2, Math.round((b[1] / max) * (H - 6))) : 0;
        if (h) g.append(mk('rect', { x: 4 + i * gw + k * (bw + 1), y: H - h, width: bw, height: h, rx: 1.5, class: 'b-' + b[0] }));
      });
      g.append(mk('text', { x: 4 + i * gw + (3 * bw + 2) / 2, y: H + 13, 'text-anchor': 'middle', class: 'b-lbl' }, group === 'day' ? s.key.slice(8).replace(/^0/, '') : monthName(s.key)));
      svg.append(g);
    });
    svg.append(mk('line', { x1: 0, x2: W, y1: H, y2: H, class: 'b-axis' }));
    return el('div', { class: 'chart-scroll' }, svg);
  }

  /* ------------------------------ Bottom sheet ------------------------------ */
  /** Opens a modal bottom-sheet. Returns close(). */
  function openSheet(title, content) {
    const close = () => { overlay.remove(); document.body.classList.remove('no-scroll'); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const sheet = el('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' },
      el('div', { class: 'sheet-head' }, el('h2', { text: title }), el('button', { class: 'sheet-x', type: 'button', 'aria-label': 'Close', text: '✕', onclick: close })),
      content);
    const overlay = el('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay) close(); } }, sheet);
    document.body.appendChild(overlay);
    document.body.classList.add('no-scroll');
    document.addEventListener('keydown', onKey);
    return close;
  }

  window.App = Object.assign({
    $, el, toast, flash, showFlash, setBusy, api, call, ApiError,
    loadSession, saveSession, requireLogin, logout,
    cachedMasters, refreshMasters, storeMasters,
    mountHeader, mountNav, openSheet, barChart
  }, pure);
})();
