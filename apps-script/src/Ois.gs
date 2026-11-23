/**
 * OIS List: one row per work position (station) of a workshop – the OIS name, the station number, the people who work
 * that position and whether it is an SC / CC position. Kept as master data for building the monthly plan automatically.
 */
function oisOut_(r) {
  var o = clean_(r);
  try { o.people = JSON.parse(r.people || '[]'); } catch (e) { o.people = []; }
  o.sc = r.sc_cc.split(',').indexOf('SC') >= 0; o.cc = r.sc_cc.split(',').indexOf('CC') >= 0;
  o.active = r.active !== 'false';
  return o;
}
function oisPeople_(workshop, list) {
  var seen = {}, out = [];
  (list || []).forEach(function (x) {
    var name = String(x && x.name !== undefined ? x.name : x || '').replace(/\s+/g, ' ').trim();
    if (!name || seen[normName_(name)]) return;
    seen[normName_(name)] = true;
    out.push({ code: (x && x.code) || matchEmployee_(workshop, name), name: name });
  });
  return out;
}
function oisStation_(s) { return String(s || '').replace(/\s+/g, '').toUpperCase(); }
function oisFlags_(p) { return [p.sc ? 'SC' : '', p.cc ? 'CC' : ''].filter(Boolean).join(','); }

API.ois_list = function (u, p) {
  var vis = visibleWorkshops(u).filter(function (w) { return !p.workshop || w === p.workshop; });
  var rows = rows_('OisList').filter(function (r) { return vis.indexOf(r.workshop) >= 0; })
    .sort(function (a, b) { return a.workshop < b.workshop ? -1 : a.workshop > b.workshop ? 1 : a.station < b.station ? -1 : 1; }).map(oisOut_);
  return { rows: rows, can_edit: visibleWorkshops(u).filter(function (w) { return canCreateAudit(u, w); }) };
};

API.ois_save = function (u, p) {
  var station = oisStation_(p.station), name = String(p.ois_name || '').trim();
  if (!rows_('Workshops').some(function (w) { return w.code === p.workshop; })) throw new RuleError('เลือก Workshop');
  require_(canCreateAudit(u, p.workshop));
  if (!station) throw new RuleError('ระบุสถานีงาน (หมายเลขตำแหน่งงาน)');
  if (!name) throw new RuleError('ระบุชื่อ OIS');
  return withLock(function () {
    var row = p.id ? find_('OisList', 'id', p.id) : null;
    if (p.id && !row) throw new RuleError('ไม่พบรายการ', 'not_found');
    if (row) require_(canCreateAudit(u, row.workshop));
    var dup = rows_('OisList').filter(function (r) { return r.workshop === p.workshop && r.station === station && (!row || r.id !== row.id); })[0];
    if (dup) throw new RuleError('สถานีงาน ' + station + ' มีใน OIS List ของ ' + p.workshop + ' แล้ว');
    var rec = { workshop: p.workshop, station: station, ois_name: name, people: JSON.stringify(oisPeople_(p.workshop, p.people)), sc_cc: oisFlags_(p),
                active: p.active === false ? 'false' : 'true', updated_by: u.username, updated_at: nowIso() };
    if (row) update_('OisList', row, rec);
    else { rec.id = String(nextNumber_('ois-id')); insert_('OisList', rec); }
    trail(u, row ? 'ois.update' : 'ois.add', '', '', { workshop: p.workshop, station: station });
    return { id: row ? row.id : rec.id };
  });
};

API.ois_delete = function (u, p) {
  return withLock(function () {
    var row = find_('OisList', 'id', p.id);
    if (!row) throw new RuleError('ไม่พบรายการ', 'not_found');
    require_(canCreateAudit(u, row.workshop));
    deleteRowsWhere_('OisList', function (r) { return r.id === row.id; });
    trail(u, 'ois.delete', '', '', { workshop: row.workshop, station: row.station });
    return {};
  });
};

/** p = { workshop, text } – lines "station<TAB>OIS name<TAB>people (separated by ; or /)<TAB>SC and/or CC", pasted from Excel. */
API.ois_import = function (u, p) {
  if (!rows_('Workshops').some(function (w) { return w.code === p.workshop; })) throw new RuleError('เลือก Workshop');
  require_(canCreateAudit(u, p.workshop));
  var lines = String(p.text || '').split(/\r?\n/).map(function (l) { return l.split('\t').map(function (x) { return x.trim(); }); }).filter(function (c) { return c[0]; });
  return withLock(function () {
    var added = 0, updated = 0, errors = [];
    lines.forEach(function (c, n) {
      var station = oisStation_(c[0]), name = c[1] || '';
      if (/^(สถานี|station|หมายเลข)/i.test(c[0]) && n === 0) return;  // header row
      if (!name) { errors.push('บรรทัด ' + (n + 1) + ': ไม่มีชื่อ OIS ของ ' + station); return; }
      var flags = String(c[3] || '').toUpperCase();
      var rec = { workshop: p.workshop, station: station, ois_name: name, people: JSON.stringify(oisPeople_(p.workshop, String(c[2] || '').split(/[;\/]/))),
                  sc_cc: oisFlags_({ sc: /\bSC\b/.test(flags), cc: /\bCC\b/.test(flags) }), active: 'true', updated_by: u.username, updated_at: nowIso() };
      var row = rows_('OisList').filter(function (r) { return r.workshop === p.workshop && r.station === station; })[0];
      if (row) { update_('OisList', row, rec); updated++; } else { rec.id = String(nextNumber_('ois-id')); insert_('OisList', rec); added++; }
    });
    trail(u, 'ois.import', '', '', { workshop: p.workshop, added: added, updated: updated });
    return { added: added, updated: updated, errors: errors };
  });
};

