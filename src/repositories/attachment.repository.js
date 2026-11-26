'use strict';

const db = require('./db');

function countByIncident(incidentId) {
  return db.prepare(
    'SELECT COUNT(*) AS n FROM attachments WHERE incident_id = ?'
  ).get(incidentId).n;
}

function findById(id) {
  return db.prepare(`
    SELECT id, incident_id, filename, original_name, mime_type,
           size_bytes, uploaded_by, uploaded_at
    FROM   attachments
    WHERE  id = ?
  `).get(id);
}

/**
 * Inserts an attachment row only while the incident is under the limit.
 * The count and the insert share one transaction, so two uploads arriving
 * at the same moment cannot both slip in as the 3rd file.
 *
 * @returns {number|null} new attachment id, or null if the limit was reached
 */
const createWithinLimit = db.transaction((data, maxPerIncident) => {
  if (countByIncident(data.incident_id) >= maxPerIncident) return null;

  const result = db.prepare(`
    INSERT INTO attachments
      (incident_id, filename, original_name, mime_type, size_bytes, uploaded_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    data.incident_id,
    data.filename,
    data.original_name,
    data.mime_type,
    data.size_bytes,
    data.uploaded_by,
  );
  return Number(result.lastInsertRowid);
});

module.exports = { countByIncident, findById, createWithinLimit };
