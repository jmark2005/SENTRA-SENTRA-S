'use strict';

const db = require('./db');

// ── Reference number generation ──────────────────────────────────────────────
/**
 * Generates the next INC-YYYY-NNNN reference number for the given year.
 * Uses a better-sqlite3 transaction (synchronous, serialised within the
 * Node process) to guarantee uniqueness without needing BEGIN IMMEDIATE.
 */
function generateRefNumber(year) {
  const generate = db.transaction(() => {
    db.prepare(`
      INSERT INTO incident_ref_counters (year, last_number)
      VALUES (?, 1)
      ON CONFLICT(year) DO UPDATE SET last_number = last_number + 1
    `).run(year);

    const { last_number } = db.prepare(
      'SELECT last_number FROM incident_ref_counters WHERE year = ?'
    ).get(year);

    return `INC-${year}-${String(last_number).padStart(4, '0')}`;
  });

  return generate();
}

// ── Create ────────────────────────────────────────────────────────────────────
/**
 * Inserts a new incident row and returns the RunResult.
 */
function create({
  reference_number, category_id, incident_date, incident_time,
  location_text, campus_location_id, description, reporter_id,
}) {
  return db.prepare(`
    INSERT INTO incidents
      (reference_number, category_id, incident_date, incident_time,
       location_text, campus_location_id, description, reporter_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    reference_number,
    category_id,
    incident_date,
    incident_time,
    location_text,
    campus_location_id ?? null,
    description,
    reporter_id,
  );
}

// ── Find by id ────────────────────────────────────────────────────────────────
function findById(id) {
  return db.prepare(`
    SELECT i.*,
           c.name  AS category_name,
           cl.name AS campus_location_name,
           u.full_name AS reporter_name,
           u.role_id   AS reporter_role_id,
           cb.full_name AS closed_by_name
    FROM   incidents i
    JOIN   incident_categories  c  ON c.id  = i.category_id
    LEFT JOIN campus_locations  cl ON cl.id = i.campus_location_id
    JOIN   users                u  ON u.id  = i.reporter_id
    LEFT JOIN users             cb ON cb.id = i.closed_by
    WHERE  i.id = ?
  `).get(id);
}

/** Active assignments for the detail view. */
function getAssignments(incidentId) {
  return db.prepare(`
    SELECT ia.assigned_to, u.full_name, r.name AS role, ia.assigned_at, ia.acknowledged_at
    FROM   incident_assignments ia
    JOIN   users u ON u.id = ia.assigned_to
    JOIN   roles r ON r.id = u.role_id
    WHERE  ia.incident_id = ? AND ia.is_active = 1
    ORDER  BY ia.id ASC
  `).all(incidentId);
}

/** Active users who can be assigned to incidents (Safety Officer, Guidance, Teacher). */
function listAssignableUsers() {
  return db.prepare(`
    SELECT u.id, u.full_name, r.name AS role
    FROM   users u JOIN roles r ON r.id = u.role_id
    WHERE  u.status = 'Active' AND r.name IN ('safetyofficer', 'guidance', 'teacher')
    ORDER  BY r.name, u.full_name
  `).all();
}

// ── Find by reference number ──────────────────────────────────────────────────
function findByRef(reference_number) {
  return db.prepare(`
    SELECT i.*,
           c.name  AS category_name,
           cl.name AS campus_location_name,
           u.full_name AS reporter_name
    FROM   incidents i
    JOIN   incident_categories  c  ON c.id  = i.category_id
    LEFT JOIN campus_locations  cl ON cl.id = i.campus_location_id
    JOIN   users                u  ON u.id  = i.reporter_id
    WHERE  i.reference_number = ?
  `).get(reference_number);
}

// ── List (role-scoped, with optional filters) ─────────────────────────────────
/**
 * @param {object} opts
 * @param {number}  opts.userId
 * @param {string}  opts.role       — sysadmin|schoolhead|teacher|guidance|safetyofficer|student
 * @param {string}  [opts.status]
 * @param {number}  [opts.category_id]
 * @param {string}  [opts.from]      YYYY-MM-DD
 * @param {string}  [opts.to]        YYYY-MM-DD
 * @param {number}  [opts.reporter]  user id filter (SysAdmin/SchHead only)
 */
function list({ userId, role, status, category_id, from, to, reporter } = {}) {
  const conditions = ['i.is_archived = 0'];
  const params     = [];

  // Role-based visibility ------------------------------------------------
  if (role === 'sysadmin' || role === 'schoolhead') {
    // See all including restricted — no extra condition needed
  } else if (role === 'safetyofficer') {
    // All non-restricted, plus any restricted they are assigned to
    conditions.push(`(
      i.is_restricted = 0
      OR EXISTS (
        SELECT 1 FROM incident_assignments ia
        WHERE ia.incident_id = i.id AND ia.assigned_to = ? AND ia.is_active = 1
      )
    )`);
    params.push(userId);
  } else if (role === 'teacher' || role === 'guidance') {
    // Assigned to self (even if restricted), OR reported by self and not restricted.
    // Matches canUserView() in incident.service.js.
    conditions.push(`(
      EXISTS (
        SELECT 1 FROM incident_assignments ia
        WHERE ia.incident_id = i.id AND ia.assigned_to = ? AND ia.is_active = 1
      )
      OR (i.reporter_id = ? AND i.is_restricted = 0)
    )`);
    params.push(userId, userId);
  } else if (role === 'student') {
    // Own submissions only; restricted never visible
    conditions.push(`i.is_restricted = 0`);
    conditions.push(`i.reporter_id = ?`);
    params.push(userId);
  } else {
    // Unknown role: show nothing
    conditions.push('1 = 0');
  }

  // Optional filters -------------------------------------------------------
  if (status) {
    conditions.push('i.status = ?');
    params.push(status);
  }
  if (category_id) {
    conditions.push('i.category_id = ?');
    params.push(category_id);
  }
  if (from) {
    conditions.push('i.incident_date >= ?');
    params.push(from);
  }
  if (to) {
    conditions.push('i.incident_date <= ?');
    params.push(to);
  }
  if (reporter && (role === 'sysadmin' || role === 'schoolhead')) {
    conditions.push('i.reporter_id = ?');
    params.push(reporter);
  }

  const where = 'WHERE ' + conditions.join(' AND ');

  return db.prepare(`
    SELECT i.id, i.reference_number, i.category_id, i.incident_date, i.incident_time,
           i.location_text, i.campus_location_id, i.severity, i.status,
           i.is_restricted, i.reporter_id, i.created_at, i.updated_at,
           c.name  AS category_name,
           cl.name AS campus_location_name,
           u.full_name AS reporter_name
    FROM   incidents i
    JOIN   incident_categories  c  ON c.id  = i.category_id
    LEFT JOIN campus_locations  cl ON cl.id = i.campus_location_id
    JOIN   users                u  ON u.id  = i.reporter_id
    ${where}
    ORDER BY i.created_at DESC
  `).all(...params);
}

// ── Involved parties ──────────────────────────────────────────────────────────
function getParties(incidentId) {
  return db.prepare(`
    SELECT ip.id, ip.student_id, ip.party_text,
           s.student_number, s.first_name, s.last_name
    FROM   incident_parties ip
    LEFT JOIN students s ON s.id = ip.student_id
    WHERE  ip.incident_id = ?
    ORDER  BY ip.id ASC
  `).all(incidentId);
}

function addParty({ incident_id, student_id, party_text }) {
  return db.prepare(`
    INSERT INTO incident_parties (incident_id, student_id, party_text)
    VALUES (?, ?, ?)
  `).run(incident_id, student_id ?? null, party_text ?? null);
}

// ── Attachments list (for detail view) ───────────────────────────────────────
function getAttachments(incidentId) {
  return db.prepare(`
    SELECT id, original_name, mime_type, size_bytes, uploaded_at
    FROM   attachments
    WHERE  incident_id = ?
    ORDER  BY uploaded_at ASC
  `).all(incidentId);
}

function isActiveAssignee(incidentId, userId) {
  return !!db.prepare(`
    SELECT 1 FROM incident_assignments
    WHERE  incident_id = ? AND assigned_to = ? AND is_active = 1
  `).get(incidentId, userId);
}

// ── Activity log (timeline) ───────────────────────────────────────────────────
function addTimelineEntry({ incident_id, actor_id, entry_type, description, old_status, new_status, follow_up_date }) {
  return db.prepare(`
    INSERT INTO incident_activity_log
      (incident_id, actor_id, entry_type, description, old_status, new_status, follow_up_date)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    incident_id,
    actor_id,
    entry_type,
    description,
    old_status ?? null,
    new_status ?? null,
    follow_up_date ?? null,
  );
}

