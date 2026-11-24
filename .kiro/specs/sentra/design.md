# Design Document

## S.E.N.T.R.A. — System Design
**An Integrated School Safety and Student Support Monitoring System**
Developed by Global Solutions INC.
Version 1.0 | November 2026

---

## 1. Architecture Overview

### 1.1 Technology Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Runtime | Node.js 20 LTS | Widely supported, large ecosystem, async I/O suitable for polling-based notifications. |
| Framework | Express 4 | Minimal, well-documented, pairs cleanly with SQLite and vanilla frontend. |
| Database | SQLite 3 (via `better-sqlite3`) | File-based, zero infrastructure, synchronous API avoids callback complexity, fully sufficient for single-school LAN load. |
| Frontend | Vanilla HTML / CSS / JS | Preserves the existing prototype with zero build tooling; straightforward hand-off. |
| PDF export | `pdfkit` (Node.js) | Pure JS, no native dependencies, generates PDFs server-side. |
| CSV export | `csv-stringify` | Lightweight, streaming-compatible. |
| Charts (AF2) | Chart.js 4 (vendored into `public/vendor/`) | Vanilla-JS compatible, no build step, well-maintained. Vendored so the system runs fully offline on LAN. |
| Session store | `express-session` + custom SQLite store (thin wrapper over `better-sqlite3`) | Sessions stored in the library-managed `sessions` table; a separate `user_sessions` table supports bulk invalidation. No Redis dependency needed for LAN scale. |
| Password hashing | `bcryptjs` (cost factor 12) | Pure-JS implementation; no native build step or node-gyp required, which simplifies setup on Windows LAN servers. Functionally identical to `bcrypt` for this workload. If the deployment machine has build tools available and throughput becomes a concern, switching to native `bcrypt` is a one-line dependency change. |
| CSRF protection | `csrf-csrf` (double-submit cookie pattern) | Drop-in replacement for the deprecated `csurf`; actively maintained; works correctly with Express 4 cookie sessions. |
| Security headers | `helmet` | Sets `Content-Security-Policy` (`'self'` only — no CDN sources), `X-Frame-Options: DENY`, `X-Content-Type-Options`, `Referrer-Policy`, and other headers in one middleware. |
| Rate limiting | `express-rate-limit` | Applied to `/api/auth/login` (10 requests / minute / IP) and signup; prevents brute-force attacks. |
| Static assets | Font Awesome 6, Chart.js 4 vendored into `public/vendor/` | Eliminates external network dependency; required for LAN-only deployment and `'self'`-only CSP. |

### 1.2 Deployment Topology

```
[ School LAN ]
     │
     ▼
[ Node.js / Express server ]  ←── process.env (COOKIE_SECURE, PORT, DB_PATH)
     │
     ├── /public              ← static assets (HTML, CSS, JS, images)
     ├── /uploads             ← attachment storage (outside /public)
     ├── /src                 ← application source
     │    ├── routes/
     │    ├── services/
     │    ├── repositories/
     │    ├── middleware/
     │    └── jobs/           ← scheduled jobs (escalation, overdue check)
     └── /db
          ├── migrations/     ← versioned SQL files
          ├── seeds/          ← seed script
          └── sentra.db       ← SQLite database file
```

### 1.3 Request Lifecycle

```
Browser → Static HTML page → JS fetch() → Express route
                                              │
                                    authMiddleware (session check)
                                              │
                                    rbacMiddleware (permission check)
                                              │
                                    Route handler
                                              │
                                    Service layer (business logic)
                                              │
                                    Repository layer (SQL, parameterized)
                                              │
                                    SQLite (better-sqlite3, synchronous)
                                              │
                                    JSON response → JS renders DOM
```

---

## 2. Database Design

### 2.1 Pragmas (applied on every connection open)

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
```

### 2.2 Entity Relationship Diagram (textual)

```
system_settings (1)
    └─ referenced by all modules for school_year / semester defaults

roles (1──∞) role_permissions (∞──1) permissions
    └─ users (∞──1) roles

users (1──0..1) students        [student account link]
users (1──∞) sessions
users (1──∞) notifications
users (1──∞) audit_logs

students (1──∞) incidents       [involved_party link, via incident_parties]
students (1──∞) referrals
students (1──∞) attendance_records
students (∞──1) classes         [via student_class_assignments]

classes (∞──1) users            [class_adviser_id]
classes (1──∞) class_teachers   [∞──1 users]
classes (1──∞) attendance_records

incident_categories (1──∞) incidents
incidents (1──∞) incident_assignments  [∞──1 users]
incidents (1──∞) incident_activity_log [∞──1 users]
incidents (1──∞) attachments
incidents (∞──1) campus_locations      [optional, AF3]

referrals (1──∞) referral_followups    [∞──1 users]

escalation_rules (1──∞) incidents      [via incident_activity_log escalation entries]
```

### 2.3 SQLite DDL

```sql
-- ============================================================
-- Migration 001: Core schema
-- ============================================================

-- Incident reference number counters (one row per calendar year)
-- Increment is done inside a BEGIN IMMEDIATE transaction to guarantee uniqueness.
CREATE TABLE IF NOT EXISTS incident_ref_counters (
    year        INTEGER PRIMARY KEY,   -- e.g. 2026
    last_number INTEGER NOT NULL DEFAULT 0
);

-- Reminder / deduplication log
-- Prevents follow-up reminders, overdue notices, attendance threshold notices,
-- and escalation notifications from firing more than once per unique event.
-- A row is inserted ONLY AFTER the notification is successfully created —
-- never speculatively. The UNIQUE constraint then blocks re-insertion on
-- subsequent job cycles.
-- due_key: for escalations   = rule_id + '|' + status_entered_at ISO string;
--          for incident f/u  = incident_activity_log entry id (the entry that set follow_up_date);
--          for referral f/u  = referral_followups.id;
--          for attendance    = student_id + '|' + semester + '|' + threshold_type.
CREATE TABLE IF NOT EXISTS reminder_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    kind         TEXT NOT NULL,   -- 'follow_up_reminder'|'overdue_notice'|'attendance_threshold'|'escalation'
    target_table TEXT NOT NULL,   -- 'incidents'|'referrals'|'attendance_records'
    target_id    INTEGER NOT NULL,
    due_key      TEXT NOT NULL,
    sent_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    UNIQUE (kind, target_table, target_id, due_key)
);
CREATE INDEX IF NOT EXISTS idx_reminder_target ON reminder_log(target_table, target_id);

-- System settings (key-value store for global config)
CREATE TABLE IF NOT EXISTS system_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_by INTEGER REFERENCES users(id)
);

-- Roles
CREATE TABLE IF NOT EXISTS roles (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,           -- 'sysadmin','schoolhead','teacher','guidance','safetyofficer','student'
    display_name TEXT NOT NULL,
    is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- Permissions
CREATE TABLE IF NOT EXISTS permissions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    code        TEXT NOT NULL UNIQUE,           -- e.g. 'submit_incident'
    description TEXT NOT NULL,
    module      TEXT NOT NULL
);

-- Role ↔ Permission junction
CREATE TABLE IF NOT EXISTS role_permissions (
    role_id       INTEGER NOT NULL REFERENCES roles(id),
    permission_id INTEGER NOT NULL REFERENCES permissions(id),
    granted       INTEGER NOT NULL DEFAULT 1 CHECK (granted IN (0,1)),
    updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_by    INTEGER REFERENCES users(id),
    PRIMARY KEY (role_id, permission_id)
);

