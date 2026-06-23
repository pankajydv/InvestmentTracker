const Database = require('better-sqlite3');
const db = new Database('data/investments.db', {readonly: true});

// Check FOREIGN_STOCK holdings
const foreignStocks = db.prepare(`
  SELECT 
    i.id, i.name, i.asset_type,
    COUNT(t.id) as txn_count,
    MAX(t.transaction_date) as last_txn
  FROM investments i
  LEFT JOIN transactions t ON i.id = t.investment_id
  WHERE i.asset_type = 'FOREIGN_STOCK'
  GROUP BY i.id
`).all();

console.log('FOREIGN_STOCK Investments:');
console.log(foreignStocks);

// Check how many times MSFT is processed in each CA sync
const msftScopes = db.prepare(`
  SELECT 
    dbs.investment_id,
    COUNT(*) as scope_count,
    GROUP_CONCAT(DISTINCT dbs.portfolio_id) as portfolio_ids,
    COUNT(DISTINCT DATE(dbs.created_at)) as days_marked_dirty
  FROM dirty_backfill_scope dbs
  WHERE dbs.investment_id = 212
  GROUP BY dbs.investment_id
`).get();

console.log('\nMSFT Dirty Scopes (212):');
console.log(msftScopes);

// Sample data volume from NASDAQ call
console.log('\nData Volume Estimate:');
console.log('- NASDAQ typically returns 40+ years of data (1980s-2026)');
console.log('- For MSFT: ~1700+ dividend records');
console.log('- But CA window is typically: 10-14 days (rolling freshness window)');
console.log('- Waste ratio: 1700+ records fetched / ~10 relevant = 170x overfetch');

db.close();
