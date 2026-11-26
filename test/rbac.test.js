'use strict';

// RBAC denials per permission code (src/middleware/rbac.js, T-08/T-12).
// Grants come from role_permissions, so the expected denials are read from the seeded DB.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { db, ROOT, makeUser, makeStudent, startServer } = require('./helpers');

// One endpoint guarded by each permission code. The guard runs before the handler,
// so ids and bodies do not need to be valid.
const GUARDS = {
  manage_accounts:            ['GET',   '/api/users'],
  manage_roles_permissions:   ['PATCH', '/api/roles/1/permissions', {}],
  manage_settings:            ['GET',   '/api/settings'],
  view_audit_log:             ['GET',   '/api/audit-logs'],
  manage_students:            ['GET',   '/api/students/archived'],
  view_students:              ['GET',   '/api/students'],
  manage_classes:             ['POST',  '/api/classes', {}],
  view_classes:               ['GET',   '/api/classes'],
  submit_incident:            ['GET',   '/api/incidents'],
  view_incidents:             ['GET',   '/api/reports/response'],
  manage_incidents:           ['PATCH', '/api/incidents/1/classify', {}],
  assign_incidents:           ['GET',   '/api/incidents/assignable-users'],
  respond_incidents:          ['POST',  '/api/incidents/1/acknowledge', {}],
  archive_incidents:          ['GET',   '/api/incidents/archived'],
  manage_attachments:         ['GET',   '/api/attachments/1/download'],
  submit_referral:            ['POST',  '/api/referrals', {}],
  manage_referrals:           ['GET',   '/api/referrals/assignable-users'],
  view_referrals:             ['GET',   '/api/referrals'],
  record_attendance:          ['PATCH', '/api/attendance/1', {}],
  view_attendance:            ['GET',   '/api/attendance/classes'],
  view_reports:               ['GET',   '/api/reports/incidents'],
  manage_incident_categories: ['POST',  '/api/incident-categories', {}],
  send_emergency_alert:       ['POST',  '/api/notifications/emergency', {}],
  view_participation:         ['GET',   '/api/users/1/participation'],
  manage_escalation_rules:    ['GET',   '/api/escalation-rules'],
};
// Seeded codes that no route checks yet (trends: T-38;
// campus-location routes currently check manage_incident_categories).
const NO_ROUTE_YET = ['manage_campus_locations', 'view_trends'];

const ROLES = ['sysadmin', 'schoolhead', 'teacher', 'guidance', 'safetyofficer', 'student'];
const granted = (role, code) => !!db.prepare(`
  SELECT 1 FROM role_permissions rp JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
  WHERE r.name = ? AND p.code = ? AND rp.granted = 1`).get(role, code);
function setGrant(role, code, value) {
  db.prepare(`
    UPDATE role_permissions SET granted = ?
    WHERE role_id = (SELECT id FROM roles WHERE name = ?) AND permission_id = (SELECT id FROM permissions WHERE code = ?)
  `).run(value, role, code);
}

let srv;
const sessions = {};

before(async () => {
  srv = await startServer();
  for (const role of ROLES) {
    const extra = role === 'student' ? { student_record_id: makeStudent() } : {};
    sessions[role] = await srv.login(makeUser(role, `Test ${role}`, extra));
  }
});
after(() => srv.close());

const hit = (role, code) => { const [m, p, b] = GUARDS[code]; return srv.call(sessions[role], m, p, b); };
const isRbacDenial = r => r.status === 403 && r.body && r.body.error === 'Forbidden';

test('every permission code used by a route has an endpoint in this test', () => {
  const dir = path.join(ROOT, 'src', 'routes');
  const used = new Set();
  for (const f of fs.readdirSync(dir)) {
    for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/requirePermission\('([a-z_]+)'\)/g)) used.add(m[1]);
  }
  const missing = [...used].filter(c => !GUARDS[c]);
  assert.deepEqual(missing, [], 'add these codes to GUARDS');
  const seeded = db.prepare('SELECT code FROM permissions').all().map(r => r.code);
  assert.deepEqual(seeded.filter(c => !GUARDS[c] && !NO_ROUTE_YET.includes(c)), [], 'unknown seeded codes');
});

for (const code of Object.keys(GUARDS)) {
  test(`${code}: every role without it gets 403`, async t => {
    const denied = ROLES.filter(role => !granted(role, code));
    if (!denied.length) return t.skip(`granted to every role by default (${GUARDS[code][1]})`);
    for (const role of denied) {
      const r = await hit(role, code);
      assert.ok(isRbacDenial(r), `${role} → ${r.status} ${JSON.stringify(r.body)}`);
    }
  });

  test(`${code}: revoking it from a role that has it → 403; granting it back lifts the denial`, async () => {
    const role = ROLES.find(r => r !== 'sysadmin' && granted(r, code)) || 'sysadmin';
    // Keep SysAdmin able to manage roles (a revoked manage_roles_permissions is restored directly in the DB anyway).
    setGrant(role, code, 0);
    try {
      const r = await hit(role, code);
      assert.ok(isRbacDenial(r), `${role} without ${code} → ${r.status} ${JSON.stringify(r.body)}`);
    } finally {
      setGrant(role, code, 1);
    }
    const r = await hit(role, code);
    assert.ok(!isRbacDenial(r), `${role} with ${code} → ${r.status} ${JSON.stringify(r.body)}`);
  });
}

test('no session → 401 on guarded routes', async () => {
  for (const [code, [m, p, b]] of Object.entries(GUARDS)) {
    const r = await srv.call(null, m, p, b);
    // Mutating requests without a session have no CSRF cookie either, so 403 from CSRF is also a refusal.
    assert.ok(r.status === 401 || (m !== 'GET' && r.status === 403), `${code} ${m} ${p} → ${r.status}`);
  }
});
