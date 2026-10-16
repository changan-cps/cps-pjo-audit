/**
 * Monthly PJO plan: import from the paper plan form (Excel / PDF are read in the browser and sent as rows),
 * calendar with status colours, changing a plan (e.g. the operator is on leave), starting an audit from a plan,
 * factory holidays and the daily audit time window (default 14:30–15:30, 60 minutes).
 */
var DEFAULT_AUDIT_WINDOW = { start: '14:30', end: '15:30', min_minutes: 60, grace: 5 };
var PLAN_STATUS = {
  ok: { label: 'ตรวจตรงเวลา', color: 'green' },
  short: { label: 'เวลาไม่ครบ', color: 'amber' },
  late: { label: 'ตรวจนอกเวลา', color: 'red' },
  missed: { label: 'ไม่ได้ตรวจ', color: 'red' },
  overdue: { label: 'ตรวจไม่เสร็จ', color: 'red' },
  in_progress: { label: 'กำลังตรวจ', color: 'blue' },
  today: { label: 'ตรวจวันนี้', color: 'today' },
  planned: { label: 'ตามแผน', color: 'grey' }
};
var WEEKDAY_TH = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];

// ---------------------------------------------------------------- settings
function auditWindow_() {
  var w = settingGet('audit_window') || {};
  return { start: w.start || DEFAULT_AUDIT_WINDOW.start, end: w.end || DEFAULT_AUDIT_WINDOW.end,
           min_minutes: Number(w.min_minutes || DEFAULT_AUDIT_WINDOW.min_minutes), grace: Number(w.grace === undefined ? DEFAULT_AUDIT_WINDOW.grace : w.grace) };
}
function holidays_() { return settingGet('factory_holidays') || []; }
function holidayMap_() { var m = {}; holidays_().forEach(function (h) { m[h.date] = h.name || 'วันหยุดโรงงาน'; }); return m; }
function canPlanAny_(u) { return isAdmin(u) || rows_('Workshops').some(function (w) { return canCreateAudit(u, w.code); }); }

// ---------------------------------------------------------------- date helpers (Asia/Bangkok)
function toMin_(hhmm) { var p = String(hhmm).split(':'); return Number(p[0]) * 60 + Number(p[1] || 0); }
function bkk_(iso, fmt) { return Utilities.formatDate(new Date(iso), 'Asia/Bangkok', fmt); }
function minOfDay_(iso) { return toMin_(bkk_(iso, 'HH:mm')); }
function weekday_(isoDate) { return new Date(isoDate + 'T00:00:00Z').getUTCDay(); }
function isWeekend_(isoDate) { var d = weekday_(isoDate); return d === 0 || d === 6; }
function daysInMonth_(month) { var p = month.split('-'); return new Date(Date.UTC(Number(p[0]), Number(p[1]), 0)).getUTCDate(); }
function pad2_(n) { return (n < 10 ? '0' : '') + n; }
function normName_(s) { return String(s || '').normalize('NFC').replace(/ํา/g, 'ำ').replace(/\s+/g, '').toLowerCase(); }

// ---------------------------------------------------------------- audit timing & plan status
/** Start = audit created, end = first "ส่งลงนาม". */
function auditTiming_(a, win) {
  if (!a || a.status === 'cancelled' || !a.created_at) return null;
  win = win || auditWindow_();
  var t = { started_at: a.created_at, finished_at: a.submitted_at || '', day: bkk_(a.created_at, 'yyyy-MM-dd'),
            start_hm: bkk_(a.created_at, 'HH:mm'), end_hm: a.submitted_at ? bkk_(a.submitted_at, 'HH:mm') : '' };
  if (!a.submitted_at) return t;
  t.minutes = Math.round((new Date(a.submitted_at) - new Date(a.created_at)) / 60000);
  var s = minOfDay_(a.created_at), e = minOfDay_(a.submitted_at), sameDay = bkk_(a.submitted_at, 'yyyy-MM-dd') === t.day;
  t.in_window = sameDay && s >= toMin_(win.start) - win.grace && e <= toMin_(win.end) + win.grace;
  t.full = t.minutes >= win.min_minutes;
  return t;
}

