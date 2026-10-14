/**
 * =====================================================================
 *  FINANCE — Money Manager · Google Apps Script backend (Code.gs)
 *  API_VERSION 1.1-finance
 * =====================================================================
 *  SETUP (one time)
 *  1. New Google Sheet → Extensions → Apps Script → paste this whole file.
 *  2. Edit ADMIN_USERNAME / ADMIN_NAME / ADMIN_PASSWORD (bottom of file, in createUser),
 *     then run  setupSheets  once  (creates all tabs + Analysis), then run  createUser.
 *  3. Deploy → New deployment → Web app → Execute as: Me · Who has access: Anyone → Deploy.
 *  4. Copy the Web app URL → paste into API_URL in site/common.js.
 *  UPDATING: Deploy → Manage deployments → pencil → Version: New version → Deploy.
 *
 *  Tabs: Users | Transactions | Accounts | Category | Analysis
 *  Analysis is built by setupSheets (change FROM / TO in B1 / B2 → everything recalculates).
 *  Every data action needs a valid username + token. Passwords are salted hashes.
 * =====================================================================
 */

var SHEET_USERS = 'Users';
var SHEET_TXN   = 'Transactions';
var SHEET_ACC   = 'Accounts';
var SHEET_CAT   = 'Category';
var SHEET_ANA   = 'Analysis';

var HEADERS = {
  Users:        ['Username', 'Name', 'Password', 'Status'],
  Transactions: ['ID', 'Time', 'Type', 'Amount', 'Category', 'Account', 'To_Account', 'Notes'],
  Accounts:     ['ID', 'Name', 'Opening_Balance', 'Current_Balance', 'Icon', 'Note'],
  Category:     ['ID', 'Name', 'Type', 'Icon', 'Budget', 'Note']
};

var TYPES     = ['Income', 'Expense', 'Investment', 'Transfer'];
var CAT_TYPES = ['Income', 'Expense', 'Investment'];

var SESSION_DAYS     = 30;
var MAX_ATTEMPTS     = 5;
var LOCKOUT_SECONDS  = 900;
var MAX_RANGE_ROWS   = 3000;
var TIME_ZONE        = 'Asia/Kolkata';
var TIME_FMT         = "yyyy-MM-dd'T'HH:mm";

var API_VERSION = '1.1-finance';

// --------------------------- HTTP ENTRY -----------------------------

function doGet(e) {
  return json_({ success: true, version: API_VERSION, message: 'Finance API is running. Send POST requests.' });
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) throw new ApiError('bad_request', 'Empty request.');
    var body;
    try { body = JSON.parse(e.postData.contents); }
    catch (x) { throw new ApiError('bad_request', 'Invalid JSON.'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError('bad_request', 'Invalid request.');

    switch (body.action) {
      case 'login':              return ok_(login_(body));
      case 'bootstrap':          return ok_(bootstrap_(body));
      case 'list_transactions':  return ok_(listTransactions_(body));
      case 'get_analysis':       return ok_(getAnalysis_(body));
      case 'save_transaction':   return ok_(withLock_(function () { return saveTransaction_(body); }));
      case 'delete_transaction': return ok_(withLock_(function () { return deleteTransaction_(body); }));
      case 'save_account':       return ok_(withLock_(function () { return saveAccount_(body); }));
      case 'save_category':      return ok_(withLock_(function () { return saveCategory_(body); }));
      default: throw new ApiError('bad_request', 'Unknown action.');
    }
  } catch (err) {
    if (err instanceof ApiError) return fail_(err.code, err.message);
    console.error(err && err.stack ? err.stack : err);
    return fail_('server_error', 'Server error. Please try again.');
  }
}

// ----------------------------- ACTIONS ------------------------------

function login_(body) {
  var username = str_(body.username, 60);
  var password = String(body.password == null ? '' : body.password);
  var invalid = new ApiError('invalid_credentials', 'Invalid Credentials');
  if (!username || !password) throw invalid;
  assertNotLocked_(username);

  var user = findUser_(username);
  if (!user || user.status !== 'Active' || !verifyPassword_(user.password, password)) {
    recordFailure_(username);
    throw invalid;
  }
  clearFailures_(username);

  if (user.password.indexOf('sha256$') !== 0) {   // upgrade plain-text password
    withLock_(function () {
      user.password = hashPassword_(password);
      user.t.sh.getRange(user.row, user.t.idx.Password + 1).setNumberFormat('@').setValue(user.password);
    });
  }
  var tk = makeToken_(user);
  return { token: tk.token, expires: tk.expires, user: { username: user.username, name: user.name } };
}

