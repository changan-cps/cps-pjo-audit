// ===== Store.gs =====
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
           'employee_code', 'employee_name', 'auditor', 'plan_id', 'open_issues', 'recert_pending', 'missing_signatures', 'created_at', 'updated_at', 'completed_at'],
  Issues: ['id', 'issue_no', 'audit_id', 'workshop', 'team_id', 'station', 'sheet', 'item_code', 'issue_type', 'title', 'owner', 'owner_name',
           'due_date', 'status', 'occurrences', 'created_at', 'closed_at', 'audit_ids'],
  Plans: ['id', 'workshop', 'team_id', 'station', 'employee_code', 'planned_date', 'auditor', 'note', 'cancelled', 'created_by', 'created_at'],
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

// ===== Auth.gs =====
/**
 * Login with username + PIN (works for staff without company Google accounts).
 * Sessions live in the script cache (sliding 6 hours). Permissions mirror the Django version:
 * roles are granted per workshop, or for ALL workshops.
 */
var ROLES = ['admin', 'auditor', 'tlgl', 'employee', 'issue_owner', 'verifier', 'viewer'];
var STAFF_ROLES = ['auditor', 'tlgl', 'viewer', 'verifier', 'issue_owner'];
var SESSION_SECONDS = 6 * 60 * 60;

function hashPin_(salt, pin) { return sha256_(salt + ':' + pin); }

function login_(username, pin) {
  username = String(username || '').trim().toLowerCase();
  var cache = CacheService.getScriptCache();
  var failKey = 'fail:' + username;
  var fails = Number(cache.get(failKey) || 0);
  if (fails >= 5) throw new RuleError('ใส่ PIN ผิดหลายครั้ง กรุณารอ 15 นาที', 'locked_out');
  var u = find_('Users', 'username', username);
  if (!u || u.active === 'false' || hashPin_(u.salt, String(pin || '')) !== u.pin_hash) {
    cache.put(failKey, String(fails + 1), 900);
    throw new RuleError('ชื่อผู้ใช้หรือ PIN ไม่ถูกต้อง', 'bad_login');
  }
  cache.remove(failKey);
  var token = uuid_() + uuid_().slice(0, 8);
  cache.put('s:' + token, username, SESSION_SECONDS);
  trail({ username: username }, 'login', '', '', {});
  return { token: token, user: publicUser_(userObj_(u)) };
}

function logout_(token) { CacheService.getScriptCache().remove('s:' + token); }

function requireSession(token) {
  var cache = CacheService.getScriptCache();
  var username = token ? cache.get('s:' + token) : null;
  if (!username) throw new RuleError('กรุณาเข้าสู่ระบบใหม่', 'auth');
  cache.put('s:' + token, username, SESSION_SECONDS); // sliding expiry
  var u = find_('Users', 'username', username);
  if (!u || u.active === 'false') throw new RuleError('บัญชีถูกปิดใช้งาน', 'auth');
  return userObj_(u);
}

function userObj_(row) {
  var roles = [];
  try { roles = JSON.parse(row.roles || '[]'); } catch (e) { roles = []; }
  var emp = null;
  rows_('Employees').forEach(function (e) { if (e.username === row.username) emp = e.code; });
  return { username: row.username, name: row.name || row.username, roles: roles, employee_code: emp, must_change_pin: row.must_change_pin === 'true' };
}
function publicUser_(u) {
  return { username: u.username, name: u.name, roles: u.roles, employee_code: u.employee_code, is_admin: isAdmin(u), must_change_pin: u.must_change_pin };
}

function rolesFor(u, workshop) {
  var out = {};
  (u.roles || []).forEach(function (r) {
    if (r.role === 'admin' || !workshop || r.workshop === 'ALL' || r.workshop === workshop) out[r.role] = true;
  });
  return out;
}
function isAdmin(u) { return (u.roles || []).some(function (r) { return r.role === 'admin'; }); }
function hasRole(u, workshop) {
  var r = rolesFor(u, workshop);
  if (r.admin) return true;
  var wanted = Array.prototype.slice.call(arguments, 2);
  return wanted.some(function (role) { return r[role]; });
}
function visibleWorkshops(u) {
  var all = rows_('Workshops').map(function (w) { return w.code; });
  if (isAdmin(u) || (u.roles || []).some(function (r) { return r.workshop === 'ALL'; })) return all;
  var set = {};
  (u.roles || []).forEach(function (r) { set[r.workshop] = true; });
  return all.filter(function (c) { return set[c]; });
}
function require_(cond) { if (!cond) throw new Forbidden(); }

function canViewAudit(u, idx) {
  if (hasRole.apply(null, [u, idx.workshop].concat(STAFF_ROLES))) return true;
  if (u.employee_code && idx.employee_code === u.employee_code) return true;
  return rows_('Issues').some(function (i) { return i.owner === u.username && (',' + i.audit_ids + ',').indexOf(',' + idx.id + ',') >= 0; });
}
function canEditAudit(u, idx) { return hasRole(u, idx.workshop, 'auditor', 'tlgl'); }
function canCreateAudit(u, workshop) { return hasRole(u, workshop, 'auditor', 'tlgl'); }
function canViewIssue(u, i) { return hasRole.apply(null, [u, i.workshop].concat(STAFF_ROLES)) || i.owner === u.username; }
function canManageIssue(u, i) { return hasRole(u, i.workshop, 'auditor', 'tlgl'); }
function canWorkIssue(u, i) { return i.owner === u.username || canManageIssue(u, i); }
function canVerifyIssue(u, i) { return hasRole(u, i.workshop, 'verifier'); }

function newUserRow_(username, name, pin, roles, mustChange) {
  var salt = uuid_();
  return { username: username, name: name, salt: salt, pin_hash: hashPin_(salt, pin), roles: JSON.stringify(roles || []),
           active: 'true', created_at: nowIso(), must_change_pin: mustChange ? 'true' : 'false' };
}
function randomPin_() {
  var s = '';
  for (var i = 0; i < 6; i++) s += Math.floor(Math.random() * 10);
  return s;
}

// ===== Logic.gs =====
/**
 * PJO business rules (ported 1:1 from the tested Django service layer).
 * An audit is one JSON document (blob "audit:<id>") plus an index row in the Audits sheet.
 * An issue is one JSON document (blob "issue:<id>") plus an index row in the Issues sheet.
 */
var HEADER_FIELDS = ['audit_date', 'shift', 'group', 'line', 'station', 'model', 'employee_name', 'tlgl_name',
  'ois_revision', 'ois_url', 'ois_current', 'standard_time_s', 'standard_time_source', 'takt_time_s', 'takt_time_source'];
var SIGNATURE_SCOPE = {
  employee_major: ['s1'], employee_minor: ['s1'], employee_recert: ['recert'], recertifier: ['recert'],
  employee_s3: ['s3'], supervisor_s3: ['s3'], auditor: ['header', 's1', 's2', 's3', 's4']
};
var SIGNATURE_LABEL = {
  employee_major: 'พนักงานยืนยันความผิดปกติหลัก', employee_minor: 'พนักงานยืนยันความผิดปกติรอง',
  employee_recert: 'ลายเซ็นยืนยันความผิดปกติหลักหลังการรับรองใหม่', recertifier: 'ผู้รับรองใหม่',
  employee_s3: 'ลายเซ็นของพนักงาน (ระยะที่ 2)', supervisor_s3: 'ลายเซ็นของผู้บังคับบัญชา (Group Leader, MFG. Engineer, Process Eng.)',
  auditor: 'ผู้ตรวจสอบ'
};
var ISSUE_TRANSITIONS = {
  open: ['assigned'], reopened: ['assigned', 'in_progress'], assigned: ['in_progress', 'assigned'],
  in_progress: ['pending_verification'], pending_verification: ['closed', 'in_progress'], closed: ['reopened']
};
var ISSUE_STATUS_TH = { open: 'เปิด', assigned: 'มอบหมายแล้ว', in_progress: 'กำลังแก้ไข', pending_verification: 'รอตรวจยืนยัน', closed: 'ปิดแล้ว', reopened: 'เปิดใหม่' };
var AUDIT_STATUS_TH = { draft: 'ร่าง', in_progress: 'กำลังตรวจ', pending_signatures: 'รอลงนาม', completed: 'ตรวจและลงนามครบ', amended: 'แก้ไขหลังลงนาม (รอลงนามใหม่)', cancelled: 'ยกเลิก' };
var ISSUE_TYPE_TH = { major: 'ความผิดปกติหลัก', minor: 'ความผิดปกติรอง', improvement: 'โอกาสปรับปรุง (ตาราง 2)', understanding: 'ความเข้าใจ (ตาราง 3)',
  suggestion: 'ข้อเสนอแนะพนักงาน', real_event: 'ความผิดปกติที่เกิดจริง (ตาราง 4)', other: 'อื่น ๆ' };

// ------------------------------------------------------------------ templates
function templateContent(id) { return blobGet('tpl:' + id); }

function buildItemIndex(c) {
  var idx = {};
  c.s1.items.forEach(function (i) { idx[i.key] = Object.assign({ sheet: 's1' }, i); });
  c.s2.sections.forEach(function (s) { s.items.forEach(function (i) { idx[i.key] = Object.assign({ sheet: 's2', section: s.code }, i); }); });
  c.s3.questions.forEach(function (q) { idx[q.key] = Object.assign({ sheet: 's3' }, q); });
  c.s4.cases.forEach(function (k) { idx[k.key] = Object.assign({ sheet: 's4', text: k.case }, k); });
  return idx;
}

// ------------------------------------------------------------------ audit docs
function loadAudit(id) {
  var a = blobGet('audit:' + id);
  if (!a) throw new RuleError('ไม่พบ Audit', 'not_found');
  a._snap = templateContent(a.template_id);
  a._items = buildItemIndex(a._snap);
  return a;
}
function saveAudit(a) {
  var copy = {};
  Object.keys(a).forEach(function (k) { if (k.charAt(0) !== '_') copy[k] = a[k]; });
  copy.updated_at = nowIso();
  blobPut('audit:' + a.id, copy);
  var idx = find_('Audits', 'id', a.id);
  var openIssues = issueIdsOfAudit_(a).filter(function (iid) { var r = find_('Issues', 'id', iid); return r && r.status !== 'closed'; }).length;
  var missing = requiredSignatures(a).filter(function (r) { return r.required && !r.signature; }).length;
  var rec = {
    id: a.id, audit_no: a.audit_no, workshop: a.workshop, template_id: a.template_id, status: a.status, revision: a.revision,
    audit_date: a.header.audit_date, shift: a.header.shift, team_id: a.header.team_id || '', station: a.header.station, model: a.header.model,
    employee_code: a.header.employee_code || '', employee_name: a.header.employee_name, auditor: a.auditor, plan_id: a.plan_id || '',
    open_issues: openIssues, recert_pending: (a.followups || []).filter(function (f) { return f.stage !== 'recertified'; }).length,
    missing_signatures: missing, created_at: a.created_at, updated_at: copy.updated_at, completed_at: a.completed_at || ''
  };
  if (idx) update_('Audits', idx, rec); else insert_('Audits', rec);
}
function issueIdsOfAudit_(a) {
  var set = {};
  Object.keys(a.origins || {}).forEach(function (k) { set[a.origins[k]] = true; });
  return Object.keys(set);
}

