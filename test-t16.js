'use strict';

/**
 * test-t16.js — Integration test for T-16 Class Management API
 *
 * Run: node test-t16.js
 * Exit code 0 = all PASS, exit code 1 = at least one FAIL.
 */

const http = require('http');

// ---------------------------------------------------------------------------
// 1. Insert test users + students BEFORE requiring app
// ---------------------------------------------------------------------------
const db     = require('./src/repositories/db');
const bcrypt = require('bcryptjs');

const adminRole = db.prepare("SELECT id FROM roles WHERE name='sysadmin'").get();
if (!adminRole) {
  console.error('FATAL: sysadmin role not found in DB. Run the seed first.');
  process.exit(1);
}

const adminHash = bcrypt.hashSync('AdminPass1!', 12);

db.prepare(`
  INSERT INTO users (username, email, password_hash, full_name, role_id, status, password_reset_required)
  VALUES (?,?,?,?,?,'Active',0)
  ON CONFLICT(username) DO UPDATE SET
    email=excluded.email, password_hash=excluded.password_hash,
    full_name=excluded.full_name, role_id=excluded.role_id,
    status=excluded.status, password_reset_required=excluded.password_reset_required
`).run('t16_admin', 't16admin@test.local', adminHash, 'T16 Admin', adminRole.id);

const adminUser = db.prepare("SELECT id FROM users WHERE username='t16_admin'").get();

// Insert 3 students with unique student_numbers
const studentIds = [];
const studentDefs = [
  { sn: 'T16-S-001', ln: 'Reyes',   fn: 'Ana' },
  { sn: 'T16-S-002', ln: 'Cruz',    fn: 'Ben' },
  { sn: 'T16-S-003', ln: 'Santos',  fn: 'Carlo' },
];

for (const s of studentDefs) {
  db.prepare(`
    INSERT INTO students (student_number, last_name, first_name, grade_level, section, school_year, created_by)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(student_number) DO NOTHING
  `).run(s.sn, s.ln, s.fn, '11', 'A', '2026-2027', adminUser.id);

  const row = db.prepare("SELECT id FROM students WHERE student_number=?").get(s.sn);
  studentIds.push(row.id);
}

// ---------------------------------------------------------------------------
// 2. Start server on port 3087
// ---------------------------------------------------------------------------
const app      = require('./src/app');
const TEST_PORT = 3087;
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

// Helper to get a fresh CSRF token and merge cookies
async function refreshCsrf(currentCookie) {
  const { csrfToken, csrfCookie } = await fetchCsrf(currentCookie);
  return { csrfToken, cookie: mergeCookies(currentCookie, csrfCookie) };
}

