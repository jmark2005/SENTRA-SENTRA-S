'use strict';

// The four append-only tables refuse UPDATE and DELETE (db/migrations/001_core_schema.sql triggers).

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { db, makeUser, makeStudent } = require('./helpers');

const rows = {};

before(() => {
  const user = makeUser('sysadmin', 'Test Admin');
  const teacher = makeUser('teacher', 'Test Teacher');
  const studentId = makeStudent();
  const cat = db.prepare('SELECT id FROM incident_categories ORDER BY id LIMIT 1').get().id;

  rows.audit_logs = Number(db.prepare(`
    INSERT INTO audit_logs (actor_id, actor_name, actor_role, action_type) VALUES (?, 'Test Admin', 'sysadmin', 'TEST')
  `).run(user.id).lastInsertRowid);

  const incidentId = Number(db.prepare(`
    INSERT INTO incidents (reference_number, category_id, incident_date, incident_time, location_text, description, reporter_id)
    VALUES ('INC-2099-0001', ?, '2026-01-05', '09:00', 'Gym', 'Fake', ?)
  `).run(cat, teacher.id).lastInsertRowid);
  rows.incident_activity_log = Number(db.prepare(`
    INSERT INTO incident_activity_log (incident_id, actor_id, entry_type, description) VALUES (?, ?, 'Note', 'Fake note')
  `).run(incidentId, user.id).lastInsertRowid);

  const referralId = Number(db.prepare(`
    INSERT INTO referrals (student_id, referral_type, referral_date, referring_user, status)
    VALUES (?, 'Academic Assistance', '2026-01-05', ?, 'Ongoing')
  `).run(studentId, teacher.id).lastInsertRowid);
  rows.referral_followups = Number(db.prepare(`
    INSERT INTO referral_followups (referral_id, actor_id, activity_desc, activity_date) VALUES (?, ?, 'Fake', '2026-01-05')
  `).run(referralId, user.id).lastInsertRowid);

  const classId = Number(db.prepare(`
    INSERT INTO classes (name, grade_level, section, school_year, semester, class_adviser_id, created_by)
    VALUES ('Fake class', '7', 'A', '2026-2027', '1st Semester', ?, ?)
  `).run(teacher.id, user.id).lastInsertRowid);
  const recordId = Number(db.prepare(`
    INSERT INTO attendance_records (student_id, class_id, record_date, status, recorded_by) VALUES (?, ?, '2026-01-05', 'Absent', ?)
  `).run(studentId, classId, teacher.id).lastInsertRowid);
  rows.attendance_corrections = Number(db.prepare(`
    INSERT INTO attendance_corrections (attendance_id, corrected_by, old_status, new_status, reason)
    VALUES (?, ?, 'Absent', 'Present', 'Fake correction')
  `).run(recordId, user.id).lastInsertRowid);
});

const UPDATES = {
  audit_logs:             "UPDATE audit_logs SET action_type = 'TAMPERED' WHERE id = ?",
  incident_activity_log:  "UPDATE incident_activity_log SET description = 'tampered' WHERE id = ?",
  referral_followups:     "UPDATE referral_followups SET activity_desc = 'tampered' WHERE id = ?",
  attendance_corrections: "UPDATE attendance_corrections SET reason = 'tampered' WHERE id = ?",
};

test('exactly 8 append-only triggers exist (UPDATE and DELETE on 4 tables)', () => {
  const triggers = db.prepare("SELECT tbl_name FROM sqlite_master WHERE type = 'trigger' AND sql LIKE '%append-only%'").all();
  assert.equal(triggers.length, 8);
  assert.deepEqual([...new Set(triggers.map(t => t.tbl_name))].sort(), Object.keys(UPDATES).sort());
});

for (const [table, updateSql] of Object.entries(UPDATES)) {
  test(`${table}: UPDATE is refused`, () => {
    assert.throws(() => db.prepare(updateSql).run(rows[table]), /append-only/);
  });

  test(`${table}: DELETE is refused`, () => {
    assert.throws(() => db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(rows[table]), /append-only/);
    assert.ok(db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(rows[table]), 'row still there');
  });
}
