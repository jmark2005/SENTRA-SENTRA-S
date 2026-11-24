# Test Plan

## S.E.N.T.R.A. — Test Plan
Developed by Global Solutions INC.
Version 1.0 | November 2026

---

## 1. Scope and Objectives

This test plan covers all core modules and advanced features of SENTRA. Its objectives are to verify that:
- All functional requirements from `requirements.md` are met.
- Role-based access control blocks unauthorized access on every endpoint.
- The full incident, referral, and attendance workflows execute correctly end-to-end.
- Notifications fire at the right time and never duplicate.
- Exports are accurate, role-scoped, and audit-logged.
- Security controls resist the OWASP Top 10 threats documented in `design.md §9`.
- The system is usable by non-technical school personnel on desktop and mobile browsers.
- Performance targets from NFR-06 are met under normal LAN conditions.

**Out of scope for testing:** Parent portal (not built), SMS/email notifications, medical or counseling data (excluded by design), external system integrations.

---

## 2. Test Environment

| Item | Value |
|------|-------|
| OS | Windows (LAN deployment) |
| Node.js | 20 LTS |
| Browser targets | Chrome latest, Edge latest, Firefox latest |
| Mobile viewport | 360 px wide (Chrome DevTools device emulation) |
| Database | Fresh `sentra.db` created from seed script for each test session |
| Test data | Seeded via `db/seeds/seed.js` + supplementary test-data scripts |

---

## 3. Test Accounts (Seeded)

| Account | Role | Purpose |
|---------|------|---------|
| `sysadmin` | System Administrator | Full access; first login forces password change |
| `schoolhead_test` | School Head | Incident review, assignment, closure |
| `teacher_test` | Teacher | Attendance, incident submission, referral submission |
| `guidance_test` | Guidance | Referral management, follow-ups |
| `safety_test` | Safety Officer | Incident response |
| `student_test` | Student (flag ON) | Own-records-only access; linked to `student_record_001` |
| `student_norec` | Student (flag ON) | No linked student record (error case) |

---

## 4. Functional Tests

### 4.1 Module 0 — Prototype Integration

| TC-ID | Test Case | Expected Result |
|-------|-----------|-----------------|
| TC-0.1 | Open `index.html` with network offline (no CDN) | Font Awesome icons render; page fully loads |
| TC-0.2 | Verify hero stats on landing page | Shows "1 School", "6 User Roles", "6 Core Modules" |
| TC-0.3 | Verify Modules section | Shows exactly 6 module cards matching `requirements.md §5–10` |
| TC-0.4 | Open `login.html` and inspect page source | No hardcoded credentials, no demo hint `div`, no `demoAccounts` object |
| TC-0.5 | Login role tabs count | 6 tabs visible when student flag ON; 5 when flag OFF (Student hidden) |
| TC-0.6 | Signup → Pending account | Account created with `status = 'Pending'`; login attempt returns 401 |
| TC-0.7 | Signup with duplicate username | Returns "Username already exists" error |
| TC-0.8 | Signup with weak password (no uppercase) | Returns password policy error |
| TC-0.9 | Seed SysAdmin first login | Redirected to `change-password.html`; cannot access any other page |
| TC-0.10 | SysAdmin sets new password matching policy | Access granted; `password_reset_required = 0` in DB |

### 4.2 Module 0-B — System Settings

| TC-ID | Test Case | Expected Result |
|-------|-----------|-----------------|
| TC-S.1 | SysAdmin updates `current_school_year` to `2027–2028` | Attendance form default changes to new year |
| TC-S.2 | SysAdmin sets `current_semester` to `2nd Semester` | Dashboard and report filter defaults reflect new semester |
| TC-S.3 | SysAdmin sets `session_idle_minutes` to `1` | Session expires after ~70 seconds of inactivity |
| TC-S.4 | SysAdmin submits invalid school year format `2026/2027` | Inline error: invalid format |
| TC-S.5 | Settings change logged | Audit log has entry with old and new values |

### 4.3 Module 1 — Student Information

