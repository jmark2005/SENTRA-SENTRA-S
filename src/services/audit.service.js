'use strict';
const db = require('../repositories/db');

/**
 * Inserts one row into audit_logs.
 * audit_logs is append-only (enforced by DB triggers).
 *
 * @param {object} opts
 * @param {number|null} opts.actorId
 * @param {string}      opts.actorName
 * @param {string}      opts.actorRole
 * @param {string}      opts.actionType
 * @param {string|null} [opts.targetTable]
 * @param {number|null} [opts.targetId]
 * @param {object|null} [opts.oldValues]
 * @param {object|null} [opts.newValues]
 * @param {string|null} [opts.ipAddress]
 */
function log({ actorId, actorName, actorRole, actionType,
               targetTable = null, targetId = null,
               oldValues = null, newValues = null, ipAddress = null } = {}) {
  db.prepare(`
    INSERT INTO audit_logs
      (actor_id, actor_name, actor_role, action_type,
       target_table, target_id, old_values, new_values, ip_address)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    actorId   ?? null,
    actorName ?? 'SYSTEM',
    actorRole ?? 'system',
    actionType,
    targetTable ?? null,
    targetId    ?? null,
    oldValues   ? JSON.stringify(oldValues) : null,
    newValues   ? JSON.stringify(newValues) : null,
    ipAddress   ?? null,
  );
}

module.exports = { log };
