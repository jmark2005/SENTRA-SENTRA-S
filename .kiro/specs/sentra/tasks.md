# Implementation Plan: S.E.N.T.R.A.

## Overview

Full implementation of the S.E.N.T.R.A. system — an integrated school safety and student support monitoring system built on Node.js/Express + SQLite. Tasks proceed sequentially through 16 phases: project setup, database, auth/RBAC, settings, personnel, student records/classes, incident management, incident response, referrals, attendance, notifications, dashboard/reports, escalation, trends, campus mapping, and final testing/polish.

## Tasks

- [x] T-01: Repository and Project Scaffolding
  - Confirm existing HTML/CSS files are in `public/`. Run `npm init -y`. Install production deps: express, better-sqlite3, bcryptjs, express-session, csrf-csrf, helmet, express-rate-limit, multer, pdfkit, csv-stringify, uuid, cookie-parser. Install dev dep: nodemon. Create src/server.js, src/app.js, src/config.js. Add public/ as static dir. Create .env.example with PORT, DB_PATH, COOKIE_SECURE, SESSION_SECRET. Add .env and uploads/ to .gitignore. Add start and dev scripts to package.json.
  - Test: `npm run dev` starts; GET http://localhost:PORT/ returns index.html with HTTP 200.

- [x] T-02: Vendor Static Assets
  - Depends on: T-01
  - Download Font Awesome 6 Free (CSS + webfonts) into public/vendor/fontawesome/. Download Chart.js 4 UMD build into public/vendor/chartjs/chart.umd.min.js. Update all existing HTML files to load Font Awesome from vendor/fontawesome/css/all.min.css. Apply helmet in src/app.js with contentSecurityPolicy default-src 'self' but do NOT enable CSP yet. Verify no CDN links remain in HTML.
  - Test: Open index.html offline → Font Awesome icons render; no ERR_INTERNET_DISCONNECTED errors.

- [x] T-03: Design Token Extraction
  - Depends on: T-01
  - Create public/tokens.css with the :root block containing all CSS custom properties from styles.css (--maroon-*, --black*, --white, --bg, --surface, --text, --muted, --border*, --radius, --shadow*, --transition, --nav-h). Remove :root block from styles.css. Add `<link rel="stylesheet" href="tokens.css" />` as first stylesheet in every existing HTML file.
  - Test: All existing HTML files render identically to before the extraction.

- [x] T-04: Database Connection and Migration Runner
  - Depends on: T-01
  - Create src/repositories/db.js: opens better-sqlite3 at DB_PATH, applies PRAGMA foreign_keys=ON, journal_mode=WAL, busy_timeout=5000. Create db/migrations/ with a migrations meta-table. Write migration runner that reads .sql files ordered by filename prefix and runs unrecorded ones. Create db/migrations/001_core_schema.sql with full DDL from design.md §2.3 (all tables, indexes, triggers).
  - Test: node src/server.js creates sentra.db; all table names present; all 8 append-only triggers present.

- [x] T-05: Seed Script
  - Depends on: T-04
  - Create db/seeds/seed.js. Insert roles: sysadmin, schoolhead, teacher, guidance, safetyofficer, student. Insert all permissions from design.md RBAC with codes and descriptions. Insert all role_permissions rows. Insert default system_settings rows from design.md §2.4. Insert 6 default incident_categories. Generate cryptographically random 12+ char temp password, hash with bcryptjs, insert SysAdmin with password_reset_required=1. Print temp password to console. Record seed run in audit_log with actor_id=NULL, actor_name='SYSTEM', action_type='SEED'. Seed must be idempotent via INSERT OR IGNORE.
  - Test: Run seed → SysAdmin login redirects to change-password. Run seed again → no duplicate key errors.

- [x] T-06: Authentication Middleware and Login API
  - Depends on: T-05
  - Configure express-session with custom SQLite store managing the sessions table. Set cookie options (httpOnly, sameSite strict, secure from COOKIE_SECURE). Implement POST /api/auth/login with session regeneration, user_sessions insert, audit log. Implement POST /api/auth/logout. Implement GET /api/auth/me returning permissions array. Implement GET /api/auth/session-status (must NOT update last_active). Implement POST /api/auth/extend-session. Create src/middleware/auth.js checking session validity, excluding /api/notifications/count and /api/auth/session-status from idle update. Apply express-rate-limit to login (10 req/min/IP).
  - Test: Valid login → 200, session cookie, user_sessions row. Invalid password → 401, audit log with actor_id=NULL. GET /api/auth/me without session → 401. Idle timeout → 401 after window. session-status does not reset idle. 11th login → 429.

- [x] T-06B: CSRF Protection Setup
  - Depends on: T-06
  - Configure csrf-csrf in src/middleware/csrf.js with double-submit cookie pattern; cookieName '__Host-sentra.x-csrf-token' (plain 'sentra.x-csrf-token' when COOKIE_SECURE=false); size 64; secure from COOKIE_SECURE. Register middleware in src/app.js: cookieParser → express-session → csrf protection on all /api routes except GET /api/csrf-token and GET /api/auth/session-status. Implement GET /api/csrf-token returning csrfToken. Create public/js/api.js: shared fetch wrapper that caches CSRF token, injects X-CSRF-Token header on POST/PATCH/DELETE, retries once on 403. Export api.get, api.post, api.patch, api.del.
  - Test: POST without X-CSRF-Token → 403. Normal login via api.post → 200. Expired CSRF cookie → wrapper retries and succeeds.

