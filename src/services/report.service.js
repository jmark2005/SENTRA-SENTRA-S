'use strict';

/**
 * Report exports (T-34). Requirements: requirements.md US-6.8 and US-5.6;
 * endpoints: design.md §3.12.
 *
 * Every report needs view_reports plus the permission that guards the same
 * data elsewhere (checked in report.routes.js). On top of that:
 *   Incident Summary, Response Summary — never Teachers (US-6.8: 403). Other
 *     roles get exactly the incidents their incident list shows: archived
 *     never; restricted only for SysAdmin, SchHead and assigned users.
 *   Attendance Summary — Teachers get their own classes only.
 *   Referral Summary — counts by type and status of the referrals the user
 *     can see. SysAdmin and SchHead also get the student numbers; student
 *     names and remarks are never exported.
 *   Audit Log — SchHead gets the authorized subset (same rule as the viewer).
 * Each export writes one REPORT_EXPORTED audit entry (report, format, filters, rows).
 */

const db             = require('../repositories/db');
const incidentRepo   = require('../repositories/incident.repository');
const referralRepo   = require('../repositories/referral.repository');
const attendanceSvc  = require('./attendance.service');
const { log: auditLog, buildFilter } = require('./audit.service');
const { getSetting } = require('./settings.service');
const { STATUSES: INCIDENT_STATUSES } = require('./incident-workflow.service');
const { TYPES: REFERRAL_TYPES, STATUSES: REFERRAL_STATUSES } = require('./referral.service');
const { schoolToday, schoolTimestamp, isIsoDate } = require('../utils/school-time');
const { toCsv, toPdf } = require('../utils/report-output');

class ReportError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ── Filter checks ────────────────────────────────────────────────────────────
function present(value) { return value !== undefined && value !== null && value !== ''; }

function optionalDate(value, name) {
  if (!present(value)) return null;
  if (!isIsoDate(String(value))) throw new ReportError(400, `${name} must be a real date (YYYY-MM-DD).`);
  return String(value);
}

function dateRange(q) {
  const from = optionalDate(q.from, 'from');
  const to   = optionalDate(q.to, 'to');
  if (from && to && from > to) throw new ReportError(400, 'from must be on or before to.');
  return { from, to };
}

function oneOf(value, list, name) {
  if (!present(value)) return null;
  if (!list.includes(value)) throw new ReportError(400, `${name} must be one of: ${list.join(', ')}.`);
  return value;
}

function optionalText(value) { return present(value) ? String(value) : null; }

/** UTC timestamp from the database → school-timezone "YYYY-MM-DD HH:MM:SS". */
function local(iso) { return iso ? schoolTimestamp(new Date(iso)) : ''; }

function noTeachers(user, title) {
  if (user.role === 'teacher') throw new ReportError(403, `Teachers cannot export the ${title}.`);
}

/** The incidents the user's incident list shows, oldest first. */
function scopedIncidents(user, f) {
  return incidentRepo.list({ userId: user.id, role: user.role, ...f })
    .sort((a, b) => a.incident_date.localeCompare(b.incident_date)
      || a.reference_number.localeCompare(b.reference_number));
}

// ── 1. Incident Summary ──────────────────────────────────────────────────────
function incidentReport(user, q) {
  noTeachers(user, 'Incident Summary');
  const { from, to } = dateRange(q);
  const status = oneOf(q.status, INCIDENT_STATUSES, 'status');

  let category = null;
  if (present(q.category)) {
    const row = /^[1-9]\d{0,9}$/.test(String(q.category))
      && db.prepare('SELECT id, name FROM incident_categories WHERE id = ?').get(Number(q.category));
    if (!row) throw new ReportError(400, 'category must be an existing category ID.');
    category = row;
  }

  const incidents = scopedIncidents(user, { from, to, status, category_id: category ? category.id : undefined });
  const assigned = new Map(db.prepare(`
    SELECT ia.incident_id AS id, group_concat(u.full_name, '; ') AS names
    FROM   incident_assignments ia JOIN users u ON u.id = ia.assigned_to
    WHERE  ia.is_active = 1
    GROUP  BY ia.incident_id
  `).all().map(r => [r.id, r.names]));

  return {
    title: 'Incident Summary', slug: 'incident-summary', source: 'incidents',
    filters: { from, to, category: category ? category.name : null, status },
    columns: [
      { label: 'Reference Number', width: 1.3 }, { label: 'Category', width: 1.4 },
      { label: 'Date', width: 0.9 }, { label: 'Severity', width: 0.8 }, { label: 'Status', width: 1 },
      { label: 'Reporter', width: 1.4 }, { label: 'Assigned Personnel', width: 2.2 },
    ],
    rows: incidents.map(i => [
      i.reference_number, i.category_name, i.incident_date, i.severity || '', i.status,
      i.reporter_name, assigned.get(i.id) || '',
    ]),
  };
}

