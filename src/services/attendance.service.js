'use strict';

/**
 * Attendance recording and correction (T-29).
 * Requirements: requirements.md US-5.1 and US-5.2.
 *
 * - Teachers record for classes they teach or advise; SchHead and SysAdmin
 *   for any class. Guidance can view but not record (no record_attendance).
 * - Submitting a day only adds missing records. Changing a recorded status is
 *   a correction: it needs a reason and is written to attendance_corrections.
 * - Teachers may correct only on the record's own date (school timezone);
 *   SchHead and SysAdmin may correct at any time.
 */

const db                     = require('../repositories/db');
const repo                   = require('../repositories/attendance.repository');
const { log: auditLog }      = require('./audit.service');
const { getUserPermissions } = require('./permission.service');
const { getSetting }         = require('./settings.service');
const { schoolToday, isIsoDate } = require('../utils/school-time');
const { checkThresholds }        = require('./attendance-threshold.service');

const STATUSES = ['Present', 'Absent', 'Tardy'];
const MSG_WINDOW = 'Edit window closed: teachers can only correct attendance on the same day it was recorded for. '
  + 'Ask the School Head or System Administrator to make this correction.';

class AttendanceError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function hasPermission(user, code) { return getUserPermissions(user.id).has(code); }
function seesAllClasses(user) { return ['sysadmin', 'schoolhead', 'guidance'].includes(user.role); }
function isAdminCorrector(user) {
  return (user.role === 'sysadmin' || user.role === 'schoolhead') && hasPermission(user, 'record_attendance');
}

function canViewClass(user, cls) {
  if (seesAllClasses(user)) return true;
  return user.role === 'teacher' && repo.isClassTeacher(cls.id, user.id);
}

function canRecordClass(user, cls) {
  if (!hasPermission(user, 'record_attendance')) return false;
  if (user.role === 'sysadmin' || user.role === 'schoolhead') return true;
  return user.role === 'teacher' && repo.isClassTeacher(cls.id, user.id);
}

function loadClass(user, classId) {
  const cls = repo.findClass(classId);
  if (!cls) throw new AttendanceError(404, 'Class not found.');
  if (!canViewClass(user, cls)) throw new AttendanceError(403, 'Forbidden.');
  return cls;
}

function checkDate(date) {
  if (!isIsoDate(date)) throw new AttendanceError(400, 'Date must be a real date (YYYY-MM-DD).');
  if (date > schoolToday()) throw new AttendanceError(422, 'Attendance cannot be recorded for a future date.');
}

// ── GET classes ──────────────────────────────────────────────────────────────
/**
 * Defaults to active classes in the current school year and semester.
 * all=1 drops the year/semester filter; include_inactive=1 adds inactive classes
 * (used by the summary view, where past semesters matter).
 */
function listClasses(user, query) {
  const all = query.all === '1';
  const schoolYear = all ? null : (query.school_year || getSetting('current_school_year'));
  const semester = all ? null : (query.semester || getSetting('current_semester'));
  return {
    school_year: schoolYear,
    semester,
    data: repo.listClasses({
      userId:          user.id,
      teacherOnly:     !seesAllClasses(user),
      schoolYear,
      semester,
      includeInactive: query.include_inactive === '1',
    }),
  };
}

// ── GET one class and date ───────────────────────────────────────────────────
/** Roster merged with any records for the date. Correction reasons: SysAdmin/SchHead only (US-5.2). */
function getDay(user, classId, date) {
  const cls = loadClass(user, classId);
  checkDate(date);

  const records = repo.recordsFor(cls.id, date);
  const byStudent = new Map(records.map(r => [r.student_id, r]));
  const showReasons = user.role === 'sysadmin' || user.role === 'schoolhead';
  const corrections = showReasons ? repo.correctionsFor(records.map(r => r.id)) : [];

  const rows = repo.roster(cls.id).map(s => ({ student: s, record: byStudent.get(s.id) || null }));
  // Records for students no longer on the roster are still shown
  for (const r of records) {
    if (!rows.some(x => x.student.id === r.student_id)) {
      rows.push({ student: { id: r.student_id, student_number: r.student_number, last_name: r.last_name, first_name: r.first_name }, record: r });
    }
  }

  return {
    class: { id: cls.id, name: cls.name, grade_level: cls.grade_level, section: cls.section,
             school_year: cls.school_year, semester: cls.semester, is_active: cls.is_active },
    date,
    today: schoolToday(),
    recorded: records.length > 0,
    can_record: canRecordClass(user, cls) && !!cls.is_active,
    can_correct: isAdminCorrector(user) || (canRecordClass(user, cls) && date === schoolToday()),
    students: rows.map(({ student, record }) => ({
      student_id:       student.id,
      student_number:   student.student_number,
      name:             `${student.last_name}, ${student.first_name}`,
      attendance_id:    record ? record.id : null,
      status:           record ? record.status : null,
      recorded_by_name: record ? record.recorded_by_name : null,
      correction_count: record ? record.correction_count : 0,
      ...(showReasons && record ? { corrections: corrections.filter(c => c.attendance_id === record.id) } : {}),
    })),
  };
}

