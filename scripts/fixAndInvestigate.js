const Database = require('better-sqlite3');
const db = new Database('./data/investments.db');

// Fix Kingfisher ISIN
const r = db.prepare("UPDATE investments SET notes = REPLACE(notes, 'INE438A01022', 'INE438H01019') WHERE id = 62").run();
console.log('Updated Kingfisher ISIN:', r.changes, 'rows');
console.log('New notes:', db.prepare('SELECT notes FROM investments WHERE id=62').get());

// Check Yes Bank transactions
console.log('\n=== Yes Bank (id=59) transactions ===');
const yb = db.prepare('SELECT * FROM transactions WHERE investment_id = 59 ORDER BY transaction_date').all();
yb.forEach(t => console.log(`  ${t.transaction_date} | ${t.transaction_type} | ${t.units} @ ${t.price_per_unit} | ${t.notes || ''}`));
console.log('Total transactions:', yb.length);

// Check Yes Bank investment details
console.log('\n=== Yes Bank investment record ===');
console.log(db.prepare('SELECT * FROM investments WHERE id=59').get());

// Check ICICI Pru Life transactions  
console.log('\n=== ICICI Pru Life (id=67) transactions ===');
const ip = db.prepare('SELECT * FROM transactions WHERE investment_id = 67 ORDER BY transaction_date').all();
ip.forEach(t => console.log(`  ${t.transaction_date} | ${t.transaction_type} | ${t.units} @ ${t.price_per_unit} | ${t.notes || ''}`));

db.close();
