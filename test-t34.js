'use strict';

/**
 * test-t34.js — T-34 Reports and CSV/PDF Export
 * Run: node test-t34.js   (exit 0 = all pass)
 *
 * tasks.md Test line:
 *   Export incidents CSV → columns match spec. Export PDF → valid PDF.
 *   Teacher exports all incidents → 403. Audit log shows export entry.
 * Also covers test-plan.md TC-6.11–6.15 and TC-R.1–R.10.
 */

const zlib = require('zlib');
const { upsertUser, ensureStudent, createHarness } = require('./test-support');
const { schoolToday } = require('./src/utils/school-time');
const { SCHOOLHEAD_EXCLUDED_ACTIONS } = require('./src/services/audit.service');

const PORT = 3106;
const { db, check, login, call, createIncident, run } = createHarness(PORT);

const ADMIN    = upsertUser('t34_admin',    'sysadmin',      'T34 Admin');
const HEAD     = upsertUser('t34_head',     'schoolhead',    'T34 School Head');
const TEACHER  = upsertUser('t34_teacher',  'teacher',       'T34 Teacher');
const TEACHER2 = upsertUser('t34_teacher2', 'teacher',       'T34 Other Teacher');
const GUIDANCE = upsertUser('t34_guidance', 'guidance',      'T34 Guidance');
const SAFETY   = upsertUser('t34_safety',   'safetyofficer', 'T34 Safety Officer');

const runId = Date.now().toString(36);
const setting = key => (db.prepare('SELECT value FROM system_settings WHERE key = ?').get(key) || {}).value;
const semester = setting('current_semester') || '1st Semester';
const classYear = (setting('current_school_year') || '2026–2027').replace('–', '-');
const daysAgo = n => schoolToday(new Date(Date.now() - n * 86400000));
const incidentDate = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10); // as createIncident()

function makeClass(label, adviserId, names) {
  const section = `S34-${label}-${runId}`;
  const name = `T34 ${label} ${runId}`;
  const id = Number(db.prepare(`
    INSERT INTO classes (name, grade_level, section, school_year, semester, class_adviser_id, created_by)
    VALUES (?, '8', ?, ?, ?, ?, ?)
  `).run(name, section, classYear, semester, adviserId, ADMIN.id).lastInsertRowid);
  const students = names.map((first, i) => {
    const sid = ensureStudent(`T34-${label}-${runId}-${i + 1}`, 'Reportson', first);
    db.prepare('INSERT INTO student_class_assignments (student_id, class_id, school_year, semester) VALUES (?, ?, ?, ?)')
      .run(sid, id, classYear, semester);
    return sid;
  });
  return { id, name, students };
}

const one = makeClass('One', TEACHER.id, ['Ana', 'Bo']);
const two = makeClass('Two', TEACHER2.id, ['Cy']);
const REF_STUDENT_NO = `T34-R-${runId}`;
const REF_STUDENT = ensureStudent(REF_STUDENT_NO, 'Referralson', 'Dia');

// ── Raw download helpers ─────────────────────────────────────────────────────
async function get(session, path) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { headers: session ? { cookie: session.cookie } : {} });
  const buf = Buffer.from(await res.arrayBuffer());
  return {
    status: res.status, buf, text: buf.toString('utf8'),
    type: res.headers.get('content-type') || '',
    disposition: res.headers.get('content-disposition') || '',
  };
}

function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** Visible text of a pdfkit PDF: inflate each stream, join the hex strings of each TJ. */
function pdfVisibleText(buf) {
  const s = buf.toString('latin1');
  let out = '';
  let at = 0;
  while ((at = s.indexOf('stream', at)) !== -1) {
    if (s.slice(at - 3, at) === 'end') { at += 6; continue; }
    let start = at + 6;
    if (s[start] === '\r') start++;
    if (s[start] === '\n') start++;
    const end = s.indexOf('endstream', start);
    let data;
    try { data = zlib.inflateSync(buf.subarray(start, end), { finishFlush: zlib.constants.Z_SYNC_FLUSH }); }
    catch (_) { data = buf.subarray(start, end); }
    for (const tj of data.toString('latin1').matchAll(/\[([^\]]*)\]\s*TJ/g)) {
      out += [...tj[1].matchAll(/<([0-9a-fA-F]*)>/g)].map(h => Buffer.from(h[1], 'hex').toString('latin1')).join('') + '\n';
    }
    at = end + 9;
  }
  return out;
}

