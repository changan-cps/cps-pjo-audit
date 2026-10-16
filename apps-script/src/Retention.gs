/**
 * Data retention: the CPS System keeps the history (it pulls this app every 720 minutes), so this app only keeps
 * the last 2 days. Everything older than 2 days that CPS has already received is removed:
 * audits, issues, their photos/signature files (moved to Drive trash) and the change log.
 * Plans (แผนตรวจ) are never removed; before an audit is removed, the plan keeps a snapshot of its calendar status.
 */
var RETENTION_DAYS = 2;

/** Called by the CPS export each time CPS pulls data. ack = generated_at of the last export CPS stored (optional). */
function cpsRecordPull_(generatedAt, ack) {
  var s = settingGet('cps_sync') || { pulls: [] };
  s.pulls = (s.pulls || []).concat([generatedAt]).slice(-10);
  if (ack && /^\d{4}-\d{2}-\d{2}T/.test(ack) && (!s.ack || ack > s.ack)) s.ack = ack;
  settingPut('cps_sync', s, 'cps');
  return s;
}
/** Records changed before this time have certainly been delivered to CPS. */
function cpsDeliveredUntil_() {
  var s = settingGet('cps_sync');
  if (!s) return '';
  if (s.ack) return s.ack;
  var p = s.pulls || [];
  return p.length >= 2 ? p[p.length - 2] : '';  // the previous pull answered, and CPS came back for more
}

function deleteRowsWhere_(name, drop) {
  var sh = sheet_(name), cols = TABLES[name], all = rows_(name);
  var keep = all.filter(function (r) { return !drop(r); });
  if (keep.length === all.length) return 0;
  var n = sh.getLastRow() - 1;
  if (n > 0) sh.getRange(2, 1, n, cols.length).clearContent();
  if (keep.length) sh.getRange(2, 1, keep.length, cols.length).setValues(keep.map(function (r) { return cols.map(function (c) { return cell_(r[c]); }); }));
  invalidate_(name);
  return all.length - keep.length;
}
function trashFile_(id) { if (!id) return 0; try { DriveApp.getFileById(id).setTrashed(true); return 1; } catch (e) { return 0; } }

/**
 * Removes data older than RETENTION_DAYS that CPS already has. Runs at most once a day (after a CPS pull);
 * pass force=true to run now. Returns what was removed.
 */
function runRetention_(force) {
  var state = settingGet('retention') || {};
  if (!force && state.last_run && Date.now() - new Date(state.last_run).getTime() < 20 * 3600e3) return { skipped: 'ran recently', last: state.last_run };
  var delivered = cpsDeliveredUntil_();
  if (!delivered) return { skipped: 'CPS ยังไม่เคยดึงข้อมูล จึงยังไม่ล้าง' };
  var cutoff = new Date(Date.now() - RETENTION_DAYS * 864e5).toISOString();
  var limit = delivered < cutoff ? delivered : cutoff;
  return withLock(function () {
    var old = function (iso) { return iso && iso < limit; };
    var audits = rows_('Audits').filter(function (a) { return old(a.updated_at || a.created_at); });
    var issues = rows_('Issues').filter(function (i) {
      var b = null; try { b = blobGet('issue:' + i.id); } catch (e) { b = null; }
      return old((b && b.updated_at) || i.closed_at || i.created_at);
    });
    var res = { limit: limit, audits: audits.length, issues: issues.length, files: 0, trail: 0, plans_snapshot: 0 };
    if (!audits.length && !issues.length) {
      res.trail = deleteRowsWhere_('Trail', function (t) { return old(t.at); });
      settingPut('retention', { last_run: nowIso(), last: res }, 'system');
      return res;
    }
    // 1) plans keep their calendar status
    var gone = {}; audits.forEach(function (a) { gone[a.id] = true; });
    var win = auditWindow_(), today = todayBkk(), nowMin = minOfDay_(nowIso());
    var byPlan = {};
    rows_('Audits').forEach(function (a) { if (a.plan_id) (byPlan[a.plan_id] = byPlan[a.plan_id] || []).push(a); });
    ensureHeader_('Plans');
    rows_('Plans').filter(function (pl) { return (byPlan[pl.id] || []).some(function (a) { return gone[a.id]; }); }).forEach(function (pl) {
      var st = planStatus_(pl, byPlan[pl.id], today, nowMin, win);
      update_('Plans', pl, { snapshot: JSON.stringify({ at: nowIso(), code: st.code, why: st.why, timing: st.timing, audits: st.audits }) });
      res.plans_snapshot++;
    });
    // 2) files on Drive (to trash, recoverable for 30 days)
    audits.forEach(function (a) {
      var doc = null; try { doc = blobGet('audit:' + a.id); } catch (e) { doc = null; }
      if (!doc) return;
      (doc.signatures || []).forEach(function (s) { res.files += trashFile_(s.file_id); });
      (doc.attachments || []).forEach(function (f) { res.files += trashFile_(f.id || f.file_id); });
    });
    issues.forEach(function (i) {
      var doc = null; try { doc = blobGet('issue:' + i.id); } catch (e) { doc = null; }
      if (doc) (doc.attachments || []).forEach(function (f) { res.files += trashFile_(f.id || f.file_id); });
    });
    // 3) rows
    var keys = {};
    audits.forEach(function (a) { keys['audit:' + a.id] = true; });
    issues.forEach(function (i) { keys['issue:' + i.id] = true; });
    var dropIssue = {}; issues.forEach(function (i) { dropIssue[i.id] = true; });
    deleteRowsWhere_('Audits', function (a) { return gone[a.id]; });
    deleteRowsWhere_('Issues', function (i) { return dropIssue[i.id]; });
    deleteRowsWhere_('Blobs', function (b) { return keys[b.key]; });
    res.trail = deleteRowsWhere_('Trail', function (t) { return old(t.at); });
    var cache = CacheService.getScriptCache();
    Object.keys(keys).forEach(function (k) { try { cache.remove('b:' + k); } catch (e) { /* ignore */ } });
    settingPut('retention', { last_run: nowIso(), last: res }, 'system');
    trail(null, 'retention.run', '', '', res);
    return res;
  });
}

/** Run from the Apps Script editor to clear old data right away (still only what CPS already has). */
function purgeOldDataNow() { var r = runRetention_(true); Logger.log(JSON.stringify(r)); return r; }
