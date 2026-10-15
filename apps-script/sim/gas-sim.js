/**
 * Minimal Google Apps Script simulator for local testing.
 * Loads every .gs file of the project into one V8 context with in-memory versions of
 * SpreadsheetApp, DriveApp, PropertiesService, CacheService, LockService, Utilities and
 * HtmlService — only the methods this project uses. Each call starts a fresh "execution"
 * (module-level caches cleared), like a real Apps Script request.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

function toSigned(buf) { return Array.from(buf, b => (b > 127 ? b - 256 : b)); }
function toBuf(bytes) { return Buffer.from(bytes.map(b => (b < 0 ? b + 256 : b))); }

class Range {
  constructor(sheet, r, c, nr, nc) { Object.assign(this, { sheet, r, c, nr: nr || 1, nc: nc || 1 }); }
  getRow() { return this.r; }
  setNumberFormat() { return this; }
  setFontWeight() { return this; }
  getValues() {
    const out = [];
    for (let i = 0; i < this.nr; i++) {
      const row = this.sheet.data[this.r - 1 + i] || [];
      const vals = [];
      for (let j = 0; j < this.nc; j++) vals.push(row[this.c - 1 + j] === undefined ? '' : row[this.c - 1 + j]);
      out.push(vals);
    }
    return out;
  }
  setValues(vals) {
    if (vals.length !== this.nr || vals[0].length !== this.nc) throw new Error('setValues dimension mismatch');
    for (let i = 0; i < this.nr; i++) {
      const idx = this.r - 1 + i;
      while (this.sheet.data.length <= idx) this.sheet.data.push([]);
      for (let j = 0; j < this.nc; j++) this.sheet.data[idx][this.c - 1 + j] = cellIn(vals[i][j]);
    }
    return this;
  }
  createTextFinder(text) {
    const self = this;
    let whole = false;
    return {
      matchEntireCell(b) { whole = b; return this; },
      findAll() {
        const hits = [];
        const vals = self.getValues();
        vals.forEach((row, i) => row.forEach((v, j) => {
          const s = String(v);
          if (whole ? s === text : s.indexOf(text) >= 0) hits.push(new Range(self.sheet, self.r + i, self.c + j, 1, 1));
        }));
        return hits;
      },
    };
  }
}

function cellIn(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s.length > 50000) throw new Error('Your input contains more than the maximum of 50000 characters in a single cell.');
  if (/^=/.test(s)) throw new Error('simulator: value would be stored as a formula: ' + s.slice(0, 30));
  return s;
}

class Sheet {
  constructor(name) { this.name = name; this.data = []; }
  getName() { return this.name; }
  getMaxRows() { return Math.max(1000, this.data.length); }
  getMaxColumns() { return 26; }
  getLastRow() {
    for (let i = this.data.length - 1; i >= 0; i--) if ((this.data[i] || []).some(v => v !== '' && v !== undefined)) return i + 1;
    return 0;
  }
  getRange(r, c, nr, nc) { return new Range(this, r, c, nr, nc); }
  appendRow(vals) { this.data.splice(this.getLastRow(), 0, vals.map(cellIn)); return this; }
  setFrozenRows() { return this; }
}

class Spreadsheet {
  constructor(id, name) { this.id = id; this.name = name; this.sheets = [new Sheet('Sheet1')]; }
  getId() { return this.id; }
  getUrl() { return 'https://docs.google.com/spreadsheets/d/' + this.id; }
  getSheetByName(n) { return this.sheets.find(s => s.name === n) || null; }
  insertSheet(n) { const s = new Sheet(n); this.sheets.push(s); return s; }
  getSheets() { return this.sheets.slice(); }
  deleteSheet(s) { this.sheets = this.sheets.filter(x => x !== s); }
}

function createSim(srcDir, opts) {
  opts = opts || {};
  const store = { spreadsheets: {}, props: {}, cache: {}, files: {}, folders: {}, calls: 0 };
  let clockOffset = 0;
  const now = () => Date.now() + clockOffset;

  const services = {
    SpreadsheetApp: {
      create(name) { const id = 'ss' + crypto.randomBytes(6).toString('hex'); store.spreadsheets[id] = new Spreadsheet(id, name); return store.spreadsheets[id]; },
      openById(id) { if (!store.spreadsheets[id]) throw new Error('no spreadsheet ' + id); return store.spreadsheets[id]; },
    },
    PropertiesService: {
      getScriptProperties() {
        return { getProperty: k => (k in store.props ? store.props[k] : null), setProperty: (k, v) => { store.props[k] = String(v); } };
      },
    },
    CacheService: {
      getScriptCache() {
        return {
          get(k) { const e = store.cache[k]; if (!e || e.exp < now()) return null; return e.v; },
          put(k, v, sec) {
            if (String(v).length > 100 * 1024) throw new Error('Argument too large: value');
            store.cache[k] = { v: String(v), exp: now() + (sec || 600) * 1000 };
          },
          remove(k) { delete store.cache[k]; },
        };
      },
    },
    LockService: { getScriptLock() { return { tryLock: () => true, releaseLock: () => {} }; } },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' },
      computeDigest(alg, value) {
        const h = crypto.createHash(alg);
        h.update(typeof value === 'string' ? Buffer.from(value, 'utf8') : toBuf(value));
        return toSigned(h.digest());
      },
      base64Decode: s => toSigned(Buffer.from(s, 'base64')),
      base64Encode: bytes => toBuf(bytes).toString('base64'),
      newBlob: (bytes, mime, name) => ({ bytes, mime, name }),
      formatDate(d, tz, fmt) {
        const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(d).map(p => [p.type, p.value]));
        return fmt.replace('yyyy', parts.year).replace('MM', parts.month).replace('dd', parts.day)
          .replace('HH', parts.hour).replace('mm', parts.minute).replace('ss', parts.second);
      },
    },
    DriveApp: {
      createFolder(name) { const id = 'fd' + crypto.randomBytes(4).toString('hex'); store.folders[id] = name; return { getId: () => id }; },
      getFolderById(id) {
        return { createFile(blob) { const fid = 'fl' + crypto.randomBytes(6).toString('hex'); store.files[fid] = blob; return { getId: () => fid }; } };
      },
      getFileById(id) {
        const b = store.files[id];
        if (!b) throw new Error('no file');
        return { getBlob: () => ({ getContentType: () => b.mime, getBytes: () => b.bytes }) };
      },
    },
    Logger: { log: (...a) => { if (opts.verbose) console.log(...a); } },
    console: { log: (...a) => opts.verbose && console.log(...a), error: (...a) => opts.quietErrors || console.error(...a), warn: () => {} },
  };

  const ctx = vm.createContext(Object.assign({}, services));
  const htmlFiles = {};
  for (const f of fs.readdirSync(srcDir).sort()) {
    const p = path.join(srcDir, f);
    if (f.endsWith('.gs')) vm.runInContext(fs.readFileSync(p, 'utf8'), ctx, { filename: f });
    else if (f.endsWith('.html')) htmlFiles[f.replace(/\.html$/, '')] = fs.readFileSync(p, 'utf8');
  }
  // HtmlService: only the subset used by doGet/include
  ctx.HtmlService = {
    XFrameOptionsMode: { DEFAULT: 'DEFAULT', ALLOWALL: 'ALLOWALL' },
    createHtmlOutputFromFile(name) { return { getContent: () => htmlFiles[name] }; },
    createTemplateFromFile(name) {
      return {
        evaluate() {
          const html = htmlFiles[name].replace(/<\?!=\s*include\('([^']+)'\)\s*\?>/g, (_, n) => htmlFiles[n]);
          const out = { content: html, getContent: () => html, setTitle: () => out, addMetaTag: () => out, setXFrameOptionsMode: () => out };
          return out;
        },
      };
    },
  };

  function freshExecution() {
    vm.runInContext('if (typeof db_ !== "undefined") { db_._cache = null; db_._sheets = null; db_._rows = null; }', ctx);
  }

  return {
    ctx, store,
    call(fnName, ...args) {
      store.calls++;
      freshExecution();
      return ctx[fnName](...args);
    },
    api(name, token, payload) {
      const s = this.call('api', name, token, JSON.parse(JSON.stringify(payload || {})));
      return JSON.parse(s);
    },
    page() { freshExecution(); return ctx.doGet().getContent(); },
    advanceClock(ms) { clockOffset += ms; },
  };
}

module.exports = { createSim };
