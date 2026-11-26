'use strict';

// GET /api/notifications/count (the 30-second badge poll) must not extend the idle session (T-06, T-09B).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { db, makeUser, startServer } = require('./helpers');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let srv;
before(async () => { srv = await startServer(); });
after(() => srv.close());

/** Session id from the signed express-session cookie ("connect.sid=s%3A<sid>.<signature>"). */
function sidOf(session) {
  const raw = session.cookie.split('; ').find(c => c.startsWith('connect.sid=')).slice('connect.sid='.length);
  const value = decodeURIComponent(raw).replace(/^s:/, '');
  return value.slice(0, value.lastIndexOf('.'));
}

async function signIn() {
  const s = await srv.login(makeUser('teacher', 'Test Teacher'));
  const sid = sidOf(s);
  const read = () => JSON.parse(db.prepare('SELECT sess FROM sessions WHERE sid = ?').get(sid).sess);
  const write = sess => db.prepare('UPDATE sessions SET sess = ? WHERE sid = ?').run(JSON.stringify(sess), sid);
  return { s, read, write };
}

test('notification count polls leave last_active alone; a normal request moves it', async () => {
  const { s, read } = await signIn();
  await srv.call(s, 'GET', '/api/auth/me');
  const t0 = read().last_active;
  assert.ok(Number.isFinite(t0), 'last_active set by a normal request');

  await sleep(1100);
  for (let i = 0; i < 10; i++) {
    const r = await srv.call(s, 'GET', '/api/notifications/count');
    assert.equal(r.status, 200);
    assert.equal(typeof r.body.unread_count, 'number');
  }
  assert.equal(read().last_active, t0, 'count calls must not touch last_active');

  const status = await srv.call(s, 'GET', '/api/auth/session-status');
  const idleMinutes = Number(db.prepare("SELECT value FROM system_settings WHERE key = 'session_idle_minutes'").get().value);
  assert.ok(status.body.idle_expires_in_seconds < idleMinutes * 60, 'idle clock kept running');
  assert.equal(read().last_active, t0, 'session-status must not touch last_active either');

  await srv.call(s, 'GET', '/api/auth/me');
  assert.ok(read().last_active > t0, 'a normal request extends the session');
});

test('a session idle past the limit expires even while the badge keeps polling', async () => {
  const { s, read, write } = await signIn();
  await srv.call(s, 'GET', '/api/auth/me');
  const idleMinutes = Number(db.prepare("SELECT value FROM system_settings WHERE key = 'session_idle_minutes'").get().value);
  const sess = read();
  sess.last_active = Date.now() - (idleMinutes * 60 + 5) * 1000; // pretend the user walked away
  write(sess);

  const r = await srv.call(s, 'GET', '/api/notifications/count');
  assert.equal(r.status, 401, `count after idle limit → ${r.status}`);
  const me = await srv.call(s, 'GET', '/api/auth/me');
  assert.equal(me.status, 401, 'session is gone');
});
