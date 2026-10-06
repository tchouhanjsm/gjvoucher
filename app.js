/* Cash Payment Vouchers — static PWA front end. Talks to the Apps Script API (backend/Code.gs). */
(() => {
'use strict';
const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(16).slice(2));
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => iso(new Date());
const addDays = (s, n) => { const d = new Date(s + 'T12:00:00'); d.setDate(d.getDate() + n); return iso(d); };
const dmy = s => s ? s.split('-').reverse().join('/') : '';
const money = n => { n = Number(n || 0); return '₹' + n.toLocaleString('en-IN', {minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2}); };
const ls = {get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); return true; } catch { return false; } }, del: k => { try { localStorage.removeItem(k); } catch {} }};
const S = {url: '', token: '', me: null, settings: {}, vouchers: [], vendors: [], names: {}, loadedAt: 0, view: 'dash'};
const can = p => !!(S.me && S.me.perms && S.me.perms[p]);
const nm = e => S.names[e] || e || '';

/* ---------------- API ---------------- */
async function api(action, payload = {}) {
  if (!S.url) throw Object.assign(new Error('Server URL is not set.'), {code: 'NOURL'});
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 70000);
  let res;
  try { res = await fetch(S.url, {method: 'POST', body: JSON.stringify({action, token: S.token, ...payload}), signal: ctl.signal}); }
  catch { throw Object.assign(new Error('No connection to the server. Check your internet and try again.'), {code: 'NET'}); }
  finally { clearTimeout(t); }
  let j; try { j = await res.json(); } catch { throw Object.assign(new Error('Unexpected server response. Check the Server URL / deployment.'), {code: 'BAD'}); }
  if (!j.ok) {
    if (j.code === 'SESSION') { signOut(true); }
    if (j.code === 'PIN_CHANGE') { forcePinChange(); }
    throw Object.assign(new Error(j.error || 'Request failed.'), {code: j.code});
  }
  return j.data;
}
let toastT;
function toast(msg, kind) { const el = $('#toast'); el.textContent = msg; el.className = 'toast ' + (kind || ''); clearTimeout(toastT); toastT = setTimeout(() => el.classList.add('hidden'), 3800); }
const fail = e => toast(e.message || String(e), 'err');
async function busy(btn, fn) { if (btn) btn.disabled = true; try { return await fn(); } finally { if (btn) btn.disabled = false; } }

/* ---------------- modal ---------------- */
function closeModal() { $('#modal').classList.add('hidden'); $('#modal').innerHTML = ''; }
function dialog(title, body, onSubmit, ok = 'Save') {
  const m = $('#modal'); m.classList.remove('hidden');
  m.innerHTML = `<form class="card mcard" autocomplete="off"><h2>${title}</h2>${body}<p class="error" id="mErr"></p><div class="actions"><button type="button" class="btn" data-x>Close</button>${onSubmit ? `<button class="btn primary">${ok}</button>` : ''}</div></form>`;
  const f = $('form', m); $('[data-x]', f).onclick = closeModal;
  f.onsubmit = async e => { e.preventDefault(); const b = $('.primary', f); b.disabled = true; try { await onSubmit(f); } catch (er) { $('#mErr').textContent = er.message; } finally { b.disabled = false; } };
  const first = $('input,select,textarea', f); if (first) first.focus();
  return f;
}

/* ---------------- login ---------------- */
function showLogin(msg) {
  $('#app').classList.add('hidden'); $('#login').classList.remove('hidden');
  $('#lUrl').classList.toggle('hidden', !!(window.CV_CONFIG && CV_CONFIG.API_URL));
  $('#lUrl').value = ls.get('cv.url') || ''; $('#lPin').value = ''; $('#lErr').textContent = msg || '';
  $('#loginTitle').textContent = ls.get('cv.name') || 'Cash Vouchers';
  const lastEmail = ls.get('cv.email'); if (lastEmail) $('#lEmail').value = lastEmail;
}
$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault(); const err = $('#lErr'); err.textContent = '';
  S.url = (window.CV_CONFIG && CV_CONFIG.API_URL) || $('#lUrl').value.trim();
  if (!/^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1))/.test(S.url)) return err.textContent = 'Enter the Server URL (starts with https://).';
  S.token = '';
  await busy($('#lBtn'), async () => {
    try {
      const d = await api('login', {email: $('#lEmail').value.trim(), pin: $('#lPin').value.trim()});
      S.token = d.token; ls.set('cv.token', d.token); ls.set('cv.url', S.url); ls.set('cv.email', $('#lEmail').value.trim());
      await start(d.user.mustChangePin);
    } catch (er) { err.textContent = er.message; }
  });
});
function signOut(expired) {
  if (S.token && !expired) api('logout').catch(() => {});
  S.token = ''; S.me = null; ls.del('cv.token'); closeModal(); showLogin(expired ? 'Session expired. Please sign in again.' : '');
}
function forcePinChange() {
  dialog('Choose a new PIN', `<p class="muted">Your PIN was set by an administrator. Please choose your own 6-digit PIN.</p>
    <input id="op" type="password" inputmode="numeric" maxlength="6" placeholder="Current (temporary) PIN" required>
    <input id="np" type="password" inputmode="numeric" maxlength="6" placeholder="New PIN" required style="margin-top:8px">`,
    async f => { const d = await api('changePin', {oldPin: $('#op').value, newPin: $('#np').value}); S.token = d.token; ls.set('cv.token', d.token); closeModal(); toast('PIN changed.', 'ok'); await start(); }, 'Change PIN');
  $('[data-x]').onclick = () => signOut();
}

/* ---------------- boot / nav ---------------- */
const NAV = [['dash', '📊', 'Dashboard', () => true], ['new', '➕', 'New Payment', () => can('create')], ['reg', '📒', 'Register', () => true],
  ['bulk', '📥', 'Bulk Upload', () => can('bulk')], ['vend', '🏪', 'Vendors', () => can('vendors')], ['users', '👥', 'Users', () => can('users')],
  ['set', '⚙️', 'Settings', () => can('settings')], ['acct', '👤', 'Account', () => true]];
