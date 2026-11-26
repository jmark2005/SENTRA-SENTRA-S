'use strict';

// Referral state machine (US-4.x, T-27/T-28): Pending → Ongoing → Completed | Referred.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { db, makeUser, makeStudent, startServer } = require('./helpers');

const row = id => db.prepare('SELECT status, assigned_to FROM referrals WHERE id = ?').get(id);

let srv, teacher, guidance, head, studentId;

before(async () => {
  srv = await startServer();
  teacher  = await srv.login(makeUser('teacher', 'Test Teacher'));
  guidance = await srv.login(makeUser('guidance', 'Test Guidance'));
  head     = await srv.login(makeUser('schoolhead', 'Test School Head'));
  studentId = makeStudent();
});
after(() => srv.close());

async function submit() {
  // referral_date: yesterday in UTC is never in the future in any school timezone
  const date = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const r = await srv.call(teacher, 'POST', '/api/referrals', {
    student_id: studentId, referral_type: 'Academic Assistance', referral_date: date, remarks: 'Fake test referral.',
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(row(r.body.id).status, 'Pending');
  return r.body.id;
}

test('Pending cannot jump to Completed or Referred, or take follow-ups', async () => {
  const id = await submit();
  let r = await srv.call(guidance, 'PATCH', `/api/referrals/${id}/status`, { status: 'Completed', completion_note: 'x' });
  assert.equal(r.status, 422, 'Pending → Completed');
  r = await srv.call(guidance, 'PATCH', `/api/referrals/${id}/status`, { status: 'Referred', referred_destination: 'x' });
  assert.equal(r.status, 422, 'Pending → Referred');
  r = await srv.call(guidance, 'PATCH', `/api/referrals/${id}/status`, { status: 'Ongoing' });
  assert.equal(r.status, 422, 'Ongoing only through Assign');
  r = await srv.call(head, 'POST', `/api/referrals/${id}/followups`, { activity_desc: 'Check-in' });
  assert.equal(r.status, 422, 'follow-up on Pending');
  assert.equal(row(id).status, 'Pending');
});

test('valid path: assign → Ongoing → follow-up → Completed (note required), then read-only', async () => {
  const id = await submit();
  let r = await srv.call(guidance, 'PATCH', `/api/referrals/${id}/assign`, { user_id: guidance.user.id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(row(id), { status: 'Ongoing', assigned_to: guidance.user.id });

  r = await srv.call(guidance, 'POST', `/api/referrals/${id}/followups`, { activity_desc: 'Met with student.' });
  assert.equal(r.status, 201, JSON.stringify(r.body));

  r = await srv.call(guidance, 'PATCH', `/api/referrals/${id}/status`, { status: 'Completed' });
  assert.equal(r.status, 422, 'Completed without a note');
  r = await srv.call(guidance, 'PATCH', `/api/referrals/${id}/status`, { status: 'Completed', completion_note: 'Support finished.' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(row(id).status, 'Completed');

  r = await srv.call(guidance, 'PATCH', `/api/referrals/${id}/status`, { status: 'Referred', referred_destination: 'Clinic' });
  assert.equal(r.status, 422, 'Completed → Referred');
  r = await srv.call(guidance, 'POST', `/api/referrals/${id}/followups`, { activity_desc: 'Late note' });
  assert.equal(r.status, 422, 'follow-up on Completed');
  r = await srv.call(head, 'PATCH', `/api/referrals/${id}/assign`, { user_id: guidance.user.id });
  assert.equal(r.status, 422, 'reassign a Completed referral');
  assert.equal(row(id).status, 'Completed');
});

test('Ongoing → Referred needs a destination', async () => {
  const id = await submit();
  await srv.call(head, 'PATCH', `/api/referrals/${id}/assign`, { user_id: guidance.user.id });
  let r = await srv.call(guidance, 'PATCH', `/api/referrals/${id}/status`, { status: 'Referred' });
  assert.equal(r.status, 422, 'Referred without destination');
  r = await srv.call(guidance, 'PATCH', `/api/referrals/${id}/status`, { status: 'Referred', referred_destination: 'Division clinic' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(row(id).status, 'Referred');
});

test('a Teacher cannot assign or change status', async () => {
  const id = await submit();
  let r = await srv.call(teacher, 'PATCH', `/api/referrals/${id}/assign`, { user_id: guidance.user.id });
  assert.equal(r.status, 403);
  await srv.call(head, 'PATCH', `/api/referrals/${id}/assign`, { user_id: guidance.user.id });
  r = await srv.call(teacher, 'PATCH', `/api/referrals/${id}/status`, { status: 'Completed', completion_note: 'x' });
  assert.equal(r.status, 403);
  assert.equal(row(id).status, 'Ongoing');
});
