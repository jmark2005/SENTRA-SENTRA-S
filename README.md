# S.E.N.T.R.A.

**School Emergency and Notification Tracking, Reporting, and Action System**

An integrated school safety and student support monitoring system built on Node.js / Express + SQLite.

Developed by **Global Solutions INC.**
Version 1.0 | 2026

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Setup](#setup)
3. [Environment Variables](#environment-variables)
4. [Running the Server](#running-the-server)
5. [User Roles](#user-roles)
6. [Modules](#modules)
7. [Backup Procedure](#backup-procedure)
8. [Restore Procedure](#restore-procedure)
9. [HTTPS vs LAN HTTP (COOKIE_SECURE)](#https-vs-lan-http-cookie_secure)
10. [Project Structure](#project-structure)

---

## Prerequisites

| Requirement | Version |
|-------------|---------|
| Node.js | **20 LTS** (required) |
| npm | 10+ (bundled with Node 20) |
| Operating System | Windows, macOS, or Linux |

> **Windows LAN servers:** `better-sqlite3` requires a native build step. If the install fails, ensure you have the Visual Studio C++ Build Tools installed, or use `npm install --ignore-scripts` and switch to a pre-built binary.

---

## Setup

Run these commands from the project root (`SENTRA-SENTRA-S/`):

```bash
# 1. Install dependencies
npm install

# 2. Create your local environment file
cp .env.example .env
#    Then edit .env and set a strong SESSION_SECRET (see Environment Variables below)

# 3. Run database migrations and seed initial data
npm run seed
#    The seed script will print:
#    "SENTRA seed complete. Temporary SysAdmin password: XXXXXXXXXXXX
#     Change this password immediately after first login. This message will not be shown again."
#    Copy this password — it is shown only once.

# 4. Start the server
npm start
```

Open your browser to `http://localhost:3000` (or the port you set in `.env`).

Log in as **System Admin** using the temporary password printed by the seed script. You will be forced to set a new password on first login.

---

## Environment Variables

Copy `.env.example` to `.env` and edit the values:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | TCP port the Express server listens on. |
| `DB_PATH` | `./db/sentra.db` | Path to the SQLite database file. Use an absolute path for production. |
| `COOKIE_SECURE` | `false` | Set to `true` when running over HTTPS. Set to `false` for LAN HTTP (development/demo). **Never hardcode in source.** |
| `SESSION_SECRET` | *(placeholder)* | Secret used to sign the session cookie. **Must be replaced with a cryptographically random string of 32+ characters before any non-demo deployment.** Generate one with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |

> `.env` is listed in `.gitignore` and will never be committed. Never commit real credentials.

---

## Running the Server

| Command | Description |
|---------|-------------|
| `npm start` | Start the production server (`node src/server.js`) |
| `npm run dev` | Start with auto-reload for development (`nodemon src/server.js`) |
| `npm run seed` | Run the database seed script (idempotent — safe to run multiple times) |
| `npm test` | Run the automated test suite |

---

## User Roles

| Role | Description |
|------|-------------|
| System Administrator | Full system access — accounts, roles, settings, audit logs |
| School Head | Oversees incidents, assigns personnel, views all dashboards |
| Teacher / Class Adviser | Submits incident reports, records attendance, submits referrals |
| Guidance Counselor | Manages referrals, follow-ups, reviews incidents |
| Safety Officer | Submits and responds to incidents, updates response status |
| Student *(optional)* | Submits safety concerns; views own submissions only. Disabled by default — enable in System Settings |

---

## Modules

| Module | Description |
|--------|-------------|
| Student Information Management | Student records, class assignments, account linking |
| Incident Reporting and Management | Submit, classify, restrict, and archive safety incidents |
| Incident Response and Resolution | Assign personnel, track actions, resolve and close incidents |
| Referral Management | Student support referrals, follow-ups, completion tracking |
| Attendance Monitoring | Daily attendance recording, corrections, threshold flagging |
| Dashboards and Reports | Role-scoped summaries, trend charts, PDF/CSV exports |

---

## Backup Procedure

SENTRA uses SQLite in **WAL (Write-Ahead Logging) mode**. This means the live database consists of three files:

| File | Purpose |
|------|---------|
| `db/sentra.db` | Main database file |
| `db/sentra.db-wal` | Write-ahead log (may contain uncommitted data) |
| `db/sentra.db-shm` | Shared memory file (can be omitted if server is stopped) |

### Recommended: Online Backup via `better-sqlite3` Backup API

The safest method while the server is running. Create `db/backup.js`:

```javascript
'use strict';
const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

const srcPath  = process.env.DB_PATH || './db/sentra.db';
const backupDir = process.env.BACKUP_DIR || './db/backups';
const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const destPath  = path.join(backupDir, `sentra-backup-${timestamp}.db`);

fs.mkdirSync(backupDir, { recursive: true });

const src = new Database(srcPath, { readonly: true });
src.backup(destPath)
   .then(() => { console.log(`Backup complete: ${destPath}`); src.close(); })
   .catch(err => { console.error('Backup failed:', err.message); src.close(); process.exit(1); });
```

Run it with:

```bash
node db/backup.js
```

The `.backup()` API uses the [SQLite Online Backup API](https://www.sqlite.org/backup.html) — it produces a consistent, fully checkpointed snapshot even while the server is writing.

### Alternative: File Copy (Server Stopped)

If you stop the server first, copy all three files together:

```bash
# Windows (PowerShell)
$ts = Get-Date -Format "yyyy-MM-dd_HH-mm"
Copy-Item db\sentra.db      "db\backups\sentra-$ts.db"
Copy-Item db\sentra.db-wal  "db\backups\sentra-$ts.db-wal"  -ErrorAction SilentlyContinue
Copy-Item db\sentra.db-shm  "db\backups\sentra-$ts.db-shm"  -ErrorAction SilentlyContinue
```

```bash
# Linux / macOS
ts=$(date +%Y-%m-%d_%H-%M)
mkdir -p db/backups
cp db/sentra.db     db/backups/sentra-$ts.db
cp db/sentra.db-wal db/backups/sentra-$ts.db-wal 2>/dev/null || true
cp db/sentra.db-shm db/backups/sentra-$ts.db-shm 2>/dev/null || true
```

> **Important:** Always copy `.db` and `.db-wal` together. Copying only `.db` while WAL mode is active may produce an incomplete snapshot.

### Schedule Notes

- **Recommended frequency:** Daily, before business hours (e.g., 06:00 school time).
- **Retention:** Keep at least 7 daily backups; archive weekly snapshots for the duration of the retention period configured in System Settings (default 5 years).
- **Storage location:** Copy backups to a separate physical drive or network share. Do not store backups only on the same machine as the database.
- **Windows Task Scheduler:** Create a Basic Task → Action: `node C:\path\to\SENTRA-SENTRA-S\db\backup.js`. Set trigger to Daily at 06:00.
- **Linux/macOS cron:** `0 6 * * * cd /path/to/SENTRA-SENTRA-S && node db/backup.js >> /var/log/sentra-backup.log 2>&1`

---

## Restore Procedure

To restore from a backup produced by the `.backup()` API or a file copy:

1. **Stop the server.**
2. Replace `db/sentra.db` with the backup file.
3. If restoring a file-copy backup, also restore the matching `.db-wal` file (if present). If only `.db` is available, that is acceptable — WAL mode will recreate `.db-wal` on next open.
4. **Start the server.**

```bash
# Example (Windows PowerShell)
Stop-Process -Name "node" -Force          # or use Ctrl+C on the server terminal
Copy-Item "db\backups\sentra-2026-11-25.db" "db\sentra.db" -Force
npm start
```

> Never restore to a running server — always stop first to avoid database corruption.

---

## HTTPS vs LAN HTTP (`COOKIE_SECURE`)

SENTRA is designed to run on a school LAN without HTTPS for demo/capstone use, and to run over HTTPS in production. The `COOKIE_SECURE` environment variable controls session and CSRF cookie security:

| Scenario | `COOKIE_SECURE` value | Effect |
|----------|-----------------------|--------|
| LAN HTTP (demo / development) | `false` | Session and CSRF cookies are sent over HTTP. `__Host-` prefix is omitted from CSRF cookie name. |
| HTTPS (production) | `true` | Cookies include the `Secure` attribute and are only sent over HTTPS. CSRF cookie uses the `__Host-` prefix for extra security. |

**Never set `COOKIE_SECURE=true` on a plain HTTP server** — browsers will not send the Secure cookie back and all sessions will fail.

**Never hardcode this value** — always control it via `.env`.

---

## Project Structure

```
SENTRA-SENTRA-S/
├── db/
│   ├── backups/           ← backup files (not committed)
│   ├── migrations/        ← versioned SQL migration files
│   │   └── 001_core_schema.sql
│   ├── seeds/
│   │   └── seed.js        ← initial data seed (idempotent)
│   └── sentra.db          ← SQLite database (not committed)
├── public/                ← static frontend (HTML, CSS, JS)
│   ├── vendor/            ← vendored Font Awesome, Chart.js
│   ├── js/                ← frontend JavaScript modules
│   ├── tokens.css         ← CSS design tokens
│   ├── styles.css         ← global styles
│   └── responsive.css     ← responsive layout (T-45)
├── src/
│   ├── app.js             ← Express app (middleware, routes)
│   ├── server.js          ← HTTP server entry point
│   ├── config.js          ← environment config helper
│   ├── jobs/              ← scheduled jobs (reminders, escalation)
│   ├── middleware/        ← auth, RBAC, CSRF middleware
│   ├── repositories/      ← database access layer
│   ├── routes/            ← Express route handlers
│   └── services/          ← business logic services
├── uploads/               ← attachment files (not committed)
├── .env                   ← local environment (not committed)
├── .env.example           ← environment variable template
├── .gitignore
├── package.json
└── README.md
```

---

## Disclaimer

> **Important:** Software priority labels and notifications in SENTRA must never delay official emergency procedures. SENTRA supports school-level coordination only and does not replace professional counseling, official emergency services, or school policies.

---

*S.E.N.T.R.A. — Developed by Global Solutions INC. | Version 1.0 | 2026*
