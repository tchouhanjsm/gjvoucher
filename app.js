/* Cash Payment Vouchers — static, local-first (no server, no Google Apps Script).
   Data is stored in this browser (localStorage). Use Settings → Backup to move/save it.
   NOTE: the PIN is a screen lock for casual protection, not server-grade security. */
(() => {
'use strict';
const KEY = 'cashVouchers.v1', LOCK_KEY = 'cashVouchers.lock';
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(16).slice(2));
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
const fmtDate = iso => iso ? iso.split('-').reverse().join('/') : '';
const fmtMoney = n => '₹' + Number(n || 0).toLocaleString('en-IN', {minimumFractionDigits: 0, maximumFractionDigits: 2});
const parseAmt = s => Number(String(s ?? '').replace(/[,₹\s]/g, ''));

/* ---------- storage ---------- */
const blank = () => ({v: 1, pinHash: '', salt: '', settings: {name: 'My Property', addr: ''}, seq: 201, vouchers: [], vendors: [], audit: []});
let DB;
function load() {
  try { DB = Object.assign(blank(), JSON.parse(localStorage.getItem(KEY) || '{}')); } catch { DB = blank(); }
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(DB)); }
  catch { toast('Could not save — browser storage is full or blocked.', true); }
}
function log(a, d) { DB.audit.unshift({t: new Date().toISOString(), a, d}); DB.audit.length = Math.min(DB.audit.length, 500); }

/* ---------- ui helpers ---------- */
let toastTimer;
function toast(msg, err) {
  const el = $('#alert'); el.textContent = msg; el.className = 'alert' + (err ? ' err' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.add('hidden'), 3500);
}
async function sha(text) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}

/* ---------- lock screen ---------- */
async function initLock() {
  load();
  $('#lock').classList.remove('hidden'); $('#app').classList.add('hidden');
  const first = !DB.pinHash;
  $('#lockPin2').classList.toggle('hidden', !first);
  $('#lockPin2').required = first;
  $('#lockTitle').textContent = DB.settings.name || 'Cash Vouchers';
  $('#lockHint').textContent = first ? 'First time here — choose a 6-digit PIN.' : 'Enter your PIN to continue.';
  $('#lockPin').value = $('#lockPin2').value = ''; $('#lockErr').textContent = '';
  $('#lockPin').focus();
}
$('#lockForm').addEventListener('submit', async e => {
  e.preventDefault();
  const pin = $('#lockPin').value.trim(), err = $('#lockErr');
  if (!/^\d{6}$/.test(pin)) return err.textContent = 'PIN must be exactly 6 digits.';
  if (!DB.pinHash) {
    if (pin !== $('#lockPin2').value.trim()) return err.textContent = 'PINs do not match.';
    DB.salt = uid(); DB.pinHash = await sha(DB.salt + pin); log('SETUP', 'PIN created'); save(); return enter();
  }
  let st = {}; try { st = JSON.parse(localStorage.getItem(LOCK_KEY) || '{}'); } catch {}
  if (st.until && Date.now() < st.until) return err.textContent = `Too many attempts. Try again in ${Math.ceil((st.until - Date.now()) / 60000)} min.`;
  if (await sha(DB.salt + pin) === DB.pinHash) { localStorage.removeItem(LOCK_KEY); return enter(); }
  st.fails = (st.fails || 0) + 1;
  if (st.fails >= 5) { st = {until: Date.now() + 15 * 60000}; err.textContent = 'Locked for 15 minutes.'; }
  else err.textContent = `Wrong PIN (${5 - st.fails} attempts left).`;
  localStorage.setItem(LOCK_KEY, JSON.stringify(st));
  $('#lockPin').value = '';
});
$('#lockBtn').onclick = initLock;

/* ---------- navigation ---------- */
function enter() {
  $('#lock').classList.add('hidden'); $('#app').classList.remove('hidden');
  $('#brandName').textContent = DB.settings.name || 'Cash Vouchers';
  document.title = (DB.settings.name || 'Cash Vouchers') + ' — Vouchers';
  show('overview');
}
function show(v) {
  $$('.view').forEach(s => s.classList.toggle('hidden', s.id !== 'v-' + v));
  $$('#nav button').forEach(b => b.classList.toggle('active', b.dataset.v === v));
  ({overview: renderOverview, new: renderNew, register: renderRegister, reports: runReport, vendors: renderVendors, settings: renderSettings})[v]();
}
$('#nav').addEventListener('click', e => { if (e.target.dataset.v) show(e.target.dataset.v); });

