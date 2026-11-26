'use strict';

/**
 * test-t41.js — End-to-End Incident Lifecycle (Workflow A, T-41)
 *
 * Run: node test-t41.js
 * Exit 0 = all PASS, 1 = any FAIL.
 *
 * Workflow A steps:
 *  1. Teacher submits → ref generated, status = Submitted
 *  2. SchHead classifies (Critical) → Under Review
 *  3. SchHead assigns SafetyOff → Assigned, notification created
 *  4. SafetyOff acknowledges → In Progress
 *  5. SafetyOff adds action with follow_up_date → timeline has ≥4 entries
 *  6. SchHead resolves without resolution_summary → 422
 *  7. SchHead resolves with resolution_summary → Resolved
 *  8. SchHead closes without closure_summary → 422
 *  9. SchHead closes with closure_summary → Closed
 * 10. Any further status change → 422 "closed"
 * 11. Timeline entries are in chronological order
 * 12. Teacher cannot restrict (403)
 * 13. SchHead restricts → incident disappears from Teacher's list
 */

const http   = require('http');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db     = require('./src/repositories/db');

// ── Helpers ──────────────────────────────────────────────────────────────────

function randomPassword() {
  return crypto.randomBytes(12).toString('base64url') + 'Aa1!';
}
function upsertUser(username, roleName, fullName) {
  const role = db.prepare('SELECT id FROM roles WHERE name = ?').get(roleName);
  if (!role) throw new Error(`Role ${roleName} missing – run the seed first.`);
  const password = randomPassword();
  db.prepare(`
    INSERT INTO users (username, email, password_hash, full_name, role_id, status, password_reset_required)
    VALUES (?, ?, ?, ?, ?, 'Active', 0)
    ON CONFLICT(username) DO UPDATE SET
      email = excluded.email, password_hash = excluded.password_hash,
      full_name = excluded.full_name, role_id = excluded.role_id,
      status = 'Active', password_reset_required = 0
  `).run(username, `${username}@t41.local`, bcrypt.hashSync(password, 10), fullName, role.id);
  return { username, password };
}

const TEACHER  = upsertUser('t41_teacher',  'teacher',       'T41 Teacher');
const SCHHEAD  = upsertUser('t41_schhead',  'schoolhead',    'T41 SchHead');
const SAFETYOF = upsertUser('t41_safety',   'safetyofficer', 'T41 SafetyOff');

const soUser = db.prepare("SELECT id FROM users WHERE username = 't41_safety'").get();
const catRow = db.prepare('SELECT id FROM incident_categories WHERE is_active = 1 LIMIT 1').get();
if (!catRow) { console.error('No active incident categories – run seed.'); process.exit(1); }

// ── Server ────────────────────────────────────────────────────────────────────

