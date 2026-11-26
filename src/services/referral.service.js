'use strict';

/**
 * Student support referrals (T-27 onward).
 * Requirements: requirements.md US-4.1 to US-4.5.
 *
 * Scope rule: referrals hold administrative information only. There are no
 * fields for counseling notes, diagnosis, or clinical content, and the
 * system makes no automated welfare decisions.
 */

const db                = require('../repositories/db');
const repo              = require('../repositories/referral.repository');
const notificationSvc   = require('./notification.service');
const { log: auditLog } = require('./audit.service');
const { getUserPermissions } = require('./permission.service');
const { schoolToday, isIsoDate } = require('../utils/school-time');

const TYPES    = ['Academic Assistance', 'Guidance Referral', 'Attendance-Related Follow-Up', 'Other School-Based Support'];
const STATUSES = ['Pending', 'Ongoing', 'Completed', 'Referred'];

class ReferralError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function toId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function cleanText(value, max) {
  if (value === undefined || value === null) return '';
  return String(value).trim().slice(0, max);
}

function audit(ctx, actionType, referral, oldValues, newValues) {
  auditLog({
    actorId:     ctx.user.id,
    actorName:   ctx.user.full_name,
    actorRole:   ctx.user.role,
    actionType,
    targetTable: 'referrals',
    targetId:    referral.id,
    oldValues,
    newValues,
    ipAddress:   ctx.ip,
  });
}

// ── Visibility ───────────────────────────────────────────────────────────────

/** Whether `user` may open `referral`. Mirrors the list scoping in the repository. */
function canUserView(user, referral) {
  if (referral.is_archived) return user.role === 'sysadmin';
  switch (user.role) {
    case 'sysadmin':
    case 'schoolhead':
      return true;
    case 'guidance':
      return (referral.status === 'Pending' && !referral.assigned_to)
        || referral.assigned_to === user.id || referral.referring_user === user.id;
    case 'teacher':
      return referral.referring_user === user.id || referral.assigned_to === user.id;
    default:
      return false;
  }
}

/**
 * Someone whose only link is having submitted the referral sees its status
 * but not the follow-up record or final notes of the person handling it.
 */
function hasFullView(user, referral) {
  if (user.role === 'sysadmin' || user.role === 'schoolhead') return true;
  if (referral.assigned_to === user.id) return true;
  return user.role === 'guidance' && referral.status === 'Pending' && !referral.assigned_to;
}

function detailFor(user, referral) {
  if (hasFullView(user, referral)) {
    return { ...referral, followups: repo.getFollowups(referral.id), limited_view: false };
  }
  const { completion_note, referred_destination, ...rest } = referral;
  return { ...rest, limited_view: true };
}

// ── T-27: submit ─────────────────────────────────────────────────────────────

function submit(ctx, body) {
  const studentId = toId(body.student_id);
  if (!studentId) throw new ReferralError(400, 'Choose a student.');
  const student = repo.findActiveStudent(studentId);
  if (!student) throw new ReferralError(422, 'Student not found or not active.');

  if (!TYPES.includes(body.referral_type)) {
    throw new ReferralError(400, `referral_type must be one of: ${TYPES.join(', ')}.`);
  }
  const date = String(body.referral_date || '');
  if (!isIsoDate(date)) throw new ReferralError(400, 'Referral date must be a real date (YYYY-MM-DD).');
  if (date > schoolToday()) throw new ReferralError(422, 'Referral date cannot be in the future.');

  const remarks = cleanText(body.remarks, 1001);
  if (remarks.length > 1000) throw new ReferralError(400, 'Remarks must be 1000 characters or fewer.');

  let id;
  db.transaction(() => {
    id = repo.create({
      student_id:     studentId,
      referral_type:  body.referral_type,
      referral_date:  date,
      referring_user: ctx.user.id,
      remarks,
    });
    // US-4.1: route to the Guidance queue and notify every active Guidance user
    notificationSvc.createForRole('guidance', {
      type:    'System Notice',
      title:   'New Referral',
      message: `New referral submitted for ${student.student_number} by ${ctx.user.full_name}.`,
      link:    null,
    });
  })();

  // Remarks are not copied into the audit log.
  audit(ctx, 'REFERRAL_SUBMITTED', { id }, null, {
    student_id:     studentId,
    student_number: student.student_number,
    referral_type:  body.referral_type,
    referral_date:  date,
    status:         'Pending',
    has_remarks:    remarks.length > 0,
  });
  return id;
}

