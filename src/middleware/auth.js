'use strict';

const db = require('../../src/repositories/db');

/**
 * Endpoints excluded from updating last_active.
 * Polling endpoints that should never reset the idle timer.
 */
const IDLE_EXEMPT_PATHS = [
  '/api/auth/session-status',
  '/api/notifications/count',
];

/**
 * Authentication middleware.
 *
 * - Reads session_idle_minutes and session_max_hours from system_settings.
 * - Checks req.session.userId.
 * - Enforces idle timeout and absolute session max.
 * - Attaches req.user = { id, username, full_name, role, role_id }.
 * - Updates req.session.last_active unless the path is exempt.
 */
function authMiddleware(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Read configurable timeouts from system_settings
  const idleRow = db
    .prepare("SELECT value FROM system_settings WHERE key = 'session_idle_minutes'")
    .get();
  const maxRow = db
    .prepare("SELECT value FROM system_settings WHERE key = 'session_max_hours'")
    .get();

  const idleMinutes = idleRow ? parseInt(idleRow.value, 10) : 30;
  const maxHours = maxRow ? parseInt(maxRow.value, 10) : 8;

  const now = Date.now();
  const lastActive = req.session.last_active || req.session.loginAt || now;
  const loginAt = req.session.loginAt || now;

  const idleLimitMs = idleMinutes * 60 * 1000;
  const maxLimitMs = maxHours * 3600 * 1000;

  // Check idle expiry
  if (now - lastActive > idleLimitMs) {
    req.session.destroy(() => {});
    return res.status(401).json({ error: 'Session expired' });
  }

  // Check absolute expiry
  if (now - loginAt > maxLimitMs) {
    req.session.destroy(() => {});
    return res.status(401).json({ error: 'Session expired' });
  }

  // Fetch the user record
  const user = db
    .prepare(`
      SELECT u.id, u.username, u.full_name, u.role_id, u.status,
             u.password_reset_required, u.student_record_id, r.name AS role
      FROM users u
      JOIN roles r ON r.id = u.role_id
      WHERE u.id = ?
    `)
    .get(req.session.userId);

  if (!user) {
    req.session.destroy(() => {});
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (user.status !== 'Active') {
    req.session.destroy(() => {});
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Attach user to request
  req.user = {
    id: user.id,
    username: user.username,
    full_name: user.full_name,
    role: user.role,
    role_id: user.role_id,
    password_reset_required: user.password_reset_required,
    student_record_id: user.student_record_id || null,
  };

  // Update last_active unless on an exempt path
  const isExempt = IDLE_EXEMPT_PATHS.some(p => req.path === p || req.originalUrl === p);
  if (!isExempt) {
    req.session.last_active = now;
  }

  // Paths exempt from the password-reset gate
  const RESET_EXEMPT = [
    '/api/auth/change-password',
    '/api/auth/logout',
    '/api/csrf-token',
    '/api/auth/session-status',
    '/api/auth/extend-session',
  ];

  if (user.password_reset_required === 1) {
    const isResetExempt = RESET_EXEMPT.some(p =>
      req.path === p || req.originalUrl.split('?')[0] === p
    );
    if (!isResetExempt) {
      return res.status(403).json({
        error: 'Password change required',
        redirect: '/change-password.html',
      });
    }
  }

  return next();
}

module.exports = authMiddleware;
