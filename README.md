# Investment Tracker

Personal investment tracker for Indian and global assets with daily valuation, performance analytics, statement imports, and self-healing backfill/compliance workflows.

## Documentation

- [Troubleshooting & Operations](docs/Troubleshooting.md) — architecture, layered debugging, blue/green deploys, backup/restore
- [Metrics Basis](docs/Metrics.md) — cost-basis vs attribution reporting lenses

## What You Get

- Multi-portfolio tracking for family accounts
- Asset support: INDIAN_STOCK, MUTUAL_FUND, FOREIGN_STOCK, PPF, SSY, PF, BOND, NPS, SGB
- Imports: CAS/CAMS, NPS, PF/PPF statements, broker contract notes, RSU/ESPP files
- Analytics: holdings, invested amount, realized/unrealized P/L, daily rollups, dashboard performance views
- Operations: scheduler-driven price updates, dirty-scope backfill, XLSX export

## Tech Stack

- Backend: Node.js, Express, SQLite (better-sqlite3), node-cron
- Frontend: React, Vite, React Router, Bootstrap, Recharts
- Auth: express-session + Google ID token verification

## Design Principles

- Transaction-ledger first: transactions are the canonical source of truth
- Derived-data rebuildability: daily aggregates are computed and repairable
- Incremental recomputation: only impacted date ranges are recalculated
- Safety over convenience: production auth and deploy sequencing avoid data exposure
- Operational visibility: compliance gaps and repair state are externally observable

## Quick Start

### Prerequisites

- Node.js 20+
- npm

### Install

```bash
npm run install-all
```

### Initialize Database

```bash
npm run setup
```

### Run Locally

```bash
npm run dev
```

- API: http://localhost:4000
- UI: http://localhost:5173

### Run Tests

```bash
npm test
```

## Architecture (High Level)

- Source of truth: transactions table
- Derived tables (rebuildable): investment_metrics_daily, asset_metrics_daily, portfolio_metrics_daily
- Incremental recompute trigger: dirty_backfill_scope

Flow:

1. UI calls API
2. API writes transactional/source data
3. Dirty scope is marked when historical recalculation is needed
4. Backfill services rebuild derived rows for impacted ranges only
5. Dashboard reads rollups

## Functional Areas

- Portfolio and investment lifecycle management
- Transaction ingestion and historical recomputation
- Statement and contract-note imports
- Price updates and valuation rollups
- Performance and dashboard analytics
- Compliance scan, gap detection, and self-healing repair
- Tax and reporting exports

## Authentication (Google + Allowlist)

Protected access is based on session auth + Google token verification + allowed email list.

Key environment variables:

- PORT (default 4000)
- NODE_ENV
- DATA_DIR (default ./data)
- SESSION_SECRET (required in production)
- ENABLE_SCHEDULER (true to run cron jobs)
- AUTH_DISABLED (true for local bypass)
- GOOGLE_CLIENT_ID (required for Google auth)
- ALLOWED_EMAILS (comma-separated allowlist)
- ALLOW_DB_MIGRATIONS (true only when deploying schema changes)

Auth sequence for production:

1. Implement and verify auth locally
2. Deploy app privately to Oracle VM first
3. Configure DNS + HTTPS
4. Add production origin/redirect URI in Google Cloud Console
5. Validate allowlisted and blocked-user behavior
6. Open public access after smoke tests pass

Why this order:

- Prevents exposing financial data before auth is active
- Avoids OAuth callback rework before stable HTTPS hostname exists

## Scheduler and Compliance

Scheduler windows (IST, `Asia/Kolkata`; run only when `ENABLE_SCHEDULER=true`):

- 9:35 AM–4:35 PM hourly (weekdays): Indian stocks + SGB + MF/NPS + Foreign Stock pre-market
- 7:35 PM, 8:35 PM, 9:35 PM, 11:35 PM (weekdays): Foreign Stocks + conditional MF/NPS (US session)
- 12:01 AM (all days): day-rollover sweep across all asset types
- 4:35 AM (all days): early-morning baseline, all asset types
- 5:35 PM (all days): evening baseline, all asset types
- 10:35 PM (all days): authoritative final run (after MF NAVs settle) + full compliance scan

Self-healing compliance loop:

