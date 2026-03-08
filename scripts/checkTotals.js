const db = require('better-sqlite3')('data/investments.db');

// Total BUY cost (money going out)
const buys = db.prepare(`
  SELECT COALESCE(SUM(amount + COALESCE(fees,0)),0) as total
  FROM transactions t JOIN investments i ON t.investment_id=i.id
  WHERE i.portfolio_id=1 AND t.transaction_type IN ('BUY','DEPOSIT','IPO')
`).get();

// Total SELL proceeds (money coming in)
const sells = db.prepare(`
  SELECT COALESCE(SUM(amount - COALESCE(fees,0)),0) as total
  FROM transactions t JOIN investments i ON t.investment_id=i.id
  WHERE i.portfolio_id=1 AND t.transaction_type IN ('SELL','WITHDRAWAL')
`).get();

console.log('Total purchased (cost):', buys.total.toFixed(2));
console.log('Total sold (proceeds):', sells.total.toFixed(2));
console.log('Profit (sells - buys):', (sells.total - buys.total).toFixed(2));
console.log('Current invested_amount in DB (buys - sells):', (buys.total - sells.total).toFixed(2));

// Check current dashboard values
const portfolio = db.prepare(`
  SELECT * FROM portfolio_daily WHERE portfolio_id IS NULL ORDER BY date DESC LIMIT 1
`).get();
console.log('\nCurrent portfolio_daily:', portfolio);

// Check per-stock invested_amount
const stocks = db.prepare(`
  SELECT i.name, dv.total_units, dv.invested_amount, dv.current_value, dv.profit_loss, dv.day_change
  FROM daily_values dv JOIN investments i ON dv.investment_id = i.id
  WHERE i.portfolio_id = 1 AND dv.date = (SELECT MAX(date) FROM daily_values WHERE investment_id = i.id)
  ORDER BY i.name
`).all();

console.log('\nPer-stock breakdown:');
for (const s of stocks) {
  console.log(`  ${s.name}: units=${s.total_units} invested=${s.invested_amount} value=${s.current_value} P/L=${s.profit_loss} day_change=${s.day_change}`);
}
