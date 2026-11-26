'use strict';

/**
 * test-t38.js — Integration test for T-38 Trend Analysis API
 *
 * Run: node test-t38.js
 * Exit code 0 = all PASS, 1 = at least one FAIL.
 *
 * Tests:
 *  1. 5 incidents across 3 categories → by-category returns exactly 3 rows.
 *  2. Category with 3 incidents has count === 3.
 *  3. GET /api/trends/by-location → 200 with data array.
 *  4. GET /api/trends/over-time?period=monthly → 200 with data array.
 *  5. GET /api/trends/by-category without login → 401.
 *  6. GET /api/trends/by-category as teacher → 200 (teacher has view_reports).
 *  7. Archived incidents are excluded.
 *  8. Restricted incidents excluded for teacher, visible to sysadmin.
 */

const http   = require('http');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const db = require('./src/repositories/db');

// ── Helpers ──────────────────────────────────────────────────────────────────

function randomPassword() {
  return crypto.randomBytes(12).toString('base64url') + 'Aa1!';
}

function upsertUser(username, roleName, fullName) {
  const role = db.prepare('SELECT id FROM roles WHERE name = ?').get(roleName);
  if (!role) throw new Error(`Role ${roleName} missing. Run the seed first.`);
  const password = randomPassword();
  db.prepare(`
    INSERT INTO users (username, email, password_hash, full_name, role_id, status, password_reset_required)
    VALUES (?, ?, ?, ?, ?, 'Active', 0)
    ON CONFLICT(username) DO UPDATE SET
      email = excluded.email, password_hash = excluded.password_hash,
      full_name = excluded.full_name, role_id = excluded.role_id,
      status = 'Active', password_reset_required = 0
  `).run(username, `${username}@test.local`, bcrypt.hashSync(password, 10), fullName, role.id);
  return { username, password };
}

// ── Create test users ─────────────────────────────────────────────────────────
const ADMIN   = upsertUser('t38_admin',   'sysadmin', 'T38 Admin');
const TEACHER = upsertUser('t38_teacher', 'teacher',  'T38 Teacher');

// ── Resolve categories — use first 3 active categories from DB ────────────────
const categories = db.prepare('SELECT id, name FROM incident_categories WHERE is_active = 1 ORDER BY id LIMIT 3').all();
if (categories.length < 3) {
  console.error('Need at least 3 active incident categories. Run the seed first.');
  process.exit(1);
}
const [cat1, cat2, cat3] = categories;

// ── Insert test incidents (5 total across 3 categories) ───────────────────────
const adminUser = db.prepare("SELECT id FROM users WHERE username = 't38_admin'").get();
const ts = Date.now();

function insertIncident(ref, categoryId, opts = {}) {
  db.prepare(`
    INSERT INTO incidents
      (reference_number, category_id, incident_date, incident_time,
       location_text, description, reporter_id, is_archived, is_restricted)
    VALUES (?, ?, '2025-03-15', '10:00', 'Test location', 'T38 test incident', ?, ?, ?)
  `).run(ref, categoryId, adminUser.id,
         opts.archived ? 1 : 0,
         opts.restricted ? 1 : 0);
}

// 3 incidents in cat1, 1 in cat2, 1 in cat3  (should give 3 category rows)
insertIncident(`T38-${ts}-A`, cat1.id);
insertIncident(`T38-${ts}-B`, cat1.id);
insertIncident(`T38-${ts}-C`, cat1.id);
insertIncident(`T38-${ts}-D`, cat2.id);
insertIncident(`T38-${ts}-E`, cat3.id);

// Extra archived incident in cat1 — must NOT appear in counts
insertIncident(`T38-${ts}-ARC`, cat1.id, { archived: true });

// Extra restricted incident in cat2 — teacher must NOT see it, admin must see it
insertIncident(`T38-${ts}-RES`, cat2.id, { restricted: true });

