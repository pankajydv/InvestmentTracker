const Database = require('better-sqlite3');
const db = new Database('data/investments.db');

const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='dirty_backfill_scope'").get();
console.log('Schema:');
console.log(schema.sql);

// Also check constraints
const constraints = db.prepare("PRAGMA table_info(dirty_backfill_scope)").all();
console.log('\nColumns:');
console.log(constraints);
