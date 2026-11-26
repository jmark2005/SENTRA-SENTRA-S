'use strict';

/**
 * Incident review and response workflow (T-22 onward).
 * State machine and role rules from requirements.md US-2.4, US-2.5 and US-3.4.
 *
 * Every function takes ctx = { user: req.user, ip } and an incident row from
 * incident.service.findById() that the caller has already checked the user
 * may see (canUserView). Functions throw WorkflowError(status, message) for
 * the route to send; on success they write the timeline entry and audit log.
 */

const db                     = require('../repositories/db');
const repo                   = require('../repositories/incident.repository');
const { log: auditLog }      = require('./audit.service');
const { getUserPermissions } = require('./permission.service');
const notificationSvc        = require('./notification.service');
const { schoolToday, schoolDateTime, isIsoDate } = require('../utils/school-time');

const SEVERITIES = ['Low', 'Moderate', 'High', 'Critical'];
const STATUSES   = ['Submitted', 'Under Review', 'Assigned', 'In Progress',
                    'For Follow-Up', 'Resolved', 'Closed'];
const ASSIGNABLE_ROLES = ['safetyofficer', 'guidance', 'teacher'];

const MSG_NO_PERMISSION = 'You do not have permission to perform this status change.';
const MSG_SEVERITY      = 'Severity must be set before assignment.';
const MSG_RESOLUTION    = 'A resolution summary is required to mark this incident as Resolved.';
const MSG_CLOSED        = 'This incident is closed and can no longer be changed.';
const MSG_CLOSURE       = 'A closure summary is required to close this incident.';
const MSG_ARCHIVED      = 'This incident is archived. Restore it before making changes.';
const MSG_CONFLICT      = 'This incident was changed by someone else. Reload it and try again.';

class WorkflowError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Allowed transitions. A user may make a transition when they hold `permission`
 * and either their role is in `roles`, or they are actively assigned to the
 * incident and their role is in `assigneeRoles`.
 */
