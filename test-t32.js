'use strict';

/**
 * test-t32.js — T-32 Emergency Alert (API part)
 * Run: node test-t32.js   (exit 0 = all pass)
 *
 * tasks.md Test line:
 *   Send alert → all recipient-role users see banner within 30s; excluded role
 *   does not. Audit log entry exists.
 *
 * The banner reads emergency_alerts from GET /api/notifications/count, which the
 * dashboard polls every 30 s; this test checks that data. The banner itself is
 * checked in the browser. The recipient-roles setting is changed to exclude
 * Guidance for the test and restored afterwards.
 */

const { upsertUser, createHarness } = require('./test-support');
const { db, check, login, call, run } = createHarness(3104);

const ADMIN    = upsertUser('t32_admin',    'sysadmin',      'T32 Admin');
const HEAD     = upsertUser('t32_head',     'schoolhead',    'T32 School Head');
const TEACHER  = upsertUser('t32_teacher',  'teacher',       'T32 Teacher');
const SAFETY   = upsertUser('t32_safety',   'safetyofficer', 'T32 Safety Officer');
const GUIDANCE = upsertUser('t32_guidance', 'guidance',      'T32 Guidance');
const INACTIVE = upsertUser('t32_inactive', 'teacher',       'T32 Inactive Teacher');
db.prepare("UPDATE users SET status = 'Inactive' WHERE id = ?").run(INACTIVE.id);

const KEY = 'emergency_alert_recipient_roles';
const getRoles = () => db.prepare('SELECT value FROM system_settings WHERE key = ?').get(KEY).value;
const MESSAGE = `Drill ${Date.now().toString(36)}: shelter in place in classrooms until the all-clear (fake test).`;

run('T-32 Emergency Alert', async () => {
  const original = getRoles();
  db.prepare('UPDATE system_settings SET value = ? WHERE key = ?').run('sysadmin,schoolhead,teacher,safetyofficer', KEY);
  try {
    const admin = await login(ADMIN);
    const head = await login(HEAD);
    const teacher = await login(TEACHER);
    const safety = await login(SAFETY);
    const guidance = await login(GUIDANCE);

    let r = await call(teacher, 'POST', '/api/notifications/emergency', { message: MESSAGE });
    check('Teacher (no send_emergency_alert) → 403', r.status === 403, `${r.status}`);
    r = await call(admin, 'POST', '/api/notifications/emergency', { message: '   ' });
    check('Empty message → 400', r.status === 400, `${r.status}`);
    r = await call(admin, 'POST', '/api/notifications/emergency', { message: 'x'.repeat(501) });
    check('Message over 500 chars → 400', r.status === 400, `${r.status}`);

    // ── Send ──
    const expected = db.prepare(`SELECT COUNT(*) n FROM users u JOIN roles ro ON ro.id = u.role_id
      WHERE u.status = 'Active' AND ro.name IN ('sysadmin','schoolhead','teacher','safetyofficer')`).get().n;
    r = await call(admin, 'POST', '/api/notifications/emergency', { message: MESSAGE });
    check('SysAdmin sends → 201 with recipient count = active users in recipient roles',
      r.status === 201 && r.body.recipients === expected && !r.body.roles.includes('guidance'),
      `${r.status} ${JSON.stringify(r.body)} expected ${expected}`);

    for (const [name, s] of [['Teacher', teacher], ['Safety Officer', safety], ['School Head', head], ['SysAdmin (sender)', admin]]) {
      r = await call(s, 'GET', '/api/notifications/count');
      const alert = (r.body.emergency_alerts || []).find(a => a.message === MESSAGE);
      check(`${name}: unread Emergency Alert in the poll data the banner uses`,
        r.status === 200 && alert && alert.title === 'Emergency Alert from T32 Admin');
    }
    r = await call(guidance, 'GET', '/api/notifications/count');
    check('Guidance (excluded role): no alert in the poll data',
      !(r.body.emergency_alerts || []).some(a => a.message === MESSAGE));
    check('Guidance (excluded role): no notification row at all',
      db.prepare('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND message = ?').get(GUIDANCE.id, MESSAGE).n === 0);
    check('Inactive account not notified',
      db.prepare('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND message = ?').get(INACTIVE.id, MESSAGE).n === 0);
    check('Rows are type "Emergency Alert"',
      db.prepare("SELECT COUNT(*) n FROM notifications WHERE message = ? AND type = 'Emergency Alert'").get(MESSAGE).n === expected);

    const audit = db.prepare("SELECT * FROM audit_logs WHERE action_type = 'EMERGENCY_ALERT_SENT' AND actor_id = ? ORDER BY id DESC LIMIT 1").get(ADMIN.id);
    const v = audit && JSON.parse(audit.new_values);
    check('Audit log entry exists with message, roles, and count',
      v && v.message === MESSAGE && v.recipient_count === expected && v.recipient_roles.join() === 'sysadmin,schoolhead,teacher,safetyofficer');

    // ── Acknowledge clears the banner data for that user only ──
    r = await call(teacher, 'GET', '/api/notifications/count');
    const id = r.body.emergency_alerts.find(a => a.message === MESSAGE).id;
    r = await call(teacher, 'PATCH', `/api/notifications/${id}/read`, {});
    r = await call(teacher, 'GET', '/api/notifications/count');
    check('Teacher acknowledges → alert leaves their poll data', !(r.body.emergency_alerts || []).some(a => a.id === id));
    r = await call(safety, 'GET', '/api/notifications/count');
    check('…still shown to others', (r.body.emergency_alerts || []).some(a => a.message === MESSAGE));

    // School Head also holds send_emergency_alert
    r = await call(head, 'POST', '/api/notifications/emergency', { message: `${MESSAGE} (follow-up)` });
    check('School Head can send → 201', r.status === 201, `${r.status}`);

    // The drawer endpoint returns { data } (dashboard-common.js reads .data)
    r = await call(safety, 'GET', '/api/notifications');
    check('GET /api/notifications returns { data: [...] } including the alert',
      Array.isArray(r.body.data) && r.body.data.some(n => n.type === 'Emergency Alert' && n.message === MESSAGE));
  } finally {
    db.prepare('UPDATE system_settings SET value = ? WHERE key = ?').run(original, KEY);
    // The fake drill went to every account in the recipient roles (including real
    // ones in this dev DB); mark it read so no one is left with a test banner.
    db.prepare("UPDATE notifications SET is_read = 1 WHERE type = 'Emergency Alert' AND message LIKE ?").run(`${MESSAGE}%`);
  }
  check('Recipient roles setting restored', getRoles() === original);
});