async function load() {
  const d = await api('bootstrap');
  Object.assign(S, {me: d.user, settings: d.settings, vouchers: d.vouchers, vendors: d.vendors, names: d.names, loadedAt: Date.now()});
  ls.set('cv.name', d.settings.propertyName);
  ls.set('cv.cache', JSON.stringify({me: d.user, names: d.names, settings: d.settings, vendors: d.vendors, vn: [...new Set(d.vouchers.map(v => v.vendor))].slice(0, 300)}));
}
async function start(mustChange) {
  $('#login').classList.add('hidden');
  if (mustChange) { $('#app').classList.add('hidden'); return forcePinChange(); }
  let offline = false;
  try { await load(); } catch (e) {
    if (e.code === 'PIN_CHANGE' || e.code === 'SESSION') return;
    let c = null; try { c = JSON.parse(ls.get('cv.cache') || 'null'); } catch {}
    if (e.code === 'NET' && c && c.me) { Object.assign(S, {me: c.me, settings: c.settings, vendors: c.vendors || [], names: c.names || {}, vouchers: []}); offline = true; }
    else { $('#login').classList.remove('hidden'); return $('#lErr').textContent = e.message; }
  }
  $('#app').classList.remove('hidden');
  $('#brand').textContent = S.settings.propertyName || 'Cash Vouchers'; document.title = (S.settings.propertyName || 'Vouchers');
  $('#who').innerHTML = `${esc(S.me.name)}<br>${esc(S.me.role)}`;
  $('#nav').innerHTML = NAV.filter(n => n[3]()).map(n => `<button data-v="${n[0]}"><span class="ic">${n[1]}</span><span>${n[2]}</span></button>`).join('');
  go(offline ? 'new' : (S.view && NAV.find(n => n[0] === S.view && n[3]()) ? S.view : 'dash'));
  if (offline) toast('Offline — you can still add payments; they upload when you are back online.'); else flushOutbox();
}
$('#nav').addEventListener('click', e => { const b = e.target.closest('[data-v]'); if (b) go(b.dataset.v); });
function go(v) {
  S.view = v; $$('#nav button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  ({dash: vDash, new: vNew, reg: vReg, bulk: vBulk, vend: vVend, users: vUsers, set: vSet, acct: vAcct})[v]();
  window.scrollTo(0, 0);
}
async function refresh(quiet) { try { await load(); go(S.view); if (!quiet) toast('Updated.', 'ok'); } catch (e) { if (!quiet) fail(e); } }
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.me && Date.now() - S.loadedAt > 120000 && !$('#modal').innerHTML) { if (S.view !== 'new' && S.view !== 'bulk') refresh(true); flushOutbox(); } });
window.addEventListener('online', () => flushOutbox());
let idleT; const arm = () => { clearTimeout(idleT); if (S.me) idleT = setTimeout(() => signOut(true), 30 * 60000); };
['click', 'keydown', 'touchstart'].forEach(ev => document.addEventListener(ev, arm, {passive: true}));
const head = (t, extra = '') => `<div class="head"><h1>${t}</h1><div>${extra}</div></div>`;
const refreshBtn = '<button class="btn sm" data-act="refresh">↻ Refresh</button>';

/* ---------------- helpers ---------------- */
const active = () => S.vouchers.filter(v => v.status === 'ACTIVE');
const sum = a => a.reduce((s, v) => s + v.amount, 0);
const categories = () => S.settings.categories || ['Other'];
const catOpts = sel => categories().map(c => `<option${c === sel ? ' selected' : ''}>${esc(c)}</option>`).join('');
const vendorNames = () => { const c = {}; S.vouchers.forEach(v => c[v.vendor] = (c[v.vendor] || 0) + 1);
  let cache = {}; try { cache = JSON.parse(ls.get('cv.cache') || '{}'); } catch {}
  return [...new Set([...Object.keys(c).sort((a, b) => c[b] - c[a]), ...S.vendors.filter(v => v.active).map(v => v.name), ...(cache.vn || [])])]; };
const vendorList = () => `<datalist id="vlist">${vendorNames().map(n => `<option value="${esc(n)}">`).join('')}</datalist>`;
function download(name, text, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], {type})); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1500); }
const csvCell = c => `"${String(c ?? '').replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"`;
function readFileB64(blob) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); }); }
async function compress(file) {
  if (!/^image\//.test(file.type)) throw new Error('Please choose an image file.');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Could not read that image (try a JPG or PNG).')); i.src = url; });
    for (const [max, q] of [[1600, .72], [1280, .6], [960, .5]]) {
      const sc = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight)), c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * sc); c.height = Math.round(img.naturalHeight * sc);
      const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(img, 0, 0, c.width, c.height);
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', q));
      if (blob && blob.size < 1100000) return {mime: 'image/jpeg', data: await readFileB64(blob), preview: URL.createObjectURL(blob)};
    }
    throw new Error('Image is too large.');
  } finally { URL.revokeObjectURL(url); }
}

/* ---------------- dashboard ---------------- */
const D = {r: '30d', from: '', to: ''};
function range() {
  const t = today(), d = new Date(), ms = iso(new Date(d.getFullYear(), d.getMonth(), 1));
  if (D.r === '7d') return [addDays(t, -6), t]; if (D.r === 'mtd') return [ms, t];
  if (D.r === 'lm') { const a = new Date(d.getFullYear(), d.getMonth() - 1, 1), b = new Date(d.getFullYear(), d.getMonth(), 0); return [iso(a), iso(b)]; }
  if (D.r === 'cus' && D.from && D.to) return [D.from, D.to]; return [addDays(t, -29), t];
}
function group(list, key) { const m = {}; list.forEach(v => { const k = key(v); (m[k] ||= {k, n: 0, s: 0}); m[k].n++; m[k].s += v.amount; }); return Object.values(m).sort((a, b) => b.s - a.s); }
const bars = (rows, n = 8) => { const top = rows.slice(0, n), mx = Math.max(1, ...top.map(r => r.s));
  return top.map(r => `<div class="hb"><div class="hb-l" title="${esc(r.k)}">${esc(r.k)}</div><div class="hb-t"><i style="width:${Math.max(2, r.s / mx * 100)}%"></i></div><div class="hb-v">${money(r.s)}</div></div>`).join('') || '<p class="muted">No data in this period.</p>'; };