const refOf = id => db.prepare('SELECT reference_number AS r FROM incidents WHERE id = ?').get(id).r;
const latestExport = actorId => {
  const row = db.prepare("SELECT * FROM audit_logs WHERE action_type = 'REPORT_EXPORTED' AND actor_id = ? ORDER BY id DESC LIMIT 1").get(actorId);
  return row ? { ...row, values: JSON.parse(row.new_values) } : null;
};

run('T-34 Reports and CSV/PDF Export', async () => {
  const admin = await login(ADMIN);
  const head = await login(HEAD);
  const teacher = await login(TEACHER);
  const teacher2 = await login(TEACHER2);
  const guidance = await login(GUIDANCE);
  const safety = await login(SAFETY);

  // ── Setup: A resolved (with one action), B submitted, R restricted, G guidance's own ──
  const incA = await createIncident(teacher, 'T34 A');
  await call(head, 'PATCH', `/api/incidents/${incA}/classify`, { severity: 'Moderate' });
  await call(head, 'POST', `/api/incidents/${incA}/assign`, { user_ids: [SAFETY.id] });
  await call(safety, 'POST', `/api/incidents/${incA}/acknowledge`);
  await call(safety, 'POST', `/api/incidents/${incA}/actions`, { description: 'Checked the corridor (fake).' });
  const res = await call(safety, 'PATCH', `/api/incidents/${incA}/status`,
    { status: 'Resolved', resolution_summary: '=1+1 handled by safety officer (fake).' });
  if (res.status !== 200) throw new Error(`setup resolve → ${res.status} ${JSON.stringify(res.body)}`);
  const incB = await createIncident(teacher, 'T34 B');
  const incR = await createIncident(guidance, 'T34 R restricted');
  await call(head, 'PATCH', `/api/incidents/${incR}/restrict`, { is_restricted: true });
  const incG = await createIncident(guidance, 'T34 G');
  const [refA, refB, refR, refG] = [incA, incB, incR, incG].map(refOf);
  const range = `from=${incidentDate}&to=${incidentDate}`;

  // ── Test line 1: incidents CSV columns match spec ──
  let r = await get(admin, `/api/reports/incidents?${range}&format=csv`);
  let rows = parseCsv(r.text);
  check('Admin incidents CSV → 200 text/csv download',
    r.status === 200 && r.type.startsWith('text/csv') && /attachment; filename="incident-summary-\d{4}-\d{2}-\d{2}\.csv"/.test(r.disposition),
    `${r.status} ${r.type} ${r.disposition}`);
  check('CSV columns match spec (TC-6.11)',
    rows[0].join('|') === 'Reference Number|Category|Date|Severity|Status|Reporter|Assigned Personnel', rows[0].join('|'));
  const expected = db.prepare('SELECT COUNT(*) n FROM incidents WHERE is_archived = 0 AND incident_date = ?').get(incidentDate).n;
  check('Row count matches the filtered incident count (TC-R.1)', rows.length - 1 === expected, `${rows.length - 1} vs ${expected}`);
  const rowA = rows.find(x => x[0] === refA);
  check('Incident A row: date, severity, status, reporter, assigned personnel',
    rowA && rowA[2] === incidentDate && rowA[3] === 'Moderate' && rowA[4] === 'Resolved'
      && rowA[5] === 'T34 Teacher' && rowA[6].includes('T34 Safety Officer'), JSON.stringify(rowA));
  check('Restricted incident present in SysAdmin export (TC-R.10)', rows.some(x => x[0] === refR));

  const exp = latestExport(ADMIN.id);
  check('Test line: audit log shows export entry with report, format, filters, rows (TC-6.15)',
    exp && exp.values.report === 'incident-summary' && exp.values.format === 'csv'
      && exp.values.filters.from === incidentDate && exp.values.filters.to === incidentDate
      && exp.values.rows === expected && exp.actor_name === 'T34 Admin' && !!exp.created_at, JSON.stringify(exp));

  r = await get(admin, `/api/reports/incidents?${range}&status=Resolved`);
  rows = parseCsv(r.text).slice(1);
  check('Status filter, CSV is the default format', r.status === 200 && r.type.startsWith('text/csv')
    && rows.length >= 1 && rows.every(x => x[4] === 'Resolved') && rows.some(x => x[0] === refA) && !rows.some(x => x[0] === refB));

  // ── Test line 2: PDF is valid ──
  r = await get(admin, `/api/reports/incidents?${range}&format=pdf`);
  const pdfText = pdfVisibleText(r.buf);
  const schoolName = setting('school_name');
  check('Admin incidents PDF → 200 application/pdf download',
    r.status === 200 && r.type === 'application/pdf' && /filename="incident-summary-.*\.pdf"/.test(r.disposition), `${r.status} ${r.type}`);
  check('Valid PDF (header and %%EOF trailer)',
    r.buf.subarray(0, 5).toString() === '%PDF-' && r.buf.toString('latin1').trimEnd().endsWith('%%EOF'));
  check('PDF shows school name from settings, title and rows (TC-6.12, TC-R.2)',
    pdfText.includes(schoolName) && pdfText.includes('Incident Summary') && pdfText.includes(refA)
      && pdfText.includes(`from = ${incidentDate}`), pdfText.slice(0, 300));
  check('PDF export logged too', latestExport(ADMIN.id).values.format === 'pdf');

  // ── Test line 3: Teacher → 403 on incidents (and response, audit log) ──
  const auditMark = db.prepare('SELECT MAX(id) AS m FROM audit_logs').get().m;
  r = await get(teacher, '/api/reports/incidents?format=csv');
  check('Test line: Teacher exports all incidents → 403 (TC-6.14a)', r.status === 403, `${r.status} ${r.text}`);
  r = await get(teacher, `/api/reports/incidents?${range}&format=pdf`);
  check('Teacher incidents with filters → still 403', r.status === 403);
  r = await get(teacher, '/api/reports/response');
  check('Teacher response summary → 403', r.status === 403);
  r = await get(teacher, '/api/reports/audit-log');
  check('Teacher audit log export → 403', r.status === 403);
  check('Denied exports are not logged', !db.prepare(
    "SELECT 1 FROM audit_logs WHERE action_type = 'REPORT_EXPORTED' AND actor_id = ? AND id > ?").get(TEACHER.id, auditMark));

  // ── Role scoping of incident exports ──
  r = await get(guidance, `/api/reports/incidents?${range}`);
  rows = parseCsv(r.text).slice(1);
  check('Guidance export: own incident yes, restricted no — even as reporter (TC-R.10)',
    r.status === 200 && rows.some(x => x[0] === refG) && !rows.some(x => x[0] === refR) && !rows.some(x => x[0] === refA));
  r = await get(safety, `/api/reports/incidents?${range}`);
  rows = parseCsv(r.text).slice(1);
  check('Safety Officer export: non-restricted yes, restricted no',
    r.status === 200 && rows.some(x => x[0] === refA) && rows.some(x => x[0] === refB) && !rows.some(x => x[0] === refR));

  // ── Response summary ──
  r = await get(head, `/api/reports/response?${range}`);
  rows = parseCsv(r.text);
  check('Response summary columns include Resolution Summary (TC-6.13)',
    rows[0].join('|') === 'Reference Number|Status|Resolution Summary|Action Count|Last Action Date|Resolution Date|Closed By', rows[0].join('|'));
  const respA = rows.find(x => x[0] === refA);
  const respB = rows.find(x => x[0] === refB);
  check('Resolved incident: summary, 1 action, action and resolution dates',
    respA && respA[2].endsWith('handled by safety officer (fake).') && respA[3] === '1'
      && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(respA[4]) && /^\d{4}-\d{2}-\d{2} /.test(respA[5]), JSON.stringify(respA));
  check('Formula-looking text is neutralised in CSV', respA && respA[2].startsWith("'=1+1"), respA && respA[2]);
  check('Unresolved incident: empty resolution summary (TC-R.3)', respB && respB[2] === '' && respB[5] === '', JSON.stringify(respB));
  check('School Head sees restricted incident in response summary', rows.some(x => x[0] === refR));

  // ── Attendance summary ──
  async function record(s, cls, date, statuses) {
    const x = await call(s, 'POST', `/api/attendance/classes/${cls.id}/date/${date}`, {
      records: cls.students.map((student_id, i) => ({ student_id, status: statuses[i] })),
    });
    if (x.status !== 201) throw new Error(`record → ${x.status} ${JSON.stringify(x.body)}`);
  }
  await record(teacher, one, daysAgo(2), ['Present', 'Absent']);
  await record(teacher, one, daysAgo(1), ['Tardy', 'Absent']);
  await record(teacher2, two, daysAgo(1), ['Absent']);

  r = await get(teacher, '/api/reports/attendance');
  rows = parseCsv(r.text);
  check('Attendance CSV columns',
    rows[0].join('|') === 'Student Number|Student Name|Class|Section|Semester|School Year|Absent|Tardy|Present|Total Days|Attendance %', rows[0].join('|'));
  check('Teacher attendance export → own class only (TC-6.14b)',
    r.status === 200 && rows.length - 1 === 2 && rows.slice(1).every(x => x[2] === one.name) && !r.text.includes(two.name),
    `${r.status} ${rows.length - 1}`);
  r = await get(teacher, `/api/reports/attendance?class=${two.id}`);
  check('Teacher asks for another teacher\'s class → 403', r.status === 403, `${r.status}`);
  r = await get(safety, '/api/reports/attendance');
  check('Safety Officer attendance export → 403', r.status === 403, `${r.status}`);

  r = await get(admin, `/api/reports/attendance?class=${one.id}&format=csv`);
  rows = parseCsv(r.text).slice(1);
  const raw = db.prepare(`
    SELECT s.student_number AS no, SUM(a.status='Absent') AS ab, SUM(a.status='Tardy') AS ta, SUM(a.status='Present') AS pr
    FROM attendance_records a JOIN students s ON s.id = a.student_id
    WHERE a.class_id = ? AND a.is_archived = 0 GROUP BY a.student_id`).all(one.id);
  check('Attendance counts match raw attendance_records (TC-R.4)',
    rows.length === raw.length && raw.every(x => rows.some(y => y[0] === x.no
      && Number(y[6]) === x.ab && Number(y[7]) === x.ta && Number(y[8]) === x.pr)), JSON.stringify(rows));
  const ana = rows.find(x => x[0] === `T34-One-${runId}-1`);
  check('Attendance % = (present + tardy) / days', ana && ana[10] === '100' && ana[9] === '2', JSON.stringify(ana));
  r = await get(head, `/api/reports/attendance?class=${one.id}&format=pdf`);
  check('Attendance PDF', r.status === 200 && r.buf.subarray(0, 5).toString() === '%PDF-'
    && pdfVisibleText(r.buf).includes('Attendance Summary'));

  // ── Referral summary ──
  const ref = await call(teacher, 'POST', '/api/referrals', {
    student_id: REF_STUDENT, referral_type: 'Academic Assistance', referral_date: schoolToday(),
    remarks: 'Needs help catching up (fake).',
  });
  if (ref.status !== 201) throw new Error(`referral → ${ref.status} ${JSON.stringify(ref.body)}`);

  r = await get(teacher, '/api/reports/referrals?format=csv');
  rows = parseCsv(r.text);
  check('Teacher referral export → counts only (TC-6.14c)',
    r.status === 200 && rows[0].join('|') === 'Referral Type|Status|Count'
      && rows.some(x => x[0] === 'Academic Assistance' && x[1] === 'Pending' && Number(x[2]) >= 1), r.text);
  check('No student names or numbers in Teacher referral export (TC-R.5)',
    !r.text.includes(REF_STUDENT_NO) && !r.text.includes('Referralson') && !r.text.includes('catching up'));
  r = await get(admin, `/api/reports/referrals?type=${encodeURIComponent('Academic Assistance')}&status=Pending`);
  rows = parseCsv(r.text);
  check('SysAdmin referral export includes student numbers (TC-R.6)',
    r.status === 200 && rows[0].join('|') === 'Referral Type|Status|Count|Student Numbers'
      && rows.length === 2 && rows[1][3].split('; ').includes(REF_STUDENT_NO) && !r.text.includes('Referralson'), r.text);
  r = await get(safety, '/api/reports/referrals');
  check('Safety Officer referral export → 403', r.status === 403, `${r.status}`);

  // ── Audit log ──
  const totalBefore = db.prepare('SELECT COUNT(*) n FROM audit_logs').get().n;
  r = await get(admin, '/api/reports/audit-log');
  rows = parseCsv(r.text);
  check('Audit log CSV columns',
    rows[0].join('|') === 'Timestamp|Actor|Role|Action Type|Target|Old Values|New Values', rows[0].join('|'));
  check('SysAdmin audit export has every entry (TC-R.7)', rows.length - 1 === totalBefore, `${rows.length - 1} vs ${totalBefore}`);
  check('Audit export includes the earlier export entries', rows.some(x => x[3] === 'REPORT_EXPORTED' && x[1] === 'T34 Admin'));
  check('SysAdmin export includes account/permission entries', rows.some(x => SCHOOLHEAD_EXCLUDED_ACTIONS.includes(x[3])));
  r = await get(head, '/api/reports/audit-log?format=csv');
  rows = parseCsv(r.text).slice(1);
  check('School Head audit export: authorized subset only (TC-R.8)',
    r.status === 200 && rows.length > 0 && !rows.some(x => SCHOOLHEAD_EXCLUDED_ACTIONS.includes(x[3]))
      && rows.some(x => x[3] === 'REPORT_EXPORTED'));
  r = await get(admin, `/api/reports/audit-log?action_type=REPORT_EXPORTED&from=${schoolToday()}&format=pdf`);
  check('Audit log PDF', r.status === 200 && pdfVisibleText(r.buf).includes('REPORT_EXPORTED'));
  r = await get(guidance, '/api/reports/audit-log');
  check('Guidance audit export → 403', r.status === 403);

  // ── Input checks ──
  r = await get(admin, '/api/reports/incidents?format=xls');
  check('format=xls → 400', r.status === 400, `${r.status}`);
  r = await get(admin, '/api/reports/incidents?from=2026-02-30');
  check('Bad date → 400', r.status === 400);
  r = await get(admin, '/api/reports/referrals?from=2026-05-02&to=2026-05-01');
  check('from after to → 400', r.status === 400);
  r = await get(admin, '/api/reports/incidents?status=Bogus');
  check('Unknown status → 400', r.status === 400);
  r = await get(admin, '/api/reports/incidents?category=999999');
  check('Unknown category → 400', r.status === 400);
  r = await get(null, '/api/reports/incidents');
  check('No login → 401', r.status === 401);

  // Cleanup: archive fake incidents, referral, attendance; deactivate classes; archive students
  db.prepare(`UPDATE incidents SET is_archived = 1 WHERE id IN (${[incA, incB, incR, incG].join(',')})`).run();
  db.prepare('UPDATE referrals SET is_archived = 1 WHERE id = ?').run(ref.body.id);
  for (const cls of [one, two]) {
    db.prepare('UPDATE attendance_records SET is_archived = 1 WHERE class_id = ?').run(cls.id);
    db.prepare('UPDATE classes SET is_active = 0 WHERE id = ?').run(cls.id);
    db.prepare(`UPDATE students SET status = 'Archived' WHERE id IN (${cls.students.join(',')})`).run();
  }
  db.prepare("UPDATE students SET status = 'Archived' WHERE id = ?").run(REF_STUDENT);
});
