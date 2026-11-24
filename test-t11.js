'use strict';

/**
 * test-t11.js — Integration test for T-11 SysAdmin-Initiated Password Reset
 *
 * Run: node test-t11.js
 * Exit code 0 = all PASS, exit code 1 = at least one FAIL.
 */

const http = require('http');

// ---------------------------------------------------------------------------
// 1. Insert test users BEFORE requiring app
// ---------------------------------------------------------------------------
const db     = require('./src/repositories/db');
const bcrypt = require('bcryptjs');

const ADMIN_USER = 't11_admin';
const ADMIN_PASS = 'AdminPass1!';
const TEACHER_USER = 't11_teacher';
const TEACHER_PASS = 'TeachPass1!';

const adminRole = db.prepare("SELECT id FROM roles WHERE name = 'sysadmin'").get();
if (!adminRole) {
  console.error('FATAL: sysadmin role not found in DB. Run the seed first.');
  process.exit(1);
}

const teacherRole = db.prepare("SELECT id FROM roles WHERE name = 'teacher'").get();
if (!teacherRole) {
  console.error('FATAL: teacher role not found in DB. Run the seed first.');
  process.exit(1);
}

const adminHash   = bcrypt.hashSync(ADMIN_PASS, 12);
const teacherHash = bcrypt.hashSync(TEACHER_PASS, 12);

// Upsert sysadmin test user
db.prepare(`
  INSERT INTO users (username, email, password_hash, full_name, role_id, status, password_reset_required)
  VALUES (?, ?, ?, ?, ?, 'Active', 0)
  ON CONFLICT(username) DO UPDATE SET
    email = excluded.email,
    password_hash = excluded.password_hash,
    full_name = excluded.full_name,
    role_id = excluded.role_id,
    status = excluded.status,
    password_reset_required = excluded.password_reset_required
`).run(ADMIN_USER, 't11admin@test.local', adminHash, 'T11 Admin User', adminRole.id);

// Upsert teacher test user (no forced reset, known password)
db.prepare(`
  INSERT INTO users (username, email, password_hash, full_name, role_id, status, password_reset_required)
  VALUES (?, ?, ?, ?, ?, 'Active', 0)
  ON CONFLICT(username) DO UPDATE SET
    email = excluded.email,
    password_hash = excluded.password_hash,
    full_name = excluded.full_name,
    role_id = excluded.role_id,
    status = excluded.status,
    password_reset_required = excluded.password_reset_required
`).run(TEACHER_USER, 't11teacher@test.local', teacherHash, 'T11 Teacher User', teacherRole.id);

const teacherRow = db.prepare('SELECT id FROM users WHERE username = ?').get(TEACHER_USER);
const teacherId  = teacherRow.id;

