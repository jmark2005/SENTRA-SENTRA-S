'use strict';

/**
 * test-t28.js — T-28 Referral Assignment, Follow-Ups, and Completion
 * Run: node test-t28.js   (exit 0 = all pass)
 *
 * tasks.md Test line:
 *   Pending → Completed (skipping Ongoing) → 422. Add follow-up to Completed → 422.
 *   next_followup set → entry saved, no reminder_log row yet.
 */

const { upsertUser, ensureStudent, createHarness } = require('./test-support');
const { schoolToday } = require('./src/utils/school-time');
const { db, check, login, call, listIds, run } = createHarness(3099);

const ADMIN     = upsertUser('t28_admin',     'sysadmin',      'T28 Admin');
const HEAD      = upsertUser('t28_head',      'schoolhead',    'T28 School Head');
const TEACHER   = upsertUser('t28_teacher',   'teacher',       'T28 Teacher');
const TEACHER2  = upsertUser('t28_teacher2',  'teacher',       'T28 Assigned Teacher');
const GUIDANCE  = upsertUser('t28_guidance',  'guidance',      'T28 Guidance');
const GUIDANCE2 = upsertUser('t28_guidance2', 'guidance',      'T28 Guidance Two');
const SAFETY    = upsertUser('t28_safety',    'safetyofficer', 'T28 Safety Officer');
const STUDENT   = ensureStudent('T28-S-001', 'Fakely', 'Dana');

const DAY = 86400000;
const today     = schoolToday();
const tomorrow  = schoolToday(new Date(Date.now() + 7 * DAY));
const yesterday = schoolToday(new Date(Date.now() - DAY));

function row(id) { return db.prepare('SELECT * FROM referrals WHERE id = ?').get(id); }