- [x] T-07: Force Password Change
  - Depends on: T-06B
  - Create public/change-password.html matching auth page design. Implement POST /api/auth/change-password: validate current password, enforce policy (8+ chars, uppercase, lowercase, number), hash new password, update user, clear password_reset_required, write audit log, invalidate all other sessions. Update authMiddleware to redirect to change-password.html when password_reset_required=1.
  - Test: SysAdmin login → redirected to change-password.html. Weak password → rejected. Strong password → redirected to dashboard; password_reset_required=0 in DB.

- [x] T-08: RBAC Middleware and Permission Helpers
  - Depends on: T-07
  - Create src/middleware/rbac.js with factory requirePermission(code) returning middleware that queries role_permissions and returns 403 if not granted. Create src/services/permission.service.js with getUserPermissions(userId) returning Set of permission codes (used by GET /api/auth/me). Apply to all existing routes.
  - Test: Two test users with different roles; guarded route returns 403 for unauthorized role.

- [x] T-09: Audit Logging Service
  - Depends on: T-08
  - Create src/services/audit.service.js with log({actorId, actorName, actorRole, actionType, targetTable, targetId, oldValues, newValues, ipAddress}) inserting into audit_logs. Verify RAISE(ABORT) triggers work by attempting UPDATE audit_logs. Wire into login and logout handlers. Create GET /api/audit-logs with pagination (?page, limit, from, to, actor, action_type), guarded by view_audit_log permission, with role-scoped filtering.
  - Test: Login → audit_logs row created. Direct DB UPDATE on audit_logs → exception. GET /api/audit-logs as SysAdmin → entries. As Teacher → 403.

- [x] T-09B: Notification Service and Endpoints
  - Depends on: T-08
  - Create src/services/notification.service.js with create({userId, type, title, message, link}) and createForRole(roleName, ...). Implement GET /api/notifications (own only, optional ?unread_only=true). Implement GET /api/notifications/count returning {unread_count} (must NOT update last_active). Implement PATCH /api/notifications/:id/read and PATCH /api/notifications/read-all.
  - Test: Create notification → count=1. Mark read → count=0. User cannot read another's notifications. Count called 10 times → idle clock unchanged.

- [x] T-10: Signup and Account Approval
  - Depends on: T-09, T-09B
  - Update public/signup.html: role tabs Teacher/Guidance/Safety Officer/Student, connect to POST /api/users/signup. Implement POST /api/users/signup: validate fields, enforce password policy, check username/email uniqueness, hash password, insert status=Pending, notify SysAdmin, write audit log. Rate limit 5 signups/hour/IP. Implement GET /api/users (SysAdmin). Implement PATCH /api/users/:id/status (Approve/Reject/Deactivate/Reactivate) with session invalidation, audit log, notifications. Implement GET /api/users/:id.
  - Test: Signup → Pending; login → 401. SysAdmin approves → Active; user logs in. Deactivate mid-session → 401.

- [x] T-10B: Account Approval UI
  - Depends on: T-10
  - Build Account Management panel in dashboard-admin.html: table of users with status/role filters. Row actions: Approve, Reject (optional reason), Deactivate, Reactivate via api.patch('/api/users/:id/status') with confirmAction for destructive ones. For Student role Approve → show student record search/select. Add Reset password button (UI wired in T-11).
  - Test (browser): Sign up Teacher → Pending → Approve → Active. Reject with reason. Deactivate Active user → session ends.

- [x] T-11: Password Reset (SysAdmin-Initiated)
  - Depends on: T-10B
  - Implement POST /api/users/:id/reset-password (SysAdmin only): generate 12-char random password, hash, update user, set password_reset_required=1, invalidate all sessions, write audit log. Return {temp_password} once. UI: Reset password button in Account Management → shows temp password once in modal with copy button.
  - Test: SysAdmin resets → temp_password returned once. User logs in with temp → forced to change. Old sessions invalidated.

- [x] T-12: Role and Permission Management API
  - Depends on: T-11
  - Implement GET /api/roles and GET /api/roles/:id/permissions. Implement PATCH /api/roles/:id/permissions: toggle granted on role_permissions row; guard against removing SysAdmin's manage_accounts and manage_roles_permissions; write audit log. Build Permissions UI panel in dashboard-admin.html (role × permission checkbox grid).
  - Test: Toggle permission off for Teacher → guarded endpoint returns 403. Toggle back → 200.

- [x] T-13: System Settings API and UI
  - Depends on: T-12
  - Implement GET /api/settings (SysAdmin only). Implement PATCH /api/settings: validate school_year format (/^\d{4}–\d{4}$/), numeric ranges for timeouts, school_timezone as valid IANA name, emergency_alert_recipient_roles as comma-separated valid role names, write audit log per changed key. Create src/services/settings.service.js with getSetting(key) and getSettings(keys[]). Build System Settings panel in dashboard-admin.html.
  - Test: Update current_school_year to 2027–2028 → GET /api/settings returns new value.

