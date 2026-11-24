'use strict';

/**
 * test-t14.js — Integration test for T-14 Personnel Participation History API
 *
 * Run: node test-t14.js
 * Exit code 0 = all PASS, exit code 1 = at least one FAIL.
 */

const http = require('http');

// ---------------------------------------------------------------------------
// 1. Insert test data BEFORE requiring app
// ---------------------------------------------------------------------------
const db     = require('./src/repositories/db');
const bcrypt = require('bcryptjs');

const adminRole = db.prepare("SELECT id FROM roles WHERE name='sysadmin'").get();
if (!adminRole) {
  console.error('FATAL: sysadmin role not found in DB. Run the seed first.');
  process.exit(1);
}

const teacherRole = db.prepare("SELECT id FROM roles WHERE name='teacher'").get();
if (!teacherRole) {
  console.error('FATAL: teacher role not found in DB. Run the seed first.');
  process.exit(1);
}

const adminHash   = bcrypt.hashSync('AdminPass1!', 12);
const teacherHash = bcrypt.hashSync('TeachPass1!', 12);

db.prepare(`INSERT INTO users (username,email,password_hash,full_name,role_id,status,password_reset_required)
  VALUES (?,?,?,?,?,'Active',0)
  ON CONFLICT(username) DO UPDATE SET email=excluded.email,password_hash=excluded.password_hash,
  full_name=excluded.full_name,role_id=excluded.role_id,status=excluded.status,password_reset_required=excluded.password_reset_required`)
  .run('t14_admin', 't14admin@test.local', adminHash, 'T14 Admin', adminRole.id);

db.prepare(`INSERT INTO users (username,email,password_hash,full_name,role_id,status,password_reset_required)
  VALUES (?,?,?,?,?,'Active',0)
  ON CONFLICT(username) DO UPDATE SET email=excluded.email,password_hash=excluded.password_hash,
  full_name=excluded.full_name,role_id=excluded.role_id,status=excluded.status,password_reset_required=excluded.password_reset_required`)
  .run('t14_teacher', 't14teacher@test.local', teacherHash, 'T14 Teacher', teacherRole.id);

const teacherUser = db.prepare("SELECT id FROM users WHERE username='t14_teacher'").get();
const adminUser   = db.prepare("SELECT id FROM users WHERE username='t14_admin'").get();

// Seed incident category
db.prepare(`INSERT OR IGNORE INTO incident_categories (name) VALUES ('T14 Test Category')`).run();
const cat = db.prepare("SELECT id FROM incident_categories WHERE name='T14 Test Category'").get();

// Seed 2 incidents reported by teacher
for (let i = 0; i < 2; i++) {
  db.prepare(`INSERT OR IGNORE INTO incidents (reference_number,category_id,incident_date,incident_time,location_text,description,reporter_id)
    VALUES (?,?,?,?,?,?,?)`)
    .run(`T14-INC-${i}`, cat.id, '2026-01-01', '08:00', 'Test', 'Test incident', teacherUser.id);
}

// Seed 1 incident assignment for teacher
const inc = db.prepare("SELECT id FROM incidents WHERE reference_number='T14-INC-0'").get();
db.prepare(`INSERT OR IGNORE INTO incident_assignments (incident_id,assigned_to,assigned_by)
  SELECT ?,?,? WHERE NOT EXISTS (SELECT 1 FROM incident_assignments WHERE incident_id=? AND assigned_to=?)`)
  .run(inc.id, teacherUser.id, adminUser.id, inc.id, teacherUser.id);

// Seed student and class for attendance records
const studentRoleId = db.prepare("SELECT id FROM roles WHERE name='student'").get().id;
db.prepare(`INSERT OR IGNORE INTO users (username,email,password_hash,full_name,role_id,status,password_reset_required)
  VALUES ('t14_stu','t14stu@test.local','x','T14 Student',?,?, 0)`).run(studentRoleId, 'Active');
const stuUser = db.prepare("SELECT id FROM users WHERE username='t14_stu'").get();

db.prepare(`INSERT OR IGNORE INTO students (student_number,last_name,first_name,grade_level,section,school_year,created_by)
  VALUES ('T14-S-001','Doe','Jane','11','A','2026-2027',?)`).run(stuUser.id);
const student = db.prepare("SELECT id FROM students WHERE student_number='T14-S-001'").get();

db.prepare(`INSERT OR IGNORE INTO classes (name,grade_level,section,school_year,semester,class_adviser_id,created_by)
  VALUES ('T14 Class','11','A','2026-2027','1st Semester',?,?)`).run(teacherUser.id, adminUser.id);
const cls = db.prepare("SELECT id FROM classes WHERE name='T14 Class'").get();

for (let i = 0; i < 3; i++) {
  db.prepare(`INSERT OR IGNORE INTO attendance_records (student_id,class_id,record_date,status,recorded_by)
    VALUES (?,?,?,?,?)`)
    .run(student.id, cls.id, `2026-01-0${i + 1}`, 'Present', teacherUser.id);
}

// ---------------------------------------------------------------------------
// 2. Start server on port 3089
// ---------------------------------------------------------------------------
const app      = require('./src/app');
const TEST_PORT = 3089;
const server   = http.createServer(app);

// ---------------------------------------------------------------------------
// 3. Test helpers
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;

