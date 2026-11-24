'use strict';

const express = require('express');
const authMiddleware = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const { log: auditLog } = require('../services/audit.service');
const categorySvc = require('../services/incident-category.service');

const router = express.Router();

// ── GET /api/incident-categories ─────────────────────────────────────────────
// Any authenticated user. Query param ?active_only=true limits to active rows.
router.get('/', authMiddleware, (req, res) => {
  const activeOnly = req.query.active_only === 'true';
  const data = activeOnly ? categorySvc.findAllActive() : categorySvc.findAll();
  return res.json({ data });
});

// ── POST /api/incident-categories ────────────────────────────────────────────
// SysAdmin only.
router.post('/', authMiddleware, requirePermission('manage_incident_categories'), (req, res) => {
  const { name } = req.body;

  if (!name || typeof name !== 'string' || name.trim() === '') {
    return res.status(400).json({ error: 'name is required and must be a non-empty string.' });
  }

  let result;
  try {
    result = categorySvc.create({ name: name.trim(), created_by: req.user.id });
  } catch (err) {
    if (err && err.message && err.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'A category with that name already exists.' });
    }
    throw err;
  }

  const created = categorySvc.findById(result.lastInsertRowid);

  auditLog({
    actorId: req.user.id,
    actorName: req.user.full_name,
    actorRole: req.user.role,
    actionType: 'INCIDENT_CATEGORY_CREATED',
    targetTable: 'incident_categories',
    targetId: result.lastInsertRowid,
    newValues: { name: created.name },
    ipAddress: req.ip,
  });

  return res.status(201).json(created);
});

// ── PATCH /api/incident-categories/:id ───────────────────────────────────────
// SysAdmin only.
router.patch('/:id', authMiddleware, requirePermission('manage_incident_categories'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: 'Invalid category ID.' });
  }

  const existing = categorySvc.findById(id);
  if (!existing) {
    return res.status(404).json({ error: 'Category not found.' });
  }

  const fields = {};

  if (req.body.name !== undefined) {
    if (typeof req.body.name !== 'string' || req.body.name.trim() === '') {
      return res.status(400).json({ error: 'name must be a non-empty string.' });
    }
    fields.name = req.body.name.trim();
  }

  if (req.body.is_active !== undefined) {
    const val = req.body.is_active;
    if (val !== 0 && val !== 1) {
      return res.status(400).json({ error: 'is_active must be 0 or 1.' });
    }
    fields.is_active = val;
  }

  if (Object.keys(fields).length === 0) {
    return res.status(400).json({ error: 'No valid fields to update.' });
  }

  try {
    categorySvc.update(id, fields);
  } catch (err) {
    if (err && err.message && err.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'A category with that name already exists.' });
    }
    throw err;
  }

  const updated = categorySvc.findById(id);

  auditLog({
    actorId: req.user.id,
    actorName: req.user.full_name,
    actorRole: req.user.role,
    actionType: 'INCIDENT_CATEGORY_UPDATED',
    targetTable: 'incident_categories',
    targetId: id,
    oldValues: { name: existing.name, is_active: existing.is_active },
    newValues: fields,
    ipAddress: req.ip,
  });

  return res.json(updated);
});

module.exports = router;
