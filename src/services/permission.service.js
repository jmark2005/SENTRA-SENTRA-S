'use strict';
const db = require('../repositories/db');

/**
 * Returns a Set of permission codes granted to the given user's role.
 * Used by GET /api/auth/me and elsewhere.
 */
function getUserPermissions(userId) {
  const rows = db.prepare(`
    SELECT p.code
    FROM users u
    JOIN role_permissions rp ON rp.role_id = u.role_id
    JOIN permissions p       ON p.id = rp.permission_id
    WHERE u.id = ? AND rp.granted = 1
  `).all(userId);
  return new Set(rows.map(r => r.code));
}

module.exports = { getUserPermissions };
