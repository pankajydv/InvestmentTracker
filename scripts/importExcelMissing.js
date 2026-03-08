/**
 * Import missing transactions from Sharekhan.xlsx
 * 
 * Fixes:
 * 1. Coal India IPO price: 291 → 232.75 (actual allocation price)
 * 2. CARE IPO: 10 shares @ 940 → 20 shares @ 750 (actual IPO order)
 * 3. Bharti Infratel IPO: 200 → 210 (after partial refund)
 * 
 * Missing buy/sell:
 * 4. DLF BUY 10 @ 183, 2012-05-04
 * 5. RCOM BUY 20 @ 73, 2012-05-04
 * 6. CARE SELL 10 @ 815, 2014-02-18
 * 7. Kingfisher Airlines BUY 20 @ 13.5, 2012-05-04 (new investment)
 * 
 * Dividends:
 * 8. All "Bonus" entries from Excel (actually dividend cash payments)
 */

const { getDb } = require('../server/db/schema');
const db = getDb();

// Helper: get investment by name
function getInv(name) {
  return db.prepare('SELECT * FROM investments WHERE name = ?').get(name);
}

// Helper: insert transaction
function insertTxn(investment_id, type, date, units, price, amount, fees, notes) {
  return db.prepare(`
    INSERT INTO transactions (investment_id, transaction_type, transaction_date, units, price_per_unit, amount, fees, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(investment_id, type, date, units, price, amount, fees || 0, notes || null);
}

console.log('=== Importing missing transactions from Sharekhan.xlsx ===\n');

// ─── 1. Fix Coal India IPO price ───────────────────────────────────────
const coalIndia = getInv('COAL INDIA LIMITED');
if (coalIndia) {
  const buyTxn = db.prepare(
    "SELECT * FROM transactions WHERE investment_id = ? AND transaction_type = 'BUY' AND transaction_date = '2010-11-03'"
  ).get(coalIndia.id);
  if (buyTxn && buyTxn.price_per_unit === 291) {
    db.prepare('UPDATE transactions SET price_per_unit = ?, amount = ?, notes = ? WHERE id = ?')
      .run(232.75, 5818.75, 'Coal India IPO allocation (25 shares @ ₹232.75)', buyTxn.id);
    console.log('✓ Fixed Coal India BUY: 291 → 232.75 per share');
  } else {
    console.log('  Coal India BUY already correct or not found');
  }
}

// ─── 2. Fix CARE IPO: 10 @ 940 → 20 @ 750 ─────────────────────────────
const care = getInv('CREDIT ANALYSIS & RESEARCH LTD');
if (care) {
  const buyTxn = db.prepare(
    "SELECT * FROM transactions WHERE investment_id = ? AND transaction_type = 'BUY'"
  ).get(care.id);
  if (buyTxn && buyTxn.units === 10 && buyTxn.price_per_unit === 940) {
    db.prepare('UPDATE transactions SET units = ?, price_per_unit = ?, amount = ?, transaction_date = ?, notes = ? WHERE id = ?')
      .run(20, 750, 15000, '2012-12-11', 'CARE IPO allocation (20 shares @ ₹750)', buyTxn.id);
    console.log('✓ Fixed CARE BUY: 10 @ 940 → 20 @ 750, date → 2012-12-11');
  } else {
    console.log('  CARE BUY already correct or not found');
  }
}

// ─── 3. Fix Bharti Infratel IPO: 200 → 210 ─────────────────────────────
const infratel = getInv('BHARTI INFRATEL LIMITED');
if (infratel) {
  const buyTxn = db.prepare(
    "SELECT * FROM transactions WHERE investment_id = ? AND transaction_type = 'BUY'"
  ).get(infratel.id);
  if (buyTxn && buyTxn.price_per_unit === 200) {
    // IPO order was 50 @ 230 = 11500, refund 1000, net cost = 10500, per share = 210
    db.prepare('UPDATE transactions SET price_per_unit = ?, amount = ?, transaction_date = ?, notes = ? WHERE id = ?')
      .run(210, 10500, '2012-12-14', 'Bharti Infratel IPO allocation (50 shares, ordered @230, ₹1000 refund)', buyTxn.id);
    console.log('✓ Fixed Bharti Infratel BUY: 200 → 210 per share, date → 2012-12-14');
  } else {
    console.log('  Bharti Infratel BUY already correct or not found');
  }
}

// ─── 4. Add DLF BUY 10 @ 183, 2012-05-04 ───────────────────────────────
const dlf = getInv('DLF LTD.');
if (dlf) {
  const existing = db.prepare(
    "SELECT * FROM transactions WHERE investment_id = ? AND transaction_type = 'BUY' AND transaction_date = '2012-05-04'"
  ).get(dlf.id);
  if (!existing) {
    insertTxn(dlf.id, 'BUY', '2012-05-04', 10, 183, 1830, 0.54, 'Sharekhan trade');
    console.log('✓ Added DLF BUY 10 @ 183 on 2012-05-04');
  } else {
    console.log('  DLF BUY 2012-05-04 already exists');
  }
}

// ─── 5. Add RCOM BUY 20 @ 73, 2012-05-04 ───────────────────────────────
const rcom = getInv('RELIANCE COMMUNICATION LTD.');
if (rcom) {
  const existing = db.prepare(
    "SELECT * FROM transactions WHERE investment_id = ? AND transaction_type = 'BUY' AND transaction_date = '2012-05-04'"
  ).get(rcom.id);
  if (!existing) {
    insertTxn(rcom.id, 'BUY', '2012-05-04', 20, 73, 1460, 3.26, 'Sharekhan trade');
    console.log('✓ Added RCOM BUY 20 @ 73 on 2012-05-04');
  } else {
    console.log('  RCOM BUY 2012-05-04 already exists');
  }
}

// ─── 6. Add CARE SELL 10 @ 815, 2014-02-18 ─────────────────────────────
if (care) {
  const existing = db.prepare(
    "SELECT * FROM transactions WHERE investment_id = ? AND transaction_type = 'SELL' AND transaction_date = '2014-02-18'"
  ).get(care.id);
  if (!existing) {
    insertTxn(care.id, 'SELL', '2014-02-18', 10, 815, 8150, 27.77, 'Sharekhan trade');
    console.log('✓ Added CARE SELL 10 @ 815 on 2014-02-18');
  } else {
    console.log('  CARE SELL 2014-02-18 already exists');
  }
}

// ─── 7. Create Kingfisher Airlines + BUY 20 @ 13.5, 2012-05-04 ─────────
let kingfisher = db.prepare("SELECT * FROM investments WHERE name LIKE '%Kingfisher%'").get();
if (!kingfisher) {
  const result = db.prepare(`
    INSERT INTO investments (name, asset_type, ticker_symbol, currency, is_active, portfolio_id, broker, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'KINGFISHER AIRLINES LIMITED', 'INDIAN_STOCK', null, 'INR', 0, 1, 'Sharekhan',
    'Delisted. ISIN: INE438A01022. Shares worthless after airline shutdown.'
  );
  kingfisher = db.prepare('SELECT * FROM investments WHERE id = ?').get(result.lastInsertRowid);
  console.log('✓ Created investment: KINGFISHER AIRLINES LIMITED (id=' + kingfisher.id + ', is_active=0)');
}
if (kingfisher) {
  const existing = db.prepare(
    "SELECT * FROM transactions WHERE investment_id = ? AND transaction_type = 'BUY'"
  ).get(kingfisher.id);
  if (!existing) {
    insertTxn(kingfisher.id, 'BUY', '2012-05-04', 20, 13.5, 270, 5.64, 'Sharekhan trade');
    console.log('✓ Added Kingfisher BUY 20 @ 13.5 on 2012-05-04');
  } else {
    console.log('  Kingfisher BUY already exists');
  }
}

// ─── 8. Add dividend transactions ───────────────────────────────────────
console.log('\n--- Adding dividends (Excel "Bonus" entries = cash dividend payments) ---');

const DIVIDENDS = [
  // [investment name, date, amount, notes]
  ['POWER GRID CORP. OF IND. LTD.', '2011-02-24', 5, 'Dividend (10 shares)'],
  ['COAL INDIA LIMITED', '2011-02-28', 52.5, 'Dividend (25 shares @ ₹2.10)'],
  ['DLF LTD.', '2011-12-08', 40, 'Dividend'],
  ['JAIPRAKASH ASSOCIATES LTD.', '2011-10-12', 22, 'Dividend (55 shares)'],  // Anju's (id=45)
  ['SAIL', '2012-03-06', 15.6, 'Dividend (13 shares @ ₹1.20)'],
  ['ICICI BANK LTD.', '2012-06-26', 66, 'Dividend (4 shares)'],
  ['PUNJAB & SIND BANK', '2012-07-06', 76, 'Dividend (38 shares @ ₹2.00)'],
  ['RELIANCE COMMUNICATION LTD.', '2012-09-08', 5, 'Dividend (20 shares)'],
  ['DLF LTD.', '2012-09-14', 20, 'Dividend'],
  ['JAIPRAKASH ASSOCIATES LTD.', '2012-10-12', 27.5, 'Dividend (55 shares)'],  // Anju's
  ['SAIL', '2012-10-19', 10.4, 'Dividend (13 shares @ ₹0.80)'],
  ['CREDIT ANALYSIS & RESEARCH LTD', '2013-03-18', 120, 'Dividend (20 shares @ ₹6.00)'],
  ['BHARTI INFRATEL LIMITED', '2013-07-04', 150, 'Dividend (50 shares @ ₹3.00)'],
  ['PUNJAB & SIND BANK', '2013-07-08', 101.84, 'Dividend (38 shares)'],
  ['CREDIT ANALYSIS & RESEARCH LTD', '2013-09-03', 60, 'Dividend (10 shares @ ₹6.00)'],
  ['CREDIT ANALYSIS & RESEARCH LTD', '2013-10-17', 80, 'Dividend (10 shares @ ₹8.00)'],
  ['CREDIT ANALYSIS & RESEARCH LTD', '2013-12-05', 60, 'Dividend (10 shares @ ₹6.00)'],
  ['PUNJAB & SIND BANK', '2014-01-31', 60.8, 'Dividend (38 shares)'],
  ['CREDIT ANALYSIS & RESEARCH LTD', '2014-02-14', 60, 'Dividend (10 shares @ ₹6.00)'],
];

let divCount = 0;
for (const [invName, date, amount, notes] of DIVIDENDS) {
  // For Jaiprakash - use Anju's (portfolio_id=1)
  let inv;
  if (invName === 'JAIPRAKASH ASSOCIATES LTD.') {
    inv = db.prepare("SELECT * FROM investments WHERE name = ? AND portfolio_id = 1").get(invName);
  } else {
    inv = getInv(invName);
  }
  if (!inv) {
    console.log('  ✗ Investment not found: ' + invName);
    continue;
  }
  // Check if dividend already exists for this date and investment
  const existing = db.prepare(
    "SELECT * FROM transactions WHERE investment_id = ? AND transaction_type = 'DIVIDEND' AND transaction_date = ?"
  ).get(inv.id, date);
  if (existing) {
    console.log('  ' + invName + ' dividend ' + date + ' already exists');
    continue;
  }
  insertTxn(inv.id, 'DIVIDEND', date, null, null, amount, 0, notes);
  divCount++;
  console.log('✓ Added ' + invName + ' dividend ₹' + amount + ' on ' + date);
}
console.log('\nAdded ' + divCount + ' dividend transactions');

// ─── Summary ────────────────────────────────────────────────────────────
console.log('\n=== Final Summary ===');
const totalTxns = db.prepare("SELECT COUNT(*) as c FROM transactions t JOIN investments i ON t.investment_id=i.id WHERE i.broker='Sharekhan'").get();
console.log('Total Sharekhan transactions:', totalTxns.c);

// Show net positions for the fixed stocks
const checkStocks = ['DLF LTD.', 'RELIANCE COMMUNICATION LTD.', 'CREDIT ANALYSIS & RESEARCH LTD', 'KINGFISHER AIRLINES LIMITED'];
for (const name of checkStocks) {
  const inv = db.prepare("SELECT * FROM investments WHERE name = ?").get(name);
  if (!inv) continue;
  const net = db.prepare(`
    SELECT COALESCE(SUM(CASE
      WHEN transaction_type IN ('BUY','DEPOSIT','BONUS','RIGHTS','IPO','TRANSFER_IN','SPLIT') THEN COALESCE(units, 0)
      WHEN transaction_type IN ('SELL','WITHDRAWAL','TRANSFER_OUT','CONSOLIDATION') THEN -COALESCE(units, 0)
      ELSE 0 END), 0) as net_units
    FROM transactions WHERE investment_id = ?
  `).get(inv.id);
  console.log('  ' + name + ': net units = ' + net.net_units);
}

db.close();
console.log('\nDone!');
