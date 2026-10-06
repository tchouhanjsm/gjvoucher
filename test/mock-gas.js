// Minimal in-memory mock of the Apps Script services used by backend/Code.gs
const fs = require('fs'), vm = require('vm'), crypto = require('crypto'), path = require('path');
function create() {
  const sheets = {}, propsStore = {}, cacheStore = {}, files = {};
  const mkSheet = name => {
    const rows = [];
    const rng = (r, c, nr, nc) => ({
      getValues: () => Array.from({length: nr}, (_, i) => Array.from({length: nc}, (_, j) => (rows[r - 1 + i] || [])[c - 1 + j] ?? '')),
      setValues: v => v.forEach((row, i) => row.forEach((val, j) => { (rows[r - 1 + i] ||= [])[c - 1 + j] = val; })),
      setNumberFormat() { return this; }
    });
    return {name, getLastRow: () => rows.length, getDataRange: () => ({getValues: () => rows.map(r => r.slice())}),
      getRange: (a, b, c, d) => typeof a === 'string' ? {setNumberFormat() { return this; }} : rng(a, b, c, d)};
  };
  const ss = {getId: () => 'SS1', getSheetByName: n => sheets[n] || null, insertSheet: n => (sheets[n] = mkSheet(n))};
  const ctx = {
    console, JSON, Date, Math, Object, Array, String, Number, isFinite, isNaN, RegExp, Error, parseInt,
    SpreadsheetApp: {getActiveSpreadsheet: () => ss, openById: () => ss},
    PropertiesService: {getScriptProperties: () => ({getProperty: k => propsStore[k] ?? null, setProperty: (k, v) => propsStore[k] = String(v), deleteProperty: k => delete propsStore[k]})},
    CacheService: {getScriptCache: () => ({get: k => cacheStore[k] ?? null, put: (k, v) => cacheStore[k] = v, remove: k => delete cacheStore[k]})},
    LockService: {getScriptLock: () => ({waitLock() {}, releaseLock() {}})},
    ContentService: {MimeType: {JSON: 'json'}, createTextOutput: t => ({t, setMimeType() { return this; }, getContent() { return t; }})},
    DriveApp: {createFolder: () => ({getId: () => 'FOLDER'}),
      getFolderById: () => ({createFile: b => { const id = 'F' + Object.keys(files).length; files[id] = b; return {getId: () => id}; }}),
      getFileById: id => ({getBlob: () => ({getContentType: () => files[id].mime, getBytes: () => files[id].bytes})})},
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      computeHmacSha256Signature: (m, k) => [...crypto.createHmac('sha256', k).update(m).digest()].map(b => b > 127 ? b - 256 : b),
      base64Decode: s => [...Buffer.from(s, 'base64')], base64Encode: b => Buffer.from(b).toString('base64'),
      newBlob: (bytes, mime, name) => ({bytes, mime, name}),
      formatDate: (d, tz, fmt) => {
        const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'}).formatToParts(d).map(x => [x.type, x.value]));
        return fmt.startsWith('yyyy-MM-dd\'T') ? `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}` : `${p.year}-${p.month}-${p.day}`;
      }
    },
    Logger: {log() {}}
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../backend/Code.gs'), 'utf8') + '\n;this.__api={setup,doPost,PERMS};', ctx);
  return {
    props: propsStore, files, cache: cacheStore, sheets,
    setup: () => ctx.__api.setup(),
    call: (action, payload = {}) => JSON.parse(ctx.__api.doPost({postData: {contents: JSON.stringify({action, ...payload})}}).getContent())
  };
}
module.exports = {create};
