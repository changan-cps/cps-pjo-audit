/**
 * Store: all Google Sheets / Drive access lives here.
 * Each table is a sheet with a header row. Large JSON documents (templates, audits,
 * issues) are kept in the "Blobs" sheet, split into chunks below the 50,000-char cell limit.
 * Every write happens inside withLock() so two people saving at once never overwrite each other.
 */
var DB_PROP = 'PJO_DB_ID';
var FOLDER_PROP = 'PJO_FOLDER_ID';
var CHUNK = 40000;

var TABLES = {
  Workshops: ['code', 'name', 'active'],
  Teams: ['id', 'workshop', 'group', 'name', 'line', 'active'],
  Employees: ['code', 'name', 'workshop', 'team_id', 'username', 'active'],
  Users: ['username', 'name', 'salt', 'pin_hash', 'roles', 'active', 'created_at', 'must_change_pin'],
  Templates: ['id', 'workshop', 'version', 'status', 'source_sha', 'change_note', 'created_at', 'published_at', 'retired_at', 'created_by'],
  Audits: ['id', 'audit_no', 'workshop', 'template_id', 'status', 'revision', 'audit_date', 'shift', 'team_id', 'station', 'model',
           'employee_code', 'employee_name', 'auditor', 'plan_id', 'open_issues', 'recert_pending', 'missing_signatures', 'created_at', 'updated_at', 'completed_at', 'submitted_at'],
  Issues: ['id', 'issue_no', 'audit_id', 'workshop', 'team_id', 'station', 'sheet', 'item_code', 'issue_type', 'title', 'owner', 'owner_name',
           'due_date', 'status', 'occurrences', 'created_at', 'closed_at', 'audit_ids'],
  Plans: ['id', 'workshop', 'team_id', 'station', 'employee_code', 'planned_date', 'auditor', 'note', 'cancelled', 'created_by', 'created_at',
          'team_name', 'employee_name', 'level', 'problems', 'batch_id', 'source', 'history', 'updated_at'],
  Pending: ['code', 'title', 'detail', 'workshops', 'sources', 'status', 'resolution', 'resolved_by', 'resolved_at'],
  Settings: ['key', 'value', 'updated_by', 'updated_at'],
  Counters: ['name', 'value'],
  Trail: ['at', 'user', 'action', 'audit_id', 'issue_id', 'data'],
  Blobs: ['key', 'part', 'text']
};

function db_() {
  var id = PropertiesService.getScriptProperties().getProperty(DB_PROP);
  if (!id) throw new RuleError('ยังไม่ได้ติดตั้งระบบ ให้ผู้ดูแลรันฟังก์ชัน setup ก่อน', 'not_setup');
  if (!db_._cache) db_._cache = SpreadsheetApp.openById(id);
  return db_._cache;
}

function sheet_(name) {
  db_._sheets = db_._sheets || {};
  if (!db_._sheets[name]) {
    var sh = db_().getSheetByName(name);
    if (!sh) throw new Error('missing sheet ' + name);
    db_._sheets[name] = sh;
  }
  return db_._sheets[name];
}

/** Rewrites the header row when a table gained columns since setup (data columns are positional). */
function ensureHeader_(name) {
  var sh = sheet_(name), cols = TABLES[name];
  var cur = sh.getRange(1, 1, 1, cols.length).getValues()[0];
  if (cur.join('|') !== cols.join('|')) {
    sh.getRange(1, 1, Math.max(sh.getMaxRows(), 2), cols.length).setNumberFormat('@');
    sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
  }
}

function createTables_(ss) {
  Object.keys(TABLES).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    var cols = TABLES[name];
    sh.getRange(1, 1, Math.max(sh.getMaxRows(), 2), Math.max(cols.length, sh.getMaxColumns())).setNumberFormat('@');
    sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
    sh.setFrozenRows(1);
  });
  var first = ss.getSheetByName('Sheet1') || ss.getSheetByName('แผ่น1');
  if (first && ss.getSheets().length > 1) ss.deleteSheet(first);
}

function withLock(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new RuleError('ระบบกำลังบันทึกข้อมูลของผู้อื่น กรุณาลองอีกครั้ง', 'busy');
  try { return fn(); } finally { lock.releaseLock(); }
}

// ---------- cell safety: a value starting with = + - @ would become a formula
function cell_(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') v = JSON.stringify(v);
  v = String(v);
  return /^[=+\-@]/.test(v) ? ' ' + v : v;
}

// ---------- rows
function rows_(name) {
  db_._rows = db_._rows || {};
  if (db_._rows[name]) return db_._rows[name];
  var sh = sheet_(name), cols = TABLES[name];
  var n = sh.getLastRow() - 1;
  if (n < 1) return [];
  var vals = sh.getRange(2, 1, n, cols.length).getValues();
  var out = [];
  for (var i = 0; i < vals.length; i++) {
    if (vals[i][0] === '' || vals[i][0] === null) continue;
    var o = { _row: i + 2 };
    for (var c = 0; c < cols.length; c++) o[cols[c]] = vals[i][c] === null ? '' : String(vals[i][c]);
    out.push(o);
  }
  db_._rows[name] = out;
  return out;
}
function invalidate_(name) { if (db_._rows) delete db_._rows[name]; }

function find_(name, key, value) {
  var all = rows_(name);
  for (var i = 0; i < all.length; i++) if (all[i][key] === String(value)) return all[i];
  return null;
}

