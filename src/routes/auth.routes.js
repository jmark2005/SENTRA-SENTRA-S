'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const db = require('../../src/repositories/db');
const authMiddleware = require('../middleware/auth');
const { getUserPermissions } = require('../services/permission.service');
const { log: auditLog } = require('../services/audit.service');

const router = express.Router();

// ---------------------------------------------------------------------------
// Rate limiter: 10 requests / minute / IP on the login endpoint
// ---------------------------------------------------------------------------
const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again later.' },
});

// ---------------------------------------------------------------------------
// POST /api/auth/login
// ---------------------------------------------------------------------------
router.post('/login', loginLimiter, (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  // Look up user by username (case-insensitive via COLLATE NOCASE on column)
  const user = db.prepare(`
    SELECT u.id, u.username, u.email, u.password_hash, u.full_name,
           u.role_id, u.status, r.name AS role
    FROM users u
    JOIN roles r ON r.id = u.role_id
    WHERE u.username = ?
  `).get(username);

  // Invalid username
  if (!user) {
    auditLog({
      actorId: null,
      actorName: username,
      actorRole: 'unknown',
      actionType: 'LOGIN_FAILED',
      ipAddress: req.ip,
    });
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  // Wrong password
  const passwordMatch = bcrypt.compareSync(password, user.password_hash);
  if (!passwordMatch) {
    auditLog({
      actorId: null,
      actorName: username,
      actorRole: 'unknown',
      actionType: 'LOGIN_FAILED',
      ipAddress: req.ip,
    });
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  // Check account status
  if (user.status !== 'Active') {
    let message;
    if (user.status === 'Pending') {
      message = 'Your account is pending approval.';
    } else if (user.status === 'Inactive') {
      message = 'Your account has been deactivated.';
    } else if (user.status === 'Rejected') {
      message = 'Your account application was rejected.';
    } else {
      message = 'Your account is not active.';
    }
    return res.status(401).json({ error: message });
  }

  // T-18: Student accounts must have a linked student record
  if (user.role === 'student') {
    const linked = db.prepare('SELECT student_record_id FROM users WHERE id = ?').get(user.id);
    if (!linked || !linked.student_record_id) {
      return res.status(401).json({
        error: 'Account configuration incomplete. Contact the system administrator.',
      });
    }
  }

  // Regenerate session to prevent fixation
  req.session.regenerate((err) => {
    if (err) {
      return res.status(500).json({ error: 'Session error.' });
    }

    req.session.userId = user.id;
    req.session.loginAt = Date.now();
    req.session.last_active = Date.now();

    // Persist user_sessions row for bulk-invalidation support
    // The session store will write the sessions row; we insert the user link here.
    // We use a callback via req.session.save to ensure the sid is committed first.
    req.session.save((saveErr) => {
      if (saveErr) {
        return res.status(500).json({ error: 'Session save error.' });
      }

      // Insert into user_sessions (may already exist on quick regenerate; use INSERT OR IGNORE)
      try {
        db.prepare(`
          INSERT OR IGNORE INTO user_sessions (sid, user_id)
          VALUES (?, ?)
        `).run(req.sessionID, user.id);
      } catch (dbErr) {
        // Non-fatal: log and continue
        console.error('[auth] user_sessions insert error:', dbErr.message);
      }

      auditLog({
        actorId: user.id,
        actorName: user.full_name,
        actorRole: user.role,
        actionType: 'LOGIN',
        ipAddress: req.ip,
        targetTable: 'users',
        targetId: user.id,
      });

      const ROLE_REDIRECTS = {
        sysadmin:      '/dashboard-admin.html',
        schoolhead:    '/dashboard-schoolhead.html',
        teacher:       '/dashboard-teacher.html',
        guidance:      '/dashboard-guidance.html',
        safetyofficer: '/dashboard-safetyofficer.html',
        student:       '/dashboard-student.html',
      };

      return res.status(200).json({
        message: 'Login successful',
        redirect: ROLE_REDIRECTS[user.role] || '/dashboard-admin.html',
        user: {
          id: user.id,
          username: user.username,
          full_name: user.full_name,
          role: user.role,
        },
      });
    });
  });
});

// ---------------------------------------------------------------------------
// POST /api/auth/logout
// ---------------------------------------------------------------------------
router.post('/logout', authMiddleware, (req, res) => {
  const userId = req.user.id;
  const actorName = req.user.full_name;
  const actorRole = req.user.role;
  const sid = req.sessionID;

  // Remove from user_sessions
  try {
    db.prepare('DELETE FROM user_sessions WHERE sid = ?').run(sid);
  } catch (dbErr) {
    console.error('[auth] user_sessions delete error:', dbErr.message);
  }

  req.session.destroy((err) => {
    if (err) {
      console.error('[auth] session destroy error:', err.message);
    }

    auditLog({
      actorId: userId,
      actorName: actorName,
      actorRole: actorRole,
      actionType: 'LOGOUT',
      ipAddress: req.ip,
      targetTable: 'users',
      targetId: userId,
    });

    return res.status(200).json({ message: 'Logged out successfully.' });
  });
});

// ---------------------------------------------------------------------------
// GET /api/auth/me
// ---------------------------------------------------------------------------
router.get('/me', authMiddleware, (req, res) => {
  const { id, username, full_name, role, role_id, student_record_id } = req.user;

  const perms = getUserPermissions(id);
  const payload = {
    id,
    username,
    full_name,
    role,
    permissions: [...perms],
  };

  // T-18: Expose student_record_id so the student dashboard can load live data
  if (role === 'student') {
    payload.student_record_id = student_record_id || null;
  }

  return res.status(200).json(payload);
});

// ---------------------------------------------------------------------------
// GET /api/auth/session-status  (open endpoint — no auth middleware)
// ---------------------------------------------------------------------------
router.get('/session-status', (req, res) => {
  // Read settings
  const idleRow = db
    .prepare("SELECT value FROM system_settings WHERE key = 'session_idle_minutes'")
    .get();
  const maxRow = db
    .prepare("SELECT value FROM system_settings WHERE key = 'session_max_hours'")
    .get();

  const idleMinutes = idleRow ? parseInt(idleRow.value, 10) : 30;
  const maxHours = maxRow ? parseInt(maxRow.value, 10) : 8;

  if (!req.session || !req.session.userId) {
    return res.status(200).json({
      authenticated: false,
      idle_expires_in_seconds: null,
      expires_in_seconds: null,
    });
  }

  const now = Date.now();
  const lastActive = req.session.last_active || now;
  const loginAt = req.session.loginAt || now;

  const idleWindowMs = idleMinutes * 60 * 1000;
  const maxWindowMs = maxHours * 3600 * 1000;

  const idleExpiresIn = Math.floor((idleWindowMs - (now - lastActive)) / 1000);
  const absoluteExpiresIn = Math.floor(((loginAt + maxWindowMs) - now) / 1000);

  return res.status(200).json({
    authenticated: true,
    idle_expires_in_seconds: idleExpiresIn,
    expires_in_seconds: absoluteExpiresIn,
  });
});

// ---------------------------------------------------------------------------
// POST /api/auth/extend-session
// ---------------------------------------------------------------------------
router.post('/extend-session', authMiddleware, (req, res) => {
  req.session.last_active = Date.now();
  return res.status(200).json({ message: 'Session extended' });
});

// ---------------------------------------------------------------------------
// Role → redirect map
// ---------------------------------------------------------------------------
const REDIRECT_MAP = {
  sysadmin:      '/dashboard-admin.html',
  schoolhead:    '/dashboard-schoolhead.html',
  teacher:       '/dashboard-teacher.html',
  guidance:      '/dashboard-guidance.html',
  safetyofficer: '/dashboard-safetyofficer.html',
  student:       '/dashboard-student.html',
};

// ---------------------------------------------------------------------------
// POST /api/auth/change-password
// ---------------------------------------------------------------------------
router.post('/change-password', authMiddleware, (req, res) => {
  const { current_password, new_password } = req.body;
  const { id: userId, full_name, role } = req.user;

  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'current_password and new_password are required.' });
  }

  // Fetch current hash
  const userRow = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId);
  if (!userRow) return res.status(401).json({ error: 'User not found.' });

  // Verify current password
  if (!bcrypt.compareSync(current_password, userRow.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }

  // Enforce policy: 8+ chars, uppercase, lowercase, digit
  const policyRegex = /^(?=.*[A-Z])(?=.*[a-z])(?=.*\d).{8,}$/;
  if (!policyRegex.test(new_password)) {
    return res.status(422).json({
      error: 'New password must be at least 8 characters and contain an uppercase letter, a lowercase letter, and a number.',
    });
  }

  const newHash = bcrypt.hashSync(new_password, 12);
  const now = new Date().toISOString();

  // Update user
  db.prepare(`
    UPDATE users SET password_hash = ?, password_reset_required = 0, updated_at = ? WHERE id = ?
  `).run(newHash, now, userId);

  // Invalidate ALL other sessions for this user
  const otherSids = db.prepare(
    'SELECT sid FROM user_sessions WHERE user_id = ? AND sid != ?'
  ).all(userId, req.sessionID).map(r => r.sid);

  if (otherSids.length > 0) {
    const placeholders = otherSids.map(() => '?').join(',');
    db.prepare(`DELETE FROM user_sessions WHERE sid IN (${placeholders})`).run(...otherSids);
    db.prepare(`DELETE FROM sessions WHERE sid IN (${placeholders})`).run(...otherSids);
  }

  auditLog({
    actorId: userId,
    actorName: full_name,
    actorRole: role,
    actionType: 'PASSWORD_CHANGED',
    targetTable: 'users',
    targetId: userId,
    ipAddress: req.ip,
  });

  return res.status(200).json({
    message: 'Password changed successfully.',
    redirect: REDIRECT_MAP[role] || '/',
  });
});

module.exports = router;
