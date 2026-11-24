'use strict';

const db = require('./db');

/**
 * Returns all campus locations ordered by name.
 */
function findAll() {
  return db.prepare(`
    SELECT id, name, description, coord_x, coord_y, is_active, created_at
    FROM campus_locations
    ORDER BY name ASC
  `).all();
}

/**
 * Returns only active (is_active = 1) campus locations ordered by name.
 */
function findAllActive() {
  return db.prepare(`
    SELECT id, name, description, coord_x, coord_y, is_active, created_at
    FROM campus_locations
    WHERE is_active = 1
    ORDER BY name ASC
  `).all();
}

/**
 * Returns a single campus location by id, or undefined if not found.
 */
function findById(id) {
  return db.prepare(`
    SELECT id, name, description, coord_x, coord_y, is_active, created_at
    FROM campus_locations
    WHERE id = ?
  `).get(id);
}

/**
 * Inserts a new campus location.
 * Throws on UNIQUE constraint violation (duplicate name).
 * @returns {object} better-sqlite3 RunResult with lastInsertRowid
 */
function create({ name, description, coord_x, coord_y, created_by }) {
  return db.prepare(`
    INSERT INTO campus_locations (name, description, coord_x, coord_y, created_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    name,
    description ?? null,
    coord_x     ?? null,
    coord_y     ?? null,
    created_by  ?? null,
  );
}

/**
 * Updates the provided fields for the given id.
 * @param {number} id
 * @param {object} fields — subset of { name, description, coord_x, coord_y, is_active }
 * @returns {object} better-sqlite3 RunResult
 */
function update(id, fields) {
  const setClauses = [];
  const params     = [];

  if (fields.name        !== undefined) { setClauses.push('name = ?');        params.push(fields.name);        }
  if (fields.description !== undefined) { setClauses.push('description = ?'); params.push(fields.description); }
  if (fields.coord_x     !== undefined) { setClauses.push('coord_x = ?');     params.push(fields.coord_x);     }
  if (fields.coord_y     !== undefined) { setClauses.push('coord_y = ?');     params.push(fields.coord_y);     }
  if (fields.is_active   !== undefined) { setClauses.push('is_active = ?');   params.push(fields.is_active);   }

  if (setClauses.length === 0) return { changes: 0 };

  params.push(id);
  return db.prepare(`
    UPDATE campus_locations
    SET ${setClauses.join(', ')}
    WHERE id = ?
  `).run(...params);
}

module.exports = { findAll, findAllActive, findById, create, update };
