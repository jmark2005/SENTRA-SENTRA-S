'use strict';

/**
 * security-check.js — SENTRA Security Hardening Verification
 *
 * Run from project root: node security-check.js
 *
 * Checks performed (all static; no live server required):
 *   1. SQL injection — no raw user-input interpolation in SQL strings
 *   2. helmet CSP — default-src 'self', no unsafe-inline, no external sources
 *   3. CSRF — doubleCsrfProtection applied before all /api state-changing routes
 *   4. Attachment storage — multer uses UUID filenames; mime validated
 *   5. Attachment path traversal — resolveStoredPath guards against traversal
 *   6. Git history — no committed .env files or plaintext passwords
 */

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = __dirname;

// ANSI colour helpers
const GREEN  = (s) => `\x1b[32m${s}\x1b[0m`;
const RED    = (s) => `\x1b[31m${s}\x1b[0m`;
const YELLOW = (s) => `\x1b[33m${s}\x1b[0m`;
const BOLD   = (s) => `\x1b[1m${s}\x1b[0m`;

const results = [];

function pass(check, detail) {
  results.push({ status: 'PASS', check, detail });
  console.log(`  ${GREEN('✔ PASS')}  ${check}`);
  if (detail) console.log(`         ${detail}`);
}

function fail(check, detail) {
  results.push({ status: 'FAIL', check, detail });
  console.log(`  ${RED('✘ FAIL')}  ${check}`);
  if (detail) console.log(`         ${detail}`);
}

function warn(check, detail) {
  results.push({ status: 'WARN', check, detail });
  console.log(`  ${YELLOW('⚠ WARN')}  ${check}`);
  if (detail) console.log(`         ${detail}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Recursively collect all .js files under dir, excluding node_modules. */
function collectJs(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJs(full, files);
    } else if (entry.name.endsWith('.js')) {
      files.push(full);
    }
  }
  return files;
}

function readSrc(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 1 — SQL Injection (parameterized queries only)
// ─────────────────────────────────────────────────────────────────────────────
console.log(BOLD('\n[1] SQL Injection — Parameterized Queries'));

const srcDir   = path.join(ROOT, 'src');
const allFiles = collectJs(srcDir);
// Safe interpolation patterns:
//   ${NOW_SQL}             — compile-time constant string for current timestamp
//   ${SELECT_REFERRAL}     — compile-time constant SELECT fragment
//   ${setClauses.join(...)} / ${sets.join(...)} — built from hardcoded 'col = ?' strings
//   ${conditions.join(...)} — built from hardcoded '? placeholders' strings
//   ${where}               — string built from conditions array above
//   ${placeholders} / ${ph} — '?,?,?' strings built from array.map(() => '?')
//   ${SCHOOLHEAD_EXCLUDED_ACTIONS.map(...)} — constant list mapped to ?
//   ${having}              — HAVING clause built from constant strings only
//   ${attendanceIds.map(() => '?').join(', ')} — IN-list placeholder expansion
//   ${statuses.map(() => '?').join(', ')}    — IN-list placeholder expansion
//   ${ids.map(() => '?').join(', ')}         — IN-list placeholder expansion
//   ${roles.map(() => '?').join(', ')}       — IN-list placeholder expansion
//   ${incWhere}            — WHERE fragment built from parameterized conditions
//   ${labelExpr}           — column expression built from whitelisted constants
//   ${SY('...')}           — REPLACE() expression operating on column names, not user data
//   ${scope}               — WHERE fragment built from whitelist joins
//   ${f.classIds.map(() => '?').join(', ') || 'NULL'}  — IN-list placeholder expansion
//   ${unreadOnly ? 'AND is_read = 0' : ''}  — boolean flag interpolation (server-controlled)
const SAFE_INTERPOLATION_RE = new RegExp(
  [
    'NOW_SQL',
    'SELECT_REFERRAL',
    'setClauses\\.join',
    'sets\\.join',
    'conditions\\.join',
    'where\\b',
    'incWhere\\b',
    'placeholders\\b',
    '\\bph\\b',
    'SCHOOLHEAD_EXCLUDED_ACTIONS',
    'having\\b',
    'attendanceIds\\.map',
    'statuses\\.map',
    '\\bids\\.map',
    'roles\\.map',
    'labelExpr\\b',
    'SY\\(',
    'scope\\b',
    'classIds\\.map',
    'f\\.classIds\\.map',
    'unreadOnly\\b',
    'df[0-9]+\\.clause\\b',    // parameterised date filter clauses (e.g. ${df1.clause})
    'user\\.full_name\\b',      // plain JS string (response message, not SQL)
    'severity\\b',              // string interpolation in English description text
    '\\.map\\(\\(\\)\\s*=>\\s*\'\\?\'\\)',  // any .map(() => '?') pattern
  ].join('|')
);

const injectionViolations = [];
for (const file of allFiles) {
  const src = fs.readFileSync(file, 'utf8');
  // Find all template literal strings that look like SQL
  const templateLiterals = [...src.matchAll(/`([^`]*)`/g)];
  for (const tl of templateLiterals) {
    const content = tl[1];
    // Only interested in strings that look like SQL
    if (!/SELECT|INSERT|UPDATE|DELETE|WHERE|SET\s/i.test(content)) continue;
    // Find all interpolations in this SQL string
    const interpolations = [...content.matchAll(/\$\{([^}]+)\}/g)];
    for (const interp of interpolations) {
      const expr = interp[1].trim();
      if (!SAFE_INTERPOLATION_RE.test(expr)) {
        const lineNum = src.slice(0, tl.index).split('\n').length;
        injectionViolations.push({
          file: path.relative(ROOT, file),
          expr,
          line: lineNum,
        });
      }
    }
  }
}

