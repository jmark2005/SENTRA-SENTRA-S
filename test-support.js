'use strict';

/**
 * test-support.js — shared helpers for the integration tests (test-t22.js on).
 *
 * Creates fake users with random passwords generated per run (never printed),
 * starts the app on a port, and gives each user a session with a CSRF token.
 */

const http   = require('http');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const db = require('./src/repositories/db');

function upsertUser(username, roleName, fullName) {
  const role = db.prepare('SELECT id FROM roles WHERE name = ?').get(roleName);
  if (!role) throw new Error(`Role ${roleName} missing. Run the seed first.`);
  const password = crypto.randomBytes(12).toString('base64url') + 'Aa1!';
  db.prepare(`
    INSERT INTO users (username, email, password_hash, full_name, role_id, status, password_reset_required)
    VALUES (?, ?, ?, ?, ?, 'Active', 0)
    ON CONFLICT(username) DO UPDATE SET
      email = excluded.email, password_hash = excluded.password_hash,
      full_name = excluded.full_name, role_id = excluded.role_id,
      status = 'Active', password_reset_required = 0
  `).run(username, `${username}@test.local`, bcrypt.hashSync(password, 10), fullName, role.id);
  const { id } = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  return { id, username, password, fullName, role: roleName };
}

/** Creates (or reactivates) a fake student record and returns its id. */
function ensureStudent(studentNumber, lastName, firstName) {
  const creator = db.prepare("SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name = 'sysadmin' LIMIT 1").get();
  db.prepare(`
    INSERT INTO students (student_number, last_name, first_name, grade_level, section, school_year, created_by)
    VALUES (?, ?, ?, '10', 'A', '2026-2027', ?)
    ON CONFLICT(student_number) DO UPDATE SET status = 'Active'
  `).run(studentNumber, lastName, firstName, creator ? creator.id : null);
  return db.prepare('SELECT id FROM students WHERE student_number = ?').get(studentNumber).id;
}

function createHarness(port) {
  const app    = require('./src/app');
  const base   = `http://127.0.0.1:${port}`;
  const server = http.createServer(app);
  let passed = 0;
  let failed = 0;

  function check(name, ok, detail) {
    if (ok) { passed++; console.log(`  PASS  ${name}`); }
    else    { failed++; console.error(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
  }

  function cookiesFrom(res) {
    return (res.headers.getSetCookie ? res.headers.getSetCookie() : []).map(c => c.split(';')[0]);
  }
  function mergeCookies(...lists) {
    const map = new Map();
    for (const c of lists.flat()) if (c) map.set(c.split('=')[0], c);
    return [...map.values()].join('; ');
  }

  async function csrf(cookie) {
    const res = await fetch(`${base}/api/csrf-token`, { headers: cookie ? { cookie } : {} });
    const { csrfToken } = await res.json();
    return { token: csrfToken, cookies: cookiesFrom(res) };
  }

  async function login(user) {
    const c = await csrf();
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': c.token, cookie: mergeCookies(c.cookies) },
      body: JSON.stringify({ username: user.username, password: user.password }),
    });
    if (res.status !== 200) throw new Error(`login ${user.username} → ${res.status}`);
    const cookie = mergeCookies(c.cookies, cookiesFrom(res));
    const fresh = await csrf(cookie);
    return { user, cookie: mergeCookies(cookie.split('; '), fresh.cookies), token: fresh.token };
  }

  /** JSON request; session may be null for an anonymous call. */
  async function call(session, method, path, body) {
    const headers = {};
    if (session) { headers.cookie = session.cookie; headers['x-csrf-token'] = session.token; }
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(base + path, {
      method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch (_) { json = null; }
    return { status: res.status, body: json };
  }

  async function createIncident(session, label) {
    const cat  = db.prepare('SELECT id FROM incident_categories WHERE is_active = 1 ORDER BY id LIMIT 1').get();
    const date = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
    const r = await call(session, 'POST', '/api/incidents', {
      category_id: cat.id, incident_date: date, incident_time: '09:00',
      location_text: 'Test corridor (fake)', description: `${label} (fake test data)`,
    });
    if (r.status !== 201) throw new Error(`create incident → ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.id;
  }

  function listIds(r) {
    return (r.body && r.body.data ? r.body.data : []).map(i => i.id);
  }

  function run(title, fn) {
    server.listen(port, async () => {
      console.log(`\n=== ${title} ===\n`);
      try {
        await fn();
      } catch (err) {
        failed++;
        console.error('  FAIL  unexpected error:', err);
      }
      console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
      server.close(() => process.exit(failed ? 1 : 0));
    });
  }

  return { db, check, login, call, createIncident, listIds, run };
}

module.exports = { upsertUser, ensureStudent, createHarness };