- [x] T-14: Personnel Participation History API
  - Depends on: T-13
  - Implement GET /api/users/:id/participation?from=&to=: query incidents (reported_by), incident_assignments (assigned_to), incident_activity_log (actor_id), referrals (referring_user, assigned_to), referral_followups (actor_id), attendance_records (recorded_by). Aggregate counts. Write audit log on access. Add Personnel Participation panel to dashboard-admin.html and dashboard-schoolhead.html.
  - Test: Seed user with 2 incidents, 1 assigned, 3 attendance → endpoint returns correct counts.

- [x] T-15: Student Records API
  - Depends on: T-13
  - Create src/repositories/student.repository.js and src/services/student.service.js. Implement POST /api/students (validate student_number unique, required fields, no forbidden fields, audit log). Implement GET /api/students?q=&status=&school_year= (role-scoped). Implement GET /api/students/:id (profile + linked counts, role-scoped). Implement PATCH /api/students/:id (SysAdmin all fields; Teacher/Guidance section and school_year only; block student_number edit if linked records exist; audit log with old/new). Implement PATCH /api/students/:id/archive and restore (SysAdmin only, audit log). Implement GET /api/students/archived (SysAdmin only).
  - Test: Create → search finds it. Edit last_name → audit log shows old+new. Archive → excluded from search. Restore → found again.

- [x] T-15B: Student Records UI
  - Depends on: T-15
  - In dashboard-admin.html Student Information section: wire search to GET /api/students?q=; render data table. Add Student modal form for POST /api/students. View modal with Profile/Incidents/Referrals tabs from GET /api/students/:id. Edit modal pre-filled for PATCH /api/students/:id. Archive with confirmAction. Show Archived toggle (SysAdmin) with Restore. In dashboard-teacher.html: read-only student list scoped to teacher's class via GET /api/students?class_id=.
  - Test (browser): Add → appears in table. Search by partial name → filtered. Edit → table refreshes. Archive → disappears. Show Archived → reappears with Restore. Teacher sees only own class.

- [x] T-16: Class Management API
  - Depends on: T-15
  - Create src/repositories/class.repository.js and src/services/class.service.js. Implement POST /api/classes (validate, audit log). Implement GET /api/classes (SysAdmin/SchHead all; Teacher own via class_teachers). Implement PATCH /api/classes/:id. Implement POST /api/classes/:id/students (bulk assign; enforce UNIQUE student_id+school_year+semester; audit log). Implement DELETE /api/classes/:id/students/:sid (audit log).
  - Test: Create class → assign 3 students → assign same student to second class same semester → 409.

- [x] T-16B: Class Management UI
  - Depends on: T-16
  - Build Class Management panel in dashboard-admin.html: data table of classes. Add Class modal form → api.post('/api/classes'). Manage Students slide-in panel with search-and-add and remove. Assign Teachers multi-select → api.patch('/api/classes/:id'). Active/Inactive toggle → api.patch.
  - Test (browser): Create class → table. Assign 3 students → roster=3. Duplicate student same semester → error. Deactivate → not in attendance picker.

- [x] T-17: Landing Page and Login Update
  - Depends on: T-06B, T-13
  - Update index.html: hero stats 1 School/6 Roles/6 Modules, Modules section, About section 6 role cards, Key Terms, footer roles. Implement GET /api/public/config (no auth) returning {student_feature_enabled, school_name}. Update login.html: 6 role tabs; hide Student when student_feature_enabled=0; remove demo credential logic. Create public/js/login.js (no inline script): submit via api.post('/api/auth/login'); show errors inline; on success go to data.redirect.
  - Test: login.html offline → page renders. Wrong password → inline error, no reload. Student tab hidden when flag=0.

- [x] T-18B: Dashboard Shell (Shared Layout)
  - Depends on: T-09B, T-17
  - Create public/js/dashboard-common.js with initDashboard(config): builds sidebar from navItems, sets brand/user info from GET /api/auth/me. Sidebar hamburger toggle for mobile. Notification bell badge polling GET /api/notifications/count every 30s via api.get (not post/patch). Notification drawer on bell click. Session-warning modal: setInterval every 25s calling GET /api/auth/session-status via plain fetch; show modal when idle_expires_in_seconds < 120; Stay signed in → api.post(/api/auth/extend-session); Log out → api.post(/api/auth/logout). confirmAction(message, onConfirm) modal. Add disclaimer banner on every dashboard. Update dashboard-admin.html to use initDashboard and remove duplicated inline init logic.
  - Test: SysAdmin login → sidebar renders. Hamburger collapses at 360px. Idle warning appears ~55s before expiry. Stay signed in resets idle. Notification badge increments. Notification count calls do NOT reset idle clock.

