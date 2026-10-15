'use strict';
// Run: node --test apps-script/test/
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { createSim } = require('../sim/gas-sim');

const SRC = path.join(__dirname, '..', 'src');
const SEED = path.join(__dirname, '..', '..', 'pjo', 'seed', 'templates');
const EXPECTED_S3 = { GA: 9, GA_Inspection: 9, BS: 10, PS: 10, LOG: 11, PT_Sub_Line_Engine: 9, PT_Battery: 9 };
// a real, non-empty PNG (1x1 white pixel repeated is too small) – the server only checks size/prefix
const SIG = 'data:image/png;base64,' + Buffer.alloc(400, 7).toString('base64');

function boot() {
  const sim = createSim(SRC, { quietErrors: true });
  const msg = sim.call('setup');
  const pin = /PIN ชั่วคราว: (\d+)/.exec(msg)[1];
  let r = sim.api('login', null, { username: 'admin', pin });
  assert.ok(r.ok, JSON.stringify(r));
  const admin = r.data.token;
  assert.equal(sim.api('lookups', admin).code, 'must_change_pin');
  assert.ok(sim.api('change_pin', admin, { new_pin: '246810' }).ok);
  const ok = (name, token, p) => { const x = sim.api(name, token, p); assert.ok(x.ok, name + ': ' + JSON.stringify(x)); return x.data; };
  // master data
  ok('admin_team_save', admin, { workshop: 'GA', group: 'G1', name: 'T1', line: 'L1' });
  ok('admin_employees_import', admin, { text: 'E1\tพนักงาน หนึ่ง\tGA\tT1\nE2\tพนักงาน สอง\tGA\tT1' });
  const users = {};
  for (const [name, roles] of [['aud', [{ role: 'auditor', workshop: 'GA' }]], ['aud2', [{ role: 'auditor', workshop: 'GA' }]],
    ['ver', [{ role: 'verifier', workshop: 'GA' }]], ['own', [{ role: 'issue_owner', workshop: 'GA' }]], ['bsv', [{ role: 'viewer', workshop: 'BS' }]]]) {
    const tmp = ok('admin_user_save', admin, { username: name, name: name.toUpperCase(), roles }).temp_pin;
    const t = ok('login', null, { username: name, pin: tmp }).token;
    ok('change_pin', t, { new_pin: '135790' });
    users[name] = t;
  }
  const lk = ok('lookups', users.aud);
  const ga = lk.workshops.find(w => w.code === 'GA');
  const team = lk.teams[0];
  return { sim, admin, users, ok, ga, team };
}

function newAudit(env, extra) {
  return env.ok('audit_create', env.users.aud, { template_id: env.ga.template.id, header: Object.assign({ station: 'ST1', model: 'M1', employee_code: 'E1', team_id: env.team.id }, extra || {}) }).id;
}
let opn = 0;
function op(env, user, auditId, o) {
  const r = env.ok('ops', env.users[user] || user, { audit_id: auditId, ops: [Object.assign({ op_id: 'op' + (++opn) }, o)] });
  return r.results[0];
}

test('setup loads 7 templates exactly from the source + confirmed corrections', () => {
  const env = boot();
  const t = env.ok('templates', env.admin);
  const pub = t.templates.filter(x => x.status === 'published');
  assert.equal(pub.length, 7);
  for (const [code, n] of Object.entries(EXPECTED_S3)) assert.equal(pub.find(x => x.workshop === code).counts.s3, n, code);
  assert.equal(pub.find(x => x.workshop === 'LOG').counts.s1, 9);
  // v1 of every workshop is byte-identical to the extracted Excel template
  for (const code of Object.keys(EXPECTED_S3)) {
    const v1 = t.templates.find(x => x.workshop === code && x.version === '1');
    const content = env.ok('template_get', env.admin, { template_id: v1.id }).content;
    assert.deepEqual(content, JSON.parse(fs.readFileSync(path.join(SEED, code + '.json'), 'utf8')), code);
  }
  const ptb = pub.find(x => x.workshop === 'PT_Battery');
  assert.equal(ptb.version, '3');
  const c = env.ok('template_get', env.admin, { template_id: ptb.id }).content;
  ['s1', 's2', 's3', 's4'].forEach(s => assert.match(c[s].title, /\(PT Battery\)/));
  assert.equal(c.s3.questions.find(q => q.key === 'S3-4').expected, 'พนักงานเข้าใจระบบ 4M Change Management');
  assert.equal(t.pending.filter(p => p.status === 'pending').length, 0);
  assert.deepEqual([t.gbr.G, t.gbr.B, t.gbr.R], ['Complete', 'On progress', 'Overdue']);
  // running setup again changes nothing
  env.sim.call('setup');
  assert.equal(env.ok('templates', env.admin).templates.length, t.templates.length);
});

