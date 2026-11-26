'use strict';

/**
 * test-t26.js — T-26 Reminders and Overdue Job
 * Run: node test-t26.js   (exit 0 = all pass)
 *
 * tasks.md Test line:
 *   Incident with follow-up=today → one "due" notice; runOnce() again → none.
 *   Date=yesterday → one "overdue"; run again → none. Same for referral.
 *
 * Referral APIs arrive in T-27/T-28, so referral rows (and a fake student)
 * are inserted directly. Past follow-up dates are refused by the actions API,
 * so the "yesterday" incident entry is inserted directly too.
 */

const { upsertUser, createHarness } = require('./test-support');
const job = require('./src/jobs/reminders.job');
const { db, check, login, call, createIncident, run } = createHarness(3097);

const HEAD     = upsertUser('t26_head',     'schoolhead',    'T26 School Head');
const TEACHER  = upsertUser('t26_teacher',  'teacher',       'T26 Teacher');
const SAFETY   = upsertUser('t26_safety',   'safetyofficer', 'T26 Safety Officer');
const GUIDANCE = upsertUser('t26_guidance', 'guidance',      'T26 Guidance');

const DAY = 86400000;
const today     = job.schoolDate(new Date());
const yesterday = job.schoolDate(new Date(Date.now() - DAY));

function notes(userId, type, like) {
  return db.prepare('SELECT * FROM notifications WHERE user_id = ? AND type = ? AND message LIKE ?')
    .all(userId, type, `%${like}%`);
}
function logRows(kind, table, id) {
  return db.prepare('SELECT * FROM reminder_log WHERE kind = ? AND target_table = ? AND target_id = ?').all(kind, table, id);
}
function sentFor(result, table, ids) {
  return result.sent.filter(s => s.target_table === table && ids.includes(s.target_id));
}

