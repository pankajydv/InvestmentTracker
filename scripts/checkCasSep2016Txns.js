const Database = require('better-sqlite3');
const db = new Database('./data/investments.db');

// CAS Sep 2016 transactions found:
// 1. BPCL: INTDEP-CR 8 shares on 2016-09-15 (buy delivery into demat)
// 2. Hero MotoCorp: EP-DR 5 shares on 2016-09-06 (sell delivery out of demat)
// 3. ICICI Pru Life: IPO 44 shares on 2016-09-27

console.log('=== Checking existing transactions ===\n');

// BPCL (id=66)
console.log('BPCL (id=66):');
const bpcl = db.prepare("SELECT * FROM transactions WHERE investment_id=66 ORDER BY transaction_date").all();
bpcl.forEach(t => console.log(`  ${t.transaction_date} ${t.transaction_type} ${t.units} @ ${t.price_per_unit} | ${t.notes}`));
const bpclNet = bpcl.reduce((s,t) => s + (['BUY','BONUS','SPLIT','IPO','TRANSFER_IN','RIGHTS'].includes(t.transaction_type) ? t.units : -t.units), 0);
console.log(`  Net: ${bpclNet}\n`);

// Hero MotoCorp (id=57)
console.log('Hero MotoCorp (id=57):');
const hero = db.prepare("SELECT * FROM transactions WHERE investment_id=57 ORDER BY transaction_date").all();
hero.forEach(t => console.log(`  ${t.transaction_date} ${t.transaction_type} ${t.units} @ ${t.price_per_unit} | ${t.notes}`));
const heroNet = hero.reduce((s,t) => s + (['BUY','BONUS','SPLIT','IPO','TRANSFER_IN','RIGHTS'].includes(t.transaction_type) ? t.units : -t.units), 0);
console.log(`  Net: ${heroNet}\n`);

// ICICI Pru Life (id=67)
console.log('ICICI Pru Life (id=67):');
const icici = db.prepare("SELECT * FROM transactions WHERE investment_id=67 ORDER BY transaction_date").all();
icici.forEach(t => console.log(`  ${t.transaction_date} ${t.transaction_type} ${t.units} @ ${t.price_per_unit} | ${t.notes}`));
const iciciNet = icici.reduce((s,t) => s + (['BUY','BONUS','SPLIT','IPO','TRANSFER_IN','RIGHTS'].includes(t.transaction_type) ? t.units : -t.units), 0);
console.log(`  Net: ${iciciNet}\n`);

db.close();
