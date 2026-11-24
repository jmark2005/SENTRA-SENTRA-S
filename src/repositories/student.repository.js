'use strict';
const db = require('./db');

function create({ student_number, last_name, first_name, middle_initial,
                  grade_level, section, school_year, guardian_name, guardian_contact, created_by }) {
  return db.prepare(`
    INSERT INTO students (student_number, last_name, first_name, middle_initial,
      grade_level, section, school_year, guardian_name, guardian_contact, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(student_number, last_name, first_name, middle_initial || null,
         grade_level, section, school_year, guardian_name || null,
         guardian_contact || null, created_by || null);
}

function findById(id) {
  return db.prepare(`
    SELECT s.*,
      (SELECT COUNT(*) FROM incidents ip JOIN incident_parties ipart ON ipart.incident_id=ip.id WHERE ipart.student_id=s.id) AS incident_count,
      (SELECT COUNT(*) FROM referrals r WHERE r.student_id=s.id) AS referral_count,
      (SELECT COUNT(*) FROM attendance_records ar WHERE ar.student_id=s.id) AS attendance_count
    FROM students s WHERE s.id=?
  `).get(id);
}

function search({ q, status, school_year }) {
  const conditions = ["s.status != 'Archived'"];
  const params = [];
  if (status) { conditions.push('s.status = ?'); params.push(status); }
  if (school_year) { conditions.push('s.school_year = ?'); params.push(school_year); }
  if (q) {
    conditions.push('(s.student_number LIKE ? OR s.last_name LIKE ? OR s.first_name LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  return db.prepare(`SELECT * FROM students s ${where} ORDER BY s.last_name, s.first_name`).all(...params);
}

function findArchived() {
  return db.prepare("SELECT * FROM students WHERE status='Archived' ORDER BY updated_at DESC").all();
}

function update(id, fields) {
  const allowedKeys = ['student_number','last_name','first_name','middle_initial',
                       'grade_level','section','school_year','guardian_name','guardian_contact'];
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(fields)) {
    if (allowedKeys.includes(k)) { sets.push(`${k}=?`); vals.push(v); }
  }
  if (!sets.length) return;
  sets.push("updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')");
  vals.push(id);
  db.prepare(`UPDATE students SET ${sets.join(',')} WHERE id=?`).run(...vals);
}

function hasLinkedRecords(id) {
  const inc = db.prepare('SELECT COUNT(*) AS n FROM incident_parties WHERE student_id=?').get(id).n;
  const ref = db.prepare('SELECT COUNT(*) AS n FROM referrals WHERE student_id=?').get(id).n;
  const att = db.prepare('SELECT COUNT(*) AS n FROM attendance_records WHERE student_id=?').get(id).n;
  return inc > 0 || ref > 0 || att > 0;
}

function archive(id) {
  db.prepare("UPDATE students SET status='Archived', updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?").run(id);
}

function restore(id) {
  db.prepare("UPDATE students SET status='Active', updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?").run(id);
}

module.exports = { create, findById, search, findArchived, update, hasLinkedRecords, archive, restore };
