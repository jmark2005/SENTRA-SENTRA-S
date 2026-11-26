'use strict';

const express = require('express');

const authMiddleware = require('../middleware/auth');
const dashboardSvc   = require('../services/dashboard.service');

const router = express.Router();

// GET /api/dashboard/summary — metrics for the signed-in user's role (T-33).
// Takes no user parameter: each user only ever gets their own figures.
router.get('/summary', authMiddleware, (req, res) => {
  const summary = dashboardSvc.summaryFor(req.user);
  if (!summary) return res.status(403).json({ error: 'Forbidden.' });
  return res.json(summary);
});

module.exports = router;