// ---------------------------------------------------------------------------
// 4. Run tests
// ---------------------------------------------------------------------------
async function runTests() {
  console.log('\n=== T-16 Class Management API Tests ===\n');

  // ---- Check 1: Login as sysadmin ------------------------------------------
  let adminCookie = await login('t16_admin', 'AdminPass1!');
  if (!adminCookie) {
    fail('SysAdmin login → 200 + session cookie', 'Could not log in as t16_admin');
    console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
    server.close(() => process.exit(1));
    return;
  }
  pass('SysAdmin login → 200 + session cookie');

  // ---- Check 2: POST /api/classes → 201, class created ---------------------
  let classId;
  {
    const { csrfToken, cookie } = await refreshCsrf(adminCookie);
    adminCookie = cookie;

    const r = await request({
      method: 'POST',
      path: '/api/classes',
      cookie: adminCookie,
      csrfToken,
      body: {
        name: 'Grade 11-A',
        grade_level: '11',
        section: 'A',
        school_year: '2026-2027',
        semester: '1st Semester',
      },
    });

    if (r.status === 201 && r.body && r.body.id) {
      classId = r.body.id;
      pass(`POST /api/classes → 201, id=${classId}`);
    } else {
      fail('POST /api/classes → 201', `status=${r.status}, body=${JSON.stringify(r.body)}`);
      console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
      server.close(() => process.exit(1));
      return;
    }
  }

  // ---- Check 3: GET /api/classes → 200, contains new class -----------------
  {
    const r = await request({
      method: 'GET',
      path: '/api/classes',
      cookie: adminCookie,
    });

    const found = r.body && r.body.data && r.body.data.some(c => c.id === classId);
    if (r.status === 200 && found) {
      pass(`GET /api/classes → 200, contains class id=${classId}`);
    } else {
      fail('GET /api/classes → 200 with new class', `status=${r.status}, found=${found}`);
    }
  }

  // ---- Check 4: GET /api/classes/:id → 200, students empty -----------------
  {
    const r = await request({
      method: 'GET',
      path: `/api/classes/${classId}`,
      cookie: adminCookie,
    });

    if (r.status === 200 && r.body && Array.isArray(r.body.students) && r.body.students.length === 0) {
      pass(`GET /api/classes/${classId} → 200, students=[]`);
    } else {
      fail(`GET /api/classes/${classId} → 200 with empty students`, `status=${r.status}, body=${JSON.stringify(r.body)}`);
    }
  }

  // ---- Check 5: POST /api/classes/:id/students → 201, assigned=3 -----------
  {
    const { csrfToken, cookie } = await refreshCsrf(adminCookie);
    adminCookie = cookie;

    const r = await request({
      method: 'POST',
      path: `/api/classes/${classId}/students`,
      cookie: adminCookie,
      csrfToken,
      body: { student_ids: studentIds },
    });

    if (r.status === 201 && r.body && r.body.assigned && r.body.assigned.length === 3 && r.body.errors.length === 0) {
      pass(`POST /api/classes/${classId}/students → 201, assigned=3, errors=[]`);
    } else {
      fail(`POST /api/classes/${classId}/students → 201`, `status=${r.status}, body=${JSON.stringify(r.body)}`);
    }
  }

  // ---- Check 6: GET /api/classes/:id → students has 3 entries --------------
  {
    const r = await request({
      method: 'GET',
      path: `/api/classes/${classId}`,
      cookie: adminCookie,
    });

    if (r.status === 200 && r.body && Array.isArray(r.body.students) && r.body.students.length === 3) {
      pass(`GET /api/classes/${classId} → 200, students.length=3`);
    } else {
      fail(`GET /api/classes/${classId} → students.length=3`, `status=${r.status}, students=${JSON.stringify(r.body && r.body.students)}`);
    }
  }

  // ---- Check 7: PATCH /api/classes/:id {is_active:0} → 200, is_active=0 ----
  {
    const { csrfToken, cookie } = await refreshCsrf(adminCookie);
    adminCookie = cookie;

    const r = await request({
      method: 'PATCH',
      path: `/api/classes/${classId}`,
      cookie: adminCookie,
      csrfToken,
      body: { is_active: 0 },
    });

    if (r.status === 200 && r.body && r.body.is_active === 0) {
      pass(`PATCH /api/classes/${classId} {is_active:0} → 200, is_active=0`);
    } else {
      fail(`PATCH /api/classes/${classId} → is_active=0`, `status=${r.status}, body=${JSON.stringify(r.body)}`);
    }
  }

  // ---- Check 8: Create second class same school_year+semester ---------------
  let classId2;
  {
    const { csrfToken, cookie } = await refreshCsrf(adminCookie);
    adminCookie = cookie;

    const r = await request({
      method: 'POST',
      path: '/api/classes',
      cookie: adminCookie,
      csrfToken,
      body: {
        name: 'Grade 11-B',
        grade_level: '11',
        section: 'B',
        school_year: '2026-2027',
        semester: '1st Semester',
      },
    });

    if (r.status === 201 && r.body && r.body.id) {
      classId2 = r.body.id;
      pass(`POST /api/classes (second class) → 201, id=${classId2}`);
    } else {
      fail('POST /api/classes (second class) → 201', `status=${r.status}, body=${JSON.stringify(r.body)}`);
    }
  }

  // ---- Check 9: Assign same student to second class → 409 ------------------
  if (classId2) {
    const { csrfToken, cookie } = await refreshCsrf(adminCookie);
    adminCookie = cookie;

    const r = await request({
      method: 'POST',
      path: `/api/classes/${classId2}/students`,
      cookie: adminCookie,
      csrfToken,
      body: { student_ids: [studentIds[0]] },
    });

    // 409 when all conflict, or 207 partial with errors — either means constraint enforced
    if (r.status === 409 || (r.status === 207 && r.body && r.body.errors && r.body.errors.length > 0)) {
      pass(`POST /api/classes/${classId2}/students (already-assigned student) → ${r.status} conflict enforced`);
    } else {
      fail(`POST /api/classes/${classId2}/students → 409 or 207`, `status=${r.status}, body=${JSON.stringify(r.body)}`);
    }
  }

  // ---- Check 10: DELETE /api/classes/:id/students/:sid → 200 ---------------
  const sidToRemove = studentIds[0];
  {
    const { csrfToken, cookie } = await refreshCsrf(adminCookie);
    adminCookie = cookie;

    const r = await request({
      method: 'DELETE',
      path: `/api/classes/${classId}/students/${sidToRemove}`,
      cookie: adminCookie,
      csrfToken,
    });

    if (r.status === 200 && r.body && r.body.message) {
      pass(`DELETE /api/classes/${classId}/students/${sidToRemove} → 200`);
    } else {
      fail(`DELETE /api/classes/${classId}/students/${sidToRemove} → 200`, `status=${r.status}, body=${JSON.stringify(r.body)}`);
    }
  }

  // ---- Check 11: GET /api/classes/:id → students has 2 entries -------------
  {
    const r = await request({
      method: 'GET',
      path: `/api/classes/${classId}`,
      cookie: adminCookie,
    });

    if (r.status === 200 && r.body && Array.isArray(r.body.students) && r.body.students.length === 2) {
      pass(`GET /api/classes/${classId} after remove → students.length=2`);
    } else {
      fail(`GET /api/classes/${classId} → students.length=2`, `status=${r.status}, students=${JSON.stringify(r.body && r.body.students)}`);
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
