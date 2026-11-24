'use strict';

const db = require('./src/repositories/db');

const expectedTables = [
  'incident_ref_counters','reminder_log','system_settings','roles','permissions',
  'role_permissions','users','sessions','user_sessions','students','classes',
  'class_teachers','student_class_assignments','incident_categories','campus_locations',
  'incidents','incident_parties','attachments','incident_assignments',
  'incident_activity_log','referrals','referral_followups','attendance_records',
  'attendance_corrections','notifications','escalation_rules','audit_logs'
];

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
console.log('Tables found:', tables.length);

const missing = expectedTables.filter(t => !tables.includes(t));
if (missing.length > 0) {
  console.error('MISSING TABLES:', missing);
  process.exitCode = 1;
} else {
  console.log('All', expectedTables.length, 'expected tables present.');
}

const expectedTriggers = [
  'audit_logs_no_update','audit_logs_no_delete',
  'incident_activity_no_update','incident_activity_no_delete',
  'att_corrections_no_update','att_corrections_no_delete',
  'referral_followups_no_update','referral_followups_no_delete'
];

const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name").all().map(r => r.name);
console.log('Triggers found:', triggers.length);

const missingTriggers = expectedTriggers.filter(t => !triggers.includes(t));
if (missingTriggers.length > 0) {
  console.error('MISSING TRIGGERS:', missingTriggers);
  process.exitCode = 1;
} else {
  console.log('All 8 append-only triggers present:', triggers.join(', '));
}

db.close();
