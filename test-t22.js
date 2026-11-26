'use strict';

/**
 * test-t22.js — T-22 Incident Review, Classify, and Restrict
 * Run: node test-t22.js   (exit 0 = all pass)
 *
 * tasks.md Test line:
 *   Classify Submitted → severity set, status Under Review.
 *   Submitted → Assigned → 422. Teacher closes → 403. Restrict → not in Teacher list.
 */

const { upsertUser, createHarness } = require('./test-support');
const { db, check, login, call, createIncident, listIds, run } = createHarness(3092);

const ADMIN    = upsertUser('t22_admin',    'sysadmin',      'T22 Admin');
const HEAD     = upsertUser('t22_head',     'schoolhead',    'T22 School Head');
const TEACHER  = upsertUser('t22_teacher',  'teacher',       'T22 Teacher');
const SAFETY   = upsertUser('t22_safety',   'safetyofficer', 'T22 Safety Officer');
const SAFETY2  = upsertUser('t22_safety2',  'safetyofficer', 'T22 Safety Officer Two');
const GUIDANCE = upsertUser('t22_guidance', 'guidance',      'T22 Guidance');

// T-24 (assign) is not built yet, so tests that need an assignee insert the row directly.
function assignDirect(incidentId, userId, byId) {
  db.prepare(`INSERT INTO incident_assignments (incident_id, assigned_to, assigned_by) VALUES (?, ?, ?)`)
    .run(incidentId, userId, byId);
}
function statusOf(id) { return db.prepare('SELECT status, severity FROM incidents WHERE id = ?').get(id); }
function lastEntry(id) {
  return db.prepare('SELECT * FROM incident_activity_log WHERE incident_id = ? ORDER BY id DESC LIMIT 1').get(id);
}
function lastAudit(action, id) {
  return db.prepare('SELECT * FROM audit_logs WHERE action_type = ? AND target_id = ? ORDER BY id DESC LIMIT 1')
    .get(action, id);
}