/** Static data for the app: accounts (with live balance) + categories. */
function bootstrap_(body) {
  authenticate_(body);
  return masters_();
}

function masters_() {
  return { accounts: accountsWithBalance_(), categories: readCategories_() };
}

function listTransactions_(body) {
  authenticate_(body);
  var from = dateKey_(body.from), to = dateKey_(body.to);
  if (from > to) throw new ApiError('bad_request', 'Invalid date range.');

  var list = readTxns_().filter(function (t) {
    var d = t.time.slice(0, 10);
    return d >= from && d <= to;
  });
  list.sort(function (a, b) { return a.time < b.time ? 1 : a.time > b.time ? -1 : 0; });
  if (list.length > MAX_RANGE_ROWS) list = list.slice(0, MAX_RANGE_ROWS);
  list.forEach(function (t) { delete t._row; });
  return { from: from, to: to, transactions: list };
}

function saveTransaction_(body) {
  authenticate_(body);
  var accs = readAccounts_(), cats = readCategories_();
  var c = cleanTxn_(body, accs, cats);
  var t = table_(SHEET_TXN);
  var id = str_(body.id, 40);

  var rowIdx = -1;
  if (id) {
    t.rows.forEach(function (r, i) { if (String(r[t.idx.ID]) === id) rowIdx = i; });
    if (rowIdx < 0) throw new ApiError('not_found', 'Transaction not found.');
  }
  var row = rowIdx < 0 ? blankRow_(t) : t.rows[rowIdx].slice();
  row[t.idx.ID]         = rowIdx < 0 ? newId_('T') : id;
  row[t.idx.Time]       = c.date;
  row[t.idx.Type]       = c.type;
  row[t.idx.Amount]     = c.amount;
  row[t.idx.Category]   = c.category;
  row[t.idx.Account]    = c.account;
  row[t.idx.To_Account] = c.to_account;
  row[t.idx.Notes]      = safeText_(c.note);

  var target = rowIdx < 0 ? Math.max(t.sh.getLastRow(), 1) + 1 : rowIdx + 2;
  t.sh.getRange(target, 1, 1, t.width).setValues([row]);
  var out = masters_();
  out.saved_id = row[t.idx.ID];
  return out;
}

function deleteTransaction_(body) {
  authenticate_(body);
  var id = str_(body.id, 40);
  if (!id) throw new ApiError('bad_request', 'Missing id.');
  var t = table_(SHEET_TXN), rowIdx = -1;
  t.rows.forEach(function (r, i) { if (String(r[t.idx.ID]) === id) rowIdx = i; });
  if (rowIdx < 0) throw new ApiError('not_found', 'Transaction not found.');
  t.sh.deleteRow(rowIdx + 2);
  return masters_();
}

function saveAccount_(body) {
  authenticate_(body);
  var t = table_(SHEET_ACC);
  var name = cleanName_(body.name);
  var opening = body.opening_balance === '' || body.opening_balance == null ? 0 : Number(body.opening_balance);
  if (!isFinite(opening) || Math.abs(opening) > 1e10) throw new ApiError('bad_request', 'Invalid opening balance.');
  opening = Math.round(opening * 100) / 100;
  var icon = str_(body.icon, 8) || '🏦';
  var note = strMulti_(body.note, 300);
  var id = str_(body.id, 40);

  var rowIdx = findRow_(t, id);
  t.rows.forEach(function (r, i) {
    if (i !== rowIdx && String(r[t.idx.Name]).toLowerCase() === name.toLowerCase()) {
      throw new ApiError('bad_request', 'An account with this name already exists.');
    }
  });

  var row = rowIdx < 0 ? blankRow_(t) : t.rows[rowIdx].slice();
  var oldName = rowIdx < 0 ? '' : String(row[t.idx.Name]);
  row[t.idx.ID]              = rowIdx < 0 ? newId_('A') : id;
  row[t.idx.Name]            = name;
  row[t.idx.Opening_Balance] = opening;
  row[t.idx.Icon]            = icon;
  row[t.idx.Note]            = safeText_(note);
  var target = rowIdx < 0 ? Math.max(t.sh.getLastRow(), 1) + 1 : rowIdx + 2;
  row[t.idx.Current_Balance] = balanceFormula_(t, target);   // keeps the sheet's own balance live
  t.sh.getRange(target, 1, 1, t.width).setValues([row]);

  if (oldName && oldName !== name) renameRefs_(['Account', 'To_Account'], oldName, name);
  return masters_();
}

