'use strict';

/**
 * test-t29.js — T-29 Attendance Recording and Submission
 * Run: node test-t29.js   (exit 0 = all pass)
 *
 * tasks.md Test line:
 *   Submit attendance → all records saved. Correct same day → allowed with reason.
 *   Next day: Teacher → 403 "edit window closed". SysAdmin → allowed.
 *
 * "Next day" is tested with a record dated yesterday: the edit window is the
 * record's own date in the school timezone. Each run uses a fresh fake class
 * and fake students, because attendance is unique per student, class and day.
 */

const { upsertUser, ensureStudent, createHarness } = require('./test-support');
const { schoolToday } = require('./src/utils/school-time');
const { db, check, login, call, run } = createHarness(3101);

const ADMIN    = upsertUser('t29_admin',    'sysadmin',   'T29 Admin');
const HEAD     = upsertUser('t29_head',     'schoolhead', 'T29 School Head');
const TEACHER  = upsertUser('t29_teacher',  'teacher',    'T29 Teacher');
const TEACHER2 = upsertUser('t29_teacher2', 'teacher',    'T29 Other Teacher');
const GUIDANCE = upsertUser('t29_guidance', 'guidance',   'T29 Guidance');

const runId = Date.now().toString(36);
const year = (db.prepare("SELECT value FROM system_settings WHERE key = 'current_school_year'").get() || {}).value || '2026-2027';
const semester = (db.prepare("SELECT value FROM system_settings WHERE key = 'current_semester'").get() || {}).value || '1st Semester';
// Stored with a hyphen, like the classes created through the UI (settings use an en dash)
const classYear = year.replace('–', '-');

const classId = Number(db.prepare(`
  INSERT INTO classes (name, grade_level, section, school_year, semester, class_adviser_id, created_by)
  VALUES (?, '10', ?, ?, ?, ?, ?)
`).run(`T29 Class ${runId}`, `T29-${runId}`, classYear, semester, TEACHER.id, ADMIN.id).lastInsertRowid);
db.prepare('INSERT INTO class_teachers (class_id, user_id) VALUES (?, ?)').run(classId, TEACHER.id);
const students = [1, 2, 3].map(n => {
  const id = ensureStudent(`T29-${runId}-${n}`, 'Testrun', `Student ${n}`);
  db.prepare('INSERT INTO student_class_assignments (student_id, class_id, school_year, semester) VALUES (?, ?, ?, ?)')
    .run(id, classId, classYear, semester);
  return id;
});
const outsider = ensureStudent(`T29-${runId}-X`, 'Testrun', 'Not Enrolled');

const today = schoolToday();
const yesterday = schoolToday(new Date(Date.now() - 86400000));
const tomorrow = schoolToday(new Date(Date.now() + 86400000));
const dayUrl = d => `/api/attendance/classes/${classId}/date/${d}`;
const sheet = statuses => ({ records: students.map((sid, i) => ({ student_id: sid, status: statuses[i] })) });

function rows(date) {
  return db.prepare('SELECT * FROM attendance_records WHERE class_id = ? AND record_date = ? ORDER BY student_id').all(classId, date);
}

