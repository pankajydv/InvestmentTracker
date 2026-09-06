/**
 * Migration: Move portfolio_id from investments to transactions.
 *
 * This allows a single investment (e.g. Asian Paints) to have transactions
 * from multiple portfolios (family members).
 *
 * Steps:
 * 1. Add portfolio_id column to transactions table
 * 2. Backfill each transaction's portfolio_id from its parent investment
 * 3. Merge duplicate investments (same ISIN or ticker) across portfolios
 * 4. Remove portfolio_id from investments table
 */

const Database = require('better-sqlite3');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const db = new Database(path.join(DATA_DIR, 'investments.db'));
db.pragma('journal_mode = WAL');

// CRITICAL: Must disable foreign keys for table recreation
db.pragma('foreign_keys = OFF');

console.log('=== Portfolio-to-Transactions Migration ===\n');

// Step 1: Add portfolio_id to transactions
console.log('Step 1: Adding portfolio_id column to transactions...');
try {
  db.exec('ALTER TABLE transactions ADD COLUMN portfolio_id INTEGER');
  console.log('  Added portfolio_id column to transactions');
} catch (e) {
  if (e.message.includes('duplicate column')) {
    console.log('  portfolio_id column already exists in transactions');
  } else {
    throw e;
  }
}

// Step 2: Backfill portfolio_id from parent investment
console.log('\nStep 2: Backfilling portfolio_id from investments...');
const backfillResult = db.prepare(`
  UPDATE transactions
  SET portfolio_id = (SELECT portfolio_id FROM investments WHERE investments.id = transactions.investment_id)
  WHERE portfolio_id IS NULL
`).run();
console.log(`  Updated ${backfillResult.changes} transactions`);

// Verify no NULLs remain
const nullCount = db.prepare('SELECT COUNT(*) as c FROM transactions WHERE portfolio_id IS NULL').get().c;
if (nullCount > 0) {
  console.warn(`  WARNING: ${nullCount} transactions still have NULL portfolio_id`);
}

// Step 3: Merge duplicate investments across portfolios
console.log('\nStep 3: Merging duplicate investments...');

// Find duplicates by ISIN (most reliable)
const isinDupes = db.prepare(`
  SELECT isin_code, GROUP_CONCAT(id) as ids, COUNT(*) as cnt
  FROM investments
  WHERE isin_code IS NOT NULL AND isin_code != ''
  GROUP BY isin_code
  HAVING cnt > 1
`).all();

// Find duplicates by ticker_symbol base (for those without ISIN)
const tickerDupes = db.prepare(`
  SELECT REPLACE(REPLACE(ticker_symbol, '.NS', ''), '.BO', '') as base_ticker,
         GROUP_CONCAT(id) as ids, COUNT(*) as cnt
  FROM investments
  WHERE ticker_symbol IS NOT NULL AND ticker_symbol != ''
    AND (isin_code IS NULL OR isin_code = '')
  GROUP BY base_ticker
  HAVING cnt > 1
`).all();

// Find "Demat Account Charges" duplicates by name
const dematDupes = db.prepare(`
  SELECT name, GROUP_CONCAT(id) as ids, COUNT(*) as cnt
  FROM investments
  WHERE name = 'Demat Account Charges'
  GROUP BY name
  HAVING cnt > 1
`).all();

const allDupeGroups = [...isinDupes, ...tickerDupes, ...dematDupes];

let totalMerged = 0;

