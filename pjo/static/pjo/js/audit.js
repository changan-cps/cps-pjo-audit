/* CPS PJO Audit – audit form
 * Renders the 4 sheets from the template snapshot, autosaves every change as an
 * idempotent op (queued in localStorage when offline), opens the issue window on ×,
 * runs the timestamp-based stopwatch and captures signatures.
 */
(function () {
  'use strict';

  // ------------------------------------------------------------ boot
  const B = JSON.parse(document.getElementById('boot').textContent);
  const SNAP = B.snapshot;
  let ST = B.state;
  const AID = ST.id;
  const SYM = { pass: '√', fail: '×', na: 'N/A' };
  const SYM_TH = { pass: 'ปฏิบัติตามมาตรฐาน', fail: 'ไม่ปฏิบัติตามมาตรฐาน', na: 'ไม่เกี่ยวข้อง' };
  const PAGE_LOADED_AT = Date.now();
  const SERVER_OFFSET = ST.server_now - PAGE_LOADED_AT; // server clock minus device clock
  const $ = (s, r) => (r || document).querySelector(s);

  // ------------------------------------------------------------ small utils
  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }
  function lsGet(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  function cookie(name) {
    const m = document.cookie.match('(^|;)\\s*' + name + '\\s*=\\s*([^;]+)');
    return m ? decodeURIComponent(m.pop()) : '';
  }
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k === 'value') el.value = v;
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, v);
      }
    }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  function toast(msg, err) {
    const t = h('div', { class: 'toast' + (err ? ' err' : ''), role: 'alert', text: msg });
    document.body.append(t);
    setTimeout(() => t.remove(), err ? 6000 : 3000);
  }
  async function req(url, body, method) {
    const opt = { method: method || (body ? 'POST' : 'GET'), headers: { 'X-CSRFToken': cookie('csrftoken') }, credentials: 'same-origin' };
    if (body instanceof FormData) opt.body = body;
    else if (body) { opt.body = JSON.stringify(body); opt.headers['Content-Type'] = 'application/json'; }
    const r = await fetch(url, opt); // network failure throws
    let data = {};
    try { data = await r.json(); } catch (e) { data = { message: 'เซิร์ฟเวอร์ตอบกลับไม่ถูกต้อง (' + r.status + ')' }; }
    return { ok: r.ok, status: r.status, data };
  }
  function fmtSec(s) { return s === null || s === undefined ? '–' : Number(s).toFixed(2); }
  function clock(ms) {
    ms = Math.max(0, ms);
    const m = Math.floor(ms / 60000), s = (ms % 60000) / 1000;
    return (m ? m + ':' + (s < 10 ? '0' : '') : '') + s.toFixed(2);
  }

  // ------------------------------------------------------------ template index
  const ITEMS = {};
  SNAP.s1.items.forEach(i => { ITEMS[i.key] = Object.assign({ sheet: 's1' }, i); });
  SNAP.s2.sections.forEach(s => s.items.forEach(i => { ITEMS[i.key] = Object.assign({ sheet: 's2', section: s.code }, i); }));
  SNAP.s3.questions.forEach(q => { ITEMS[q.key] = Object.assign({ sheet: 's3' }, q); });
  SNAP.s4.cases.forEach(c => { ITEMS[c.key] = Object.assign({ sheet: 's4' }, c); });
  const NOCC = SNAP.s1.frequency_count || 12;
  const itemLabel = (it) => it.sheet === 's2' ? it.code : (it.sheet === 's4' ? 'กรณี ' + it.no : 'ข้อ ' + it.no);

  // ------------------------------------------------------------ ui state
  const ui = {
    tab: lsGet('pjo-tab-' + AID) || 's1',
    view: lsGet('pjo-view') || (window.innerWidth < 900 ? 'occ' : 'grid'),
    occ: 1,
    tool: 'pass',
  };
  const canEdit = () => ST.can_edit && ST.status !== 'cancelled';
  const isLocked = (sheet) => !canEdit() || ST.locked.indexOf(sheet) >= 0;

  // ------------------------------------------------------------ save queue
  const QK = 'pjo-queue-' + AID;
  let queue = lsGet(QK) || [];
  let inflight = null, netErr = false, lastSaved = null, storageOk = true, flushTimer = null;

  function persistQueue() { storageOk = lsSet(QK, queue); }

  function enqueue(op) {
    // coalesce edits of the same text field / header that have not been sent yet
    const sameKey = (o) => o.type === op.type && !o._sent && (
      (op.type === 'header') ||
      (op.type === 's3' && o.item_key === op.item_key && o.field === op.field && op.field !== 'before' && op.field !== 'after') ||
      ((op.type === 'suggestion' || op.type === 's4') && o.client_id === op.client_id && !o.delete && !op.delete) ||
      (op.type === 'followup' && o.id === op.id));
    const prev = queue.find(sameKey);
    if (prev) {
      if (op.type === 'header' || op.type === 'suggestion' || op.type === 's4' || op.type === 'followup') prev.fields = Object.assign({}, prev.fields, op.fields);
      else prev.value = op.value;
    } else {
      op.op_id = uid();
      queue.push(op);
    }
    persistQueue();
    renderSave();
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 350);
  }

  async function flush() {
    if (inflight || !queue.length) { renderSave(); return; }
    const batch = [];
    let header = false;
    for (const o of queue) {
      if (batch.length >= 40) break;
      if (o.type === 'header') { if (header) break; header = true; o.lock_version = ST.lock_version; }
      o._sent = true;
      batch.push(o);
    }
    persistQueue();
    inflight = batch;
    renderSave();
    try {
      const r = await req(B.urls.ops, { ops: batch.map(o => { const c = Object.assign({}, o); delete c._sent; return c; }) });
      if (r.status === 403) { toast(r.data.message || 'ไม่มีสิทธิ์แก้ไข', true); queue = queue.filter(o => batch.indexOf(o) < 0); }
      else if (!r.ok) throw new Error(r.data.message || 'save failed');
      else {
        for (const res of r.data.results) {
          const op = batch.find(o => o.op_id === res.op_id);
          queue = queue.filter(o => o.op_id !== res.op_id);
          if (op) onResult(op, res);
        }
        ST.lock_version = r.data.lock_version;
        ST.status = r.data.status;
        lastSaved = r.data.saved_at;
        netErr = false;
      }
    } catch (e) {
      netErr = true;
      batch.forEach(o => { o._sent = false; });
    }
    inflight = null;
    persistQueue();
    renderSave();
    renderStatus();
    if (queue.length) setTimeout(flush, netErr ? 6000 : 30);
  }

  function onResult(op, res) {
    if (res.status === 'ok') {
      if (op.type === 'mark') {
        const k = op.item_key + '|' + op.occurrence;
        if (ST.marks[k]) { ST.marks[k].pending = false; ST.marks[k].at = new Date(res.recorded_at).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }); }
        if (res.needs_issue && op._ask !== false) openFinding({ sheet: ITEMS[op.item_key].sheet, item_key: op.item_key, occurrence: op.occurrence });
      }
      if (op.type === 's3' && ST.s3[op.item_key]) { ST.s3[op.item_key]._srv = ST.s3[op.item_key]._srv || {}; ST.s3[op.item_key]._srv[op.field] = op.value; }
      return;
    }
    toast(res.message || 'บันทึกไม่สำเร็จ', true);
    if (op.type === 'mark') {
      const k = op.item_key + '|' + op.occurrence;
      if (res.current) ST.marks[k] = { v: res.current, by: res.by || '' }; else delete ST.marks[k];
      renderSheet();
    } else if (res.code === 'conflict' || res.code === 'locked') {
      refreshState();
    }
  }

  function renderSave() {
    const el = $('#saveState');
    const n = queue.length;
    let cls = '', txt;
    if (!storageOk && n) { cls = 'error'; txt = 'เบราว์เซอร์ไม่ให้เก็บข้อมูลในเครื่อง: อย่าปิดหน้านี้จนกว่าจะบันทึกขึ้น server'; }
    else if (n && (netErr || !navigator.onLine)) { cls = 'offline'; txt = 'ยังไม่ถึง server · เก็บในเครื่องนี้ ' + n + ' รายการ (รอ Sync)'; }
    else if (n) { cls = 'pending'; txt = 'กำลังบันทึก… ' + n + ' รายการ'; }
    else txt = lastSaved ? 'บันทึกขึ้น server แล้ว ' + lastSaved : 'ข้อมูลตรงกับ server';
    el.className = 'savestate ' + cls;
    $('.txt', el).textContent = txt;
  }
  window.addEventListener('online', () => { netErr = false; flush(); });
  window.addEventListener('offline', renderSave);
  window.addEventListener('beforeunload', (e) => { if (queue.length) { e.preventDefault(); e.returnValue = ''; } });

  function applyLocal(op) {
    if (op.type === 'mark') {
      const k = op.item_key + '|' + op.occurrence;
      if (op.value) ST.marks[k] = { v: op.value, by: B.user.name, at: 'ยังไม่ถึง server', pending: true }; else delete ST.marks[k];
    } else if (op.type === 'header') Object.assign(ST.header, op.fields);
    else if (op.type === 's3') { ST.s3[op.item_key] = ST.s3[op.item_key] || {}; ST.s3[op.item_key][op.field] = op.value; }
    else if (op.type === 'suggestion') {
      let r = ST.suggestions.find(x => x.client_id === op.client_id);
      if (op.delete) ST.suggestions = ST.suggestions.filter(x => x.client_id !== op.client_id);
      else { if (!r) { r = { client_id: op.client_id }; ST.suggestions.push(r); } Object.assign(r, op.fields); }
    } else if (op.type === 's4') {
      let r = ST.s4.find(x => x.client_id === op.client_id);
      if (op.delete) ST.s4 = ST.s4.filter(x => x.client_id !== op.client_id);
      else { if (!r) { r = { client_id: op.client_id }; ST.s4.push(r); } Object.assign(r, op.fields); }
    } else if (op.type === 'followup') {
      const f = ST.followups.find(x => x.id === op.id);
      if (f) Object.assign(f, op.fields);
    }
  }

  async function refreshState() {
    try {
      const r = await req(B.urls.state);
      if (r.ok) {
        ST = r.data.state;
        queue.forEach(applyLocal); // keep unsynced local edits visible
        renderAll();
      }
    } catch (e) { netErr = true; renderSave(); }
  }

  // ------------------------------------------------------------ header
  const HEADER = [
    ['audit_date', 'วันที่', 'date'], ['shift', 'กะ', 'text'], ['group', 'Group', 'text'], ['line', 'Line', 'text'],
    ['station', 'Station', 'text'], ['model', 'Model', 'text'], ['employee_name', 'พนักงานที่ถูกตรวจ', 'text'],
    ['tlgl_name', 'TL/GL', 'text'], ['ois_revision', 'OIS/WES Revision', 'text'], ['ois_url', 'ลิงก์ OIS/WES', 'url'],
  ];
  function renderHeader() {
    const box = $('#headerFields');
    box.textContent = '';
    const ro = (label, val) => h('div', null, h('label', { text: label }), h('div', { class: 'box', style: 'min-height:40px', text: val || '–' }));
    box.append(ro('เลข Audit', ST.audit_no + (ST.revision > 1 ? ' (Rev ' + ST.revision + ')' : '')));
    box.append(ro('Workshop', SNAP.name));
    box.append(ro('Template Version', B.meta.template_label));
    box.append(ro('ผู้ตรวจ', B.meta.auditor));
    if (B.meta.team) box.append(ro('Team', B.meta.team));
    const locked = isLocked('header');
    HEADER.forEach(([f, label, type]) => {
      const id = 'hf-' + f;
      const inp = h('input', { id, type, value: ST.header[f] || '', disabled: locked });
      inp.addEventListener('change', () => { const op = { type: 'header', fields: { [f]: inp.value } }; applyLocal(op); enqueue(op); });
      box.append(h('div', null, h('label', { for: id, text: label }), inp));
    });
    box.append(h('div', null, h('label', { for: 'hf-std', text: 'Standard Time (วินาที)' }),
      numIn('standard_time_s', 'hf-std', locked), srcIn('standard_time_source', 'แหล่งที่มา Standard Time', locked)));
    box.append(h('div', null, h('label', { for: 'hf-takt', text: 'Takt Time (วินาที)' }),
      numIn('takt_time_s', 'hf-takt', locked), srcIn('takt_time_source', 'แหล่งที่มา Takt Time', locked)));
  }
  function numIn(f, id, locked) {
    const i = h('input', { id, type: 'number', step: '0.01', min: '0', value: ST.header[f] || '', disabled: locked });
    i.addEventListener('change', () => { const op = { type: 'header', fields: { [f]: i.value } }; applyLocal(op); enqueue(op); });
    return i;
  }
  function srcIn(f, ph, locked) {
    const i = h('input', { type: 'text', placeholder: ph, 'aria-label': ph, value: ST.header[f] || '', disabled: locked, style: 'margin-top:4px' });
    i.addEventListener('change', () => { const op = { type: 'header', fields: { [f]: i.value } }; applyLocal(op); enqueue(op); });
    return i;
  }

  // ------------------------------------------------------------ status bar
  function renderStatus() {
    const b = $('#statusBadge');
    const th = { draft: 'ร่าง', in_progress: 'กำลังตรวจ', pending_signatures: 'รอลงนาม', completed: 'ตรวจและลงนามครบ', amended: 'แก้ไขหลังลงนาม · รอลงนามใหม่', cancelled: 'ยกเลิก' };
    b.className = 'badge b-' + ST.status;
    b.textContent = (th[ST.status] || ST.status) + (ST.revision > 1 ? ' · Rev ' + ST.revision : '');
    const flags = $('#flags');
    flags.textContent = '';
    if (ST.status === 'completed' && ST.open_issues) flags.append(h('span', { class: 'badge b-pending', text: 'ตรวจครบ แต่ยังมีปัญหาเปิด ' + ST.open_issues + ' รายการ' }));
    else if (ST.open_issues) flags.append(h('span', { class: 'badge b-open', text: 'ปัญหาเปิด ' + ST.open_issues }));
    if (ST.recert_pending) flags.append(' ', h('span', { class: 'badge b-major', text: 'รอรับรองใหม่ ' + ST.recert_pending }));
    const unlogged = unloggedFails();
    if (unlogged.length) flags.append(' ', h('span', { class: 'badge b-open', text: '× ยังไม่บันทึกปัญหา ' + unlogged.length }));
    const signed = ST.signatures.filter(s => s.required && s.signed).length, req = ST.signatures.filter(s => s.required).length;
    $('#btnSigs').textContent = 'ลงนาม (' + signed + '/' + req + ')';
    $('#btnSubmit').classList.toggle('hidden', !canEdit() || !['draft', 'in_progress', 'amended'].includes(ST.status));
    $('#btnSubmit').textContent = ST.status === 'amended' ? 'ส่งลงนามใหม่' : 'ตรวจเสร็จ ส่งลงนาม';
    $('#btnAmend').classList.toggle('hidden', !canEdit() || !ST.signatures.some(s => s.signed));
    $('#btnCancel').classList.toggle('hidden', !canEdit() || ST.status === 'completed');
  }
  function unloggedFails() {
    return Object.entries(ST.marks).filter(([k, m]) => m.v === 'fail' && !ST.findings[k]).map(([k]) => k);
  }

  // ------------------------------------------------------------ tabs
  const TABS = [
    ['s1', 'ระยะที่ 1 ส่วนที่ 1 · สังเกตการปฏิบัติงานตามมาตรฐาน'],
    ['s2', 'ระยะที่ 1 ส่วนที่ 2 · ค้นหาโอกาสปรับปรุง'],
    ['s3', 'ระยะที่ 2 · ประเมินความเข้าใจเชิงลึกและสอนงาน'],
    ['s4', 'ระยะที่ 3 · ทบทวนการจัดการความผิดปกติ'],
  ];
  function renderTabs() {
    const t = $('#tabs');
    t.textContent = '';
    TABS.forEach(([k, sub]) => {
      t.append(h('button', {
        type: 'button', role: 'tab', class: ui.tab === k ? 'on' : '', 'aria-selected': ui.tab === k ? 'true' : 'false',
        onclick: () => { ui.tab = k; lsSet('pjo-tab-' + AID, k); renderTabs(); renderSheet(); },
      }, h('span', { class: 'long', text: SNAP[k].sheet_name }), h('span', { class: 'short', text: 'ตาราง ' + k.slice(1) }),
        isLocked(k) && ST.can_edit ? ' 🔒' : '', h('small', { text: sub })));
    });
  }
  function renderSheet() {
    const box = $('#sheet');
    box.textContent = '';
    ({ s1: renderS1, s2: renderS2, s3: renderS3, s4: renderS4 })[ui.tab](box);
    renderStatus();
  }
  function renderAll() { renderHeader(); renderTabs(); renderSheet(); renderSave(); }

  function lockNote(sheet) {
    if (!ST.can_edit) return h('div', { class: 'notice info', text: 'ดูได้อย่างเดียว (ไม่มีสิทธิ์แก้ไข Audit นี้)' });
    if (ST.status === 'cancelled') return h('div', { class: 'notice err', text: 'Audit นี้ถูกยกเลิกแล้ว' });
    if (isLocked(sheet)) return h('div', { class: 'notice info', text: 'ส่วนนี้ลงนามแล้วและถูกล็อก หากต้องแก้ไขให้กด “ขอแก้ไขหลังลงนาม” พร้อมเหตุผล ระบบจะเก็บข้อมูลและลายเซ็นเดิมไว้' });
    return null;
  }

  // ------------------------------------------------------------ marks
  function setMark(key, occ, value) {
    const it = ITEMS[key];
    if (isLocked(it.sheet)) { toast('ส่วนนี้ถูกล็อก', true); return; }
    const k = key + '|' + occ;
    const cur = ST.marks[k] ? ST.marks[k].v : '';
    if (value === cur) return;
    if (value === 'na' && !it.allow_na) { toast('ข้อนี้ไม่อนุญาต N/A', true); return; }
    // prev = value the server is expected to hold, so concurrent edits are detected
    const pendingSame = queue.filter(o => o.type === 'mark' && o.item_key === key && o.occurrence === occ);
    const prev = pendingSame.length ? pendingSame[pendingSame.length - 1].value : cur;
    const op = { type: 'mark', item_key: key, occurrence: occ, value, prev };
    if (value === 'fail' && ST.findings[k]) op._ask = false;
    applyLocal(op);
    enqueue(op);
    renderSheet();
    if (value === 'fail' && !ST.findings[k] && (!navigator.onLine || netErr)) openFinding({ sheet: it.sheet, item_key: key, occurrence: occ });
  }

  function markEl(v) {
    return h('span', { class: 'mk ' + (v || 'empty'), title: v ? SYM_TH[v] : 'ยังไม่ได้ตรวจ', text: v ? SYM[v] : '·' });
  }

  // ------------------------------------------------------------ sheet 1
  function renderS1(box) {
    const s = SNAP.s1;
    box.append(h('div', { class: 'sheettitle', text: s.title }));
    const ln = lockNote('s1'); if (ln) box.append(ln);
    box.append(h('div', { class: 'legend' },
      h('span', null, markEl('fail'), ' ', s.legend.fail.replace(/X/g, '').trim()),
      h('span', null, markEl('pass'), ' ', s.legend.pass.replace('√', '').trim()),
      h('span', null, markEl('na'), ' ', s.legend.na.replace('N/A', '').trim()),
      h('span', null, markEl(''), ' ช่องว่าง = ยังไม่ได้ตรวจ (ไม่ใช่ผ่าน)')));

    // OIS pre-check (row A4 of the form)
    const lockedH = isLocked('header');
    const oisBtn = (val, label) => h('button', {
      type: 'button', class: 'btn small' + (ST.header.ois_current === val ? ' primary' : ''), disabled: lockedH,
      onclick: () => { const op = { type: 'header', fields: { ois_current: val } }; applyLocal(op); enqueue(op); renderSheet(); },
    }, label);
    box.append(h('div', { class: 'card', style: 'padding:10px 12px;margin-bottom:8px' },
      h('div', { class: 'btnrow', style: 'justify-content:space-between' },
        h('span', null, h('b', { text: s.ois_check.text })),
        h('span', { class: 'btnrow' }, oisBtn('yes', 'Yes'), oisBtn('no', 'No'),
          h('button', { type: 'button', class: 'btn small', onclick: openOis }, 'เปิด OIS/WES'))),
      ST.header.ois_current === 'no' ? h('div', { class: 'notice', text: 'OIS ไม่ใช่ฉบับปัจจุบัน: บันทึกเป็นปัญหาเพื่อติดตามการอัปเดตเอกสาร' }) : null));

    box.append(h('div', { class: 'resp' },
      h('div', { class: 'maj' }, h('span', { class: 'badge b-major' }, 'ความผิดปกติหลัก · ข้อ 1–4'), h('div', { text: s.major_response.text })),
      h('div', { class: 'min' }, h('span', { class: 'badge b-minor' }, 'ความผิดปกติรอง · ข้อ 5–' + s.items[s.items.length - 1].no), h('div', { text: s.minor_response.text }))));

    box.append(h('div', { class: 'btnrow', style: 'margin-bottom:8px' },
      h('button', { type: 'button', class: 'btn small' + (ui.view === 'grid' ? ' primary' : ''), onclick: () => { ui.view = 'grid'; lsSet('pjo-view', 'grid'); renderSheet(); } }, 'ตารางเต็ม'),
      h('button', { type: 'button', class: 'btn small' + (ui.view === 'occ' ? ' primary' : ''), onclick: () => { ui.view = 'occ'; lsSet('pjo-view', 'occ'); renderSheet(); } }, 'ตรวจทีละครั้ง')));

    if (ui.view === 'grid') renderS1Grid(box); else renderS1Occ(box);

    // problems found
    const f1 = Object.entries(ST.findings).filter(([k]) => k.startsWith('S1-'));
    box.append(h('h3', { text: (s.labels.find(l => l.role === 'problems') || { text: 'ปัญหาที่พบจากการสังเกต:' }).text }));
    box.append(findingTable(f1));
    renderFollowups(box);
    box.append(h('h3', { text: 'ลายเซ็น (ตาราง 1)' }));
    box.append(sigBlocks(['employee_major', 'employee_minor']));
  }

  function cellState(key, occ) {
    const k = key + '|' + occ;
    return { m: ST.marks[k], f: ST.findings[k] };
  }

  function renderS1Grid(box) {
    const locked = isLocked('s1');
    if (!locked) {
      const tools = [['pass', '√ ปฏิบัติตาม'], ['fail', '× ไม่ปฏิบัติตาม'], ['na', 'N/A'], ['', 'ล้างช่อง']];
      box.append(h('div', { class: 'toolbox' }, h('span', { class: 'muted', text: 'เลือกเครื่องหมาย แล้วแตะช่อง:' }),
        tools.map(([v, l]) => h('button', { type: 'button', class: 'tool t-' + (v || 'clear') + (ui.tool === v ? ' on' : ''), 'aria-pressed': ui.tool === v ? 'true' : 'false', onclick: () => { ui.tool = v; renderSheet(); } }, l))));
    }
    const occs = Array.from({ length: NOCC }, (_, i) => i + 1);
    const thead = h('thead', null, h('tr', null, h('th', { class: 'q' }, SNAP.s1.frequency_label || 'ความถี่', ' → ครั้งที่สังเกต'), occs.map(o => h('th', { scope: 'col', text: o }))));
    const tb = h('tbody');
    const grp = (label, cls) => tb.append(h('tr', { class: 'grp' }, h('td', { colspan: NOCC + 1 }, h('span', { class: 'badge ' + cls, text: label }))));
    let lastSev = null;
    SNAP.s1.items.forEach(it => {
      if (it.severity !== lastSev) { grp(it.severity === 'major' ? '(1) ความผิดปกติหลัก' : '(2) ความผิดปกติรอง', it.severity === 'major' ? 'b-major' : 'b-minor'); lastSev = it.severity; }
      const tr = h('tr', null, h('td', { class: 'q' }, it.text, h('div', { class: 'src', text: it.source.sheet + '!' + it.source.cell })));
      occs.forEach(o => {
        const { m, f } = cellState(it.key, o);
        const btn = h('button', {
          type: 'button', class: 'cellbtn' + (locked ? ' locked' : ''),
          'aria-label': itemLabel(it) + ' ครั้งที่ ' + o + ': ' + (m ? SYM_TH[m.v] : 'ยังไม่ได้ตรวจ'),
          title: m ? (m.by + ' · ' + (m.at || '')) : 'ยังไม่ได้ตรวจ',
          onclick: () => {
            if (locked) { if (f) location.href = '/issues/' + f.id + '/'; return; }
            if (ui.tool === 'na' && !it.allow_na) { toast('ข้อนี้ไม่อนุญาต N/A', true); return; }
            if (m && m.v === 'fail' && ui.tool === 'fail' && !f) { openFinding({ sheet: 's1', item_key: it.key, occurrence: o }); return; }
            setMark(it.key, o, ui.tool);
          },
        }, markEl(m && m.v));
        if (m && m.v === 'fail') btn.append(f ? h('span', { class: 't', text: f.issue_no.slice(-5) }) : h('span', { class: 'warn', text: '! บันทึก' }));
        if (m && m.pending) btn.append(h('span', { class: 't', text: '⋯' }));
        tr.append(h('td', { class: 'cell' }, btn));
      });
      tb.append(tr);
      if (it.kind === 'timing') {
        const tr2 = h('tr', null, h('td', { class: 'q' }, h('b', { text: '⏱ เวลาที่วัด (วินาที เฉลี่ยรอบที่ใช้)' }), h('div', { class: 'meta', text: 'แตะช่องเพื่อเปิดตัวจับเวลา · ครั้งที่สังเกต ≠ รอบจับเวลา' })));
        occs.forEach(o => {
          const t = ST.timing.find(x => x.item_key === it.key && x.observation === o);
          const running = timerRunning(it.key, o);
          tr2.append(h('td', { class: 'cell' }, h('button', {
            type: 'button', class: 'cellbtn', 'aria-label': 'จับเวลา ครั้งที่สังเกต ' + o, onclick: () => openTimer(it.key, o),
          }, running ? h('span', { class: 'warn', text: '● REC' }) : (t ? h('span', { text: fmtSec(t.avg) }) : h('span', { class: 'mk empty', text: '⏱' })),
          t ? h('span', { class: 't', text: t.count_used + ' รอบ' }) : null)));
        });
        tb.append(tr2);
      }
    });
    box.append(h('div', { class: 'tablewrap', style: 'max-height:72vh' }, h('table', { class: 's1grid' }, thead, tb)));
  }

  function renderS1Occ(box) {
    const locked = isLocked('s1');
    const bar = h('div', { class: 'occbar', role: 'tablist', 'aria-label': 'ครั้งที่สังเกต' });
    for (let o = 1; o <= NOCC; o++) {
      const anyFail = SNAP.s1.items.some(it => (ST.marks[it.key + '|' + o] || {}).v === 'fail');
      const done = SNAP.s1.items.every(it => ST.marks[it.key + '|' + o]);
      bar.append(h('button', { type: 'button', class: ui.occ === o ? 'on' : '', 'aria-label': 'ครั้งที่ ' + o + (done ? ' ตรวจครบ' : ''), onclick: () => { ui.occ = o; renderSheet(); } },
        String(o), done ? '✓' : '', anyFail ? h('span', { class: 'pip' }) : null));
    }
    box.append(h('div', { class: 'muted', text: 'ครั้งที่สังเกต (ตามช่อง ' + (SNAP.s1.frequency_label || 'ความถี่') + ' 1–' + NOCC + ' ในแบบฟอร์ม)' }), bar);
    const o = ui.occ;
    let lastSev = null;
    SNAP.s1.items.forEach(it => {
      if (it.severity !== lastSev) {
        box.append(h('div', { style: 'margin:10px 0 6px' }, h('span', { class: 'badge ' + (it.severity === 'major' ? 'b-major' : 'b-minor'), text: it.severity === 'major' ? '(1) ความผิดปกติหลัก' : '(2) ความผิดปกติรอง' })));
        lastSev = it.severity;
      }
      const { m, f } = cellState(it.key, o);
      const choice = h('div', { class: 'choice' + (it.allow_na ? '' : ' two') });
      [['pass', '√'], ['fail', '×'], ['na', 'N/A']].forEach(([v, l]) => {
        if (v === 'na' && !it.allow_na) return;
        choice.append(h('button', {
          type: 'button', class: 'c-' + v + (m && m.v === v ? ' on' : ''), disabled: locked, 'aria-pressed': m && m.v === v ? 'true' : 'false',
          'aria-label': l + ' ' + SYM_TH[v], onclick: () => setMark(it.key, o, m && m.v === v ? '' : v),
        }, l));
      });
      const card = h('div', { class: 'itemcard' }, h('div', { class: 'txt', text: it.text }), choice,
        h('div', { class: 'meta', text: m ? ('บันทึกโดย ' + m.by + ' · ' + (m.at || '')) : 'ยังไม่ได้ตรวจ · แตะปุ่มที่เลือกซ้ำเพื่อล้าง' }));
      if (m && m.v === 'fail') {
        card.append(f ? h('div', { class: 'meta' }, 'ปัญหา: ', h('a', { href: '/issues/' + f.id + '/', text: f.issue_no + ' ' + f.title }), ' ', h('span', { class: 'badge b-' + f.status, text: f.status_th }))
          : h('button', { type: 'button', class: 'btn small danger', style: 'margin-top:6px', onclick: () => openFinding({ sheet: 's1', item_key: it.key, occurrence: o }) }, '! บันทึกปัญหาของช่องนี้'));
      }
      if (it.kind === 'timing') {
        const t = ST.timing.find(x => x.item_key === it.key && x.observation === o);
        card.append(h('div', { class: 'btnrow', style: 'margin-top:8px' },
          h('button', { type: 'button', class: 'btn primary', onclick: () => openTimer(it.key, o) }, timerRunning(it.key, o) ? '● กำลังจับเวลา (เปิด)' : '⏱ จับเวลา ครั้งที่สังเกต ' + o),
          t ? h('span', { class: 'meta', text: 'เฉลี่ย ' + fmtSec(t.avg) + ' s · ต่ำสุด ' + fmtSec(t.min) + ' · สูงสุด ' + fmtSec(t.max) + ' · ใช้ ' + t.count_used + '/' + t.count_total + ' รอบ · ' + t.evaluation }) : null));
      }
      box.append(card);
    });
    box.append(h('div', { class: 'btnrow' },
      h('button', { type: 'button', class: 'btn', disabled: o <= 1, onclick: () => { ui.occ--; renderSheet(); window.scrollTo(0, $('#tabs').offsetTop); } }, '← ครั้งก่อน'),
      h('button', { type: 'button', class: 'btn', disabled: o >= NOCC, onclick: () => { ui.occ++; renderSheet(); window.scrollTo(0, $('#tabs').offsetTop); } }, 'ครั้งถัดไป →'),
      h('button', { type: 'button', class: 'btn', onclick: () => { ui.view = 'grid'; renderSheet(); } }, 'ดูตารางเต็ม')));
  }

  function findingTable(entries) {
    if (!entries.length) return h('p', { class: 'muted', text: 'ยังไม่มีปัญหา' });
    const seen = {};
    const rows = [];
    entries.forEach(([k, f]) => {
      const [key, occ] = k.split('|');
      const it = ITEMS[key];
      if (!seen[f.id]) { seen[f.id] = { f, refs: [] }; rows.push(seen[f.id]); }
      seen[f.id].refs.push((it ? itemLabel(it) : key) + (occ !== '0' ? ' ครั้งที่ ' + occ : ''));
    });
    return h('div', { class: 'tablewrap' }, h('table', { class: 'tbl' },
      h('tr', null, ['Issue', 'อ้างอิงข้อ', 'รายละเอียด', 'ผู้รับผิดชอบ', 'กำหนดเสร็จ', 'สถานะ'].map(t => h('th', { text: t }))),
      rows.map(({ f, refs }) => h('tr', null,
        h('td', null, h('a', { href: '/issues/' + f.id + '/', text: f.issue_no })), h('td', { text: refs.join(', ') }), h('td', { text: f.title }),
        h('td', { text: f.owner || '–' }), h('td', { text: f.due_date || '–' }),
        h('td', null, h('span', { class: 'badge b-' + f.status, text: f.status_th }), f.overdue ? h('span', { class: 'badge b-overdue', text: 'เกินกำหนด' }) : null)))));
  }

  // major abnormality response
  function renderFollowups(box) {
    if (!ST.followups.length) return;
    box.append(h('h3', { text: 'การตอบสนองความผิดปกติหลัก (ตามมาตรฐาน)' }));
    box.append(h('div', { class: 'notice err' }, h('b', { text: 'มาตรฐาน: ' }), SNAP.s1.major_response.text,
      h('div', { class: 'meta', text: 'โปรแกรมบันทึกสิ่งที่ดำเนินการเท่านั้น ไม่ควบคุมเครื่องจักรและไม่อนุญาตให้กลับเข้าทำงานแทนผู้มีอำนาจ' })));
    ST.followups.forEach(f => {
      const it = ITEMS[f.item_key];
      const recertSigned = f.signatures.some(s => s.signed);
      const lock = !canEdit() || recertSigned;
      const fld = (name, label, type) => {
        const id = 'fu-' + f.id + '-' + name;
        const val = (f[name] || '').slice(0, type === 'datetime-local' ? 16 : undefined);
        const inp = type === 'textarea' ? h('textarea', { id, disabled: lock }, val) : h('input', { id, type, value: val, disabled: lock });
        inp.addEventListener('change', () => { const op = { type: 'followup', id: f.id, fields: { [name]: inp.value } }; applyLocal(op); enqueue(op); });
        return h('div', null, h('label', { for: id, text: label }), inp);
      };
      box.append(h('div', { class: 'card' },
        h('div', { class: 'btnrow', style: 'justify-content:space-between' },
          h('b', null, itemLabel(it) + ' ครั้งที่ ' + f.occurrence + ' · ', h('a', { href: '/issues/' + f.issue.id + '/', text: f.issue.issue_no })),
          h('span', { class: 'badge ' + (f.stage === 'recertified' ? 'b-closed' : 'b-major'), text: f.stage_th })),
        h('div', { class: 'grid', style: 'margin-top:8px' },
          fld('supervisor_notified', '1. แจ้งหัวหน้า (ใคร / เวลา)', 'text'), fld('immediate_action', '2. การจัดการทันที', 'textarea'),
          fld('training_by', '3. ผู้ฝึกอบรม (ออฟไลน์)', 'text'), fld('training_at', 'วันเวลาฝึกอบรม', 'datetime-local'),
          fld('training_detail', 'เนื้อหาการฝึกอบรม', 'textarea'), fld('recert_by', '4. ผู้ตรวจรับรองใหม่', 'text'),
          fld('recert_at', 'วันเวลาสังเกตซ้ำ', 'datetime-local'), fld('recert_result', 'ผลการสังเกตซ้ำ', 'textarea')),
        h('div', { class: 'sigs' }, f.signatures.map(s => sigCard(s, f.id)))));
    });
  }

  // ------------------------------------------------------------ sheet 2
  function renderS2(box) {
    const s = SNAP.s2;
    box.append(h('div', { class: 'sheettitle', text: s.title }));
    const ln = lockNote('s2'); if (ln) box.append(ln);
    box.append(h('div', { class: 'legend' }, h('span', null, markEl('pass'), ' ไม่มีปัญหาและไม่สามารถปรับปรุงได้'), h('span', null, markEl('fail'), ' มีสิ่งผิดปกติและสามารถปรับปรุงได้'), h('span', { class: 'muted', text: '(ตามหมายเหตุของแบบฟอร์ม)' })));
    const locked = isLocked('s2');
    const wide = window.innerWidth >= 900;
    s.sections.forEach(sec => {
      const left = sec.items.filter(i => i.source.cell[0] === 'B'), right = sec.items.filter(i => i.source.cell[0] !== 'B');
      const cell = (it) => {
        if (!it) return [h('td'), h('td')];
        const k = it.key + '|0', m = ST.marks[k], f = ST.findings[k];
        const ch = h('div', { class: 'choice' });
        [['pass', '√'], ['fail', '×']].forEach(([v, l]) => ch.append(h('button', {
          type: 'button', class: 'c-' + v + (m && m.v === v ? ' on' : ''), disabled: locked, 'aria-pressed': m && m.v === v ? 'true' : 'false',
          'aria-label': it.code + ' ' + l, onclick: () => setMark(it.key, 0, m && m.v === v ? '' : v),
        }, l)));
        const extra = m && m.v === 'fail' ? (f ? h('a', { class: 'meta', href: '/issues/' + f.id + '/', text: f.issue_no }) :
          h('button', { type: 'button', class: 'btn small danger', style: 'margin-top:4px', onclick: () => openFinding({ sheet: 's2', item_key: it.key, occurrence: 0 }) }, '! บันทึก')) : null;
        return [h('td', null, h('b', { text: it.code + ' ' }), it.text.replace(/^\s*\d+\s*\.?\s*/, '')), h('td', { class: 'm' }, ch, extra)];
      };
      const tbl = h('table', { class: 'tbl s2tbl' }, h('tr', { class: 'sec' }, h('td', { colspan: wide ? 4 : 2, text: sec.title })));
      if (wide) {
        for (let i = 0; i < Math.max(left.length, right.length); i++) tbl.append(h('tr', null, ...cell(left[i]), ...cell(right[i])));
      } else sec.items.forEach(it => tbl.append(h('tr', null, ...cell(it))));
      box.append(h('div', { class: 'tablewrap', style: 'margin-bottom:10px' }, tbl));
    });
    box.append(h('h3', { text: s.log_title ? s.log_title.text : 'บันทึกโอกาสการปรับปรุงที่เป็นไปได้:' }));
    const rows = Object.entries(ST.findings).filter(([k]) => k.startsWith('S2-'));
    const uniq = []; const seen = {};
    rows.forEach(([k, f]) => { if (!seen[f.id]) { seen[f.id] = 1; uniq.push([k, f]); } });
    const cols = s.table_columns.map(c => c.text);
    const t = h('table', { class: 'tbl' }, h('tr', null, cols.map(c => h('th', { text: c }))));
    uniq.forEach(([k, f], i) => t.append(h('tr', null, h('td', { text: i + 1 }), h('td', { text: f.item_code || ITEMS[k.split('|')[0]].code }),
      h('td', null, h('a', { href: '/issues/' + f.id + '/', text: f.issue_no }), ' ', f.title), h('td', { text: f.owner || '–' }),
      h('td', { text: f.fix || '–' }),
      h('td', null, h('span', { class: 'badge b-' + f.status, text: f.status_th }), ' ',
        B.gbr ? h('span', { class: 'meta', text: f.gbr ? 'G/B/R: ' + f.gbr : 'G/B/R: ยังไม่ระบุ' }) : h('span', { class: 'meta', text: 'G/B/R: รอยืนยันความหมาย' })))));
    if (!uniq.length) t.append(h('tr', null, h('td', { colspan: cols.length, class: 'muted', text: 'ยังไม่มีรายการ' })));
    box.append(h('div', { class: 'tablewrap' }, t));
    if (!locked) box.append(h('div', { class: 'btnrow', style: 'margin-top:8px' }, h('button', { type: 'button', class: 'btn', onclick: () => openFinding({ sheet: 's2', pickItem: true }) }, '+ เพิ่มแถว (บันทึกโอกาสปรับปรุง)')));
    if (s.note) box.append(h('div', { class: 'box', style: 'margin-top:10px', text: s.note.text }));
  }

  // ------------------------------------------------------------ sheet 3
  function textField(value, onSave, opts) {
    const el = h(opts && opts.input ? 'input' : 'textarea', Object.assign({ disabled: opts && opts.disabled }, opts && opts.input ? { type: 'text', value: value || '' } : {}));
    if (!(opts && opts.input)) el.value = value || '';
    if (opts && opts.label) el.setAttribute('aria-label', opts.label);
    let t;
    el.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => onSave(el.value), 700); });
    el.addEventListener('change', () => { clearTimeout(t); onSave(el.value); });
    return el;
  }
  function s3op(key, field, value) {
    const cur = ST.s3[key] || {};
    const srv = cur._srv || {};
    const op = { type: 's3', item_key: key, field, value };
    if (field === 'before' || field === 'after') op.prev = field in srv ? srv[field] : (cur[field] || '');
    applyLocal(op);
    enqueue(op);
  }
  function renderS3(box) {
    const s = SNAP.s3;
    box.append(h('div', { class: 'sheettitle', text: s.title }));
    const ln = lockNote('s3'); if (ln) box.append(ln);
    box.append(h('div', { class: 'box', text: s.goal.text }));
    box.append(h('div', { class: 'resp' }, h('div', { text: s.step.text }), h('div', { text: s.guidance.text })));
    const locked = isLocked('s3');
    const pf = (key, field, val) => {
      const ch = h('div', { class: 'choice two' });
      [['pass', '√'], ['fail', '×']].forEach(([v, l]) => ch.append(h('button', {
        type: 'button', class: 'c-' + v + (val === v ? ' on' : ''), disabled: locked, 'aria-pressed': val === v ? 'true' : 'false',
        'aria-label': (field === 'before' ? 'ผลก่อนสอน ' : 'ผลหลังสอน ') + l, onclick: () => { s3op(key, field, val === v ? '' : v); renderSheet(); },
      }, l)));
      return ch;
    };
    const t = h('table', { class: 'tbl qa' }, h('tr', null,
      h('th', { text: 'ข้อ' }), h('th', { text: s.col_question || 'คำถาม' }), h('th', { text: s.col_expected || 'ระดับความเข้าใจที่คาดหวัง' }),
      h('th', { text: 'คำตอบจริงของพนักงาน' }), h('th', { text: 'ผลก่อนสอน' }), h('th', { text: 'สิ่งที่ชี้แนะ / ฝึกอบรม' }), h('th', { text: 'ผลหลังสอน' })));
    s.questions.forEach(q => {
      const a = ST.s3[q.key] || {};
      const ans = textField(a.employee_answer, v => s3op(q.key, 'employee_answer', v), { disabled: locked, label: 'คำตอบพนักงาน ข้อ ' + q.no });
      if (q.is_suggestion) {
        t.append(h('tr', null, h('td', { text: q.no }), h('td', { text: q.text }), h('td', { text: q.expected }), h('td', { colspan: 4 }, ans, h('div', { class: 'meta', text: 'บันทึกข้อเสนอแนะแยกในตารางด้านล่าง (ไม่นับเป็นความผิดปกติ)' }))));
        return;
      }
      const gap = a.after === 'fail' || (a.before === 'fail' && !a.after);
      const f = ST.findings[q.key + '|0'];
      t.append(h('tr', null, h('td', { text: q.no }), h('td', null, q.text, h('div', { class: 'src', text: q.source.sheet + '!' + q.source.cell })),
        h('td', { class: 'pre', text: q.expected }), h('td', null, ans), h('td', null, pf(q.key, 'before', a.before)),
        h('td', null, textField(a.coaching, v => s3op(q.key, 'coaching', v), { disabled: locked, label: 'สิ่งที่ชี้แนะ ข้อ ' + q.no })),
        h('td', null, pf(q.key, 'after', a.after), a.by ? h('div', { class: 'meta', text: a.by + ' ' + a.at }) : null,
          f ? h('a', { class: 'meta', href: '/issues/' + f.id + '/', text: f.issue_no }) :
            (gap && !locked ? h('button', { type: 'button', class: 'btn small', style: 'margin-top:4px', onclick: () => openFinding({ sheet: 's3', item_key: q.key, occurrence: 0 }) }, 'บันทึกเป็นปัญหา (ไม่บังคับ)') : null))));
    });
    box.append(h('div', { class: 'tablewrap' }, t));

    // suggestions table
    box.append(h('h3', { text: s.suggestion_title.text }));
    const cols = s.suggestion_columns.map(c => c.text);
    const st = h('table', { class: 'tbl' }, h('tr', null, cols.map(c => h('th', { text: c })), h('th', { text: 'ติดตาม' })));
    ST.suggestions.forEach((r, i) => {
      const upd = (field) => (v) => { const op = { type: 'suggestion', client_id: r.client_id, fields: { [field]: v } }; applyLocal(op); enqueue(op); };
      st.append(h('tr', null, h('td', { text: i + 1 }),
        h('td', null, textField(r.description, upd('description'), { disabled: locked, label: 'คำอธิบายปัญหา' })),
        h('td', null, textField(r.suggestion, upd('suggestion'), { disabled: locked, label: 'ข้อเสนอแนะ' })),
        h('td', null, textField(r.owner_name, upd('owner_name'), { disabled: locked, input: true, label: 'ผู้รับผิดชอบ' })),
        h('td', null, r.issue ? h('a', { href: '/issues/' + r.issue.id + '/', text: r.issue.issue_no }) : (locked ? '–' : h('div', { class: 'btnrow' },
          h('button', { type: 'button', class: 'btn small', onclick: () => { flush(); openFinding({ sheet: 's3', suggestion_id: r.client_id, title: r.description || r.suggestion, issue_type: 'suggestion' }); } }, 'สร้างเป็นปัญหาติดตาม'),
          h('button', { type: 'button', class: 'btn small danger', onclick: () => { const op = { type: 'suggestion', client_id: r.client_id, delete: true }; applyLocal(op); enqueue(op); renderSheet(); } }, 'ลบ'))))));
    });
    if (!ST.suggestions.length) st.append(h('tr', null, h('td', { colspan: cols.length + 1, class: 'muted', text: 'ยังไม่มีข้อเสนอแนะ' })));
    box.append(h('div', { class: 'tablewrap' }, st));
    if (!locked) box.append(h('div', { class: 'btnrow', style: 'margin-top:8px' }, h('button', {
      type: 'button', class: 'btn', onclick: () => { const op = { type: 'suggestion', client_id: uid(), fields: { description: '', suggestion: '', owner_name: '' } }; applyLocal(op); enqueue(op); renderSheet(); },
    }, '+ เพิ่มแถวข้อเสนอแนะ')));
    box.append(h('h3', { text: s.signature.text.replace(/\s+/g, ' ') }));
    box.append(sigBlocks(['supervisor_s3', 'employee_s3']));
  }

  // ------------------------------------------------------------ sheet 4
  function renderS4(box) {
    const s = SNAP.s4;
    box.append(h('div', { class: 'sheettitle', text: s.title }));
    const ln = lockNote('s4'); if (ln) box.append(ln);
    box.append(h('div', { class: 'box', text: s.goal.text }));
    box.append(h('p', { text: s.lead.text }));
    box.append(h('div', { class: 'steps4' }, s.steps.map(st => h('div', null, h('b', { text: st.no }), st.text))));
    // diagram boxes from the form (two rows of 4, read by position)
    if (s.diagram_boxes && s.diagram_boxes.length) {
      const pos = s.diagram_boxes.map(d => { const m = /R(\d+)C(\d+)/.exec(d.source.cell) || [0, 0, 0]; return { t: d.text, r: +m[1], c: +m[2] }; });
      const minR = Math.min(...pos.map(p => p.r));
      const g1 = pos.filter(p => p.r <= minR + 1).sort((a, b) => a.c - b.c), g2 = pos.filter(p => p.r > minR + 1).sort((a, b) => a.c - b.c);
      box.append(h('details', null, h('summary', { class: 'btn small' }, 'แผนภาพในแบบฟอร์ม (หน้าที่พื้นฐานด้านคุณภาพ / 4 ระยะพฤติกรรมด้านความปลอดภัย)'),
        [g1, g2].map(g => h('div', { class: 'steps4' }, g.map((p, i) => h('div', { class: 'pre' }, h('b', { text: i + 1 }), p.t))))));
    }
    const locked = isLocked('s4');
    box.append(h('h3', { text: s.discussion_title.text }));
    const t = h('table', { class: 'tbl qa' }, h('tr', null, s.columns.map(c => h('th', { class: 'pre', text: c })), h('th', { text: 'คำตอบจริงของพนักงาน' }), h('th', { text: 'การชี้แนะ' }), h('th', { text: 'ผล' })));
    let lastCat = null;
    s.cases.forEach(c => {
      const cid = AID + '-' + c.key;
      const r = ST.s4.find(x => x.client_id === cid) || {};
      const upd = (field) => (v) => { const op = { type: 's4', client_id: cid, fields: { case_key: c.key, [field]: v } }; applyLocal(op); enqueue(op); };
      const ch = h('div', { class: 'choice two' });
      [['pass', '√'], ['fail', '×']].forEach(([v, l]) => ch.append(h('button', {
        type: 'button', class: 'c-' + v + (r.result === v ? ' on' : ''), disabled: locked, 'aria-label': 'ผลกรณี ' + c.no + ' ' + l,
        onclick: () => { upd('result')(r.result === v ? '' : v); renderSheet(); },
      }, l)));
      t.append(h('tr', null, h('td', { class: 'pre', text: c.category !== lastCat ? c.category : '' }), h('td', { text: c.case }), h('td', { text: c.answer }),
        h('td', null, textField(r.employee_answer, upd('employee_answer'), { disabled: locked, label: 'คำตอบพนักงาน กรณี ' + c.no })),
        h('td', null, textField(r.coaching, upd('coaching'), { disabled: locked, label: 'การชี้แนะ กรณี ' + c.no })), h('td', null, ch)));
      lastCat = c.category;
    });
    box.append(h('div', { class: 'tablewrap' }, t));
    box.append(h('div', { class: 'meta', text: 'กรณีข้างบนเป็นสถานการณ์ตัวอย่างสำหรับทบทวน ระบบไม่สร้างปัญหาจากกรณีตัวอย่างโดยอัตโนมัติ' }));

    // employee's own experience / real events
    box.append(h('h3', { text: s.record_title.text + ' · ประสบการณ์จริงของพนักงาน' }));
    const own = ST.s4.filter(r => !r.case_key);
    const ot = h('table', { class: 'tbl qa' }, h('tr', null, h('th', { text: 'ประเภท' }), h('th', { text: s.record_columns[0] }), h('th', { text: 'คำตอบ / การจัดการของพนักงาน' }),
      h('th', { text: 'การชี้แนะ' }), h('th', { text: s.record_columns[1] }), h('th', { text: 'Issue' })));
    own.forEach(r => {
      const upd = (field) => (v) => { const op = { type: 's4', client_id: r.client_id, fields: { [field]: v } }; applyLocal(op); enqueue(op); };
      const sel = h('select', { disabled: locked || !!r.issue, 'aria-label': 'ประเภท' }, h('option', { value: '0', text: 'สถานการณ์สมมติ / เล่าเป็นตัวอย่าง' }), h('option', { value: '1', text: 'เกิดขึ้นจริง' }));
      sel.value = r.is_real_event ? '1' : '0';
      sel.addEventListener('change', () => { upd('is_real_event')(sel.value === '1'); renderSheet(); });
      ot.append(h('tr', null, h('td', null, sel), h('td', null, textField(r.case_text, upd('case_text'), { disabled: locked, label: 'คำอธิบายปัญหา' })),
        h('td', null, textField(r.employee_answer, upd('employee_answer'), { disabled: locked, label: 'คำตอบ' })),
        h('td', null, textField(r.coaching, upd('coaching'), { disabled: locked, label: 'การชี้แนะ' })),
        h('td', null, textField(r.improvement, upd('improvement'), { disabled: locked, label: 'ข้อเสนอแนะการปรับปรุง' })),
        h('td', null, r.issue ? h('a', { href: '/issues/' + r.issue.id + '/', text: r.issue.issue_no }) :
          (r.is_real_event && !locked ? h('button', { type: 'button', class: 'btn small danger', onclick: () => { flush(); openFinding({ sheet: 's4', review_id: r.client_id, title: r.case_text }); } }, 'สร้าง Issue') :
            (!locked ? h('button', { type: 'button', class: 'btn small', onclick: () => { const op = { type: 's4', client_id: r.client_id, delete: true }; applyLocal(op); enqueue(op); renderSheet(); } }, 'ลบ') : '–')))));
    });
    if (!own.length) ot.append(h('tr', null, h('td', { colspan: 6, class: 'muted', text: 'ยังไม่มีรายการ' })));
    box.append(h('div', { class: 'tablewrap' }, ot));
    if (!locked) box.append(h('div', { class: 'btnrow', style: 'margin-top:8px' }, h('button', {
      type: 'button', class: 'btn', onclick: () => { const op = { type: 's4', client_id: uid(), fields: { case_key: '', case_text: '', is_real_event: false } }; applyLocal(op); enqueue(op); renderSheet(); },
    }, '+ เพิ่มประสบการณ์ของพนักงาน')));
  }

  // ------------------------------------------------------------ modal helper
  function modal(title, body, footer, opts) {
    const ov = h('div', { class: 'overlay' + (opts && opts.sheet ? ' sheetmode' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
    const close = () => { ov.remove(); if (opts && opts.onclose) opts.onclose(); };
    const m = h('div', { class: 'modal' }, h('header', null, h('h2', { text: title }), h('button', { type: 'button', class: 'xbtn', 'aria-label': 'ปิด', onclick: close }, '×')),
      h('div', { class: 'body' }, body), footer ? h('footer', null, footer) : null);
    ov.append(m);
    ov.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
    document.body.append(ov);
    const first = m.querySelector('input,textarea,select,button.primary');
    if (first) setTimeout(() => first.focus(), 30);
    return { el: ov, close };
  }

  // ------------------------------------------------------------ finding (issue) window
  function openFinding(ctx) {
    const clientId = uid();
    const it = ctx.item_key ? ITEMS[ctx.item_key] : null;
    const isMajor = it && it.sheet === 's1' && it.severity === 'major';
    const refText = () => {
      const sheetName = SNAP[ctx.sheet].sheet_name;
      if (!it) return sheetName;
      return sheetName + ' · ' + itemLabel(it) + (ctx.occurrence ? ' · ครั้งที่ ' + ctx.occurrence : '') + (it.sheet === 's1' ? ' · ' + (isMajor ? 'ความผิดปกติหลัก' : 'ความผิดปกติรอง') : '');
    };
    let mode = 'new', linkId = null;
    const itemSel = ctx.pickItem ? h('select', { id: 'fd-item', required: true }, h('option', { value: '', text: '- เลือกรหัสข้อ -' }),
      SNAP.s2.sections.flatMap(s => s.items.map(i => h('option', { value: i.key, text: i.code + ' ' + i.text.slice(0, 70) })))) : null;
    const title = h('textarea', { id: 'fd-title', required: true, placeholder: 'สิ่งที่พบ เช่น ไม่สวมแว่นตานิรภัยขณะเจียร' }); title.value = ctx.title || '';
    const desc = h('textarea', { id: 'fd-desc', placeholder: 'หมายเหตุเพิ่มเติม (ถ้ามี)' });
    const cont = h('textarea', { id: 'fd-cont', placeholder: 'สิ่งที่ทำทันทีหน้างาน' });
    const prio = h('select', { id: 'fd-prio' }, ['', 'สูง', 'กลาง', 'ต่ำ'].map(v => h('option', { value: v, text: v || '- ไม่ระบุ -' })));
    const owner = h('select', { id: 'fd-owner' }, h('option', { value: '', text: '- เลือกผู้ใช้ -' }), B.owners.map(o => h('option', { value: o.id, text: o.name })));
    const ownerName = h('input', { id: 'fd-ownername', type: 'text', placeholder: 'หรือพิมพ์ชื่อ/หน่วยงาน' });
    const due = h('input', { id: 'fd-due', type: 'date' });
    const cam = h('input', { id: 'fd-cam', type: 'file', accept: 'image/*', capture: 'environment', class: 'sr' });
    const files = h('input', { id: 'fd-files', type: 'file', accept: 'image/*,application/pdf', multiple: true, class: 'sr' });
    const fileList = h('div', { class: 'meta', text: 'ยังไม่มีไฟล์แนบ' });
    const picked = [];
    const onPick = (inp) => () => { for (const f of inp.files) picked.push(f); fileList.textContent = picked.map(f => f.name).join(', ') || 'ยังไม่มีไฟล์แนบ'; inp.value = ''; };
    cam.addEventListener('change', onPick(cam)); files.addEventListener('change', onPick(files));
    const candBox = h('div', { class: 'hidden' });
    const newBox = h('div', null,
      h('label', { for: 'fd-title', text: 'รายละเอียดปัญหา *' }), title,
      h('div', { class: 'grid', style: 'margin-top:8px' },
        h('div', null, h('label', { for: 'fd-prio', text: 'ความสำคัญ (ผู้ตรวจกำหนด)' }), prio),
        h('div', null, h('label', { for: 'fd-owner', text: 'ผู้รับผิดชอบ' }), owner, ownerName),
        h('div', null, h('label', { for: 'fd-due', text: 'กำหนดเสร็จ' }), due)),
      h('label', { for: 'fd-cont', text: 'การแก้ไขทันที', style: 'margin-top:8px' }), cont,
      h('label', { for: 'fd-desc', text: 'หมายเหตุ', style: 'margin-top:8px' }), desc);
    const modeBtns = h('div', { class: 'btnrow', style: 'margin:8px 0' });
    const setMode = (m) => {
      mode = m;
      newBox.classList.toggle('hidden', m !== 'new');
      candBox.classList.toggle('hidden', m !== 'link');
      modeBtns.querySelectorAll('button').forEach(b => b.classList.toggle('primary', b.dataset.m === m));
      if (m === 'link') loadCands('');
    };
    modeBtns.append(h('button', { type: 'button', class: 'btn small primary', dataset: { m: 'new' }, onclick: () => setMode('new') }, 'ปัญหาใหม่'),
      h('button', { type: 'button', class: 'btn small', dataset: { m: 'link' }, onclick: () => setMode('link') }, 'เป็นเรื่องเดียวกับปัญหาเดิม'));
    const search = h('input', { type: 'search', placeholder: 'ค้นหาเลข Issue / หัวข้อ', 'aria-label': 'ค้นหาปัญหาเดิม' });
    const list = h('div');
    let st;
    search.addEventListener('input', () => { clearTimeout(st); st = setTimeout(() => loadCands(search.value), 300); });
    async function loadCands(q) {
      list.textContent = 'กำลังโหลด…';
      try {
        const r = await req(B.urls.link_candidates + '?item_key=' + encodeURIComponent(ctx.item_key || '') + '&q=' + encodeURIComponent(q));
        list.textContent = '';
        (r.data.issues || []).forEach(i => list.append(h('label', { class: 'card', style: 'display:flex;gap:8px;margin:6px 0;padding:8px;cursor:pointer' },
          h('input', { type: 'radio', name: 'fd-link', value: i.id, onchange: () => { linkId = i.id; } }),
          h('span', null, h('b', { text: i.issue_no + ' ' }), i.title, h('br'), h('small', { text: (i.item_code || '') + ' · ' + (i.station || '') + ' · ' + i.status_th })))));
        if (!list.childNodes.length) list.textContent = 'ไม่พบปัญหาเดิม';
      } catch (e) { list.textContent = 'โหลดไม่ได้ (ออฟไลน์)'; }
    }
    candBox.append(search, list, h('div', { class: 'meta', text: 'การเชื่อมจะเพิ่มประวัติการพบครั้งนี้ในปัญหาเดิม โดยไม่ลบประวัติครั้งก่อน' }));
    const body = h('div', null,
      h('div', { class: 'notice info' }, h('b', { text: 'อ้างอิง: ' }), refText(), it ? h('div', { class: 'meta', text: it.text || it.case || '' }) : null),
      isMajor ? h('div', { class: 'notice err' }, h('b', { text: 'ความผิดปกติหลัก: ' }), SNAP.s1.major_response.text) : null,
      it && it.sheet === 's1' && !isMajor ? h('div', { class: 'notice' }, h('b', { text: 'ความผิดปกติรอง: ' }), SNAP.s1.minor_response.text) : null,
      itemSel ? h('div', null, h('label', { for: 'fd-item', text: 'รหัสข้อ *' }), itemSel) : null,
      ctx.sheet === 's1' || ctx.sheet === 's2' ? modeBtns : null, newBox, candBox,
      h('div', { style: 'margin-top:10px' }, h('label', { text: 'หลักฐาน (รูปภาพ / PDF)' }),
        h('div', { class: 'btnrow' }, h('label', { for: 'fd-cam', class: 'btn small', style: 'margin:0' }, '📷 ถ่ายรูป'), cam,
          h('label', { for: 'fd-files', class: 'btn small', style: 'margin:0' }, 'เลือกไฟล์'), files), fileList));
    const saveBtn = h('button', { type: 'button', class: 'btn primary' }, 'บันทึกปัญหา');
    const m = modal('บันทึกปัญหา', body, [h('button', { type: 'button', class: 'btn', onclick: () => m.close() }, 'ภายหลัง'), saveBtn], { sheet: true });
    saveBtn.addEventListener('click', async () => {
      const payload = { client_id: clientId, sheet: ctx.sheet, item_key: itemSel ? itemSel.value : (ctx.item_key || ''), occurrence: ctx.occurrence || 0,
        review_id: ctx.review_id, suggestion_id: ctx.suggestion_id };
      if (itemSel) { if (!itemSel.value) { toast('เลือกรหัสข้อ', true); return; } payload.row_id = clientId; payload.occurrence = 0; }
      if (mode === 'link') { if (!linkId) { toast('เลือกปัญหาเดิม', true); return; } payload.link_issue_id = linkId; }
      else {
        if (!title.value.trim()) { toast('กรุณาระบุรายละเอียดปัญหา', true); title.focus(); return; }
        Object.assign(payload, { title: title.value.trim(), description: desc.value, priority: prio.value, owner_id: owner.value || null,
          owner_name: ownerName.value || (owner.value ? owner.options[owner.selectedIndex].text : ''), due_date: due.value || null, containment: cont.value });
      }
      saveBtn.disabled = true; saveBtn.textContent = 'กำลังบันทึก…';
      try {
        await flush();
        const r = await req(B.urls.finding, payload);
        if (!r.ok) { toast(r.data.message || 'บันทึกไม่สำเร็จ', true); saveBtn.disabled = false; saveBtn.textContent = 'บันทึกปัญหา'; return; }
        if (picked.length) {
          const fd = new FormData();
          picked.forEach(f => fd.append('files', f));
          fd.append('issue_id', r.data.issue.id);
          const up = await req(B.urls.upload, fd);
          if (!up.ok) toast('บันทึกปัญหาแล้ว แต่แนบไฟล์ไม่สำเร็จ: ' + (up.data.message || ''), true);
        }
        toast((r.data.created ? 'สร้างปัญหา ' : 'เชื่อมกับปัญหา ') + r.data.issue.issue_no);
        m.close();
        await refreshState();
      } catch (e) {
        toast('ยังไม่ถึง server (ออฟไลน์) กดบันทึกอีกครั้งเมื่อมีสัญญาณ ระบบจะไม่สร้างซ้ำ', true);
        saveBtn.disabled = false; saveBtn.textContent = 'บันทึกปัญหา';
      }
    });
  }

  // ------------------------------------------------------------ stopwatch
  const TK = (key, obs) => 'pjo-timer-' + AID + '-' + key + '-' + obs;
  function timerRunning(key, obs) {
    const t = lsGet(TK(key, obs));
    if (!t || !t.events.length) return false;
    const last = t.events[t.events.length - 1].type;
    return last === 'start' || last === 'lap' || last === 'pause' || last === 'resume';
  }
  function computeLaps(events, now) {
    const laps = []; let start = null, paused = 0, pStart = null, reasons = [];
    for (const e of events) {
      if (e.type === 'start') { start = e.t; paused = 0; pStart = null; reasons = []; }
      else if (e.type === 'pause' && start !== null && pStart === null) { pStart = e.t; reasons.push(e.reason || ''); }
      else if (e.type === 'resume' && pStart !== null) { paused += e.t - pStart; pStart = null; }
      else if ((e.type === 'lap' || e.type === 'stop') && start !== null) {
        if (pStart !== null) { paused += e.t - pStart; pStart = null; }
        laps.push({ gross: (e.t - start) / 1000, paused: paused / 1000, net: (e.t - start - paused) / 1000, reasons });
        start = e.type === 'lap' ? e.t : null; paused = 0; reasons = [];
      }
    }
    let current = null;
    if (start !== null) {
      const p = paused + (pStart !== null ? now - pStart : 0);
      current = { net: now - start - p, paused: p, isPaused: pStart !== null };
    }
    return { laps, current };
  }

  function openTimer(key, obs) {
    const it = ITEMS[key];
    const locked = isLocked('s1');
    const k = TK(key, obs);
    let T = lsGet(k) || { client_id: uid(), events: [], overrides: {}, manual: [], warnings: [], offset: SERVER_OFFSET, lastSeen: null, lastPerf: null };
    const saved = ST.timing.find(x => x.item_key === key && x.observation === obs);
    // recovery checks after reload / tab switch
    const nowWall = Date.now();
    if (T.events.length && timerRunning(key, obs)) {
      if (T.lastSeen && nowWall - T.lastSeen > 5000) {
        T.warnings.push({ type: 'gap', message: 'หน้าจอถูกปิด/รีเฟรชระหว่างจับเวลา ขาดช่วง ' + ((nowWall - T.lastSeen) / 1000).toFixed(1) + ' วินาที (เวลานับต่อจาก timestamp)', at: new Date().toISOString(), confirmed: false });
      }
      if (Math.abs(SERVER_OFFSET - T.offset) > 5000) {
        T.warnings.push({ type: 'clock', message: 'เวลาเครื่องเปลี่ยนไป ' + ((SERVER_OFFSET - T.offset) / 1000).toFixed(1) + ' วินาที เทียบกับเวลา server', at: new Date().toISOString(), confirmed: false });
        T.offset = SERVER_OFFSET;
      }
    }
    T.lastPerf = null;
    const save = () => { T.lastSeen = Date.now(); lsSet(k, T); };
    save();
    const draftSync = () => { req(B.urls.timing, { item_key: key, observation: obs, client_id: T.client_id, events: T.events, warnings: T.warnings, final: false }).catch(() => {}); };

    const disp = h('div', { class: 'sw-display', 'aria-live': 'off', text: '0.00' });
    const sub = h('div', { class: 'sw-sub' });
    const btns = h('div', { class: 'sw-btns' });
    const pauseReason = h('div');
    const lapsBox = h('div');
    const warnBox = h('div');
    const sumBox = h('div');
    const ev = (type, extra) => { T.events.push(Object.assign({ type, t: Date.now(), perf: Math.round(performance.now()), srv: Date.now() + SERVER_OFFSET }, extra || {})); save(); draftSync(); draw(); };
    const state = () => {
      if (!T.events.length) return 'idle';
      const l = T.events[T.events.length - 1].type;
      return l === 'stop' ? 'stopped' : (l === 'pause' ? 'paused' : 'running');
    };
    function draw() {
      const s = state();
      btns.textContent = '';
      const B_ = (label, cls, fn, dis) => h('button', { type: 'button', class: 'btn ' + (cls || ''), disabled: locked || dis, onclick: fn }, label);
      if (s === 'idle' || s === 'stopped') {
        btns.append(B_(s === 'idle' ? 'Start' : 'Start รอบใหม่', 'primary', () => ev('start')));
        btns.append(B_('บันทึกลงแบบฟอร์ม', '', saveToForm, !computeLaps(T.events, Date.now()).laps.length && !T.manual.length));
        btns.append(B_('เริ่มใหม่', 'danger', resetAll, !T.events.length && !T.manual.length));
      } else if (s === 'running') {
        btns.append(B_('Lap / จบรอบ', 'primary', () => ev('lap')));
        btns.append(B_('Pause', '', () => ev('pause', { reason: '' })));
        btns.append(B_('Stop', 'danger', () => ev('stop')));
      } else {
        btns.append(B_('ทำต่อ', 'primary', () => {
          const p = T.events[T.events.length - 1];
          if (!(p.reason || '').trim()) { toast('ระบุเหตุผลที่หยุดชั่วคราวก่อน', true); return; }
          ev('resume');
        }));
        btns.append(B_('Stop', 'danger', () => ev('stop')));
        btns.append(h('span'));
      }
      pauseReason.textContent = '';
      if (s === 'paused') {
        const p = T.events[T.events.length - 1];
        const inp = h('input', { type: 'text', id: 'sw-pr', value: p.reason || '', placeholder: 'เช่น ไลน์หยุด รอชิ้นงาน' });
        inp.addEventListener('input', () => { p.reason = inp.value; save(); });
        pauseReason.append(h('label', { for: 'sw-pr', text: 'เหตุผลที่หยุดชั่วคราว * (เวลาที่หยุดจะถูกหักและแสดงในรอบนี้)' }), inp);
      }
      drawLaps();
      drawWarnings();
    }
    function drawLaps() {
      const { laps } = computeLaps(T.events, Date.now());
      lapsBox.textContent = '';
      const t = h('table', { class: 'tbl' }, h('tr', null, ['รอบ', 'เวลาสุทธิ (s)', 'หยุดชั่วคราว', 'ที่มา', 'ใช้รอบนี้'].map(x => h('th', { text: x }))));
      const all = [];
      laps.forEach((l, i) => all.push({ no: i + 1, sec: l.net, paused: l.paused, reasons: l.reasons, src: 'Stopwatch', ov: T.overrides[i + 1] || (T.overrides[i + 1] = { valid: true, invalid_reason: '' }) }));
      T.manual.forEach((m, j) => all.push({ no: laps.length + j + 1, sec: m.seconds, paused: 0, reasons: [], src: 'Manual: ' + m.reason, ov: m, manual: j }));
      all.forEach(r => {
        const cb = h('input', { type: 'checkbox', checked: r.ov.valid !== false, disabled: locked, 'aria-label': 'ใช้รอบ ' + r.no, style: 'width:22px;height:22px' });
        const why = h('input', { type: 'text', value: r.ov.invalid_reason || '', placeholder: 'เหตุผลที่ไม่ใช้ *', class: r.ov.valid === false ? '' : 'hidden', 'aria-label': 'เหตุผลที่ไม่ใช้รอบ ' + r.no });
        cb.addEventListener('change', () => { r.ov.valid = cb.checked; why.classList.toggle('hidden', cb.checked); save(); drawSummary(); });
        why.addEventListener('input', () => { r.ov.invalid_reason = why.value; save(); });
        t.append(h('tr', null, h('td', { text: r.no }), h('td', { class: 'nowrap', text: r.sec.toFixed(2) }),
          h('td', { text: r.paused ? r.paused.toFixed(2) + ' s · ' + r.reasons.join(', ') : '–' }), h('td', { text: r.src }),
          h('td', null, h('div', { class: 'btnrow' }, cb, why, r.manual !== undefined && !locked ? h('button', { type: 'button', class: 'btn small danger', onclick: () => { T.manual.splice(r.manual, 1); save(); draw(); } }, 'ลบ') : null))));
      });
      if (!all.length) t.append(h('tr', null, h('td', { colspan: 5, class: 'muted', text: 'ยังไม่มีรอบ กด Start แล้วกด Lap เมื่อจบแต่ละรอบงาน (รวมเวลาเดิน)' })));
      lapsBox.append(t);
      if (!locked) {
        const sec = h('input', { type: 'number', step: '0.01', min: '0', placeholder: 'วินาที', 'aria-label': 'เวลา (วินาที)' });
        const rs = h('input', { type: 'text', placeholder: 'เหตุผล/แหล่งที่มา เช่น วัดจากวิดีโอ *', 'aria-label': 'เหตุผลกรอกเอง' });
        lapsBox.append(h('details', { style: 'margin-top:8px' }, h('summary', { class: 'btn small' }, '+ กรอกเวลาจากภายนอก (Manual)'),
          h('div', { class: 'grid', style: 'margin-top:8px' }, sec, rs, h('button', { type: 'button', class: 'btn', onclick: () => {
            const v = parseFloat(sec.value);
            if (!(v > 0)) { toast('ระบุเวลาเป็นวินาที มากกว่า 0', true); return; }
            if (!rs.value.trim()) { toast('ระบุเหตุผลที่กรอกเอง', true); return; }
            T.manual.push({ seconds: v, reason: rs.value.trim(), valid: true, invalid_reason: '' }); save(); draw();
          } }, 'เพิ่มรอบ Manual'))));
      }
      drawSummary();
    }
    function drawSummary() {
      const { laps } = computeLaps(T.events, Date.now());
      const used = laps.map((l, i) => ({ v: l.net, ok: (T.overrides[i + 1] || {}).valid !== false })).concat(T.manual.map(m => ({ v: m.seconds, ok: m.valid !== false }))).filter(x => x.ok).map(x => x.v);
      const avg = used.length ? used.reduce((a, b) => a + b, 0) / used.length : null;
      const hd = ST.header;
      sumBox.textContent = '';
      sumBox.append(h('div', { class: 'kv' },
        h('div', null, 'ค่าเฉลี่ย', h('b', { text: fmtSec(avg) })), h('div', null, 'ต่ำสุด', h('b', { text: used.length ? fmtSec(Math.min(...used)) : '–' })),
        h('div', null, 'สูงสุด', h('b', { text: used.length ? fmtSec(Math.max(...used)) : '–' })), h('div', null, 'จำนวนรอบที่ใช้', h('b', { text: used.length + ' / ' + (laps.length + T.manual.length) })),
        h('div', null, 'Standard Time', h('b', { text: hd.standard_time_s ? hd.standard_time_s + ' s' : 'ไม่ได้ระบุ' }), h('small', { text: hd.standard_time_source || '' })),
        h('div', null, 'Takt Time', h('b', { text: hd.takt_time_s ? hd.takt_time_s + ' s' : 'ไม่ได้ระบุ' }), h('small', { text: hd.takt_time_source || '' })),
        h('div', null, 'ผลประเมิน', h('b', { text: 'รอประเมิน' }), h('small', { text: 'ยังไม่มีเกณฑ์ที่อนุมัติ' }))));
    }
    function drawWarnings() {
      warnBox.textContent = '';
      T.warnings.forEach(w => {
        const cb = h('input', { type: 'checkbox', checked: !!w.confirmed, style: 'width:20px;height:20px' });
        cb.addEventListener('change', () => { w.confirmed = cb.checked; w.confirmed_by = B.user.name; save(); });
        warnBox.append(h('label', { class: 'notice', style: 'display:flex;gap:8px;align-items:center' }, cb, w.message + ' · ผู้ตรวจยืนยันว่ารับทราบ'));
      });
    }
    function tick() {
      if (!document.body.contains(disp)) return;
      const now = Date.now(), perf = performance.now();
      if (T.lastPerf !== null && T.lastWall !== null && state() !== 'idle' && state() !== 'stopped') {
        const drift = (now - T.lastWall) - (perf - T.lastPerf);
        if (Math.abs(drift) > 2000) {
          T.warnings.push({ type: 'clock_jump', message: (drift > 0 ? 'เวลาเครื่องกระโดดไปข้างหน้า / เครื่องหลับ ' : 'เวลาเครื่องถอยหลัง ') + (Math.abs(drift) / 1000).toFixed(1) + ' วินาที ระหว่างจับเวลา', at: new Date().toISOString(), confirmed: false });
          drawWarnings();
        }
      }
      T.lastPerf = perf; T.lastWall = now;
      const { laps, current } = computeLaps(T.events, now);
      disp.textContent = current ? clock(current.net) : (laps.length ? clock(laps[laps.length - 1].net * 1000) : '0.00');
      sub.textContent = 'รอบจับเวลาที่ ' + (laps.length + (current ? 1 : 0)) + (current && current.isPaused ? ' · หยุดชั่วคราว' : '') + ' · ครั้งที่สังเกต ' + obs;
      if (state() === 'running' || state() === 'paused') { T.lastSeen = now; lsSet(k, T); }
      requestAnimationFrame(() => setTimeout(tick, 100));
    }
    function resetAll() {
      if (!confirm('ทิ้งข้อมูลจับเวลาที่ยังไม่บันทึกทั้งหมดของครั้งที่สังเกตนี้?')) return;
      lsDel(k);
      T = { client_id: uid(), events: [], overrides: {}, manual: [], warnings: [], offset: SERVER_OFFSET, lastSeen: null };
      save(); draw();
    }
    async function saveToForm() {
      if (T.warnings.some(w => !w.confirmed)) { toast('ต้องยืนยันคำเตือนเรื่องเวลาก่อนบันทึก', true); return; }
      const { laps } = computeLaps(T.events, Date.now());
      const bad = Object.entries(T.overrides).find(([n, o]) => +n <= laps.length && o.valid === false && !(o.invalid_reason || '').trim());
      if (bad) { toast('รอบที่ ' + bad[0] + ' ไม่ใช้ ต้องระบุเหตุผล', true); return; }
      const payload = {
        final: true, item_key: key, observation: obs, client_id: T.client_id, events: T.events, warnings: T.warnings,
        laps: laps.map((l, i) => Object.assign({ lap_no: i + 1 }, T.overrides[i + 1] || { valid: true })),
        manual_laps: T.manual.map(m => ({ seconds: m.seconds, reason: m.reason, valid: m.valid !== false, invalid_reason: m.invalid_reason || '' })),
      };
      try {
        const r = await req(B.urls.timing, payload);
        if (!r.ok) { toast(r.data.message || 'บันทึกไม่สำเร็จ', true); return; }
        lsDel(k);
        toast('บันทึกเวลาลงแบบฟอร์มแล้ว');
        mm.close();
        await refreshState();
      } catch (e) { toast('ยังไม่ถึง server ข้อมูลยังอยู่ในเครื่องนี้ กดบันทึกอีกครั้งเมื่อออนไลน์', true); }
    }
    const info = h('div', { class: 'kv', style: 'margin-bottom:8px' },
      h('div', null, 'พนักงาน', h('b', { text: ST.header.employee_name || '–' })), h('div', null, 'สถานี', h('b', { text: ST.header.station || '–' })),
      h('div', null, 'รุ่นผลิตภัณฑ์', h('b', { text: ST.header.model || '–' })), h('div', null, 'ครั้งที่สังเกต', h('b', { text: obs + ' / ' + NOCC })));
    const body = h('div', null, h('div', { class: 'meta', text: it.text }), info,
      saved ? h('div', { class: 'notice info', text: 'บันทึกไว้แล้ว: เฉลี่ย ' + fmtSec(saved.avg) + ' s (' + saved.count_used + ' รอบ) · จับใหม่และบันทึกจะแทนที่ค่าเดิม โดยเก็บค่าเดิมไว้ในประวัติ' }) : null,
      locked ? h('div', { class: 'notice info', text: 'ส่วนนี้ลงนามแล้ว ดูได้อย่างเดียว' }) : null,
      disp, sub, btns, pauseReason, warnBox, h('h3', { text: 'รอบจับเวลา (หน่วยวินาที รวมเวลาเดิน)' }), lapsBox, h('h3', { text: 'สรุป' }), sumBox);
    const mm = modal('จับเวลา · ' + itemLabel(it), body, [h('button', { type: 'button', class: 'btn', onclick: () => mm.close() }, 'ปิด (การจับเวลายังเดินต่อ)')],
      { sheet: true, onclose: () => { save(); renderSheet(); } });
    draw();
    tick();
    const vis = () => { if (document.visibilityState === 'hidden') save(); };
    document.addEventListener('visibilitychange', vis);
    window.addEventListener('pagehide', save);
  }

  // ------------------------------------------------------------ signatures
  function sigRow(role) { return ST.signatures.find(s => s.role === role); }
  function sigCard(s, followupId) {
    const card = h('div', { class: 'sig' + (s.required && !s.signed ? ' req' : '') }, h('div', { class: 'who', text: s.label }));
    if (s.signed) {
      card.append(h('img', { src: '/files/signature/' + s.sig_id + '/', alt: 'ลายเซ็น ' + s.signer }), h('div', { text: s.signer }),
        h('div', { class: 'meta', text: s.at + ' · ' + (s.method === 'login' ? 'ยืนยันด้วยบัญชีผู้ใช้' : 'ยืนยันรหัสพนักงาน มีผู้ตรวจเป็นพยาน') }));
    } else {
      card.append(h('div', { class: 'meta', text: s.required === false ? 'ไม่ต้องลงนาม (ไม่มีรายการที่เกี่ยวข้อง)' : 'ยังไม่ลงนาม' }));
      const ready = followupId || ['pending_signatures', 'amended'].includes(ST.status);
      if (s.required !== false) card.append(h('button', { type: 'button', class: 'btn small primary', disabled: !ready, onclick: () => openSign(s, followupId), style: 'margin-top:6px' },
        ready ? 'ลงนาม' : 'ลงนามได้หลังกด “ตรวจเสร็จ ส่งลงนาม”'));
    }
    return card;
  }
  function sigBlocks(roles) { return h('div', { class: 'sigs' }, roles.map(r => sigRow(r)).filter(Boolean).map(s => sigCard(s))); }

  function relatedSummary(role, followupId) {
    const ul = h('ul', { style: 'margin:4px 0;padding-left:20px' });
    const fails = Object.entries(ST.marks).filter(([k, m]) => m.v === 'fail' && k.startsWith('S1-'));
    if (role === 'employee_major' || role === 'employee_minor') {
      fails.filter(([k]) => (ITEMS[k.split('|')[0]].severity === 'major') === (role === 'employee_major')).forEach(([k]) => {
        const [key, occ] = k.split('|'); const f = ST.findings[k];
        ul.append(h('li', { text: itemLabel(ITEMS[key]) + ' ครั้งที่ ' + occ + ': ' + (f ? f.title + ' (' + f.issue_no + ')' : '') }));
      });
    } else if (role === 'employee_s3' || role === 'supervisor_s3') {
      SNAP.s3.questions.filter(q => !q.is_suggestion).forEach(q => {
        const a = ST.s3[q.key] || {};
        ul.append(h('li', { text: 'ข้อ ' + q.no + ': ก่อนสอน ' + (SYM[a.before] || 'ไม่ได้บันทึก') + ' · หลังสอน ' + (SYM[a.after] || 'ไม่ได้บันทึก') }));
      });
    } else if (role === 'auditor') {
      const majors = fails.filter(([k]) => ITEMS[k.split('|')[0]].severity === 'major').length;
      ul.append(h('li', { text: 'ตาราง 1: × หลัก ' + majors + ' · × รอง ' + (fails.length - majors) + ' · ช่องที่บันทึก ' + Object.keys(ST.marks).filter(k => k.startsWith('S1-')).length }));
      ul.append(h('li', { text: 'ตาราง 2: × ' + Object.entries(ST.marks).filter(([k, m]) => k.startsWith('S2-') && m.v === 'fail').length }));
      ul.append(h('li', { text: 'การจับเวลาที่บันทึก: ' + ST.timing.length + ' ครั้งที่สังเกต' }));
      ul.append(h('li', { text: 'ปัญหาที่เปิดอยู่: ' + ST.open_issues }));
    } else if (followupId) {
      const f = ST.followups.find(x => x.id === followupId);
      ul.append(h('li', { text: 'การฝึกอบรม: ' + (f.training_detail || '-') }), h('li', { text: 'ผลการสังเกตซ้ำ: ' + (f.recert_result || '-') }));
    }
    return ul;
  }

  function openSign(row, followupId) {
    const isEmployee = /^employee/.test(row.role);
    let method = isEmployee ? 'employee_code_witnessed' : 'login';
    const code = h('input', { id: 'sg-code', type: 'text', value: isEmployee ? (B.employee.code || '') : '', inputmode: 'numeric', autocomplete: 'off' });
    const codeBox = h('div', null, h('label', { for: 'sg-code', text: 'รหัสพนักงานของผู้ลงนาม *' }), code,
      h('div', { class: 'meta', text: 'พนักงานไม่มีบัญชีผู้ใช้: ระบบตรวจรหัสกับรายชื่อพนักงาน และบันทึก ' + B.user.name + ' เป็นพยาน' }));
    const loginBox = h('div', { class: 'notice info', text: 'ลงนามด้วยบัญชีที่ล็อกอินอยู่: ' + B.user.name });
    const methodBtns = h('div', { class: 'btnrow', style: 'margin:6px 0' });
    const setM = (m) => { method = m; codeBox.classList.toggle('hidden', m !== 'employee_code_witnessed'); loginBox.classList.toggle('hidden', m !== 'login');
      methodBtns.querySelectorAll('button').forEach(b => b.classList.toggle('primary', b.dataset.m === m)); };
    methodBtns.append(h('button', { type: 'button', class: 'btn small', dataset: { m: 'login' }, onclick: () => setM('login') }, 'ใช้บัญชีที่ล็อกอิน'),
      h('button', { type: 'button', class: 'btn small', dataset: { m: 'employee_code_witnessed' }, onclick: () => setM('employee_code_witnessed') }, 'ยืนยันรหัสพนักงาน + พยาน'));
    // signature pad
    const canvas = h('canvas', { 'aria-label': 'ช่องเซ็นชื่อ ใช้นิ้ว ปากกา หรือเมาส์' });
    const hint = h('div', { class: 'hint', text: 'เซ็นชื่อในกรอบนี้' });
    const pad = h('div', { class: 'padwrap' }, canvas, hint);
    let strokes = 0, drawing = false, last = null, ctx2d;
    const confirmBtn = h('button', { type: 'button', class: 'btn primary', disabled: true }, 'ยืนยันลงนาม');
    function setupCanvas() {
      const r = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
      ctx2d = canvas.getContext('2d');
      ctx2d.scale(dpr, dpr);
      ctx2d.lineWidth = 2.4; ctx2d.lineCap = 'round'; ctx2d.lineJoin = 'round'; ctx2d.strokeStyle = '#111';
      ctx2d.fillStyle = '#fff'; ctx2d.fillRect(0, 0, r.width, r.height);
    }
    const pt = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    canvas.addEventListener('pointerdown', e => { e.preventDefault(); canvas.setPointerCapture(e.pointerId); drawing = true; last = pt(e); ctx2d.beginPath(); ctx2d.arc(last.x, last.y, 1.1, 0, Math.PI * 2); ctx2d.fillStyle = '#111'; ctx2d.fill(); });
    canvas.addEventListener('pointermove', e => { if (!drawing) return; e.preventDefault(); const p = pt(e); ctx2d.beginPath(); ctx2d.moveTo(last.x, last.y); ctx2d.lineTo(p.x, p.y); ctx2d.stroke(); last = p; });
    const end = () => { if (drawing) { drawing = false; strokes++; hint.classList.add('hidden'); confirmBtn.disabled = false; } };
    canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end); canvas.addEventListener('pointerleave', end);
    const clearBtn = h('button', { type: 'button', class: 'btn', onclick: () => { setupCanvas(); strokes = 0; hint.classList.remove('hidden'); confirmBtn.disabled = true; } }, 'ล้าง / เซ็นใหม่');
    const body = h('div', null,
      h('div', { class: 'kv' }, h('div', null, 'บทบาท', h('b', { text: row.label })), h('div', null, 'Audit', h('b', { text: ST.audit_no + ' Rev ' + ST.revision })),
        isEmployee ? h('div', null, 'พนักงาน', h('b', { text: B.employee.name || ST.header.employee_name || '–' })) : null),
      (() => {
        const ul = relatedSummary(row.role, followupId);
        const n = ul.children.length;
        return n > 4 ? h('details', null, h('summary', { style: 'cursor:pointer;min-height:40px;font-weight:600' }, 'รายการที่เกี่ยวข้อง (' + n + ')'), ul)
          : h('div', null, h('h3', { text: 'รายการที่เกี่ยวข้อง' }), n ? ul : h('p', { class: 'muted', text: 'ไม่มี' }));
      })(),
      h('div', { class: 'notice info' }, h('b', { text: 'ข้อความที่ลงนาม: ' }), row.statement),
      methodBtns, loginBox, codeBox, h('label', { text: 'ลายเซ็น *', style: 'margin-top:8px' }), pad);
    const cid = uid();
    const m = modal('ลงนาม · ' + row.label, body, [clearBtn, h('button', { type: 'button', class: 'btn', onclick: () => m.close() }, 'ยกเลิก'), confirmBtn], { sheet: true });
    setM(method);
    requestAnimationFrame(setupCanvas);
    confirmBtn.addEventListener('click', async () => {
      if (strokes < 1) { toast('ลายเซ็นว่าง', true); return; }
      if (method === 'employee_code_witnessed' && !code.value.trim()) { toast('ระบุรหัสพนักงาน', true); return; }
      confirmBtn.disabled = true;
      try {
        await flush();
        const r = await req(B.urls.sign, { role: row.role, followup_id: followupId || null, identity_method: method, signer_code: code.value.trim(),
          image: canvas.toDataURL('image/png'), strokes, client_id: cid });
        if (!r.ok) { toast(r.data.message || 'ลงนามไม่สำเร็จ', true); confirmBtn.disabled = false; return; }
        ST = r.data.state; queue.forEach(applyLocal);
        toast('ลงนามแล้ว');
        m.close();
        renderAll();
      } catch (e) { toast('ยังไม่ถึง server ลองอีกครั้งเมื่อออนไลน์', true); confirmBtn.disabled = false; }
    });
  }

  function openSigPanel() {
    const body = h('div', null,
      ['pending_signatures', 'amended', 'completed'].includes(ST.status) ? null : h('div', { class: 'notice', text: 'ต้องกด “ตรวจเสร็จ ส่งลงนาม” ก่อนจึงจะลงนามได้' }),
      h('div', { class: 'sigs' }, ST.signatures.map(s => sigCard(s))),
      ST.followups.length ? h('h3', { text: 'การรับรองใหม่ (ความผิดปกติหลัก)' }) : null,
      ST.followups.map(f => h('div', null, h('div', { class: 'meta', text: itemLabel(ITEMS[f.item_key]) + ' ครั้งที่ ' + f.occurrence + ' · ' + f.stage_th }),
        h('div', { class: 'sigs' }, f.signatures.map(s => sigCard(s, f.id))))));
    const m = modal('ลายเซ็น', body, [h('button', { type: 'button', class: 'btn', onclick: () => m.close() }, 'ปิด')]);
    body.addEventListener('click', e => { if (e.target.closest('.sig button')) m.close(); }, true);
  }

  // ------------------------------------------------------------ actions
  async function submitAudit() {
    await flush();
    if (queue.length) { toast('ยังมีข้อมูลที่ไม่ถึง server รอสัญญาณก่อน', true); return; }
    const un = unloggedFails();
    if (un.length) { toast('ยังมีช่อง × ที่ไม่ได้บันทึกปัญหา ' + un.length + ' ช่อง', true); return; }
    const empty = SNAP.s1.items.filter(it => !Object.keys(ST.marks).some(k => k.startsWith(it.key + '|')));
    if (empty.length && !confirm('มี ' + empty.length + ' ข้อในตาราง 1 ที่ยังไม่ได้ตรวจเลย (ช่องว่าง = ยังไม่ได้ตรวจ) ยืนยันส่งลงนาม?')) return;
    try {
      const r = await req(B.urls.submit, {});
      if (!r.ok) { toast(r.data.message || 'ส่งไม่สำเร็จ', true); return; }
      ST = r.data.state; renderAll(); toast('ส่งลงนามแล้ว'); openSigPanel();
    } catch (e) { toast('ออฟไลน์ ส่งไม่ได้', true); }
  }
  function openAmend() {
    const reason = h('textarea', { id: 'am-r', placeholder: 'เหตุผลการแก้ไข *' });
    const boxes = [['header', 'ส่วนหัว'], ['s1', 'ตาราง 1'], ['s2', 'ตาราง 2'], ['s3', 'ตาราง 3'], ['s4', 'ตาราง 4']].map(([v, l]) =>
      h('label', { style: 'display:flex;gap:8px;align-items:center' }, h('input', { type: 'checkbox', value: v, style: 'width:20px;height:20px' }), l));
    const body = h('div', null, h('div', { class: 'notice', text: 'ระบบจะสร้าง Revision ใหม่ เก็บข้อมูลและลายเซ็นเดิมไว้ตรวจสอบ ลายเซ็นที่ครอบคลุมส่วนที่แก้จะต้องเซ็นใหม่' }),
      h('label', { for: 'am-r', text: 'เหตุผล' }), reason, h('label', { text: 'ส่วนที่ต้องแก้ไข', style: 'margin-top:8px' }), boxes);
    const ok = h('button', { type: 'button', class: 'btn primary' }, 'สร้าง Revision ใหม่');
    const m = modal('ขอแก้ไขหลังลงนาม', body, [h('button', { type: 'button', class: 'btn', onclick: () => m.close() }, 'ยกเลิก'), ok]);
    ok.addEventListener('click', async () => {
      const sheets = boxes.map(b => b.querySelector('input')).filter(i => i.checked).map(i => i.value);
      try {
        const r = await req(B.urls.amend, { reason: reason.value, sheets });
        if (!r.ok) { toast(r.data.message, true); return; }
        ST = r.data.state; m.close(); renderAll(); toast('สร้าง Rev ' + ST.revision + ' แล้ว');
      } catch (e) { toast('ออฟไลน์', true); }
    });
  }
  function openCancel() {
    const reason = h('textarea', { id: 'cc-r' });
    const ok = h('button', { type: 'button', class: 'btn danger' }, 'ยืนยันยกเลิก Audit');
    const m = modal('ยกเลิก Audit', h('div', null, h('label', { for: 'cc-r', text: 'เหตุผล *' }), reason), [h('button', { type: 'button', class: 'btn', onclick: () => m.close() }, 'ปิด'), ok]);
    ok.addEventListener('click', async () => {
      const r = await req(B.urls.cancel, { reason: reason.value });
      if (!r.ok) { toast(r.data.message, true); return; }
      location.reload();
    });
  }
  function openOis() {
    const url = ST.header.ois_url;
    if (!url) { toast('ยังไม่ได้ใส่ลิงก์ OIS/WES ในส่วนหัว', true); const i = $('#hf-ois_url'); if (i) i.focus(); return; }
    const d = h('div', { class: 'drawer', role: 'dialog', 'aria-label': 'OIS/WES' },
      h('div', { class: 'btnrow', style: 'padding:8px;border-bottom:1px solid var(--line);justify-content:space-between' },
        h('b', { text: 'OIS/WES ' + (ST.header.ois_revision || '') }),
        h('span', { class: 'btnrow' }, h('a', { class: 'btn small', href: url, target: '_blank', rel: 'noopener' }, 'เปิดในแท็บใหม่'), h('button', { type: 'button', class: 'btn small', onclick: () => d.remove() }, 'ปิด'))),
      h('iframe', { src: url, title: 'OIS/WES' }));
    document.body.append(d);
  }

  $('#btnOis').addEventListener('click', openOis);
  $('#btnSubmit').addEventListener('click', submitAudit);
  $('#btnSigs').addEventListener('click', openSigPanel);
  $('#btnAmend').addEventListener('click', openAmend);
  $('#btnCancel').addEventListener('click', openCancel);

  queue.forEach(o => { o._sent = false; applyLocal(o); });
  if (window.innerWidth >= 900 || ST.status === 'draft') $('#headToggle').open = true;
  renderAll();
  if (queue.length) flush();
})();
