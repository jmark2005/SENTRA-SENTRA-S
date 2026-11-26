'use strict';

/**
 * T-37 Escalation Job — integration test
 *
 * Setup  (direct DB, no HTTP):
 *  1. Upsert a sysadmin user (escalation target) and a teacher user (incident reporter).
 *  2. Upsert a test incident_category and campus_location.
 *  3. INSERT a test incident (Critical / In Progress).
 *  4. INSERT an incident_activity_log "Status Change" row with created_at='2020-01-01T00:00:00Z'
 *     (5 years old — well past any time_target_minutes threshold).
 *  5. INSERT an escalation rule (Critical + In Progress, 1 min).
 *
 * Assertions:
 *  - runOnce() returns sent.length === 1.
 *  - notifications table has an 'Escalated' row for the escalation_user_id.
 *  - incident_activity_log has an 'Escalation' entry for the incident.
 *  - reminder_log has a row with kind='escalation', target_id=incident.id.
 *  - Second runOnce() returns sent.length === 0 (deduplication).
 *
 * Cleanup: deletes test rows in insertion-reverse order (skips audit_log —
 * append-only). The reminder_log row cannot be deleted (would break the
 * deduplication proof), so it is intentionally left and cleaned up at end.
 */

const db = require('./src/repositories/db');

// ── Helpers ──────────────────────────────────────────────────────────────────

let pass = 0;
let fail = 0;

function assert(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓  ${label}`);
    pass++;
  } else {
    console.error(`  ✗  ${label}${detail ? ' — ' + detail : ''}`);
    fail++;
  }
}

// ── Setup ─────────────────────────────────────────────────────────────────────

console.log('\n=== T-37 Escalation Job Test ===\n');

// 1. Upsert roles (sysadmin must exist for FK)
db.prepare(`INSERT OR IGNORE INTO roles (name, display_name) VALUES ('sysadmin', 'System Administrator')`).run();
db.prepare(`INSERT OR IGNORE INTO roles (name, display_name) VALUES ('teacher',  'Teacher')`).run();

// 2. Upsert sysadmin user (escalation target)
db.prepare(`
  INSERT OR IGNORE INTO users (username, email, password_hash, full_name, role_id, status)
  VALUES (
    'test_admin_t37',
    'test_admin_t37@sentra.test',
    'x',
    'Test Admin T37',
    (SELECT id FROM roles WHERE name = 'sysadmin'),
    'Active'
  )
`).run();
const adminUser = db.prepare(`SELECT id FROM users WHERE username = 'test_admin_t37'`).get();

// 3. Upsert teacher user (incident reporter — must be a real FK target)
db.prepare(`
  INSERT OR IGNORE INTO users (username, email, password_hash, full_name, role_id, status)
  VALUES (
    'test_teacher_t37',
    'test_teacher_t37@sentra.test',
    'x',
    'Test Teacher T37',
    (SELECT id FROM roles WHERE name = 'teacher'),
    'Active'
  )
`).run();
const teacherUser = db.prepare(`SELECT id FROM users WHERE username = 'test_teacher_t37'`).get();

// 4. Upsert incident category
db.prepare(`INSERT OR IGNORE INTO incident_categories (name) VALUES ('T37 Test Category')`).run();
const category = db.prepare(`SELECT id FROM incident_categories WHERE name = 'T37 Test Category'`).get();

// 5. INSERT test incident (Critical / In Progress)
//    Use a timestamp-based reference so re-runs don't collide on the UNIQUE constraint.
const refNumber = `T37-TEST-${Date.now()}`;
const incidentResult = db.prepare(`
  INSERT INTO incidents
    (reference_number, category_id, incident_date, incident_time,
     location_text, description, severity, status,
     reporter_id, is_archived)
  VALUES
    (?, ?, date('now'), time('now'),
     'Test Location', 'T37 integration test incident', 'Critical', 'In Progress',
     ?, 0)
`).run(refNumber, category.id, teacherUser.id);
const incidentId = incidentResult.lastInsertRowid;

// 6. INSERT a backdated "Status Change" activity log row (5 years ago)
//    INSERT is NOT blocked by the append-only trigger — only UPDATE/DELETE are.
db.prepare(`
  INSERT INTO incident_activity_log
    (incident_id, actor_id, entry_type, description, old_status, new_status, created_at)
  VALUES
    (?, ?, 'Status Change', 'Status set to In Progress (backdated for T37 test)',
     'Submitted', 'In Progress', '2020-01-01T00:00:00Z')
`).run(incidentId, teacherUser.id);

// 7. INSERT escalation rule: Critical + In Progress, 1-min threshold
const ruleResult = db.prepare(`
  INSERT INTO escalation_rules
    (severity, watch_status, time_target_minutes, escalation_user_id, is_active)
  VALUES ('Critical', 'In Progress', 1, ?, 1)
`).run(adminUser.id);
const ruleId = ruleResult.lastInsertRowid;

console.log(`Setup complete:`);
console.log(`  incident_id  = ${incidentId}`);
console.log(`  rule_id      = ${ruleId}`);
console.log(`  admin_id     = ${adminUser.id}`);
console.log('');

// ── First run ────────────────────────────────────────────────────────────────

console.log('--- First runOnce() ---');
const job = require('./src/jobs/escalation.job');
const { sent: sent1All } = job.runOnce();

// Filter to entries for our specific test incident (there may be leftover incidents
// from prior test runs that also match the rule — the job correctly processes them).
const sent1 = sent1All.filter(s => s.incident_id === incidentId);

assert('sent includes exactly 1 entry for our test incident', sent1.length === 1,
  `got ${sent1.length} entries for incident ${incidentId}; total sent = ${sent1All.length}`);

if (sent1.length > 0) {
  assert('sent[0].incident_id matches', sent1[0].incident_id === incidentId,
    `expected ${incidentId}, got ${sent1[0].incident_id}`);
  assert('sent[0].rule_id matches', sent1[0].rule_id === ruleId,
    `expected ${ruleId}, got ${sent1[0].rule_id}`);
}

// Notification
const notif = db.prepare(`
  SELECT * FROM notifications
  WHERE user_id = ? AND type = 'Escalated' AND title LIKE ?
  ORDER BY id DESC LIMIT 1
`).get(adminUser.id, `%${refNumber}%`);
assert('Escalated notification created', !!notif, 'no matching notification row');
if (notif) {
  assert('Notification title contains reference number', notif.title.includes(refNumber));
  assert('Notification message mentions severity', notif.message.includes('Critical'));
  assert('Notification link set', notif.link === `/api/incidents/${incidentId}`,
    `got ${notif.link}`);
}

// Activity log entry
const actLog = db.prepare(`
  SELECT * FROM incident_activity_log
  WHERE incident_id = ? AND entry_type = 'Escalation'
  ORDER BY id DESC LIMIT 1
`).get(incidentId);
assert('Escalation activity log entry added', !!actLog, 'no Escalation entry in incident_activity_log');
if (actLog) {
  assert('Activity log description mentions rule id', actLog.description.includes(`rule #${ruleId}`));
}