run('T-26 Reminders and Overdue Job', async () => {
  const head = await login(HEAD);
  const teacher = await login(TEACHER);
  const safety = await login(SAFETY);

  async function inProgress(label) {
    const id = await createIncident(teacher, label);
    await call(head, 'PATCH', `/api/incidents/${id}/classify`, { severity: 'Moderate' });
    await call(head, 'POST', `/api/incidents/${id}/assign`, { user_ids: [SAFETY.id] });
    await call(safety, 'POST', `/api/incidents/${id}/acknowledge`);
    return id;
  }
  function insertFollowUp(id, date) {
    db.prepare(`INSERT INTO incident_activity_log (incident_id, actor_id, entry_type, description, follow_up_date)
                VALUES (?, ?, 'Action', 'Check back (fake)', ?)`).run(id, SAFETY.id, date);
  }

  // ── Incidents ──
  const incToday = await inProgress('T26 due today');
  let r = await call(safety, 'POST', `/api/incidents/${incToday}/actions`, { description: 'Spoke with students', follow_up_date: today });
  if (r.status !== 201) throw new Error(`setup action → ${r.status} ${JSON.stringify(r.body)}`);
  const incPast = await inProgress('T26 overdue');
  insertFollowUp(incPast, yesterday);
  const incResolved = await inProgress('T26 resolved');
  insertFollowUp(incResolved, yesterday);
  await call(safety, 'PATCH', `/api/incidents/${incResolved}/status`, { status: 'Resolved', resolution_summary: 'Done (fake).' });
  const incArchived = await inProgress('T26 archived');
  insertFollowUp(incArchived, yesterday);
  db.prepare('UPDATE incidents SET is_archived = 1 WHERE id = ?').run(incArchived);
  const refToday = db.prepare('SELECT reference_number FROM incidents WHERE id = ?').get(incToday).reference_number;
  const refPast  = db.prepare('SELECT reference_number FROM incidents WHERE id = ?').get(incPast).reference_number;

  // ── Referrals (fake student, rows inserted directly) ──
  db.prepare(`INSERT INTO students (student_number, last_name, first_name, grade_level, section, school_year, created_by)
              VALUES ('T26-S-001', 'Testcase', 'Fake', '10', 'A', '2026-2027', ?)
              ON CONFLICT(student_number) DO NOTHING`).run(HEAD.id);
  const studentId = db.prepare("SELECT id FROM students WHERE student_number = 'T26-S-001'").get().id;
  function referral(status, nextFollowup) {
    const id = Number(db.prepare(`INSERT INTO referrals (student_id, referral_type, referral_date, referring_user, assigned_to, status)
      VALUES (?, 'Academic Assistance', ?, ?, ?, ?)`).run(studentId, yesterday, TEACHER.id, GUIDANCE.id, status).lastInsertRowid);
    db.prepare(`INSERT INTO referral_followups (referral_id, actor_id, activity_desc, activity_date, next_followup)
      VALUES (?, ?, 'Check-in meeting (fake)', ?, ?)`).run(id, GUIDANCE.id, yesterday, nextFollowup);
    return id;
  }
  const refDue = referral('Ongoing', today);
  const refOver = referral('Ongoing', yesterday);
  const refDone = referral('Completed', yesterday);

  const incidentIds = [incToday, incPast, incResolved, incArchived];
  const referralIds = [refDue, refOver, refDone];

  // ── Run 1 ──
  const first = job.runOnce();
  check(`runOnce uses the school-timezone date (${first.today})`, first.today === today);

  check('Incident follow-up = today → one "due" reminder_log row',
    logRows('incident_followup_due', 'incidents', incToday).length === 1 && logRows('incident_followup_overdue', 'incidents', incToday).length === 0);
  check('Due notice → assigned Safety Officer notified once',
    notes(SAFETY.id, 'Follow-Up Reminder', refToday).length === 1);
  check('Due notice → School Head notified once', notes(HEAD.id, 'Follow-Up Reminder', refToday).length === 1);

  check('Incident follow-up = yesterday → one "overdue" reminder_log row',
    logRows('incident_followup_overdue', 'incidents', incPast).length === 1 && logRows('incident_followup_due', 'incidents', incPast).length === 0);
  const overdue = notes(SAFETY.id, 'Overdue Action', refPast);
  check('Overdue notice uses the US-3.8 wording and is not an emergency',
    overdue.length === 1 && overdue[0].message === `Follow-up overdue for incident ${refPast} — originally due ${yesterday}. Action pending review.`,
    overdue[0] && overdue[0].message);
  check('Overdue notice → School Head notified once', notes(HEAD.id, 'Overdue Action', refPast).length === 1);
  check('Resolved and archived incidents get no notice',
    sentFor(first, 'incidents', [incResolved, incArchived]).length === 0
      && logRows('incident_followup_overdue', 'incidents', incResolved).length === 0
      && logRows('incident_followup_overdue', 'incidents', incArchived).length === 0);

  check('Referral next follow-up = today → one "due" row, assigned Guidance notified once',
    logRows('referral_followup_due', 'referrals', refDue).length === 1
      && notes(GUIDANCE.id, 'Follow-Up Reminder', `referral #${refDue}.`).length === 1);
  check('Referral next follow-up = yesterday → one "overdue" row, assigned Guidance notified once',
    logRows('referral_followup_overdue', 'referrals', refOver).length === 1
      && notes(GUIDANCE.id, 'Overdue Action', `referral #${refOver} `).length === 1);
  check('Completed referral gets no notice', logRows('referral_followup_overdue', 'referrals', refDone).length === 0);
  check('Referral notices name no student', db.prepare(
    "SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND message LIKE '%Testcase%'").get(GUIDANCE.id).n === 0);

  const audits = db.prepare(`SELECT COUNT(*) n FROM audit_logs WHERE actor_name = 'SYSTEM'
    AND action_type IN ('FOLLOWUP_DUE_NOTICE', 'FOLLOWUP_OVERDUE_NOTICE')
    AND ((target_table = 'incidents' AND target_id IN (?, ?)) OR (target_table = 'referrals' AND target_id IN (?, ?)))`)
    .get(incToday, incPast, refDue, refOver).n;
  check('Audit: one SYSTEM entry per notice (4)', audits === 4, `${audits}`);

  // ── Run 2: nothing new ──
  const notesBefore = db.prepare('SELECT COUNT(*) n FROM notifications').get().n;
  const second = job.runOnce();
  check('runOnce() again → no incident notices', sentFor(second, 'incidents', incidentIds).length === 0,
    JSON.stringify(sentFor(second, 'incidents', incidentIds)));
  check('runOnce() again → no referral notices', sentFor(second, 'referrals', referralIds).length === 0);
  check('runOnce() again → no new notifications at all', db.prepare('SELECT COUNT(*) n FROM notifications').get().n === notesBefore);

  // ── Next day: today's follow-up becomes overdue, once ──
  const tomorrow = new Date(Date.now() + DAY);
  const third = job.runOnce(tomorrow);
  check('Next day → the "due today" incident gets one overdue notice',
    sentFor(third, 'incidents', [incToday]).map(s => s.kind).join() === 'incident_followup_overdue');
  check('Next day → the "due today" referral gets one overdue notice',
    sentFor(third, 'referrals', [refDue]).map(s => s.kind).join() === 'referral_followup_overdue');
  const fourth = job.runOnce(tomorrow);
  check('Next day, run again → none', sentFor(fourth, 'incidents', incidentIds).length === 0
    && sentFor(fourth, 'referrals', referralIds).length === 0);

  // ── Scheduling ──
  job.start();
  job.start(); // second call is a no-op
  job.stop();
  check('start() and stop() run without error', true);

  // Cleanup: archive the fake incidents and referrals so later runs skip them
  db.prepare(`UPDATE incidents SET is_archived = 1 WHERE id IN (${incidentIds.join(',')})`).run();
  db.prepare(`UPDATE referrals SET is_archived = 1 WHERE id IN (${referralIds.join(',')})`).run();
});
