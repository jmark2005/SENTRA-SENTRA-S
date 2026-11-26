'use strict';

/**
 * test-t42.js — Referral (Workflow B) + Attendance (Workflow C) — T-42
 *
 * Run: node test-t42.js
 * Exit 0 = all PASS, 1 = any FAIL.
 *
 * Workflow B — Referral:
 *  1. Teacher submits referral → Pending
 *  2. Guidance sees it in queue
 *  3. Teacher2 cannot see Teacher's referral
 *  4. Guidance assigns to self → Ongoing
 *  5. Guidance adds follow-up
 *  6. Complete without completion_note → 422
 *  7. Complete with completion_note → Completed (read-only)
 *  8. Add follow-up to Completed → 422
 *
 * Workflow C — Attendance:
 *  1. Create class + assign student
 *  2. Teacher submits attendance (Absent)
 *  3. Teacher corrects without reason → 400/422
 *  4. Teacher corrects with reason (same day) → 200
 *  5. Teacher tries to correct past-date record → 403
 *  6. SysAdmin can correct past-date record
 */

const http   = require('http');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db     = require('./src/repositories/db');

function randomPassword() {
  return crypto.randomBytes(12).toString('base64url') + 'Aa1!';
}
function upsertUser(username, roleName, fullName) {
  const role = db.prepare('SELECT id FROM roles WHERE name = ?').get(roleName);
  if (!role) throw new Error(`Role ${roleName} missing – run the seed first.`);
  const password = randomPassword();
  db.prepare(`
    INSERT INTO users (username, email, password_hash, full_name, role_id, status, password_reset_required)
    VALUES (?, ?, ?, ?, ?, 'Active', 0)
    ON CONFLICT(username) DO UPDATE SET
      email = excluded.email, password_hash = excluded.password_hash,
      full_name = excluded.full_name, role_id = excluded.role_id,
      status = 'Active', password_reset_required = 0
  `).run(username, `${username}@t42.local`, bcrypt.hashSync(password, 10), fullName, role.id);
  return { username, password };
}

const TEACHER  = upsertUser('t42_teacher',  'teacher',  'T42 Teacher');
const TEACHER2 = upsertUser('t42_teacher2', 'teacher',  'T42 Teacher2');
const GUIDANCE = upsertUser('t42_guidance', 'guidance', 'T42 Guidance');
const ADMIN    = upsertUser('t42_admin',    'sysadmin', 'T42 Admin');

const teacherUser   = db.prepare("SELECT id FROM users WHERE username = 't42_teacher'").get();
const teacher2User  = db.prepare("SELECT id FROM users WHERE username = 't42_teacher2'").get();
const guidanceUser  = db.prepare("SELECT id FROM users WHERE username = 't42_guidance'").get();
const adminUser     = db.prepare("SELECT id FROM users WHERE username = 't42_admin'").get();

// Create a test student
db.prepare(`INSERT OR IGNORE INTO students (student_number, last_name, first_name, grade_level, section, school_year, created_by)
  VALUES ('T42-9999', 'T42Last', 'T42First', '11', 'A', '2026-2027', ?)`).run(adminUser.id);
const student = db.prepare("SELECT id FROM students WHERE student_number = 'T42-9999'").get();

// Create a test class with teacher as class adviser
db.prepare(`INSERT OR IGNORE INTO classes (name, grade_level, section, school_year, semester, class_adviser_id, is_active, created_by)
  VALUES ('T42 Class', '11', 'A', '2026-2027', '1st Semester', ?, 1, ?)`).run(teacherUser.id, adminUser.id);
const cls = db.prepare("SELECT id FROM classes WHERE name = 'T42 Class'").get();

// Assign teacher to class
db.prepare('INSERT OR IGNORE INTO class_teachers (class_id, user_id) VALUES (?, ?)').run(cls.id, teacherUser.id);

// Assign student to class
db.prepare(`INSERT OR IGNORE INTO student_class_assignments (student_id, class_id, school_year, semester)
  VALUES (?, ?, '2026-2027', '1st Semester')`).run(student.id, cls.id);

