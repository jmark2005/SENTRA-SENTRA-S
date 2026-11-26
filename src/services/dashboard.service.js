'use strict';

/**
 * Role-scoped dashboard metrics (T-33).
 *
 * Every figure is computed for the signed-in user only; there is no way to
 * ask for another user's numbers. Archived records are never counted.
 * "Current term" = system_settings current_school_year + current_semester.
 */

const db              = require('../repositories/db');
const { getSetting }  = require('./settings.service');
const { schoolToday } = require('../utils/school-time');

const OPEN_STATUSES = ['Submitted', 'Under Review', 'Assigned', 'In Progress', 'For Follow-Up', 'Resolved'];
const RESPONSE_STATUSES = ['Assigned', 'In Progress', 'For Follow-Up'];
const SY = col => `REPLACE(${col}, '–', '-')`; // settings use an en dash, classes a hyphen

function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function rate(attended, total) {
  return total ? Math.round((attended / total) * 1000) / 10 : null;
}

/** Attendance rate for the current term, optionally limited to some classes. */
function termAttendance(term, classIds) {
  const scope = classIds ? `AND a.class_id IN (${classIds.map(() => '?').join(', ') || 'NULL'})` : '';
  const row = db.prepare(`
    SELECT COUNT(*) AS total, COALESCE(SUM(a.status IN ('Present', 'Tardy')), 0) AS attended
    FROM   attendance_records a JOIN classes c ON c.id = a.class_id
    WHERE  a.is_archived = 0 AND ${SY('c.school_year')} = ${SY('?')} AND c.semester = ? ${scope}
  `).get(term.school_year, term.semester, ...(classIds || []));
  return { rate: rate(row.attended, row.total), records: row.total };
}

function countsBy(sql, params, keys) {
  const out = {};
  keys.forEach(k => { out[k] = 0; });
  db.prepare(sql).all(...params).forEach(r => { out[r.k] = r.n; });
  return out;
}

// ── SysAdmin and School Head ────────────────────────────────────────────────
function adminMetrics(term) {
  const byStatus = countsBy(`
    SELECT status AS k, COUNT(*) AS n FROM incidents
    WHERE is_archived = 0 AND status <> 'Closed' GROUP BY status
  `, [], OPEN_STATUSES);
  return {
    active_students: db.prepare("SELECT COUNT(*) n FROM students WHERE status = 'Active'").get().n,
    open_incidents: Object.values(byStatus).reduce((a, b) => a + b, 0),
    open_incidents_by_status: byStatus,
    pending_incidents_by_category: db.prepare(`
      SELECT c.name AS category, COUNT(*) AS count
      FROM   incidents i JOIN incident_categories c ON c.id = i.category_id
      WHERE  i.is_archived = 0 AND i.status = 'Submitted'
      GROUP  BY c.name ORDER BY count DESC, c.name
    `).all(),
    pending_referrals: db.prepare("SELECT COUNT(*) n FROM referrals WHERE is_archived = 0 AND status = 'Pending'").get().n,
    attendance: termAttendance(term, null),
    pending_accounts: db.prepare("SELECT COUNT(*) n FROM users WHERE status = 'Pending'").get().n,
  };
}

// ── Teacher ──────────────────────────────────────────────────────────────────
function teacherMetrics(user, term, today) {
  const classes = db.prepare(`
    SELECT c.id, c.name, c.section
    FROM   classes c
    WHERE  c.is_active = 1 AND ${SY('c.school_year')} = ${SY('?')} AND c.semester = ?
      AND  c.id IN (SELECT class_id FROM class_teachers WHERE user_id = ?
                    UNION SELECT id FROM classes WHERE class_adviser_id = ?)
    ORDER  BY c.name
  `).all(term.school_year, term.semester, user.id, user.id).map(c => {
    const students = db.prepare(`
      SELECT COUNT(*) n FROM student_class_assignments sca JOIN students s ON s.id = sca.student_id
      WHERE  sca.class_id = ? AND s.status = 'Active'
    `).get(c.id).n;
    const recordedToday = db.prepare(`
      SELECT COUNT(*) n FROM attendance_records WHERE class_id = ? AND record_date = ? AND is_archived = 0
    `).get(c.id, today).n;
    return { ...c, students, recorded_today: recordedToday, attendance_rate: termAttendance(term, [c.id]).rate };
  });

  const incidents = db.prepare(`
    SELECT COUNT(*) AS total, COALESCE(SUM(status <> 'Closed'), 0) AS open
    FROM   incidents WHERE reporter_id = ? AND is_archived = 0
  `).get(user.id);
  const referrals = db.prepare(`
    SELECT COUNT(*) AS total, COALESCE(SUM(status = 'Pending'), 0) AS pending
    FROM   referrals WHERE referring_user = ? AND is_archived = 0
  `).get(user.id);

  return {
    classes,
    attendance_today: {
      recorded: classes.reduce((a, c) => a + c.recorded_today, 0),
      students: classes.reduce((a, c) => a + c.students, 0),
    },
    attendance: termAttendance(term, classes.map(c => c.id)),
    incidents_reported: incidents,
    referrals_submitted: referrals,
  };
}

