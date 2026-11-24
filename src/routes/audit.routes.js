'use strict';
const express = require('express');
const db = require('../repositories/db');
const authMiddleware = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');

const router = express.Router();

const SCHOOLHEAD_EXCLUDED_ACTIONS = [
  'ACCOUNT_CREATED','PASSWORD_CHANGED','ACCOUNT_STATUS_CHANGED',
  'SEED','ROLE_PERMISSION_CHANGED','SETTINGS_CHANGED',
];

router.get('/', authMiddleware, requirePermission('view_audit_log'), (req, res) => {
  const page  = Math.max(1, parseInt(req.query.page, 10)  || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const offset = (page - 1) * limit;

  const { from, to, actor, action_type } = req.query;

  const conditions = [];
  const params     = [];

  if (from) { conditions.push("date(a.created_at) >= date(?)"); params.push(from); }
  if (to)   { conditions.push("date(a.created_at) <= date(?)"); params.push(to);   }
  if (actor) { conditions.push("a.actor_name LIKE ?"); params.push(`%${actor}%`); }
  if (action_type) { conditions.push("a.action_type = ?"); params.push(action_type); }

  if (req.user.role === 'schoolhead') {
    const placeholders = SCHOOLHEAD_EXCLUDED_ACTIONS.map(() => '?').join(',');
    conditions.push(`a.action_type NOT IN (${placeholders})`);
    params.push(...SCHOOLHEAD_EXCLUDED_ACTIONS);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const total = db.prepare(`SELECT COUNT(*) AS n FROM audit_logs a ${where}`).get(...params).n;
  const rows  = db.prepare(`
    SELECT a.id, a.actor_id, a.actor_name, a.actor_role, a.action_type,
           a.target_table, a.target_id, a.old_values, a.new_values,
           a.ip_address, a.created_at
    FROM audit_logs a
    ${where}
    ORDER BY a.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const data = rows.map(r => ({
    ...r,
    old_values: r.old_values ? JSON.parse(r.old_values) : null,
    new_values: r.new_values ? JSON.parse(r.new_values) : null,
  }));

  return res.json({
    data,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
});

module.exports = router;