-- Users
CREATE TABLE IF NOT EXISTS users (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    username               TEXT NOT NULL UNIQUE COLLATE NOCASE,
    email                  TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash          TEXT NOT NULL,
    full_name              TEXT NOT NULL,
    id_number              TEXT,
    role_id                INTEGER NOT NULL REFERENCES roles(id),
    status                 TEXT NOT NULL DEFAULT 'Pending'
                               CHECK (status IN ('Pending','Active','Inactive','Rejected')),
    password_reset_required INTEGER NOT NULL DEFAULT 0 CHECK (password_reset_required IN (0,1)),
    student_record_id      INTEGER UNIQUE REFERENCES students(id),  -- for Student role only
    rejection_reason       TEXT,
    created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_users_role   ON users(role_id);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

-- Sessions (owned by the express-session custom SQLite store)
-- The library creates and manages this table via the custom store adapter.
-- Do NOT add application-level columns here.
CREATE TABLE IF NOT EXISTS sessions (
    sid        TEXT PRIMARY KEY,
    sess       TEXT NOT NULL,          -- JSON blob managed by express-session
    expired    TEXT NOT NULL           -- ISO 8601 expiry, used by store cleanup
);
CREATE INDEX IF NOT EXISTS idx_sessions_expired ON sessions(expired);

-- User sessions index (application-owned, separate from the store table)
-- Used to bulk-invalidate all sessions for a user on deactivation, password
-- reset, or role change, by deleting rows here and then deleting matching sids
-- from the sessions table.
CREATE TABLE IF NOT EXISTS user_sessions (
    sid        TEXT PRIMARY KEY REFERENCES sessions(sid) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);

-- Students
CREATE TABLE IF NOT EXISTS students (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    student_number  TEXT NOT NULL UNIQUE,
    last_name       TEXT NOT NULL,
    first_name      TEXT NOT NULL,
    middle_initial  TEXT,
    grade_level     TEXT NOT NULL,
    section         TEXT NOT NULL,
    school_year     TEXT NOT NULL,              -- e.g. '2026–2027'
    guardian_name   TEXT,
    guardian_contact TEXT,
    status          TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Archived')),
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    created_by      INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_students_number  ON students(student_number);
CREATE INDEX IF NOT EXISTS idx_students_status  ON students(status);
CREATE INDEX IF NOT EXISTS idx_students_sy      ON students(school_year);

-- Classes
CREATE TABLE IF NOT EXISTS classes (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT NOT NULL,             -- e.g. 'Grade 11 — Section A'
    grade_level      TEXT NOT NULL,
    section          TEXT NOT NULL,
    school_year      TEXT NOT NULL,
    semester         TEXT NOT NULL CHECK (semester IN ('1st Semester','2nd Semester')),
    class_adviser_id INTEGER REFERENCES users(id),
    is_active        INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    created_by       INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_classes_sy ON classes(school_year, semester);

-- Class ↔ Teacher assignments
CREATE TABLE IF NOT EXISTS class_teachers (
    class_id   INTEGER NOT NULL REFERENCES classes(id),
    user_id    INTEGER NOT NULL REFERENCES users(id),
    PRIMARY KEY (class_id, user_id)
);

-- Student ↔ Class assignments
CREATE TABLE IF NOT EXISTS student_class_assignments (
    student_id  INTEGER NOT NULL REFERENCES students(id),
    class_id    INTEGER NOT NULL REFERENCES classes(id),
    school_year TEXT NOT NULL,
    semester    TEXT NOT NULL,
    PRIMARY KEY (student_id, school_year, semester)   -- one class per student per semester
);
CREATE INDEX IF NOT EXISTS idx_sca_class ON student_class_assignments(class_id);

-- Incident categories
CREATE TABLE IF NOT EXISTS incident_categories (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    created_by  INTEGER REFERENCES users(id)
);

-- Campus locations (AF3)
CREATE TABLE IF NOT EXISTS campus_locations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    description TEXT,
    coord_x     REAL,                           -- x% relative to image width
    coord_y     REAL,                           -- y% relative to image height
    is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    created_by  INTEGER REFERENCES users(id)
);

-- Incidents
CREATE TABLE IF NOT EXISTS incidents (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    reference_number    TEXT NOT NULL UNIQUE,   -- INC-YYYY-NNNN
    category_id         INTEGER NOT NULL REFERENCES incident_categories(id),
    incident_date       TEXT NOT NULL,          -- YYYY-MM-DD
    incident_time       TEXT NOT NULL,          -- HH:MM
    location_text       TEXT NOT NULL,
    campus_location_id  INTEGER REFERENCES campus_locations(id),
    description         TEXT NOT NULL,
    severity            TEXT CHECK (severity IN ('Low','Moderate','High','Critical')),
    status              TEXT NOT NULL DEFAULT 'Submitted'
                            CHECK (status IN ('Submitted','Under Review','Assigned',
                                              'In Progress','For Follow-Up','Resolved','Closed')),
    is_restricted       INTEGER NOT NULL DEFAULT 0 CHECK (is_restricted IN (0,1)),
    is_archived         INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0,1)),
    reporter_id         INTEGER NOT NULL REFERENCES users(id),
    resolution_summary  TEXT,                   -- required when transitioning to Resolved
    closure_summary     TEXT,
    closed_by           INTEGER REFERENCES users(id),
    closed_at           TEXT,
    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_incidents_status   ON incidents(status);
CREATE INDEX IF NOT EXISTS idx_incidents_date     ON incidents(incident_date);
CREATE INDEX IF NOT EXISTS idx_incidents_category ON incidents(category_id);
CREATE INDEX IF NOT EXISTS idx_incidents_reporter ON incidents(reporter_id);
CREATE INDEX IF NOT EXISTS idx_incidents_archived ON incidents(is_archived);

-- Involved parties per incident
CREATE TABLE IF NOT EXISTS incident_parties (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    incident_id INTEGER NOT NULL REFERENCES incidents(id),
    student_id  INTEGER REFERENCES students(id),    -- NULL if free-text party
    party_text  TEXT,                                -- free-text for non-students
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_parties_incident ON incident_parties(incident_id);

-- Attachments
CREATE TABLE IF NOT EXISTS attachments (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    incident_id  INTEGER NOT NULL REFERENCES incidents(id),
    filename     TEXT NOT NULL,                 -- stored filename (UUID-based)
    original_name TEXT NOT NULL,
    mime_type    TEXT NOT NULL,
    size_bytes   INTEGER NOT NULL,
    uploaded_by  INTEGER NOT NULL REFERENCES users(id),
    uploaded_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_attachments_incident ON attachments(incident_id);

-- Incident assignments
CREATE TABLE IF NOT EXISTS incident_assignments (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    incident_id  INTEGER NOT NULL REFERENCES incidents(id),
    assigned_to  INTEGER NOT NULL REFERENCES users(id),
    assigned_by  INTEGER NOT NULL REFERENCES users(id),
    assigned_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    acknowledged_at TEXT,
    is_active    INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1))
);
CREATE INDEX IF NOT EXISTS idx_assignments_incident ON incident_assignments(incident_id);
CREATE INDEX IF NOT EXISTS idx_assignments_user     ON incident_assignments(assigned_to);

-- Incident activity log (timeline)
CREATE TABLE IF NOT EXISTS incident_activity_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    incident_id  INTEGER NOT NULL REFERENCES incidents(id),
    actor_id     INTEGER NOT NULL REFERENCES users(id),
    entry_type   TEXT NOT NULL
                     CHECK (entry_type IN ('Submitted','Status Change','Assignment','Acknowledgement',
                                           'Action','Follow-Up Set','Resolution','Closure',
                                           'Restriction Change','Escalation','Archive','Restore','Note')),
    description  TEXT NOT NULL,
    old_status   TEXT,
    new_status   TEXT,
    follow_up_date TEXT,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_activity_incident ON incident_activity_log(incident_id);
CREATE INDEX IF NOT EXISTS idx_activity_date     ON incident_activity_log(created_at);

-- Referrals
CREATE TABLE IF NOT EXISTS referrals (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id      INTEGER NOT NULL REFERENCES students(id),
    referral_type   TEXT NOT NULL
                        CHECK (referral_type IN ('Academic Assistance','Guidance Referral',
                                                 'Attendance-Related Follow-Up','Other School-Based Support')),
    referral_date   TEXT NOT NULL,              -- YYYY-MM-DD
    referring_user  INTEGER NOT NULL REFERENCES users(id),
    assigned_to     INTEGER REFERENCES users(id),
    status          TEXT NOT NULL DEFAULT 'Pending'
                        CHECK (status IN ('Pending','Ongoing','Completed','Referred')),
    remarks         TEXT,                       -- admin remarks only, no clinical detail
    completion_note TEXT,
    referred_destination TEXT,
    is_archived     INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0,1)),
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_referrals_student  ON referrals(student_id);
CREATE INDEX IF NOT EXISTS idx_referrals_status   ON referrals(status);
CREATE INDEX IF NOT EXISTS idx_referrals_assigned ON referrals(assigned_to);
CREATE INDEX IF NOT EXISTS idx_referrals_archived ON referrals(is_archived);