function saveCategory_(body) {
  authenticate_(body);
  var t = table_(SHEET_CAT);
  var name = cleanName_(body.name);
  var type = String(body.type || '');
  if (CAT_TYPES.indexOf(type) < 0) throw new ApiError('bad_request', 'Type must be Income, Expense or Investment.');
  var budget = body.budget === '' || body.budget == null ? 0 : Number(body.budget);
  if (!isFinite(budget) || budget < 0 || budget > 1e10) throw new ApiError('bad_request', 'Invalid budget.');
  budget = Math.round(budget * 100) / 100;
  var icon = str_(body.icon, 8) || '🏷️';
  var note = strMulti_(body.note, 500);
  var id = str_(body.id, 40);

  var rowIdx = findRow_(t, id);
  t.rows.forEach(function (r, i) {
    if (i !== rowIdx && String(r[t.idx.Name]).toLowerCase() === name.toLowerCase() && String(r[t.idx.Type]) === type) {
      throw new ApiError('bad_request', 'A category with this name already exists in ' + type + '.');
    }
  });

  var row = rowIdx < 0 ? blankRow_(t) : t.rows[rowIdx].slice();
  var oldName = rowIdx < 0 ? '' : String(row[t.idx.Name]);
  if (rowIdx >= 0 && String(row[t.idx.Type]) !== type) {
    throw new ApiError('bad_request', 'Category type cannot be changed after creation.');
  }
  row[t.idx.ID]     = rowIdx < 0 ? newId_('C') : id;
  row[t.idx.Name]   = name;
  row[t.idx.Type]   = type;
  row[t.idx.Icon]   = icon;
  row[t.idx.Budget] = budget;
  row[t.idx.Note]   = safeText_(note);
  var target = rowIdx < 0 ? Math.max(t.sh.getLastRow(), 1) + 1 : rowIdx + 2;
  t.sh.getRange(target, 1, 1, t.width).setValues([row]);

  if (oldName && oldName !== name) renameRefs_(['Category'], oldName, name);
  return masters_();
}

// ------------------------------ DATA --------------------------------

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }

function sheet_(name) {
  var sh = ss_().getSheetByName(name);
  if (!sh) throw new ApiError('server_error', 'Tab "' + name + '" is missing. Run setupSheets.');
  return sh;
}

/** Reads a tab: {sh, idx (header→col), rows (2D), width}. Columns are found by NAME. */
function table_(name) {
  var sh = sheet_(name);
  var need = HEADERS[name];
  var width = Math.max(sh.getLastColumn(), need.length);
  var head = sh.getRange(1, 1, 1, width).getValues()[0].map(function (h) { return String(h).trim(); });
  var idx = {};
  head.forEach(function (h, i) { if (h) idx[h] = i; });
  need.forEach(function (h) {
    if (idx[h] === undefined) throw new ApiError('server_error', 'Column "' + h + '" missing in ' + name + '. Run setupSheets.');
  });
  var last = sh.getLastRow();
  var rows = last > 1 ? sh.getRange(2, 1, last - 1, width).getValues() : [];
  return { sh: sh, idx: idx, rows: rows, width: width };
}

function blankRow_(t) {
  var r = [];
  for (var i = 0; i < t.width; i++) r.push('');
  return r;
}

function findRow_(t, id) {
  if (!id) return -1;
  var found = -1;
  t.rows.forEach(function (r, i) { if (String(r[t.idx.ID]) === id) found = i; });
  if (found < 0) throw new ApiError('not_found', 'Record not found.');
  return found;
}

function readAccounts_() {
  var t = table_(SHEET_ACC), out = [];
  t.rows.forEach(function (r) {
    var name = String(r[t.idx.Name] || '').trim();
    if (!name) return;
    out.push({
      id: String(r[t.idx.ID] || ''), name: name,
      opening_balance: Number(r[t.idx.Opening_Balance]) || 0,
      icon: String(r[t.idx.Icon] || '') || '🏦',
      note: unsafeText_(String(r[t.idx.Note] || ''))
    });
  });
  return out;
}

function readCategories_() {
  var t = table_(SHEET_CAT), out = [];
  t.rows.forEach(function (r) {
    var name = String(r[t.idx.Name] || '').trim();
    var type = String(r[t.idx.Type] || '').trim();
    if (!name || CAT_TYPES.indexOf(type) < 0) return;
    out.push({
      id: String(r[t.idx.ID] || ''), name: name, type: type,
      icon: String(r[t.idx.Icon] || '') || '🏷️',
      budget: Number(r[t.idx.Budget]) || 0,
      note: unsafeText_(String(r[t.idx.Note] || ''))
    });
  });
  return out;
}