function trendSvg(list, from, to) {
  const days = Math.round((new Date(to) - new Date(from)) / 864e5) + 1, monthly = days > 62, m = {};
  list.forEach(v => { const k = monthly ? v.date.slice(0, 7) : v.date; m[k] = (m[k] || 0) + v.amount; });
  const keys = []; if (monthly) { let d = new Date(from.slice(0, 7) + '-01T12:00:00'); const end = to.slice(0, 7); while (iso(d).slice(0, 7) <= end) { keys.push(iso(d).slice(0, 7)); d.setMonth(d.getMonth() + 1); } }
  else for (let i = 0; i < days; i++) keys.push(addDays(from, i));
  const vals = keys.map(k => m[k] || 0), mx = Math.max(1, ...vals), W = Math.max(280, Math.min(1100, innerWidth - (innerWidth > 800 ? 262 : 24) - 34)), H = 190, L = 8, B = 22, bw = (W - L * 2) / keys.length, step = Math.ceil(keys.length / Math.max(3, Math.floor(W / 70)));
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Spending trend">` +
    keys.map((k, i) => { const h = Math.max(vals[i] ? 2 : 0, vals[i] / mx * (H - B - 18)); return `<rect class="b" x="${L + i * bw + 1}" y="${H - B - h}" width="${Math.max(1, bw - 2)}" height="${h}" rx="2"><title>${esc(monthly ? k : dmy(k))}: ${money(vals[i])}</title></rect>` +
      (i % step === 0 ? `<text x="${L + i * bw}" y="${H - 6}">${esc(monthly ? k : k.slice(8) + '/' + k.slice(5, 7))}</text>` : ''); }).join('') +
    `<text x="${L}" y="11">Peak ${money(mx)}</text></svg>`;
}
function vDash() {
  const [from, to] = range(), len = Math.round((new Date(to) - new Date(from)) / 864e5) + 1;
  const A = active(), cur = A.filter(v => v.date >= from && v.date <= to), prev = A.filter(v => v.date >= addDays(from, -len) && v.date < from);
  const tot = sum(cur), ptot = sum(prev), delta = ptot ? (tot - ptot) / ptot * 100 : null, td = A.filter(v => v.date === today());
  const big = cur.reduce((m, v) => v.amount > (m ? m.amount : 0) ? v : m, null);
  $('#view').innerHTML = head(can('viewAll') ? 'Dashboard' : 'My Dashboard', refreshBtn) + `
  <div class="seg">${[['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['mtd', 'This month'], ['lm', 'Last month'], ['cus', 'Custom']].map(([k, l]) => `<button data-act="range" data-k="${k}" class="${D.r === k ? 'on' : ''}">${l}</button>`).join('')}</div>
  ${D.r === 'cus' ? `<div class="card filters"><label>From<input type="date" id="dFrom" value="${D.from || from}"></label><label>To<input type="date" id="dTo" value="${D.to || to}"></label><button class="btn primary" data-act="cus">Apply</button></div>` : ''}
  <div class="stats">
    <div class="card stat"><span>Total paid</span><b>${money(tot)}</b><small class="${delta === null ? 'muted' : delta > 0 ? 'up' : 'down'}">${delta === null ? 'no earlier data' : (delta > 0 ? '▲ ' : '▼ ') + Math.abs(delta).toFixed(0) + '% vs previous ' + len + ' days'}</small></div>
    <div class="card stat"><span>Vouchers</span><b>${cur.length}</b><small class="muted">avg ${money(cur.length ? tot / cur.length : 0)}</small></div>
    <div class="card stat"><span>Largest</span><b>${money(big ? big.amount : 0)}</b><small class="muted">${big ? esc(big.vendor) : '–'}</small></div>
    <div class="card stat"><span>Today</span><b>${money(sum(td))}</b><small class="muted">${td.length} vouchers</small></div>
  </div>
  <div class="card"><h2>Spending trend <span class="muted">${dmy(from)} – ${dmy(to)}</span></h2>${trendSvg(cur, from, to)}</div>
  <div class="two"><div class="card"><h2>Top vendors</h2>${bars(group(cur, v => v.vendor))}</div><div class="card"><h2>By category</h2>${bars(group(cur, v => v.category || 'Other'))}</div></div>
  ${can('viewAll') ? `<div class="card"><h2>By team member</h2>${bars(group(cur, v => nm(v.createdBy)), 10)}</div>` : ''}`;
}

/* ---------------- new payment ---------------- */
function rowHtml() {
  return `<div class="erow"><div class="top"><input class="rv" list="vlist" placeholder="Paid to (vendor)" autocapitalize="words"><input class="ra" inputmode="decimal" placeholder="Amount ₹"><button type="button" class="x" data-act="delrow" title="Remove">✕</button></div>
  <div class="bot"><select class="rc">${catOpts('Other')}</select><input class="rn" placeholder="Note (optional)"></div>
  <div class="chips"><label class="btn sm" style="margin:0">📷 Receipt<input type="file" class="rf" accept="image/*" multiple hidden></label><span class="rp"></span></div></div>`;
}
function vNew() {
  $('#view').innerHTML = head('New Cash Payment') + `<form id="nf" class="card" autocomplete="off">${vendorList()}
    <label style="max-width:220px">Date<input type="date" id="nd" value="${today()}" max="${addDays(today(), 1)}" required></label><div id="rows"></div>
    <div class="actions"><button type="button" class="btn" data-act="addrow">+ Add another</button><button class="btn primary" id="nsave">Save payments</button></div>
    <p class="muted">Tip: tap “Receipt” to take a photo or pick a screenshot (up to 3 per payment).</p></form><div id="nres"></div>`;
  addRow();
}
function addRow() { const d = document.createElement('div'); d.innerHTML = rowHtml(); const r = d.firstElementChild; r._rec = []; $('#rows').appendChild(r); const v = $('.rv', r); if ($$('#rows .erow').length > 1) v.focus(); }
document.addEventListener('change', async e => {
  if (!e.target.classList.contains('rf')) return;
  const row = e.target.closest('.erow'), files = [...e.target.files]; e.target.value = '';
  for (const f of files) { if (row._rec.length >= 3) { toast('Maximum 3 receipts per payment.', 'err'); break; }
    try { row._rec.push(await compress(f)); } catch (er) { fail(er); } }
  $('.rp', row).innerHTML = row._rec.map(r => `<img class="thumb" src="${r.preview}" alt="receipt">`).join('') + (row._rec.length ? ` <button type="button" class="btn sm" data-act="clrrec">Clear</button>` : '');
});
document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.classList.contains('ra')) { e.preventDefault(); const rows = $$('#rows .erow'); if (e.target.closest('.erow') === rows[rows.length - 1]) addRow(); else $('.rv', rows[rows.indexOf(e.target.closest('.erow')) + 1]).focus(); } });
async function saveNew(btn) {
  const date = $('#nd').value, entries = [];
  for (const r of $$('#rows .erow')) {
    const vendor = $('.rv', r).value.trim(), raw = $('.ra', r).value.trim(), amount = parseAmt(raw);
    if (!vendor && !raw && !r._rec.length) continue;
    if (!vendor) return toast('Vendor is required in every row.', 'err');
    if (!(amount > 0)) return toast('Enter a valid amount for ' + vendor + '.', 'err');
    entries.push({clientId: r._cid || (r._cid = uid()), date, vendor, amount, category: $('.rc', r).value, notes: $('.rn', r).value.trim(), receipts: r._rec.map(x => ({mime: x.mime, data: x.data}))});
  }
  if (!date) return toast('Date is required.', 'err'); if (!entries.length) return toast('Add at least one payment.', 'err');
  await busy(btn, async () => {
    try {
      const d = await api('createVouchers', {entries}); d.created.forEach(c => { if (!S.vouchers.find(v => v.id === c.id)) S.vouchers.push(c); });
      $('#nf').classList.add('hidden');
      $('#nres').innerHTML = `<div class="card ok-panel"><h2>✔ Saved ${d.created.length} payment${d.created.length > 1 ? 's' : ''}</h2>${d.created.map(c => `<div style="margin:8px 0">#${c.no} · ${esc(c.vendor)} · <b>${money(c.amount)}</b> <button class="btn sm" data-act="print" data-id="${c.id}">Print</button></div>`).join('')}<div class="actions"><button class="btn primary" data-act="newagain">New payment</button></div></div>`;
    } catch (e) {
      if (e.code !== 'NET') return fail(e);
      if (!queue(entries)) return;
      $('#nf').classList.add('hidden'); $('#nres').innerHTML = `<div class="card ok-panel"><h2>📴 Saved on this device</h2><p>You're offline. These ${entries.length} payment(s) will upload automatically when you're back online.</p><div class="actions"><button class="btn primary" data-act="newagain">New payment</button></div></div>`;
    }
  });
}
$('#view').addEventListener('submit', e => { if (e.target.id === 'nf') { e.preventDefault(); saveNew($('#nsave')); } });
function parseAmt(s) { const n = Number(String(s ?? '').replace(/[,₹\s]|rs\.?/gi, '')); return isFinite(n) ? Math.round(n * 100) / 100 : NaN; }