/* ---------- vouchers ---------- */
const vendorNames = () => {
  const c = {}; DB.vouchers.forEach(v => c[v.vendor] = (c[v.vendor] || 0) + 1);
  const reg = DB.vendors.filter(x => x.active).map(x => x.name);
  return [...new Set([...Object.keys(c).sort((a, b) => c[b] - c[a]), ...reg])];
};
const statusBadge = v => `<span class="badge ${v.status === 'ACTIVE' ? '' : 'bad'}">${v.status}</span>`;
function voucherRow(v) {
  return `<tr class="${v.status === 'ACTIVE' ? '' : 'cx'}"><td><b>${esc(v.no)}</b></td><td>${fmtDate(v.date)}</td><td>${esc(v.vendor)}</td>
  <td class="r">${fmtMoney(v.amount)}</td><td>${statusBadge(v)}</td>
  <td class="r"><button class="btn sm" data-a="print" data-id="${v.id}">Print</button>
  ${v.status === 'ACTIVE' ? `<button class="btn sm" data-a="edit" data-id="${v.id}">Edit</button> <button class="btn sm danger" data-a="cancel" data-id="${v.id}">Cancel</button>` : ''}</td></tr>`;
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-a]'); if (!b) return;
  const id = b.dataset.id;
  ({print: () => printVoucher(id), edit: () => openEdit(id), cancel: () => cancelVoucher(id),
    vedit: () => editVendor(id), vtoggle: () => toggleVendor(id)})[b.dataset.a]?.();
});
function renderOverview() {
  const t = today(), act = DB.vouchers.filter(v => v.status === 'ACTIVE' && v.date === t);
  $('#stToday').textContent = fmtMoney(act.reduce((s, v) => s + v.amount, 0));
  $('#stCount').textContent = act.length;
  const last = [...DB.vouchers].sort((a, b) => b.no - a.no)[0];
  $('#stLatest').textContent = last ? '#' + last.no : '–';
  $('#recentBody').innerHTML = [...DB.vouchers].sort((a, b) => b.no - a.no).slice(0, 10).map(voucherRow).join('') || '<tr><td colspan="6" class="muted">No payments yet.</td></tr>';
}

/* new payment */
function addRow(vendor = '', amount = '') {
  const d = document.createElement('div'); d.className = 'row';
  d.innerHTML = `<input class="rv" list="vendorList" placeholder="Paid to (vendor)" value="${esc(vendor)}">
    <input class="ra" inputmode="decimal" placeholder="Amount ₹" value="${esc(amount)}"><button type="button" title="Remove">✕</button>`;
  d.querySelector('button').onclick = () => { if ($$('#rows .row').length > 1) d.remove(); };
  d.querySelector('.ra').addEventListener('keydown', e => {
    if (e.key === 'Enter' && d === $('#rows').lastElementChild) { e.preventDefault(); addRow(); $('#rows').lastElementChild.querySelector('.rv').focus(); }
  });
  $('#rows').appendChild(d);
}
function renderNew() {
  $('#vendorList').innerHTML = vendorNames().map(n => `<option value="${esc(n)}">`).join('');
  $('#nDate').value = today(); $('#rows').innerHTML = ''; addRow(); $('#rows .rv').focus();
}
$('#addRow').onclick = () => { addRow(); $('#rows').lastElementChild.querySelector('.rv').focus(); };
$('#newForm').addEventListener('submit', e => {
  e.preventDefault();
  const date = $('#nDate').value, entries = [];
  for (const r of $$('#rows .row')) {
    const vendor = r.querySelector('.rv').value.trim().slice(0, 200), amount = parseAmt(r.querySelector('.ra').value);
    if (!vendor && !r.querySelector('.ra').value.trim()) continue;
    if (!vendor) return toast('Vendor is required in every row.', true);
    if (!isFinite(amount) || amount <= 0) return toast('Enter a valid amount for ' + vendor + '.', true);
    entries.push({vendor, amount: Math.round(amount * 100) / 100});
  }
  if (!date) return toast('Date is required.', true);
  if (!entries.length) return toast('Add at least one payment.', true);
  const nos = entries.map(en => {
    const v = {id: uid(), no: DB.seq++, date, vendor: en.vendor, amount: en.amount, status: 'ACTIVE', createdAt: new Date().toISOString(), updatedAt: ''};
    DB.vouchers.push(v); log('CREATE', `#${v.no} ${v.vendor} ${fmtMoney(v.amount)}`); return v.no;
  });
  save(); toast(`Saved voucher${nos.length > 1 ? 's' : ''} #${nos.join(', #')}`); renderNew();
});