// ── POST one class and date ──────────────────────────────────────────────────
function submitDay(ctx, classId, date, body) {
  const cls = repo.findClass(classId);
  if (!cls) throw new AttendanceError(404, 'Class not found.');
  if (!canRecordClass(ctx.user, cls)) {
    throw new AttendanceError(403, 'You can only record attendance for classes you are assigned to.');
  }
  if (!cls.is_active) throw new AttendanceError(422, 'This class is inactive.');
  checkDate(date);

  const list = body.records;
  if (!Array.isArray(list) || !list.length) {
    throw new AttendanceError(400, 'records must be a non-empty list of { student_id, status }.');
  }
  const onRoster = new Set(repo.roster(cls.id).map(s => s.id));
  const seen = new Set();
  const bad = [];
  for (const item of list) {
    const sid = Number(item && item.student_id);
    if (!STATUSES.includes(item && item.status)) {
      throw new AttendanceError(400, `Each status must be one of: ${STATUSES.join(', ')}.`);
    }
    if (seen.has(sid)) throw new AttendanceError(400, `Student ${sid} appears more than once.`);
    seen.add(sid);
    if (!onRoster.has(sid)) bad.push(sid);
  }
  if (bad.length) {
    throw new AttendanceError(422, `These students are not on this class roster: ${bad.join(', ')}.`);
  }

  const saved = [];
  const skipped = [];
  db.transaction(() => {
    for (const item of list) {
      const sid = Number(item.student_id);
      const added = repo.insertRecord({
        student_id: sid, class_id: cls.id, record_date: date, status: item.status, recorded_by: ctx.user.id,
      });
      (added ? saved : skipped).push(sid);
    }
  })();

  if (!saved.length) {
    throw new AttendanceError(409, 'Attendance for this date is already recorded. Use Correct to change a record.');
  }

  const counts = { Present: 0, Absent: 0, Tardy: 0 };
  list.filter(i => saved.includes(Number(i.student_id))).forEach(i => { counts[i.status] += 1; });
  auditLog({
    actorId:     ctx.user.id,
    actorName:   ctx.user.full_name,
    actorRole:   ctx.user.role,
    actionType:  'ATTENDANCE_SUBMITTED',
    targetTable: 'classes',
    targetId:    cls.id,
    newValues:   { class_name: cls.name, record_date: date, saved: saved.length, skipped: skipped.length, counts },
    ipAddress:   ctx.ip,
  });

  // T-30: flag students who reached an absence or tardy threshold
  checkThresholds(cls, saved);
  return { saved: saved.length, skipped };
}

// ── PATCH one record (correction) ────────────────────────────────────────────
function correct(ctx, id, body) {
  const record = repo.findRecord(id);
  if (!record) throw new AttendanceError(404, 'Attendance record not found.');
  if (record.is_archived) throw new AttendanceError(422, 'This attendance record is archived.');
  const cls = repo.findClass(record.class_id);

  const withinWindow = record.record_date === schoolToday();
  if (!isAdminCorrector(ctx.user)) {
    if (!canRecordClass(ctx.user, cls)) {
      throw new AttendanceError(403, 'You do not have permission to correct this record.');
    }
    if (!withinWindow) throw new AttendanceError(403, MSG_WINDOW);
  }

  const status = body.status;
  if (!STATUSES.includes(status)) throw new AttendanceError(400, `status must be one of: ${STATUSES.join(', ')}.`);
  if (status === record.status) throw new AttendanceError(422, `The status is already ${status}.`);
  const reason = String(body.reason === undefined || body.reason === null ? '' : body.reason).trim();
  if (!reason) throw new AttendanceError(422, 'A reason is required for every correction.');
  if (reason.length > 500) throw new AttendanceError(400, 'The reason must be 500 characters or fewer.');

  db.transaction(() => {
    if (!repo.setStatus(record.id, record.status, status)) {
      throw new AttendanceError(409, 'This record was changed by someone else. Reload and try again.');
    }
    repo.insertCorrection({
      attendance_id: record.id, corrected_by: ctx.user.id,
      old_status: record.status, new_status: status, reason,
    });
  })();

  // US-5.2: actor, old and new status, reason, timestamp, student number, class, date
  auditLog({
    actorId:     ctx.user.id,
    actorName:   ctx.user.full_name,
    actorRole:   ctx.user.role,
    actionType:  'ATTENDANCE_CORRECTED',
    targetTable: 'attendance_records',
    targetId:    record.id,
    oldValues:   { status: record.status },
    newValues:   {
      status, reason,
      student_number: record.student_number,
      class_id: record.class_id, class_name: record.class_name,
      record_date: record.record_date,
      within_edit_window: withinWindow,
    },
    ipAddress:   ctx.ip,
  });

  // T-30: a correction can push a student over a threshold too
  checkThresholds(cls, [record.student_id]);

  const updated = repo.findRecord(record.id);
  return {
    id: updated.id, student_id: updated.student_id, class_id: updated.class_id,
    record_date: updated.record_date, status: updated.status, updated_at: updated.updated_at,
  };
}

