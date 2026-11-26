'use strict';

/**
 * test-t24.js — T-24 Assignment, Acknowledgement, and Actions
 * Run: node test-t24.js   (exit 0 = all pass)
 *
 * tasks.md Test line:
 *   Assign → notification. Acknowledge → In Progress.
 *   Add action with follow-up date → timeline has 4 entries in order.
 *
 * Note on the count: T-22 requires a timeline entry when an incident is
 * reviewed (Submitted → Under Review), and assignment is only possible after
 * review. So the timeline holds Submitted, the review entry, then the 3 entries
 * this task adds — 5 in all. The test checks all 5 are present and in order.
 */

const { upsertUser, createHarness } = require('./test-support');
const workflow = require('./src/services/incident-workflow.service');
const { db, check, login, call, createIncident, listIds, run } = createHarness(3094);

const ADMIN    = upsertUser('t24_admin',    'sysadmin',      'T24 Admin');
const HEAD     = upsertUser('t24_head',     'schoolhead',    'T24 School Head');
const TEACHER  = upsertUser('t24_teacher',  'teacher',       'T24 Teacher');
const TEACHER2 = upsertUser('t24_teacher2', 'teacher',       'T24 Assigned Teacher');
const SAFETY   = upsertUser('t24_safety',   'safetyofficer', 'T24 Safety Officer');
const GUIDANCE = upsertUser('t24_guidance', 'guidance',      'T24 Guidance');
const INACTIVE = upsertUser('t24_inactive', 'teacher',       'T24 Inactive Teacher');
db.prepare("UPDATE users SET status = 'Inactive' WHERE id = ?").run(INACTIVE.id);

function inc(id) { return db.prepare('SELECT * FROM incidents WHERE id = ?').get(id); }
function entries(id) {
  return db.prepare('SELECT * FROM incident_activity_log WHERE incident_id = ? ORDER BY id ASC').all(id);
}
function tomorrow() {
  const [y, m, d] = workflow.schoolClock().date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}
