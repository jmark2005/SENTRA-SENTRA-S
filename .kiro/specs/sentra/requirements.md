# Requirements Document

## S.E.N.T.R.A. — Requirements Specification
**An Integrated School Safety and Student Support Monitoring System**
Developed by Global Solutions INC.
Version 1.1 | November 2026

---

## Introduction

SENTRA is a single-school, web-based system that centralizes safety incident reporting and response tracking, student support referrals, and attendance monitoring for authorized school personnel. It is deployed on a school LAN for capstone demonstration and runs on Node.js + Express with a SQLite database.

**Important disclaimer (must appear in the UI on all dashboards):** Software priority labels and notifications must never delay official emergency procedures. SENTRA supports school-level coordination only and does not replace professional counseling, official emergency services, or school policies.

### Document Conventions

- **EARS notation** is used for acceptance criteria:
  - *When* [trigger], the system *shall* [behavior].
  - *While* [state], the system *shall* [behavior].
  - *If* [condition], the system *shall* [behavior].
  - *The system shall* [unconditional behavior].
- **Priority labels**: P1 = Must Have (core), P2 = Should Have, P3 = Advanced Feature.
- Actor abbreviations: **SysAdmin** = System Administrator; **SchHead** = School Head / School Administrator; **Teacher** = Teacher / Class Adviser; **Guidance** = Guidance Counselor / Student Affairs Personnel; **SafetyOff** = School Safety Officer / Designated Response Personnel; **Student** = Student (optional, default off).
- All dates stored as ISO 8601 TEXT in SQLite (`YYYY-MM-DD`, `YYYY-MM-DDTHH:MM:SSZ`).

### Actors

| ID | Actor | Description |
|----|-------|-------------|
| A1 | System Administrator (SysAdmin) | Manages accounts, roles, configuration, and audit logs. Full system access. |
| A2 | School Head (SchHead) | Oversees incidents, assigns personnel, approves closures, views all dashboards. |
| A3 | Teacher / Class Adviser (Teacher) | Submits incident reports, records attendance, submits referrals for assigned students. |
| A4 | Guidance Counselor / Student Affairs (Guidance) | Manages referrals, follow-ups, reviews incidents for assigned students. |
| A5 | Safety Officer / Designated Response (SafetyOff) | Submits and responds to incidents, updates response status, views campus map. |
| A6 | Student (optional, config flag default OFF) | Submits safety concerns about themselves or others; views own submission status and reference number only. |

**Out-of-scope actors:** Parent/Guardian access is out of scope. The system does not send messages to guardians.

---

## Glossary

| Term | Definition |
|------|-----------|
| Incident Reference Number | Unique system-generated identifier in format `INC-YYYY-NNNN`, auto-incremented per calendar year. |
| RBAC | Role-Based Access Control — permissions assigned to roles stored in the database, checked on every API request. |
| Soft Delete / Archive | Setting a record's status to `Archived` to hide it from normal views without permanently deleting it. |
| Escalation | Automated notification to a supervisor when an incident or follow-up stays unresolved past a configured time target. |
| Referral | A formal request to route a student to a school support service (academic, guidance, or attendance-related). |
| Semester | An academic period — either 1st Semester or 2nd Semester — within a school year (e.g., "2026–2027"). |
| Restricted Incident | An incident flagged by SysAdmin or SchHead as restricted, hidden from SafetyOff and lower roles. |
| Retention Period | Configurable duration after which records are flagged as eligible for archive review (never auto-deleted). |
| WAL Mode | SQLite Write-Ahead Logging mode, used for crash safety and concurrent read performance. |

---

## Non-Functional Requirements

### NFR-01 Security
- The system shall hash all passwords using bcrypt (minimum cost factor 12) before storage.
- The system shall never store plaintext credentials in the database, logs, source code, or configuration files committed to the repository.
- The system shall enforce role-based access control (RBAC) on every API endpoint, checking permissions from the database on each request.
- The system shall protect against OWASP Top 10 threats: SQL injection (parameterized queries), XSS (output encoding, Content-Security-Policy header), CSRF (token-based protection on state-changing requests), clickjacking (X-Frame-Options: DENY), and insecure direct object references (ownership checks before data access).
- The system shall use httpOnly and SameSite=Strict cookie attributes for session tokens on all deployments. The Secure attribute shall be set when the server is running over HTTPS and omitted when running over HTTP (LAN demo mode); this behavior shall be controlled by a server-side environment variable (`COOKIE_SECURE=true|false`), never hardcoded.
- Attachment files shall be stored outside the public web folder and served only through authenticated, permission-checked endpoints.

### NFR-02 Session Management
- **Idle timeout**: default 30 minutes of inactivity; configurable by SysAdmin through the System Settings UI.
- **Absolute maximum**: default 8 hours from login time; configurable by SysAdmin through the System Settings UI.
- **Browser close**: session ends on tab/browser close unless "Remember me" was checked.
- **Remember me**: persists the session token across browser restarts; idle timeout and absolute maximum still apply.
- **Warning**: the system shall show a modal warning 2 minutes before idle expiry, allowing the user to extend the session with one click.
- **Invalidation**: on logout, idle expiry, absolute expiry, or password reset, the server shall invalidate the session token immediately (server-side token store or token version column).
- **Audit**: session expirations and forced logouts shall be recorded in the audit log.

### NFR-03 Privacy
- The system shall collect only the minimum data necessary for each module (data minimization).
- Student records shall not include student photos, student contact numbers, medical records, psychological assessments, or counseling notes.
- The system shall be designed in accordance with the Data Privacy Act of 2012 (Republic Act 10173), with particular care for minors' information.
- Sensitive incident, referral, and student records shall be accessible only to roles with explicit permission.
- The data retention period shall be configurable by SysAdmin. Records shall use soft-delete and archiving only; no hard deletion through the UI for incident, attendance, or referral records.
- Every archive and restore action shall be recorded in the audit log.

### NFR-04 Data Integrity
- Every incident shall have a unique, system-generated reference number (`INC-YYYY-NNNN`).
- Status transitions for incidents and referrals shall follow defined state machines; unauthorized transitions shall be rejected.
- All foreign key relationships shall be enforced at the database level (SQLite `PRAGMA foreign_keys = ON`).
- The system shall use WAL mode (`PRAGMA journal_mode = WAL`) for concurrent read performance and crash safety.

