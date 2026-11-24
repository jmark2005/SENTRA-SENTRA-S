'use strict';

const express = require('express');

const authMiddleware         = require('../middleware/auth');
const { requirePermission }  = require('../middleware/rbac');
const { log: auditLog }      = require('../services/audit.service');
const incidentSvc            = require('../services/incident.service');
const notificationSvc        = require('../services/notification.service');
const { getSetting }         = require('../services/settings.service');
const db                     = require('../repositories/db');

const router = express.Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns today's date string (YYYY-MM-DD) in the configured school timezone.
 * Uses Intl.DateTimeFormat (built-in, no external dep).
 */
function todayInSchoolTz() {
  const tz = getSetting('school_timezone') || 'Asia/Manila';
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date());
    const y = parts.find(p => p.type === 'year').value;
    const m = parts.find(p => p.type === 'month').value;
    const d = parts.find(p => p.type === 'day').value;
    return `${y}-${m}-${d}`;
  } catch (_) {
    return new Date().toISOString().slice(0, 10);
  }
}

/**
 * Returns the calendar year (number) in the configured school timezone.
 */
function yearInSchoolTz() {
  const tz = getSetting('school_timezone') || 'Asia/Manila';
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric',
    }).formatToParts(new Date());
    return parseInt(parts.find(p => p.type === 'year').value, 10);
  } catch (_) {
    return new Date().getFullYear();
  }
}

// Reporter roles allowed to submit incidents.
const REPORTER_ROLES = ['sysadmin', 'schoolhead', 'teacher', 'guidance', 'safetyofficer', 'student'];

// ── POST /api/incidents ───────────────────────────────────────────────────────
router.post(
  '/',
  authMiddleware,
  requirePermission('submit_incident'),
  (req, res) => {
    const { role } = req.user;

    // Students only allowed when flag is ON
    if (role === 'student') {
      const flag = getSetting('student_feature_enabled');
      if (!flag || flag === '0') {
        return res.status(403).json({ error: 'Student incident submission is not enabled.' });
      }
    }

    const {
      category_id, incident_date, incident_time,
      location_text, campus_location_id, description,
      parties,  // optional array: [{student_id?, party_text?}]
    } = req.body;

    // Required field validation
    if (!category_id || !incident_date || !incident_time || !location_text || !description) {
      return res.status(400).json({
        error: 'category_id, incident_date, incident_time, location_text, and description are required.',
      });
    }

    // Validate incident_date is not in the future
    const today = todayInSchoolTz();
    if (incident_date > today) {
      return res.status(422).json({ error: 'Incident date cannot be in the future.' });
    }

    // Validate category exists and is active
    const category = db.prepare(
      'SELECT id, is_active FROM incident_categories WHERE id = ?'
    ).get(parseInt(category_id, 10));

    if (!category) {
      return res.status(400).json({ error: 'Invalid category.' });
    }
    if (!category.is_active) {
      return res.status(400).json({ error: 'Selected category is not active.' });
    }

    // Validate campus_location_id if provided
    if (campus_location_id) {
      const loc = db.prepare(
        'SELECT id FROM campus_locations WHERE id = ? AND is_active = 1'
      ).get(parseInt(campus_location_id, 10));
      if (!loc) {
        return res.status(400).json({ error: 'Invalid or inactive campus location.' });
      }
    }

    // Validate parties (students only allowed to submit free-text parties)
    const partiesArr = Array.isArray(parties) ? parties : [];
    for (const p of partiesArr) {
      if (role === 'student' && p.student_id) {
        return res.status(400).json({ error: 'Student reporters may not link other student records as parties.' });
      }
    }

    // Generate reference number
    const year      = yearInSchoolTz();
    const refNumber = incidentSvc.generateRefNumber(year);

    // Insert incident
    const result = incidentSvc.create({
      reference_number:    refNumber,
      category_id:         parseInt(category_id, 10),
      incident_date,
      incident_time,
      location_text:       String(location_text).trim(),
      campus_location_id:  campus_location_id ? parseInt(campus_location_id, 10) : null,
      description:         String(description).trim(),
      reporter_id:         req.user.id,
    });

    const incidentId = result.lastInsertRowid;

    // Insert involved parties
    for (const p of partiesArr) {
      if (p.student_id || p.party_text) {
        incidentSvc.addParty({
          incident_id: incidentId,
          student_id:  p.student_id  ? parseInt(p.student_id, 10) : null,
          party_text:  p.party_text  ? String(p.party_text).trim() : null,
        });
      }
    }

    // Timeline: Submitted entry
    incidentSvc.addTimelineEntry({
      incident_id: incidentId,
      actor_id:    req.user.id,
      entry_type:  'Submitted',
      description: `Incident submitted by ${req.user.full_name}.`,
      new_status:  'Submitted',
    });

    // Notifications to SysAdmin and SchHead
    notificationSvc.createForRole('sysadmin', {
      type:    'Pending Incident',
      title:   `New Incident: ${refNumber}`,
      message: `A new incident report (${refNumber}) has been submitted by ${req.user.full_name}.`,
      link:    `/api/incidents/${incidentId}`,
    });
    notificationSvc.createForRole('schoolhead', {
      type:    'Pending Incident',
      title:   `New Incident: ${refNumber}`,
      message: `A new incident report (${refNumber}) has been submitted by ${req.user.full_name}.`,
      link:    `/api/incidents/${incidentId}`,
    });

    // Audit log
    auditLog({
      actorId:     req.user.id,
      actorName:   req.user.full_name,
      actorRole:   req.user.role,
      actionType:  'INCIDENT_SUBMITTED',
      targetTable: 'incidents',
      targetId:    incidentId,
      newValues:   { reference_number: refNumber, category_id, incident_date, status: 'Submitted' },
      ipAddress:   req.ip,
    });

    // Return result — students see only ref + status
    if (role === 'student') {
      return res.status(201).json({
        reference_number: refNumber,
        status: 'Submitted',
      });
    }

    return res.status(201).json(incidentSvc.findById(incidentId));
  }
);