| TC-ID | Test Case | Expected Result |
|-------|-----------|-----------------|
| TC-1.1 | Add student with all required fields | Record created; audit log entry exists |
| TC-1.2 | Add student with duplicate student number | Error: "Student number already exists" |
| TC-1.3 | Add student with prohibited field (blood type) | Field not present in form; not storable via API |
| TC-1.4 | Search by partial last name | Returns matching students only |
| TC-1.5 | Teacher searches for student not in their class | Record not returned |
| TC-1.6 | SysAdmin edits student last name | Old value and new value both appear in audit log |
| TC-1.7 | Teacher attempts to edit student number | Field is read-only; API returns 403 |
| TC-1.8 | Archive a student | Record disappears from standard search; visible in Archived Records (SysAdmin only) |
| TC-1.9 | Restore archived student | Visible in standard search again |
| TC-1.10 | Student user views own profile | Sees own data only; no other students' records |
| TC-1.11 | Student user views profile of another student via API | Returns 403 |

### 4.4 Module 1 — Class Management

| TC-ID | Test Case | Expected Result |
|-------|-----------|-----------------|
| TC-1.12 | SysAdmin creates a class with adviser | Class appears in Teacher's dashboard class list |
| TC-1.13 | Assign same student to two classes in same semester | Returns 409 conflict |
| TC-1.14 | Deactivate a class | Hidden from active selection; historical attendance records unaffected |

### 4.5 Module 2 — Incident Reporting

| TC-ID | Test Case | Expected Result |
|-------|-----------|-----------------|
| TC-2.1 | Teacher submits incident with all required fields | Reference number generated (`INC-2026-0001`); status `Submitted` |
| TC-2.2 | Submit incident with missing description | Inline field error; not submitted |
| TC-2.3 | Submit two incidents in quick succession | Each gets a unique reference number; no duplicates |
| TC-2.4 | Student submits incident | Involved parties field is free-text only; no student lookup dropdown |
| TC-2.4B | Assign incident before severity is set | Returns 422 "severity must be set before assignment" |
| TC-2.5 | Student submits; confirmation screen | Shows reference number and status only; no response details |
| TC-2.6 | Upload 4th attachment | Error: "maximum 3 attachments" |
| TC-2.7 | Upload `.docx` file | Error: "Only JPG, PNG, and PDF files are accepted" |
| TC-2.8 | Upload 5.1 MB file | Error: "File exceeds the 5 MB size limit" |
| TC-2.9 | Upload valid 4.9 MB PDF | Accepted; stored outside `/public` |
| TC-2.10 | Download attachment without session | Returns 401 |
| TC-2.11 | SysAdmin deactivates "Facility Hazard" category | Category not in submission dropdown; existing incidents retain the name |
| TC-2.12 | SysAdmin sets `is_restricted = true` on incident | Incident disappears from Teacher's incident list |
| TC-2.13 | SafetyOff lists incidents after one is restricted | Restricted incident absent from SafetyOff's list |
| TC-2.14 | SafetyOff assigned to a restricted incident | Can see that specific incident (assigned user exception) |
| TC-2.15 | Archive non-Closed incident without `confirmed: true` | Returns 400 |
| TC-2.16 | Archive with `confirmed: true` | Hidden from all standard lists |

### 4.6 Module 3 — Incident Response

| TC-ID | Test Case | Expected Result |
|-------|-----------|-----------------|
| TC-3.1 | SchHead assigns incident to SafetyOff | Status → `Assigned`; SafetyOff receives notification |
| TC-3.2 | SafetyOff acknowledges | Status → `In Progress`; timeline entry added |
| TC-3.3 | SafetyOff adds action with follow-up date | Timeline entry added; `reminder_log` row inserted |
| TC-3.4 | Attempt `Submitted → Closed` (skipping steps) | Returns 422 "invalid transition" |
| TC-3.5 | Teacher attempts to close incident | Returns 403 |
| TC-3.6 | Transition to `Resolved` without resolution summary | Returns 422 "resolution summary required" |
| TC-3.7 | Transition to `Resolved` with summary | Summary stored; visible in timeline and Response Summary report |
| TC-3.8 | SchHead closes with closure summary | Status `Closed`; subsequent status change → 422 |
| TC-3.9 | Timeline order | All entries appear chronologically: Submitted, Under Review, Assigned, Acknowledged, Action, Resolved, Closed |
| TC-3.10 | Attempt to edit timeline entry directly in DB | `RAISE(ABORT)` trigger fires |
| TC-3.11 | Overdue job (follow-up date yesterday) | Notification sent to assigned user and SchHead |
| TC-3.12 | Run overdue job twice | No duplicate notification (reminder_log deduplication) |

