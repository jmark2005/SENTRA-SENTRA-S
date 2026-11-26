'use strict';

/**
 * Attendance threshold flagging (T-30, requirements.md US-5.5).
 *
 * Called after attendance is saved or corrected. For each affected student it
 * counts Absent and Tardy records (not archived) in that class and compares
 * them with system_settings attendance_threshold_absences / _tardies. When a
 * count reaches its threshold, the class adviser gets one notification;
 * reminder_log (kind attendance_threshold, target attendance_records /
 * student id, due_key "{class_id}|{semester}|{absences|tardies}") makes it
 * once only. The notification, log row and audit entry share a transaction.
 *
 * Deliberately limited: no welfare wording, Guidance is not notified, and no
 * referral is ever created automatically — the adviser decides.
 */

const db                = require('../repositories/db');
const notificationSvc   = require('./notification.service');
const { log: auditLog } = require('./audit.service');
const { getSetting }    = require('./settings.service');

const TYPES = [
  { key: 'absences', status: 'Absent', setting: 'attendance_threshold_absences', label: 'absences' },
  { key: 'tardies',  status: 'Tardy',  setting: 'attendance_threshold_tardies',  label: 'tardies' },
];

function threshold(settingKey) {
  const n = parseInt(getSetting(settingKey), 10);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

function countFor(studentId, classId, status) {
  return db.prepare(`
    SELECT COUNT(*) AS n FROM attendance_records
    WHERE  student_id = ? AND class_id = ? AND status = ? AND is_archived = 0
  `).get(studentId, classId, status).n;
}

function activeAdviser(cls) {
  if (!cls.class_adviser_id) return null;
  return db.prepare("SELECT id FROM users WHERE id = ? AND status = 'Active'").get(cls.class_adviser_id) || null;
}

const flagOnce = db.transaction((notice) => {
  const logged = db.prepare(`
    INSERT OR IGNORE INTO reminder_log (kind, target_table, target_id, due_key)
    VALUES ('attendance_threshold', 'attendance_records', ?, ?)
  `).run(notice.studentId, notice.dueKey).changes;
  if (!logged) return false;

  notificationSvc.create({
    userId:  notice.adviserId,
    type:    'System Notice',
    title:   `Attendance review (${notice.label})`,
    // Exact wording from US-5.5; it must not suggest a safety or welfare issue.
    message: `Student ${notice.studentName}, ${notice.studentNumber} has reached the attendance threshold for review. `
      + 'Please review and determine if follow-up is needed.',
    link:    null,
  });

  auditLog({
    actorId:     null,
    actorName:   'SYSTEM',
    actorRole:   'system',
    actionType:  'ATTENDANCE_THRESHOLD_NOTICE',
    targetTable: 'students',
    targetId:    notice.studentId,
    newValues:   {
      class_id: notice.classId, semester: notice.semester, threshold_type: notice.label,
      count: notice.count, threshold: notice.threshold, adviser_id: notice.adviserId,
    },
  });
  return true;
});

/**
 * Checks the given students in one class and flags any that reached a threshold.
 * @param {object} cls        classes row (id, semester, class_adviser_id)
 * @param {number[]} studentIds
 * @returns {object[]} notices sent
 */
function checkThresholds(cls, studentIds) {
  const adviser = activeAdviser(cls);
  if (!adviser) return []; // nobody to notify; checked again on the next save

  const sent = [];
  for (const studentId of [...new Set(studentIds)]) {
    const student = db.prepare('SELECT id, student_number, first_name, last_name FROM students WHERE id = ?').get(studentId);
    if (!student) continue;
    for (const type of TYPES) {
      const limit = threshold(type.setting);
      if (!limit) continue;
      const count = countFor(studentId, cls.id, type.status);
      if (count < limit) continue;
      const notice = {
        studentId,
        studentName:   `${student.first_name} ${student.last_name}`,
        studentNumber: student.student_number,
        classId:       cls.id,
        semester:      cls.semester,
        label:         type.label,
        dueKey:        `${cls.id}|${cls.semester}|${type.key}`,
        adviserId:     adviser.id,
        count,
        threshold:     limit,
      };
      if (flagOnce(notice)) sent.push({ student_id: studentId, type: type.key, count, threshold: limit });
    }
  }
  return sent;
}

module.exports = { checkThresholds };