test('login: wrong PIN, lockout, session required', () => {
  const env = boot();
  for (let i = 0; i < 5; i++) assert.equal(env.sim.api('login', null, { username: 'aud', pin: '000000' }).code, 'bad_login');
  assert.equal(env.sim.api('login', null, { username: 'aud', pin: '135790' }).code, 'locked_out');
  assert.equal(env.sim.api('lookups', 'nonsense').code, 'auth');
});

test('marks: blank is unchecked, N/A rules, occurrence range', () => {
  const env = boot();
  const id = newAudit(env);
  const st = env.ok('state', env.users.aud, { audit_id: id }).state;
  assert.deepEqual(st.marks, {});
  assert.equal(op(env, 'aud', id, { type: 'mark', item_key: 'S2-A-1', occurrence: 0, value: 'na' }).status, 'error');
  assert.equal(op(env, 'aud', id, { type: 'mark', item_key: 'S1-1', occurrence: 13, value: 'pass' }).status, 'error');
  assert.equal(op(env, 'aud', id, { type: 'mark', item_key: 'S1-1', occurrence: 1, value: 'na' }).status, 'ok');
});

test('× creates one issue on the right item; double tap / resync never duplicates; major follow-up', () => {
  const env = boot();
  const id = newAudit(env);
  const r = op(env, 'aud', id, { type: 'mark', item_key: 'S1-2', occurrence: 3, value: 'fail', prev: '' });
  assert.equal(r.needs_issue, true);
  const f1 = env.ok('finding', env.users.aud, { audit_id: id, sheet: 's1', item_key: 'S1-2', occurrence: 3, title: 'ไม่สวม PPE', client_id: 'c1' });
  assert.equal(f1.created, true);
  assert.equal(f1.issue.type, 'major');
  const f2 = env.ok('finding', env.users.aud, { audit_id: id, sheet: 's1', item_key: 'S1-2', occurrence: 3, title: 'x', client_id: 'c1' });
  const f3 = env.ok('finding', env.users.aud, { audit_id: id, sheet: 's1', item_key: 'S1-2', occurrence: 3, title: 'x', client_id: 'c2' });
  assert.equal(f2.issue.id, f1.issue.id); assert.equal(f3.issue.id, f1.issue.id);
  assert.equal(env.ok('issues', env.users.aud, {}).issues.length, 1);
  // same op id twice
  const o = { type: 'mark', item_key: 'S1-2', occurrence: 3, value: 'fail', op_id: 'same' };
  env.ok('ops', env.users.aud, { audit_id: id, ops: [o] });
  assert.equal(env.ok('ops', env.users.aud, { audit_id: id, ops: [o] }).results[0].duplicate, true);
  const st = env.ok('state', env.users.aud, { audit_id: id }).state;
  assert.equal(st.followups.length, 1);
  assert.equal(st.findings['S1-2|3'].issue_no, f1.issue.issue_no);
});