run('T-28 Referral Assignment, Follow-Ups, and Completion', async () => {
  const admin = await login(ADMIN);
  const head = await login(HEAD);
  const teacher = await login(TEACHER);
  const teacher2 = await login(TEACHER2);
  const guidance = await login(GUIDANCE);
  const guidance2 = await login(GUIDANCE2);
  const created = [];

  async function submit(type) {
    const r = await call(teacher, 'POST', '/api/referrals', {
      student_id: STUDENT, referral_type: type || 'Guidance Referral', referral_date: today,
      remarks: 'Administrative note (fake).',
    });
    if (r.status !== 201) throw new Error(`submit → ${r.status} ${JSON.stringify(r.body)}`);
    created.push(r.body.id);
    return r.body.id;
  }

  // ── Test line 1: Pending → Completed (skipping Ongoing) → 422 ──
  const a = await submit();
  let r = await call(guidance, 'PATCH', `/api/referrals/${a}/status`, { status: 'Completed', completion_note: 'Done.' });
  check('Pending → Completed (skipping Ongoing) → 422', r.status === 422 && /invalid transition/i.test(r.body.error),
    `${r.status} ${JSON.stringify(r.body)}`);
  r = await call(guidance, 'PATCH', `/api/referrals/${a}/status`, { status: 'Referred', referred_destination: 'X' });
  check('Pending → Referred (skipping Ongoing) → 422', r.status === 422 && row(a).status === 'Pending');
  r = await call(guidance, 'POST', `/api/referrals/${a}/followups`, { activity_desc: 'Too early' });
  check('Follow-up on an unassigned Pending referral → 403/422', r.status === 403 || r.status === 422, `${r.status}`);

  // ── Assign ──
  r = await call(teacher, 'PATCH', `/api/referrals/${a}/assign`, { user_id: GUIDANCE.id });
  check('Teacher assign → 403', r.status === 403, `${r.status}`);
  r = await call(admin, 'PATCH', `/api/referrals/${a}/assign`, { user_id: GUIDANCE.id });
  check('SysAdmin assign → 403 (Guidance or School Head only)', r.status === 403, `${r.status}`);
  r = await call(guidance, 'PATCH', `/api/referrals/${a}/assign`, { user_id: SAFETY.id });
  check('Assign to a Safety Officer → 422', r.status === 422, `${r.status}`);
  r = await call(guidance, 'PATCH', `/api/referrals/${a}/assign`, {});
  check('Assign without user_id → 400', r.status === 400, `${r.status}`);
  r = await call(guidance, 'PATCH', `/api/referrals/${a}/assign`, { user_id: GUIDANCE.id });
  check('Guidance assigns to self → 200, Ongoing', r.status === 200 && r.body.status === 'Ongoing' && r.body.assigned_to === GUIDANCE.id,
    `${r.status} ${JSON.stringify(r.body)}`);
  const note = db.prepare("SELECT * FROM notifications WHERE user_id = ? AND type = 'New Assignment' AND message LIKE ?")
    .get(GUIDANCE.id, `%referral #${a} %`);
  check('Assigned counselor notified', !!note, JSON.stringify(note));
  check('Audit: REFERRAL_ASSIGNED',
    !!db.prepare("SELECT 1 FROM audit_logs WHERE action_type = 'REFERRAL_ASSIGNED' AND target_id = ?").get(a));
  r = await call(guidance2, 'PATCH', `/api/referrals/${a}/assign`, { user_id: GUIDANCE2.id });
  check('Another counselor can no longer reassign it (not visible) → 403', r.status === 403, `${r.status}`);

  // ── Test line 3: next_followup set → entry saved, no reminder_log row yet ──
  const remindersBefore = db.prepare("SELECT COUNT(*) n FROM reminder_log WHERE target_table = 'referrals' AND target_id = ?").get(a).n;
  r = await call(guidance, 'POST', `/api/referrals/${a}/followups`,
    { activity_desc: 'Met student and adviser; set study plan.', activity_date: today, next_followup: tomorrow });
  check('Follow-up with next_followup → 201, entry saved',
    r.status === 201 && r.body.next_followup === tomorrow && r.body.activity_date === today,
    `${r.status} ${JSON.stringify(r.body)}`);
  const saved = db.prepare('SELECT * FROM referral_followups WHERE referral_id = ?').all(a);
  check('Entry is in referral_followups', saved.length === 1 && saved[0].next_followup === tomorrow);
  const remindersAfter = db.prepare("SELECT COUNT(*) n FROM reminder_log WHERE target_table = 'referrals' AND target_id = ?").get(a).n;
  check('No reminder_log row yet (the T-26 job writes it on the due date)', remindersAfter === remindersBefore);
  const fAudit = db.prepare("SELECT * FROM audit_logs WHERE action_type = 'REFERRAL_FOLLOWUP_ADDED' AND target_id = ?").get(a);
  check('Audit: REFERRAL_FOLLOWUP_ADDED without the activity text',
    fAudit && !fAudit.new_values.includes('study plan'));

  // Follow-up validation and who may add them
  r = await call(guidance, 'POST', `/api/referrals/${a}/followups`, { activity_desc: '  ' });
  check('Blank activity → 400', r.status === 400, `${r.status}`);
  r = await call(guidance, 'POST', `/api/referrals/${a}/followups`, { activity_desc: 'x', activity_date: tomorrow });
  check('Activity date in the future → 422', r.status === 422, `${r.status}`);
  r = await call(guidance, 'POST', `/api/referrals/${a}/followups`, { activity_desc: 'x', next_followup: yesterday });
  check('Next follow-up in the past → 422', r.status === 422, `${r.status}`);
  r = await call(guidance, 'POST', `/api/referrals/${a}/followups`, { activity_desc: 'x', next_followup: '2026-13-01' });
  check('Impossible next follow-up date → 400', r.status === 400, `${r.status}`);
  r = await call(teacher, 'POST', `/api/referrals/${a}/followups`, { activity_desc: 'Submitter note' });
  check('Submitting teacher (not assigned) → 403', r.status === 403, `${r.status}`);
  r = await call(head, 'POST', `/api/referrals/${a}/followups`, { activity_desc: 'School Head check-in.' });
  check('School Head adds a follow-up (activity date defaults to today) → 201',
    r.status === 201 && r.body.activity_date === today, `${r.status}`);

  let threw = false;
  try { db.prepare("UPDATE referral_followups SET activity_desc = 'edited' WHERE referral_id = ?").run(a); }
  catch (e) { threw = /append-only/.test(e.message); }
  check('Editing referral_followups in the DB → RAISE(ABORT) trigger', threw);

  r = await call(guidance, 'GET', `/api/referrals/${a}`);
  check('Assigned counselor sees both follow-ups', r.status === 200 && r.body.followups.length === 2);
  r = await call(teacher, 'GET', `/api/referrals/${a}`);
  check('Submitting teacher sees status Ongoing but not the follow-ups',
    r.body.status === 'Ongoing' && r.body.limited_view === true && !('followups' in r.body));

  // ── Complete ──
  r = await call(guidance2, 'PATCH', `/api/referrals/${a}/status`, { status: 'Completed', completion_note: 'x' });
  check('Unassigned counselor completes → 403', r.status === 403, `${r.status}`);
  r = await call(guidance, 'PATCH', `/api/referrals/${a}/status`, { status: 'Completed' });
  check('Completed without completion note → 422 "Completion note is required"',
    r.status === 422 && r.body.error === 'Completion note is required.', JSON.stringify(r.body));
  r = await call(guidance, 'PATCH', `/api/referrals/${a}/status`, { status: 'Ongoing' });
  check('status Ongoing via /status → 422 (use assign)', r.status === 422);
  r = await call(guidance, 'PATCH', `/api/referrals/${a}/status`,
    { status: 'Completed', completion_note: 'Study plan in place; grades improving.' });
  check('Completed with note → 200', r.status === 200 && row(a).status === 'Completed'
    && row(a).completion_note === 'Study plan in place; grades improving.', `${r.status}`);

  // ── Test line 2: add follow-up to Completed → 422 ──
  r = await call(guidance, 'POST', `/api/referrals/${a}/followups`, { activity_desc: 'One more' });
  check('Add follow-up to Completed → 422', r.status === 422 && /read-only/i.test(r.body.error), JSON.stringify(r.body));
  r = await call(guidance, 'PATCH', `/api/referrals/${a}/assign`, { user_id: GUIDANCE2.id });
  check('Reassign a Completed referral → 422', r.status === 422);
  r = await call(guidance, 'PATCH', `/api/referrals/${a}/status`, { status: 'Referred', referred_destination: 'X' });
  check('Status change on Completed → 422', r.status === 422);
  check('Audit: REFERRAL_STATUS_CHANGED without the note text', (() => {
    const x = db.prepare("SELECT * FROM audit_logs WHERE action_type = 'REFERRAL_STATUS_CHANGED' AND target_id = ?").get(a);
    return x && JSON.parse(x.new_values).status === 'Completed' && !x.new_values.includes('grades improving');
  })());

  // ── Referred, and a Teacher assignee ──
  const b = await submit('Attendance-Related Follow-Up');
  r = await call(head, 'PATCH', `/api/referrals/${b}/assign`, { user_id: TEACHER2.id });
  check('School Head assigns a Teacher → 200, Ongoing', r.status === 200 && row(b).assigned_to === TEACHER2.id);
  r = await call(teacher2, 'GET', '/api/referrals');
  check('Assigned teacher sees it in their list', listIds(r).includes(b));
  r = await call(teacher2, 'POST', `/api/referrals/${b}/followups`, { activity_desc: 'Checked attendance with class.' });
  check('Assigned teacher adds a follow-up → 201', r.status === 201, `${r.status}`);
  r = await call(teacher2, 'PATCH', `/api/referrals/${b}/status`, { status: 'Completed', completion_note: 'x' });
  check('Assigned teacher cannot complete (Guidance/School Head only) → 403', r.status === 403, `${r.status}`);
  r = await call(head, 'PATCH', `/api/referrals/${b}/assign`, { user_id: GUIDANCE2.id });
  check('Reassign an Ongoing referral → stays Ongoing with the new owner',
    r.status === 200 && row(b).status === 'Ongoing' && row(b).assigned_to === GUIDANCE2.id);
  r = await call(guidance2, 'PATCH', `/api/referrals/${b}/status`, { status: 'Referred' });
  check('Referred without destination → 422', r.status === 422 && /destination is required/i.test(r.body.error));
  r = await call(guidance2, 'PATCH', `/api/referrals/${b}/status`,
    { status: 'Referred', referred_destination: 'Referred to the division attendance office' });
  check('Referred with destination → 200', r.status === 200 && row(b).status === 'Referred');

  // ── Archive and restore ──
  const c = await submit('Other School-Based Support');
  await call(guidance, 'PATCH', `/api/referrals/${c}/assign`, { user_id: GUIDANCE.id });
  r = await call(guidance, 'PATCH', `/api/referrals/${c}/archive`, { confirmed: true });
  check('Guidance archive → 403', r.status === 403, `${r.status}`);
  r = await call(admin, 'PATCH', `/api/referrals/${c}/archive`, {});
  check('Archive Ongoing without confirmation → 400', r.status === 400, `${r.status}`);
  r = await call(admin, 'PATCH', `/api/referrals/${c}/archive`, { confirmed: true });
  check('Archive Ongoing with confirmed:true → 200', r.status === 200 && row(c).is_archived === 1, `${r.status}`);
  for (const [name, s] of [['SysAdmin', admin], ['School Head', head], ['assigned Guidance', guidance]]) {
    r = await call(s, 'GET', '/api/referrals');
    check(`Archived: hidden from ${name} list`, !listIds(r).includes(c));
  }
  r = await call(admin, 'GET', '/api/referrals/archived');
  check('Archived: listed in /api/referrals/archived for SysAdmin', listIds(r).includes(c));
  r = await call(head, 'GET', '/api/referrals/archived');
  check('/api/referrals/archived as School Head → 403', r.status === 403, `${r.status}`);
  r = await call(admin, 'PATCH', `/api/referrals/${c}/restore`);
  check('Restore → 200, back to its last status (Ongoing)', r.status === 200 && row(c).is_archived === 0 && row(c).status === 'Ongoing');
  r = await call(guidance, 'GET', '/api/referrals');
  check('Restored: back in the assigned counselor\'s list', listIds(r).includes(c));
  r = await call(admin, 'PATCH', `/api/referrals/${a}/archive`, {});
  check('Completed referral archives without confirmation', r.status === 200, `${r.status}`);
  for (const t of ['REFERRAL_ARCHIVED', 'REFERRAL_RESTORED']) {
    check(`Audit: ${t}`, !!db.prepare('SELECT 1 FROM audit_logs WHERE action_type = ? AND target_id = ?').get(t, c));
  }

  // Cleanup: archive the fake referrals
  db.prepare(`UPDATE referrals SET is_archived = 1 WHERE id IN (${created.join(',')})`).run();
});
