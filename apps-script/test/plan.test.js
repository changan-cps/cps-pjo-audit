'use strict';
// Monthly plan import, factory holidays, calendar status colours, plan changes, audit timing.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createSim } = require('../sim/gas-sim');

const SRC = path.join(__dirname, '..', 'src');
// Body Shop, October 2026 (1 Oct = Thursday) – positions from the paper form
const FORM = { 1: ['FA1', 'FA07'], 2: ['FA2', 'FA06'], 5: ['EH', 'EH04'], 6: ['BS', 'BS23'], 7: ['MB', 'MB09'], 8: ['FA1', 'FA08'], 9: ['FA2', 'FA19'],
  12: ['EH', 'FR02'], 13: ['BS', 'BS27'], 14: ['MB', 'UB02'], 15: ['FA1', 'FA09'], 16: ['FA2', 'FA12'], 19: ['EH', 'FR01'], 20: ['BS', 'BS21'],
  21: ['MB', 'UB05'], 22: ['FA1', 'FA10'], 23: ['FA2', 'FA13'], 26: ['EH', 'EH01'], 27: ['BS', 'BS24'], 28: ['MB', 'MB01'], 29: ['FA1', 'FA02'], 30: ['FA2', 'FA14'] };
function formDays(over) {
  const days = Object.keys(FORM).map(d => ({ day: Number(d), team: FORM[d][0], name: 'พนักงาน ' + d, station: FORM[d][1], level: 'A' }));
  (over || []).forEach(o => { const i = days.findIndex(x => x.day === o.day); if (i >= 0) Object.assign(days[i], o); else days.push(o); });
  return days;
}

function boot() {
  const sim = createSim(SRC, { quietErrors: true });
  const pin = /PIN ชั่วคราว: (\d+)/.exec(sim.call('setup'))[1];
  const ok = (name, token, p) => { const x = sim.api(name, token, p); assert.ok(x.ok, name + ': ' + JSON.stringify(x).slice(0, 400)); return x.data; };
  const admin = ok('login', null, { username: 'admin', pin }).token;
  ok('change_pin', admin, { new_pin: '246810' });
  ok('admin_employees_import', admin, { text: 'B05\tพนักงาน 5\tBS\t\nB06\tพนักงาน  6\tBS\t' });
  const tmp = ok('admin_user_save', admin, { username: 'bsa', name: 'BS Auditor', roles: [{ role: 'auditor', workshop: 'BS' }] }).temp_pin;
  const t = ok('login', null, { username: 'bsa', pin: tmp }).token;
  ok('change_pin', t, { new_pin: '135790' });
  const gtmp = ok('admin_user_save', admin, { username: 'gaa', name: 'GA Auditor', roles: [{ role: 'auditor', workshop: 'GA' }] }).temp_pin;
  const g = ok('login', null, { username: 'gaa', pin: gtmp }).token;
  ok('change_pin', g, { new_pin: '135790' });
  return { sim, ok, admin, bsa: t, gaa: g };
}

test('import check: every working day needs team + name + position; weekends/holidays may be empty', () => {
  const env = boot();
  const r = env.ok('plan_import', env.bsa, { workshop: 'BS', month: '2026-10', dry_run: true,
    days: formDays([{ day: 8, station: '' }, { day: 14, name: '' }, { day: 21, team: '', name: '', station: '' }, { day: 2, station: 'FaA18' }, { day: 27, station: 'BS23' }]) });
  const byDay = d => r.days[d - 1];
  assert.equal(r.days.length, 31);
  assert.equal(r.working_days, 22);
  assert.equal(r.errors, 3);
  assert.match(byDay(8).messages.map(m => m.text).join(), /หมายเลขตำแหน่งงาน/);
  assert.match(byDay(14).messages.map(m => m.text).join(), /ชื่อพนักงาน/);
  assert.match(byDay(21).messages.map(m => m.text).join(), /ยังไม่ได้ลงแผน/);
  assert.equal(byDay(3).status, 'off');           // Saturday, empty → fine
  assert.equal(byDay(4).weekday, 'อา.');
  assert.equal(byDay(2).status, 'warn');          // odd position number
  assert.match(byDay(6).messages.map(m => m.text).join(), /BS23 อยู่ในแผนซ้ำ \(วันที่ 6, 27\)/);
  assert.equal(byDay(5).employee_code, 'B05');    // matched by name
  assert.equal(byDay(6).employee_code, 'B06');    // spaces ignored
  assert.deepEqual(r.new_teams.sort(), ['BS', 'EH', 'FA1', 'FA2', 'MB']);
  // committing with errors is refused and nothing is written
  const bad = env.sim.api('plan_import', env.bsa, { workshop: 'BS', month: '2026-10', days: formDays([{ day: 8, station: '' }]) });
  assert.equal(bad.code, 'invalid');
  assert.equal(env.ok('calendar', env.bsa, { month: '2026-10' }).plans.length, 0);
  // other workshop's auditor cannot import Body Shop
  assert.equal(env.sim.api('plan_import', env.gaa, { workshop: 'BS', month: '2026-10', dry_run: true, days: [] }).code, 'forbidden');
});

