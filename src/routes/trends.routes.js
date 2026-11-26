'use strict';

const express = require('express');
const db = require('../repositories/db');
const authMiddleware = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');

const router = express.Router();

// ── GET /api/trends/by-category ───────────────────────────────────────────────
// Groups non-archived incidents by category and optional time range.
// ?from=YYYY-MM-DD  &to=YYYY-MM-DD  &period=   (period echoed back as metadata)
// Returns: { data: [{category_id, category, count}], period }
router.get('/by-category', authMiddleware, requirePermission('view_reports'), (req, res) => {
  const { from, to, period } = req.query;
  const { role } = req.user;

  const conditions = ['i.is_archived = 0'];
  const params = [];

  if (from) { conditions.push('i.incident_date >= ?'); params.push(from); }
  if (to)   { conditions.push('i.incident_date <= ?'); params.push(to); }

  if (role !== 'sysadmin' && role !== 'schoolhead') {
    conditions.push('i.is_restricted = 0');
  }

  const where = 'WHERE ' + conditions.join(' AND ');

  const rows = db.prepare(`
    SELECT c.id AS category_id, c.name AS category, COUNT(*) AS count
    FROM   incidents i
    JOIN   incident_categories c ON c.id = i.category_id
    ${where}
    GROUP  BY c.id
    ORDER  BY count DESC, c.name ASC
  `).all(...params);

  return res.json({ data: rows, period: period || null });
});

// ── GET /api/trends/by-location ───────────────────────────────────────────────
// Groups non-archived incidents by campus_location_id.
// Incidents with no campus_location fall under their location_text value.
// ?from=YYYY-MM-DD  &to=YYYY-MM-DD  &category=<id>
// Returns: { data: [{location_id, location_name, count}] }
router.get('/by-location', authMiddleware, requirePermission('view_reports'), (req, res) => {
  const { from, to, category } = req.query;
  const { role } = req.user;

  const conditions = ['i.is_archived = 0'];
  const params = [];

  if (from)     { conditions.push('i.incident_date >= ?'); params.push(from); }
  if (to)       { conditions.push('i.incident_date <= ?'); params.push(to); }
  if (category) { conditions.push('i.category_id = ?');   params.push(parseInt(category, 10)); }

  if (role !== 'sysadmin' && role !== 'schoolhead') {
    conditions.push('i.is_restricted = 0');
  }

  const where = 'WHERE ' + conditions.join(' AND ');

  // Incidents with a campus_location use the location name;
  // incidents without (NULL campus_location_id) group by location_text.
  const rows = db.prepare(`
    SELECT
      i.campus_location_id AS location_id,
      COALESCE(cl.name, i.location_text) AS location_name,
      COUNT(*) AS count
    FROM   incidents i
    LEFT JOIN campus_locations cl ON cl.id = i.campus_location_id
    ${where}
    GROUP  BY COALESCE(cl.name, i.location_text)
    ORDER  BY count DESC, location_name ASC
  `).all(...params);

  return res.json({ data: rows });
});

// ── GET /api/trends/over-time ─────────────────────────────────────────────────
// Groups non-archived incidents into time buckets.
// ?from=YYYY-MM-DD  &to=YYYY-MM-DD  &period=daily|weekly|monthly|semester
// Returns: { data: [{period_label, count}], period }
router.get('/over-time', authMiddleware, requirePermission('view_reports'), (req, res) => {
  const { from, to, period } = req.query;
  const { role } = req.user;

  const allowedPeriods = ['daily', 'weekly', 'monthly', 'semester'];
  const resolvedPeriod = allowedPeriods.includes(period) ? period : 'monthly';

  const conditions = ['i.is_archived = 0'];
  const params = [];

  if (from) { conditions.push('i.incident_date >= ?'); params.push(from); }
  if (to)   { conditions.push('i.incident_date <= ?'); params.push(to); }

  if (role !== 'sysadmin' && role !== 'schoolhead') {
    conditions.push('i.is_restricted = 0');
  }

  const where = 'WHERE ' + conditions.join(' AND ');

  // Build period_label expression for SQLite
  let labelExpr;
  switch (resolvedPeriod) {
    case 'daily':
      labelExpr = "strftime('%Y-%m-%d', i.incident_date)";
      break;
    case 'weekly':
      // ISO-ish week: YYYY-Www (strftime %W = week 00-53 starting Sunday)
      labelExpr = "strftime('%Y-W', i.incident_date) || printf('%02d', cast(strftime('%W', i.incident_date) AS INTEGER))";
      break;
    case 'monthly':
      labelExpr = "strftime('%Y-%m', i.incident_date)";
      break;
    case 'semester':
      // 'YYYY S1' (Jan-Jun) or 'YYYY S2' (Jul-Dec)
      labelExpr = "strftime('%Y', i.incident_date) || ' S' || CASE WHEN cast(strftime('%m', i.incident_date) AS INTEGER) <= 6 THEN '1' ELSE '2' END";
      break;
    default:
      labelExpr = "strftime('%Y-%m', i.incident_date)";
  }

  const rows = db.prepare(`
    SELECT ${labelExpr} AS period_label, COUNT(*) AS count
    FROM   incidents i
    ${where}
    GROUP  BY period_label
    ORDER  BY period_label ASC
  `).all(...params);

  return res.json({ data: rows, period: resolvedPeriod });
});

module.exports = router;