function readTxns_() {
  var t = table_(SHEET_TXN), out = [];
  t.rows.forEach(function (r, i) {
    var d = toDate_(r[t.idx.Time]);
    var type = String(r[t.idx.Type] || '').trim();
    if (!d || TYPES.indexOf(type) < 0) return;
    out.push({
      id: String(r[t.idx.ID] || ''),
      time: Utilities.formatDate(d, TIME_ZONE, TIME_FMT),
      type: type,
      amount: Number(r[t.idx.Amount]) || 0,
      category: String(r[t.idx.Category] || ''),
      account: String(r[t.idx.Account] || ''),
      to_account: String(r[t.idx.To_Account] || ''),
      note: unsafeText_(String(r[t.idx.Notes] || '')),
      _row: i + 2
    });
  });
  return out;
}

/** opening balance + income − expense − investment ± transfers. */
function accountsWithBalance_() {
  var accs = readAccounts_(), delta = {};
  function add(name, v) { if (name) delta[name] = (delta[name] || 0) + v; }
  readTxns_().forEach(function (x) {
    if (x.type === 'Income') add(x.account, x.amount);
    else if (x.type === 'Transfer') { add(x.account, -x.amount); add(x.to_account, x.amount); }
    else add(x.account, -x.amount);   // Expense, Investment
  });
  accs.forEach(function (a) {
    a.balance = Math.round((a.opening_balance + (delta[a.name] || 0)) * 100) / 100;
  });
  return accs;
}

function renameRefs_(cols, oldName, newName) {
  var t = table_(SHEET_TXN);
  if (!t.rows.length) return;
  cols.forEach(function (c) {
    var i = t.idx[c], changed = false;
    var vals = t.rows.map(function (r) {
      if (String(r[i]) === oldName) { changed = true; return [newName]; }
      return [r[i]];
    });
    if (changed) t.sh.getRange(2, i + 1, vals.length, 1).setValues(vals);
  });
}

// ------------------------ BALANCE FORMULAS --------------------------

function colLetter_(i) {
  var s = '';
  i = i + 1;
  while (i > 0) { var m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
  return s;
}

/** Column letters of the Transactions tab by header name: {Time:'B', Type:'C', Amount:'D', …} */
function txnCols_() {
  var sh = sheet_(SHEET_TXN);
  var head = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), HEADERS.Transactions.length)).getValues()[0];
  var out = {};
  head.forEach(function (h, i) { if (String(h).trim()) out[String(h).trim()] = colLetter_(i); });
  HEADERS.Transactions.forEach(function (h) {
    if (!out[h]) throw new ApiError('server_error', 'Column "' + h + '" missing in Transactions. Run setupSheets.');
  });
  return out;
}

/** The sheet's own live balance for account row r: opening + income − expense − investment − transfer-out + transfer-in. */
function balanceFormula_(at, r) {
  var c = txnCols_();
  function rng(n) { return 'Transactions!$' + c[n] + ':$' + c[n]; }
  var opening = colLetter_(at.idx.Opening_Balance) + r, name = colLetter_(at.idx.Name) + r;
  function s(type, col) { return 'SUMIFS(' + rng('Amount') + ',' + rng('Type') + ',"' + type + '",' + rng(col) + ',' + name + ')'; }
  return '=' + opening + '+' + s('Income', 'Account') + '-' + s('Expense', 'Account') + '-' + s('Investment', 'Account') +
         '-' + s('Transfer', 'Account') + '+' + s('Transfer', 'To_Account');
}

/** (Re)writes the Current_Balance formula on every account row. Run by setupSheets; safe to run any time. */
function refreshBalanceFormulas_() {
  var a = table_(SHEET_ACC);
  if (!a.rows.length) return;
  var f = a.rows.map(function (r, i) {
    return [String(r[a.idx.Name]).trim() ? balanceFormula_(a, i + 2) : ''];
  });
  a.sh.getRange(2, a.idx.Current_Balance + 1, f.length, 1).setFormulas(f).setNumberFormat('#,##0.00');
}
function refreshBalanceFormulas() { refreshBalanceFormulas_(); }

// ------------------------------ ANALYSIS ----------------------------

/**
 * Income / Expense / Investment totals for a date range (transfers are NOT counted),
 * a zero-filled time series (per day or per month) and category-wise totals.
 * body: from, to (YYYY-MM-DD), group = 'day' | 'month'
 */