/* ---------------- offline outbox ---------------- */
const outbox = () => { try { return JSON.parse(ls.get('cv.outbox') || '[]'); } catch { return []; } };
function queue(entries) { const all = outbox().concat(entries); if (!ls.set('cv.outbox', JSON.stringify(all))) { toast('Phone storage is full — could not save offline. Remove receipts and retry.', 'err'); return false; } showBanner(); return true; }
function showBanner(errMsg) {
  const n = outbox().length, b = $('#banner');
  if (!n) return b.classList.add('hidden');
  b.className = 'banner' + (errMsg ? ' err' : ''); b.innerHTML = `<span>📤 ${n} payment${n > 1 ? 's' : ''} waiting to upload${errMsg ? ' — ' + esc(errMsg) : ''}</span><button class="btn sm" data-act="flush">Retry now</button><button class="btn sm danger" data-act="discard">Discard</button>`;
}
let flushing = false;
async function flushOutbox() {
  const all = outbox(); if (!all.length || flushing || !S.token) return showBanner(); flushing = true;
  try {
    for (let i = 0; i < all.length; i += 10) { const chunk = all.slice(i, i + 10); await api('createVouchers', {entries: chunk}); ls.set('cv.outbox', JSON.stringify(all.slice(i + 10))); }
    toast('Offline payments uploaded.', 'ok'); showBanner(); await refresh(true);
  } catch (e) { showBanner(e.code === 'NET' ? '' : e.message); } finally { flushing = false; }
}

