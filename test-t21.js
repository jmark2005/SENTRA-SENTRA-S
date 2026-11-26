'use strict';

/**
 * test-t21.js — Integration test for T-21 Incident Attachments
 *
 * Run: node test-t21.js
 * Exit code 0 = all PASS, 1 = at least one FAIL.
 *
 * Uses fake users (t21_*) with random passwords generated per run, and
 * fake in-memory files. Test attachments are removed and test incidents
 * archived at the end.
 */

const fs     = require('fs');
const path   = require('path');
const http   = require('http');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const db            = require('./src/repositories/db');
const attachmentSvc = require('./src/services/attachment.service');

// ── Fake users (random passwords, never printed) ─────────────────────────────
function randomPassword() {
  return crypto.randomBytes(12).toString('base64url') + 'Aa1!';
}

function upsertUser(username, roleName, fullName) {
  const role = db.prepare('SELECT id FROM roles WHERE name = ?').get(roleName);
  if (!role) throw new Error(`Role ${roleName} missing. Run the seed first.`);
  const password = randomPassword();
  db.prepare(`
    INSERT INTO users (username, email, password_hash, full_name, role_id, status, password_reset_required)
    VALUES (?, ?, ?, ?, ?, 'Active', 0)
    ON CONFLICT(username) DO UPDATE SET
      email = excluded.email, password_hash = excluded.password_hash,
      full_name = excluded.full_name, role_id = excluded.role_id,
      status = 'Active', password_reset_required = 0
  `).run(username, `${username}@test.local`, bcrypt.hashSync(password, 10), fullName, role.id);
  return { username, password };
}

const ADMIN    = upsertUser('t21_admin',    'sysadmin', 'T21 Admin');
const TEACHER  = upsertUser('t21_teacher',  'teacher',  'T21 Teacher');
const TEACHER2 = upsertUser('t21_teacher2', 'teacher',  'T21 Other Teacher');

// ── Fake files ───────────────────────────────────────────────────────────────
const MB = 1024 * 1024;

function pdfOfSize(bytes) {
  const head = Buffer.from('%PDF-1.4\n% fake test PDF\n');
  const tail = Buffer.from('\n%%EOF\n');
  return Buffer.concat([head, Buffer.alloc(bytes - head.length - tail.length, 0x20), tail]);
}

const FILES = {
  pdf49:  { buf: pdfOfSize(Math.round(4.9 * MB)), type: 'application/pdf', name: 'evidence-4.9MB.pdf' },
  pdf51:  { buf: pdfOfSize(Math.round(5.1 * MB)), type: 'application/pdf', name: 'too-big-5.1MB.pdf' },
  png:    { buf: Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), crypto.randomBytes(64)]), type: 'image/png', name: 'photo.png' },
  jpg:    { buf: Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), crypto.randomBytes(64)]), type: 'image/jpeg', name: 'photo.jpg' },
  docx:   { buf: Buffer.concat([Buffer.from('PK\u0003\u0004', 'latin1'), crypto.randomBytes(64)]),
            type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', name: 'report.docx' },
  // Windows executable header, renamed and declared as a JPEG
  exeJpg: { buf: Buffer.concat([Buffer.from('MZ\u0090\u0000', 'latin1'), crypto.randomBytes(64)]), type: 'image/jpeg', name: 'holiday.jpg' },
  // Valid PDF whose client name tries path traversal and quote injection
  nasty:  { buf: pdfOfSize(2048), type: 'application/pdf', name: '..\\..\\etc/se"cret<1>.pdf' },
};

// ── Server and HTTP helpers ──────────────────────────────────────────────────
const app    = require('./src/app');
const PORT   = 3091;
const BASE   = `http://127.0.0.1:${PORT}`;
const server = http.createServer(app);

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log(`  PASS  ${name}`); }
  else    { failed++; console.error(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

function cookiesFrom(res) {
  return (res.headers.getSetCookie ? res.headers.getSetCookie() : [])
    .map(c => c.split(';')[0]);
}

function mergeCookies(...lists) {
  const map = new Map();
  for (const c of lists.flat()) map.set(c.split('=')[0], c);
  return [...map.values()].join('; ');
}

async function csrf(cookie) {
  const res = await fetch(`${BASE}/api/csrf-token`, { headers: cookie ? { cookie } : {} });
  const { csrfToken } = await res.json();
  return { token: csrfToken, cookies: cookiesFrom(res) };
}

async function login(user) {
  const c = await csrf();
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': c.token, cookie: mergeCookies(c.cookies) },
    body: JSON.stringify({ username: user.username, password: user.password }),
  });
  if (res.status !== 200) throw new Error(`login ${user.username} → ${res.status}`);
  const cookie = mergeCookies(c.cookies, cookiesFrom(res));
  const fresh = await csrf(cookie);
  return { cookie: mergeCookies(cookie.split('; '), fresh.cookies), token: fresh.token };
}

