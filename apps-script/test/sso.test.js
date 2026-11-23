'use strict';
// CPS SSO: sign-in with a ticket from the CPS Digital Platform portal. Run: node --test apps-script/test/sso.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const crypto = require('crypto');
const { createSim } = require('../sim/gas-sim');

const SRC = path.join(__dirname, '..', 'src');
const SECRET = 'test-secret-123';
function ticket(over, secret) {
  const payload = Object.assign({ t: 'k', u: 'Somchai', n: 'สมชาย ใจดี', app: 'cps-pjo-audit', role: 'auditor', exp: Date.now() + 120000, jti: crypto.randomUUID() }, over);
  const part = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return part + '.' + crypto.createHmac('sha256', secret || SECRET).update(part).digest('base64url');
}
function boot(withSecret) {
  const sim = createSim(SRC, { quietErrors: true });
  const msg = sim.call('setup');
  const pin = /PIN ชั่วคราว: (\d+)/.exec(msg)[1];
  if (withSecret !== false) sim.store.props.SSO_SECRET = SECRET;
  return { sim, pin };
}

test('without SSO_SECRET nothing changes: PIN login works, tickets are refused', () => {
  const { sim, pin } = boot(false);
  assert.equal(sim.api('ping').data.sso_only, false);
  assert.ok(sim.api('login', null, { username: 'admin', pin }).ok);
  assert.equal(sim.api('sso_login', null, { ticket: ticket() }).code, 'sso_off');
});

test('a valid ticket creates the user with the portal role and signs in', () => {
  const { sim } = boot();
  const r = sim.api('sso_login', null, { ticket: ticket() });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.data.user.username, 'somchai');
  assert.equal(r.data.user.name, 'สมชาย ใจดี');
  assert.deepEqual(r.data.user.roles, [{ role: 'auditor', workshop: 'ALL' }]);
  assert.equal(r.data.user.must_change_pin, false);
  const me = sim.api('me', r.data.token);
  assert.ok(me.ok, JSON.stringify(me));
  assert.equal(me.data.user.username, 'somchai');
});

test('portal-only: the PIN form is closed once the secret is set, unless re-enabled', () => {
  const { sim, pin } = boot();
  assert.equal(sim.api('ping').data.sso_only, true);
  assert.equal(sim.api('login', null, { username: 'admin', pin }).code, 'sso_only');
  sim.store.props.ALLOW_LOCAL_LOGIN = 'true';
  assert.equal(sim.api('ping').data.sso_only, false);
  assert.ok(sim.api('login', null, { username: 'admin', pin }).ok);
});

test('bad tickets are rejected', () => {
  const { sim } = boot();
  const bad = t => assert.equal(sim.api('sso_login', null, { ticket: t }).code, 'sso_bad', t.slice(0, 30));
  bad(ticket({}, 'other-secret'));                 // wrong signature
  bad(ticket({ app: 'cps-health-check' }));        // ticket for another app
  bad(ticket({ exp: Date.now() - 1000 }));         // expired
  bad(ticket({ t: 's' }));                         // a portal session token is not a ticket
  bad('garbage'); bad('');
  const once = ticket();
  assert.ok(sim.api('sso_login', null, { ticket: once }).ok);
  bad(once);                                       // replay
  const [part] = ticket().split('.');
  bad(Buffer.from(JSON.stringify({ t: 'k', u: 'admin', app: 'cps-pjo-audit', role: 'admin', exp: Date.now() + 1e6, jti: 'x' })).toString('base64url') + '.' + ticket().split('.')[1]);
  assert.ok(part);
});

test('the portal role wins on the next sign-in; matching roles keep per-workshop detail', () => {
  const { sim } = boot();
  let r = sim.api('sso_login', null, { ticket: ticket({ role: 'viewer' }) });
  assert.deepEqual(r.data.user.roles, [{ role: 'viewer', workshop: 'ALL' }]);
  r = sim.api('sso_login', null, { ticket: ticket({ role: 'admin', n: 'New Name' }) });
  assert.deepEqual(r.data.user.roles, [{ role: 'admin', workshop: 'ALL' }]);
  assert.equal(r.data.user.name, 'New Name');
  assert.equal(r.data.user.is_admin, true);
  r = sim.api('sso_login', null, { ticket: ticket({ role: 'not-a-role' }) });
  assert.deepEqual(r.data.user.roles, [{ role: 'viewer', workshop: 'ALL' }], 'unknown role falls back to viewer');
});

test('the page boots through the SSO path', () => {
  const { sim } = boot();
  const html = sim.page();
  assert.ok(html.includes("PJO.call('sso_login'"));
  assert.ok(html.includes('google.script.url.getLocation'));
});