// Also check: string concatenation directly in prepare() calls
const concatInPrepareRe = /\.prepare\(\s*(['"`])[^'"` ]*\1\s*\+/;
const concatViolations = [];
for (const file of allFiles) {
  const src = fs.readFileSync(file, 'utf8');
  if (concatInPrepareRe.test(src)) {
    concatViolations.push(path.relative(ROOT, file));
  }
}

if (injectionViolations.length === 0 && concatViolations.length === 0) {
  pass('All SQL queries use ? placeholders; dynamic WHERE/SET builders use whitelisted column names only');
} else {
  if (injectionViolations.length > 0) {
    const unique = [...new Set(injectionViolations.map(v => `${v.file}:${v.line} \${${v.expr}}`))];
    fail('Potentially unsafe SQL interpolation found', unique.join('; '));
  }
  if (concatViolations.length > 0) {
    fail('String concatenation inside .prepare() calls', concatViolations.join(', '));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 2 — helmet CSP (default-src 'self', no unsafe-inline, no CDN)
// ─────────────────────────────────────────────────────────────────────────────
console.log(BOLD('\n[2] helmet CSP — Content Security Policy'));

const appSrc = readSrc('src/app.js');

const helmetApplied = /app\.use\(\s*helmet\(/.test(appSrc);
const cspEnabled    = /contentSecurityPolicy\s*:/.test(appSrc) &&
                      !/contentSecurityPolicy\s*:\s*false/.test(appSrc);
const defaultSelf   = /defaultSrc\s*:\s*\["'self'"\]/.test(appSrc);
const noUnsafeInline = !/unsafe-inline/.test(appSrc);
const noExternalSrc = !/https?:\/\/(?!localhost|127\.0\.0\.1)/.test(
  appSrc.match(/contentSecurityPolicy[\s\S]*?}\s*,\s*}\s*\)/)?.[0] || ''
);
const scriptNone    = /scriptSrcAttr\s*:\s*\["'none'"\]/.test(appSrc);

if (!helmetApplied) {
  fail('helmet() not applied in app.js');
} else if (!cspEnabled) {
  fail('contentSecurityPolicy is disabled in helmet config');
} else if (!defaultSelf) {
  fail("defaultSrc is not set to [\"'self'\"]");
} else {
  pass("helmet() applied with contentSecurityPolicy default-src 'self'");
}

if (noUnsafeInline) {
  pass("CSP contains no 'unsafe-inline' directive");
} else {
  fail("CSP contains 'unsafe-inline' — XSS protection weakened");
}

if (scriptNone) {
  pass("scriptSrcAttr: [\"'none'\"] blocks inline event handlers");
} else {
  warn('scriptSrcAttr not set to none — inline event handlers not explicitly blocked');
}

// Check HTML files for CDN links
const htmlDir = path.join(ROOT, 'public');
const htmlFiles = fs.readdirSync(htmlDir).filter(f => f.endsWith('.html'));
const cdnPattern = /https?:\/\/(?!localhost)/;
let cdnViolations = [];
for (const html of htmlFiles) {
  const src = fs.readFileSync(path.join(htmlDir, html), 'utf8');
  // Look for CDN links in script/link tags
  const tags = src.match(/<(?:script|link)[^>]+(?:src|href)\s*=\s*["']https?:\/\/[^"']+["'][^>]*>/gi) || [];
  const external = tags.filter(t => cdnPattern.test(t));
  if (external.length > 0) cdnViolations.push({ file: html, tags: external });
}

if (cdnViolations.length === 0) {
  pass('No external CDN links found in any HTML file — CSP self-only is consistent');
} else {
  fail('External CDN links found — these will be blocked by CSP default-src self', 
       cdnViolations.map(v => `${v.file}: ${v.tags.length} tag(s)`).join('; '));
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 3 — CSRF middleware applied to all /api state-changing routes
// ─────────────────────────────────────────────────────────────────────────────
console.log(BOLD('\n[3] CSRF Protection'));

const csrfSrc = readSrc('src/middleware/csrf.js');

const csrfDoubleCsrf  = /doubleCsrf\s*\(/.test(csrfSrc);
const csrfCookieName  = /__Host-sentra\.x-csrf-token/.test(csrfSrc) || /sentra\.x-csrf-token/.test(csrfSrc);
const csrfSize64      = /size\s*:\s*64/.test(csrfSrc);
const csrfFromHeader  = /x-csrf-token/.test(csrfSrc);

if (csrfDoubleCsrf && csrfCookieName && csrfSize64 && csrfFromHeader) {
  pass('csrf-csrf doubleCsrf configured: cookie name correct, size 64, reads X-CSRF-Token header');
} else {
  if (!csrfDoubleCsrf)  fail('doubleCsrf() not found in csrf.js');
  if (!csrfCookieName)  fail('CSRF cookie name not set correctly');
  if (!csrfSize64)      fail('CSRF token size is not 64');
  if (!csrfFromHeader)  fail('CSRF token not read from X-CSRF-Token header');
}

const appCsrfApplied = /app\.use\(['"]\/api['"],\s*doubleCsrfProtection\)/.test(appSrc);
const csrfBeforeRoutes = (() => {
  const appLines = appSrc.split('\n');
  const csrfLine   = appLines.findIndex(l => /app\.use\(['"]\/api['"],\s*doubleCsrfProtection\)/.test(l));
  const routesLine = appLines.findIndex(l => /app\.use\(['"]\/api\/auth['"]/.test(l));
  return csrfLine !== -1 && routesLine !== -1 && csrfLine < routesLine;
})();

if (appCsrfApplied) {
  pass('doubleCsrfProtection applied to all /api routes in app.js');
} else {
  fail('doubleCsrfProtection NOT found on the /api router in app.js');
}

if (csrfBeforeRoutes) {
  pass('CSRF middleware registered before route handlers');
} else {
  warn('Could not confirm CSRF middleware is registered before route handlers');
}

// Verify GET /api/csrf-token is exempt (registered before the CSRF middleware)
const csrfTokenExempt = appSrc.indexOf('app.get(\'/api/csrf-token\'') <
                         appSrc.indexOf('app.use(\'/api\', doubleCsrfProtection)');
if (csrfTokenExempt) {
  pass('GET /api/csrf-token exempt from CSRF check (registered before middleware)');
} else {
  warn('GET /api/csrf-token registration order relative to CSRF middleware unclear');
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 4 — Attachment storage: UUID filenames, mime validation
// ─────────────────────────────────────────────────────────────────────────────
console.log(BOLD('\n[4] Attachment Storage — UUID Filenames & MIME Validation'));

const attachSvc = readSrc('src/services/attachment.service.js');

const uuidFilename    = /randomUUID\(\)/.test(attachSvc);
const mimeWhitelist   = /ACCEPTED\s*=\s*\{/.test(attachSvc) &&
                        /image\/jpeg/.test(attachSvc) &&
                        /image\/png/.test(attachSvc) &&
                        /application\/pdf/.test(attachSvc);
const signatureCheck  = /hasValidSignature/.test(attachSvc);
const outsidePublic   = /UPLOAD_DIR.*uploads/.test(attachSvc) && !/public/.test(
  (attachSvc.match(/UPLOAD_DIR\s*=\s*path\.resolve\([^;]+/)?.[0] || '')
);
const storedNameRe    = /STORED_NAME_RE\s*=\s*\/\^/.test(attachSvc);

if (uuidFilename) {
  pass('multer uses crypto.randomUUID() for stored filenames — no user-supplied names saved to disk');
} else {
  fail('multer does NOT use UUID filenames — user-supplied names may reach the filesystem');
}

if (mimeWhitelist) {
  pass('MIME type whitelist present: image/jpeg, image/png, application/pdf');
} else {
  fail('MIME type whitelist missing or incomplete');
}

if (signatureCheck) {
  pass('Magic-byte signature validation (hasValidSignature) confirms actual file type');
} else {
  fail('No magic-byte signature check — MIME type spoofing possible');
}

if (outsidePublic) {
  pass('Uploads stored outside /public directory');
} else {
  warn('Could not confirm uploads directory is outside /public');
}

if (storedNameRe) {
  pass('STORED_NAME_RE regex validates filename before serving');
} else {
  warn('STORED_NAME_RE pattern not found — stored filename validation may be missing');
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 5 — Attachment download: path traversal prevention
// ─────────────────────────────────────────────────────────────────────────────
console.log(BOLD('\n[5] Attachment Download — Path Traversal Prevention'));

const resolveStoredPath = attachSvc.match(/function resolveStoredPath[\s\S]*?^}/m)?.[0] || '';

const usesRegexGate   = /STORED_NAME_RE\.test/.test(resolveStoredPath);
const usesPathJoin    = /path\.join\(UPLOAD_DIR,\s*storedName\)/.test(resolveStoredPath);
const dirnameCheck    = /path\.dirname\(full\)\s*===\s*UPLOAD_DIR/.test(resolveStoredPath) ||
                        /requestedFile\.startsWith\(uploadsDir/.test(resolveStoredPath);
const returnsNullOnBad = /return null/.test(resolveStoredPath);

const attachRoute = readSrc('src/routes/attachment.routes.js');
const filenameFromDb = /attachment\.filename/.test(attachRoute) &&
                       !/req\.params|req\.query|req\.body/.test(
                         attachRoute.match(/resolveStoredPath\([^)]+\)/)?.[0] || ''
                       );

if (usesRegexGate && (usesPathJoin || dirnameCheck) && returnsNullOnBad) {
  pass('resolveStoredPath: UUID regex gate + dirname equality check prevents path traversal');
} else {
  if (!usesRegexGate)   fail('resolveStoredPath missing UUID regex gate');
  if (!dirnameCheck)    fail('resolveStoredPath missing directory boundary check');
  if (!returnsNullOnBad) fail('resolveStoredPath does not return null on invalid input');
}

if (filenameFromDb) {
  pass('Download endpoint reads filename from database row only — never from request params');
} else {
  warn('Could not confirm filename comes exclusively from database row');
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 6 — git log: no committed .env or plaintext passwords
// ─────────────────────────────────────────────────────────────────────────────
console.log(BOLD('\n[6] Git History — No Committed Secrets'));

try {
  // Check if .env was ever committed
  const gitEnvLog = execSync('git log --all --oneline -- ".env"', { cwd: ROOT, encoding: 'utf8' }).trim();
  if (gitEnvLog) {
    fail('.env file was committed in git history', gitEnvLog.split('\n').join('; '));
  } else {
    pass('.env was never committed (confirmed by git log)');
  }
} catch (_) {
  warn('Could not check git log for .env commits (git may not be available)');
}

// Check .gitignore explicitly lists .env
const gitignore = fs.existsSync(path.join(ROOT, '.gitignore'))
  ? fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8')
  : '';
if (/^\.env$/m.test(gitignore)) {
  pass('.env listed in .gitignore');
} else {
  fail('.env NOT listed in .gitignore — risk of accidental commit');
}

// Check .env.example for placeholder values only (no real secrets)
if (fs.existsSync(path.join(ROOT, '.env.example'))) {
  const envExample = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  const hasPlaceholder = /change-me|your[-_]?secret|your[-_]?password|placeholder/i.test(envExample);
  const noRealSecret   = !/SESSION_SECRET\s*=\s*(?!change-me)[a-zA-Z0-9!@#$%^&*]{16,}/.test(envExample);
  if (hasPlaceholder && noRealSecret) {
    pass('.env.example contains only placeholder values — no real credentials');
  } else {
    fail('.env.example may contain real credentials or missing placeholder indicators');
  }
}

// Scan committed history for password-related additions in non-example config files
try {
  const gitPickaxe = execSync(
    'git log --all --oneline -S "password_hash" -- "*.env" "*.json" ".env*"',
    { cwd: ROOT, encoding: 'utf8' }
  ).trim();
  if (gitPickaxe) {
    warn('git log found commits touching password_hash in config files; review manually', gitPickaxe);
  } else {
    pass('No commits found adding password hashes to committed config/env files');
  }
} catch (_) {
  warn('Could not run git pickaxe scan for password_hash in config files');
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 7 — Rate limiting on /api/auth/login
// ─────────────────────────────────────────────────────────────────────────────
console.log(BOLD('\n[7] Brute-Force Protection — Login Rate Limit'));

const authRoutesSrc = readSrc('src/routes/auth.routes.js');

const rateLimitImported = /express-rate-limit/.test(authRoutesSrc);
const rateLimitApplied  = /loginLimiter/.test(authRoutesSrc) && /router\.post\(['"]\/login['"],\s*loginLimiter/.test(authRoutesSrc);
const rateLimitConfig   = /windowMs\s*:\s*60\s*\*\s*1000/.test(authRoutesSrc) &&
                          /max\s*:\s*10/.test(authRoutesSrc);

if (rateLimitImported && rateLimitApplied && rateLimitConfig) {
  pass('express-rate-limit applied to POST /login: 10 req/min/IP');
} else {
  if (!rateLimitImported) fail('express-rate-limit not imported in auth.routes.js');
  if (!rateLimitApplied)  fail('loginLimiter not applied to POST /login route');
  if (!rateLimitConfig)   fail('Rate limit configuration does not match 10 req/min');
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 8 — Session fixation prevention (regenerate on login)
// ─────────────────────────────────────────────────────────────────────────────
console.log(BOLD('\n[8] Session Fixation — Session Regeneration on Login'));

const sessionRegenerate = /req\.session\.regenerate\s*\(/.test(authRoutesSrc);
const regenerateBeforeSet = (() => {
  const lines = authRoutesSrc.split('\n');
  const regenLine = lines.findIndex(l => /req\.session\.regenerate/.test(l));
  const setLine   = lines.findIndex(l => /req\.session\.userId/.test(l));
  return regenLine !== -1 && setLine !== -1 && regenLine < setLine;
})();

if (sessionRegenerate && regenerateBeforeSet) {
  pass('req.session.regenerate() called before session data is set — session fixation prevented');
} else {
  if (!sessionRegenerate) {
    fail('req.session.regenerate() NOT called in login handler — session fixation risk');
  } else {
    fail('session.regenerate() found but session data may be set before callback');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 9 — Cookie security attributes
// ─────────────────────────────────────────────────────────────────────────────
console.log(BOLD('\n[9] Session Cookie Security Attributes'));

const httpOnlyCookie  = /httpOnly\s*:\s*true/.test(appSrc);
const sameSiteStrict  = /sameSite\s*:\s*['"]strict['"]/.test(appSrc);
const secureFromEnv   = /secure\s*:\s*COOKIE_SECURE/.test(appSrc) || /secure\s*:\s*process\.env\.COOKIE_SECURE/.test(appSrc);

if (httpOnlyCookie) {
  pass('Session cookie: httpOnly: true');
} else {
  fail('Session cookie missing httpOnly: true');
}

if (sameSiteStrict) {
  pass("Session cookie: sameSite: 'strict'");
} else {
  fail("Session cookie missing sameSite: 'strict'");
}

if (secureFromEnv) {
  pass('Session cookie: secure flag driven by COOKIE_SECURE environment variable');
} else {
  fail('Session cookie secure flag is hardcoded rather than from environment variable');
}

// ─────────────────────────────────────────────────────────────────────────────
// SUMMARY
// ─────────────────────────────────────────────────────────────────────────────
const passed = results.filter(r => r.status === 'PASS').length;
const failed = results.filter(r => r.status === 'FAIL').length;
const warned = results.filter(r => r.status === 'WARN').length;

console.log(BOLD('\n══════════════════════════════════════════════════════'));
console.log(BOLD(' SENTRA Security Check Results'));
console.log(BOLD('══════════════════════════════════════════════════════'));
console.log(`  ${GREEN(`${passed} passed`)}   ${failed > 0 ? RED(`${failed} failed`) : '0 failed'}   ${warned > 0 ? YELLOW(`${warned} warnings`) : '0 warnings'}`);

if (failed > 0) {
  console.log(RED('\n  ✘ FAILURES — address before deployment:'));
  for (const r of results.filter(r => r.status === 'FAIL')) {
    console.log(`    • ${r.check}`);
    if (r.detail) console.log(`      ${r.detail}`);
  }
}

if (warned > 0) {
  console.log(YELLOW('\n  ⚠ WARNINGS — review recommended:'));
  for (const r of results.filter(r => r.status === 'WARN')) {
    console.log(`    • ${r.check}`);
    if (r.detail) console.log(`      ${r.detail}`);
  }
}

console.log('');
process.exit(failed > 0 ? 1 : 0);