function getAnalysis_(body) {
  authenticate_(body);
  var from = dateKey_(body.from), to = dateKey_(body.to);
  if (from > to) throw new ApiError('bad_request', 'Invalid date range.');
  var group = body.group === 'month' ? 'month' : 'day';
  var f = from.split('-').map(Number), t = to.split('-').map(Number);
  var start = Date.UTC(f[0], f[1] - 1, f[2]), end = Date.UTC(t[0], t[1] - 1, t[2]);
  if ((end - start) / 86400000 > 3660) throw new ApiError('bad_request', 'Range too long (max 10 years).');

  var keys = [], seen = {};
  for (var ms = start; ms <= end; ms += 86400000) {
    var k = new Date(ms).toISOString().slice(0, group === 'month' ? 7 : 10);
    if (!seen[k]) { seen[k] = true; keys.push(k); }
  }
  var series = {};
  keys.forEach(function (k) { series[k] = { key: k, income: 0, expense: 0, invest: 0 }; });

  var totals = { Income: 0, Expense: 0, Investment: 0 };
  var catMap = { Income: {}, Expense: {}, Investment: {} };
  readTxns_().forEach(function (x) {
    var d = x.time.slice(0, 10);
    if (x.type === 'Transfer' || d < from || d > to) return;
    totals[x.type] += x.amount;
    var s = series[group === 'month' ? d.slice(0, 7) : d];
    if (s) { if (x.type === 'Income') s.income += x.amount; else if (x.type === 'Expense') s.expense += x.amount; else s.invest += x.amount; }
    catMap[x.type][x.category] = (catMap[x.type][x.category] || 0) + x.amount;
  });

  function r2(n) { return Math.round(n * 100) / 100; }
  var meta = {};
  readCategories_().forEach(function (c) { meta[c.type + '|' + c.name] = c; });
  var categories = {};
  CAT_TYPES.forEach(function (type) {
    categories[type] = Object.keys(catMap[type]).map(function (name) {
      var m = meta[type + '|' + name];
      return { name: name, icon: m ? m.icon : '🏷️', budget: m ? m.budget : 0, total: r2(catMap[type][name]) };
    }).sort(function (a, b) { return b.total - a.total; });
  });

  return {
    from: from, to: to, group: group,
    totals: { income: r2(totals.Income), expense: r2(totals.Expense), invest: r2(totals.Investment) },
    series: keys.map(function (k) { var s = series[k]; return { key: k, income: r2(s.income), expense: r2(s.expense), invest: r2(s.invest) }; }),
    categories: categories
  };
}


// --------------------------- VALIDATION -----------------------------

function cleanTxn_(b, accs, cats) {
  var type = String(b.type || '');
  if (TYPES.indexOf(type) < 0) throw new ApiError('bad_request', 'Invalid type.');

  var amount = Number(b.amount);
  if (!isFinite(amount) || amount <= 0 || amount > 1e9) throw new ApiError('bad_request', 'Enter a valid amount.');
  amount = Math.round(amount * 100) / 100;

  var time = String(b.time || '');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(time)) throw new ApiError('bad_request', 'Invalid date/time.');
  var date = Utilities.parseDate(time, TIME_ZONE, TIME_FMT);

  var accNames = accs.map(function (a) { return a.name; });
  var account = str_(b.account, 60), toAcc = str_(b.to_account, 60), category = str_(b.category, 60);
  if (accNames.indexOf(account) < 0) throw new ApiError('bad_request', 'Choose a valid account.');

  if (type === 'Transfer') {
    if (accNames.indexOf(toAcc) < 0) throw new ApiError('bad_request', 'Choose a valid "To" account.');
    if (toAcc === account) throw new ApiError('bad_request', 'From and To accounts must be different.');
    category = '';
  } else {
    toAcc = '';
    var ok = cats.some(function (c) { return c.name === category && c.type === type; });
    if (!ok) throw new ApiError('bad_request', 'Choose a valid ' + type + ' category.');
  }
  return { type: type, amount: amount, date: date, account: account, to_account: toAcc,
           category: category, note: strMulti_(b.note, 300) };
}

function cleanName_(v) {
  var n = str_(v, 40);
  if (!n) throw new ApiError('bad_request', 'Name is required.');
  if (/^[=+\-@]/.test(n)) throw new ApiError('bad_request', 'Name cannot start with = + - @');
  return n;
}

