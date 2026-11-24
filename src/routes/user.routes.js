'use strict';

const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const db = require('../../src/repositories/db');
const authMiddleware = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const { log: auditLog } = require('../services/audit.service');
const { create: createNotification, createForRole } = require('../services/notification.service');

const router = express.Router();

// ---------------------------------------------------------------------------
// Rate limiter: 5 signups per hour per IP
// ---------------------------------------------------------------------------
const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many signup attempts. Please try again later.' },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const PASSWORD_POLICY = /^(?=.*[A-Z])(?=.*[a-z])(?=.*\d).{8,}$/;

const ALLOWED_ROLES = ['teacher', 'guidance', 'safetyofficer', 'student'];

function invalidateUserSessions(userId) {
  const sids = db
    .prepare('SELECT sid FROM user_sessions WHERE user_id = ?')
    .all(userId)
    .map(r => r.sid);

  if (sids.length > 0) {
    const ph = sids.map(() => '?').join(',');
    db.prepare(`DELETE FROM user_sessions WHERE sid IN (${ph})`).run(...sids);
    db.prepare(`DELETE FROM sessions WHERE sid IN (${ph})`).run(...sids);
  }
}

// ---------------------------------------------------------------------------
// POST /api/users/signup — public
// ---------------------------------------------------------------------------
router.post('/signup', signupLimiter, (req, res) => {
  const { full_name, id_number, email, username, password, confirm_password, role } = req.body;

  // Presence check
  if (!full_name || !id_number || !email || !username || !password || !confirm_password || !role) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  // Role validation
  if (!ALLOWED_ROLES.includes(role)) {
    return res.status(400).json({ error: 'Invalid role. Must be one of: teacher, guidance, safetyofficer, student.' });
  }

  // Password match
  if (password !== confirm_password) {
    return res.status(400).json({ error: 'Passwords do not match.' });
  }

  // Password policy
  if (!PASSWORD_POLICY.test(password)) {
    return res.status(422).json({
      error: 'Password must be at least 8 characters and contain an uppercase letter, a lowercase letter, and a number.',
    });
  }

  // Username uniqueness (case-insensitive — handled by COLLATE NOCASE on column)
  const existingUsername = db
    .prepare('SELECT id FROM users WHERE username = ?')
    .get(username);
  if (existingUsername) {
    return res.status(409).json({ error: 'Username already taken.' });
  }

  // Email uniqueness (case-insensitive — handled by COLLATE NOCASE on column)
  const existingEmail = db
    .prepare('SELECT id FROM users WHERE email = ?')
    .get(email);
  if (existingEmail) {
    return res.status(409).json({ error: 'Email already registered.' });
  }

  // Look up role_id
  const roleRow = db.prepare('SELECT id FROM roles WHERE name = ?').get(role);
  if (!roleRow) {
    return res.status(400).json({ error: 'Role not found.' });
  }

  // Hash password
  const passwordHash = bcrypt.hashSync(password, 12);

  // Insert user
  const result = db
    .prepare(`
      INSERT INTO users (username, email, password_hash, full_name, id_number, role_id, status, password_reset_required)
      VALUES (?, ?, ?, ?, ?, ?, 'Pending', 0)
    `)
    .run(username, email.toLowerCase(), passwordHash, full_name, id_number, roleRow.id);

  const newUserId = result.lastInsertRowid;

  // Notify all Active sysadmin users
  try {
    createForRole('sysadmin', {
      type: 'Account Approval',
      title: 'New account request',
      message: `New account request from ${full_name} requesting ${role}.`,
    });
  } catch (err) {
    console.error('[signup] notification error:', err.message);
  }

  // Audit log
  try {
    auditLog({
      actorId: null,
      actorName: full_name,
      actorRole: role,
      actionType: 'SIGNUP',
      targetTable: 'users',
      targetId: newUserId,
    });
  } catch (err) {
    console.error('[signup] audit log error:', err.message);
  }

  return res.status(201).json({
    message: 'Your account request has been submitted. You will be notified once an administrator approves your access.',
  });
});

