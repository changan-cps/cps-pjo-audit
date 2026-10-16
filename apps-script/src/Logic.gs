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
    missing_signatures: missing, created_at: a.created_at, updated_at: copy.updated_at, completed_at: a.completed_at || '',
    submitted_at: a.first_submitted_at || ''
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
    if (!a.first_submitted_at) a.first_submitted_at = a.submitted_at;  // end of the audit for on-time / minutes checks
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