// ------------------------------------------------------------------ automatic monthly plan from the OIS List
/**
 * Builds one plan per working day (Mon–Fri, not a factory holiday) from the active positions of the OIS List, in the same row
 * shape as the import form, so the person reviews/edits it in the import screen and then imports it.
 * Order of positions (each position once per round, then a new round):
 *   1) positions with problems last month (or still-open issues)   2) positions not planned in the last 60 days (2-month coverage)
 *   3) SC / CC positions   4) the position planned the longest ago.
 * Person: whoever of the position's people was planned at it the longest ago. Team: the person's team in the employee list,
 * else the team used the last time that position was planned.
 */
var OIS_COVER_DAYS = 60;
function daysBetween_(a, b) { return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 864e5); }

API.plan_generate = function (u, p) {
  if (!rows_('Workshops').some(function (w) { return w.code === p.workshop; })) throw new RuleError('เลือก Workshop');
  require_(canCreateAudit(u, p.workshop));
  if (!/^\d{4}-\d{2}$/.test(p.month || '')) throw new RuleError('ระบุเดือนของแผน');
  var stations = rows_('OisList').filter(function (r) { return r.workshop === p.workshop && r.active !== 'false'; }).map(oisOut_);
  if (!stations.length) throw new RuleError('ยังไม่มีข้อมูลใน OIS List ของ ' + p.workshop + ' กรุณาเพิ่มสถานีงานก่อน');
  var n = daysInMonth_(p.month), hol = holidayMap_(), first = p.month + '-01';
  var py = Number(p.month.slice(0, 4)), pm = Number(p.month.slice(5, 7)) - 1;
  var prevMonth = pm ? py + '-' + pad2_(pm) : (py - 1) + '-12';
  // history of this workshop's plans: last planned date per position and per (position, person), team used last time
  var last = {}, lastPerson = {}, lastTeam = {}, taken = {};
  rows_('Plans').filter(function (x) { return x.workshop === p.workshop && x.cancelled !== 'true'; })
    .sort(function (a, b) { return a.planned_date < b.planned_date ? -1 : 1; }).forEach(function (x) {
      var st = oisStation_(x.station);
      if (x.planned_date.slice(0, 7) === p.month) { taken[x.planned_date] = x; }
      if (x.planned_date.slice(0, 7) <= p.month) {
        last[st] = x.planned_date; lastPerson[st + '|' + normName_(x.employee_name)] = x.planned_date; if (x.team_name) lastTeam[st] = x.team_name;
      }
    });
  // positions that had problems last month or still have an open issue
  var problem = {};
  rows_('Issues').filter(function (i) { return i.workshop === p.workshop && i.station; }).forEach(function (i) {
    if (i.status !== 'closed' || String(i.created_at).slice(0, 7) === prevMonth) problem[oisStation_(i.station)] = true;
  });
  var teamName = {}; rows_('Teams').forEach(function (t) { teamName[t.id] = t.name; });
  var empByCode = {}; rows_('Employees').forEach(function (e) { empByCode[e.code] = e; });
  var done = {}, res = { workshop: p.workshop, month: p.month, days: [], generated: 0, kept: 0, no_person: [], no_team: [], stations: stations.length };
  for (var d = 1; d <= n; d++) {
    var iso = p.month + '-' + pad2_(d), row = { day: d, team: '', name: '', station: '', level: '', problems: '', note: '' };
    res.days.push(row);
    if (taken[iso]) {  // already planned (kept as is so that importing with "replace" does not lose it)
      var t = taken[iso];
      row.team = t.team_name; row.name = t.employee_name; row.station = t.station; row.level = t.level; row.note = t.note; row.existing = true; res.kept++;
      continue;
    }
    if (isWeekend_(iso) || hol[iso]) continue;
    var pool = stations.filter(function (s) { return !done[s.station]; });
    if (!pool.length) { done = {}; pool = stations.slice(); }
    function key(s) {
      var l = last[s.station], overdue = !l || daysBetween_(l, iso) >= OIS_COVER_DAYS;
      return [problem[s.station] ? 0 : 1, overdue ? 0 : 1, s.sc || s.cc ? 0 : 1, l || '0000-00-00', s.station];
    }
    pool.sort(function (a, b) { var x = key(a), y = key(b); for (var i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1; return 0; });
    var s = pool[0], k = key(s);
    done[s.station] = true; last[s.station] = iso;
    var people = s.people.filter(function (x) { var e = x.code ? empByCode[x.code] : null; return !e || e.active !== 'false'; })
      .sort(function (a, b) { var la = lastPerson[s.station + '|' + normName_(a.name)] || '', lb = lastPerson[s.station + '|' + normName_(b.name)] || ''; return la < lb ? -1 : la > lb ? 1 : 0; });
    var who = people[0];
    row.station = s.station; row.name = who ? who.name : '';
    if (who) {
      lastPerson[s.station + '|' + normName_(who.name)] = iso;
      var emp = who.code ? empByCode[who.code] : null;
      row.team = (emp && emp.team_id && teamName[emp.team_id]) || lastTeam[s.station] || '';
    } else row.team = lastTeam[s.station] || '';
    if (!row.name) res.no_person.push(s.station);
    if (!row.team) res.no_team.push(s.station);
    row.note = 'สร้างอัตโนมัติ: ' + [problem[s.station] ? 'จุดมีปัญหา' : '', k[1] === 0 && !problem[s.station] ? 'ครบรอบ 2 เดือน' : '', s.sc ? 'SC' : '', s.cc ? 'CC' : ''].filter(Boolean).join(' · ');
    row.note = row.note.replace(/: $/, '');
    res.generated++;
  }
  return res;
};