function getTimeline(incidentId) {
  // created_at has one-second resolution, so id breaks ties to keep insert order.
  return db.prepare(`
    SELECT al.id, al.entry_type, al.description, al.old_status, al.new_status,
           al.follow_up_date, al.created_at,
           u.full_name AS actor_name, u.id AS actor_id, r.name AS actor_role
    FROM   incident_activity_log al
    JOIN   users u ON u.id = al.actor_id
    JOIN   roles r ON r.id = u.role_id
    WHERE  al.incident_id = ?
    ORDER  BY al.created_at ASC, al.id ASC
  `).all(incidentId);
}

// ── Workflow updates ──────────────────────────────────────────────────────────
// Each update is guarded by the status the caller saw, so a concurrent change
// makes it affect 0 rows instead of overwriting.

const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";

function setClassification(id, expectedStatus, severity, newStatus) {
  return db.prepare(`
    UPDATE incidents SET severity = ?, status = ?, updated_at = ${NOW_SQL}
    WHERE  id = ? AND status = ?
  `).run(severity, newStatus, id, expectedStatus).changes;
}

function setStatus(id, expectedStatus, newStatus, resolutionSummary) {
  return db.prepare(`
    UPDATE incidents
    SET    status = ?, resolution_summary = COALESCE(?, resolution_summary), updated_at = ${NOW_SQL}
    WHERE  id = ? AND status = ?
  `).run(newStatus, resolutionSummary ?? null, id, expectedStatus).changes;
}