const RESPONSE = { roles: ['schoolhead'], assigneeRoles: ASSIGNABLE_ROLES, permission: 'respond_incidents' };
const TRANSITIONS = {
  'Submitted':     { 'Under Review':  { roles: ['sysadmin', 'schoolhead', 'safetyofficer'], assigneeRoles: [], permission: 'manage_incidents' } },
  'Under Review':  { 'Assigned':      { roles: ['schoolhead'], assigneeRoles: [], permission: 'assign_incidents' } },
  'Assigned':      { 'In Progress':   RESPONSE },
  'In Progress':   { 'For Follow-Up': RESPONSE, 'Resolved': RESPONSE },
  'For Follow-Up': { 'In Progress':   RESPONSE, 'Resolved': RESPONSE },
  // "SafetyOff (limited)": only a Safety Officer assigned to the incident
  'Resolved':      { 'Closed':        { roles: ['schoolhead', 'sysadmin'], assigneeRoles: ['safetyofficer'], permission: 'manage_incidents' } },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function hasPermission(user, code) {
  return getUserPermissions(user.id).has(code);
}

function ruleAllows(rule, user, incident) {
  if (!hasPermission(user, rule.permission)) return false;
  if (rule.roles.includes(user.role)) return true;
  return rule.assigneeRoles.includes(user.role) && repo.isActiveAssignee(incident.id, user.id);
}

// Could this role move any incident into `to`? Used to answer 403 before 422,
// so e.g. a Teacher asking to close gets "no permission" whatever the state.
function roleCanEverReach(role, to) {
  return Object.values(TRANSITIONS).some(targets => {
    const rule = targets[to];
    return rule && (rule.roles.includes(role) || rule.assigneeRoles.includes(role));
  });
}

function assertMutable(incident) {
  if (incident.is_archived) throw new WorkflowError(422, MSG_ARCHIVED);
  if (incident.status === 'Closed') throw new WorkflowError(422, MSG_CLOSED);
}

function cleanText(value, max) {
  if (value === undefined || value === null) return '';
  return String(value).trim().slice(0, max);
}

function audit(ctx, actionType, incident, oldValues, newValues) {
  auditLog({
    actorId:     ctx.user.id,
    actorName:   ctx.user.full_name,
    actorRole:   ctx.user.role,
    actionType,
    targetTable: 'incidents',
    targetId:    incident.id,
    oldValues,
    newValues:   { reference_number: incident.reference_number, ...newValues },
    ipAddress:   ctx.ip,
  });
}

// Runs fn inside a transaction. fn returns the rows its guarded update changed;
// 0 means someone else changed the incident first, so throw inside the
// transaction to roll back anything fn already wrote.
function applyGuarded(fn) {
  db.transaction(() => {
    if (!fn()) throw new WorkflowError(409, MSG_CONFLICT);
  })();
}

// Today's date and the current time in the configured school timezone.
function schoolClock() {
  const now = new Date();
  return { date: schoolToday(now), dateTime: schoolDateTime(now) };
}

// ── T-22: classify ───────────────────────────────────────────────────────────
/** Sets severity; a Submitted incident also moves to Under Review. */
function classify(ctx, incident, body) {
  const severity = body.severity;
  if (!SEVERITIES.includes(severity)) {
    throw new WorkflowError(400, `severity must be one of: ${SEVERITIES.join(', ')}.`);
  }
  assertMutable(incident);

  const fromStatus = incident.status;
  const toStatus   = fromStatus === 'Submitted' ? 'Under Review' : fromStatus;
  if (severity === incident.severity && toStatus === fromStatus) return { changed: false };

  const statusChanged = toStatus !== fromStatus;
  const severityText  = incident.severity
    ? `Severity changed from ${incident.severity} to ${severity}`
    : `Severity set to ${severity}`;

  applyGuarded(() => {
    const changed = repo.setClassification(incident.id, fromStatus, severity, toStatus);
    if (changed) {
      repo.addTimelineEntry({
        incident_id: incident.id,
        actor_id:    ctx.user.id,
        entry_type:  statusChanged ? 'Status Change' : 'Note',
        description: statusChanged
          ? `Reviewed by ${ctx.user.full_name}. ${severityText}; status changed from ${fromStatus} to ${toStatus}.`
          : `${severityText} by ${ctx.user.full_name}.`,
        old_status:  statusChanged ? fromStatus : null,
        new_status:  statusChanged ? toStatus : null,
      });
    }
    return changed;
  });

  audit(ctx, 'INCIDENT_CLASSIFIED', incident,
    { severity: incident.severity, status: fromStatus },
    { severity, status: toStatus });
  return { changed: true };
}

// ── T-22: status transitions ─────────────────────────────────────────────────
function changeStatus(ctx, incident, body) {
  const to = body.status;
  if (!STATUSES.includes(to)) {
    throw new WorkflowError(400, `status must be one of: ${STATUSES.join(', ')}.`);
  }
  assertMutable(incident);
  if (!roleCanEverReach(ctx.user.role, to)) throw new WorkflowError(403, MSG_NO_PERMISSION);

  const from = incident.status;
  const rule = TRANSITIONS[from] && TRANSITIONS[from][to];
  if (!rule) throw new WorkflowError(422, `Invalid transition from ${from} to ${to}.`);
  if (!ruleAllows(rule, ctx.user, incident)) throw new WorkflowError(403, MSG_NO_PERMISSION);

  if (to === 'Assigned') {
    if (!incident.severity) throw new WorkflowError(422, MSG_SEVERITY);
    // Assignment needs the people to assign; POST /assign moves it to Assigned.
    throw new WorkflowError(422, 'Use the Assign action to choose personnel; it moves the incident to Assigned.');
  }
  if (to === 'Closed') return close(ctx, incident, body);

  let resolution = null;
  if (to === 'Resolved') {
    resolution = cleanText(body.resolution_summary, 5000);
    if (!resolution) throw new WorkflowError(422, MSG_RESOLUTION);
  }

  applyGuarded(() => {
    const changed = repo.setStatus(incident.id, from, to, resolution);
    if (changed) {
      repo.addTimelineEntry({
        incident_id: incident.id,
        actor_id:    ctx.user.id,
        entry_type:  to === 'Resolved' ? 'Resolution' : 'Status Change',
        description: to === 'Resolved'
          ? `Marked Resolved by ${ctx.user.full_name}. Resolution summary: ${resolution}`
          : `Status changed from ${from} to ${to} by ${ctx.user.full_name}.`,
        old_status:  from,
        new_status:  to,
      });
    }
    return changed;
  });

  audit(ctx, 'INCIDENT_STATUS_CHANGED', incident,
    { status: from },
    resolution ? { status: to, resolution_summary: resolution } : { status: to });
}

// ── T-25: closure ────────────────────────────────────────────────────────────
/**
 * Resolved → Closed. Reached through changeStatus after the role and
 * transition checks. Records closed_by, closed_at and the closure summary;
 * a Closed incident then refuses every further change (assertMutable).
 */
function close(ctx, incident, body) {
  const summary = cleanText(body.closure_summary, 5000);
  if (!summary) throw new WorkflowError(422, MSG_CLOSURE);

  applyGuarded(() => {
    const changed = repo.closeIncident(incident.id, summary, ctx.user.id);
    if (changed) {
      repo.addTimelineEntry({
        incident_id: incident.id,
        actor_id:    ctx.user.id,
        entry_type:  'Closure',
        description: `Closed by ${ctx.user.full_name}. Closure summary: ${summary}`,
        old_status:  'Resolved',
        new_status:  'Closed',
      });
    }
    return changed;
  });

  audit(ctx, 'INCIDENT_CLOSED', incident,
    { status: 'Resolved' },
    { status: 'Closed', closure_summary: summary, closed_by: ctx.user.id });
}

// ── T-22: restrict ───────────────────────────────────────────────────────────
function parseFlag(value) {
  if (value === true || value === 1 || value === '1' || value === 'true') return 1;
  if (value === false || value === 0 || value === '0' || value === 'false') return 0;
  return null;
}

function setRestricted(ctx, incident, body) {
  if (ctx.user.role !== 'sysadmin' && ctx.user.role !== 'schoolhead') {
    throw new WorkflowError(403, 'Only the System Administrator or School Head can restrict incidents.');
  }
  const value = parseFlag(body.is_restricted);
  if (value === null) throw new WorkflowError(400, 'is_restricted must be true or false.');
  if (value === incident.is_restricted) return { changed: false };

  applyGuarded(() => {
    const changed = repo.setRestricted(incident.id, value);
    if (changed) {
      repo.addTimelineEntry({
        incident_id: incident.id,
        actor_id:    ctx.user.id,
        entry_type:  'Restriction Change',
        description: value
          ? `Marked as restricted by ${ctx.user.full_name}.`
          : `Restriction removed by ${ctx.user.full_name}.`,
      });
    }
    return changed;
  });

  audit(ctx, 'INCIDENT_RESTRICTION_CHANGED', incident,
    { is_restricted: incident.is_restricted },
    { is_restricted: value });
  return { changed: true };
}

// ── T-23: archive and restore ────────────────────────────────────────────────
function assertSysAdmin(ctx) {
  if (ctx.user.role !== 'sysadmin') {
    throw new WorkflowError(403, 'Only the System Administrator can archive or restore incidents.');
  }
}

function archive(ctx, incident, body) {
  assertSysAdmin(ctx);
  if (incident.is_archived) throw new WorkflowError(422, 'This incident is already archived.');
  if (incident.status !== 'Closed' && body.confirmed !== true) {
    throw new WorkflowError(400,
      `This incident is ${incident.status}, not Closed. Send confirmed: true to archive it anyway.`);
  }

  applyGuarded(() => {
    const changed = repo.setArchived(incident.id, 1);
    if (changed) {
      repo.addTimelineEntry({
        incident_id: incident.id,
        actor_id:    ctx.user.id,
        entry_type:  'Archive',
        description: `Archived by ${ctx.user.full_name} while ${incident.status}.`,
      });
    }
    return changed;
  });

  audit(ctx, 'INCIDENT_ARCHIVED', incident,
    { is_archived: 0, status: incident.status },
    { is_archived: 1, status: incident.status, confirmed: incident.status !== 'Closed' });
}

function restore(ctx, incident) {
  assertSysAdmin(ctx);
  if (!incident.is_archived) throw new WorkflowError(422, 'This incident is not archived.');

  applyGuarded(() => {
    const changed = repo.setArchived(incident.id, 0);
    if (changed) {
      repo.addTimelineEntry({
        incident_id: incident.id,
        actor_id:    ctx.user.id,
        entry_type:  'Restore',
        description: `Restored by ${ctx.user.full_name}; status remains ${incident.status}.`,
      });
    }
    return changed;
  });

  audit(ctx, 'INCIDENT_RESTORED', incident,
    { is_archived: 1, status: incident.status },
    { is_archived: 0, status: incident.status });
}

// ── T-24: assign ─────────────────────────────────────────────────────────────
/** SchHead assigns one or more response personnel; Under Review → Assigned. */
function assign(ctx, incident, body) {
  if (ctx.user.role !== 'schoolhead') {
    throw new WorkflowError(403, 'Only the School Head can assign incidents.');
  }
  assertMutable(incident);
  if (!incident.severity) throw new WorkflowError(422, MSG_SEVERITY);
  if (incident.status !== 'Under Review') {
    throw new WorkflowError(422,
      `Only incidents that are Under Review can be assigned (this one is ${incident.status}).`);
  }

  const raw = body.user_ids;
  if (!Array.isArray(raw) || !raw.length) {
    throw new WorkflowError(400, 'user_ids must be a non-empty array of user IDs.');
  }
  if (raw.length > 20) throw new WorkflowError(400, 'Assign at most 20 people at once.');
  const ids = [...new Set(raw.map(Number))];
  if (ids.some(n => !Number.isInteger(n) || n < 1)) {
    throw new WorkflowError(400, 'user_ids must contain user IDs.');
  }

  const users = repo.findUsersByIds(ids);
  const byId  = new Map(users.map(u => [u.id, u]));
  const bad   = ids.filter(id => {
    const u = byId.get(id);
    return !u || u.status !== 'Active' || !ASSIGNABLE_ROLES.includes(u.role);
  });
  if (bad.length) {
    throw new WorkflowError(422,
      `These users cannot be assigned (must be active Safety Officer, Guidance, or Teacher accounts): ${bad.join(', ')}.`);
  }
  const names = ids.map(id => byId.get(id).full_name);
  const ref   = incident.reference_number;

  applyGuarded(() => {
    const changed = repo.setStatus(incident.id, 'Under Review', 'Assigned', null);
    if (!changed) return 0;
    ids.forEach(uid => repo.addAssignment(incident.id, uid, ctx.user.id));
    repo.addTimelineEntry({
      incident_id: incident.id,
      actor_id:    ctx.user.id,
      entry_type:  'Assignment',
      description: `Assigned to ${names.join(', ')} by ${ctx.user.full_name}.`,
      old_status:  'Under Review',
      new_status:  'Assigned',
    });
    ids.forEach(uid => notificationSvc.create({
      userId:  uid,
      type:    'New Assignment',
      title:   `New Assignment: ${ref}`,
      message: `You have been assigned to incident ${ref}.`,
      link:    `/api/incidents/${incident.id}`,
    }));
    return changed;
  });

  audit(ctx, 'INCIDENT_ASSIGNED', incident,
    { status: 'Under Review' },
    { status: 'Assigned', assigned_to: ids });
}

// ── T-24: acknowledge ────────────────────────────────────────────────────────
/** An assigned user acknowledges; the first acknowledgement moves Assigned → In Progress. */
function acknowledge(ctx, incident) {
  assertMutable(incident);
  const assignment = repo.findActiveAssignment(incident.id, ctx.user.id);
  if (!assignment) {
    throw new WorkflowError(403, 'Only personnel assigned to this incident can acknowledge it.');
  }
  if (assignment.acknowledged_at) {
    throw new WorkflowError(422, 'You have already acknowledged this assignment.');
  }
  if (!['Assigned', 'In Progress', 'For Follow-Up'].includes(incident.status)) {
    throw new WorkflowError(422, `Assignments cannot be acknowledged while the incident is ${incident.status}.`);
  }

  const from  = incident.status;
  const moves = from === 'Assigned';
  const to    = moves ? 'In Progress' : from;
  const when  = schoolClock().dateTime;

  applyGuarded(() => {
    if (!repo.acknowledgeAssignment(assignment.id)) return 0;
    if (moves ? !repo.setStatus(incident.id, from, to, null) : !repo.touch(incident.id, [from])) return 0;
    repo.addTimelineEntry({
      incident_id: incident.id,
      actor_id:    ctx.user.id,
      entry_type:  'Acknowledgement',
      description: `${ctx.user.full_name} acknowledged assignment on ${when}.`,
      old_status:  moves ? from : null,
      new_status:  moves ? to : null,
    });
    return 1;
  });

  audit(ctx, 'INCIDENT_ACKNOWLEDGED', incident, { status: from }, { status: to, acknowledged_at: when });
}

// ── T-24: actions ────────────────────────────────────────────────────────────
/**
 * Adds an Action entry, optionally with a next follow-up date.
 * Reminders are not scheduled here; the T-26 job reads follow_up_date.
 */
function addAction(ctx, incident, body) {
  assertMutable(incident);
  if (ctx.user.role !== 'schoolhead' && !repo.isActiveAssignee(incident.id, ctx.user.id)) {
    throw new WorkflowError(403, 'Only assigned personnel or the School Head can record actions.');
  }
  if (!['In Progress', 'For Follow-Up'].includes(incident.status)) {
    throw new WorkflowError(422,
      `Actions can only be recorded while the incident is In Progress or For Follow-Up (this one is ${incident.status}).`);
  }

  const description = cleanText(body.description, 2001);
  if (!description) throw new WorkflowError(400, 'Action description is required.');
  if (description.length > 2000) throw new WorkflowError(400, 'Action description must be 2000 characters or fewer.');

  let followUp = null;
  if (body.follow_up_date !== undefined && body.follow_up_date !== null && body.follow_up_date !== '') {
    followUp = String(body.follow_up_date);
    if (!isIsoDate(followUp)) {
      throw new WorkflowError(400, 'Follow-up date must be a real date (YYYY-MM-DD).');
    }
    if (followUp < schoolClock().date) throw new WorkflowError(422, 'Follow-up date cannot be in the past.');
  }

  let entryId;
  applyGuarded(() => {
    if (!repo.touch(incident.id, ['In Progress', 'For Follow-Up'])) return 0;
    entryId = Number(repo.addTimelineEntry({
      incident_id:    incident.id,
      actor_id:       ctx.user.id,
      entry_type:     'Action',
      description,
      follow_up_date: followUp,
    }).lastInsertRowid);
    return 1;
  });

  audit(ctx, 'INCIDENT_ACTION_ADDED', incident, null,
    { entry_id: entryId, description: description.slice(0, 200), follow_up_date: followUp });

  const entry = repo.getTimeline(incident.id).find(e => e.id === entryId);
  return { response: { status: 201, body: entry } };
}

module.exports = {
  WorkflowError,
  SEVERITIES,
  STATUSES,
  ASSIGNABLE_ROLES,
  MSG_NO_PERMISSION,
  MSG_SEVERITY,
  MSG_RESOLUTION,
  MSG_CLOSED,
  MSG_CLOSURE,
  classify,
  changeStatus,
  setRestricted,
  archive,
  restore,
  assign,
  acknowledge,
  addAction,
  schoolClock,
};
