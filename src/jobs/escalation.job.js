'use strict';

/**
 * Escalation job (T-37).
 *
 * runOnce() iterates over active escalation_rules. For each rule it finds
 * incidents whose severity and status match the rule and whose latest
 * status-change incident_activity_log entry is older than
 * time_target_minutes. For each such incident it creates one "Escalated"
 * notification for the escalation_user_id, appends an Escalation entry to
 * incident_activity_log, inserts a reminder_log row and writes an audit
 * log entry. reminder_log's UNIQUE (kind, target_table, target_id, due_key)
 * means each escalation fires once per (rule, status_entered_at).
 *
 * start() runs it every escalation_job_interval_minutes (default 15),
 * re-reading the setting after each run. Nothing runs on require, so
 * tests call runOnce().
 */

const db                = require('../repositories/db');
const notificationSvc   = require('../services/notification.service');
const { log: auditLog } = require('../services/audit.service');
const { getSetting }    = require('../services/settings.service');

const DEFAULT_INTERVAL_MINUTES = 15;

// ── Active escalation rules ──────────────────────────────────────────────────

function activeRules() {
  return db.prepare(`
    SELECT er.id, er.severity, er.watch_status, er.time_target_minutes,
           er.escalation_user_id, u.full_name AS escalation_user_name,
           u.username   AS escalation_user_username
    FROM   escalation_rules er
    JOIN   users u ON u.id = er.escalation_user_id
    WHERE  er.is_active = 1 AND u.status = 'Active'
    ORDER  BY er.id ASC
  `).all();
}

/**
 * Finds incidents matching a single rule whose latest status-change entry
 * is older than time_target_minutes.
 */
function matchingIncidents(rule) {
  return db.prepare(`
    SELECT i.id, i.reference_number, i.severity, i.status,
           al.created_at AS status_entered_at,
           (julianday('now') * 24 * 60 - julianday(al.created_at) * 24 * 60) AS minutes_in_status
    FROM   incidents i
    JOIN   incident_activity_log al ON al.id = (
             SELECT MAX(x.id) FROM incident_activity_log x
             WHERE  x.incident_id = i.id AND x.new_status IS NOT NULL)
    WHERE  i.severity = ? AND i.status = ? AND i.is_archived = 0
      AND  (julianday('now') * 24 * 60 - julianday(al.created_at) * 24 * 60) >= ?
  `).all(rule.severity, rule.watch_status, rule.time_target_minutes);
}

// ── Escalation ────────────────────────────────────────────────────────────────

/**
 * Escalates a single incident under a rule, unless reminder_log already has
 * it. Returns true if an escalation was created, false if already logged.
 * All four writes share one transaction.
 */
const escalate = db.transaction((rule, incident) => {
  const dueKey = `${rule.id}|${incident.status_entered_at}`;

  const logged = db.prepare(`
    INSERT OR IGNORE INTO reminder_log (kind, target_table, target_id, due_key)
    VALUES (?, ?, ?, ?)
  `).run('escalation', 'incidents', incident.id, dueKey).changes;
  if (!logged) return false;

  // 1. Notification to the escalation user
  notificationSvc.create({
    userId: rule.escalation_user_id,
    type:    'Escalated',
    title:   `Escalated: ${incident.reference_number}`,
    message: `Incident ${incident.reference_number} (severity: ${incident.severity}) has been in "${incident.status}" status for longer than ${rule.time_target_minutes} minute(s). Escalation review required.`,
    link:    `/api/incidents/${incident.id}`,
  });

  // 2. Append Escalation entry to the incident activity log.
  //    old_status / new_status are left NULL: an escalation is not a status
  //    change, so it must not become the "latest status-change entry" that
  //    matchingIncidents() keys on — otherwise the timer would reset and the
  //    reminder_log deduplication (due_key = rule|status_entered_at) would
  //    never get a chance to suppress repeats.
  db.prepare(`
    INSERT INTO incident_activity_log
      (incident_id, actor_id, entry_type, description)
    VALUES (?, ?, 'Escalation', ?)
  `).run(
    incident.id,
    rule.escalation_user_id,
    `Escalation triggered by rule #${rule.id} (${rule.severity} + ${rule.watch_status}, ${rule.time_target_minutes} min). Incident has been in "${incident.status}" status for ${Math.round(incident.minutes_in_status)} minute(s).`,
  );

  // 3. Audit log
  auditLog({
    actorId:     null,
    actorName:   'SYSTEM',
    actorRole:   'system',
    actionType:  'ESCALATION_TRIGGERED',
    targetTable: 'incidents',
    targetId:    incident.id,
    newValues:   {
      rule_id:            rule.id,
      incident_id:        incident.id,
      reference_number:   incident.reference_number,
      severity:           incident.severity,
      status:             incident.status,
      minutes_in_status:  Math.round(incident.minutes_in_status),
      escalation_user_id: rule.escalation_user_id,
    },
  });

  return true;
});

// ── One pass ─────────────────────────────────────────────────────────────────

/**
 * One pass over active rules and their matching incidents.
 * @param {Date} [now] defaults to the current time (ignored by SQL which
 *   uses julianday('now'), kept for API consistency with reminders.job.js)
 * @returns {{ sent: object[] }}
 */
function runOnce(now = new Date()) {
  const sent = [];

  const rules = activeRules();
  for (const rule of rules) {
    const incidents = matchingIncidents(rule);
    for (const incident of incidents) {
      if (escalate(rule, incident)) {
        sent.push({
          rule_id:           rule.id,
          incident_id:       incident.id,
          reference_number:  incident.reference_number,
          escalation_user_id: rule.escalation_user_id,
          due_key:            `${rule.id}|${incident.status_entered_at}`,
        });
      }
    }
  }
  return { sent };
}

// ── Scheduling ───────────────────────────────────────────────────────────────

let timer = null;

function intervalMs() {
  const minutes = parseInt(getSetting('escalation_job_interval_minutes'), 10);
  const safe = Number.isFinite(minutes) && minutes >= 1 && minutes <= 1440 ? minutes : DEFAULT_INTERVAL_MINUTES;
  return safe * 60 * 1000;
}

function tick() {
  try {
    const { sent } = runOnce();
    if (sent.length) console.log(`[escalation] sent ${sent.length} escalation notice(s)`);
  } catch (err) {
    console.error('[escalation] run failed:', err.message);
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

module.exports = { runOnce, start, stop, intervalMs };
