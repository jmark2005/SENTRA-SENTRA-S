'use strict';

/**
 * test-t07.js — Integration test for T-07 Force Password Change
 *
 * Run: node test-t07.js
 * Exit code 0 = all PASS, exit code 1 = at least one FAIL.
 */

const http = require('http');

// ---------------------------------------------------------------------------
// 1. Insert a test user with password_reset_required = 1 BEFORE requiring app
// ---------------------------------------------------------------------------
const db = require('./src/repositories/db');
const bcrypt = require('bcryptjs');

const TEST_USER = 't07_pwr_user';
const TEST_PASS = 'OldPass1!';
const NEW_PASS  = 'NewStr0ng!';

// Ensure the test user exists with password_reset_required = 1
const hash = bcrypt.hashSync(TEST_PASS, 12);
const role = db.prepare("SELECT id FROM roles WHERE name = 'sysadmin'").get();
if (!role) {
  console.error('FATAL: sysadmin role not found in DB. Run the seed first.');
  process.exit(1);
}

db.prepare(`
  INSERT OR REPLACE INTO users (username, email, password_hash, full_name, role_id, status, password_reset_required)
  VALUES (?, ?, ?, ?, ?, 'Active', 1)
`).run(TEST_USER, 't07pwr@test.local', hash, 'T07 PWR User', role.id);

// ---------------------------------------------------------------------------
// 2. Start the Express app on a test port
// ---------------------------------------------------------------------------
const app = require('./src/app');
const TEST_PORT = 3097;

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

/**
 * HTTP request helper.
 * Returns { status, headers, body (parsed JSON) }.
 */
function request({ method, path, body, cookie, csrfToken }) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = {
      'Content-Type': 'application/json',
    };
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);
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

/** Extract the name=value portion of the first Set-Cookie entry. */
function extractCookie(setCookieHeader) {
  if (!setCookieHeader) return null;
  const val = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  return val.split(';')[0];
}

/**
 * Obtain a fresh CSRF token + cookie pair.
 * Returns { csrfToken, csrfCookie }.
 */
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

/** Merge two cookie strings, deduplicating by name. */
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

// ---------------------------------------------------------------------------
// 4. Run tests
// ---------------------------------------------------------------------------
async function runTests() {
  console.log('\n=== T-07 Force Password Change Tests ===\n');

  // ---- Check 1 & 2: Login → 200, capture session cookie ------------------
  // Need CSRF for login POST
  let { csrfToken, csrfCookie } = await fetchCsrf();

  let r = await request({
    method: 'POST',
    path: '/api/auth/login',
    body: { username: TEST_USER, password: TEST_PASS },
    cookie: csrfCookie,
    csrfToken,
  });

  if (r.status === 200 && r.body && r.body.message === 'Login successful') {
    pass('POST /api/auth/login — valid credentials → 200');
  } else {
    fail('POST /api/auth/login — valid credentials → 200', `got ${r.status}: ${JSON.stringify(r.body)}`);
  }

  const sessionCookie = extractCookie(r.headers['set-cookie']);
  if (sessionCookie) {
    pass('POST /api/auth/login — set-cookie header present');
  } else {
    fail('POST /api/auth/login — set-cookie header present', 'no Set-Cookie header');
    // Cannot continue without a session cookie
    console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
    server.close(() => process.exit(1));
    return;
  }

  // Merge session + CSRF cookies for subsequent requests
  let cookie = mergeCookies(sessionCookie, csrfCookie);

  // Refresh CSRF token using the authenticated session
  const csrf2 = await fetchCsrf(cookie);
  csrfToken = csrf2.csrfToken;
  cookie = mergeCookies(cookie, csrf2.csrfCookie);

  // ---- Check 3: GET /api/auth/me → 403 (password change required) --------
  r = await request({
    method: 'GET',
    path: '/api/auth/me',
    cookie,
  });

  if (r.status === 403 && r.body && r.body.error === 'Password change required') {
    pass('GET /api/auth/me — password_reset_required=1 → 403 "Password change required"');
  } else {
    fail('GET /api/auth/me — password_reset_required=1 → 403 "Password change required"', `got ${r.status}: ${JSON.stringify(r.body)}`);
  }

  // ---- Check 4: POST /change-password with wrong current password → 401 --
  r = await request({
    method: 'POST',
    path: '/api/auth/change-password',
    body: { current_password: 'WrongPass1!', new_password: NEW_PASS },
    cookie,
    csrfToken,
  });

  if (r.status === 401) {
    pass('POST /api/auth/change-password — wrong current password → 401');
  } else {
    fail('POST /api/auth/change-password — wrong current password → 401', `got ${r.status}: ${JSON.stringify(r.body)}`);
  }

  // ---- Check 5: POST /change-password with weak new password → 422 -------
  r = await request({
    method: 'POST',
    path: '/api/auth/change-password',
    body: { current_password: TEST_PASS, new_password: 'weak' },
    cookie,
    csrfToken,
  });

  if (r.status === 422) {
    pass('POST /api/auth/change-password — weak new password → 422');
  } else {
    fail('POST /api/auth/change-password — weak new password → 422', `got ${r.status}: ${JSON.stringify(r.body)}`);
  }

  // ---- Check 6: POST /change-password with valid credentials → 200 -------
  r = await request({
    method: 'POST',
    path: '/api/auth/change-password',
    body: { current_password: TEST_PASS, new_password: NEW_PASS },
    cookie,
    csrfToken,
  });

  if (r.status === 200 && r.body && r.body.message === 'Password changed successfully.') {
    pass('POST /api/auth/change-password — valid current + strong new password → 200');
  } else {
    fail('POST /api/auth/change-password — valid current + strong new password → 200', `got ${r.status}: ${JSON.stringify(r.body)}`);
  }

  // ---- Check 7: GET /api/auth/me → 200 (no longer blocked) ---------------
  // The session is still valid after the password change
  r = await request({
    method: 'GET',
    path: '/api/auth/me',
    cookie,
  });

  if (r.status === 200) {
    pass('GET /api/auth/me after password change → 200 (no longer blocked)');
  } else {
    fail('GET /api/auth/me after password change → 200 (no longer blocked)', `got ${r.status}: ${JSON.stringify(r.body)}`);
  }

  // ---- Check 8: DB check: password_reset_required = 0 --------------------
  const userRow = db
    .prepare('SELECT password_reset_required FROM users WHERE username = ?')
    .get(TEST_USER);

  if (userRow && userRow.password_reset_required === 0) {
    pass('DB: password_reset_required = 0 after successful change');
  } else {
    fail('DB: password_reset_required = 0 after successful change',
      `got ${userRow ? userRow.password_reset_required : 'no row'}`);
  }

  // ---- Summary -----------------------------------------------------------
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);

  server.close(() => {
    process.exit(failed > 0 ? 1 : 0);
  });
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
