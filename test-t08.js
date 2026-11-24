'use strict';

/**
 * test-t08.js — Integration test for T-08 RBAC Middleware and Permission Helpers
 *
 * Run: node test-t08.js
 * Exit code 0 = all PASS, exit code 1 = at least one FAIL.
 */

const http = require('http');

// ---------------------------------------------------------------------------
// 1. Insert two test users BEFORE requiring app
// ---------------------------------------------------------------------------
const db = require('./src/repositories/db');
const bcrypt = require('bcryptjs');

const TEACHER_USER  = 't08_teacher';
const TEACHER_PASS  = 'TeachPass1!';
const ADMIN_USER    = 't08_admin';
const ADMIN_PASS    = 'AdminPass1!';

const teacherRole = db.prepare("SELECT id FROM roles WHERE name = 'teacher'").get();
if (!teacherRole) {
  console.error('FATAL: teacher role not found in DB. Run the seed first.');
  process.exit(1);
}

const adminRole = db.prepare("SELECT id FROM roles WHERE name = 'sysadmin'").get();
if (!adminRole) {
  console.error('FATAL: sysadmin role not found in DB. Run the seed first.');
  process.exit(1);
}

const teacherHash = bcrypt.hashSync(TEACHER_PASS, 12);
const adminHash   = bcrypt.hashSync(ADMIN_PASS, 12);

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
`).run(TEACHER_USER, 't08teacher@test.local', teacherHash, 'T08 Teacher User', teacherRole.id);

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
`).run(ADMIN_USER, 't08admin@test.local', adminHash, 'T08 Admin User', adminRole.id);

// ---------------------------------------------------------------------------
// 2. Add test-only route BEFORE starting the server
// ---------------------------------------------------------------------------
const authMiddleware = require('./src/middleware/auth');
const { requirePermission } = require('./src/middleware/rbac');
const app = require('./src/app');

app.get('/api/test/admin-only', authMiddleware, requirePermission('manage_accounts'), (req, res) => {
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// 3. Start server on port 3096
// ---------------------------------------------------------------------------
const TEST_PORT = 3096;
const server = http.createServer(app);

// ---------------------------------------------------------------------------
// 4. Test helpers
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
// 5. Run tests
// ---------------------------------------------------------------------------
async function runTests() {
  console.log('\n=== T-08 RBAC Middleware and Permission Helpers Tests ===\n');

  // ---- Teacher login -------------------------------------------------------
  let teacherCookie = await login(TEACHER_USER, TEACHER_PASS);
  if (!teacherCookie) {
    fail('Teacher login', 'Could not log in as teacher — cannot continue');
    console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
    server.close(() => process.exit(1));
    return;
  }
  pass('Teacher login — 200 + session cookie');

  // Refresh CSRF bound to the authenticated session
  const csrf2 = await fetchCsrf(teacherCookie);
  teacherCookie = mergeCookies(teacherCookie, csrf2.csrfCookie);

  // ---- Check 1: teacher → GET /api/test/admin-only → 403 ------------------
  let r = await request({
    method: 'GET',
    path: '/api/test/admin-only',
    cookie: teacherCookie,
  });

  if (r.status === 403) {
    pass('GET /api/test/admin-only as teacher → 403 Forbidden');
  } else {
    fail('GET /api/test/admin-only as teacher → 403 Forbidden', `got ${r.status}: ${JSON.stringify(r.body)}`);
  }

  // ---- Check 2: GET /api/auth/me as teacher --------------------------------
  r = await request({
    method: 'GET',
    path: '/api/auth/me',
    cookie: teacherCookie,
  });

  if (r.status !== 200) {
    fail('GET /api/auth/me as teacher → 200', `got ${r.status}: ${JSON.stringify(r.body)}`);
  } else {
    pass('GET /api/auth/me as teacher → 200');

    const perms = r.body && Array.isArray(r.body.permissions) ? r.body.permissions : [];

    if (!perms.includes('manage_accounts')) {
      pass('GET /api/auth/me as teacher — permissions does NOT include manage_accounts');
    } else {
      fail('GET /api/auth/me as teacher — permissions does NOT include manage_accounts',
        `permissions = ${JSON.stringify(perms)}`);
    }

    if (perms.includes('submit_incident')) {
      pass('GET /api/auth/me as teacher — permissions DOES include submit_incident');
    } else {
      fail('GET /api/auth/me as teacher — permissions DOES include submit_incident',
        `permissions = ${JSON.stringify(perms)}`);
    }
  }

  // ---- Sysadmin login ------------------------------------------------------
  let adminCookie = await login(ADMIN_USER, ADMIN_PASS);
  if (!adminCookie) {
    fail('Sysadmin login', 'Could not log in as sysadmin — cannot continue');
    console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
    server.close(() => process.exit(1));
    return;
  }
  pass('Sysadmin login — 200 + session cookie');

  const csrf3 = await fetchCsrf(adminCookie);
  adminCookie = mergeCookies(adminCookie, csrf3.csrfCookie);

  // ---- Check 3: sysadmin → GET /api/test/admin-only → 200 -----------------
  r = await request({
    method: 'GET',
    path: '/api/test/admin-only',
    cookie: adminCookie,
  });

  if (r.status === 200 && r.body && r.body.ok === true) {
    pass('GET /api/test/admin-only as sysadmin → 200');
  } else {
    fail('GET /api/test/admin-only as sysadmin → 200', `got ${r.status}: ${JSON.stringify(r.body)}`);
  }

  // ---- Check 4: GET /api/auth/me as sysadmin ------------------------------
  r = await request({
    method: 'GET',
    path: '/api/auth/me',
    cookie: adminCookie,
  });

  if (r.status !== 200) {
    fail('GET /api/auth/me as sysadmin → 200', `got ${r.status}: ${JSON.stringify(r.body)}`);
  } else {
    pass('GET /api/auth/me as sysadmin → 200');

    const perms = r.body && Array.isArray(r.body.permissions) ? r.body.permissions : [];

    if (perms.includes('manage_accounts')) {
      pass('GET /api/auth/me as sysadmin — permissions DOES include manage_accounts');
    } else {
      fail('GET /api/auth/me as sysadmin — permissions DOES include manage_accounts',
        `permissions = ${JSON.stringify(perms)}`);
    }
  }

  // ---- Summary -------------------------------------------------------------
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  server.close(() => process.exit(failed > 0 ? 1 : 0));
}

// ---------------------------------------------------------------------------
// 6. Start server then run tests
// ---------------------------------------------------------------------------
server.listen(TEST_PORT, '127.0.0.1', () => {
  console.log(`Test server started on port ${TEST_PORT}`);
  runTests().catch(err => {
    console.error('Unexpected error:', err);
    server.close(() => process.exit(1));
  });
});
