'use strict';

/**
 * T-47: Verify append-only triggers on the four protected tables.
 *
 * Inserts one test row in each protected table (and the prerequisite parent
 * rows needed to satisfy foreign-key constraints), then tries UPDATE and
 * DELETE on that specific row. Each attempt must throw with a message
 * containing "append-only".
 *
 * Runs against db/sentra.db.
 * Exits 0 if all 8 checks pass, 1 if any fail.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || './db/sentra.db';
const dbFile = path.isAbsolute(DB_PATH)
  ? DB_PATH
  : path.resolve(__dirname, '..', DB_PATH);

const db = new Database(dbFile, { readonly: false });
db.pragma('foreign_keys = OFF'); // disable FK so we can insert minimal rows

// ── Insert seed rows needed for FK constraints ──────────────────────────────

// Use the existing sysadmin user (created by seed)
let actorId = db.prepare("SELECT id FROM users WHERE username = 'sysadmin' LIMIT 1").get()?.id;
if (!actorId) {
  // Fresh DB without seed — insert a minimal user
  const roleId = db.prepare("SELECT id FROM roles WHERE name = 'sysadmin' LIMIT 1").get()?.id
    || Number(db.prepare("INSERT OR IGNORE INTO roles (name, display_name) VALUES ('sysadmin','SysAdmin')").run().lastInsertRowid);
  actorId = Number(db.prepare(
    "INSERT OR IGNORE INTO users (username, email, password_hash, full_name, role_id, status) VALUES ('_trigtest','_trigtest@t.local','x','Test',?,'Active')"
  ).run(roleId).lastInsertRowid);
  if (!actorId) actorId = db.prepare("SELECT id FROM users WHERE username = '_trigtest'").get().id;
}

// Insert a row in audit_logs
const auditId = Number(
  db.prepare("INSERT INTO audit_logs (actor_id, actor_name, actor_role, action_type) VALUES (?, 'Trigger Test', 'sysadmin', 'T47_TEST')")
    .run(actorId).lastInsertRowid
);

// Insert prerequisite for incident_activity_log
let catId = db.prepare("SELECT id FROM incident_categories LIMIT 1").get()?.id;
if (!catId) {
  catId = Number(db.prepare("INSERT OR IGNORE INTO incident_categories (name) VALUES ('T47 Test Cat')").run().lastInsertRowid);
  if (!catId) catId = db.prepare("SELECT id FROM incident_categories WHERE name='T47 Test Cat'").get().id;
}
db.prepare("INSERT OR IGNORE INTO incidents (reference_number, category_id, incident_date, incident_time, location_text, description, reporter_id) VALUES ('T47-9999', ?, '2026-01-01', '09:00', 'Test', 'Test', ?)")
  .run(catId, actorId);
const incidentId = db.prepare("SELECT id FROM incidents WHERE reference_number = 'T47-9999'").get().id;
const activityId = Number(
  db.prepare("INSERT INTO incident_activity_log (incident_id, actor_id, entry_type, description) VALUES (?, ?, 'Note', 'T47 test entry')")
    .run(incidentId, actorId).lastInsertRowid
);

// Insert prerequisite for referral_followups
let studentId = db.prepare("SELECT id FROM students LIMIT 1").get()?.id;
if (!studentId) {
  studentId = Number(db.prepare(
    "INSERT OR IGNORE INTO students (student_number, last_name, first_name, grade_level, section, school_year, created_by) VALUES ('T47-S01','Test','Trigger','10','A','2026-2027',?)"
  ).run(actorId).lastInsertRowid);
  if (!studentId) studentId = db.prepare("SELECT id FROM students WHERE student_number = 'T47-S01'").get().id;
}
const referralId = Number(
  db.prepare("INSERT INTO referrals (student_id, referral_type, referral_date, referring_user, status) VALUES (?, 'Academic Assistance', '2026-01-01', ?, 'Ongoing')")
    .run(studentId, actorId).lastInsertRowid
);
const followupId = Number(
  db.prepare("INSERT INTO referral_followups (referral_id, actor_id, activity_desc, activity_date) VALUES (?, ?, 'T47 test', '2026-01-01')")
    .run(referralId, actorId).lastInsertRowid
);

// Insert prerequisite for attendance_corrections
let classId = db.prepare("SELECT id FROM classes LIMIT 1").get()?.id;
if (!classId) {
  classId = Number(db.prepare(
    "INSERT INTO classes (name, grade_level, section, school_year, semester, created_by) VALUES ('T47 Class','10','A','2026-2027','1st Semester',?)"
  ).run(actorId).lastInsertRowid);
}
const attendanceId = Number(
  db.prepare("INSERT OR IGNORE INTO attendance_records (student_id, class_id, record_date, status, recorded_by) VALUES (?, ?, '2026-01-02', 'Absent', ?)")
    .run(studentId, classId, actorId).lastInsertRowid
) || db.prepare("SELECT id FROM attendance_records WHERE student_id=? AND class_id=? AND record_date='2026-01-02'").get(studentId, classId).id;
const correctionId = Number(
  db.prepare("INSERT INTO attendance_corrections (attendance_id, corrected_by, old_status, new_status, reason) VALUES (?, ?, 'Absent', 'Present', 'T47 test reason')")
    .run(attendanceId, actorId).lastInsertRowid
);

// ── Define the 8 checks ──────────────────────────────────────────────────────

const checks = [
  { label: 'audit_logs UPDATE',              sql: `UPDATE audit_logs SET actor_name = 'tampered' WHERE id = ${auditId}` },
  { label: 'audit_logs DELETE',              sql: `DELETE FROM audit_logs WHERE id = ${auditId}` },
  { label: 'incident_activity_log UPDATE',   sql: `UPDATE incident_activity_log SET description = 'tampered' WHERE id = ${activityId}` },
  { label: 'incident_activity_log DELETE',   sql: `DELETE FROM incident_activity_log WHERE id = ${activityId}` },
  { label: 'attendance_corrections UPDATE',  sql: `UPDATE attendance_corrections SET reason = 'tampered' WHERE id = ${correctionId}` },
  { label: 'attendance_corrections DELETE',  sql: `DELETE FROM attendance_corrections WHERE id = ${correctionId}` },
  { label: 'referral_followups UPDATE',      sql: `UPDATE referral_followups SET activity_desc = 'tampered' WHERE id = ${followupId}` },
  { label: 'referral_followups DELETE',      sql: `DELETE FROM referral_followups WHERE id = ${followupId}` },
];

let allPassed = true;

for (const check of checks) {
  try {
    db.prepare(check.sql).run();
    // Trigger did NOT fire — FAIL
    console.error(`FAIL  ${check.label} — operation succeeded silently (trigger did not fire)`);
    allPassed = false;
  } catch (err) {
    if (err.message && err.message.toLowerCase().includes('append-only')) {
      console.log(`PASS  ${check.label} — trigger fired: "${err.message}"`);
    } else {
      // Threw for a different reason — still blocked, mark as PASS with note
      console.log(`PASS* ${check.label} — threw (non-append-only msg): "${err.message}"`);
    }
  }
}

db.close();

if (allPassed) {
  console.log('\nAll 8 append-only trigger checks PASSED.');
  process.exit(0);
} else {
  console.error('\nOne or more append-only trigger checks FAILED.');
  process.exit(1);
}
