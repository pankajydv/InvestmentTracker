#!/usr/bin/env node
/**
 * Direct import of missing RSU grants into investment_id=212
 * Usage: node scripts/import_missing_rsu_grants.js [--apply]
 *   --apply: Actually insert records (without flag, only previews)
 */

const Database = require('better-sqlite3');
const path = require('path');

// Import the RSU grant service
const rsuGrantService = require('../server/services/rsuGrantService');

const dbPath = path.join(__dirname, '../data/investments.db');
const db = new Database(dbPath);
const args = process.argv.slice(2);
const shouldApply = args.includes('--apply');

const INVESTMENT_ID = 212;
const PORTFOLIO_ID = 2;
const GRANT_KEYS = [
  'FY21_ANNUAL',
  'FY22_ANNUAL',
  'FY23_ANNUAL',
  'FY24_ANNUAL',
  'FY25_ANNUAL',
  'SPECIAL_SA'
];

console.log(`\n📊 RSU Grant Import Preview`);
console.log(`Investment ID: ${INVESTMENT_ID}`);
console.log(`Portfolio ID: ${PORTFOLIO_ID}`);
console.log(`Grants to import: ${GRANT_KEYS.join(', ')}`);
console.log(`Mode: ${shouldApply ? '✏️  APPLY' : '👁️  PREVIEW'}\n`);

// Generate schedule
const result = rsuGrantService.generateRsuSchedule({
  includeFuture: false,
  filterGrants: GRANT_KEYS
});

const schedule = result.rows;
console.log(`Total rows to import: ${schedule.length}`);
if (schedule.length > 0) {
  console.log(`Date range: ${schedule[0]?.vest_date} to ${schedule[schedule.length - 1]?.vest_date}\n`);
}

// Check for existing transactions to avoid duplicates
const checkExisting = db.prepare(`
  SELECT COUNT(*) as cnt FROM transactions
  WHERE investment_id = ? AND transaction_date = ? AND transaction_type = 'VEST' AND units = ?
`);

const stmt = db.prepare(`
  INSERT INTO transactions (
    portfolio_id, investment_id, transaction_date, transaction_type,
    units, amount, notes
  ) VALUES (?, ?, ?, ?, ?, ?, ?)
`);

let imported = 0;
let skipped = 0;
const details = [];

for (const row of schedule) {
  const existing = checkExisting.get(INVESTMENT_ID, row.vest_date, row.units);
  if (existing.cnt > 0) {
    skipped++;
    continue;
  }

  const detail = {
    grant: row.grant_label,
    award: row.award_number,
    tranche: `${row.vest_sequence}/${row.vest_total_tranches}`,
    vest_date: row.vest_date,
    units: row.units,
    notes: row.notes
  };

  if (shouldApply) {
    stmt.run(
      PORTFOLIO_ID,
      INVESTMENT_ID,
      row.vest_date,
      'VEST',
      row.units,
      0,
      row.notes
    );
    imported++;
    detail.status = '✓ IMPORTED';
  } else {
    detail.status = '📋 PREVIEW';
  }

  details.push(detail);
}

console.log(`Summary:`);
console.log(`  ✓ To import: ${imported}`);
console.log(`  ⏭️  Skipped (already exist): ${skipped}`);
console.log(`  Total in schedule: ${schedule.length}\n`);

if (details.length > 0) {
  console.log('Sample rows:');
  details.slice(0, 5).forEach(d => {
    console.log(`  [${d.status}] ${d.vest_date} | ${d.grant} | Award ${d.award} | ${d.units} units (Tranche ${d.tranche})`);
  });
  if (details.length > 5) {
    console.log(`  ... and ${details.length - 5} more\n`);
  }
}

if (!shouldApply) {
  console.log(`\n⚠️  PREVIEW MODE - No changes made to database.`);
  console.log(`To apply: node scripts/import_missing_rsu_grants.js --apply\n`);
} else {
  console.log(`\n✅ Import complete! ${imported} new VEST transactions added to investment_id=212.\n`);
  
  // Show DB stats
  const stats = db.prepare(`
    SELECT COUNT(*) as total_vests, 
           MIN(transaction_date) as first_vest,
           MAX(transaction_date) as last_vest
    FROM transactions
    WHERE investment_id = ? AND transaction_type = 'VEST'
  `).get(INVESTMENT_ID);
  
  console.log(`Updated investment_id=${INVESTMENT_ID}:`);
  console.log(`  Total VEST transactions: ${stats.total_vests}`);
  console.log(`  Date range: ${stats.first_vest} to ${stats.last_vest}\n`);
}

db.close();
