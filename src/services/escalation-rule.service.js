'use strict';

const repo = require('../repositories/escalation-rule.repository');

function findAll()         { return repo.findAll(); }
function findById(id)      { return repo.findById(id); }
function create(data)      { return repo.create(data); }
function update(id, fields){ return repo.update(id, fields); }

module.exports = { findAll, findById, create, update };
