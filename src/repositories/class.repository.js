'use strict';
const db = require('./db');

function create({ name, grade_level, section, school_year, semester, class_adviser_id, created_by }) {
  return db.prepare(`
    INSERT INTO classes (name, grade_level, section, school_year, semester, class_adviser_id, created_by)
    VALUES (?,?,?,?,?,?,?)
  `).run(name, grade_level, section, school_year, semester,
         class_adviser_id || null, created_by || null);
}

function findById(id) {
  return db.prepare(`
    SELECT c.*,
      u.full_name AS adviser_name
    FROM classes c
    LEFT JOIN users u ON u.id = c.class_adviser_id
    WHERE c.id = ?
  `).get(id);
}

function findAll() {
  return db.prepare(`
    SELECT c.*, u.full_name AS adviser_name
    FROM classes c
    LEFT JOIN users u ON u.id = c.class_adviser_id
    ORDER BY c.school_year DESC, c.name
  `).all();
}

function findByTeacher(userId) {
  return db.prepare(`
    SELECT c.*, u.full_name AS adviser_name
    FROM classes c
    LEFT JOIN users u ON u.id = c.class_adviser_id
    WHERE c.id IN (
      SELECT class_id FROM class_teachers WHERE user_id = ?
      UNION
      SELECT id FROM classes WHERE class_adviser_id = ?
    )
    ORDER BY c.school_year DESC, c.name
  `).all(userId, userId);
}

function update(id, fields) {
  const allowed = ['name', 'grade_level', 'section', 'school_year', 'semester', 'class_adviser_id', 'is_active'];
  const sets = [], vals = [];
  for (const [k, v] of Object.entries(fields)) {
    if (allowed.includes(k)) { sets.push(`${k}=?`); vals.push(v); }
  }
  if (!sets.length) return;
  vals.push(id);
  db.prepare(`UPDATE classes SET ${sets.join(',')} WHERE id=?`).run(...vals);
}

function getStudents(classId) {
  return db.prepare(`
    SELECT s.*, sca.school_year AS assigned_year, sca.semester AS assigned_semester
    FROM student_class_assignments sca
    JOIN students s ON s.id = sca.student_id
    WHERE sca.class_id = ?
    ORDER BY s.last_name, s.first_name
  `).all(classId);
}

function assignStudent({ student_id, class_id, school_year, semester }) {
  return db.prepare(`
    INSERT INTO student_class_assignments (student_id, class_id, school_year, semester)
    VALUES (?,?,?,?)
  `).run(student_id, class_id, school_year, semester);
}

function removeStudent(classId, studentId) {
  return db.prepare(`
    DELETE FROM student_class_assignments WHERE class_id=? AND student_id=?
  `).run(classId, studentId);
}

function getTeachers(classId) {
  return db.prepare(`
    SELECT u.id, u.full_name, u.username, r.name AS role
    FROM class_teachers ct
    JOIN users u ON u.id = ct.user_id
    JOIN roles r ON r.id = u.role_id
    WHERE ct.class_id = ?
  `).all(classId);
}

function setTeachers(classId, userIds) {
  db.prepare('DELETE FROM class_teachers WHERE class_id = ?').run(classId);
  const insert = db.prepare('INSERT OR IGNORE INTO class_teachers (class_id, user_id) VALUES (?,?)');
  for (const uid of userIds) insert.run(classId, uid);
}

module.exports = { create, findById, findAll, findByTeacher, update, getStudents,
                   assignStudent, removeStudent, getTeachers, setTeachers };
