'use strict';
const express = require('express');
const db = require('../repositories/db');
const authMiddleware = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const { log: auditLog }     = require('../services/audit.service');
const { getSetting }        = require('../services/settings.service');
const notificationSvc       = require('../services/notification.service');

const router = express.Router();

// GET /api/notifications  — own notifications only, optional ?unread_only=true
router.get('/', authMiddleware, (req, res) => {
  const userId = req.user.id;
  const unreadOnly = req.query.unread_only === 'true';

  const rows = db.prepare(`
    SELECT id, type, title, message, link, is_read, created_at
    FROM notifications
    WHERE user_id = ? ${unreadOnly ? 'AND is_read = 0' : ''}
    ORDER BY created_at DESC
  `).all(userId);

  return res.json({ data: rows });
});

// GET /api/notifications/count  — MUST NOT update last_active (exempt path in authMiddleware)
// Also returns unread Emergency Alerts so the dashboard banner rides on this
// idle-exempt poll instead of a second poll that would keep sessions alive (T-32).
router.get('/count', authMiddleware, (req, res) => {
  const { count } = db.prepare(`
    SELECT COUNT(*) AS count FROM notifications
    WHERE user_id = ? AND is_read = 0
  `).get(req.user.id);

  const emergency = db.prepare(`
    SELECT id, title, message, created_at FROM notifications
    WHERE  user_id = ? AND is_read = 0 AND type = 'Emergency Alert'
    ORDER  BY created_at DESC, id DESC
    LIMIT  5
  `).all(req.user.id);

  return res.json({ unread_count: count, emergency_alerts: emergency });
});

// POST /api/notifications/emergency  { message }  — T-32
// Sends an in-app Emergency Alert to every active user in the roles listed in
// system_settings.emergency_alert_recipient_roles. In-app only (no SMS/email).
router.post('/emergency', authMiddleware, requirePermission('send_emergency_alert'), (req, res) => {
  const message = String((req.body && req.body.message) || '').trim();
  if (!message) return res.status(400).json({ error: 'An alert message is required.' });
  if (message.length > 500) {
    return res.status(400).json({ error: 'The alert message must be 500 characters or fewer.' });
  }

  const roles = String(getSetting('emergency_alert_recipient_roles') || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (!roles.length) {
    return res.status(422).json({ error: 'No recipient roles are configured for emergency alerts.' });
  }

  const recipients = db.prepare(`
    SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
    WHERE  u.status = 'Active' AND r.name IN (${roles.map(() => '?').join(', ')})
  `).all(...roles);

  const title = `Emergency Alert from ${req.user.full_name}`;
  db.transaction(() => {
    for (const u of recipients) {
      notificationSvc.create({ userId: u.id, type: 'Emergency Alert', title, message, link: null });
    }
  })();

  auditLog({
    actorId:     req.user.id,
    actorName:   req.user.full_name,
    actorRole:   req.user.role,
    actionType:  'EMERGENCY_ALERT_SENT',
    targetTable: 'notifications',
    newValues:   { message, recipient_roles: roles, recipient_count: recipients.length },
    ipAddress:   req.ip,
  });

  return res.status(201).json({ recipients: recipients.length, roles });
});

// PATCH /api/notifications/read-all  — MUST be registered BEFORE /:id/read
router.patch('/read-all', authMiddleware, (req, res) => {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0')
    .run(req.user.id);
  return res.json({ message: 'All notifications marked as read.' });
});

// PATCH /api/notifications/:id/read
router.patch('/:id/read', authMiddleware, (req, res) => {
  const notif = db.prepare('SELECT id, user_id FROM notifications WHERE id = ?')
    .get(req.params.id);

  if (!notif) return res.status(404).json({ error: 'Notification not found.' });
  if (notif.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden.' });

  db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ?').run(notif.id);
  return res.json({ message: 'Notification marked as read.' });
});

module.exports = router;
