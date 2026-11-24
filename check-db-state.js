'use strict';
const Database = require('better-sqlite3');
const path = require('path');
try {
  const db = new Database(path.resolve(__dirname, 'db/sentra.db'));
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
  console.log('Tables:', JSON.stringify(tables));
  const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name").all().map(r => r.name);
  console.log('Triggers:', JSON.stringify(triggers));
  db.close();
} catch(e) { console.error(e.message); }
