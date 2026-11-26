'use strict';

const express = require('express');
const db = require('../repositories/db');
const authMiddleware = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const { log: auditLog } = require('../services/audit.service');
const locationSvc = require('../services/campus-location.service');

const router = express.Router();

// ── GET /api/campus-locations ─────────────────────────────────────────────────
// Any authenticated user.
// Query param ?active_only=true limits to active rows (used by incident forms).
router.get('/', authMiddleware, (req, res) => {
  const activeOnly = req.query.active_only === 'true';
  const data = activeOnly ? locationSvc.findAllActive() : locationSvc.findAll();
  return res.json({ data });
});

// ── GET /api/campus-locations/map-data ───────────────────────────────────────
// Aggregates non-restricted, non-archived incident counts per active location.
// ?category=<id>  &from=YYYY-MM-DD  &to=YYYY-MM-DD
// Returns [{ location_id, name, coord_x, coord_y, count, incidents:[{ref,category,status}] }]
router.get('/map-data', authMiddleware, (req, res) => {
  const { category, from, to } = req.query;
  const { role } = req.user;

  // Build incident filter conditions (non-archived, non-restricted for limited roles)
  const incConditions = ['i.is_archived = 0', 'i.campus_location_id IS NOT NULL'];
  const incParams = [];

  if (role !== 'sysadmin' && role !== 'schoolhead' && role !== 'safetyofficer') {
    incConditions.push('i.is_restricted = 0');
  }
  if (category) { incConditions.push('i.category_id = ?'); incParams.push(parseInt(category, 10)); }
  if (from)     { incConditions.push('i.incident_date >= ?'); incParams.push(from); }
  if (to)       { incConditions.push('i.incident_date <= ?'); incParams.push(to); }

  const incWhere = 'WHERE ' + incConditions.join(' AND ');

  // Fetch all active locations
  const locations = db.prepare(
    'SELECT id, name, coord_x, coord_y FROM campus_locations WHERE is_active = 1 ORDER BY name ASC'
  ).all();

  // Fetch matching incidents grouped by location with detail list
  const incidentRows = db.prepare(`
    SELECT i.campus_location_id AS location_id,
           i.id, i.reference_number, i.status,
           c.name AS category
    FROM   incidents i
    JOIN   incident_categories c ON c.id = i.category_id
    ${incWhere}
    ORDER  BY i.created_at DESC
  `).all(...incParams);

  // Group incidents by location_id
  const incByLoc = {};
  for (const row of incidentRows) {
    if (!incByLoc[row.location_id]) incByLoc[row.location_id] = [];
    incByLoc[row.location_id].push({ id: row.id, ref: row.reference_number, category: row.category, status: row.status });
  }

  // Build response — only include locations that have coords (can still include 0-count locations)
  const data = locations
    .filter(loc => loc.coord_x !== null && loc.coord_y !== null)
    .map(loc => ({
      location_id: loc.id,
      name:        loc.name,
      coord_x:     loc.coord_x,
      coord_y:     loc.coord_y,
      count:       (incByLoc[loc.id] || []).length,
      incidents:   (incByLoc[loc.id] || []),
    }));

  return res.json({ data });
});

// ── POST /api/campus-locations ────────────────────────────────────────────────
// SysAdmin only (manage_incident_categories permission guards this, same as categories).
router.post('/', authMiddleware, requirePermission('manage_incident_categories'), (req, res) => {
  const { name, description, coord_x, coord_y } = req.body;

  if (!name || typeof name !== 'string' || name.trim() === '') {
    return res.status(400).json({ error: 'name is required and must be a non-empty string.' });
  }

  // Validate coord ranges if provided
  if (coord_x !== undefined && coord_x !== null && coord_x !== '') {
    const cx = Number(coord_x);
    if (isNaN(cx) || cx < 0 || cx > 100) {
      return res.status(400).json({ error: 'coord_x must be a number between 0 and 100.' });
    }
  }
  if (coord_y !== undefined && coord_y !== null && coord_y !== '') {
    const cy = Number(coord_y);
    if (isNaN(cy) || cy < 0 || cy > 100) {
      return res.status(400).json({ error: 'coord_y must be a number between 0 and 100.' });
    }
  }

  let result;
  try {
    result = locationSvc.create({
      name:        name.trim(),
      description: description ? String(description).trim() : null,
      coord_x:     (coord_x !== undefined && coord_x !== null && coord_x !== '') ? Number(coord_x) : null,
      coord_y:     (coord_y !== undefined && coord_y !== null && coord_y !== '') ? Number(coord_y) : null,
      created_by:  req.user.id,
    });
  } catch (err) {
    if (err && err.message && err.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'A campus location with that name already exists.' });
    }
    throw err;
  }

  const created = locationSvc.findById(result.lastInsertRowid);

  auditLog({
    actorId:     req.user.id,
    actorName:   req.user.full_name,
    actorRole:   req.user.role,
    actionType:  'CAMPUS_LOCATION_CREATED',
    targetTable: 'campus_locations',
    targetId:    result.lastInsertRowid,
    newValues:   { name: created.name, description: created.description, coord_x: created.coord_x, coord_y: created.coord_y },
    ipAddress:   req.ip,
  });

  return res.status(201).json(created);
});

// ── PATCH /api/campus-locations/:id ──────────────────────────────────────────
// SysAdmin only.
router.patch('/:id', authMiddleware, requirePermission('manage_incident_categories'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: 'Invalid campus location ID.' });
  }

  const existing = locationSvc.findById(id);
  if (!existing) {
    return res.status(404).json({ error: 'Campus location not found.' });
  }

  const fields = {};

  if (req.body.name !== undefined) {
    if (typeof req.body.name !== 'string' || req.body.name.trim() === '') {
      return res.status(400).json({ error: 'name must be a non-empty string.' });
    }
    fields.name = req.body.name.trim();
  }

  if (req.body.description !== undefined) {
    fields.description = req.body.description ? String(req.body.description).trim() : null;
  }

  if (req.body.coord_x !== undefined) {
    if (req.body.coord_x === null || req.body.coord_x === '') {
      fields.coord_x = null;
    } else {
      const cx = Number(req.body.coord_x);
      if (isNaN(cx) || cx < 0 || cx > 100) {
        return res.status(400).json({ error: 'coord_x must be a number between 0 and 100.' });
      }
      fields.coord_x = cx;
    }
  }

  if (req.body.coord_y !== undefined) {
    if (req.body.coord_y === null || req.body.coord_y === '') {
      fields.coord_y = null;
    } else {
      const cy = Number(req.body.coord_y);
      if (isNaN(cy) || cy < 0 || cy > 100) {
        return res.status(400).json({ error: 'coord_y must be a number between 0 and 100.' });
      }
      fields.coord_y = cy;
    }
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
    locationSvc.update(id, fields);
  } catch (err) {
    if (err && err.message && err.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'A campus location with that name already exists.' });
    }
    throw err;
  }

  const updated = locationSvc.findById(id);

  auditLog({
    actorId:     req.user.id,
    actorName:   req.user.full_name,
    actorRole:   req.user.role,
    actionType:  'CAMPUS_LOCATION_UPDATED',
    targetTable: 'campus_locations',
    targetId:    id,
    oldValues:   {
      name:        existing.name,
      description: existing.description,
      coord_x:     existing.coord_x,
      coord_y:     existing.coord_y,
      is_active:   existing.is_active,
    },
    newValues:   fields,
    ipAddress:   req.ip,
  });

  return res.json(updated);
});

module.exports = router;
