'use strict';

const express = require('express');

const authMiddleware        = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const retentionSvc          = require('../services/retention.service');

const router = express.Router();

// GET /api/retention/review — records past their retention period (T-35).
// SysAdmin only: archive_incidents is the System Administrator's archiving permission.
// Read-only; nothing is archived or deleted automatically.
router.get('/review', authMiddleware, requirePermission('archive_incidents'), (req, res) => {
  res.set('Cache-Control', 'no-store');
  return res.json(retentionSvc.review());
});

module.exports = router;
