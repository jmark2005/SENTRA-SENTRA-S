'use strict';

const express = require('express');

const authMiddleware        = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const attendanceSvc         = require('../services/attendance.service');

const router = express.Router();

function parseId(raw) {
  return /^[1-9]\d{0,9}$/.test(String(raw)) ? parseInt(raw, 10) : null;
}

/** Runs fn and turns AttendanceError into a JSON response. */
function handle(res, fn, okStatus = 200) {
  let result;
  try {
    result = fn();
  } catch (err) {
    if (err instanceof attendanceSvc.AttendanceError) {
      return res.status(err.status).json({ error: err.message });
    }
    throw err;
  }
  return res.status(okStatus).json(result);
}

// GET /api/attendance/classes?school_year=&semester=&all=1
// Teacher: own classes; SchHead, Guidance, SysAdmin: all. Defaults to the current year/semester.
router.get('/classes', authMiddleware, requirePermission('view_attendance'), (req, res) =>
  handle(res, () => attendanceSvc.listClasses(req.user, req.query)));

// GET /api/attendance/classes/:classId/date/:date — roster with any existing records
router.get('/classes/:classId/date/:date', authMiddleware, requirePermission('view_attendance'), (req, res) => {
  const classId = parseId(req.params.classId);
  if (!classId) return res.status(400).json({ error: 'Invalid class ID.' });
  return handle(res, () => attendanceSvc.getDay(req.user, classId, req.params.date));
});

// POST /api/attendance/classes/:classId/date/:date  { records: [{ student_id, status }] }
router.post('/classes/:classId/date/:date', authMiddleware, requirePermission('record_attendance'), (req, res) => {
  const classId = parseId(req.params.classId);
  if (!classId) return res.status(400).json({ error: 'Invalid class ID.' });
  return handle(res, () => attendanceSvc.submitDay(
    { user: req.user, ip: req.ip }, classId, req.params.date, req.body || {}), 201);
});

// GET /api/attendance/summary?student=&class=&section=&semester=&school_year=&from=&to=&status=&archived=1
router.get('/summary', authMiddleware, requirePermission('view_attendance'), (req, res) =>
  handle(res, () => attendanceSvc.summary({ user: req.user, ip: req.ip }, req.query)));

// PATCH /api/attendance/archive and /restore  { class_id, semester }  — SysAdmin only.
// MUST be before /:id.
router.patch('/archive', authMiddleware, requirePermission('view_attendance'), (req, res) =>
  handle(res, () => attendanceSvc.archive({ user: req.user, ip: req.ip }, req.body || {})));
router.patch('/restore', authMiddleware, requirePermission('view_attendance'), (req, res) =>
  handle(res, () => attendanceSvc.restore({ user: req.user, ip: req.ip }, req.body || {})));

// PATCH /api/attendance/:id  { status, reason }  — correction
router.patch('/:id', authMiddleware, requirePermission('record_attendance'), (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid attendance ID.' });
  return handle(res, () => attendanceSvc.correct({ user: req.user, ip: req.ip }, id, req.body || {}));
});

module.exports = router;