function dateKey_(v) {
  var s = String(v == null ? '' : v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new ApiError('bad_request', 'Invalid date.');
  return s;
}

function toDate_(v) {
  if (v instanceof Date && !isNaN(v.getTime())) return v;
  var s = String(v == null ? '' : v).trim().replace(' ', 'T');
  var m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(s);
  if (!m) return null;
  try { return Utilities.parseDate(m[1] + 'T' + m[2], TIME_ZONE, TIME_FMT); } catch (e) { return null; }
}

function str_(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
}
function strMulti_(v, max) {
  return String(v == null ? '' : v).replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f]/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
}
/** setValues() evaluates strings starting with = + - @ → prefix an apostrophe; stripped on read. */
function safeText_(s) { return /^[=+\-@]/.test(s) ? "'" + s : s; }
function unsafeText_(s) { return /^'[=+\-@]/.test(s) ? s.slice(1) : s; }

function newId_(prefix) {
  return prefix + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
}

// ------------------------- USERS / TOKENS ---------------------------

function findUser_(username) {
  var t = table_(SHEET_USERS), want = String(username).toLowerCase();
  for (var i = 0; i < t.rows.length; i++) {
    var r = t.rows[i];
    if (String(r[t.idx.Username]).trim().toLowerCase() === want) {
      return {
        t: t, row: i + 2,
        username: String(r[t.idx.Username]).trim(),
        name: String(r[t.idx.Name] || r[t.idx.Username]).trim(),
        password: String(r[t.idx.Password] || ''),
        status: String(r[t.idx.Status] || '').trim()
      };
    }
  }
  return null;
}

function sha256Hex_(text) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ((b < 0 ? b + 256 : b)).toString(16).padStart(2, '0'); }).join('');
}
function hashPassword_(plain) {
  var salt = Utilities.getUuid().replace(/-/g, '');
  return 'sha256$' + salt + '$' + sha256Hex_(salt + plain);
}
function verifyPassword_(stored, plain) {
  stored = String(stored);
  if (stored.indexOf('sha256$') === 0) {
    var p = stored.split('$');
    return p.length === 3 && safeEqual_(sha256Hex_(p[1] + plain), p[2]);
  }
  return stored !== '' && safeEqual_(stored, plain);
}
function safeEqual_(a, b) {
  a = String(a); b = String(b);
  var diff = a.length ^ b.length, n = Math.max(a.length, b.length);
  for (var i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
function secret_() {
  var props = PropertiesService.getScriptProperties();
  var s = props.getProperty('TOKEN_SECRET');
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); props.setProperty('TOKEN_SECRET', s); }
  return s;
}
function sign_(m) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(m, secret_()));
}
function makeToken_(user) {
  var expires = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  return { token: expires + '.' + sign_(user.username + '.' + expires + '.' + user.password), expires: expires };
}
function authenticate_(body) {
  var expired = new ApiError('session_expired', 'Session expired. Please login again.');
  var username = str_(body.username, 60), token = String(body.token || ''), dot = token.indexOf('.');
  if (!username || dot < 1) throw expired;
  var expires = Number(token.slice(0, dot));
  if (!isFinite(expires) || expires < Date.now()) throw expired;
  var user = findUser_(username);
  if (!user || user.status !== 'Active') throw expired;
  if (!safeEqual_(sign_(user.username + '.' + expires + '.' + user.password), token.slice(dot + 1))) throw expired;
  return user;
}

function assertNotLocked_(u) {
  if (Number(CacheService.getScriptCache().get('fail_' + u.toLowerCase()) || 0) >= MAX_ATTEMPTS) {
    throw new ApiError('too_many_attempts', 'Too many wrong attempts. Try again after 15 minutes.');
  }
}
function recordFailure_(u) {
  var c = CacheService.getScriptCache(), k = 'fail_' + u.toLowerCase();
  c.put(k, String(Number(c.get(k) || 0) + 1), LOCKOUT_SECONDS);
}
function clearFailures_(u) { CacheService.getScriptCache().remove('fail_' + u.toLowerCase()); }

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try { return fn(); } finally { lock.releaseLock(); }
}

class ApiError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function ok_(d) { d = d || {}; d.success = true; return json_(d); }
function fail_(code, message) { return json_({ success: false, error: code, message: message }); }

// ------------------------- ADMIN (run from editor) -------------------

