'use strict';

/**
 * SENTRA seed script
 *
 * Inserts:
 *  - 6 roles
 *  - 27 permissions
 *  - all role_permissions
 *  - 15 system_settings defaults
 *  - 6 default incident_categories
 *  - 1 SysAdmin user (password_reset_required = 1, temp password printed once)
 *  - 1 audit_logs SEED row
 *
 * Idempotent: every INSERT uses INSERT OR IGNORE so running twice is safe.
 */

const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

// Bootstrap config so DB_PATH resolves correctly
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

// Reuse the same db singleton (runs migrations if needed)
const db = require('../../src/repositories/db');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a cryptographically random password of at least 12 characters
 * containing uppercase, lowercase, digits, and symbols.
 */
function generateTempPassword() {
  const upper   = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lower   = 'abcdefghijklmnopqrstuvwxyz';
  const digits  = '0123456789';
  const symbols = '!@#$%^&*()-_=+[]{}|;:,.<>?';
  const all     = upper + lower + digits + symbols;

  // Guarantee at least one character from each required class
  const pick = (chars) => chars[crypto.randomInt(chars.length)];

  let password = pick(upper) + pick(lower) + pick(digits) + pick(symbols);

  // Fill remaining characters randomly (total length = 16)
  while (password.length < 16) {
    password += pick(all);
  }

  // Shuffle to avoid predictable positions
  return password
    .split('')
    .sort(() => crypto.randomInt(3) - 1)
    .join('');
}

// ---------------------------------------------------------------------------
// Data definitions
// ---------------------------------------------------------------------------

const ROLES = [
  { name: 'sysadmin',     display_name: 'System Administrator' },
  { name: 'schoolhead',   display_name: 'School Head' },
  { name: 'teacher',      display_name: 'Teacher' },
  { name: 'guidance',     display_name: 'Guidance Counselor' },
  { name: 'safetyofficer',display_name: 'Safety Officer' },
  { name: 'student',      display_name: 'Student' },
];

const PERMISSIONS = [
  { code: 'manage_accounts',           description: 'Manage user accounts',                    module: 'accounts'   },
  { code: 'manage_roles_permissions',  description: 'Manage roles and permissions',             module: 'accounts'   },
  { code: 'manage_settings',           description: 'Manage system settings',                   module: 'settings'   },
  { code: 'view_audit_log',            description: 'View audit log',                           module: 'audit'      },
  { code: 'manage_students',           description: 'Manage student records',                   module: 'students'   },
  { code: 'view_students',             description: 'View student records',                     module: 'students'   },
  { code: 'manage_classes',            description: 'Manage classes',                           module: 'classes'    },
  { code: 'view_classes',              description: 'View classes',                             module: 'classes'    },
  { code: 'submit_incident',           description: 'Submit incident reports',                  module: 'incidents'  },
  { code: 'view_incidents',            description: 'View incident list',                       module: 'incidents'  },
  { code: 'manage_incidents',          description: 'Manage/classify/restrict incidents',       module: 'incidents'  },
  { code: 'assign_incidents',          description: 'Assign incidents to personnel',            module: 'incidents'  },
  { code: 'respond_incidents',         description: 'Acknowledge/act on incidents',             module: 'incidents'  },
  { code: 'archive_incidents',         description: 'Archive/restore incidents',                module: 'incidents'  },
  { code: 'manage_attachments',        description: 'Upload/download attachments',              module: 'incidents'  },
  { code: 'submit_referral',           description: 'Submit referrals',                         module: 'referrals'  },
  { code: 'manage_referrals',          description: 'Assign/complete referrals',                module: 'referrals'  },
  { code: 'view_referrals',            description: 'View referrals',                           module: 'referrals'  },
  { code: 'record_attendance',         description: 'Record/correct attendance',                module: 'attendance' },
  { code: 'view_attendance',           description: 'View attendance records',                  module: 'attendance' },
  { code: 'view_reports',              description: 'View dashboard and reports',               module: 'reports'    },
  { code: 'manage_incident_categories',description: 'Manage incident categories',              module: 'incidents'  },
  { code: 'manage_campus_locations',   description: 'Manage campus locations',                  module: 'campus'     },
  { code: 'send_emergency_alert',      description: 'Send emergency alerts',                    module: 'alerts'     },
  { code: 'manage_escalation_rules',   description: 'Manage escalation rules',                  module: 'escalation' },
  { code: 'view_participation',        description: 'View personnel participation',             module: 'personnel'  },
  { code: 'view_trends',               description: 'View trend analysis',                      module: 'reports'    },
];

