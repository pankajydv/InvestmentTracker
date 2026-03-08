const Database = require('better-sqlite3');
const db = new Database('./data/investments.db');

// Yes Bank (id=59): SELL 6 @ 1300 on 2016-08-16 from NSE-Contract-20160816.pdf
const insert = db.prepare(`INSERT INTO transactions (investment_id, transaction_type, transaction_date, units, price_per_unit, amount, fees, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`);

insert.run(59, 'SELL', '2016-08-16', 6, 1300, 7800, 0, 'Sharekhan trade. From NSE-Contract-20160816.pdf');
console.log('Inserted Yes Bank SELL 6 @ 1300 on 2016-08-16');

// Verify balance
const txns = db.prepare('SELECT transaction_type, units, transaction_date, price_per_unit FROM transactions WHERE investment_id = 59 ORDER BY transaction_date').all();
console.log('\nYes Bank transactions:');
txns.forEach(t => console.log(`  ${t.transaction_date} ${t.transaction_type} ${t.units} @ ${t.price_per_unit}`));

const net = txns.reduce((sum, t) => {
  if (['BUY','BONUS','SPLIT','IPO','TRANSFER_IN','RIGHTS'].includes(t.transaction_type)) return sum + t.units;
  if (['SELL','TRANSFER_OUT'].includes(t.transaction_type)) return sum - t.units;
  return sum;
}, 0);
console.log(`\nNet balance: ${net}`);

db.close();
