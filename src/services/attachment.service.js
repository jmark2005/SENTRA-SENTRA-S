'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const multer = require('multer');

const repo = require('../repositories/attachment.repository');

// Storage lives outside public/ so files are only reachable through the
// permission-checked download route.
const UPLOAD_DIR       = path.resolve(__dirname, '..', '..', 'uploads');
const MAX_FILE_BYTES   = 5 * 1024 * 1024; // 5 MB
const MAX_PER_INCIDENT = 3;

// Wording from requirements.md US-2.2 and test-plan.md TC-2.6 to TC-2.8.
const MSG_TYPE  = 'Only JPG, PNG, and PDF files are accepted';
const MSG_SIZE  = 'File exceeds the 5 MB size limit';
const MSG_LIMIT = `This incident already has the maximum ${MAX_PER_INCIDENT} attachments`;

// Declared MIME type -> stored extension + the bytes the file must start with.
const ACCEPTED = {
  'image/jpeg':      { ext: '.jpg', signature: [0xFF, 0xD8, 0xFF] },
  'image/png':       { ext: '.png', signature: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] },
  'application/pdf': { ext: '.pdf', signature: [0x25, 0x50, 0x44, 0x46, 0x2D] }, // "%PDF-"
};

// Stored names are always generated here: <uuid>.<ext>
const STORED_NAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|pdf)$/;

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

class UploadRejection extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    // fileFilter has already rejected unknown types, so ACCEPTED[...] exists.
    filename: (req, file, cb) => cb(null, crypto.randomUUID() + ACCEPTED[file.mimetype].ext),
  }),
  limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 5, parts: 10 },
  // Browsers send UTF-8 filenames; multer's default (latin1) would garble them.
  defParamCharset: 'utf8',
  // Reject on the declared type before anything is written to disk.
  fileFilter: (req, file, cb) => {
    if (!ACCEPTED[file.mimetype]) return cb(new UploadRejection(422, MSG_TYPE));
    return cb(null, true);
  },
}).single('file');

function removeTemp(file) {
  if (!file || !file.path) return;
  try { fs.rmSync(file.path, { force: true }); } catch (_) { /* already gone */ }
}

/**
 * Express middleware: receives one file in the "file" field.
 * Converts multer errors into the spec's 400/422 JSON responses.
 * Multer removes partially written files when it aborts; removeTemp is a backstop.
 */
function receiveFile(req, res, next) {
  upload(req, res, (err) => {
    if (!err) return next();
    removeTemp(req.file);

    if (err instanceof UploadRejection) {
      return res.status(err.status).json({ error: err.message });
    }
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(422).json({ error: MSG_SIZE });
      }
      return res.status(400).json({ error: 'Send exactly one file in the "file" field.' });
    }
    // Disk or OS failures are server errors; anything else is a malformed upload.
    if (err.syscall) return next(err);
    return res.status(400).json({ error: 'Invalid upload request.' });
  });
}

/** True when the file on disk starts with the signature for its declared type. */
function hasValidSignature(filePath, mimeType) {
  const accepted = ACCEPTED[mimeType];
  if (!accepted) return false;

  const sig = accepted.signature;
  const buf = Buffer.alloc(sig.length);
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    if (fs.readSync(fd, buf, 0, sig.length, 0) < sig.length) return false;
  } catch (_) {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return sig.every((byte, i) => buf[i] === byte);
}

/** Display name only: strips any client path, control and reserved characters. */
function sanitizeOriginalName(name) {
  let base = String(name || '').split(/[\\/]/).pop();
  base = base.replace(/[\u0000-\u001F\u007F"<>:|?*]/g, '').trim();
  if (base.length > 200) {
    const ext = path.extname(base).slice(0, 10);
    base = base.slice(0, 200 - ext.length) + ext;
  }
  return base || 'attachment';
}

/**
 * Absolute path for a stored filename taken from the database.
 * Returns null for anything that is not one of our generated names.
 */
function resolveStoredPath(storedName) {
  if (!STORED_NAME_RE.test(String(storedName))) return null;
  const full = path.join(UPLOAD_DIR, storedName);
  return path.dirname(full) === UPLOAD_DIR ? full : null;
}

module.exports = {
  UPLOAD_DIR,
  MAX_FILE_BYTES,
  MAX_PER_INCIDENT,
  MSG_TYPE,
  MSG_SIZE,
  MSG_LIMIT,
  receiveFile,
  removeTemp,
  hasValidSignature,
  sanitizeOriginalName,
  resolveStoredPath,
  countByIncident:   repo.countByIncident,
  findById:          repo.findById,
  createWithinLimit: (data) => repo.createWithinLimit(data, MAX_PER_INCIDENT),
};
