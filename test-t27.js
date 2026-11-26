'use strict';

/**
 * test-t27.js — T-27 Referral Submission and Routing
 * Run: node test-t27.js   (exit 0 = all pass)
 *
 * tasks.md Test line:
 *   Teacher submits → Guidance sees in queue. Teacher cannot see another student's referral.
 * ("another student's referral" is read as a referral the teacher did not submit and is
 * not assigned to — e.g. another teacher's referral for a different student.)
 */

const { upsertUser, ensureStudent, createHarness } = require('./test-support');
const { schoolToday } = require('./src/utils/school-time');
const { db, check, login, call, listIds, run } = createHarness(3098);

const ADMIN     = upsertUser('t27_admin',     'sysadmin',      'T27 Admin');
const HEAD      = upsertUser('t27_head',      'schoolhead',    'T27 School Head');
const TEACHER   = upsertUser('t27_teacher',   'teacher',       'T27 Teacher');
const TEACHER2  = upsertUser('t27_teacher2',  'teacher',       'T27 Other Teacher');
const GUIDANCE  = upsertUser('t27_guidance',  'guidance',      'T27 Guidance');
const GUIDANCE2 = upsertUser('t27_guidance2', 'guidance',      'T27 Guidance Two');
const SAFETY    = upsertUser('t27_safety',    'safetyofficer', 'T27 Safety Officer');

const STUDENT  = ensureStudent('T27-S-001', 'Fakeson', 'Alex');
const STUDENT2 = ensureStudent('T27-S-002', 'Fakeson', 'Bea');
const ARCHIVED = ensureStudent('T27-S-003', 'Fakeson', 'Cy');
db.prepare("UPDATE students SET status = 'Archived' WHERE id = ?").run(ARCHIVED);

const today = schoolToday();
const tomorrow = schoolToday(new Date(Date.now() + 86400000));
const valid = (studentId, extra) => ({
  student_id: studentId, referral_type: 'Academic Assistance', referral_date: today,
  remarks: 'Needs help catching up on missed lessons (fake).', ...extra,
});

