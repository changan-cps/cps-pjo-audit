'use strict';
/**
 * Local preview of the Apps Script web app: serves doGet() output and answers
 * google.script.run calls through the simulator. For development and tests only.
 *   node apps-script/sim/server.js [port] [--seed]
 */
const http = require('http');
const path = require('path');
const { createSim } = require('./gas-sim');

const port = Number(process.argv[2]) || 8090;
const sim = createSim(path.join(__dirname, '..', 'src'), { quietErrors: false });
const setupMsg = sim.call('setup');
const adminPin = /PIN ชั่วคราว: (\d+)/.exec(setupMsg)[1];

function seedDemo() {
  const tok = sim.api('login', null, { username: 'admin', pin: adminPin }).data.token;
  sim.api('change_pin', tok, { new_pin: '111111' });
  sim.api('admin_team_save', tok, { workshop: 'GA', group: 'G1', name: 'Trim 1', line: 'GA-L1' });
  sim.api('admin_employees_import', tok, { text: 'E1001\tมานะ ตั้งใจ\tGA\tTrim 1\nE1002\tสมใจ รักงาน\tGA\tTrim 1' });
  const pins = {};
  for (const [u, name, roles] of [['auditor1', 'สมชาย ผู้ตรวจ', [{ role: 'auditor', workshop: 'GA' }]], ['verifier1', 'วิไล ผู้ยืนยัน', [{ role: 'verifier', workshop: 'GA' }]],
    ['owner1', 'ประเสริฐ เจ้าของปัญหา', [{ role: 'issue_owner', workshop: 'GA' }]]]) {
    const pin = sim.api('admin_user_save', tok, { username: u, name, roles }).data.temp_pin;
    const t = sim.api('login', null, { username: u, pin }).data.token;
    sim.api('change_pin', t, { new_pin: '222222' });
    pins[u] = '222222';
  }
  return pins;
}
const demo = process.argv.includes('--seed') ? seedDemo() : null;

const SHIM = `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><script>
(function () {
  function runner() {
    var ok = null, fail = null;
    var r = new Proxy({}, { get: function (_, name) {
      if (name === 'withSuccessHandler') return function (f) { ok = f; return r; };
      if (name === 'withFailureHandler') return function (f) { fail = f; return r; };
      if (name === 'withUserObject') return function () { return r; };
      return function () {
        var args = Array.prototype.slice.call(arguments);
        fetch('/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fn: name, args: args }) })
          .then(function (res) { return res.json(); })
          .then(function (j) { if (j.error) { if (fail) fail(new Error(j.error)); } else if (ok) ok(j.result); })
          .catch(function (e) { if (fail) fail(e); });
      };
    } });
    return r;
  }
  window.google = { script: { get run() { return runner(); } } };
})();
</script>`;

http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/rpc') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let out;
      try {
        const { fn, args } = JSON.parse(body);
        if (fn !== 'api') throw new Error('only api() is callable from the browser');
        out = { result: sim.call('api', ...args) };
      } catch (e) { out = { error: String(e && e.message || e) }; }
      setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out)); }, 120);
    });
    return;
  }
  if (req.url === '/' || req.url.startsWith('/?')) {
    const html = sim.page().replace('<head>', '<head>' + SHIM);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }
  res.writeHead(404); res.end();
}).listen(port, () => {
  console.log('PJO Apps Script preview on http://localhost:' + port);
  console.log(demo ? 'admin PIN 111111; auditor1/verifier1/owner1 PIN 222222' : 'admin temporary PIN ' + adminPin);
});