function createAudit(user, templateId, header, planId) {
  var t = find_('Templates', 'id', templateId);
  if (!t || t.status !== 'published') throw new RuleError('ใช้ได้เฉพาะแม่แบบที่ Published แล้ว');
  require_(canCreateAudit(user, t.workshop));
  var date = header.audit_date || todayBkk();
  var n = nextNumber_('audit-' + date.slice(0, 4));
  var id = String(nextNumber_('audit-id'));
  var h = {};
  HEADER_FIELDS.forEach(function (f) { h[f] = header[f] !== undefined && header[f] !== null ? String(header[f]) : ''; });
  h.audit_date = date;
  h.team_id = header.team_id || '';
  h.employee_code = header.employee_code || '';
  if (h.employee_code && !h.employee_name) { var e = find_('Employees', 'code', h.employee_code); if (e) h.employee_name = e.name; }
  if (h.team_id) { var tm = find_('Teams', 'id', h.team_id); if (tm) { h.group = h.group || tm.group; h.line = h.line || tm.line; } }
  var a = {
    id: id, audit_no: 'PJO-' + date.slice(0, 4) + '-' + pad5_(n), template_id: t.id, template_label: 'CATH-CPS009-B02 ' + t.workshop + ' v' + t.version,
    workshop: t.workshop, plan_id: planId || '', auditor: user.username, auditor_name: user.name, header: h, status: 'draft', revision: 1, lock_version: 1,
    marks: {}, s3: {}, suggestions: [], s4: [], timings: [], followups: [], signatures: [], revisions: [], origins: {}, ops: [], attachments: [],
    created_at: nowIso(), created_by: user.username
  };
  a._snap = templateContent(t.id);
  a._items = buildItemIndex(a._snap);
  saveAudit(a);
  trail(user, 'audit.create', id, '', { template: a.template_label });
  return a;
}

function activeSignatures(a) { return (a.signatures || []).filter(function (s) { return !s.superseded_at; }); }
function lockedSheets(a) {
  var locked = {};
  activeSignatures(a).filter(function (s) { return !s.followup_id; }).forEach(function (s) { SIGNATURE_SCOPE[s.role].forEach(function (x) { locked[x] = true; }); });
  if (a.status === 'completed' || a.status === 'cancelled') ['header', 's1', 's2', 's3', 's4'].forEach(function (x) { locked[x] = true; });
  return Object.keys(locked);
}
function ensureEditable(a, sheet) {
  if (a.status === 'cancelled') throw new RuleError('Audit นี้ถูกยกเลิกแล้ว', 'cancelled');
  if (lockedSheets(a).indexOf(sheet) >= 0) throw new RuleError('ส่วนนี้ลงนามแล้ว หากต้องแก้ไขให้กด “ขอแก้ไขหลังลงนาม” และระบุเหตุผล', 'locked');
}
function touch_(a) { if (a.status === 'draft') a.status = 'in_progress'; }

function auditData(a) {
  var s1 = {}, s2 = {};
  Object.keys(a.marks).sort().forEach(function (k) {
    var p = k.split('|');
    if (p[0].indexOf('S1-') === 0) { s1[p[0]] = s1[p[0]] || {}; s1[p[0]][p[1]] = a.marks[k].v; }
    else s2[p[0]] = a.marks[k].v;
  });
  var s3 = {};
  Object.keys(a.s3).sort().forEach(function (k) { var x = a.s3[k]; s3[k] = { answer: x.employee_answer || '', before: x.before || '', coaching: x.coaching || '', after: x.after || '' }; });
  return {
    header: a.header,
    s1: { marks: s1, timing: (a.timings || []).filter(function (t) { return t.saved && !t.discarded; }).map(timingSummary) },
    s2: s2,
    s3: { answers: s3, suggestions: a.suggestions.map(function (s) { return { id: s.client_id, description: s.description, suggestion: s.suggestion, owner: s.owner_name }; }) },
    s4: a.s4.map(function (r) { return { id: r.client_id, case: r.case_key, text: r.case_text, real: !!r.is_real_event, answer: r.employee_answer, coaching: r.coaching, result: r.result, improvement: r.improvement }; })
  };
}
function scopeData(a, role, f) {
  var scope = SIGNATURE_SCOPE[role];
  if (scope[0] === 'recert') return { followup: f.id, item: f.item_key, occurrence: f.occurrence, training: f.training_detail || '', recert_by: f.recert_by || '', recert_result: f.recert_result || '', revision: a.revision };
  var d = auditData(a), out = { audit_no: a.audit_no, revision: a.revision };
  scope.forEach(function (k) { out[k] = d[k]; });
  return out;
}

// ------------------------------------------------------------------ autosave ops
function applyOps(user, auditId, ops) {
  return withLock(function () {
    var a = loadAudit(auditId);
    require_(canEditAudit(user, auditIndexOf_(a)));
    var results = [];
    var issuesTouched = [];
    ops.forEach(function (op) {
      var opId = String(op.op_id || '');
      var done = opId ? a.ops.filter(function (o) { return o.id === opId; })[0] : null;
      if (done) { results.push(Object.assign({}, done.res, { op_id: opId, duplicate: true })); return; }
      var snapshot = JSON.stringify(a);
      try {
        var res = applyOp_(a, user, op, issuesTouched);
        res = Object.assign({ op_id: opId, status: 'ok' }, res);
        if (opId) { a.ops.push({ id: opId, res: res }); if (a.ops.length > 1500) a.ops = a.ops.slice(-1000); }
        results.push(res);
      } catch (e) {
        if (!(e instanceof RuleError)) throw e;
        var keep = { _snap: a._snap, _items: a._items };
        a = JSON.parse(snapshot); a._snap = keep._snap; a._items = keep._items; // roll back this op only
        results.push(Object.assign({ op_id: opId, status: e.code === 'conflict' ? 'conflict' : 'error', code: e.code, message: e.message }, e.extra));
      }
    });
    saveAudit(a);
    issuesTouched.forEach(function (x) { saveIssue(x); });
    return { results: results, lock_version: a.lock_version, status: a.status };
  });
}
function auditIndexOf_(a) { return { id: a.id, workshop: a.workshop, employee_code: a.header.employee_code }; }

function applyOp_(a, user, op, issuesTouched) {
  switch (op.type) {
    case 'mark': return opMark_(a, user, op, issuesTouched);
    case 'header': return opHeader_(a, user, op);
    case 's3': return opS3_(a, user, op);
    case 'suggestion': return opRow_(a, user, op, 'suggestions', 's3', ['description', 'suggestion', 'owner_name']);
    case 's4': return opS4_(a, user, op);
    case 'followup': return opFollowup_(a, user, op);
  }
  throw new RuleError('ไม่รู้จักคำสั่ง ' + op.type);
}

function opMark_(a, user, op, issuesTouched) {
  var key = op.item_key, occ = Number(op.occurrence || 0), value = op.value || '';
  var item = a._items[key];
  if (!item || (item.sheet !== 's1' && item.sheet !== 's2')) throw new RuleError('ไม่พบข้อนี้ในมาตรฐานของ Audit');
  ensureEditable(a, item.sheet);
  if (['', 'pass', 'fail', 'na'].indexOf(value) < 0) throw new RuleError('ค่าไม่ถูกต้อง');
  if (item.sheet === 's1') {
    var n = a._snap.s1.frequency_count || 12;
    if (occ < 1 || occ > n) throw new RuleError('ครั้งที่สังเกตไม่ถูกต้อง');
    if (value === 'na' && !item.allow_na) throw new RuleError('ข้อนี้ไม่อนุญาต N/A');
  } else {
    occ = 0;
    if (value === 'na') throw new RuleError('ตาราง 2 ใช้เฉพาะ √ / × ตามหมายเหตุของแบบฟอร์ม');
  }
  var k = key + '|' + occ, cur = a.marks[k], curVal = cur ? cur.v : '';
  if ('prev' in op && (op.prev || '') !== curVal) throw new RuleError('มีผู้อื่นบันทึกช่องนี้ไปก่อนแล้ว', 'conflict', { current: curVal, by: cur ? cur.by : '' });
  if (value === '') delete a.marks[k];
  else a.marks[k] = { v: value, by: user.name, user: user.username, at: nowIso(), rev: a.revision };
  var origin = originKey(a, key, occ);
  if (curVal === 'fail' && value !== 'fail' && a.origins[origin]) {
    var iss = loadIssue(a.origins[origin]);
    var note = 'ผลตรวจถูกเปลี่ยนจาก × เป็น ' + (value || 'ว่าง') + ' โดย ' + user.name + ' ' + fmtBkk_(nowIso());
    iss.occurrences.forEach(function (o) { if (o.origin_key === origin) o.mark_changed_note = note; });
    iss.events.push({ action: 'mark_changed', comment: note, user: user.username, at: nowIso() });
    issuesTouched.push(iss);
  }
  touch_(a);
  trail(user, 'mark', a.id, '', { item: key, occurrence: occ, old: curVal, new: value });
  return { value: value, needs_issue: value === 'fail' && !a.origins[origin], recorded_at: nowIso() };
}

function opHeader_(a, user, op) {
  ensureEditable(a, 'header');
  if (op.lock_version !== undefined && op.lock_version !== null && Number(op.lock_version) !== a.lock_version)
    throw new RuleError('ข้อมูลส่วนหัวถูกแก้ไขโดยผู้อื่น กรุณาโหลดใหม่', 'conflict', { lock_version: a.lock_version });
  var changed = {};
  Object.keys(op.fields || {}).forEach(function (f) {
    if (HEADER_FIELDS.indexOf(f) < 0) return;
    var v = op.fields[f] === null || op.fields[f] === undefined ? '' : String(op.fields[f]);
    if ((f === 'standard_time_s' || f === 'takt_time_s') && v !== '' && !(Number(v) >= 0)) throw new RuleError('เวลาต้องเป็นตัวเลข');
    if (f === 'audit_date' && !v) return;
    if (f === 'ois_current' && ['', 'yes', 'no'].indexOf(v) < 0) throw new RuleError('ค่าไม่ถูกต้อง');
    if ((a.header[f] || '') !== v) { changed[f] = [a.header[f] || '', v]; a.header[f] = v; }
  });
  if (Object.keys(changed).length) { a.lock_version += 1; trail(user, 'header', a.id, '', { changed: changed }); }
  touch_(a);
  return { lock_version: a.lock_version };
}

function opS3_(a, user, op) {
  ensureEditable(a, 's3');
  var key = op.item_key;
  if (!a._items[key] || a._items[key].sheet !== 's3') throw new RuleError('ไม่พบคำถามนี้');
  var field = op.field;
  if (['employee_answer', 'before', 'coaching', 'after'].indexOf(field) < 0) throw new RuleError('ช่องไม่ถูกต้อง');
  var val = op.value || '';
  if ((field === 'before' || field === 'after') && ['', 'pass', 'fail'].indexOf(val) < 0) throw new RuleError('ค่าไม่ถูกต้อง');
  var ans = a.s3[key] = a.s3[key] || {};
  var cur = ans[field] || '';
  if ('prev' in op && (op.prev || '') !== cur) throw new RuleError('มีผู้อื่นแก้ไขช่องนี้แล้ว', 'conflict', { current: cur });
  ans[field] = val;
  ans.by = user.name; ans.at = nowIso();
  touch_(a);
  trail(user, 's3', a.id, '', { item: key, field: field, old: cur, new: val });
  return { evaluated_at: ans.at };
}

function opRow_(a, user, op, listName, sheet, fields) {
  ensureEditable(a, sheet);
  var list = a[listName], cid = String(op.client_id || '');
  if (!cid) throw new RuleError('ไม่มีรหัสรายการ');
  var r = list.filter(function (x) { return x.client_id === cid; })[0];
  if (op.delete) {
    if (r && r.issue_id) throw new RuleError('รายการนี้สร้างปัญหาแล้ว ลบไม่ได้');
    a[listName] = list.filter(function (x) { return x.client_id !== cid; });
    return {};
  }
  if (!r) { r = { client_id: cid, created_by: user.username }; list.push(r); }
  fields.forEach(function (f) { if (op.fields && f in op.fields) r[f] = String(op.fields[f] || ''); });
  touch_(a);
  return {};
}

