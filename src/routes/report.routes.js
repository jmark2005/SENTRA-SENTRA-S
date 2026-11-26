'use strict';

const express = require('express');

const authMiddleware        = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const reportSvc             = require('../services/report.service');

const router = express.Router();

// GET /api/reports/<name>?<filters>&format=csv|pdf  (design.md §3.12, T-34)
// All need view_reports, plus the permission that guards the same data elsewhere.
// Role scoping (e.g. Teachers → 403 on incidents) is in report.service.js.
const REPORTS = {
  incidents:   'view_incidents',  // ?from=&to=&category=&status=
  response:    'view_incidents',  // ?from=&to=
  attendance:  'view_attendance', // ?semester=&school_year=&section=&class=&from=&to=
  referrals:   'view_referrals',  // ?from=&to=&type=&status=
  'audit-log': 'view_audit_log',  // ?from=&to=&actor=&action_type=
};

for (const [name, permission] of Object.entries(REPORTS)) {
  router.get(`/${name}`, authMiddleware, requirePermission('view_reports'), requirePermission(permission),
    async (req, res) => {
      let out;
      try {
        out = await reportSvc.exportReport(name, { user: req.user, ip: req.ip }, req.query);
      } catch (err) {
        if (err instanceof reportSvc.ReportError) return res.status(err.status).json({ error: err.message });
        throw err;
      }
      res.set({
        'Content-Type':        out.contentType,
        'Content-Disposition': `attachment; filename="${out.filename}"`,
        'Cache-Control':       'no-store',
      });
      return res.send(out.body);
    });
}

module.exports = router;