- [x] T-18C: Role Dashboard Pages and Login Redirect
  - Depends on: T-18B
  - Create public/dashboard-schoolhead.html, dashboard-teacher.html, dashboard-guidance.html, dashboard-safetyofficer.html, dashboard-student.html — each calling initDashboard() with role-specific nav and placeholder panels per design.md §7. Update POST /api/auth/login response to include redirect URL (sysadmin→/dashboard-admin.html, schoolhead→/dashboard-schoolhead.html, teacher→/dashboard-teacher.html, guidance→/dashboard-guidance.html, safetyofficer→/dashboard-safetyofficer.html, student→/dashboard-student.html). Update login.js to use data.redirect. Add auth-guard at top of each dashboard JS calling GET /api/auth/me; on 401 → login.html; on role mismatch → correct dashboard. Disclaimer banner on all dashboards.
  - Test: Teacher login → dashboard-teacher.html. Navigate to dashboard-admin.html as Teacher → redirected. No session → login.html. All 6 dashboards load without JS errors.

- [x] T-17B: Inline Script and Style Cleanup and Enable CSP
  - Depends on: T-18C
  - Audit every HTML file in public/. Move all <script> blocks with logic into public/js/ as separate files loaded with defer. Replace all style="..." attributes with CSS utility classes. Download any external fonts to public/vendor/fonts/ with @font-face. Enable helmet CSP (default-src 'self') in src/app.js.
  - Test: Every page → zero CSP violations; no inline script logic or style= attributes; pages look the same.

- [x] T-09C: Audit Log Viewer UI
  - Depends on: T-09, T-18C
  - Add Audit Log panel to dashboard-admin.html and dashboard-schoolhead.html: table (time, actor, role, action, target, details) with filters (date range, actor, action type) and pagination via GET /api/audit-logs. SchHead sees only authorized subset (enforced by API).
  - Test (browser): Login and logout → entries appear. Filter by action type works. SchHead view has no account/permission change entries.

- [x] T-18: Student Account Link at Approval
  - Depends on: T-15B, T-10B
  - Update PATCH /api/users/:id/status: when status=Active and role=student, require student_record_id; validate record exists and is Active; enforce unique constraint (one active user per student record); write audit log. Update Account Management panel: show student record search/select when approving Student role. If Student login with no linked record → 401 "Account configuration incomplete. Contact the system administrator."
  - Test: Approve Student without student_record_id → 422. With valid ID → linked; student logs in sees own profile only.

- [x] T-19: Incident Categories API
  - Depends on: T-13
  - Implement GET /api/incident-categories (authenticated). Implement POST /api/incident-categories and PATCH /api/incident-categories/:id (SysAdmin only): add, rename, deactivate; prevent deletion of linked categories; write audit log.
  - Test: Deactivate "Facility Hazard" → not in submission dropdown; existing incidents retain category name.

- [x] T-19B: Incident Category UI
  - Depends on: T-19, T-18C
  - Build Category Management panel in dashboard-admin.html: data table with active/inactive badges. Add Category input+button → api.post. Rename (inline edit) → api.patch. Deactivate toggle → api.patch.
  - Test (browser): Add "Test Category" → in list and dropdown. Deactivate → out of dropdown, remains in list as inactive.

- [x] T-19C: Campus Location Management (Core)
  - Depends on: T-19B
  - Implement GET /api/campus-locations (authenticated), POST /api/campus-locations and PATCH /api/campus-locations/:id (SysAdmin only). Store name, description, coord_x, coord_y (0–100%). Write audit log. Build Campus Locations panel in dashboard-admin.html. Add optional Campus Location dropdown to incident submission form in all reporter dashboards (hidden if no active locations). Store campus_location_id on incident; location_text still required.
  - Test (browser): Add "Main Building" → in incident form dropdown. Submit incident with it → campus_location_id set. Deactivate → not in dropdown. Submit without location → saves with campus_location_id=NULL; location_text still required.

- [x] T-20: Incident Reference Counter and Submission
  - Depends on: T-19C, T-15
  - Create src/repositories/incident.repository.js with generateRefNumber(year) using BEGIN IMMEDIATE transaction as per design.md §2.5. Create src/services/incident.service.js. Reject incident_date later than today in school_timezone with 422. Implement POST /api/incidents: generate ref, set status=Submitted, notify SysAdmin/SchHead, audit log. Implement GET /api/incidents with role-scoped filtering (exclude restricted unless SysAdmin/SchHead; exclude archived). Implement GET /api/incidents/:id (role-scoped; include timeline, parties, attachments list).
  - Test: First incident → INC-2026-0001. Second → INC-2026-0002. Concurrent inserts → no duplicates. Future date → 422.

- [x] T-20B: Incident Submission and List UI
  - Depends on: T-20
  - Build incident submission form in all five reporter dashboards (teacher, guidance, safetyofficer, schoolhead, admin — and student when flag ON): category dropdown, date (max today, rejects future), time, location text, campus location dropdown (hidden if empty), description, involved-parties (non-Student: student number lookup + free-text; Student role: free-text only). File upload zone with client-side preview and inline server validation errors. Build incident list view with filter bar (status, category, date range). Build incident detail panel with all fields, parties, attachments, and activity timeline. Status transition buttons based on role and state machine.
  - Test (browser): Submit → ref shown in confirmation → in list. Future date → inline error. Teacher has no Restrict toggle. SchHead restricts → disappears from Teacher list.