// ── T-31: summary ────────────────────────────────────────────────────────────
const SEMESTERS = ['1st Semester', '2nd Semester'];

function optionalId(value, name) {
  if (value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new AttendanceError(400, `${name} must be an ID.`);
  return n;
}

function optionalDate(value, name) {
  if (value === undefined || value === '') return null;
  if (!isIsoDate(String(value))) throw new AttendanceError(400, `${name} must be a real date (YYYY-MM-DD).`);
  return String(value);
}

/**
 * Per-student attendance counts (US-5.4). Teachers: their classes only;
 * Guidance, SchHead, SysAdmin: all. archived=1 (SysAdmin only) shows archived records.
 * attendance_rate = (present + tardy) / total recorded days.
 * Checks and scopes the query but writes no audit entry (summary() and the
 * attendance report export each log their own).
 * @returns {{ filters: object, data: object[] }}
 */
function summaryRows(user, query) {
  const archived = query.archived === '1';
  if (archived && user.role !== 'sysadmin') throw new AttendanceError(403, 'Only the System Administrator can view archived attendance.');

  const f = {
    archived,
    studentId:  optionalId(query.student, 'student'),
    classId:    optionalId(query.class, 'class'),
    section:    query.section ? String(query.section) : null,
    semester:   query.semester ? String(query.semester) : null,
    schoolYear: query.school_year ? String(query.school_year) : null,
    from:       optionalDate(query.from, 'from'),
    to:         optionalDate(query.to, 'to'),
    status:     query.status || null,
    classIds:   null,
  };
  if (f.semester && !SEMESTERS.includes(f.semester)) throw new AttendanceError(400, `semester must be one of: ${SEMESTERS.join(', ')}.`);
  if (f.status && !['Absent', 'Tardy'].includes(f.status)) throw new AttendanceError(400, 'status must be Absent or Tardy.');
  if (f.from && f.to && f.from > f.to) throw new AttendanceError(400, 'from must be on or before to.');

  if (!seesAllClasses(user)) {
    f.classIds = repo.teacherClassIds(user.id);
    if (f.classId && !f.classIds.includes(f.classId)) {
      throw new AttendanceError(403, 'You can only view attendance for classes you are assigned to.');
    }
  }

  const data = repo.summary(f).map(r => ({
    ...r,
    attendance_rate: r.total_days ? Math.round(((r.present + r.tardy) / r.total_days) * 1000) / 10 : null,
  }));

  const filters = { student: f.studentId, class: f.classId, section: f.section, semester: f.semester,
                    school_year: f.schoolYear, from: f.from, to: f.to, status: f.status, archived };
  return { filters, data };
}

function summary(ctx, query) {
  const user = ctx.user;
  const { filters, data } = summaryRows(user, query);

  auditLog({
    actorId:     user.id,
    actorName:   user.full_name,
    actorRole:   user.role,
    actionType:  'ATTENDANCE_SUMMARY_VIEWED',
    targetTable: 'attendance_records',
    newValues:   { filters, rows: data.length },
    ipAddress:   ctx.ip,
  });

  return { data };
}

// ── T-31: archive and restore by class and semester (SysAdmin) ──────────────
function archiveOrRestore(ctx, body, archive) {
  if (ctx.user.role !== 'sysadmin') {
    throw new AttendanceError(403, 'Only the System Administrator can archive or restore attendance.');
  }
  const classId = optionalId(body.class_id, 'class_id');
  if (!classId) throw new AttendanceError(400, 'class_id is required.');
  if (!body.semester) throw new AttendanceError(400, 'semester is required.');
  const cls = repo.findClass(classId);
  if (!cls) throw new AttendanceError(404, 'Class not found.');
  if (cls.semester !== body.semester) {
    throw new AttendanceError(422, `${cls.name} is a ${cls.semester} class, not ${body.semester}.`);
  }

  const changed = repo.setClassArchived(classId, archive ? 1 : 0);
  if (!changed) {
    throw new AttendanceError(422, archive
      ? 'There are no active attendance records to archive for this class.'
      : 'There are no archived attendance records to restore for this class.');
  }

  auditLog({
    actorId:     ctx.user.id,
    actorName:   ctx.user.full_name,
    actorRole:   ctx.user.role,
    actionType:  archive ? 'ATTENDANCE_ARCHIVED' : 'ATTENDANCE_RESTORED',
    targetTable: 'classes',
    targetId:    classId,
    newValues:   { class_name: cls.name, semester: cls.semester, school_year: cls.school_year, records: changed },
    ipAddress:   ctx.ip,
  });
  return { class_id: classId, semester: cls.semester, records: changed, is_archived: archive };
}

module.exports = {
  AttendanceError, STATUSES, listClasses, getDay, submitDay, correct, summary, summaryRows,
  archive: (ctx, body) => archiveOrRestore(ctx, body, true),
  restore: (ctx, body) => archiveOrRestore(ctx, body, false),
};
