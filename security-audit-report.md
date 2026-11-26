# SENTRA Security Audit Report — T-44

**Task:** T-44 — Security Hardening Checklist  
**Date:** 2026-11-25 (re-verified 2026-11-26)  
**Audited by:** Automated review + manual code inspection  
**Script:** `node security-check.js` (25 checks, 0 failures, 0 warnings)

---

## Summary

| Check | Result |
|-------|--------|
| Helmet headers + CSP | PASS |
| Parameterized queries | FIXED → PASS |
| CSRF protection | PASS |
| Session fixation (SID regeneration) | PASS |
| Brute-force rate limit (429 on 11th) | PASS |
| Attachment path traversal prevention | PASS |
| No committed .env or plaintext passwords | PASS |

---

## Details

### 2a. Helmet Headers + CSP

**Result: PASS**

`app.js` registers `helmet()` as the **first** middleware, before all routes. The
`contentSecurityPolicy` option is explicitly configured with `useDefaults: false` and
the following directives — no `'unsafe-inline'` or `'unsafe-eval'` appears anywhere:

```javascript
contentSecurityPolicy: {
  useDefaults: false,
  directives: {
    defaultSrc:    ["'self'"],
    scriptSrc:     ["'self'"],
    scriptSrcAttr: ["'none'"],   // blocks inline event handlers (on*, etc.)
    styleSrc:      ["'self'"],
    fontSrc:       ["'self'"],
    imgSrc:        ["'self'", 'data:'],
    objectSrc:     ["'none'"],
    connectSrc:    ["'self'"],
    frameAncestors:["'self'"],
    baseUri:       ["'self'"],
    formAction:    ["'self'"],
    // upgradeInsecureRequests added only when COOKIE_SECURE=true (HTTPS mode)
  },
}
```

`X-Frame-Options: DENY`-equivalent is enforced by helmet's default `frameAncestors: ["'self'"]`
in the CSP, plus helmet sets `X-Frame-Options: SAMEORIGIN` as an HTTP header by default.
No external CDN links were found in any HTML file (all scripts, styles, and fonts are
vendored under `public/vendor/`).

**Files changed:** None — was already correctly configured from T-17B.

---

### 2b. Parameterized Queries — No SQL Injection

**Result: FIXED (prior to this run) → PASS**

All SQL in `src/repositories/` uses `?` placeholders via `better-sqlite3`'s `prepare().all()`
/ `.get()` / `.run()` API. No template literal interpolation of user-supplied values into
SQL strings exists in any repository file.

The one vulnerability that existed in a prior version was in `GET /api/users/:id/participation`
(`src/routes/user.routes.js`), where a `dateFilter` helper interpolated `from` and `to` query
parameters directly into SQL using template literals. This was fixed before the current run:
the helper was rewritten to return `{ clause, params }` with `?` placeholders, and all
seven query call sites were updated accordingly.

The static analysis script (`security-check.js` check 1) confirms: zero violations across
all `.js` files under `src/`.

**Dynamic WHERE/SET builder pattern (safe):** Repository files such as `student.repository.js`
and `campus-location.repository.js` build `SET col = ?` clause strings from hardcoded
column-name string literals and push user values into a separate params array. This is a
safe pattern — the column names come from code, not from the request.

**Files changed:** `src/routes/user.routes.js` (fixed before this audit run).

---

### 2c. CSRF Protection

**Result: PASS**

`src/middleware/csrf.js` configures `csrf-csrf` with the double-submit cookie pattern:
- Cookie name: `__Host-sentra.x-csrf-token` (`COOKIE_SECURE=true`) or `sentra.x-csrf-token` (HTTP LAN)
- Token size: 64 bytes
- Token read from: `X-CSRF-Token` request header
- Cookie options: `httpOnly: true`, `sameSite: 'strict'`, `secure` from env var

In `app.js`:
1. `GET /api/csrf-token` is registered **before** `app.use('/api', doubleCsrfProtection)`.
2. `app.use('/api', doubleCsrfProtection)` is registered **before** all route handlers.
3. `csrf-csrf` automatically skips GET, HEAD, and OPTIONS — so `GET /api/auth/session-status`
   is exempt by method, not by exclusion.

Removing the `X-CSRF-Token` header from a POST/PATCH/DELETE request returns HTTP 403.

**Files changed:** None — correctly configured from T-06B.

---

### 2d. Session Fixation — SID Regeneration on Login

**Result: PASS**

`POST /api/auth/login` in `src/routes/auth.routes.js` calls `req.session.regenerate()`
immediately after credentials are verified, before any session data is written:

```javascript
req.session.regenerate((err) => {
  if (err) return res.status(500).json({ error: 'Session error.' });
  req.session.userId      = user.id;
  req.session.loginAt     = Date.now();
  req.session.last_active = Date.now();
  req.session.save((saveErr) => {
    if (saveErr) return res.status(500).json({ error: 'Session save error.' });
    // ... insert user_sessions row, write audit log, return JSON
  });
});
```

The old session ID is invalidated and a fresh SID is issued before any user identity is
attached. A pre-login session ID cannot be reused after login.

**Files changed:** None — correctly implemented from T-06.

---

### 2e. Brute-Force Rate Limit

**Result: PASS**

`express-rate-limit` is applied directly to the `POST /api/auth/login` route:

```javascript
const loginLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 minute window
  max: 10,              // max 10 requests per window per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again later.' },
});
router.post('/login', loginLimiter, ...);
```

The 11th request from the same IP within a 60-second window returns HTTP 429.

**Files changed:** None — correctly implemented from T-06.

---

### 2f. Attachment Path Traversal Prevention

**Result: PASS**

Three independent layers block traversal:

