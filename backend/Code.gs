/**
 * Cash Payment Vouchers — API (Google Apps Script, bound to a Google Sheet).
 * Deploy: Deploy > New deployment > Web app > Execute as: Me, Who has access: Anyone.
 * No secrets live in this file. Owner login is created by setup() from Script Properties.
 */
const CFG = {
  TZ: 'Asia/Kolkata',
  SESSION_TTL: 21600, // 6 h
  MAX_FAILS: 5,
  LOCK_SECONDS: 900, // 15 min
  MAX_BULK: 500,
  MAX_NORMAL: 25,
  MAX_RECEIPTS: 3,
  MAX_B64: 2200000, // ~1.6 MB image
  MAX_AMOUNT: 10000000,
  DEFAULT_CATEGORIES: ['Housekeeping', 'Maintenance', 'Electrical', 'Plumbing', 'Kitchen', 'Food & Beverage', 'Laundry', 'Guest Supplies', 'Transport', 'Fuel', 'Staff Welfare', 'Staff Advance', 'Petty Cash', 'Local Purchase', 'Vendor Payment', 'Repairs', 'Gardening', 'Security', 'Office Expense', 'Stationery', 'Internet / Telecom', 'Licenses', 'Bank Charges', 'Guest Refund', 'Other'],
  H: {
    Users: ['UserID', 'Name', 'Email', 'Role', 'Active', 'Salt', 'PinHash', 'MustChangePin', 'CreatedAt', 'LastLogin'],
    Vouchers: ['VoucherID', 'VoucherNo', 'Date', 'Vendor', 'Amount', 'Category', 'Notes', 'Status', 'CreatedBy', 'CreatedAt', 'UpdatedBy', 'UpdatedAt', 'Receipts', 'CancelReason', 'ClientID'],
    Vendors: ['VendorID', 'Name', 'Company', 'Mobile', 'Active', 'CreatedBy', 'CreatedAt'],
    Settings: ['Key', 'Value'],
    AuditLog: ['Time', 'User', 'Action', 'Target', 'Details']
  }
};
const PERMS = {
  staff: {create: 1, viewOwn: 1},
  manager: {create: 1, viewAll: 1, edit: 1, cancel: 1, bulk: 1, vendors: 1, receiptAny: 1},
  owner: {create: 1, viewAll: 1, edit: 1, cancel: 1, bulk: 1, vendors: 1, receiptAny: 1, users: 1, settings: 1, audit: 1}
};

/* ============ one-time setup (run from the editor) ============ */
/** Script Properties needed once: OWNER_EMAIL, OWNER_PIN (6 digits), optional OWNER_NAME. */
function setup() {
  const p = PropertiesService.getScriptProperties();
  if (!p.getProperty('SS_ID')) p.setProperty('SS_ID', SpreadsheetApp.getActiveSpreadsheet().getId());
  if (!p.getProperty('PEPPER')) p.setProperty('PEPPER', Utilities.getUuid() + Utilities.getUuid());
  Object.keys(CFG.H).forEach(ensureSheet_);
  if (!p.getProperty('RECEIPT_FOLDER_ID')) p.setProperty('RECEIPT_FOLDER_ID', DriveApp.createFolder('Cash Voucher Receipts').getId());
  const set = settings_();
  if (set.propertyName === undefined) setSetting_('propertyName', 'My Property');
  if (set.propertyAddress === undefined) setSetting_('propertyAddress', '');
  if (set.categories === undefined) setSetting_('categories', JSON.stringify(CFG.DEFAULT_CATEGORIES));
  if (set.nextVoucherNo === undefined) setSetting_('nextVoucherNo', '201');
  if (!readAll_('Users').length) {
    const email = String(p.getProperty('OWNER_EMAIL') || '').trim().toLowerCase();
    const pin = String(p.getProperty('OWNER_PIN') || '').trim();
    if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('Set Script Property OWNER_EMAIL first.');
    if (!pinOk_(pin)) throw new Error('Set Script Property OWNER_PIN to a 6-digit PIN (not 123456 / 111111 etc.).');
    addUser_(p.getProperty('OWNER_NAME') || 'Owner', email, 'owner', pin, true);
    p.deleteProperty('OWNER_PIN');
    audit_({email: 'system'}, 'SETUP', '', 'Owner created: ' + email);
  }
  Logger.log('Setup complete. Now deploy as a Web app.');
}