test('import: factory holiday ticked in the check, teams created, re-import replaces plans that were not audited', () => {
  const env = boot();
  env.ok('holiday_save', env.bsa, { date: '2026-10-13', name: 'วันคล้ายวันสวรรคต ร.9' });
  const days = formDays([{ day: 13, team: '', name: '', station: '' }, { day: 21, team: '', name: '', station: '', holiday: true }]);
  const chk = env.ok('plan_import', env.bsa, { workshop: 'BS', month: '2026-10', dry_run: true, days });
  assert.equal(chk.errors, 0);
  assert.equal(chk.days[12].holiday_name, 'วันคล้ายวันสวรรคต ร.9');
  assert.deepEqual(chk.new_holidays, ['2026-10-21']);
  const res = env.ok('plan_import', env.bsa, { workshop: 'BS', month: '2026-10', days, source: 'BS-Oct.xlsx' });
  assert.equal(res.created, 20);
  assert.deepEqual(env.ok('holidays', env.bsa, { year: 2026 }).holidays.map(h => h.date), ['2026-10-13', '2026-10-21']);
  assert.equal(env.ok('lookups', env.bsa).teams.filter(t => t.workshop === 'BS').length, 5);
  const cal = env.ok('calendar', env.bsa, { month: '2026-10', workshop: 'BS' });
  assert.equal(cal.plans.length, 20);
  assert.equal(cal.holidays.length, 2);
  const p5 = cal.plans.find(p => p.planned_date === '2026-10-05');
  assert.equal(p5.team_name, 'EH'); assert.equal(p5.station, 'EH04'); assert.equal(p5.employee_name, 'พนักงาน 5'); assert.equal(p5.level, 'A');
  // audit one plan, then re-import with "replace": the audited plan stays, the rest are replaced
  env.ok('plan_start', env.bsa, { plan_id: p5.id });
  const again = env.ok('plan_import', env.bsa, { workshop: 'BS', month: '2026-10', days, replace: true });
  assert.deepEqual([again.created, again.replaced, again.kept], [20, 19, 1]);
  assert.equal(env.ok('calendar', env.bsa, { month: '2026-10', workshop: 'BS' }).plans.length, 21);
});