1. **UUID-only stored filenames.** `multer` generates stored filenames with
   `crypto.randomUUID() + extension`. The user-supplied filename goes only into the
   `original_name` column (for display); it never reaches the filesystem.

2. **UUID regex gate in `resolveStoredPath`.** Before resolving any path, the service
   validates the filename against a strict regex:
   ```javascript
   const STORED_NAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|pdf)$/;

   function resolveStoredPath(storedName) {
     if (!STORED_NAME_RE.test(String(storedName))) return null;
     const full = path.join(UPLOAD_DIR, storedName);
     return path.dirname(full) === UPLOAD_DIR ? full : null;
   }
   ```
   The regex rejects any name containing `..`, `/`, `\`, or any character outside the
   UUID character set. The `path.dirname` check provides a second-layer boundary enforcement.

3. **Filename comes exclusively from the database row.** The download route reads
   `attachment.filename` from the DB record — never from `req.params`, `req.query`,
   or `req.body`. An attacker cannot supply a malicious path through the HTTP request.

A request to `GET /api/attachments/../../../package.json` would be rejected by Express's
router before reaching any handler (Express normalises paths and would not match the
`/attachments/:id/download` pattern). Even if it did reach the handler, `resolveStoredPath`
returns `null` for any non-UUID name, and the route returns 404.

**Files changed:** None — correctly implemented from T-21.

---

### 2g. Git History — No Committed Secrets

**Result: PASS**

The following checks were run:

```
git log --all --full-history -- ".env" "*.env"
```
→ **No output.** `.env` was never committed in any branch or tag.

```
git log --all --oneline -S "password" -- "*.js" "*.json"
```
→ One commit found: `509d352 before T-21`. Manual inspection of that commit shows the
match is in `db/seeds/seed.js` — specifically the function names `generateTempPassword`,
`password_hash`, and `bcrypt.hashSync(tempPassword, 12)`. These are legitimate code tokens,
not plaintext credential values. No real passwords or secrets appear in any committed file.

Additional checks:
- `.env` is listed in `.gitignore`.
- `.env.example` contains only placeholder values (`SESSION_SECRET=change-me-in-production`).
- No `password_hash` values appear in committed config or env files.

---

## Automated Check Results

Running `node security-check.js` from project root:

```
[1] SQL Injection — Parameterized Queries
  ✔ PASS  All SQL queries use ? placeholders; dynamic WHERE/SET builders use whitelisted column names only

[2] helmet CSP — Content Security Policy
  ✔ PASS  helmet() applied with contentSecurityPolicy default-src 'self'
  ✔ PASS  CSP contains no 'unsafe-inline' directive
  ✔ PASS  scriptSrcAttr: ["'none'"] blocks inline event handlers
  ✔ PASS  No external CDN links found in any HTML file — CSP self-only is consistent

[3] CSRF Protection
  ✔ PASS  csrf-csrf doubleCsrf configured: cookie name correct, size 64, reads X-CSRF-Token header
  ✔ PASS  doubleCsrfProtection applied to all /api routes in app.js
  ✔ PASS  CSRF middleware registered before route handlers
  ✔ PASS  GET /api/csrf-token exempt from CSRF check (registered before middleware)

[4] Attachment Storage — UUID Filenames & MIME Validation
  ✔ PASS  multer uses crypto.randomUUID() for stored filenames — no user-supplied names saved to disk
  ✔ PASS  MIME type whitelist present: image/jpeg, image/png, application/pdf
  ✔ PASS  Magic-byte signature validation (hasValidSignature) confirms actual file type
  ✔ PASS  Uploads stored outside /public directory
  ✔ PASS  STORED_NAME_RE regex validates filename before serving

[5] Attachment Download — Path Traversal Prevention
  ✔ PASS  resolveStoredPath: UUID regex gate + dirname equality check prevents path traversal
  ✔ PASS  Download endpoint reads filename from database row only — never from request params

[6] Git History — No Committed Secrets
  ✔ PASS  .env was never committed (confirmed by git log)
  ✔ PASS  .env listed in .gitignore
  ✔ PASS  .env.example contains only placeholder values — no real credentials
  ✔ PASS  No commits found adding password hashes to committed config/env files

[7] Brute-Force Protection — Login Rate Limit
  ✔ PASS  express-rate-limit applied to POST /login: 10 req/min/IP

[8] Session Fixation — Session Regeneration on Login
  ✔ PASS  req.session.regenerate() called before session data is set — session fixation prevented

[9] Session Cookie Security Attributes
  ✔ PASS  Session cookie: httpOnly: true
  ✔ PASS  Session cookie: sameSite: 'strict'
  ✔ PASS  Session cookie: secure flag driven by COOKIE_SECURE environment variable

══════════════════════════════════════════════════════
 SENTRA Security Check Results
══════════════════════════════════════════════════════
  25 passed   0 failed   0 warnings
```

---

## Recommendations (Non-Blocking)

1. **`SESSION_SECRET` in `.env`:** The current `.env` still uses the placeholder value
   `change-me-in-production`. Replace with a 32+ byte cryptographically random string
   before any non-demo deployment.

2. **`path.resolve` + `startsWith` alternative (defense-in-depth):** The current
   `resolveStoredPath` uses `path.dirname(full) === UPLOAD_DIR`, which is functionally
   correct given the UUID regex gate. The task spec suggests the alternative:
   ```javascript
   const full = path.resolve(UPLOAD_DIR, storedName);
   if (!full.startsWith(UPLOAD_DIR + path.sep)) return null;
   ```
   Both approaches are equivalent for the UUID filename format in use. The UUID regex
   gate makes either boundary check a secondary defence.

3. **bcrypt cost factor:** Confirmed at factor 12 in both `seed.js` and `auth.routes.js`,
   meeting NFR-01.