- [x] T-21: Incident Attachments
  - Depends on: T-20
  - Configure multer to uploads/ directory; filename=uuid.ext. Implement POST /api/incidents/:id/attachments: check ≤3 attachments; validate mime (image/jpeg, image/png, application/pdf) and size (≤5MB) server-side; store in attachments table; write audit log. Implement GET /api/attachments/:id/download: permission check; stream from uploads/; write audit log.
  - Test: Upload 4 → 4th rejected "maximum 3 attachments". Upload .docx → rejected. Upload valid 4.9MB PDF → accepted. Download without auth → 401.

- [x] T-22: Incident Review, Classify, and Restrict
  - Depends on: T-21
  - Implement PATCH /api/incidents/:id/classify (SysAdmin, SchHead, SafetyOff): body {severity}; if Submitted also transition to Under Review; timeline entry; audit log. Implement PATCH /api/incidents/:id/status: enforce state machine from design.md §US-3.4; check role permissions; require resolution_summary for Resolved; reject Under Review → Assigned if severity null; append to incident_activity_log; audit log. Implement PATCH /api/incidents/:id/restrict (SysAdmin/SchHead only): toggle is_restricted; timeline entry; audit log. Verify GET /api/incidents hides restricted from Teacher/Guidance/SafetyOff unless assigned.
  - Test: Classify Submitted → severity set, status Under Review. Submitted → Assigned → 422. Teacher closes → 403. Restrict → not in Teacher list.

- [x] T-23: Incident Archive and Restore
  - Depends on: T-22
  - Implement PATCH /api/incidents/:id/archive and PATCH /api/incidents/:id/restore (SysAdmin only). Archiving non-Closed requires confirmed:true in body. Write audit log. Implement GET /api/incidents/archived (SysAdmin only). Confirm GET /api/incidents excludes archived for all roles.
  - Test: Archive without confirmed:true → 400. Archive with confirmed:true → hidden from all lists. Restore → visible again.

- [x] T-24: Assignment, Acknowledgement, and Actions
  - Depends on: T-23
  - Implement POST /api/incidents/:id/assign (SchHead only): reject with 422 if severity null; insert incident_assignments rows; transition to Assigned; notify each assigned user; timeline entry; audit log. Implement POST /api/incidents/:id/acknowledge (assigned user only): update acknowledged_at; transition to In Progress; timeline entry; audit log. Implement POST /api/incidents/:id/actions: validate fields; insert incident_activity_log entry_type=Action with optional follow_up_date; audit log (do NOT write reminder_log here). Implement GET /api/incidents/:id/timeline returning all activity log entries ordered by created_at ASC.
  - Test: Assign → notification. Acknowledge → In Progress. Add action with follow-up date → timeline has 4 entries in order.

- [x] T-24B: Incident Response UI
  - Depends on: T-24
  - In incident detail panel (from T-20B): add controls shown only when valid for role and status per state machine: Classify (severity select), Assign (multi-select of SafetyOff/Guidance/Teacher users), Acknowledge, Add Action (description + optional follow-up date), mark For Follow-Up, Resolve (resolution summary required), Close (closure summary required), Restrict toggle (SysAdmin/SchHead), Archive (SysAdmin). Show server errors inline. Refresh timeline after every action.
  - Test (browser): Run Workflow A. Teacher sees no Restrict toggle. SchHead restricts → disappears from Teacher list.

- [x] T-25: Incident Closure
  - Depends on: T-24B
  - PATCH /api/incidents/:id/status to Closed: require closure_summary; set closed_by, closed_at; append timeline closure entry; write audit log. Any further status change on a Closed incident → 422 "incident is closed."
  - Test: Close without closure_summary → 422. Close with summary → status=Closed. Subsequent status change → 422.

- [x] T-26: Reminders and Overdue Job
  - Depends on: T-25
  - Create src/jobs/reminders.job.js, run every reminders_job_interval_minutes (default 60), export runOnce() for tests. Incident follow-ups: for each open incident, find latest incident_activity_log entry with follow_up_date. If date=today and no reminder_log row (kind=incident_followup_due): notify assigned personnel and SchHead; insert reminder_log in same transaction. If date<today and no reminder_log row (kind=incident_followup_overdue): notify with overdue message; insert reminder_log in same transaction. Referral follow-ups: same logic using latest referral_followups.next_followup for each Ongoing referral (kinds referral_followup_due and referral_followup_overdue). Write audit log per notice. Start job in src/server.js.
  - Test: Incident with follow-up=today → one "due" notice; runOnce() again → none. Date=yesterday → one "overdue"; run again → none. Same for referral.

- [x] T-27: Referral Submission and Routing
  - Depends on: T-26, T-15
  - Create src/repositories/referral.repository.js and src/services/referral.service.js. Implement POST /api/referrals: validate student lookup; insert status=Pending; notify all active Guidance users; audit log. Implement GET /api/referrals (role-scoped: Guidance sees all unassigned Pending + assigned to self; Teacher sees own submissions; SchHead/SysAdmin see all; exclude archived). Implement GET /api/referrals/:id.
  - Test: Teacher submits → Guidance sees in queue. Teacher cannot see another student's referral.

- [x] T-27B: Referral Submission UI
  - Depends on: T-27
  - Add Referrals section to Teacher, Guidance, SchHead, and SysAdmin dashboards: submit form (student search, referral type, date, remarks labelled "Administrative remarks only — do not record counseling notes or clinical information") via api.post('/api/referrals'). List view from GET /api/referrals with status badges.
  - Test (browser): Teacher submits → appears in their list and in Guidance queue.

