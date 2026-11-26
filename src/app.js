'use strict';

const express = require('express');
const helmet = require('helmet');
const path = require('path');
const cookieParser = require('cookie-parser');
const session = require('express-session');

const { COOKIE_SECURE, SESSION_SECRET } = require('./config');
const SQLiteStore = require('./middleware/sessionStore');

require('./repositories/db');

const app = express();

// Security headers, including CSP (T-17B). Everything is served from 'self':
// scripts and styles are files under public/ (no inline <script>, style= or
// on*= handlers), fonts are vendored under public/vendor/fontawesome, and
// img-src allows data: only for the SVG pattern inlined in styles.css.
// Attachment downloads replace this with their own stricter policy.
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        scriptSrcAttr: ["'none'"],
        styleSrc: ["'self'"],
        // Only over HTTPS: on plain-HTTP LAN installs this would break every asset load.
        ...(COOKIE_SECURE ? { upgradeInsecureRequests: [] } : {}),
      },
    },
  })
);

// Parse JSON and URL-encoded bodies
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Cookie parser (must come before session)
app.use(cookieParser());

// Session middleware backed by SQLite store
app.use(session({
  store: new SQLiteStore(),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'strict',
    secure: COOKIE_SECURE,
    maxAge: 8 * 60 * 60 * 1000, // 8 hours absolute max (overridden by idle logic)
  },
}));

// Serve static files from public/
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------------------------------------------------------------------------
// CSRF Protection
// ---------------------------------------------------------------------------
const { doubleCsrfProtection, generateCsrfToken } = require('./middleware/csrf');

// CSRF token dispenser — must be registered BEFORE the doubleCsrfProtection middleware
// (GET is ignored by csrf-csrf, but explicit placement makes the intent clear)
app.get('/api/csrf-token', (req, res) => {
  res.json({ csrfToken: generateCsrfToken(req, res) });
});

// Public config — no auth required; must be before doubleCsrfProtection block
const { getSettings } = require('./services/settings.service');
app.get('/api/public/config', (req, res) => {
  const settings = getSettings(['student_feature_enabled', 'school_name']);
  res.json({
    student_feature_enabled: settings.student_feature_enabled ?? '0',
    school_name: settings.school_name ?? '',
  });
});

// Apply CSRF protection to all /api routes; csrf-csrf automatically skips GET/HEAD/OPTIONS
app.use('/api', doubleCsrfProtection);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
const authRoutes = require('./routes/auth.routes');
app.use('/api/auth', authRoutes);

const auditRoutes = require('./routes/audit.routes');
app.use('/api/audit-logs', auditRoutes);

const notificationRoutes = require('./routes/notification.routes');
app.use('/api/notifications', notificationRoutes);

const userRoutes = require('./routes/user.routes');
app.use('/api/users', userRoutes);

const roleRoutes = require('./routes/role.routes');
app.use('/api/roles', roleRoutes);

const settingsRoutes = require('./routes/settings.routes');
app.use('/api/settings', settingsRoutes);

const studentRoutes = require('./routes/student.routes');
app.use('/api/students', studentRoutes);

const classRoutes = require('./routes/class.routes');
app.use('/api/classes', classRoutes);

const incidentCategoryRoutes = require('./routes/incident-category.routes');
app.use('/api/incident-categories', incidentCategoryRoutes);

const campusLocationRoutes = require('./routes/campus-location.routes');
app.use('/api/campus-locations', campusLocationRoutes);

const incidentRoutes = require('./routes/incident.routes');
app.use('/api/incidents', incidentRoutes);

// POST /api/incidents/:id/attachments and GET /api/attachments/:id/download
const attachmentRoutes = require('./routes/attachment.routes');
app.use('/api', attachmentRoutes);

const referralRoutes = require('./routes/referral.routes');
app.use('/api/referrals', referralRoutes);

const attendanceRoutes = require('./routes/attendance.routes');
app.use('/api/attendance', attendanceRoutes);

const dashboardRoutes = require('./routes/dashboard.routes');
app.use('/api/dashboard', dashboardRoutes);

const reportRoutes = require('./routes/report.routes');
app.use('/api/reports', reportRoutes);

const retentionRoutes = require('./routes/retention.routes');
app.use('/api/retention', retentionRoutes);

const escalationRuleRoutes = require('./routes/escalation-rule.routes');
app.use('/api/escalation-rules', escalationRuleRoutes);

const trendsRoutes = require('./routes/trends.routes');
app.use('/api/trends', trendsRoutes);

module.exports = app;