/** Creates / completes all tabs, formats, defaults and the Analysis sheet. Safe to re-run. */
function setupSheets() {
  var ss = ss_();
  ss.setSpreadsheetTimeZone(TIME_ZONE);
  if (ss.getName().indexOf('Untitled') === 0 || ss.getName() === 'Paisa - Money Manager') ss.rename('Finance');

  Object.keys(HEADERS).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    var need = HEADERS[name];
    var have = sh.getLastColumn() ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String) : [];
    need.forEach(function (h) { if (have.indexOf(h) < 0) { sh.getRange(1, have.length + 1).setValue(h); have.push(h); } });
    sh.getRange(1, 1, 1, have.length).setFontWeight('bold').setBackground('#E8EAF6');
    sh.setFrozenRows(1);
  });
  var first = ss.getSheetByName('Sheet1');
  if (first && first.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(first);

  var tx = table_(SHEET_TXN), n = 5000;
  tx.sh.getRange(2, tx.idx.Time + 1, n, 1).setNumberFormat('yyyy-mm-dd hh:mm');
  tx.sh.getRange(2, tx.idx.Notes + 1, n, 1).setNumberFormat('@');
  tx.sh.getRange(2, tx.idx.Amount + 1, n, 1).setNumberFormat('#,##0.00');
  tx.sh.getRange(2, tx.idx.Type + 1, n, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(TYPES, true).setAllowInvalid(false).build());

  var ct = table_(SHEET_CAT);
  ct.sh.getRange(2, ct.idx.Type + 1, 500, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(CAT_TYPES, true).setAllowInvalid(false).build());
  ct.sh.getRange(2, ct.idx.Note + 1, 500, 1).setNumberFormat('@');
  var ac = table_(SHEET_ACC);
  ac.sh.getRange(2, ac.idx.Note + 1, 500, 1).setNumberFormat('@');
  var us = table_(SHEET_USERS);
  us.sh.getRange(2, us.idx.Password + 1, 50, 1).setNumberFormat('@');
  us.sh.getRange(2, us.idx.Status + 1, 50, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['Active', 'Inactive'], true).build());

  seedDefaults_();
  fillMissingIds_();
  refreshBalanceFormulas_();
  setupAnalysis();
  SpreadsheetApp.flush();
}

function seedDefaults_() {
  var a = table_(SHEET_ACC);
  if (!a.rows.length) {
    a.sh.getRange(2, 1, 2, a.width).setValues([['Cash', '💵', 'A'], ['Bank', '🏦', 'Ab']].map(function (d) {
      var r = blankRow_(a);
      r[a.idx.ID] = newId_('A') + d[2]; r[a.idx.Name] = d[0]; r[a.idx.Opening_Balance] = 0; r[a.idx.Icon] = d[1];
      return r;
    }));
  }
  var c = table_(SHEET_CAT);
  if (!c.rows.length) {
    var defs = [['Salary', 'Income', '💼', 0], ['Food', 'Expense', '🍔', 5000], ['Travel', 'Expense', '🚗', 2000], ['SIP', 'Investment', '📈', 2500]];
    c.sh.getRange(2, 1, defs.length, c.width).setValues(defs.map(function (d, i) {
      var r = blankRow_(c);
      r[c.idx.ID] = newId_('C') + i; r[c.idx.Name] = d[0]; r[c.idx.Type] = d[1]; r[c.idx.Icon] = d[2]; r[c.idx.Budget] = d[3];
      return r;
    }));
  }
}

/** Gives an ID to rows pasted without one (needed for edit / delete in the app). */
function fillMissingIds() { fillMissingIds_(); }
function fillMissingIds_() {
  [[SHEET_TXN, 'T'], [SHEET_ACC, 'A'], [SHEET_CAT, 'C']].forEach(function (p) {
    var t = table_(p[0]);
    if (!t.rows.length) return;
    var changed = false, k = 0;
    var vals = t.rows.map(function (r) {
      var hasData = r.some(function (x, i) { return i !== t.idx.ID && String(x) !== ''; });
      if (hasData && !String(r[t.idx.ID])) { changed = true; return [newId_(p[1]) + (k++).toString(36)]; }
      return [r[t.idx.ID]];
    });
    if (changed) t.sh.getRange(2, t.idx.ID + 1, vals.length, 1).setValues(vals);
  });
}

/**
 * Builds the Analysis tab. Change FROM / TO (B1 / B2) → everything recalculates. Default = current month.
 *   A:B  Income overview   (total + category-wise)
 *   D:E  Expense overview
 *   G:H  Investment overview
 *   J:M  Date-wise table: for every date in the range → Income | Expense | Invest
 */
