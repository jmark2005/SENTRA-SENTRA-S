'use strict';

/**
 * test/helpers.js — shared setup for the `npm test` suites (T-35B).
 *
 * Require this BEFORE anything from src/. It:
 *   - points DB_PATH at a fresh temporary SQLite file for this test process
 *     (node --test runs each file in its own process, so files never share a DB),
 *   - runs the migrations and the seed into it (seed output is silenced),
 *   - deletes the temporary files when the process exits.
 * Nothing here reads or writes db/sentra.db or needs a .env file.
 *
 * Then it offers: makeUser(), makeStudent(), startServer() and, per server,
 * login() / call() / createIncident() — every user gets a random password.
 */

const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const crypto = require('crypto');
const http   = require('http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentra-test-'));
process.env.DB_PATH = path.join(tmpDir, 'sentra-test.db');
process.env.COOKIE_SECURE = 'false';      // the tests talk plain HTTP
process.env.DOTENV_CONFIG_QUIET = 'true';
process.env.NODE_ENV = 'test';            // Express skips logging expected 4xx errors (e.g. CSRF refusals)

const ROOT = path.resolve(__dirname, '..');

// Migrations run when db.js is first required; the seed runs on require too.
const quietLog = console.log;
console.log = () => {};
let db;
try {
  db = require(path.join(ROOT, 'src', 'repositories', 'db'));
  require(path.join(ROOT, 'db', 'seeds', 'seed'));
} finally {
  console.log = quietLog;
}

process.on('exit', () => {
  try { db.close(); } catch (_) { /* already closed */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
});

const bcrypt = require('bcryptjs');
let userSeq = 0;

/** Creates an Active user with a random password; returns { id, username, password, role, fullName }. */
function makeUser(role, fullName, extra = {}) {
  const roleRow = db.prepare('SELECT id FROM roles WHERE name = ?').get(role);
  if (!roleRow) throw new Error(`Unknown role ${role}`);
  const username = `${role}_${++userSeq}_${crypto.randomBytes(3).toString('hex')}`;
  const password = crypto.randomBytes(12).toString('base64url') + 'Aa1!';
  const id = Number(db.prepare(`
    INSERT INTO users (username, email, password_hash, full_name, role_id, status, password_reset_required, student_record_id)
    VALUES (?, ?, ?, ?, ?, 'Active', 0, ?)
  `).run(username, `${username}@test.local`, bcrypt.hashSync(password, 4), fullName || username, roleRow.id,
    extra.student_record_id || null).lastInsertRowid);
  return { id, username, password, role, fullName: fullName || username };
}

let studentSeq = 0;
/** Creates an Active student record and returns its id. */
function makeStudent(lastName = 'Testson') {
  const admin = db.prepare("SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name = 'sysadmin' LIMIT 1").get();
  return Number(db.prepare(`
    INSERT INTO students (student_number, last_name, first_name, grade_level, section, school_year, created_by)
    VALUES (?, ?, 'Fake', '10', 'A', '2026-2027', ?)
  `).run(`TS-${process.pid}-${++studentSeq}`, lastName, admin.id).lastInsertRowid);
}

/** Starts the app on a free port. Returns { base, close, login, call, createIncident }. */
async function startServer() {
  const app = require(path.join(ROOT, 'src', 'app'));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const cookiesFrom = res => (res.headers.getSetCookie ? res.headers.getSetCookie() : []).map(c => c.split(';')[0]);
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

  /** Logs `user` in and returns a session { user, cookie, token }. */
  async function login(user) {
    const c = await csrf();
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': c.token, cookie: mergeCookies(c.cookies) },
      body: JSON.stringify({ username: user.username, password: user.password }),
    });
    if (res.status !== 200) throw new Error(`login ${user.role} → ${res.status} ${await res.text()}`);
    const cookie = mergeCookies(c.cookies, cookiesFrom(res));
    const fresh = await csrf(cookie);
    return { user, cookie: mergeCookies(cookie.split('; '), fresh.cookies), token: fresh.token };
  }

  /** JSON request; `session` may be null. Returns { status, body }. */
  async function call(session, method, urlPath, body) {
    const headers = {};
    if (session) { headers.cookie = session.cookie; headers['x-csrf-token'] = session.token; }
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(base + urlPath, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { json = null; }
    return { status: res.status, body: json };
  }

  /** Submits an incident dated two days ago; returns its id. */
  async function createIncident(session, label = 'Test incident') {
    const cat = db.prepare('SELECT id FROM incident_categories WHERE is_active = 1 ORDER BY id LIMIT 1').get();
    const date = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
    const r = await call(session, 'POST', '/api/incidents', {
      category_id: cat.id, incident_date: date, incident_time: '09:00',
      location_text: 'Test corridor', description: `${label} (fake test data)`,
    });
    if (r.status !== 201) throw new Error(`create incident → ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.id;
  }

  return {
    base, login, call, createIncident,
    // fetch keeps connections alive; drop them so the process can exit promptly
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }),
  };
}

module.exports = { db, ROOT, makeUser, makeStudent, startServer };