/* ============ web app entry ============ */
function doGet() { return ContentService.createTextOutput('Cash Vouchers API is running.'); }
function doPost(e) {
  let out;
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    out = {ok: true, data: route_(req)};
  } catch (err) {
    out = {ok: false, error: err.userMessage || 'Something went wrong. Please try again.', code: err.code || ''};
    if (!err.userMessage) console.error(err && err.stack || err);
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

const ACTIONS = {
  bootstrap: bootstrap_, createVouchers: createVouchers_, updateVoucher: updateVoucher_, cancelVoucher: cancelVoucher_,
  addReceipt: addReceipt_, getReceipt: getReceipt_, saveVendor: saveVendor_, toggleVendor: toggleVendor_,
  listUsers: listUsers_, saveUser: saveUser_, resetPin: resetPin_, changePin: changePin_,
  saveSettings: saveSettings_, auditLog: auditLog_, logout: logout_
};
const WRITES = {createVouchers: 1, updateVoucher: 1, cancelVoucher: 1, addReceipt: 1, saveVendor: 1, toggleVendor: 1, saveUser: 1, resetPin: 1, changePin: 1, saveSettings: 1};

function route_(req) {
  if (req.action === 'login') return login_(req);
  const fn = ACTIONS[req.action];
  if (!fn) throw err_('Unknown action.');
  const user = auth_(req.token);
  if (user.mustChange && req.action !== 'changePin' && req.action !== 'logout') throw err_('Please change your PIN first.', 'PIN_CHANGE');
  if (!WRITES[req.action]) return fn(user, req);
  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try { return fn(user, req); } finally { lock.releaseLock(); }
}

/* ============ helpers ============ */
function err_(msg, code) { const e = new Error(msg); e.userMessage = msg; e.code = code || ''; return e; }
function props_() { return PropertiesService.getScriptProperties(); }
function sheet_(n) {
  const id = props_().getProperty('SS_ID');
  if (!id) throw err_('Server is not set up yet. Run setup() in the script editor.');
  const s = SpreadsheetApp.openById(id).getSheetByName(n);
  if (!s) throw err_('Sheet "' + n + '" is missing. Run setup() again.');
  return s;
}
function ensureSheet_(name) {
  const ss = SpreadsheetApp.openById(props_().getProperty('SS_ID'));
  let s = ss.getSheetByName(name) || ss.insertSheet(name);
  const h = CFG.H[name];
  if (s.getLastRow() === 0) s.getRange(1, 1, 1, h.length).setValues([h]);
  if (name === 'Vouchers') s.getRange('C:C').setNumberFormat('@');
  if (name === 'AuditLog' || name === 'Users') s.getRange('A:A').setNumberFormat('@');
  return s;
}
function readAll_(name) {
  const v = sheet_(name).getDataRange().getValues(), h = v[0] || [];
  const out = [];
  for (let i = 1; i < v.length; i++) {
    if (v[i][0] === '' || v[i][0] === null) continue;
    const o = {_row: i + 1};
    h.forEach(function (k, j) { o[k] = v[i][j]; });
    out.push(o);
  }
  return out;
}
function toRow_(name, o) { return CFG.H[name].map(function (k) { return o[k] === undefined ? '' : o[k]; }); }
function appendRows_(name, objs) {
  if (!objs.length) return;
  const s = sheet_(name), rows = objs.map(function (o) { return toRow_(name, o); });
  s.getRange(s.getLastRow() + 1, 1, rows.length, CFG.H[name].length).setValues(rows);
}
function updateRow_(name, row, patch) {
  const s = sheet_(name), h = CFG.H[name], r = s.getRange(row, 1, 1, h.length), cur = r.getValues()[0];
  h.forEach(function (k, j) { if (patch[k] !== undefined) cur[j] = patch[k]; });
  r.setValues([cur]);
}
function settings_() {
  const o = {}; readAll_('Settings').forEach(function (r) { o[r.Key] = r.Value; }); return o;
}
function setSetting_(k, v) {
  const row = readAll_('Settings').filter(function (r) { return r.Key === k; })[0];
  if (row) updateRow_('Settings', row._row, {Value: v}); else appendRows_('Settings', [{Key: k, Value: v}]);
}
function categories_() { try { return JSON.parse(settings_().categories) || CFG.DEFAULT_CATEGORIES; } catch (e) { return CFG.DEFAULT_CATEGORIES; } }
function nowIso_() { return Utilities.formatDate(new Date(), CFG.TZ, "yyyy-MM-dd'T'HH:mm:ss"); }
function todayIso_(plusDays) { return Utilities.formatDate(new Date(Date.now() + (plusDays || 0) * 86400000), CFG.TZ, 'yyyy-MM-dd'); }
function isoDate_(v) { return v instanceof Date ? Utilities.formatDate(v, CFG.TZ, 'yyyy-MM-dd') : String(v || ''); }
function clean_(v, max) {
  let s = String(v === undefined || v === null ? '' : v).replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, max || 200);
  if (/^[=+\-@]/.test(s)) s = "'" + s; // block spreadsheet formula injection
  return s;
}
function pinOk_(p) { return /^\d{6}$/.test(p) && !/^(\d)\1{5}$/.test(p) && p !== '123456' && p !== '654321'; }
function hashPin_(salt, pin) {
  const sig = Utilities.computeHmacSha256Signature(salt + ':' + pin, props_().getProperty('PEPPER'));
  return sig.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}
