#!/usr/bin/env node
/**
 * Test script for manual dirty scope marking functionality.
 * Usage: node scripts/test-manual-mark-dirty.js [scenario]
 *
 * Scenarios:
 *   1 = One investment (212), all portfolios, earliest txn per portfolio
 *   2 = All portfolios, all investments, earliest txn per portfolio
 *   3 = One portfolio (1), fixed date 2026-06-01
 *   4 = All active, max(2026-01-01, scope first txn)
 *   5 = Dry-run preview: Mutual funds + NPS all portfolios
 */

const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'data', 'investments.db');
const db = new Database(dbPath, { readonly: true });

const { buildSelectorMatches, computeScopeDatesFromStrategy } = require('../server/services/dirtyBackfillService');

function runScenario(num) {
  console.log(`\n=== Scenario ${num} ===\n`);

  let selector = {};
  let dateStrategy = {};
  let description = '';

  if (num === 1) {
    description = 'One investment (212), all portfolios, earliest txn per portfolio';
    selector = { investment_ids: [212] };
    dateStrategy = { type: 'scope_first_transaction' };
  } else if (num === 2) {
    description = 'All portfolios, all investments, earliest txn per portfolio';
    selector = {};
    dateStrategy = { type: 'scope_first_transaction' };
  } else if (num === 3) {
    description = 'One portfolio (1), fixed date 2026-06-01';
    selector = { portfolio_ids: [1] };
    dateStrategy = { type: 'fixed_date', from_date: '2026-06-01' };
  } else if (num === 4) {
    description = 'All active, max(2026-01-01, scope first txn)';
    selector = {};
    dateStrategy = { type: 'max_of_fixed_and_scope_first', from_date: '2026-01-01' };
  } else if (num === 5) {
    description = 'Dry-run preview: Mutual funds + NPS all portfolios';
    selector = { asset_types: ['MUTUAL_FUND', 'NPS'] };
    dateStrategy = { type: 'scope_first_transaction' };
  } else {
    console.log('Invalid scenario. Choose 1-5.');
    process.exit(1);
  }

  console.log(`Description: ${description}`);
  console.log(`Selector: ${JSON.stringify(selector)}`);
  console.log(`Date Strategy: ${JSON.stringify(dateStrategy)}\n`);

  try {
    const matches = buildSelectorMatches(db, selector);
    console.log(`✓ Matched ${matches.length} (investment, portfolio) pairs`);

    if (matches.length > 0) {
      console.log(`  First 5 matches: ${JSON.stringify(matches.slice(0, 5), null, 2)}\n`);
    }

    const scopesWithDates = computeScopeDatesFromStrategy(db, matches, dateStrategy);
    console.log(`✓ Computed dirty dates for ${scopesWithDates.length} scopes`);

    if (scopesWithDates.length > 0) {
      console.log(`  First 5 scopes with dates: ${JSON.stringify(scopesWithDates.slice(0, 5), null, 2)}\n`);
    }

    // Summary
    const invCounts = new Map();
    for (const scope of scopesWithDates) {
      const count = (invCounts.get(scope.investment_id) || 0) + 1;
      invCounts.set(scope.investment_id, count);
    }

    console.log(`Summary by investment:`);
    const sorted = Array.from(invCounts.entries()).sort((a, b) => a[0] - b[0]);
    for (const [invId, count] of sorted.slice(0, 10)) {
      const inv = db.prepare('SELECT name FROM investments WHERE id = ?').get(invId);
      console.log(`  Investment ${invId} (${inv?.name || 'unknown'}): ${count} portfolios`);
    }
    if (sorted.length > 10) {
      console.log(`  ... and ${sorted.length - 10} more investments`);
    }
  } catch (e) {
    console.error(`✗ Error: ${e.message}`);
  }
}

const scenario = process.argv[2] ? Number(process.argv[2]) : 5;
runScenario(scenario);

db.close();
console.log('\n');
