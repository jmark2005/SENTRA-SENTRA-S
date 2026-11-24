-- Migration 001: Core schema

CREATE TABLE IF NOT EXISTS incident_ref_counters (
    year        INTEGER PRIMARY KEY,
    last_number INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS reminder_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    kind         TEXT NOT NULL,
    target_table TEXT NOT NULL,
    target_id    INTEGER NOT NULL,
    due_key      TEXT NOT NULL,
    sent_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    UNIQUE (kind, target_table, target_id, due_key)
);
CREATE INDEX IF NOT EXISTS idx_reminder_target ON reminder_log(target_table, target_id);

CREATE TABLE IF NOT EXISTS roles (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    is_active    INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS permissions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    code        TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL,
    module      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    username                TEXT NOT NULL UNIQUE COLLATE NOCASE,
    email                   TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash           TEXT NOT NULL,
    full_name               TEXT NOT NULL,
    id_number               TEXT,
    role_id                 INTEGER NOT NULL REFERENCES roles(id),
    status                  TEXT NOT NULL DEFAULT 'Pending'
                                CHECK (status IN ('Pending','Active','Inactive','Rejected')),
    password_reset_required INTEGER NOT NULL DEFAULT 0 CHECK (password_reset_required IN (0,1)),
    student_record_id       INTEGER UNIQUE REFERENCES students(id),
    rejection_reason        TEXT,
    created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_users_role   ON users(role_id);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

CREATE TABLE IF NOT EXISTS students (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    student_number   TEXT NOT NULL UNIQUE,
    last_name        TEXT NOT NULL,
    first_name       TEXT NOT NULL,
    middle_initial   TEXT,
    grade_level      TEXT NOT NULL,
    section          TEXT NOT NULL,
    school_year      TEXT NOT NULL,
    guardian_name    TEXT,
    guardian_contact TEXT,
    status           TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Archived')),
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    created_by       INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_students_number ON students(student_number);
CREATE INDEX IF NOT EXISTS idx_students_status ON students(status);
CREATE INDEX IF NOT EXISTS idx_students_sy     ON students(school_year);

CREATE TABLE IF NOT EXISTS role_permissions (
    role_id       INTEGER NOT NULL REFERENCES roles(id),
    permission_id INTEGER NOT NULL REFERENCES permissions(id),
    granted       INTEGER NOT NULL DEFAULT 1 CHECK (granted IN (0,1)),
    updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_by    INTEGER REFERENCES users(id),
    PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS system_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_by INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS sessions (
    sid     TEXT PRIMARY KEY,
    sess    TEXT NOT NULL,
    expired TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expired ON sessions(expired);

CREATE TABLE IF NOT EXISTS user_sessions (
    sid        TEXT PRIMARY KEY REFERENCES sessions(sid) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);

CREATE TABLE IF NOT EXISTS classes (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT NOT NULL,
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

CREATE TABLE IF NOT EXISTS class_teachers (
    class_id INTEGER NOT NULL REFERENCES classes(id),
    user_id  INTEGER NOT NULL REFERENCES users(id),
    PRIMARY KEY (class_id, user_id)
);

CREATE TABLE IF NOT EXISTS student_class_assignments (
    student_id  INTEGER NOT NULL REFERENCES students(id),
    class_id    INTEGER NOT NULL REFERENCES classes(id),
    school_year TEXT NOT NULL,
    semester    TEXT NOT NULL,
    PRIMARY KEY (student_id, school_year, semester)
);
CREATE INDEX IF NOT EXISTS idx_sca_class ON student_class_assignments(class_id);

CREATE TABLE IF NOT EXISTS incident_categories (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,
    is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    created_by INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS campus_locations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    description TEXT,
    coord_x     REAL,
    coord_y     REAL,
    is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    created_by  INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS incidents (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    reference_number   TEXT NOT NULL UNIQUE,
    category_id        INTEGER NOT NULL REFERENCES incident_categories(id),
    incident_date      TEXT NOT NULL,
    incident_time      TEXT NOT NULL,
    location_text      TEXT NOT NULL,
    campus_location_id INTEGER REFERENCES campus_locations(id),
    description        TEXT NOT NULL,
    severity           TEXT CHECK (severity IN ('Low','Moderate','High','Critical')),
    status             TEXT NOT NULL DEFAULT 'Submitted'
                           CHECK (status IN ('Submitted','Under Review','Assigned',
                                             'In Progress','For Follow-Up','Resolved','Closed')),
    is_restricted      INTEGER NOT NULL DEFAULT 0 CHECK (is_restricted IN (0,1)),
    is_archived        INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0,1)),
    reporter_id        INTEGER NOT NULL REFERENCES users(id),
    resolution_summary TEXT,
    closure_summary    TEXT,
    closed_by          INTEGER REFERENCES users(id),
    closed_at          TEXT,
    created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_incidents_status   ON incidents(status);
CREATE INDEX IF NOT EXISTS idx_incidents_date     ON incidents(incident_date);
CREATE INDEX IF NOT EXISTS idx_incidents_category ON incidents(category_id);
CREATE INDEX IF NOT EXISTS idx_incidents_reporter ON incidents(reporter_id);
CREATE INDEX IF NOT EXISTS idx_incidents_archived ON incidents(is_archived);

CREATE TABLE IF NOT EXISTS incident_parties (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    incident_id INTEGER NOT NULL REFERENCES incidents(id),
    student_id  INTEGER REFERENCES students(id),
    party_text  TEXT,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_parties_incident ON incident_parties(incident_id);

CREATE TABLE IF NOT EXISTS attachments (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    incident_id   INTEGER NOT NULL REFERENCES incidents(id),
    filename      TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime_type     TEXT NOT NULL,
    size_bytes    INTEGER NOT NULL,
    uploaded_by   INTEGER NOT NULL REFERENCES users(id),
    uploaded_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_attachments_incident ON attachments(incident_id);

CREATE TABLE IF NOT EXISTS incident_assignments (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    incident_id     INTEGER NOT NULL REFERENCES incidents(id),
    assigned_to     INTEGER NOT NULL REFERENCES users(id),
    assigned_by     INTEGER NOT NULL REFERENCES users(id),
    assigned_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    acknowledged_at TEXT,
    is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1))
);
CREATE INDEX IF NOT EXISTS idx_assignments_incident ON incident_assignments(incident_id);
CREATE INDEX IF NOT EXISTS idx_assignments_user     ON incident_assignments(assigned_to);

CREATE TABLE IF NOT EXISTS incident_activity_log (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    incident_id    INTEGER NOT NULL REFERENCES incidents(id),
    actor_id       INTEGER NOT NULL REFERENCES users(id),
    entry_type     TEXT NOT NULL
                       CHECK (entry_type IN ('Submitted','Status Change','Assignment','Acknowledgement',
                                             'Action','Follow-Up Set','Resolution','Closure',
                                             'Restriction Change','Escalation','Archive','Restore','Note')),
    description    TEXT NOT NULL,
    old_status     TEXT,
    new_status     TEXT,
    follow_up_date TEXT,
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_activity_incident ON incident_activity_log(incident_id);
CREATE INDEX IF NOT EXISTS idx_activity_date     ON incident_activity_log(created_at);

CREATE TABLE IF NOT EXISTS referrals (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id           INTEGER NOT NULL REFERENCES students(id),
    referral_type        TEXT NOT NULL
                             CHECK (referral_type IN ('Academic Assistance','Guidance Referral',
                                                      'Attendance-Related Follow-Up','Other School-Based Support')),
    referral_date        TEXT NOT NULL,
    referring_user       INTEGER NOT NULL REFERENCES users(id),
    assigned_to          INTEGER REFERENCES users(id),
    status               TEXT NOT NULL DEFAULT 'Pending'
                             CHECK (status IN ('Pending','Ongoing','Completed','Referred')),
    remarks              TEXT,
    completion_note      TEXT,
    referred_destination TEXT,
    is_archived          INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0,1)),
    created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_referrals_student  ON referrals(student_id);
CREATE INDEX IF NOT EXISTS idx_referrals_status   ON referrals(status);
CREATE INDEX IF NOT EXISTS idx_referrals_assigned ON referrals(assigned_to);
CREATE INDEX IF NOT EXISTS idx_referrals_archived ON referrals(is_archived);

CREATE TABLE IF NOT EXISTS referral_followups (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    referral_id   INTEGER NOT NULL REFERENCES referrals(id),
    actor_id      INTEGER NOT NULL REFERENCES users(id),
    activity_desc TEXT NOT NULL,
    activity_date TEXT NOT NULL,
    next_followup TEXT,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_rf_referral ON referral_followups(referral_id);

CREATE TABLE IF NOT EXISTS attendance_records (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id  INTEGER NOT NULL REFERENCES students(id),
    class_id    INTEGER NOT NULL REFERENCES classes(id),
    record_date TEXT NOT NULL,
    status      TEXT NOT NULL CHECK (status IN ('Present','Absent','Tardy')),
    is_archived INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0,1)),
    recorded_by INTEGER NOT NULL REFERENCES users(id),
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    UNIQUE (student_id, class_id, record_date)
);
CREATE INDEX IF NOT EXISTS idx_att_student  ON attendance_records(student_id);
CREATE INDEX IF NOT EXISTS idx_att_class    ON attendance_records(class_id);
CREATE INDEX IF NOT EXISTS idx_att_date     ON attendance_records(record_date);
CREATE INDEX IF NOT EXISTS idx_att_archived ON attendance_records(is_archived);

CREATE TABLE IF NOT EXISTS attendance_corrections (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    attendance_id INTEGER NOT NULL REFERENCES attendance_records(id),
    corrected_by  INTEGER NOT NULL REFERENCES users(id),
    old_status    TEXT NOT NULL,
    new_status    TEXT NOT NULL,
    reason        TEXT NOT NULL,
    corrected_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_att_corr_record ON attendance_corrections(attendance_id);

CREATE TABLE IF NOT EXISTS notifications (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    type       TEXT NOT NULL
                   CHECK (type IN ('New Assignment','Pending Incident','Follow-Up Reminder',
                                   'Overdue Action','Escalated','Emergency Alert',
                                   'Account Approval','System Notice')),
    title      TEXT NOT NULL,
    message    TEXT NOT NULL,
    link       TEXT,
    is_read    INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0,1)),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_notif_user    ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notif_read    ON notifications(user_id, is_read);
CREATE INDEX IF NOT EXISTS idx_notif_created ON notifications(created_at);

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

-- audit_logs defined BEFORE the triggers that reference it
CREATE TABLE IF NOT EXISTS audit_logs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id     INTEGER REFERENCES users(id),
    actor_name   TEXT NOT NULL,
    actor_role   TEXT NOT NULL,
    action_type  TEXT NOT NULL,
    target_table TEXT,
    target_id    INTEGER,
    old_values   TEXT,
    new_values   TEXT,
    ip_address   TEXT,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_actor  ON audit_logs(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_type   ON audit_logs(action_type);
CREATE INDEX IF NOT EXISTS idx_audit_date   ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_logs(target_table, target_id);

-- Append-only triggers
CREATE TRIGGER IF NOT EXISTS audit_logs_no_update
  BEFORE UPDATE ON audit_logs
  BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;

CREATE TRIGGER IF NOT EXISTS audit_logs_no_delete
  BEFORE DELETE ON audit_logs
  BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;

CREATE TRIGGER IF NOT EXISTS incident_activity_no_update
  BEFORE UPDATE ON incident_activity_log
  BEGIN SELECT RAISE(ABORT, 'incident_activity_log is append-only'); END;

CREATE TRIGGER IF NOT EXISTS incident_activity_no_delete
  BEFORE DELETE ON incident_activity_log
  BEGIN SELECT RAISE(ABORT, 'incident_activity_log is append-only'); END;

CREATE TRIGGER IF NOT EXISTS att_corrections_no_update
  BEFORE UPDATE ON attendance_corrections
  BEGIN SELECT RAISE(ABORT, 'attendance_corrections is append-only'); END;

CREATE TRIGGER IF NOT EXISTS att_corrections_no_delete
  BEFORE DELETE ON attendance_corrections
  BEGIN SELECT RAISE(ABORT, 'attendance_corrections is append-only'); END;

CREATE TRIGGER IF NOT EXISTS referral_followups_no_update
  BEFORE UPDATE ON referral_followups
  BEGIN SELECT RAISE(ABORT, 'referral_followups is append-only'); END;

CREATE TRIGGER IF NOT EXISTS referral_followups_no_delete
  BEFORE DELETE ON referral_followups
  BEGIN SELECT RAISE(ABORT, 'referral_followups is append-only'); END;
