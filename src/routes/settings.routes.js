'use strict';
const express = require('express');
const db = require('../repositories/db');
const authMiddleware = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const { log: auditLog } = require('../services/audit.service');

const router = express.Router();

const VALID_ROLES     = ['sysadmin','schoolhead','teacher','guidance','safetyofficer','student'];
const VALID_SEMESTERS = ['1st Semester','2nd Semester'];

function validateSetting(key, value) {
  switch (key) {
    case 'school_name':
      if (!value || value.trim() === '') return 'school_name cannot be empty.';
      break;
    case 'current_school_year':
      if (!/^\d{4}[–\-]\d{4}$/.test(value))
        return 'current_school_year must be in format YYYY–YYYY (e.g. 2026–2027).';
      break;
    case 'current_semester':
      if (!VALID_SEMESTERS.includes(value))
        return `current_semester must be one of: ${VALID_SEMESTERS.join(', ')}.`;
      break;
    case 'session_idle_minutes': {
      const n = parseInt(value, 10);
      if (isNaN(n) || n < 5 || n > 480) return 'session_idle_minutes must be between 5 and 480.';
      break;
    }
    case 'session_max_hours': {
      const n = parseInt(value, 10);
      if (isNaN(n) || n < 1 || n > 24) return 'session_max_hours must be between 1 and 24.';
      break;
    }
    case 'student_feature_enabled':
      if (value !== '0' && value !== '1') return 'student_feature_enabled must be 0 or 1.';
      break;
    case 'attendance_threshold_absences':
    case 'attendance_threshold_tardies': {
      const n = parseInt(value, 10);
      if (isNaN(n) || n < 1 || n > 100) return `${key} must be between 1 and 100.`;
      break;
    }
    case 'school_timezone':
      try { Intl.DateTimeFormat(undefined, { timeZone: value }); }
      catch (_) { return `school_timezone '${value}' is not a valid IANA timezone.`; }
      break;
    case 'escalation_job_interval_minutes':
    case 'reminders_job_interval_minutes': {
      const n = parseInt(value, 10);
      if (isNaN(n) || n < 1 || n > 1440) return `${key} must be between 1 and 1440.`;
      break;
    }
    case 'retention_years_incidents':
    case 'retention_years_referrals':
    case 'retention_years_attendance': {
      const n = parseInt(value, 10);
      if (isNaN(n) || n < 1 || n > 100) return `${key} must be between 1 and 100.`;
      break;
    }
    case 'emergency_alert_recipient_roles': {
      const parts = value.split(',').map(s => s.trim()).filter(Boolean);
      if (parts.length === 0) return 'emergency_alert_recipient_roles cannot be empty.';
      const invalid = parts.filter(r => !VALID_ROLES.includes(r));
      if (invalid.length > 0) return `Invalid role(s): ${invalid.join(', ')}.`;
      break;
    }
    default:
      return `Unknown setting key: ${key}.`;
  }
  return null;
}

// GET /api/settings — SysAdmin only
router.get('/', authMiddleware, requirePermission('manage_settings'), (req, res) => {
  const rows = db.prepare('SELECT key, value, updated_at FROM system_settings ORDER BY key').all();
  const settings = {};
  rows.forEach(r => { settings[r.key] = r.value; });
  return res.json({ data: settings });
});

// PATCH /api/settings — SysAdmin only
router.patch('/', authMiddleware, requirePermission('manage_settings'), (req, res) => {
  const updates = req.body;
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    return res.status(400).json({ error: 'Request body must be a JSON object of key-value pairs.' });
  }

  const errors = {};
  for (const [key, value] of Object.entries(updates)) {
    const err = validateSetting(key, String(value));
    if (err) errors[key] = err;
  }

  if (Object.keys(errors).length > 0) {
    return res.status(422).json({ errors });
  }

  const now = new Date().toISOString();
  for (const [key, value] of Object.entries(updates)) {
    const oldRow  = db.prepare('SELECT value FROM system_settings WHERE key = ?').get(key);
    const oldVal  = oldRow ? oldRow.value : null;
    const newVal  = String(value);

    db.prepare(`
      INSERT INTO system_settings (key, value, updated_at, updated_by)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by
    `).run(key, newVal, now, req.user.id);

    auditLog({
      actorId: req.user.id, actorName: req.user.full_name, actorRole: req.user.role,
      actionType: 'SETTINGS_CHANGED', targetTable: 'system_settings',
      oldValues: { [key]: oldVal }, newValues: { [key]: newVal }, ipAddress: req.ip,
    });
  }

  const rows = db.prepare('SELECT key, value FROM system_settings ORDER BY key').all();
  const settings = {};
  rows.forEach(r => { settings[r.key] = r.value; });
  return res.json({ message: 'Settings updated.', data: settings });
});

module.exports = router;