function setRestricted(id, value) {
  return db.prepare(`
    UPDATE incidents SET is_restricted = ?, updated_at = ${NOW_SQL}
    WHERE  id = ? AND is_restricted = ?
  `).run(value, id, value ? 0 : 1).changes;
}

// Marks an incident as changed while it is still in one of `statuses`.
function touch(id, statuses) {
  return db.prepare(`
    UPDATE incidents SET updated_at = ${NOW_SQL}
    WHERE  id = ? AND status IN (${statuses.map(() => '?').join(', ')})
  `).run(id, ...statuses).changes;
}

// ── Assignments ───────────────────────────────────────────────────────────────
function findUsersByIds(ids) {
  if (!ids.length) return [];
  return db.prepare(`
    SELECT u.id, u.full_name, u.status, r.name AS role
    FROM   users u JOIN roles r ON r.id = u.role_id
    WHERE  u.id IN (${ids.map(() => '?').join(', ')})
  `).all(...ids);
}

/** Adds an active assignment unless the user already has one on this incident. */
function addAssignment(incidentId, userId, assignedBy) {
  return db.prepare(`
    INSERT INTO incident_assignments (incident_id, assigned_to, assigned_by)
    SELECT ?, ?, ?
    WHERE NOT EXISTS (
      SELECT 1 FROM incident_assignments
      WHERE incident_id = ? AND assigned_to = ? AND is_active = 1
    )
  `).run(incidentId, userId, assignedBy, incidentId, userId).changes;
}

function findActiveAssignment(incidentId, userId) {
  return db.prepare(`
    SELECT id, acknowledged_at FROM incident_assignments
    WHERE  incident_id = ? AND assigned_to = ? AND is_active = 1
    ORDER  BY id DESC LIMIT 1
  `).get(incidentId, userId);
}

function acknowledgeAssignment(assignmentId) {
  return db.prepare(`
    UPDATE incident_assignments SET acknowledged_at = ${NOW_SQL}
    WHERE  id = ? AND acknowledged_at IS NULL
  `).run(assignmentId).changes;
}

/** Resolved → Closed with the closure record (T-25). */
function closeIncident(id, closureSummary, closedBy) {
  return db.prepare(`
    UPDATE incidents
    SET    status = 'Closed', closure_summary = ?, closed_by = ?,
           closed_at = ${NOW_SQL}, updated_at = ${NOW_SQL}
    WHERE  id = ? AND status = 'Resolved'
  `).run(closureSummary, closedBy, id).changes;
}

// Archiving only flips the flag, so restore returns the incident to its last status.
function setArchived(id, value) {
  return db.prepare(`
    UPDATE incidents SET is_archived = ?, updated_at = ${NOW_SQL}
    WHERE  id = ? AND is_archived = ?
  `).run(value, id, value ? 0 : 1).changes;
}

module.exports = {
  generateRefNumber,
  create,
  findById,
  getAssignments,
  listAssignableUsers,
  findByRef,
  list,
  getParties,
  addParty,
  getAttachments,
  isActiveAssignee,
  addTimelineEntry,
  getTimeline,
  setClassification,
  setStatus,
  setRestricted,
  setArchived,
  closeIncident,
  touch,
  findUsersByIds,
  addAssignment,
  findActiveAssignment,
  acknowledgeAssignment,
};