async function upload(session, incidentId, file) {
  const fd = new FormData();
  fd.append('file', new Blob([file.buf], { type: file.type }), file.name);
  const headers = {};
  if (session) { headers.cookie = session.cookie; headers['x-csrf-token'] = session.token; }
  const res = await fetch(`${BASE}/api/incidents/${incidentId}/attachments`, { method: 'POST', headers, body: fd });
  let body = null;
  try { body = await res.json(); } catch (_) { body = null; }
  return { status: res.status, body };
}

async function getJson(session, urlPath) {
  const res = await fetch(BASE + urlPath, { headers: session ? { cookie: session.cookie } : {} });
  let body = null;
  try { body = await res.json(); } catch (_) { body = null; }
  return { status: res.status, body };
}

// Raw request so "../" segments are sent as-is (fetch would normalise them).
function rawGet(rawPath, cookie) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: rawPath, method: 'GET',
      headers: cookie ? { cookie } : {} }, (res) => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

// "attachment; filename=x" or "attachment; filename=\"x\"" → x (RFC 6266 allows both)
function dispositionName(header) {
  const m = /^attachment; filename=(?:"([^"\r\n]*)"|([^;\s"]+))$/.exec(header || '');
  return m ? (m[1] !== undefined ? m[1] : m[2]) : null;
}

function storedUploadFiles() {
  return fs.readdirSync(attachmentSvc.UPLOAD_DIR).filter(n => n !== '.gitkeep');
}

