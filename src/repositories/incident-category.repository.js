'use strict';

const db = require('./db');

/**
 * Returns all incident categories ordered by name.
 */
function findAll() {
  return db.prepare(`
    SELECT id, name, is_active, created_at
    FROM incident_categories
    ORDER BY name ASC
  `).all();
}

/**
 * Returns only active (is_active = 1) categories ordered by name.
 */
function findAllActive() {
  return db.prepare(`
    SELECT id, name, is_active, created_at
    FROM incident_categories
    WHERE is_active = 1
    ORDER BY name ASC
  `).all();
}

/**
 * Returns a single category by id, or undefined if not found.
 */
function findById(id) {
  return db.prepare(`
    SELECT id, name, is_active, created_at
    FROM incident_categories
    WHERE id = ?
  `).get(id);
}

/**
 * Inserts a new category. Throws on UNIQUE constraint violation.
 * @returns {object} better-sqlite3 RunResult with lastInsertRowid
 */
function create({ name, created_by }) {
  return db.prepare(`
    INSERT INTO incident_categories (name, created_by)
    VALUES (?, ?)
  `).run(name, created_by ?? null);
}

/**
 * Updates the provided fields (name and/or is_active) for the given id.
 * @param {number} id
 * @param {object} fields  — subset of { name, is_active }
 * @returns {object} better-sqlite3 RunResult
 */
function update(id, fields) {
  const setClauses = [];
  const params = [];

  if (fields.name !== undefined) {
    setClauses.push('name = ?');
    params.push(fields.name);
  }
  if (fields.is_active !== undefined) {
    setClauses.push('is_active = ?');
    params.push(fields.is_active);
  }

  if (setClauses.length === 0) {
    return { changes: 0 };
  }

  params.push(id);
  return db.prepare(`
    UPDATE incident_categories
    SET ${setClauses.join(', ')}
    WHERE id = ?
  `).run(...params);
}

/**
 * Returns true if any incident references this category.
 */
function isLinkedToIncidents(id) {
  const row = db.prepare(`
    SELECT 1 FROM incidents WHERE category_id = ? LIMIT 1
  `).get(id);
  return !!row;
}

module.exports = { findAll, findAllActive, findById, create, update, isLinkedToIncidents };