test('× → √ keeps issue with note; linking keeps every finding; concurrent edits detected', () => {
  const env = boot();
  const id = newAudit(env);
  op(env, 'aud', id, { type: 'mark', item_key: 'S1-6', occurrence: 1, value: 'fail' });
  const i = env.ok('finding', env.users.aud, { audit_id: id, sheet: 's1', item_key: 'S1-6', occurrence: 1, title: 'ไม่มีสมาธิ' }).issue;
  op(env, 'aud', id, { type: 'mark', item_key: 'S1-6', occurrence: 1, value: 'pass' });
  let d = env.ok('issue_get', env.users.aud, { issue_id: i.id }).issue;
  assert.match(d.occurrences[0].mark_changed_note, /× เป็น pass/);
  assert.ok(d.events.some(e => e.action === 'mark_changed'));
  const id2 = newAudit(env);
  const j = env.ok('finding', env.users.aud, { audit_id: id2, sheet: 's1', item_key: 'S1-6', occurrence: 4, link_issue_id: i.id });
  assert.equal(j.created, false);
  d = env.ok('issue_get', env.users.aud, { issue_id: i.id }).issue;
  assert.equal(d.occurrences.length, 2); assert.equal(d.repeat, true);
  // concurrency
  op(env, 'aud', id, { type: 'mark', item_key: 'S1-1', occurrence: 1, value: 'pass', prev: '' });
  const c = op(env, 'aud2', id, { type: 'mark', item_key: 'S1-1', occurrence: 1, value: 'fail', prev: '' });
  assert.equal(c.status, 'conflict'); assert.equal(c.current, 'pass');
  const lv = env.ok('state', env.users.aud, { audit_id: id }).state.lock_version;
  assert.equal(op(env, 'aud', id, { type: 'header', fields: { station: 'A' }, lock_version: lv }).status, 'ok');
  assert.equal(op(env, 'aud2', id, { type: 'header', fields: { station: 'B' }, lock_version: lv }).status, 'conflict');
});

test('S4 examples never create issues automatically; real event does', () => {
  const env = boot();
  const id = newAudit(env);
  op(env, 'aud', id, { type: 's4', client_id: 'r1', fields: { case_key: 'S4-1', employee_answer: 'แจ้งหัวหน้า', result: 'fail' } });
  assert.equal(env.ok('issues', env.users.aud, {}).issues.length, 0);
  op(env, 'aud', id, { type: 's4', client_id: 'r2', fields: { case_key: '', case_text: 'เกิดจริง', is_real_event: true } });
  const f = env.ok('finding', env.users.aud, { audit_id: id, sheet: 's4', review_id: 'r2', title: 'ชิ้นงานมีรอย' });
  assert.equal(f.issue.type, 'real_event');
  assert.equal(env.ok('state', env.users.aud, { audit_id: id }).state.s4.find(r => r.client_id === 'r2').issue.id, f.issue.id);
  op(env, 'aud', id, { type: 'suggestion', client_id: 's1', fields: { description: 'ชั้นวางไกล' } });
  assert.equal(env.ok('issues', env.users.aud, {}).issues.length, 1);
});

test('issue workflow, verifier-only close, G/B/R derived', () => {
  const env = boot();
  const id = newAudit(env);
  const iss = env.ok('finding', env.users.aud, { audit_id: id, sheet: 's2', item_key: 'S2-A-1', occurrence: 0, title: 'แสงไม่พอ', owner: 'own', due_date: '2020-01-01' }).issue;
  assert.equal(iss.status, 'assigned'); assert.equal(iss.overdue, true); assert.equal(iss.gbr, 'R');
  const lv = () => env.ok('issue_get', env.users.own, { issue_id: iss.id }).issue.lock_version;
  assert.equal(env.sim.api('issue_transition', env.users.own, { issue_id: iss.id, to: 'closed', lock_version: lv() }).code, 'forbidden');
  env.ok('issue_transition', env.users.own, { issue_id: iss.id, to: 'in_progress', lock_version: lv() });
  assert.match(env.sim.api('issue_transition', env.users.own, { issue_id: iss.id, to: 'pending_verification', lock_version: lv() }).message, /ต้องบันทึกการแก้ไข/);
  env.ok('issue_save', env.users.own, { issue_id: iss.id, lock_version: lv(), fields: { permanent_action: 'เพิ่มโคมไฟ', effectiveness: 'hack' } });
  assert.equal(env.ok('issue_get', env.users.own, { issue_id: iss.id }).issue.effectiveness, ''); // owner cannot write verification result
  env.ok('issue_transition', env.users.own, { issue_id: iss.id, to: 'pending_verification', lock_version: lv() });
  assert.match(env.sim.api('issue_transition', env.users.ver, { issue_id: iss.id, to: 'closed', lock_version: lv() }).message, /ประสิทธิผล/);
  env.ok('issue_transition', env.users.ver, { issue_id: iss.id, to: 'closed', lock_version: lv(), effectiveness: '500 lux' });
  const d = env.ok('issue_get', env.users.ver, { issue_id: iss.id }).issue;
  assert.equal(d.status, 'closed'); assert.equal(d.gbr, 'G'); assert.equal(d.verifier, 'ver');
  assert.match(env.sim.api('issue_transition', env.users.ver, { issue_id: iss.id, to: 'reopened', lock_version: lv() }).message, /เหตุผล/);
  env.ok('issue_transition', env.users.ver, { issue_id: iss.id, to: 'reopened', comment: 'พบซ้ำ', lock_version: lv() });
  // stale lock version is refused
  assert.equal(env.sim.api('issue_save', env.users.aud, { issue_id: iss.id, lock_version: 1, fields: { title: 'x' } }).code, 'conflict');
  assert.equal(env.ok('issues', env.users.aud, { gbr: 'B' }).issues.length, 0);
  assert.equal(env.ok('issues', env.users.aud, { gbr: 'R' }).issues.length, 1);
});

