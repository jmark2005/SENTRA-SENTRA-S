'use strict';
const db = require('../repositories/db');

/**
 * Get a single setting value by key. Returns the value string or null.
 */
function getSetting(key) {
  const row = db.prepare('SELECT value FROM system_settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

/**
 * Get multiple settings by keys[]. Returns object { key: value }.
 */
function getSettings(keys) {
  const result = {};
  for (const key of keys) {
    result[key] = getSetting(key);
  }
  return result;
}

module.exports = { getSetting, getSettings };
