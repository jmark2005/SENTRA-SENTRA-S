'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { DB_PATH } = require('../config');

// Resolve DB_PATH relative to project root when it is not absolute
const dbFile = path.isAbsolute(DB_PATH)
  ? DB_PATH
  : path.resolve(__dirname, '..', '..', DB_PATH);

// Ensure the directory containing the database file exists
fs.mkdirSync(path.dirname(dbFile), { recursive: true });

const db = new Database(dbFile);

// Apply connection-level pragmas on every open
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

// Create the migrations meta-table if it does not exist yet
db.exec(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename   TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  )
`);

/**
 * Split a SQL file into individual statements.
 *
 * Handles CREATE TRIGGER … BEGIN … END blocks correctly by tracking
 * BEGIN/END nesting so the semicolon inside a trigger body is not
 * treated as a statement separator.
 */
function splitStatements(sql) {
  const statements = [];
  let current = '';
  let depth = 0; // tracks BEGIN…END nesting inside trigger bodies

  for (const rawLine of sql.split('\n')) {
    // Strip inline -- comments
    const line = rawLine.replace(/--.*$/, '');

    // Count BEGIN / END keywords (case-insensitive, word-boundary aware)
    const beginMatches = (line.match(/\bBEGIN\b/gi) || []).length;
    const endMatches   = (line.match(/\bEND\b/gi)   || []).length;

    current += line + '\n';
    depth += beginMatches - endMatches;

    // A semicolon at depth 0 marks the end of a statement
    if (depth <= 0 && line.trimEnd().endsWith(';')) {
      depth = 0;
      const trimmed = current.trim();
      if (trimmed.length > 0) statements.push(trimmed);
      current = '';
    }
  }

  // Flush any trailing content without a terminating semicolon
  const trimmed = current.trim();
  if (trimmed.length > 0) statements.push(trimmed);

  return statements;
}

/**
 * Migration runner.
 *
 * Reads all .sql files from db/migrations/ ordered by filename,
 * skips any that have already been recorded in schema_migrations,
 * executes the remaining ones, and records each applied filename.
 */
function runMigrations() {
  const migrationsDir = path.resolve(__dirname, '..', '..', 'db', 'migrations');

  if (!fs.existsSync(migrationsDir)) {
    fs.mkdirSync(migrationsDir, { recursive: true });
    return;
  }

  const files = fs
    .readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort(); // lexicographic sort gives numeric prefix ordering

  const applied = new Set(
    db.prepare('SELECT filename FROM schema_migrations').all().map(r => r.filename)
  );

  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    const statements = splitStatements(sql);

    for (const stmt of statements) {
      db.exec(stmt);
    }

    db.prepare('INSERT INTO schema_migrations (filename) VALUES (?)').run(file);
    console.log(`[Migration] Applied: ${file}`);
  }
}

runMigrations();

module.exports = db;