function same_(a, b) { a = String(a); b = String(b); if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }
function addUser_(name, email, role, pin, must) {
  const salt = Utilities.getUuid();
  const u = {UserID: Utilities.getUuid(), Name: clean_(name, 80), Email: email, Role: role, Active: true, Salt: salt, PinHash: hashPin_(salt, pin), MustChangePin: !!must, CreatedAt: nowIso_(), LastLogin: ''};
  appendRows_('Users', [u]); return u;
}
function pubUser_(u) { return {id: u.UserID, name: u.Name, email: u.Email, role: u.Role, active: u.Active === true || u.Active === 'TRUE', mustChangePin: u.MustChangePin === true || u.MustChangePin === 'TRUE'}; }
function audit_(user, action, target, details) {
  try { appendRows_('AuditLog', [{Time: nowIso_(), User: user.email, Action: action, Target: target || '', Details: clean_(details, 300)}]); } catch (e) { console.error(e); }
}
function can_(user, perm) { return !!(PERMS[user.role] && PERMS[user.role][perm]); }
function need_(user, perm) { if (!can_(user, perm)) { audit_(user, 'DENIED', perm, ''); throw err_('You do not have permission to do that.', 'FORBIDDEN'); } }

/* ============ auth ============ */
function findUserByEmail_(email) { return readAll_('Users').filter(function (u) { return String(u.Email).toLowerCase() === email; })[0]; }
function login_(req) {
  const email = String(req.email || '').trim().toLowerCase(), pin = String(req.pin || '').trim();
  const cache = CacheService.getScriptCache(), fk = 'f:' + email;
  const fails = Number(cache.get(fk) || 0);
  if (fails >= CFG.MAX_FAILS) throw err_('Too many attempts. Try again in 15 minutes.', 'LOCKED');
  const u = findUserByEmail_(email);
  const active = u && (u.Active === true || u.Active === 'TRUE');
  if (!u || !active || !same_(hashPin_(u.Salt, pin), u.PinHash)) {
    cache.put(fk, String(fails + 1), CFG.LOCK_SECONDS);
    if (u) audit_({email: email}, 'LOGIN_FAILED', '', '');
    throw err_('Invalid email or PIN.');
  }
  cache.remove(fk);
  const token = Utilities.getUuid() + Utilities.getUuid();
  cache.put('s:' + token, JSON.stringify({email: email, salt: u.Salt}), CFG.SESSION_TTL);
  updateRow_('Users', u._row, {LastLogin: nowIso_()});
  audit_({email: email}, 'LOGIN', '', '');
  return {token: token, user: pubUser_(u)};
}
function auth_(token) {
  const raw = token && CacheService.getScriptCache().get('s:' + token);
  if (!raw) throw err_('Session expired. Please sign in again.', 'SESSION');
  const s = JSON.parse(raw), u = findUserByEmail_(s.email);
  if (!u || !(u.Active === true || u.Active === 'TRUE') || u.Salt !== s.salt) throw err_('Session expired. Please sign in again.', 'SESSION');
  const p = pubUser_(u);
  return {id: p.id, name: p.name, email: p.email, role: p.role, mustChange: p.mustChangePin, _row: u._row, _u: u};
}
function logout_(user, req) { CacheService.getScriptCache().remove('s:' + req.token); return {ok: true}; }

