'use strict';

const db = require('./db');

/**
 * Returns all escalation rules, joined with the escalation user's name.
 */
function findAll() {
  return db.prepare(`
    SELECT er.id, er.severity, er.watch_status, er.time_target_minutes,
           er.escalation_user_id, er.is_active, er.created_at, er.created_by,
           u.full_name AS escalation_user_name,
           u.username   AS escalation_user_username
    FROM escalation_rules er
    LEFT JOIN users u ON u.id = er.escalation_user_id
    ORDER BY er.id ASC
  `).all();
}

/**
 * Returns a single escalation rule by id, joined with the escalation user's name.
 */
function findById(id) {
  return db.prepare(`
    SELECT er.id, er.severity, er.watch_status, er.time_target_minutes,
           er.escalation_user_id, er.is_active, er.created_at, er.created_by,
           u.full_name AS escalation_user_name,
           u.username   AS escalation_user_username
    FROM escalation_rules er
    LEFT JOIN users u ON u.id = er.escalation_user_id
    WHERE er.id = ?
  `).get(id);
}

/**
 * Inserts a new escalation rule.
 * @returns {object} better-sqlite3 RunResult with lastInsertRowid
 */
function create({ severity, watch_status, time_target_minutes, escalation_user_id, is_active, created_by }) {
  return db.prepare(`
    INSERT INTO escalation_rules
      (severity, watch_status, time_target_minutes, escalation_user_id, is_active, created_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    severity,
    watch_status,
    time_target_minutes,
    escalation_user_id,
    is_active ?? 1,
    created_by ?? null,
  );
}

/**
 * Updates the provided fields for the given id.
 * @param {number} id
 * @param {object} fields — subset of { severity, watch_status, time_target_minutes, escalation_user_id, is_active }
 * @returns {object} better-sqlite3 RunResult
 */
function update(id, fields) {
  const setClauses = [];
  const params     = [];

  if (fields.severity             !== undefined) { setClauses.push('severity = ?');             params.push(fields.severity);             }
  if (fields.watch_status         !== undefined) { setClauses.push('watch_status = ?');         params.push(fields.watch_status);         }
  if (fields.time_target_minutes  !== undefined) { setClauses.push('time_target_minutes = ?');  params.push(fields.time_target_minutes);  }
  if (fields.escalation_user_id   !== undefined) { setClauses.push('escalation_user_id = ?');    params.push(fields.escalation_user_id);   }
  if (fields.is_active            !== undefined) { setClauses.push('is_active = ?');             params.push(fields.is_active);            }

  if (setClauses.length === 0) return { changes: 0 };

  params.push(id);
  return db.prepare(`
    UPDATE escalation_rules
    SET ${setClauses.join(', ')}
    WHERE id = ?
  `).run(...params);
}

module.exports = { findAll, findById, create, update };