/* ---------------- register ---------------- */
const R = {q: '', vendor: '', cat: '', user: '', from: '', to: '', st: 'ACTIVE', limit: 100};
function filtered() {
  const q = R.q.toLowerCase();
  return S.vouchers.filter(v => (R.st === 'ALL' || v.status === R.st) && (!R.vendor || v.vendor === R.vendor) && (!R.cat || v.category === R.cat) && (!R.user || v.createdBy === R.user)
    && (!R.from || v.date >= R.from) && (!R.to || v.date <= R.to) && (!q || String(v.no).includes(q) || v.vendor.toLowerCase().includes(q) || v.notes.toLowerCase().includes(q))).sort((a, b) => b.no - a.no);
}
function vReg() {
  const vend = [...new Set(S.vouchers.map(v => v.vendor))].sort(), users = [...new Set(S.vouchers.map(v => v.createdBy))];
  $('#view').innerHTML = head('Payment Register', refreshBtn) + `<div class="card filters" id="rf">
    <input id="rq" placeholder="Search no / vendor / note" value="${esc(R.q)}">
    <select id="rv"><option value="">All vendors</option>${vend.map(v => `<option${v === R.vendor ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select>
    <select id="rc"><option value="">All categories</option>${categories().map(c => `<option${c === R.cat ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select>
    ${can('viewAll') ? `<select id="ru"><option value="">All users</option>${users.map(u => `<option value="${esc(u)}"${u === R.user ? ' selected' : ''}>${esc(nm(u))}</option>`).join('')}</select>` : ''}
    <label>From<input type="date" id="rfrom" value="${R.from}"></label><label>To<input type="date" id="rto" value="${R.to}"></label>
    <select id="rs">${[['ACTIVE', 'Active'], ['CANCELLED', 'Cancelled'], ['ALL', 'All']].map(([k, l]) => `<option value="${k}"${R.st === k ? ' selected' : ''}>${l}</option>`).join('')}</select>
    <button class="btn" data-act="rclear">Clear</button><button class="btn" data-act="csv">Export CSV</button></div>
    <div class="card"><div id="rtot" style="margin-bottom:8px"></div><div class="table-wrap"><table><thead><tr><th>No</th><th>Date</th><th>Paid to</th><th class="r">Amount</th><th>By</th><th></th></tr></thead><tbody id="rbody"></tbody></table></div><div id="rmore"></div></div>`;
  regRows();
}
function regRows() {
  const list = filtered(), shown = list.slice(0, R.limit);
  $('#rtot').innerHTML = `Total: <b>${money(sum(list.filter(v => v.status === 'ACTIVE')))}</b> <span class="muted">(${list.length} vouchers)</span>`;
  $('#rbody').innerHTML = shown.map(v => `<tr class="${v.status === 'ACTIVE' ? '' : 'cx'}"><td class="nw"><b>${v.no}</b></td><td class="nw">${dmy(v.date)}</td>
    <td>${esc(v.vendor)}<div class="cat">${esc(v.category)}${v.notes ? ' · ' + esc(v.notes) : ''}${v.status !== 'ACTIVE' ? ` · <span class="badge bad">CANCELLED</span> ${esc(v.cancelReason)}` : ''}</div></td>
    <td class="r nw amt">${money(v.amount)}</td><td class="nw cat">${esc(nm(v.createdBy))}</td>
    <td class="r nw"><button class="btn sm" data-act="print" data-id="${v.id}">Print</button>
    ${v.receipts.length || (v.status === 'ACTIVE' && (can('receiptAny') || v.createdBy === S.me.email)) ? `<button class="btn sm" data-act="rec" data-id="${v.id}">📎${v.receipts.length || ''}</button>` : ''}
    ${v.status === 'ACTIVE' && can('edit') ? `<button class="btn sm" data-act="edit" data-id="${v.id}">Edit</button>` : ''}${v.status === 'ACTIVE' && can('cancel') ? `<button class="btn sm danger" data-act="cancel" data-id="${v.id}">Cancel</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No payments match.</td></tr>';
  $('#rmore').innerHTML = list.length > R.limit ? `<div class="actions"><button class="btn" data-act="more">Show more (${list.length - R.limit} left)</button></div>` : '';
}
$('#view').addEventListener('input', e => {
  const m = {rq: 'q', rv: 'vendor', rc: 'cat', ru: 'user', rfrom: 'from', rto: 'to', rs: 'st'}[e.target.id]; if (m && S.view === 'reg') { R[m] = e.target.value; R.limit = 100; regRows(); }
});
function csvExport() {
  const rows = [['No', 'Date', 'Vendor', 'Category', 'Notes', 'Amount', 'Status', 'CreatedBy', 'CreatedAt', 'Receipts']].concat(filtered().map(v => [v.no, dmy(v.date), v.vendor, v.category, v.notes, v.amount, v.status, nm(v.createdBy), v.createdAt, v.receipts.length]));
  download('vouchers-' + today() + '.csv', '﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n'), 'text/csv');
}
function editDlg(id) {
  const v = S.vouchers.find(x => x.id === id);
  dialog(`Edit #${v.no}`, `<label>Date<input type="date" id="ed" value="${v.date}" required></label><label>Paid to<input id="ev" list="vlist" value="${esc(v.vendor)}" required></label>${vendorList()}
    <label>Amount (₹)<input id="ea" inputmode="decimal" value="${v.amount}" required></label><label>Category<select id="ec">${catOpts(v.category)}</select></label><label>Note<input id="en" value="${esc(v.notes)}"></label>`,
    async () => { const u = await api('updateVoucher', {id, fields: {date: $('#ed').value, vendor: $('#ev').value, amount: parseAmt($('#ea').value), category: $('#ec').value, notes: $('#en').value}}); Object.assign(v, u); closeModal(); toast('Updated.', 'ok'); go(S.view); });
}
function cancelDlg(id) {
  const v = S.vouchers.find(x => x.id === id);
  dialog(`Cancel #${v.no}?`, `<p>${esc(v.vendor)} · <b>${money(v.amount)}</b></p><label>Reason (required)<input id="cr" required minlength="3" maxlength="200"></label>`,
    async () => { Object.assign(v, await api('cancelVoucher', {id, reason: $('#cr').value})); closeModal(); toast('Voucher cancelled.', 'ok'); go(S.view); }, 'Cancel voucher');
}
const rcache = {};
async function recDlg(id) {
  const v = S.vouchers.find(x => x.id === id), canAdd = v.status === 'ACTIVE' && v.receipts.length < 3 && (can('receiptAny') || v.createdBy === S.me.email);
  const f = dialog(`Receipts · #${v.no}`, `<div id="rimgs">${v.receipts.length ? '<p class="muted">Loading…</p>' : '<p class="muted">No receipts yet.</p>'}</div>${canAdd ? '<label class="btn" style="margin:0">📷 Add receipt<input type="file" id="radd" accept="image/*" hidden></label>' : ''}`);
  const draw = async () => {
    const box = $('#rimgs', f); if (!v.receipts.length) return; box.innerHTML = '';
    for (const fid of v.receipts) { try { rcache[fid] ||= (await api('getReceipt', {id, fileId: fid})).dataUrl; box.insertAdjacentHTML('beforeend', `<img class="rimg" src="${rcache[fid]}" alt="receipt">`); } catch (e) { box.insertAdjacentHTML('beforeend', `<p class="error">${esc(e.message)}</p>`); } }
  };
  draw();
  const add = $('#radd', f); if (add) add.onchange = async () => { try { const r = await compress(add.files[0]); Object.assign(v, await api('addReceipt', {id, receipt: {mime: r.mime, data: r.data}})); toast('Receipt added.', 'ok'); closeModal(); recDlg(id); } catch (e) { fail(e); } };
}

/* ---------------- print ---------------- */
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'], TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const b100 = n => n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : '');
const b1000 = n => (n >= 100 ? ONES[Math.floor(n / 100)] + ' Hundred' + (n % 100 ? ' ' : '') : '') + (n % 100 ? b100(n % 100) : '');
function words(n) { if (n === 0) return 'Zero'; const o = []; for (const [d, nme] of [[1e7, 'Crore'], [1e5, 'Lakh'], [1e3, 'Thousand']]) { const q = Math.floor(n / d); if (q) { o.push(words(q) + ' ' + nme); n %= d; } } if (n) o.push(b1000(n)); return o.join(' '); }
const amtWords = a => { const r = Math.floor(a), p = Math.round((a - r) * 100); return words(r) + ' Rupees' + (p ? ' and ' + words(p) + ' Paise' : '') + ' Only'; };
function printVoucher(id) {
  const v = S.vouchers.find(x => x.id === id); if (!v) return;
  $('#printArea').innerHTML = `<div class="pv"><div class="pv-head"><div class="pv-hotel">${esc(S.settings.propertyName)}</div><div class="pv-addr">${esc(S.settings.propertyAddress)}</div><div class="pv-title">CASH PAYMENT VOUCHER</div></div>
  <div class="pv-meta"><div>Voucher No: <b>${v.no}</b></div><div>Date: <b>${dmy(v.date)}</b></div></div>
  <div class="pv-row"><div class="l">Paid To</div><div class="v">${esc(v.vendor)}</div></div>
  ${v.category ? `<div class="pv-row"><div class="l">Category</div><div class="v">${esc(v.category)}${v.notes ? ' — ' + esc(v.notes) : ''}</div></div>` : ''}
  <div class="pv-row"><div class="l">Amount Paid</div><div class="v pv-amt">${money(v.amount)}</div></div>
  <div class="pv-words"><b>Amount in Words</b><br><br>${esc(amtWords(v.amount))}</div>${v.status !== 'ACTIVE' ? '<div class="pv-cx">*** CANCELLED ***</div>' : ''}
  <div class="pv-sign"><div>Prepared By</div><div>Paid By</div><div>Receiver Signature</div></div></div>`;
  setTimeout(() => window.print(), 50);
}

/* ---------------- bulk upload ---------------- */
let BU = [];
function vBulk() {
  BU = [];
  $('#view').innerHTML = head('Bulk Upload') + `<div class="card"><h2>1. Get your data in</h2>
    <p class="muted">Columns: <b>Date, Vendor, Amount</b>, optional <b>Category, Notes</b>. Dates like 25/12/2026 or 2026-12-25. Works with CSV, Excel (.xlsx) or paste straight from a spreadsheet.</p>
    <div class="actions"><button class="btn" data-act="tpl">⬇ Download template</button><label class="btn" style="margin:0">📁 Choose file<input type="file" id="bf" accept=".csv,.tsv,.txt,.xlsx,.xls" hidden></label></div>
    <label style="margin-top:12px">…or paste rows here<textarea id="bt" rows="5" placeholder="25/12/2026&#9;Ram Traders&#9;1500&#9;Kitchen&#9;vegetables"></textarea></label>
    <button class="btn primary" data-act="parse">Check data</button></div><div id="bprev"></div>`;
}
function parseDelim(text) {
  text = text.replace(/^﻿/, ''); const first = text.split(/\r?\n/)[0] || '', d = first.includes('\t') ? '\t' : (first.split(';').length > first.split(',').length ? ';' : ',');
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) { const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true; else if (c === d) { row.push(cell); cell = ''; } else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; } else cell += c; }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); } return rows.filter(r => r.some(c => String(c).trim() !== ''));
}
const MONTHS = {jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12};
function parseDate(v) {
  if (typeof v === 'number' && v > 20000 && v < 80000) { const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 864e5); return d.toISOString().slice(0, 10); }
  const s = String(v ?? '').trim(); let m;
  if ((m = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/))) return chk(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})/))) return chk(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[2], +m[1]);
  if ((m = s.match(/^(\d{1,2})[\s-]+([A-Za-z]{3})[a-z]*[\s,-]+(\d{2,4})/))) return chk(m[3].length === 2 ? 2000 + +m[3] : +m[3], MONTHS[m[2].toLowerCase()] || 0, +m[1]);
  return '';
}
function chk(y, mo, d) { const t = new Date(Date.UTC(y, mo - 1, d)); return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? `${y}-${pad(mo)}-${pad(d)}` : ''; }
function mapRows(rows) {
  const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z]/g, ''), h = rows[0].map(norm);
  const find = re => h.findIndex(x => re.test(x)); let ix = {date: find(/^date|voucherdate/), vendor: find(/vendor|paidto|payee|party|name/), amount: find(/amount|amt|rs|inr/), cat: find(/categor|head|type/), notes: find(/note|remark|desc|narration|particular/)};
  let body = rows.slice(1);
  if (ix.date < 0 || ix.vendor < 0 || ix.amount < 0) { ix = {date: 0, vendor: 1, amount: 2, cat: 3, notes: 4}; body = rows; }
  return body.map(r => ({date: r[ix.date], vendor: r[ix.vendor], amount: r[ix.amount], cat: ix.cat >= 0 ? r[ix.cat] : '', notes: ix.notes >= 0 ? r[ix.notes] : ''}));
}
function checkRows(raw) {
  const seen = new Set(active().map(v => `${v.date}|${v.vendor.toLowerCase()}|${v.amount}`)), cats = categories(), out = [];
  raw.forEach((r, i) => {
    const date = parseDate(r.date), vendor = String(r.vendor ?? '').trim(), amount = parseAmt(r.amount), cat = String(r.cat ?? '').trim(), errs = [], warns = [];
    if (!date) errs.push('bad date'); else if (date > addDays(today(), 1)) errs.push('future date');
    if (!vendor) errs.push('no vendor'); if (!(amount > 0) || amount > 1e7) errs.push('bad amount');
    let category = cats.find(c => c.toLowerCase() === cat.toLowerCase()); if (cat && !category) { warns.push('category → Other'); } category ||= 'Other';
    const key = `${date}|${vendor.toLowerCase()}|${amount}`, dup = !errs.length && seen.has(key); if (!errs.length) seen.add(key);
    out.push({n: i + 1, date, vendor, amount, category, notes: String(r.notes ?? '').trim(), errs, warns, dup, skip: dup});
  });
  return out;
}
function drawPreview() {
  const ok = BU.filter(r => !r.errs.length && !r.skip), bad = BU.filter(r => r.errs.length), dup = BU.filter(r => r.dup);
  $('#bprev').innerHTML = `<div class="card"><h2>2. Review</h2><p><b>${ok.length}</b> ready · <span class="${bad.length ? 'up' : ''}"><b>${bad.length}</b> with errors (skipped)</span> · <b>${dup.length}</b> possible duplicates ${dup.length ? '<label style="display:inline;margin-left:8px"><input type="checkbox" id="bdup" style="width:auto;min-height:0"> import duplicates too</label>' : ''}</p>
    <div class="table-wrap" style="max-height:340px;overflow:auto"><table><thead><tr><th>#</th><th>Date</th><th>Vendor</th><th class="r">Amount</th><th>Category</th><th>Status</th></tr></thead><tbody>${BU.slice(0, 300).map(r => `<tr><td>${r.n}</td><td class="nw">${r.date ? dmy(r.date) : '–'}</td><td>${esc(r.vendor)}</td><td class="r nw">${r.amount > 0 ? money(r.amount) : '–'}</td><td>${esc(r.category)}</td>
    <td class="nw">${r.errs.length ? `<span class="badge bad">${esc(r.errs.join(', '))}</span>` : r.dup ? '<span class="badge warn">duplicate?</span>' : r.warns.length ? `<span class="badge warn">${esc(r.warns[0])}</span>` : '<span class="badge">OK</span>'}</td></tr>`).join('')}</tbody></table></div>
    ${BU.length > 300 ? `<p class="muted">Showing first 300 of ${BU.length} rows.</p>` : ''}<div class="actions"><button class="btn primary" data-act="import" ${ok.length ? '' : 'disabled'}>Import ${ok.length} payments</button></div><p id="bprog" class="muted"></p></div>`;
}
$('#view').addEventListener('change', e => { if (e.target.id === 'bdup') { BU.forEach(r => { if (r.dup) r.skip = !e.target.checked; }); drawPreview(); $('#bdup').checked = e.target.checked; } });
function loadScript(src) { return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load the Excel reader (are you online?). Save as CSV instead.')); document.head.appendChild(s); }); }
async function parseInput() {
  const f = $('#bf').files[0]; let rows;
  if (f && /\.xlsx?$/i.test(f.name)) { if (!window.XLSX) await loadScript('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js'); const wb = XLSX.read(await f.arrayBuffer(), {type: 'array'}); rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], {header: 1, raw: true, defval: ''}).filter(r => r.some(c => String(c).trim() !== '')); }
  else rows = parseDelim(f ? await f.text() : $('#bt').value);
  if (!rows.length) throw new Error('Nothing to read — choose a file or paste some rows.');
  if (rows.length > 3001) throw new Error('Too many rows. Please upload up to 3,000 at a time.');
  BU = checkRows(mapRows(rows)); drawPreview();
}
async function runImport(btn) {
  const ok = BU.filter(r => !r.errs.length && !r.skip); if (!ok.length) return; let done = 0, skipped = 0;
  await busy(btn, async () => {
    try {
      for (let i = 0; i < ok.length; i += 100) {
        const chunk = ok.slice(i, i + 100).map(r => ({clientId: r.cid ||= uid(), date: r.date, vendor: r.vendor, amount: r.amount, category: r.category, notes: r.notes}));
        const d = await api('createVouchers', {bulk: true, entries: chunk}); done += d.created.length - d.skipped; skipped += d.skipped; d.created.forEach(c => { if (!S.vouchers.find(v => v.id === c.id)) S.vouchers.push(c); });
        $('#bprog').textContent = `Imported ${Math.min(i + 100, ok.length)} of ${ok.length}…`;
      }
      $('#bprev').innerHTML = `<div class="card ok-panel"><h2>✔ Imported ${done} payments</h2>${skipped ? `<p class="muted">${skipped} already existed and were skipped.</p>` : ''}<div class="actions"><button class="btn primary" data-act="goreg">Open register</button><button class="btn" data-act="bulkagain">Import more</button></div></div>`;
    } catch (e) { fail(e); $('#bprog').textContent = `Stopped after ${done} rows. Fix the problem and run "Check data" again — already imported rows will be skipped as duplicates.`; await refresh(true); }
  });
}

