'use strict';

/**
 * test-t43.js — Access Control Verification (T-43)
 *
 * Run: node test-t43.js
 * Exit 0 = all PASS, 1 = any FAIL.
 *
 * Tests:
 *  1. Per-permission denials: for each guarded route, verify that at least one
 *     denied role receives 403.
 *  2. Restricted incident hidden from Teacher/Guidance/SafetyOff unless assigned.
 *  3. Audit log inaccessible to Teacher.
 *  4. Student (when flag=0) cannot submit incident.
 */

const http   = require('http');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db     = require('./src/repositories/db');

function randomPassword() {
  return crypto.randomBytes(12).toString('base64url') + 'Aa1!';
}
function upsertUser(username, roleName, fullName, extra) {
  const role = db.prepare('SELECT id FROM roles WHERE name = ?').get(roleName);
  if (!role) throw new Error(`Role ${roleName} missing – run the seed first.`);
  const password = randomPassword();
  const extra_srid = extra && extra.student_record_id ? extra.student_record_id : null;
  db.prepare(`
    INSERT INTO users (username, email, password_hash, full_name, role_id, status,
                       password_reset_required, student_record_id)
    VALUES (?, ?, ?, ?, ?, 'Active', 0, ?)
    ON CONFLICT(username) DO UPDATE SET
      email = excluded.email, password_hash = excluded.password_hash,
      full_name = excluded.full_name, role_id = excluded.role_id,
      status = 'Active', password_reset_required = 0,
      student_record_id = excluded.student_record_id
  `).run(username, `${username}@t43.local`, bcrypt.hashSync(password, 10), fullName, role.id, extra_srid);
  return { username, password };
}

// Seed a student record so the student account can link to it
const adminUser43 = db.prepare("SELECT id FROM users WHERE username = 't43_admin'").get()
  || (() => { upsertUser('t43_admin', 'sysadmin', 'T43 Admin'); return db.prepare("SELECT id FROM users WHERE username = 't43_admin'").get(); })();

db.prepare(`INSERT OR IGNORE INTO students (student_number, last_name, first_name, grade_level, section, school_year, created_by)
  VALUES ('T43-9001', 'T43L', 'T43F', '11', 'B', '2026-2027', ?)`).run(adminUser43.id);
const studentRec = db.prepare("SELECT id FROM students WHERE student_number = 'T43-9001'").get();

const ADMIN    = upsertUser('t43_admin',    'sysadmin',       'T43 Admin');
const TEACHER  = upsertUser('t43_teacher',  'teacher',        'T43 Teacher');
const GUIDANCE = upsertUser('t43_guidance', 'guidance',       'T43 Guidance');
const SAFETY   = upsertUser('t43_safety',   'safetyofficer',  'T43 Safety');
const SCHHEAD  = upsertUser('t43_schhead',  'schoolhead',     'T43 SchHead');
const STUDENT  = upsertUser('t43_student',  'student',        'T43 Student', { student_record_id: studentRec.id });

// Make sure student_feature_enabled = 0 (default)
db.prepare("UPDATE system_settings SET value = '0' WHERE key = 'student_feature_enabled'").run();

const catRow = db.prepare('SELECT id FROM incident_categories WHERE is_active = 1 LIMIT 1').get();
const adminId = db.prepare("SELECT id FROM users WHERE username = 't43_admin'").get().id;

// Create a restricted incident for restriction tests
const today = new Date().toISOString().slice(0, 10);
const refRestricted = `T43-RES-${Date.now()}`;
db.prepare(`INSERT INTO incidents
  (reference_number, category_id, incident_date, incident_time, location_text, description,
   severity, status, is_restricted, reporter_id)
  VALUES (?, ?, ?, '11:00', 'T43 restricted loc', 'T43 restricted test', 'High', 'Under Review', 1, ?)`
).run(refRestricted, catRow.id, today, adminId);
const restrictedInc = db.prepare('SELECT id FROM incidents WHERE reference_number = ?').get(refRestricted);

// ── Server ────────────────────────────────────────────────────────────────────

const app    = require('./src/app');
const PORT   = 3093;
const BASE   = `http://127.0.0.1:${PORT}`;
const server = http.createServer(app);

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else    { fail++; console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); }
}
function cookiesFrom(res) {
  return (res.headers.getSetCookie ? res.headers.getSetCookie() : []).map(c => c.split(';')[0]);
}
function mergeCookies(...lists) {
  const map = new Map();
  for (const c of lists.flat()) if (c) map.set(c.split('=')[0], c);
  return [...map.values()].join('; ');
}
async function csrf(cookie) {
  const r = await fetch(`${BASE}/api/csrf-token`, { headers: cookie ? { cookie } : {} });
  const { csrfToken } = await r.json();
  return { token: csrfToken, cookies: cookiesFrom(r) };
}
async function login(user) {
  const c = await csrf();
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': c.token, cookie: mergeCookies(c.cookies) },
    body: JSON.stringify({ username: user.username, password: user.password }),
  });
  if (r.status !== 200) throw new Error(`login ${user.username} → ${r.status}: ${await r.text()}`);
  const cookie = mergeCookies(c.cookies, cookiesFrom(r));
  const fresh  = await csrf(cookie);
  return { cookie: mergeCookies(cookie.split('; '), fresh.cookies), token: fresh.token };
}
async function req(session, method, path, body) {
  const headers = { 'content-type': 'application/json' };
  if (session) { headers.cookie = session.cookie; headers['x-csrf-token'] = session.token; }
  const opts = { method, headers };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(BASE + path, opts);
  let json = null;
  try { json = await r.json(); } catch (_) {}
  return { status: r.status, body: json };
}

