'use strict';

/**
 * test-t10.js — Integration test for T-10 Signup and Account Approval
 *
 * Run: node test-t10.js
 * Exit code 0 = all PASS, exit code 1 = at least one FAIL.
 */

const http = require('http');

// ---------------------------------------------------------------------------
// 1. Insert test users BEFORE requiring app
// ---------------------------------------------------------------------------
const db = require('./src/repositories/db');
const bcrypt = require('bcryptjs');

const ADMIN_USER = 't10_admin';
const ADMIN_PASS = 'AdminPass1!';

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

const adminHash = bcrypt.hashSync(ADMIN_PASS, 12);

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
`).run(ADMIN_USER, 't10admin@test.local', adminHash, 'T10 Admin User', adminRole.id);

// Clean up any leftover signup users from previous runs
db.prepare('PRAGMA foreign_keys = OFF').run();
db.prepare("DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE username IN ('t10_newteacher', 't10_dupuser'))").run();
db.prepare("DELETE FROM user_sessions WHERE user_id IN (SELECT id FROM users WHERE username IN ('t10_newteacher', 't10_dupuser'))").run();
db.prepare("DELETE FROM users WHERE username IN ('t10_newteacher', 't10_dupuser')").run();
db.prepare('PRAGMA foreign_keys = ON').run();

// ---------------------------------------------------------------------------
// 2. Start server on port 3093
// ---------------------------------------------------------------------------
const app = require('./src/app');
const TEST_PORT = 3093;
const server = http.createServer(app);

// ---------------------------------------------------------------------------
// 3. Test helpers
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
let newUserId = null;
let newUserSessionCookie = null;

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
  const csrfToken = r.body && r.body.csrfToken;
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
  console.log('\n=== T-10 Signup and Account Approval Tests ===\n');

  // ---- Check 3: POST /api/users/signup with valid body → 201 ---------------
  {
    const { csrfToken, csrfCookie } = await fetchCsrf();
    const r = await request({
      method: 'POST',
      path: '/api/users/signup',
      body: {
        full_name: 'T10 New Teacher',
        id_number: '2024-T10-001',
        email: 't10newteacher@test.local',
        username: 't10_newteacher',
        password: 'TeachPass1!',
        confirm_password: 'TeachPass1!',
        requested_role: 'teacher',
      },
      cookie: csrfCookie,
      csrfToken,
    });

    if (r.status === 201 && r.body && r.body.message) {
      pass('POST /api/users/signup (valid, teacher) → 201 with success message');
    } else {
      fail('POST /api/users/signup (valid, teacher) → 201 with success message',
        `status=${r.status}, body=${JSON.stringify(r.body)}`);
    }

    // Look up the new user id for later checks
    const newUser = db.prepare("SELECT id FROM users WHERE username = 't10_newteacher'").get();
    if (newUser) newUserId = newUser.id;
  }

  // ---- Check 3b: requested_role is stored; role_id stays placeholder -------
  {
    if (!newUserId) {
      fail('requested_role stored, role_id is placeholder', 'newUserId not set');
    } else {
      const row = db.prepare(
        "SELECT requested_role, role_id FROM users WHERE id = ?"
      ).get(newUserId);
      const teacherRoleId = db.prepare("SELECT id FROM roles WHERE name = 'teacher'").get().id;

      if (row && row.requested_role === 'teacher' && row.role_id === teacherRoleId) {
        pass('requested_role stored as "teacher"; role_id is placeholder teacher role');
      } else {
        fail('requested_role stored as "teacher"; role_id is placeholder teacher role',
          `requested_role=${row && row.requested_role}, role_id=${row && row.role_id}, teacher_id=${teacherRoleId}`);
      }
    }
  }

  // ---- Check 3c: Signup with role_id or sysadmin role in body is rejected --
  {
    const { csrfToken, csrfCookie } = await fetchCsrf();
    // Attempt to inject role_id directly (should fail — role is required via requested_role only)
    const r1 = await request({
      method: 'POST',
      path: '/api/users/signup',
      body: {
        full_name: 'Hacker',
        id_number: '2024-HACK-001',
        email: 't10hacker1@test.local',
        username: 't10_hacker1',
        password: 'HackPass1!',
        confirm_password: 'HackPass1!',
        role_id: 1,                   // attempt to inject role_id — must be ignored/rejected
        requested_role: 'teacher',    // valid requested_role present
      },
      cookie: csrfCookie,
      csrfToken,
    });
    // Server ignores role_id; the account is created with placeholder role, not id=1 if that differs
    if (r1.status === 201) {
      // Verify the role_id stored is still the placeholder (teacher), not whatever was injected
      const hackerRow = db.prepare("SELECT role_id FROM users WHERE username = 't10_hacker1'").get();
      const teacherRoleId = db.prepare("SELECT id FROM roles WHERE name = 'teacher'").get().id;
      // Clean up the hacker account
      db.prepare('PRAGMA foreign_keys = OFF').run();
      db.prepare("DELETE FROM users WHERE username = 't10_hacker1'").run();
      db.prepare('PRAGMA foreign_keys = ON').run();
      if (hackerRow && hackerRow.role_id === teacherRoleId) {
        pass('Signup with injected role_id: stored role_id is still placeholder, injection ignored');
      } else {
        fail('Signup with injected role_id: stored role_id is still placeholder, injection ignored',
          `stored role_id=${hackerRow && hackerRow.role_id}, expected=${teacherRoleId}`);
      }
    } else if (r1.status === 400 || r1.status === 422) {
      pass('Signup with injected role_id → rejected (400/422)');
    } else {
      fail('Signup with injected role_id: expected 201 (injection ignored) or 400/422',
        `status=${r1.status}, body=${JSON.stringify(r1.body)}`);
    }

    // Attempt to send requested_role = 'sysadmin' — must be rejected
    const { csrfToken: ct2, csrfCookie: cc2 } = await fetchCsrf();
    const r2 = await request({
      method: 'POST',
      path: '/api/users/signup',
      body: {
        full_name: 'Hacker2',
        id_number: '2024-HACK-002',
        email: 't10hacker2@test.local',
        username: 't10_hacker2',
        password: 'HackPass1!',
        confirm_password: 'HackPass1!',
        requested_role: 'sysadmin',   // not in allowlist
      },
      cookie: cc2,
      csrfToken: ct2,
    });
    if (r2.status === 400 && r2.body && r2.body.error && r2.body.error.includes('Invalid requested_role')) {
      pass('Signup with requested_role="sysadmin" → 400 Invalid requested_role');
    } else {
      fail('Signup with requested_role="sysadmin" → 400 Invalid requested_role',
        `status=${r2.status}, body=${JSON.stringify(r2.body)}`);
    }
  }

  // ---- Check 4: Login with pending account → 401 ---------------------------
  {
    const { csrfToken, csrfCookie } = await fetchCsrf();
    const r = await request({
      method: 'POST',
      path: '/api/auth/login',
      body: { username: 't10_newteacher', password: 'TeachPass1!' },
      cookie: csrfCookie,
      csrfToken,
    });

    if (r.status === 401 && r.body && r.body.error && r.body.error.toLowerCase().includes('pending')) {
      pass('Login with Pending account → 401 (pending message)');
    } else {
      fail('Login with Pending account → 401 (pending message)',
        `status=${r.status}, body=${JSON.stringify(r.body)}`);
    }
  }

  // ---- Check 5: SysAdmin login (full CSRF flow) ----------------------------
  let adminCookie = await login(ADMIN_USER, ADMIN_PASS);
  if (!adminCookie) {
    fail('SysAdmin login → 200 + session cookie', 'Could not log in — cannot continue');
    console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
    server.close(() => process.exit(1));
    return;
  }
  pass('SysAdmin login → 200 + session cookie');

  // Refresh CSRF bound to the authenticated session
  const csrf2 = await fetchCsrf(adminCookie);
  adminCookie = mergeCookies(adminCookie, csrf2.csrfCookie);

  // ---- Check 6: GET /api/users as sysadmin → 200, contains pending user ----
  {
    const r = await request({
      method: 'GET',
      path: '/api/users',
      cookie: adminCookie,
    });

    const hasPending = r.body && Array.isArray(r.body.data) &&
      r.body.data.some(u => u.username === 't10_newteacher');

    if (r.status === 200 && r.body && Array.isArray(r.body.data) && hasPending) {
      pass('GET /api/users as sysadmin → 200, data array contains new pending user');
    } else {
      fail('GET /api/users as sysadmin → 200, data array contains new pending user',
        `status=${r.status}, found=${hasPending}, data length=${r.body && r.body.data ? r.body.data.length : 'N/A'}`);
    }
  }

  // ---- Check 7: GET /api/users/:id → 200, correct data --------------------
  {
    if (!newUserId) {
      fail('GET /api/users/:id for new user → 200', 'newUserId not set — signup may have failed');
    } else {
      const r = await request({
        method: 'GET',
        path: `/api/users/${newUserId}`,
        cookie: adminCookie,
      });

      if (
        r.status === 200 &&
        r.body &&
        r.body.id === newUserId &&
        r.body.username === 't10_newteacher' &&
        r.body.status === 'Pending' &&
        r.body.requested_role === 'teacher'
      ) {
        pass(`GET /api/users/${newUserId} → 200, correct data, requested_role present`);
      } else {
        fail(`GET /api/users/${newUserId} → 200, correct data, requested_role present`,
          `status=${r.status}, body=${JSON.stringify(r.body)}`);
      }
    }
  }

  // ---- Check 8: PATCH /api/users/:id/status → Active (approve) + notification
  {
    if (!newUserId) {
      fail('PATCH /api/users/:id/status → Active → 200', 'newUserId not set');
    } else {
      const { csrfToken: ct, csrfCookie: cc } = await fetchCsrf(adminCookie);
      adminCookie = mergeCookies(adminCookie, cc);

      const r = await request({
        method: 'PATCH',
        path: `/api/users/${newUserId}/status`,
        body: { status: 'Active', role: 'teacher' },
        cookie: adminCookie,
        csrfToken: ct,
      });

      if (r.status === 200 && r.body && r.body.user && r.body.user.status === 'Active') {
        pass('PATCH /api/users/:id/status → Active → 200');
      } else {
        fail('PATCH /api/users/:id/status → Active → 200',
          `status=${r.status}, body=${JSON.stringify(r.body)}`);
      }

      // Verify notification was created for the new user
      const notif = db.prepare(
        "SELECT id FROM notifications WHERE user_id = ? AND type = 'Account Approval' AND title = 'Account approved'"
      ).get(newUserId);

      if (notif) {
        pass('Notification created for user after approval');
      } else {
        fail('Notification created for user after approval', 'No matching notification row found');
      }
    }
  }

  // ---- Check 9: Login with now-Active user → 200 ---------------------------
  {
    const cookie = await login('t10_newteacher', 'TeachPass1!');
    if (cookie) {
      newUserSessionCookie = cookie;
      pass('Login with now-Active user → 200');
    } else {
      fail('Login with now-Active user → 200', 'Login returned non-200');
    }
  }

  // ---- Check 10: Deactivate → 200; session gone from user_sessions ---------
  {
    if (!newUserId) {
      fail('PATCH /api/users/:id/status → Inactive → 200', 'newUserId not set');
    } else {
      const { csrfToken: ct, csrfCookie: cc } = await fetchCsrf(adminCookie);
      adminCookie = mergeCookies(adminCookie, cc);

      const r = await request({
        method: 'PATCH',
        path: `/api/users/${newUserId}/status`,
        body: { status: 'Inactive' },
        cookie: adminCookie,
        csrfToken: ct,
      });

      if (r.status === 200 && r.body && r.body.user && r.body.user.status === 'Inactive') {
        pass('PATCH /api/users/:id/status → Inactive → 200');
      } else {
        fail('PATCH /api/users/:id/status → Inactive → 200',
          `status=${r.status}, body=${JSON.stringify(r.body)}`);
      }

      // Verify session is gone
      const remaining = db
        .prepare('SELECT sid FROM user_sessions WHERE user_id = ?')
        .all(newUserId);

      if (remaining.length === 0) {
        pass('User sessions removed from user_sessions after deactivation');
      } else {
        fail('User sessions removed from user_sessions after deactivation',
          `${remaining.length} session(s) still present`);
      }
    }
  }

  // ---- Check 11: Login attempt after deactivation → 401 "deactivated" -----
  {
    const { csrfToken, csrfCookie } = await fetchCsrf();
    const r = await request({
      method: 'POST',
      path: '/api/auth/login',
      body: { username: 't10_newteacher', password: 'TeachPass1!' },
      cookie: csrfCookie,
      csrfToken,
    });

    if (r.status === 401 && r.body && r.body.error && r.body.error.toLowerCase().includes('deactivated')) {
      pass('Login after deactivation → 401 (deactivated message)');
    } else {
      fail('Login after deactivation → 401 (deactivated message)',
        `status=${r.status}, body=${JSON.stringify(r.body)}`);
    }
  }

  // ---- Check 12: Signup with duplicate username → 409 ----------------------
  {
    const { csrfToken, csrfCookie } = await fetchCsrf();
    const r = await request({
      method: 'POST',
      path: '/api/users/signup',
      body: {
        full_name: 'Dup User',
        id_number: '2024-DUP-001',
        email: 't10dup_unique@test.local',
        username: 't10_newteacher', // already exists
        password: 'DupPass1!',
        confirm_password: 'DupPass1!',
        requested_role: 'student',
      },
      cookie: csrfCookie,
      csrfToken,
    });

    if (r.status === 409 && r.body && r.body.error === 'Username already taken.') {
      pass('Signup with duplicate username → 409 "Username already taken."');
    } else {
      fail('Signup with duplicate username → 409 "Username already taken."',
        `status=${r.status}, body=${JSON.stringify(r.body)}`);
    }
  }

  // ---- Check 13: Signup with weak password → 422 ---------------------------
  {
    const { csrfToken, csrfCookie } = await fetchCsrf();
    const r = await request({
      method: 'POST',
      path: '/api/users/signup',
      body: {
        full_name: 'Weak Pass User',
        id_number: '2024-WEAK-001',
        email: 't10weak@test.local',
        username: 't10_weakpass',
        password: 'password', // no uppercase, no digit
        confirm_password: 'password',
        requested_role: 'student',
      },
      cookie: csrfCookie,
      csrfToken,
    });

    if (r.status === 422) {
      pass('Signup with weak password → 422');
    } else {
      fail('Signup with weak password → 422',
        `status=${r.status}, body=${JSON.stringify(r.body)}`);
    }
  }

  // ---- Check 14: GET /api/users as teacher → 403 ---------------------------
  {
    // Create and log in as a teacher
    const teacherHash = bcrypt.hashSync('TeachPass1!', 12);
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
    `).run('t10_teacher403', 't10teacher403@test.local', teacherHash, 'T10 Teacher 403', teacherRole.id);

    const teacherCookie = await login('t10_teacher403', 'TeachPass1!');
    if (!teacherCookie) {
      fail('GET /api/users as teacher → 403', 'Could not log in as teacher');
    } else {
      const r = await request({
        method: 'GET',
        path: '/api/users',
        cookie: teacherCookie,
      });

      if (r.status === 403) {
        pass('GET /api/users as teacher → 403 Forbidden');
      } else {
        fail('GET /api/users as teacher → 403 Forbidden',
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
