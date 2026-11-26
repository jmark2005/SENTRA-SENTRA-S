'use strict';
/**
 * Recreate missing append-only trigger: audit_logs_no_update.
 * Uses better-sqlite3 exec with the correct multi-statement DDL.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
const Database = require('better-sqlite3');
const dbFile = path.resolve(__dirname, 'db', 'sentra.db');
const db = new Database(dbFile);

// Drop first (safe if missing)
db.exec('DROP TRIGGER IF EXISTS audit_logs_no_update;');

// Recreate. better-sqlite3 exec handles single CREATE TRIGGER blocks fine as long as
// we pass the whole thing as one string without trailing newlines inside BEGIN...END.
db.exec("CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON audit_logs BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;");

console.log('Recreated audit_logs_no_update');

// Verify all 8
const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name").all();
console.log('Total triggers:', triggers.length);
triggers.forEach(t => console.log(' ', t.name));
db.close();
