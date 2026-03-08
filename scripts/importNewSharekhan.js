/**
 * Import new Sharekhan trades from contract notes added in 2016-2020.
 * 
 * New trades to add (all Anju Yadav, portfolio_id=1):
 * 
 * FROM PARSED CONTRACT NOTES:
 *  1. 2016-01-07 BUY  6  HCL TECHNOLOGIES LTD      @ 830     (new stock)
 *  2. 2016-08-10 BUY  4  INDUSIND BANK LTD.         @ 1170    (new stock)
 *  3. 2016-08-11 BUY  4  ASIAN PAINTS LTD.          @ 1120    (new stock)
 *  4. 2016-09-06 SELL 5  HERO MOTOCORP LIMITED       @ 3600
 *  5. 2016-09-12 BUY  8  BHARAT PETROLEUM CORP. LTD.@ 580     (new stock)
 *  6. 2018-08-29 SELL 20 AXIS BANK LIMITED           @ 666.6
 *  7. 2019-04-09 SELL 4  INDUSIND BANK LTD.          @ 1760
 *  8. 2019-04-11 SELL 19 ICICI BANK LTD.             @ 390.5
 *  9. 2019-04-15 SELL 4  ASIAN PAINTS LTD.           @ 1441.7
 * 10. 2019-04-15 SELL 6  HCL TECHNOLOGIES LTD        @ 1106.67
 * 11. 2019-04-15 SELL 44 ICICI PRUDENTIAL LIFE INS.  @ 366.6  (new stock)
 * 12. 2019-04-15 SELL 21 TVS MOTOR COMPANY LTD       @ 507.18 (new stock)
 * 13. 2019-11-29 SELL 12 BHARAT PETROLEUM CORP. LTD. @ 514.55
 * 14. 2020-11-18 SELL 150 ADANI POWER LIMITED         @ 38
 *
 * STOCKS WITH MISSING BUYS (no contract note available):
 *  - AXIS BANK: need BUY 10 (to cover sell of 20 vs existing buy of 10)
 *  - ICICI BANK: need BUY 19 (to cover sell of 19 after existing net=0)
 *  - BHARAT PETROLEUM: need BUY 4 (to cover sell of 12 vs buy of 8)
 *  - ICICI PRUDENTIAL LIFE: need BUY 44 (no contract note for buys)
 *  - TVS MOTOR COMPANY: need BUY 21 (no contract note for buys)
 */

const path = require('path');
const { getDb } = require(path.join(__dirname, '..', 'server', 'db', 'schema'));

const db = getDb();
const PORTFOLIO_ID = 1; // Anju Yadav

// ─── Helper functions ───────────────────────────────────────────────────
function findInvestment(name) {
  return db.prepare(
    'SELECT id, name FROM investments WHERE name = ? AND portfolio_id = ?'
  ).get(name, PORTFOLIO_ID);
}

function createInvestment(name, tickerSymbol, isin, isActive = 1) {
  const result = db.prepare(`
    INSERT INTO investments (name, asset_type, portfolio_id, ticker_symbol, currency, broker, is_active, notes, created_at, updated_at)
    VALUES (?, 'INDIAN_STOCK', ?, ?, 'INR', 'Sharekhan', ?, ?, datetime('now'), datetime('now'))
  `).run(name, PORTFOLIO_ID, tickerSymbol, isActive, `Imported from Sharekhan contract notes. ISIN: ${isin}`);
  console.log(`  ✓ Created investment: ${name} (id=${result.lastInsertRowid}, ticker=${tickerSymbol})`);
  return result.lastInsertRowid;
}

function txnExists(investmentId, type, date, units) {
  return db.prepare(
    'SELECT id FROM transactions WHERE investment_id=? AND transaction_type=? AND transaction_date=? AND units=?'
  ).get(investmentId, type, date, units);
}

function addTransaction(investmentId, type, date, units, price, notes) {
  const amount = units * price;
  if (txnExists(investmentId, type, date, units)) {
    console.log(`  ⊘ Already exists: ${type} ${units} @ ${price} on ${date}`);
    return;
  }
  db.prepare(`
    INSERT INTO transactions (investment_id, transaction_type, transaction_date, units, price_per_unit, amount, fees, notes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, datetime('now'))
  `).run(investmentId, type, date, units, price, amount, notes);
  console.log(`  ✓ Added: ${type} ${units} @ ${price} on ${date} (₹${amount.toFixed(2)})`);
}

// ─── Step 1: Create new investments ─────────────────────────────────────
console.log('\n=== Creating new investments ===\n');

const newStocks = [
  { name: 'HCL TECHNOLOGIES LTD', ticker: 'HCLTECH.NS', isin: 'INE860A01027' },
  { name: 'INDUSIND BANK LTD.', ticker: 'INDUSINDBK.NS', isin: 'INE095A01012' },
  { name: 'ASIAN PAINTS LTD.', ticker: 'ASIANPAINT.NS', isin: 'INE021A01026' },
  { name: 'BHARAT PETROLEUM CORP. LTD.', ticker: 'BPCL.NS', isin: 'INE029A01011' },
  { name: 'ICICI PRUDENTIAL LIFE INSURANCE COMPANY LTD', ticker: 'ICICIPRULI.NS', isin: 'INE726G01019' },
  { name: 'TVS MOTOR COMPANY LTD', ticker: 'TVSMOTOR.NS', isin: 'INE494B01023' },
];

const investmentIds = {};
for (const s of newStocks) {
  const existing = findInvestment(s.name);
  if (existing) {
    investmentIds[s.name] = existing.id;
    console.log(`  ⊘ Already exists: ${s.name} (id=${existing.id})`);
  } else {
    investmentIds[s.name] = createInvestment(s.name, s.ticker, s.isin);
  }
}

