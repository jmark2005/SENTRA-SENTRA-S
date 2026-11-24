'use strict';
const db = require('../repositories/db');

/**
 * Create a notification for a single user.
 * @param {object} opts
 * @param {number} opts.userId
 * @param {string} opts.type  — must match the CHECK constraint in schema:
 *   'New Assignment'|'Pending Incident'|'Follow-Up Reminder'|'Overdue Action'|
 *   'Escalated'|'Emergency Alert'|'Account Approval'|'System Notice'
 * @param {string} opts.title
 * @param {string} opts.message
 * @param {string|null} [opts.link]
 * @returns {number} inserted row id
 */
function create({ userId, type, title, message, link = null }) {
  const result = db.prepare(`
    INSERT INTO notifications (user_id, type, title, message, link)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, type, title, message, link);
  return result.lastInsertRowid;
}

/**
 * Create a notification for every Active user with the given role name.
 * @param {string} roleName  e.g. 'sysadmin'
 * @param {object} opts      same shape as create() minus userId
 * @returns {number[]} array of inserted row ids
 */
function createForRole(roleName, { type, title, message, link = null }) {
  const users = db.prepare(`
    SELECT u.id FROM users u
    JOIN roles r ON r.id = u.role_id
    WHERE r.name = ? AND u.status = 'Active'
  `).all(roleName);

  return users.map(u => create({ userId: u.id, type, title, message, link }));
}

module.exports = { create, createForRole };
