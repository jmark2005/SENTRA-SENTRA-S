'use strict';

/**
 * test-t12.js — Integration test for T-12 Role and Permission Management API
 *
 * Run: node test-t12.js
 * Exit code 0 = all PASS, exit code 1 = at least one FAIL.
 */

const http = require('http');

// ---------------------------------------------------------------------------
// 1. Insert test users BEFORE requiring app
// ---------------------------------------------------------------------------
const db     = require('./src/repositories/db');
const bcrypt = require('bcryptjs');

const ADMIN_USER   = 't12_admin';
const ADMIN_PASS   = 'AdminPass1!';
const TEACHER_USER = 't12_teacher';
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
`).run(ADMIN_USER, 't12admin@test.local', adminHash, 'T12 Admin User', adminRole.id);

// Upsert teacher test user (password_reset_required=0)
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
`).run(TEACHER_USER, 't12teacher@test.local', teacherHash, 'T12 Teacher User', teacherRole.id);

// ---------------------------------------------------------------------------
// 2. Start server on port 3091
// ---------------------------------------------------------------------------
const app      = require('./src/app');
const TEST_PORT = 3091;
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
  console.log('\n=== T-12 Role and Permission Management API Tests ===\n');

  // ---- Check 1: Login as sysadmin ------------------------------------------
  let adminCookie = await login(ADMIN_USER, ADMIN_PASS);
  if (!adminCookie) {
    fail('SysAdmin login → 200 + session cookie', 'Could not log in as sysadmin');
    console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
    server.close(() => process.exit(1));
    return;
  }
  pass('SysAdmin login → 200 + session cookie');

  // Bind a fresh CSRF token to the admin session
  const adminCsrf1 = await fetchCsrf(adminCookie);
  adminCookie = mergeCookies(adminCookie, adminCsrf1.csrfCookie);

  // ---- Check 2: GET /api/roles — 200, contains sysadmin and teacher --------
  let teacherRoleId = null;
  let sysadminRoleId = null;
  {
    const r = await request({
      method: 'GET',
      path: '/api/roles',
      cookie: adminCookie,
    });

    const hasAdmin   = r.body && Array.isArray(r.body.data) &&
                       r.body.data.some(x => x.name === 'sysadmin');
    const hasTeacher = r.body && Array.isArray(r.body.data) &&
                       r.body.data.some(x => x.name === 'teacher');

    if (r.status === 200 && hasAdmin && hasTeacher) {
      teacherRoleId   = r.body.data.find(x => x.name === 'teacher').id;
      sysadminRoleId  = r.body.data.find(x => x.name === 'sysadmin').id;
      pass('GET /api/roles → 200, contains sysadmin and teacher');
    } else {
      fail('GET /api/roles → 200, contains sysadmin and teacher',
        `status=${r.status}, hasAdmin=${hasAdmin}, hasTeacher=${hasTeacher}`);
    }
  }

  if (!teacherRoleId || !sysadminRoleId) {
    console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
    server.close(() => process.exit(1));
    return;
  }

  // ---- Check 3: GET /api/roles/:teacherRoleId/permissions — includes submit_incident granted=1
  let submitIncidentPermId = null;
  {
    const r = await request({
      method: 'GET',
      path: `/api/roles/${teacherRoleId}/permissions`,
      cookie: adminCookie,
    });

    const submitPerm = r.body && Array.isArray(r.body.data) &&
                       r.body.data.find(x => x.code === 'submit_incident');

    if (r.status === 200 && submitPerm && submitPerm.granted === 1) {
      submitIncidentPermId = submitPerm.id;
      pass(`GET /api/roles/${teacherRoleId}/permissions → 200, submit_incident granted=1`);
    } else {
      fail(`GET /api/roles/${teacherRoleId}/permissions → 200, submit_incident granted=1`,
        `status=${r.status}, submitPerm=${JSON.stringify(submitPerm)}`);
    }
  }

  if (!submitIncidentPermId) {
    console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
    server.close(() => process.exit(1));
    return;
  }

  // ---- Check 4: PATCH revoke submit_incident from teacher → 200, granted=0 -
  {
    const csrf = await fetchCsrf(adminCookie);
    adminCookie = mergeCookies(adminCookie, csrf.csrfCookie);

    const r = await request({
      method: 'PATCH',
      path: `/api/roles/${teacherRoleId}/permissions`,
      body: { permission_id: submitIncidentPermId, granted: false },
      cookie: adminCookie,
      csrfToken: csrf.csrfToken,
    });

    if (r.status === 200 && r.body && r.body.granted === 0) {
      pass(`PATCH revoke submit_incident from teacher role → 200, granted=0`);
    } else {
      fail(`PATCH revoke submit_incident from teacher role → 200, granted=0`,
        `status=${r.status}, body=${JSON.stringify(r.body)}`);
    }
  }

  // ---- Check 5: Login as teacher, GET /api/auth/me → permissions does NOT include submit_incident
  {
    const teacherCookie = await login(TEACHER_USER, TEACHER_PASS);
    if (!teacherCookie) {
      fail('Teacher login after revoke → 200', 'Could not log in as teacher');
    } else {
      const r = await request({
        method: 'GET',
        path: '/api/auth/me',
        cookie: teacherCookie,
      });

      const perms = r.body && Array.isArray(r.body.permissions) ? r.body.permissions : [];
      if (r.status === 200 && !perms.includes('submit_incident')) {
        pass('Teacher /api/auth/me after revoke → 200, permissions does NOT include submit_incident');
      } else {
        fail('Teacher /api/auth/me after revoke → 200, permissions does NOT include submit_incident',
          `status=${r.status}, permissions=${JSON.stringify(perms)}`);
      }
    }
  }

  // ---- Check 6: PATCH grant submit_incident back to teacher → 200, granted=1
  {
    const csrf = await fetchCsrf(adminCookie);
    adminCookie = mergeCookies(adminCookie, csrf.csrfCookie);

    const r = await request({
      method: 'PATCH',
      path: `/api/roles/${teacherRoleId}/permissions`,
      body: { permission_id: submitIncidentPermId, granted: true },
      cookie: adminCookie,
      csrfToken: csrf.csrfToken,
    });

    if (r.status === 200 && r.body && r.body.granted === 1) {
      pass(`PATCH grant submit_incident back to teacher role → 200, granted=1`);
    } else {
      fail(`PATCH grant submit_incident back to teacher role → 200, granted=1`,
        `status=${r.status}, body=${JSON.stringify(r.body)}`);
    }
  }

  // ---- Check 7: Login as teacher again, GET /api/auth/me → permissions DOES include submit_incident
  {
    const teacherCookie = await login(TEACHER_USER, TEACHER_PASS);
    if (!teacherCookie) {
      fail('Teacher login after re-grant → 200', 'Could not log in as teacher');
    } else {
      const r = await request({
        method: 'GET',
        path: '/api/auth/me',
        cookie: teacherCookie,
      });

      const perms = r.body && Array.isArray(r.body.permissions) ? r.body.permissions : [];
      if (r.status === 200 && perms.includes('submit_incident')) {
        pass('Teacher /api/auth/me after re-grant → 200, permissions DOES include submit_incident');
      } else {
        fail('Teacher /api/auth/me after re-grant → 200, permissions DOES include submit_incident',
          `status=${r.status}, permissions=${JSON.stringify(perms)}`);
      }
    }
  }

  // ---- Check 8: Get manage_accounts permission ID --------------------------
  let manageAccountsPermId = null;
  {
    const r = await request({
      method: 'GET',
      path: `/api/roles/${sysadminRoleId}/permissions`,
      cookie: adminCookie,
    });

    const perm = r.body && Array.isArray(r.body.data) &&
                 r.body.data.find(x => x.code === 'manage_accounts');

    if (r.status === 200 && perm) {
      manageAccountsPermId = perm.id;
      pass(`GET /api/roles/${sysadminRoleId}/permissions → 200, found manage_accounts`);
    } else {
      fail(`GET /api/roles/${sysadminRoleId}/permissions → 200, found manage_accounts`,
        `status=${r.status}, perm=${JSON.stringify(perm)}`);
    }
  }

  // ---- Check 9: PATCH try to remove manage_accounts from sysadmin → 403 ---
  if (manageAccountsPermId) {
    const csrf = await fetchCsrf(adminCookie);
    adminCookie = mergeCookies(adminCookie, csrf.csrfCookie);

    const r = await request({
      method: 'PATCH',
      path: `/api/roles/${sysadminRoleId}/permissions`,
      body: { permission_id: manageAccountsPermId, granted: false },
      cookie: adminCookie,
      csrfToken: csrf.csrfToken,
    });

    if (r.status === 403) {
      pass('PATCH remove manage_accounts from sysadmin → 403 (protected)');
    } else {
      fail('PATCH remove manage_accounts from sysadmin → 403 (protected)',
        `status=${r.status}, body=${JSON.stringify(r.body)}`);
    }
  } else {
    fail('PATCH remove manage_accounts from sysadmin → 403 (protected)', 'manage_accounts perm ID not found');
  }

  // ---- Check 10: Teacher PATCH /api/roles/:teacherRoleId/permissions → 403 -
  {
    const teacherCookie = await login(TEACHER_USER, TEACHER_PASS);
    if (!teacherCookie) {
      fail('Teacher PATCH /api/roles/permissions → 403 (no manage_roles_permissions)',
        'Could not log in as teacher');
    } else {
      const csrf = await fetchCsrf(teacherCookie);
      const mergedTeacherCookie = mergeCookies(teacherCookie, csrf.csrfCookie);

      const r = await request({
        method: 'PATCH',
        path: `/api/roles/${teacherRoleId}/permissions`,
        body: { permission_id: submitIncidentPermId, granted: false },
        cookie: mergedTeacherCookie,
        csrfToken: csrf.csrfToken,
      });

      if (r.status === 403) {
        pass('Teacher PATCH /api/roles/permissions → 403 (no manage_roles_permissions)');
      } else {
        fail('Teacher PATCH /api/roles/permissions → 403 (no manage_roles_permissions)',
          `status=${r.status}, body=${JSON.stringify(r.body)}`);
      }
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