// ── 2. Response / Task Completion Summary ────────────────────────────────────
function responseReport(user, q) {
  noTeachers(user, 'Response Summary');
  const { from, to } = dateRange(q);
  const incidents = scopedIncidents(user, { from, to });

  const stats = new Map(db.prepare(`
    SELECT i.id, i.resolution_summary, cu.full_name AS closed_by_name,
           (SELECT COUNT(*)          FROM incident_activity_log l WHERE l.incident_id = i.id AND l.entry_type = 'Action')     AS action_count,
           (SELECT MAX(l.created_at) FROM incident_activity_log l WHERE l.incident_id = i.id AND l.entry_type = 'Action')     AS last_action_at,
           (SELECT MAX(l.created_at) FROM incident_activity_log l WHERE l.incident_id = i.id AND l.entry_type = 'Resolution') AS resolved_at
    FROM   incidents i LEFT JOIN users cu ON cu.id = i.closed_by
    WHERE  i.id IN (SELECT value FROM json_each(?))
  `).all(JSON.stringify(incidents.map(i => i.id))).map(r => [r.id, r]));

  return {
    title: 'Response / Task Completion Summary', slug: 'response-summary', source: 'incidents',
    filters: { from, to },
    columns: [
      { label: 'Reference Number', width: 1.2 }, { label: 'Status', width: 0.9 },
      { label: 'Resolution Summary', width: 3.2 }, { label: 'Action Count', width: 0.7 },
      { label: 'Last Action Date', width: 1.2 }, { label: 'Resolution Date', width: 1.2 },
      { label: 'Closed By', width: 1.2 },
    ],
    rows: incidents.map(i => {
      const s = stats.get(i.id);
      return [i.reference_number, i.status, s.resolution_summary || '', s.action_count,
        local(s.last_action_at), local(s.resolved_at), s.closed_by_name || ''];
    }),
  };
}

// ── 3. Attendance Summary ────────────────────────────────────────────────────
function attendanceReport(user, q) {
  let result;
  try {
    result = attendanceSvc.summaryRows(user, {
      class: q.class, section: q.section, semester: q.semester,
      school_year: q.school_year, from: q.from, to: q.to,
    });
  } catch (err) {
    if (err instanceof attendanceSvc.AttendanceError) throw new ReportError(err.status, err.message);
    throw err;
  }
  const { filters, data } = result;
  delete filters.archived; // always 0 here

  return {
    title: 'Attendance Summary', slug: 'attendance-summary', source: 'attendance_records',
    filters,
    columns: [
      { label: 'Student Number', width: 1.1 }, { label: 'Student Name', width: 1.8 },
      { label: 'Class', width: 1.4 }, { label: 'Section', width: 0.8 }, { label: 'Semester', width: 1 },
      { label: 'School Year', width: 0.9 }, { label: 'Absent', width: 0.6 }, { label: 'Tardy', width: 0.6 },
      { label: 'Present', width: 0.6 }, { label: 'Total Days', width: 0.7 }, { label: 'Attendance %', width: 0.8 },
    ],
    rows: data.map(r => [
      r.student_number, `${r.last_name}, ${r.first_name}`, r.class_name, r.section, r.semester,
      r.school_year, r.absent, r.tardy, r.present, r.total_days,
      r.attendance_rate === null ? '' : r.attendance_rate,
    ]),
  };
}