function opS4_(a, user, op) {
  var f = op.fields || {};
  if (f.case_key && (!a._items[f.case_key] || a._items[f.case_key].sheet !== 's4')) throw new RuleError('ไม่พบกรณีนี้ในมาตรฐาน');
  if ('result' in f && ['', 'pass', 'fail'].indexOf(f.result) < 0) throw new RuleError('ค่าไม่ถูกต้อง');
  var res = opRow_(a, user, op, 's4', 's4', ['case_key', 'case_text', 'employee_answer', 'coaching', 'result', 'improvement']);
  if (!op.delete && 'is_real_event' in f) {
    a.s4.forEach(function (r) { if (r.client_id === op.client_id) r.is_real_event = !!f.is_real_event; });
  }
  return res;
}

function opFollowup_(a, user, op) {
  var f = a.followups.filter(function (x) { return String(x.id) === String(op.id); })[0];
  if (!f) throw new RuleError('ไม่พบรายการติดตาม');
  if (activeSignatures(a).some(function (s) { return String(s.followup_id) === String(f.id); })) throw new RuleError('การรับรองใหม่ลงนามแล้ว แก้ไขไม่ได้');
  ['supervisor_notified', 'immediate_action', 'training_by', 'training_at', 'training_detail', 'recert_by', 'recert_at', 'recert_result'].forEach(function (k) {
    if (op.fields && k in op.fields) f[k] = String(op.fields[k] || '');
  });
  if (f.stage !== 'recertified') f.stage = (f.training_detail || '').trim() ? 'trained' : 'open';
  trail(user, 'followup', a.id, '', { followup: f.id, fields: Object.keys(op.fields || {}) });
  return { stage: f.stage };
}

// ------------------------------------------------------------------ issues
function originKey(a, itemKey, occ) { return 'A' + a.id + ':' + itemKey + ':' + (occ || 0); }

function loadIssue(id) {
  var i = blobGet('issue:' + id);
  if (!i) throw new RuleError('ไม่พบปัญหา', 'not_found');
  return i;
}
function saveIssue(i) {
  i.updated_at = nowIso();
  blobPut('issue:' + i.id, i);
  var auditIds = {};
  if (i.audit_id) auditIds[i.audit_id] = true;
  i.occurrences.forEach(function (o) { if (o.audit_id) auditIds[o.audit_id] = true; });
  upsert_('Issues', 'id', {
    id: i.id, issue_no: i.issue_no, audit_id: i.audit_id || '', workshop: i.workshop, team_id: i.team_id || '', station: i.station || '',
    sheet: i.sheet || '', item_code: i.item_code || '', issue_type: i.issue_type, title: (i.title || '').slice(0, 300), owner: i.owner || '',
    owner_name: i.owner_name || '', due_date: i.due_date || '', status: i.status, occurrences: i.occurrences.length,
    created_at: i.created_at, closed_at: i.closed_at || '', audit_ids: Object.keys(auditIds).join(',')
  });
}
function isOverdue(i) { return !!(i.due_date && i.status !== 'closed' && i.due_date < todayBkk()); }
function gbrOf(i) { return i.status === 'closed' ? 'G' : (isOverdue(i) ? 'R' : 'B'); }

var ITEM_TYPE = { s2: 'improvement', s3: 'understanding', s4: 'real_event' };

function recordFinding(user, auditId, p) {
  return withLock(function () {
    var a = loadAudit(auditId);
    require_(canEditAudit(user, auditIndexOf_(a)));
    var sheet = p.sheet;
    if (['s1', 's2', 's3', 's4'].indexOf(sheet) < 0) throw new RuleError('ระบุตารางไม่ถูกต้อง');
    if (sheet !== 's4') ensureEditable(a, sheet);
    if (p.client_id) {
      var existing = (a.client_findings || {})[p.client_id];
      if (existing) return { created: false, issue: issueBrief(loadIssue(existing)) };
    }
    var origin;
    if (sheet === 's4') origin = 'A' + a.id + ':S4:' + p.review_id;
    else if (sheet === 's3' && p.suggestion_id) origin = 'A' + a.id + ':SUG:' + p.suggestion_id;
    else if (sheet === 's2' && p.row_id) origin = 'A' + a.id + ':S2ROW:' + p.row_id;
    else if (p.item_key) origin = originKey(a, p.item_key, p.occurrence || 0);
    if (origin && a.origins[origin]) return { created: false, issue: issueBrief(loadIssue(a.origins[origin])) };
    var item = p.item_key ? (a._items[p.item_key] || {}) : {};
    var itype = sheet === 's1' ? (item.severity === 'major' ? 'major' : 'minor') : (p.suggestion_id ? 'suggestion' : (ITEM_TYPE[sheet] || 'other'));
    var title = String(p.title || '').trim();
    var issue, created = false;
    if (p.due_date && !/^\d{4}-\d{2}-\d{2}$/.test(p.due_date)) throw new RuleError('รูปแบบวันที่กำหนดเสร็จไม่ถูกต้อง');
    if (p.link_issue_id) {
      issue = loadIssue(p.link_issue_id);
      require_(canViewIssue(user, issue));
      if (issue.workshop !== a.workshop) throw new RuleError('เชื่อมได้เฉพาะปัญหาใน Workshop เดียวกัน');
      if (issue.status === 'closed') transitionIssue_(issue, user, 'reopened', 'พบซ้ำใน ' + a.audit_no);
    } else {
      if (!title) throw new RuleError('กรุณาระบุรายละเอียดปัญหา');
      var y = todayBkk().slice(0, 4);
      var id = String(nextNumber_('issue-id'));
      var owner = p.owner ? find_('Users', 'username', p.owner) : null;
      issue = {
        id: id, issue_no: 'ISS-' + y + '-' + pad5_(nextNumber_('issue-' + y)), audit_id: a.id, audit_no: a.audit_no, workshop: a.workshop,
        team_id: a.header.team_id || '', station: a.header.station || '', model: a.header.model || '', employee_code: a.header.employee_code || '',
        employee_name: a.header.employee_name || '', sheet: sheet, item_key: p.item_key || '',
        item_code: item.code || (item.no ? 'ข้อ ' + item.no : ''), issue_type: itype, priority: p.priority || '', title: title.slice(0, 500),
        description: p.description || '', owner: owner ? owner.username : '', owner_name: p.owner_name || (owner ? owner.name : ''),
        due_date: p.due_date || '', containment: p.containment || '', root_cause: '', permanent_action: '', effectiveness: '',
        verifier: '', verified_at: '', closed_at: '', status: (owner || p.owner_name) ? 'assigned' : 'open', lock_version: 1,
        created_by: user.username, created_at: nowIso(), occurrences: [], events: [], attachments: []
      };
      issue.events.push({ action: 'created', to: issue.status, user: user.username, at: nowIso(),
                          comment: 'สร้างจาก ' + a.audit_no + ' ' + (item.code || p.item_key || '') + ' ครั้งที่ ' + (p.occurrence || '-') });
      created = true;
    }
    issue.occurrences.push({ audit_id: a.id, audit_no: a.audit_no, sheet: sheet, item_key: p.item_key || '', occurrence: p.occurrence || null,
                             origin_key: origin || '', note: p.description || '', mark_value_at_finding: (sheet === 's1' || sheet === 's2') ? 'fail' : '',
                             found_by: user.username, found_at: nowIso() });
    if (!created) issue.events.push({ action: 'linked', user: user.username, at: nowIso(), comment: 'พบซ้ำใน ' + a.audit_no + ' ' + (item.code || p.item_key || '') + ' ครั้งที่ ' + (p.occurrence || '-') });
    if (origin) a.origins[origin] = issue.id;
    else a.origins['A' + a.id + ':MISC:' + (p.client_id || uuid_())] = issue.id;
    if (p.client_id) { a.client_findings = a.client_findings || {}; a.client_findings[p.client_id] = issue.id; }
    if (itype === 'major' && sheet === 's1' && !a.followups.some(function (f) { return f.issue_id === issue.id; })) {
      a.followups.push({ id: String(a.followups.length + 1), issue_id: issue.id, issue_no: issue.issue_no, item_key: p.item_key, occurrence: Number(p.occurrence || 0), stage: 'open' });
    }
    if (sheet === 's4' && p.review_id) a.s4.forEach(function (r) { if (r.client_id === p.review_id) { r.issue_id = issue.id; r.is_real_event = true; } });
    if (sheet === 's3' && p.suggestion_id) a.suggestions.forEach(function (r) { if (r.client_id === p.suggestion_id) r.issue_id = issue.id; });
    saveIssue(issue);
    saveAudit(a);
    trail(user, 'issue.finding', a.id, issue.id, { created: created, item: p.item_key, occurrence: p.occurrence });
    return { created: created, issue: issueBrief(issue), major_followup: itype === 'major' };
  });
}

function issueBrief(i) {
  return { id: i.id, issue_no: i.issue_no, title: i.title, status: i.status, status_th: ISSUE_STATUS_TH[i.status], item_code: i.item_code,
           station: i.station, owner: i.owner_name || i.owner, due_date: i.due_date || null, overdue: isOverdue(i), type: i.issue_type,
           fix: i.permanent_action || i.containment, gbr: gbrOf(i) };
}

function transitionIssue_(i, user, to, comment) {
  var from = i.status;
  if ((ISSUE_TRANSITIONS[from] || []).indexOf(to) < 0) throw new RuleError('เปลี่ยนสถานะจาก ' + ISSUE_STATUS_TH[from] + ' เป็น ' + to + ' ไม่ได้');
  if (to === 'reopened' && !String(comment || '').trim()) throw new RuleError('ต้องระบุเหตุผลการเปิดใหม่');
  if (to === 'assigned' && !(i.owner || i.owner_name)) throw new RuleError('ต้องระบุผู้รับผิดชอบก่อนมอบหมาย');
  if (to === 'pending_verification' && !(i.containment || i.permanent_action)) throw new RuleError('ต้องบันทึกการแก้ไขก่อนส่งตรวจยืนยัน');
  if (to === 'closed') {
    if (!String(i.effectiveness || '').trim()) throw new RuleError('ต้องบันทึกผลตรวจประสิทธิผลก่อนปิด');
    i.verifier = user.username; i.verified_at = nowIso(); i.closed_at = nowIso();
  }
  if (to === 'reopened') i.closed_at = '';
  i.status = to;
  i.lock_version += 1;
  i.events.push({ from: from, to: to, action: 'transition', comment: comment || '', user: user.username, at: nowIso() });
  trail(user, 'issue.transition', i.audit_id, i.id, { from: from, to: to });
}

// ------------------------------------------------------------------ timing
function lapsFromEvents(events) {
  var laps = [], start = null, paused = 0, pStart = null, reasons = [];
  events.forEach(function (e) {
    var t = Number(e.t);
    if (e.type === 'start') { start = t; paused = 0; pStart = null; reasons = []; }
    else if (e.type === 'pause' && start !== null && pStart === null) { pStart = t; reasons.push(e.reason || ''); }
    else if (e.type === 'resume' && pStart !== null) { paused += t - pStart; pStart = null; }
    else if ((e.type === 'lap' || e.type === 'stop') && start !== null) {
      if (pStart !== null) { paused += t - pStart; pStart = null; }
      var gross = (t - start) / 1000;
      laps.push({ gross: gross, paused: paused / 1000, net: gross - paused / 1000, pause_reasons: reasons });
      start = e.type === 'lap' ? t : null; paused = 0; reasons = [];
    }
  });
  return laps;
}
function r2_(x) { return Math.round(Number(x) * 100) / 100; }

