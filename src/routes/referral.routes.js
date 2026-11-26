'use strict';

const express = require('express');

const authMiddleware        = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const referralSvc           = require('../services/referral.service');

const router = express.Router();

function parseId(raw) {
  return /^[1-9]\d{0,9}$/.test(String(raw)) ? parseInt(raw, 10) : null;
}

function sendError(res, err) {
  if (err instanceof referralSvc.ReferralError) {
    return res.status(err.status).json({ error: err.message });
  }
  throw err;
}

// ── POST /api/referrals ──────────────────────────────────────────────────────
// Body: { student_id, referral_type, referral_date, remarks? }
router.post('/', authMiddleware, requirePermission('submit_referral'), (req, res) => {
  let id;
  try {
    id = referralSvc.submit({ user: req.user, ip: req.ip }, req.body || {});
  } catch (err) {
    return sendError(res, err);
  }
  const referral = referralSvc.findById(id);
  return res.status(201).json(referralSvc.detailFor(req.user, referral));
});

// ── GET /api/referrals ───────────────────────────────────────────────────────
// Query: ?status=&type=&student=   (role-scoped, archived excluded)
router.get('/', authMiddleware, requirePermission('view_referrals'), (req, res) => {
  const { status, type, student } = req.query;
  if (status && !referralSvc.STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${referralSvc.STATUSES.join(', ')}.` });
  }
  if (type && !referralSvc.TYPES.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${referralSvc.TYPES.join(', ')}.` });
  }
  const rows = referralSvc.list({
    userId:    req.user.id,
    role:      req.user.role,
    status:    status || undefined,
    type:      type || undefined,
    studentId: student ? parseId(student) || -1 : undefined,
  });
  // List rows never include remarks or final notes
  const data = rows.map(({ remarks, completion_note, referred_destination, ...row }) => row);
  return res.json({ data });
});

// ── GET /api/referrals/assignable-users (Guidance, School Head) ──────────────
// For the Assign picker (T-28B). MUST be before /:id.
router.get('/assignable-users', authMiddleware, requirePermission('manage_referrals'), (req, res) => {
  if (!referralSvc.isManager(req.user)) return res.status(403).json({ error: 'Forbidden.' });
  return res.json({ data: referralSvc.listAssignableUsers() });
});

// ── GET /api/referrals/archived (SysAdmin) ───────────────────────────────────
// MUST be before /:id.
router.get('/archived', authMiddleware, requirePermission('manage_referrals'), (req, res) => {
  if (req.user.role !== 'sysadmin') return res.status(403).json({ error: 'Forbidden.' });
  const data = referralSvc.listArchived().map(({ remarks, completion_note, referred_destination, ...row }) => row);
  return res.json({ data });
});

// ── GET /api/referrals/:id ───────────────────────────────────────────────────
router.get('/:id', authMiddleware, requirePermission('view_referrals'), (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid referral ID.' });
  const referral = referralSvc.findById(id);
  if (!referral) return res.status(404).json({ error: 'Referral not found.' });
  if (!referralSvc.canUserView(req.user, referral)) return res.status(403).json({ error: 'Forbidden.' });
  return res.json(referralSvc.detailFor(req.user, referral));
});

// ── T-28: assign, follow-ups, status, archive ────────────────────────────────

/**
 * Loads the referral, applies the same visibility rule as GET /:id, runs the
 * action, and replies with the updated referral (or `created` with 201).
 */
function referralRoute(action, { created = false } = {}) {
  return (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid referral ID.' });
    const referral = referralSvc.findById(id);
    if (!referral) return res.status(404).json({ error: 'Referral not found.' });
    if (!referralSvc.canUserView(req.user, referral)) return res.status(403).json({ error: 'Forbidden.' });

    let result;
    try {
      result = action({ user: req.user, ip: req.ip }, referral, req.body || {});
    } catch (err) {
      return sendError(res, err);
    }
    if (created) return res.status(201).json(result);
    return res.json(referralSvc.detailFor(req.user, referralSvc.findById(id)));
  };
}

// PATCH /api/referrals/:id/assign  { user_id }  — Guidance or School Head
router.patch('/:id/assign', authMiddleware, requirePermission('manage_referrals'),
  referralRoute(referralSvc.assign));

// POST /api/referrals/:id/followups  { activity_desc, activity_date?, next_followup? }
// Assigned person or School Head (checked in the service)
router.post('/:id/followups', authMiddleware, requirePermission('view_referrals'),
  referralRoute(referralSvc.addFollowup, { created: true }));

// PATCH /api/referrals/:id/status  { status: Completed|Referred, completion_note?, referred_destination? }
router.patch('/:id/status', authMiddleware, requirePermission('manage_referrals'),
  referralRoute(referralSvc.changeStatus));

// PATCH /api/referrals/:id/archive  { confirmed? }  and  /restore  — SysAdmin only
router.patch('/:id/archive', authMiddleware, requirePermission('manage_referrals'),
  referralRoute(referralSvc.archive));
router.patch('/:id/restore', authMiddleware, requirePermission('manage_referrals'),
  referralRoute(referralSvc.restore));

module.exports = router;
