'use strict';

const repo = require('../repositories/incident.repository');

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

module.exports = {
  generateRefNumber, create, findById, findByRef, list,
  getParties, addParty, getAttachments, addTimelineEntry, getTimeline,
};