-- Referral follow-ups
CREATE TABLE IF NOT EXISTS referral_followups (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    referral_id     INTEGER NOT NULL REFERENCES referrals(id),
    actor_id        INTEGER NOT NULL REFERENCES users(id),
    activity_desc   TEXT NOT NULL,
    activity_date   TEXT NOT NULL,
    next_followup   TEXT,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_rf_referral ON referral_followups(referral_id);

-- Attendance records
CREATE TABLE IF NOT EXISTS attendance_records (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id   INTEGER NOT NULL REFERENCES students(id),
    class_id     INTEGER NOT NULL REFERENCES classes(id),
    record_date  TEXT NOT NULL,                 -- YYYY-MM-DD
    status       TEXT NOT NULL CHECK (status IN ('Present','Absent','Tardy')),
    is_archived  INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0,1)),
    recorded_by  INTEGER NOT NULL REFERENCES users(id),
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    UNIQUE (student_id, class_id, record_date)
);
CREATE INDEX IF NOT EXISTS idx_att_student  ON attendance_records(student_id);
CREATE INDEX IF NOT EXISTS idx_att_class    ON attendance_records(class_id);
CREATE INDEX IF NOT EXISTS idx_att_date     ON attendance_records(record_date);
CREATE INDEX IF NOT EXISTS idx_att_archived ON attendance_records(is_archived);

-- Attendance corrections log
CREATE TABLE IF NOT EXISTS attendance_corrections (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    attendance_id   INTEGER NOT NULL REFERENCES attendance_records(id),
    corrected_by    INTEGER NOT NULL REFERENCES users(id),
    old_status      TEXT NOT NULL,
    new_status      TEXT NOT NULL,
    reason          TEXT NOT NULL,
    corrected_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_att_corr_record ON attendance_corrections(attendance_id);

-- ============================================================
-- Append-only enforcement triggers
-- These fire BEFORE any UPDATE or DELETE on the four append-only
-- tables and RAISE(ABORT), making those operations impossible at
-- the database level regardless of application code.
-- ============================================================

CREATE TRIGGER IF NOT EXISTS audit_logs_no_update
  BEFORE UPDATE ON audit_logs
  BEGIN RAISE(ABORT, 'audit_logs is append-only'); END;

CREATE TRIGGER IF NOT EXISTS audit_logs_no_delete
  BEFORE DELETE ON audit_logs
  BEGIN RAISE(ABORT, 'audit_logs is append-only'); END;

CREATE TRIGGER IF NOT EXISTS incident_activity_no_update
  BEFORE UPDATE ON incident_activity_log
  BEGIN RAISE(ABORT, 'incident_activity_log is append-only'); END;

CREATE TRIGGER IF NOT EXISTS incident_activity_no_delete
  BEFORE DELETE ON incident_activity_log
  BEGIN RAISE(ABORT, 'incident_activity_log is append-only'); END;

CREATE TRIGGER IF NOT EXISTS att_corrections_no_update
  BEFORE UPDATE ON attendance_corrections
  BEGIN RAISE(ABORT, 'attendance_corrections is append-only'); END;

CREATE TRIGGER IF NOT EXISTS att_corrections_no_delete
  BEFORE DELETE ON attendance_corrections
  BEGIN RAISE(ABORT, 'attendance_corrections is append-only'); END;

CREATE TRIGGER IF NOT EXISTS referral_followups_no_update
  BEFORE UPDATE ON referral_followups
  BEGIN RAISE(ABORT, 'referral_followups is append-only'); END;

CREATE TRIGGER IF NOT EXISTS referral_followups_no_delete
  BEFORE DELETE ON referral_followups
  BEGIN RAISE(ABORT, 'referral_followups is append-only'); END;

-- Notifications
CREATE TABLE IF NOT EXISTS notifications (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id),
    type         TEXT NOT NULL
                     CHECK (type IN ('New Assignment','Pending Incident','Follow-Up Reminder',
                                     'Overdue Action','Escalated','Emergency Alert',
                                     'Account Approval','System Notice')),
    title        TEXT NOT NULL,
    message      TEXT NOT NULL,
    link         TEXT,                          -- relative URL to relevant record
    is_read      INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0,1)),
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_notif_user    ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notif_read    ON notifications(user_id, is_read);
CREATE INDEX IF NOT EXISTS idx_notif_created ON notifications(created_at);

-- Escalation rules (AF1)
CREATE TABLE IF NOT EXISTS escalation_rules (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    severity            TEXT NOT NULL CHECK (severity IN ('Low','Moderate','High','Critical')),
    watch_status        TEXT NOT NULL CHECK (watch_status IN ('In Progress','For Follow-Up')),
    time_target_minutes INTEGER NOT NULL CHECK (time_target_minutes >= 1),
    escalation_user_id  INTEGER NOT NULL REFERENCES users(id),
    is_active           INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    created_by          INTEGER REFERENCES users(id)
);