// Map: permission_code → array of role names that have it
const ROLE_PERMISSIONS = {
  manage_accounts:            ['sysadmin'],
  manage_roles_permissions:   ['sysadmin'],
  manage_settings:            ['sysadmin'],
  view_audit_log:             ['sysadmin', 'schoolhead'],
  manage_students:            ['sysadmin', 'schoolhead', 'teacher', 'guidance'],
  view_students:              ['sysadmin', 'schoolhead', 'teacher', 'guidance', 'safetyofficer'],
  manage_classes:             ['sysadmin', 'schoolhead'],
  view_classes:               ['sysadmin', 'schoolhead', 'teacher'],
  submit_incident:            ['sysadmin', 'schoolhead', 'teacher', 'guidance', 'safetyofficer', 'student'],
  view_incidents:             ['sysadmin', 'schoolhead', 'teacher', 'guidance', 'safetyofficer'],
  manage_incidents:           ['sysadmin', 'schoolhead', 'safetyofficer'],
  assign_incidents:           ['sysadmin', 'schoolhead'],
  respond_incidents:          ['sysadmin', 'schoolhead', 'teacher', 'guidance', 'safetyofficer'],
  archive_incidents:          ['sysadmin'],
  manage_attachments:         ['sysadmin', 'schoolhead', 'teacher', 'guidance', 'safetyofficer'],
  submit_referral:            ['sysadmin', 'schoolhead', 'teacher', 'guidance'],
  manage_referrals:           ['sysadmin', 'schoolhead', 'guidance'],
  view_referrals:             ['sysadmin', 'schoolhead', 'teacher', 'guidance'],
  record_attendance:          ['sysadmin', 'schoolhead', 'teacher'],
  view_attendance:            ['sysadmin', 'schoolhead', 'teacher', 'guidance'],
  view_reports:               ['sysadmin', 'schoolhead', 'teacher', 'guidance', 'safetyofficer'],
  manage_incident_categories: ['sysadmin'],
  manage_campus_locations:    ['sysadmin'],
  send_emergency_alert:       ['sysadmin', 'schoolhead'],
  manage_escalation_rules:    ['sysadmin', 'schoolhead'],
  view_participation:         ['sysadmin', 'schoolhead'],
  view_trends:                ['sysadmin', 'schoolhead'],
};

const SYSTEM_SETTINGS = [
  { key: 'school_name',                       value: '[YOUR SCHOOL NAME]' },
  { key: 'current_school_year',               value: '2026\u20132027' },
  { key: 'current_semester',                  value: '1st Semester' },
  { key: 'session_idle_minutes',              value: '30' },
  { key: 'session_max_hours',                 value: '8' },
  { key: 'student_feature_enabled',           value: '0' },
  { key: 'attendance_threshold_absences',     value: '3' },
  { key: 'attendance_threshold_tardies',      value: '5' },
  { key: 'school_timezone',                   value: 'Asia/Manila' },
  { key: 'escalation_job_interval_minutes',   value: '15' },
  { key: 'reminders_job_interval_minutes',    value: '60' },
  { key: 'retention_years_incidents',         value: '5' },
  { key: 'retention_years_referrals',         value: '5' },
  { key: 'retention_years_attendance',        value: '5' },
  { key: 'emergency_alert_recipient_roles',   value: 'sysadmin,schoolhead,teacher,guidance,safetyofficer' },
];

const INCIDENT_CATEGORIES = [
  'Bullying/Harassment Concern',
  'Physical Altercation',
  'Accident',
  'Property Damage',
  'Security Concern',
  'Facility Hazard',
];