function insert_(name, obj) {
  var cols = TABLES[name];
  sheet_(name).appendRow(cols.map(function (c) { return cell_(obj[c]); }));
  invalidate_(name);
}

function update_(name, row, obj) {
  var cols = TABLES[name];
  sheet_(name).getRange(row._row, 1, 1, cols.length).setValues([cols.map(function (c) {
    return cell_(c in obj ? obj[c] : row[c]);
  })]);
  invalidate_(name);
}

function upsert_(name, key, obj) {
  var row = find_(name, key, obj[key]);
  if (row) update_(name, row, obj); else insert_(name, obj);
}

// ---------- JSON blobs (chunked)
function blobGet(key) {
  var cache = CacheService.getScriptCache();
  var hit = null;
  try { hit = cache.get('b:' + key); } catch (e) { hit = null; }
  if (hit) return JSON.parse(hit);
  var sh = sheet_('Blobs');
  var n = sh.getLastRow() - 1;
  if (n < 1) return null;
  var found = sh.getRange(2, 1, n, 1).createTextFinder(key).matchEntireCell(true).findAll();
  if (!found.length) return null;
  var parts = found.map(function (r) {
    var v = sh.getRange(r.getRow(), 1, 1, 3).getValues()[0];
    return { part: Number(v[1]), text: String(v[2]) };
  }).filter(function (p) { return p.text !== ''; }).sort(function (a, b) { return a.part - b.part; });
  if (!parts.length) return null;
  var json = parts.map(function (p) { return p.text.slice(1); }).join('');
  if (json.length < 90000) { try { cache.put('b:' + key, json, 600); } catch (e) { /* too large to cache */ } }
  return JSON.parse(json);
}

function blobPut(key, obj) {
  var json = JSON.stringify(obj);
  var chunks = [];
  for (var i = 0; i < json.length; i += CHUNK) chunks.push('J' + json.slice(i, i + CHUNK));
  var sh = sheet_('Blobs');
  var n = sh.getLastRow() - 1;
  var rowsFound = n < 1 ? [] : sh.getRange(2, 1, n, 1).createTextFinder(key).matchEntireCell(true).findAll().map(function (r) { return r.getRow(); });
  rowsFound.sort(function (a, b) { return a - b; });
  for (var j = 0; j < Math.max(chunks.length, rowsFound.length); j++) {
    if (j < rowsFound.length) sh.getRange(rowsFound[j], 1, 1, 3).setValues([[key, String(j), j < chunks.length ? chunks[j] : '']]);
    else sh.appendRow([key, String(j), chunks[j]]);
  }
  try { CacheService.getScriptCache().remove('b:' + key); } catch (e) { /* ignore */ }
}

// ---------- ids, settings, trail
function nextNumber_(name) {
  var row = find_('Counters', 'name', name);
  var v = row ? Number(row.value) + 1 : 1;
  if (row) update_('Counters', row, { value: String(v) }); else insert_('Counters', { name: name, value: String(v) });
  return v;
}
function pad5_(n) { return ('00000' + n).slice(-5); }

function settingGet(key) {
  var r = find_('Settings', 'key', key);
  return r && r.value ? JSON.parse(r.value) : null;
}
function settingPut(key, value, user) {
  upsert_('Settings', 'key', { key: key, value: JSON.stringify(value), updated_by: user || '', updated_at: nowIso() });
}

function trail(user, action, auditId, issueId, data) {
  insert_('Trail', { at: nowIso(), user: user ? user.username : '', action: action, audit_id: auditId || '', issue_id: issueId || '',
                     data: JSON.stringify(data || {}).slice(0, 45000) });
}

// ---------- Drive (private files)
function folder_() {
  var id = PropertiesService.getScriptProperties().getProperty(FOLDER_PROP);
  return DriveApp.getFolderById(id);
}
function saveFile_(name, mime, base64) {
  var bytes = Utilities.base64Decode(base64);
  var blob = Utilities.newBlob(bytes, mime, name);
  var f = folder_().createFile(blob);
  var sha = hexDigest_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes));
  return { id: f.getId(), size: bytes.length, sha256: sha };
}
function readFileDataUrl_(id) {
  var f = DriveApp.getFileById(id);
  var b = f.getBlob();
  return 'data:' + b.getContentType() + ';base64,' + Utilities.base64Encode(b.getBytes());
}

// ---------- helpers
function nowIso() { return new Date().toISOString(); }
function todayBkk() { return Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd'); }
function hexDigest_(bytes) {
  return bytes.map(function (b) { var v = (b < 0 ? b + 256 : b).toString(16); return v.length === 1 ? '0' + v : v; }).join('');
}
function sha256_(text) {
  return hexDigest_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8));
}
function canonical_(o) {
  if (o === null || typeof o !== 'object') return JSON.stringify(o);
  if (Array.isArray(o)) return '[' + o.map(canonical_).join(',') + ']';
  return '{' + Object.keys(o).sort().map(function (k) { return JSON.stringify(k) + ':' + canonical_(o[k]); }).join(',') + '}';
}
function uuid_() { return Utilities.getUuid(); }

function RuleError(message, code, extra) {
  this.name = 'RuleError';
  this.message = message;
  this.code = code || 'rule';
  this.extra = extra || {};
}
RuleError.prototype = Object.create(Error.prototype);

function Forbidden(message) {
  this.name = 'Forbidden';
  this.message = message || 'ไม่มีสิทธิ์ดำเนินการนี้';
}
Forbidden.prototype = Object.create(Error.prototype);
