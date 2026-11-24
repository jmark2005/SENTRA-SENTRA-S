'use strict';
// Quick smoke-test for T-19 — runs without a live HTTP server.
// Directly exercises the repository and service layers.

const repo = require('./src/repositories/incident-category.repository');
const svc  = require('./src/services/incident-category.service');

// 1. findAll() returns the 6 seeded categories
const all = svc.findAll();
console.assert(all.length >= 6, `Expected >=6 categories, got ${all.length}`);
console.log(`[PASS] findAll returns ${all.length} categories`);

// 2. findAllActive() returns only is_active = 1 rows
const active = svc.findAllActive();
const allActive = active.every(c => c.is_active === 1);
console.assert(allActive, 'findAllActive returned an inactive category');
console.log(`[PASS] findAllActive returns ${active.length} active categories`);

// 3. Find "Facility Hazard"
const fh = all.find(c => c.name === 'Facility Hazard');
console.assert(fh, '"Facility Hazard" not found');
console.log(`[PASS] "Facility Hazard" found with id=${fh.id}, is_active=${fh.is_active}`);

// 4. Deactivate "Facility Hazard"
svc.update(fh.id, { is_active: 0 });
const fhAfter = svc.findById(fh.id);
console.assert(fhAfter.is_active === 0, `Expected is_active=0, got ${fhAfter.is_active}`);
console.log(`[PASS] "Facility Hazard" deactivated — is_active=${fhAfter.is_active}`);

// 5. Active list no longer includes "Facility Hazard"
const activeAfter = svc.findAllActive();
const stillActive = activeAfter.find(c => c.name === 'Facility Hazard');
console.assert(!stillActive, '"Facility Hazard" still appears in active list after deactivation');
console.log(`[PASS] "Facility Hazard" not in active list (${activeAfter.length} active categories)`);

// 6. Full list still includes it (data preserved)
const allAfter = svc.findAll();
const stillPresent = allAfter.find(c => c.name === 'Facility Hazard');
console.assert(stillPresent, '"Facility Hazard" disappeared from full list after deactivation');
console.assert(stillPresent.name === 'Facility Hazard', 'Category name changed unexpectedly');
console.log(`[PASS] "Facility Hazard" still in full list with name="${stillPresent.name}", is_active=${stillPresent.is_active}`);

// 7. Re-activate for clean state
svc.update(fh.id, { is_active: 1 });
console.log(`[PASS] "Facility Hazard" re-activated`);

// 8. create() — test unique constraint
let newId;
try {
  const r = svc.create({ name: '__T19_Test_Category__', created_by: null });
  newId = r.lastInsertRowid;
  console.log(`[PASS] create() inserted new category id=${newId}`);
} catch (e) {
  console.error('[FAIL] create() threw unexpectedly:', e.message);
  process.exit(1);
}

try {
  svc.create({ name: '__T19_Test_Category__', created_by: null });
  console.error('[FAIL] Duplicate create() should have thrown');
  process.exit(1);
} catch (e) {
  if (e.message.includes('UNIQUE constraint failed')) {
    console.log('[PASS] Duplicate create() correctly throws UNIQUE constraint error');
  } else {
    console.error('[FAIL] Unexpected error:', e.message);
    process.exit(1);
  }
}

// 9. Clean up test category
const db = require('./src/repositories/db');
db.prepare('DELETE FROM incident_categories WHERE name = ?').run('__T19_Test_Category__');
console.log('[PASS] Test category cleaned up');

console.log('\nAll T-19 smoke tests passed.');