function setupAnalysis() {
  var ss = ss_();
  var sh = ss.getSheetByName(SHEET_ANA) || ss.insertSheet(SHEET_ANA);
  sh.clear();
  var c = txnCols_();   // column letters of Transactions (Time, Type, Amount …)
  function rng(n) { return 'Transactions!$' + c[n] + ':$' + c[n]; }

  sh.getRange('A1').setValue('FROM'); sh.getRange('B1').setFormula('=DATE(YEAR(TODAY()),MONTH(TODAY()),1)');
  sh.getRange('A2').setValue('TO');   sh.getRange('B2').setFormula('=EOMONTH(TODAY(),0)');
  sh.getRange('A1:A2').setFontWeight('bold');
  sh.getRange('B1:B2').setNumberFormat('yyyy-mm-dd').setBackground('#FFF8E1').setFontWeight('bold');
  sh.getRange('C1').setValue('← change these two dates to analyse any range (date-wise table shows up to 366 days)');

  var blocks = [['Income', 'A', 'B', '#2E7D32'], ['Expense', 'D', 'E', '#C62828'], ['Investment', 'G', 'H', '#1565C0']];
  blocks.forEach(function (b) {
    var type = b[0], c1 = b[1], c2 = b[2];
    sh.getRange(c1 + '4').setValue(type.toUpperCase() + ' OVERVIEW').setFontWeight('bold').setFontColor('#FFFFFF');
    sh.getRange(c1 + '4:' + c2 + '4').setBackground(b[3]);
    sh.getRange(c1 + '5').setValue('Total').setFontWeight('bold');
    sh.getRange(c2 + '5').setFormula(
      '=SUMIFS(' + rng('Amount') + ',' + rng('Type') + ',"' + type + '",' + rng('Time') + ',">="&$B$1,' + rng('Time') + ',"<"&($B$2+1))')
      .setNumberFormat('#,##0.00').setFontWeight('bold');
    // category-wise (Transactions B:E = Time, Type, Amount, Category — default column order)
    sh.getRange(c1 + '7').setFormula(
      '=IF($' + c2 + '$5=0,"No data",QUERY(Transactions!$B$2:$E,"select D, sum(C) where B=\'' + type + '\' and A >= datetime \'"&TEXT($B$1,"yyyy-MM-dd")&" 00:00:00\' and A <= datetime \'"&TEXT($B$2,"yyyy-MM-dd")&" 23:59:59\' group by D order by sum(C) desc label D \'Category\', sum(C) \'Amount\'",0))');
    sh.getRange(c2 + '7:' + c2 + '500').setNumberFormat('#,##0.00');
  });

  // date-wise table
  sh.getRange('J4').setValue('DATE-WISE').setFontWeight('bold').setFontColor('#FFFFFF');
  sh.getRange('J4:M4').setBackground('#3F51B5');
  sh.getRange('J5:M5').setValues([['Date', 'Income', 'Expense', 'Invest']]).setFontWeight('bold').setBackground('#E8EAF6');
  var rows = [];
  for (var r = 6; r <= 371; r++) {
    var row = ['=IF($B$1+' + (r - 6) + '<=$B$2,$B$1+' + (r - 6) + ',"")'];
    ['Income', 'Expense', 'Investment'].forEach(function (type) {
      row.push('=IF($J' + r + '="","",SUMIFS(' + rng('Amount') + ',' + rng('Type') + ',"' + type + '",' + rng('Time') + ',">="&$J' + r + ',' + rng('Time') + ',"<"&($J' + r + '+1)))');
    });
    rows.push(row);
  }
  sh.getRange(6, 10, rows.length, 4).setFormulas(rows);
  sh.getRange('J6:J371').setNumberFormat('yyyy-mm-dd ddd');
  sh.getRange('K6:M371').setNumberFormat('#,##0.00;-#,##0.00;"-"');

  sh.setColumnWidth(1, 160); sh.setColumnWidth(4, 160); sh.setColumnWidth(7, 160); sh.setColumnWidth(10, 130);
  sh.setColumnWidth(3, 30);  sh.setColumnWidth(6, 30);  sh.setColumnWidth(9, 30);
}

/** Edit the three constants, then run once to add a login (or reset that user's password). */
function createUser() {
  var ADMIN_USERNAME = 'bhavesh';
  var ADMIN_NAME     = 'Bhavesh';
  var ADMIN_PASSWORD = 'ChangeMe123';

  if (ADMIN_PASSWORD.length < 6) throw new Error('Password must be at least 6 characters.');
  var existing = findUser_(ADMIN_USERNAME);
  var hash = hashPassword_(ADMIN_PASSWORD);
  if (existing) {
    var t = existing.t;
    t.sh.getRange(existing.row, t.idx.Password + 1).setNumberFormat('@').setValue(hash);
    t.sh.getRange(existing.row, t.idx.Status + 1).setValue('Active');
    Logger.log('Password reset for ' + ADMIN_USERNAME);
  } else {
    var u = table_(SHEET_USERS), row = blankRow_(u);
    row[u.idx.Username] = ADMIN_USERNAME; row[u.idx.Name] = ADMIN_NAME; row[u.idx.Password] = hash; row[u.idx.Status] = 'Active';
    u.sh.getRange(Math.max(u.sh.getLastRow(), 1) + 1, 1, 1, u.width).setNumberFormat('@').setValues([row]);
    Logger.log('User created: ' + ADMIN_USERNAME);
  }
}