/* ---------------- vendors / users / settings / account ---------------- */
function vVend() {
  $('#view').innerHTML = head('Vendors') + `<form id="vf" class="card filters" autocomplete="off"><input type="hidden" id="vid"><input id="vn" placeholder="Vendor name" required><input id="vc" placeholder="Company (optional)"><input id="vm" placeholder="Mobile (optional)" inputmode="tel"><button class="btn primary">Save vendor</button><button type="button" class="btn" data-act="vclr">Clear</button></form>
  <div class="card"><div class="table-wrap"><table><thead><tr><th>Name</th><th>Company</th><th>Mobile</th><th>Status</th><th></th></tr></thead><tbody>${S.vendors.slice().sort((a, b) => a.name.localeCompare(b.name)).map(v => `<tr><td>${esc(v.name)}</td><td>${esc(v.company)}</td><td>${esc(v.mobile)}</td><td><span class="badge ${v.active ? '' : 'bad'}">${v.active ? 'ACTIVE' : 'INACTIVE'}</span></td><td class="r nw"><button class="btn sm" data-act="vedit" data-id="${v.id}">Edit</button> <button class="btn sm" data-act="vtog" data-id="${v.id}">${v.active ? 'Deactivate' : 'Activate'}</button></td></tr>`).join('') || '<tr><td colspan="5" class="muted">No vendors yet — vendors you pay are also remembered automatically.</td></tr>'}</tbody></table></div></div>`;
}
$('#view').addEventListener('submit', async e => {
  if (e.target.id !== 'vf') return; e.preventDefault();
  try { await api('saveVendor', {id: $('#vid').value || undefined, name: $('#vn').value, company: $('#vc').value, mobile: $('#vm').value}); await load(); toast('Vendor saved.', 'ok'); vVend(); } catch (er) { fail(er); }
});
async function vUsers() {
  $('#view').innerHTML = head('Users') + '<p class="muted">Loading…</p>';
  let users; try { users = await api('listUsers'); } catch (e) { return fail(e); }
  const roles = ['staff', 'manager', 'owner'];
  $('#view').innerHTML = head('Users') + `<div class="card"><h2>Add user</h2><form id="uf" class="filters" autocomplete="off"><input id="un" placeholder="Name" required><input id="ue" type="email" placeholder="Email" required><select id="ur">${roles.map(r => `<option>${r}</option>`).join('')}</select><input id="up" inputmode="numeric" maxlength="6" placeholder="Temporary 6-digit PIN" required><button class="btn primary">Add</button></form>
    <p class="muted"><b>Staff</b>: add payments + receipts, see own entries · <b>Manager</b>: also view all, edit, cancel, bulk upload, vendors · <b>Owner</b>: also users, settings, audit log.</p></div>
  <div class="card"><div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>${users.map(u => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td><select data-act="urole" data-id="${u.id}" style="min-height:34px;padding:4px">${roles.map(r => `<option${r === u.role ? ' selected' : ''}>${r}</option>`).join('')}</select></td><td><span class="badge ${u.active ? '' : 'bad'}">${u.active ? 'ACTIVE' : 'DISABLED'}</span></td>
    <td class="r nw"><button class="btn sm" data-act="upin" data-id="${u.id}">Reset PIN</button> <button class="btn sm ${u.active ? 'danger' : ''}" data-act="utog" data-id="${u.id}">${u.active ? 'Disable' : 'Enable'}</button></td></tr>`).join('')}</tbody></table></div></div>`;
  S._users = users;
}
$('#view').addEventListener('submit', async e => {
  if (e.target.id !== 'uf') return; e.preventDefault();
  try { await api('saveUser', {name: $('#un').value, email: $('#ue').value, role: $('#ur').value, pin: $('#up').value}); toast('User added. They must change the PIN at first login.', 'ok'); vUsers(); } catch (er) { fail(er); }
});
async function vSet() {
  $('#view').innerHTML = head('Settings') + `<form id="sf" class="card" autocomplete="off"><h2>Property</h2><label>Name<input id="sn" value="${esc(S.settings.propertyName)}" required></label><label>Address (printed on vouchers)<textarea id="sa" rows="2">${esc(S.settings.propertyAddress)}</textarea></label>
    <label>Categories (one per line)<textarea id="sc" rows="8">${esc(categories().join('\n'))}</textarea></label><label style="max-width:240px">Next voucher number<input id="sq" type="number" min="1" value="${S.settings.nextVoucherNo}"></label><button class="btn primary">Save settings</button></form>
    <div class="card"><h2>Audit log <span class="muted">(latest 200)</span></h2><div class="table-wrap" style="max-height:420px;overflow:auto"><table><thead><tr><th>When</th><th>User</th><th>Action</th><th>Details</th></tr></thead><tbody id="aud"><tr><td colspan="4" class="muted">Loading…</td></tr></tbody></table></div></div>`;
  try { const a = await api('auditLog'); $('#aud').innerHTML = a.map(r => `<tr><td class="nw">${esc(r.time.replace('T', ' '))}</td><td>${esc(r.user)}</td><td class="nw">${esc(r.action)}</td><td>${esc(r.target)} ${esc(r.details)}</td></tr>`).join(''); } catch (e) { fail(e); }
}
$('#view').addEventListener('submit', async e => {
  if (e.target.id !== 'sf') return; e.preventDefault();
  try { await api('saveSettings', {propertyName: $('#sn').value, propertyAddress: $('#sa').value, categories: $('#sc').value.split('\n'), nextVoucherNo: $('#sq').value}); await load(); $('#brand').textContent = S.settings.propertyName; toast('Settings saved.', 'ok'); vSet(); } catch (er) { fail(er); }
});
let deferredInstall;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; });
function vAcct() {
  $('#view').innerHTML = head('My Account') + `<div class="card"><h2>${esc(S.me.name)}</h2><p>${esc(S.me.email)} · <span class="badge">${esc(S.me.role)}</span></p><div class="actions">${deferredInstall ? '<button class="btn" data-act="install">📲 Install app</button>' : ''}<button class="btn danger" data-act="signout">Sign out</button></div>
    <p class="muted">Tip: on iPhone use Share → Add to Home Screen. On Android/Chrome use the menu → Install app.</p></div>
    <form id="pf" class="card" autocomplete="off"><h2>Change PIN</h2><div class="filters"><input id="po" type="password" inputmode="numeric" maxlength="6" placeholder="Current PIN" required><input id="pn" type="password" inputmode="numeric" maxlength="6" placeholder="New PIN" required><button class="btn primary">Change PIN</button></div></form>`;
}
$('#view').addEventListener('submit', async e => {
  if (e.target.id !== 'pf') return; e.preventDefault();
  try { const d = await api('changePin', {oldPin: $('#po').value, newPin: $('#pn').value}); S.token = d.token; ls.set('cv.token', d.token); e.target.reset(); toast('PIN changed.', 'ok'); } catch (er) { fail(er); }
});

/* ---------------- click router ---------------- */
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-act]'); if (!b || b.tagName === 'SELECT') return; const id = b.dataset.id, a = b.dataset.act;
  const acts = {
    refresh: () => refresh(), range: () => { D.r = b.dataset.k; vDash(); }, cus: () => { D.from = $('#dFrom').value; D.to = $('#dTo').value; if (!D.from || D.from > D.to) return toast('Pick a valid range.', 'err'); vDash(); },
    addrow: addRow, delrow: () => { if ($$('#rows .erow').length > 1) b.closest('.erow').remove(); }, clrrec: () => { const r = b.closest('.erow'); r._rec = []; $('.rp', r).innerHTML = ''; }, newagain: vNew,
    print: () => printVoucher(id), edit: () => editDlg(id), cancel: () => cancelDlg(id), rec: () => recDlg(id), more: () => { R.limit += 200; regRows(); },
    rclear: () => { Object.assign(R, {q: '', vendor: '', cat: '', user: '', from: '', to: '', st: 'ACTIVE', limit: 100}); vReg(); }, csv: csvExport,
    flush: flushOutbox, discard: () => { if (confirm('Discard all payments waiting to upload? This cannot be undone.')) { ls.del('cv.outbox'); showBanner(); } },
    tpl: () => download('voucher-template.csv', 'Date,Vendor,Amount,Category,Notes\r\n25/12/2026,Ram Traders,1500,Kitchen,Vegetables\r\n', 'text/csv'),
    parse: () => busy(b, () => parseInput().catch(fail)), import: () => runImport(b), goreg: () => go('reg'), bulkagain: vBulk,
    vclr: () => { $('#vf').reset(); $('#vid').value = ''; }, vedit: () => { const v = S.vendors.find(x => x.id === id); $('#vid').value = id; $('#vn').value = v.name; $('#vc').value = v.company; $('#vm').value = v.mobile; $('#vn').focus(); },
    vtog: async () => { try { await api('toggleVendor', {id}); await load(); vVend(); } catch (er) { fail(er); } },
    utog: async () => { const u = S._users.find(x => x.id === id); try { await api('saveUser', {id, name: u.name, email: u.email, role: u.role, active: !u.active}); vUsers(); } catch (er) { fail(er); } },
    upin: () => dialog('Reset PIN', '<p class="muted">Set a temporary PIN. The user must change it at next sign-in.</p><input id="tp" inputmode="numeric" maxlength="6" placeholder="Temporary 6-digit PIN" required>', async () => { await api('resetPin', {id, pin: $('#tp').value}); closeModal(); toast('PIN reset.', 'ok'); }, 'Reset'),
    install: async () => { if (deferredInstall) { deferredInstall.prompt(); deferredInstall = null; } }, signout: () => signOut()
  };
  if (acts[a]) acts[a]();
});
document.addEventListener('change', async e => {
  if (e.target.dataset.act !== 'urole') return; const u = S._users.find(x => x.id === e.target.dataset.id);
  try { await api('saveUser', {id: u.id, name: u.name, email: u.email, role: e.target.value, active: u.active}); toast('Role updated.', 'ok'); vUsers(); } catch (er) { fail(er); vUsers(); }
});

/* ---------------- init ---------------- */
function init() {
  S.url = (window.CV_CONFIG && CV_CONFIG.API_URL) || ls.get('cv.url') || ''; S.token = ls.get('cv.token') || '';
  if (location.protocol.startsWith('http') && 'serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  showBanner(); if (S.token && S.url) { $('#login').classList.add('hidden'); start(); } else showLogin();
}
init();
})();