-- Audit log
CREATE TABLE IF NOT EXISTS audit_logs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id     INTEGER REFERENCES users(id),  -- NULL for system jobs
    actor_name   TEXT NOT NULL,
    actor_role   TEXT NOT NULL,
    action_type  TEXT NOT NULL,
    target_table TEXT,
    target_id    INTEGER,
    old_values   TEXT,                          -- JSON
    new_values   TEXT,                          -- JSON
    ip_address   TEXT,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_actor  ON audit_logs(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_type   ON audit_logs(action_type);
CREATE INDEX IF NOT EXISTS idx_audit_date   ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_logs(target_table, target_id);
```

### 2.5 Incident Reference Number Generation

Reference number generation uses a `BEGIN IMMEDIATE` transaction to prevent race conditions:

```javascript
// src/repositories/incident.repository.js
function generateRefNumber(db, year) {
  const insert = db.transaction(() => {
    db.prepare(`
      INSERT INTO incident_ref_counters (year, last_number)
      VALUES (?, 1)
      ON CONFLICT(year) DO UPDATE SET last_number = last_number + 1
    `).run(year);
    const { last_number } = db.prepare(
      'SELECT last_number FROM incident_ref_counters WHERE year = ?'
    ).get(year);
    return `INC-${year}-${String(last_number).padStart(4, '0')}`;
  });
  // BEGIN IMMEDIATE is set via better-sqlite3's transaction default isolation
  return insert();
}
```

The entire incident INSERT and counter UPDATE run inside a single `better-sqlite3` transaction, which serializes writes within the Node.js process (better-sqlite3 is synchronous, so no concurrent write interleaving is possible).

| Key | Default Value | Description |
|-----|--------------|-------------|
| `school_name` | `[YOUR SCHOOL NAME]` | Displayed in headers and exports. |
| `current_school_year` | `2026–2027` | Default for forms and dashboards. |
| `current_semester` | `1st Semester` | Default for forms and dashboards. |
| `session_idle_minutes` | `30` | Idle timeout. |
| `session_max_hours` | `8` | Absolute session maximum. |
| `student_feature_enabled` | `0` | Student role flag (0 = off). |
| `attendance_threshold_absences` | `3` | School-wide absence threshold. |
| `attendance_threshold_tardies` | `5` | School-wide tardy threshold. |
| `school_timezone` | `Asia/Manila` | IANA timezone string; used for "today", due dates, edit windows, dashboard "due today". |
| `escalation_job_interval_minutes` | `15` | How often the escalation job runs. |
| `retention_years_incidents` | `5` | Retention period for incidents. |
| `retention_years_referrals` | `5` | Retention period for referrals. |
| `retention_years_attendance` | `5` | Retention period for attendance records. |
| `emergency_alert_recipient_roles` | `sysadmin,schoolhead,teacher,guidance,safetyofficer` | Comma-separated role names that receive Emergency Alert notifications. Configurable by SysAdmin. |

---

## 3. API Design

All endpoints are prefixed `/api`. All state-changing endpoints require a valid CSRF token (`X-CSRF-Token` header). All endpoints return JSON. HTTP status codes follow REST conventions (200, 201, 400, 401, 403, 404, 409, 422, 500).

### 3.1 Authentication

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/login` | Authenticate user; create session. Body: `{username, password, role, remember_me}`. |
| POST | `/api/auth/logout` | Invalidate session server-side; remove from `user_sessions`. |
| GET | `/api/auth/me` | Return current session user (id, name, role, permissions). Updates `last_active`. |
| POST | `/api/auth/change-password` | Forced or voluntary password change. Invalidates all sessions for the user. Body: `{current_password, new_password}`. |
| GET | `/api/auth/session-status` | Return `{expires_in_seconds, idle_expires_in_seconds}`. **Does NOT update `last_active`** — excluded from idle tracking. |
| POST | `/api/auth/extend-session` | Reset `last_active` to now (user clicked "Stay signed in"). Updates `last_active`. |

### 3.2 System Settings

| Method | Path | Roles | Description |
|--------|------|-------|-------------|
| GET | `/api/settings` | SysAdmin | Get all settings key-value pairs. |
| PATCH | `/api/settings` | SysAdmin | Update one or more settings. Body: `{key: value, ...}`. |

### 3.3 Accounts and Roles

| Method | Path | Roles | Description |
|--------|------|-------|-------------|
| GET | `/api/users` | SysAdmin | List all users (filterable by status, role). |
| GET | `/api/users/:id` | SysAdmin | Get user detail. |
| POST | `/api/users/signup` | Public | Submit signup request (creates Pending account). |
| PATCH | `/api/users/:id/status` | SysAdmin | Approve / Reject / Deactivate / Reactivate. Body: `{status, student_record_id?, reason?}`. |
| POST | `/api/users/:id/reset-password` | SysAdmin | Issue temporary password. Returns `{temp_password}` once. |
| GET | `/api/roles` | SysAdmin | List roles. |
| GET | `/api/roles/:id/permissions` | SysAdmin | Get permissions for a role. |
| PATCH | `/api/roles/:id/permissions` | SysAdmin | Toggle permissions. Body: `{permission_id, granted}`. |
| GET | `/api/users/:id/participation` | SysAdmin, SchHead | Personnel participation history. Query: `?from=&to=`. |

### 3.4 Students

| Method | Path | Roles | Description |
|--------|------|-------|-------------|
| GET | `/api/students` | Authorized | Search students. Query: `?q=&status=&school_year=`. |
| POST | `/api/students` | SysAdmin, Teacher(perm) | Create student record. |
| GET | `/api/students/:id` | Authorized | Get student profile + linked record counts. |
| PATCH | `/api/students/:id` | SysAdmin, Teacher(limited) | Edit student fields. |
| PATCH | `/api/students/:id/archive` | SysAdmin | Archive student. |
| PATCH | `/api/students/:id/restore` | SysAdmin | Restore student. |
| GET | `/api/students/archived` | SysAdmin | List archived students. |

### 3.5 Classes

| Method | Path | Roles | Description |
|--------|------|-------|-------------|
| GET | `/api/classes` | SysAdmin, SchHead, Teacher | List classes (Teacher sees own only). |
| POST | `/api/classes` | SysAdmin | Create class. |
| PATCH | `/api/classes/:id` | SysAdmin | Edit class (adviser, name, teachers). |
| POST | `/api/classes/:id/students` | SysAdmin | Assign students to class. Body: `{student_ids: [...]}`. |
| DELETE | `/api/classes/:id/students/:sid` | SysAdmin | Remove student from class. |
| PATCH | `/api/classes/:id/deactivate` | SysAdmin | Deactivate class. |

### 3.6 Incident Categories

| Method | Path | Roles | Description |
|--------|------|-------|-------------|
| GET | `/api/incident-categories` | Authorized | List active categories. |
| POST | `/api/incident-categories` | SysAdmin | Add category. |
| PATCH | `/api/incident-categories/:id` | SysAdmin | Rename or deactivate. |

### 3.7 Incidents

| Method | Path | Roles | Description |
|--------|------|-------|-------------|
| GET | `/api/incidents` | Authorized | List incidents (role-scoped, restricted excluded). Query: `?status=&category=&from=&to=&reporter=`. |
| POST | `/api/incidents` | Authorized reporters | Submit incident. |
| GET | `/api/incidents/:id` | Authorized | Get incident detail + timeline + attachments. |
| PATCH | `/api/incidents/:id/status` | Role-checked | Transition status. Body: `{status, resolution_summary?, closure_summary?}`. |
| PATCH | `/api/incidents/:id/restrict` | SysAdmin, SchHead | Toggle restricted flag. Body: `{is_restricted}`. |
| PATCH | `/api/incidents/:id/classify` | SysAdmin, SchHead, SafetyOff | Set severity. Body: {severity}. Required before assignment. |
| PATCH | `/api/incidents/:id/archive` | SysAdmin | Archive incident. |
| PATCH | `/api/incidents/:id/restore` | SysAdmin | Restore incident. |
| GET | `/api/incidents/archived` | SysAdmin | List archived incidents. |
| POST | `/api/incidents/:id/assign` | SchHead | Assign personnel. Body: `{user_ids: [...]}`. |
| POST | `/api/incidents/:id/acknowledge` | Assigned user | Acknowledge assignment. |
| POST | `/api/incidents/:id/actions` | Assigned, SchHead | Add action/remark entry. Body: `{description, follow_up_date?}`. |
| GET | `/api/incidents/:id/timeline` | Authorized | Get incident activity timeline. |

### 3.8 Attachments

| Method | Path | Roles | Description |
|--------|------|-------|-------------|
| POST | `/api/incidents/:id/attachments` | Authorized reporters | Upload attachment (multipart/form-data). |
| GET | `/api/attachments/:id/download` | Authorized | Download attachment (served from outside /public). |
| DELETE | `/api/attachments/:id` | SysAdmin | Remove attachment (soft-remove, audit-logged). |

### 3.9 Referrals

| Method | Path | Roles | Description |
|--------|------|-------|-------------|
| GET | `/api/referrals` | Authorized | List referrals (role-scoped). Query: `?status=&type=&student=`. |
| POST | `/api/referrals` | Teacher, Guidance, SchHead, SysAdmin | Submit referral. |
| GET | `/api/referrals/:id` | Authorized | Get referral detail + follow-ups. |
| PATCH | `/api/referrals/:id/assign` | Guidance, SchHead | Assign counselor. Body: `{user_id}`. |
| PATCH | `/api/referrals/:id/status` | Guidance, SchHead | Transition status. Body: `{status, completion_note?, referred_destination?}`. |
| POST | `/api/referrals/:id/followups` | Assigned, Guidance, SchHead | Add follow-up entry. |
| PATCH | `/api/referrals/:id/archive` | SysAdmin | Archive referral. |
| PATCH | `/api/referrals/:id/restore` | SysAdmin | Restore referral. |
| GET | `/api/referrals/archived` | SysAdmin | List archived referrals. |

### 3.10 Attendance

| Method | Path | Roles | Description |
|--------|------|-------|-------------|
| GET | `/api/attendance/classes` | Teacher, SchHead, Guidance | List classes available for attendance entry. |
| GET | `/api/attendance/classes/:classId/date/:date` | Authorized | Get attendance records for class on date. |
| POST | `/api/attendance/classes/:classId/date/:date` | Teacher, SchHead(limited), Guidance(limited) | Submit attendance for all students in class. Body: `{records: [{student_id, status}]}`. |
| PATCH | `/api/attendance/:id` | Teacher(within window), SysAdmin, SchHead | Correct single record. Body: `{status, reason}`. |
| GET | `/api/attendance/summary` | Authorized | Attendance summary. Query: `?student=&class=&section=&semester=&school_year=&from=&to=`. |
| PATCH | `/api/attendance/archive` | SysAdmin | Archive attendance records for a class/semester. Body: `{class_id, semester, school_year}`. |
| PATCH | `/api/attendance/restore` | SysAdmin | Restore archived attendance. Body: `{class_id, semester, school_year}`. |

### 3.11 Notifications

| Method | Path | Roles | Description |
|--------|------|-------|-------------|
| GET | `/api/notifications` | Authenticated | Get current user's notifications. Query: `?unread_only=true`. |
| GET | `/api/notifications/count` | Authenticated | Get unread count (used by 30 s poll). |
| PATCH | `/api/notifications/:id/read` | Authenticated | Mark one notification read. |
| PATCH | `/api/notifications/read-all` | Authenticated | Mark all read. |
| POST | `/api/notifications/emergency` | Authorized roles | Send Emergency Alert to all configured roles. Body: `{message}`. |

### 3.12 Reports and Exports

| Method | Path | Roles | Description |
|--------|------|-------|-------------|
| GET | `/api/reports/incidents` | Authorized | Incident Summary report. Query: `?from=&to=&category=&status=&format=csv|pdf`. |
| GET | `/api/reports/response` | Authorized | Response/Task Completion Summary. Query: `?from=&to=&format=csv|pdf`. |
| GET | `/api/reports/attendance` | Authorized | Attendance Summary. Query: `?semester=&school_year=&section=&class=&format=csv|pdf`. |
| GET | `/api/reports/referrals` | Authorized | Referral Summary. Query: `?from=&to=&type=&status=&format=csv|pdf`. |
| GET | `/api/reports/audit-log` | SysAdmin, SchHead(auth) | Audit Log export. Query: `?from=&to=&actor=&action_type=&format=csv|pdf`. |

### 3.13 Audit Log (view)

| Method | Path | Roles | Description |
|--------|------|-------|-------------|
| GET | `/api/audit-logs` | SysAdmin, SchHead(auth) | Paginated audit log. Query: `?from=&to=&actor=&action_type=&page=&limit=`. |

### 3.14 Dashboard

| Method | Path | Roles | Description |
|--------|------|-------|-------------|
| GET | `/api/dashboard/summary` | Authenticated | Role-scoped dashboard metrics. |

### 3.15 Campus Locations (AF3)

| Method | Path | Roles | Description |
|--------|------|-------|-------------|
| GET | `/api/campus-locations` | Authorized | List active locations. |
| POST | `/api/campus-locations` | SysAdmin | Add location. |
| PATCH | `/api/campus-locations/:id` | SysAdmin | Edit or deactivate location. |
| GET | `/api/campus-locations/map-data` | Authorized | Aggregated marker data. Query: `?category=&from=&to=`. |

### 3.16 Escalation Rules (AF1)

| Method | Path | Roles | Description |
|--------|------|-------|-------------|
| GET | `/api/escalation-rules` | SysAdmin | List rules. |
| POST | `/api/escalation-rules` | SysAdmin | Create rule. |
| PATCH | `/api/escalation-rules/:id` | SysAdmin | Edit rule. |
| DELETE | `/api/escalation-rules/:id` | SysAdmin | Deactivate rule. |

### 3.17 Trend Analysis (AF2)

| Method | Path | Roles | Description |
|--------|------|-------|-------------|
| GET | `/api/trends/by-category` | SysAdmin, SchHead, SafetyOff | Incident counts by category. Query: `?from=&to=&period=daily|weekly|monthly|semester`. |
| GET | `/api/trends/by-location` | SysAdmin, SchHead, SafetyOff | Incident counts by location. Query: `?from=&to=&category=`. |
| GET | `/api/trends/over-time` | SysAdmin, SchHead, SafetyOff | Incident counts over time. Query: `?from=&to=&period=`. |

### 3.18 Retention Review

| Method | Path | Roles | Description |
|--------|------|-------|-------------|
| GET | `/api/retention/review` | SysAdmin | List records flagged as eligible for archive review. |

---

## 2.6 Permission Codes (Authoritative List)

The following 23 permission codes are seeded by `db/seeds/seed.js`. The RBAC matrix in `requirements.md §RBAC` and the access-control test checklist in `test-plan.md §6` are derived from this table.

| Code | Description | Module | Default Grants (roles) |
|------|-------------|--------|------------------------|
| manage_accounts | Create, approve, reject, deactivate, reactivate user accounts | M6 | sysadmin |
| manage_roles_permissions | View and toggle role permission grants | M6 | sysadmin |
| manage_student_records | Create and edit student records | M1 | sysadmin, schoolhead(○), teacher(○), guidance(○), safetyofficer(○) |
| view_own_student_profile | View student profile detail | M1 | sysadmin, schoolhead, teacher, guidance, safetyofficer(○), student(own) |
| manage_classes | Create classes, assign advisers/teachers, map students | M1 | sysadmin |
| submit_incident | Submit a new incident report | M2 | sysadmin, schoolhead, teacher, guidance, safetyofficer, student(opt) |
| review_incident | Review and classify an incident | M2/M3 | sysadmin, schoolhead, teacher(○), guidance(○), safetyofficer |
| restrict_incident | Set or clear the restricted flag on an incident | M2 | sysadmin, schoolhead |
| assign_incident | Assign incident to response personnel | M3 | schoolhead |
| update_response_status | Transition incident status and add actions | M3 | sysadmin(○), schoolhead, teacher(○), guidance(○), safetyofficer |
| approve_incident_closure | Transition incident to Closed | M3 | sysadmin(○), schoolhead, safetyofficer(○) |
| archive_records | Archive and restore incident/referral/attendance records | M1-M5 | sysadmin |
| record_attendance | Submit and correct attendance within the edit window | M5 | sysadmin(○), schoolhead(○), teacher, guidance(○) |
| correct_attendance_post_window | Correct attendance records after the edit window closes | M5 | sysadmin, schoolhead |
| manage_referrals | Assign, update status, and manage referrals | M4 | sysadmin(○), schoolhead(○), teacher(refer-only), guidance |
| update_referral_followups | Add follow-up entries to assigned referrals | M4 | schoolhead(○), teacher(assigned), guidance |
| view_dashboard | Access the administrative dashboard and summaries | M6 | sysadmin, schoolhead, teacher(limited), guidance(limited), safetyofficer(limited) |
| view_campus_map | View the campus incident map | AF3 | sysadmin, schoolhead, teacher(limited), guidance(limited), safetyofficer |
| view_audit_log | View the audit log | M6 | sysadmin, schoolhead(auth-subset) |
| send_emergency_alert | Trigger an Emergency Alert notification | M6 | sysadmin, schoolhead, teacher, guidance, safetyofficer |
| export_reports | Export reports as CSV or PDF | M6 | sysadmin, schoolhead, teacher(own-class only), guidance(limited), safetyofficer(limited) |
| configure_system | Edit system settings | M6 | sysadmin |
| view_personnel_history | View per-staff participation history | M6 | sysadmin, schoolhead |

The attendance edit window is defined as the same calendar day in the `school_timezone` (from `system_settings`). There is no configurable hour count. SysAdmin and SchHead may correct at any time.

---

## 4. RBAC Implementation

### 4.1 Middleware Chain

```
authMiddleware
  └─ reads session → attaches req.user (id, role_id, role_name)
  └─ if no valid session → 401

rbacMiddleware(permissionCode)
  └─ queries role_permissions WHERE role_id = req.user.role_id AND permission_code = ? AND granted = 1
  └─ if not found → 403
```

### 4.2 Row-Level Scoping (applied in service layer)

| Role | Incidents | Students | Referrals | Attendance |
|------|-----------|----------|-----------|------------|
| SysAdmin | All (including restricted) | All | All | All |
| SchHead | All (including restricted) | All | All (all classes) | All classes |
| Teacher | Reported by self + assigned to self; **restricted incidents hidden** | Own class students | Submitted by self | Own classes only |
| Guidance | Assigned to self + reported by self; **restricted incidents hidden** (even if they were the reporter) | Assigned students | All **unassigned** Pending referrals in Guidance queue **plus** those assigned to self | All classes (summaries per US-5.4) |
| SafetyOff | All **non-restricted** incidents + assigned to self | Assigned students | — | — |
| Student | Own submissions only; restricted incidents never visible | Own profile only | — | — |

**Restricted incident visibility rule:** A restricted incident is visible only to SysAdmin, SchHead, and users who are explicitly listed in `incident_assignments` for that incident (regardless of role). It is hidden from all other users, including the original reporter if they are a Teacher or Guidance user.

---

## 5. Session Management Implementation

Sessions are owned by the `express-session` custom SQLite store. The store manages the `sessions` table (sid, sess JSON, expired). The application owns a parallel `user_sessions(sid, user_id, created_at)` table that maps session IDs to users, enabling bulk invalidation.

```
Session lifecycle:

  Login
    → express-session creates new sid (UUID)
    → store writes to sessions table
    → app writes (sid, user_id) to user_sessions
    → session.data stores: { userId, roleId, loginAt, rememberMe }

  Every user-initiated API request (authMiddleware):
    → reads session.data
    → checks absolute expiry: loginAt + max_hours → 401 if exceeded
    → checks idle: now - last_active > idle_minutes → 401 if exceeded
    → updates session.last_active = now   ← USER-INITIATED ONLY

  Excluded from idle tracking (last_active NOT updated):
    GET  /api/notifications/count
    GET  /api/auth/session-status
    These may be called on a timer and must not reset the idle clock.

  GET /api/auth/session-status
    → returns { expires_in_seconds, idle_expires_in_seconds }
    → used by client to show warning modal at < 120 seconds

  POST /api/auth/extend-session
    → user clicks "Stay signed in" in warning modal
    → resets last_active = now
    → returns updated session-status

  Logout / deactivation / password reset / role change:
    → DELETE FROM user_sessions WHERE user_id = ?
      → ON DELETE CASCADE removes matching rows from sessions
    → all sessions for that user are invalidated server-side

  Remember me:
    → cookie maxAge set to absolute maximum (hours → ms)
    → idle and absolute checks still apply server-side
```

Cookie attributes:
```javascript
{
  httpOnly: true,
  sameSite: 'strict',
  secure: process.env.COOKIE_SECURE === 'true',  // controlled by env var
  path: '/'
  // maxAge set only when rememberMe = true
}
```

---

## 6. Workflow Sequence Diagrams

### 6.1 Workflow A — Incident Lifecycle

```
Reporter         System              SchHead            AssignedPersonnel
   │                │                   │                      │
   │──submit()─────▶│                   │                      │
   │                │─generate ref num──│                      │
   │                │─set status:       │                      │
   │                │  Submitted        │                      │
   │                │─notify SysAdmin,  │                      │
   │                │  SchHead──────────▶                      │
   │◀─confirm(ref)──│                   │                      │
   │                │                   │                      │
   │                │◀──review()────────│                      │
   │                │─set severity      │                      │
   │                │─status: Under     │                      │
   │                │  Review           │                      │
   │                │─timeline entry────│                      │
   │                │                   │                      │
   │                │◀──assign(users)───│                      │
   │                │─status: Assigned  │                      │
   │                │─notify assigned──────────────────────────▶
   │                │                   │                      │
   │                │◀──────────────────────────acknowledge()──│
   │                │─status: In Progress                      │
   │                │─timeline entry                           │
   │                │                   │                      │
   │                │◀──────────────────────────addAction()────│
   │                │─timeline entry    │                      │
   │                │─schedule reminder │                      │
   │                │                   │                      │
   │                │◀──────────────────────────resolve(summary)
   │                │─require resolution_summary               │
   │                │─status: Resolved  │                      │
   │                │─timeline entry    │                      │
   │                │                   │                      │
   │                │◀──close(summary)──│                      │
   │                │─status: Closed    │                      │
   │                │─read-only         │                      │
```

### 6.2 Workflow B — Referral Lifecycle

```
Teacher          System              Guidance           AssignedCounselor
   │                │                   │                      │
   │──submitReferral()─▶               │                      │
   │                │─status: Pending   │                      │
   │                │─notify Guidance───▶                      │
   │◀─confirm()─────│                   │                      │
   │                │                   │                      │
   │                │◀──assign(user)────│                      │
   │                │─status: Ongoing───────────────────────────▶
   │                │─notify assigned   │                      │
   │                │                   │                      │
   │                │◀──────────────────────────addFollowUp()──│
   │                │─log entry         │                      │
   │                │                   │                      │
   │                │◀──────────────────────────complete() ────│
   │                │─status: Completed │                      │
   │                │  or Referred      │                      │
   │                │─read-only         │                      │
```

### 6.3 Workflow C — Attendance Concern

```
Teacher          System              ClassAdviser       Guidance
   │                │                   │                 │
   │──submitAttendance()─▶             │                 │
   │                │─save records      │                 │
   │                │─update summary    │                 │
   │                │                   │                 │
   │                │─[if threshold]────▶                 │
   │                │  notify adviser   │                 │
   │                │  "for review"     │                 │
   │                │                   │                 │
   │                │                   │─[adviser decides]
   │                │                   │─submitReferral()▶
   │                │─status: Pending───────────────────▶
   │                │─notify Guidance   │                 │
```

### 6.4 Workflow D — Account Approval (Student with Record Link)

```
Applicant        System              SysAdmin
   │                │                   │
   │──signup()─────▶│                   │
   │                │─status: Pending   │
   │                │─notify SysAdmin───▶
   │◀─confirm msg───│                   │
   │                │                   │
   │                │◀──approve(student_record_id)
   │                │─validate 1-to-1 link
   │                │─status: Active    │
   │                │─notify user───────▶ (in-app)
   │                │─log audit         │
```

---

## 7. Screen List

All screens share the existing design system (crimson/maroon gradient, glass panels, pink accent, Font Awesome icons, `tokens.css` + `styles.css`).

### 7.1 Public / Auth Screens

| Screen | File | Description |
|--------|------|-------------|
| Landing Page | `index.html` | Updated hero stats, modules, roles, key terms. |
| Login | `login.html` | Updated role tabs, real auth, no demo hints. |
| Sign Up | `signup.html` | Pending account form. |
| Force Password Change | `change-password.html` | Shown after first login or password reset. |

### 7.2 Shared Dashboard Shell

All role dashboards share a common layout:
- **Sidebar**: brand, role-appropriate nav links, logout.
- **Topbar**: hamburger (mobile), page title, notification bell with badge, user avatar + name/role.
- **Content area**: section panels switched by JS.

### 7.3 System Administrator Dashboard

| Section | Key Actions |
|---------|-------------|
| Overview | Stats cards: total students, open incidents, pending accounts, pending referrals. |
| System Settings | Edit school year, semester, session timeouts, student flag, thresholds, retention periods. |
| Account Management | List users (filter by status/role), approve/reject, deactivate/reactivate, link student record. |
| Role & Permissions | Table of roles × permissions with toggle switches. |
| Password Reset | Issue temp password with one-click copy. |
| Student Records | Search, add, edit, archive, restore; linked records tab. |
| Class Management | Create/edit classes, assign adviser + teachers, map students. |
| Incident Categories | Add, rename, deactivate. |
| Campus Locations (AF3) | Add, edit, deactivate; map image preview with coordinate picker. |
| Escalation Rules (AF1) | Add/edit rules (severity, status, time target, contact). |
| Incidents | Full list with all filters; restricted flag toggle; archive/restore. |
| Referrals | Full list; archive/restore. |
| Attendance | Full access; correct after window; archive/restore. |
| Notifications | Full notification list; Emergency Alert button. |
| Dashboard & Reports | All 5 report exports; audit log view + export. |
| Personnel Participation | Per-staff activity history with date filter. |
| Retention Review | Records flagged as eligible for archive review. |
| Archived Records | Unified view of archived students, incidents, referrals, attendance. |

### 7.4 School Head Dashboard

| Section | Key Actions |
|---------|-------------|
| Overview | Stats: open incidents by status, pending referrals, attendance rate, pending accounts (view only). |
| Incidents | Full list (all non-restricted + restricted); assign personnel; approve closure; set restricted flag. |
| Response Tracking | View timelines; update status; add actions. |
| Referrals | Full list; assign counselors; view follow-ups. |
| Attendance | View all summaries; correct after window. |
| Students | Search and view all student profiles. |
| Dashboard & Reports | All applicable reports + audit log (authorized subset). |
| Personnel Participation | Per-staff activity history. |
| Notifications | Full notification list; Emergency Alert button. |
| Trend Analysis (AF2) | Charts and tables. |
| Campus Map (AF3) | Full marker detail view. |

### 7.5 Teacher Dashboard

| Section | Key Actions |
|---------|-------------|
| Overview | My class attendance summary; incidents I reported; referrals I submitted. |
| Submit Incident | Incident submission form. |
| My Incidents | List of incidents I reported or am assigned to. |
| Attendance | Record attendance for my classes; view/correct within window (with reason). |
| Support Referrals | Submit referral; view referrals I submitted. |
| Notifications | Notification list; Emergency Alert button. |
| Campus Map (AF3) | Counts-only view. |

### 7.6 Guidance Counselor Dashboard

| Section | Key Actions |
|---------|-------------|
| Overview | Referrals assigned to me (by status); follow-ups due today/this week. |
| Submit Incident | Incident submission form. |
| My Incidents | Incidents assigned to me or reported by me. |
| Referrals | Assigned referrals; add follow-ups; complete or refer. |
| Attendance | View summaries (all classes). |
| Students | View assigned student profiles. |
| Notifications | Notification list; Emergency Alert button. |
| Campus Map (AF3) | Counts-only view. |

### 7.7 Safety Officer Dashboard

| Section | Key Actions |
|---------|-------------|
| Overview | Open incidents assigned to me; overdue follow-ups. |
| Submit Incident | Incident submission form. |
| Incidents | All non-restricted incidents; assigned incidents detail; update status/actions. |
| Notifications | Notification list; Emergency Alert button. |
| Campus Map (AF3) | Full marker detail. |
| Trend Analysis (AF2) | Read-only view. |

### 7.8 Student Dashboard (when flag is ON)

| Section | Key Actions |
|---------|-------------|
| Overview | My submitted reports (reference number, status). |
| Submit Concern | Incident form (free-text parties only). |
| My Submissions | List: reference number, category, date, status only. |
| Notifications | Account approval notification. |

### 7.9 Shared Components

| Component | Description |
|-----------|-------------|
| Notification Panel | Slide-in drawer listing notifications; unread badge; "Mark all read." |
| Emergency Alert Modal | Triggered from topbar button; message input; disclaimer text. |
| Session Warning Modal | Appears 2 min before idle expiry; "Stay signed in" / "Log out" buttons. |
| Confirmation Modal | Reusable confirm dialog for destructive actions (archive, delete, restrict). |
| Data Table | Sortable, filterable, paginated table component with CSV/PDF export buttons. |
| Timeline Component | Vertically stacked, chronological entries with icon, actor chip, timestamp. |
| Status Badge | Colour-coded pill for incident/referral status. |
| File Upload Zone | Drag-and-drop + click; client-side type/size preview; server validation feedback. |

---

## 8. Source Code Structure

```
SENTRA-SENTRA-S/
├── public/                          ← static files served by Express
│    ├── index.html
│    ├── login.html
│    ├── signup.html
│    ├── change-password.html
│    ├── dashboard-admin.html
│    ├── dashboard-schoolhead.html
│    ├── dashboard-teacher.html
│    ├── dashboard-guidance.html
│    ├── dashboard-safetyofficer.html
│    ├── dashboard-student.html
│    ├── tokens.css
│    ├── styles.css
│    ├── js/
│    │    ├── auth.js                ← login/signup/session warning
│    │    ├── dashboard-common.js   ← sidebar, topbar, notification poll
│    │    ├── notifications.js
│    │    ├── students.js
│    │    ├── incidents.js
│    │    ├── referrals.js
│    │    ├── attendance.js
│    │    ├── reports.js
│    │    ├── settings.js
│    │    ├── map.js                 ← AF3
│    │    └── trends.js              ← AF2
│    ├── vendor/
│    │    ├── fontawesome/           ← Font Awesome 6 (CSS + webfonts)
│    │    └── chartjs/
│    │         └── chart.umd.min.js ← Chart.js 4 UMD build
│    ├── blueprint.svg
│    └── facility-map.svg
├── uploads/                         ← attachment storage (NOT in public)
├── src/
│    ├── app.js                      ← Express app setup, middleware, routes
│    ├── server.js                   ← HTTP server entry point, starts jobs
│    ├── config.js                   ← env var loading, defaults
│    ├── middleware/
│    │    ├── auth.js                ← authMiddleware, session idle/absolute check (excludes /count, /session-status)
│    │    ├── rbac.js                ← rbacMiddleware(permissionCode)
│    │    └── csrf.js                ← csrf-csrf double-submit cookie setup
│    ├── routes/
│    │    ├── auth.routes.js
│    │    ├── settings.routes.js
│    │    ├── users.routes.js
│    │    ├── students.routes.js
│    │    ├── classes.routes.js
│    │    ├── incidents.routes.js
│    │    ├── attachments.routes.js
│    │    ├── referrals.routes.js
│    │    ├── attendance.routes.js
│    │    ├── notifications.routes.js
│    │    ├── reports.routes.js
│    │    ├── audit.routes.js
│    │    ├── dashboard.routes.js
│    │    ├── escalation.routes.js   ← AF1
│    │    ├── trends.routes.js       ← AF2
│    │    └── map.routes.js          ← AF3
│    ├── services/
│    │    ├── auth.service.js
│    │    ├── user.service.js
│    │    ├── student.service.js
│    │    ├── class.service.js
│    │    ├── incident.service.js
│    │    ├── referral.service.js
│    │    ├── attendance.service.js
│    │    ├── notification.service.js
│    │    ├── report.service.js
│    │    ├── audit.service.js
│    │    ├── dashboard.service.js
│    │    ├── escalation.service.js  ← AF1
│    │    ├── trends.service.js      ← AF2
│    │    └── map.service.js         ← AF3
│    ├── repositories/
│    │    ├── db.js                  ← better-sqlite3 singleton, pragma setup
│    │    └── [entity].repository.js (one per entity)
│    └── jobs/
│         ├── escalation.job.js      ← setInterval job, AF1
│         └── reminders.job.js       ← setInterval job, follow-up reminders and overdue notices (reads from incident_activity_log and referral_followups)
├── db/
│    ├── migrations/
│    │    ├── 001_core_schema.sql
│    │    ├── 002_seed_roles_permissions.sql
│    │    └── 003_advanced_features.sql
│    └── seeds/
│         └── seed.js               ← runs migrations, inserts defaults, creates SysAdmin
├── .env.example                    ← template (COOKIE_SECURE, PORT, DB_PATH — no secrets)
├── .gitignore                      ← excludes .env, uploads/, *.db, node_modules/
├── package.json
└── README.md                       ← setup, backup procedure, env var docs
```

---

## 9. Security Controls Summary

| Threat | Control |
|--------|---------|
| SQL injection | All queries parameterized via `better-sqlite3` prepared statements. |
| XSS | `helmet` sets `Content-Security-Policy: default-src 'self'` (no CDN sources — all assets vendored). Client: `textContent` / `innerText` for all user data, never `innerHTML` with unsanitized input. |
| CSRF | `csrf-csrf` (double-submit cookie pattern, actively maintained replacement for deprecated `csurf`). `X-CSRF-Token` header required on all POST/PATCH/DELETE. |
| Clickjacking | `helmet` sets `X-Frame-Options: DENY`. |
| IDOR | Service layer checks ownership/assignment before returning records; restricted incident check on every query. |
| Credential exposure | No hardcoded credentials in source; seed outputs temp password to console only once; `.env` in `.gitignore`. |
| Attachment path traversal | Stored with UUID filenames; original filename sanitized; served via ID lookup only; storage directory outside `/public`. |
| Session fixation | New session SID generated on every login (`req.session.regenerate()`). |
| Brute force | `express-rate-limit` applied to `POST /api/auth/login` (10 requests / minute / IP) and `POST /api/users/signup`. |
| Cookie theft | `httpOnly`, `SameSite=Strict`; `Secure` when `COOKIE_SECURE=true`. |
| Secrets in repo | `.env` in `.gitignore`; `COOKIE_SECURE`, `DB_PATH`, `PORT` only — no API keys needed. |
| Failed login audit | `actor_id = NULL`; `actor_name` stores the attempted username string. |
| Missing security headers | `helmet` middleware applied globally (sets `X-Content-Type-Options`, `Referrer-Policy`, `Strict-Transport-Security` when HTTPS, etc.). |

---

## 10. Backup Strategy

Documented in `README.md`. Summary:

1. **Daily backup script**: copy `db/sentra.db` and `db/sentra.db-wal` to a timestamped directory (e.g., `backups/sentra-YYYYMMDD.db`).
2. Use SQLite's Online Backup API (`better-sqlite3` supports `.backup(destination)`) to safely copy while the server is running.
3. Recommended schedule: daily, before 7:00 AM school start.
4. Store backups on a separate physical drive or network share from the server.
5. Test restores quarterly: copy backup `.db` file to a separate test environment and verify data integrity.
6. The `uploads/` directory shall be included in the same backup schedule.

---

*End of design.md — v1.0*