### 4.7 Module 4 — Referrals

| TC-ID | Test Case | Expected Result |
|-------|-----------|-----------------|
| TC-4.1 | Teacher submits referral | Status `Pending`; Guidance users notified |
| TC-4.2 | Guidance sees unassigned Pending referral | Visible in Guidance queue |
| TC-4.3 | Guidance assigns to counselor | Status `Ongoing`; counselor notified |
| TC-4.4 | Add follow-up with next_followup date | `reminder_log` row inserted |
| TC-4.5 | Add follow-up to Completed referral | Returns 422 |
| TC-4.6 | Mark Completed without completion note | Returns 422 |
| TC-4.7 | Mark `Pending → Completed` (skip Ongoing) | Returns 422 |
| TC-4.8 | Attempt to edit referral_followups in DB | `RAISE(ABORT)` trigger fires |
| TC-4.9 | Archive Ongoing referral without confirmation | Returns 400 |

### 4.8 Module 5 — Attendance

| TC-ID | Test Case | Expected Result |
|-------|-----------|-----------------|
| TC-5.1 | Teacher records attendance for class | All records saved; audit log entry created |
| TC-5.2 | Submit attendance twice same day | Second submission updates existing records |
| TC-5.3 | Teacher corrects attendance within edit window | Requires reason; `attendance_corrections` row inserted; audit log has old + new + reason |
| TC-5.4 | Teacher corrects attendance next day | Returns 403 "edit window closed" |
| TC-5.5 | SysAdmin corrects attendance next day | Allowed with reason; audit-logged |
| TC-5.6 | Attempt to edit attendance_corrections in DB | `RAISE(ABORT)` trigger fires |
| TC-5.7 | Absence threshold = 2; record 2nd absence | Class adviser notified; notification text contains "for review" only |
| TC-5.8 | Record 3rd absence after threshold | No second notification (reminder_log deduplication) |
| TC-5.9 | Threshold notification text | Does NOT contain the words "safety", "welfare", "concern", or "issue" |
| TC-5.10 | Archive class semester attendance | Records hidden from summary query; SysAdmin sees them in archived view |
| TC-5.11 | Teacher views attendance summary | Sees own classes only; audit log entry created |
| TC-5.12 | Guidance views attendance summary | Sees all classes |

### 4.9 Module 6 — Personnel, Notifications, Dashboard, Reports

