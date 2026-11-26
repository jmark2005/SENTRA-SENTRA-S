'use strict';

const repo           = require('../repositories/incident.repository');
const { getSetting } = require('./settings.service');

function generateRefNumber(year)      { return repo.generateRefNumber(year); }
function create(data)                 { return repo.create(data); }
function findById(id)                 { return repo.findById(id); }
function findByRef(ref)               { return repo.findByRef(ref); }
function list(opts)                   { return repo.list(opts); }
function getParties(incidentId)       { return repo.getParties(incidentId); }
function addParty(data)               { return repo.addParty(data); }
function getAttachments(incidentId)   { return repo.getAttachments(incidentId); }
function addTimelineEntry(data)       { return repo.addTimelineEntry(data); }
function getTimeline(incidentId)      { return repo.getTimeline(incidentId); }
function getAssignments(incidentId)   { return repo.getAssignments(incidentId); }
function listAssignableUsers()        { return repo.listAssignableUsers(); }

/**
 * Whether `user` (req.user) may see `incident` (a findById row).
 * One rule shared by GET /api/incidents/:id and the attachment routes.
 */
function canUserView(user, incident) {
  const { role, id: userId } = user;

  // Archived incidents: SysAdmin only
  if (incident.is_archived && role !== 'sysadmin') return false;

  // Restricted incidents: SysAdmin, SchHead, and actively assigned users
  if (incident.is_restricted && role !== 'sysadmin' && role !== 'schoolhead'
      && !repo.isActiveAssignee(incident.id, userId)) {
    return false;
  }

  // Teacher/Guidance: own reports or incidents assigned to them
  if (role === 'teacher' || role === 'guidance') {
    return incident.reporter_id === userId || repo.isActiveAssignee(incident.id, userId);
  }

  // Student: own reports, and only while the student feature is on
  if (role === 'student') {
    const flag = getSetting('student_feature_enabled');
    if (!flag || flag === '0') return false;
    return incident.reporter_id === userId;
  }

  return true;
}

module.exports = {
  generateRefNumber, create, findById, findByRef, list,
  getParties, addParty, getAttachments, addTimelineEntry, getTimeline,
  getAssignments, listAssignableUsers,
  canUserView,
};