function saveTiming(user, auditId, p) {
  return withLock(function () {
    var a = loadAudit(auditId);
    require_(canEditAudit(user, auditIndexOf_(a)));
    ensureEditable(a, 's1');
    var item = a._items[p.item_key];
    if (!item || item.kind !== 'timing') throw new RuleError('ข้อนี้ไม่ใช่ข้อวัดเวลา');
    var obs = Number(p.observation);
    if (!(obs >= 1 && obs <= (a._snap.s1.frequency_count || 12))) throw new RuleError('ครั้งที่สังเกตไม่ถูกต้อง');
    var s = a.timings.filter(function (t) { return t.client_id === p.client_id; })[0];
    if (s && s.saved && !p.final) return { session: timingSummary(s), saved: true };
    if (!s) { s = { client_id: String(p.client_id), item_key: p.item_key, observation: obs, laps: [], saved: false, discarded: false }; a.timings.push(s); }
    s.events = (p.events || []).map(function (e) { return Object.assign({ server_received: e.server_received || nowIso() }, e); });
    s.warnings = p.warnings || [];
    if (p.final) {
      var computed = lapsFromEvents(s.events);
      var over = {};
      (p.laps || []).forEach(function (x) { over[Number(x.lap_no)] = x; });
      var laps = [];
      computed.forEach(function (c, i) {
        var o = over[i + 1] || {};
        var valid = o.valid !== false;
        if (!valid && !String(o.invalid_reason || '').trim()) throw new RuleError('รอบที่ ' + (i + 1) + ' ถูกตั้งเป็นใช้ไม่ได้ ต้องระบุเหตุผล');
        if (c.paused > 0 && !c.pause_reasons.every(function (r) { return String(r || '').trim(); })) throw new RuleError('รอบที่ ' + (i + 1) + ' มีการหยุดชั่วคราว ต้องระบุเหตุผล');
        laps.push({ lap_no: i + 1, seconds: r2_(c.net), gross: r2_(c.gross), paused: r2_(c.paused), pause_reasons: c.pause_reasons, source: 'stopwatch',
                    manual_reason: '', valid: valid, invalid_reason: o.invalid_reason || '' });
      });
      (p.manual_laps || []).forEach(function (m) {
        var reason = String(m.reason || '').trim();
        if (!reason) throw new RuleError('เวลาที่กรอกเองต้องระบุเหตุผล');
        var sec = Number(m.seconds);
        if (!(sec > 0)) throw new RuleError('เวลาต้องมากกว่า 0');
        laps.push({ lap_no: laps.length + 1, seconds: r2_(sec), gross: r2_(sec), paused: 0, pause_reasons: [], source: 'manual', manual_reason: reason,
                    valid: m.valid !== false, invalid_reason: m.invalid_reason || '' });
      });
      if (!laps.length) throw new RuleError('ยังไม่มีรอบจับเวลา');
      a.timings.forEach(function (t) {
        if (t !== s && t.item_key === p.item_key && t.observation === obs && t.saved && !t.discarded) {
          t.discarded = true; t.discard_reason = 'แทนที่ด้วยการจับเวลาใหม่ ' + fmtBkk_(nowIso());
        }
      });
      s.laps = laps; s.saved = true; s.saved_by = user.username; s.saved_at = nowIso(); s.observation = obs;
      touch_(a);
      trail(user, 'timing.saved', a.id, '', { item: p.item_key, observation: obs });
    }
    saveAudit(a);
    return { session: timingSummary(s, a), saved: s.saved };
  });
}

function timingSummary(s, a) {
  var used = (s.laps || []).filter(function (l) { return l.valid; }).map(function (l) { return l.seconds; });
  var h = a ? a.header : {};
  return {
    client_id: s.client_id, item_key: s.item_key, observation: s.observation, laps: s.laps || [], warnings: s.warnings || [],
    count_used: used.length, count_total: (s.laps || []).length,
    avg: used.length ? used.reduce(function (x, y) { return x + y; }, 0) / used.length : null,
    min: used.length ? Math.min.apply(null, used) : null, max: used.length ? Math.max.apply(null, used) : null,
    saved_at: s.saved_at || null, discarded: !!s.discarded, discard_reason: s.discard_reason || '',
    standard_time: h.standard_time_s ? Number(h.standard_time_s) : null, standard_time_source: h.standard_time_source || '',
    takt_time: h.takt_time_s ? Number(h.takt_time_s) : null, takt_time_source: h.takt_time_source || '',
    evaluation: 'รอประเมิน'
  };
}

// ------------------------------------------------------------------ signatures
function requiredSignatures(a) {
  var items = a._items || buildItemIndex(templateContent(a.template_id));
  var hasMajor = false, hasMinor = false;
  Object.keys(a.marks).forEach(function (k) {
    if (a.marks[k].v !== 'fail' || k.indexOf('S1-') !== 0) return;
    var it = items[k.split('|')[0]] || {};
    if (it.severity === 'major') hasMajor = true; else hasMinor = true;
  });
  var active = {};
  activeSignatures(a).filter(function (s) { return !s.followup_id; }).forEach(function (s) { active[s.role] = s; });
  var snap = a._snap || templateContent(a.template_id);
  var labels = {};
  (snap.s1.labels || []).forEach(function (l) { labels[l.role] = l.text; });
  var s3sig = (snap.s3.signature || {}).text || '';
  function row(role, req, label, statement) { return { role: role, label: label, required: req, signature: active[role] || null, statement: statement }; }
  return [
    row('employee_major', hasMajor, labels.employee_major || SIGNATURE_LABEL.employee_major, 'ข้าพเจ้ารับทราบความผิดปกติหลักที่บันทึกในตาราง 1 ของ Audit นี้'),
    row('employee_minor', hasMinor, labels.employee_minor || SIGNATURE_LABEL.employee_minor, 'ข้าพเจ้ารับทราบความผิดปกติรองที่บันทึกในตาราง 1 ของ Audit นี้'),
    row('employee_s3', true, SIGNATURE_LABEL.employee_s3, 'ข้าพเจ้ารับทราบผลการประเมินความเข้าใจเชิงลึกและการชี้แนะในตาราง 3'),
    row('supervisor_s3', true, s3sig ? s3sig.split(':')[0].trim() : SIGNATURE_LABEL.supervisor_s3, 'ข้าพเจ้ารับรองว่าได้ประเมินและชี้แนะพนักงานตามตาราง 3'),
    row('auditor', true, SIGNATURE_LABEL.auditor, 'ข้าพเจ้ารับรองว่าผลตรวจ PJO ทั้ง 4 ตารางใน Audit นี้ถูกต้องตามที่สังเกตจริง')
  ];
}
function recertSignatures(a, f) {
  var active = {};
  activeSignatures(a).filter(function (s) { return String(s.followup_id) === String(f.id); }).forEach(function (s) { active[s.role] = s; });
  return [
    { role: 'recertifier', label: 'ผู้รับรองใหม่', required: true, signature: active.recertifier || null,
      statement: 'ข้าพเจ้าได้สังเกตงานซ้ำหลังการฝึกอบรมและบันทึกผลตามจริง (โปรแกรมไม่ใช่การอนุญาตให้กลับเข้าทำงาน)' },
    { role: 'employee_recert', label: SIGNATURE_LABEL.employee_recert, required: true, signature: active.employee_recert || null,
      statement: 'ข้าพเจ้ารับทราบผลการรับรองใหม่หลังความผิดปกติหลัก' }
  ];
}

function sign(user, auditId, p) {
  return withLock(function () {
    var a = loadAudit(auditId);
    var idx = auditIndexOf_(a);
    require_(canViewAudit(user, idx));
    var role = p.role, method = p.identity_method;
    if (method === 'login') {
      if (/^employee/.test(role)) require_(user.employee_code && user.employee_code === a.header.employee_code);
      else if (role === 'auditor') require_(a.auditor === user.username || hasRole(user, a.workshop, 'auditor'));
      else require_(hasRole(user, a.workshop, 'tlgl', 'auditor', 'verifier'));
    } else require_(canEditAudit(user, idx));
    var dup = a.signatures.filter(function (s) { return s.client_id === p.client_id; })[0];
    if (dup) return { state: auditState(a, user) };
    if (a.status === 'cancelled') throw new RuleError('Audit ถูกยกเลิกแล้ว');
    if (Number(p.strokes || 0) < 1) throw new RuleError('ลายเซ็นว่าง กรุณาเซ็นก่อนยืนยัน');
    var f = null, rows;
    if (role === 'employee_recert' || role === 'recertifier') {
      f = a.followups.filter(function (x) { return String(x.id) === String(p.followup_id); })[0];
      if (!f) throw new RuleError('ไม่พบรายการรับรองใหม่');
      if (!(f.training_detail && f.recert_result)) throw new RuleError('ต้องบันทึกการฝึกอบรมและผลการสังเกตซ้ำก่อนลงนามรับรองใหม่');
      rows = recertSignatures(a, f);
    } else {
      if (a.status !== 'pending_signatures' && a.status !== 'amended') throw new RuleError('ต้องกด “ตรวจเสร็จ ส่งลงนาม” ก่อน');
      rows = requiredSignatures(a);
    }
    var row = rows.filter(function (r) { return r.role === role; })[0];
    if (!row) throw new RuleError('บทบาทลงนามไม่ถูกต้อง');
    if (row.signature) throw new RuleError('บทบาทนี้ลงนามแล้ว');
    var signerName = user.name, signerCode = '', witness = '';
    if (method === 'employee_code_witnessed') {
      signerCode = String(p.signer_code || '').trim();
      if (!signerCode) throw new RuleError('ต้องระบุรหัสพนักงาน');
      var emp = find_('Employees', 'code', signerCode);
      if (!emp) throw new RuleError('ไม่พบรหัสพนักงานนี้');
      if (/^employee/.test(role) && a.header.employee_code && signerCode !== a.header.employee_code) throw new RuleError('รหัสพนักงานไม่ตรงกับพนักงานที่ถูกตรวจ');
      signerName = emp.name; witness = user.username;
    } else if (method !== 'login') throw new RuleError('วิธีระบุตัวตนไม่ถูกต้อง');
    var img = String(p.image || '');
    if (img.indexOf('data:image/png;base64,') !== 0) throw new RuleError('ไม่พบภาพลายเซ็น');
    var b64 = img.split(',')[1];
    if (b64.length < 260) throw new RuleError('ลายเซ็นว่าง กรุณาเซ็นก่อนยืนยัน');
    var file = saveFile_('sig_' + a.audit_no + '_' + role + '_' + Date.now() + '.png', 'image/png', b64);
    a.signatures.push({
      id: String(a.signatures.length + 1), role: role, followup_id: f ? f.id : '', revision: a.revision,
      signer_user: method === 'login' ? user.username : '', signer_name: signerName, signer_code: signerCode, identity_method: method,
      witness: witness, statement: row.statement, file_id: file.id, image_sha256: file.sha256,
      data_hash: sha256_(canonical_(scopeData(a, role, f))), signed_at: nowIso(), client_id: String(p.client_id || uuid_())
    });
    trail(user, 'signature', a.id, '', { role: role, signer: signerName, method: method, revision: a.revision });
    if (f) {
      if (recertSignatures(a, f).every(function (r) { return r.signature; })) f.stage = 'recertified';
    } else refreshCompletion_(a, user);
    saveAudit(a);
    return { state: auditState(a, user) };
  });
}

