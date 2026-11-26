'use strict';

/**
 * test-t35.js — T-35 Data Retention Review
 * Run: node test-t35.js   (exit 0 = all pass)
 *
 * tasks.md Test line:
 *   Set retention_years_incidents=0 → all incidents in review. Archive one → disappears from list.
 * Also covers test-plan.md TC-6.20 (none auto-archived) and the referral and attendance groups.
 */

const { upsertUser, ensureStudent, createHarness } = require('./test-support');
const { schoolToday } = require('./src/utils/school-time');
const { db, check, login, call, createIncident, run } = createHarness(3107);

const ADMIN   = upsertUser('t35_admin',   'sysadmin', 'T35 Admin');
const HEAD    = upsertUser('t35_head',    'schoolhead', 'T35 School Head');
const TEACHER = upsertUser('t35_teacher', 'teacher',  'T35 Teacher');

const KEYS = ['retention_years_incidents', 'retention_years_referrals', 'retention_years_attendance'];
const setting = key => (db.prepare('SELECT value FROM system_settings WHERE key = ?').get(key) || {}).value;
const original = Object.fromEntries(KEYS.map(k => [k, setting(k) || '5']));

const runId = Date.now().toString(36);
const semester = setting('current_semester') || '1st Semester';
const classYear = (setting('current_school_year') || '2026–2027').replace('–', '-');
const classId = Number(db.prepare(`
  INSERT INTO classes (name, grade_level, section, school_year, semester, class_adviser_id, created_by)
  VALUES (?, '9', ?, ?, ?, ?, ?)
`).run(`T35 Class ${runId}`, `S35-${runId}`, classYear, semester, TEACHER.id, ADMIN.id).lastInsertRowid);
const students = ['Eli', 'Fe'].map((first, i) => {
  const sid = ensureStudent(`T35-${runId}-${i + 1}`, 'Retentionson', first);
  db.prepare('INSERT INTO student_class_assignments (student_id, class_id, school_year, semester) VALUES (?, ?, ?, ?)')
    .run(sid, classId, classYear, semester);
  return sid;
});

const group = (r, type) => (r.body && r.body.groups || []).find(g => g.record_type === type) || { data: [], count: -1 };
const refs = g => g.data.map(x => x.reference);
const isArchived = id => db.prepare('SELECT is_archived FROM incidents WHERE id = ?').get(id).is_archived;

