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
