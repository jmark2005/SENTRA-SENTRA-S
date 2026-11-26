'use strict';

// reminder_log deduplication in the reminders job (T-26): each due/overdue notice goes out once.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { db, ROOT, makeUser, makeStudent, startServer } = require('./helpers');

const job = require(path.join(ROOT, 'src', 'jobs', 'reminders.job'));
const DAY = 86400000;

let srv, ids;

before(async () => {
  srv = await startServer();
  const head    = await srv.login(makeUser('schoolhead', 'Test School Head'));
  const teacher = await srv.login(makeUser('teacher', 'Test Teacher'));
  const safety  = await srv.login(makeUser('safetyofficer', 'Test Safety Officer'));
  const guidance = makeUser('guidance', 'Test Guidance');
  const today = job.schoolDate(new Date());
  const yesterday = job.schoolDate(new Date(Date.now() - DAY));

  async function inProgress(label) {
    const id = await srv.createIncident(teacher, label);
    await srv.call(head, 'PATCH', `/api/incidents/${id}/classify`, { severity: 'Moderate' });
    await srv.call(head, 'POST', `/api/incidents/${id}/assign`, { user_ids: [safety.user.id] });
    await srv.call(safety, 'POST', `/api/incidents/${id}/acknowledge`);
    return id;
  }

  const incDue = await inProgress('due today');
  const r = await srv.call(safety, 'POST', `/api/incidents/${incDue}/actions`, { description: 'Talked to students', follow_up_date: today });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  // The API refuses past follow-up dates, so the overdue entry is inserted directly.
  const incOver = await inProgress('overdue');
  db.prepare(`INSERT INTO incident_activity_log (incident_id, actor_id, entry_type, description, follow_up_date)
              VALUES (?, ?, 'Action', 'Check back', ?)`).run(incOver, safety.user.id, yesterday);

  const studentId = makeStudent();
  function referral(nextFollowup) {
    const id = Number(db.prepare(`INSERT INTO referrals (student_id, referral_type, referral_date, referring_user, assigned_to, status)
      VALUES (?, 'Academic Assistance', ?, ?, ?, 'Ongoing')`).run(studentId, yesterday, teacher.user.id, guidance.id).lastInsertRowid);
    db.prepare(`INSERT INTO referral_followups (referral_id, actor_id, activity_desc, activity_date, next_followup)
      VALUES (?, ?, 'Check-in', ?, ?)`).run(id, guidance.id, yesterday, nextFollowup);
    return id;
  }
  ids = { incDue, incOver, refDue: referral(today), refOver: referral(yesterday) };
});
after(() => srv.close());

const logRows = (kind, table, id) =>
  db.prepare('SELECT COUNT(*) n FROM reminder_log WHERE kind = ? AND target_table = ? AND target_id = ?').get(kind, table, id).n;

test('first run sends one notice per due or overdue follow-up and logs it', () => {
  const { sent } = job.runOnce();
  const got = sent.map(s => `${s.kind}:${s.target_id}`).sort();
  assert.deepEqual(got, [
    `incident_followup_due:${ids.incDue}`,
    `incident_followup_overdue:${ids.incOver}`,
    `referral_followup_due:${ids.refDue}`,
    `referral_followup_overdue:${ids.refOver}`,
  ].sort());
  assert.equal(logRows('incident_followup_due', 'incidents', ids.incDue), 1);
  assert.equal(logRows('incident_followup_overdue', 'incidents', ids.incOver), 1);
  assert.equal(logRows('referral_followup_due', 'referrals', ids.refDue), 1);
  assert.equal(logRows('referral_followup_overdue', 'referrals', ids.refOver), 1);
  assert.equal(logRows('incident_followup_overdue', 'incidents', ids.incDue), 0, 'due today is not overdue');
});

test('later runs send nothing new (reminder_log dedup)', () => {
  const notes = () => db.prepare('SELECT COUNT(*) n FROM notifications').get().n;
  const before = notes();
  for (let i = 0; i < 3; i++) assert.deepEqual(job.runOnce().sent, []);
  assert.equal(notes(), before, 'no new notifications');
  assert.equal(logRows('incident_followup_due', 'incidents', ids.incDue), 1);
  assert.equal(logRows('referral_followup_overdue', 'referrals', ids.refOver), 1);
});

test('reminder_log holds only the job\'s four notices (the actions API writes none)', () => {
  // The follow-up date was set through POST /actions in setup; only runOnce() writes reminder_log (T-24, T-26).
  assert.equal(db.prepare('SELECT COUNT(*) n FROM reminder_log').get().n, 4);
});
