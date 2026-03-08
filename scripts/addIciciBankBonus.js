const db = require('better-sqlite3')('./data/investments.db');

// ICICI Bank had an 11:10 split (1 bonus for every 10 held) on 2017-05-31
// Anju held 18 shares → entitled to 18/10 = 1.8 → 1 bonus share (fractional paid as cash)

const stmt = db.prepare(`
  INSERT INTO transactions (investment_id, transaction_type, transaction_date, units, price_per_unit, amount, notes, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
`);

const result = stmt.run(
  49,           // investment_id: ICICI BANK LTD. (Anju, portfolio_id=1)
  'BONUS',
  '2017-05-31',
  1,
  0,
  0,
  'ICICI Bank 1:10 bonus (11:10 split) on 2017-05-31. Held 18 shares → 1 bonus share.'
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

console.log('ICICI Bank net units after bonus:', balance.net_units);
db.close();