function planStatus_(plan, audits, today, nowMin, win) {
  var live = audits.filter(function (a) { return a.status !== 'cancelled'; })
    .sort(function (a, b) { return Number(b.id) - Number(a.id); });
  if (!live.length && plan.snapshot) {
    // the audit itself was cleared after CPS received it (Retention.gs) – keep showing its result
    var snap = JSON.parse(plan.snapshot);
    return { code: snap.code, label: PLAN_STATUS[snap.code].label, color: PLAN_STATUS[snap.code].color, timing: snap.timing, why: snap.why || [],
             audits: (snap.audits || []).map(function (x) { return Object.assign({}, x, { archived: true }); }), archived_at: snap.at };
  }
  var a = live[0], code, timing = a ? auditTiming_(a, win) : null;
  var afterWindow = plan.planned_date < today || (plan.planned_date === today && nowMin > toMin_(win.end) + win.grace);
  if (!a) code = afterWindow ? 'missed' : plan.planned_date === today ? 'today' : 'planned';
  else if (!a.submitted_at) code = afterWindow ? 'overdue' : 'in_progress';
  else if (timing.day !== plan.planned_date || !timing.in_window) code = 'late';
  else code = timing.full ? 'ok' : 'short';
  var why = [];
  if (timing && timing.minutes !== undefined) {
    if (timing.day !== plan.planned_date) why.push('ตรวจวันที่ ' + timing.day.split('-').reverse().join('/') + ' (แผน ' + plan.planned_date.split('-').reverse().join('/') + ')');
    if (!timing.in_window) why.push('เวลา ' + timing.start_hm + '–' + timing.end_hm + ' อยู่นอกช่วง ' + win.start + '–' + win.end);
    if (!timing.full) why.push('ใช้เวลา ' + timing.minutes + ' นาที (มาตรฐาน ' + win.min_minutes + ' นาที)');
  }
  return { code: code, label: PLAN_STATUS[code].label, color: PLAN_STATUS[code].color, timing: timing, why: why,
           audits: live.map(function (x) { return { id: x.id, audit_no: x.audit_no, status: x.status, status_th: AUDIT_STATUS_TH[x.status], timing: auditTiming_(x, win) }; }) };
}

function planOut_(pl, auditsByPlan, today, nowMin, win) {
  var o = clean_(pl);
  delete o.history; delete o.snapshot;
  o.history_count = pl.history ? JSON.parse(pl.history).length : 0;
  o.state = planStatus_(pl, auditsByPlan[pl.id] || [], today, nowMin, win);
  return o;
}

// ---------------------------------------------------------------- calendar
API.calendar = function (u, p) {
  var month = /^\d{4}-\d{2}$/.test(p.month || '') ? p.month : todayBkk().slice(0, 7);
  var vis = visibleWorkshops(u).filter(function (w) { return !p.workshop || w === p.workshop; });
  var win = auditWindow_(), today = todayBkk(), nowMin = minOfDay_(nowIso());
  var byPlan = {};
  rows_('Audits').forEach(function (a) { if (a.plan_id) (byPlan[a.plan_id] = byPlan[a.plan_id] || []).push(a); });
  var plans = rows_('Plans').filter(function (x) { return vis.indexOf(x.workshop) >= 0 && x.cancelled !== 'true' && x.planned_date.slice(0, 7) === month; })
    .sort(function (a, b) { return a.planned_date < b.planned_date ? -1 : a.planned_date > b.planned_date ? 1 : (a.workshop < b.workshop ? -1 : 1); })
    .map(function (pl) { var o = planOut_(pl, byPlan, today, nowMin, win); o.can_edit = canCreateAudit(u, pl.workshop); return o; });
  var summary = {};
  plans.forEach(function (pl) { summary[pl.state.code] = (summary[pl.state.code] || 0) + 1; });
  return { month: month, today: today, window: win, plans: plans, summary: summary, statuses: PLAN_STATUS,
           holidays: holidays_().filter(function (h) { return h.date.slice(0, 7) === month; }),
           can_plan: vis.filter(function (w) { return canCreateAudit(u, w); }), can_holiday: canPlanAny_(u), is_admin: isAdmin(u) };
};