test('calendar colours + audit time window 14:30–15:30 and 60 minutes', () => {
  const env = boot();
  env.ok('plan_import', env.bsa, { workshop: 'BS', month: '2026-10', days: formDays() });
  const plan = d => env.ok('calendar', env.bsa, { month: '2026-10' }).plans.find(p => p.planned_date === '2026-10-' + String(d).padStart(2, '0'));
  const doAudit = (day, startHM, endHM) => {
    env.sim.setNow(`2026-10-${String(day).padStart(2, '0')}T${startHM}:00+07:00`);
    const { id } = env.ok('plan_start', env.bsa, { plan_id: plan(day).id });
    env.ok('ops', env.bsa, { audit_id: id, ops: [{ op_id: 'm' + day, type: 'mark', item_key: 'S1-1', occurrence: 1, value: 'pass' },
      { op_id: 'h' + day, type: 'header', fields: { ois_current: 'yes' } }] });
    if (endHM) { env.sim.setNow(`2026-10-${String(day).padStart(2, '0')}T${endHM}:00+07:00`); env.ok('submit', env.bsa, { audit_id: id }); }
    return id;
  };
  const id5 = doAudit(5, '14:30', '15:28');   // in window, 58 min → minutes short
  doAudit(6, '14:29', '15:31');               // in window (5 min grace), 62 min → ok
  doAudit(7, '15:00', '16:10');               // past 15:30 → late (red)
  doAudit(8, '14:35', null);                  // started, never submitted
  env.sim.setNow('2026-10-09T16:00:00+07:00');
  const st = d => plan(d).state;
  assert.equal(st(1).code, 'missed'); assert.equal(st(1).color, 'red');
  assert.equal(st(5).code, 'short'); assert.equal(st(5).timing.minutes, 58); assert.match(st(5).why.join(), /58 นาที/);
  assert.equal(st(6).code, 'ok'); assert.equal(st(6).color, 'green');
  assert.equal(st(7).code, 'late'); assert.match(st(7).why.join(), /15:00–16:10/);
  assert.equal(st(8).code, 'overdue'); assert.equal(st(8).color, 'red');
  assert.equal(st(9).code, 'missed');         // today, after 15:35 and nothing done
  assert.equal(st(12).code, 'planned');
  // audit done on a later day than planned is red too
  env.sim.setNow('2026-10-13T14:30:00+07:00');
  const { id } = env.ok('plan_start', env.bsa, { plan_id: plan(12).id });
  env.ok('ops', env.bsa, { audit_id: id, ops: [{ op_id: 'x1', type: 'mark', item_key: 'S1-1', occurrence: 1, value: 'pass' }, { op_id: 'x2', type: 'header', fields: { ois_current: 'yes' } }] });
  env.sim.setNow('2026-10-13T15:30:00+07:00');
  env.ok('submit', env.bsa, { audit_id: id });
  assert.equal(st(12).code, 'late'); assert.match(st(12).why.join(), /แผน 12\/10\/2026/);
  // starting again from the same plan resumes the existing audit
  env.sim.setNow('2026-10-08T15:00:00+07:00');
  assert.deepEqual(env.ok('plan_start', env.bsa, { plan_id: plan(5).id }), { id: id5, resumed: true });
  // admin changes the window
  env.ok('window_save', env.admin, { start: '14:00', end: '15:30', min_minutes: 55, grace: 0 });
  env.sim.setNow('2026-10-09T16:00:00+07:00');
  assert.equal(st(5).code, 'ok');
  assert.equal(env.sim.api('window_save', env.bsa, { start: '14:00', end: '15:00' }).code, 'forbidden');
  env.sim.setNow(null);
});