test('timing: pause deducted and reported, invalid/manual laps need reasons, re-measure keeps old', () => {
  const env = boot();
  const id = newAudit(env);
  const t0 = 1700000000000;
  const events = [{ type: 'start', t: t0 }, { type: 'lap', t: t0 + 30500 }, { type: 'pause', t: t0 + 40000, reason: 'รอชิ้นงาน' },
    { type: 'resume', t: t0 + 45000 }, { type: 'lap', t: t0 + 62250 }, { type: 'stop', t: t0 + 90000 }];
  const base = { audit_id: id, item_key: 'S1-10', observation: 2, client_id: 'tm1', events, final: true };
  assert.match(env.sim.api('timing', env.users.aud, Object.assign({}, base, { laps: [{ lap_no: 3, valid: false }] })).message, /ต้องระบุเหตุผล/);
  assert.match(env.sim.api('timing', env.users.aud, Object.assign({}, base, { manual_laps: [{ seconds: 25 }] })).message, /ต้องระบุเหตุผล/);
  const s = env.ok('timing', env.users.aud, Object.assign({}, base, { laps: [{ lap_no: 3, valid: false, invalid_reason: 'ทำผิดลำดับ' }],
    manual_laps: [{ seconds: '29.40', reason: 'วัดจากวิดีโอ' }] })).session;
  assert.deepEqual(s.laps.map(l => l.seconds), [30.5, 26.75, 27.75, 29.4]);
  assert.equal(s.laps[1].paused, 5); assert.deepEqual(s.laps[1].pause_reasons, ['รอชิ้นงาน']);
  assert.equal(s.count_used, 3); assert.equal(s.min, 26.75); assert.equal(s.max, 30.5);
  assert.equal(s.evaluation, 'รอประเมิน');
  env.ok('timing', env.users.aud, Object.assign({}, base, { client_id: 'tm2' }));
  const st = env.ok('state', env.users.aud, { audit_id: id }).state;
  assert.equal(st.timing.length, 1);
  const exp = env.ok('audit_export', env.users.aud, { audit_id: id });
  assert.equal(exp.timing.filter(t => t.discarded).length, 1);
  assert.match(env.sim.api('timing', env.users.aud, { audit_id: id, item_key: 'S1-1', observation: 1, client_id: 'x', events: [], final: true }).message, /ไม่ใช่ข้อวัดเวลา/);
});

function readyForSign(env) {
  const id = newAudit(env);
  op(env, 'aud', id, { type: 'mark', item_key: 'S1-1', occurrence: 1, value: 'fail' });
  const iss = env.ok('finding', env.users.aud, { audit_id: id, sheet: 's1', item_key: 'S1-1', occurrence: 1, title: 'ไม่สวม PPE' }).issue;
  op(env, 'aud', id, { type: 'header', fields: { ois_current: 'yes' } });
  env.ok('submit', env.users.aud, { audit_id: id });
  return { id, iss };
}
function sign(env, user, id, role, extra) {
  return env.sim.api('sign', env.users[user], Object.assign({ audit_id: id, role, image: SIG, strokes: 3, client_id: role + Math.random(), identity_method: 'login' }, extra || {}));
}

