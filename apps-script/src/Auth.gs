/**
 * Login with username + PIN (works for staff without company Google accounts).
 * Sessions live in the script cache (sliding 6 hours). Permissions mirror the Django version:
 * roles are granted per workshop, or for ALL workshops.
 */
var ROLES = ['admin', 'auditor', 'tlgl', 'employee', 'issue_owner', 'verifier', 'viewer'];
var STAFF_ROLES = ['auditor', 'tlgl', 'viewer', 'verifier', 'issue_owner'];
var SESSION_SECONDS = 6 * 60 * 60;

function hashPin_(salt, pin) { return sha256_(salt + ':' + pin); }

function login_(username, pin) {
  if (ssoOnly_()) throw new RuleError('เข้าใช้งานผ่าน CPS Digital Platform เท่านั้น', 'sso_only');
  username = String(username || '').trim().toLowerCase();
  var cache = CacheService.getScriptCache();
  var failKey = 'fail:' + username;
  var fails = Number(cache.get(failKey) || 0);
  if (fails >= 5) throw new RuleError('ใส่ PIN ผิดหลายครั้ง กรุณารอ 15 นาที', 'locked_out');
  var u = find_('Users', 'username', username);
  if (!u || u.active === 'false' || hashPin_(u.salt, String(pin || '')) !== u.pin_hash) {
    cache.put(failKey, String(fails + 1), 900);
    throw new RuleError('ชื่อผู้ใช้หรือ PIN ไม่ถูกต้อง', 'bad_login');
  }
  cache.remove(failKey);
  var token = uuid_() + uuid_().slice(0, 8);
  cache.put('s:' + token, username, SESSION_SECONDS);
  trail({ username: username }, 'login', '', '', {});
  return { token: token, user: publicUser_(userObj_(u)) };
}

function logout_(token) { CacheService.getScriptCache().remove('s:' + token); }

function requireSession(token) {
  var cache = CacheService.getScriptCache();
  var username = token ? cache.get('s:' + token) : null;
  if (!username) throw new RuleError('กรุณาเข้าสู่ระบบใหม่', 'auth');
  cache.put('s:' + token, username, SESSION_SECONDS); // sliding expiry
  var u = find_('Users', 'username', username);
  if (!u || u.active === 'false') throw new RuleError('บัญชีถูกปิดใช้งาน', 'auth');
  return userObj_(u);
}

function userObj_(row) {
  var roles = [];
  try { roles = JSON.parse(row.roles || '[]'); } catch (e) { roles = []; }
  var emp = null;
  rows_('Employees').forEach(function (e) { if (e.username === row.username) emp = e.code; });
  return { username: row.username, name: row.name || row.username, roles: roles, employee_code: emp, must_change_pin: row.must_change_pin === 'true' };
}
function publicUser_(u) {
  return { username: u.username, name: u.name, roles: u.roles, employee_code: u.employee_code, is_admin: isAdmin(u), must_change_pin: u.must_change_pin };
}

function rolesFor(u, workshop) {
  var out = {};
  (u.roles || []).forEach(function (r) {
    if (r.role === 'admin' || !workshop || r.workshop === 'ALL' || r.workshop === workshop) out[r.role] = true;
  });
  return out;
}
function isAdmin(u) { return (u.roles || []).some(function (r) { return r.role === 'admin'; }); }
function hasRole(u, workshop) {
  var r = rolesFor(u, workshop);
  if (r.admin) return true;
  var wanted = Array.prototype.slice.call(arguments, 2);
  return wanted.some(function (role) { return r[role]; });
}
function visibleWorkshops(u) {
  var all = rows_('Workshops').map(function (w) { return w.code; });
  if (isAdmin(u) || (u.roles || []).some(function (r) { return r.workshop === 'ALL'; })) return all;
  var set = {};
  (u.roles || []).forEach(function (r) { set[r.workshop] = true; });
  return all.filter(function (c) { return set[c]; });
}
function require_(cond) { if (!cond) throw new Forbidden(); }

function canViewAudit(u, idx) {
  if (hasRole.apply(null, [u, idx.workshop].concat(STAFF_ROLES))) return true;
  if (u.employee_code && idx.employee_code === u.employee_code) return true;
  return rows_('Issues').some(function (i) { return i.owner === u.username && (',' + i.audit_ids + ',').indexOf(',' + idx.id + ',') >= 0; });
}
function canEditAudit(u, idx) { return hasRole(u, idx.workshop, 'auditor', 'tlgl'); }
function canCreateAudit(u, workshop) { return hasRole(u, workshop, 'auditor', 'tlgl'); }
function canViewIssue(u, i) { return hasRole.apply(null, [u, i.workshop].concat(STAFF_ROLES)) || i.owner === u.username; }
function canManageIssue(u, i) { return hasRole(u, i.workshop, 'auditor', 'tlgl'); }
function canWorkIssue(u, i) { return i.owner === u.username || canManageIssue(u, i); }
function canVerifyIssue(u, i) { return hasRole(u, i.workshop, 'verifier'); }