// ── Server and HTTP helpers ───────────────────────────────────────────────────
const app    = require('./src/app');
const PORT   = 3098;
const BASE   = `http://127.0.0.1:${PORT}`;
const server = http.createServer(app);

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log(`  PASS  ${name}`); }
  else    { failed++; console.error(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

function cookiesFrom(res) {
  return (res.headers.getSetCookie ? res.headers.getSetCookie() : []).map(c => c.split(';')[0]);
}
function mergeCookies(...lists) {
  const map = new Map();
  for (const c of lists.flat()) if (c) map.set(c.split('=')[0], c);
  return [...map.values()].join('; ');
}

async function csrf(cookie) {
  const res = await fetch(`${BASE}/api/csrf-token`, { headers: cookie ? { cookie } : {} });
  const { csrfToken } = await res.json();
  return { token: csrfToken, cookies: cookiesFrom(res) };
}

async function login(user) {
  const c = await csrf();
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': c.token, cookie: mergeCookies(c.cookies) },
    body: JSON.stringify({ username: user.username, password: user.password }),
  });
  if (res.status !== 200) throw new Error(`login ${user.username} → ${res.status}`);
  const cookie = mergeCookies(c.cookies, cookiesFrom(res));
  const fresh = await csrf(cookie);
  return { cookie: mergeCookies(cookie.split('; '), fresh.cookies), token: fresh.token };
}

async function apiGet(session, path) {
  const headers = {};
  if (session) { headers.cookie = session.cookie; headers['x-csrf-token'] = session.token; }
  const res = await fetch(BASE + path, { method: 'GET', headers });
  let json = null;
  try { json = await res.json(); } catch (_) { json = null; }
  return { status: res.status, body: json };
}

