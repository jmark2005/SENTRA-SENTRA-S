'use strict';

/**
 * test-t25.js — T-25 Incident Closure
 * Run: node test-t25.js   (exit 0 = all pass)
 *
 * tasks.md Test line:
 *   Close without closure_summary → 422. Close with summary → status=Closed.
 *   Subsequent status change → 422.
 */

const { upsertUser, createHarness } = require('./test-support');
const { db, check, login, call, createIncident, run } = createHarness(3096);

const ADMIN   = upsertUser('t25_admin',   'sysadmin',      'T25 Admin');
const HEAD    = upsertUser('t25_head',    'schoolhead',    'T25 School Head');
const TEACHER = upsertUser('t25_teacher', 'teacher',       'T25 Teacher');
const SAFETY  = upsertUser('t25_safety',  'safetyofficer', 'T25 Safety Officer');
const SAFETY2 = upsertUser('t25_safety2', 'safetyofficer', 'T25 Other Safety Officer');

function inc(id) { return db.prepare('SELECT * FROM incidents WHERE id = ?').get(id); }

// Walk an incident through the API to Resolved with SAFETY assigned.
async function toResolved(s, label) {
  const id = await createIncident(s.teacher, label);
  await call(s.head, 'PATCH', `/api/incidents/${id}/classify`, { severity: 'Moderate' });
  await call(s.head, 'POST', `/api/incidents/${id}/assign`, { user_ids: [SAFETY.id] });
  await call(s.safety, 'POST', `/api/incidents/${id}/acknowledge`);
  await call(s.safety, 'PATCH', `/api/incidents/${id}/status`, { status: 'Resolved', resolution_summary: 'Handled (fake).' });
  if (inc(id).status !== 'Resolved') throw new Error(`setup failed: ${inc(id).status}`);
  return id;
}

run('T-25 Incident Closure', async () => {
  const s = {
    admin: await login(ADMIN), head: await login(HEAD), teacher: await login(TEACHER),
    safety: await login(SAFETY), safety2: await login(SAFETY2),
  };
  const created = [];

  const a = await toResolved(s, 'T25 A');
  created.push(a);

  // ── Test line ──
  let r = await call(s.head, 'PATCH', `/api/incidents/${a}/status`, { status: 'Closed' });
  check('Close without closure_summary → 422', r.status === 422 && /closure summary is required/i.test(r.body.error),
    `${r.status} ${JSON.stringify(r.body)}`);
  r = await call(s.head, 'PATCH', `/api/incidents/${a}/status`, { status: 'Closed', closure_summary: '   ' });
  check('Blank closure_summary → 422', r.status === 422 && inc(a).status === 'Resolved');

  r = await call(s.head, 'PATCH', `/api/incidents/${a}/status`,
    { status: 'Closed', closure_summary: '  Reviewed; no further action needed.  ' });
  const row = inc(a);
  check('Close with summary → 200, status Closed', r.status === 200 && row.status === 'Closed',
    `${r.status} ${JSON.stringify(r.body)}`);
  check('closed_by, closed_at and trimmed closure_summary recorded',
    row.closed_by === HEAD.id && /^\d{4}-\d{2}-\d{2}T/.test(row.closed_at || '')
      && row.closure_summary === 'Reviewed; no further action needed.', JSON.stringify(row));
  check('Detail shows who closed it', r.body.closed_by_name === 'T25 School Head');
  const last = db.prepare('SELECT * FROM incident_activity_log WHERE incident_id = ? ORDER BY id DESC LIMIT 1').get(a);
  check('Timeline: final Closure entry Resolved → Closed with the summary',
    last.entry_type === 'Closure' && last.old_status === 'Resolved' && last.new_status === 'Closed'
      && last.description.includes('no further action needed'), JSON.stringify(last));
  const audit = db.prepare("SELECT * FROM audit_logs WHERE action_type = 'INCIDENT_CLOSED' AND target_id = ?").get(a);
  check('Audit: INCIDENT_CLOSED', audit && JSON.parse(audit.new_values).status === 'Closed');

  for (const to of ['In Progress', 'For Follow-Up', 'Resolved', 'Closed', 'Under Review']) {
    r = await call(s.head, 'PATCH', `/api/incidents/${a}/status`, { status: to, resolution_summary: 'x', closure_summary: 'x' });
    check(`Subsequent status change to ${to} → 422 "incident is closed"`,
      r.status === 422 && /incident is closed/i.test(r.body.error), `${r.status} ${JSON.stringify(r.body)}`);
  }

  // ── Closed is read-only everywhere ──
  r = await call(s.head, 'PATCH', `/api/incidents/${a}/classify`, { severity: 'High' });
  check('Classify on Closed → 422', r.status === 422 && inc(a).severity === 'Moderate');
  r = await call(s.safety, 'POST', `/api/incidents/${a}/actions`, { description: 'late note' });
  check('Add action on Closed → 422', r.status === 422);
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from('%PDF-1.4\n%%EOF\n')], { type: 'application/pdf' }), 'late.pdf');
  const up = await fetch(`http://127.0.0.1:3096/api/incidents/${a}/attachments`, {
    method: 'POST', headers: { cookie: s.head.cookie, 'x-csrf-token': s.head.token }, body: fd,
  });
  check('Upload attachment on Closed → 422', up.status === 422, `${up.status}`);
  const changes = db.prepare('SELECT COUNT(*) n FROM incident_activity_log WHERE incident_id = ? AND id > ?').get(a, last.id).n;
  check('No timeline entries were added after closure', changes === 0, `${changes}`);

  // ── Who may close ──
  const b = await toResolved(s, 'T25 B');
  created.push(b);
  r = await call(s.teacher, 'PATCH', `/api/incidents/${b}/status`, { status: 'Closed', closure_summary: 'x' });
  check('Teacher close → 403', r.status === 403, `${r.status}`);
  r = await call(s.safety2, 'PATCH', `/api/incidents/${b}/status`, { status: 'Closed', closure_summary: 'x' });
  check('Unassigned Safety Officer close → 403', r.status === 403, `${r.status}`);
  r = await call(s.safety, 'PATCH', `/api/incidents/${b}/status`, { status: 'Closed', closure_summary: 'Closed by responder.' });
  check('Assigned Safety Officer close → 200 ("SafetyOff limited")', r.status === 200 && inc(b).status === 'Closed', `${r.status}`);

  const c = await toResolved(s, 'T25 C');
  created.push(c);
  r = await call(s.admin, 'PATCH', `/api/incidents/${c}/status`, { status: 'Closed', closure_summary: 'Closed by admin.' });
  check('SysAdmin close → 200', r.status === 200 && inc(c).closed_by === ADMIN.id, `${r.status}`);

  const d = await createIncident(s.teacher, 'T25 D');
  created.push(d);
  await call(s.head, 'PATCH', `/api/incidents/${d}/classify`, { severity: 'Low' });
  r = await call(s.head, 'PATCH', `/api/incidents/${d}/status`, { status: 'Closed', closure_summary: 'too early' });
  check('Close from Under Review (not Resolved) → 422 invalid transition', r.status === 422 && /invalid transition/i.test(r.body.error));

  // Closed incidents can still be archived (US-2.7: any status)
  r = await call(s.admin, 'PATCH', `/api/incidents/${a}/archive`, {});
  check('Closed incident archives without confirmation', r.status === 200);

  db.prepare(`UPDATE incidents SET is_archived = 1 WHERE id IN (${created.join(',')})`).run();
});