function refreshCompletion_(a, user) {
  if ((a.status === 'pending_signatures' || a.status === 'amended') && requiredSignatures(a).every(function (r) { return !r.required || r.signature; })) {
    a.status = 'completed';
    a.completed_at = nowIso();
    trail(user, 'audit.completed', a.id, '', { revision: a.revision });
  }
}

function submitAudit(user, auditId) {
  return withLock(function () {
    var a = loadAudit(auditId);
    require_(canEditAudit(user, auditIndexOf_(a)));
    if (['draft', 'in_progress', 'amended'].indexOf(a.status) < 0) throw new RuleError('สถานะปัจจุบันส่งลงนามไม่ได้');
    if (!Object.keys(a.marks).some(function (k) { return k.indexOf('S1-') === 0; })) throw new RuleError('ยังไม่มีผลการสังเกตในตาราง 1');
    if (!a.header.ois_current) throw new RuleError('กรุณาตอบการตรวจสอบ OIS ฉบับปัจจุบัน (Yes/No) ก่อนส่งลงนาม');
    var unlogged = Object.keys(a.marks).filter(function (k) {
      if (a.marks[k].v !== 'fail') return false;
      var p = k.split('|');
      return !a.origins[originKey(a, p[0], Number(p[1]))];
    });
    if (unlogged.length) throw new RuleError('ยังมีช่อง × ที่ไม่ได้บันทึกปัญหา: ' + unlogged.slice(0, 8).join(', '), 'unlogged', { items: unlogged });
    a.status = 'pending_signatures';
    a.submitted_at = nowIso();
    trail(user, 'audit.submitted', a.id, '', {});
    refreshCompletion_(a, user);
    saveAudit(a);
    return { state: auditState(a, user) };
  });
}

function amendAudit(user, auditId, reason, sheets) {
  return withLock(function () {
    var a = loadAudit(auditId);
    require_(canEditAudit(user, auditIndexOf_(a)));
    if (!String(reason || '').trim()) throw new RuleError('ต้องระบุเหตุผลการแก้ไข');
    sheets = (sheets || []).filter(function (s) { return ['header', 's1', 's2', 's3', 's4'].indexOf(s) >= 0; });
    if (!sheets.length) throw new RuleError('เลือกส่วนที่ต้องแก้ไข');
    if (a.status === 'cancelled') throw new RuleError('Audit ถูกยกเลิกแล้ว');
    var act = activeSignatures(a).filter(function (s) { return !s.followup_id; });
    if (!act.length) throw new RuleError('ยังไม่มีการลงนาม แก้ไขได้ตามปกติ');
    a.revisions.push({ revision: a.revision, reason: reason, affected: sheets, data_before: auditData(a), by: user.username, at: nowIso() });
    act.forEach(function (s) {
      if (SIGNATURE_SCOPE[s.role].some(function (x) { return sheets.indexOf(x) >= 0; })) {
        s.superseded_at = nowIso();
        s.superseded_reason = 'แก้ไข Rev ' + (a.revision + 1) + ': ' + reason;
      }
    });
    a.revision += 1;
    a.status = 'amended';
    a.completed_at = '';
    trail(user, 'audit.amended', a.id, '', { reason: reason, sheets: sheets, revision: a.revision });
    saveAudit(a);
    return { state: auditState(a, user) };
  });
}

function cancelAudit(user, auditId, reason) {
  return withLock(function () {
    var a = loadAudit(auditId);
    require_(canEditAudit(user, auditIndexOf_(a)));
    if (!String(reason || '').trim()) throw new RuleError('ต้องระบุเหตุผลการยกเลิก');
    if (a.status === 'completed') throw new RuleError('Audit ที่ลงนามครบแล้วยกเลิกไม่ได้ ให้ใช้การแก้ไขหลังลงนาม');
    a.status = 'cancelled';
    a.cancel_reason = reason;
    trail(user, 'audit.cancelled', a.id, '', { reason: reason });
    saveAudit(a);
    return {};
  });
}

// ------------------------------------------------------------------ state for the form
function auditState(a, user) {
  var findings = {};
  var issueCache = {};
  function brief(id) { if (!issueCache[id]) issueCache[id] = issueBrief(loadIssue(id)); return issueCache[id]; }
  Object.keys(a.origins).forEach(function (o) {
    var m = /^A\d+:(S[1-4]-[^:]+|S4|SUG|S2ROW|MISC):(.+)$/.exec(o);
    if (!m) return;
    if (m[1] === 'S4' || m[1] === 'SUG' || m[1] === 'MISC') return;
    if (m[1] === 'S2ROW') { findings['S2ROW:' + m[2] + '|0'] = brief(a.origins[o]); return; }
    findings[m[1] + '|' + m[2]] = Object.assign({ origin: o }, brief(a.origins[o]));
  });
  // S2 rows added from "+ เพิ่มแถว" are shown with their item code
  Object.keys(findings).forEach(function (k) { if (k.indexOf('S2ROW:') === 0) { var b = findings[k]; delete findings[k]; findings['S2-ROW-' + b.id + '|0'] = b; } });
  var marks = {};
  Object.keys(a.marks).forEach(function (k) { var m = a.marks[k]; marks[k] = { v: m.v, by: m.by, at: fmtBkk_(m.at) }; });
  var s3 = {};
  Object.keys(a.s3).forEach(function (k) { var x = a.s3[k]; s3[k] = Object.assign({}, x, { at: x.at ? fmtBkk_(x.at) : '' }); });
  var sigRow = function (r) {
    var s = r.signature;
    return { role: r.role, label: r.label, required: r.required, statement: r.statement, signed: !!s, signer: s ? s.signer_name : '',
             method: s ? s.identity_method : '', at: s ? fmtBkk_(s.signed_at) : '', sig_id: s ? s.id : null };
  };
  var openIssues = issueIdsOfAudit_(a).filter(function (id) { return brief(id).status !== 'closed'; }).length;
  return {
    id: a.id, audit_no: a.audit_no, status: a.status, status_th: AUDIT_STATUS_TH[a.status], revision: a.revision, lock_version: a.lock_version,
    locked: lockedSheets(a), can_edit: canEditAudit(user, auditIndexOf_(a)), marks: marks, findings: findings, s3: s3,
    suggestions: a.suggestions.map(function (s) { return Object.assign({}, s, { issue: s.issue_id ? brief(s.issue_id) : null }); }),
    s4: a.s4.map(function (r) { return Object.assign({}, r, { issue: r.issue_id ? brief(r.issue_id) : null }); }),
    timing: a.timings.filter(function (t) { return t.saved && !t.discarded; }).map(function (t) { return timingSummary(t, a); }),
    followups: a.followups.map(function (f) {
      return Object.assign({}, f, { stage_th: { open: 'รอดำเนินการ', trained: 'ฝึกอบรมแล้ว รอตรวจรับรองใหม่', recertified: 'รับรองใหม่แล้ว' }[f.stage],
                                    issue: brief(f.issue_id), signatures: recertSignatures(a, f).map(sigRow) });
    }),
    signatures: requiredSignatures(a).map(sigRow), open_issues: openIssues,
    recert_pending: a.followups.filter(function (f) { return f.stage !== 'recertified'; }).length,
    header: a.header, server_now: Date.now()
  };
}

function fmtBkk_(iso) {
  if (!iso) return '';
  return Utilities.formatDate(new Date(iso), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm');
}

// ===== Api.gs =====
/** Every function the browser may call. Each one checks permissions itself. */
var API = {};

// ----------------------------------------------------------------- session
API.ping = function () { return { ok: true, now: Date.now() }; };
API.login = function (_, p) { return login_(p.username, p.pin); };
API.logout = function (u, p, token) { logout_(token); return {}; };
API.me = function (u) { return { user: publicUser_(u), gbr: settingGet('gbr_mapping'), workshops: workshopList_(u) }; };
API.change_pin = function (u, p) {
  var pin = String(p.new_pin || '');
  if (!/^\d{6,8}$/.test(pin)) throw new RuleError('PIN ต้องเป็นตัวเลข 6–8 หลัก');
  return withLock(function () {
    var row = find_('Users', 'username', u.username);
    if (!u.must_change_pin && hashPin_(row.salt, String(p.old_pin || '')) !== row.pin_hash) throw new RuleError('PIN เดิมไม่ถูกต้อง');
    var salt = uuid_();
    update_('Users', row, { salt: salt, pin_hash: hashPin_(salt, pin), must_change_pin: 'false' });
    trail(u, 'pin.changed', '', '', {});
    return {};
  });
};

function workshopList_(u) {
  var vis = visibleWorkshops(u);
  return rows_('Workshops').filter(function (w) { return vis.indexOf(w.code) >= 0; }).map(function (w) { return { code: w.code, name: w.name }; });
}

// ----------------------------------------------------------------- lookups
API.lookups = function (u) {
  var vis = visibleWorkshops(u);
  var pub = rows_('Templates').filter(function (t) { return t.status === 'published' && vis.indexOf(t.workshop) >= 0; });
  return {
    workshops: workshopList_(u).map(function (w) {
      var t = pub.filter(function (x) { return x.workshop === w.code; })[0];
      return Object.assign(w, { can_create: canCreateAudit(u, w.code), template: t ? { id: t.id, version: t.version, published_at: t.published_at, label: 'CATH-CPS009-B02 ' + w.code + ' v' + t.version } : null });
    }),
    teams: rows_('Teams').filter(function (t) { return vis.indexOf(t.workshop) >= 0 && t.active !== 'false'; }).map(clean_),
    employees: rows_('Employees').filter(function (e) { return vis.indexOf(e.workshop) >= 0 && e.active !== 'false'; }).map(function (e) { return { code: e.code, name: e.name, workshop: e.workshop, team_id: e.team_id }; }),
    users: rows_('Users').filter(function (x) { return x.active !== 'false'; }).map(function (x) { return { username: x.username, name: x.name }; })
  };
};
function clean_(r) { var o = {}; Object.keys(r).forEach(function (k) { if (k !== '_row') o[k] = r[k]; }); return o; }

// ----------------------------------------------------------------- dashboard
API.dashboard = function (u, p) {
  var vis = visibleWorkshops(u).filter(function (w) { return !p.workshop || w === p.workshop; });
  var audits = rows_('Audits').filter(function (a) { return vis.indexOf(a.workshop) >= 0 && a.status !== 'cancelled'; });
  var issues = rows_('Issues').filter(function (i) { return vis.indexOf(i.workshop) >= 0; });
  var today = todayBkk(), month = today.slice(0, 7);
  var plans = rows_('Plans').filter(function (x) { return vis.indexOf(x.workshop) >= 0 && x.cancelled !== 'true' && x.planned_date.slice(0, 7) === month; });
  var planDone = plans.filter(function (pl) { return audits.some(function (a) { return a.plan_id === pl.id && a.status === 'completed'; }); }).length;
  var major = 0, minor = 0, byItem = {}, fuOpen = 0, fuTrained = 0;
  audits.forEach(function (ai) {
    var a = blobGet('audit:' + ai.id); if (!a) return;
    var items = buildItemIndex(templateContent(a.template_id));
    Object.keys(a.marks).forEach(function (k) {
      if (a.marks[k].v !== 'fail' || k.indexOf('S1-') !== 0) return;
      var it = items[k.split('|')[0]] || {};
      if (it.severity === 'major') major++; else minor++;
      var key = a.workshop + '|' + (it.text || '').slice(0, 90);
      byItem[key] = (byItem[key] || 0) + 1;
    });
    a.followups.forEach(function (f) { if (f.stage === 'open') fuOpen++; else if (f.stage === 'trained') fuTrained++; });
  });
  var open = issues.filter(function (i) { return i.status !== 'closed'; });
  return {
    plan_total: plans.length, plan_done: planDone,
    in_progress: audits.filter(function (a) { return a.status === 'draft' || a.status === 'in_progress'; }).length,
    pending_sig: audits.filter(function (a) { return a.status === 'pending_signatures' || a.status === 'amended'; }).length,
    completed: audits.filter(function (a) { return a.status === 'completed'; }).length,
    completed_open: audits.filter(function (a) { return a.status === 'completed' && Number(a.open_issues) > 0; }).length,
    major: major, minor: minor, fu_training: fuOpen, fu_recert: fuTrained,
    top_items: Object.keys(byItem).map(function (k) { var x = k.split('|'); return { workshop: x[0], text: x[1], n: byItem[k] }; }).sort(function (a, b) { return b.n - a.n; }).slice(0, 8),
    issues_open: open.length, issues_overdue: open.filter(function (i) { return i.due_date && i.due_date < today; }).length,
    issues_verify: issues.filter(function (i) { return i.status === 'pending_verification'; }).length,
    issues_repeat: issues.filter(function (i) { return Number(i.occurrences) > 1; }).length,
    recent: audits.sort(function (a, b) { return b.updated_at < a.updated_at ? -1 : 1; }).slice(0, 10).map(auditRowOut_),
    overdue_list: open.filter(function (i) { return i.due_date && i.due_date < today; }).sort(function (a, b) { return a.due_date < b.due_date ? -1 : 1; }).slice(0, 10).map(issueRowOut_)
  };
};
function auditRowOut_(a) { var o = clean_(a); o.status_th = AUDIT_STATUS_TH[a.status]; return o; }
function issueRowOut_(i) {
  var o = clean_(i);
  o.status_th = ISSUE_STATUS_TH[i.status]; o.type_th = ISSUE_TYPE_TH[i.issue_type] || i.issue_type;
  o.overdue = isOverdue(i); o.gbr = gbrOf(i);
  return o;
}

// ----------------------------------------------------------------- plans & audits list
API.plans = function (u, p) {
  var vis = visibleWorkshops(u).filter(function (w) { return !p.workshop || w === p.workshop; });
  var since = Utilities.formatDate(new Date(Date.now() - 31 * 864e5), 'Asia/Bangkok', 'yyyy-MM-dd');
  var audits = rows_('Audits').filter(function (a) { return vis.indexOf(a.workshop) >= 0; });
  var plans = rows_('Plans').filter(function (x) { return vis.indexOf(x.workshop) >= 0 && x.cancelled !== 'true' && x.planned_date >= since; })
    .sort(function (a, b) { return a.planned_date < b.planned_date ? -1 : 1; })
    .map(function (x) { var o = clean_(x); o.audits = audits.filter(function (a) { return a.plan_id === x.id; }).map(auditRowOut_); return o; });
  var list = audits.filter(function (a) {
    if (p.status && a.status !== p.status) return false;
    if (p.q) { var q = String(p.q).toLowerCase(); return (a.audit_no + ' ' + a.station + ' ' + a.employee_name).toLowerCase().indexOf(q) >= 0; }
    return true;
  }).sort(function (a, b) { return Number(b.id) - Number(a.id); }).slice(0, 300).map(auditRowOut_);
  return { plans: plans, audits: list };
};
API.plan_save = function (u, p) {
  require_(hasRole(u, p.workshop, 'auditor', 'tlgl'));
  return withLock(function () {
    if (p.cancel_id) { var r = find_('Plans', 'id', p.cancel_id); require_(r && r.workshop === p.workshop); update_('Plans', r, { cancelled: 'true' }); return {}; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.planned_date || '')) throw new RuleError('ระบุวันที่แผน');
    insert_('Plans', { id: String(nextNumber_('plan-id')), workshop: p.workshop, team_id: p.team_id || '', station: p.station || '', employee_code: p.employee_code || '',
                       planned_date: p.planned_date, auditor: p.auditor || '', note: p.note || '', cancelled: 'false', created_by: u.username, created_at: nowIso() });
    return {};
  });
};

