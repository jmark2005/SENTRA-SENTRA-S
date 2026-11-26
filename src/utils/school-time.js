'use strict';

/**
 * Dates in the school's configured timezone (system_settings.school_timezone).
 * Falls back to the server's local time if the setting is not a valid zone.
 */

const { getSetting } = require('../services/settings.service');

function parts(now, withTime, withSeconds = false) {
  const opts = { year: 'numeric', month: '2-digit', day: '2-digit' };
  if (withTime) Object.assign(opts, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  if (withSeconds) opts.second = '2-digit';
  let list;
  try {
    list = new Intl.DateTimeFormat('en-CA', { ...opts, timeZone: getSetting('school_timezone') || 'Asia/Manila' })
      .formatToParts(now);
  } catch (_) {
    list = new Intl.DateTimeFormat('en-CA', opts).formatToParts(now);
  }
  const p = type => list.find(x => x.type === type).value;
  const date = `${p('year')}-${p('month')}-${p('day')}`;
  if (!withTime) return date;
  return `${date} ${p('hour')}:${p('minute')}${withSeconds ? ':' + p('second') : ''}`;
}

/** Today as YYYY-MM-DD in the school timezone. */
function schoolToday(now = new Date()) { return parts(now, false); }

/** Now as "YYYY-MM-DD HH:MM" in the school timezone. */
function schoolDateTime(now = new Date()) { return parts(now, true); }

/** A moment as "YYYY-MM-DD HH:MM:SS" in the school timezone (report timestamps). */
function schoolTimestamp(now = new Date()) { return parts(now, true, true); }

/** True for a real calendar date written as YYYY-MM-DD. */
function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

module.exports = { schoolToday, schoolDateTime, schoolTimestamp, isIsoDate };