// ── Tests ─────────────────────────────────────────────────────────────────────
async function run() {
  console.log('\n=== T-38 Trend Analysis API ===\n');

  const admin   = await login(ADMIN);
  const teacher = await login(TEACHER);

  // ── 1. by-category: 5 incidents across 3 categories → 3 rows ──
  let r = await apiGet(admin, '/api/trends/by-category');
  check('GET /api/trends/by-category → 200', r.status === 200, `got ${r.status}`);

  const data = r.body && Array.isArray(r.body.data) ? r.body.data : [];

  // Filter to only the rows for our 3 test categories
  const testCatIds = new Set([cat1.id, cat2.id, cat3.id]);
  const testRows = data.filter(row => testCatIds.has(row.category_id));

  check(
    'by-category returns a row for each of the 3 test categories',
    testRows.length === 3,
    `got ${testRows.length} test-category rows out of ${data.length} total; rows: ${JSON.stringify(testRows)}`
  );

  const cat1Row = testRows.find(r => r.category_id === cat1.id);
  check(
    `Category "${cat1.name}" (3 incidents) has count === 3`,
    cat1Row && cat1Row.count === 3,
    `got ${cat1Row ? cat1Row.count : 'not found'}`
  );

  const cat2Row = testRows.find(r => r.category_id === cat2.id);
  check(
    `Category "${cat2.name}" (1 normal + 1 restricted = 2 for admin) has count === 2`,
    cat2Row && cat2Row.count === 2,
    `got ${cat2Row ? cat2Row.count : 'not found'} (admin sees restricted incidents)`
  );

  // ── 2. Archived incidents excluded ──
  // The archived incident in cat1 must NOT inflate the count (already verified above with count===3)
  // Extra explicit check: total count for cat1 without archive = 3
  check(
    'Archived incident excluded from cat1 count (would be 4 otherwise)',
    cat1Row && cat1Row.count === 3,
    `cat1 count: ${cat1Row ? cat1Row.count : 'missing'}`
  );

  // ── 3. Restricted incidents: teacher sees non-restricted only ──
  let tr = await apiGet(teacher, '/api/trends/by-category');
  check('Teacher: GET /api/trends/by-category → 200', tr.status === 200, `got ${tr.status}`);

  const teacherData = tr.body && Array.isArray(tr.body.data) ? tr.body.data : [];
  const teacherCat2Row = teacherData.find(row => row.category_id === cat2.id);
  check(
    `Teacher: cat2 count === 1 (restricted incident excluded)`,
    teacherCat2Row && teacherCat2Row.count === 1,
    `got ${teacherCat2Row ? teacherCat2Row.count : 'not found'}`
  );

  // Admin sees restricted — cat2 count should be 2 (1 normal + 1 restricted)
  const adminCat2Row = data.find(row => row.category_id === cat2.id);
  check(
    `Admin: cat2 count === 2 (sees restricted incident)`,
    adminCat2Row && adminCat2Row.count === 2,
    `got ${adminCat2Row ? adminCat2Row.count : 'not found'}`
  );

  // ── 4. GET /api/trends/by-location → 200, data array ──
  r = await apiGet(admin, '/api/trends/by-location');
  check('GET /api/trends/by-location → 200', r.status === 200, `got ${r.status}`);
  check(
    'by-location response has data array',
    r.body && Array.isArray(r.body.data),
    JSON.stringify(r.body)
  );

  // ── 5. GET /api/trends/over-time?period=monthly → 200, data array ──
  r = await apiGet(admin, '/api/trends/over-time?period=monthly');
  check('GET /api/trends/over-time?period=monthly → 200', r.status === 200, `got ${r.status}`);
  check(
    'over-time response has data array',
    r.body && Array.isArray(r.body.data),
    JSON.stringify(r.body)
  );
  check(
    'over-time echoes period=monthly',
    r.body && r.body.period === 'monthly',
    `got period=${r.body && r.body.period}`
  );

  // ── 6. over-time with other period values ──
  for (const period of ['daily', 'weekly', 'semester']) {
    r = await apiGet(admin, `/api/trends/over-time?period=${period}`);
    check(`GET /api/trends/over-time?period=${period} → 200`, r.status === 200, `got ${r.status}`);
    check(
      `over-time echoes period=${period}`,
      r.body && r.body.period === period,
      `got ${r.body && r.body.period}`
    );
  }

  // ── 7. Date range filtering ──
  r = await apiGet(admin, '/api/trends/by-category?from=2025-01-01&to=2025-12-31');
  check('by-category with date range → 200', r.status === 200, `got ${r.status}`);
  check('by-category date range result has data array', r.body && Array.isArray(r.body.data), '');

  // ── 8. No login → 401 ──
  const anonCsrf = await csrf();
  const anonSession = { cookie: mergeCookies(anonCsrf.cookies), token: anonCsrf.token };
  r = await apiGet(anonSession, '/api/trends/by-category');
  check('GET /api/trends/by-category without login → 401', r.status === 401, `got ${r.status}`);

  r = await apiGet(anonSession, '/api/trends/by-location');
  check('GET /api/trends/by-location without login → 401', r.status === 401, `got ${r.status}`);

  r = await apiGet(anonSession, '/api/trends/over-time');
  check('GET /api/trends/over-time without login → 401', r.status === 401, `got ${r.status}`);

  // ── 9. Teacher has access (view_reports permission) ──
  r = await apiGet(teacher, '/api/trends/by-category');
  check('Teacher GET /api/trends/by-category → 200', r.status === 200, `got ${r.status}`);

  r = await apiGet(teacher, '/api/trends/by-location');
  check('Teacher GET /api/trends/by-location → 200', r.status === 200, `got ${r.status}`);

  r = await apiGet(teacher, '/api/trends/over-time?period=monthly');
  check('Teacher GET /api/trends/over-time → 200', r.status === 200, `got ${r.status}`);

  // ── 10. by-category period query param echoed ──
  r = await apiGet(admin, '/api/trends/by-category?period=weekly');
  check('by-category echoes period param', r.body && r.body.period === 'weekly', `got ${r.body && r.body.period}`);

  r = await apiGet(admin, '/api/trends/by-category');
  check('by-category period null when not provided', r.body && r.body.period === null, `got ${r.body && r.body.period}`);

  // ── Cleanup test incidents ───────────────────────────────────────────────────
  db.prepare(`DELETE FROM incidents WHERE reference_number LIKE 'T38-${ts}-%'`).run();
  console.log(`\n  (cleanup: removed T38-${ts}-* test incidents)\n`);
}

server.listen(PORT, async () => {
  try {
    await run();
  } catch (err) {
    failed++;
    console.error('  FAIL  unexpected error:', err);
  }
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  server.close(() => process.exit(failed ? 1 : 0));
});