| TC-ID | Test Case | Expected Result |
|-------|-----------|-----------------|
| TC-6.1 | SysAdmin approves Teacher account | Account `Active`; teacher can log in |
| TC-6.2 | SysAdmin approves Student account without student_record_id | Returns 422 |
| TC-6.3 | SysAdmin deactivates active user mid-session | User's next request returns 401 |
| TC-6.4 | Toggle permission off for Teacher | Teacher's next call to that endpoint returns 403 |
| TC-6.5 | Attempt to remove SysAdmin's `manage_accounts` permission | Returns 403 "protected permission" |
| TC-6.6 | Notification badge count | Returns `unread_count` correctly; mark-all-read → count returns 0 |
| TC-6.7 | `GET /api/notifications/count` called 10 times | Idle timeout does NOT advance; idle clock unchanged |
| TC-6.8 | Emergency Alert sent | All recipient role users see it within 30 seconds; audit log entry exists |
| TC-6.9 | Emergency Alert UI disclaimer | Displays "does not replace official emergency procedures" adjacent to button |
| TC-6.10 | Dashboard metrics match underlying data | Manually count open incidents vs. dashboard count → equal |
| TC-6.11 | Export Incident Summary as CSV | Valid CSV; columns: reference, category, date, severity, status, reporter, assigned |
| TC-6.12 | Export Incident Summary as PDF | Valid PDF; school name from settings visible |
| TC-6.13 | Export Response Summary | Includes `resolution_summary` column |
| TC-6.14a | Teacher exports Incident Summary | Returns 403 |
| TC-6.14b | Teacher exports own-class Attendance Summary | Returns CSV with own-class data only |
| TC-6.14c | Teacher exports Referral Summary | Returns counts-only CSV; no student names or numbers |
| TC-6.15 | Export logged in audit log | Audit log has entry with report type, filters, actor, timestamp |
| TC-6.16 | Attempt to edit audit_logs in DB | `RAISE(ABORT)` trigger fires |
| TC-6.17 | SchHead views audit log | Sees incidents/referrals/closures/exports; does NOT see permission change entries |
| TC-6.18 | Personnel participation view | Counts match manually counted incidents, referrals, attendance records for that user |
| TC-6.19 | SysAdmin issues temp password | Returned once in response; `password_reset_required = 1` in DB |
| TC-6.20 | Retention review (set retention to 0 years) | All existing incidents appear in review list; none auto-archived |

---

## 5. Workflow Tests

### 5.1 Workflow A — Full Incident Lifecycle (UI-driven)

**Prerequisite:** Test accounts seeded; student record exists; class created.

| Step | Actor | Action | Expected State |
|------|-------|--------|----------------|
| 1 | Teacher | Submit incident (category, date, time, location, description) | `Submitted`; reference `INC-2026-NNNN` shown |
| 2 | SchHead | Open incident, set severity `High`, transition to `Under Review` | `Under Review`; timeline entry added |
| 3 | SchHead | Assign to `safety_test` | `Assigned`; SafetyOff receives notification |
| 4 | SafetyOff | Click "Acknowledge" | `In Progress`; timeline entry added |
| 5 | SafetyOff | Add action "Interviewed witnesses"; set follow-up date = tomorrow | Action entry in timeline; `reminder_log` row present |
| 6 | SafetyOff | Transition to `For Follow-Up` | `For Follow-Up` |
| 7 | SafetyOff | Add action "Follow-up complete" | Timeline updated |
| 8 | SafetyOff | Attempt to transition to `Resolved` without summary | Error displayed |
| 9 | SafetyOff | Enter resolution summary; transition to `Resolved` | `Resolved`; summary in timeline |
| 10 | SchHead | Enter closure summary; transition to `Closed` | `Closed`; record read-only |
| 11 | Anyone | Attempt further status change | Error: incident is closed |
| 12 | Tester | View full timeline | All 10+ entries in chronological order |

### 5.2 Workflow B — Full Referral Lifecycle (UI-driven)

| Step | Actor | Action | Expected State |
|------|-------|--------|----------------|
| 1 | Teacher | Submit referral (student, type `Academic Assistance`, remarks) | `Pending`; Guidance notified |
| 2 | Guidance | View referral in queue; assign to self | `Ongoing` |
| 3 | Guidance | Add follow-up activity with next date | Activity recorded; reminder_log row present |
| 4 | Guidance | Mark `Completed` with completion note | `Completed`; read-only |
| 5 | Guidance | Attempt to add another follow-up | Error: referral is completed |

### 5.3 Workflow C — Attendance Concern (UI-driven)

| Step | Actor | Action | Expected State |
|------|-------|--------|----------------|
| 1 | SysAdmin | Set absence threshold = 2 for class | Settings saved |
| 2 | Teacher | Record attendance: student_001 Absent | 1 absence; no notification |
| 3 | Teacher | Next day: student_001 Absent again | 2nd absence; class adviser notified "for review" |
| 4 | Teacher | Third absence | No duplicate notification |
| 5 | Adviser | Reviews notification; submits referral for student_001 | Guidance notified |
| 6 | Guidance | Sees new referral in queue | `Pending` in queue |

