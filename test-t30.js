'use strict';

/**
 * test-t30.js — T-30 Attendance Threshold Flagging
 * Run: node test-t30.js   (exit 0 = all pass)
 *
 * tasks.md Test line:
 *   Absence threshold=2; record 2 absences → adviser notified once.
 *   Record 3rd → no second notification.
 *
 * Thresholds are changed for the test and restored afterwards. Each run uses a
 * fresh fake class and fake students.
 */

const { upsertUser, ensureStudent, createHarness } = require('./test-support');
const { schoolToday } = require('./src/utils/school-time');
const { db, check, login, call, run } = createHarness(3102);

const ADMIN    = upsertUser('t30_admin',    'sysadmin',   'T30 Admin');
const HEAD     = upsertUser('t30_head',     'schoolhead', 'T30 School Head');
const ADVISER  = upsertUser('t30_adviser',  'teacher',    'T30 Adviser');
const TEACHER  = upsertUser('t30_teacher',  'teacher',    'T30 Subject Teacher');
const GUIDANCE = upsertUser('t30_guidance', 'guidance',   'T30 Guidance');

const runId = Date.now().toString(36);
const setting = key => (db.prepare('SELECT value FROM system_settings WHERE key = ?').get(key) || {}).value;
const semester = setting('current_semester') || '1st Semester';
const classYear = (setting('current_school_year') || '2026-2027').replace('–', '-');

const classId = Number(db.prepare(`
  INSERT INTO classes (name, grade_level, section, school_year, semester, class_adviser_id, created_by)
  VALUES (?, '8', ?, ?, ?, ?, ?)
`).run(`T30 Class ${runId}`, `T30-${runId}`, classYear, semester, ADVISER.id, ADMIN.id).lastInsertRowid);
db.prepare('INSERT INTO class_teachers (class_id, user_id) VALUES (?, ?)').run(classId, TEACHER.id);
const [A, B, C] = ['Ava', 'Bo', 'Cy'].map((first, i) => {
  const id = ensureStudent(`T30-${runId}-${i + 1}`, 'Thresholdson', first);
  db.prepare('INSERT INTO student_class_assignments (student_id, class_id, school_year, semester) VALUES (?, ?, ?, ?)')
    .run(id, classId, classYear, semester);
  return id;
});
const numberOf = id => db.prepare('SELECT student_number FROM students WHERE id = ?').get(id).student_number;

const daysAgo = n => schoolToday(new Date(Date.now() - n * 86400000));
const MESSAGE = (first, id) => `Student ${first} Thresholdson, ${numberOf(id)} has reached the attendance threshold for review. `
  + 'Please review and determine if follow-up is needed.';

function adviserNotes(text) {
  return db.prepare('SELECT * FROM notifications WHERE user_id = ? AND message = ?').all(ADVISER.id, text);
}
function logRows(studentId, type) {
  return db.prepare("SELECT * FROM reminder_log WHERE kind = 'attendance_threshold' AND target_table = 'attendance_records' AND target_id = ? AND due_key = ?")
    .all(studentId, `${classId}|${semester}|${type}`);
}