// ----------------------------------------------------------------- audit form
API.audit_create = function (u, p) {
  var a = withLock(function () { return createAudit(u, p.template_id, p.header || {}, p.plan_id); });
  return { id: a.id };
};
API.audit_open = function (u, p) {
  var a = loadAudit(p.audit_id);
  require_(canViewAudit(u, auditIndexOf_(a)));
  var t = find_('Templates', 'id', a.template_id);
  var pending = rows_('Pending').filter(function (x) { return x.status === 'pending'; });
  return {
    snapshot: a._snap, state: auditState(a, u),
    meta: { template_label: a.template_label + (t ? ' (' + t.status + ')' : ''), auditor: a.auditor_name || a.auditor, team: teamName_(a.header.team_id) },
    employee: { code: a.header.employee_code || '', name: a.header.employee_name || '' },
    pending_ws: pending.filter(function (x) { return x.workshops.split(',').map(function (s) { return s.trim(); }).indexOf(a.workshop) >= 0; }).map(clean_),
    pending_all: pending.filter(function (x) { return x.workshops === 'ALL'; }).map(clean_),
    gbr: settingGet('gbr_mapping')
  };
};
function teamName_(id) { if (!id) return ''; var t = find_('Teams', 'id', id); return t ? t.workshop + ' / ' + (t.group ? t.group + ' / ' : '') + t.name : ''; }
API.state = function (u, p) { var a = loadAudit(p.audit_id); require_(canViewAudit(u, auditIndexOf_(a))); return { state: auditState(a, u) }; };
API.ops = function (u, p) {
  var r = applyOps(u, p.audit_id, p.ops || []);
  r.saved_at = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'HH:mm:ss');
  return r;
};
API.finding = function (u, p) {
  var r = recordFinding(u, p.audit_id, p);
  if (p.containment && r.created) {
    withLock(function () { var i = loadIssue(r.issue.id); i.containment = p.containment; saveIssue(i); });
  }
  return r;
};
API.link_candidates = function (u, p) {
  var a = loadAudit(p.audit_id);
  require_(canViewAudit(u, auditIndexOf_(a)));
  var q = String(p.q || '').toLowerCase();
  var rows = rows_('Issues').filter(function (i) { return i.workshop === a.workshop && (!q || (i.issue_no + ' ' + i.title).toLowerCase().indexOf(q) >= 0); });
  var itemKey = p.item_key || '';
  rows.sort(function (x, y) {
    function score(i) { return (i.status === 'closed' ? 4 : 0) + (i.station !== a.header.station ? 2 : 0); }
    return score(x) - score(y) || Number(y.id) - Number(x.id);
  });
  return { issues: rows.slice(0, 25).map(function (i) { return issueBrief(loadIssue(i.id)); }) };
};
API.timing = function (u, p) { return saveTiming(u, p.audit_id, p); };
API.submit = function (u, p) { return submitAudit(u, p.audit_id); };
API.sign = function (u, p) { return sign(u, p.audit_id, p); };
API.amend = function (u, p) { return amendAudit(u, p.audit_id, p.reason, p.sheets); };
API.cancel = function (u, p) { return cancelAudit(u, p.audit_id, p.reason); };
API.signature_image = function (u, p) {
  var a = loadAudit(p.audit_id);
  require_(canViewAudit(u, auditIndexOf_(a)));
  var s = a.signatures.filter(function (x) { return String(x.id) === String(p.sig_id); })[0];
  if (!s) throw new RuleError('ไม่พบลายเซ็น');
  return { data_url: readFileDataUrl_(s.file_id) };
};

var ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'];
API.upload = function (u, p) {
  var files = p.files || [];
  var issue = loadIssue(p.issue_id);
  var auditIdx = issue.audit_id ? auditIndexOf_(loadAudit(issue.audit_id)) : null;
  require_(canWorkIssue(u, issue) || (auditIdx && canEditAudit(u, auditIdx)));
  return withLock(function () {
    var i = loadIssue(p.issue_id);
    var out = files.map(function (f) {
      if (ALLOWED_MIME.indexOf(f.type) < 0) throw new RuleError('รองรับเฉพาะรูปภาพหรือ PDF');
      if (String(f.data || '').length > 14 * 1024 * 1024) throw new RuleError('ไฟล์ใหญ่เกิน 10 MB');
      var saved = saveFile_(i.issue_no + '_' + f.name, f.type, f.data);
      var att = { id: saved.id, name: String(f.name).slice(0, 200), mime: f.type, size: saved.size, purpose: p.purpose || 'evidence', by: u.username, at: nowIso() };
      i.attachments.push(att);
      return att;
    });
    saveIssue(i);
    trail(u, 'attachment', i.audit_id, i.id, { n: out.length });
    return { files: out };
  });
};
API.attachment = function (u, p) {
  var i = loadIssue(p.issue_id);
  require_(canViewIssue(u, i));
  var att = i.attachments.filter(function (x) { return x.id === p.file_id; })[0];
  if (!att) throw new RuleError('ไม่พบไฟล์');
  return { name: att.name, mime: att.mime, data_url: readFileDataUrl_(att.id) };
};

