'use strict';

/**
 * test-t06b.js — CSRF Protection Tests
 *
 * Tests:
 *  1. GET /api/csrf-token → 200, { csrfToken: "<non-empty string>" }
 *  2. POST /api/auth/login WITHOUT X-CSRF-Token → 403
 *  3. GET /api/auth/session-status WITHOUT X-CSRF-Token → 200 (exempt)
 *  4. Full login flow: GET csrf-token (with cookie), POST /api/auth/login with both → 200
 */

const http = require('http');
const bcrypt = require('bcryptjs');
const db = require('./src/repositories/db');

const TEST_PORT = 3098;
const TEST_USERNAME = 'testcsrf';
const TEST_PASSWORD = 'TestPass@123!';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function request({ method, path, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };

    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, body: json, raw: data });
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Extract all Set-Cookie values from a response header object. */
function extractCookies(resHeaders) {
  const raw = resHeaders['set-cookie'] || [];
  const cookies = {};
  for (const entry of raw) {
    const [pair] = entry.split(';');
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) continue;
    const name = pair.slice(0, eqIdx).trim();
    const value = pair.slice(eqIdx + 1).trim();
    cookies[name] = value;
  }
  return cookies;
}

/** Build a Cookie header string from a name→value map. */
function buildCookieHeader(cookies) {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}

// ---------------------------------------------------------------------------
// Test setup: insert a known test user
// ---------------------------------------------------------------------------

function ensureTestUser() {
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(TEST_USERNAME);
  if (existing) return;

  const hash = bcrypt.hashSync(TEST_PASSWORD, 10);
  const roleRow = db.prepare("SELECT id FROM roles WHERE name = 'sysadmin'").get();
  if (!roleRow) throw new Error('sysadmin role not found — run seed first');

  db.prepare(`
    INSERT INTO users (username, email, password_hash, full_name, role_id, status, password_reset_required)
    VALUES (?, ?, ?, ?, ?, 'Active', 0)
  `).run(TEST_USERNAME, `${TEST_USERNAME}@sentra.test`, hash, 'CSRF Test User', roleRow.id);
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${name}`);
    passed++;
  } else {
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('\n── T-06B: CSRF Protection Tests ──\n');

  // --- Setup ---
  ensureTestUser();

  // Start the server
  const app = require('./src/app');
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(TEST_PORT, '127.0.0.1', resolve));
  console.log(`Server listening on port ${TEST_PORT}\n`);

  try {
    // -----------------------------------------------------------------
    // Test 1: GET /api/csrf-token → 200, { csrfToken: "<non-empty string>" }
    // -----------------------------------------------------------------
    console.log('Test 1: GET /api/csrf-token returns token');
    const t1 = await request({ method: 'GET', path: '/api/csrf-token' });
    check('status is 200', t1.status === 200, `got ${t1.status}`);
    check('body has csrfToken', typeof t1.body?.csrfToken === 'string', `body: ${JSON.stringify(t1.body)}`);
    check('csrfToken is non-empty', t1.body?.csrfToken?.length > 0, `token: ${t1.body?.csrfToken}`);

    const csrfCookies = extractCookies(t1.headers);
    const csrfCookieName = 'sentra.x-csrf-token'; // COOKIE_SECURE=false
    check('CSRF cookie is set', csrfCookieName in csrfCookies, `cookies: ${JSON.stringify(Object.keys(csrfCookies))}`);

    console.log();

    // -----------------------------------------------------------------
    // Test 2: POST /api/auth/login WITHOUT X-CSRF-Token → 403
    // -----------------------------------------------------------------
    console.log('Test 2: POST /api/auth/login without CSRF token → 403');
    const t2 = await request({
      method: 'POST',
      path: '/api/auth/login',
      body: { username: TEST_USERNAME, password: TEST_PASSWORD },
      // Deliberately omit X-CSRF-Token and the CSRF cookie
    });
    check('status is 403', t2.status === 403, `got ${t2.status}`);

    console.log();

    // -----------------------------------------------------------------
    // Test 3: GET /api/auth/session-status without CSRF token → 200
    // -----------------------------------------------------------------
    console.log('Test 3: GET /api/auth/session-status (exempt) → 200');
    const t3 = await request({ method: 'GET', path: '/api/auth/session-status' });
    check('status is 200', t3.status === 200, `got ${t3.status}`);
    check('body has authenticated field', 'authenticated' in (t3.body || {}), `body: ${JSON.stringify(t3.body)}`);

    console.log();

    // -----------------------------------------------------------------
    // Test 4: Full login flow — GET csrf-token then POST with cookie + header
    // -----------------------------------------------------------------
    console.log('Test 4: Full login flow (GET token → POST with token + cookie)');

    // Step 4a: Get CSRF token (also sets the CSRF cookie)
    const tokenRes = await request({ method: 'GET', path: '/api/csrf-token' });
    const csrfToken = tokenRes.body?.csrfToken;
    const tokenCookies = extractCookies(tokenRes.headers);
    const cookieHeader = buildCookieHeader(tokenCookies);

    check('got csrf token for login', typeof csrfToken === 'string' && csrfToken.length > 0, `token: ${csrfToken}`);
    check('got csrf cookie for login', csrfCookieName in tokenCookies, `cookies: ${JSON.stringify(Object.keys(tokenCookies))}`);

    // Step 4b: POST login with both the CSRF cookie and the X-CSRF-Token header
    const loginRes = await request({
      method: 'POST',
      path: '/api/auth/login',
      headers: {
        'X-CSRF-Token': csrfToken,
        'Cookie': cookieHeader,
      },
      body: { username: TEST_USERNAME, password: TEST_PASSWORD },
    });

    check('login status is 200', loginRes.status === 200, `got ${loginRes.status} — body: ${JSON.stringify(loginRes.body)}`);
    check('login body has user', loginRes.body?.user != null, `body: ${JSON.stringify(loginRes.body)}`);

    console.log();

  } finally {
    server.close();
    db.close();
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  console.log(`─────────────────────────────────`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`─────────────────────────────────\n`);

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Test run error:', err);
  process.exit(1);
});