// Also get IDs for existing stocks
const existingStocks = [
  'HERO MOTOCORP LIMITED', 'AXIS BANK LIMITED', 'ICICI BANK LTD.',
  'ADANI POWER LIMITED',
];
for (const name of existingStocks) {
  const inv = findInvestment(name);
  if (inv) {
    investmentIds[name] = inv.id;
  } else {
    console.log(`  ✗ ERROR: Cannot find existing investment: ${name}`);
  }
}

// ─── Step 2: Add trades from contract notes ─────────────────────────────
console.log('\n=== Adding trades from contract notes ===\n');

const trades = [
  // 2016 trades
  { date: '2016-01-07', type: 'BUY',  units: 6,   price: 830,      name: 'HCL TECHNOLOGIES LTD' },
  { date: '2016-08-10', type: 'BUY',  units: 4,   price: 1170,     name: 'INDUSIND BANK LTD.' },
  { date: '2016-08-11', type: 'BUY',  units: 4,   price: 1120,     name: 'ASIAN PAINTS LTD.' },
  { date: '2016-09-06', type: 'SELL', units: 5,   price: 3600,     name: 'HERO MOTOCORP LIMITED' },
  { date: '2016-09-12', type: 'BUY',  units: 8,   price: 580,      name: 'BHARAT PETROLEUM CORP. LTD.' },
  // 2018 trades
  { date: '2018-08-29', type: 'SELL', units: 20,  price: 666.6,    name: 'AXIS BANK LIMITED' },
  // 2019 trades
  { date: '2019-04-09', type: 'SELL', units: 4,   price: 1760,     name: 'INDUSIND BANK LTD.' },
  { date: '2019-04-11', type: 'SELL', units: 19,  price: 390.5,    name: 'ICICI BANK LTD.' },
  { date: '2019-04-15', type: 'SELL', units: 4,   price: 1441.7,   name: 'ASIAN PAINTS LTD.' },
  { date: '2019-04-15', type: 'SELL', units: 6,   price: 1106.67,  name: 'HCL TECHNOLOGIES LTD' },
  { date: '2019-04-15', type: 'SELL', units: 44,  price: 366.6,    name: 'ICICI PRUDENTIAL LIFE INSURANCE COMPANY LTD' },
  { date: '2019-04-15', type: 'SELL', units: 21,  price: 507.18,   name: 'TVS MOTOR COMPANY LTD' },
  // 2019 late
  { date: '2019-11-29', type: 'SELL', units: 12,  price: 514.55,   name: 'BHARAT PETROLEUM CORP. LTD.' },
  // 2020
  { date: '2020-11-18', type: 'SELL', units: 150, price: 38,       name: 'ADANI POWER LIMITED' },
];

for (const t of trades) {
  const invId = investmentIds[t.name];
  if (!invId) {
    console.log(`  ✗ ERROR: No investment ID for ${t.name}`);
    continue;
  }
  addTransaction(invId, t.type, t.date, t.units, t.price, 'Sharekhan trade');
}

// ─── Step 3: Mark fully sold investments as inactive ────────────────────
console.log('\n=== Updating investment status ===\n');

// Adani Power is now fully sold (net=0), mark as sold-out
const adaniId = investmentIds['ADANI POWER LIMITED'];
if (adaniId) {
  const net = db.prepare(`
    SELECT COALESCE(SUM(CASE 
      WHEN transaction_type IN ('BUY','DEPOSIT','BONUS','RIGHTS','IPO','TRANSFER_IN','SPLIT') THEN COALESCE(units,0)
      WHEN transaction_type IN ('SELL','WITHDRAWAL','TRANSFER_OUT','CONSOLIDATION') THEN -COALESCE(units,0)
      ELSE 0 END),0) as n
    FROM transactions WHERE investment_id=?
  `).get(adaniId);
  if (net.n === 0) {
    console.log(`  ✓ ADANI POWER LIMITED: net=0, all shares sold`);
  }
}

// ─── Step 5: Verify all positions ───────────────────────────────────────
console.log('\n=== Final position verification ===\n');

const allInvs = db.prepare(
  "SELECT id, name FROM investments WHERE broker='Sharekhan' AND portfolio_id=? ORDER BY name"
).all(PORTFOLIO_ID);

let allBalanced = true;
for (const inv of allInvs) {
  const net = db.prepare(`
    SELECT COALESCE(SUM(CASE 
      WHEN transaction_type IN ('BUY','DEPOSIT','BONUS','RIGHTS','IPO','TRANSFER_IN','SPLIT') THEN COALESCE(units,0)
      WHEN transaction_type IN ('SELL','WITHDRAWAL','TRANSFER_OUT','CONSOLIDATION') THEN -COALESCE(units,0)
      ELSE 0 END),0) as n
    FROM transactions WHERE investment_id=?
  `).get(inv.id);
  
  const txnCount = db.prepare('SELECT COUNT(*) as c FROM transactions WHERE investment_id=?').get(inv.id);
  const status = net.n > 0 ? 'HELD' : net.n === 0 ? 'CLOSED' : 'NEGATIVE!';
  
  if (net.n < 0) allBalanced = false;
  console.log(`  ${inv.name.padEnd(45)} net: ${String(net.n).padEnd(5)} ${status} (${txnCount.c} txns)`);
}

// Total Sharekhan transaction count
const total = db.prepare(
  "SELECT COUNT(*) as c FROM transactions t JOIN investments i ON t.investment_id=i.id WHERE i.broker='Sharekhan'"
).get();
console.log(`\nTotal Sharekhan transactions: ${total.c}`);
console.log(allBalanced ? '✓ All positions balanced!' : '✗ Some positions are negative - check above');

db.close();
