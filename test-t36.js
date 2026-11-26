'use strict';

/**
 * test-t36.js — Integration test for T-36 Escalation Rules API
 *
 * Run: node test-t36.js
 * Exit code 0 = all PASS, 1 = at least one FAIL.
 *
 * Tests:
 *  1. Create a rule (Critical + In Progress, 1 minute) → 201, appears in GET list.
 *  2. PATCH the rule to toggle is_active.
 *  3. Audit log entries written for create and update.
 *  4. Validation errors (bad severity, missing user, non-integer minutes).
 *  5. Unauthorised (no login) → 401; non-privileged role → 403.
 */

const http   = require('http');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const db = require('./src/repositories/db');

// ── Fake users (random passwords, never printed) ─────────────────────────────
function randomPassword() {
  return crypto.randomBytes(12).toString('base64url') + 'Aa1!';
}

function upsertUser(username, roleName, fullName) {
  const role = db.prepare('SELECT id FROM roles WHERE name = ?').get(roleName);
  if (!role) throw new Error(`Role ${roleName} missing. Run the seed first.`);
  const password = randomPassword();
  db.prepare(`
    INSERT INTO users (username, email, password_hash, full_name, role_id, status, password_reset_required)
    VALUES (?, ?, ?, ?, ?, 'Active', 0)
    ON CONFLICT(username) DO UPDATE SET
      email = excluded.email, password_hash = excluded.password_hash,
      full_name = excluded.full_name, role_id = excluded.role_id,
      status = 'Active', password_reset_required = 0
  `).run(username, `${username}@test.local`, bcrypt.hashSync(password, 10), fullName, role.id);
  return { username, password };
}

const ADMIN   = upsertUser('t36_admin',   'sysadmin', 'T36 Admin');
const TEACHER = upsertUser('t36_teacher', 'teacher',  'T36 Teacher');

// ── Server and HTTP helpers ──────────────────────────────────────────────────
const app    = require('./src/app');
const PORT   = 3096;
const BASE   = `http://127.0.0.1:${PORT}`;
const server = http.createServer(app);

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log(`  PASS  ${name}`); }
  else    { failed++; console.error(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

function cookiesFrom(res) {
  return (res.headers.getSetCookie ? res.headers.getSetCookie() : [])
    .map(c => c.split(';')[0]);
}

function mergeCookies(...lists) {
  const map = new Map();
  for (const c of lists.flat()) map.set(c.split('=')[0], c);
  return [...map.values()].join('; ');
}

async function csrf(cookie) {
  const res = await fetch(`${BASE}/api/csrf-token`, { headers: cookie ? { cookie } : {} });
  const { csrfToken } = await res.json();
  return { token: csrfToken, cookies: cookiesFrom(res) };
}

async function login(user) {
  const c = await csrf();
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': c.token, cookie: mergeCookies(c.cookies) },
    body: JSON.stringify({ username: user.username, password: user.password }),
  });
  if (res.status !== 200) throw new Error(`login ${user.username} → ${res.status}`);
  const cookie = mergeCookies(c.cookies, cookiesFrom(res));
  const fresh = await csrf(cookie);
  return { cookie: mergeCookies(cookie.split('; '), fresh.cookies), token: fresh.token };
}

async function apiJson(session, method, urlPath, body) {
  const headers = { 'content-type': 'application/json' };
  if (session) { headers.cookie = session.cookie; headers['x-csrf-token'] = session.token; }
  const opts = { method, headers };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(BASE + urlPath, opts);
  let parsed = null;
  try { parsed = await res.json(); } catch (_) { parsed = null; }
  return { status: res.status, body: parsed };
}

