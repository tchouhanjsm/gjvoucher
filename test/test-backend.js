const {create} = require('./mock-gas'); const assert = require('assert');
const g = create(); let n = 0; const ok = (c, m) => { assert(c, m); n++; };
g.props.OWNER_EMAIL = 'Owner@Test.com'; g.props.OWNER_PIN = '483921'; g.setup(); g.setup(); // idempotent
ok(!g.props.OWNER_PIN, 'owner PIN property removed after setup');
// login
ok(!g.call('login', {email: 'owner@test.com', pin: '000000'}).ok, 'wrong pin rejected');
let r = g.call('login', {email: 'OWNER@test.com', pin: '483921'}); ok(r.ok && r.data.user.role === 'owner', 'owner login');
const as = (t, a, p) => g.call(a, {token: t, ...p});
ok(as(r.data.token, 'bootstrap').code === 'PIN_CHANGE', 'owner must change setup PIN');
let T = as(r.data.token, 'changePin', {oldPin: '483921', newPin: '579246'}).data.token;
ok(g.call('bootstrap').error && g.call('bootstrap').code === 'SESSION', 'no token => session error');
// create users
ok(!as(T, 'saveUser', {name: 'Bad', email: 'a@b.com', role: 'staff', pin: '111111'}).ok, 'weak PIN rejected');
ok(as(T, 'saveUser', {name: 'Mona Manager', email: 'm@test.com', role: 'manager', pin: '246810'}).ok, 'manager created');
ok(as(T, 'saveUser', {name: 'Sam Staff', email: 's@test.com', role: 'staff', pin: '135790'}).ok, 'staff created');
ok(!as(T, 'saveUser', {name: 'X', email: 'M@test.com', role: 'staff', pin: '135791'}).ok, 'dup email rejected');
// forced PIN change
const M0 = g.call('login', {email: 'm@test.com', pin: '246810'}).data.token;
ok(as(M0, 'bootstrap').code === 'PIN_CHANGE', 'must change pin first');
const cp = as(M0, 'changePin', {oldPin: '246810', newPin: '864209'}); ok(cp.ok, 'pin changed');
ok(as(M0, 'bootstrap').code === 'SESSION', 'old token invalid after pin change');
const M = cp.data.token; ok(as(M, 'bootstrap').ok, 'new token works');
const S0 = g.call('login', {email: 's@test.com', pin: '135790'}).data.token; const S = as(S0, 'changePin', {oldPin: '135790', newPin: '975310'}).data.token;
// create vouchers
const today = new Date().toISOString().slice(0, 10);
const tiny = Buffer.from('fakejpeg').toString('base64');
r = as(S, 'createVouchers', {entries: [{clientId: 'c1', date: today, vendor: '=HYPERLINK("x")', amount: '150.555', category: 'Fuel', receipts: [{mime: 'image/jpeg', data: tiny}]}, {clientId: 'c2', date: today, vendor: 'Ram Traders', amount: 2000}]});
ok(r.ok && r.data.created.length === 2 && r.data.created[0].no === 201 && r.data.created[1].no === 202, 'numbers from 201');
ok(r.data.created[0].vendor.startsWith("'="), 'formula injection neutralised');
ok(r.data.created[0].amount === 150.56 || r.data.created[0].amount === 150.55, 'amount rounded to 2dp');
ok(r.data.created[0].receipts.length === 1, 'receipt stored');
const dup = as(S, 'createVouchers', {entries: [{clientId: 'c1', date: today, vendor: 'x', amount: 1}]}); ok(dup.data.skipped === 1 && dup.data.created[0].no === 201, 'idempotent by clientId');
ok(!as(S, 'createVouchers', {entries: [{date: '2999-01-01', vendor: 'x', amount: 1}]}).ok, 'future date rejected');
ok(!as(S, 'createVouchers', {entries: [{date: today, vendor: 'x', amount: -5}]}).ok, 'negative amount rejected');
ok(!as(S, 'createVouchers', {bulk: true, entries: [{date: today, vendor: 'x', amount: 5}]}).ok, 'staff cannot bulk');
ok(!as(S, 'createVouchers', {entries: [{date: today, vendor: 'x', amount: 5, receipts: [{mime: 'text/html', data: tiny}]}]}).ok, 'non-image receipt rejected');
// RBAC
const id1 = r.data.created[0].id;
ok(!as(S, 'updateVoucher', {id: id1, fields: {amount: 1}}).ok, 'staff cannot edit');
ok(!as(S, 'cancelVoucher', {id: id1, reason: 'test'}).ok, 'staff cannot cancel');
ok(!as(S, 'listUsers').ok && !as(S, 'auditLog').ok && !as(M, 'listUsers').ok, 'non-owners blocked from admin');
ok(as(S, 'bootstrap').data.vouchers.length === 2, 'staff sees own');
const mv = as(M, 'createVouchers', {bulk: true, entries: Array.from({length: 50}, (_, i) => ({date: today, vendor: 'V' + (i % 5), amount: 10 + i, category: 'Other'}))});
ok(mv.ok && mv.data.created.length === 50 && mv.data.created[49].no === 252, 'manager bulk 50');
ok(as(S, 'bootstrap').data.vouchers.length === 2, 'staff still sees only own after bulk');
ok(as(M, 'bootstrap').data.vouchers.length === 52, 'manager sees all');
ok(as(M, 'updateVoucher', {id: id1, fields: {amount: 175}}).data.amount === 175, 'manager edit');
ok(!as(M, 'cancelVoucher', {id: id1, reason: ''}).ok, 'cancel needs reason');
ok(as(M, 'cancelVoucher', {id: id1, reason: 'Duplicate entry'}).data.status === 'CANCELLED', 'manager cancel');
ok(!as(M, 'updateVoucher', {id: id1, fields: {amount: 2}}).ok, 'cancelled not editable');
// receipts
const id2 = r.data.created[1].id;
ok(as(S, 'addReceipt', {id: id2, receipt: {mime: 'image/png', data: tiny}}).data.receipts.length === 1, 'staff adds receipt to own');
ok(!as(S, 'addReceipt', {id: mv.data.created[0].id, receipt: {mime: 'image/png', data: tiny}}).ok, "staff cannot add to others'");
const fid = as(S, 'bootstrap').data.vouchers.find(v => v.id === id2).receipts[0];
ok(as(S, 'getReceipt', {id: id2, fileId: fid}).data.dataUrl.startsWith('data:image/png;base64,'), 'own receipt readable');
ok(!as(S, 'getReceipt', {id: mv.data.created[0].id, fileId: fid}).ok, "cannot read others' receipt");
// vendors + settings
ok(as(M, 'saveVendor', {name: 'Ram Traders', mobile: '9999999999'}).ok && !as(M, 'saveVendor', {name: 'ram traders'}).ok, 'vendor unique');
ok(!as(M, 'saveSettings', {}).ok, 'manager cannot change settings');
ok(!as(T, 'saveSettings', {propertyName: 'P', categories: ['A'], nextVoucherNo: 100}).ok, 'next no must exceed max');
ok(as(T, 'saveSettings', {propertyName: 'Hotel X', propertyAddress: 'Addr', categories: ['A', 'B'], nextVoucherNo: 300}).ok, 'owner settings');
ok(as(T, 'bootstrap').data.settings.categories.includes('Other'), 'Other auto-added');
// last owner guard
const me = as(T, 'listUsers').data.find(u => u.role === 'owner');
ok(!as(T, 'saveUser', {id: me.id, name: 'Owner', email: 'owner@test.com', role: 'manager'}).ok, 'cannot demote last owner');
// disable user kills session
const sm = as(T, 'listUsers').data.find(u => u.email === 's@test.com');
ok(as(T, 'saveUser', {id: sm.id, name: sm.name, email: sm.email, role: 'staff', active: false}).ok, 'disable staff');
ok(as(S, 'bootstrap').code === 'SESSION', 'disabled user session dead');
ok(as(T, 'auditLog').data.length > 10, 'audit log written');
// lockout
for (let i = 0; i < 5; i++) g.call('login', {email: 'm@test.com', pin: '000000'});
ok(g.call('login', {email: 'm@test.com', pin: '864209'}).code === 'LOCKED', 'lockout after 5 fails');
ok(as(T, 'resetPin', {id: as(T, 'listUsers').data.find(u => u.email === 'm@test.com').id, pin: '314159'}).ok && g.call('login', {email: 'm@test.com', pin: '314159'}).ok, 'owner reset pin clears lock');
console.log(`backend OK — ${n} checks passed`);
