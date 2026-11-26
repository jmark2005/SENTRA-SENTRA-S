'use strict';

/**
 * test-t31.js — T-31 Attendance Summary and Archive
 * Run: node test-t31.js   (exit 0 = all pass)
 *
 * tasks.md Test line:
 *   Archive class semester attendance → summary returns no data. Restore → data reappears.
 */

const { upsertUser, ensureStudent, createHarness } = require('./test-support');
const { schoolToday } = require('./src/utils/school-time');
const { db, check, login, call, run } = createHarness(3103);

const ADMIN    = upsertUser('t31_admin',    'sysadmin',   'T31 Admin');
const HEAD     = upsertUser('t31_head',     'schoolhead', 'T31 School Head');
const TEACHER  = upsertUser('t31_teacher',  'teacher',    'T31 Teacher');
const TEACHER2 = upsertUser('t31_teacher2', 'teacher',    'T31 Other Teacher');
const GUIDANCE = upsertUser('t31_guidance', 'guidance',   'T31 Guidance');

const runId = Date.now().toString(36);
const setting = key => (db.prepare('SELECT value FROM system_settings WHERE key = ?').get(key) || {}).value;
const semester = setting('current_semester') || '1st Semester';
const settingYear = setting('current_school_year') || '2026–2027';
const classYear = settingYear.replace('–', '-');

function makeClass(label, adviserId, names) {
  const id = Number(db.prepare(`
    INSERT INTO classes (name, grade_level, section, school_year, semester, class_adviser_id, created_by)
    VALUES (?, '7', ?, ?, ?, ?, ?)
  `).run(`T31 ${label} ${runId}`, `S-${label}-${runId}`, classYear, semester, adviserId, ADMIN.id).lastInsertRowid);
  const students = names.map((first, i) => {
    const sid = ensureStudent(`T31-${label}-${runId}-${i + 1}`, 'Summaryson', first);
    db.prepare('INSERT INTO student_class_assignments (student_id, class_id, school_year, semester) VALUES (?, ?, ?, ?)')
      .run(sid, id, classYear, semester);
    return sid;
  });
  return { id, students, section: `S-${label}-${runId}` };
}

const one = makeClass('One', TEACHER.id, ['Ann', 'Ben', 'Cal']);
const two = makeClass('Two', TEACHER2.id, ['Dee']);
const [A, B, C] = one.students;
const daysAgo = n => schoolToday(new Date(Date.now() - n * 86400000));
const byStudent = (r, id) => (r.body.data || []).find(x => x.student_id === id);
const ids = r => (r.body.data || []).map(x => x.student_id);