async function run() {
  console.log('\n=== T-43: Access Control Verification ===\n');

  const teacher  = await login(TEACHER);
  const guidance = await login(GUIDANCE);
  const safety   = await login(SAFETY);
  const schhead  = await login(SCHHEAD);
  const admin    = await login(ADMIN);
  const student  = await login(STUDENT);

  // ── 1. Per-permission denials ─────────────────────────────────────────────
  console.log('--- Permission denial checks ---');

  // manage_accounts: teacher → 403
  let r = await req(teacher, 'GET', '/api/users');
  check('manage_accounts: Teacher denied → 403', r.status === 403, `got ${r.status}`);

  // manage_roles_permissions: teacher → 403
  r = await req(teacher, 'PATCH', '/api/roles/1/permissions', {});
  check('manage_roles_permissions: Teacher denied → 403', r.status === 403, `got ${r.status}`);

  // manage_settings: teacher → 403
  r = await req(teacher, 'GET', '/api/settings');
  check('manage_settings (GET): Teacher denied → 403', r.status === 403, `got ${r.status}`);

  // view_audit_log: teacher → 403
  r = await req(teacher, 'GET', '/api/audit-logs');
  check('view_audit_log: Teacher denied → 403', r.status === 403, `got ${r.status}`);

  // manage_incident_categories: teacher → 403
  r = await req(teacher, 'POST', '/api/incident-categories', { name: 'T43 test cat' });
  check('manage_incident_categories: Teacher denied → 403', r.status === 403, `got ${r.status}`);

  // manage_escalation_rules: teacher → 403
  r = await req(teacher, 'GET', '/api/escalation-rules');
  check('manage_escalation_rules: Teacher denied → 403', r.status === 403, `got ${r.status}`);

  // manage_classes: teacher → 403 (teacher has view_classes but not manage_classes for POST)
  r = await req(teacher, 'POST', '/api/classes', {});
  check('manage_classes (POST): Teacher denied → 403', r.status === 403, `got ${r.status}`);

  // view_reports: student → 403
  r = await req(student, 'GET', '/api/reports/incidents');
  check('view_reports: Student denied → 403', r.status === 403, `got ${r.status}`);

  // assign_incidents: teacher → 403
  r = await req(teacher, 'POST', '/api/incidents/1/assign', { user_ids: [] });
  check('assign_incidents: Teacher denied → 403', r.status === 403, `got ${r.status}`);

  // archive_incidents: teacher → 403
  r = await req(teacher, 'GET', '/api/incidents/archived');
  check('archive_incidents (GET archived): Teacher denied → 403', r.status === 403, `got ${r.status}`);

  // ── 2. Student cannot submit incident when flag=0 ─────────────────────────
  console.log('');
  console.log('--- Student feature flag = 0 ---');
  r = await req(student, 'POST', '/api/incidents', {
    category_id:   catRow.id,
    incident_date: today,
    incident_time: '12:00',
    location_text: 'Student test',
    description:   'T43 student should be blocked',
  });
  check('Student cannot submit incident (flag=0) → 403', r.status === 403, `got ${r.status}`);

  // ── 3. Restricted incident hidden from Teacher/Guidance/SafetyOff ─────────
  console.log('');
  console.log('--- Restricted incident visibility ---');

  // Teacher cannot see it
  r = await req(teacher, 'GET', '/api/incidents');
  const teacherList = r.body && (r.body.data || []);
  check('Restricted incident hidden from Teacher list', !teacherList.some(i => i.id === restrictedInc.id));

  r = await req(teacher, 'GET', `/api/incidents/${restrictedInc.id}`);
  check('Teacher GET restricted incident → 403', r.status === 403, `got ${r.status}`);

  // Guidance cannot see it
  r = await req(guidance, 'GET', `/api/incidents/${restrictedInc.id}`);
  check('Guidance GET restricted incident → 403', r.status === 403, `got ${r.status}`);

  // SafetyOff cannot see it (unless assigned — they are not assigned here)
  r = await req(safety, 'GET', `/api/incidents/${restrictedInc.id}`);
  check('SafetyOff GET restricted incident (unassigned) → 403', r.status === 403, `got ${r.status}`);

  // SysAdmin can see it
  r = await req(admin, 'GET', `/api/incidents/${restrictedInc.id}`);
  check('SysAdmin GET restricted incident → 200', r.status === 200, `got ${r.status}`);

  // SchHead can see it
  r = await req(schhead, 'GET', `/api/incidents/${restrictedInc.id}`);
  check('SchHead GET restricted incident → 200', r.status === 200, `got ${r.status}`);

  // ── 4. Audit log access ───────────────────────────────────────────────────
  console.log('');
  console.log('--- Audit log access ---');

  r = await req(teacher, 'GET', '/api/audit-logs');
  check('Audit log: Teacher → 403', r.status === 403, `got ${r.status}`);

  r = await req(guidance, 'GET', '/api/audit-logs');
  check('Audit log: Guidance → 403', r.status === 403, `got ${r.status}`);

  r = await req(admin, 'GET', '/api/audit-logs');
  check('Audit log: SysAdmin → 200', r.status === 200, `got ${r.status}`);

  r = await req(schhead, 'GET', '/api/audit-logs');
  check('Audit log: SchHead → 200 (authorized subset)', r.status === 200, `got ${r.status}`);

  console.log('');
  console.log(`=== Results: ${pass} passed, ${fail} failed ===\n`);
}

server.listen(PORT, async () => {
  try { await run(); }
  catch (err) { fail++; console.error('Unexpected error:', err); }
  server.close(() => process.exit(fail ? 1 : 0));
});