// ---------------------------------------------------------------------------
// 2. Start server on port 3092
// ---------------------------------------------------------------------------
const app      = require('./src/app');
const TEST_PORT = 3092;
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
  console.log('\n=== T-11 SysAdmin-Initiated Password Reset Tests ===\n');

  let tempPassword = null;
  let teacherNewCookie = null;

  // ---- Check 1: Login as teacher, capture session cookie -------------------
  let teacherOldCookie = await login(TEACHER_USER, TEACHER_PASS);
  if (!teacherOldCookie) {
    fail('Teacher login → 200 + session cookie', 'Could not log in as teacher');
    console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
    server.close(() => process.exit(1));
    return;
  }
  pass('Teacher login → 200 + session cookie');

  // ---- Check 2: Login as sysadmin ------------------------------------------
  let adminCookie = await login(ADMIN_USER, ADMIN_PASS);
  if (!adminCookie) {
    fail('SysAdmin login → 200 + session cookie', 'Could not log in as sysadmin');
    console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
    server.close(() => process.exit(1));
    return;
  }
  pass('SysAdmin login → 200 + session cookie');

  // Refresh CSRF bound to the authenticated admin session
  {
    const csrf2 = await fetchCsrf(adminCookie);
    adminCookie = mergeCookies(adminCookie, csrf2.csrfCookie);

    // ---- Check 3: POST /api/users/:id/reset-password as sysadmin → 200 ------
    const r = await request({
      method: 'POST',
      path: `/api/users/${teacherId}/reset-password`,
      body: {},
      cookie: adminCookie,
      csrfToken: csrf2.csrfToken,
    });

    if (
      r.status === 200 &&
      r.body &&
      typeof r.body.temp_password === 'string' &&
      r.body.temp_password.length >= 12
    ) {
      tempPassword = r.body.temp_password;
      pass(`POST /api/users/${teacherId}/reset-password as sysadmin → 200, temp_password (${tempPassword.length} chars)`);
    } else {
      fail(`POST /api/users/${teacherId}/reset-password as sysadmin → 200 with temp_password`,
        `status=${r.status}, body=${JSON.stringify(r.body)}`);
    }
  }

  // ---- Check 4: DB — password_reset_required = 1 for teacher ---------------
  {
    const row = db.prepare('SELECT password_reset_required FROM users WHERE id = ?').get(teacherId);
    if (row && row.password_reset_required === 1) {
      pass('DB: password_reset_required = 1 for teacher after reset');
    } else {
      fail('DB: password_reset_required = 1 for teacher after reset',
        `password_reset_required=${row ? row.password_reset_required : 'row not found'}`);
    }
  }

  // ---- Check 5: Teacher's old session is gone from user_sessions -----------
  {
    const remaining = db
      .prepare('SELECT sid FROM user_sessions WHERE user_id = ?')
      .all(teacherId);
    if (remaining.length === 0) {
      pass("Teacher's old session removed from user_sessions after reset");
    } else {
      fail("Teacher's old session removed from user_sessions after reset",
        `${remaining.length} session(s) still present`);
    }
  }

  // ---- Check 6: Login as teacher with OLD password → 401 -------------------
  {
    const { csrfToken, csrfCookie } = await fetchCsrf();
    const r = await request({
      method: 'POST',
      path: '/api/auth/login',
      body: { username: TEACHER_USER, password: TEACHER_PASS },
      cookie: csrfCookie,
      csrfToken,
    });
    if (r.status === 401) {
      pass('Login as teacher with OLD password after reset → 401');
    } else {
      fail('Login as teacher with OLD password after reset → 401',
        `status=${r.status}, body=${JSON.stringify(r.body)}`);
    }
  }

  // ---- Check 7: Login as teacher with NEW temp_password → 200 --------------
  if (!tempPassword) {
    fail('Login as teacher with temp_password → 200', 'tempPassword not captured — reset may have failed');
  } else {
    teacherNewCookie = await login(TEACHER_USER, tempPassword);
    if (teacherNewCookie) {
      pass('Login as teacher with new temp_password → 200');
    } else {
      fail('Login as teacher with new temp_password → 200',
        'Login returned non-200');
    }
  }

  // ---- Check 8: GET /api/auth/me with teacher's new session → 403 "Password change required"
  if (!teacherNewCookie) {
    fail('GET /api/auth/me with new session → 403 Password change required',
      'teacherNewCookie not set — login with temp_password may have failed');
  } else {
    const r = await request({
      method: 'GET',
      path: '/api/auth/me',
      cookie: teacherNewCookie,
    });
    if (
      r.status === 403 &&
      r.body &&
      r.body.error &&
      r.body.error.toLowerCase().includes('password change required')
    ) {
      pass('GET /api/auth/me with new session → 403 "Password change required"');
    } else {
      fail('GET /api/auth/me with new session → 403 "Password change required"',
        `status=${r.status}, body=${JSON.stringify(r.body)}`);
    }
  }

  // ---- Check 9: POST /api/users/:id/reset-password as teacher → 403 --------
  // Teacher has password_reset_required=1, so authMiddleware will block before RBAC.
  // We need a teacher without forced reset for a clean RBAC-only 403 check.
  {
    // Create a fresh teacher without forced reset for the permission check
    const freshHash = bcrypt.hashSync('FreshPass1!', 12);
    db.prepare(`
      INSERT INTO users (username, email, password_hash, full_name, role_id, status, password_reset_required)
      VALUES (?, ?, ?, ?, ?, 'Active', 0)
      ON CONFLICT(username) DO UPDATE SET
        email = excluded.email,
        password_hash = excluded.password_hash,
        full_name = excluded.full_name,
        role_id = excluded.role_id,
        status = excluded.status,
        password_reset_required = excluded.password_reset_required
    `).run('t11_teacher2', 't11teacher2@test.local', freshHash, 'T11 Teacher 2', teacherRole.id);

    const freshCookie = await login('t11_teacher2', 'FreshPass1!');
    if (!freshCookie) {
      fail(`POST /api/users/${teacherId}/reset-password as teacher → 403`, 'Could not log in as fresh teacher');
    } else {
      const { csrfToken, csrfCookie } = await fetchCsrf(freshCookie);
      const mergedFreshCookie = mergeCookies(freshCookie, csrfCookie);

      const r = await request({
        method: 'POST',
        path: `/api/users/${teacherId}/reset-password`,
        body: {},
        cookie: mergedFreshCookie,
        csrfToken,
      });
      if (r.status === 403) {
        pass(`POST /api/users/${teacherId}/reset-password as teacher → 403 (no manage_accounts permission)`);
      } else {
        fail(`POST /api/users/${teacherId}/reset-password as teacher → 403`,
          `status=${r.status}, body=${JSON.stringify(r.body)}`);
      }
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