for (const group of allDupeGroups) {
  const ids = group.ids.split(',').map(Number);
  const investments = db.prepare(
    `SELECT id, name, display_name, ticker_symbol, isin_code, portfolio_id,
            (SELECT COUNT(*) FROM transactions WHERE investment_id = investments.id) as txn_count
     FROM investments WHERE id IN (${ids.map(() => '?').join(',')})`
  ).all(...ids);

  // Pick the best primary: prefer one with ticker_symbol, display_name, most transactions
  investments.sort((a, b) => {
    // Prefer one with ticker_symbol
    if (a.ticker_symbol && !b.ticker_symbol) return -1;
    if (!a.ticker_symbol && b.ticker_symbol) return 1;
    // Prefer one with display_name
    if (a.display_name && !b.display_name) return -1;
    if (!a.display_name && b.display_name) return 1;
    // Prefer more transactions
    return b.txn_count - a.txn_count;
  });

  const primary = investments[0];
  const orphans = investments.slice(1);

  if (orphans.length === 0) continue;

  const identifier = group.isin_code || group.base_ticker || group.name;
  console.log(`\n  Merging "${identifier}": keeping ID ${primary.id} "${primary.display_name || primary.name}"`);

  for (const orphan of orphans) {
    console.log(`    <- merging ID ${orphan.id} "${orphan.display_name || orphan.name}" (${orphan.txn_count} txns)`);

    // Move transactions (portfolio_id already set on each transaction)
    db.prepare('UPDATE transactions SET investment_id = ? WHERE investment_id = ?')
      .run(primary.id, orphan.id);

    // Delete orphan's investment_metrics_daily
    db.prepare('DELETE FROM investment_metrics_daily WHERE investment_id = ?').run(orphan.id);

    // Delete orphan investment
    db.prepare('DELETE FROM investments WHERE id = ?').run(orphan.id);

    totalMerged++;
  }

  // Backfill primary with best available data from merged records
  // (isin_code, ticker_symbol already on primary since we sorted for it)
}

console.log(`\n  Total orphans merged: ${totalMerged}`);

// Step 4: Remove portfolio_id from investments (table recreation)
console.log('\nStep 4: Removing portfolio_id from investments...');

db.exec(`
  CREATE TABLE investments_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    asset_type TEXT NOT NULL CHECK(asset_type IN ('INDIAN_STOCK', 'MUTUAL_FUND', 'FOREIGN_STOCK', 'PPF', 'PF', 'BOND')),
    ticker_symbol TEXT,
    amfi_code TEXT,
    folio_number TEXT,
    account_number TEXT,
    interest_rate REAL,
    currency TEXT DEFAULT 'INR',
    face_value REAL,
    coupon_frequency TEXT,
    maturity_date TEXT,
    notes TEXT,
    display_name TEXT,
    isin_code TEXT,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  INSERT INTO investments_new (id, name, asset_type, ticker_symbol, amfi_code, folio_number,
    account_number, interest_rate, currency, face_value, coupon_frequency, maturity_date,
    notes, display_name, isin_code, is_active, created_at, updated_at)
  SELECT id, name, asset_type, ticker_symbol, amfi_code, folio_number,
    account_number, interest_rate, currency, face_value, coupon_frequency, maturity_date,
    notes, display_name, isin_code, is_active, created_at, updated_at
  FROM investments;

  DROP TABLE investments;
  ALTER TABLE investments_new RENAME TO investments;
`);

console.log('  Removed portfolio_id from investments table');

// Step 5: Verify
console.log('\n=== Verification ===');
const invCount = db.prepare('SELECT COUNT(*) as c FROM investments').get().c;
const txnCount = db.prepare('SELECT COUNT(*) as c FROM transactions').get().c;
const txnWithPortfolio = db.prepare('SELECT COUNT(*) as c FROM transactions WHERE portfolio_id IS NOT NULL').get().c;
console.log(`  Investments: ${invCount}`);
console.log(`  Transactions: ${txnCount}`);
console.log(`  Transactions with portfolio_id: ${txnWithPortfolio}`);

// Show final state
console.log('\n=== Final Investments ===');
const finalInvestments = db.prepare(`
  SELECT id, COALESCE(display_name, name) as name, ticker_symbol, isin_code,
         (SELECT COUNT(*) FROM transactions WHERE investment_id = investments.id) as txn_count,
         (SELECT GROUP_CONCAT(DISTINCT portfolio_id) FROM transactions WHERE investment_id = investments.id) as portfolio_ids
  FROM investments
  ORDER BY name
`).all();
finalInvestments.forEach(inv => {
  console.log(`  ID ${inv.id}: ${inv.name} | ${inv.ticker_symbol || 'no ticker'} | ${inv.txn_count} txns | portfolios: ${inv.portfolio_ids}`);
});

db.close();
console.log('\n=== Migration complete ===');
