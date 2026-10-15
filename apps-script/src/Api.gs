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