async function createIncident(session, label) {
  const cat = db.prepare('SELECT id FROM incident_categories WHERE is_active = 1 ORDER BY id LIMIT 1').get();
  const date = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  const res = await fetch(`${BASE}/api/incidents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: session.cookie, 'x-csrf-token': session.token },
    body: JSON.stringify({
      category_id: cat.id, incident_date: date, incident_time: '10:00',
      location_text: 'T21 Test Room', description: `T21 attachment test (${label}, fake data)`,
    }),
  });
  const body = await res.json();
  if (res.status !== 201) throw new Error(`create incident → ${res.status} ${JSON.stringify(body)}`);
  return body.id;
}

// ── Tests ────────────────────────────────────────────────────────────────────
async function run() {
  console.log('\n=== T-21 Incident Attachments ===\n');

  const filesBefore = storedUploadFiles().length;
  const admin    = await login(ADMIN);
  const teacher  = await login(TEACHER);
  const teacher2 = await login(TEACHER2);

  const incA = await createIncident(teacher, 'A');
  const incB = await createIncident(teacher, 'B');
  console.log(`  (test incidents ${incA}, ${incB})\n`);

  // Upload without login
  const anon = await csrf();
  const anonSession = { cookie: mergeCookies(anon.cookies), token: anon.token };
  let r = await upload(anonSession, incA, FILES.png);
  check('Upload without login → 401', r.status === 401, `got ${r.status}`);

  // TC-2.9 valid 4.9 MB PDF accepted
  r = await upload(teacher, incA, FILES.pdf49);
  const pdfId = r.body && r.body.id;
  check('Valid 4.9 MB PDF → 201', r.status === 201, `got ${r.status} ${JSON.stringify(r.body)}`);
  const row = pdfId && db.prepare('SELECT * FROM attachments WHERE id = ?').get(pdfId);
  check('Row stored with uuid filename, PDF type, exact size',
    row && /^[0-9a-f-]{36}\.pdf$/.test(row.filename) && row.mime_type === 'application/pdf'
      && row.size_bytes === FILES.pdf49.buf.length && row.original_name === FILES.pdf49.name,
    JSON.stringify(row));
  const storedPath = row && path.join(attachmentSvc.UPLOAD_DIR, row.filename);
  check('File is on disk in uploads/ (outside public/)',
    storedPath && fs.existsSync(storedPath) && !storedPath.includes(`${path.sep}public${path.sep}`)
      && fs.statSync(storedPath).size === FILES.pdf49.buf.length);

  // TC-2.7 .docx rejected
  r = await upload(teacher, incA, FILES.docx);
  check('.docx → 422 "Only JPG, PNG, and PDF files are accepted"',
    r.status === 422 && r.body.error === attachmentSvc.MSG_TYPE, `got ${r.status} ${JSON.stringify(r.body)}`);

  // .exe renamed to .jpg (declared image/jpeg) rejected by signature check
  r = await upload(teacher, incA, FILES.exeJpg);
  check('.exe renamed to .jpg → 422 "Only JPG, PNG, and PDF files are accepted"',
    r.status === 422 && r.body.error === attachmentSvc.MSG_TYPE, `got ${r.status} ${JSON.stringify(r.body)}`);

  // TC-2.8 5.1 MB rejected
  r = await upload(teacher, incA, FILES.pdf51);
  check('5.1 MB PDF → 422 "File exceeds the 5 MB size limit"',
    r.status === 422 && r.body.error === attachmentSvc.MSG_SIZE, `got ${r.status} ${JSON.stringify(r.body)}`);

  check('Rejected uploads left no files in uploads/',
    storedUploadFiles().length === filesBefore + 1, `files: ${storedUploadFiles().length - filesBefore} new`);

  // Fill to 3, then the 4th is refused (TC-2.6)
  r = await upload(teacher, incA, FILES.png);
  check('2nd file (PNG) → 201', r.status === 201, `got ${r.status} ${JSON.stringify(r.body)}`);
  r = await upload(teacher, incA, FILES.jpg);
  check('3rd file (JPG) → 201', r.status === 201, `got ${r.status} ${JSON.stringify(r.body)}`);
  r = await upload(teacher, incA, FILES.png);
  check('4th file → 422 "maximum 3 attachments"',
    r.status === 422 && /maximum 3 attachments/i.test(r.body.error), `got ${r.status} ${JSON.stringify(r.body)}`);

  // Visibility: a teacher who did not report and is not assigned
  r = await upload(teacher2, incB, FILES.png);
  check('Upload by teacher who cannot see the incident → 403', r.status === 403, `got ${r.status}`);

  // Concurrent uploads cannot exceed the limit
  const burst = await Promise.all([1, 2, 3, 4, 5].map(() => upload(teacher, incB, FILES.jpg)));
  const ok201 = burst.filter(x => x.status === 201).length;
  const rej422 = burst.filter(x => x.status === 422).length;
  const countB = db.prepare('SELECT COUNT(*) AS n FROM attachments WHERE incident_id = ?').get(incB).n;
  check('5 simultaneous uploads → exactly 3 accepted, 2 refused', ok201 === 3 && rej422 === 2 && countB === 3,
    `201=${ok201} 422=${rej422} rows=${countB}`);
  check('Refused simultaneous uploads left no files',
    storedUploadFiles().length === filesBefore + 6, `files: ${storedUploadFiles().length - filesBefore} new`);

  // Filename sanitising (use admin on a fresh incident)
  const incC = await createIncident(admin, 'C');
  r = await upload(admin, incC, FILES.nasty);
  check('Client path and reserved characters stripped from original name',
    r.status === 201 && r.body.original_name === 'secret1.pdf', `got ${r.status} ${JSON.stringify(r.body)}`);
  const nastyId = r.body && r.body.id;

  // ── Download ──
  r = await getJson(null, `/api/attachments/${pdfId}/download`);
  check('Download without login → 401 (TC-2.10)', r.status === 401, `got ${r.status}`);

  const dl = await fetch(`${BASE}/api/attachments/${pdfId}/download`, { headers: { cookie: teacher.cookie } });
  const dlBytes = Buffer.from(await dl.arrayBuffer());
  check('Reporter downloads → 200 with identical bytes',
    dl.status === 200 && dlBytes.equals(FILES.pdf49.buf), `got ${dl.status}, ${dlBytes.length} bytes`);
  check('Download Content-Type is the stored type', dl.headers.get('content-type') === 'application/pdf',
    dl.headers.get('content-type'));
  check('Download has X-Content-Type-Options: nosniff', dl.headers.get('x-content-type-options') === 'nosniff');
  check('Download Content-Disposition is attachment with the original name',
    dispositionName(dl.headers.get('content-disposition')) === FILES.pdf49.name,
    dl.headers.get('content-disposition'));

  const dlNasty = await fetch(`${BASE}/api/attachments/${nastyId}/download`, { headers: { cookie: admin.cookie } });
  await dlNasty.arrayBuffer();
  check('Content-Disposition stays a single safe header for odd names',
    dlNasty.status === 200 && dispositionName(dlNasty.headers.get('content-disposition')) === 'secret1.pdf',
    dlNasty.headers.get('content-disposition'));

  r = await getJson(teacher2, `/api/attachments/${pdfId}/download`);
  check('Download by teacher who cannot see the incident → 403', r.status === 403, `got ${r.status}`);

  r = await getJson(admin, '/api/attachments/999999999/download');
  check('Unknown attachment id → 404', r.status === 404, `got ${r.status}`);
  r = await getJson(admin, '/api/attachments/abc/download');
  check('Non-numeric attachment id → 404', r.status === 404, `got ${r.status}`);

  const trav = await rawGet('/api/attachments/../../../package.json', admin.cookie);
  check('Path traversal URL → 404/403, never package.json',
    (trav.status === 404 || trav.status === 403) && !trav.body.includes('"dependencies"'), `got ${trav.status}`);

  // ── Detail endpoint still applies the same visibility (refactor check) ──
  r = await getJson(teacher, `/api/incidents/${incA}`);
  check('GET /api/incidents/:id lists 3 attachments for the reporter',
    r.status === 200 && r.body.attachments.length === 3, `got ${r.status}`);
  r = await getJson(teacher2, `/api/incidents/${incA}`);
  check('GET /api/incidents/:id → 403 for a teacher who cannot see it', r.status === 403, `got ${r.status}`);

  db.prepare('UPDATE incidents SET is_restricted = 1 WHERE id = ?').run(incA);
  r = await getJson(teacher, `/api/incidents/${incA}`);
  const rd = await getJson(teacher, `/api/attachments/${pdfId}/download`);
  const ra = await getJson(admin, `/api/attachments/${pdfId}/download`);
  check('Restricted incident: reporter (not assigned) gets 403 on detail and download',
    r.status === 403 && rd.status === 403, `detail ${r.status}, download ${rd.status}`);
  check('Restricted incident: SysAdmin can still download', ra.status === 200, `got ${ra.status}`);
  db.prepare('UPDATE incidents SET is_restricted = 0 WHERE id = ?').run(incA);

  // ── Audit log ──
  const upAudits = db.prepare(`
    SELECT COUNT(*) AS n FROM audit_logs
    WHERE action_type = 'ATTACHMENT_UPLOADED' AND json_extract(new_values, '$.incident_id') IN (?, ?, ?)
  `).get(incA, incB, incC).n;
  check('Audit log: one ATTACHMENT_UPLOADED per accepted file (7)', upAudits === 7, `got ${upAudits}`);
  const dlAudit = db.prepare(`
    SELECT actor_name FROM audit_logs
    WHERE action_type = 'ATTACHMENT_DOWNLOADED' AND target_id = ? ORDER BY id ASC LIMIT 1
  `).get(pdfId);
  check('Audit log: ATTACHMENT_DOWNLOADED recorded with the actor', dlAudit && dlAudit.actor_name === 'T21 Teacher',
    JSON.stringify(dlAudit));
  const deniedAudit = db.prepare(`
    SELECT COUNT(*) AS n FROM audit_logs
    WHERE action_type = 'ATTACHMENT_DOWNLOADED' AND target_id = ? AND actor_name = 'T21 Other Teacher'
  `).get(pdfId).n;
  check('Audit log: refused downloads are not logged as downloads', deniedAudit === 0, `got ${deniedAudit}`);

  // ── Cleanup: remove test files and rows, archive test incidents ──
  const testRows = db.prepare('SELECT id, filename FROM attachments WHERE incident_id IN (?, ?, ?)').all(incA, incB, incC);
  for (const t of testRows) fs.rmSync(path.join(attachmentSvc.UPLOAD_DIR, t.filename), { force: true });
  db.prepare('DELETE FROM attachments WHERE incident_id IN (?, ?, ?)').run(incA, incB, incC);
  db.prepare('UPDATE incidents SET is_archived = 1 WHERE id IN (?, ?, ?)').run(incA, incB, incC);
  check('Cleanup: uploads/ back to its starting file count', storedUploadFiles().length === filesBefore);
}

server.listen(PORT, async () => {
  try {
    await run();
  } catch (err) {
    failed++;
    console.error('  FAIL  unexpected error:', err);
  }
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  server.close(() => process.exit(failed ? 1 : 0));
});