// ----------------------------------------------------------------- issues
API.issues = function (u, p) {
  var vis = visibleWorkshops(u).filter(function (w) { return !p.workshop || w === p.workshop; });
  var today = todayBkk();
  var rows = rows_('Issues').filter(function (i) {
    if (!(vis.indexOf(i.workshop) >= 0 || i.owner === u.username)) return false;
    if (p.status && i.status !== p.status) return false;
    if (p.team && i.team_id !== p.team) return false;
    if (p.owner && i.owner !== p.owner) return false;
    if (p.mine && i.owner !== u.username) return false;
    if (p.type && i.issue_type !== p.type) return false;
    if (p.due && !(i.due_date && i.due_date <= p.due)) return false;
    if (p.overdue && !(i.status !== 'closed' && i.due_date && i.due_date < today)) return false;
    if (p.repeat && !(Number(i.occurrences) > 1)) return false;
    if (p.gbr && gbrOf(i) !== p.gbr) return false;
    if (p.q && (i.issue_no + ' ' + i.title + ' ' + i.station).toLowerCase().indexOf(String(p.q).toLowerCase()) < 0) return false;
    return true;
  }).sort(function (a, b) { return Number(b.id) - Number(a.id); }).slice(0, 500);
  var teams = {};
  rows_('Teams').forEach(function (t) { teams[t.id] = t.name; });
  return { issues: rows.map(function (i) { var o = issueRowOut_(i); o.team_name = teams[i.team_id] || ''; return o; }) };
};
API.issue_get = function (u, p) {
  var i = loadIssue(p.issue_id);
  require_(canViewIssue(u, i));
  var a = i.audit_id ? blobGet('audit:' + i.audit_id) : null;
  var fu = a ? (a.followups || []).filter(function (f) { return f.issue_id === i.id; })[0] : null;
  var o = JSON.parse(JSON.stringify(i));
  o.status_th = ISSUE_STATUS_TH[i.status]; o.type_th = ISSUE_TYPE_TH[i.issue_type]; o.overdue = isOverdue(i); o.gbr = gbrOf(i);
  o.repeat = i.occurrences.length > 1; o.team_name = teamName_(i.team_id);
  return { issue: o, can_manage: canManageIssue(u, i), can_work: canWorkIssue(u, i), can_verify: canVerifyIssue(u, i),
           followup: fu ? { stage: fu.stage, audit_id: a.id, audit_no: a.audit_no } : null, gbr: settingGet('gbr_mapping') };
};
API.issue_save = function (u, p) {
  return withLock(function () {
    var i = loadIssue(p.issue_id);
    if (Number(p.lock_version) !== Number(i.lock_version)) throw new RuleError('ปัญหานี้ถูกแก้ไขโดยผู้อื่นระหว่างนี้ กรุณาโหลดใหม่แล้วบันทึกอีกครั้ง', 'conflict');
    var manage = canManageIssue(u, i), work = canWorkIssue(u, i), verify = canVerifyIssue(u, i);
    require_(manage || work || verify);
    var fields = [];
    if (work) fields = fields.concat(['containment', 'root_cause', 'permanent_action']);
    if (manage) fields = fields.concat(['title', 'description', 'priority', 'owner_name', 'due_date', 'owner']);
    if (verify) fields.push('effectiveness');
    var changed = [];
    fields.forEach(function (k) {
      if (!(k in (p.fields || {}))) return;
      var v = String(p.fields[k] || '');
      if (k === 'due_date' && v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new RuleError('รูปแบบวันที่ไม่ถูกต้อง');
      if (k === 'owner' && v && !find_('Users', 'username', v)) throw new RuleError('ไม่พบผู้ใช้');
      if ((i[k] || '') !== v) { i[k] = v; changed.push(k); }
    });
    if (i.owner && !i.owner_name) { var ur = find_('Users', 'username', i.owner); if (ur) i.owner_name = ur.name; }
    i.lock_version += 1;
    i.events.push({ action: 'updated', user: u.username, at: nowIso(), comment: changed.join(', ') || 'บันทึก' });
    saveIssue(i);
    return { lock_version: i.lock_version };
  });
};
API.issue_transition = function (u, p) {
  return withLock(function () {
    var i = loadIssue(p.issue_id);
    if (Number(p.lock_version) !== Number(i.lock_version)) throw new RuleError('ปัญหานี้ถูกแก้ไขโดยผู้อื่นระหว่างนี้ กรุณาโหลดใหม่', 'conflict');
    var to = p.to;
    if (to === 'closed' || (to === 'in_progress' && i.status === 'pending_verification')) {
      require_(canVerifyIssue(u, i));
      if (to === 'closed' && p.effectiveness) i.effectiveness = String(p.effectiveness);
    } else if (to === 'assigned' || to === 'reopened') require_(canManageIssue(u, i) || canVerifyIssue(u, i));
    else require_(canWorkIssue(u, i));
    transitionIssue_(i, u, to, p.comment || '');
    saveIssue(i);
    if (i.audit_id) { var a = loadAudit(i.audit_id); saveAudit(a); } // refresh open-issue counters
    return {};
  });
};

// ----------------------------------------------------------------- pending signatures
API.pending_signatures = function (u) {
  var vis = visibleWorkshops(u);
  var rows = [], recert = [];
  rows_('Audits').forEach(function (ai) {
    var mine = vis.indexOf(ai.workshop) >= 0 || (u.employee_code && ai.employee_code === u.employee_code);
    if (!mine) return;
    if ((ai.status === 'pending_signatures' || ai.status === 'amended') && Number(ai.missing_signatures) > 0) {
      var a = loadAudit(ai.id);
      rows.push({ audit: auditRowOut_(ai), missing: requiredSignatures(a).filter(function (r) { return r.required && !r.signature; }).map(function (r) { return r.label; }) });
    }
    if (Number(ai.recert_pending) > 0 && vis.indexOf(ai.workshop) >= 0) {
      var b = blobGet('audit:' + ai.id);
      b.followups.filter(function (f) { return f.stage !== 'recertified'; }).forEach(function (f) {
        recert.push({ audit_id: b.id, audit_no: b.audit_no, issue_id: f.issue_id, issue_no: f.issue_no, item_key: f.item_key, occurrence: f.occurrence,
                      stage_th: { open: 'รอดำเนินการ', trained: 'ฝึกอบรมแล้ว รอตรวจรับรองใหม่' }[f.stage] });
      });
    }
  });
  return { rows: rows, recert: recert };
};

// ----------------------------------------------------------------- standards (templates)
API.templates = function (u) {
  var list = rows_('Templates').filter(function (t) { return t.status !== 'deleted'; }).map(function (t) {
    var c = templateContent(t.id);
    var o = clean_(t);
    o.counts = { s1: c.s1.items.length, s2: c.s2.sections.map(function (s) { return s.code + s.items.length; }).join(' '), s3: c.s3.questions.length, s4: c.s4.cases.length };
    o.source_file = c.source_file;
    o.audits = rows_('Audits').filter(function (a) { return a.template_id === t.id; }).length;
    return o;
  }).sort(function (a, b) { return a.workshop < b.workshop ? -1 : a.workshop > b.workshop ? 1 : Number(b.version) - Number(a.version); });
  return { templates: list, pending: rows_('Pending').map(function (p) { var o = clean_(p); try { o.sources = JSON.parse(p.sources || '[]'); } catch (e) { o.sources = []; } return o; }),
           gbr: settingGet('gbr_mapping'), precedence: settingGet('standard_precedence'), is_admin: isAdmin(u) };
};
API.template_get = function (u, p) {
  var t = find_('Templates', 'id', p.template_id);
  if (!t) throw new RuleError('ไม่พบแม่แบบ');
  return { template: clean_(t), content: templateContent(t.id), is_admin: isAdmin(u) };
};
API.template_action = function (u, p) {
  require_(isAdmin(u));
  return withLock(function () {
    var t = find_('Templates', 'id', p.template_id);
    if (!t) throw new RuleError('ไม่พบแม่แบบ');
    if (p.action === 'new_draft') {
      if (rows_('Templates').some(function (x) { return x.workshop === t.workshop && x.status === 'draft'; })) throw new RuleError('มี Draft ของ Workshop นี้อยู่แล้ว');
      var id = addTemplate_(t.workshop, maxVersion_(t.workshop) + 1, 'draft', templateContent(t.id), t.source_sha, 'คัดลอกจาก v' + t.version, u.username);
      return { template_id: id };
    }
    if (p.action === 'edit_item') {
      if (t.status !== 'draft') throw new RuleError('แก้ไขได้เฉพาะ Draft');
      var c = templateContent(t.id);
      c.s1.items.forEach(function (i) { if (i.key === p.key) { i.text = p.text; i.allow_na = !!p.allow_na; } });
      c.s2.sections.forEach(function (s) { s.items.forEach(function (i) { if (i.key === p.key) i.text = p.text; }); });
      c.s3.questions.forEach(function (q) { if (q.key === p.key) { q.text = p.text; q.expected = p.expected; } });
      c.s4.cases.forEach(function (k) { if (k.key === p.key) { k.case = p.text; k.answer = p.expected; } });
      blobPut('tpl:' + t.id, c);
      return {};
    }
    if (p.action === 'publish') {
      if (t.status !== 'draft') throw new RuleError('เผยแพร่ได้เฉพาะ Draft');
      if (!String(p.change_note || '').trim()) throw new RuleError('ต้องระบุสิ่งที่เปลี่ยนแปลง');
      rows_('Templates').filter(function (x) { return x.workshop === t.workshop && x.status === 'published'; }).forEach(function (x) { update_('Templates', x, { status: 'retired', retired_at: nowIso() }); });
      update_('Templates', find_('Templates', 'id', t.id), { status: 'published', published_at: nowIso(), change_note: p.change_note });
      trail(u, 'template.publish', '', '', { workshop: t.workshop, version: t.version });
      return {};
    }
    if (p.action === 'retire') { update_('Templates', t, { status: 'retired', retired_at: nowIso() }); return {}; }
    if (p.action === 'delete_draft') {
      if (t.status !== 'draft' || rows_('Audits').some(function (a) { return a.template_id === t.id; })) throw new RuleError('ลบได้เฉพาะ Draft ที่ยังไม่ถูกใช้');
      update_('Templates', t, { status: 'deleted' });
      return {};
    }
    throw new RuleError('คำสั่งไม่ถูกต้อง');
  });
};
API.pending_resolve = function (u, p) {
  require_(isAdmin(u));
  if (!String(p.resolution || '').trim()) throw new RuleError('ต้องระบุผลการยืนยัน');
  return withLock(function () { var r = find_('Pending', 'code', p.code); update_('Pending', r, { status: 'resolved', resolution: p.resolution, resolved_by: u.username, resolved_at: nowIso() }); return {}; });
};
API.gbr_save = function (u, p) {
  require_(isAdmin(u));
  if (!(p.G && p.B && p.R)) throw new RuleError('ต้องระบุความหมายครบทั้ง G, B, R');
  var cur = settingGet('gbr_mapping') || {};
  settingPut('gbr_mapping', Object.assign(cur, { G: p.G, B: p.B, R: p.R }), u.username);
  return {};
};

// ----------------------------------------------------------------- reports / export data
API.reports = function (u, p) {
  var vis = visibleWorkshops(u).filter(function (w) { return !p.workshop || w === p.workshop; });
  return { audits: rows_('Audits').filter(function (a) {
    return vis.indexOf(a.workshop) >= 0 && a.status !== 'cancelled' && (!p.from || a.audit_date >= p.from) && (!p.to || a.audit_date <= p.to);
  }).sort(function (a, b) { return Number(b.id) - Number(a.id); }).slice(0, 300).map(auditRowOut_) };
};
/** Everything needed to print the 4 sheets or build the Excel workbook in the browser. */
API.audit_export = function (u, p) {
  var a = loadAudit(p.audit_id);
  require_(canViewAudit(u, auditIndexOf_(a)));
  var issues = issueIdsOfAudit_(a).map(function (id) { var i = loadIssue(id); return Object.assign(issueBrief(i), { occurrences: i.occurrences, containment: i.containment,
    permanent_action: i.permanent_action, root_cause: i.root_cause, effectiveness: i.effectiveness, owner_name: i.owner_name, sheet: i.sheet, item_key: i.item_key,
    priority: i.priority, description: i.description, closed_at: i.closed_at, verifier: i.verifier, n_attachments: i.attachments.length, type_th: ISSUE_TYPE_TH[i.issue_type] }); });
  var sigs = activeSignatures(a).map(function (s) { return Object.assign({}, s, { image: p.with_images ? readFileDataUrl_(s.file_id) : null, role_th: SIGNATURE_LABEL[s.role], signed_at_th: fmtBkk_(s.signed_at) }); });
  var all = a.signatures.map(function (s) { return Object.assign({}, s, { role_th: SIGNATURE_LABEL[s.role], signed_at_th: fmtBkk_(s.signed_at) }); });
  var doc = JSON.parse(JSON.stringify(a)); delete doc._snap; delete doc._items; delete doc.ops;
  return { audit: doc, snapshot: a._snap, issues: issues, signatures: sigs, all_signatures: all, team: teamName_(a.header.team_id),
           status_th: AUDIT_STATUS_TH[a.status], printed_at: fmtBkk_(nowIso()), gbr: settingGet('gbr_mapping'),
           timing: a.timings.filter(function (t) { return t.saved; }).map(function (t) { return timingSummary(t, a); }) };
};
API.issue_register = function (u, p) {
  var r = API.issues(u, p);
  return { issues: r.issues.map(function (row) {
    var i = loadIssue(row.id);
    return Object.assign(row, { audit_no: i.audit_no || '', model: i.model || '', employee_name: i.employee_name || '', description: i.description,
      containment: i.containment, root_cause: i.root_cause, permanent_action: i.permanent_action, effectiveness: i.effectiveness, verifier: i.verifier,
      priority: i.priority, n_attachments: i.attachments.length, occurrence_list: i.occurrences.map(function (o) { return o.occurrence; }).filter(Boolean).join(', ') });
  }) };
};

// ----------------------------------------------------------------- admin: users, teams, employees
API.admin_data = function (u) {
  require_(isAdmin(u));
  return {
    users: rows_('Users').map(function (x) { return { username: x.username, name: x.name, roles: JSON.parse(x.roles || '[]'), active: x.active !== 'false' }; }),
    teams: rows_('Teams').map(clean_), employees: rows_('Employees').map(clean_), workshops: rows_('Workshops').map(clean_), roles: ROLES
  };
};
API.admin_user_save = function (u, p) {
  require_(isAdmin(u));
  var username = String(p.username || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) throw new RuleError('ชื่อผู้ใช้ใช้ได้เฉพาะ a-z 0-9 . _ - (3–40 ตัว)');
  var roles = (p.roles || []).filter(function (r) { return ROLES.indexOf(r.role) >= 0 && r.workshop; });
  return withLock(function () {
    var row = find_('Users', 'username', username);
    var pin = null;
    if (!row) {
      pin = randomPin_();
      insert_('Users', newUserRow_(username, p.name || username, pin, roles, true));
    } else {
      if (username === u.username && !roles.some(function (r) { return r.role === 'admin'; })) throw new RuleError('ห้ามถอดสิทธิ์ admin ของตัวเอง');
      update_('Users', row, { name: p.name || row.name, roles: JSON.stringify(roles), active: p.active === false ? 'false' : 'true' });
    }
    trail(u, 'admin.user', '', '', { username: username, roles: roles });
    return { temp_pin: pin };
  });
};
API.admin_reset_pin = function (u, p) {
  require_(isAdmin(u));
  return withLock(function () {
    var row = find_('Users', 'username', p.username);
    if (!row) throw new RuleError('ไม่พบผู้ใช้');
    var pin = randomPin_(), salt = uuid_();
    update_('Users', row, { salt: salt, pin_hash: hashPin_(salt, pin), must_change_pin: 'true' });
    trail(u, 'admin.reset_pin', '', '', { username: p.username });
    return { temp_pin: pin };
  });
};
API.admin_team_save = function (u, p) {
  require_(isAdmin(u));
  if (!p.workshop || !p.name) throw new RuleError('ระบุ Workshop และชื่อทีม');
  return withLock(function () {
    if (p.id) { var r = find_('Teams', 'id', p.id); update_('Teams', r, { group: p.group || '', name: p.name, line: p.line || '', active: p.active === false ? 'false' : 'true' }); }
    else insert_('Teams', { id: String(nextNumber_('team-id')), workshop: p.workshop, group: p.group || '', name: p.name, line: p.line || '', active: 'true' });
    return {};
  });
};
/** Paste rows "code<TAB>name<TAB>workshop<TAB>team" copied from Excel. */
API.admin_employees_import = function (u, p) {
  require_(isAdmin(u));
  var lines = String(p.text || '').split(/\r?\n/).map(function (l) { return l.split(/\t|,/).map(function (x) { return x.trim(); }); }).filter(function (c) { return c[0] && c[1]; });
  var ws = rows_('Workshops').map(function (w) { return w.code; });
  return withLock(function () {
    var added = 0, updated = 0, errors = [];
    lines.forEach(function (c, n) {
      var code = c[0], name = c[1], w = c[2] || p.workshop, teamName = c[3] || '';
      if (ws.indexOf(w) < 0) { errors.push('บรรทัด ' + (n + 1) + ': ไม่พบ Workshop ' + w); return; }
      var team = teamName ? rows_('Teams').filter(function (t) { return t.workshop === w && t.name === teamName; })[0] : null;
      var row = find_('Employees', 'code', code);
      var rec = { code: code, name: name, workshop: w, team_id: team ? team.id : '', username: row ? row.username : '', active: 'true' };
      if (row) { update_('Employees', row, rec); updated++; } else { insert_('Employees', rec); added++; }
    });
    return { added: added, updated: updated, errors: errors };
  });
};
API.admin_employee_link = function (u, p) {
  require_(isAdmin(u));
  return withLock(function () {
    var row = find_('Employees', 'code', p.code);
    if (!row) throw new RuleError('ไม่พบพนักงาน');
    update_('Employees', row, { username: p.username || '', active: p.active === false ? 'false' : 'true' });
    return {};
  });
};

// ===== Code.gs =====
/**
 * CPS PJO Audit – Google Apps Script web app.
 * Entry points: doGet() serves the app, api() is the only function the browser calls,
 * setup() is run once by the owner from the Apps Script editor.
 */
var APP_NAME = 'CPS PJO Audit';

function doGet() {
  return HtmlService.createTemplateFromFile('Index').evaluate()
    .setTitle(APP_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

function include(name) { return HtmlService.createHtmlOutputFromFile(name).getContent(); }

/** Single RPC entry point. Returns a JSON string: {ok, data} or {ok:false, code, message}. */
function api(name, token, payload) {
  try {
    var fn = API[name];
    if (!fn) throw new RuleError('ไม่รู้จักคำสั่ง ' + name);
    var user = (name === 'login' || name === 'ping') ? null : requireSession(token);
    if (user && user.must_change_pin && name !== 'change_pin' && name !== 'me') throw new RuleError('กรุณาตั้ง PIN ใหม่ก่อนใช้งาน', 'must_change_pin');
    var data = fn(user, payload || {}, token);
    return JSON.stringify({ ok: true, data: data === undefined ? null : data });
  } catch (e) {
    if (e instanceof RuleError) return JSON.stringify(Object.assign({ ok: false, code: e.code, message: e.message }, e.extra));
    if (e instanceof Forbidden) return JSON.stringify({ ok: false, code: 'forbidden', message: e.message });
    console.error(name + ': ' + (e && e.stack || e));
    return JSON.stringify({ ok: false, code: 'server', message: 'เกิดข้อผิดพลาดในระบบ: ' + (e && e.message || e) });
  }
}

// =====================================================================================
// setup – run once from the editor (Run ▸ setup). Safe to run again.
// =====================================================================================
function setup() {
  var props = PropertiesService.getScriptProperties();
  var ss;
  if (props.getProperty(DB_PROP)) ss = SpreadsheetApp.openById(props.getProperty(DB_PROP));
  else {
    ss = SpreadsheetApp.create('CPS PJO Audit – Data');
    props.setProperty(DB_PROP, ss.getId());
  }
  createTables_(ss);
  db_._cache = ss;
  if (!props.getProperty(FOLDER_PROP)) {
    var folder = DriveApp.createFolder('CPS PJO Audit – Files (private)');
    props.setProperty(FOLDER_PROP, folder.getId());
  }
  var log = [];
  seedTemplates_(log);
  SEED_SETTINGS.forEach(function (s) { if (!find_('Settings', 'key', s.key)) settingPut(s.key, s.value, 'setup'); });
  SEED_PENDING.forEach(function (p) {
    var row = find_('Pending', 'code', p.code);
    if (!row) insert_('Pending', { code: p.code, title: p.title, detail: p.detail, workshops: p.workshops, sources: JSON.stringify(p.sources),
                                    status: p.resolution ? 'resolved' : 'pending', resolution: p.resolution || '', resolved_by: p.resolution ? 'setup' : '',
                                    resolved_at: p.resolution ? nowIso() : '' });
    else if (p.resolution && row.status === 'pending') update_('Pending', row, { status: 'resolved', resolution: p.resolution, resolved_by: 'setup', resolved_at: nowIso() });
  });
  var pin = null;
  if (!find_('Users', 'username', 'admin')) {
    pin = randomPin_();
    insert_('Users', newUserRow_('admin', 'ผู้ดูแลระบบ', pin, [{ role: 'admin', workshop: 'ALL' }], true));
  }
  var msg = 'ติดตั้งเสร็จ\nฐานข้อมูล: ' + ss.getUrl() + '\n' + log.join('\n') +
    (pin ? '\n\nบัญชีผู้ดูแลระบบ: admin\nPIN ชั่วคราว: ' + pin + '\n(ระบบจะให้ตั้ง PIN ใหม่ตอนเข้าครั้งแรก)' : '\nบัญชี admin มีอยู่แล้ว');
  Logger.log(msg);
  return msg;
}

/** Run from the editor if the admin PIN is lost: sets a new temporary PIN (see the execution log). */
function resetAdminPin() {
  var msg = withLock(function () {
    var row = find_('Users', 'username', 'admin');
    var pin = randomPin_(), salt = uuid_();
    if (!row) insert_('Users', newUserRow_('admin', 'ผู้ดูแลระบบ', pin, [{ role: 'admin', workshop: 'ALL' }], true));
    else update_('Users', row, { salt: salt, pin_hash: hashPin_(salt, pin), must_change_pin: 'true', active: 'true' });
    CacheService.getScriptCache().remove('fail:admin');
    trail(null, 'admin.reset_pin', '', '', { username: 'admin', via: 'editor' });
    return 'บัญชี admin\nPIN ชั่วคราว: ' + pin;
  });
  Logger.log(msg);
  return msg;
}

function seedTemplates_(log) {
  Object.keys(SEED_TEMPLATES).forEach(function (code) {
    var content = SEED_TEMPLATES[code];
    var sha = sha256_(canonical_(content));
    if (!find_('Workshops', 'code', code)) insert_('Workshops', { code: code, name: content.name, active: 'true' });
    var mine = rows_('Templates').filter(function (t) { return t.workshop === code; });
    if (!mine.length) {
      addTemplate_(code, 1, 'published', content, sha, 'นำเข้าจากแบบฟอร์มต้นฉบับ', 'setup');
      log.push(code + ': v1 published');
    } else if (!mine.some(function (t) { return t.source_sha === sha; })) {
      addTemplate_(code, maxVersion_(code) + 1, 'draft', content, sha, 'นำเข้าซ้ำจากไฟล์ต้นฉบับ (มีความต่าง) รอ Admin ตรวจและ Publish', 'setup');
      log.push(code + ': source changed -> new draft');
    }
  });
  SEED_CORRECTIONS.forEach(function (corr) {
    var mine = rows_('Templates').filter(function (t) { return t.workshop === corr.workshop; });
    var done = mine.some(function (t) { return (templateContent(t.id).corrections || []).some(function (c) { return c.code === corr.code; }); });
    if (done) return;
    var base = mine.filter(function (t) { return t.status === 'published'; }).sort(function (x, y) { return Number(y.version) - Number(x.version); })[0];
    if (!base) return;
    update_('Templates', base, { status: 'retired', retired_at: nowIso() });
    var v = maxVersion_(corr.workshop) + 1;
    addTemplate_(corr.workshop, v, 'published', applyCorrection_(templateContent(base.id), corr), base.source_sha, corr.change_note, 'setup');
    log.push(corr.workshop + ': ' + corr.code + ' -> v' + v + ' published');
  });
}
function maxVersion_(code) {
  return rows_('Templates').filter(function (t) { return t.workshop === code; }).reduce(function (m, t) { return Math.max(m, Number(t.version)); }, 0);
}
function addTemplate_(code, version, status, content, sha, note, by) {
  var id = String(nextNumber_('template-id'));
  blobPut('tpl:' + id, content);
  insert_('Templates', { id: id, workshop: code, version: String(version), status: status, source_sha: sha, change_note: note,
                         created_at: nowIso(), published_at: status === 'published' ? nowIso() : '', retired_at: '', created_by: by });
  return id;
}
function applyCorrection_(content, corr) {
  var c = JSON.parse(JSON.stringify(content));
  (corr.replace_in_titles || []).forEach(function (pair) {
    ['s1', 's2', 's3', 's4'].forEach(function (s) { c[s].title = c[s].title.split(pair[0]).join(pair[1]); });
  });
  var exp = corr.set_s3_expected || {};
  c.s3.questions.forEach(function (q) { if (exp[q.key]) { q.expected = exp[q.key]; q.expected_corrected_by = corr.code; } });
  c.corrections = (c.corrections || []).concat([{ code: corr.code, note: corr.change_note }]);
  return c;
}

