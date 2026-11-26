'use strict';

/**
 * test-t10b.js — Pending account / approval-flow integration tests.
 *
 * Covers:
 *  1. Signup creates account with status Pending.
 *  2. Pending account cannot log in.
 *  3. Non-admin (teacher) cannot approve → 403.
 *  4. Approving without a role → 422.
 *  5. Approving a Student without a student_record_id → 422.
 *  6. Approving a non-Pending account → 422.
 *  7. Rejecting a non-Pending account → 422.
 *  8. Successful approve with role → account becomes Active, in-app notification created.
 *  9. Approved user can log in and redirect is role-specific.
 * 10. Reject with reason → status Rejected, login denied.
 *
 * Run: node test-t10b.js
 */

const http = require('http');
const db   = require('./src/repositories/db');
const bcrypt = require('bcryptjs');

// ---------------------------------------------------------------------------
// Seed minimal test data before starting app
// ---------------------------------------------------------------------------
const adminRole   = db.prepare("SELECT id FROM roles WHERE name = 'sysadmin'").get();
const teacherRole = db.prepare("SELECT id FROM roles WHERE name = 'teacher'").get();
const guidanceRole = db.prepare("SELECT id FROM roles WHERE name = 'guidance'").get();
if (!adminRole || !teacherRole || !guidanceRole) {
  console.error('FATAL: required roles not found. Run the seed first.');
  process.exit(1);
}

function upsertUser(username, email, roleId, status) {
  const hash = bcrypt.hashSync('TestPass1!', 10);
  db.prepare(`
    INSERT INTO users (username, email, password_hash, full_name, role_id, status, password_reset_required)
    VALUES (?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(username) DO UPDATE SET
      password_hash = excluded.password_hash,
      role_id = excluded.role_id,
      status = excluded.status,
      password_reset_required = 0
  `).run(username, email, hash, username, roleId, status);
  return db.prepare('SELECT id FROM users WHERE username = ?').get(username).id;
}

const adminId   = upsertUser('t10b_admin',   't10b_admin@test.local',   adminRole.id,   'Active');
const teacherId = upsertUser('t10b_teacher', 't10b_teacher@test.local', teacherRole.id, 'Active');

// Clean up pending test users from previous runs
db.prepare('PRAGMA foreign_keys = OFF').run();
db.prepare("DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE username IN ('t10b_pending','t10b_toreject'))").run();
db.prepare("DELETE FROM user_sessions  WHERE user_id IN (SELECT id FROM users WHERE username IN ('t10b_pending','t10b_toreject'))").run();
db.prepare("DELETE FROM users WHERE username IN ('t10b_pending','t10b_toreject')").run();
db.prepare('PRAGMA foreign_keys = ON').run();

// Create a student record for student-approval tests
let testStudentId = db.prepare("SELECT id FROM students WHERE student_number = 'T10B-STU-001'").get();
if (!testStudentId) {
  const res = db.prepare(`
    INSERT INTO students (student_number, last_name, first_name, grade_level, section, school_year, status, created_by)
    VALUES ('T10B-STU-001', 'T10B', 'Student', '10', 'A', '2026-2027', 'Active', ?)
  `).run(adminId);
  testStudentId = { id: Number(res.lastInsertRowid) };
}
const studentRecordId = testStudentId.id;

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
const app    = require('./src/app');
const server = http.createServer(app);
const PORT   = 3094;

let passed = 0, failed = 0;
function pass(name) { console.log(`  PASS  ${name}`); passed++; }
function fail(name, detail) { console.error(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); failed++; }

function request({ method, path, body, cookie, csrf }) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);
    if (cookie) headers['Cookie'] = cookie;
    if (csrf)   headers['X-CSRF-Token'] = csrf;
    const req = http.request({ hostname: '127.0.0.1', port: PORT, path, method, headers }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(raw); } catch (_) { body = raw; }
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function extractCookie(header) {
  if (!header) return null;
  const val = Array.isArray(header) ? header[0] : header;
  return val.split(';')[0];
}

function mergeCookies(a, b) {
  if (!a) return b; if (!b) return a;
  const map = new Map();
  for (const p of [...a.split('; '), ...b.split('; ')]) { const [n] = p.split('='); map.set(n, p); }
  return [...map.values()].join('; ');
}

async function getCsrf(sessionCookie) {
  const r = await request({ method: 'GET', path: '/api/csrf-token', cookie: sessionCookie });
  return { token: r.body.csrfToken, cookie: extractCookie(r.headers['set-cookie']) };
}