// ── T-28 helpers ─────────────────────────────────────────────────────────────

const ASSIGNEE_ROLES = ['guidance', 'teacher']; // US-4.2 counselor; US-4.3 "Teacher (if assigned)"
const FINAL = ['Completed', 'Referred'];
const MSG_CONFLICT = 'This referral was changed by someone else. Reload it and try again.';

function hasPermission(user, code) {
  return getUserPermissions(user.id).has(code);
}

/** Guidance or School Head holding manage_referrals (US-4.2, US-4.4). */
function isManager(user) {
  return (user.role === 'guidance' || user.role === 'schoolhead') && hasPermission(user, 'manage_referrals');
}

function assertOpen(referral) {
  if (referral.is_archived) {
    throw new ReferralError(422, 'This referral is archived. Restore it before making changes.');
  }
  if (FINAL.includes(referral.status)) {
    throw new ReferralError(422, `This referral is ${referral.status} and read-only; no further changes can be made.`);
  }
}

// Throwing inside the transaction rolls back anything already written.
function applyGuarded(fn) {
  db.transaction(() => {
    if (!fn()) throw new ReferralError(409, MSG_CONFLICT);
  })();
}

// ── T-28: assign ─────────────────────────────────────────────────────────────
/** Pending → Ongoing with an owner; reassigning an Ongoing referral keeps it Ongoing. */
function assign(ctx, referral, body) {
  if (!isManager(ctx.user)) {
    throw new ReferralError(403, 'Only Guidance or the School Head can assign referrals.');
  }
  assertOpen(referral);

  const userId = toId(body.user_id);
  if (!userId) throw new ReferralError(400, 'Choose a person to assign.');
  const assignee = repo.findUserWithRole(userId);
  if (!assignee || assignee.status !== 'Active' || !ASSIGNEE_ROLES.includes(assignee.role)) {
    throw new ReferralError(422, 'Referrals can only be assigned to an active Guidance or Teacher account.');
  }
  if (referral.status === 'Ongoing' && referral.assigned_to === userId) {
    throw new ReferralError(422, 'This referral is already assigned to that person.');
  }

  const from = referral.status;
  applyGuarded(() => {
    const changed = repo.setAssigned(referral.id, from, userId, 'Ongoing');
    if (changed) {
      notificationSvc.create({
        userId,
        type:    'New Assignment',
        title:   `Referral #${referral.id} assigned`,
        message: `You have been assigned referral #${referral.id} for student ${referral.student_number}.`,
        link:    null,
      });
    }
    return changed;
  });

  audit(ctx, 'REFERRAL_ASSIGNED', referral,
    { status: from, assigned_to: referral.assigned_to },
    { status: 'Ongoing', assigned_to: userId });
}

// ── T-28: follow-ups ─────────────────────────────────────────────────────────
/**
 * Adds an administrative follow-up entry (no clinical fields exist).
 * Reminders are not scheduled here; the T-26 job reads next_followup.
 */
function addFollowup(ctx, referral, body) {
  const isAssignee = referral.assigned_to === ctx.user.id;
  if (!isAssignee && !(ctx.user.role === 'schoolhead' && hasPermission(ctx.user, 'manage_referrals'))) {
    throw new ReferralError(403, 'Only the assigned person or the School Head can record follow-ups.');
  }
  assertOpen(referral);
  if (referral.status !== 'Ongoing') {
    throw new ReferralError(422, 'Assign this referral before recording follow-ups.');
  }

  const desc = cleanText(body.activity_desc, 2001);
  if (!desc) throw new ReferralError(400, 'Activity description is required.');
  if (desc.length > 2000) throw new ReferralError(400, 'Activity description must be 2000 characters or fewer.');

  const today = schoolToday();
  const activityDate = body.activity_date ? String(body.activity_date) : today;
  if (!isIsoDate(activityDate)) throw new ReferralError(400, 'Activity date must be a real date (YYYY-MM-DD).');
  if (activityDate > today) throw new ReferralError(422, 'Activity date cannot be in the future.');

  let next = null;
  if (body.next_followup !== undefined && body.next_followup !== null && body.next_followup !== '') {
    next = String(body.next_followup);
    if (!isIsoDate(next)) throw new ReferralError(400, 'Next follow-up date must be a real date (YYYY-MM-DD).');
    if (next < today) throw new ReferralError(422, 'Next follow-up date cannot be in the past.');
  }

  let entryId;
  applyGuarded(() => {
    if (!repo.touchOngoing(referral.id)) return 0;
    entryId = repo.addFollowup({
      referral_id:   referral.id,
      actor_id:      ctx.user.id,
      activity_desc: desc,
      activity_date: activityDate,
      next_followup: next,
    });
    return 1;
  });

  // The activity text stays out of the audit log.
  audit(ctx, 'REFERRAL_FOLLOWUP_ADDED', referral, null,
    { followup_id: entryId, activity_date: activityDate, next_followup: next });
  return repo.getFollowups(referral.id).find(f => f.id === entryId);
}