---

## 6. Access Control Tests

For each permission in the RBAC matrix, verify that the denied roles receive HTTP 403.

| Permission | Denied Roles Tested | Sample Endpoint |
|-----------|---------------------|-----------------|
| manage_accounts | SchHead, Teacher, Guidance, SafetyOff, Student | `PATCH /api/users/:id/status` |
| manage_roles_permissions | all except SysAdmin | `PATCH /api/roles/:id/permissions` |
| assign_incident | Teacher, Guidance, SafetyOff, Student | `POST /api/incidents/:id/assign` |
| approve_incident_closure | Teacher, Student | `PATCH /api/incidents/:id/status` (→ Closed) |
| restrict_incident | Teacher, Guidance, SafetyOff, Student | `PATCH /api/incidents/:id/restrict` |
| archive_records | SchHead, Teacher, Guidance, SafetyOff, Student | `PATCH /api/incidents/:id/archive` |
| correct_attendance_post_window | Teacher (after window), Guidance, SafetyOff | `PATCH /api/attendance/:id` |
| view_audit_log | Teacher, SafetyOff | `GET /api/audit-logs` |
| configure_system | SchHead, Teacher, Guidance, SafetyOff, Student | `PATCH /api/settings` |
| view_personnel_history | Teacher, Guidance, SafetyOff, Student | `GET /api/users/:id/participation` |
| export_reports (all incidents) | Teacher | `GET /api/reports/incidents` (without own-class filter) |
| view_campus_map (AF3) | Student | Campus map API endpoint |

---

## 7. Notification Tests

| TC-ID | Test Case | Expected Result |
|-------|-----------|-----------------|
| TC-N.1 | Incident submitted → SysAdmin and SchHead notified | Both receive `Pending Incident` notification |
| TC-N.2 | Assignment → assigned user notified | `New Assignment` notification with incident reference |
| TC-N.3 | Overdue follow-up → notification sent | `Overdue Action` notification; second run no duplicate |
| TC-N.4 | Attendance threshold crossed → class adviser notified | Notification with compliant wording |
| TC-N.5 | Emergency Alert sent | All configured roles notified within 30 s; alert has distinct style |
| TC-N.6 | Emergency Alert disclaimer | "does not replace official emergency procedures" visible |
| TC-N.7 | Mark notification read | `is_read = 1`; unread count decrements |
| TC-N.8 | Mark all read | All `is_read = 1`; badge shows 0 |
| TC-N.9 | Polling does not advance idle clock | After 10 poll calls only, idle timer unchanged |
| TC-N.10 | Deactivated user's notifications | Cannot be fetched (session invalidated; 401) |
| TC-N.11 | Escalation notification (AF1) | Distinct style (orange border); escalation entry in timeline |
| TC-N.12 | Escalation deduplication | Second job run on same incident does not create a second escalation |

---

## 8. Data Validation Tests

| TC-ID | Field / Rule | Input | Expected Result |
|-------|-------------|-------|-----------------|
| TC-V.1 | Incident date | Future date (2 years ahead) | Rejected: "Incident date cannot be in the future" |
| TC-V.2 | Incident date | Empty | Field error "required" |
| TC-V.3 | Password | 7 characters | "Must be at least 8 characters" |
| TC-V.4 | Password | 8 chars, no uppercase | "Must contain at least one uppercase letter" |
| TC-V.5 | Student number | Duplicate | "Student number already exists" |
| TC-V.6 | School year | `2026/2027` | "Invalid format; use YYYY–YYYY" |
| TC-V.7 | Attachment MIME | `application/msword` | "Only JPG, PNG, and PDF files accepted" |
| TC-V.8 | Attachment size | 5.1 MB | "File exceeds the 5 MB size limit" |
| TC-V.9 | Resolution summary | Empty on Resolved transition | "Resolution summary is required" |
| TC-V.10 | Closure summary | Empty on Close transition | "Closure summary is required" |
| TC-V.11 | Referral completion note | Empty on Complete | "Completion note is required" |
| TC-V.12 | Attendance correction reason | Empty | "Reason is required" |
| TC-V.13 | CSRF token | Missing on POST | Returns 403 |
| TC-V.14 | Reference number collision | Concurrent submissions | No duplicate reference numbers |