run('T-22 Incident Review, Classify, and Restrict', async () => {
  const admin = await login(ADMIN);
  const head = await login(HEAD);
  const teacher = await login(TEACHER);
  const safety = await login(SAFETY);
  const safety2 = await login(SAFETY2);
  const guidance = await login(GUIDANCE);

  const incA = await createIncident(teacher, 'T22 A classify');
  const incB = await createIncident(teacher, 'T22 B transitions');
  const incC = await createIncident(teacher, 'T22 C restrict');
  const incD = await createIncident(teacher, 'T22 D close');
  const created = [incA, incB, incC, incD];

  // ── Test line 1: classify Submitted → severity set, Under Review ──
  let r = await call(head, 'PATCH', `/api/incidents/${incA}/classify`, { severity: 'High' });
  check('Classify Submitted → 200', r.status === 200, `${r.status} ${JSON.stringify(r.body)}`);
  check('Severity High and status Under Review', statusOf(incA).severity === 'High' && statusOf(incA).status === 'Under Review',
    JSON.stringify(statusOf(incA)));
  let e = lastEntry(incA);
  check('Timeline: Status Change Submitted → Under Review', e.entry_type === 'Status Change'
    && e.old_status === 'Submitted' && e.new_status === 'Under Review', JSON.stringify(e));
  let a = lastAudit('INCIDENT_CLASSIFIED', incA);
  check('Audit: INCIDENT_CLASSIFIED with old and new values',
    a && JSON.parse(a.old_values).status === 'Submitted' && JSON.parse(a.new_values).severity === 'High');

  r = await call(head, 'PATCH', `/api/incidents/${incA}/classify`, { severity: 'Critical' });
  check('Re-classify Under Review → 200, status unchanged', r.status === 200
    && statusOf(incA).severity === 'Critical' && statusOf(incA).status === 'Under Review');
  check('Re-classify adds a Note entry', lastEntry(incA).entry_type === 'Note');
  r = await call(head, 'PATCH', `/api/incidents/${incA}/classify`, { severity: 'Extreme' });
  check('Invalid severity → 400', r.status === 400, `${r.status}`);
  r = await call(teacher, 'PATCH', `/api/incidents/${incA}/classify`, { severity: 'Low' });
  check('Teacher classify → 403', r.status === 403, `${r.status}`);

  // ── Test line 2: Submitted → Assigned → 422 ──
  r = await call(head, 'PATCH', `/api/incidents/${incB}/status`, { status: 'Assigned' });
  check('Submitted → Assigned → 422', r.status === 422 && /invalid transition/i.test(r.body.error),
    `${r.status} ${JSON.stringify(r.body)}`);
  r = await call(head, 'PATCH', `/api/incidents/${incB}/status`, { status: 'Closed' });
  check('Submitted → Closed (skipping steps) → 422 invalid transition', r.status === 422 && /invalid transition/i.test(r.body.error));
  r = await call(head, 'PATCH', `/api/incidents/${incB}/status`, { status: 'Sleeping' });
  check('Unknown status → 400', r.status === 400);

  // Under Review without severity: assignment refused
  r = await call(safety, 'PATCH', `/api/incidents/${incB}/status`, { status: 'Under Review' });
  check('SafetyOff Submitted → Under Review → 200', r.status === 200 && statusOf(incB).status === 'Under Review',
    `${r.status} ${JSON.stringify(r.body)}`);
  r = await call(head, 'PATCH', `/api/incidents/${incB}/status`, { status: 'Assigned' });
  check('Under Review → Assigned with no severity → 422 severity required',
    r.status === 422 && /severity must be set before assignment/i.test(r.body.error), JSON.stringify(r.body));

  // Response transitions (assignee inserted directly; T-24 builds assign)
  db.prepare("UPDATE incidents SET severity = 'Moderate', status = 'Assigned' WHERE id = ?").run(incB);
  assignDirect(incB, SAFETY.id, HEAD.id);
  r = await call(safety2, 'PATCH', `/api/incidents/${incB}/status`, { status: 'In Progress' });
  check('Unassigned SafetyOff Assigned → In Progress → 403 with spec message',
    r.status === 403 && r.body.error === 'You do not have permission to perform this status change.', JSON.stringify(r.body));
  r = await call(safety, 'PATCH', `/api/incidents/${incB}/status`, { status: 'In Progress' });
  check('Assigned SafetyOff Assigned → In Progress → 200', r.status === 200 && statusOf(incB).status === 'In Progress');
  r = await call(safety, 'PATCH', `/api/incidents/${incB}/status`, { status: 'For Follow-Up' });
  check('In Progress → For Follow-Up → 200', r.status === 200 && statusOf(incB).status === 'For Follow-Up');
  r = await call(safety, 'PATCH', `/api/incidents/${incB}/status`, { status: 'Resolved' });
  check('Resolved without summary → 422 with spec message',
    r.status === 422 && r.body.error === 'A resolution summary is required to mark this incident as Resolved.', JSON.stringify(r.body));
  r = await call(safety, 'PATCH', `/api/incidents/${incB}/status`, { status: 'Resolved', resolution_summary: '  Witnesses interviewed; area made safe.  ' });
  const resolved = db.prepare('SELECT status, resolution_summary FROM incidents WHERE id = ?').get(incB);
  check('Resolved with summary → 200, summary stored', r.status === 200 && resolved.status === 'Resolved'
    && resolved.resolution_summary === 'Witnesses interviewed; area made safe.', JSON.stringify(resolved));
  e = lastEntry(incB);
  check('Timeline: Resolution entry shows the summary', e.entry_type === 'Resolution' && e.description.includes('area made safe'));
  const statusAudits = db.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action_type = 'INCIDENT_STATUS_CHANGED' AND target_id = ?").get(incB).n;
  check('Audit: one INCIDENT_STATUS_CHANGED per transition (4)', statusAudits === 4, `${statusAudits}`);

  // ── Test line 3: Teacher closes → 403 ──
  db.prepare("UPDATE incidents SET severity = 'Low', status = 'Resolved' WHERE id = ?").run(incD);
  r = await call(teacher, 'PATCH', `/api/incidents/${incD}/status`, { status: 'Closed' });
  check('Teacher closes → 403', r.status === 403, `${r.status} ${JSON.stringify(r.body)}`);
  r = await call(head, 'PATCH', `/api/incidents/${incD}/status`, { status: 'Closed' });
  check('SchHead Resolved → Closed without closure summary → 422', r.status === 422 && statusOf(incD).status === 'Resolved');

  // ── Test line 4: Restrict → not in Teacher list ──
  r = await call(teacher, 'GET', '/api/incidents');
  check('Before restrict: incident C in Teacher list', listIds(r).includes(incC));
  r = await call(safety, 'PATCH', `/api/incidents/${incC}/restrict`, { is_restricted: true });
  check('SafetyOff restrict → 403', r.status === 403, `${r.status}`);
  r = await call(head, 'PATCH', `/api/incidents/${incC}/restrict`, { is_restricted: 'yes' });
  check('Invalid is_restricted → 400', r.status === 400);
  r = await call(head, 'PATCH', `/api/incidents/${incC}/restrict`, { is_restricted: true });
  check('SchHead restrict → 200, is_restricted = 1', r.status === 200 && r.body.is_restricted === 1);
  r = await call(teacher, 'GET', '/api/incidents');
  check('Restrict → not in Teacher (reporter) list', !listIds(r).includes(incC));
  r = await call(teacher, 'GET', `/api/incidents/${incC}`);
  check('Restricted: Teacher detail → 403', r.status === 403);
  r = await call(safety, 'GET', '/api/incidents');
  check('Restricted: not in unassigned SafetyOff list', !listIds(r).includes(incC));
  r = await call(admin, 'GET', '/api/incidents');
  check('Restricted: still in SysAdmin list', listIds(r).includes(incC));

  assignDirect(incC, GUIDANCE.id, HEAD.id);
  assignDirect(incC, SAFETY.id, HEAD.id);
  r = await call(guidance, 'GET', '/api/incidents');
  check('Restricted: assigned Guidance sees it in list', listIds(r).includes(incC));
  r = await call(safety, 'GET', '/api/incidents');
  check('Restricted: assigned SafetyOff sees it in list', listIds(r).includes(incC));

  e = lastEntry(incC);
  a = lastAudit('INCIDENT_RESTRICTION_CHANGED', incC);
  check('Timeline: Restriction Change entry', e.entry_type === 'Restriction Change');
  check('Audit: restriction change with reference, old and new value',
    a && JSON.parse(a.old_values).is_restricted === 0 && JSON.parse(a.new_values).is_restricted === 1
      && JSON.parse(a.new_values).reference_number);

  r = await call(head, 'PATCH', `/api/incidents/${incC}/restrict`, { is_restricted: false });
  r = await call(teacher, 'GET', '/api/incidents');
  check('Unrestrict → back in Teacher list', listIds(r).includes(incC));

  // Cleanup: archive the fake incidents so they stay out of normal lists
  db.prepare(`UPDATE incidents SET is_archived = 1 WHERE id IN (${created.join(',')})`).run();
});
