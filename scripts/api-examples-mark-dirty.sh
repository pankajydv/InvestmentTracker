#!/usr/bin/env bash
# API Usage Examples for Manual Dirty Scope Marking
# File: scripts/api-examples-mark-dirty.sh
#
# These examples show how to call the new POST /api/utils/dirty-backfill-scopes/mark endpoint
# 
# Prerequisites:
# - Investment Tracker server running on http://localhost:4000
# - Authenticated session (cookie-based or token in header)

API_BASE="http://localhost:4000/api"

echo "=== Example 1: Dry-run preview - One investment, all portfolios, earliest txn per portfolio ==="
curl -X POST "$API_BASE/utils/dirty-backfill-scopes/mark" \
  -H "Content-Type: application/json" \
  -d '{
    "selector": {
      "investment_ids": [212]
    },
    "date_strategy": {
      "type": "scope_first_transaction"
    },
    "dry_run": true,
    "run_date": "2026-06-16"
  }' | jq '.'

echo ""
echo "=== Example 2: Dry-run - All portfolios, all investments, earliest txn per portfolio ==="
curl -X POST "$API_BASE/utils/dirty-backfill-scopes/mark" \
  -H "Content-Type: application/json" \
  -d '{
    "selector": {},
    "date_strategy": {
      "type": "scope_first_transaction"
    },
    "dry_run": true,
    "run_date": "2026-06-16"
  }' | jq '.'

echo ""
echo "=== Example 3: Mark + Enqueue (no execute) - One portfolio, fixed date ==="
curl -X POST "$API_BASE/utils/dirty-backfill-scopes/mark" \
  -H "Content-Type: application/json" \
  -d '{
    "selector": {
      "portfolio_ids": [1]
    },
    "date_strategy": {
      "type": "fixed_date",
      "from_date": "2026-06-01"
    },
    "reason": "manual-portfolio-refresh",
    "source_event_id": "manual:portfolio-1-jun-refresh",
    "dry_run": false,
    "execute_now": false,
    "run_date": "2026-06-16"
  }' | jq '.'

echo ""
echo "=== Example 4: Mark + Enqueue + Execute - Mutual funds + NPS, earliest txn per portfolio ==="
curl -X POST "$API_BASE/utils/dirty-backfill-scopes/mark" \
  -H "Content-Type: application/json" \
  -d '{
    "selector": {
      "asset_types": ["MUTUAL_FUND", "NPS"]
    },
    "date_strategy": {
      "type": "scope_first_transaction"
    },
    "reason": "manual-mf-nps-refresh",
    "source_event_id": "manual:mf-nps-full-refresh-2026-06-16",
    "dry_run": false,
    "execute_now": true,
    "run_date": "2026-06-16"
  }' | jq '.'

echo ""
echo "=== Example 5: Dry-run - Combined selector - Active stocks + active mutual funds in portfolio 2 ==="
curl -X POST "$API_BASE/utils/dirty-backfill-scopes/mark" \
  -H "Content-Type: application/json" \
  -d '{
    "selector": {
      "portfolio_ids": [2],
      "asset_types": ["INDIAN_STOCK", "MUTUAL_FUND"],
      "include_inactive": false,
      "include_excluded": false
    },
    "date_strategy": {
      "type": "scope_first_transaction"
    },
    "dry_run": true,
    "run_date": "2026-06-16"
  }' | jq '.'

echo ""
echo "=== Example 6: Dry-run - Max strategy (from_date or first_txn, whichever is later) ==="
curl -X POST "$API_BASE/utils/dirty-backfill-scopes/mark" \
  -H "Content-Type: application/json" \
  -d '{
    "selector": {
      "asset_types": ["FOREIGN_STOCK"]
    },
    "date_strategy": {
      "type": "max_of_fixed_and_scope_first",
      "from_date": "2026-01-01"
    },
    "dry_run": true,
    "run_date": "2026-06-16"
  }' | jq '.'

echo ""
echo "=== Example 7: Error case - Invalid asset_type ==="
curl -X POST "$API_BASE/utils/dirty-backfill-scopes/mark" \
  -H "Content-Type: application/json" \
  -d '{
    "selector": {
      "asset_types": ["INVALID_TYPE"]
    },
    "date_strategy": {
      "type": "scope_first_transaction"
    },
    "dry_run": true
  }' | jq '.'

echo ""
echo "=== Example 8: Error case - Missing from_date for fixed_date strategy ==="
curl -X POST "$API_BASE/utils/dirty-backfill-scopes/mark" \
  -H "Content-Type: application/json" \
  -d '{
    "selector": {},
    "date_strategy": {
      "type": "fixed_date"
    },
    "dry_run": true
  }' | jq '.'