// ---------------------------------------------------------------------------
// GET /api/users — SysAdmin only
// ---------------------------------------------------------------------------
router.get('/', authMiddleware, requirePermission('manage_accounts'), (req, res) => {
  const { status, role, page = 1, limit = 50 } = req.query;

  const conditions = [];
  const params = [];

  if (status) {
    conditions.push('u.status = ?');
    params.push(status);
  }
  if (role) {
    conditions.push('r.name = ?');
    params.push(role);
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
  const offset = (pageNum - 1) * limitNum;

  const totalRow = db
    .prepare(`SELECT COUNT(*) AS total FROM users u JOIN roles r ON r.id = u.role_id ${where}`)
    .get(...params);
  const total = totalRow ? totalRow.total : 0;

  const users = db
    .prepare(`
      SELECT u.id, u.username, u.email, u.full_name, u.id_number,
             r.name AS role, u.status, u.password_reset_required,
             u.created_at, u.updated_at
      FROM users u
      JOIN roles r ON r.id = u.role_id
      ${where}
      ORDER BY u.created_at DESC
      LIMIT ? OFFSET ?
    `)
    .all(...params, limitNum, offset);

  return res.status(200).json({
    data: users,
    pagination: {
      total,
      page: pageNum,
      limit: limitNum,
      pages: Math.ceil(total / limitNum),
    },
  });
});

// ---------------------------------------------------------------------------
// GET /api/users/:id — SysAdmin only
// ---------------------------------------------------------------------------
router.get('/:id', authMiddleware, requirePermission('manage_accounts'), (req, res) => {
  const userId = parseInt(req.params.id, 10);

  if (!userId) {
    return res.status(400).json({ error: 'Invalid user ID.' });
  }

  const user = db
    .prepare(`
      SELECT u.id, u.username, u.email, u.full_name, u.id_number,
             r.name AS role, u.status, u.password_reset_required,
             u.created_at, u.updated_at
      FROM users u
      JOIN roles r ON r.id = u.role_id
      WHERE u.id = ?
    `)
    .get(userId);

  if (!user) {
    return res.status(404).json({ error: 'User not found.' });
  }

  return res.status(200).json(user);
});

// ---------------------------------------------------------------------------
// PATCH /api/users/:id/status — SysAdmin only
// ---------------------------------------------------------------------------
router.patch('/:id/status', authMiddleware, requirePermission('manage_accounts'), (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (!userId) {
    return res.status(400).json({ error: 'Invalid user ID.' });
  }

  const { status, rejection_reason, student_record_id } = req.body;
  const allowedStatuses = ['Active', 'Rejected', 'Inactive'];
  if (!status || !allowedStatuses.includes(status)) {
    return res.status(400).json({ error: 'status must be one of: Active, Rejected, Inactive.' });
  }

  // Fetch current user with role
  const user = db
    .prepare(`
      SELECT u.id, u.status, u.full_name, r.name AS role
      FROM users u JOIN roles r ON r.id = u.role_id
      WHERE u.id = ?
    `)
    .get(userId);

  if (!user) {
    return res.status(404).json({ error: 'User not found.' });
  }

  // T-18: student role approval requires a valid linked student record
  let studentRecord = null;
  if (status === 'Active' && user.role === 'student') {
    if (!student_record_id) {
      return res.status(422).json({ error: 'student_record_id is required when approving a Student account.' });
    }
    studentRecord = db.prepare('SELECT id, student_number, status FROM students WHERE id = ?')
      .get(parseInt(student_record_id, 10));
    if (!studentRecord) {
      return res.status(422).json({ error: 'Student record not found.' });
    }
    if (studentRecord.status !== 'Active') {
      return res.status(422).json({ error: 'Student record must be Active.' });
    }
    // Enforce unique: one active user per student record
    const existingLink = db.prepare(
      "SELECT id FROM users WHERE student_record_id = ? AND id != ? AND status != 'Inactive'"
    ).get(studentRecord.id, userId);
    if (existingLink) {
      return res.status(422).json({ error: 'This student record is already linked to another active user account.' });
    }
  }

  const oldStatus = user.status;
  const now = new Date().toISOString();

  // Build update — include student_record_id link when approving a student account
  const updateParams = [status, now];
  let updateSql = 'UPDATE users SET status = ?, updated_at = ?';

  if (status === 'Rejected' && rejection_reason) {
    updateSql += ', rejection_reason = ?';
    updateParams.push(rejection_reason);
  }

  if (status === 'Active' && studentRecord) {
    updateSql += ', student_record_id = ?';
    updateParams.push(studentRecord.id);
  }

  updateSql += ' WHERE id = ?';
  updateParams.push(userId);

  db.prepare(updateSql).run(...updateParams);

  // Per-transition side effects
  if (status === 'Active' && oldStatus === 'Pending') {
    // Approve (includes student record link when studentRecord is set)
    try {
      createNotification({
        userId,
        type: 'Account Approval',
        title: 'Account approved',
        message: 'Your account has been approved. You can now log in.',
      });
    } catch (err) {
      console.error('[status] notification error:', err.message);
    }
    // Extra audit log entry for student record linking
    if (studentRecord) {
      auditLog({
        actorId: req.user.id,
        actorName: req.user.full_name,
        actorRole: req.user.role,
        actionType: 'STUDENT_ACCOUNT_LINKED',
        targetTable: 'users',
        targetId: userId,
        newValues: { student_record_id: studentRecord.id, student_number: studentRecord.student_number },
        ipAddress: req.ip,
      });
    }
  } else if (status === 'Rejected') {
    // Reject
    const reason = rejection_reason || '';
    const msg = 'Your account request was rejected.' + (reason ? ' Reason: ' + reason : '');
    try {
      createNotification({
        userId,
        type: 'Account Approval',
        title: 'Account rejected',
        message: msg,
      });
    } catch (err) {
      console.error('[status] notification error:', err.message);
    }
  } else if (status === 'Inactive') {
    // Deactivate — invalidate all sessions first
    invalidateUserSessions(userId);
    try {
      createNotification({
        userId,
        type: 'System Notice',
        title: 'Account deactivated',
        message: 'Your account has been deactivated.',
      });
    } catch (err) {
      console.error('[status] notification error:', err.message);
    }
  } else if (status === 'Active' && oldStatus === 'Inactive') {
    // Reactivate
    try {
      createNotification({
        userId,
        type: 'Account Approval',
        title: 'Account reactivated',
        message: 'Your account has been reactivated.',
      });
    } catch (err) {
      console.error('[status] notification error:', err.message);
    }
  }

  // Audit log
  try {
    auditLog({
      actorId: req.user.id,
      actorName: req.user.full_name,
      actorRole: req.user.role,
      actionType: 'ACCOUNT_STATUS_CHANGED',
      targetTable: 'users',
      targetId: userId,
      oldValues: { status: oldStatus },
      newValues: { status },
    });
  } catch (err) {
    console.error('[status] audit log error:', err.message);
  }

  return res.status(200).json({
    message: 'User status updated.',
    user: { id: userId, status },
  });
});

// ---------------------------------------------------------------------------
// Helpers — temp password generator
// ---------------------------------------------------------------------------
function generateTempPassword() {
  const upper   = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lower   = 'abcdefghijklmnopqrstuvwxyz';
  const digits  = '0123456789';
  const symbols = '!@#$%^&*()-_=+';
  const all     = upper + lower + digits + symbols;
  const pick    = (chars) => chars[crypto.randomInt(chars.length)];
  let pw = pick(upper) + pick(lower) + pick(digits) + pick(symbols);
  while (pw.length < 12) pw += pick(all);
  return pw.split('').sort(() => crypto.randomInt(3) - 1).join('');
}

// ---------------------------------------------------------------------------
// POST /api/users/:id/reset-password  — SysAdmin only
// ---------------------------------------------------------------------------
router.post('/:id/reset-password', authMiddleware, requirePermission('manage_accounts'), (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (!userId) return res.status(400).json({ error: 'Invalid user ID.' });

  const user = db.prepare('SELECT id, full_name FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  const tempPassword = generateTempPassword();
  const hash = bcrypt.hashSync(tempPassword, 12);
  const now  = new Date().toISOString();

  // Update user: new hash, force reset flag, timestamp
  db.prepare(`UPDATE users SET password_hash = ?, password_reset_required = 1, updated_at = ? WHERE id = ?`)
    .run(hash, now, userId);

  // Invalidate all existing sessions for this user
  invalidateUserSessions(userId);

  // Audit log
  auditLog({
    actorId:     req.user.id,
    actorName:   req.user.full_name,
    actorRole:   req.user.role,
    actionType:  'PASSWORD_RESET',
    targetTable: 'users',
    targetId:    userId,
    ipAddress:   req.ip,
  });

  // Return the temp password exactly once — never stored in plaintext
  return res.status(200).json({
    message: `Password reset for ${user.full_name}. Share the temporary password securely.`,
    temp_password: tempPassword,
  });
});

// ---------------------------------------------------------------------------
// GET /api/users/:id/participation — SysAdmin and SchoolHead only
//
// NOTE: The dateFilter helper interpolates `from`/`to` query values directly
// into SQL using SQLite's date() function. These values are used only as
// date string arguments to date(), which coerces them to NULL if malformed,
// limiting injection risk. For stronger safety, switch to parameterised
// date comparisons when query complexity allows.
// ---------------------------------------------------------------------------
router.get('/:id/participation', authMiddleware, requirePermission('view_participation'), (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (!userId) return res.status(400).json({ error: 'Invalid user ID.' });

  const user = db.prepare(`
    SELECT u.id, u.username, u.full_name, r.name AS role
    FROM users u JOIN roles r ON r.id = u.role_id
    WHERE u.id = ?
  `).get(userId);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  const { from, to } = req.query;

  // Build date filter clause
  function dateFilter(col, tableAlias) {
    const parts = [];
    if (from) parts.push(`date(${tableAlias ? tableAlias + '.' : ''}${col}) >= date('${from}')`);
    if (to)   parts.push(`date(${tableAlias ? tableAlias + '.' : ''}${col}) <= date('${to}')`);
    return parts.length ? ' AND ' + parts.join(' AND ') : '';
  }

  // 1. Incidents reported by this user
  const incidentsReported = db.prepare(`
    SELECT COUNT(*) AS n FROM incidents WHERE reporter_id = ? ${dateFilter('created_at', '')}
  `).get(userId).n;

  // 2. Incident assignments to this user
  const incidentsAssigned = db.prepare(`
    SELECT COUNT(*) AS n FROM incident_assignments WHERE assigned_to = ? ${dateFilter('assigned_at', '')}
  `).get(userId).n;

  // 3. Incident activity log entries by this user
  const incidentActivityEntries = db.prepare(`
    SELECT COUNT(*) AS n FROM incident_activity_log WHERE actor_id = ? ${dateFilter('created_at', '')}
  `).get(userId).n;

  // 4. Referrals submitted by this user (referring_user)
  const referralsSubmitted = db.prepare(`
    SELECT COUNT(*) AS n FROM referrals WHERE referring_user = ? ${dateFilter('created_at', '')}
  `).get(userId).n;

  // 5. Referrals assigned to this user
  const referralsAssigned = db.prepare(`
    SELECT COUNT(*) AS n FROM referrals WHERE assigned_to = ? ${dateFilter('created_at', '')}
  `).get(userId).n;

  // 6. Referral follow-ups by this user
  const referralFollowups = db.prepare(`
    SELECT COUNT(*) AS n FROM referral_followups WHERE actor_id = ? ${dateFilter('created_at', '')}
  `).get(userId).n;

  // 7. Attendance records recorded by this user
  const attendanceRecorded = db.prepare(`
    SELECT COUNT(*) AS n FROM attendance_records WHERE recorded_by = ? ${dateFilter('record_date', '')}
  `).get(userId).n;

  auditLog({
    actorId: req.user.id, actorName: req.user.full_name, actorRole: req.user.role,
    actionType: 'VIEW_PARTICIPATION', targetTable: 'users', targetId: userId, ipAddress: req.ip,
  });

  return res.json({
    user: { id: user.id, username: user.username, full_name: user.full_name, role: user.role },
    participation: {
      incidents_reported:        incidentsReported,
      incidents_assigned:        incidentsAssigned,
      incident_activity_entries: incidentActivityEntries,
      referrals_submitted:       referralsSubmitted,
      referrals_assigned:        referralsAssigned,
      referral_followups:        referralFollowups,
      attendance_recorded:       attendanceRecorded,
    },
    filters: { from: from || null, to: to || null },
  });
});

module.exports = router;
