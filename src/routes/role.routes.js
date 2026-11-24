'use strict';
const express = require('express');
const db = require('../repositories/db');
const authMiddleware = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const { log: auditLog } = require('../services/audit.service');

const router = express.Router();

// Protected permissions that cannot be removed from sysadmin
const SYSADMIN_PROTECTED = ['manage_accounts', 'manage_roles_permissions'];

// GET /api/roles — authenticated users
router.get('/', authMiddleware, (req, res) => {
  const roles = db.prepare(`
    SELECT id, name, display_name, is_active, created_at FROM roles ORDER BY id
  `).all();
  return res.json({ data: roles });
});

// GET /api/roles/:id/permissions — authenticated users
router.get('/:id/permissions', authMiddleware, (req, res) => {
  const roleId = parseInt(req.params.id, 10);
  if (!roleId) return res.status(400).json({ error: 'Invalid role ID.' });

  const role = db.prepare('SELECT id, name, display_name FROM roles WHERE id = ?').get(roleId);
  if (!role) return res.status(404).json({ error: 'Role not found.' });

  const perms = db.prepare(`
    SELECT p.id, p.code, p.description, p.module,
           COALESCE(rp.granted, 0) AS granted
    FROM permissions p
    LEFT JOIN role_permissions rp ON rp.permission_id = p.id AND rp.role_id = ?
    ORDER BY p.module, p.code
  `).all(roleId);

  return res.json({ role, data: perms });
});

// PATCH /api/roles/:id/permissions — SysAdmin only
router.patch('/:id/permissions', authMiddleware, requirePermission('manage_roles_permissions'), (req, res) => {
  const roleId = parseInt(req.params.id, 10);
  if (!roleId) return res.status(400).json({ error: 'Invalid role ID.' });

  const { permission_id, granted } = req.body;
  if (permission_id == null || granted == null) {
    return res.status(400).json({ error: 'permission_id and granted are required.' });
  }

  const role = db.prepare('SELECT id, name FROM roles WHERE id = ?').get(roleId);
  if (!role) return res.status(404).json({ error: 'Role not found.' });

  const perm = db.prepare('SELECT id, code FROM permissions WHERE id = ?').get(permission_id);
  if (!perm) return res.status(404).json({ error: 'Permission not found.' });

  // Guard: cannot remove protected permissions from sysadmin
  if (role.name === 'sysadmin' && !granted && SYSADMIN_PROTECTED.includes(perm.code)) {
    return res.status(403).json({
      error: `Cannot remove '${perm.code}' from the sysadmin role.`,
    });
  }

  const now = new Date().toISOString();
  const grantedInt = granted ? 1 : 0;

  // Get old value for audit log
  const existing = db.prepare(
    'SELECT granted FROM role_permissions WHERE role_id = ? AND permission_id = ?'
  ).get(roleId, permission_id);
  const oldGranted = existing ? existing.granted : null;

  // Upsert the role_permission row
  db.prepare(`
    INSERT INTO role_permissions (role_id, permission_id, granted, updated_at, updated_by)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(role_id, permission_id) DO UPDATE SET
      granted = excluded.granted,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by
  `).run(roleId, permission_id, grantedInt, now, req.user.id);

  auditLog({
    actorId:     req.user.id,
    actorName:   req.user.full_name,
    actorRole:   req.user.role,
    actionType:  'ROLE_PERMISSION_CHANGED',
    targetTable: 'role_permissions',
    targetId:    roleId,
    oldValues:   { role: role.name, permission: perm.code, granted: oldGranted },
    newValues:   { role: role.name, permission: perm.code, granted: grantedInt },
    ipAddress:   req.ip,
  });

  return res.json({
    message: `Permission '${perm.code}' ${grantedInt ? 'granted to' : 'revoked from'} role '${role.name}'.`,
    role_id: roleId,
    permission_id,
    granted: grantedInt,
  });
});

module.exports = router;
