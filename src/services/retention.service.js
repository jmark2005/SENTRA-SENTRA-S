'use strict';

/**
 * Data retention review (T-35, requirements.md US-6.10).
 *
 * Lists records that have reached the retention period set in System Settings
 * (retention_years_incidents, retention_years_referrals,
 * retention_years_attendance): created_at on or before now minus years × 365
 * days. Archived records are left out, since they have already been dealt with.
 *
 * Read-only. Nothing is archived or deleted here; the System Administrator
 * archives each record with its own Archive action.
 *
 * Attendance is listed per class rather than per record, because attendance is
 * archived a whole class at a time (PATCH /api/attendance/archive).
 */

const db             = require('../repositories/db');
const { getSetting } = require('./settings.service');

const YEAR_MS = 365 * 86400000;
const DEFAULT_YEARS = 5;

function retentionYears(key) {
  const value = getSetting(key);
  return /^\d{1,3}$/.test(String(value)) ? Number(value) : DEFAULT_YEARS;
}

/** Cutoff in the same format as created_at ("YYYY-MM-DDTHH:MM:SSZ"). */
function cutoffFor(years, now) {
  return new Date(now - years * YEAR_MS).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Whole and tenths of a year since `iso`, rounded down. */
function ageYears(iso, now) {
  return Math.max(0, Math.floor(((now - Date.parse(iso)) / YEAR_MS) * 10) / 10);
}

function incidents(cutoff, now) {
  return db.prepare(`
    SELECT i.id, i.reference_number AS reference, c.name AS category, i.status, i.is_restricted, i.created_at
    FROM   incidents i JOIN incident_categories c ON c.id = i.category_id
    WHERE  i.is_archived = 0 AND i.created_at <= ?
    ORDER  BY i.created_at, i.id
  `).all(cutoff).map(r => ({ ...r, age_years: ageYears(r.created_at, now) }));
}

function referrals(cutoff, now) {
  return db.prepare(`
    SELECT r.id, r.referral_type, r.status, s.student_number, r.created_at
    FROM   referrals r JOIN students s ON s.id = r.student_id
    WHERE  r.is_archived = 0 AND r.created_at <= ?
    ORDER  BY r.created_at, r.id
  `).all(cutoff).map(r => ({ ...r, reference: `Referral #${r.id}`, age_years: ageYears(r.created_at, now) }));
}

function attendanceClasses(cutoff, now) {
  return db.prepare(`
    SELECT c.id AS class_id, c.name AS class_name, c.section, c.semester, c.school_year,
           COUNT(*)          AS eligible_records,
           (SELECT COUNT(*) FROM attendance_records x WHERE x.class_id = c.id AND x.is_archived = 0) AS active_records,
           MIN(a.created_at) AS created_at
    FROM   attendance_records a JOIN classes c ON c.id = a.class_id
    WHERE  a.is_archived = 0 AND a.created_at <= ?
    GROUP  BY c.id
    ORDER  BY MIN(a.created_at), c.id
  `).all(cutoff).map(r => ({
    ...r,
    reference: `${r.class_name} (${r.semester}, ${r.school_year})`,
    age_years: ageYears(r.created_at, now),
  }));
}

/**
 * @returns {{ generated_at: string, groups: Array<{ record_type, label, retention_years, cutoff, count, data }> }}
 * Attendance rows are classes; `created_at` there is the oldest eligible record's.
 */
function review(now = Date.now()) {
  const groups = [
    { record_type: 'incident',   label: 'Incidents',  key: 'retention_years_incidents',  list: incidents },
    { record_type: 'referral',   label: 'Referrals',  key: 'retention_years_referrals',  list: referrals },
    { record_type: 'attendance', label: 'Attendance', key: 'retention_years_attendance', list: attendanceClasses },
  ].map(g => {
    const years  = retentionYears(g.key);
    const cutoff = cutoffFor(years, now);
    const data   = g.list(cutoff, now);
    return { record_type: g.record_type, label: g.label, retention_years: years, cutoff, count: data.length, data };
  });
  return { generated_at: new Date(now).toISOString(), groups };
}

module.exports = { review };
