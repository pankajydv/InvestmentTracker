const db = require('better-sqlite3')('./data/investments.db');

const stmt = db.prepare(`
  INSERT INTO transactions (investment_id, transaction_type, transaction_date, units, price_per_unit, amount, notes, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
`);

const result = stmt.run(
  49,           // investment_id: ICICI BANK LTD. (Anju, portfolio_id=1)
  'BUY',
  '2015-09-04',
  18,
  260.00,
  4680.00,
  'Sharekhan contract note NSE-Contract-20150904.pdf - Trade 2015090425236053'
);

console.log('Inserted:', result);

// Verify balance
const balance = db.prepare(`
  SELECT COALESCE(SUM(CASE 
    WHEN transaction_type='BUY' THEN units 
    WHEN transaction_type='SELL' THEN -units 
    WHEN transaction_type='BONUS' THEN units 
    ELSE 0 END), 0) as net_units 
  FROM transactions WHERE investment_id = 49
`).get();

console.log('ICICI Bank net units after import:', balance.net_units);
