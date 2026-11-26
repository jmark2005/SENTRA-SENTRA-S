'use strict';

/**
 * Follow-up reminder and overdue job (T-26).
 *
 * runOnce() looks at
 *   - each open incident's latest follow-up date (incident_activity_log.follow_up_date)
 *   - each Ongoing referral's latest next follow-up (referral_followups.next_followup)
 * and sends one "due" notice on that date (in the school timezone) and one
 * "overdue" notice once it has passed. reminder_log's UNIQUE
 * (kind, target_table, target_id, due_key) means each notice goes out once;
 * the log row, the notifications and the audit entry share one transaction.
 *
 * start() runs it every reminders_job_interval_minutes (default 60), re-reading
 * the setting after each run. Nothing runs on require, so tests call runOnce().
 */

const db                = require('../repositories/db');
const notificationSvc   = require('../services/notification.service');
const { log: auditLog } = require('../services/audit.service');
const { getSetting }    = require('../services/settings.service');
const { schoolToday }   = require('../utils/school-time');

const DEFAULT_INTERVAL_MINUTES = 60;

/** YYYY-MM-DD for `now` in the configured school timezone. */
const schoolDate = schoolToday;

// ── What is due ──────────────────────────────────────────────────────────────

function incidentFollowUps(today) {
  return db.prepare(`
    SELECT i.id, i.reference_number, al.follow_up_date
    FROM   incidents i
    JOIN   incident_activity_log al ON al.id = (
             SELECT MAX(x.id) FROM incident_activity_log x
             WHERE  x.incident_id = i.id AND x.follow_up_date IS NOT NULL)
    WHERE  i.is_archived = 0
      AND  i.status NOT IN ('Resolved', 'Closed')
      AND  al.follow_up_date <= ?
  `).all(today);
}

function incidentRecipients(incidentId) {
  return db.prepare(`
    SELECT u.id FROM incident_assignments ia JOIN users u ON u.id = ia.assigned_to
    WHERE  ia.incident_id = ? AND ia.is_active = 1 AND u.status = 'Active'
    UNION
    SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
    WHERE  r.name = 'schoolhead' AND u.status = 'Active'
  `).all(incidentId).map(r => r.id);
}

function referralFollowUps(today) {
  return db.prepare(`
    SELECT r.id, r.assigned_to, f.next_followup AS follow_up_date
    FROM   referrals r
    JOIN   referral_followups f ON f.id = (
             SELECT MAX(x.id) FROM referral_followups x
             WHERE  x.referral_id = r.id AND x.next_followup IS NOT NULL)
    WHERE  r.is_archived = 0
      AND  r.status = 'Ongoing'
      AND  f.next_followup <= ?
  `).all(today);
}

function referralRecipients(referral) {
  if (!referral.assigned_to) return [];
  const u = db.prepare("SELECT id FROM users WHERE id = ? AND status = 'Active'").get(referral.assigned_to);
  return u ? [u.id] : [];
}

// ── Sending ──────────────────────────────────────────────────────────────────

/**
 * Sends one notice unless reminder_log already has it. Returns true if sent.
 * Skipped (and retried next run) when nobody can receive it.
 */
const sendNotice = db.transaction((notice) => {
  if (!notice.recipients.length) return false;

  const logged = db.prepare(`
    INSERT OR IGNORE INTO reminder_log (kind, target_table, target_id, due_key)
    VALUES (?, ?, ?, ?)
  `).run(notice.kind, notice.targetTable, notice.targetId, notice.dueKey).changes;
  if (!logged) return false;

  for (const userId of notice.recipients) {
    notificationSvc.create({
      userId,
      type:    notice.type,
      title:   notice.title,
      message: notice.message,
      link:    notice.link,
    });
  }

  auditLog({
    actorId:     null,
    actorName:   'SYSTEM',
    actorRole:   'system',
    actionType:  notice.overdue ? 'FOLLOWUP_OVERDUE_NOTICE' : 'FOLLOWUP_DUE_NOTICE',
    targetTable: notice.targetTable,
    targetId:    notice.targetId,
    newValues:   { kind: notice.kind, due_key: notice.dueKey, recipients: notice.recipients },
  });
  return true;
});

function incidentNotice(row, today) {
  const overdue = row.follow_up_date < today;
  const ref = row.reference_number;
  return {
    overdue,
    kind:        overdue ? 'incident_followup_overdue' : 'incident_followup_due',
    targetTable: 'incidents',
    targetId:    row.id,
    dueKey:      row.follow_up_date,
    recipients:  incidentRecipients(row.id),
    type:        overdue ? 'Overdue Action' : 'Follow-Up Reminder',
    title:       overdue ? `Follow-up overdue: ${ref}` : `Follow-up due today: ${ref}`,
    // Wording from requirements.md US-3.8; not phrased as an emergency.
    message:     overdue
      ? `Follow-up overdue for incident ${ref} — originally due ${row.follow_up_date}. Action pending review.`
      : `A follow-up is due today for incident ${ref}.`,
    link:        `/api/incidents/${row.id}`,
  };
}

function referralNotice(row, today) {
  const overdue = row.follow_up_date < today;
  return {
    overdue,
    kind:        overdue ? 'referral_followup_overdue' : 'referral_followup_due',
    targetTable: 'referrals',
    targetId:    row.id,
    dueKey:      row.follow_up_date,
    recipients:  referralRecipients(row),
    type:        overdue ? 'Overdue Action' : 'Follow-Up Reminder',
    title:       overdue ? `Referral follow-up overdue: #${row.id}` : `Referral follow-up due today: #${row.id}`,
    // Referral id only: no student or counseling details in notifications.
    message:     overdue
      ? `Follow-up overdue for referral #${row.id} — originally due ${row.follow_up_date}. Action pending review.`
      : `A follow-up is due today for referral #${row.id}.`,
    link:        null,
  };
}

/**
 * One pass over incidents and referrals.
 * @param {Date} [now] defaults to the current time (tests may pass a fixed date)
 * @returns {{ today: string, sent: object[] }}
 */
function runOnce(now = new Date()) {
  const today = schoolDate(now);
  const sent = [];

  const notices = [
    ...incidentFollowUps(today).map(r => incidentNotice(r, today)),
    ...referralFollowUps(today).map(r => referralNotice(r, today)),
  ];
  for (const notice of notices) {
    if (sendNotice(notice)) {
      sent.push({ kind: notice.kind, target_table: notice.targetTable, target_id: notice.targetId,
                  due_key: notice.dueKey, recipients: notice.recipients });
    }
  }
  return { today, sent };
}

// ── Scheduling ───────────────────────────────────────────────────────────────

let timer = null;

function intervalMs() {
  const minutes = parseInt(getSetting('reminders_job_interval_minutes'), 10);
  const safe = Number.isFinite(minutes) && minutes >= 1 && minutes <= 1440 ? minutes : DEFAULT_INTERVAL_MINUTES;
  return safe * 60 * 1000;
}

function tick() {
  try {
    const { sent } = runOnce();
    if (sent.length) console.log(`[reminders] sent ${sent.length} follow-up notice(s)`);
  } catch (err) {
    console.error('[reminders] run failed:', err.message);
  }
}

function schedule(delayMs) {
  timer = setTimeout(() => {
    tick();
    schedule(intervalMs());
  }, delayMs);
  if (timer.unref) timer.unref();
}

/** Starts the job: first run shortly after startup, then every interval. */
function start() {
  if (timer) return;
  schedule(10 * 1000);
}

function stop() {
  if (timer) clearTimeout(timer);
  timer = null;
}

module.exports = { runOnce, start, stop, schoolDate };