test('change plan: reason required, history kept, team/name/position stay complete, done plans locked', () => {
  const env = boot();
  env.ok('plan_import', env.bsa, { workshop: 'BS', month: '2026-10', days: formDays() });
  const cal = () => env.ok('calendar', env.bsa, { month: '2026-10' }).plans;
  const p = cal().find(x => x.planned_date === '2026-10-20');
  assert.match(env.sim.api('plan_update', env.bsa, { plan_id: p.id, station: 'BS22' }).message, /เหตุผล/);
  assert.match(env.sim.api('plan_update', env.bsa, { plan_id: p.id, employee_name: '', reason: 'ลา' }).message, /ครบ/);
  env.ok('plan_update', env.bsa, { plan_id: p.id, station: 'BS22', employee_name: 'พนักงาน 6', reason: 'พนักงานเดิมลาป่วย' });
  const g = env.ok('plan_get', env.bsa, { plan_id: p.id });
  assert.equal(g.station, 'BS22'); assert.equal(g.employee_code, 'B06');
  assert.equal(g.history.length, 1);
  assert.deepEqual(g.history[0].from, { station: 'BS21', employee_code: '', employee_name: 'พนักงาน 20' });
  assert.equal(g.history[0].reason, 'พนักงานเดิมลาป่วย');
  // move to another day
  env.ok('plan_update', env.bsa, { plan_id: p.id, planned_date: '2026-10-21', reason: 'ไลน์หยุด' });
  assert.equal(env.ok('plan_get', env.bsa, { plan_id: p.id }).planned_date, '2026-10-21');
  // GA auditor cannot change Body Shop plans
  assert.equal(env.sim.api('plan_update', env.gaa, { plan_id: p.id, station: 'X', reason: 'x' }).code, 'forbidden');
  // after the audit is submitted the plan is locked
  const { id } = env.ok('plan_start', env.bsa, { plan_id: p.id });
  env.ok('ops', env.bsa, { audit_id: id, ops: [{ op_id: 'a', type: 'mark', item_key: 'S1-1', occurrence: 1, value: 'pass' }, { op_id: 'b', type: 'header', fields: { ois_current: 'yes' } }] });
  env.ok('submit', env.bsa, { audit_id: id });
  assert.match(env.sim.api('plan_update', env.bsa, { plan_id: p.id, station: 'BS20', reason: 'x' }).message, /ตรวจและส่งลงนามแล้ว/);
  // the audit header was filled from the plan
  const st = env.ok('state', env.bsa, { audit_id: id }).state;
  assert.equal(st.status, 'pending_signatures');
  // cancel a plan
  const q = cal().find(x => x.planned_date === '2026-10-22');
  env.ok('plan_cancel', env.bsa, { plan_id: q.id, reason: 'ไลน์หยุดผลิต' });
  assert.equal(cal().some(x => x.id === q.id), false);
});

test('retention: only data older than 2 days that CPS already received is removed; plans and their colours stay', () => {
  const env = boot();
  env.ok('plan_import', env.bsa, { workshop: 'BS', month: '2026-10', days: formDays() });
  const plan = d => env.ok('calendar', env.bsa, { month: '2026-10' }).plans.find(p => p.planned_date === '2026-10-' + String(d).padStart(2, '0'));
  // audit on 5 Oct with a × finding (creates an issue) and a photo, submitted on time
  env.sim.setNow('2026-10-05T14:30:00+07:00');
  const { id } = env.ok('plan_start', env.bsa, { plan_id: plan(5).id });
  env.ok('ops', env.bsa, { audit_id: id, ops: [{ op_id: 'r1', type: 'mark', item_key: 'S1-1', occurrence: 1, value: 'pass' }, { op_id: 'r2', type: 'header', fields: { ois_current: 'yes' } }] });
  env.sim.setNow('2026-10-05T15:31:00+07:00');
  env.ok('submit', env.bsa, { audit_id: id });
  const before = plan(5).state; assert.equal(before.code, 'ok');
  // nothing is removed while CPS has not pulled
  env.sim.setNow('2026-10-09T10:00:00+07:00');
  assert.match(env.sim.call('runRetention_', true).skipped, /CPS ยังไม่เคยดึง/);
  // CPS pulls twice (second pull confirms the first one was received)
  env.sim.call('cpsRecordPull_', '2026-10-08T02:00:00.000Z');
  env.sim.call('cpsRecordPull_', '2026-10-08T14:00:00.000Z');
  // a fresh audit today must survive
  env.sim.setNow('2026-10-09T14:30:00+07:00');
  const fresh = env.ok('plan_start', env.bsa, { plan_id: plan(9).id }).id;
  env.sim.setNow('2026-10-09T16:00:00+07:00');
  const r = env.sim.call('runRetention_', true);
  assert.equal(r.audits, 1); assert.ok(r.plans_snapshot >= 1);
  assert.equal(env.sim.api('state', env.bsa, { audit_id: id }).code, 'not_found');
  assert.ok(env.ok('state', env.bsa, { audit_id: fresh }).state);
  // the plan still shows its result from the snapshot, linked audit marked as archived
  const after = plan(5).state;
  assert.equal(after.code, 'ok'); assert.equal(after.timing.minutes, 61);
  assert.equal(after.audits[0].archived, true);
  // archived + submitted plans stay locked
  assert.match(env.sim.api('plan_update', env.bsa, { plan_id: plan(5).id, station: 'X1', reason: 'x' }).message, /ตรวจและส่งลงนามแล้ว/);
  // plans are all still there
  assert.equal(env.ok('calendar', env.bsa, { month: '2026-10' }).plans.length, 22);
  // runs at most once a day unless forced
  assert.equal(env.sim.call('runRetention_', false).skipped, 'ran recently');
  env.sim.setNow(null);
});

