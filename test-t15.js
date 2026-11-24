'use strict';

/**
 * test-t15.js — Integration test for T-15 Student Records API
 *
 * Run: node test-t15.js
 * Exit code 0 = all PASS, exit code 1 = at least one FAIL.
 */

const http = require('http');

// ---------------------------------------------------------------------------
// 1. Insert test users BEFORE requiring app
// ---------------------------------------------------------------------------
const db     = require('./src/repositories/db');
const bcrypt = require('bcryptjs');

const adminRole = db.prepare("SELECT id FROM roles WHERE name='sysadmin'").get();
if (!adminRole) {
  console.error('FATAL: sysadmin role not found in DB. Run the seed first.');
  process.exit(1);
}

const teacherRole = db.prepare("SELECT id FROM roles WHERE name='teacher'").get();
if (!teacherRole) {
  console.error('FATAL: teacher role not found in DB. Run the seed first.');
  process.exit(1);
}

const adminHash   = bcrypt.hashSync('AdminPass1!', 12);
const teacherHash = bcrypt.hashSync('TeachPass1!', 12);

db.prepare(`INSERT INTO users (username,email,password_hash,full_name,role_id,status,password_reset_required)
  VALUES (?,?,?,?,?,'Active',0)
  ON CONFLICT(username) DO UPDATE SET email=excluded.email,password_hash=excluded.password_hash,
  full_name=excluded.full_name,role_id=excluded.role_id,status=excluded.status,password_reset_required=excluded.password_reset_required`)
  .run('t15_admin', 't15admin@test.local', adminHash, 'T15 Admin', adminRole.id);

db.prepare(`INSERT INTO users (username,email,password_hash,full_name,role_id,status,password_reset_required)
  VALUES (?,?,?,?,?,'Active',0)
  ON CONFLICT(username) DO UPDATE SET email=excluded.email,password_hash=excluded.password_hash,
  full_name=excluded.full_name,role_id=excluded.role_id,status=excluded.status,password_reset_required=excluded.password_reset_required`)
  .run('t15_teacher', 't15teacher@test.local', teacherHash, 'T15 Teacher', teacherRole.id);

const adminUser = db.prepare("SELECT id FROM users WHERE username='t15_admin'").get();

