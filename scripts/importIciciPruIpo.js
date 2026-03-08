const Database = require('better-sqlite3');
const db = new Database('./data/investments.db');

// ICICI Prudential Life Insurance IPO - 44 shares allotted on 2016-09-27
// IPO issue price: Rs 334 per share (upper end of price band Rs 300-334)
// Source: CDSL CAS Sep 2016 - "INITIAL PUBLIC OFFERING 00125921 00000000 9107709 CREDIT"
const insert = db.prepare(`INSERT INTO transactions (investment_id, transaction_type, transaction_date, units, price_per_unit, amount, fees, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`);

insert.run(67, 'IPO', '2016-09-27', 44, 334, 44 * 334, 0, 'ICICI Prudential Life Insurance IPO allotment. From CDSL CAS Sep 2016.');
console.log('Inserted ICICI Pru Life IPO: 44 shares @ Rs 334 on 2016-09-27');

// Verify balance
const txns = db.prepare('SELECT transaction_type, units, transaction_date, price_per_unit FROM transactions WHERE investment_id = 67 ORDER BY transaction_date').all();
console.log('\nICICI Pru Life transactions:');
txns.forEach(t => console.log(`  ${t.transaction_date} ${t.transaction_type} ${t.units} @ ${t.price_per_unit}`));

const net = txns.reduce((sum, t) => {
  if (['BUY','BONUS','SPLIT','IPO','TRANSFER_IN','RIGHTS'].includes(t.transaction_type)) return sum + t.units;
  if (['SELL','TRANSFER_OUT'].includes(t.transaction_type)) return sum - t.units;
  return sum;
}, 0);
console.log(`\nNet balance: ${net}`);

db.close();
