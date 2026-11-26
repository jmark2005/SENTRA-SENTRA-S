'use strict';

/**
 * `npm test` entry point (T-35B). Runs every test/*.test.js with Node's built-in
 * test runner. Files are listed here rather than with a glob because npm on
 * Windows does not expand globs and Node 20 does not either. Each file runs in
 * its own process with its own temporary database (see test/helpers.js), so the
 * suites never touch db/sentra.db and need no .env.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const files = fs.readdirSync(__dirname)
  .filter(f => f.endsWith('.test.js'))
  .sort()
  .map(f => path.join(__dirname, f));

const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { stdio: 'inherit' });
process.exit(result.status === null ? 1 : result.status);