1. Detect gaps in daily_values, portfolio_daily, asset_type_daily
2. Record open gaps for visibility
3. Enqueue repair scopes via dirty backfill
4. Repair on next cycles and mark gaps resolved

Scheduler design notes:

- Scheduler executes only when `ENABLE_SCHEDULER=true`
- Intraday and end-of-day runs are intentionally separated by scope
- Compliance scan runs as part of the operational loop, not as a separate manual-only process

Key APIs:

- POST /api/compliance/scan
- GET /api/compliance/open-gaps
- GET /api/holidays/:year
- POST /api/holidays/sync
- POST /api/utils/update-prices
- POST /api/utils/cancel-update
- GET /api/utils/dirty-backfill-scopes
- GET /api/utils/backfill-status
- POST /api/utils/backfill

## Export

- GET /api/utils/export
- XLSX sheets include portfolios, investments, transactions, expenses, rates, config

## Deployment (Oracle VM + Docker + Caddy)

Production shape:

1. Oracle Ubuntu VM (ap-mumbai-1) hosts the app as Docker containers
2. Caddy terminates TLS and reverse-proxies to the **active** app container via an
   includable upstream file (`/etc/caddy/investtrack-upstream.caddy`)
3. **Zero-downtime blue/green deploys:** two containers alternate —
   `investment-tracker-blue` (:8081) and `investment-tracker-green` (:8082). The
   deploy starts the new color, health-checks it, flips Caddy, then retires the old
   color; a failed build aborts before touching the live container
4. SQLite persisted with host mount `/data` -> container `/data`
5. Runtime env file at `/opt/investment-tracker.env`

Deploys are automated by `scripts/deploy-remote.sh` (run by the GitHub Actions
workflow). See **[Troubleshooting](docs/Troubleshooting.md)**
for the architecture diagram, blue/green flow, rollback, and one-time server prep.

## CI/CD Deployment Workflow

Manual GitHub Actions workflow:

- .github/workflows/deploy-oracle.yml

Reads deployment settings from configs/investtrack-prod.json and uses GitHub secrets for auth values.

Required GitHub secrets:

- ORACLE_SSH_PRIVATE_KEY
- GOOGLE_CLIENT_ID
- ALLOWED_EMAILS

Optional workflow inputs:

- allow_db_migrations (default false)
- backup_before_deploy (default true)

## Backups & Recovery

- **Database:** nightly (02:30 UTC) gzip snapshot of `/data/investments.db` to
  **Google Drive → `InvestTrackBackups/db`** (30-day retention) + local `/data/backups`.
- **Secrets/config** (SSH key, `Caddyfile`, OAuth client, env): **Google Drive →
  Investments → InvestTrack**.
- **Logs:** app-managed rotation (today plain, older gzipped, >30 days deleted).

Restore steps and full operations reference: **[Troubleshooting](docs/Troubleshooting.md)**.

## Deployment Validation Checklist

Before/after each production deploy:

1. Confirm DB objects and indexes required by current release
2. Confirm app boots and auth config endpoint responds
3. Verify compliance and holidays APIs
4. Validate dashboard in no-gap and gap-present states
5. Confirm gap-repair lifecycle (detect -> dirty scope -> resolve)
6. Keep backup enabled unless intentionally skipped

## Maintenance Playbook

Routine maintenance:

1. Monitor scheduler and compliance scan logs daily
2. Review open gaps and ensure repair closes as expected
3. Verify backup artifacts before production deployments
4. Keep `configs/investtrack-prod.json` and runtime env values aligned
5. Run `npm test` before major schema or service changes

When changing data model or pricing logic:

1. Apply schema changes with migration controls (`ALLOW_DB_MIGRATIONS`)
2. Validate derived-table consistency (`daily_values`, `portfolio_daily`, `asset_type_daily`)
3. Re-run targeted backfill for impacted date ranges
4. Recheck dashboard values and compliance endpoints

## Project Map (Short)

- client/src: React app, components, API client
- server/index.js: app bootstrap + route mounting
- server/routes: domain APIs
- server/services: pricing, parser, scheduler, backfill, compliance, holidays
- server/db: schema, setup, migrations
- scripts: maintenance and deployment helpers
- data: SQLite DB and backups