const app    = require('./src/app');
const PORT   = 3091;
const BASE   = `http://127.0.0.1:${PORT}`;
const server = http.createServer(app);

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else    { fail++; console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); }
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
  const r = await fetch(`${BASE}/api/csrf-token`, { headers: cookie ? { cookie } : {} });
  const { csrfToken } = await r.json();
  return { token: csrfToken, cookies: cookiesFrom(r) };
}
async function login(user) {
  const c = await csrf();
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': c.token, cookie: mergeCookies(c.cookies) },
    body: JSON.stringify({ username: user.username, password: user.password }),
  });
  if (r.status !== 200) throw new Error(`login ${user.username} → ${r.status}`);
  const cookie = mergeCookies(c.cookies, cookiesFrom(r));
  const fresh  = await csrf(cookie);
  return { cookie: mergeCookies(cookie.split('; '), fresh.cookies), token: fresh.token };
}
async function req(session, method, path, body) {
  const headers = { 'content-type': 'application/json' };
  if (session) { headers.cookie = session.cookie; headers['x-csrf-token'] = session.token; }
  const opts = { method, headers };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(BASE + path, opts);
  let json = null;
  try { json = await r.json(); } catch (_) {}
  return { status: r.status, body: json };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  console.log('\n=== T-41: Incident Lifecycle (Workflow A) ===\n');

  const teacher  = await login(TEACHER);
  const schhead  = await login(SCHHEAD);
  const safetyof = await login(SAFETYOF);

  const today = new Date().toISOString().slice(0, 10);

  // 1. Teacher submits incident
  let r = await req(teacher, 'POST', '/api/incidents', {
    category_id:   catRow.id,
    incident_date: today,
    incident_time: '09:00',
    location_text: 'T41 Test Location',
    description:   'T41 workflow A integration test incident',
  });
  check('POST /api/incidents → 201', r.status === 201, `got ${r.status} ${JSON.stringify(r.body)}`);
  const incident = r.body;
  const incidentId = incident && incident.id;
  check('Reference number generated (INC-…)', incident && /^INC-\d{4}-\d{4}/.test(incident.reference_number), `ref=${incident && incident.reference_number}`);
  check('Status = Submitted', incident && incident.status === 'Submitted', `status=${incident && incident.status}`);

  if (!incidentId) { console.error('Cannot continue without incident id'); fail++; return; }

  // 2. SchHead classifies (Critical)
  r = await req(schhead, 'PATCH', `/api/incidents/${incidentId}/classify`, { severity: 'Critical' });
  check('PATCH /classify → 200', r.status === 200, `got ${r.status} ${JSON.stringify(r.body)}`);
  check('Status → Under Review', r.body && r.body.status === 'Under Review', `status=${r.body && r.body.status}`);
  check('Severity = Critical', r.body && r.body.severity === 'Critical', `severity=${r.body && r.body.severity}`);

  // 3. SchHead assigns SafetyOff
  r = await req(schhead, 'POST', `/api/incidents/${incidentId}/assign`, { user_ids: [soUser.id] });
  check('POST /assign → 200', r.status === 200, `got ${r.status} ${JSON.stringify(r.body)}`);
  check('Status → Assigned', r.body && r.body.status === 'Assigned', `status=${r.body && r.body.status}`);

  // Notification created for SafetyOff
  const notif = db.prepare(`
    SELECT id FROM notifications WHERE user_id = ? AND type = 'New Assignment' AND link LIKE ?
  `).get(soUser.id, `%${incidentId}%`);
  check('SafetyOff notification created', !!notif);

  // 4. SafetyOff acknowledges
  r = await req(safetyof, 'POST', `/api/incidents/${incidentId}/acknowledge`, {});
  check('POST /acknowledge → 200', r.status === 200, `got ${r.status} ${JSON.stringify(r.body)}`);
  check('Status → In Progress', r.body && r.body.status === 'In Progress', `status=${r.body && r.body.status}`);

  // 5. SafetyOff adds action with follow_up_date
  const futureDate = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  r = await req(safetyof, 'POST', `/api/incidents/${incidentId}/actions`, {
    description:    'T41 response action recorded.',
    follow_up_date: futureDate,
  });
  check('POST /actions → 201 or 200', r.status === 201 || r.status === 200, `got ${r.status} ${JSON.stringify(r.body)}`);

  // Timeline has ≥4 entries (Submitted, Under Review, Assigned, Acknowledged, Action)
  r = await req(schhead, 'GET', `/api/incidents/${incidentId}/timeline`);
  check('GET /timeline → 200', r.status === 200, `got ${r.status}`);
  const timeline = r.body && (r.body.data || r.body);
  const entries  = Array.isArray(timeline) ? timeline : (timeline && timeline.data ? timeline.data : []);
  check('Timeline has ≥4 entries', entries.length >= 4, `got ${entries.length}`);
  // All entries ordered by created_at ASC
  let ordered = true;
  for (let i = 1; i < entries.length; i++) {
    if (entries[i].created_at < entries[i - 1].created_at) { ordered = false; break; }
  }
  check('Timeline entries are in chronological order', ordered);

  // 6. Resolve without resolution_summary → 422
  r = await req(schhead, 'PATCH', `/api/incidents/${incidentId}/status`, { status: 'Resolved' });
  check('Resolve without summary → 422', r.status === 422, `got ${r.status} ${JSON.stringify(r.body)}`);

  // 7. Resolve with resolution_summary → Resolved
  r = await req(schhead, 'PATCH', `/api/incidents/${incidentId}/status`, {
    status: 'Resolved',
    resolution_summary: 'T41 resolution: matter addressed by SafetyOff.',
  });
  check('Resolve with summary → 200', r.status === 200, `got ${r.status} ${JSON.stringify(r.body)}`);
  check('Status → Resolved', r.body && r.body.status === 'Resolved', `status=${r.body && r.body.status}`);

  // 8. Close without closure_summary → 422
  r = await req(schhead, 'PATCH', `/api/incidents/${incidentId}/status`, { status: 'Closed' });
  check('Close without closure_summary → 422', r.status === 422, `got ${r.status} ${JSON.stringify(r.body)}`);

  // 9. Close with closure_summary → Closed
  r = await req(schhead, 'PATCH', `/api/incidents/${incidentId}/status`, {
    status: 'Closed',
    closure_summary: 'T41 closure: incident formally closed.',
  });
  check('Close with closure_summary → 200', r.status === 200, `got ${r.status} ${JSON.stringify(r.body)}`);
  check('Status → Closed', r.body && r.body.status === 'Closed', `status=${r.body && r.body.status}`);

  // 10. Further status change on Closed → 422
  r = await req(schhead, 'PATCH', `/api/incidents/${incidentId}/status`, {
    status: 'Under Review',
  });
  check('Status change on Closed → 422', r.status === 422, `got ${r.status} ${JSON.stringify(r.body)}`);

  // 11. Create a fresh incident for restriction tests (the closed one can still be tested)
  const r2 = await req(teacher, 'POST', '/api/incidents', {
    category_id:   catRow.id,
    incident_date: today,
    incident_time: '10:00',
    location_text: 'T41 Restriction Test Location',
    description:   'T41 restriction test incident',
  });
  const incidentId2 = r2.body && r2.body.id;

  // 12. Teacher cannot restrict → 403
  if (incidentId2) {
    r = await req(teacher, 'PATCH', `/api/incidents/${incidentId2}/restrict`, { is_restricted: 1 });
    check('Teacher cannot restrict incident → 403', r.status === 403, `got ${r.status}`);

    // SchHead restricts
    r = await req(schhead, 'PATCH', `/api/incidents/${incidentId2}/restrict`, { is_restricted: 1 });
    check('SchHead restricts → 200', r.status === 200, `got ${r.status}`);

    // 13. Teacher cannot see restricted incident in list
    r = await req(teacher, 'GET', '/api/incidents');
    const list = r.body && (r.body.data || []);
    const visible = list.some(i => i.id === incidentId2);
    check('Restricted incident hidden from Teacher list', !visible, `found id=${incidentId2} in Teacher list`);

    // SchHead can still see it
    r = await req(schhead, 'GET', '/api/incidents');
    const schList = r.body && (r.body.data || []);
    const schVisible = schList.some(i => i.id === incidentId2);
    check('Restricted incident still visible to SchHead', schVisible, `id=${incidentId2} not in SchHead list`);
  } else {
    check('Restriction test incident created', false, 'could not create second incident');
    check('Teacher cannot restrict', false, 'skipped');
    check('SchHead restricts → 200', false, 'skipped');
    check('Restricted hidden from Teacher', false, 'skipped');
    check('Restricted visible to SchHead', false, 'skipped');
  }

  console.log('');
  console.log(`=== Results: ${pass} passed, ${fail} failed ===\n`);
}

server.listen(PORT, async () => {
  try { await run(); }
  catch (err) { fail++; console.error('Unexpected error:', err); }
  server.close(() => process.exit(fail ? 1 : 0));
});