---

## 9. Map Tests (Advanced Feature 3)

| TC-ID | Test Case | Expected Result |
|-------|-----------|-----------------|
| TC-M.1 | Add campus location with coordinates | Marker appears on map at correct position |
| TC-M.2 | 1–2 incidents at a location | Green marker |
| TC-M.3 | 6+ incidents at a location | Red marker |
| TC-M.4 | Filter by category | Only markers with incidents of that category shown |
| TC-M.5 | Teacher clicks marker | Sees count and reference numbers only; no description or response notes |
| TC-M.6 | SysAdmin clicks marker | Full detail links available |
| TC-M.7 | Restricted incident | Does not contribute to map count for Teacher/Guidance marker view |
| TC-M.8 | Map renders without internet | Uses vendored `blueprint.svg`; no external requests |

*(If using Fallback T-40C instead: verify unified timeline filters, pagination at 25-entry boundary, and entries display incident reference correctly.)*

---

## 10. Report and Export Tests

| TC-ID | Report | Checks |
|-------|--------|--------|
| TC-R.1 | Incident Summary CSV | Column headers match spec; row count matches filtered incident count |
| TC-R.2 | Incident Summary PDF | Valid PDF; school name in header; date range filter applied |
| TC-R.3 | Response Summary CSV | Includes `resolution_summary` column; empty for unresolved incidents |
| TC-R.4 | Attendance Summary CSV | Counts match raw attendance_records for the same filter |
| TC-R.5 | Referral Summary CSV (Teacher) | No student names or sensitive details |
| TC-R.6 | Referral Summary CSV (SysAdmin) | Includes student numbers |
| TC-R.7 | Audit Log CSV (SysAdmin) | All seeded events present; no gaps |
| TC-R.8 | Audit Log (SchHead) | Only authorized subset visible; account management entries absent |
| TC-R.9 | Export audit log entry | Logged with report type, filters, actor, timestamp |
| TC-R.10 | Restricted incident in export | Not in Teacher/Guidance exports; present in SysAdmin export |

---

## 11. Usability Tests

| TC-ID | Test Case | Pass Criterion |
|-------|-----------|----------------|
| TC-U.1 | Login on 360 px viewport | Form fully visible; no horizontal scroll required; buttons tappable |
| TC-U.2 | Submit incident on mobile | All fields accessible; file upload works |
| TC-U.3 | Session warning modal | Appears at ~2 minutes before expiry; "Stay signed in" button works |
| TC-U.4 | Emergency Alert modal | Disclaimer text visible; submit button clearly labeled |
| TC-U.5 | Incident list with 60 records | Pagination controls visible; navigating pages works |
| TC-U.6 | Form error display | Errors appear inline next to the relevant field, not only at top of form |
| TC-U.7 | Active nav item | Current section highlighted in sidebar for all 6 dashboards |
| TC-U.8 | Restricted incident badge | Prominent "RESTRICTED" label visible to SysAdmin/SchHead in incident detail |
| TC-U.9 | Attendance threshold notification wording | "for review" present; words "safety", "welfare", "concern", "issue" absent |

---

## 12. Performance Tests

| TC-ID | Operation | Acceptable Time |
|-------|-----------|-----------------|
| TC-P.1 | Incident list (100 records, filtered by category) | < 2 seconds |
| TC-P.2 | Student search (500 students, partial name query) | < 2 seconds |
| TC-P.3 | Attendance summary (full semester, 30 students, 1 class) | < 3 seconds |
| TC-P.4 | Dashboard summary load (SysAdmin, all modules) | < 2 seconds |
| TC-P.5 | Incident Summary CSV export (200 records) | < 5 seconds |
| TC-P.6 | Notification count poll | < 500 ms |

---

## 13. Security Tests