run('T-29 Attendance Recording and Submission', async () => {
  const admin = await login(ADMIN);
  const head = await login(HEAD);
  const teacher = await login(TEACHER);
  const teacher2 = await login(TEACHER2);
  const guidance = await login(GUIDANCE);

  // ── Class lists ──
  let r = await call(teacher, 'GET', '/api/attendance/classes');
  check('Teacher class list includes their class (current year and semester)',
    r.status === 200 && r.body.data.some(c => c.id === classId && c.student_count === 3), `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  r = await call(teacher2, 'GET', '/api/attendance/classes');
  check('Unassigned teacher does not get the class', r.status === 200 && !r.body.data.some(c => c.id === classId));
  r = await call(guidance, 'GET', '/api/attendance/classes');
  check('Guidance sees all classes', r.status === 200 && r.body.data.some(c => c.id === classId));

  r = await call(teacher, 'GET', dayUrl(today));
  check('Day view: roster of 3 with no records yet', r.status === 200 && r.body.students.length === 3
    && r.body.recorded === false && r.body.can_record === true && r.body.students.every(s => s.status === null));
  r = await call(teacher2, 'GET', dayUrl(today));
  check('Unassigned teacher day view → 403', r.status === 403, `${r.status}`);

  // ── Who may record ──
  r = await call(teacher2, 'POST', dayUrl(today), sheet(['Present', 'Present', 'Present']));
  check('Unassigned teacher submit → 403', r.status === 403, `${r.status}`);
  r = await call(guidance, 'POST', dayUrl(today), sheet(['Present', 'Present', 'Present']));
  check('Guidance submit → 403 (no record_attendance)', r.status === 403, `${r.status}`);

  // ── Validation ──
  r = await call(teacher, 'POST', dayUrl(tomorrow), sheet(['Present', 'Present', 'Present']));
  check('Future date → 422', r.status === 422, `${r.status}`);
  r = await call(teacher, 'POST', dayUrl('2026-02-30'), sheet(['Present', 'Present', 'Present']));
  check('Impossible date → 400', r.status === 400, `${r.status}`);
  r = await call(teacher, 'POST', dayUrl(today), { records: [] });
  check('Empty records → 400', r.status === 400, `${r.status}`);
  r = await call(teacher, 'POST', dayUrl(today), sheet(['Present', 'Sleeping', 'Present']));
  check('Unknown status → 400', r.status === 400, `${r.status}`);
  r = await call(teacher, 'POST', dayUrl(today), { records: [{ student_id: outsider, status: 'Present' }] });
  check('Student not on the roster → 422', r.status === 422, `${r.status}`);
  r = await call(teacher, 'POST', dayUrl(today), { records: [{ student_id: students[0], status: 'Present' }, { student_id: students[0], status: 'Absent' }] });
  check('Same student twice → 400', r.status === 400, `${r.status}`);
  check('Refused submissions saved nothing', rows(today).length === 0);

  // ── Test line 1: submit → all records saved ──
  r = await call(teacher, 'POST', dayUrl(today), sheet(['Present', 'Absent', 'Tardy']));
  const saved = rows(today);
  check('Submit attendance → 201 and all 3 records saved',
    r.status === 201 && r.body.saved === 3 && saved.length === 3
      && saved.map(x => x.status).join() === 'Present,Absent,Tardy' && saved.every(x => x.recorded_by === TEACHER.id),
    `${r.status} ${JSON.stringify(r.body)}`);
  const subAudit = db.prepare("SELECT * FROM audit_logs WHERE action_type = 'ATTENDANCE_SUBMITTED' AND target_id = ? ORDER BY id DESC LIMIT 1").get(classId);
  check('Audit: ATTENDANCE_SUBMITTED with counts', subAudit && JSON.parse(subAudit.new_values).counts.Absent === 1);
  r = await call(teacher, 'POST', dayUrl(today), sheet(['Absent', 'Absent', 'Absent']));
  check('Submitting the same day again → 409 (use Correct), records unchanged',
    r.status === 409 && rows(today).map(x => x.status).join() === 'Present,Absent,Tardy', `${r.status}`);
  r = await call(teacher, 'GET', dayUrl(today));
  check('Day view now shows the saved statuses', r.body.recorded === true && r.body.students.every(s => s.attendance_id && s.status));

  // ── Test line 2: correct same day → allowed with reason ──
  const absentRec = saved.find(x => x.status === 'Absent');
  r = await call(teacher, 'PATCH', `/api/attendance/${absentRec.id}`, { status: 'Present' });
  check('Correction without a reason → 422', r.status === 422 && /reason is required/i.test(r.body.error), JSON.stringify(r.body));
  r = await call(teacher, 'PATCH', `/api/attendance/${absentRec.id}`, { status: 'Absent', reason: 'x' });
  check('Correction to the same status → 422', r.status === 422, `${r.status}`);
  r = await call(teacher, 'PATCH', `/api/attendance/${absentRec.id}`,
    { status: 'Present', reason: 'Clerical error — student was present' });
  check('Teacher corrects same day with reason → 200, status updated', r.status === 200 && r.body.status === 'Present',
    `${r.status} ${JSON.stringify(r.body)}`);
  const corr = db.prepare('SELECT * FROM attendance_corrections WHERE attendance_id = ?').all(absentRec.id);
  check('Correction row stores old and new status and the reason',
    corr.length === 1 && corr[0].old_status === 'Absent' && corr[0].new_status === 'Present'
      && corr[0].reason === 'Clerical error — student was present' && corr[0].corrected_by === TEACHER.id);
  const cAudit = db.prepare("SELECT * FROM audit_logs WHERE action_type = 'ATTENDANCE_CORRECTED' AND target_id = ? ORDER BY id DESC LIMIT 1").get(absentRec.id);
  const cv = cAudit && JSON.parse(cAudit.new_values);
  check('Audit: actor, old/new status, reason, student number, class, and date',
    cAudit && cAudit.actor_name === 'T29 Teacher' && JSON.parse(cAudit.old_values).status === 'Absent'
      && cv.status === 'Present' && cv.reason && cv.student_number && cv.class_id === classId && cv.record_date === today);

  // ── Test line 3: next day — Teacher 403, SysAdmin allowed ──
  r = await call(teacher, 'POST', dayUrl(yesterday), sheet(['Present', 'Present', 'Absent']));
  check('Teacher can record a past date (late entry) → 201', r.status === 201, `${r.status}`);
  const oldRec = rows(yesterday).find(x => x.status === 'Absent');
  r = await call(teacher, 'PATCH', `/api/attendance/${oldRec.id}`, { status: 'Present', reason: 'Was present' });
  check('Next day: Teacher correction → 403 "edit window closed"',
    r.status === 403 && /edit window closed/i.test(r.body.error), `${r.status} ${JSON.stringify(r.body)}`);
  r = await call(guidance, 'PATCH', `/api/attendance/${oldRec.id}`, { status: 'Present', reason: 'Was present' });
  check('Guidance correction → 403', r.status === 403, `${r.status}`);
  r = await call(admin, 'PATCH', `/api/attendance/${oldRec.id}`, { status: 'Tardy', reason: 'Arrived late; marked absent by mistake' });
  check('Next day: SysAdmin correction → 200', r.status === 200 && r.body.status === 'Tardy', `${r.status}`);
  r = await call(head, 'PATCH', `/api/attendance/${oldRec.id}`, { status: 'Present', reason: 'Late slip excused by School Head' });
  check('Next day: School Head correction → 200', r.status === 200 && r.body.status === 'Present', `${r.status}`);
  const wAudit = db.prepare("SELECT new_values FROM audit_logs WHERE action_type = 'ATTENDANCE_CORRECTED' AND target_id = ? ORDER BY id DESC LIMIT 1").get(oldRec.id);
  check('Audit marks the correction as outside the edit window', JSON.parse(wAudit.new_values).within_edit_window === false);

  // ── Who sees correction reasons (US-5.2) ──
  r = await call(head, 'GET', dayUrl(yesterday));
  const headRow = r.body.students.find(s => s.attendance_id === oldRec.id);
  check('School Head day view shows corrections with reasons', headRow.corrections.length === 2
    && headRow.corrections[0].reason === 'Arrived late; marked absent by mistake');
  r = await call(teacher, 'GET', dayUrl(yesterday));
  const teacherRow = r.body.students.find(s => s.attendance_id === oldRec.id);
  check('Teacher day view shows the count but not the reasons', teacherRow.correction_count === 2 && !('corrections' in teacherRow));
  check('Teacher cannot correct yesterday (can_correct false)', r.body.can_correct === false);

  let threw = false;
  try { db.prepare('UPDATE attendance_corrections SET reason = ? WHERE attendance_id = ?').run('edited', absentRec.id); }
  catch (e) { threw = /append-only/.test(e.message); }
  check('Editing attendance_corrections in the DB → RAISE(ABORT) trigger', threw);

  // Cleanup: deactivate the fake class, archive its records and fake students
  db.prepare('UPDATE attendance_records SET is_archived = 1 WHERE class_id = ?').run(classId);
  db.prepare('UPDATE classes SET is_active = 0 WHERE id = ?').run(classId);
  db.prepare(`UPDATE students SET status = 'Archived' WHERE id IN (${[...students, outsider].join(',')})`).run();
});
