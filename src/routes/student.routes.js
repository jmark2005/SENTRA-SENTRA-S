'use strict';
const express = require('express');
const db = require('../repositories/db');
const authMiddleware = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const { log: auditLog } = require('../services/audit.service');
const studentSvc = require('../services/student.service');

const router = express.Router();

// Forbidden fields that must never be collected
const FORBIDDEN_FIELDS = ['photo','contact_number','medical_history','blood_type','allergies','emergency_contact'];

// ── POST /api/students ────────────────────────────────────────────────────────
router.post('/', authMiddleware, requirePermission('manage_students'), (req, res) => {
  const { student_number, last_name, first_name, middle_initial,
          grade_level, section, school_year, guardian_name, guardian_contact } = req.body;

  // Check forbidden fields
  for (const f of FORBIDDEN_FIELDS) {
    if (req.body[f] !== undefined) {
      return res.status(400).json({ error: `Field '${f}' is not permitted.` });
    }
  }

  if (!student_number || !last_name || !first_name || !grade_level || !section || !school_year) {
    return res.status(400).json({ error: 'student_number, last_name, first_name, grade_level, section, and school_year are required.' });
  }

  const existing = db.prepare('SELECT id FROM students WHERE student_number=?').get(student_number);
  if (existing) return res.status(409).json({ error: 'Student number already exists.' });

  const result = studentSvc.create({
    student_number, last_name, first_name, middle_initial, grade_level,
    section, school_year, guardian_name, guardian_contact, created_by: req.user.id,
  });

  auditLog({ actorId: req.user.id, actorName: req.user.full_name, actorRole: req.user.role,
    actionType: 'STUDENT_CREATED', targetTable: 'students', targetId: result.lastInsertRowid,
    newValues: { student_number, last_name, first_name }, ipAddress: req.ip });

  const student = studentSvc.findById(result.lastInsertRowid);
  return res.status(201).json(student);
});

// ── GET /api/students/archived ───────────────────────────────────────────────
// MUST be registered BEFORE /:id to prevent Express matching 'archived' as an id
router.get('/archived', authMiddleware, requirePermission('manage_students'), (req, res) => {
  if (req.user.role !== 'sysadmin') return res.status(403).json({ error: 'Forbidden.' });
  return res.json({ data: studentSvc.findArchived() });
});

// ── GET /api/students ────────────────────────────────────────────────────────
router.get('/', authMiddleware, requirePermission('view_students'), (req, res) => {
  const { q, status, school_year } = req.query;
  const students = studentSvc.search({ q, status, school_year });
  return res.json({ data: students });
});

// ── GET /api/students/:id ────────────────────────────────────────────────────
router.get('/:id', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Invalid ID.' });

  // T-18: Students may only access their own linked student record.
  // All other roles require the view_students permission.
  if (req.user.role === 'student') {
    if (!req.user.student_record_id || req.user.student_record_id !== id) {
      return res.status(403).json({ error: 'Forbidden.' });
    }
    // Student accessing their own record — allow, no permission check needed
  } else {
    // Non-student roles: enforce view_students permission
    const row = db.prepare(`
      SELECT rp.granted
      FROM role_permissions rp
      JOIN permissions p ON p.id = rp.permission_id
      WHERE rp.role_id = ? AND p.code = 'view_students'
    `).get(req.user.role_id);

    if (!row || row.granted !== 1) {
      return res.status(403).json({ error: 'Forbidden' });
    }
  }

  const student = studentSvc.findById(id);
  if (!student) return res.status(404).json({ error: 'Student not found.' });
  if (student.status === 'Archived' && req.user.role !== 'sysadmin') {
    return res.status(403).json({ error: 'Forbidden.' });
  }

  auditLog({ actorId: req.user.id, actorName: req.user.full_name, actorRole: req.user.role,
    actionType: 'STUDENT_VIEWED', targetTable: 'students', targetId: id, ipAddress: req.ip });

  return res.json(student);
});

// ── PATCH /api/students/:id ──────────────────────────────────────────────────
router.patch('/:id', authMiddleware, requirePermission('manage_students'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Invalid ID.' });

  const student = studentSvc.findById(id);
  if (!student) return res.status(404).json({ error: 'Student not found.' });

  for (const f of FORBIDDEN_FIELDS) {
    if (req.body[f] !== undefined) return res.status(400).json({ error: `Field '${f}' is not permitted.` });
  }

  const isSysAdmin = req.user.role === 'sysadmin';
  const isLimited  = ['teacher','guidance'].includes(req.user.role);

  // Limited roles can only edit section and school_year
  const allowedFields = isSysAdmin || req.user.role === 'schoolhead'
    ? ['last_name','first_name','middle_initial','grade_level','section','school_year','guardian_name','guardian_contact']
    : isLimited ? ['section','school_year'] : [];

  const updates = {};
  for (const [k, v] of Object.entries(req.body)) {
    if (allowedFields.includes(k)) updates[k] = v;
  }

  // Block student_number edit if linked records exist
  if (req.body.student_number !== undefined && req.body.student_number !== student.student_number) {
    if (studentSvc.hasLinkedRecords(id)) {
      return res.status(422).json({ error: 'Cannot change student number: linked records exist.' });
    }
    if (isSysAdmin) updates.student_number = req.body.student_number;
  }

  if (!Object.keys(updates).length) {
    return res.status(400).json({ error: 'No valid fields to update.' });
  }

  const oldValues = {};
  for (const k of Object.keys(updates)) oldValues[k] = student[k];

  studentSvc.update(id, updates);

  auditLog({ actorId: req.user.id, actorName: req.user.full_name, actorRole: req.user.role,
    actionType: 'STUDENT_UPDATED', targetTable: 'students', targetId: id,
    oldValues, newValues: updates, ipAddress: req.ip });

  return res.json(studentSvc.findById(id));
});

// ── PATCH /api/students/:id/archive ─────────────────────────────────────────
router.patch('/:id/archive', authMiddleware, requirePermission('manage_students'), (req, res) => {
  if (req.user.role !== 'sysadmin') return res.status(403).json({ error: 'Forbidden.' });
  const id = parseInt(req.params.id, 10);
  const student = studentSvc.findById(id);
  if (!student) return res.status(404).json({ error: 'Student not found.' });
  studentSvc.archive(id);
  auditLog({ actorId: req.user.id, actorName: req.user.full_name, actorRole: req.user.role,
    actionType: 'STUDENT_ARCHIVED', targetTable: 'students', targetId: id, ipAddress: req.ip });
  return res.json({ message: 'Student archived.' });
});

// ── PATCH /api/students/:id/restore ─────────────────────────────────────────
router.patch('/:id/restore', authMiddleware, requirePermission('manage_students'), (req, res) => {
  if (req.user.role !== 'sysadmin') return res.status(403).json({ error: 'Forbidden.' });
  const id = parseInt(req.params.id, 10);
  const student = studentSvc.findById(id);
  if (!student) return res.status(404).json({ error: 'Student not found.' });
  studentSvc.restore(id);
  auditLog({ actorId: req.user.id, actorName: req.user.full_name, actorRole: req.user.role,
    actionType: 'STUDENT_RESTORED', targetTable: 'students', targetId: id, ipAddress: req.ip });
  return res.json({ message: 'Student restored.' });
});

module.exports = router;
