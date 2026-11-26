'use strict';

/**
 * test-t24b.js — API support for the T-24B Incident Response UI
 * Run: node test-t24b.js   (exit 0 = all pass)
 *
 * The T-24B Test line itself (Workflow A) is a browser test; this covers the
 * two endpoints the UI needs: the Assign picker list and assignments in detail.
 */

const { upsertUser, createHarness } = require('./test-support');
const { db, check, login, call, createIncident, run } = createHarness(3095);

const HEAD     = upsertUser('t24b_head',     'schoolhead',    'T24B School Head');
const ADMIN    = upsertUser('t24b_admin',    'sysadmin',      'T24B Admin');
const TEACHER  = upsertUser('t24b_teacher',  'teacher',       'T24B Teacher');
const SAFETY   = upsertUser('t24b_safety',   'safetyofficer', 'T24B Safety Officer');
const INACTIVE = upsertUser('t24b_inactive', 'guidance',      'T24B Inactive Guidance');
db.prepare("UPDATE users SET status = 'Inactive' WHERE id = ?").run(INACTIVE.id);

run('T-24B API support (assign picker, assignments in detail)', async () => {
  const head = await login(HEAD);
  const teacher = await login(TEACHER);
  const safety = await login(SAFETY);

  let r = await call(head, 'GET', '/api/incidents/assignable-users');
  const users = (r.body && r.body.data) || [];
  const ids = users.map(u => u.id);
  check('SchHead lists assignable users → 200', r.status === 200, `${r.status}`);
  check('List has active Safety Officer and Teacher accounts', ids.includes(SAFETY.id) && ids.includes(TEACHER.id));
  check('List excludes SysAdmin, School Head, inactive and student accounts',
    !ids.includes(ADMIN.id) && !ids.includes(HEAD.id) && !ids.includes(INACTIVE.id)
      && users.every(u => ['safetyofficer', 'guidance', 'teacher'].includes(u.role)));
  check('List returns only id, full_name, role', users.every(u => Object.keys(u).sort().join() === 'full_name,id,role'));
  r = await call(teacher, 'GET', '/api/incidents/assignable-users');
  check('Teacher lists assignable users → 403', r.status === 403, `${r.status}`);

  const inc = await createIncident(teacher, 'T24B detail');
  await call(head, 'PATCH', `/api/incidents/${inc}/classify`, { severity: 'Low' });
  r = await call(head, 'GET', `/api/incidents/${inc}`);
  check('Detail has an empty assignments list before assignment',
    Array.isArray(r.body.assignments) && r.body.assignments.length === 0);
  await call(head, 'POST', `/api/incidents/${inc}/assign`, { user_ids: [SAFETY.id] });
  r = await call(safety, 'GET', `/api/incidents/${inc}`);
  const a = r.body.assignments && r.body.assignments[0];
  check('Detail lists the assignee, role, and pending acknowledgement',
    a && a.assigned_to === SAFETY.id && a.role === 'safetyofficer' && a.acknowledged_at === null, JSON.stringify(a));
  await call(safety, 'POST', `/api/incidents/${inc}/acknowledge`);
  r = await call(safety, 'GET', `/api/incidents/${inc}`);
  check('Detail shows the acknowledgement time', !!r.body.assignments[0].acknowledged_at);

  db.prepare('UPDATE incidents SET is_archived = 1 WHERE id = ?').run(inc);
});