// ── 4. Referral Summary ──────────────────────────────────────────────────────
function referralReport(user, q) {
  const { from, to } = dateRange(q);
  const type   = oneOf(q.type, REFERRAL_TYPES, 'type');
  const status = oneOf(q.status, REFERRAL_STATUSES, 'status');
  const withNumbers = user.role === 'sysadmin' || user.role === 'schoolhead';

  const groups = new Map();
  referralRepo.list({ userId: user.id, role: user.role, type, status })
    .filter(r => (!from || r.referral_date >= from) && (!to || r.referral_date <= to))
    .forEach(r => {
      const key = `${r.referral_type}|${r.status}`;
      if (!groups.has(key)) groups.set(key, { count: 0, numbers: new Set() });
      const g = groups.get(key);
      g.count++;
      g.numbers.add(r.student_number);
    });

  const rows = [];
  for (const t of REFERRAL_TYPES) {
    for (const s of REFERRAL_STATUSES) {
      const g = groups.get(`${t}|${s}`);
      if (!g) continue;
      rows.push(withNumbers ? [t, s, g.count, [...g.numbers].sort().join('; ')] : [t, s, g.count]);
    }
  }

  const columns = [{ label: 'Referral Type', width: 2 }, { label: 'Status', width: 1 }, { label: 'Count', width: 0.6 }];
  if (withNumbers) columns.push({ label: 'Student Numbers', width: 4 });

  return {
    title: 'Referral Summary', slug: 'referral-summary', source: 'referrals',
    filters: { from, to, type, status }, columns, rows,
  };
}

// ── 5. Audit Log ─────────────────────────────────────────────────────────────
function auditReport(user, q) {
  const filters = { ...dateRange(q), actor: optionalText(q.actor), action_type: optionalText(q.action_type) };
  const { where, params } = buildFilter(user, filters);
  const entries = db.prepare(`
    SELECT a.created_at, a.actor_name, a.actor_role, a.action_type,
           a.target_table, a.target_id, a.old_values, a.new_values
    FROM   audit_logs a
    ${where}
    ORDER  BY a.created_at ASC, a.id ASC
  `).all(...params);

  return {
    title: 'Audit Log', slug: 'audit-log', source: 'audit_logs', filters,
    columns: [
      // Action Type is sized so the longest type (~141pt at 8pt) stays on one line
      { label: 'Timestamp', width: 1.15 }, { label: 'Actor', width: 1.25 }, { label: 'Role', width: 0.95 },
      { label: 'Action Type', width: 2 }, { label: 'Target', width: 1.05 },
      { label: 'Old Values', width: 1.55 }, { label: 'New Values', width: 2.1 },
    ],
    rows: entries.map(e => [
      local(e.created_at), e.actor_name, e.actor_role, e.action_type,
      e.target_table ? `${e.target_table}${e.target_id ? ' #' + e.target_id : ''}` : '',
      e.old_values || '', e.new_values || '',
    ]),
  };
}

// ── Export ───────────────────────────────────────────────────────────────────
const BUILDERS = {
  incidents:   incidentReport,
  response:    responseReport,
  attendance:  attendanceReport,
  referrals:   referralReport,
  'audit-log': auditReport,
};

/**
 * Builds report `name` for ctx.user, writes it as CSV or PDF, and logs the export.
 * @returns {Promise<{ body: Buffer, filename: string, contentType: string }>}
 */
async function exportReport(name, ctx, query) {
  const build = BUILDERS[name];
  if (!build) throw new ReportError(404, 'Unknown report.');
  const format = present(query.format) ? query.format : 'csv';
  if (format !== 'csv' && format !== 'pdf') throw new ReportError(400, 'format must be csv or pdf.');

  const { user } = ctx;
  const report = build(user, query);
  const filters = Object.fromEntries(Object.entries(report.filters).filter(([, v]) => present(v)));

  let body;
  if (format === 'csv') {
    body = toCsv(report);
  } else {
    const role = db.prepare('SELECT display_name FROM roles WHERE name = ?').get(user.role);
    body = await toPdf(report, {
      schoolName:  getSetting('school_name') || 'S.E.N.T.R.A.',
      generatedAt: schoolTimestamp(),
      timezone:    getSetting('school_timezone') || 'Asia/Manila',
      generatedBy: `${user.full_name} (${role ? role.display_name : user.role})`,
      filterText:  Object.entries(filters).map(([k, v]) => `${k} = ${v}`).join(', ') || 'none',
    });
  }

  auditLog({
    actorId:     user.id,
    actorName:   user.full_name,
    actorRole:   user.role,
    actionType:  'REPORT_EXPORTED',
    targetTable: report.source,
    newValues:   { report: report.slug, format, filters, rows: report.rows.length },
    ipAddress:   ctx.ip,
  });

  return {
    body,
    filename:    `${report.slug}-${schoolToday()}.${format}`,
    contentType: format === 'csv' ? 'text/csv; charset=utf-8' : 'application/pdf',
  };
}

module.exports = { ReportError, exportReport };
