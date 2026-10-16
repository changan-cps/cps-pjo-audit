/**
 * CPS PJO Audit – Google Apps Script web app.
 * Entry points: doGet() serves the app, api() is the only function the browser calls,
 * setup() is run once by the owner from the Apps Script editor.
 */
var APP_NAME = 'CPS PJO Audit';

// Icon shown in the browser tab / Android shortcut. Hosted with the launcher on GitHub Pages (docs/).
var ICON_URL = 'https://changan-cps.github.io/cps-pjo-audit/icons/icon-192.png';

function doGet() {
  var out = HtmlService.createTemplateFromFile('Index').evaluate()
    .setTitle(APP_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .addMetaTag('mobile-web-app-capable', 'yes')
    // ALLOWALL lets the home-screen launcher (docs/index.html) show the app full screen.
    // Access is still controlled by the app's own username + PIN login.
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  try { out.setFaviconUrl(ICON_URL); } catch (e) { /* invalid URL: keep default icon */ }
  return out;
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