API.plan_get = function (u, p) {
  var pl = find_('Plans', 'id', p.plan_id);
  if (!pl) throw new RuleError('ไม่พบแผน', 'not_found');
  require_(visibleWorkshops(u).indexOf(pl.workshop) >= 0);
  var win = auditWindow_(), byPlan = {};
  byPlan[pl.id] = rows_('Audits').filter(function (a) { return a.plan_id === pl.id; });
  var o = planOut_(pl, byPlan, todayBkk(), minOfDay_(nowIso()), win);
  o.history = pl.history ? JSON.parse(pl.history) : [];
  o.can_edit = canCreateAudit(u, pl.workshop);
  return o;
};

// ---------------------------------------------------------------- change a plan
var PLAN_EDIT_FIELDS = ['planned_date', 'team_name', 'station', 'employee_code', 'employee_name', 'level', 'note', 'auditor'];
API.plan_update = function (u, p) {
  return withLock(function () {
    var pl = find_('Plans', 'id', p.plan_id);
    if (!pl || pl.cancelled === 'true') throw new RuleError('ไม่พบแผน', 'not_found');
    require_(canCreateAudit(u, pl.workshop));
    var reason = String(p.reason || '').trim();
    if (!reason) throw new RuleError('ระบุเหตุผลการเปลี่ยนแผน เช่น พนักงานลา');
    var done = rows_('Audits').some(function (a) { return a.plan_id === pl.id && a.status !== 'cancelled' && a.submitted_at; }) ||
      (pl.snapshot && (JSON.parse(pl.snapshot).audits || []).some(function (a) { return a.timing && a.timing.finished_at; }));
    if (done) throw new RuleError('แผนนี้ตรวจและส่งลงนามแล้ว เปลี่ยนแผนไม่ได้');
    if (p.planned_date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(p.planned_date)) throw new RuleError('วันที่ไม่ถูกต้อง');
    var ch = {}, from = {}, to = {};
    if (p.employee_code && !p.employee_name) { var e = find_('Employees', 'code', p.employee_code); if (e) p.employee_name = e.name; }
    if (p.employee_name !== undefined && p.employee_code === undefined) p.employee_code = matchEmployee_(pl.workshop, p.employee_name);
    PLAN_EDIT_FIELDS.forEach(function (f) {
      if (p[f] === undefined) return;
      var v = String(p[f] || '').trim();
      if (v !== (pl[f] || '')) { from[f] = pl[f] || ''; to[f] = v; ch[f] = v; }
    });
    if (ch.team_name !== undefined) ch.team_id = teamIdFor_(pl.workshop, ch.team_name, false) || '';
    if (!Object.keys(to).length) throw new RuleError('ไม่มีการเปลี่ยนแปลง');
    ['team_name', 'station', 'employee_name'].forEach(function (f) {
      if ((f in ch ? ch[f] : pl[f]) === '') throw new RuleError('ต้องมีทีม ชื่อพนักงาน และหมายเลขตำแหน่งงานครบ');
    });
    var hist = pl.history ? JSON.parse(pl.history) : [];
    hist.push({ at: nowIso(), by: u.username, by_name: u.name, reason: reason, from: from, to: to });
    ch.history = JSON.stringify(hist); ch.updated_at = nowIso();
    ensureHeader_('Plans');
    update_('Plans', pl, ch);
    trail(u, 'plan.update', '', '', { plan: pl.id, reason: reason, to: to });
    return {};
  });
};

