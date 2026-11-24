'use strict';
const db = require('./src/repositories/db');
const checks = [
  ['roles',               'SELECT COUNT(*) AS n FROM roles'],
  ['permissions',         'SELECT COUNT(*) AS n FROM permissions'],
  ['system_settings',     'SELECT COUNT(*) AS n FROM system_settings'],
  ['incident_categories', 'SELECT COUNT(*) AS n FROM incident_categories'],
  ['users (sysadmin)',    "SELECT COUNT(*) AS n FROM users WHERE username='sysadmin'"],
  ['audit_logs (SEED)',   "SELECT COUNT(*) AS n FROM audit_logs WHERE action_type='SEED'"],
  ['role_permissions',    'SELECT COUNT(*) AS n FROM role_permissions'],
  ['password_reset_req',  "SELECT password_reset_required AS n FROM users WHERE username='sysadmin'"],
];
for (const [label, sql] of checks) {
  const row = db.prepare(sql).get();
  console.log(label.padEnd(25), row ? row.n : 'N/A');
}