run('T-30 Attendance Threshold Flagging', async () => {
  const original = { abs: setting('attendance_threshold_absences'), tar: setting('attendance_threshold_tardies') };
  const setThresholds = (abs, tar) => {
    db.prepare("UPDATE system_settings SET value = ? WHERE key = 'attendance_threshold_absences'").run(String(abs));
    db.prepare("UPDATE system_settings SET value = ? WHERE key = 'attendance_threshold_tardies'").run(String(tar));
  };
  setThresholds(2, 2);
  try {
    const teacher = await login(TEACHER);
    const head = await login(HEAD);
    const referralsBefore = db.prepare('SELECT COUNT(*) n FROM referrals').get().n;
    const guidanceBefore = db.prepare('SELECT COUNT(*) n FROM notifications WHERE user_id = ?').get(GUIDANCE.id).n;

    async function record(date, statuses) {
      const r = await call(teacher, 'POST', `/api/attendance/classes/${classId}/date/${date}`, {
        records: [[A, statuses[0]], [B, statuses[1]], [C, statuses[2]]].map(([student_id, status]) => ({ student_id, status })),
      });
      if (r.status !== 201) throw new Error(`record ${date} → ${r.status} ${JSON.stringify(r.body)}`);
    }

    // ── Test line: absence threshold = 2 ──
    await record(daysAgo(3), ['Absent', 'Present', 'Tardy']);
    check('1st absence → no notice yet', adviserNotes(MESSAGE('Ava', A)).length === 0 && logRows(A, 'absences').length === 0);

    await record(daysAgo(2), ['Absent', 'Absent', 'Tardy']);
    check('2nd absence → adviser notified once with the US-5.5 wording', adviserNotes(MESSAGE('Ava', A)).length === 1);
    check('reminder_log row: attendance_threshold, student id, "{class}|{semester}|absences"', logRows(A, 'absences').length === 1);
    const audit = db.prepare("SELECT * FROM audit_logs WHERE action_type = 'ATTENDANCE_THRESHOLD_NOTICE' AND target_id = ? ORDER BY id DESC LIMIT 1").get(A);
    check('Audit: ATTENDANCE_THRESHOLD_NOTICE', audit && audit.actor_name === 'SYSTEM'
      && JSON.parse(audit.new_values).threshold_type === 'absences' && JSON.parse(audit.new_values).count === 2);

    await record(daysAgo(1), ['Absent', 'Present', 'Present']);
    check('3rd absence → no second notification', adviserNotes(MESSAGE('Ava', A)).length === 1 && logRows(A, 'absences').length === 1);

    // ── Tardies use their own threshold and key ──
    check('Two tardies → separate tardies notice for that student', logRows(C, 'tardies').length === 1
      && db.prepare("SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND title = 'Attendance review (tardies)' AND message = ?")
        .get(ADVISER.id, MESSAGE('Cy', C)).n === 1);
    check('…and no absences notice for them', logRows(C, 'absences').length === 0);

    // ── A correction can cross the threshold ──
    check('Bo has 1 absence → not flagged yet', logRows(B, 'absences').length === 0);
    const boPresent = db.prepare("SELECT id FROM attendance_records WHERE student_id = ? AND class_id = ? AND status = 'Present' ORDER BY record_date LIMIT 1").get(B, classId);
    const r = await call(head, 'PATCH', `/api/attendance/${boPresent.id}`, { status: 'Absent', reason: 'Register checked; student was absent' });
    check('School Head correction Present → Absent → 200', r.status === 200, `${r.status} ${JSON.stringify(r.body)}`);
    check('Correction takes Bo to 2 absences → adviser notified once', adviserNotes(MESSAGE('Bo', B)).length === 1 && logRows(B, 'absences').length === 1);

    // ── Scope rules (US-5.5) ──
    check('Wording never mentions safety or welfare', !/safety|welfare|risk|danger/i.test(MESSAGE('Ava', A)));
    check('Guidance is not notified by the threshold', db.prepare('SELECT COUNT(*) n FROM notifications WHERE user_id = ?').get(GUIDANCE.id).n === guidanceBefore);
    check('No referral is created automatically', db.prepare('SELECT COUNT(*) n FROM referrals').get().n === referralsBefore);
    check('Only the adviser is notified (the recording teacher is not)',
      db.prepare("SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND message LIKE '%attendance threshold%'").get(TEACHER.id).n === 0);
  } finally {
    setThresholds(original.abs, original.tar);
    // Cleanup: deactivate the fake class, archive its records and fake students
    db.prepare('UPDATE attendance_records SET is_archived = 1 WHERE class_id = ?').run(classId);
    db.prepare('UPDATE classes SET is_active = 0 WHERE id = ?').run(classId);
    db.prepare(`UPDATE students SET status = 'Archived' WHERE id IN (${[A, B, C].join(',')})`).run();
  }
  check('Thresholds restored to their original values',
    setting('attendance_threshold_absences') === original.abs && setting('attendance_threshold_tardies') === original.tar);
});