// ---------------------------------------------------------------------------
// 2. Start server on port 3088
// ---------------------------------------------------------------------------
const app      = require('./src/app');
const TEST_PORT = 3088;
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
  console.log('\n=== T-15 Student Records API Tests ===\n');

  // ---- Check 1: Login as sysadmin ------------------------------------------
  let adminCookie = await login('t15_admin', 'AdminPass1!');
  if (!adminCookie) {
    fail('SysAdmin login → 200 + session cookie', 'Could not log in as t15_admin');
    console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
    server.close(() => process.exit(1));
    return;
  }
  pass('SysAdmin login → 200 + session cookie');

  // Need a refreshed CSRF token for state-changing requests
  const { csrfToken: csrf1, csrfCookie: csrfC1 } = await fetchCsrf(adminCookie);
  adminCookie = mergeCookies(adminCookie, csrfC1);

  // ---- Check 2: POST /api/students → 201 student created -------------------
  let studentId;
  const originalLastName = 'Santos';
  {
    const r = await request({
      method: 'POST',
      path: '/api/students',
      cookie: adminCookie,
      csrfToken: csrf1,
      body: {
        student_number: 'T15-S-001',
        last_name: originalLastName,
        first_name: 'Maria',
        grade_level: '11',
        section: 'A',
        school_year: '2026-2027',
      },
    });

    if (r.status === 201 && r.body && r.body.id) {
      studentId = r.body.id;
      pass(`POST /api/students → 201, id=${studentId}`);
    } else {
      fail('POST /api/students → 201', `status=${r.status}, body=${JSON.stringify(r.body)}`);
      console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
      server.close(() => process.exit(1));
      return;
    }
  }

  // ---- Check 3: GET /api/students?q=Santos → student appears ---------------
  {
    const r = await request({
      method: 'GET',
      path: '/api/students?q=Santos',
      cookie: adminCookie,
    });

    const found = r.body && r.body.data && r.body.data.some(s => s.id === studentId);
    if (r.status === 200 && found) {
      pass(`GET /api/students?q=Santos → 200, student appears in results`);
    } else {
      fail(`GET /api/students?q=Santos → 200 with student`, `status=${r.status}, found=${found}, body=${JSON.stringify(r.body)}`);
    }
  }

  // ---- Check 4: PATCH /api/students/:id last_name → 200, updated -----------
  const { csrfToken: csrf2, csrfCookie: csrfC2 } = await fetchCsrf(adminCookie);
  adminCookie = mergeCookies(adminCookie, csrfC2);

  {
    const r = await request({
      method: 'PATCH',
      path: `/api/students/${studentId}`,
      cookie: adminCookie,
      csrfToken: csrf2,
      body: { last_name: 'Updated' },
    });

    if (r.status === 200 && r.body && r.body.last_name === 'Updated') {
      pass(`PATCH /api/students/${studentId} {last_name:'Updated'} → 200, last_name=Updated`);
    } else {
      fail(`PATCH /api/students/${studentId} → 200 with new last_name`, `status=${r.status}, body=${JSON.stringify(r.body)}`);
    }
  }

  // ---- Check 5: Audit log has STUDENT_UPDATED with old_values --------------
  {
    const auditRow = db.prepare(`
      SELECT id, old_values, new_values FROM audit_logs
      WHERE action_type='STUDENT_UPDATED' AND target_id=? AND actor_id=?
      ORDER BY id DESC LIMIT 1
    `).get(studentId, adminUser.id);

    if (auditRow) {
      let oldParsed = null;
      try { oldParsed = JSON.parse(auditRow.old_values); } catch (_) {}
      if (oldParsed && oldParsed.last_name === originalLastName) {
        pass(`audit_logs STUDENT_UPDATED has old_values.last_name='${originalLastName}'`);
      } else {
        fail(`audit_logs STUDENT_UPDATED has old_values.last_name`, `old_values=${auditRow.old_values}`);
      }
    } else {
      fail(`audit_logs has STUDENT_UPDATED entry for student ${studentId}`, 'No matching row found');
    }
  }

  // ---- Check 6: PATCH /api/students/:id/archive → 200 ----------------------
  const { csrfToken: csrf3, csrfCookie: csrfC3 } = await fetchCsrf(adminCookie);
  adminCookie = mergeCookies(adminCookie, csrfC3);

  {
    const r = await request({
      method: 'PATCH',
      path: `/api/students/${studentId}/archive`,
      cookie: adminCookie,
      csrfToken: csrf3,
    });

    if (r.status === 200 && r.body && r.body.message) {
      pass(`PATCH /api/students/${studentId}/archive → 200`);
    } else {
      fail(`PATCH /api/students/${studentId}/archive → 200`, `status=${r.status}, body=${JSON.stringify(r.body)}`);
    }
  }

  // ---- Check 7: GET /api/students → archived student NOT in results ---------
  {
    const r = await request({
      method: 'GET',
      path: '/api/students',
      cookie: adminCookie,
    });

    const found = r.body && r.body.data && r.body.data.some(s => s.id === studentId);
    if (r.status === 200 && !found) {
      pass(`GET /api/students after archive → archived student NOT in results`);
    } else {
      fail(`GET /api/students → archived student should be excluded`, `status=${r.status}, found=${found}`);
    }
  }

  // ---- Check 8: PATCH /api/students/:id/restore → 200 ----------------------
  const { csrfToken: csrf4, csrfCookie: csrfC4 } = await fetchCsrf(adminCookie);
  adminCookie = mergeCookies(adminCookie, csrfC4);

  {
    const r = await request({
      method: 'PATCH',
      path: `/api/students/${studentId}/restore`,
      cookie: adminCookie,
      csrfToken: csrf4,
    });

    if (r.status === 200 && r.body && r.body.message) {
      pass(`PATCH /api/students/${studentId}/restore → 200`);
    } else {
      fail(`PATCH /api/students/${studentId}/restore → 200`, `status=${r.status}, body=${JSON.stringify(r.body)}`);
    }
  }

  // ---- Check 9: GET /api/students → restored student IS in results ----------
  {
    const r = await request({
      method: 'GET',
      path: '/api/students',
      cookie: adminCookie,
    });

    const found = r.body && r.body.data && r.body.data.some(s => s.id === studentId);
    if (r.status === 200 && found) {
      pass(`GET /api/students after restore → student IS in results`);
    } else {
      fail(`GET /api/students → restored student should appear`, `status=${r.status}, found=${found}`);
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
