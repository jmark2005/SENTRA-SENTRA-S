-- Migration 002: Add requested_role column to users
-- Stores the role the user asked for at signup.
-- Has no effect on access control — the real role_id stays the placeholder
-- until a SysAdmin assigns a confirmed role at approval.

ALTER TABLE users ADD COLUMN requested_role TEXT
  CHECK (requested_role IN ('teacher','guidance','safetyofficer','student') OR requested_role IS NULL);
