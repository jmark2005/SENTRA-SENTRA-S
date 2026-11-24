'use strict';
const db = require('../repositories/db');

/**
 * Factory that returns Express middleware checking whether the
 * authenticated user's role has the given permission code granted.
 *
 * Usage: router.get('/protected', authMiddleware, requirePermission('view_audit_log'), handler)
 */
function requirePermission(code) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const row = db.prepare(`
      SELECT rp.granted
      FROM role_permissions rp
      JOIN permissions p ON p.id = rp.permission_id
      WHERE rp.role_id = ? AND p.code = ?
    `).get(req.user.role_id, code);

    if (!row || row.granted !== 1) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    return next();
  };
}

module.exports = { requirePermission };
