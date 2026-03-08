const path = require('path');
const { getDb } = require(path.join(__dirname, '..', 'server', 'db', 'schema'));

const db = getDb();

// BPCL: 3:2 bonus on 2017-07-13. User had 8 shares -> gets 4 bonus shares
const bpclId = 66; // BHARAT PETROLEUM CORP. LTD.

const existing = db.prepare(
  "SELECT id FROM transactions WHERE investment_id=? AND transaction_type='BONUS' AND transaction_date='2017-07-13'"
).get(bpclId);

if (existing) {
  console.log('BPCL bonus already exists (id=' + existing.id + ')');
} else {
  db.prepare(`
    INSERT INTO transactions (investment_id, transaction_type, transaction_date, units, price_per_unit, amount, fees, notes, created_at)
    VALUES (?, 'BONUS', '2017-07-13', 4, 0, 0, 0, 'Bonus issue 1:2 (1 share for every 2 held). 8 shares -> 4 bonus shares', datetime('now'))
  `).run(bpclId);
  console.log('✓ Added BPCL BONUS: 4 shares on 2017-07-13');
}

// Verify
const net = db.prepare(`
  SELECT COALESCE(SUM(CASE 
    WHEN transaction_type IN ('BUY','DEPOSIT','BONUS','RIGHTS','IPO','TRANSFER_IN','SPLIT') THEN COALESCE(units,0)
    WHEN transaction_type IN ('SELL','WITHDRAWAL','TRANSFER_OUT','CONSOLIDATION') THEN -COALESCE(units,0)
    ELSE 0 END),0) as n
  FROM transactions WHERE investment_id=?
`).get(bpclId);

console.log('BPCL net position: ' + net.n + (net.n === 0 ? ' ✓ BALANCED' : ' ✗ STILL OFF'));

console.log('\nAll BPCL transactions:');
const txns = db.prepare('SELECT * FROM transactions WHERE investment_id=? ORDER BY transaction_date').all(bpclId);
txns.forEach(t => {
  const units = t.units || '-';
  const price = t.price_per_unit || '-';
  console.log('  ' + t.transaction_date + '  ' + t.transaction_type.padEnd(8) + '  ' + String(units).padEnd(5) + ' @ ' + price);
});

// Show remaining negative positions
console.log('\n=== Remaining positions for Anju Yadav Sharekhan stocks ===\n');
const allInvs = db.prepare(
  "SELECT id, name FROM investments WHERE broker='Sharekhan' AND portfolio_id=1 ORDER BY name"
).all();
for (const inv of allInvs) {
  const n = db.prepare(`
    SELECT COALESCE(SUM(CASE 
      WHEN transaction_type IN ('BUY','DEPOSIT','BONUS','RIGHTS','IPO','TRANSFER_IN','SPLIT') THEN COALESCE(units,0)
      WHEN transaction_type IN ('SELL','WITHDRAWAL','TRANSFER_OUT','CONSOLIDATION') THEN -COALESCE(units,0)
      ELSE 0 END),0) as n
    FROM transactions WHERE investment_id=?
  `).get(inv.id);
  if (n.n !== 0) {
    console.log('  ' + inv.name.padEnd(48) + '  net: ' + n.n + (n.n < 0 ? '  ← MISSING BUY' : '  ← HELD'));
  }
}

db.close();