// ── Guidance ─────────────────────────────────────────────────────────────────
function guidanceMetrics(user, today) {
  const byStatus = countsBy(`
    SELECT status AS k, COUNT(*) AS n FROM referrals
    WHERE  assigned_to = ? AND is_archived = 0 GROUP BY status
  `, [user.id], ['Ongoing', 'Completed', 'Referred']);

  // Latest next_followup for each Ongoing referral assigned to this user
  const next = db.prepare(`
    SELECT f.next_followup AS d
    FROM   referrals r
    JOIN   referral_followups f ON f.id = (
             SELECT MAX(x.id) FROM referral_followups x
             WHERE  x.referral_id = r.id AND x.next_followup IS NOT NULL)
    WHERE  r.assigned_to = ? AND r.status = 'Ongoing' AND r.is_archived = 0
  `).all(user.id).map(r => r.d);
  const weekEnd = addDays(today, 6);

  return {
    referral_queue: db.prepare(`
      SELECT COUNT(*) n FROM referrals WHERE status = 'Pending' AND assigned_to IS NULL AND is_archived = 0
    `).get().n,
    referrals_assigned_by_status: byStatus,
    followups_due_today: next.filter(d => d === today).length,
    followups_due_this_week: next.filter(d => d >= today && d <= weekEnd).length,
    followups_overdue: next.filter(d => d < today).length,
    week: { from: today, to: weekEnd },
  };
}

// ── Safety Officer ───────────────────────────────────────────────────────────
function safetyMetrics(user, today) {
  const placeholders = RESPONSE_STATUSES.map(() => '?').join(', ');
  const open = db.prepare(`
    SELECT i.id, ia.acknowledged_at,
           (SELECT al.follow_up_date FROM incident_activity_log al
            WHERE  al.incident_id = i.id AND al.follow_up_date IS NOT NULL
            ORDER  BY al.id DESC LIMIT 1) AS follow_up_date
    FROM   incidents i
    JOIN   incident_assignments ia ON ia.incident_id = i.id AND ia.assigned_to = ? AND ia.is_active = 1
    WHERE  i.is_archived = 0 AND i.status IN (${placeholders})
  `).all(user.id, ...RESPONSE_STATUSES);

  return {
    open_assigned_incidents: open.length,
    awaiting_acknowledgement: open.filter(r => !r.acknowledged_at).length,
    followups_due_today: open.filter(r => r.follow_up_date === today).length,
    overdue_followups: open.filter(r => r.follow_up_date && r.follow_up_date < today).length,
  };
}

/** @returns {object|null} null when the role has no staff dashboard */
function summaryFor(user) {
  const term = { school_year: getSetting('current_school_year'), semester: getSetting('current_semester') };
  const today = schoolToday();
  let metrics;
  switch (user.role) {
    case 'sysadmin':
    case 'schoolhead':    metrics = adminMetrics(term); break;
    case 'teacher':       metrics = teacherMetrics(user, term, today); break;
    case 'guidance':      metrics = guidanceMetrics(user, today); break;
    case 'safetyofficer': metrics = safetyMetrics(user, today); break;
    default:              return null;
  }
  return { role: user.role, school_year: term.school_year, semester: term.semester, today, metrics };
}

module.exports = { summaryFor };
