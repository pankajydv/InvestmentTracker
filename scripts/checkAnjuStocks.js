const Database = require('better-sqlite3');
const db = new Database('./data/investments.db');

const rows = db.prepare(`
  SELECT i.id, i.name, i.ticker_symbol, i.notes,
    COALESCE(SUM(CASE WHEN t.transaction_type IN ('BUY','BONUS','SPLIT','IPO','TRANSFER_IN','RIGHTS') THEN t.units ELSE 0 END), 0) as bought,
    COALESCE(SUM(CASE WHEN t.transaction_type IN ('SELL','TRANSFER_OUT') THEN t.units ELSE 0 END), 0) as sold,
    COALESCE(SUM(CASE WHEN t.transaction_type IN ('BUY','BONUS','SPLIT','IPO','TRANSFER_IN','RIGHTS') THEN t.units ELSE 0 END), 0) -
    COALESCE(SUM(CASE WHEN t.transaction_type IN ('SELL','TRANSFER_OUT') THEN t.units ELSE 0 END), 0) as net
  FROM investments i
  LEFT JOIN transactions t ON i.id = t.investment_id
  WHERE i.portfolio_id = 1 AND i.asset_type = 'INDIAN_STOCK'
  GROUP BY i.id
  ORDER BY net DESC
`).all();

console.log('=== Anju Yadav - Stock Holdings Summary ===\n');
console.log('Stocks with POSITIVE net (should appear in CAS if still held):');
rows.filter(r => r.net > 0).forEach(r => {
  const isin = r.notes ? (r.notes.match(/ISIN[: ]+([A-Z0-9]+)/i) || [])[1] || 'N/A' : 'N/A';
  console.log(`  ${r.name} (${r.ticker_symbol}) | bought:${r.bought} sold:${r.sold} net:${r.net} | ISIN:${isin} | id:${r.id}`);
});

console.log('\nStocks with NEGATIVE net (missing BUY transactions):');
rows.filter(r => r.net < 0).forEach(r => {
  const isin = r.notes ? (r.notes.match(/ISIN[: ]+([A-Z0-9]+)/i) || [])[1] || 'N/A' : 'N/A';
  console.log(`  ${r.name} (${r.ticker_symbol}) | bought:${r.bought} sold:${r.sold} net:${r.net} | ISIN:${isin} | id:${r.id}`);
});

console.log('\nStocks with ZERO net (balanced):');
rows.filter(r => r.net === 0).forEach(r => {
  console.log(`  ${r.name} (${r.ticker_symbol}) | bought:${r.bought} sold:${r.sold} | id:${r.id}`);
});

console.log(`\nTotal stocks: ${rows.length}`);
console.log(`Positive net: ${rows.filter(r => r.net > 0).length}`);
console.log(`Negative net: ${rows.filter(r => r.net < 0).length}`);
console.log(`Zero net: ${rows.filter(r => r.net === 0).length}`);

db.close();
