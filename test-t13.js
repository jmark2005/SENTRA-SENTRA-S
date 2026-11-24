'use strict';

/**
 * test-t13.js — Integration test for T-13 System Settings API
 *
 * Run: node test-t13.js
 * Exit code 0 = all PASS, exit code 1 = at least one FAIL.
 */

const http = require('http');

// ---------------------------------------------------------------------------
// 1. Insert test users BEFORE requiring app
// ---------------------------------------------------------------------------
const db     = require('./src/repositories/db');
const bcrypt = require('bcryptjs');

const ADMIN_USER   = 't13_admin';
const ADMIN_PASS   = 'AdminPass1!';
const TEACHER_USER = 't13_teacher';
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
`).run(ADMIN_USER, 't13admin@test.local', adminHash, 'T13 Admin User', adminRole.id);

// Upsert teacher test user
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
`).run(TEACHER_USER, 't13teacher@test.local', teacherHash, 'T13 Teacher User', teacherRole.id);

// ---------------------------------------------------------------------------
// 2. Start server on port 3090
// ---------------------------------------------------------------------------
const app      = require('./src/app');
const TEST_PORT = 3090;
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
  console.log('\n=== T-13 System Settings API Tests ===\n');

  // ---- Check 1: Login as sysadmin ------------------------------------------
  let adminCookie = await login(ADMIN_USER, ADMIN_PASS);
  if (!adminCookie) {
    fail('SysAdmin login → 200 + session cookie', 'Could not log in as sysadmin');
    console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
    server.close(() => process.exit(1));
    return;
  }
  pass('SysAdmin login → 200 + session cookie');

  // ---- Check 2: GET /api/settings → 200, has data.current_school_year ------
  {
    const r = await request({
      method: 'GET',
      path: '/api/settings',
      cookie: adminCookie,
    });

    const hasKey = r.body && r.body.data && 'current_school_year' in r.body.data;
    if (r.status === 200 && hasKey) {
      pass('GET /api/settings → 200, response has data.current_school_year');
    } else {
      fail('GET /api/settings → 200, response has data.current_school_year',
        `status=${r.status}, hasKey=${hasKey}, body=${JSON.stringify(r.body)}`);
    }
  }

  // ---- Check 3: PATCH current_school_year → 200 ----------------------------
  {
    const csrf = await fetchCsrf(adminCookie);
    adminCookie = mergeCookies(adminCookie, csrf.csrfCookie);

    const r = await request({
      method: 'PATCH',
      path: '/api/settings',
      body: { current_school_year: '2027\u20132028' },
      cookie: adminCookie,
      csrfToken: csrf.csrfToken,
    });

    if (r.status === 200) {
      pass('PATCH /api/settings {current_school_year: "2027–2028"} → 200');
    } else {
      fail('PATCH /api/settings {current_school_year: "2027–2028"} → 200',
        `status=${r.status}, body=${JSON.stringify(r.body)}`);
    }
  }

  // ---- Check 4: GET /api/settings → data.current_school_year === '2027–2028'
  {
    const r = await request({
      method: 'GET',
      path: '/api/settings',
      cookie: adminCookie,
    });

    const val = r.body && r.body.data && r.body.data.current_school_year;
    if (r.status === 200 && val === '2027\u20132028') {
      pass('GET /api/settings → data.current_school_year === "2027–2028"');
    } else {
      fail('GET /api/settings → data.current_school_year === "2027–2028"',
        `status=${r.status}, value=${val}`);
    }
  }

  // ---- Check 5: PATCH bad current_school_year → 422 ------------------------
  {
    const csrf = await fetchCsrf(adminCookie);
    adminCookie = mergeCookies(adminCookie, csrf.csrfCookie);

    const r = await request({
      method: 'PATCH',
      path: '/api/settings',
      body: { current_school_year: 'bad-year' },
      cookie: adminCookie,
      csrfToken: csrf.csrfToken,
    });

    if (r.status === 422) {
      pass('PATCH /api/settings {current_school_year: "bad-year"} → 422');
    } else {
      fail('PATCH /api/settings {current_school_year: "bad-year"} → 422',
        `status=${r.status}, body=${JSON.stringify(r.body)}`);
    }
  }

  // ---- Check 6: PATCH session_idle_minutes out of range → 422 --------------
  {
    const csrf = await fetchCsrf(adminCookie);
    adminCookie = mergeCookies(adminCookie, csrf.csrfCookie);

    const r = await request({
      method: 'PATCH',
      path: '/api/settings',
      body: { session_idle_minutes: '999' },
      cookie: adminCookie,
      csrfToken: csrf.csrfToken,
    });

    if (r.status === 422) {
      pass('PATCH /api/settings {session_idle_minutes: "999"} → 422 (out of range)');
    } else {
      fail('PATCH /api/settings {session_idle_minutes: "999"} → 422 (out of range)',
        `status=${r.status}, body=${JSON.stringify(r.body)}`);
    }
  }

  // ---- Check 7: PATCH invalid school_timezone → 422 ------------------------
  {
    const csrf = await fetchCsrf(adminCookie);
    adminCookie = mergeCookies(adminCookie, csrf.csrfCookie);

    const r = await request({
      method: 'PATCH',
      path: '/api/settings',
      body: { school_timezone: 'Not/ATimezone' },
      cookie: adminCookie,
      csrfToken: csrf.csrfToken,
    });

    if (r.status === 422) {
      pass('PATCH /api/settings {school_timezone: "Not/ATimezone"} → 422');
    } else {
      fail('PATCH /api/settings {school_timezone: "Not/ATimezone"} → 422',
        `status=${r.status}, body=${JSON.stringify(r.body)}`);
    }
  }

  // ---- Check 8: PATCH invalid emergency_alert_recipient_roles → 422 --------
  {
    const csrf = await fetchCsrf(adminCookie);
    adminCookie = mergeCookies(adminCookie, csrf.csrfCookie);

    const r = await request({
      method: 'PATCH',
      path: '/api/settings',
      body: { emergency_alert_recipient_roles: 'teacher,fakemole' },
      cookie: adminCookie,
      csrfToken: csrf.csrfToken,
    });

    if (r.status === 422) {
      pass('PATCH /api/settings {emergency_alert_recipient_roles: "teacher,fakemole"} → 422');
    } else {
      fail('PATCH /api/settings {emergency_alert_recipient_roles: "teacher,fakemole"} → 422',
        `status=${r.status}, body=${JSON.stringify(r.body)}`);
    }
  }

  // ---- Check 9: Teacher GET /api/settings → 403 ----------------------------
  {
    const teacherCookie = await login(TEACHER_USER, TEACHER_PASS);
    if (!teacherCookie) {
      fail('Teacher login → 200 + session cookie', 'Could not log in as teacher');
    } else {
      const r = await request({
        method: 'GET',
        path: '/api/settings',
        cookie: teacherCookie,
      });

      if (r.status === 403) {
        pass('Teacher GET /api/settings → 403 (no manage_settings)');
      } else {
        fail('Teacher GET /api/settings → 403 (no manage_settings)',
          `status=${r.status}, body=${JSON.stringify(r.body)}`);
      }
    }
  }

  // ---- Check 10: Restore current_school_year → 200 -------------------------
  {
    const csrf = await fetchCsrf(adminCookie);
    adminCookie = mergeCookies(adminCookie, csrf.csrfCookie);

    const r = await request({
      method: 'PATCH',
      path: '/api/settings',
      body: { current_school_year: '2026\u20132027' },
      cookie: adminCookie,
      csrfToken: csrf.csrfToken,
    });

    if (r.status === 200) {
      pass('Restore: PATCH /api/settings {current_school_year: "2026–2027"} as sysadmin → 200');
    } else {
      fail('Restore: PATCH /api/settings {current_school_year: "2026–2027"} as sysadmin → 200',
        `status=${r.status}, body=${JSON.stringify(r.body)}`);
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
