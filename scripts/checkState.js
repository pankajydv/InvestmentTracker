const path = require('path');
const { getDb } = require(path.join(__dirname, '..', 'server', 'db', 'schema'));
const db = getDb();

// Get all Sharekhan transaction dates
const txns = db.prepare(`SELECT DISTINCT t.transaction_date FROM transactions t JOIN investments i ON t.investment_id=i.id WHERE i.broker='Sharekhan' ORDER BY t.transaction_date`).all();
console.log('Existing Sharekhan transaction dates:');
txns.forEach(t => console.log('  ', t.transaction_date));

// Also check negative positions
const neg = db.prepare(`
  SELECT i.name,
    SUM(CASE WHEN t.transaction_type IN ('BUY','IPO','BONUS','TRANSFER_IN') THEN t.units ELSE 0 END) -
    SUM(CASE WHEN t.transaction_type IN ('SELL','TRANSFER_OUT') THEN t.units ELSE 0 END) as net
  FROM investments i
  JOIN transactions t ON t.investment_id = i.id
  WHERE i.broker='Sharekhan'
  GROUP BY i.id
  HAVING net < 0
`).all();
console.log('\nNegative positions:');
neg.forEach(r => console.log('  ', r.name, 'net:', r.net));
db.close();
