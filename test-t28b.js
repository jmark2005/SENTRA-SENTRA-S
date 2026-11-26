'use strict';

/**
 * test-t28b.js — API support for the T-28B Referral Management UI
 * Run: node test-t28b.js   (exit 0 = all pass)
 *
 * The T-28B Test line itself (Workflow B) is a browser test; this covers the
 * endpoint the Assign picker needs.
 */

const { upsertUser, createHarness } = require('./test-support');
const { db, check, login, call, run } = createHarness(3100);

const ADMIN    = upsertUser('t28b_admin',    'sysadmin',      'T28B Admin');
const HEAD     = upsertUser('t28b_head',     'schoolhead',    'T28B School Head');
const TEACHER  = upsertUser('t28b_teacher',  'teacher',       'T28B Teacher');
const GUIDANCE = upsertUser('t28b_guidance', 'guidance',      'T28B Guidance');
const SAFETY   = upsertUser('t28b_safety',   'safetyofficer', 'T28B Safety Officer');
const INACTIVE = upsertUser('t28b_inactive', 'guidance',      'T28B Inactive Guidance');
db.prepare("UPDATE users SET status = 'Inactive' WHERE id = ?").run(INACTIVE.id);

run('T-28B API support (referral assign picker)', async () => {
  const guidance = await login(GUIDANCE);
  const head = await login(HEAD);
  const teacher = await login(TEACHER);
  const admin = await login(ADMIN);

  let r = await call(guidance, 'GET', '/api/referrals/assignable-users');
  const users = (r.body && r.body.data) || [];
  const ids = users.map(u => u.id);
  check('Guidance lists assignable people → 200', r.status === 200, `${r.status}`);
  check('List has active Guidance and Teacher accounts', ids.includes(GUIDANCE.id) && ids.includes(TEACHER.id));
  check('List excludes Safety Officer, SysAdmin, School Head, and inactive accounts',
    !ids.includes(SAFETY.id) && !ids.includes(ADMIN.id) && !ids.includes(HEAD.id) && !ids.includes(INACTIVE.id)
      && users.every(u => u.role === 'guidance' || u.role === 'teacher'));
  check('Guidance accounts are listed first', users.findIndex(u => u.role === 'teacher') > users.findIndex(u => u.role === 'guidance'));
  r = await call(head, 'GET', '/api/referrals/assignable-users');
  check('School Head → 200', r.status === 200, `${r.status}`);
  r = await call(teacher, 'GET', '/api/referrals/assignable-users');
  check('Teacher → 403', r.status === 403, `${r.status}`);
  r = await call(admin, 'GET', '/api/referrals/assignable-users');
  check('SysAdmin → 403 (does not assign referrals)', r.status === 403, `${r.status}`);
});