### NFR-05 Usability
- All pages shall be responsive for common desktop and mobile browsers (Chrome, Edge, Firefox; screen widths 360 px to 1920 px).
- All new pages shall match the existing design system: dark crimson/maroon gradient theme, white headings, pink accent (#f4a0a0), rounded buttons and cards, glass-style panels.
- Forms shall display inline validation errors before submission.
- Navigation shall clearly indicate the current active section.

### NFR-06 Performance
- Search results, table renders, and dashboard summaries shall respond within 2 seconds under normal LAN conditions.
- Attendance summary queries for a full semester shall complete within 3 seconds.

### NFR-07 Maintainability
- Database changes shall be managed through versioned SQL migration files.
- A seed script shall populate roles, permissions, one SysAdmin account, and default system settings for initial setup.
- All configuration values (session timeouts, attendance thresholds, escalation rules, system settings, etc.) shall be stored in the database and editable by SysAdmin through the UI, not hardcoded.

### NFR-08 Backup Strategy
- The system shall document a backup procedure: scheduled file copy of the SQLite `.db` file (recommended: daily, before business hours) to a separate directory or external drive.
- Because WAL mode is in use, the backup procedure shall copy both the `.db` and `.db-wal` files, or use the SQLite Online Backup API.
- Backup configuration (path, schedule notes) shall be documented in `README.md`.

---

## Requirements

---

### Module 0 — Prototype Integration and Shared Foundations

#### US-0.1 Design Token Extraction (P1)
**As a** developer,
**I want** all design tokens extracted into a single shared stylesheet (`tokens.css`),
**so that** every new page automatically matches the existing visual style.

**Acceptance Criteria:**
- The system shall define all CSS custom properties from the existing `styles.css` (e.g., `--maroon`, `--maroon-dark`, `--maroon-light`, `--maroon-faint`, `--maroon-subtle`, `--maroon-glow`, `--radius`, `--shadow`, `--shadow-lg`, `--transition`, `--nav-h`) in a single `:root` block in `tokens.css`.
- When a new page imports `tokens.css` and `styles.css`, it shall render with the dark crimson/maroon gradient theme, pink accent, rounded cards, and glass-style panels without additional inline styles.
- The existing `index.html`, `login.html`, `signup.html`, and `admin-dashboard.html` shall continue to render correctly after the extraction.

#### US-0.2 Landing Page Update (P1)
**As a** visitor,
**I want** the landing page to accurately reflect the actual modules, roles, and features of SENTRA,
**so that** I understand what the system does before signing in.

**Acceptance Criteria:**
- The hero stats shall display: **1 School**, **6 User Roles** (SysAdmin, School Head, Teacher, Guidance, Safety Officer, Student\*), **6 Core Modules**.
- The Modules section shall list exactly the 6 modules defined in this document.
- The About section role cards shall list: System Administrator, School Head, Teacher/Class Adviser, Guidance Counselor, Safety Officer, Student (with note: optional).
- The Key Terms section shall include at minimum: Incident Reference Number, Role-Based Access Control, Soft Delete / Archive, Escalation, Referral, Semester.
- The footer User Roles list shall match the 6 actors.

#### US-0.3 Login Role Selector Update (P1)
**As a** user,
**I want** the login role selector to show the correct roles,
**so that** I select the right role before entering my credentials.

**Acceptance Criteria:**
- The role tabs shall be: **System Admin**, **School Head**, **Teacher**, **Guidance**, **Safety Officer**, and **Student** (Student tab hidden when the student feature flag is OFF).
- When [student feature flag is OFF], the system shall hide the Student tab on the login and signup pages.
- The system shall remove all hardcoded demo credentials and demo hint UI from `login.html`.
- When a user submits the login form, the system shall authenticate against the database, not against in-memory objects.

#### US-0.4 Signup Pending Account (P1)
**As a** prospective user,
**I want** to register for an account,
**so that** I can request access and wait for administrator approval.

**Acceptance Criteria:**
- The signup form shall collect: full name, ID number, email address, username, password, confirm password, requested role (Teacher, Guidance, Safety Officer, Student — not SysAdmin or School Head), and agreement to terms.
- When a user submits the signup form with all valid fields and matching passwords, the system shall create a user account with status `Pending`.
- The system shall display: "Your account request has been submitted. You will be notified once an administrator approves your access."
- When a pending account is submitted, the system shall create an in-app notification for SysAdmin: "New account request from [Full Name] requesting [Role]."
- A pending user shall not be able to log in until their account status is changed to `Active` by SysAdmin.
- The system shall reject signup if the username or email already exists, displaying a specific error for each case.
- Passwords shall be at least 8 characters and contain at least one uppercase letter, one lowercase letter, and one number.

#### US-0.5 Seeded SysAdmin First-Login Password Change (P1)
**As a** SysAdmin running the system for the first time,
**I want** to be forced to set a new password on first login,
**so that** no default credentials exist in production.

**Acceptance Criteria:**
- The seed script shall create one SysAdmin account with a randomly generated temporary password printed to the console at seed time only. No default credentials shall appear in source code, configuration files committed to the repository, or any UI element.
- The seed script output shall include the message: "SENTRA seed complete. Temporary SysAdmin password: [GENERATED]. Change this password immediately after first login. This message will not be shown again."
- When the seeded SysAdmin logs in with the temporary password, the system shall flag `password_reset_required = true` and force the password-change screen before granting any access.
- After the SysAdmin sets a new password meeting the password policy, the flag shall be cleared.
- The seed action shall be logged in the audit log on first run.

---

### Module 0-B — System Settings

#### US-0.6 System Settings Management (P1)
**As a** SysAdmin,
**I want** to manage global system settings,
**so that** school year, semester, session behavior, and feature flags are centrally configured.

**Acceptance Criteria:**
- The System Settings screen shall allow SysAdmin to view and edit:
  - Current school year (format `YYYY–YYYY`, e.g., "2026–2027").
  - Current semester (1st Semester, 2nd Semester).
  - Session idle timeout (minutes, minimum 5, maximum 480).
  - Session absolute maximum (hours, minimum 1, maximum 24).
  - Student feature flag (Enabled / Disabled).
  - `COOKIE_SECURE` environment indicator (read-only display, not editable through UI — set via environment variable).
- When the current school year or semester is updated, the new values shall become the default for attendance entry forms, dashboard summaries, and report filter pre-fills.
- The system shall use the current school year and semester as defaults across all modules; users may override the filter for historical views.
- When a setting is saved, the system shall log the change in the audit log (old value, new value, actor, timestamp).
- The system shall validate the school year format (`YYYY–YYYY`) and reject invalid input with an inline error.

---

### Module 1 — Student Information Management

#### US-1.1 Class and Section Management (P1)
**As a** SysAdmin,
**I want** to create and manage classes/sections, assign a class adviser and subject teachers, and map students to classes,
**so that** attendance recording and access scoping work correctly.

**Acceptance Criteria:**
- The class management form shall collect: class name (e.g., "Grade 11 — Section A"), grade level, section, school year, semester, and class adviser (assigned from active Teacher accounts).
- SysAdmin shall be able to assign one or more subject teachers to a class (for multi-subject attendance scoping).
- SysAdmin shall be able to map students to a class by selecting from active student records with matching grade level and section.
- A student may be in only one class per school year and semester.
- When a class is deactivated, it shall be hidden from active selection but remain linked to historical attendance records.
- The system shall log class creation, teacher assignments, and student-class mappings in the audit log.
- Class management is for attendance scoping and access only; it does not constitute enrollment processing.

#### US-1.2 Add Student Record (P1)
**As a** SysAdmin or Teacher (with permission),
**I want** to add a student record,
**so that** the student can be linked to incidents, attendance records, and referrals.

**Acceptance Criteria:**
- The add-student form shall collect: student number (unique), last name, first name, middle initial, grade level, section, school year (defaults to current school year from System Settings).
- Optional fields: guardian name, guardian contact number.
- Prohibited fields: student photo, student contact number, medical history, blood type, allergies, emergency contact — these shall not appear on the form.
- When a user submits with all required fields valid, the system shall save the record and return the user to the student list with a success message.
- When the student number already exists, the system shall reject the submission with: "Student number already exists."
- The system shall log the creation in the audit log (actor, timestamp, student number).

#### US-1.3 Student Account Linking (P1)
**As a** SysAdmin,
**I want** to link a Student user account to exactly one student record,
**so that** the Student role's own-records-only access is correctly scoped.

**Acceptance Criteria:**
- When SysAdmin approves a pending Student account, the approval form shall require selection of a matching student record by student number.
- The system shall enforce a one-to-one constraint: one student record may be linked to at most one active Student user account.
- When a Student user logs in, the system shall scope all own-records access (incident submissions, profile view) to the linked student record.
- If a Student account has no linked student record (data error), the system shall deny login and display: "Account configuration incomplete. Contact the system administrator."
- The system shall log the account-to-student-record link in the audit log at time of approval.

#### US-1.4 Search and View Student Records (P1)
**As an** authorized user,
**I want** to search for and view student records,
**so that** I can find a student's profile and access their linked records.

**Acceptance Criteria:**
- The system shall provide a search input that filters by student number, last name, or first name (case-insensitive, partial match).
- Search results shall display: student number, full name, grade level, section, school year, and status (Active / Archived).
- When a user clicks a student record they are permitted to view, the system shall display the student's profile including linked incident count, referral count, and attendance summary.
- When a user attempts to view a student record they are not permitted to access, the system shall return a 403 error.
- The system shall log every student profile view in the audit log.

#### US-1.5 Edit Student Record (P1)
**As a** SysAdmin,
**I want** to edit a student's core fields,
**so that** I can correct errors or update information.

**Acceptance Criteria:**
- When a SysAdmin edits and saves a student record, the system shall update the record and log the change in the audit log (actor, timestamp, fields changed, old values, new values).
- Teachers and Guidance users with limited permission shall be able to update section and school year only; all other fields shall be read-only for them.
- The system shall prevent editing a student's student number once linked to any incident, referral, or attendance record; the SysAdmin must archive and re-create instead.

#### US-1.6 Archive and Restore Student Record (P1)
**As a** SysAdmin,
**I want** to archive and restore student records,
**so that** inactive students are hidden from normal views without permanent deletion.

**Acceptance Criteria:**
- When a SysAdmin archives a student record, the system shall set status to `Archived` and hide the record from all standard search results.
- Archived records shall remain visible in an "Archived Records" view accessible to SysAdmin only.
- When a SysAdmin restores an archived record, the system shall set status back to `Active`.
- Every archive and restore action shall be logged in the audit log (actor, timestamp, student number, action).
- The system shall never hard-delete a student record through the UI.

#### US-1.7 Student Profile Linked Records (P1)
**As an** authorized user viewing a student profile,
**I want** to see the student's linked incidents, referrals, and attendance summary,
**so that** I have a complete picture of their records in one place.

**Acceptance Criteria:**
- The student profile page shall include three tabs or sections: Incidents, Referrals, and Attendance Summary.
- Each tab shall show only records the viewing user is permitted to see based on their role.
- When [Student role is ON] and the student views their own profile, they shall see only their own submitted incident reference numbers and statuses — no response notes, assignments, or other students' records.

---

### Module 2 — Incident Reporting and Management

#### US-2.1 Submit Incident Report (P1)
**As an** authorized reporter (SysAdmin, SchHead, Teacher, Guidance, SafetyOff, or Student when flag is ON),
**I want** to submit a safety incident report,
**so that** the incident is formally recorded and can be reviewed and acted upon.

**Acceptance Criteria:**
- The incident submission form shall collect: category (from admin-configurable list), date of incident, time of incident, location (free text + optional campus location link if Advanced Feature 3 is built), description (required, plain text), reporter name (pre-filled from session, read-only), and involved parties.
- For non-Student reporters, involved parties shall support: lookup by student number (linking to a student record) and free-text entry for non-students (e.g., "Unknown visitor").
- When [Student role is ON] and the submitter is a Student, involved parties shall be free-text entry only. No student number lookup or student search shall be available to Student submitters.
- When a user submits a valid form, the system shall generate a unique reference number (`INC-YYYY-NNNN`), set status to `Submitted`, create an in-app notification for SysAdmin and SchHead, and display a confirmation with the reference number.
- When [Student role is ON] and a Student submits, the confirmation shall display only the reference number and status; no other details shall be shown.
- The system shall reject submission if category, date, time, location, or description is missing, displaying field-level error messages.
- The system shall reject submission if the incident date is in the future (later than today in the school's configured timezone), displaying: "Incident date cannot be in the future."
- The system shall log the submission in the audit log.

#### US-2.2 Attach Files to Incident (P1)
**As an** authorized reporter,
**I want** to attach supporting files to an incident report,
**so that** relevant evidence is linked to the record.

**Acceptance Criteria:**
- The system shall accept attachments of type JPG, PNG, and PDF only.
- Maximum file size per attachment: **5 MB**. Maximum attachments per incident: **3**.
- The system shall validate file type and size on the server side; client-side validation is advisory only.
- When a file fails validation, the system shall display: "Only JPG, PNG, and PDF files are accepted" or "File exceeds the 5 MB size limit."
- Attachments shall be stored outside the public web folder and served only through an authenticated, permission-checked download endpoint.
- When an authorized user downloads an attachment, the action shall be recorded in the audit log.

#### US-2.3 Admin-Configurable Incident Categories (P1)
**As a** SysAdmin,
**I want** to manage the list of incident categories,
**so that** the school can customize categories to match its policies.

**Acceptance Criteria:**
- Default categories (seeded): Bullying/Harassment Concern, Physical Altercation, Accident, Property Damage, Security Concern, Facility Hazard.
- The system shall allow SysAdmin to add, rename, and deactivate categories.
- When a category is deactivated, existing incidents linked to it shall retain the category name; the category shall no longer appear in the submission dropdown.
- The system shall prevent deletion of a category that has linked incidents; deactivation shall be used instead.

#### US-2.4 Review and Classify Incident (P1)
**As a** SysAdmin, SchHead, or SafetyOff,
**I want** to review a submitted incident and classify its severity,
**so that** the appropriate response level is assigned.

**Acceptance Criteria:**
- When an authorized reviewer opens an incident with status `Submitted`, they shall be able to set severity (Low, Moderate, High, Critical) and transition the status to `Under Review`.
- When the status transitions to `Under Review`, the system shall add an entry to the incident activity timeline (actor, timestamp, action description).
- Severity shall be required before the incident can be assigned to response personnel.
- The system shall log the review action in the audit log.

#### US-2.5 Restricted Incident Flag (P1)
**As a** SysAdmin or SchHead,
**I want** to mark an incident as restricted,
**so that** sensitive incidents are hidden from SafetyOff and lower roles.

**Acceptance Criteria:**
- SysAdmin or SchHead shall be able to toggle a `restricted` flag on any incident.
- When an incident is marked restricted, it shall be visible only to SysAdmin and SchHead in all lists, searches, and exports; SafetyOff, Teacher, Guidance, and Student roles shall not see it.
- The restricted flag shall be displayed prominently on the incident detail view for SysAdmin and SchHead.
- Setting or clearing the restricted flag shall be logged in the audit log (actor, incident reference, old value, new value, timestamp).

#### US-2.6 View Incident List (P1)
**As an** authorized user,
**I want** to view a list of incidents filtered by status, category, and date,
**so that** I can find and monitor relevant incidents.

**Acceptance Criteria:**
- The incident list shall be filterable by: status, category, date range, and (for SysAdmin/SchHead) reporter.
- Teachers and Guidance users shall see only incidents they reported or are assigned to; restricted incidents shall never appear for these roles.
- SafetyOff users shall see all non-restricted incidents they submitted or are assigned to.
- SysAdmin and SchHead see all incidents including restricted ones.
- When [Student role is ON], students shall see only their own submissions (reference number, category, date, status — no response details).
- The list shall display: reference number, category, date, severity, status, and reporter name.
- Pagination or virtual scrolling shall be used for lists exceeding 50 records.

#### US-2.7 Archive and Restore Incident Record (P1)
**As a** SysAdmin,
**I want** to archive and restore incident records,
**so that** old or resolved incidents can be hidden from normal views without deletion.

**Acceptance Criteria:**
- SysAdmin shall be able to archive any incident (regardless of status); archiving a non-Closed incident shall require a confirmation prompt.
- When archived, the incident shall be hidden from all standard lists and searches for all roles.
- Archived incidents shall be viewable in an "Archived Incidents" view accessible to SysAdmin only.
- SysAdmin shall be able to restore an archived incident; on restore, the incident returns to its last status.
- Every archive and restore action shall be logged in the audit log.
- The system shall never hard-delete an incident record through the UI.

---

### Module 3 — Incident Response and Resolution Tracking

#### US-3.1 Assign Incident to Response Personnel (P1)
**As a** SchHead,
**I want** to assign an incident to one or more designated personnel,
**so that** responsibility for response is clearly recorded.

**Acceptance Criteria:**
- When an incident has status `Under Review`, the SchHead shall be able to assign it to one or more users with roles SafetyOff, Guidance, or Teacher.
- When the assignment is saved, the system shall transition the status to `Assigned`, notify each assigned person with an in-app notification ("You have been assigned to incident [INC-YYYY-NNNN]"), and add an entry to the incident timeline.
- The system shall log the assignment in the audit log.

#### US-3.2 Acknowledge Assignment (P1)
**As an** assigned response personnel,
**I want** to acknowledge my assignment,
**so that** the School Head knows I have received and accepted responsibility.

**Acceptance Criteria:**
- When an assigned user opens the incident and clicks "Acknowledge," the system shall record the acknowledgement timestamp and transition the status to `In Progress`.
- The timeline shall show: "[Actor] acknowledged assignment on [datetime]."
- The system shall log the acknowledgement in the audit log.

#### US-3.3 Record Response Actions (P1)
**As an** assigned response personnel or SchHead,
**I want** to record actions taken and remarks for an incident,
**so that** there is a complete chronological record of the response.

**Acceptance Criteria:**
- While an incident is `In Progress` or `For Follow-Up`, authorized users shall be able to add action entries with: action description (required), date/time of action (default now), next follow-up date (optional).
- Each entry shall be appended to the incident timeline with actor name, timestamp, and content.
- When a next follow-up date is set, the system shall schedule a reminder notification to the assigned personnel on that date.
- The system shall log each action entry in the audit log.

#### US-3.4 Incident Status Transitions (P1)
**As an** authorized user,
**I want** status transitions to follow the defined workflow,
**so that** incidents cannot skip to an invalid state.

**Acceptance Criteria:**
- The system shall enforce this state machine:
  `Submitted → Under Review → Assigned → In Progress → For Follow-Up → Resolved → Closed`
- Permitted transitions per role:

| From | To | Permitted Roles |
|------|----|-----------------|
| Submitted | Under Review | SysAdmin, SchHead, SafetyOff |
| Under Review | Assigned | SchHead |
| Assigned | In Progress | Assigned personnel (SafetyOff, Guidance, Teacher), SchHead |
| In Progress | For Follow-Up | Assigned personnel, SchHead |
| In Progress | Resolved | Assigned personnel, SchHead |
| For Follow-Up | In Progress | Assigned personnel, SchHead |
| For Follow-Up | Resolved | Assigned personnel, SchHead |
| Resolved | Closed | SchHead, SysAdmin, SafetyOff (limited) |
| Closed | (terminal) | — |

- When an unauthorized transition is attempted, the system shall return: "You do not have permission to perform this status change."
- Every status change shall be recorded in the incident timeline and audit log.

#### US-3.5 Resolution Summary Required (P1)
**As an** assigned response personnel or SchHead,
**I want** to be required to enter a resolution summary before marking an incident Resolved,
**so that** the resolution is always documented.

**Acceptance Criteria:**
- When a user attempts to transition an incident to `Resolved`, the system shall display a resolution summary field (required, plain text).
- The system shall reject the transition if the resolution summary is empty, displaying: "A resolution summary is required to mark this incident as Resolved."
- The resolution summary shall be stored on the incident record, displayed in the incident activity timeline under the Resolved entry, and included in the Response/Task Completion Summary report.

#### US-3.6 Incident Closure (P1)
**As a** SchHead or authorized SysAdmin,
**I want** to close a resolved incident,
**so that** the record is finalized with a closure summary.

**Acceptance Criteria:**
- When closing an incident, the authorized user shall provide a closure summary (required, plain text).
- When the incident is closed, the system shall record: closed by, closed datetime, closure summary; set status to `Closed`; add a final timeline entry.
- A `Closed` incident shall be read-only; no further actions or status changes shall be permitted.
- The system shall log the closure in the audit log.

#### US-3.7 Incident Activity Timeline (P1)
**As an** authorized user,
**I want** to view the complete chronological activity history of an incident,
**so that** I can see every action, status change, and note in sequence.

**Acceptance Criteria:**
- The timeline shall display all entries in chronological order: submission, review, assignments, acknowledgements, action entries, resolution summary, follow-up dates, status changes, escalations, and closure.
- Each entry shall show: actor name, role, timestamp, and entry description.
- The timeline shall be read-only and append-only; no entry shall be editable or deletable after saving.

#### US-3.8 Overdue Action Notifications (P1)
**As an** assigned personnel or SchHead,
**I want** to be notified when an incident action or follow-up is overdue,
**so that** nothing falls through the cracks.

**Acceptance Criteria:**
- When an incident has a follow-up date and that date has passed without a status update, the system shall send an in-app notification to the assigned personnel and SchHead: "Follow-up overdue for incident [INC-YYYY-NNNN] — originally due [date]."
- The overdue check shall run on the server-side polling cycle (at minimum once per hour).
- The notification shall not imply an emergency; it shall use wording such as "action pending review."

---

### Module 4 — Student Support Referral and Monitoring

#### US-4.1 Submit Support Referral (P1)
**As a** Teacher, Guidance user, SchHead, or SysAdmin,
**I want** to submit a student support referral,
**so that** the student is connected to the appropriate school support service.

**Acceptance Criteria:**
- The referral form shall collect: student (lookup by student number or name), referral type (Academic Assistance, Guidance Referral, Attendance-Related Follow-Up, Other School-Based Support), date of referral, referring person (pre-filled, read-only), administrative remarks (optional plain text, labelled "Administrative remarks only — do not record counseling notes or clinical information").
- When submitted, the system shall create the referral with status `Pending`, route it to the Guidance role queue, and send an in-app notification: "New referral submitted for [Student Number] by [Reporter Name]."
- Teachers may only submit referrals; they cannot assign or manage them unless specifically assigned.
- The system shall log the submission in the audit log.

#### US-4.2 Assign and Manage Referral (P1)
**As a** Guidance user or SchHead,
**I want** to assign a referral to a specific Guidance Counselor and manage its progress,
**so that** each referral has a clear owner and tracking history.

**Acceptance Criteria:**
- When a Guidance user or SchHead assigns a referral, the system shall record the assigned personnel and transition status to `Ongoing`.
- The system shall enforce: `Pending → Ongoing → Completed` or `Pending → Ongoing → Referred`.
- When an unauthorized transition is attempted, the system shall reject it with an error message.
- Every status change shall be logged in the audit log.

#### US-4.3 Record Follow-Up Activity (P1)
**As an** assigned Guidance user or Teacher (if assigned),
**I want** to record follow-up activities for a referral,
**so that** there is a documented record of what support was provided.

**Acceptance Criteria:**
- While a referral is `Ongoing`, authorized users shall be able to add follow-up entries with: activity description (required), date of activity, next follow-up date (optional).
- The system shall not include fields for diagnosis, clinical assessment, therapy session notes, or counseling content.
- When a next follow-up date is set, the system shall schedule a reminder notification.
- The system shall log each follow-up entry in the audit log.

#### US-4.4 Complete or Further-Refer a Referral (P1)
**As a** Guidance user,
**I want** to mark a referral as completed or further-referred,
**so that** the final disposition is recorded.

**Acceptance Criteria:**
- When marking `Completed`, the user shall provide a completion note (plain text, required, same field-labelling restriction as remarks).
- When marking `Referred`, the user shall indicate the destination (e.g., "Referred to external agency") with no clinical detail required.
- A `Completed` or `Referred` referral shall be read-only; no further follow-ups shall be addable.
- The system shall log the final status change in the audit log.

#### US-4.5 Archive and Restore Referral Record (P1)
**As a** SysAdmin,
**I want** to archive and restore referral records,
**so that** old or completed referrals can be hidden from normal views without deletion.

**Acceptance Criteria:**
- SysAdmin shall be able to archive any referral; archiving an `Ongoing` referral shall require a confirmation prompt.
- When archived, the referral shall be hidden from all standard lists for all roles.
- Archived referrals shall be viewable in an "Archived Referrals" view accessible to SysAdmin only.
- SysAdmin shall be able to restore an archived referral; on restore, the referral returns to its last status.
- Every archive and restore action shall be logged in the audit log.
- The system shall never hard-delete a referral record through the UI.

---

### Module 5 — Student Attendance Monitoring

#### US-5.1 Record Attendance (P1)
**As a** Teacher (primary) or Guidance/SchHead (limited),
**I want** to record attendance for my assigned class,
**so that** daily attendance is captured accurately.

**Acceptance Criteria:**
- The system shall allow attendance to be recorded once per day per student per class.
- Attendance statuses shall be: Present, Absent, Tardy.
- The class list for a Teacher shall show only students in their assigned class(es) for the current school year and semester (defaults from System Settings).
- When a Teacher submits attendance for a class on a given date, the system shall save all records and display a confirmation.
- When attendance has already been recorded for a class on a given date, the system shall display the existing records and allow Teacher correction on the same calendar day in the school's configured timezone (from System Settings). SysAdmin and SchHead may correct at any time.
- The system shall log attendance submission in the audit log.

#### US-5.2 Attendance Correction (P1)
**As a** Teacher (within edit window), SysAdmin, or SchHead (after edit window),
**I want** to correct an attendance record with a mandatory reason,
**so that** every change is documented and attributable.

**Acceptance Criteria:**
- Any correction to an attendance record shall require a reason field (plain text, required; e.g., "Clerical error — student was present").
- When a Teacher corrects within the same-day edit window, the system shall save the correction and log: actor, old status, new status, reason, timestamp, student number, class, date.
- When SysAdmin or SchHead corrects after the edit window has closed, the system shall allow the correction with the same mandatory reason field and the same audit log entry.
- No other role shall be able to correct attendance after the edit window closes.
- The correction reason shall be visible in the attendance record detail view for SysAdmin and SchHead.

#### US-5.3 Archive and Restore Attendance Records (P1)
**As a** SysAdmin,
**I want** to archive and restore attendance records by class and semester,
**so that** historical records are preserved but hidden from active views.

**Acceptance Criteria:**
- SysAdmin shall be able to archive all attendance records for a specific class and semester.
- When archived, those records shall be hidden from all standard attendance views and summaries.
- Archived attendance records shall be viewable in an "Archived Attendance" view accessible to SysAdmin only.
- SysAdmin shall be able to restore an archived set of attendance records.
- Every archive and restore action shall be logged in the audit log.
- The system shall never hard-delete attendance records through the UI.

#### US-5.4 View Attendance Summary (P1)
**As an** authorized user,
**I want** to view attendance summaries filtered by student, class, section, and date range,
**so that** I can monitor patterns and generate reports.

**Acceptance Criteria:**
- The attendance summary shall be filterable by: student, class, section, semester, school year, date range, and status (Absent / Tardy).
- The summary shall display: total school days, present count, absent count, tardy count, and attendance percentage per student.
- Teachers shall see summaries for their assigned classes only.
- Guidance and SchHead shall see summaries for all classes.
- The system shall log access to attendance summaries in the audit log.

#### US-5.5 Attendance Threshold Flagging (P1)
**As a** SysAdmin,
**I want** to configure absence and tardy count thresholds,
**so that** class advisers are notified for human review when a student exceeds them.

**Acceptance Criteria:**
- The system shall support a configurable school-wide default threshold (e.g., 3 absences in the semester, 5 tardies in the semester).
- SysAdmin shall be able to set an optional override threshold per class.
- When a student's absence or tardy count reaches the threshold, the system shall send an in-app notification to the class adviser: "Student [Name, Student No.] has reached the attendance threshold for review. Please review and determine if follow-up is needed."
- The notification wording shall never state or imply a safety or welfare issue.
- The class adviser decides independently whether to create a support referral. The system shall not automatically create a referral.
- Guidance users shall be notified only when a referral is explicitly submitted; not by the threshold trigger.
- The threshold notification shall be logged in the audit log.

#### US-5.6 Semester Attendance Report (P2)
**As an** authorized user,
**I want** to generate a semester attendance report,
**so that** I can export a summary for review or records.

**Acceptance Criteria:**
- The report shall be filterable by semester, school year, section, and class.
- The report shall be exportable as CSV or PDF.
- The export shall respect the requesting user's role permissions (Teachers see their classes only).
- Every export shall be logged in the audit log.

---

### Module 6 — Personnel, Notifications, Dashboard, and Reports

#### US-6.1 Account Management (P1)
**As a** SysAdmin,
**I want** to manage all user accounts,
**so that** only authorized personnel can access the system.

**Acceptance Criteria:**
- The SysAdmin shall be able to view all accounts with status (Pending, Active, Inactive, Rejected).
- When a new signup is pending, the SysAdmin shall see it with "Approve" or "Reject" actions.
- When SysAdmin approves a pending account, the system shall set status to `Active` and send an in-app notification to the user: "Your account has been approved. You may now sign in."
- For Student role approvals, the system shall require linking to a student record per US-1.3 before approval can complete.
- When SysAdmin rejects an account, the system shall set status to `Rejected` and optionally add a reason.
- SysAdmin shall be able to deactivate an Active account; existing sessions shall be invalidated immediately.
- SysAdmin shall be able to reactivate an Inactive account.
- The system shall log all account status changes in the audit log.

#### US-6.2 Role and Permission Management (P1)
**As a** SysAdmin,
**I want** to manage roles and permissions in the database,
**so that** the school can adjust access levels without code changes.

**Acceptance Criteria:**
- The system shall seed the default roles and permissions from the RBAC matrix in this document.
- SysAdmin shall be able to view the current permissions for each role.
- SysAdmin shall be able to toggle individual permissions for a role on or off.
- When a permission is changed, it shall take effect on the next API request by any user with that role.
- The system shall log all permission changes in the audit log with old and new values.
- The system shall prevent removing SysAdmin's own `manage_accounts` and `manage_roles_permissions` permissions.

#### US-6.3 Password Reset (P1)
**As a** SysAdmin,
**I want** to issue a temporary password for a user,
**so that** the user can regain access when they cannot log in.

**Acceptance Criteria:**
- When SysAdmin issues a temporary password, the system shall hash and store it, flag `password_reset_required = true`, and display the temporary password to the SysAdmin once only (plaintext, copy-able, not stored after display).
- When the affected user logs in with the temporary password, the system shall force a password-change screen before granting dashboard access.
- The forced password-change form shall enforce the same password policy (min 8 chars, uppercase, lowercase, number).
- After the password is changed, the flag shall be cleared and the session established normally.
- The reset action and subsequent password change shall be logged in the audit log.

#### US-6.4 Personnel Participation History (P1)
**As a** SysAdmin or SchHead,
**I want** to view a per-staff history of their activity,
**so that** I can see each personnel member's contribution to incidents, referrals, attendance, and task completion.

**Acceptance Criteria:**
- The personnel participation view shall be accessible to SysAdmin (all staff) and SchHead (all staff).
- For each staff member, the view shall display:
  - Incidents reported (count and list of reference numbers).
  - Assigned incidents handled (count, incident references, and their current status).
  - Referrals submitted (count and referral IDs).
  - Referrals assigned and managed (count, referral IDs, status).
  - Attendance records submitted (count, classes, date range).
  - Tasks/actions completed on incidents (count and incident references).
- The view shall be filterable by date range (defaults to current semester from System Settings).
- Data shall be built from existing incident, referral, attendance, and audit records; no separate participation table is required.
- The system shall log access to the personnel participation view in the audit log.

#### US-6.5 In-App Notifications (P1)
**As an** authorized user,
**I want** to receive in-app notifications about assignments, pending items, and alerts,
**so that** I am informed without leaving the system.

**Acceptance Criteria:**
- The system shall display an unread notification count badge in the topbar, updated by polling every 30 seconds.
- Notification types: New Assignment, Pending Incident, Follow-Up Reminder, Overdue Action, Escalated, Emergency Alert, Account Approval, System Notice.
- Emergency Alert notifications shall be visually distinct (red border, warning icon) and include: "This is an in-system alert. Do not delay official emergency procedures."
- When a user clicks a notification, the system shall mark it as read and navigate to the relevant record if applicable.
- The system shall provide a "Mark all as read" action.
- Notifications shall be stored in the database and persist across sessions.
- The notification polling endpoint shall require authentication and shall not expose other users' notifications.

#### US-6.6 Emergency Alert (P1)
**As a** SysAdmin, SchHead, Teacher, Guidance, or SafetyOff,
**I want** to send an Emergency Alert notification to all authorized staff,
**so that** everyone is informed of an on-campus emergency quickly.

**Acceptance Criteria:**
- The Emergency Alert feature shall be accessible from a prominent location in the dashboard (e.g., top navigation).
- When an authorized user triggers an Emergency Alert, the system shall create a notification of type `Emergency Alert` for all users with roles SysAdmin, SchHead, Teacher, Guidance, and SafetyOff (configurable by SysAdmin).
- The alert shall include: alert message (required, free text), sender name, and timestamp.
- The alert shall appear as unread for all recipients; polling shall surface it within 30 seconds.
- Every Emergency Alert sent shall be logged in the audit log.
- The UI shall display, adjacent to the Emergency Alert button: "Sending this alert does not replace official emergency procedures. Contact emergency services directly."

#### US-6.7 Administrative Dashboard (P1)
**As an** authorized user,
**I want** a dashboard summarizing key metrics for my role,
**so that** I can monitor the system status at a glance.

**Acceptance Criteria:**
- Dashboard defaults (school year, semester) shall come from System Settings.
- SysAdmin and SchHead shall see: total students, open incidents by status, pending incidents by category, pending referrals, attendance rate (current semester), pending user accounts.
- Teacher shall see: their class attendance summary (current semester), incidents they reported (open/closed counts), referrals they submitted.
- Guidance shall see: referrals assigned to them (by status), follow-ups due today/this week.
- SafetyOff shall see: open incidents assigned to them, overdue follow-ups.
- Dashboard data shall be view-only; no exports from the dashboard view itself.
- Dashboard summaries shall reflect only records the user is permitted to access.

#### US-6.8 Reports and CSV/PDF Export (P1)
**As an** authorized user,
**I want** to generate and export reports,
**so that** I can share or archive data outside the system.

**Acceptance Criteria:**
- The system shall support export of exactly these reports:
  1. **Incident Summary** — reference number, category, date, severity, status, reporter, assigned personnel; filterable by date range, category, status.
  2. **Response/Task Completion Summary** — incident reference, resolution summary, action count, last action date, resolution date, closed by.
  3. **Attendance Summary** — student, class, section, semester, absent count, tardy count, present count, percentage; filterable by semester, section, date range.
  4. **Referral Summary** — referral count by type and status (no student names or sensitive details in counts export); SysAdmin/SchHead may export with student numbers included.
  5. **Audit Log** — actor, action type, target, timestamp, old/new values; accessible to SysAdmin and authorized SchHead.
- Export formats: CSV and PDF.
- Every export action shall be recorded in the audit log (user, report type, filters applied, timestamp).
- Export endpoints shall enforce role permissions. Teachers may only export their own-class Attendance Summary and the Referral Summary (counts only, no student identifiers). Attempting to export Incident Summary, Response Summary, or Audit Log returns 403.

#### US-6.9 Audit Logging (P1)
**As a** SysAdmin,
**I want** a complete, tamper-visible audit log of important actions,
**so that** I can investigate issues and demonstrate accountability.

**Acceptance Criteria:**
- The system shall record the following events: logins/logouts (including session expirations), failed login attempts, role/permission changes, account status changes, student record create/edit/archive/restore, incident submit/review/assign/restrict/action/resolve/close/archive/restore, referral submit/assign/complete/archive/restore, attendance submit/correct/archive/restore, attachment download, report export, emergency alert sent, escalation triggered, password reset, system settings changes.
- Each log entry shall include: actor user ID and name, role at time of action, action type, target entity (table + record ID), timestamp, and relevant old/new values.
- Audit log entries shall be append-only; no UI shall allow editing or deleting them.
- The audit log shall be viewable by SysAdmin (all entries) and SchHead (authorized subset: incidents, referrals, closures, exports — not account management or permission changes).
- The audit log view shall be filterable by date range, actor, and action type.

#### US-6.10 Data Retention Configuration (P1)
**As a** SysAdmin,
**I want** to configure a data retention period,
**so that** records older than the threshold are flagged for archive review in compliance with the school's data protection policy.

**Acceptance Criteria:**
- SysAdmin shall be able to set a retention period (in years) for each record type: incidents, referrals, attendance records (default: 5 years; to be confirmed with the school's Data Protection Officer).
- When records reach the configured retention age, the system shall flag them as "Eligible for Archive Review" — visible to SysAdmin in a dedicated review list.
- The system shall never automatically delete or hard-archive records based on retention rules; all archiving requires explicit SysAdmin action.
- The retention review list shall show record type, record ID/reference, creation date, and age in years.
- SysAdmin may archive or leave flagged records from the review list; every action shall be logged in the audit log.
- The UI shall display the note: "Retention periods should be confirmed with your school's Data Protection Officer before configuration."

---

### Advanced Feature 1 — Automated Response Escalation (P2)

#### US-AF1.1 Configure Escalation Rules (P2)
**As a** SysAdmin,
**I want** to configure escalation rules by incident priority and status,
**so that** incidents that remain unresolved past a time target automatically escalate.

**Acceptance Criteria:**
- The escalation rule form shall collect: incident severity (Low/Moderate/High/Critical), status to watch (In Progress, For Follow-Up), time target (hours), escalation contact (default: SchHead; configurable to any active SysAdmin/SchHead user).
- The system shall allow multiple rules (e.g., Critical + In Progress → 2 hours; High + For Follow-Up → 24 hours).
- Rules shall be storable and editable by SysAdmin.
- For testing, the system shall allow time targets as short as 1 minute.

#### US-AF1.2 Automated Escalation Check (P2)
**As a** SysAdmin or SchHead,
**I want** the system to automatically detect overdue incidents and escalate them,
**so that** unresolved high-priority incidents are not silently ignored.

**Acceptance Criteria:**
- A scheduled server-side job shall run at a configurable interval (default: every 15 minutes).
- When an incident matches a rule's severity and status and has not had a status change within the rule's time target, the system shall: create an `Escalated` notification for the configured escalation contact; add an escalation entry to the incident timeline; and log the escalation in the audit log.
- The escalation notification shall be visually distinct (orange border, escalation icon).
- An incident shall not be escalated more than once per rule per status cycle.
- The feature must be demonstrable by setting a 1-minute timeout and showing the escalation fires.

---

### Advanced Feature 2 — Incident Hotspot and Trend Analysis (P2)

#### US-AF2.1 Hotspot and Trend Dashboard (P2)
**As a** SysAdmin or SchHead,
**I want** to see incident frequency summarized by location, category, and time period,
**so that** I can identify patterns and allocate resources accordingly.

**Acceptance Criteria:**
- The dashboard shall provide: a bar chart of incidents by category for a selected period; a line chart of incident counts over time (daily, weekly, monthly, semester); a table of top locations by incident count.
- Filters shall include: date range, category, and location.
- Chart data shall be computed from aggregate queries against the incident table; results shall be verifiable by counting matching records manually.
- Chart library shall be lightweight and vanilla-JS compatible (e.g., Chart.js via CDN).
- The analysis view shall be accessible to SysAdmin, SchHead, and (read-only) SafetyOff.

---

### Advanced Feature 3 — Simplified Campus Incident Mapping (P3)

#### US-AF3.1 Campus Location Management (P3)
**As a** SysAdmin,
**I want** to manage a list of campus locations linked to the floor plan image,
**so that** incidents can be tagged to specific campus areas.

**Acceptance Criteria:**
- SysAdmin shall be able to add, rename, and deactivate campus locations (e.g., "Main Building — Room 101", "Gymnasium", "Corridor B").
- Each location shall have: name, description, and optional coordinates (x%, y%) relative to the campus image for marker placement.
- The system shall use the existing `blueprint.svg` or `facility-map.svg`; no external GIS or map services.

#### US-AF3.2 Campus Map View (P3)
**As an** authorized user,
**I want** to see incident markers on the campus map,
**so that** I can visualize where incidents are occurring.

**Acceptance Criteria:**
- The map shall display a marker for each campus location that has at least one linked, non-restricted, non-archived incident in the selected filter range.
- Markers shall be color-coded by incident volume (green = 1–2, yellow = 3–5, red = 6+) showing anonymized counts only.
- Filters shall include: category and date range.
- When a user clicks a marker, the system shall show: location name, total incident count, and list of reference numbers, categories, and statuses.
- Full incident details (description, response notes) shall be accessible only to SysAdmin, SchHead, and SafetyOff with review permission; Teacher and Guidance roles shall see counts and reference numbers only.
- The map view shall be accessible to: SysAdmin (full), SchHead (full), Teacher (counts only), Guidance (counts only), SafetyOff (full).

#### US-AF3.3 Fallback — Enhanced Incident Timeline and Audit Trail View (P3-Fallback)
*Build this if the campus map cannot be completed within the capstone timeline.*

**As a** SysAdmin or SchHead,
**I want** an enhanced timeline/audit trail view for all incidents,
**so that** I can review the complete history across incidents with filtering.

**Acceptance Criteria:**
- The view shall display a unified, chronological list of all incident activity entries across all incidents.
- Filters shall include: incident reference number, actor, action type, date range, and status.
- Each entry shall show: incident reference, actor, action, timestamp, and status at time of action.
- The view shall be paginated or virtually scrolled for performance.

---

## RBAC Permission Matrix

The following 23 permissions are seeded into the database (see `design.md §2.6` for the authoritative codes list). SysAdmin may adjust permissions per role through the UI.

| Permission | SysAdmin | SchHead | Teacher | Guidance | SafetyOff | Student |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| manage_accounts | ✓ | — | — | — | — | — |
| manage_roles_permissions | ✓ | — | — | — | — | — |
| manage_classes | ✓ | — | — | — | — | — |
| manage_student_records | ✓ | ○ | ○ | ○ | ○ | — |
| view_own_student_profile | ✓ | ✓ | ✓ | ✓ | ○ | own |
| submit_incident | ✓ | ✓ | ✓ | ✓ | ✓ | opt |
| review_incident | ✓ | ✓ | ○ | ○ | ✓ | own |
| restrict_incident | ✓ | ✓ | — | — | — | — |
| assign_incident | — | ✓ | — | — | — | — |
| update_response_status | ○ | ✓ | ○ | ○ | ✓ | — |
| approve_incident_closure | ○ | ✓ | — | — | ○ | — |
| archive_records | ✓ | — | — | — | — | — |
| record_attendance | ○ | ○ | ✓ | ○ | — | — |
| correct_attendance_post_window | ✓ | ✓ | — | — | — | — |
| manage_referrals | ○ | ○ | refer | ✓ | — | — |
| update_referral_followups | — | ○ | assigned | ✓ | — | — |
| view_dashboard | ✓ | ✓ | limited | limited | limited | — |
| view_campus_map | ✓ | ✓ | limited | limited | ✓ | — |
| view_audit_log | ✓ | auth | — | restricted | restricted | — |
| send_emergency_alert | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| export_reports | ✓ | ✓ | limited | limited | limited | — |
| configure_system | ✓ | — | — | — | — | — |
| view_personnel_history | ✓ | ✓ | — | — | — | — |

Legend: ✓ = full; ○ = limited/assigned records; opt = optional config flag; own = own records only; auth = authorized subset; limited = role-scoped; refer = submit only; assigned = assigned records only; restricted = restricted subset; — = no access.

> The `view_campus_map` permission applies only if Advanced Feature 3 is implemented; otherwise the row is hidden from the permissions UI.

---

## Workflow Summaries

### Workflow A — Incident Lifecycle
1. Authorized reporter submits incident → reference number generated → status: `Submitted` → SysAdmin/SchHead notified.
2. SysAdmin/SchHead/SafetyOff reviews → sets severity → status: `Under Review`.
3. SchHead assigns to personnel → status: `Assigned` → assigned personnel notified.
4. Assigned personnel acknowledges → status: `In Progress`.
5. Personnel records actions and remarks → optional follow-up date set → reminders sent.
6. If follow-up needed: status → `For Follow-Up` → further actions recorded.
7. Personnel enters resolution summary → status: `Resolved`.
8. SchHead (or authorized) reviews and closes with closure summary → status: `Closed`.
9. *(If Advanced Feature 1 active)*: Escalation rule triggers if any step stalls beyond the time target.

### Workflow B — Referral Lifecycle
1. Teacher (or other authorized role) submits referral → status: `Pending` → Guidance role notified.
2. Guidance assigns to specific counselor → status: `Ongoing`.
3. Assigned counselor records follow-up activities (no clinical detail).
4. Counselor marks `Completed` (service concluded) or `Referred` (further escalation documented).

### Workflow C — Attendance Concern
1. Teacher records daily attendance for class (defaults to current semester).
2. System updates semester attendance summaries.
3. If absence/tardy count reaches configured threshold → class adviser notified for review.
4. Class adviser reviews independently and decides whether to create a support referral.
5. If referral created → Guidance notified → Workflow B begins.

---

## Exclusions (Do Not Build)

- Medical diagnosis, clinical records, or laboratory results.
- Psychological assessment, therapy session notes, or confidential counseling content.
- External emergency dispatch, police/law enforcement integration, or automated evacuation routing.
- Automated disciplinary decisions or automated welfare judgments about students.
- Enrollment processing, grading, tuition, payroll, or learning management features.
- Parent/Guardian portal or any outbound messaging to guardians.
- SMS or email notifications (email reset deferred to a future phase).
- AI-assisted analysis, recommendations, or predictions.
- Integration with external school information systems.
- Attendance pattern analytics beyond the configurable threshold flag.
- Multi-school deployment.

---

*End of requirements.md — v1.1*
