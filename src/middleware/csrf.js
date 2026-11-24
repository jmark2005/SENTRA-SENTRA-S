'use strict';

const { doubleCsrf } = require('csrf-csrf');
const { COOKIE_SECURE } = require('../config');

const { generateCsrfToken, doubleCsrfProtection } = doubleCsrf({
  getSecret: () => process.env.SESSION_SECRET || 'change-me-in-production',
  // For the double-submit cookie pattern, the proof of possession is the CSRF cookie itself.
  // We use a stable constant as the session identifier so pre-auth endpoints (like /login)
  // work correctly — the per-session binding is enforced by the session cookie separately.
  getSessionIdentifier: () => 'sentra',
  cookieName: COOKIE_SECURE ? '__Host-sentra.x-csrf-token' : 'sentra.x-csrf-token',
  cookieOptions: {
    httpOnly: true,
    sameSite: 'strict',
    secure: COOKIE_SECURE,
    path: '/',
  },
  size: 64,
  getCsrfTokenFromRequest: (req) => req.headers['x-csrf-token'],
});

module.exports = { generateCsrfToken, doubleCsrfProtection };
