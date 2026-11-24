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
           u.role_id   AS reporter_role_id
    FROM   incidents i
    JOIN   incident_categories  c  ON c.id  = i.category_id
    LEFT JOIN campus_locations  cl ON cl.id = i.campus_location_id
    JOIN   users                u  ON u.id  = i.reporter_id
    WHERE  i.id = ?
  `).get(id);
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
  } else if (role === 'teacher') {
    // Reported by self OR assigned to self; restricted hidden
    conditions.push(`i.is_restricted = 0`);
    conditions.push(`(
      i.reporter_id = ?
      OR EXISTS (
        SELECT 1 FROM incident_assignments ia
        WHERE ia.incident_id = i.id AND ia.assigned_to = ? AND ia.is_active = 1
      )
    )`);
    params.push(userId, userId);
  } else if (role === 'guidance') {
    // Assigned to self OR reported by self; restricted hidden even if they reported it
    conditions.push(`i.is_restricted = 0`);
    conditions.push(`(
      i.reporter_id = ?
      OR EXISTS (
        SELECT 1 FROM incident_assignments ia
        WHERE ia.incident_id = i.id AND ia.assigned_to = ? AND ia.is_active = 1
      )
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

// ── Activity log (timeline) ───────────────────────────────────────────────────
function addTimelineEntry({ incident_id, actor_id, entry_type, description, old_status, new_status }) {
  return db.prepare(`
    INSERT INTO incident_activity_log
      (incident_id, actor_id, entry_type, description, old_status, new_status)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    incident_id,
    actor_id,
    entry_type,
    description,
    old_status ?? null,
    new_status ?? null,
  );
}

function getTimeline(incidentId) {
  return db.prepare(`
    SELECT al.id, al.entry_type, al.description, al.old_status, al.new_status,
           al.follow_up_date, al.created_at,
           u.full_name AS actor_name, u.id AS actor_id
    FROM   incident_activity_log al
    JOIN   users u ON u.id = al.actor_id
    WHERE  al.incident_id = ?
    ORDER  BY al.created_at ASC
  `).all(incidentId);
}

module.exports = {
  generateRefNumber,
  create,
  findById,
  findByRef,
  list,
  getParties,
  addParty,
  getAttachments,
  addTimelineEntry,
  getTimeline,
};
