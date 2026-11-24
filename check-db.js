'use strict';
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.resolve(__dirname, 'db/sentra.db'));

try {
  const rows = db.prepare('SELECT name FROM _migrations').all();
  console.log('Applied migrations:', JSON.stringify(rows));
} catch (e) {
  console.log('_migrations table error:', e.message);
}

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
console.log('Tables (' + tables.length + '):', JSON.stringify(tables));

const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name").all().map(r => r.name);
console.log('Triggers (' + triggers.length + '):', JSON.stringify(triggers));

// Check for required 8 triggers
const required = [
  'audit_logs_no_update', 'audit_logs_no_delete',
  'incident_activity_no_update', 'incident_activity_no_delete',
  'att_corrections_no_update', 'att_corrections_no_delete',
  'referral_followups_no_update', 'referral_followups_no_delete'
];
const missing = required.filter(t => !triggers.includes(t));
if (missing.length === 0) {
  console.log('All 8 append-only triggers present: OK');
} else {
  console.log('MISSING triggers:', JSON.stringify(missing));
}

db.close();