const app    = require('./src/app');
const PORT   = 3092;
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
  if (r.status !== 200) throw new Error(`login ${user.username} → ${r.status}`);
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
  console.log('\n=== T-42: Referral (Workflow B) + Attendance (Workflow C) ===\n');

  const teacher  = await login(TEACHER);
  const teacher2 = await login(TEACHER2);
  const guidance = await login(GUIDANCE);
  const admin    = await login(ADMIN);

  const today    = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  // ── Workflow B: Referral ────────────────────────────────────────────────────
  console.log('--- Workflow B: Referral ---');

  // 1. Teacher submits referral
  let r = await req(teacher, 'POST', '/api/referrals', {
    student_id:    student.id,
    referral_type: 'Guidance Referral',
    referral_date: today,
    remarks:       'T42 referral test – administrative remark only.',
  });
  check('Teacher submits referral → 201', r.status === 201, `got ${r.status} ${JSON.stringify(r.body)}`);
  const refId = r.body && r.body.id;
  check('Referral status = Pending', r.body && r.body.status === 'Pending', `status=${r.body && r.body.status}`);

  if (!refId) { fail++; console.error('No referral id – cannot continue workflow B'); }
  else {
    // 2. Guidance sees it in queue
    r = await req(guidance, 'GET', '/api/referrals');
    check('Guidance GET /api/referrals → 200', r.status === 200, `got ${r.status}`);
    const guidList = r.body && (r.body.data || []);
    check('Guidance sees pending referral', guidList.some(x => x.id === refId), `id=${refId} not in list`);

    // 3. Teacher2 cannot see Teacher's referral
    r = await req(teacher2, 'GET', '/api/referrals');
    const t2List = r.body && (r.body.data || []);
    check("Teacher2 cannot see Teacher's referral", !t2List.some(x => x.id === refId), `id=${refId} visible to t2`);

    // 4. Guidance assigns to self → Ongoing
    r = await req(guidance, 'PATCH', `/api/referrals/${refId}/assign`, { user_id: guidanceUser.id });
    check('Guidance assigns to self → 200', r.status === 200, `got ${r.status} ${JSON.stringify(r.body)}`);
    check('Status → Ongoing', r.body && r.body.status === 'Ongoing', `status=${r.body && r.body.status}`);

    // 5. Guidance adds follow-up
    r = await req(guidance, 'POST', `/api/referrals/${refId}/followups`, {
      activity_desc: 'T42 initial follow-up session conducted.',
      activity_date: today,
      next_followup: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
    });
    check('Guidance adds follow-up → 201', r.status === 201, `got ${r.status} ${JSON.stringify(r.body)}`);

    // 6. Complete without completion_note → 422
    r = await req(guidance, 'PATCH', `/api/referrals/${refId}/status`, { status: 'Completed' });
    check('Complete without completion_note → 422', r.status === 422, `got ${r.status} ${JSON.stringify(r.body)}`);

    // 7. Complete with completion_note → Completed
    r = await req(guidance, 'PATCH', `/api/referrals/${refId}/status`, {
      status:          'Completed',
      completion_note: 'T42 referral addressed. Student counselled and situation resolved.',
    });
    check('Complete with note → 200', r.status === 200, `got ${r.status} ${JSON.stringify(r.body)}`);
    check('Status → Completed', r.body && r.body.status === 'Completed', `status=${r.body && r.body.status}`);

    // 8. Add follow-up to Completed referral → 422
    r = await req(guidance, 'POST', `/api/referrals/${refId}/followups`, {
      activity_desc: 'T42 extra follow-up should fail.',
      activity_date: today,
    });
    check('Follow-up on Completed → 422', r.status === 422, `got ${r.status} ${JSON.stringify(r.body)}`);
  }

  // ── Workflow C: Attendance ──────────────────────────────────────────────────
  console.log('');
  console.log('--- Workflow C: Attendance ---');

  // 1+2. Teacher submits attendance (Absent)
  r = await req(teacher, 'POST', `/api/attendance/classes/${cls.id}/date/${today}`, {
    records: [{ student_id: student.id, status: 'Absent' }],
  });
  check('Teacher submits attendance → 201', r.status === 201, `got ${r.status} ${JSON.stringify(r.body)}`);

  // Find the attendance record
  const attRow = db.prepare('SELECT id FROM attendance_records WHERE student_id = ? AND class_id = ? AND record_date = ?')
    .get(student.id, cls.id, today);
  check('Attendance record saved in DB', !!attRow);

  if (attRow) {
    // 3. Correct without reason → 400
    r = await req(teacher, 'PATCH', `/api/attendance/${attRow.id}`, { status: 'Present' });
    check('Correct without reason → 400 or 422', r.status === 400 || r.status === 422, `got ${r.status} ${JSON.stringify(r.body)}`);

    // 4. Correct with reason (same day) → 200
    r = await req(teacher, 'PATCH', `/api/attendance/${attRow.id}`, {
      status: 'Present',
      reason: 'T42 correction – student arrived late; marked present.',
    });
    check('Correct with reason (same day) → 200', r.status === 200, `got ${r.status} ${JSON.stringify(r.body)}`);
  }

  // 5. Past-date record: insert directly (bypassing the today-only check on submit)
  db.prepare(`
    INSERT OR IGNORE INTO attendance_records
      (student_id, class_id, record_date, status, recorded_by)
    VALUES (?, ?, ?, 'Absent', ?)
  `).run(student.id, cls.id, yesterday, teacherUser.id);
  const pastRow = db.prepare('SELECT id FROM attendance_records WHERE student_id = ? AND class_id = ? AND record_date = ?')
    .get(student.id, cls.id, yesterday);

  if (pastRow) {
    // Teacher tries to correct past-date record → 403
    r = await req(teacher, 'PATCH', `/api/attendance/${pastRow.id}`, {
      status: 'Present',
      reason: 'T42 correction attempt on past record.',
    });
    check('Teacher corrects past-date record → 403', r.status === 403, `got ${r.status} ${JSON.stringify(r.body)}`);

    // 6. SysAdmin can correct any time
    r = await req(admin, 'PATCH', `/api/attendance/${pastRow.id}`, {
      status: 'Tardy',
      reason: 'T42 admin correction on past record.',
    });
    check('SysAdmin corrects past-date record → 200', r.status === 200, `got ${r.status} ${JSON.stringify(r.body)}`);
  } else {
    check('Past-date attendance record created', false, 'failed to insert');
    check('Teacher corrects past-date → 403', false, 'skipped');
    check('SysAdmin corrects past-date → 200', false, 'skipped');
  }

  console.log('');
  console.log(`=== Results: ${pass} passed, ${fail} failed ===\n`);
}

server.listen(PORT, async () => {
  try { await run(); }
  catch (err) { fail++; console.error('Unexpected error:', err); }
  server.close(() => process.exit(fail ? 1 : 0));
});