// ── T-28: complete or refer on ───────────────────────────────────────────────
function changeStatus(ctx, referral, body) {
  const to = body.status;
  if (!STATUSES.includes(to)) throw new ReferralError(400, `status must be one of: ${STATUSES.join(', ')}.`);
  if (!isManager(ctx.user)) {
    throw new ReferralError(403, 'Only Guidance or the School Head can change a referral\'s status.');
  }
  assertOpen(referral);

  if (to === 'Ongoing') {
    throw new ReferralError(422, 'Use the Assign action to move a referral to Ongoing.');
  }
  if (!FINAL.includes(to) || referral.status !== 'Ongoing') {
    throw new ReferralError(422, `Invalid transition from ${referral.status} to ${to}.`);
  }
  // A Guidance user may only close referrals assigned to them.
  if (ctx.user.role === 'guidance' && referral.assigned_to !== ctx.user.id) {
    throw new ReferralError(403, 'Only the assigned counselor or the School Head can complete this referral.');
  }

  let note = null;
  let destination = null;
  if (to === 'Completed') {
    note = cleanText(body.completion_note, 2001);
    if (!note) throw new ReferralError(422, 'Completion note is required.');
    if (note.length > 2000) throw new ReferralError(400, 'Completion note must be 2000 characters or fewer.');
  } else {
    destination = cleanText(body.referred_destination, 301);
    if (!destination) throw new ReferralError(422, 'Referral destination is required.');
    if (destination.length > 300) throw new ReferralError(400, 'Referral destination must be 300 characters or fewer.');
  }

  applyGuarded(() => repo.setFinalStatus(referral.id, to, note, destination));

  audit(ctx, 'REFERRAL_STATUS_CHANGED', referral,
    { status: referral.status },
    { status: to, has_completion_note: !!note, referred_destination: destination });
}

// ── T-28: archive and restore (SysAdmin) ─────────────────────────────────────
function assertSysAdmin(ctx) {
  if (ctx.user.role !== 'sysadmin') {
    throw new ReferralError(403, 'Only the System Administrator can archive or restore referrals.');
  }
}

function archive(ctx, referral, body) {
  assertSysAdmin(ctx);
  if (referral.is_archived) throw new ReferralError(422, 'This referral is already archived.');
  if (!FINAL.includes(referral.status) && body.confirmed !== true) {
    throw new ReferralError(400,
      `This referral is ${referral.status}, not finished. Send confirmed: true to archive it anyway.`);
  }
  applyGuarded(() => repo.setArchived(referral.id, 1));
  audit(ctx, 'REFERRAL_ARCHIVED', referral,
    { is_archived: 0, status: referral.status },
    { is_archived: 1, status: referral.status });
}

function restore(ctx, referral) {
  assertSysAdmin(ctx);
  if (!referral.is_archived) throw new ReferralError(422, 'This referral is not archived.');
  applyGuarded(() => repo.setArchived(referral.id, 0));
  audit(ctx, 'REFERRAL_RESTORED', referral,
    { is_archived: 1, status: referral.status },
    { is_archived: 0, status: referral.status });
}

module.exports = {
  ReferralError,
  TYPES,
  STATUSES,
  canUserView,
  detailFor,
  submit,
  assign,
  addFollowup,
  changeStatus,
  archive,
  restore,
  isManager,
  findById:            repo.findById,
  list:                repo.list,
  listArchived:        repo.listArchived,
  listAssignableUsers: repo.listAssignableUsers,
};