// reminder_log row
const dueKey = db.prepare(`
  SELECT rl.due_key FROM reminder_log rl
  WHERE rl.kind = 'escalation' AND rl.target_table = 'incidents' AND rl.target_id = ?
  ORDER BY rl.id DESC LIMIT 1
`).get(incidentId);
assert('reminder_log row present', !!dueKey, 'no reminder_log row for this incident');
if (dueKey) {
  assert('due_key starts with rule id', dueKey.due_key.startsWith(`${ruleId}|`),
    `due_key = ${dueKey.due_key}`);
}

// ── Second run (deduplication) ────────────────────────────────────────────────

console.log('');
console.log('--- Second runOnce() (deduplication check) ---');
const { sent: sent2All } = job.runOnce();
const sent2 = sent2All.filter(s => s.incident_id === incidentId);
assert('Second run: no entry for our test incident (deduplicated)', sent2.length === 0,
  `got ${sent2.length}: ${JSON.stringify(sent2)}`);

const notifCount = db.prepare(`
  SELECT COUNT(*) AS cnt FROM notifications
  WHERE user_id = ? AND type = 'Escalated' AND title LIKE ?
`).get(adminUser.id, `%${refNumber}%`);
assert('No duplicate notifications created', notifCount.cnt === 1,
  `expected 1 notification, got ${notifCount.cnt}`);

// ── Cleanup ───────────────────────────────────────────────────────────────────

console.log('');
console.log('--- Cleanup ---');

// Delete test notifications
db.prepare(`
  DELETE FROM notifications
  WHERE user_id = ? AND type = 'Escalated' AND title LIKE ?
`).run(adminUser.id, `%${refNumber}%`);

// Delete reminder_log entries for this incident
db.prepare(`
  DELETE FROM reminder_log
  WHERE kind = 'escalation' AND target_table = 'incidents' AND target_id = ?
`).run(incidentId);

// Delete escalation rule
db.prepare(`DELETE FROM escalation_rules WHERE id = ?`).run(ruleId);

// incident_activity_log is append-only (UPDATE/DELETE blocked by trigger), so
// those rows and the incident itself cannot be removed here.
// audit_log rows are also append-only.
// The test incident (id=${incidentId}) and its activity log rows remain in
// the DB but are harmless — the reference number 'T37-TEST-001' is unique
// and future test runs use INSERT OR IGNORE / separate reference numbers.

console.log(`  Escalation rule ${ruleId} deleted.`);
console.log(`  Test incident ${incidentId} retained (activity_log is append-only — cannot delete).`);
console.log('  audit_log and activity_log rows retained (append-only tables).');

// ── Summary ───────────────────────────────────────────────────────────────────

console.log('');
console.log(`=== Results: ${pass} passed, ${fail} failed ===`);

if (fail > 0) {
  process.exitCode = 1;
}