/* ============ bootstrap ============ */
function vOut_(o) {
  return {id: o.VoucherID, no: Number(o.VoucherNo), date: isoDate_(o.Date), vendor: String(o.Vendor), amount: Number(o.Amount), category: String(o.Category || ''),
    notes: String(o.Notes || ''), status: String(o.Status || 'ACTIVE'), createdBy: String(o.CreatedBy || ''), createdAt: String(o.CreatedAt || ''),
    updatedBy: String(o.UpdatedBy || ''), updatedAt: String(o.UpdatedAt || ''), receipts: o.Receipts ? String(o.Receipts).split(',').filter(Boolean) : [], cancelReason: String(o.CancelReason || '')};
}
function bootstrap_(user) {
  const all = can_(user, 'viewAll');
  const vouchers = readAll_('Vouchers').filter(function (o) { return all || String(o.CreatedBy).toLowerCase() === user.email; }).map(vOut_);
  const st = settings_();
  const vendors = readAll_('Vendors').map(function (v) { return {id: v.VendorID, name: String(v.Name), company: String(v.Company || ''), mobile: String(v.Mobile || ''), active: v.Active === true || v.Active === 'TRUE'}; });
  const names = {};
  if (all) readAll_('Users').forEach(function (u) { names[String(u.Email).toLowerCase()] = u.Name; }); else names[user.email] = user.name;
  return {user: {id: user.id, name: user.name, email: user.email, role: user.role, perms: PERMS[user.role]},
    settings: {propertyName: st.propertyName || '', propertyAddress: st.propertyAddress || '', categories: categories_(), nextVoucherNo: Number(st.nextVoucherNo || 201)},
    vouchers: vouchers, vendors: vendors, names: names};
}