// ── Tests ────────────────────────────────────────────────────────────────────
async function run() {
  console.log('\n=== T-36 Escalation Rules API ===\n');

  const admin   = await login(ADMIN);
  const teacher = await login(TEACHER);

  // Resolve the admin user id for escalation_user_id
  const adminUser = db.prepare("SELECT id FROM users WHERE username = 't36_admin'").get();

  // ── 1. Create rule (Critical + In Progress, 1 minute) ──
  let r = await apiJson(admin, 'POST', '/api/escalation-rules', {
    severity: 'Critical',
    watch_status: 'In Progress',
    time_target_minutes: 1,
    escalation_user_id: adminUser.id,
  });
  check('POST create (Critical/In Progress/1min) → 201', r.status === 201, `got ${r.status} ${JSON.stringify(r.body)}`);
  const ruleId = r.body && r.body.id;
  check('Created rule has correct fields',
    r.body && r.body.severity === 'Critical' && r.body.watch_status === 'In Progress'
      && r.body.time_target_minutes === 1 && r.body.is_active === 1
      && r.body.escalation_user_name === 'T36 Admin',
    JSON.stringify(r.body));

  // ── 2. GET /api/escalation-rules — rule appears ──
  r = await apiJson(admin, 'GET', '/api/escalation-rules');
  check('GET list → 200', r.status === 200, `got ${r.status}`);
  const list = r.body && r.body.data ? r.body.data : [];
  check('Created rule appears in GET list', list.some(x => x.id === ruleId), `id=${ruleId} not found`);

  // ── 3. PATCH toggle is_active ──
  r = await apiJson(admin, 'PATCH', '/api/escalation-rules/' + ruleId, { is_active: 0 });
  check('PATCH toggle is_active → 200', r.status === 200, `got ${r.status} ${JSON.stringify(r.body)}`);
  check('Rule is_active now 0', r.body && r.body.is_active === 0, JSON.stringify(r.body));

  // Re-activate
  r = await apiJson(admin, 'PATCH', '/api/escalation-rules/' + ruleId, { is_active: 1 });
  check('PATCH re-activate → 200, is_active 1', r.status === 200 && r.body.is_active === 1, `got ${r.status}`);

  // ── 4. PATCH update fields ──
  r = await apiJson(admin, 'PATCH', '/api/escalation-rules/' + ruleId, { time_target_minutes: 30, severity: 'High' });
  check('PATCH update minutes + severity', r.status === 200 && r.body.time_target_minutes === 30 && r.body.severity === 'High',
    `got ${r.status} ${JSON.stringify(r.body)}`);

  // ── 5. Audit log entries ──
  const createAudit = db.prepare(`
    SELECT COUNT(*) AS n FROM audit_logs
    WHERE action_type = 'ESCALATION_RULE_CREATED' AND target_table = 'escalation_rules' AND target_id = ?
  `).get(ruleId).n;
  check('Audit log: ESCALATION_RULE_CREATED recorded', createAudit === 1, `got ${createAudit}`);

  const updateAudits = db.prepare(`
    SELECT COUNT(*) AS n FROM audit_logs
    WHERE action_type = 'ESCALATION_RULE_UPDATED' AND target_table = 'escalation_rules' AND target_id = ?
  `).get(ruleId).n;
  check('Audit log: ESCALATION_RULE_UPDATED recorded (>= 3 patches)', updateAudits >= 3, `got ${updateAudits}`);

  // ── 6. Validation errors ──
  r = await apiJson(admin, 'POST', '/api/escalation-rules', {
    severity: 'Urgent',
    watch_status: 'In Progress',
    time_target_minutes: 5,
    escalation_user_id: adminUser.id,
  });
  check('POST invalid severity → 400', r.status === 400, `got ${r.status}`);

  r = await apiJson(admin, 'POST', '/api/escalation-rules', {
    severity: 'Low',
    watch_status: 'Closed',
    time_target_minutes: 5,
    escalation_user_id: adminUser.id,
  });
  check('POST invalid watch_status → 400', r.status === 400, `got ${r.status}`);

  r = await apiJson(admin, 'POST', '/api/escalation-rules', {
    severity: 'Low',
    watch_status: 'In Progress',
    time_target_minutes: 0,
    escalation_user_id: adminUser.id,
  });
  check('POST time_target_minutes = 0 → 400', r.status === 400, `got ${r.status}`);

  r = await apiJson(admin, 'POST', '/api/escalation-rules', {
    severity: 'Low',
    watch_status: 'In Progress',
    time_target_minutes: 2.5,
    escalation_user_id: adminUser.id,
  });
  check('POST non-integer minutes → 400', r.status === 400, `got ${r.status}`);

  r = await apiJson(admin, 'POST', '/api/escalation-rules', {
    severity: 'Low',
    watch_status: 'In Progress',
    time_target_minutes: 5,
    escalation_user_id: 999999,
  });
  check('POST non-existent user → 400', r.status === 400, `got ${r.status}`);

  // ── 7. Auth / permission checks ──
  const anon = await csrf();
  const anonSession = { cookie: mergeCookies(anon.cookies), token: anon.token };
  r = await apiJson(anonSession, 'GET', '/api/escalation-rules');
  check('GET without login → 401', r.status === 401, `got ${r.status}`);

  r = await apiJson(null, 'POST', '/api/escalation-rules', { severity: 'Low', watch_status: 'In Progress', time_target_minutes: 5, escalation_user_id: adminUser.id });
  check('POST without login → 401 or 403 (CSRF/auth block)', r.status === 401 || r.status === 403, `got ${r.status}`);

  r = await apiJson(teacher, 'POST', '/api/escalation-rules', { severity: 'Low', watch_status: 'In Progress', time_target_minutes: 5, escalation_user_id: adminUser.id });
  check('POST as teacher (no permission) → 403', r.status === 403, `got ${r.status}`);

  r = await apiJson(teacher, 'GET', '/api/escalation-rules');
  check('GET as teacher (no permission) → 403', r.status === 403, `got ${r.status}`);

  // ── 8. PATCH non-existent rule ──
  r = await apiJson(admin, 'PATCH', '/api/escalation-rules/999999', { is_active: 0 });
  check('PATCH non-existent rule → 404', r.status === 404, `got ${r.status}`);

  // ── Cleanup: remove test rule ──
  db.prepare('DELETE FROM escalation_rules WHERE id = ?').run(ruleId);
  // audit_logs is append-only (triggers prevent DELETE) — test entries remain
  console.log('\n  (cleanup: removed test rule ' + ruleId + ')');
}

server.listen(PORT, async () => {
  try {
    await run();
  } catch (err) {
    failed++;
    console.error('  FAIL  unexpected error:', err);
  }
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  server.close(() => process.exit(failed ? 1 : 0));
});
