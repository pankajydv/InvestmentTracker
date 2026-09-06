#!/usr/bin/env node
/**
 * Migration: Merge investments with the same ISIN across different folios
 *
 * What this does:
 * 1. Ensures folio_number column exists on transactions and is populated
 * 2. Finds investments sharing the same isin_code (duplicate folios)
 * 3. Picks the canonical investment (most transactions → lowest ID tiebreak)
 * 4. Reassigns all transactions from duplicates to the canonical investment
 * 5. Merges investment_metrics_daily (keeps canonical, deletes duplicates)
 * 6. Deletes the now-empty duplicate investment records
 * 7. Auto-populates category for mutual funds that lack it
 *
 * Run: node server/db/migrate-merge-folios.js [--dry-run]
 */
const { getDb, initializeDb } = require('./schema');

const dryRun = process.argv.includes('--dry-run');
const db = getDb();
initializeDb(db); // ensures columns exist

console.log(dryRun ? '=== DRY RUN (no changes will be written) ===' : '=== LIVE MIGRATION ===');

// ── Step 1: Ensure folio_number is on transactions ──────────────────────

const txnCols = db.prepare("PRAGMA table_info(transactions)").all().map(c => c.name);
if (!txnCols.includes('folio_number')) {
  console.log('Adding folio_number column to transactions...');
  if (!dryRun) {
    db.exec("ALTER TABLE transactions ADD COLUMN folio_number TEXT");
    db.exec(`
      UPDATE transactions SET folio_number = (
        SELECT i.folio_number FROM investments i WHERE i.id = transactions.investment_id
      ) WHERE folio_number IS NULL
    `);
  }
} else {
  // Backfill any transactions still missing folio
  const missing = db.prepare(`
    SELECT COUNT(*) as cnt FROM transactions t
    JOIN investments i ON i.id = t.investment_id
    WHERE t.folio_number IS NULL AND i.folio_number IS NOT NULL
  `).get();
  if (missing.cnt > 0) {
    console.log(`Backfilling folio_number for ${missing.cnt} transactions...`);
    if (!dryRun) {
      db.exec(`
        UPDATE transactions SET folio_number = (
          SELECT i.folio_number FROM investments i WHERE i.id = transactions.investment_id
        ) WHERE folio_number IS NULL
      `);
    }
  }
}

// ── Step 2: Find ISIN duplicates ────────────────────────────────────────

const dupeGroups = db.prepare(`
  SELECT isin_code, COUNT(*) as cnt, GROUP_CONCAT(id) as ids
  FROM investments
  WHERE isin_code IS NOT NULL AND isin_code != '' AND is_active = 1
  GROUP BY isin_code
  HAVING cnt > 1
  ORDER BY isin_code
`).all();

console.log(`\nFound ${dupeGroups.length} ISIN groups with duplicates.\n`);

let totalMerged = 0;
let totalTxnsMoved = 0;

for (const group of dupeGroups) {
  const investmentIds = group.ids.split(',').map(Number);

  // Get details of each investment in this group
  const investments = investmentIds.map(id => {
    const inv = db.prepare('SELECT * FROM investments WHERE id = ?').get(id);
    const txnCount = db.prepare('SELECT COUNT(*) as cnt FROM transactions WHERE investment_id = ?').get(id).cnt;
    return { ...inv, txnCount };
  });

  // Pick canonical: most transactions, then lowest ID
  investments.sort((a, b) => b.txnCount - a.txnCount || a.id - b.id);
  const canonical = investments[0];
  const duplicates = investments.slice(1);

  console.log(`ISIN: ${group.isin_code}`);
  console.log(`  Canonical: #${canonical.id} "${canonical.display_name || canonical.name}" (folio: ${canonical.folio_number}, ${canonical.txnCount} txns)`);

  for (const dup of duplicates) {
    console.log(`  Merging:   #${dup.id} "${dup.display_name || dup.name}" (folio: ${dup.folio_number}, ${dup.txnCount} txns)`);

    if (!dryRun) {
      // Reassign transactions
      db.prepare('UPDATE transactions SET investment_id = ? WHERE investment_id = ?')
        .run(canonical.id, dup.id);

      // Delete duplicate investment_metrics_daily (canonical's are kept; duplicates may have different data
      // but canonical is the one with most history)
      db.prepare('DELETE FROM investment_metrics_daily WHERE investment_id = ?').run(dup.id);

      // Delete the duplicate investment record
      db.prepare('DELETE FROM investments WHERE id = ?').run(dup.id);
    }

    totalTxnsMoved += dup.txnCount;
    totalMerged++;
  }
  console.log('');
}