API.plan_cancel = function (u, p) {
  return withLock(function () {
    var pl = find_('Plans', 'id', p.plan_id);
    if (!pl) throw new RuleError('ไม่พบแผน', 'not_found');
    require_(canCreateAudit(u, pl.workshop));
    var hist = pl.history ? JSON.parse(pl.history) : [];
    hist.push({ at: nowIso(), by: u.username, by_name: u.name, reason: String(p.reason || 'ยกเลิกแผน'), from: {}, to: { cancelled: 'true' } });
    update_('Plans', pl, { cancelled: 'true', history: JSON.stringify(hist), updated_at: nowIso() });
    return {};
  });
};

// ---------------------------------------------------------------- start an audit from a plan
API.plan_start = function (u, p) {
  var pl = find_('Plans', 'id', p.plan_id);
  if (!pl || pl.cancelled === 'true') throw new RuleError('ไม่พบแผน', 'not_found');
  require_(canCreateAudit(u, pl.workshop));
  var open = rows_('Audits').filter(function (a) { return a.plan_id === pl.id && a.status !== 'cancelled'; })
    .sort(function (a, b) { return Number(b.id) - Number(a.id); })[0];
  if (open && !p.force_new) return { id: open.id, resumed: true };
  var t = rows_('Templates').filter(function (x) { return x.workshop === pl.workshop && x.status === 'published'; })[0];
  if (!t) throw new RuleError('Workshop ' + pl.workshop + ' ยังไม่มีแม่แบบ Published');
  var a = withLock(function () {
    return createAudit(u, t.id, { audit_date: todayBkk(), team_id: pl.team_id, station: pl.station, employee_code: pl.employee_code,
                                  employee_name: pl.employee_name }, pl.id);
  });
  return { id: a.id, resumed: false };
};

// ---------------------------------------------------------------- holidays & time window
API.holiday_save = function (u, p) {
  require_(canPlanAny_(u));
  return withLock(function () {
    var list = holidays_().filter(function (h) { return h.date !== p.date; });
    if (!p.remove) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date || '')) throw new RuleError('ระบุวันที่');
      list.push({ date: p.date, name: String(p.name || 'วันหยุดโรงงาน').trim() || 'วันหยุดโรงงาน' });
    }
    list.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    settingPut('factory_holidays', list, u.username);
    trail(u, p.remove ? 'holiday.remove' : 'holiday.add', '', '', { date: p.date, name: p.name || '' });
    return { holidays: list };
  });
};
API.holidays = function (u, p) {
  var y = String(p.year || todayBkk().slice(0, 4));
  return { holidays: holidays_().filter(function (h) { return h.date.slice(0, 4) === y; }), can_edit: canPlanAny_(u) };
};
API.window_save = function (u, p) {
  require_(isAdmin(u));
  if (!/^\d{1,2}:\d{2}$/.test(p.start || '') || !/^\d{1,2}:\d{2}$/.test(p.end || '') || toMin_(p.end) <= toMin_(p.start)) throw new RuleError('ช่วงเวลาไม่ถูกต้อง');
  var w = { start: p.start, end: p.end, min_minutes: Math.max(1, Number(p.min_minutes) || 60), grace: Math.max(0, Number(p.grace) || 0) };
  withLock(function () { settingPut('audit_window', w, u.username); });
  trail(u, 'settings.audit_window', '', '', w);
  return { window: w };
};

// ---------------------------------------------------------------- import the monthly plan form
function teamIdFor_(workshop, name, create) {
  var key = String(name || '').trim().toLowerCase();
  if (!key) return '';
  var t = rows_('Teams').filter(function (x) { return x.workshop === workshop && String(x.name).trim().toLowerCase() === key; })[0];
  if (t) return t.id;
  if (!create) return '';
  var id = String(nextNumber_('team-id'));
  insert_('Teams', { id: id, workshop: workshop, group: '', name: String(name).trim(), line: '', active: 'true' });
  return id;
}
function matchEmployee_(workshop, name) {
  var k = normName_(name);
  if (!k) return '';
  var hits = rows_('Employees').filter(function (e) { return e.workshop === workshop && e.active !== 'false' && normName_(e.name) === k; });
  return hits.length === 1 ? hits[0].code : '';
}

