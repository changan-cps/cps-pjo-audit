/**
 * Read-only export for the CPS System (PJO Record / PJO Issue pages pull this every 720 minutes).
 *
 *   GET <web app /exec URL>?cps=export&key=<export key>[&since=<ISO>][&ack=<ISO>][&images=0]
 *
 * key    – from cpsExportSetup() (run once in the Apps Script editor; it prints the key)
 * since  – only audits / issues changed after this time (send the generated_at of the last export you stored)
 * ack    – generated_at of the last export CPS stored successfully; lets this app clear its copy after 2 days
 * images – 0 = leave out signature / photo images (default: included, because this app keeps only 2 days)
 *
 * Response (JSON, schema "cps-pjo-export/1"):
 *   { ok, schema, generated_at, since, window, holidays, plans[], audits[], issues[], retention }
 *   audits[i] = { index, audit, snapshot (full standard form of that template version), issues, signatures (with image),
 *                 all_signatures, timing, team, status_th, plan, audit_time }
 * The CPS page can rebuild the standard 4-sheet form (ตารางสังเกตการณ์ 1–4) from snapshot (s1–s4 = the template items with
 * their source cells in the CATH-CPS009-B02 Excel) + audit (marks, s2 rows, s3 answers, s4 events, header, signatures).
 */
var CPS_KEY_PROP = 'CPS_EXPORT_KEY';
var CPS_USER = { username: 'cps-export', name: 'CPS System', roles: [{ role: 'admin', workshop: 'ALL' }] };

function cpsExportSetup() {
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty(CPS_KEY_PROP);
  if (!key) { key = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 8); props.setProperty(CPS_KEY_PROP, key); }
  var msg = 'Export key สำหรับระบบ CPS:\n' + key + '\n\nนำไปวางในช่อง "Export key" ที่หน้า PJO › ตั้งค่าการเชื่อมต่อ ในระบบ CPS\n' +
            'ถ้าต้องการเปลี่ยน key ให้รันฟังก์ชัน cpsExportResetKey';
  Logger.log(msg);
  return msg;
}
function cpsExportResetKey() { PropertiesService.getScriptProperties().deleteProperty(CPS_KEY_PROP); return cpsExportSetup(); }

/** Any call that carries an export key (or asks for an export) is a CPS call; the app itself is opened with no parameters. */
function isCpsRequest_(e) { var p = (e && e.parameter) || {}; return !!(p.cps || p.export_key || p.key || /export|sync|cps/i.test(p.action || '')); }

function cpsJson_(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }

function cpsExport_(params) {
  var key = PropertiesService.getScriptProperties().getProperty(CPS_KEY_PROP);
  var given = String(params.key || params.export_key || '');
  if (!key) return cpsJson_({ ok: false, code: 'not_setup', message: 'ยังไม่ได้สร้าง Export key — รันฟังก์ชัน cpsExportSetup ใน Apps Script' });
  if (given.length !== key.length || Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, given).join() !== Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, key).join())
    return cpsJson_({ ok: false, code: 'forbidden', message: 'Export key ไม่ถูกต้อง' });
  try {
    var data = cpsExportData_(params);
    cpsRecordPull_(data.generated_at, params.ack);
    try { data.retention = runRetention_(false); } catch (err) { data.retention = { error: String(err && err.message || err) }; }
    return cpsJson_(data);
  } catch (err) {
    return cpsJson_({ ok: false, code: 'error', message: String(err && err.message || err) });
  }
}

function cpsExportData_(params) {
  var since = /^\d{4}-\d{2}-\d{2}T/.test(params.since || '') ? params.since : '';
  var images = params.images !== '0';
  var generated = nowIso(), win = auditWindow_(), today = todayBkk(), nowMin = minOfDay_(generated);
  var auditRows = rows_('Audits');
  var byPlan = {};
  auditRows.forEach(function (a) { if (a.plan_id) (byPlan[a.plan_id] = byPlan[a.plan_id] || []).push(a); });
  var plans = rows_('Plans').map(function (pl) {
    var o = planOut_(pl, byPlan, today, nowMin, win);
    o.history = pl.history ? JSON.parse(pl.history) : [];
    return o;
  });
  var audits = auditRows.filter(function (a) { return !since || (a.updated_at || a.created_at) > since; }).map(function (row) {
    var x = API.audit_export(CPS_USER, { audit_id: row.id, with_images: images });
    x.index = clean_(row);
    x.audit_time = auditTiming_(row, win);
    var pl = row.plan_id ? find_('Plans', 'id', row.plan_id) : null;
    x.plan = pl ? { id: pl.id, planned_date: pl.planned_date, station: pl.station, employee_name: pl.employee_name, team_name: pl.team_name, level: pl.level } : null;
    return x;
  });
  var issues = rows_('Issues').map(function (row) {
    var i = loadIssue(row.id);
    if (since && (i.updated_at || i.created_at) <= since) return null;
    var o = issueRowOut_(row);
    o.detail = JSON.parse(JSON.stringify(i));
    if (images) o.detail.attachments = (i.attachments || []).map(function (f) {
      var c = Object.assign({}, f);
      try { c.data_url = readFileDataUrl_(f.id); } catch (e) { c.data_url = null; }
      return c;
    });
    return o;
  }).filter(Boolean);
  return { ok: true, schema: 'cps-pjo-export/1', generated_at: generated, since: since, window: win, holidays: holidays_(),
           workshops: rows_('Workshops').map(clean_), teams: rows_('Teams').map(clean_), plans: plans, audits: audits, issues: issues };
}