async function login(username, password) {
  const c = await getCsrf();
  const r = await request({
    method: 'POST', path: '/api/auth/login',
    body: { username, password },
    cookie: c.cookie, csrf: c.token,
  });
  if (r.status !== 200) return null;
  const sessCookie = extractCookie(r.headers['set-cookie']);
  return mergeCookies(sessCookie, c.cookie);
}

async function authedRequest(sessionCookie, method, path, body) {
  const c = await getCsrf(sessionCookie);
  const merged = mergeCookies(sessionCookie, c.cookie);
  return request({ method, path, body, cookie: merged, csrf: c.token });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
async function runTests() {
  console.log('\n=== T-10B: Pending Account & Approval Flow Tests ===\n');

  let pendingUserId  = null;
  let rejectUserId   = null;

  // 1. Signup creates Pending account
  {
    const c = await getCsrf();
    const r = await request({
      method: 'POST', path: '/api/users/signup',
      body: { full_name: 'T10B Pending', id_number: 'T10B-001', email: 't10bpending@test.local',
              username: 't10b_pending', password: 'TestPass1!', confirm_password: 'TestPass1!',
              requested_role: 'guidance' },
      cookie: c.cookie, csrf: c.token,
    });
    if (r.status === 201) {
      pass('Signup → 201');
      const row = db.prepare("SELECT id, status FROM users WHERE username = 't10b_pending'").get();
      pendingUserId = row && row.id;
      if (row && row.status === 'Pending') {
        pass('New account has status Pending');
      } else {
        fail('New account has status Pending', `status=${row && row.status}`);
      }
    } else {
      fail('Signup → 201', `status=${r.status} ${JSON.stringify(r.body)}`);
    }
  }

  // Create a second pending user for rejection test
  {
    const c = await getCsrf();
    const r = await request({
      method: 'POST', path: '/api/users/signup',
      body: { full_name: 'T10B Reject', id_number: 'T10B-002', email: 't10breject@test.local',
              username: 't10b_toreject', password: 'TestPass1!', confirm_password: 'TestPass1!',
              requested_role: 'teacher' },
      cookie: c.cookie, csrf: c.token,
    });
    if (r.status === 201) {
      const row = db.prepare("SELECT id FROM users WHERE username = 't10b_toreject'").get();
      rejectUserId = row && row.id;
    }
  }

  // 2. Pending account cannot log in
  {
    const c = await getCsrf();
    const r = await request({
      method: 'POST', path: '/api/auth/login',
      body: { username: 't10b_pending', password: 'TestPass1!' },
      cookie: c.cookie, csrf: c.token,
    });
    if (r.status === 401 && r.body && r.body.error && r.body.error.toLowerCase().includes('pending')) {
      pass('Pending account login → 401 with pending message');
    } else {
      fail('Pending account login → 401 with pending message', `status=${r.status} ${JSON.stringify(r.body)}`);
    }
  }

  // Log in as admin and teacher for subsequent tests
  const adminCookie   = await login('t10b_admin',   'TestPass1!');
  const teacherCookie = await login('t10b_teacher', 'TestPass1!');
  if (!adminCookie)   { fail('Admin login', 'could not log in'); }
  else                { pass('Admin login → 200'); }
  if (!teacherCookie) { fail('Teacher login', 'could not log in'); }
  else                { pass('Teacher login → 200'); }

  // 3. Non-admin (teacher) cannot approve → 403
  if (pendingUserId && teacherCookie) {
    const r = await authedRequest(teacherCookie, 'PATCH', `/api/users/${pendingUserId}/status`,
      { status: 'Active', role: 'guidance' });
    if (r.status === 403) {
      pass('Teacher PATCH status → 403 Forbidden');
    } else {
      fail('Teacher PATCH status → 403 Forbidden', `status=${r.status}`);
    }
  }

  // 4. Approving without a role → 422
  if (pendingUserId && adminCookie) {
    const r = await authedRequest(adminCookie, 'PATCH', `/api/users/${pendingUserId}/status`,
      { status: 'Active' });
    if (r.status === 422 && r.body && r.body.error && r.body.error.includes('role is required')) {
      pass('Approve without role → 422 "role is required"');
    } else {
      fail('Approve without role → 422 "role is required"', `status=${r.status} ${JSON.stringify(r.body)}`);
    }
  }

  // 5. Approving Student without student_record_id → 422
  if (pendingUserId && adminCookie) {
    const r = await authedRequest(adminCookie, 'PATCH', `/api/users/${pendingUserId}/status`,
      { status: 'Active', role: 'student' });
    if (r.status === 422 && r.body && r.body.error && r.body.error.includes('student_record_id')) {
      pass('Approve Student without record → 422');
    } else {
      fail('Approve Student without record → 422', `status=${r.status} ${JSON.stringify(r.body)}`);
    }
  }

  // 6. Approving a non-Pending account (the teacher, who is Active) → 422
  if (adminCookie) {
    const r = await authedRequest(adminCookie, 'PATCH', `/api/users/${teacherId}/status`,
      { status: 'Active', role: 'teacher' });
    if (r.status === 422 && r.body && r.body.error && r.body.error.includes('Cannot approve')) {
      pass('Approve non-Pending account → 422');
    } else {
      fail('Approve non-Pending account → 422', `status=${r.status} ${JSON.stringify(r.body)}`);
    }
  }

  // 7. Rejecting a non-Pending account → 422
  if (adminCookie) {
    const r = await authedRequest(adminCookie, 'PATCH', `/api/users/${teacherId}/status`,
      { status: 'Rejected' });
    if (r.status === 422 && r.body && r.body.error && r.body.error.includes('Cannot reject')) {
      pass('Reject non-Pending account → 422');
    } else {
      fail('Reject non-Pending account → 422', `status=${r.status} ${JSON.stringify(r.body)}`);
    }
  }

  // 8. Successful approve with role → Active + notification
  if (pendingUserId && adminCookie) {
    const r = await authedRequest(adminCookie, 'PATCH', `/api/users/${pendingUserId}/status`,
      { status: 'Active', role: 'guidance' });
    if (r.status === 200 && r.body && r.body.user && r.body.user.status === 'Active') {
      pass('Approve with role → 200, status Active');
    } else {
      fail('Approve with role → 200, status Active', `status=${r.status} ${JSON.stringify(r.body)}`);
    }
    // Verify role_id was updated
    const row = db.prepare(`
      SELECT r.name AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?
    `).get(pendingUserId);
    if (row && row.role === 'guidance') {
      pass('Approved user role_id updated to guidance');
    } else {
      fail('Approved user role_id updated to guidance', `role=${row && row.role}`);
    }
    // Verify notification
    const notif = db.prepare(
      "SELECT id FROM notifications WHERE user_id = ? AND type = 'Account Approval' AND title = 'Account approved'"
    ).get(pendingUserId);
    if (notif) {
      pass('In-app notification created for approved user');
    } else {
      fail('In-app notification created for approved user', 'no notification row found');
    }
  }

  // 9. Approved user can log in and redirect is role-specific
  {
    const cookie = await login('t10b_pending', 'TestPass1!');
    if (cookie) {
      pass('Approved user can log in → 200');
      // Verify redirect via /api/auth/me
      const r = await request({ method: 'GET', path: '/api/auth/me', cookie });
      if (r.status === 200 && r.body && r.body.role === 'guidance') {
        pass('Approved user /api/auth/me returns correct role (guidance)');
      } else {
        fail('Approved user /api/auth/me returns correct role', `status=${r.status} ${JSON.stringify(r.body)}`);
      }
    } else {
      fail('Approved user can log in → 200', 'login returned non-200');
    }
  }

  // 10. Reject with reason → Rejected, login denied
  if (rejectUserId && adminCookie) {
    const r = await authedRequest(adminCookie, 'PATCH', `/api/users/${rejectUserId}/status`,
      { status: 'Rejected', rejection_reason: 'Test rejection' });
    if (r.status === 200 && r.body && r.body.user && r.body.user.status === 'Rejected') {
      pass('Reject → 200, status Rejected');
    } else {
      fail('Reject → 200, status Rejected', `status=${r.status} ${JSON.stringify(r.body)}`);
    }
    // Verify reason stored
    const row = db.prepare('SELECT rejection_reason FROM users WHERE id = ?').get(rejectUserId);
    if (row && row.rejection_reason === 'Test rejection') {
      pass('Rejection reason stored in DB');
    } else {
      fail('Rejection reason stored in DB', `reason=${row && row.rejection_reason}`);
    }
    // Verify login denied
    const c = await getCsrf();
    const loginR = await request({
      method: 'POST', path: '/api/auth/login',
      body: { username: 't10b_toreject', password: 'TestPass1!' },
      cookie: c.cookie, csrf: c.token,
    });
    if (loginR.status === 401 && loginR.body && loginR.body.error && loginR.body.error.toLowerCase().includes('rejected')) {
      pass('Rejected account login → 401 with rejected message');
    } else {
      fail('Rejected account login → 401 with rejected message', `status=${loginR.status} ${JSON.stringify(loginR.body)}`);
    }
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  server.close(() => process.exit(failed > 0 ? 1 : 0));
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Test server started on port ${PORT}`);
  runTests().catch(err => {
    console.error('Unexpected error:', err);
    server.close(() => process.exit(1));
  });
});