- [x] T-28: Referral Assignment, Follow-Ups, and Completion
  - Depends on: T-27B
  - Implement PATCH /api/referrals/:id/assign (Guidance/SchHead only): set assigned_to; transition to Ongoing; notify assigned user; audit log. Implement POST /api/referrals/:id/followups: insert referral_followups entry (block with 422 if Completed or Referred); audit log (do NOT write reminder_log here). Implement PATCH /api/referrals/:id/status to Completed or Referred: require completion_note or referred_destination; enforce state machine; make read-only; audit log. Implement PATCH /api/referrals/:id/archive and restore (SysAdmin only); audit log.
  - Test: Pending → Completed (skipping Ongoing) → 422. Add follow-up to Completed → 422. next_followup set → entry saved, no reminder_log row yet.

- [x] T-28B: Referral Management UI
  - Depends on: T-28
  - In dashboard-guidance.html: queue view (unassigned Pending + assigned to me), referral detail, Assign, Add Follow-Up (description, date, optional next date), Complete (completion note required), Refer (destination required), Archive and Restore (SysAdmin only). Completed and Referred referrals shown read-only.
  - Test (browser): Run Workflow B end to end through the UI.

- [x] T-29: Attendance Recording and Submission
  - Depends on: T-16, T-13
  - Create src/repositories/attendance.repository.js and src/services/attendance.service.js. Implement GET /api/attendance/classes (Teacher sees own; SchHead/Guidance see all). Implement GET /api/attendance/classes/:classId/date/:date returning existing or empty records. Implement POST /api/attendance/classes/:classId/date/:date: bulk insert/replace; validate Teacher is assigned to class; audit log. Implement PATCH /api/attendance/:id (correction): Teacher may correct same calendar day only in school_timezone; SysAdmin/SchHead any time; require non-empty reason; insert attendance_corrections row; update record; audit log with old/new status and reason.
  - Test: Submit attendance → all records saved. Correct same day → allowed with reason. Next day: Teacher → 403 "edit window closed". SysAdmin → allowed.

- [x] T-29B: Attendance Entry UI
  - Depends on: T-29
  - In dashboard-teacher.html: class picker (own classes), date picker (max today), roster table with Present/Absent/Tardy per student, Submit via api.post('/api/attendance/classes/:classId/date/:date'). If records exist for date, load them; Correct button opens modal requiring reason via api.patch('/api/attendance/:id'). SysAdmin and SchHead see same screen for all classes and can correct anytime.
  - Test (browser): Record attendance → saved. Correct without reason → inline error. Teacher corrects next day → blocked; SysAdmin allowed.

- [x] T-30: Attendance Threshold Flagging Job
  - Depends on: T-29B
  - After each attendance save, query absence/tardy counts for student+class+semester against system_settings thresholds. If threshold crossed and no reminder_log row (kind=attendance_threshold, target_table=attendance_records, target_id=student_id, due_key={class_id}|{semester}|{threshold_type}): create notification for class adviser; insert reminder_log row; audit log. Notification text: "Student [Name, No.] has reached the attendance threshold for review. Please review and determine if follow-up is needed."
  - Test: Absence threshold=2; record 2 absences → adviser notified once. Record 3rd → no second notification.

- [x] T-31: Attendance Summary and Archive
  - Depends on: T-30
  - Implement GET /api/attendance/summary?student=&class=&section=&semester=&school_year=&from=&to= (aggregate counts per student; role-scoped; audit log on access). Implement PATCH /api/attendance/archive and restore (SysAdmin only, sets is_archived on matching records; audit log). Confirm archived records excluded from summaries and standard views.
  - Test: Archive class semester attendance → summary returns no data. Restore → data reappears.

- [x] T-31B: Attendance Summary UI
  - Depends on: T-31
  - Add Attendance Summary section with filters (student, class, section, semester, school year, date range) calling GET /api/attendance/summary; show present/absent/tardy/percentage per student. SysAdmin only: Archive and Restore buttons for class+semester with confirmAction.
  - Test (browser): Summary matches recorded data. Archive → empty. Restore → data returns.

- [x] T-32: Emergency Alert
  - Depends on: T-09B, T-18B
  - Implement POST /api/notifications/emergency (permission send_emergency_alert): body {message} required; create Emergency Alert notifications for all active users in roles from emergency_alert_recipient_roles setting; audit log. Add Emergency Alert button and modal to dashboard-common.js with disclaimer: "Sending this alert does not replace official emergency procedures. Contact emergency services directly." Render unread Emergency Alert notifications with distinct red style and banner.
  - Test: Send alert → all recipient-role users see banner within 30s; excluded role does not. Audit log entry exists.

- [x] T-33: Role-Scoped Dashboard API
  - Depends on: T-32, T-28B, T-31B
  - Implement GET /api/dashboard/summary returning role-scoped metrics: SysAdmin/SchHead (total active students, open incidents by status, pending incidents by category, pending referrals, attendance rate current semester, pending user accounts); Teacher (class attendance summary, incidents reported, referrals submitted); Guidance (referrals assigned by status, follow-ups due today and this week); SafetyOff (open assigned incidents, overdue follow-ups). Connect each role dashboard HTML to GET /api/dashboard/summary and render stat cards using current_school_year and current_semester from system_settings.
  - Test: Seed data → dashboard API counts match underlying data. Teacher cannot see another teacher's data.

