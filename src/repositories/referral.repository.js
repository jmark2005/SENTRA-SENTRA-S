'use strict';

const db = require('./db');

const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";

const SELECT_REFERRAL = `
  SELECT r.id, r.student_id, r.referral_type, r.referral_date, r.referring_user,
         r.assigned_to, r.status, r.remarks, r.completion_note, r.referred_destination,
         r.is_archived, r.created_at, r.updated_at,
         s.student_number, s.last_name AS student_last_name, s.first_name AS student_first_name,
         s.grade_level, s.section,
         ru.full_name AS referring_user_name,
         au.full_name AS assigned_to_name
  FROM   referrals r
  JOIN   students s  ON s.id  = r.student_id
  JOIN   users    ru ON ru.id = r.referring_user
  LEFT JOIN users au ON au.id = r.assigned_to`;

function findActiveStudent(id) {
  return db.prepare(`
    SELECT id, student_number, last_name, first_name
    FROM   students WHERE id = ? AND status = 'Active'
  `).get(id);
}

function create({ student_id, referral_type, referral_date, referring_user, remarks }) {
  return Number(db.prepare(`
    INSERT INTO referrals (student_id, referral_type, referral_date, referring_user, remarks)
    VALUES (?, ?, ?, ?, ?)
  `).run(student_id, referral_type, referral_date, referring_user, remarks || null).lastInsertRowid);
}

function findById(id) {
  return db.prepare(`${SELECT_REFERRAL} WHERE r.id = ?`).get(id);
}

/**
 * Role-scoped list of non-archived referrals.
 *   SysAdmin, SchHead: all
 *   Guidance: unassigned Pending (the queue), assigned to self, or submitted by self
 *   Teacher:  submitted by self or assigned to self
 */
function list({ userId, role, status, type, studentId } = {}) {
  const conditions = ['r.is_archived = 0'];
  const params = [];

  if (role === 'sysadmin' || role === 'schoolhead') {
    // all
  } else if (role === 'guidance') {
    conditions.push(`((r.status = 'Pending' AND r.assigned_to IS NULL) OR r.assigned_to = ? OR r.referring_user = ?)`);
    params.push(userId, userId);
  } else if (role === 'teacher') {
    conditions.push('(r.referring_user = ? OR r.assigned_to = ?)');
    params.push(userId, userId);
  } else {
    conditions.push('1 = 0');
  }

  if (status)    { conditions.push('r.status = ?');        params.push(status); }
  if (type)      { conditions.push('r.referral_type = ?'); params.push(type); }
  if (studentId) { conditions.push('r.student_id = ?');    params.push(studentId); }

  return db.prepare(`
    ${SELECT_REFERRAL}
    WHERE ${conditions.join(' AND ')}
    ORDER BY r.created_at DESC, r.id DESC
  `).all(...params);
}

function listArchived() {
  return db.prepare(`${SELECT_REFERRAL} WHERE r.is_archived = 1 ORDER BY r.updated_at DESC, r.id DESC`).all();
}

function getFollowups(referralId) {
  return db.prepare(`
    SELECT f.id, f.activity_desc, f.activity_date, f.next_followup, f.created_at,
           u.full_name AS actor_name, ro.name AS actor_role
    FROM   referral_followups f
    JOIN   users u  ON u.id  = f.actor_id
    JOIN   roles ro ON ro.id = u.role_id
    WHERE  f.referral_id = ?
    ORDER  BY f.created_at ASC, f.id ASC
  `).all(referralId);
}

// ── T-28 updates ──────────────────────────────────────────────────────────────
// Each is guarded by the status the caller saw; 0 rows changed means someone
// else changed the referral first.

/** Active accounts a referral can be assigned to (US-4.2 / US-4.3). */
function listAssignableUsers() {
  return db.prepare(`
    SELECT u.id, u.full_name, r.name AS role
    FROM   users u JOIN roles r ON r.id = u.role_id
    WHERE  u.status = 'Active' AND r.name IN ('guidance', 'teacher')
    ORDER  BY CASE r.name WHEN 'guidance' THEN 0 ELSE 1 END, u.full_name
  `).all();
}

function findUserWithRole(id) {
  return db.prepare(`
    SELECT u.id, u.full_name, u.status, r.name AS role
    FROM   users u JOIN roles r ON r.id = u.role_id
    WHERE  u.id = ?
  `).get(id);
}

function setAssigned(id, expectedStatus, userId, newStatus) {
  return db.prepare(`
    UPDATE referrals SET assigned_to = ?, status = ?, updated_at = ${NOW_SQL}
    WHERE  id = ? AND status = ? AND is_archived = 0
  `).run(userId, newStatus, id, expectedStatus).changes;
}

function addFollowup({ referral_id, actor_id, activity_desc, activity_date, next_followup }) {
  return Number(db.prepare(`
    INSERT INTO referral_followups (referral_id, actor_id, activity_desc, activity_date, next_followup)
    VALUES (?, ?, ?, ?, ?)
  `).run(referral_id, actor_id, activity_desc, activity_date, next_followup || null).lastInsertRowid);
}

function touchOngoing(id) {
  return db.prepare(`
    UPDATE referrals SET updated_at = ${NOW_SQL}
    WHERE  id = ? AND status = 'Ongoing' AND is_archived = 0
  `).run(id).changes;
}

function setFinalStatus(id, status, completionNote, referredDestination) {
  return db.prepare(`
    UPDATE referrals
    SET    status = ?, completion_note = ?, referred_destination = ?, updated_at = ${NOW_SQL}
    WHERE  id = ? AND status = 'Ongoing' AND is_archived = 0
  `).run(status, completionNote || null, referredDestination || null, id).changes;
}

// Archiving only flips the flag, so restore returns the referral to its last status.
function setArchived(id, value) {
  return db.prepare(`
    UPDATE referrals SET is_archived = ?, updated_at = ${NOW_SQL}
    WHERE  id = ? AND is_archived = ?
  `).run(value, id, value ? 0 : 1).changes;
}

module.exports = {
  NOW_SQL,
  findActiveStudent,
  create,
  findById,
  list,
  listArchived,
  getFollowups,
  listAssignableUsers,
  findUserWithRole,
  setAssigned,
  addFollowup,
  touchOngoing,
  setFinalStatus,
  setArchived,
};