test('CPS export: key required, full standard-form data, since/ack, then retention', () => {
  const env = boot();
  env.ok('plan_import', env.bsa, { workshop: 'BS', month: '2026-10', days: formDays() });
  const plan5 = env.ok('calendar', env.bsa, { month: '2026-10' }).plans.find(p => p.planned_date === '2026-10-05');
  env.sim.setNow('2026-10-05T14:30:00+07:00');
  const { id } = env.ok('plan_start', env.bsa, { plan_id: plan5.id });
  env.ok('ops', env.bsa, { audit_id: id, ops: [{ op_id: 'c1', type: 'mark', item_key: 'S1-1', occurrence: 1, value: 'pass' }, { op_id: 'c2', type: 'header', fields: { ois_current: 'yes' } }] });
  env.sim.setNow('2026-10-05T15:30:00+07:00');
  env.ok('submit', env.bsa, { audit_id: id });
  assert.equal(env.sim.get({ cps: 'export', key: 'x' }).body.code, 'not_setup');
  const key = /\n([0-9a-f]{40})\n/.exec(env.sim.call('cpsExportSetup'))[1];
  assert.equal(env.sim.get({ cps: 'export', key: 'wrong' }).body.code, 'forbidden');
  assert.equal(env.sim.get({ action: 'anything' }).body.code, 'key_required');     // any call with parameters answers JSON
  const ping = env.sim.get({ action: 'test', key }).body;
  assert.equal(ping.ok, true); assert.equal(ping.service, 'cps-pjo-audit'); assert.equal(ping.counts.audits, 1);
  const log = env.sim.call('cpsLastRequests');
  assert.ok(log.some(r => r.params.includes('key=***') && r.result === 'ok'));
  assert.ok(!JSON.stringify(log).includes(key), 'key never logged');
  const r1 = env.sim.get({ cps: 'export', key });
  assert.equal(r1.mime, 'application/json');
  const d = r1.body;
  assert.equal(d.ok, true); assert.equal(d.schema, 'cps-pjo-export/1');
  assert.equal(d.plans.length, 22);
  assert.equal(d.audits.length, 1);
  const a = d.audits[0];
  assert.equal(a.index.station, 'EH04'); assert.equal(a.audit.marks['S1-1|1'].v, 'pass');
  assert.ok(a.snapshot.s1 && a.snapshot.s2 && a.snapshot.s3 && a.snapshot.s4, 'standard form (4 sheets) of the template version'); assert.equal(a.snapshot.form_code, 'CATH-CPS009-B02');
  assert.equal(a.audit_time.minutes, 60); assert.equal(a.plan.planned_date, '2026-10-05');
  assert.equal(d.plans.find(p => p.id === plan5.id).state.code, 'ok');
  assert.match(d.retention.skipped, /CPS ยังไม่เคยดึง/);   // first pull: nothing confirmed yet
  // later pulls: since = last generated_at returns only changes; ack confirms delivery
  env.sim.setNow('2026-10-08T02:00:00+07:00');
  const r2 = env.sim.get({ cps: 'export', key, since: d.generated_at, ack: d.generated_at }).body;
  assert.equal(r2.audits.length, 0);
  assert.equal(r2.retention.audits, 1);   // older than 2 days and already delivered → cleared here
  assert.equal(env.ok('calendar', env.bsa, { month: '2026-10' }).plans.find(p => p.id === plan5.id).state.code, 'ok');
  // the normal app page still works
  assert.match(env.sim.page(), /CPS PJO Audit/);
  env.sim.setNow(null);
});