- [x] T-34: Reports and CSV/PDF Export
  - Depends on: T-33
  - Create src/services/report.service.js with query functions per report type. Implement GET /api/reports/incidents?from=&to=&category=&status=&format=csv|pdf (role-scoped; excludes restricted/archived for unauthorized). Implement GET /api/reports/response?from=&to=&format=csv|pdf (includes resolution_summary). Implement GET /api/reports/referrals?from=&to=&type=&status=&format=csv|pdf. Implement GET /api/reports/audit-log?from=&to=&actor=&action_type=&format=csv|pdf (SysAdmin + authorized SchHead). Teacher scoped to own incidents and classes. PDF via pdfkit with school_name from settings; CSV via csv-stringify. Audit log per export.
  - Test: Export incidents CSV → columns match spec. Export PDF → valid PDF. Teacher exports all incidents → 403. Audit log shows export entry.

- [x] T-34B: Reports UI
  - Depends on: T-34
  - Add Reports panel to authorized dashboards: one card per report (Incident Summary, Response/Task Completion, Attendance Summary, Referral Summary, Audit Log) with filters and CSV/PDF download buttons (plain GET links). Show only reports the user's role may export.
  - Test (browser): Download each report as CSV and PDF. Teacher sees only allowed reports.

- [x] T-35: Data Retention Review
  - Depends on: T-34B
  - Implement GET /api/retention/review (SysAdmin only): query incidents, referrals, attendance_records where created_at < NOW - retention_years * 365 days; return grouped list with record type, ID/reference, creation date, age. No auto-archive or auto-delete. Add Retention Review panel to dashboard-admin.html.
  - Test: Set retention_years_incidents=0 → all incidents in review. Archive one → disappears from list.

- [x] T-35B: Automated Tests
  - Depends on: T-35
  - Add npm test script using Node's built-in node:test; tests use temporary SQLite file (DB_PATH) created fresh per run. Cover: incident and referral state machines (valid and invalid transitions), unique reference numbers under concurrent calls, append-only triggers (UPDATE/DELETE on 4 protected tables throw), reminder_log deduplication in runOnce(), RBAC denials per permission code, notification count endpoint does not extend idle session.
  - Test: `npm test` passes on a fresh clone.

- [x] T-36: Escalation Rules API and Configuration
  - Depends on: T-35B
  - Implement GET /api/escalation-rules, POST /api/escalation-rules, PATCH /api/escalation-rules/:id (SysAdmin only). Allow time_target_minutes as low as 1 for testing. Write audit log. Build Escalation Rules panel in dashboard-admin.html.
  - Test: Create rule (Critical + In Progress, 1 minute) → appears in GET /api/escalation-rules.

- [x] T-37: Escalation Job
  - Depends on: T-36
  - Create src/jobs/escalation.job.js: runs every escalation_job_interval_minutes (from system_settings, default 15 min). For each active rule: query incidents matching severity and watch_status where last status-change incident_activity_log entry is older than time_target_minutes. For each matched incident: check reminder_log for kind=escalation, target_id=incident_id, due_key={rule_id}|{status_entered_at}. If no row: create Escalated notification for escalation_user_id; append escalation entry to incident_activity_log; insert reminder_log row; write audit log. Start job in src/server.js.
  - Test: Critical incident In Progress; rule (Critical + In Progress, 1 min); wait 90s; run job → escalation notification for SchHead; run again → no duplicate.

- [x] T-38: Trend Analysis API
  - Depends on: T-37
  - Implement GET /api/trends/by-category?from=&to=&period= (group by category_id and time bucket; return [{category, count, period}]). Implement GET /api/trends/by-location?from=&to=&category= (group by campus_location_id; raw location_text for null; return [{location_name, count}]). Implement GET /api/trends/over-time?from=&to=&period=daily|weekly|monthly|semester (return [{period_label, count}]). Guard all with view_dashboard permission; SafetyOff read-only.
  - Test: 5 incidents across 3 categories → by-category returns 3 rows with correct counts.

- [x] T-39: Trend Dashboard UI
  - Depends on: T-38
  - Create public/js/trends.js: fetch all three trend endpoints and render bar chart (incidents by category), line chart (over time), and top-locations table using vendored Chart.js. Add date range/category/location filter controls; re-fetch on change. Add Trend Analysis section to dashboard-admin.html, dashboard-schoolhead.html, and (read-only) dashboard-safetyofficer.html.
  - Test: Charts render without CSP errors; date filter updates chart; results match incident table counts.

- [x] T-40B: Campus Map View
  - Depends on: T-39, T-19C
  - Implement GET /api/campus-locations/map-data?category=&from=&to= (aggregate non-restricted, non-archived incident counts per active location; return [{location_id, name, coord_x, coord_y, count, incidents:[{ref, category, status}]}]). Create public/js/map.js: render blueprint.svg or facility-map.svg; overlay div markers at (coord_x%, coord_y%); color-code by count (green 1–2, yellow 3–5, red 6+). Click handler: popup with location name, count, incident list (Teacher/Guidance: counts+refs only; SysAdmin/SchHead/SafetyOff: full detail link). Add category and date range filters; re-fetch on change. Add Campus Map section to authorized dashboards.
  - Test: Incidents at two locations → both markers with correct colors. Teacher: count+refs only. SysAdmin: full details.