/* ============ vouchers ============ */
function validDate_(d) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const t = new Date(d + 'T00:00:00Z');
  return !isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d && d <= todayIso_(1) && d >= '2000-01-01';
}
function saveReceipt_(r, no, i) {
  if (!r || !/^image\/(jpeg|png|webp)$/.test(r.mime)) throw err_('Receipt must be a JPG, PNG or WebP image.');
  if (!r.data || r.data.length > CFG.MAX_B64) throw err_('Receipt image is too large.');
  const ext = r.mime.split('/')[1].replace('jpeg', 'jpg');
  const blob = Utilities.newBlob(Utilities.base64Decode(r.data), r.mime, 'V' + no + '-' + (Date.now() % 100000) + '-' + i + '.' + ext);
  return DriveApp.getFolderById(props_().getProperty('RECEIPT_FOLDER_ID')).createFile(blob).getId();
}
function createVouchers_(user, req) {
  need_(user, 'create');
  const entries = req.entries;
  if (!Array.isArray(entries) || !entries.length) throw err_('Add at least one payment.');
  if (req.bulk) { need_(user, 'bulk'); if (entries.length > CFG.MAX_BULK) throw err_('Maximum ' + CFG.MAX_BULK + ' rows per import.'); }
  else if (entries.length > CFG.MAX_NORMAL) throw err_('Maximum ' + CFG.MAX_NORMAL + ' payments at once. Use Bulk Upload.');
  const cats = categories_(), existing = readAll_('Vouchers'), byClient = {};
  existing.forEach(function (o) { if (o.ClientID) byClient[o.ClientID] = o; });
  const clean = [];
  entries.forEach(function (en, i) {
    const row = 'Row ' + (i + 1) + ': ';
    const date = String(en.date || '');
    if (!validDate_(date)) throw err_(row + 'invalid date.');
    const vendor = clean_(en.vendor, 200); if (!vendor) throw err_(row + 'vendor is required.');
    const amount = Math.round(Number(en.amount) * 100) / 100;
    if (!isFinite(amount) || amount <= 0 || amount > CFG.MAX_AMOUNT) throw err_(row + 'invalid amount.');
    const rec = Array.isArray(en.receipts) ? en.receipts : [];
    if (rec.length > CFG.MAX_RECEIPTS) throw err_(row + 'too many receipts.');
    clean.push({date: date, vendor: vendor, amount: amount, category: cats.indexOf(en.category) >= 0 ? en.category : 'Other', notes: clean_(en.notes, 500), clientId: clean_(en.clientId, 60), receipts: rec});
  });
  let next = Number(settings_().nextVoucherNo || 201), created = [], skipped = 0, newObjs = [];
  clean.forEach(function (c) {
    if (c.clientId && byClient[c.clientId]) { skipped++; created.push(vOut_(byClient[c.clientId])); return; }
    const no = next++, ids = [];
    c.receipts.forEach(function (r, i) { ids.push(saveReceipt_(r, no, i)); });
    const o = {VoucherID: Utilities.getUuid(), VoucherNo: no, Date: c.date, Vendor: c.vendor, Amount: c.amount, Category: c.category, Notes: c.notes, Status: 'ACTIVE',
      CreatedBy: user.email, CreatedAt: nowIso_(), UpdatedBy: '', UpdatedAt: '', Receipts: ids.join(','), CancelReason: '', ClientID: c.clientId};
    if (c.clientId) byClient[c.clientId] = o;
    newObjs.push(o); created.push(vOut_(o));
  });
  appendRows_('Vouchers', newObjs);
  setSetting_('nextVoucherNo', String(next));
  audit_(user, req.bulk ? 'BULK_CREATE' : 'CREATE', newObjs.length ? '#' + newObjs[0].VoucherNo : '', newObjs.length + ' voucher(s)' + (skipped ? ', ' + skipped + ' duplicate skipped' : ''));
  return {created: created, skipped: skipped};
}
function findVoucher_(id) {
  const o = readAll_('Vouchers').filter(function (v) { return v.VoucherID === id; })[0];
  if (!o) throw err_('Voucher not found.');
  return o;
}
function updateVoucher_(user, req) {
  need_(user, 'edit');
  const o = findVoucher_(req.id); if (o.Status !== 'ACTIVE') throw err_('Cancelled vouchers cannot be edited.');
  const f = req.fields || {}, patch = {};
  if (f.date !== undefined) { if (!validDate_(String(f.date))) throw err_('Invalid date.'); patch.Date = String(f.date); }
  if (f.vendor !== undefined) { const v = clean_(f.vendor, 200); if (!v) throw err_('Vendor is required.'); patch.Vendor = v; }
  if (f.amount !== undefined) { const a = Math.round(Number(f.amount) * 100) / 100; if (!isFinite(a) || a <= 0 || a > CFG.MAX_AMOUNT) throw err_('Invalid amount.'); patch.Amount = a; }
  if (f.category !== undefined) patch.Category = categories_().indexOf(f.category) >= 0 ? f.category : 'Other';
  if (f.notes !== undefined) patch.Notes = clean_(f.notes, 500);
  patch.UpdatedBy = user.email; patch.UpdatedAt = nowIso_();
  updateRow_('Vouchers', o._row, patch);
  audit_(user, 'UPDATE', '#' + o.VoucherNo, Object.keys(patch).join(','));
  return vOut_(Object.assign({}, o, patch));
}
function cancelVoucher_(user, req) {
  need_(user, 'cancel');
  const o = findVoucher_(req.id), reason = clean_(req.reason, 200);
  if (o.Status !== 'ACTIVE') throw err_('Already cancelled.');
  if (reason.length < 3) throw err_('Please give a reason for cancelling.');
  const patch = {Status: 'CANCELLED', CancelReason: reason, UpdatedBy: user.email, UpdatedAt: nowIso_()};
  updateRow_('Vouchers', o._row, patch);
  audit_(user, 'CANCEL', '#' + o.VoucherNo, reason);
  return vOut_(Object.assign({}, o, patch));
}
function canSee_(user, o) { return can_(user, 'viewAll') || String(o.CreatedBy).toLowerCase() === user.email; }
function addReceipt_(user, req) {
  const o = findVoucher_(req.id);
  if (!(can_(user, 'receiptAny') || (can_(user, 'viewOwn') && String(o.CreatedBy).toLowerCase() === user.email))) need_(user, 'receiptAny');
  if (o.Status !== 'ACTIVE') throw err_('Cannot add receipts to a cancelled voucher.');
  const have = o.Receipts ? String(o.Receipts).split(',').filter(Boolean) : [];
  if (have.length >= CFG.MAX_RECEIPTS) throw err_('Maximum ' + CFG.MAX_RECEIPTS + ' receipts per voucher.');
  have.push(saveReceipt_(req.receipt, o.VoucherNo, have.length));
  updateRow_('Vouchers', o._row, {Receipts: have.join(','), UpdatedBy: user.email, UpdatedAt: nowIso_()});
  audit_(user, 'RECEIPT_ADD', '#' + o.VoucherNo, '');
  return vOut_(Object.assign({}, o, {Receipts: have.join(',')}));
}
function getReceipt_(user, req) {
  const o = findVoucher_(req.id);
  if (!canSee_(user, o)) need_(user, 'viewAll');
  const ids = String(o.Receipts || '').split(',');
  if (ids.indexOf(req.fileId) < 0) throw err_('Receipt not found.');
  const blob = DriveApp.getFileById(req.fileId).getBlob();
  return {dataUrl: 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes())};
}

