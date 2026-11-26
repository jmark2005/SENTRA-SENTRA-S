'use strict';

const express = require('express');
const db = require('../repositories/db');
const authMiddleware = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const { log: auditLog } = require('../services/audit.service');
const ruleSvc = require('../services/escalation-rule.service');

const router = express.Router();

const ALLOWED_SEVERITIES   = ['Low', 'Moderate', 'High', 'Critical'];
const ALLOWED_WATCH_STATUS = ['In Progress', 'For Follow-Up'];

// ── GET /api/escalation-rules ─────────────────────────────────────────────────
router.get('/', authMiddleware, requirePermission('manage_escalation_rules'), (req, res) => {
  const data = ruleSvc.findAll();
  return res.json({ data });
});

// ── POST /api/escalation-rules ────────────────────────────────────────────────
router.post('/', authMiddleware, requirePermission('manage_escalation_rules'), (req, res) => {
  const { severity, watch_status, time_target_minutes, escalation_user_id, is_active } = req.body;

  // severity
  if (!severity || !ALLOWED_SEVERITIES.includes(severity)) {
    return res.status(400).json({ error: 'severity must be one of: Low, Moderate, High, Critical.' });
  }

  // watch_status
  if (!watch_status || !ALLOWED_WATCH_STATUS.includes(watch_status)) {
    return res.status(400).json({ error: 'watch_status must be one of: In Progress, For Follow-Up.' });
  }

  // time_target_minutes — positive integer >= 1 (allow 1 for testing)
  const ttm = Number(time_target_minutes);
  if (isNaN(ttm) || !Number.isInteger(ttm) || ttm < 1) {
    return res.status(400).json({ error: 'time_target_minutes must be a positive integer (>= 1).' });
  }

  // escalation_user_id — must reference an existing user
  const uid = parseInt(escalation_user_id, 10);
  if (!uid || isNaN(uid)) {
    return res.status(400).json({ error: 'escalation_user_id is required and must be a valid user id.' });
  }
  const user = db.prepare('SELECT id, full_name FROM users WHERE id = ?').get(uid);
  if (!user) {
    return res.status(400).json({ error: 'escalation_user_id does not reference an existing user.' });
  }

  // is_active
  let active = 1;
  if (is_active !== undefined) {
    if (is_active !== 0 && is_active !== 1) {
      return res.status(400).json({ error: 'is_active must be 0 or 1.' });
    }
    active = is_active;
  }

  const result = ruleSvc.create({
    severity,
    watch_status,
    time_target_minutes: ttm,
    escalation_user_id: uid,
    is_active: active,
    created_by: req.user.id,
  });

  const created = ruleSvc.findById(result.lastInsertRowid);

  auditLog({
    actorId:     req.user.id,
    actorName:   req.user.full_name,
    actorRole:   req.user.role,
    actionType:  'ESCALATION_RULE_CREATED',
    targetTable: 'escalation_rules',
    targetId:    result.lastInsertRowid,
    newValues:   {
      severity,
      watch_status,
      time_target_minutes: ttm,
      escalation_user_id:  uid,
      is_active:            active,
    },
    ipAddress:   req.ip,
  });

  return res.status(201).json(created);
});

// ── PATCH /api/escalation-rules/:id ───────────────────────────────────────────
router.patch('/:id', authMiddleware, requirePermission('manage_escalation_rules'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: 'Invalid escalation rule ID.' });
  }

  const existing = ruleSvc.findById(id);
  if (!existing) {
    return res.status(404).json({ error: 'Escalation rule not found.' });
  }

  const fields = {};

  if (req.body.severity !== undefined) {
    if (!ALLOWED_SEVERITIES.includes(req.body.severity)) {
      return res.status(400).json({ error: 'severity must be one of: Low, Moderate, High, Critical.' });
    }
    fields.severity = req.body.severity;
  }

  if (req.body.watch_status !== undefined) {
    if (!ALLOWED_WATCH_STATUS.includes(req.body.watch_status)) {
      return res.status(400).json({ error: 'watch_status must be one of: In Progress, For Follow-Up.' });
    }
    fields.watch_status = req.body.watch_status;
  }

  if (req.body.time_target_minutes !== undefined) {
    const ttm = Number(req.body.time_target_minutes);
    if (isNaN(ttm) || !Number.isInteger(ttm) || ttm < 1) {
      return res.status(400).json({ error: 'time_target_minutes must be a positive integer (>= 1).' });
    }
    fields.time_target_minutes = ttm;
  }

  if (req.body.escalation_user_id !== undefined) {
    const uid = parseInt(req.body.escalation_user_id, 10);
    if (!uid || isNaN(uid)) {
      return res.status(400).json({ error: 'escalation_user_id must be a valid user id.' });
    }
    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(uid);
    if (!user) {
      return res.status(400).json({ error: 'escalation_user_id does not reference an existing user.' });
    }
    fields.escalation_user_id = uid;
  }

  if (req.body.is_active !== undefined) {
    if (req.body.is_active !== 0 && req.body.is_active !== 1) {
      return res.status(400).json({ error: 'is_active must be 0 or 1.' });
    }
    fields.is_active = req.body.is_active;
  }

  if (Object.keys(fields).length === 0) {
    return res.status(400).json({ error: 'No valid fields to update.' });
  }

  ruleSvc.update(id, fields);
  const updated = ruleSvc.findById(id);

  auditLog({
    actorId:     req.user.id,
    actorName:   req.user.full_name,
    actorRole:   req.user.role,
    actionType:  'ESCALATION_RULE_UPDATED',
    targetTable: 'escalation_rules',
    targetId:    id,
    oldValues:   {
      severity:            existing.severity,
      watch_status:        existing.watch_status,
      time_target_minutes: existing.time_target_minutes,
      escalation_user_id:  existing.escalation_user_id,
      is_active:           existing.is_active,
    },
    newValues:   fields,
    ipAddress:   req.ip,
  });

  return res.json(updated);
});

module.exports = router;