| TC-ID | Test Case | Expected Result |
|-------|-----------|-----------------|
| TC-SEC.1 | SQL injection in search field (`' OR '1'='1`) | No data leak; parameterized query absorbs input |
| TC-SEC.2 | XSS in incident description (`<script>alert(1)</script>`) | Script not executed; rendered as text |
| TC-SEC.3 | CSP header present | `Content-Security-Policy: default-src 'self'` on all responses |
| TC-SEC.4 | CSRF: remove `X-CSRF-Token` from POST | Returns 403 |
| TC-SEC.5 | X-Frame-Options header | `DENY` on all responses |
| TC-SEC.6 | Session fixation | SID after login differs from SID before login |
| TC-SEC.7 | Brute force | 11th login in 1 minute → 429 Too Many Requests |
| TC-SEC.8 | Attachment path traversal | `GET /api/attachments/../../../package.json` → 404 or 403 |
| TC-SEC.9 | Credentials in repo | `git log --all -S "password"` → no plaintext password commits |
| TC-SEC.10 | Direct DB UPDATE on audit_logs | `RAISE(ABORT)` trigger fires; operation rejected |
| TC-SEC.11 | Download attachment without session | Returns 401 |
| TC-SEC.12 | Deactivated user session | All subsequent requests return 401 |
| TC-SEC.13 | `Secure` cookie on HTTP | Cookie does NOT have `Secure` flag when `COOKIE_SECURE=false` |
| TC-SEC.14 | `httpOnly` cookie | Cookie is not accessible via `document.cookie` in browser console |

---

## 14. Advanced Feature Tests

### 14.1 AF1 — Escalation

| TC-ID | Test Case | Expected Result |
|-------|-----------|-----------------|
| TC-AF1.1 | Create escalation rule (Critical, In Progress, 1 minute) | Rule saved and active |
| TC-AF1.2 | Create Critical incident; set In Progress; wait 90 seconds; run job | SchHead receives `Escalated` notification; timeline has escalation entry |
| TC-AF1.3 | Run job again | No duplicate escalation (reminder_log deduplication) |
| TC-AF1.4 | Escalation notification style | Visually distinct from standard notifications (orange border or icon) |
| TC-AF1.5 | Escalation in audit log | Audit log entry with `action_type = 'ESCALATION'` |

### 14.2 AF2 — Trend Analysis

| TC-ID | Test Case | Expected Result |
|-------|-----------|-----------------|
| TC-AF2.1 | 5 incidents: 3 Bullying, 2 Accidents | By-category chart shows correct split |
| TC-AF2.2 | Filter by date range | Only incidents in range counted |
| TC-AF2.3 | Line chart over time | Peaks align with dates incidents were submitted |
| TC-AF2.4 | Verify against raw data | Trend API count matches manual COUNT query on incidents table |
| TC-AF2.5 | SafetyOff accesses trend view | Read-only access; no 403 |
| TC-AF2.6 | Teacher accesses trend view | Returns 403 |

---

## 15. Regression Test Pass (Post-Advanced Features)

After completing all advanced feature tasks (T-36–T-40), re-execute the following test groups to confirm no regressions:
- TC-0.1 through TC-0.10 (prototype integration)
- TC-2.1 through TC-2.6 (incident submission)
- TC-3.1 through TC-3.9 (response workflow)
- TC-6.6 through TC-6.9 (notifications)
- TC-SEC.1 through TC-SEC.5 (core security)
- TC-V.13, TC-V.14 (CSRF, concurrent submissions)

---

## 16. Defect Classification

| Severity | Criteria | Action |
|----------|----------|--------|
| Critical | Data loss, authentication bypass, 500 error on core workflow, hardcoded credential found | Fix before demo; block release |
| High | Access control failure, incorrect audit log, duplicate reference numbers, append-only trigger not firing | Fix before demo |
| Medium | Report inaccuracy, notification not sent, UI layout broken on mobile | Fix before demo if time permits |
| Low | Cosmetic issue, minor wording inconsistency | Log; fix in polish phase |

---

*End of test-plan.md — v1.0*
