const path = require('path');
const { getDb } = require(path.join(__dirname, '..', 'server', 'db', 'schema'));
const db = getDb();

const PORTFOLIO_ID = 1; // Anju Yadav

// New trade from 2015-08-12 contract note
const trade = {
  date: '2015-08-12',
  type: 'BUY',
  name: 'AXIS BANK LIMITED',
  units: 10,
  rate: 558,
};

// Find the existing Axis Bank investment
const inv = db.prepare('SELECT id, name FROM investments WHERE name = ? AND portfolio_id = ?')
  .get(trade.name, PORTFOLIO_ID);

if (!inv) {
  console.error('Investment not found:', trade.name);
  process.exit(1);
}

// Check if already imported
const existing = db.prepare(
  'SELECT id FROM transactions WHERE investment_id = ? AND transaction_date = ? AND transaction_type = ? AND units = ?'
).get(inv.id, trade.date, trade.type, trade.units);

if (existing) {
  console.log('Already imported, skipping.');
} else {
  const amount = trade.units * trade.rate;
  db.prepare(`
    INSERT INTO transactions (investment_id, transaction_type, transaction_date, units, price_per_unit, amount, notes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(inv.id, trade.type, trade.date, trade.units, trade.rate, amount,
    'Imported from Sharekhan contract note 2015-08-12');
  console.log(`✓ Added: ${trade.date} ${trade.type} ${trade.units} x ${trade.name} @ ${trade.rate} (amount: ${amount})`);
}

// Verify Axis Bank position
const pos = db.prepare(`
  SELECT 
    SUM(CASE WHEN transaction_type IN ('BUY','IPO','BONUS','TRANSFER_IN') THEN units ELSE 0 END) as bought,
    SUM(CASE WHEN transaction_type IN ('SELL','TRANSFER_OUT') THEN units ELSE 0 END) as sold
  FROM transactions WHERE investment_id = ?
`).get(inv.id);
console.log(`\nAxis Bank: Bought ${pos.bought}, Sold ${pos.sold}, Net ${pos.bought - pos.sold}`);

// Show all remaining negative positions
console.log('\n=== Remaining negative positions ===');
const neg = db.prepare(`
  SELECT i.name,
    SUM(CASE WHEN t.transaction_type IN ('BUY','IPO','BONUS','TRANSFER_IN') THEN t.units ELSE 0 END) as bought,
    SUM(CASE WHEN t.transaction_type IN ('SELL','TRANSFER_OUT') THEN t.units ELSE 0 END) as sold,
    SUM(CASE WHEN t.transaction_type IN ('BUY','IPO','BONUS','TRANSFER_IN') THEN t.units ELSE 0 END) -
    SUM(CASE WHEN t.transaction_type IN ('SELL','TRANSFER_OUT') THEN t.units ELSE 0 END) as net
  FROM investments i
  JOIN transactions t ON t.investment_id = i.id
  WHERE i.broker='Sharekhan'
  GROUP BY i.id
  HAVING net < 0
`).all();

if (neg.length === 0) {
  console.log('  None! All positions balanced.');
} else {
  neg.forEach(r => console.log(`  ${r.name}: bought=${r.bought} sold=${r.sold} net=${r.net}`));
}

db.close();
