'use strict';

const { Store } = require('express-session');
const db = require('../../src/repositories/db');

/**
 * Custom SQLite session store for express-session.
 * Uses the `sessions` table (sid TEXT PK, sess TEXT, expired TEXT).
 * Relies on the better-sqlite3 synchronous API.
 */
class SQLiteStore extends Store {
  constructor(options) {
    super(options);
  }

  /**
   * Fetch a session by sid.
   * Returns null if not found or expired.
   */
  get(sid, cb) {
    try {
      const now = new Date().toISOString();
      const row = db
        .prepare('SELECT sess FROM sessions WHERE sid = ? AND expired > ?')
        .get(sid, now);

      if (!row) return cb(null, null);

      const session = JSON.parse(row.sess);
      return cb(null, session);
    } catch (err) {
      return cb(err);
    }
  }

  /**
   * Store or update a session.
   * Computes expiry from session.cookie.expires or now + maxAge.
   */
  set(sid, session, cb) {
    try {
      let expired;

      if (session.cookie && session.cookie.expires) {
        expired = new Date(session.cookie.expires).toISOString();
      } else if (session.cookie && session.cookie.maxAge) {
        expired = new Date(Date.now() + session.cookie.maxAge).toISOString();
      } else {
        // Default: 8 hours from now
        expired = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
      }

      const sess = JSON.stringify(session);

      db.prepare(
        'INSERT OR REPLACE INTO sessions (sid, sess, expired) VALUES (?, ?, ?)'
      ).run(sid, sess, expired);

      return cb(null);
    } catch (err) {
      return cb(err);
    }
  }

  /**
   * Destroy a session by sid.
   */
  destroy(sid, cb) {
    try {
      db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      return cb(null);
    } catch (err) {
      return cb(err);
    }
  }

  /**
   * Update the expiry of an existing session (keep-alive).
   */
  touch(sid, session, cb) {
    try {
      let expired;

      if (session.cookie && session.cookie.expires) {
        expired = new Date(session.cookie.expires).toISOString();
      } else if (session.cookie && session.cookie.maxAge) {
        expired = new Date(Date.now() + session.cookie.maxAge).toISOString();
      } else {
        expired = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
      }

      db.prepare(
        'UPDATE sessions SET expired = ? WHERE sid = ?'
      ).run(expired, sid);

      return cb(null);
    } catch (err) {
      return cb(err);
    }
  }

  /**
   * Delete all sessions.
   */
  clear(cb) {
    try {
      db.prepare('DELETE FROM sessions').run();
      return cb(null);
    } catch (err) {
      return cb(err);
    }
  }

  /**
   * Return the count of all (non-expired) sessions.
   */
  length(cb) {
    try {
      const now = new Date().toISOString();
      const row = db
        .prepare('SELECT COUNT(*) AS count FROM sessions WHERE expired > ?')
        .get(now);
      return cb(null, row.count);
    } catch (err) {
      return cb(err);
    }
  }
}

module.exports = SQLiteStore;
