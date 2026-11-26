'use strict';

const db = require('./db');

const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";

// School years are stored both as "2026-2027" (classes) and "2026–2027"
// (system settings, en dash), so compare them with dashes normalised.
const SY = col => `REPLACE(${col}, '–', '-')`;

/**
 * Active classes, optionally for one school year and semester.
 * Teachers get only classes they teach or advise.
 */
function listClasses({ userId, teacherOnly, schoolYear, semester, includeInactive }) {
  const conditions = includeInactive ? ['1 = 1'] : ['c.is_active = 1'];
  const params = [];
  if (schoolYear) { conditions.push(`${SY('c.school_year')} = ${SY('?')}`); params.push(schoolYear); }
  if (semester)   { conditions.push('c.semester = ?'); params.push(semester); }
  if (teacherOnly) {
    conditions.push(`c.id IN (SELECT class_id FROM class_teachers WHERE user_id = ?
                              UNION SELECT id FROM classes WHERE class_adviser_id = ?)`);
    params.push(userId, userId);
  }
  return db.prepare(`
    SELECT c.id, c.name, c.grade_level, c.section, c.school_year, c.semester,
           c.class_adviser_id, c.is_active, u.full_name AS adviser_name,
           (SELECT COUNT(*) FROM student_class_assignments sca
            JOIN students s ON s.id = sca.student_id
            WHERE sca.class_id = c.id AND s.status = 'Active') AS student_count
    FROM   classes c
    LEFT JOIN users u ON u.id = c.class_adviser_id
    WHERE  ${conditions.join(' AND ')}
    ORDER  BY c.name
  `).all(...params);
}

function findClass(id) {
  return db.prepare(`
    SELECT c.*, u.full_name AS adviser_name
    FROM   classes c LEFT JOIN users u ON u.id = c.class_adviser_id
    WHERE  c.id = ?
  `).get(id);
}

/** Teacher of the class (class_teachers) or its adviser. */
function isClassTeacher(classId, userId) {
  return !!db.prepare(`
    SELECT 1 FROM class_teachers WHERE class_id = ? AND user_id = ?
    UNION
    SELECT 1 FROM classes WHERE id = ? AND class_adviser_id = ?
  `).get(classId, userId, classId, userId);
}

/** Active students assigned to the class. */
function roster(classId) {
  return db.prepare(`
    SELECT s.id, s.student_number, s.last_name, s.first_name
    FROM   student_class_assignments sca
    JOIN   students s ON s.id = sca.student_id
    WHERE  sca.class_id = ? AND s.status = 'Active'
    ORDER  BY s.last_name, s.first_name
  `).all(classId);
}

function recordsFor(classId, date) {
  return db.prepare(`
    SELECT a.id, a.student_id, a.status, a.recorded_by, u.full_name AS recorded_by_name,
           a.created_at, a.updated_at,
           s.student_number, s.last_name, s.first_name,
           (SELECT COUNT(*) FROM attendance_corrections c WHERE c.attendance_id = a.id) AS correction_count
    FROM   attendance_records a
    JOIN   users u    ON u.id = a.recorded_by
    JOIN   students s ON s.id = a.student_id
    WHERE  a.class_id = ? AND a.record_date = ? AND a.is_archived = 0
  `).all(classId, date);
}