test('signatures: empty refused, employee must match, completion, lock, amend, re-sign', () => {
  const env = boot();
  const draft = newAudit(env);
  op(env, 'aud', draft, { type: 'mark', item_key: 'S1-5', occurrence: 1, value: 'fail' });
  op(env, 'aud', draft, { type: 'header', fields: { ois_current: 'yes' } });
  assert.equal(env.sim.api('submit', env.users.aud, { audit_id: draft }).code, 'unlogged');

  const { id } = readyForSign(env);
  const emp = { identity_method: 'employee_code_witnessed', signer_code: 'E1' };
  assert.match(sign(env, 'aud', id, 'employee_major', Object.assign({}, emp, { strokes: 0 })).message, /ลายเซ็นว่าง/);
  assert.match(sign(env, 'aud', id, 'employee_major', { identity_method: 'employee_code_witnessed', signer_code: 'E2' }).message, /ไม่ตรงกับพนักงาน/);
  let r = sign(env, 'aud', id, 'employee_major', emp); assert.ok(r.ok, JSON.stringify(r));
  sign(env, 'aud', id, 'employee_s3', emp);
  sign(env, 'aud', id, 'supervisor_s3');
  r = sign(env, 'aud', id, 'auditor');
  assert.equal(r.data.state.status, 'completed');
  assert.ok(r.data.state.open_issues > 0); // completed ≠ all issues closed
  assert.equal(op(env, 'aud', id, { type: 'mark', item_key: 'S1-1', occurrence: 2, value: 'pass' }).code, 'locked');
  r = env.ok('amend', env.users.aud, { audit_id: id, reason: 'ครั้งที่ 2 ตกหล่น', sheets: ['s1'] });
  assert.equal(r.state.revision, 2); assert.equal(r.state.status, 'amended');
  const exp = env.ok('audit_export', env.users.aud, { audit_id: id });
  assert.deepEqual(exp.audit.revisions[0].data_before.s1.marks['S1-1'], { 1: 'fail' });
  const superseded = exp.all_signatures.filter(s => s.superseded_at).map(s => s.role).sort();
  assert.deepEqual(superseded, ['auditor', 'employee_major']);
  assert.equal(exp.all_signatures.length, 4);
  assert.equal(op(env, 'aud', id, { type: 'mark', item_key: 'S1-1', occurrence: 2, value: 'pass' }).status, 'ok');
  assert.equal(op(env, 'aud', id, { type: 's3', item_key: 'S3-1', field: 'coaching', value: 'x' }).code, 'locked');
  env.ok('submit', env.users.aud, { audit_id: id });
  sign(env, 'aud', id, 'employee_major', emp);
  r = sign(env, 'aud', id, 'auditor');
  assert.equal(r.data.state.status, 'completed');
  assert.equal(env.ok('audit_export', env.users.aud, { audit_id: id }).signatures.filter(s => s.revision === 2).length, 2);
  // the stored data hash is 64 hex chars and the image is private (served only through the API)
  assert.match(exp.all_signatures[0].data_hash, /^[0-9a-f]{64}$/);
  assert.equal(env.sim.api('signature_image', env.users.bsv, { audit_id: id, sig_id: '1' }).code, 'forbidden');
  assert.match(env.ok('signature_image', env.users.aud, { audit_id: id, sig_id: '1' }).data_url, /^data:image\/png;base64,/);
});

test('major re-certification flow', () => {
  const env = boot();
  const { id } = readyForSign(env);
  let st = env.ok('state', env.users.aud, { audit_id: id }).state;
  const f = st.followups[0];
  assert.match(sign(env, 'aud', id, 'recertifier', { followup_id: f.id }).message, /ฝึกอบรม/);
  op(env, 'aud', id, { type: 'followup', id: f.id, fields: { training_detail: 'สอน PPE', recert_by: 'GL', recert_result: 'ถูกต้อง 3 รอบ' } });
  sign(env, 'aud', id, 'recertifier', { followup_id: f.id });
  const r = sign(env, 'aud', id, 'employee_recert', { followup_id: f.id, identity_method: 'employee_code_witnessed', signer_code: 'E1' });
  assert.equal(r.data.state.followups[0].stage, 'recertified');
  assert.equal(op(env, 'aud', id, { type: 'followup', id: f.id, fields: { recert_result: 'x' } }).status, 'error');
});

