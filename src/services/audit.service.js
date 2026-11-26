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

/** Action types the School Head may not see (account and permission management). */
const SCHOOLHEAD_EXCLUDED_ACTIONS = [
  'ACCOUNT_CREATED', 'PASSWORD_CHANGED', 'ACCOUNT_STATUS_CHANGED',
  'SEED', 'ROLE_PERMISSION_CHANGED', 'SETTINGS_CHANGED',
];

/**
 * WHERE clause for reading audit_logs (alias `a`) as `user`, shared by the
 * audit log viewer and the audit log export. Filters: from, to, actor, action_type.
 * @returns {{ where: string, params: any[] }}
 */
function buildFilter(user, { from, to, actor, action_type } = {}) {
  const conditions = [];
  const params     = [];

  if (from)        { conditions.push('date(a.created_at) >= date(?)'); params.push(from); }
  if (to)          { conditions.push('date(a.created_at) <= date(?)'); params.push(to); }
  if (actor)       { conditions.push('a.actor_name LIKE ?'); params.push(`%${actor}%`); }
  if (action_type) { conditions.push('a.action_type = ?'); params.push(action_type); }

  if (user.role === 'schoolhead') {
    conditions.push(`a.action_type NOT IN (${SCHOOLHEAD_EXCLUDED_ACTIONS.map(() => '?').join(',')})`);
    params.push(...SCHOOLHEAD_EXCLUDED_ACTIONS);
  }

  return { where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', params };
}

module.exports = { log, buildFilter, SCHOOLHEAD_EXCLUDED_ACTIONS };