/* register */
function filtered() {
  const q = $('#fSearch').value.trim().toLowerCase(), ven = $('#fVendor').value, f = $('#fFrom').value, t = $('#fTo').value, c = $('#fCancelled').checked;
  return DB.vouchers.filter(v => (c || v.status === 'ACTIVE') && (!ven || v.vendor === ven) && (!f || v.date >= f) && (!t || v.date <= t)
    && (!q || String(v.no).includes(q) || v.vendor.toLowerCase().includes(q))).sort((a, b) => b.no - a.no);
}
function renderRegister() {
  const sel = $('#fVendor'), cur = sel.value;
  sel.innerHTML = '<option value="">All vendors</option>' + vendorNames().sort().map(n => `<option>${esc(n)}</option>`).join(''); sel.value = cur;
  const list = filtered();
  $('#regBody').innerHTML = list.map(voucherRow).join('') || '<tr><td colspan="6" class="muted">No payments match.</td></tr>';
  $('#regTotal').textContent = fmtMoney(list.filter(v => v.status === 'ACTIVE').reduce((s, v) => s + v.amount, 0));
  $('#regCount').textContent = `(${list.length} vouchers)`;
}
['#fSearch', '#fVendor', '#fFrom', '#fTo', '#fCancelled'].forEach(s => $(s).addEventListener('input', renderRegister));
$('#fClear').onclick = () => { ['#fSearch', '#fVendor', '#fFrom', '#fTo'].forEach(s => $(s).value = ''); $('#fCancelled').checked = false; renderRegister(); };
$('#fCsv').onclick = () => {
  const rows = [['VoucherNo', 'Date', 'Vendor', 'Amount', 'Status', 'CreatedAt']].concat(filtered().map(v => [v.no, fmtDate(v.date), v.vendor, v.amount, v.status, v.createdAt]));
  download('vouchers-' + today() + '.csv', rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"`).join(',')).join('\n'), 'text/csv');
};

/* edit / cancel */
function openEdit(id) {
  const v = DB.vouchers.find(x => x.id === id); if (!v) return;
  $('#eId').value = id; $('#eNo').textContent = '#' + v.no; $('#eDate').value = v.date; $('#eVendor').value = v.vendor; $('#eAmount').value = v.amount;
  $('#modal').classList.remove('hidden');
}
$('#eCancel').onclick = () => $('#modal').classList.add('hidden');
$('#editForm').addEventListener('submit', e => {
  e.preventDefault();
  const v = DB.vouchers.find(x => x.id === $('#eId').value), amt = parseAmt($('#eAmount').value), ven = $('#eVendor').value.trim();
  if (!v || !ven || !isFinite(amt) || amt <= 0 || !$('#eDate').value) return toast('Please fill all fields with valid values.', true);
  Object.assign(v, {date: $('#eDate').value, vendor: ven.slice(0, 200), amount: Math.round(amt * 100) / 100, updatedAt: new Date().toISOString()});
  log('UPDATE', `#${v.no}`); save(); $('#modal').classList.add('hidden'); toast('Voucher updated.'); refresh();
});
function cancelVoucher(id) {
  const v = DB.vouchers.find(x => x.id === id);
  if (!v || !confirm(`Cancel voucher #${v.no} (${v.vendor}, ${fmtMoney(v.amount)})?`)) return;
  v.status = 'CANCELLED'; v.updatedAt = new Date().toISOString(); log('CANCEL', `#${v.no}`); save(); toast(`Voucher #${v.no} cancelled.`); refresh();
}
const refresh = () => show($$('.view').find(s => !s.classList.contains('hidden')).id.slice(2));

/* ---------- print (A5) ---------- */
const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
function below100(n) { return n < 20 ? ones[n] : tens[Math.floor(n / 10)] + (n % 10 ? ' ' + ones[n % 10] : ''); }
function below1000(n) { return (n >= 100 ? ones[Math.floor(n / 100)] + ' Hundred' + (n % 100 ? ' ' : '') : '') + (n % 100 ? below100(n % 100) : ''); }
function words(n) {
  if (n === 0) return 'Zero';
  const parts = [[10000000, 'Crore'], [100000, 'Lakh'], [1000, 'Thousand']]; let out = [];
  for (const [d, name] of parts) { const q = Math.floor(n / d); if (q) { out.push(words(q) + ' ' + name); n %= d; } }
  if (n) out.push(below1000(n));
  return out.join(' ');
}
function amountWords(a) {
  const r = Math.floor(a), p = Math.round((a - r) * 100);
  return words(r) + ' Rupees' + (p ? ' and ' + words(p) + ' Paise' : '') + ' Only';
}
function printVoucher(id) {
  const v = DB.vouchers.find(x => x.id === id); if (!v) return;
  $('#printArea').innerHTML = `<div class="pv"><div class="pv-head"><div class="pv-hotel">${esc(DB.settings.name)}</div>
    <div class="pv-addr">${esc(DB.settings.addr)}</div><div class="pv-title">CASH PAYMENT VOUCHER</div></div>
    <div class="pv-meta"><div>Voucher No: <b>${esc(v.no)}</b></div><div>Date: <b>${fmtDate(v.date)}</b></div></div>
    <div class="pv-row"><div class="l">Paid To</div><div class="v">${esc(v.vendor)}</div></div>
    <div class="pv-row"><div class="l">Amount Paid</div><div class="v pv-amt">${fmtMoney(v.amount)}</div></div>
    <div class="pv-words"><b>Amount in Words</b><br><br>${esc(amountWords(v.amount))}</div>
    ${v.status !== 'ACTIVE' ? '<div class="pv-cx">*** CANCELLED ***</div>' : ''}
    <div class="pv-sign"><div>Prepared By</div><div>Paid By</div><div>Receiver Signature</div></div></div>`;
  window.print();
}

/* ---------- reports ---------- */
function runReport() {
  const f = $('#rFrom').value, t = $('#rTo').value;
  if (!f && !t) { const d = new Date(); $('#rFrom').value = today().slice(0, 8) + '01'; $('#rTo').value = today(); return runReport(); }
  const list = DB.vouchers.filter(v => v.status === 'ACTIVE' && (!f || v.date >= f) && (!t || v.date <= t));
  const group = k => { const m = {}; list.forEach(v => { (m[v[k]] ||= {c: 0, s: 0}); m[v[k]].c++; m[v[k]].s += v.amount; }); return Object.entries(m); };
  const tr = (a, b, c) => `<tr><td>${a}</td><td class="r">${b}</td><td class="r">${c}</td></tr>`, tot = list.reduce((s, v) => s + v.amount, 0);
  const foot = tr('<b>Total</b>', `<b>${list.length}</b>`, `<b>${fmtMoney(tot)}</b>`);
  $('#repVendor').innerHTML = group('vendor').sort((a, b) => b[1].s - a[1].s).map(([k, x]) => tr(esc(k), x.c, fmtMoney(x.s))).join('') + foot;
  $('#repDay').innerHTML = group('date').sort((a, b) => a[0].localeCompare(b[0])).map(([k, x]) => tr(fmtDate(k), x.c, fmtMoney(x.s))).join('') + foot;
}
$('#rRun').onclick = runReport;
$('#rPrint').onclick = () => {
  $('#printArea').innerHTML = `<div class="rp"><h2>${esc(DB.settings.name)} — Payments ${fmtDate($('#rFrom').value)} to ${fmtDate($('#rTo').value)}</h2>
    <h3>By Vendor</h3><table>${$('#repVendor').closest('table').innerHTML}</table><h3>By Day</h3><table>${$('#repDay').closest('table').innerHTML}</table></div>`;
  window.print();
};

/* ---------- vendors ---------- */
function renderVendors() {
  $('#vBody').innerHTML = [...DB.vendors].sort((a, b) => a.name.localeCompare(b.name)).map(v => `<tr><td>${esc(v.name)}</td><td>${esc(v.company)}</td><td>${esc(v.mobile)}</td>
    <td><span class="badge ${v.active ? '' : 'bad'}">${v.active ? 'ACTIVE' : 'INACTIVE'}</span></td>
    <td class="r"><button class="btn sm" data-a="vedit" data-id="${v.id}">Edit</button> <button class="btn sm" data-a="vtoggle" data-id="${v.id}">${v.active ? 'Deactivate' : 'Activate'}</button></td></tr>`).join('')
    || '<tr><td colspan="5" class="muted">No vendors yet. Vendors you pay are also remembered automatically.</td></tr>';
}
const clearVendor = () => { $('#vForm').reset(); $('#vId').value = ''; };
$('#vClear').onclick = clearVendor;
$('#vForm').addEventListener('submit', e => {
  e.preventDefault();
  const name = $('#vName').value.trim(), mobile = $('#vMobile').value.trim(), id = $('#vId').value;
  if (mobile && !/^[0-9+\-\s]{7,15}$/.test(mobile)) return toast('Enter a valid mobile number.', true);
  if (DB.vendors.some(v => v.id !== id && v.name.toLowerCase() === name.toLowerCase())) return toast('This vendor already exists.', true);
  if (id) Object.assign(DB.vendors.find(v => v.id === id), {name, company: $('#vCompany').value.trim(), mobile});
  else DB.vendors.push({id: uid(), name, company: $('#vCompany').value.trim(), mobile, active: true});
  log(id ? 'UPDATE_VENDOR' : 'CREATE_VENDOR', name); save(); clearVendor(); renderVendors(); toast('Vendor saved.');
});
function editVendor(id) { const v = DB.vendors.find(x => x.id === id); $('#vId').value = id; $('#vName').value = v.name; $('#vCompany').value = v.company; $('#vMobile').value = v.mobile; $('#vName').focus(); }
function toggleVendor(id) { const v = DB.vendors.find(x => x.id === id); v.active = !v.active; log(v.active ? 'ACTIVATE_VENDOR' : 'DEACTIVATE_VENDOR', v.name); save(); renderVendors(); }

/* ---------- settings / backup ---------- */
function renderSettings() {
  $('#sName').value = DB.settings.name; $('#sAddr').value = DB.settings.addr; $('#sSeq').value = DB.seq;
  $('#auditBody').innerHTML = DB.audit.slice(0, 50).map(a => `<tr><td>${new Date(a.t).toLocaleString('en-IN')}</td><td>${esc(a.a)}</td><td>${esc(a.d)}</td></tr>`).join('');
}
$('#setForm').addEventListener('submit', e => {
  e.preventDefault();
  const seq = parseInt($('#sSeq').value, 10), max = Math.max(0, ...DB.vouchers.map(v => v.no));
  if (!(seq > max)) return toast(`Next voucher number must be greater than ${max}.`, true);
  DB.settings = {name: $('#sName').value.trim() || 'My Property', addr: $('#sAddr').value.trim()}; DB.seq = seq;
  log('SETTINGS', 'Updated'); save(); $('#brandName').textContent = DB.settings.name; toast('Settings saved.');
});
$('#pinForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (await sha(DB.salt + $('#pOld').value) !== DB.pinHash) return toast('Current PIN is wrong.', true);
  if (!/^\d{6}$/.test($('#pNew').value)) return toast('New PIN must be 6 digits.', true);
  DB.salt = uid(); DB.pinHash = await sha(DB.salt + $('#pNew').value); log('PIN', 'Changed'); save(); e.target.reset(); toast('PIN changed.');
});
function download(name, text, type) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], {type})); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
$('#bkExport').onclick = () => { download(`vouchers-backup-${today()}.json`, JSON.stringify(DB), 'application/json'); toast('Backup downloaded.'); };
$('#bkImport').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    if (!Array.isArray(d.vouchers) || !Array.isArray(d.vendors) || !d.pinHash) throw 0;
    if (!confirm(`Replace ALL current data with this backup (${d.vouchers.length} vouchers)?`)) return;
    DB = Object.assign(blank(), d); log('RESTORE', f.name); save(); toast('Backup restored.'); enter();
  } catch { toast('That file is not a valid backup.', true); }
});

/* auto-lock after 15 min idle */
let idle; const arm = () => { clearTimeout(idle); idle = setTimeout(() => !$('#app').classList.contains('hidden') && initLock(), 15 * 60000); };
['click', 'keydown', 'touchstart'].forEach(ev => document.addEventListener(ev, arm, {passive: true}));
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
initLock();
})();
