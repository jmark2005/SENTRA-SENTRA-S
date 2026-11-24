'use strict';

/**
 * test-t06.js — Integration test for T-06 Authentication Middleware and Login API
 *
 * Run: node test-t06.js
 * Exit code 0 = all PASS, exit code 1 = at least one FAIL.
 */

const http = require('http');

// ---------------------------------------------------------------------------
// 1. Insert a known test user BEFORE requiring the app (so the DB is open)
// ---------------------------------------------------------------------------
const db = require('./src/repositories/db');
const bcrypt = require('bcryptjs');

const TEST_USER = 'testadmin';
const TEST_PASS = 'TestPass123';

// Ensure the test user exists with a known password
const hash = bcrypt.hashSync(TEST_PASS, 12);
const role = db.prepare("SELECT id FROM roles WHERE name = 'sysadmin'").get();
if (!role) {
  console.error('FATAL: sysadmin role not found in DB. Run the seed first.');
  process.exit(1);
}
db.prepare(`
  INSERT OR REPLACE INTO users (username, email, password_hash, full_name, role_id, status, password_reset_required)
  VALUES (?, ?, ?, ?, ?, 'Active', 0)
`).run(TEST_USER, 'testadmin@test.local', hash, 'Test Admin', role.id);

// ---------------------------------------------------------------------------
// 2. Start the Express app on a test port
// ---------------------------------------------------------------------------
const app = require('./src/app');
const TEST_PORT = 3099;

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
 * Simple HTTP request helper.
 * Returns { status, headers, body (parsed JSON) }.
 */
function request({ method, path, body, cookie }) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = {
      'Content-Type': 'application/json',
    };
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);
    if (cookie) headers['Cookie'] = cookie;

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

/** Extract the session cookie string from a Set-Cookie header value. */
function extractCookie(setCookieHeader) {
  if (!setCookieHeader) return null;
  const val = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  // Return just the name=value part (first segment before ';')
  return val.split(';')[0];
}

// ---------------------------------------------------------------------------
// 4. Run tests
// ---------------------------------------------------------------------------
async function runTests() {
  console.log('\n=== T-06 Authentication Tests ===\n');

  // ---- Test 1: Valid login ------------------------------------------------
  let r = await request({
    method: 'POST',
    path: '/api/auth/login',
    body: { username: TEST_USER, password: TEST_PASS },
  });

  if (r.status === 200 && r.body && r.body.message === 'Login successful') {
    pass('POST /api/auth/login — valid credentials → 200');
  } else {
    fail('POST /api/auth/login — valid credentials → 200', `got ${r.status}: ${JSON.stringify(r.body)}`);
  }

  const cookie = extractCookie(r.headers['set-cookie']);
  if (cookie) {
    pass('POST /api/auth/login — set-cookie header present');
  } else {
    fail('POST /api/auth/login — set-cookie header present', 'no Set-Cookie header');
  }

  // ---- Test 2: GET /api/auth/me with cookie ------------------------------
  r = await request({
    method: 'GET',
    path: '/api/auth/me',
    cookie,
  });

  if (r.status === 200 && r.body && Array.isArray(r.body.permissions)) {
    pass('GET /api/auth/me — 200 with permissions array');
  } else {
    fail('GET /api/auth/me — 200 with permissions array', `got ${r.status}: ${JSON.stringify(r.body)}`);
  }

  // ---- Test 3: Login with wrong password ---------------------------------
  r = await request({
    method: 'POST',
    path: '/api/auth/login',
    body: { username: TEST_USER, password: 'WrongPassword!' },
  });

  if (r.status === 401) {
    pass('POST /api/auth/login — wrong password → 401');
  } else {
    fail('POST /api/auth/login — wrong password → 401', `got ${r.status}`);
  }

  // ---- Test 4: GET /api/auth/me without cookie ---------------------------
  r = await request({
    method: 'GET',
    path: '/api/auth/me',
  });

  if (r.status === 401) {
    pass('GET /api/auth/me — no cookie → 401');
  } else {
    fail('GET /api/auth/me — no cookie → 401', `got ${r.status}`);
  }

  // ---- Test 5: GET /api/auth/session-status ------------------------------
  r = await request({
    method: 'GET',
    path: '/api/auth/session-status',
    cookie,
  });

  if (
    r.status === 200 &&
    r.body &&
    r.body.authenticated === true &&
    typeof r.body.idle_expires_in_seconds === 'number'
  ) {
    pass('GET /api/auth/session-status — 200 with idle_expires_in_seconds');
  } else {
    fail('GET /api/auth/session-status — 200 with idle_expires_in_seconds', `got ${r.status}: ${JSON.stringify(r.body)}`);
  }

  // ---- Test 6: Logout ----------------------------------------------------
  r = await request({
    method: 'POST',
    path: '/api/auth/logout',
    cookie,
  });

  if (r.status === 200) {
    pass('POST /api/auth/logout — 200');
  } else {
    fail('POST /api/auth/logout — 200', `got ${r.status}: ${JSON.stringify(r.body)}`);
  }

  // ---- Test 7: Confirm user_sessions row deleted after logout ------------
  // Extract the session ID from the cookie (format: connect.sid=s%3A<sid>.<sig>)
  // We just verify no rows remain for the test user
  const userSessionsAfter = db
    .prepare('SELECT COUNT(*) AS cnt FROM user_sessions us JOIN users u ON u.id = us.user_id WHERE u.username = ?')
    .get(TEST_USER);

  if (userSessionsAfter.cnt === 0) {
    pass('user_sessions row deleted after logout');
  } else {
    fail('user_sessions row deleted after logout', `${userSessionsAfter.cnt} row(s) remain`);
  }

  // ---- Test 8: Rate limiting (11 rapid requests → 429) -------------------
  console.log('\n  [rate-limit test: sending 11 rapid login requests...]');
  let lastStatus = null;
  for (let i = 0; i < 11; i++) {
    const rr = await request({
      method: 'POST',
      path: '/api/auth/login',
      body: { username: TEST_USER, password: 'AnyPassword' },
    });
    lastStatus = rr.status;
  }

  if (lastStatus === 429) {
    pass('POST /api/auth/login — 11th rapid request → 429');
  } else {
    fail('POST /api/auth/login — 11th rapid request → 429', `got ${lastStatus} on 11th request`);
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