/**
 * p = { workshop, month: 'YYYY-MM', days: [{ day, team, name, station, level, problems, note, holiday }], replace, dry_run, source }
 * Every working day (Mon–Fri that is not a factory holiday) must have team + employee name + position number.
 * Saturdays, Sundays and factory holidays may be left empty.
 */
API.plan_import = function (u, p) {
  if (!rows_('Workshops').some(function (w) { return w.code === p.workshop; })) throw new RuleError('เลือก Workshop');
  require_(canCreateAudit(u, p.workshop));
  if (!/^\d{4}-\d{2}$/.test(p.month || '')) throw new RuleError('ระบุเดือนของแผน');
  var hol = holidayMap_(), n = daysInMonth_(p.month), byDay = {};
  (p.days || []).forEach(function (d) { if (d && d.day >= 1 && d.day <= n) byDay[Number(d.day)] = d; });
  var res = { workshop: p.workshop, month: p.month, days: [], errors: 0, warnings: 0, working_days: 0, planned: 0, new_teams: [], new_holidays: [] };
  var stationDays = {}, teamsSeen = {};
  for (var d = 1; d <= n; d++) {
    var iso = p.month + '-' + pad2_(d), src = byDay[d] || {};
    var r = { day: d, date: iso, weekday: WEEKDAY_TH[weekday_(iso)], weekend: isWeekend_(iso), holiday_name: hol[iso] || '', marked_holiday: !!src.holiday && !hol[iso],
              team: String(src.team || '').trim(), name: String(src.name || '').replace(/\s+/g, ' ').trim(), station: String(src.station || '').replace(/\s+/g, '').trim(),
              level: String(src.level || '').trim().toUpperCase(), problems: String(src.problems || '').trim(), note: String(src.note || '').trim(), messages: [] };
    var off = r.weekend || !!r.holiday_name || r.marked_holiday;
    var has = !!(r.team || r.name || r.station);
    if (!off) res.working_days++;
    if (r.marked_holiday) res.new_holidays.push(iso);
    if (has) {
      var miss = [];
      if (!r.team) miss.push('ทีม');
      if (!r.name) miss.push('ชื่อพนักงาน');
      if (!r.station) miss.push('หมายเลขตำแหน่งงาน');
      if (miss.length) r.messages.push({ type: 'error', text: 'ขาด: ' + miss.join(', ') });
      else res.planned++;
      if (off) r.messages.push({ type: 'info', text: (r.holiday_name || (r.marked_holiday ? 'วันหยุดโรงงาน' : 'วันเสาร์/อาทิตย์')) + ' แต่มีแผน — นำเข้าตามไฟล์' });
      if (r.station && !/^[A-Z]{2,3}\d{2,3}[A-Z]?$/.test(r.station)) r.messages.push({ type: 'warn', text: 'หมายเลขตำแหน่งงาน "' + r.station + '" รูปแบบผิดปกติ' });
      if (r.level && ['A', 'B', 'C'].indexOf(r.level) < 0) r.messages.push({ type: 'warn', text: 'ระดับตำแหน่งงานควรเป็น A, B หรือ C' });
      if (r.name) { r.employee_code = matchEmployee_(p.workshop, r.name); if (!r.employee_code) r.messages.push({ type: 'info', text: 'ไม่พบชื่อในรายชื่อพนักงาน — บันทึกเป็นชื่อ' }); }
      if (r.team) { r.team_id = teamIdFor_(p.workshop, r.team, false); if (!r.team_id && !teamsSeen[r.team.toLowerCase()]) { teamsSeen[r.team.toLowerCase()] = true; res.new_teams.push(r.team); } }
      if (r.station) (stationDays[r.station] = stationDays[r.station] || []).push(d);
    } else if (!off) {
      r.messages.push({ type: 'error', text: 'วันทำงานยังไม่ได้ลงแผน — ถ้าเป็นวันหยุดโรงงานให้ติ๊ก "วันหยุด"' });
    }
    res.days.push(r);
  }
  Object.keys(stationDays).forEach(function (st) {
    if (stationDays[st].length > 1) stationDays[st].forEach(function (d) {
      res.days[d - 1].messages.push({ type: 'warn', text: st + ' อยู่ในแผนซ้ำ (วันที่ ' + stationDays[st].join(', ') + ')' });
    });
  });
  res.days.forEach(function (r) {
    r.status = r.messages.some(function (m) { return m.type === 'error'; }) ? 'error' : r.messages.some(function (m) { return m.type === 'warn'; }) ? 'warn'
      : (r.team || r.name || r.station) ? 'ok' : 'off';
    if (r.status === 'error') res.errors++;
    if (r.status === 'warn') res.warnings++;
  });
  var auditPlanIds = {};
  rows_('Audits').forEach(function (a) { if (a.plan_id && a.status !== 'cancelled') auditPlanIds[a.plan_id] = true; });
  var existing = rows_('Plans').filter(function (x) { return x.workshop === p.workshop && x.cancelled !== 'true' && x.planned_date.slice(0, 7) === p.month; });
  res.existing = { total: existing.length, with_audit: existing.filter(function (x) { return auditPlanIds[x.id]; }).length };
  if (p.dry_run) return res;

  if (res.errors) throw new RuleError('ยังมี ' + res.errors + ' วันที่ข้อมูลไม่ครบ กรุณาแก้ไขก่อนนำเข้า', 'invalid', { result: res });
  if (!res.planned) throw new RuleError('ไม่พบแผนในไฟล์');
  return withLock(function () {
    ensureHeader_('Plans');
    if (res.new_holidays.length) {
      var list = holidays_();
      res.new_holidays.forEach(function (iso) { list.push({ date: iso, name: 'วันหยุดโรงงาน' }); });
      list.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
      settingPut('factory_holidays', list, u.username);
    }
    var kept = 0, replaced = 0;
    if (p.replace) existing.forEach(function (x) {
      if (auditPlanIds[x.id]) { kept++; return; }
      var hist = x.history ? JSON.parse(x.history) : [];
      hist.push({ at: nowIso(), by: u.username, by_name: u.name, reason: 'แทนที่ด้วยแผนนำเข้าใหม่', from: {}, to: { cancelled: 'true' } });
      update_('Plans', x, { cancelled: 'true', history: JSON.stringify(hist), updated_at: nowIso() });
      replaced++;
    });
    var batch = 'IMP-' + bkk_(nowIso(), 'yyyyMMdd-HHmmss'), created = 0;
    res.days.forEach(function (r) {
      if (!(r.team && r.name && r.station)) return;
      insert_('Plans', { id: String(nextNumber_('plan-id')), workshop: p.workshop, team_id: teamIdFor_(p.workshop, r.team, true), station: r.station,
                         employee_code: r.employee_code || '', planned_date: r.date, auditor: '', note: r.note, cancelled: 'false',
                         created_by: u.username, created_at: nowIso(), team_name: r.team, employee_name: r.name, level: r.level,
                         problems: r.problems, batch_id: batch, source: String(p.source || '').slice(0, 200), history: '', updated_at: '' });
      created++;
    });
    trail(u, 'plan.import', '', '', { workshop: p.workshop, month: p.month, created: created, replaced: replaced, kept: kept, source: p.source || '' });
    return { created: created, replaced: replaced, kept: kept, batch_id: batch };
  });
};
