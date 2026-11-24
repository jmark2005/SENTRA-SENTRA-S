'use strict';
const express = require('express');
const authMiddleware = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const { log: auditLog } = require('../services/audit.service');
const classSvc = require('../services/class.service');

const router = express.Router();

// ── POST /api/classes ─────────────────────────────────────────────────────────
router.post('/', authMiddleware, requirePermission('manage_classes'), (req, res) => {
  const { name, grade_level, section, school_year, semester, class_adviser_id } = req.body;

  if (!name || !grade_level || !section || !school_year || !semester) {
    return res.status(400).json({ error: 'name, grade_level, section, school_year, and semester are required.' });
  }

  const VALID_SEMESTERS = ['1st Semester', '2nd Semester'];
  if (!VALID_SEMESTERS.includes(semester)) {
    return res.status(400).json({ error: 'semester must be "1st Semester" or "2nd Semester".' });
  }

  const result = classSvc.create({
    name, grade_level, section, school_year, semester,
    class_adviser_id: class_adviser_id || null,
    created_by: req.user.id,
  });

  auditLog({
    actorId: req.user.id, actorName: req.user.full_name, actorRole: req.user.role,
    actionType: 'CLASS_CREATED', targetTable: 'classes', targetId: result.lastInsertRowid,
    newValues: { name, grade_level, section, school_year, semester }, ipAddress: req.ip,
  });

  return res.status(201).json(classSvc.findById(result.lastInsertRowid));
});

// ── GET /api/classes ──────────────────────────────────────────────────────────
router.get('/', authMiddleware, requirePermission('view_classes'), (req, res) => {
  const role = req.user.role;
  let classes;

  if (role === 'sysadmin' || role === 'schoolhead') {
    classes = classSvc.findAll();
  } else if (role === 'teacher') {
    classes = classSvc.findByTeacher(req.user.id);
  } else {
    classes = [];
  }

  return res.json({ data: classes });
});

// ── GET /api/classes/:id ──────────────────────────────────────────────────────
router.get('/:id', authMiddleware, requirePermission('view_classes'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Invalid class ID.' });

  const cls = classSvc.findById(id);
  if (!cls) return res.status(404).json({ error: 'Class not found.' });

  const students = classSvc.getStudents(id);
  const teachers = classSvc.getTeachers(id);

  return res.json({ ...cls, students, teachers });
});

// ── PATCH /api/classes/:id ────────────────────────────────────────────────────
router.patch('/:id', authMiddleware, requirePermission('manage_classes'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Invalid class ID.' });

  const cls = classSvc.findById(id);
  if (!cls) return res.status(404).json({ error: 'Class not found.' });

  const { teacher_ids, ...fields } = req.body;

  if (Object.keys(fields).length > 0) {
    classSvc.update(id, fields);
  }

  if (Array.isArray(teacher_ids)) {
    classSvc.setTeachers(id, teacher_ids);
  }

  auditLog({
    actorId: req.user.id, actorName: req.user.full_name, actorRole: req.user.role,
    actionType: 'CLASS_UPDATED', targetTable: 'classes', targetId: id,
    newValues: req.body, ipAddress: req.ip,
  });

  return res.json(classSvc.findById(id));
});

// ── POST /api/classes/:id/students (bulk assign) ──────────────────────────────
router.post('/:id/students', authMiddleware, requirePermission('manage_classes'), (req, res) => {
  const classId = parseInt(req.params.id, 10);
  if (!classId) return res.status(400).json({ error: 'Invalid class ID.' });

  const cls = classSvc.findById(classId);
  if (!cls) return res.status(404).json({ error: 'Class not found.' });

  const { student_ids } = req.body;
  if (!Array.isArray(student_ids) || !student_ids.length) {
    return res.status(400).json({ error: 'student_ids must be a non-empty array.' });
  }

  const errors = [];
  const assigned = [];

  for (const sid of student_ids) {
    try {
      classSvc.assignStudent({
        student_id: sid,
        class_id: classId,
        school_year: cls.school_year,
        semester: cls.semester,
      });
      assigned.push(sid);
    } catch (err) {
      if (err.message && err.message.includes('UNIQUE constraint failed')) {
        errors.push({ student_id: sid, error: 'Student already assigned to a class this semester.' });
      } else {
        errors.push({ student_id: sid, error: err.message });
      }
    }
  }

  auditLog({
    actorId: req.user.id, actorName: req.user.full_name, actorRole: req.user.role,
    actionType: 'CLASS_STUDENTS_ASSIGNED', targetTable: 'classes', targetId: classId,
    newValues: { assigned, errors: errors.map(e => e.student_id) }, ipAddress: req.ip,
  });

  if (errors.length > 0 && assigned.length === 0) {
    return res.status(409).json({ error: 'All students already assigned this semester.', errors });
  }

  return res.status(errors.length > 0 ? 207 : 201).json({
    message: `Assigned ${assigned.length} student(s).`,
    assigned,
    errors,
  });
});

// ── DELETE /api/classes/:id/students/:sid ─────────────────────────────────────
router.delete('/:id/students/:sid', authMiddleware, requirePermission('manage_classes'), (req, res) => {
  const classId   = parseInt(req.params.id,  10);
  const studentId = parseInt(req.params.sid, 10);
  if (!classId || !studentId) return res.status(400).json({ error: 'Invalid IDs.' });

  const result = classSvc.removeStudent(classId, studentId);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Student assignment not found.' });
  }

  auditLog({
    actorId: req.user.id, actorName: req.user.full_name, actorRole: req.user.role,
    actionType: 'CLASS_STUDENT_REMOVED', targetTable: 'classes', targetId: classId,
    oldValues: { student_id: studentId }, ipAddress: req.ip,
  });

  return res.json({ message: 'Student removed from class.' });
});

module.exports = router;
