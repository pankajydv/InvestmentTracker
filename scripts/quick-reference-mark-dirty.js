#!/usr/bin/env node
/**
 * Quick Reference: Manual Dirty Scope Marking API
 * 
 * This is a reference card for common use patterns.
 * For full documentation, see: docs/MANUAL_DIRTY_SCOPE_MARKING.md
 */

const examples = [
  {
    name: "1. Preview: All investments, per-portfolio earliest txn",
    payload: {
      selector: {},
      date_strategy: { type: "scope_first_transaction" },
      dry_run: true,
    },
  },
  {
    name: "2. Mark & Enqueue: One investment, all portfolios",
    payload: {
      selector: { investment_ids: [212] },
      date_strategy: { type: "scope_first_transaction" },
      dry_run: false,
      execute_now: false,
    },
  },
  {
    name: "3. Mark & Execute: One portfolio, fixed date",
    payload: {
      selector: { portfolio_ids: [1] },
      date_strategy: { type: "fixed_date", from_date: "2026-06-01" },
      dry_run: false,
      execute_now: true,
    },
  },
  {
    name: "4. Preview: Mutual funds + NPS, per-portfolio earliest txn",
    payload: {
      selector: { asset_types: ["MUTUAL_FUND", "NPS"] },
      date_strategy: { type: "scope_first_transaction" },
      dry_run: true,
    },
  },
  {
    name: "5. Combined: Portfolio 2, stocks + mutual funds, max(2026-01-01, first_txn)",
    payload: {
      selector: {
        portfolio_ids: [2],
        asset_types: ["INDIAN_STOCK", "MUTUAL_FUND"],
      },
      date_strategy: {
        type: "max_of_fixed_and_scope_first",
        from_date: "2026-01-01",
      },
      dry_run: true,
    },
  },
];

console.log("\n╔════════════════════════════════════════════════════════════════╗");
console.log("║  Manual Dirty Scope Marking - Quick Reference Guide            ║");
console.log("║  Endpoint: POST /api/utils/dirty-backfill-scopes/mark          ║");
console.log("╚════════════════════════════════════════════════════════════════╝\n");

for (const ex of examples) {
  console.log(`\n${ex.name}`);
  console.log("─".repeat(70));
  console.log(JSON.stringify(ex.payload, null, 2));
}

console.log("\n\n╔════════════════════════════════════════════════════════════════╗");
console.log("║  Selector Filters (all optional, ANDed together)               ║");
console.log("╠════════════════════════════════════════════════════════════════╣");
console.log("║  portfolio_ids: [number]                                       ║");
console.log("║  investment_ids: [number]                                      ║");
console.log("║  asset_types: [string]  ← INDIAN_STOCK, FOREIGN_STOCK,        ║");
console.log("║                           MUTUAL_FUND, NPS, SGB, PPF, SSY, PF ║");
console.log("║  include_inactive: boolean (default: false)                    ║");
console.log("║  include_excluded: boolean (default: false)                    ║");
console.log("╚════════════════════════════════════════════════════════════════╝\n");

console.log("╔════════════════════════════════════════════════════════════════╗");
console.log("║  Date Strategy Types                                           ║");
console.log("╠════════════════════════════════════════════════════════════════╣");
console.log("║  fixed_date                                                    ║");
console.log("║    → All scopes use same from_date (required)                  ║");
console.log("║                                                                ║");
console.log("║  scope_first_transaction                                       ║");
console.log("║    → Each scope gets MIN(transaction_date) for that pair       ║");
console.log("║                                                                ║");
console.log("║  max_of_fixed_and_scope_first                                  ║");
console.log("║    → Each scope gets later of from_date or MIN(transaction_date)║");
console.log("╚════════════════════════════════════════════════════════════════╝\n");

console.log("╔════════════════════════════════════════════════════════════════╗");
console.log("║  Key Options                                                   ║");
console.log("╠════════════════════════════════════════════════════════════════╣");
console.log("║  dry_run: true                                                 ║");
console.log("║    → Preview what would be marked without writing to DB        ║");
console.log("║                                                                ║");
console.log("║  execute_now: true                                             ║");
console.log("║    → Mark scopes and immediately run backfill preflight        ║");
console.log("║                                                                ║");
console.log("║  reason: string                                                ║");
console.log("║    → Custom reason code for logs (default: manual-mark-dirty-scope) ║");
console.log("║                                                                ║");
console.log("║  source_event_id: string                                       ║");
console.log("║    → Custom event ID for traceability (default: manual:ISO-ts) ║");
console.log("╚════════════════════════════════════════════════════════════════╝\n");

console.log("╔════════════════════════════════════════════════════════════════╗");
console.log("║  Testing                                                       ║");
console.log("╠════════════════════════════════════════════════════════════════╣");
console.log("║  $ node scripts/test-manual-mark-dirty.js [1-5]                ║");
console.log("║    → Test selector and date strategy logic locally             ║");
console.log("║                                                                ║");
console.log("║  $ bash scripts/api-examples-mark-dirty.sh                     ║");
console.log("║    → Test API endpoint with curl examples                      ║");
console.log("╚════════════════════════════════════════════════════════════════╝\n");

console.log("╔════════════════════════════════════════════════════════════════╗");
console.log("║  Key Behaviors                                                 ║");
console.log("╠════════════════════════════════════════════════════════════════╣");
console.log("║  ✓ Deduplicates on (investment_id, portfolio_id)              ║");
console.log("║  ✓ Merges earliest dirty_from_date                            ║");
console.log("║  ✓ Merges reason codes with pipe (|) delimiter                ║");
console.log("║  ✓ Safe to call multiple times (idempotent)                   ║");
console.log("║  ✓ Validates all inputs (IDs, asset types, dates)             ║");
console.log("║  ✓ No breaking changes to existing backfill endpoints          ║");
console.log("╚════════════════════════════════════════════════════════════════╝\n");