// ── GET /api/incidents/archived ───────────────────────────────────────────────
// MUST be before /:id
router.get('/archived', authMiddleware, (req, res) => {
  if (req.user.role !== 'sysadmin') {
    return res.status(403).json({ error: 'Forbidden.' });
  }
  const rows = db.prepare(`
    SELECT i.*,
           c.name  AS category_name,
           cl.name AS campus_location_name,
           u.full_name AS reporter_name
    FROM   incidents i
    JOIN   incident_categories  c  ON c.id  = i.category_id
    LEFT JOIN campus_locations  cl ON cl.id = i.campus_location_id
    JOIN   users                u  ON u.id  = i.reporter_id
    WHERE  i.is_archived = 1
    ORDER  BY i.updated_at DESC
  `).all();
  return res.json({ data: rows });
});

// ── GET /api/incidents ────────────────────────────────────────────────────────
router.get('/', authMiddleware, requirePermission('submit_incident'), (req, res) => {
  const { status, category, from, to, reporter } = req.query;

  // Students only allowed when flag is ON
  if (req.user.role === 'student') {
    const flag = getSetting('student_feature_enabled');
    if (!flag || flag === '0') {
      return res.status(403).json({ error: 'Forbidden.' });
    }
  }

  const rows = incidentSvc.list({
    userId:      req.user.id,
    role:        req.user.role,
    status:      status || undefined,
    category_id: category ? parseInt(category, 10) : undefined,
    from:        from     || undefined,
    to:          to       || undefined,
    reporter:    reporter ? parseInt(reporter, 10) : undefined,
  });

  return res.json({ data: rows });
});

// ── GET /api/incidents/:id ────────────────────────────────────────────────────
router.get('/:id', authMiddleware, requirePermission('submit_incident'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: 'Invalid incident ID.' });
  }

  const incident = incidentSvc.findById(id);
  if (!incident) {
    return res.status(404).json({ error: 'Incident not found.' });
  }

  // Archived incidents: only SysAdmin can view
  if (incident.is_archived && req.user.role !== 'sysadmin') {
    return res.status(403).json({ error: 'Forbidden.' });
  }

  // Restricted incidents: visible only to SysAdmin, SchHead, and assigned users
  if (incident.is_restricted) {
    const { role, id: userId } = req.user;
    if (role !== 'sysadmin' && role !== 'schoolhead') {
      const assignment = db.prepare(`
        SELECT 1 FROM incident_assignments
        WHERE incident_id = ? AND assigned_to = ? AND is_active = 1
      `).get(id, userId);
      if (!assignment) {
        return res.status(403).json({ error: 'Forbidden.' });
      }
    }
  }

  // Role-scoped access for non-admin roles
  const { role, id: userId } = req.user;
  if (role === 'teacher' || role === 'guidance') {
    const isReporter  = incident.reporter_id === userId;
    const isAssigned  = db.prepare(`
      SELECT 1 FROM incident_assignments
      WHERE incident_id = ? AND assigned_to = ? AND is_active = 1
    `).get(id, userId);
    if (!isReporter && !isAssigned) {
      return res.status(403).json({ error: 'Forbidden.' });
    }
  } else if (role === 'student') {
    const flag = getSetting('student_feature_enabled');
    if (!flag || flag === '0') return res.status(403).json({ error: 'Forbidden.' });
    if (incident.reporter_id !== userId) return res.status(403).json({ error: 'Forbidden.' });
  }

  // Build full detail response
  const parties     = incidentSvc.getParties(id);
  const attachments = incidentSvc.getAttachments(id);
  const timeline    = incidentSvc.getTimeline(id);

  // Students receive a trimmed response
  if (role === 'student') {
    return res.json({
      reference_number: incident.reference_number,
      category_name:    incident.category_name,
      incident_date:    incident.incident_date,
      status:           incident.status,
      created_at:       incident.created_at,
    });
  }

  return res.json({ ...incident, parties, attachments, timeline });
});

module.exports = router;
