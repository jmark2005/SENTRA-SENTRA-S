'use strict';

/**
 * test-t23.js — T-23 Incident Archive and Restore
 * Run: node test-t23.js   (exit 0 = all pass)
 *
 * tasks.md Test line:
 *   Archive without confirmed:true → 400. Archive with confirmed:true → hidden from
 *   all lists. Restore → visible again.
 */

const { upsertUser, createHarness } = require('./test-support');
const { db, check, login, call, createIncident, listIds, run } = createHarness(3093);

const ADMIN    = upsertUser('t23_admin',    'sysadmin',      'T23 Admin');
const HEAD     = upsertUser('t23_head',     'schoolhead',    'T23 School Head');
const TEACHER  = upsertUser('t23_teacher',  'teacher',       'T23 Teacher');
const SAFETY   = upsertUser('t23_safety',   'safetyofficer', 'T23 Safety Officer');
const GUIDANCE = upsertUser('t23_guidance', 'guidance',      'T23 Guidance');

function row(id) { return db.prepare('SELECT status, is_archived FROM incidents WHERE id = ?').get(id); }
function lastEntry(id) {
  return db.prepare('SELECT * FROM incident_activity_log WHERE incident_id = ? ORDER BY id DESC LIMIT 1').get(id);
}

run('T-23 Incident Archive and Restore', async () => {
  const admin = await login(ADMIN);
  const head = await login(HEAD);
  const teacher = await login(TEACHER);
  const safety = await login(SAFETY);
  const guidance = await login(GUIDANCE);

  const inc = await createIncident(teacher, 'T23 archive');
  // Put it mid-workflow with the Guidance user assigned, so every role can see it
  db.prepare("UPDATE incidents SET severity = 'Moderate', status = 'In Progress' WHERE id = ?").run(inc);
  db.prepare('INSERT INTO incident_assignments (incident_id, assigned_to, assigned_by) VALUES (?, ?, ?)')
    .run(inc, GUIDANCE.id, HEAD.id);

  const everyone = [['SysAdmin', admin], ['SchHead', head], ['Teacher', teacher], ['SafetyOff', safety], ['Guidance', guidance]];
  for (const [name, s] of everyone) {
    const r = await call(s, 'GET', '/api/incidents');
    check(`Before archive: in ${name} list`, listIds(r).includes(inc));
  }

  // Permission checks
  let r = await call(head, 'PATCH', `/api/incidents/${inc}/archive`, { confirmed: true });
  check('SchHead archive → 403', r.status === 403, `${r.status}`);
  r = await call(teacher, 'PATCH', `/api/incidents/${inc}/archive`, { confirmed: true });
  check('Teacher archive → 403', r.status === 403, `${r.status}`);

  // ── Test line 1: archive non-Closed without confirmed:true → 400 ──
  r = await call(admin, 'PATCH', `/api/incidents/${inc}/archive`, {});
  check('Archive without confirmed:true → 400', r.status === 400 && row(inc).is_archived === 0,
    `${r.status} ${JSON.stringify(r.body)}`);
  r = await call(admin, 'PATCH', `/api/incidents/${inc}/archive`);
  check('Archive with no body → 400', r.status === 400, `${r.status}`);
  r = await call(admin, 'PATCH', `/api/incidents/${inc}/archive`, { confirmed: 'true' });
  check('confirmed must be boolean true ("true" string → 400)', r.status === 400, `${r.status}`);

  // ── Test line 2: archive with confirmed:true → hidden from all lists ──
  r = await call(admin, 'PATCH', `/api/incidents/${inc}/archive`, { confirmed: true });
  check('Archive with confirmed:true → 200', r.status === 200 && row(inc).is_archived === 1,
    `${r.status} ${JSON.stringify(r.body)}`);
  check('Status unchanged by archive', row(inc).status === 'In Progress');
  for (const [name, s] of everyone) {
    r = await call(s, 'GET', '/api/incidents');
    check(`Archived: hidden from ${name} list`, !listIds(r).includes(inc));
  }
  r = await call(guidance, 'GET', `/api/incidents/${inc}`);
  check('Archived: assigned Guidance detail → 403', r.status === 403);
  r = await call(admin, 'GET', '/api/incidents/archived');
  check('Archived: listed in GET /api/incidents/archived for SysAdmin', listIds(r).includes(inc));
  r = await call(head, 'GET', '/api/incidents/archived');
  check('GET /api/incidents/archived as SchHead → 403', r.status === 403);
  r = await call(admin, 'PATCH', `/api/incidents/${inc}/archive`, { confirmed: true });
  check('Archive again → 422 already archived', r.status === 422);
  r = await call(admin, 'PATCH', `/api/incidents/${inc}/classify`, { severity: 'High' });
  check('Archived: workflow changes refused (classify → 422)', r.status === 422);
  check('Timeline: Archive entry', lastEntry(inc).entry_type === 'Archive');
  const archAudit = db.prepare("SELECT * FROM audit_logs WHERE action_type = 'INCIDENT_ARCHIVED' AND target_id = ? ORDER BY id DESC LIMIT 1").get(inc);
  check('Audit: INCIDENT_ARCHIVED', !!archAudit && JSON.parse(archAudit.new_values).is_archived === 1);

  // ── Test line 3: restore → visible again ──
  r = await call(head, 'PATCH', `/api/incidents/${inc}/restore`);
  check('SchHead restore → 403', r.status === 403, `${r.status}`);
  r = await call(admin, 'PATCH', `/api/incidents/${inc}/restore`);
  check('SysAdmin restore → 200', r.status === 200 && row(inc).is_archived === 0, `${r.status} ${JSON.stringify(r.body)}`);
  check('Restore returns the incident to its last status (In Progress)', row(inc).status === 'In Progress');
  for (const [name, s] of everyone) {
    r = await call(s, 'GET', '/api/incidents');
    check(`Restored: back in ${name} list`, listIds(r).includes(inc));
  }
  r = await call(admin, 'PATCH', `/api/incidents/${inc}/restore`);
  check('Restore again → 422 not archived', r.status === 422);
  check('Timeline: Restore entry', lastEntry(inc).entry_type === 'Restore');
  const restAudit = db.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action_type = 'INCIDENT_RESTORED' AND target_id = ?").get(inc).n;
  check('Audit: INCIDENT_RESTORED', restAudit === 1, `${restAudit}`);

  // A Closed incident archives without confirmation
  const closed = await createIncident(teacher, 'T23 closed');
  db.prepare("UPDATE incidents SET severity = 'Low', status = 'Closed' WHERE id = ?").run(closed);
  r = await call(admin, 'PATCH', `/api/incidents/${closed}/archive`, {});
  check('Closed incident archives without confirmed → 200', r.status === 200 && row(closed).is_archived === 1,
    `${r.status} ${JSON.stringify(r.body)}`);

  // Cleanup: archive the fake incidents
  db.prepare('UPDATE incidents SET is_archived = 1 WHERE id IN (?, ?)').run(inc, closed);
});
