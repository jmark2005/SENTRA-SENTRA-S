'use strict';
const express = require('express');
const db = require('../repositories/db');
const authMiddleware = require('../middleware/auth');

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
router.get('/count', authMiddleware, (req, res) => {
  const { count } = db.prepare(`
    SELECT COUNT(*) AS count FROM notifications
    WHERE user_id = ? AND is_read = 0
  `).get(req.user.id);

  return res.json({ unread_count: count });
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
