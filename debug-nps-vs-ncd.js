const Database = require('better-sqlite3');
const db = new Database('data/investments.db', {readonly: true});

// Check NPS transactions and status
const npsInvs = db.prepare(`
  SELECT id, name, asset_type FROM investments 
  WHERE asset_type = 'NPS' ORDER BY id
`).all();

console.log('NPS Investments:');
for (const inv of npsInvs) {
  const txns = db.prepare(`
    SELECT 
      MAX(date(transaction_date)) as last_txn,
      SUM(CASE 
        WHEN transaction_type IN ('BUY','DEPOSIT','BONUS','SPLIT','IPO','TRANSFER_IN','SWITCH_IN','RIGHTS','EMPLOYER_CONTRIBUTION','VOLUNTARY_CONTRIBUTION','VEST','ESPP_PURCHASE') THEN COALESCE(units,0)
        WHEN transaction_type IN ('SELL','REDEMPTION','WITHDRAWAL','TRANSFER_OUT','SWITCH_OUT','CONSOLIDATION','CHARGES','AMC') THEN -COALESCE(units,0)
        ELSE 0
      END) as net_units
    FROM transactions 
    WHERE investment_id = ?
  `).get(inv.id);
  
  const isExited = Math.abs(txns.net_units || 0) <= 0.000001;
  console.log(`  ${inv.id} (${inv.name}): last_txn=${txns?.last_txn}, net_units=${txns?.net_units}, isExited=${isExited}`);
}

// Compare with problematic NCDs/PPFs
console.log('\nProblematic Assets:');
const problem = db.prepare(`
  SELECT id, name, asset_type FROM investments 
  WHERE id IN (85, 198)
`).all();

for (const inv of problem) {
  const txns = db.prepare(`
    SELECT 
      MAX(date(transaction_date)) as last_txn,
      SUM(CASE 
        WHEN transaction_type IN ('BUY','DEPOSIT','BONUS','SPLIT','IPO','TRANSFER_IN','SWITCH_IN','RIGHTS','EMPLOYER_CONTRIBUTION','VOLUNTARY_CONTRIBUTION','VEST','ESPP_PURCHASE') THEN COALESCE(units,0)
        WHEN transaction_type IN ('SELL','REDEMPTION','WITHDRAWAL','TRANSFER_OUT','SWITCH_OUT','CONSOLIDATION','CHARGES','AMC') THEN -COALESCE(units,0)
        ELSE 0
      END) as net_units
    FROM transactions 
    WHERE investment_id = ?
  `).get(inv.id);
  
  const isExited = Math.abs(txns.net_units || 0) <= 0.000001;
  console.log(`  ${inv.id} (${inv.name}, ${inv.asset_type}): last_txn=${txns?.last_txn}, net_units=${txns?.net_units}, isExited=${isExited}`);
}

db.close();