function yesterday() {
  const [y, m, d] = workflow.schoolClock().date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

run('T-24 Assignment, Acknowledgement, and Actions', async () => {
  const admin = await login(ADMIN);
  const head = await login(HEAD);
  const teacher = await login(TEACHER);
  const teacher2 = await login(TEACHER2);
  const safety = await login(SAFETY);
  const guidance = await login(GUIDANCE);

  // ── Test line, on a clean incident ──
  const main = await createIncident(teacher, 'T24 main');
  await call(head, 'PATCH', `/api/incidents/${main}/classify`, { severity: 'High' });
  const ref = inc(main).reference_number;

  let r = await call(head, 'POST', `/api/incidents/${main}/assign`, { user_ids: [SAFETY.id] });
  check('SchHead assigns Under Review incident → 200, status Assigned',
    r.status === 200 && inc(main).status === 'Assigned', `${r.status} ${JSON.stringify(r.body)}`);
  const note = db.prepare("SELECT * FROM notifications WHERE user_id = ? AND type = 'New Assignment' ORDER BY id DESC LIMIT 1").get(SAFETY.id);
  check('Assign → SafetyOff gets "New Assignment" notification with the reference',
    note && note.message === `You have been assigned to incident ${ref}.`, JSON.stringify(note));

  r = await call(safety, 'POST', `/api/incidents/${main}/acknowledge`);
  check('Acknowledge → 200, status In Progress', r.status === 200 && inc(main).status === 'In Progress',
    `${r.status} ${JSON.stringify(r.body)}`);

  const followUp = tomorrow();
  const remindersBefore = db.prepare("SELECT COUNT(*) n FROM reminder_log WHERE target_table = 'incidents' AND target_id = ?").get(main).n;
  r = await call(safety, 'POST', `/api/incidents/${main}/actions`,
    { description: 'Interviewed witnesses', follow_up_date: followUp });
  check('Add action with follow-up date → 201 with the entry',
    r.status === 201 && r.body.entry_type === 'Action' && r.body.follow_up_date === followUp,
    `${r.status} ${JSON.stringify(r.body)}`);

  r = await call(teacher, 'GET', `/api/incidents/${main}/timeline`);
  const types = (r.body && r.body.data || []).map(e => e.entry_type);
  check('Timeline (reporter) → Submitted, review, Assignment, Acknowledgement, Action in order',
    r.status === 200 && JSON.stringify(types) ===
      JSON.stringify(['Submitted', 'Status Change', 'Assignment', 'Acknowledgement', 'Action']),
    `${r.status} ${JSON.stringify(types)}`);
  const ts = r.body.data.map(e => e.created_at);
  const ids = r.body.data.map(e => e.id);
  check('Timeline entries ordered by time then id',
    ts.every((t, i) => i === 0 || t >= ts[i - 1]) && ids.every((v, i) => i === 0 || v > ids[i - 1]));
  check('Timeline entries carry actor name and role', r.body.data.every(e => e.actor_name && e.actor_role));
  const ack = r.body.data.find(e => e.entry_type === 'Acknowledgement');
  check('Acknowledgement text: "[Actor] acknowledged assignment on [datetime]."',
    /^T24 Safety Officer acknowledged assignment on \d{4}-\d{2}-\d{2} \d{2}:\d{2}\.$/.test(ack.description)
      && ack.old_status === 'Assigned' && ack.new_status === 'In Progress', ack.description);
  const remindersAfter = db.prepare("SELECT COUNT(*) n FROM reminder_log WHERE target_table = 'incidents' AND target_id = ?").get(main).n;
  check('No reminder_log row written by the action (T-26 job does that)', remindersAfter === remindersBefore);
  for (const t of ['INCIDENT_ASSIGNED', 'INCIDENT_ACKNOWLEDGED', 'INCIDENT_ACTION_ADDED']) {
    const n = db.prepare('SELECT COUNT(*) n FROM audit_logs WHERE action_type = ? AND target_id = ?').get(t, main).n;
    check(`Audit: ${t}`, n === 1, `${n}`);
  }

  // ── Assign: rules ──
  const sev = await createIncident(teacher, 'T24 no severity');
  await call(safety, 'PATCH', `/api/incidents/${sev}/status`, { status: 'Under Review' });
  r = await call(head, 'POST', `/api/incidents/${sev}/assign`, { user_ids: [SAFETY.id] });
  check('Assign before severity is set → 422 "severity must be set before assignment"',
    r.status === 422 && /severity must be set before assignment/i.test(r.body.error), JSON.stringify(r.body));

  const multi = await createIncident(teacher, 'T24 multi');
  await call(head, 'PATCH', `/api/incidents/${multi}/classify`, { severity: 'Moderate' });
  r = await call(teacher, 'POST', `/api/incidents/${multi}/assign`, { user_ids: [SAFETY.id] });
  check('Teacher assign → 403', r.status === 403, `${r.status}`);
  r = await call(admin, 'POST', `/api/incidents/${multi}/assign`, { user_ids: [SAFETY.id] });
  check('SysAdmin assign → 403 (School Head only)', r.status === 403, `${r.status}`);
  r = await call(head, 'POST', `/api/incidents/${multi}/assign`, { user_ids: [] });
  check('Empty user_ids → 400', r.status === 400);
  r = await call(head, 'POST', `/api/incidents/${multi}/assign`, { user_ids: [ADMIN.id, INACTIVE.id, 999999999] });
  check('SysAdmin, inactive, or unknown users → 422 naming them',
    r.status === 422 && [ADMIN.id, INACTIVE.id, 999999999].every(id => r.body.error.includes(String(id))), JSON.stringify(r.body));
  check('Refused assignment left status Under Review and no rows',
    inc(multi).status === 'Under Review'
      && db.prepare('SELECT COUNT(*) n FROM incident_assignments WHERE incident_id = ?').get(multi).n === 0);

  r = await call(teacher2, 'GET', '/api/incidents');
  check('Before assignment: incident not in assignee Teacher list', !listIds(r).includes(multi));
  r = await call(head, 'POST', `/api/incidents/${multi}/assign`, { user_ids: [SAFETY.id, TEACHER2.id, SAFETY.id] });
  const rows = db.prepare('SELECT assigned_to FROM incident_assignments WHERE incident_id = ? AND is_active = 1').all(multi);
  check('Assign two people (duplicate id ignored) → 2 active assignments', r.status === 200 && rows.length === 2,
    `${r.status} rows=${rows.length}`);
  const t2note = db.prepare("SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND type = 'New Assignment' AND message LIKE ?")
    .get(TEACHER2.id, `%${inc(multi).reference_number}%`).n;
  check('Each assignee notified', t2note === 1, `${t2note}`);
  r = await call(teacher2, 'GET', '/api/incidents');
  check('After assignment: incident in assignee Teacher list', listIds(r).includes(multi));
  r = await call(head, 'POST', `/api/incidents/${multi}/assign`, { user_ids: [GUIDANCE.id] });
  check('Assign again once Assigned → 422', r.status === 422, `${r.status}`);

  // ── Acknowledge: rules ──
  r = await call(safety, 'POST', `/api/incidents/${multi}/actions`, { description: 'Too early' });
  check('Action while Assigned (before acknowledgement) → 422', r.status === 422, `${r.status}`);
  r = await call(head, 'POST', `/api/incidents/${multi}/acknowledge`);
  check('Unassigned SchHead acknowledge → 403', r.status === 403, `${r.status}`);
  r = await call(guidance, 'POST', `/api/incidents/${multi}/acknowledge`);
  check('Unrelated Guidance acknowledge → 403', r.status === 403, `${r.status}`);
  r = await call(teacher2, 'POST', `/api/incidents/${multi}/acknowledge`);
  check('First assignee acknowledges → In Progress', r.status === 200 && inc(multi).status === 'In Progress');
  r = await call(teacher2, 'POST', `/api/incidents/${multi}/acknowledge`);
  check('Acknowledge twice → 422', r.status === 422, `${r.status}`);
  r = await call(safety, 'POST', `/api/incidents/${multi}/acknowledge`);
  const lastAck = entries(multi).pop();
  check('Second assignee acknowledges → 200, status stays In Progress, no status change on entry',
    r.status === 200 && inc(multi).status === 'In Progress' && lastAck.entry_type === 'Acknowledgement'
      && lastAck.old_status === null, JSON.stringify(lastAck));
  const ackRows = db.prepare('SELECT COUNT(*) n FROM incident_assignments WHERE incident_id = ? AND acknowledged_at IS NOT NULL').get(multi).n;
  check('Both acknowledgements recorded with a timestamp', ackRows === 2, `${ackRows}`);

  // ── Actions: rules ──
  r = await call(teacher, 'POST', `/api/incidents/${multi}/actions`, { description: 'Reporter note' });
  check('Reporter who is not assigned → 403', r.status === 403, `${r.status}`);
  r = await call(safety, 'POST', `/api/incidents/${multi}/actions`, { description: '   ' });
  check('Blank description → 400', r.status === 400, `${r.status}`);
  r = await call(safety, 'POST', `/api/incidents/${multi}/actions`, { description: 'x'.repeat(2001) });
  check('Description over 2000 chars → 400', r.status === 400, `${r.status}`);
  r = await call(safety, 'POST', `/api/incidents/${multi}/actions`, { description: 'Check', follow_up_date: '2026-02-30' });
  check('Impossible follow-up date → 400', r.status === 400, `${r.status}`);
  r = await call(safety, 'POST', `/api/incidents/${multi}/actions`, { description: 'Check', follow_up_date: yesterday() });
  check('Follow-up date in the past → 422', r.status === 422, `${r.status}`);
  r = await call(head, 'POST', `/api/incidents/${multi}/actions`, { description: 'School Head checked in' });
  check('SchHead (not assigned) adds action without a date → 201', r.status === 201 && r.body.follow_up_date === null,
    `${r.status} ${JSON.stringify(r.body)}`);
  await call(safety, 'PATCH', `/api/incidents/${multi}/status`, { status: 'For Follow-Up' });
  r = await call(safety, 'POST', `/api/incidents/${multi}/actions`, { description: 'Follow-up complete' });
  check('Action while For Follow-Up → 201', r.status === 201, `${r.status}`);

  // ── Timeline endpoint access ──
  r = await call(guidance, 'GET', `/api/incidents/${multi}/timeline`);
  check('Timeline for a user who cannot see the incident → 403', r.status === 403, `${r.status}`);
  r = await call(null, 'GET', `/api/incidents/${multi}/timeline`);
  check('Timeline without login → 401', r.status === 401, `${r.status}`);
  r = await call(head, 'GET', '/api/incidents/999999999/timeline');
  check('Timeline for unknown incident → 404', r.status === 404, `${r.status}`);

  // Cleanup: archive the fake incidents
  db.prepare('UPDATE incidents SET is_archived = 1 WHERE id IN (?, ?, ?)').run(main, sev, multi);
});