/* ============ vendors ============ */
function saveVendor_(user, req) {
  need_(user, 'vendors');
  const name = clean_(req.name, 120), company = clean_(req.company, 120), mobile = clean_(req.mobile, 15);
  if (!name) throw err_('Vendor name is required.');
  if (mobile && !/^[0-9+\-\s]{7,15}$/.test(mobile)) throw err_('Enter a valid mobile number.');
  const list = readAll_('Vendors'), dup = list.filter(function (v) { return String(v.Name).toLowerCase() === name.toLowerCase() && v.VendorID !== req.id; })[0];
  if (dup) throw err_('This vendor already exists.');
  if (req.id) {
    const v = list.filter(function (x) { return x.VendorID === req.id; })[0]; if (!v) throw err_('Vendor not found.');
    updateRow_('Vendors', v._row, {Name: name, Company: company, Mobile: mobile});
  } else appendRows_('Vendors', [{VendorID: Utilities.getUuid(), Name: name, Company: company, Mobile: mobile, Active: true, CreatedBy: user.email, CreatedAt: nowIso_()}]);
  audit_(user, req.id ? 'VENDOR_UPDATE' : 'VENDOR_CREATE', '', name);
  return {ok: true};
}
function toggleVendor_(user, req) {
  need_(user, 'vendors');
  const v = readAll_('Vendors').filter(function (x) { return x.VendorID === req.id; })[0]; if (!v) throw err_('Vendor not found.');
  const now = !(v.Active === true || v.Active === 'TRUE');
  updateRow_('Vendors', v._row, {Active: now}); audit_(user, now ? 'VENDOR_ON' : 'VENDOR_OFF', '', v.Name);
  return {ok: true};
}