test('permissions: other workshop, viewers, owners, admin-only', () => {
  const env = boot();
  const id = newAudit(env);
  assert.equal(env.sim.api('state', env.users.bsv, { audit_id: id }).code, 'forbidden');
  assert.equal(env.sim.api('ops', env.users.bsv, { audit_id: id, ops: [] }).code, 'forbidden');
  assert.equal(env.sim.api('audit_export', env.users.bsv, { audit_id: id }).code, 'forbidden');
  assert.equal(env.sim.api('ops', env.users.own, { audit_id: id, ops: [] }).code, 'forbidden');
  assert.equal(env.sim.api('ops', env.users.ver, { audit_id: id, ops: [] }).code, 'forbidden');
  assert.equal(env.sim.api('admin_data', env.users.aud).code, 'forbidden');
  assert.equal(env.sim.api('template_action', env.users.aud, { template_id: env.ga.template.id, action: 'new_draft' }).code, 'forbidden');
  assert.equal(env.ok('issue_register', env.users.bsv, {}).issues.length, 0);
  const iss = env.ok('finding', env.users.aud, { audit_id: id, sheet: 's2', item_key: 'S2-A-1', occurrence: 0, title: 'x' }).issue;
  const up = env.ok('upload', env.users.aud, { issue_id: iss.id, files: [{ name: 'a.png', type: 'image/png', data: Buffer.alloc(300, 1).toString('base64') }] });
  assert.equal(env.sim.api('attachment', env.users.bsv, { issue_id: iss.id, file_id: up.files[0].id }).code, 'forbidden');
  assert.match(env.ok('attachment', env.users.aud, { issue_id: iss.id, file_id: up.files[0].id }).data_url, /^data:image\/png/);
  assert.match(env.sim.api('upload', env.users.aud, { issue_id: iss.id, files: [{ name: 'x.exe', type: 'application/x-msdownload', data: 'TVo=' }] }).message, /รูปภาพหรือ PDF/);
});

test('template versions never change old audits; workshop cannot change after answers', () => {
  const env = boot();
  const id = newAudit(env);
  const before = env.ok('audit_open', env.users.aud, { audit_id: id }).snapshot;
  const d = env.ok('template_action', env.admin, { template_id: env.ga.template.id, action: 'new_draft' }).template_id;
  env.ok('template_action', env.admin, { template_id: d, action: 'edit_item', key: 'S1-1', text: 'ข้อความใหม่', allow_na: false });
  env.ok('template_action', env.admin, { template_id: d, action: 'publish', change_note: 'แก้ข้อ 1' });
  assert.deepEqual(env.ok('audit_open', env.users.aud, { audit_id: id }).snapshot, before);
  const lk = env.ok('lookups', env.users.aud);
  assert.equal(lk.workshops.find(w => w.code === 'GA').template.id, d);
  const id2 = env.ok('audit_create', env.users.aud, { template_id: d, header: {} }).id;
  assert.equal(env.ok('audit_open', env.users.aud, { audit_id: id2 }).snapshot.s1.items[0].text, 'ข้อความใหม่');
  assert.equal(op(env, 'aud', id2, { type: 'mark', item_key: 'S1-1', occurrence: 1, value: 'na' }).status, 'error');
  assert.match(env.sim.api('audit_create', env.users.aud, { template_id: env.ga.template.id, header: {} }).message, /Published/);
});

test('large audit documents are chunked safely and dangerous text is not turned into formulas', () => {
  const env = boot();
  const id = newAudit(env);
  const long = '=SUM(A1)' + 'ก'.repeat(60000);
  op(env, 'aud', id, { type: 's3', item_key: 'S3-1', field: 'coaching', value: long });
  const st = env.ok('state', env.users.aud, { audit_id: id }).state;
  assert.equal(st.s3['S3-1'].coaching, long);
  const iss = env.ok('finding', env.users.aud, { audit_id: id, sheet: 's2', item_key: 'S2-A-1', occurrence: 0, title: '=HYPERLINK("x")' }).issue;
  assert.equal(env.ok('issue_get', env.users.aud, { issue_id: iss.id }).issue.title, '=HYPERLINK("x")');
});

test('doGet renders the app shell with all includes', () => {
  const env = boot();
  const html = env.sim.page();
  assert.match(html, /CPS PJO Audit/);
  assert.doesNotMatch(html, /<\?!=/);
});
