'use strict';

/**
 * test-t09b.js — Integration test for T-09B Notification Service and Endpoints
 *
 * Run: node test-t09b.js
 * Exit code 0 = all PASS, exit code 1 = at least one FAIL.
 */

const http = require('http');

// ---------------------------------------------------------------------------
// 1. Insert two Active sysadmin test users BEFORE requiring the app
// ---------------------------------------------------------------------------
const db = require('./src/repositories/db');
const bcrypt = require('bcryptjs');

const USER1 = 't09b_user1';
const PASS1 = 'TestPass1!';
const USER2 = 't09b_user2';
const PASS2 = 'TestPass2!';

const sysadminRole = db.prepare("SELECT id FROM roles WHERE name = 'sysadmin'").get();
if (!sysadminRole) {
  console.error('FATAL: sysadmin role not found in DB. Run the seed first.');
  process.exit(1);
}

const hash1 = bcrypt.hashSync(PASS1, 12);
const hash2 = bcrypt.hashSync(PASS2, 12);

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
`).run(USER1, 't09b_user1@test.local', hash1, 'T09B User One', sysadminRole.id);

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
`).run(USER2, 't09b_user2@test.local', hash2, 'T09B User Two', sysadminRole.id);

// ---------------------------------------------------------------------------
// 2. Start server
// ---------------------------------------------------------------------------
const app = require('./src/app');
const TEST_PORT = 3094;
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

function mergeCookies(a, b) {
  if (!a) return b;
  if (!b) return a;
  const map = new Map();
  for (const part of [...a.split('; '), ...b.split('; ')]) {
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) continue;
    const name = part.slice(0, eqIdx);
    map.set(name, part);
  }
  return [...map.values()].join('; ');
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
const notifService = require('./src/services/notification.service');