function newUserRow_(username, name, pin, roles, mustChange) {
  var salt = uuid_();
  return { username: username, name: name, salt: salt, pin_hash: hashPin_(salt, pin), roles: JSON.stringify(roles || []),
           active: 'true', created_at: nowIso(), must_change_pin: mustChange ? 'true' : 'false' };
}
function randomPin_() {
  var s = '';
  for (var i = 0; i < 6; i++) s += Math.floor(Math.random() * 10);
  return s;
}

// =====================================================================================
// CPS SSO – sign-in from the CPS Digital Platform portal (https://changan-cps.github.io/cps-portal/)
// The portal's SSO service issues a 2-minute ticket signed with a shared secret:
//   base64url(JSON {t:'k', u, n, app, role, exp, jti}) + "." + base64url(HMAC-SHA256(part1, SSO_SECRET))
// Script property SSO_SECRET   = the secret printed by showSecret() in the CPS SSO script.
// Script property ALLOW_LOCAL_LOGIN = 'true' re-enables the username + PIN form (emergency only).
// Who may enter, and with which role, is decided in the portal: the role in the ticket is applied here.
// =====================================================================================
var SSO_APP_ID = 'cps-pjo-audit';
var SSO_PORTAL_URL = 'https://changan-cps.github.io/cps-portal/';
var SSO_LAUNCHER_URL = 'https://changan-cps.github.io/cps-pjo-audit/';

function ssoSecret_() { return String(PropertiesService.getScriptProperties().getProperty('SSO_SECRET') || '').trim(); }
/** True when the portal is the only way in (secret configured and the PIN form not explicitly re-enabled). */
function ssoOnly_() { return !!ssoSecret_() && PropertiesService.getScriptProperties().getProperty('ALLOW_LOCAL_LOGIN') !== 'true'; }

function ssoVerify_(ticket) {
  var secret = ssoSecret_();
  if (!secret) throw new RuleError('ระบบนี้ยังไม่ได้เชื่อมกับ CPS Digital Platform', 'sso_off');
  var m = /^([\w-]+)\.([\w-]+)$/.exec(String(ticket || ''));
  var bad = new RuleError('บัตรผ่านไม่ถูกต้องหรือหมดอายุ กรุณาเปิดจาก CPS Digital Platform อีกครั้ง', 'sso_bad');
  if (!m) throw bad;
  var sig = Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(m[1], secret)).replace(/=+$/, '');
  if (sig !== m[2]) throw bad;
  var t;
  try { t = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(m[1] + '==='.slice((m[1].length + 3) % 4))).getDataAsString()); } catch (e) { throw bad; }
  if (!t || t.t !== 'k' || t.app !== SSO_APP_ID || !(t.exp > Date.now()) || !t.u || !t.jti) throw bad;
  var cache = CacheService.getScriptCache();
  if (cache.get('jti:' + t.jti)) throw bad;                       // each ticket works once
  cache.put('jti:' + t.jti, '1', 600);
  return t;
}

function ssoLogin_(ticket) {
  var t = ssoVerify_(ticket);
  var username = String(t.u).trim().toLowerCase();
  var role = ROLES.indexOf(t.role) >= 0 ? t.role : 'viewer';
  var name = String(t.n || username).slice(0, 80);
  withLock(function () {
    var row = find_('Users', 'username', username);
    if (!row) {
      insert_('Users', newUserRow_(username, name, randomPin_() + randomPin_(), [{ role: role, workshop: 'ALL' }], false));
    } else {
      var cur = [];
      try { cur = JSON.parse(row.roles || '[]'); } catch (e) { cur = []; }
      // same role as the portal says: keep any per-workshop detail set here; otherwise the portal wins
      var same = cur.length && cur.every(function (r) { return r.role === role; });
      update_('Users', row, { name: name, roles: same ? row.roles : JSON.stringify([{ role: role, workshop: 'ALL' }]), active: 'true', must_change_pin: 'false' });
    }
  });
  var u = find_('Users', 'username', username);
  var token = uuid_() + uuid_().slice(0, 8);
  CacheService.getScriptCache().put('s:' + token, username, SESSION_SECONDS);
  trail({ username: username }, 'sso_login', '', '', { role: role });
  return { token: token, user: publicUser_(userObj_(u)) };
}
