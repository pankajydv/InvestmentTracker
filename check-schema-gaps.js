const Database = require('better-sqlite3');
const db = new Database('data/investments.db');

// Check the schema first
const schema = db.prepare("PRAGMA table_info(daily_data_gaps)").all();
console.log('daily_data_gaps schema:');
console.log(JSON.stringify(schema, null, 2));

// Also check if the table exists
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%gap%'").all();
console.log('\nTables with "gap" in name:');
console.log(JSON.stringify(tables, null, 2));

// Check all tables that might hold LOCF info
const allTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
console.log('\nAll tables:');
console.log(allTables.map(t => t.name).join(', '));
