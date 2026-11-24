'use strict';

/**
 * test-t09.js — Integration test for T-09 Audit Logging Service
 *
 * Run: node test-t09.js
 * Exit code 0 = all PASS, exit code 1 = at least one FAIL.
 */

const http = require('http');

// ---------------------------------------------------------------------------
// 1. Insert test users BEFORE requiring app
// ---------------------------------------------------------------------------
const db = require('./src/repositories/db');
const bcrypt = require('bcryptjs');

const ADMIN_USER   = 't09_admin';
const ADMIN_PASS   = 'AdminPass1!';
const TEACHER_USER = 't09_teacher';
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
`).run(ADMIN_USER, 't09admin@test.local', adminHash, 'T09 Admin User', adminRole.id);

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
`).run(TEACHER_USER, 't09teacher@test.local', teacherHash, 'T09 Teacher User', teacherRole.id);

// ---------------------------------------------------------------------------
// 2. Start server on port 3095
// ---------------------------------------------------------------------------
const app    = require('./src/app');
const TEST_PORT = 3095;
const server = http.createServer(app);

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
  console.log('\n=== T-09 Audit Logging Service Tests ===\n');

  // ---- Check 1: Sysadmin login (triggers a LOGIN audit entry) --------------
  let adminCookie = await login(ADMIN_USER, ADMIN_PASS);
  if (!adminCookie) {
    fail('Sysadmin login', 'Could not log in as sysadmin — cannot continue');
    console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
    server.close(() => process.exit(1));
    return;
  }
  pass('Sysadmin login — 200 + session cookie');

  // Refresh CSRF bound to the authenticated session
  const csrf2 = await fetchCsrf(adminCookie);
  adminCookie = mergeCookies(adminCookie, csrf2.csrfCookie);

  // ---- Check 2: GET /api/audit-logs as sysadmin → 200 with data ------------
  let r = await request({
    method: 'GET',
    path: '/api/audit-logs',
    cookie: adminCookie,
  });

  if (r.status === 200 && r.body && Array.isArray(r.body.data) && r.body.data.length > 0) {
    pass('GET /api/audit-logs as sysadmin → 200, data array non-empty');
  } else {
    fail('GET /api/audit-logs as sysadmin → 200, data array non-empty',
      `status=${r.status}, data length=${r.body && r.body.data ? r.body.data.length : 'N/A'}`);
  }

  // ---- Check 2b: Response contains a LOGIN entry ---------------------------
  if (r.status === 200 && r.body && Array.isArray(r.body.data)) {
    const hasLogin = r.body.data.some(entry => entry.action_type === 'LOGIN');
    if (hasLogin) {
      pass('GET /api/audit-logs as sysadmin → response contains a LOGIN entry');
    } else {
      fail('GET /api/audit-logs as sysadmin → response contains a LOGIN entry',
        'No LOGIN entry found in returned data');
    }
  }

  // ---- Check 3: Append-only trigger — UPDATE must throw --------------------
  let appendOnlyThrew = false;
  try {
    // Get any existing audit log id
    const firstRow = db.prepare('SELECT id FROM audit_logs LIMIT 1').get();
    if (firstRow) {
      db.prepare('UPDATE audit_logs SET actor_name = ? WHERE id = ?').run('hacked', firstRow.id);
    } else {
      // Insert a row first to test against
      db.prepare(`
        INSERT INTO audit_logs (actor_id, actor_name, actor_role, action_type)
        VALUES (NULL, 'test', 'test', 'TEST')
      `).run();
      const row = db.prepare('SELECT id FROM audit_logs ORDER BY id DESC LIMIT 1').get();
      db.prepare('UPDATE audit_logs SET actor_name = ? WHERE id = ?').run('hacked', row.id);
    }
  } catch (err) {
    if (err.message && err.message.includes('append-only')) {
      appendOnlyThrew = true;
    }
  }

  if (appendOnlyThrew) {
    pass('UPDATE audit_logs throws append-only error (trigger enforced)');
  } else {
    fail('UPDATE audit_logs throws append-only error (trigger enforced)',
      'Expected RAISE(ABORT) but no error was thrown');
  }

  // ---- Check 4: Teacher login → GET /api/audit-logs → 403 -----------------
  const teacherCookie = await login(TEACHER_USER, TEACHER_PASS);
  if (!teacherCookie) {
    fail('Teacher login', 'Could not log in as teacher');
  } else {
    pass('Teacher login — 200 + session cookie');

    r = await request({
      method: 'GET',
      path: '/api/audit-logs',
      cookie: teacherCookie,
    });

    if (r.status === 403) {
      pass('GET /api/audit-logs as teacher → 403 Forbidden');
    } else {
      fail('GET /api/audit-logs as teacher → 403 Forbidden',
        `got ${r.status}: ${JSON.stringify(r.body)}`);
    }
  }

  // ---- Check 5: Filter by action_type=LOGIN --------------------------------
  r = await request({
    method: 'GET',
    path: '/api/audit-logs?action_type=LOGIN',
    cookie: adminCookie,
  });

  if (r.status === 200 && r.body && Array.isArray(r.body.data)) {
    const allLogin = r.body.data.every(entry => entry.action_type === 'LOGIN');
    if (allLogin) {
      pass('GET /api/audit-logs?action_type=LOGIN — all rows have action_type=LOGIN');
    } else {
      fail('GET /api/audit-logs?action_type=LOGIN — all rows have action_type=LOGIN',
        'Some rows had a different action_type');
    }
  } else {
    fail('GET /api/audit-logs?action_type=LOGIN — all rows have action_type=LOGIN',
      `status=${r.status}`);
  }

  // ---- Check 6: Pagination — limit=2 ---------------------------------------
  r = await request({
    method: 'GET',
    path: '/api/audit-logs?page=1&limit=2',
    cookie: adminCookie,
  });

  if (
    r.status === 200 &&
    r.body &&
    Array.isArray(r.body.data) &&
    r.body.data.length <= 2 &&
    r.body.pagination &&
    r.body.pagination.limit === 2
  ) {
    pass('GET /api/audit-logs?page=1&limit=2 → data.length <= 2, pagination.limit === 2');
  } else {
    fail('GET /api/audit-logs?page=1&limit=2 → data.length <= 2, pagination.limit === 2',
      `status=${r.status}, data.length=${r.body && r.body.data ? r.body.data.length : 'N/A'}, pagination=${JSON.stringify(r.body && r.body.pagination)}`);
  }

  // ---- Summary -------------------------------------------------------------
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
