'use strict';

const fs           = require('fs');
const { pipeline } = require('stream');
const express      = require('express');

const authMiddleware        = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const { log: auditLog }     = require('../services/audit.service');
const incidentSvc           = require('../services/incident.service');
const attachmentSvc         = require('../services/attachment.service');

// Mounted at /api, so the paths below are /api/incidents/:id/attachments
// and /api/attachments/:id/download.
const router = express.Router();

function parseId(raw) {
  return /^[1-9]\d{0,9}$/.test(String(raw)) ? parseInt(raw, 10) : null;
}

/**
 * Loads an incident and applies the same visibility rule as
 * GET /api/incidents/:id. Sends the error response and returns null on failure.
 */
function loadVisibleIncident(req, res, incidentId) {
  const incident = incidentSvc.findById(incidentId);
  if (!incident) {
    res.status(404).json({ error: 'Incident not found.' });
    return null;
  }
  if (!incidentSvc.canUserView(req.user, incident)) {
    res.status(403).json({ error: 'Forbidden.' });
    return null;
  }
  return incident;
}

// Runs before multer so a request that will be refused never writes to disk.
function checkBeforeUpload(req, res, next) {
  const incidentId = parseId(req.params.id);
  if (!incidentId) return res.status(400).json({ error: 'Invalid incident ID.' });

  const incident = loadVisibleIncident(req, res, incidentId);
  if (!incident) return undefined;

  // Closed incidents are read-only (T-25); archived ones must be restored first (T-23).
  if (incident.status === 'Closed' || incident.is_archived) {
    return res.status(422).json({
      error: incident.status === 'Closed'
        ? 'This incident is closed; attachments can no longer be added.'
        : 'This incident is archived. Restore it before adding attachments.',
    });
  }

  if (attachmentSvc.countByIncident(incidentId) >= attachmentSvc.MAX_PER_INCIDENT) {
    return res.status(422).json({ error: attachmentSvc.MSG_LIMIT });
  }

  req.incident = incident;
  return next();
}

// ── POST /api/incidents/:id/attachments ──────────────────────────────────────
router.post(
  '/incidents/:id/attachments',
  authMiddleware,
  requirePermission('submit_incident'),
  requirePermission('manage_attachments'),
  checkBeforeUpload,
  attachmentSvc.receiveFile,
  (req, res) => {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'No file uploaded. Send one file in the "file" field.' });
    }

    // The declared type passed multer's fileFilter; now check the actual bytes.
    if (!attachmentSvc.hasValidSignature(file.path, file.mimetype)) {
      attachmentSvc.removeTemp(file);
      return res.status(422).json({ error: attachmentSvc.MSG_TYPE });
    }

    const record = {
      incident_id:   req.incident.id,
      filename:      file.filename,
      original_name: attachmentSvc.sanitizeOriginalName(file.originalname),
      mime_type:     file.mimetype,
      size_bytes:    file.size,
      uploaded_by:   req.user.id,
    };

    let attachmentId;
    try {
      attachmentId = attachmentSvc.createWithinLimit(record);
    } catch (err) {
      attachmentSvc.removeTemp(file);
      throw err;
    }
    if (!attachmentId) {
      // Another upload took the last slot while this file was arriving.
      attachmentSvc.removeTemp(file);
      return res.status(422).json({ error: attachmentSvc.MSG_LIMIT });
    }

    auditLog({
      actorId:     req.user.id,
      actorName:   req.user.full_name,
      actorRole:   req.user.role,
      actionType:  'ATTACHMENT_UPLOADED',
      targetTable: 'attachments',
      targetId:    attachmentId,
      newValues: {
        incident_id:      record.incident_id,
        reference_number: req.incident.reference_number,
        original_name:    record.original_name,
        mime_type:        record.mime_type,
        size_bytes:       record.size_bytes,
      },
      ipAddress: req.ip,
    });

    const saved = attachmentSvc.findById(attachmentId);
    return res.status(201).json({
      id:            saved.id,
      incident_id:   saved.incident_id,
      original_name: saved.original_name,
      mime_type:     saved.mime_type,
      size_bytes:    saved.size_bytes,
      uploaded_at:   saved.uploaded_at,
    });
  }
);

// ── GET /api/attachments/:id/download ────────────────────────────────────────
router.get(
  '/attachments/:id/download',
  authMiddleware,
  requirePermission('submit_incident'),
  requirePermission('manage_attachments'),
  (req, res) => {
    const id = parseId(req.params.id);
    const attachment = id ? attachmentSvc.findById(id) : null;
    if (!attachment) return res.status(404).json({ error: 'Attachment not found.' });

    const incident = loadVisibleIncident(req, res, attachment.incident_id);
    if (!incident) return undefined;

    // Path comes only from the stored row, never from the request.
    const filePath = attachmentSvc.resolveStoredPath(attachment.filename);
    let stat = null;
    try { stat = filePath ? fs.statSync(filePath) : null; } catch (_) { stat = null; }
    if (!stat || !stat.isFile()) {
      return res.status(404).json({ error: 'Attachment file is missing.' });
    }

    auditLog({
      actorId:     req.user.id,
      actorName:   req.user.full_name,
      actorRole:   req.user.role,
      actionType:  'ATTACHMENT_DOWNLOADED',
      targetTable: 'attachments',
      targetId:    attachment.id,
      newValues: {
        incident_id:      attachment.incident_id,
        reference_number: incident.reference_number,
        original_name:    attachment.original_name,
      },
      ipAddress: req.ip,
    });

    // res.attachment() builds an RFC 6266 Content-Disposition (quotes escaped,
    // non-ASCII names encoded). It also guesses Content-Type from the name,
    // so the stored type is set after it.
    res.attachment(attachment.original_name);
    res.setHeader('Content-Type', attachment.mime_type);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");

    pipeline(fs.createReadStream(filePath), res, (err) => {
      if (err && !res.headersSent) res.status(500).json({ error: 'Could not read attachment.' });
    });
    return undefined;
  }
);

module.exports = router;
