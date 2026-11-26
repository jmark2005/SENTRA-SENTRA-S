'use strict';

// Incident state machine (design.md US-3.4, T-22/T-24/T-25): valid path and refused transitions.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { db, makeUser, startServer } = require('./helpers');

const status = id => db.prepare('SELECT status FROM incidents WHERE id = ?').get(id).status;

let srv, head, teacher, safety, admin;

before(async () => {
  srv = await startServer();
  admin   = await srv.login(makeUser('sysadmin', 'Test Admin'));
  head    = await srv.login(makeUser('schoolhead', 'Test School Head'));
  teacher = await srv.login(makeUser('teacher', 'Test Teacher'));
  safety  = await srv.login(makeUser('safetyofficer', 'Test Safety Officer'));
});
after(() => srv.close());

test('valid path: Submitted → Under Review → Assigned → In Progress → For Follow-Up → In Progress → Resolved → Closed', async () => {
  const id = await srv.createIncident(teacher, 'happy path');
  assert.equal(status(id), 'Submitted');

  let r = await srv.call(head, 'PATCH', `/api/incidents/${id}/classify`, { severity: 'Moderate' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(status(id), 'Under Review');

  r = await srv.call(head, 'POST', `/api/incidents/${id}/assign`, { user_ids: [safety.user.id] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(status(id), 'Assigned');

  r = await srv.call(safety, 'POST', `/api/incidents/${id}/acknowledge`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(status(id), 'In Progress');

  for (const to of ['For Follow-Up', 'In Progress']) {
    r = await srv.call(safety, 'PATCH', `/api/incidents/${id}/status`, { status: to });
    assert.equal(r.status, 200, `${to}: ${JSON.stringify(r.body)}`);
    assert.equal(status(id), to);
  }

  r = await srv.call(safety, 'PATCH', `/api/incidents/${id}/status`, { status: 'Resolved', resolution_summary: 'Area made safe.' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(status(id), 'Resolved');

  r = await srv.call(head, 'PATCH', `/api/incidents/${id}/status`, { status: 'Closed', closure_summary: 'Reviewed.' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(status(id), 'Closed');

  const entries = db.prepare('SELECT entry_type FROM incident_activity_log WHERE incident_id = ? ORDER BY id').all(id).map(e => e.entry_type);
  assert.deepEqual(entries.slice(0, 3), ['Submitted', 'Status Change', 'Assignment']);
  assert.equal(entries.at(-1), 'Closure');
});

test('skipping states is refused with 422 and leaves the status unchanged', async () => {
  const id = await srv.createIncident(teacher, 'skip states');
  for (const to of ['Assigned', 'In Progress', 'Resolved', 'Closed']) {
    const r = await srv.call(head, 'PATCH', `/api/incidents/${id}/status`, { status: to, resolution_summary: 'x', closure_summary: 'x' });
    assert.equal(r.status, 422, `Submitted → ${to}: ${r.status}`);
    assert.equal(status(id), 'Submitted');
  }
});

test('assignment needs a severity (Under Review without severity → 422)', async () => {
  const id = await srv.createIncident(teacher, 'no severity');
  let r = await srv.call(head, 'PATCH', `/api/incidents/${id}/status`, { status: 'Under Review' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await srv.call(head, 'POST', `/api/incidents/${id}/assign`, { user_ids: [safety.user.id] });
  assert.equal(r.status, 422);
  assert.equal(status(id), 'Under Review');
});

test('Resolved needs a resolution summary; Closed needs a closure summary; In Progress → Closed is refused', async () => {
  const id = await srv.createIncident(teacher, 'summaries');
  await srv.call(head, 'PATCH', `/api/incidents/${id}/classify`, { severity: 'Low' });
  await srv.call(head, 'POST', `/api/incidents/${id}/assign`, { user_ids: [safety.user.id] });
  await srv.call(safety, 'POST', `/api/incidents/${id}/acknowledge`);
  assert.equal(status(id), 'In Progress');

  let r = await srv.call(head, 'PATCH', `/api/incidents/${id}/status`, { status: 'Closed', closure_summary: 'x' });
  assert.equal(r.status, 422, 'In Progress → Closed');
  r = await srv.call(safety, 'PATCH', `/api/incidents/${id}/status`, { status: 'Resolved' });
  assert.equal(r.status, 422, 'Resolved without summary');
  assert.equal(status(id), 'In Progress');

  await srv.call(safety, 'PATCH', `/api/incidents/${id}/status`, { status: 'Resolved', resolution_summary: 'Done.' });
  r = await srv.call(head, 'PATCH', `/api/incidents/${id}/status`, { status: 'Closed' });
  assert.equal(r.status, 422, 'Closed without summary');
  assert.equal(status(id), 'Resolved');
});

test('a Closed incident is read-only (any further change → 422)', async () => {
  const id = await srv.createIncident(teacher, 'closed');
  await srv.call(head, 'PATCH', `/api/incidents/${id}/classify`, { severity: 'Low' });
  await srv.call(head, 'POST', `/api/incidents/${id}/assign`, { user_ids: [safety.user.id] });
  await srv.call(safety, 'POST', `/api/incidents/${id}/acknowledge`);
  await srv.call(safety, 'PATCH', `/api/incidents/${id}/status`, { status: 'Resolved', resolution_summary: 'Done.' });
  await srv.call(admin, 'PATCH', `/api/incidents/${id}/status`, { status: 'Closed', closure_summary: 'Done.' });
  assert.equal(status(id), 'Closed');

  for (const to of ['In Progress', 'Resolved', 'Under Review']) {
    const r = await srv.call(head, 'PATCH', `/api/incidents/${id}/status`, { status: to, resolution_summary: 'x' });
    assert.equal(r.status, 422, `Closed → ${to}`);
  }
  const r = await srv.call(head, 'PATCH', `/api/incidents/${id}/classify`, { severity: 'High' });
  assert.equal(r.status, 422, 'classify a Closed incident');
  assert.equal(status(id), 'Closed');
});

test('role rules: a Teacher cannot review or close; an unassigned Safety Officer cannot respond', async () => {
  const id = await srv.createIncident(teacher, 'roles');
  let r = await srv.call(teacher, 'PATCH', `/api/incidents/${id}/status`, { status: 'Under Review' });
  assert.equal(r.status, 403, 'Teacher reviews');

  await srv.call(head, 'PATCH', `/api/incidents/${id}/classify`, { severity: 'Low' });
  const other = await srv.login(makeUser('safetyofficer', 'Other Safety Officer'));
  await srv.call(head, 'POST', `/api/incidents/${id}/assign`, { user_ids: [safety.user.id] });
  r = await srv.call(other, 'POST', `/api/incidents/${id}/acknowledge`);
  assert.ok(r.status === 403 || r.status === 422, `unassigned acknowledges → ${r.status}`);
  assert.equal(status(id), 'Assigned');

  await srv.call(safety, 'POST', `/api/incidents/${id}/acknowledge`);
  await srv.call(safety, 'PATCH', `/api/incidents/${id}/status`, { status: 'Resolved', resolution_summary: 'Done.' });
  r = await srv.call(teacher, 'PATCH', `/api/incidents/${id}/status`, { status: 'Closed', closure_summary: 'x' });
  assert.equal(r.status, 403, 'Teacher closes');
  assert.equal(status(id), 'Resolved');
});
