'use strict';

/**
 * test-t33.js — T-33 Role-Scoped Dashboard API
 * Run: node test-t33.js   (exit 0 = all pass)
 *
 * tasks.md Test line:
 *   Seed data → dashboard API counts match underlying data.
 *   Teacher cannot see another teacher's data.
 */

const { upsertUser, createHarness } = require('./test-support');
const { db, check, login, call, createIncident, run } = createHarness(3105);

const ADMIN    = upsertUser('t33_admin',    'sysadmin',      'T33 Admin');
const TEACHER  = upsertUser('t33_teacher',  'teacher',       'T33 Teacher');
const TEACHER2 = upsertUser('t33_teacher2', 'teacher',       'T33 Other Teacher');
const GUIDANCE = upsertUser('t33_guidance', 'guidance',      'T33 Guidance');
const SAFETY   = upsertUser('t33_safety',   'safetyofficer', 'T33 Safety Officer');
const n = (sql, ...p) => db.prepare(sql).get(...p).n;

run('T-33 Role-Scoped Dashboard API', async () => {
  const admin = await login(ADMIN);
  const teacher = await login(TEACHER);
  const teacher2 = await login(TEACHER2);
  const guidance = await login(GUIDANCE);
  const safety = await login(SAFETY);
  const created = [await createIncident(teacher, 'T33 a'), await createIncident(teacher, 'T33 b')];

  // ── Admin counts match the tables ──
  let r = await call(admin, 'GET', '/api/dashboard/summary');
  const m = r.body.metrics;
  check('SysAdmin → 200 with current term from settings', r.status === 200
    && r.body.school_year === db.prepare("SELECT value FROM system_settings WHERE key='current_school_year'").get().value);
  check('active_students matches', m.active_students === n("SELECT COUNT(*) n FROM students WHERE status='Active'"));
  check('open_incidents matches', m.open_incidents === n("SELECT COUNT(*) n FROM incidents WHERE is_archived=0 AND status<>'Closed'"));
  check('Submitted by status matches', m.open_incidents_by_status.Submitted === n("SELECT COUNT(*) n FROM incidents WHERE is_archived=0 AND status='Submitted'"));
  check('pending by category sums to Submitted', m.pending_incidents_by_category.reduce((a, c) => a + c.count, 0) === m.open_incidents_by_status.Submitted);
  check('pending_referrals matches', m.pending_referrals === n("SELECT COUNT(*) n FROM referrals WHERE is_archived=0 AND status='Pending'"));
  check('pending_accounts matches', m.pending_accounts === n("SELECT COUNT(*) n FROM users WHERE status='Pending'"));

  // ── Teacher scope ──
  r = await call(teacher, 'GET', '/api/dashboard/summary');
  check('Teacher incidents_reported matches their own reports',
    r.body.metrics.incidents_reported.total === n('SELECT COUNT(*) n FROM incidents WHERE reporter_id=? AND is_archived=0', TEACHER.id)
      && r.body.metrics.incidents_reported.total >= 2);
  r = await call(teacher2, 'GET', `/api/dashboard/summary?user_id=${TEACHER.id}`);
  check('Other teacher sees only their own figures (user_id ignored)',
    r.body.metrics.incidents_reported.total === n('SELECT COUNT(*) n FROM incidents WHERE reporter_id=? AND is_archived=0', TEACHER2.id)
      && !('active_students' in r.body.metrics));

  r = await call(guidance, 'GET', '/api/dashboard/summary');
  check('Guidance → referral metrics', r.status === 200 && 'referral_queue' in r.body.metrics);
  r = await call(safety, 'GET', '/api/dashboard/summary');
  check('Safety Officer → assigned-incident metrics', r.status === 200 && 'open_assigned_incidents' in r.body.metrics);
  r = await call(null, 'GET', '/api/dashboard/summary');
  check('No login → 401', r.status === 401);

  db.prepare(`UPDATE incidents SET is_archived = 1 WHERE id IN (${created.join(',')})`).run();
});