async function runTests() {
  console.log('\n=== T-09B Notification Service and Endpoints Tests ===\n');

  // ---- Login as user1 (full CSRF flow) ------------------------------------
  let user1Cookie = await login(USER1, PASS1);
  if (!user1Cookie) {
    fail('Login as user1', 'Could not log in — cannot continue');
    console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
    server.close(() => process.exit(1));
    return;
  }
  pass('Login as user1 — 200 + session cookie');

  // Refresh CSRF bound to the authenticated session
  const csrf1 = await fetchCsrf(user1Cookie);
  user1Cookie = mergeCookies(user1Cookie, csrf1.csrfCookie);

  // Retrieve user1's id from DB
  const user1Row = db.prepare('SELECT id FROM users WHERE username = ?').get(USER1);
  const user1Id  = user1Row.id;

  // ---- Check 1: Insert notification for user1 via service -----------------
  let notifId;
  try {
    notifId = notifService.create({
      userId:  user1Id,
      type:    'System Notice',
      title:   'T09B Test Notification',
      message: 'This is a test notification.',
    });
    pass('notification.service.create() — inserted without error');
  } catch (err) {
    fail('notification.service.create() — inserted without error', err.message);
    server.close(() => process.exit(1));
    return;
  }

  // ---- Check 2: GET /api/notifications/count → {unread_count: 1} ----------
  let r = await request({
    method: 'GET',
    path: '/api/notifications/count',
    cookie: user1Cookie,
  });

  if (r.status === 200 && r.body && r.body.unread_count === 1) {
    pass('GET /api/notifications/count as user1 → {unread_count: 1}');
  } else {
    fail('GET /api/notifications/count as user1 → {unread_count: 1}',
      `got ${r.status}: ${JSON.stringify(r.body)}`);
  }

  // ---- Check 3: PATCH /api/notifications/:id/read → 200 -------------------
  r = await request({
    method:    'PATCH',
    path:      `/api/notifications/${notifId}/read`,
    cookie:    user1Cookie,
    csrfToken: csrf1.csrfToken,
  });

  if (r.status === 200 && r.body && r.body.message === 'Notification marked as read.') {
    pass(`PATCH /api/notifications/${notifId}/read as user1 → 200`);
  } else {
    fail(`PATCH /api/notifications/${notifId}/read as user1 → 200`,
      `got ${r.status}: ${JSON.stringify(r.body)}`);
  }

  // ---- Check 4: GET /api/notifications/count → {unread_count: 0} ----------
  r = await request({
    method: 'GET',
    path: '/api/notifications/count',
    cookie: user1Cookie,
  });

  if (r.status === 200 && r.body && r.body.unread_count === 0) {
    pass('GET /api/notifications/count as user1 → {unread_count: 0} after mark-read');
  } else {
    fail('GET /api/notifications/count as user1 → {unread_count: 0} after mark-read',
      `got ${r.status}: ${JSON.stringify(r.body)}`);
  }

  // ---- Login as user2 -------------------------------------------------------
  let user2Cookie = await login(USER2, PASS2);
  if (!user2Cookie) {
    fail('Login as user2', 'Could not log in — cannot continue');
    console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
    server.close(() => process.exit(1));
    return;
  }
  pass('Login as user2 — 200 + session cookie');

  const csrf2 = await fetchCsrf(user2Cookie);
  user2Cookie = mergeCookies(user2Cookie, csrf2.csrfCookie);

  // ---- Check 5: user2 tries to read user1's notification → 403 ------------
  r = await request({
    method:    'PATCH',
    path:      `/api/notifications/${notifId}/read`,
    cookie:    user2Cookie,
    csrfToken: csrf2.csrfToken,
  });

  if (r.status === 403) {
    pass(`PATCH /api/notifications/${notifId}/read as user2 (owns user1's notification) → 403`);
  } else {
    fail(`PATCH /api/notifications/${notifId}/read as user2 (owns user1's notification) → 403`,
      `got ${r.status}: ${JSON.stringify(r.body)}`);
  }

  // ---- Check 6: Insert 2 more notifications for user1 ---------------------
  let notifId2, notifId3;
  try {
    notifId2 = notifService.create({
      userId:  user1Id,
      type:    'System Notice',
      title:   'T09B Test Notification 2',
      message: 'Second test notification.',
    });
    notifId3 = notifService.create({
      userId:  user1Id,
      type:    'System Notice',
      title:   'T09B Test Notification 3',
      message: 'Third test notification.',
    });
    pass('notification.service.create() × 2 — inserted without error');
  } catch (err) {
    fail('notification.service.create() × 2 — inserted without error', err.message);
    server.close(() => process.exit(1));
    return;
  }

  // Refresh user1 CSRF (session still valid)
  const csrf1b = await fetchCsrf(user1Cookie);
  user1Cookie = mergeCookies(user1Cookie, csrf1b.csrfCookie);

  // ---- Check 7: PATCH /api/notifications/read-all as user1 → 200 ----------
  r = await request({
    method:    'PATCH',
    path:      '/api/notifications/read-all',
    cookie:    user1Cookie,
    csrfToken: csrf1b.csrfToken,
  });

  if (r.status === 200 && r.body && r.body.message === 'All notifications marked as read.') {
    pass('PATCH /api/notifications/read-all as user1 → 200');
  } else {
    fail('PATCH /api/notifications/read-all as user1 → 200',
      `got ${r.status}: ${JSON.stringify(r.body)}`);
  }

  // ---- Check 8: GET /api/notifications/count after read-all → 0 -----------
  r = await request({
    method: 'GET',
    path: '/api/notifications/count',
    cookie: user1Cookie,
  });

  if (r.status === 200 && r.body && r.body.unread_count === 0) {
    pass('GET /api/notifications/count as user1 → {unread_count: 0} after read-all');
  } else {
    fail('GET /api/notifications/count as user1 → {unread_count: 0} after read-all',
      `got ${r.status}: ${JSON.stringify(r.body)}`);
  }

  // ---- Check 9: Idle clock check -------------------------------------------
  // GET /api/auth/session-status before the 10 count calls
  const statusBefore = await request({
    method: 'GET',
    path:   '/api/auth/session-status',
    cookie: user1Cookie,
  });

  const idleBefore = statusBefore.body && statusBefore.body.idle_expires_in_seconds;

  if (typeof idleBefore !== 'number') {
    fail('Idle clock check — got idle_expires_in_seconds before loop', `body: ${JSON.stringify(statusBefore.body)}`);
  } else {
    // Make 10 count calls with 100ms delay between each
    for (let i = 0; i < 10; i++) {
      await request({
        method: 'GET',
        path:   '/api/notifications/count',
        cookie: user1Cookie,
      });
      await sleep(100);
    }

    // GET /api/auth/session-status after the 10 count calls
    const statusAfter = await request({
      method: 'GET',
      path:   '/api/auth/session-status',
      cookie: user1Cookie,
    });

    const idleAfter = statusAfter.body && statusAfter.body.idle_expires_in_seconds;

    if (typeof idleAfter !== 'number') {
      fail('Idle clock check — got idle_expires_in_seconds after loop', `body: ${JSON.stringify(statusAfter.body)}`);
    } else {
      const decrease = idleBefore - idleAfter;
      console.log(`  [idle check] before=${idleBefore}s, after=${idleAfter}s, decrease=${decrease}s`);

      if (decrease > 5) {
        fail(
          'Idle clock NOT reset by /count calls (idle timer should not decrease by >5s)',
          `idle_expires_in_seconds went from ${idleBefore} to ${idleAfter} (decreased by ${decrease}s)`
        );
      } else {
        pass('Idle clock NOT reset by /count calls — idle_expires_in_seconds decreased by ≤5s');
      }
    }
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