- [x] T-41: End-to-End Incident Lifecycle Test
  - Depends on: T-40B
  - Using actual UI, run Workflow A from design.md §6.1 with test Teacher, SchHead, and SafetyOff accounts. Verify: submission → reference generated → review → severity set → assignment → acknowledgement → action logged → follow-up date set → resolution summary required → closure summary required → record read-only after close. Verify timeline shows all entries in order. Document and fix any bugs before T-42.

- [x] T-42: End-to-End Referral and Attendance Workflow Test
  - Depends on: T-41
  - Run Workflow B: Teacher submits referral → Guidance sees in queue → assigns → adds follow-up → marks Completed. Run Workflow C: Teacher records attendance → SysAdmin sets threshold to 1 → Teacher records 1 absence → class adviser receives threshold notification (check wording). Adviser creates referral → Guidance notified. Fix any bugs before T-43.

- [x] T-43: Access Control Verification
  - Depends on: T-42
  - Using RBAC matrix from requirements.md §13: for every permission code, verify at least one denied role receives 403. Verify Student cannot see another student's incident or profile. Verify restricted incident hidden from Teacher/Guidance/SafetyOff unless assigned. Verify audit log inaccessible to Teacher and standard Guidance. Document and fix failures.

- [x] T-44: Security Hardening Checklist
  - Depends on: T-43
  - Verify helmet headers on all responses. Verify CSP blocks inline scripts and external sources. Verify parameterized queries (attempt SQL injection in search fields). Verify CSRF (remove X-CSRF-Token → 403). Verify no session fixation (SID changes after login). Verify brute-force limit (11th login → 429). Verify attachment path traversal (GET /api/attachments/../../../package.json → 404/403). Scan git log for committed .env or plaintext passwords → none.

- [x] T-45: Usability and Responsive Layout Polish
  - Depends on: T-44
  - Test all 6 dashboards and all forms at 360px viewport width in Chrome DevTools. Test session warning modal, Emergency Alert modal, and confirmation modals on mobile. Ensure all tables have horizontal scroll on small screens. Verify sidebar collapses to hamburger on mobile. Fix layout breaks.

- [x] T-46: README and Backup Procedure
  - Depends on: T-44
  - Write README.md: prerequisites (Node.js 20), setup steps (npm install, cp .env.example .env, node db/seeds/seed.js, npm start), environment variables table, backup procedure (better-sqlite3 .backup() API; copy .db and .db-wal files; daily schedule notes), restore procedure, notes on COOKIE_SECURE for HTTPS vs LAN HTTP. Verify .gitignore excludes .env, uploads/, *.db, *.db-wal, *.db-shm, node_modules/.

- [-] T-47: Final Regression Pass
  - Depends on: T-45, T-46
  - Re-run core module test cases from test-plan.md. Verify vendored assets still load. Verify seed script runs clean on fresh database. Verify all append-only triggers still fire. Tag final release commit.

## Task Dependency Graph

```
T-01 → T-02
T-01 → T-03
T-01 → T-04 → T-05 → T-06 → T-06B → T-07 → T-08 → T-09 → T-10 → T-10B → T-11 → T-12 → T-13
T-13 → T-14
T-13 → T-15 → T-15B
T-15 → T-16 → T-16B
T-06B → T-17
T-13 → T-17
T-09B → T-18B
T-17 → T-18B → T-18C → T-17B
T-18C → T-09C
T-15B → T-18 ← T-10B
T-13 → T-19 → T-19B → T-19C
T-19C → T-20 ← T-15
T-20 → T-20B
T-20 → T-21 → T-22 → T-23 → T-24 → T-24B → T-25 → T-26
T-26 → T-27 ← T-15
T-27 → T-27B → T-28 → T-28B
T-16 → T-29 ← T-13
T-29 → T-29B → T-30 → T-31 → T-31B
T-09B → T-32 ← T-18B
T-32 → T-33 ← T-28B ← T-31B
T-33 → T-34 → T-34B → T-35 → T-35B → T-36 → T-37 → T-38 → T-39 → T-40B ← T-19C
T-40B → T-41 → T-42 → T-43 → T-44 → T-45
T-44 → T-46
T-45 → T-47 ← T-46
T-08 → T-09B
```

## Notes

- Tasks are ordered sequentially; later tasks depend on earlier ones.
- The [CORE COMPLETE CHECKPOINT] falls after T-35B: run full test pass before proceeding to T-36+.
- Estimated sizes: S = ≤2 hours, M = ½ day, L = 1 day, XL = 2 days.
- All new HTML/JS must have no inline scripts or style attributes (enforced from T-17B onward).
- Student feature flag defaults to OFF; student-scoped features apply only when enabled.
- Reference spec files: design.md (DDL, API design, workflows), requirements.md (RBAC matrix, acceptance criteria), test-plan.md (test cases).