run('T-31 Attendance Summary and Archive', async () => {
  const admin = await login(ADMIN);
  const head = await login(HEAD);
  const teacher = await login(TEACHER);
  const teacher2 = await login(TEACHER2);
  const guidance = await login(GUIDANCE);

  async function record(s, cls, date, statuses) {
    const r = await call(s, 'POST', `/api/attendance/classes/${cls.id}/date/${date}`, {
      records: cls.students.map((student_id, i) => ({ student_id, status: statuses[i] })),
    });
    if (r.status !== 201) throw new Error(`record → ${r.status} ${JSON.stringify(r.body)}`);
  }
  await record(teacher, one, daysAgo(3), ['Present', 'Absent', 'Tardy']);
  await record(teacher, one, daysAgo(2), ['Present', 'Absent', 'Tardy']);
  await record(teacher, one, daysAgo(1), ['Present', 'Present', 'Absent']);
  await record(teacher2, two, daysAgo(1), ['Absent']);

  // ── Summary values and role scoping ──
  let r = await call(teacher, 'GET', '/api/attendance/summary');
  check('Teacher summary → only their class\'s students', r.status === 200 && ids(r).sort().join() === [A, B, C].sort().join(),
    `${r.status} ${JSON.stringify(ids(r))}`);
  const a = byStudent(r, A), b = byStudent(r, B), c = byStudent(r, C);
  check('Ann: 3 days, 3 present, rate 100%', a.total_days === 3 && a.present === 3 && a.absent === 0 && a.attendance_rate === 100);
  check('Ben: 1 present, 2 absent, rate 33.3%', b.present === 1 && b.absent === 2 && b.tardy === 0 && b.attendance_rate === 33.3);
  check('Cal: 2 tardy, 1 absent, rate 66.7% (tardy counts as attended)', c.tardy === 2 && c.absent === 1 && c.attendance_rate === 66.7);
  r = await call(teacher, 'GET', `/api/attendance/summary?class=${two.id}`);
  check('Teacher asking for another teacher\'s class → 403', r.status === 403, `${r.status}`);
  r = await call(teacher2, 'GET', '/api/attendance/summary');
  check('Other teacher sees only their own class', r.status === 200 && ids(r).join() === String(two.students[0]));
  r = await call(guidance, 'GET', `/api/attendance/summary?class=${one.id}`);
  check('Guidance sees any class', r.status === 200 && ids(r).length === 3);
  r = await call(head, 'GET', `/api/attendance/summary?school_year=${encodeURIComponent(settingYear)}&semester=${encodeURIComponent(semester)}&section=${one.section}`);
  check('School Head: school year (en dash form), semester and section filters', r.status === 200 && ids(r).length === 3);

  // ── Filters ──
  r = await call(guidance, 'GET', `/api/attendance/summary?class=${one.id}&from=${daysAgo(2)}&to=${daysAgo(1)}`);
  check('Date range: Ann has 2 days in range', byStudent(r, A).total_days === 2);
  r = await call(guidance, 'GET', `/api/attendance/summary?class=${one.id}&status=Absent`);
  check('status=Absent → only students with absences (Ben, Cal)', ids(r).sort().join() === [B, C].sort().join());
  r = await call(guidance, 'GET', `/api/attendance/summary?class=${one.id}&status=Tardy`);
  check('status=Tardy → only Cal', ids(r).join() === String(C));
  r = await call(guidance, 'GET', `/api/attendance/summary?student=${B}`);
  check('student filter → one row', ids(r).join() === String(B));
  r = await call(guidance, 'GET', '/api/attendance/summary?status=Present');
  check('status=Present → 400', r.status === 400, `${r.status}`);
  r = await call(guidance, 'GET', `/api/attendance/summary?from=${daysAgo(1)}&to=${daysAgo(3)}`);
  check('from after to → 400', r.status === 400, `${r.status}`);
  const viewed = db.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action_type = 'ATTENDANCE_SUMMARY_VIEWED' AND actor_id = ?").get(GUIDANCE.id).n;
  check('Audit: each summary access logged', viewed >= 5, `${viewed}`);

  // ── Archive ──
  const body = { class_id: one.id, semester };
  r = await call(teacher, 'PATCH', '/api/attendance/archive', body);
  check('Teacher archive → 403', r.status === 403, `${r.status}`);
  r = await call(head, 'PATCH', '/api/attendance/archive', body);
  check('School Head archive → 403 (SysAdmin only)', r.status === 403, `${r.status}`);
  r = await call(admin, 'PATCH', '/api/attendance/archive', { semester });
  check('Archive without class_id → 400', r.status === 400, `${r.status}`);
  const otherSem = semester === '1st Semester' ? '2nd Semester' : '1st Semester';
  r = await call(admin, 'PATCH', '/api/attendance/archive', { class_id: one.id, semester: otherSem });
  check('Archive with the wrong semester → 422', r.status === 422, `${r.status}`);
  r = await call(admin, 'PATCH', '/api/attendance/archive', body);
  check('SysAdmin archives the class semester → 200, 9 records', r.status === 200 && r.body.records === 9, `${r.status} ${JSON.stringify(r.body)}`);

  // ── Test line part 1: summary returns no data ──
  for (const [name, s] of [['SysAdmin', admin], ['Guidance', guidance], ['Teacher', teacher]]) {
    r = await call(s, 'GET', `/api/attendance/summary?class=${one.id}`);
    check(`Archived → ${name} summary for the class returns no data`, r.status === 200 && r.body.data.length === 0,
      `${r.status} ${JSON.stringify(r.body)}`);
  }
  r = await call(teacher, 'GET', `/api/attendance/classes/${one.id}/date/${daysAgo(2)}`);
  check('Archived records are hidden from the day view', r.status === 200 && r.body.recorded === false);
  r = await call(teacher2, 'GET', '/api/attendance/summary');
  check('Other classes are unaffected', ids(r).length === 1);
  r = await call(admin, 'GET', `/api/attendance/summary?class=${one.id}&archived=1`);
  check('SysAdmin "archived" view shows the archived records', r.status === 200 && ids(r).length === 3);
  r = await call(head, 'GET', '/api/attendance/summary?archived=1');
  check('Archived view for School Head → 403', r.status === 403, `${r.status}`);
  r = await call(admin, 'PATCH', '/api/attendance/archive', body);
  check('Archive again → 422 (nothing left to archive)', r.status === 422, `${r.status}`);

  // ── Test line part 2: restore → data reappears ──
  r = await call(head, 'PATCH', '/api/attendance/restore', body);
  check('School Head restore → 403', r.status === 403, `${r.status}`);
  r = await call(admin, 'PATCH', '/api/attendance/restore', body);
  check('SysAdmin restore → 200, 9 records', r.status === 200 && r.body.records === 9, `${r.status}`);
  r = await call(teacher, 'GET', `/api/attendance/summary?class=${one.id}`);
  check('Restore → data reappears with the same counts',
    ids(r).length === 3 && byStudent(r, B).absent === 2 && byStudent(r, C).attendance_rate === 66.7);
  r = await call(admin, 'PATCH', '/api/attendance/restore', body);
  check('Restore again → 422', r.status === 422, `${r.status}`);
  for (const t of ['ATTENDANCE_ARCHIVED', 'ATTENDANCE_RESTORED']) {
    const row = db.prepare('SELECT new_values FROM audit_logs WHERE action_type = ? AND target_id = ? ORDER BY id DESC LIMIT 1').get(t, one.id);
    check(`Audit: ${t} with class, semester, and count`, row && JSON.parse(row.new_values).records === 9);
  }

  // Cleanup: archive fake records, deactivate fake classes, archive fake students
  for (const cls of [one, two]) {
    db.prepare('UPDATE attendance_records SET is_archived = 1 WHERE class_id = ?').run(cls.id);
    db.prepare('UPDATE classes SET is_active = 0 WHERE id = ?').run(cls.id);
    db.prepare(`UPDATE students SET status = 'Archived' WHERE id IN (${cls.students.join(',')})`).run();
  }
});
