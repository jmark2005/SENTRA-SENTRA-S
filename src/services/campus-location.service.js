'use strict';

const repo = require('../repositories/campus-location.repository');

function findAll()         { return repo.findAll(); }
function findAllActive()   { return repo.findAllActive(); }
function findById(id)      { return repo.findById(id); }
function create(data)      { return repo.create(data); }
function update(id, fields){ return repo.update(id, fields); }

module.exports = { findAll, findAllActive, findById, create, update };