run('T-27 Referral Submission and Routing', async () => {
  const admin = await login(ADMIN);
  const head = await login(HEAD);
  const teacher = await login(TEACHER);
  const teacher2 = await login(TEACHER2);
  const guidance = await login(GUIDANCE);
  const guidance2 = await login(GUIDANCE2);
  const safety = await login(SAFETY);
  const created = [];

  // ── Test line part 1: Teacher submits → Guidance sees in queue ──
  const lastNoteId = db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM notifications').get().m;
  let r = await call(teacher, 'POST', '/api/referrals', valid(STUDENT));
  const refA = r.body && r.body.id;
  created.push(refA);
  check('Teacher submits → 201, status Pending, unassigned',
    r.status === 201 && r.body.status === 'Pending' && r.body.assigned_to === null && r.body.referring_user === TEACHER.id,
    `${r.status} ${JSON.stringify(r.body)}`);
  for (const [name, user] of [['Guidance', GUIDANCE], ['Guidance Two', GUIDANCE2]]) {
    // Only notifications created by this run (the test can be re-run)
    const n = db.prepare('SELECT COUNT(*) n FROM notifications WHERE id > ? AND user_id = ? AND message = ?')
      .get(lastNoteId, user.id, 'New referral submitted for T27-S-001 by T27 Teacher.').n;
    check(`${name} notified with the US-4.1 wording`, n === 1, `${n}`);
  }
  r = await call(guidance, 'GET', '/api/referrals');
  check('Guidance sees the Pending referral in the queue', listIds(r).includes(refA));
  r = await call(guidance2, 'GET', '/api/referrals?status=Pending');
  check('Second Guidance user also sees it (unassigned queue)', listIds(r).includes(refA));
  check('List rows carry no remarks', (r.body.data || []).every(row => !('remarks' in row)));
  r = await call(guidance, 'GET', `/api/referrals/${refA}`);
  check('Guidance detail (queue) → full view with remarks and follow-ups list',
    r.status === 200 && r.body.limited_view === false && Array.isArray(r.body.followups) && r.body.remarks.includes('missed lessons'));

  // ── Test line part 2: Teacher cannot see another teacher's referral ──
  r = await call(teacher2, 'POST', '/api/referrals', valid(STUDENT2, { referral_type: 'Attendance-Related Follow-Up' }));
  const refB = r.body && r.body.id;
  created.push(refB);
  r = await call(teacher, 'GET', '/api/referrals');
  check('Teacher list has own referral only', listIds(r).includes(refA) && !listIds(r).includes(refB));
  r = await call(teacher, 'GET', `/api/referrals/${refB}`);
  check('Teacher opening another teacher\'s referral → 403', r.status === 403, `${r.status}`);
  r = await call(teacher2, 'GET', `/api/referrals/${refA}`);
  check('…and the other way round → 403', r.status === 403, `${r.status}`);

  r = await call(teacher, 'GET', `/api/referrals/${refA}`);
  check('Submitter (teacher) detail → status shown, follow-ups hidden',
    r.status === 200 && r.body.limited_view === true && !('followups' in r.body) && r.body.status === 'Pending');

  // ── Other roles ──
  r = await call(head, 'GET', '/api/referrals');
  check('SchHead sees all referrals', listIds(r).includes(refA) && listIds(r).includes(refB));
  r = await call(admin, 'GET', '/api/referrals');
  check('SysAdmin sees all referrals', listIds(r).includes(refA) && listIds(r).includes(refB));
  r = await call(safety, 'POST', '/api/referrals', valid(STUDENT));
  check('Safety Officer submit → 403', r.status === 403, `${r.status}`);
  r = await call(safety, 'GET', '/api/referrals');
  check('Safety Officer list → 403', r.status === 403, `${r.status}`);
  r = await call(head, 'POST', '/api/referrals', valid(STUDENT2, { referral_type: 'Other School-Based Support', remarks: '' }));
  created.push(r.body && r.body.id);
  check('SchHead can submit (no remarks) → 201', r.status === 201 && r.body.remarks === null, `${r.status}`);

  // ── Validation ──
  r = await call(teacher, 'POST', '/api/referrals', valid(undefined));
  check('Missing student → 400', r.status === 400, `${r.status}`);
  r = await call(teacher, 'POST', '/api/referrals', valid(999999999));
  check('Unknown student → 422', r.status === 422, `${r.status}`);
  r = await call(teacher, 'POST', '/api/referrals', valid(ARCHIVED));
  check('Archived student → 422', r.status === 422, `${r.status}`);
  r = await call(teacher, 'POST', '/api/referrals', valid(STUDENT, { referral_type: 'Counseling Session' }));
  check('Unknown referral type → 400', r.status === 400, `${r.status}`);
  r = await call(teacher, 'POST', '/api/referrals', valid(STUDENT, { referral_date: '2026-02-30' }));
  check('Impossible date → 400', r.status === 400, `${r.status}`);
  r = await call(teacher, 'POST', '/api/referrals', valid(STUDENT, { referral_date: tomorrow }));
  check('Future date → 422', r.status === 422, `${r.status}`);
  r = await call(teacher, 'POST', '/api/referrals', valid(STUDENT, { remarks: 'x'.repeat(1001) }));
  check('Remarks over 1000 chars → 400', r.status === 400, `${r.status}`);
  r = await call(teacher, 'GET', '/api/referrals?status=Bogus');
  check('Unknown status filter → 400', r.status === 400, `${r.status}`);

  const audit = db.prepare("SELECT * FROM audit_logs WHERE action_type = 'REFERRAL_SUBMITTED' AND target_id = ?").get(refA);
  check('Audit: REFERRAL_SUBMITTED without the remarks text',
    audit && JSON.parse(audit.new_values).has_remarks === true && !audit.new_values.includes('missed lessons'));

  // ── Routing once assigned (assignment itself is T-28) ──
  db.prepare("UPDATE referrals SET assigned_to = ?, status = 'Ongoing' WHERE id = ?").run(GUIDANCE.id, refA);
  r = await call(guidance2, 'GET', '/api/referrals');
  check('Assigned to another counselor → leaves Guidance Two\'s queue', !listIds(r).includes(refA));
  r = await call(guidance2, 'GET', `/api/referrals/${refA}`);
  check('…and Guidance Two detail → 403', r.status === 403, `${r.status}`);
  r = await call(guidance, 'GET', '/api/referrals');
  check('Assigned counselor still sees it', listIds(r).includes(refA));

  // ── Archived referrals ──
  db.prepare('UPDATE referrals SET is_archived = 1 WHERE id = ?').run(refB);
  for (const [name, s] of [['SysAdmin', admin], ['SchHead', head], ['Teacher Two', teacher2]]) {
    r = await call(s, 'GET', '/api/referrals');
    check(`Archived referral hidden from ${name} list`, !listIds(r).includes(refB));
  }
  r = await call(teacher2, 'GET', `/api/referrals/${refB}`);
  check('Archived referral detail → 403 for its submitter', r.status === 403, `${r.status}`);

  // Cleanup: archive the fake referrals
  db.prepare(`UPDATE referrals SET is_archived = 1 WHERE id IN (${created.filter(Boolean).join(',')})`).run();
});