/** Inserts unless the student already has a record for that class and date. */
function insertRecord({ student_id, class_id, record_date, status, recorded_by }) {
  return db.prepare(`
    INSERT OR IGNORE INTO attendance_records (student_id, class_id, record_date, status, recorded_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(student_id, class_id, record_date, status, recorded_by).changes;
}

function findRecord(id) {
  return db.prepare(`
    SELECT a.*, s.student_number, s.last_name, s.first_name, c.name AS class_name
    FROM   attendance_records a
    JOIN   students s ON s.id = a.student_id
    JOIN   classes  c ON c.id = a.class_id
    WHERE  a.id = ?
  `).get(id);
}

/** Guarded by the status the caller saw. */
function setStatus(id, oldStatus, newStatus) {
  return db.prepare(`
    UPDATE attendance_records SET status = ?, updated_at = ${NOW_SQL}
    WHERE  id = ? AND status = ? AND is_archived = 0
  `).run(newStatus, id, oldStatus).changes;
}

function insertCorrection({ attendance_id, corrected_by, old_status, new_status, reason }) {
  return Number(db.prepare(`
    INSERT INTO attendance_corrections (attendance_id, corrected_by, old_status, new_status, reason)
    VALUES (?, ?, ?, ?, ?)
  `).run(attendance_id, corrected_by, old_status, new_status, reason).lastInsertRowid);
}

function correctionsFor(attendanceIds) {
  if (!attendanceIds.length) return [];
  return db.prepare(`
    SELECT c.id, c.attendance_id, c.old_status, c.new_status, c.reason, c.corrected_at,
           u.full_name AS corrected_by_name
    FROM   attendance_corrections c JOIN users u ON u.id = c.corrected_by
    WHERE  c.attendance_id IN (${attendanceIds.map(() => '?').join(', ')})
    ORDER  BY c.corrected_at ASC, c.id ASC
  `).all(...attendanceIds);
}

// ── T-31: summary and archive ─────────────────────────────────────────────────

/**
 * Per-student, per-class counts.
 * f = { archived, classIds (scope; null = all), studentId, classId, section,
 *       semester, schoolYear, from, to, status ('Absent'|'Tardy') }
 */
function summary(f) {
  const conditions = ['a.is_archived = ?'];
  const params = [f.archived ? 1 : 0];
  if (f.classIds)   { conditions.push(`a.class_id IN (${f.classIds.map(() => '?').join(', ') || 'NULL'})`); params.push(...f.classIds); }
  if (f.studentId)  { conditions.push('a.student_id = ?'); params.push(f.studentId); }
  if (f.classId)    { conditions.push('a.class_id = ?'); params.push(f.classId); }
  if (f.section)    { conditions.push('c.section = ?'); params.push(f.section); }
  if (f.semester)   { conditions.push('c.semester = ?'); params.push(f.semester); }
  if (f.schoolYear) { conditions.push(`${SY('c.school_year')} = ${SY('?')}`); params.push(f.schoolYear); }
  if (f.from)       { conditions.push('a.record_date >= ?'); params.push(f.from); }
  if (f.to)         { conditions.push('a.record_date <= ?'); params.push(f.to); }

  const having = f.status === 'Absent' ? 'HAVING absent > 0' : f.status === 'Tardy' ? 'HAVING tardy > 0' : '';
  return db.prepare(`
    SELECT a.student_id, s.student_number, s.last_name, s.first_name,
           a.class_id, c.name AS class_name, c.section, c.semester, c.school_year,
           COUNT(*) AS total_days,
           SUM(a.status = 'Present') AS present,
           SUM(a.status = 'Absent')  AS absent,
           SUM(a.status = 'Tardy')   AS tardy
    FROM   attendance_records a
    JOIN   students s ON s.id = a.student_id
    JOIN   classes  c ON c.id = a.class_id
    WHERE  ${conditions.join(' AND ')}
    GROUP  BY a.student_id, a.class_id
    ${having}
    ORDER  BY c.name, s.last_name, s.first_name
  `).all(...params);
}

/** Class ids a teacher teaches or advises. */
function teacherClassIds(userId) {
  return db.prepare(`
    SELECT class_id AS id FROM class_teachers WHERE user_id = ?
    UNION SELECT id FROM classes WHERE class_adviser_id = ?
  `).all(userId, userId).map(r => r.id);
}

/** Archives (value 1) or restores (value 0) every record of a class. */
function setClassArchived(classId, value) {
  return db.prepare(`
    UPDATE attendance_records SET is_archived = ?, updated_at = ${NOW_SQL}
    WHERE  class_id = ? AND is_archived = ?
  `).run(value, classId, value ? 0 : 1).changes;
}

module.exports = {
  summary,
  teacherClassIds,
  setClassArchived,
  listClasses,
  findClass,
  isClassTeacher,
  roster,
  recordsFor,
  insertRecord,
  findRecord,
  setStatus,
  insertCorrection,
  correctionsFor,
};