function pass(name) {
  console.log(`  PASS  ${name}`);
  passed++;
}

function fail(name, detail) {
  console.error(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  failed++;
}

function request({ method, path, body, cookie, csrfToken }) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (payload)   headers['Content-Length'] = Buffer.byteLength(payload);
    if (cookie)    headers['Cookie'] = cookie;
    if (csrfToken) headers['X-CSRF-Token'] = csrfToken;

    const options = {
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path,
      method,
      headers,
    };

    const req = http.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch (_) { parsed = raw; }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function extractCookie(setCookieHeader) {
  if (!setCookieHeader) return null;
  const val = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  return val.split(';')[0];
}

async function fetchCsrf(sessionCookie) {
  const r = await request({
    method: 'GET',
    path: '/api/csrf-token',
    cookie: sessionCookie || undefined,
  });
  const csrfCookie = extractCookie(r.headers['set-cookie']);
  const csrfToken  = r.body && r.body.csrfToken;
  return { csrfToken, csrfCookie };
}

function mergeCookies(a, b) {
  if (!a) return b;
  if (!b) return a;
  const map = new Map();
  for (const part of [...a.split('; '), ...b.split('; ')]) {
    const [name] = part.split('=');
    map.set(name, part);
  }
  return [...map.values()].join('; ');
}

/** Full CSRF + login flow. Returns merged cookie string or null on failure. */
async function login(username, password) {
  const { csrfToken, csrfCookie } = await fetchCsrf();

  const r = await request({
    method: 'POST',
    path: '/api/auth/login',
    body: { username, password },
    cookie: csrfCookie,
    csrfToken,
  });

  if (r.status !== 200) return null;

  const sessionCookie = extractCookie(r.headers['set-cookie']);
  if (!sessionCookie) return null;

  return mergeCookies(sessionCookie, csrfCookie);
}

// ---------------------------------------------------------------------------
// 4. Run tests
// ---------------------------------------------------------------------------
async function runTests() {
  console.log('\n=== T-14 Personnel Participation History API Tests ===\n');

  // ---- Check 1: Login as sysadmin ------------------------------------------
  let adminCookie = await login('t14_admin', 'AdminPass1!');
  if (!adminCookie) {
    fail('SysAdmin login → 200 + session cookie', 'Could not log in as t14_admin');
    console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
    server.close(() => process.exit(1));
    return;
  }
  pass('SysAdmin login → 200 + session cookie');

  // ---- Check 2: GET participation as admin → 200 with correct counts -------
  {
    const r = await request({
      method: 'GET',
      path: `/api/users/${teacherUser.id}/participation`,
      cookie: adminCookie,
    });

    const p = r.body && r.body.participation;
    const incReported = p && p.incidents_reported;
    const incAssigned = p && p.incidents_assigned;
    const attRecorded = p && p.attendance_recorded;

    if (
      r.status === 200 &&
      incReported === 2 &&
      incAssigned === 1 &&
      attRecorded === 3
    ) {
      pass(`GET /api/users/${teacherUser.id}/participation → 200, incidents_reported=2, incidents_assigned=1, attendance_recorded=3`);
    } else {
      fail(
        `GET /api/users/${teacherUser.id}/participation → 200 with correct counts`,
        `status=${r.status}, incidents_reported=${incReported}, incidents_assigned=${incAssigned}, attendance_recorded=${attRecorded}, body=${JSON.stringify(r.body)}`
      );
    }
  }

  // ---- Check 3: GET participation as teacher → 403 -------------------------
  {
    const teacherCookie = await login('t14_teacher', 'TeachPass1!');
    if (!teacherCookie) {
      fail('Teacher login → 200 + session cookie', 'Could not log in as t14_teacher');
    } else {
      const r = await request({
        method: 'GET',
        path: `/api/users/${teacherUser.id}/participation`,
        cookie: teacherCookie,
      });

      if (r.status === 403) {
        pass(`GET /api/users/${teacherUser.id}/participation as teacher → 403 (no view_participation)`);
      } else {
        fail(
          `GET /api/users/${teacherUser.id}/participation as teacher → 403`,
          `status=${r.status}, body=${JSON.stringify(r.body)}`
        );
      }
    }
  }

  // ---- Check 4: audit_logs has VIEW_PARTICIPATION entry for adminUser.id ---
  {
    const auditRow = db.prepare(
      `SELECT id FROM audit_logs WHERE action_type='VIEW_PARTICIPATION' AND actor_id=? AND target_id=? ORDER BY id DESC LIMIT 1`
    ).get(adminUser.id, teacherUser.id);

    if (auditRow) {
      pass('audit_logs contains VIEW_PARTICIPATION entry with actor_id = adminUser.id');
    } else {
      fail(
        'audit_logs contains VIEW_PARTICIPATION entry with actor_id = adminUser.id',
        `No matching audit_log row found (actor_id=${adminUser.id}, target_id=${teacherUser.id})`
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  server.close(() => process.exit(failed > 0 ? 1 : 0));
}

// ---------------------------------------------------------------------------
// 5. Start server then run tests
// ---------------------------------------------------------------------------
server.listen(TEST_PORT, '127.0.0.1', () => {
  console.log(`Test server started on port ${TEST_PORT}`);
  runTests().catch(err => {
    console.error('Unexpected error:', err);
    server.close(() => process.exit(1));
  });
});