/* ============ users (owner) ============ */
function listUsers_(user) { need_(user, 'users'); return readAll_('Users').map(pubUser_); }
function activeOwners_() { return readAll_('Users').filter(function (u) { return u.Role === 'owner' && (u.Active === true || u.Active === 'TRUE'); }); }
function saveUser_(user, req) {
  need_(user, 'users');
  const name = clean_(req.name, 80), email = String(req.email || '').trim().toLowerCase(), role = req.role;
  if (!name) throw err_('Name is required.');
  if (!/^\S+@\S+\.\S+$/.test(email)) throw err_('Enter a valid email.');
  if (!PERMS[role]) throw err_('Invalid role.');
  const all = readAll_('Users'), dup = all.filter(function (u) { return String(u.Email).toLowerCase() === email && u.UserID !== req.id; })[0];
  if (dup) throw err_('That email is already a user.');
  if (!req.id) {
    if (!pinOk_(String(req.pin || ''))) throw err_('Temporary PIN must be 6 digits and not too simple.');
    addUser_(name, email, role, String(req.pin), true); audit_(user, 'USER_CREATE', email, role);
    return {ok: true};
  }
  const t = all.filter(function (u) { return u.UserID === req.id; })[0]; if (!t) throw err_('User not found.');
  const active = req.active === undefined ? (t.Active === true || t.Active === 'TRUE') : !!req.active;
  const owners = activeOwners_();
  if (t.Role === 'owner' && (role !== 'owner' || !active) && owners.length <= 1) throw err_('There must be at least one active owner.');
  updateRow_('Users', t._row, {Name: name, Email: email, Role: role, Active: active});
  audit_(user, 'USER_UPDATE', email, role + (active ? '' : ' (disabled)'));
  return {ok: true};
}
function resetPin_(user, req) {
  need_(user, 'users');
  const t = readAll_('Users').filter(function (u) { return u.UserID === req.id; })[0]; if (!t) throw err_('User not found.');
  if (!pinOk_(String(req.pin || ''))) throw err_('Temporary PIN must be 6 digits and not too simple.');
  const salt = Utilities.getUuid();
  updateRow_('Users', t._row, {Salt: salt, PinHash: hashPin_(salt, String(req.pin)), MustChangePin: true});
  CacheService.getScriptCache().remove('f:' + String(t.Email).toLowerCase());
  audit_(user, 'PIN_RESET', t.Email, ''); return {ok: true};
}
function changePin_(user, req) {
  const u = user._u, oldPin = String(req.oldPin || ''), newPin = String(req.newPin || '');
  if (!same_(hashPin_(u.Salt, oldPin), u.PinHash)) throw err_('Current PIN is wrong.');
  if (!pinOk_(newPin)) throw err_('New PIN must be 6 digits and not too simple (e.g. 123456, 111111).');
  if (newPin === oldPin) throw err_('New PIN must be different.');
  const salt = Utilities.getUuid(), cache = CacheService.getScriptCache();
  updateRow_('Users', u._row, {Salt: salt, PinHash: hashPin_(salt, newPin), MustChangePin: false});
  cache.remove('s:' + req.token);
  const token = Utilities.getUuid() + Utilities.getUuid();
  cache.put('s:' + token, JSON.stringify({email: user.email, salt: salt}), CFG.SESSION_TTL);
  audit_(user, 'PIN_CHANGE', '', ''); return {token: token};
}

/* ============ settings / audit (owner) ============ */
function saveSettings_(user, req) {
  need_(user, 'settings');
  const name = clean_(req.propertyName, 120), addr = clean_(req.propertyAddress, 300);
  if (!name) throw err_('Property name is required.');
  const cats = []; (req.categories || []).forEach(function (c) { c = clean_(c, 40); if (c && cats.indexOf(c) < 0) cats.push(c); });
  if (cats.length < 1 || cats.length > 60) throw err_('Provide 1–60 categories.');
  if (cats.indexOf('Other') < 0) cats.push('Other');
  const max = readAll_('Vouchers').reduce(function (m, v) { return Math.max(m, Number(v.VoucherNo) || 0); }, 0), next = parseInt(req.nextVoucherNo, 10);
  if (!(next > max)) throw err_('Next voucher number must be greater than ' + max + '.');
  setSetting_('propertyName', name); setSetting_('propertyAddress', addr); setSetting_('categories', JSON.stringify(cats)); setSetting_('nextVoucherNo', String(next));
  audit_(user, 'SETTINGS', '', ''); return {ok: true};
}
function auditLog_(user) {
  need_(user, 'audit');
  const s = sheet_('AuditLog'), last = s.getLastRow(); if (last < 2) return [];
  const n = Math.min(200, last - 1), v = s.getRange(last - n + 1, 1, n, 5).getValues();
  return v.reverse().map(function (r) { return {time: String(r[0]), user: String(r[1]), action: String(r[2]), target: String(r[3]), details: String(r[4])}; });
}