// ---------------------------------------------------------------------------
// Prepared statements
// ---------------------------------------------------------------------------

const insertRole = db.prepare(`
  INSERT OR IGNORE INTO roles (name, display_name) VALUES (?, ?)
`);

const insertPermission = db.prepare(`
  INSERT OR IGNORE INTO permissions (code, description, module) VALUES (?, ?, ?)
`);

const insertRolePermission = db.prepare(`
  INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
  VALUES (
    (SELECT id FROM roles       WHERE name = ?),
    (SELECT id FROM permissions WHERE code = ?)
  )
`);

const insertSystemSetting = db.prepare(`
  INSERT OR IGNORE INTO system_settings (key, value) VALUES (?, ?)
`);

const insertIncidentCategory = db.prepare(`
  INSERT OR IGNORE INTO incident_categories (name) VALUES (?)
`);

const insertUser = db.prepare(`
  INSERT OR IGNORE INTO users
    (username, email, password_hash, full_name, role_id, status, password_reset_required)
  VALUES (
    ?,
    ?,
    ?,
    ?,
    (SELECT id FROM roles WHERE name = 'sysadmin'),
    'Active',
    1
  )
`);

const insertAuditLog = db.prepare(`
  INSERT INTO audit_logs
    (actor_id, actor_name, actor_role, action_type, target_table, new_values)
  VALUES (NULL, 'SYSTEM', 'system', 'SEED', NULL, ?)
`);

const countAuditSeed = db.prepare(`
  SELECT COUNT(*) AS cnt FROM audit_logs WHERE action_type = 'SEED' AND actor_name = 'SYSTEM'
`);

// ---------------------------------------------------------------------------
// Run seed inside a single transaction
// ---------------------------------------------------------------------------

const seed = db.transaction(() => {
  // 1. Roles
  for (const role of ROLES) {
    insertRole.run(role.name, role.display_name);
  }

  // 2. Permissions
  for (const perm of PERMISSIONS) {
    insertPermission.run(perm.code, perm.description, perm.module);
  }

  // 3. Role–permission assignments
  for (const [code, roleNames] of Object.entries(ROLE_PERMISSIONS)) {
    for (const roleName of roleNames) {
      insertRolePermission.run(roleName, code);
    }
  }

  // 4. System settings
  for (const setting of SYSTEM_SETTINGS) {
    insertSystemSetting.run(setting.key, setting.value);
  }

  // 5. Incident categories
  for (const name of INCIDENT_CATEGORIES) {
    insertIncidentCategory.run(name);
  }

  // 6. SysAdmin user — only generate a new password if the user doesn't exist yet
  const existingAdmin = db.prepare(`SELECT id FROM users WHERE username = 'sysadmin'`).get();
  let tempPassword = null;

  if (!existingAdmin) {
    tempPassword = generateTempPassword();
    const hash = bcrypt.hashSync(tempPassword, 12);
    insertUser.run('sysadmin', 'sysadmin@sentra.local', hash, 'System Administrator');
  }

  // 7. Audit log — record one SEED entry per run (append-only table)
  const summary = JSON.stringify({
    roles_count:              ROLES.length,
    permissions_count:        PERMISSIONS.length,
    role_permissions_count:   Object.values(ROLE_PERMISSIONS).reduce((s, r) => s + r.length, 0),
    system_settings_count:    SYSTEM_SETTINGS.length,
    incident_categories_count:INCIDENT_CATEGORIES.length,
    sysadmin_created:         tempPassword !== null,
  });
  insertAuditLog.run(summary);

  return tempPassword;
});

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

try {
  const tempPassword = seed();

  if (tempPassword !== null) {
    console.log(
      `\nSENTRA seed complete. Temporary SysAdmin password: ${tempPassword}\n` +
      `Change this password immediately after first login. This message will not be shown again.\n`
    );
  } else {
    console.log('\nSENTRA seed complete (SysAdmin already exists — no changes to credentials).\n');
  }
} catch (err) {
  console.error('Seed failed:', err.message);
  process.exit(1);
}