console.log(`\nMerge summary: ${totalMerged} duplicate investments merged, ${totalTxnsMoved} transactions reassigned.`);

// ── Step 3: Auto-populate category ──────────────────────────────────────

function inferMFCategory(name) {
  const n = name.toLowerCase();
  if (n.includes('elss') || n.includes('tax saver') || n.includes('tax saving')) return 'ELSS';
  if (n.includes('liquid') || n.includes('money market') || n.includes('overnight')) return 'Liquid';
  if (n.includes('gilt') || n.includes('debt') || n.includes('bond') || n.includes('income') ||
      n.includes('credit risk') || n.includes('banking & psu') || n.includes('banking and psu') ||
      n.includes('corporate bond') || n.includes('dynamic bond') || n.includes('short duration') ||
      n.includes('medium duration') || n.includes('long duration') || n.includes('ultra short') ||
      n.includes('low duration') || n.includes('floater') || n.includes('floating rate')) return 'Debt';
  if (n.includes('hybrid') || n.includes('balanced') || n.includes('equity savings') ||
      n.includes('multi asset') || n.includes('arbitrage')) return 'Hybrid';
  if (n.includes('index') || n.includes('nifty') || n.includes('sensex') || n.includes('etf')) return 'Index/ETF';
  if (n.includes('international') || n.includes('global') || n.includes('us equity') ||
      n.includes('nasdaq') || n.includes('emerging market') || n.includes('world')) return 'International';
  if (n.includes('large cap') || n.includes('largecap') || n.includes('mid cap') || n.includes('midcap') ||
      n.includes('small cap') || n.includes('smallcap') || n.includes('flexi cap') || n.includes('flexicap') ||
      n.includes('multi cap') || n.includes('multicap') || n.includes('focused') || n.includes('value') ||
      n.includes('contra') || n.includes('dividend yield') || n.includes('opportunities') ||
      n.includes('sectoral') || n.includes('thematic') || n.includes('consumption') ||
      n.includes('infrastructure') || n.includes('pharma') || n.includes('banking') ||
      n.includes('technology') || n.includes('equity') || n.includes('growth')) return 'Equity';
  return 'Equity';
}

const uncategorized = db.prepare(
  "SELECT id, name FROM investments WHERE asset_type = 'MUTUAL_FUND' AND (category IS NULL OR category = '')"
).all();

if (uncategorized.length > 0) {
  console.log(`\nAuto-categorizing ${uncategorized.length} mutual funds...`);
  const updateCat = db.prepare("UPDATE investments SET category = ? WHERE id = ?");
  for (const inv of uncategorized) {
    const cat = inferMFCategory(inv.name);
    console.log(`  #${inv.id} "${inv.name}" → ${cat}`);
    if (!dryRun) updateCat.run(cat, inv.id);
  }
}

// Also set category for non-MF asset types
if (!dryRun) {
  db.prepare("UPDATE investments SET category = 'Equity' WHERE asset_type IN ('INDIAN_STOCK', 'FOREIGN_STOCK') AND (category IS NULL OR category = '')").run();
  db.prepare("UPDATE investments SET category = 'Debt' WHERE asset_type IN ('PPF', 'SSY', 'PF', 'BOND') AND (category IS NULL OR category = '')").run();
}

console.log('\n✓ Migration complete.' + (dryRun ? ' (dry run — no changes made)' : ''));
db.close();