run('T-35 Data Retention Review', async () => {
  const admin = await login(ADMIN);
  const head = await login(HEAD);
  const teacher = await login(TEACHER);
  const setRetention = body => call(admin, 'PATCH', '/api/settings', body);
  const created = [];

  try {
    // ── Settings accept 0 to 100 whole years ──
    for (const bad of ['-1', '101', '2.5', 'abc', '']) {
      const r = await setRetention({ retention_years_incidents: bad });
      check(`retention_years_incidents = "${bad}" → 422`, r.status === 422, `${r.status}`);
    }
    let r = await setRetention({ retention_years_incidents: '0', retention_years_referrals: '5', retention_years_attendance: '5' });
    check('retention_years_incidents = 0 → 200', r.status === 200 && setting('retention_years_incidents') === '0', `${r.status}`);

    // ── Test line part 1: retention 0 → all incidents in review ──
    const incA = await createIncident(teacher, 'T35 A');
    const incB = await createIncident(teacher, 'T35 B');
    created.push(incA, incB);
    const [refA, refB] = [incA, incB].map(id => db.prepare('SELECT reference_number r FROM incidents WHERE id = ?').get(id).r);

    r = await call(admin, 'GET', '/api/retention/review');
    let inc = group(r, 'incident');
    const allActive = db.prepare('SELECT COUNT(*) n FROM incidents WHERE is_archived = 0').get().n;
    check('SysAdmin → 200 with incident, referral and attendance groups',
      r.status === 200 && ['incident', 'referral', 'attendance'].every(t => r.body.groups.some(g => g.record_type === t)), `${r.status}`);
    check('Test line: retention 0 → every non-archived incident is in the review (TC-6.20)',
      inc.retention_years === 0 && inc.count === allActive && inc.data.length === allActive && refs(inc).includes(refA) && refs(inc).includes(refB),
      `${inc.count} vs ${allActive}`);
    const rowA = inc.data.find(x => x.reference === refA);
    check('Row has record type group, ID/reference, creation date and age in years',
      rowA && rowA.id === incA && /^\d{4}-\d{2}-\d{2}T/.test(rowA.created_at) && rowA.age_years === 0 && rowA.category && rowA.status,
      JSON.stringify(rowA));
    check('Reviewing archives nothing (TC-6.20)',
      isArchived(incA) === 0 && db.prepare('SELECT COUNT(*) n FROM incidents WHERE is_archived = 0').get().n === allActive);

    // ── Test line part 2: archive one → disappears ──
    r = await call(admin, 'PATCH', `/api/incidents/${incA}/archive`, { confirmed: true });
    check('Archive incident A → 200', r.status === 200, `${r.status} ${JSON.stringify(r.body)}`);
    r = await call(admin, 'GET', '/api/retention/review');
    inc = group(r, 'incident');
    check('Test line: archived incident disappears from the review',
      !refs(inc).includes(refA) && refs(inc).includes(refB) && inc.count === allActive - 1, `${inc.count}`);

    // ── Default-style period: only records older than the period ──
    await setRetention({ retention_years_incidents: '5' });
    r = await call(admin, 'GET', '/api/retention/review');
    check('Retention 5 years → a new incident is not flagged', !refs(group(r, 'incident')).includes(refB));
    const sixYearsAgo = new Date(Date.now() - (6 * 365 + 10) * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    db.prepare('UPDATE incidents SET created_at = ? WHERE id = ?').run(sixYearsAgo, incB);
    r = await call(admin, 'GET', '/api/retention/review');
    const rowB = group(r, 'incident').data.find(x => x.reference === refB);
    check('Retention 5 years → a 6-year-old incident is flagged with its age', rowB && rowB.age_years === 6, JSON.stringify(rowB));

    // ── Referrals ──
    const ref = await call(teacher, 'POST', '/api/referrals', {
      student_id: students[0], referral_type: 'Guidance Referral', referral_date: schoolToday(), remarks: 'Fake T35 referral.',
    });
    if (ref.status !== 201) throw new Error(`referral → ${ref.status} ${JSON.stringify(ref.body)}`);
    r = await call(admin, 'GET', '/api/retention/review');
    check('Referral retention 5 → new referral not flagged', !refs(group(r, 'referral')).includes(`Referral #${ref.body.id}`));
    await setRetention({ retention_years_referrals: '0' });
    r = await call(admin, 'GET', '/api/retention/review');
    let refRow = group(r, 'referral').data.find(x => x.id === ref.body.id);
    check('Referral retention 0 → referral flagged with type, status, student number',
      refRow && refRow.reference === `Referral #${ref.body.id}` && refRow.referral_type === 'Guidance Referral'
        && refRow.status === 'Pending' && refRow.student_number === `T35-${runId}-1`, JSON.stringify(refRow));
    r = await call(admin, 'PATCH', `/api/referrals/${ref.body.id}/archive`, { confirmed: true });
    r = await call(admin, 'GET', '/api/retention/review');
    check('Archived referral disappears', !group(r, 'referral').data.some(x => x.id === ref.body.id));

    // ── Attendance (listed per class) ──
    const rec = await call(teacher, 'POST', `/api/attendance/classes/${classId}/date/${schoolToday()}`, {
      records: students.map(student_id => ({ student_id, status: 'Present' })),
    });
    if (rec.status !== 201) throw new Error(`attendance → ${rec.status} ${JSON.stringify(rec.body)}`);
    r = await call(admin, 'GET', '/api/retention/review');
    check('Attendance retention 5 → new records not flagged', !group(r, 'attendance').data.some(x => x.class_id === classId));
    await setRetention({ retention_years_attendance: '0' });
    r = await call(admin, 'GET', '/api/retention/review');
    const clsRow = group(r, 'attendance').data.find(x => x.class_id === classId);
    check('Attendance retention 0 → class flagged with record counts',
      clsRow && clsRow.eligible_records === 2 && clsRow.active_records === 2 && clsRow.reference.startsWith(`T35 Class ${runId}`),
      JSON.stringify(clsRow));
    r = await call(admin, 'PATCH', '/api/attendance/archive', { class_id: classId, semester });
    r = await call(admin, 'GET', '/api/retention/review');
    check('Archived class attendance disappears', !group(r, 'attendance').data.some(x => x.class_id === classId));

    // ── Access ──
    r = await call(teacher, 'GET', '/api/retention/review');
    check('Teacher → 403', r.status === 403, `${r.status}`);
    r = await call(head, 'GET', '/api/retention/review');
    check('School Head → 403 (SysAdmin only)', r.status === 403, `${r.status}`);
    r = await call(null, 'GET', '/api/retention/review');
    check('No login → 401', r.status === 401, `${r.status}`);
  } finally {
    // Restore settings; archive fake records
    await setRetention(original);
    check('Retention settings restored', KEYS.every(k => setting(k) === original[k]));
    if (created.length) db.prepare(`UPDATE incidents SET is_archived = 1 WHERE id IN (${created.join(',')})`).run();
    db.prepare('UPDATE attendance_records SET is_archived = 1 WHERE class_id = ?').run(classId);
    db.prepare('UPDATE classes SET is_active = 0 WHERE id = ?').run(classId);
    db.prepare(`UPDATE students SET status = 'Archived' WHERE id IN (${students.join(',')})`).run();
  }
});
