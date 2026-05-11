# Investment Tracker

A full-stack personal investment tracker focused on Indian and global assets (RSU + ESPP).

It tracks portfolios, transactions, valuation history, performance, tax reports, statement imports, and operational backfills.

## What This App Does

- Tracks multiple family portfolios.
- Supports asset classes:
  - `INDIAN_STOCK`
  - `MUTUAL_FUND`
  - `FOREIGN_STOCK`
  - `PPF`
  - `SSY`
  - `PF`
  - `BOND`
  - `NPS`
  - `SGB`
- Ingests data from:
  - CAS/CAMS statements
  - NPS statements
  - PF/PPF statements
  - Broker contract notes
  - RSU/ESPP related files and imports
- Computes:
  - holdings and invested amount
  - realized and unrealized gains
  - daily snapshots and allocation
  - XIRR/performance views
- Exposes maintenance utilities:
  - full export to XLSX
  - manual and scheduled price updates
  - dirty-scope based incremental backfill

## Tech Stack

### Backend

- Node.js + Express
- SQLite via `better-sqlite3`
- Session auth via `express-session`
- Google OAuth token verification via `google-auth-library`
- Cron scheduler via `node-cron`

### Frontend

- React + Vite
- React Router
- React Bootstrap + Bootstrap
- Recharts

## High-Level Architecture

```text
React UI (client/src)
   |
   | fetch('/api/...') with session cookie
   v
Express API (server/index.js + server/routes/*)
   |
   | business logic services (server/services/*)
   v
SQLite (data/investments.db by default)
   |
   | derived caches
   v
 daily_values / portfolio_daily / asset_type_daily
```

Core design principle:

- `transactions` are the source-of-truth event ledger.
- Daily aggregate tables are computed/derived and can be rebuilt.

## Request and Data Flow

1. User action in UI calls `client/src/services/api.js`.
2. Route module in `server/routes/*.js` validates request.
3. Route writes source data (`transactions`, `investments`, `portfolio_expenses`, etc.).
4. Dirty scopes are marked in `dirty_backfill_scope` when historical recomputation is needed.
5. Backfill service recomputes `daily_values` and rollups.
6. Dashboard endpoints read rollups and return chart/table payloads.

## Repository Walkthrough

```text
client/
  src/
    App.jsx                    # app bootstrap and route map
    components/                # UI screens and widgets
    context/PortfolioContext.jsx
    services/api.js            # all frontend API calls

server/
  index.js                     # express app startup and route mounting
  middleware/auth.js           # auth gate
  routes/                      # REST endpoints by domain
  services/                    # pricing, parsing, backfill, scheduler
  db/
    schema.js                  # schema + migrations + seed config/rates
    setup.js                   # setup/seed entrypoint

data/
  investments.db               # sqlite DB (when DATA_DIR not overridden)
  migration-backups/           # pre-migration DB snapshots

scripts/
  export_to_excel.js
  import_missing_rsu_grants.js
  reconcile_rsu_fidelity.js
```

## Backend Modules

Main route mounts in `server/index.js`:

- Public:
  - `/api/auth`
- Protected (guarded by `requireAuth`):
  - `/api/portfolios`
  - `/api/investments`
  - `/api/transactions`
  - `/api/dashboard`
  - `/api/utils`
  - `/api/cas`
  - `/api/stocks`
  - `/api/nps`
  - `/api/ppf`
  - `/api/pf`
  - `/api/expenses`
  - `/api/tax`

### Auth Behavior

Auth is bypassed when any of the following are true:

- `AUTH_DISABLED=true`
- `NODE_ENV=test`
- `GOOGLE_CLIENT_ID` is missing

When enabled:

- `/api/auth/google` verifies Google credential token.
- Allowed emails come from `ALLOWED_EMAILS` (comma separated), else default allowlist in `server/routes/auth.js`.
- Session cookie name is `itrack.sid`.

## Database Structure

Database initialization and migration logic is in `server/db/schema.js`.

### Core Tables

- `portfolios`
  - family/member level owner entity.
- `investments`
  - asset master data.
  - note: no `portfolio_id` column by design.
- `transactions`
  - source-of-truth event ledger.
  - links both `investment_id` and `portfolio_id`.
- `portfolio_expenses`
  - recurring and one-off portfolio charges.

### Derived/Analytical Tables

- `daily_values`
  - investment valuation by date and portfolio (plus combined rows).
- `portfolio_daily`
  - total portfolio daily rollup.
- `asset_type_daily`
  - per asset-type daily rollup.

### Operational Tables

- `interest_rates`
  - historical rates for `PPF`/`SSY`/`PF`.
- `config`
  - key/value app settings and backfill metadata.
- `dirty_backfill_scope`
  - pending/running/completed recompute scopes.
- `schema_migrations`
  - migration audit and idempotency tracking.

### Relationship Notes

```text
portfolios (1) ----< transactions >---- (1) investments
                        |
                        +----< daily_values (derived)

portfolio_daily and asset_type_daily are aggregate rollups from daily_values.
```

Important schema note:

- Portfolio ownership is represented through `transactions.portfolio_id`, not `investments`.

## Setup and Run

## Prerequisites

- Node.js 20+
- npm

### Install

```bash
npm run install-all
```

### Initialize DB

```bash
npm run setup
```

Optional sample seed:

```bash
node server/db/setup.js --seed
```

### Run in Development

```bash
npm run dev
```

- API default: `http://localhost:4000`
- Vite frontend default: `http://localhost:5173`

### Run Tests

```bash
npm test
```

## Environment Variables

Common server env vars:

- `PORT` (default `4000`)
- `NODE_ENV` (`development` or `production`)
- `DATA_DIR` (default `./data` relative to repo)
- `SESSION_SECRET` (set in production)
- `ENABLE_SCHEDULER` (`true` to enable cron jobs)
- `AUTH_DISABLED` (`true` for local auth bypass)
- `GOOGLE_CLIENT_ID` (required for Google auth)
- `ALLOWED_EMAILS` (comma-separated allowlist)
- `ALLOW_DB_MIGRATIONS` (`true` to allow pending migrations in production)

## Price Updates and Scheduler

Scheduler lives in `server/services/scheduler.js` and is started only when:

- `ENABLE_SCHEDULER=true`

Scheduled jobs (IST):

- Intraday weekdays: 9:25 AM to 4:25 PM (stocks only)
- Final weekday run: 10:25 PM (all asset types)

Manual triggers via API:

- `POST /api/utils/update-prices`
- `POST /api/utils/cancel-update`

## Dirty Backfill Model

Dirty backfill is used to recompute only impacted historical ranges.

Main flow:

1. Data changes mark scopes in `dirty_backfill_scope`.
2. Preflight processes pending scopes for a run date.
3. Backfill rewrites derived rows (`daily_values` and rollups).
4. Scope status and progress are stored in DB (`config`, `dirty_backfill_scope`).

Useful endpoints:

- `GET /api/utils/dirty-backfill-scopes`
- `GET /api/utils/backfill-status`
- `POST /api/utils/backfill`
- `POST /api/utils/backfill/preflight`
- `POST /api/utils/backfill/full`

Example full backfill:

```bash
curl -X POST http://localhost:4000/api/utils/backfill/full \
  -H "Content-Type: application/json" \
  -d '{"run_date":"2026-05-11"}'
```

## Export and Reporting

- Full export endpoint: `GET /api/utils/export`
- Generates XLSX with multiple sheets:
  - portfolios
  - investments
  - transactions
  - expenses
  - interest rates
  - config

Tax reporting routes are in `server/routes/tax.js`.

## Deployment (Docker)

`Dockerfile` uses a two-stage build:

1. Build frontend (`client/dist`)
2. Build production server image

Defaults in container:

- `NODE_ENV=production`
- `PORT=8080`
- `DATA_DIR=/data`

Mount `/data` as a persistent volume to retain SQLite data.

## Production Deployment Architecture (Oracle Cloud)

Current production runtime is configured as:

1. Oracle Cloud Ubuntu VM hosts the workload.
2. Caddy runs on the VM and terminates HTTPS for `https://investtrack.duckdns.org`.
3. Caddy reverse-proxies traffic to the app container on `http://127.0.0.1:8080`.
4. App runs as Docker container `investment-tracker` from image `investment-tracker:latest`.
5. SQLite data is persisted on host path `/data` and mounted into container as `/data`.
6. Runtime env file is stored at `/opt/investment-tracker.env`.
7. Scheduler is controlled by `ENABLE_SCHEDULER` env var.
8. Schema migration gate is controlled by `ALLOW_DB_MIGRATIONS` env var.

Runtime command shape in production:

```bash
sudo docker run -d \
  --name investment-tracker \
  --restart unless-stopped \
  -p 8080:8080 \
  -v /data:/data \
  --env-file /opt/investment-tracker.env \
  investment-tracker:latest
```

### Current Production Deploy Flow

1. Build latest image from repository source on VM.
2. Update `/opt/investment-tracker.env` with deploy-time auth/scheduler flags.
3. Recreate container with same persistent data mount.
4. Validate app and auth config endpoint.

Notes:

- Container recreation is required to apply changed env vars.
- Data in `/data` is preserved across deployments.
- Backups should run before each production deployment.

## CI/CD: One-Touch Production Deploy to Oracle VM

This repo includes a manual GitHub Actions workflow:

- `.github/workflows/deploy-oracle.yml`

**One-touch deployment:** After code changes, trigger the workflow with just one click. All configuration is centralized:

- Deployment config (host, user, paths, etc.) is in `configs/investtrack.config.json` (committed to repo)
- Google OAuth client ID auto-extracts from `configs/gcp-client.json`
- Allowed emails default to: `pankaj.ydv@gmail.com,hianju.yadav@gmail.com,yashita.ydv@gmail.com`
- Scheduler enabled by default in production
- Only optional overrides: `allow_db_migrations` and `backup_before_deploy`

The workflow performs:

1. Load Oracle VM config from `configs/investtrack.config.json`
2. Parse Google client ID from `configs/gcp-client.json`
3. Validate GitHub secrets (SSH private key only)
4. Package latest repository source
5. Copy archive to Oracle VM over SSH
6. Build `investment-tracker:latest` on VM
7. Update auth/scheduler/migration env values in `/opt/investment-tracker.env`
8. Recreate container with persistent `/data` mount
9. Verify `/api/auth/config` on VM

### Deployment Configuration

All deployment parameters are stored in `configs/investtrack.config.json`:

```json
{
  "oracle": {
    "host": "92.4.90.130",
    "user": "ubuntu",
    "port": 22,
    "deployDir": "/home/ubuntu/investment-tracker",
    "envFile": "/opt/investment-tracker.env",
    "dataDir": "/data",
    "backupScript": "/usr/local/bin/investment-backup.sh"
  },
  "deployment": {
    "enableScheduler": true,
    "enableAuth": true,
    "allowDbMigrations": false,
    "backupBeforeDeploy": true,
    "domain": "investtrack.duckdns.org"
  }
}
```

Update this file if your Oracle VM paths or connection details change.

### How to Trigger Deployment

**Option 1: GitHub Web UI (easiest)**

1. After pushing code changes to main branch on GitHub:
2. Go to: GitHub repo → Actions → "Deploy Oracle Production" workflow
3. Click "Run workflow"
4. Optional: uncheck `backup_before_deploy` if you don't want a pre-deploy backup
5. Optional: check `allow_db_migrations` if deploying schema changes
6. Click "Run workflow" button

**Option 2: GitHub CLI from local machine**

```bash
# List available workflows
gh workflow list

# Trigger deploy with defaults
gh workflow run deploy-oracle.yml --repo pankajydv/InvestmentTracker

# Trigger deploy with schema migrations enabled
gh workflow run deploy-oracle.yml --repo pankajydv/InvestmentTracker \
  -f allow_db_migrations=true
```

**Option 3: Git push + trigger workflow**

```bash
git add .
git commit -m "Your changes"
git push origin main
# Then go to GitHub Actions and click "Run workflow"
```

### Workflow Trigger Inputs (Optional Overrides)

- `allow_db_migrations` (default `false`) – set to `true` when deploying schema changes
- `backup_before_deploy` (default `true`) – disable to skip pre-deploy backup

### Required GitHub Secrets (Setup Once)

Only ONE secret is required:

- `ORACLE_SSH_PRIVATE_KEY` (private key matching an authorized key on VM)

All other parameters are read from `configs/investtrack.config.json`, eliminating the need for multiple secrets.

### Setup Instructions

1. **Add GitHub secret:**
   - Go to GitHub repo → Settings → Secrets and variables → Actions
   - Create secret `ORACLE_SSH_PRIVATE_KEY` with your private key content

2. **Verify config file:**
   - Check `configs/investtrack.config.json` has correct Oracle host/user/paths
   - Update if your VM setup differs from defaults

3. **Commit and push:**
   ```bash
   git add .
   git commit -m "Add investment tracker deployment config"
   git push origin main
   ```

4. **Test first deployment:**
   - Go to GitHub Actions and trigger "Deploy Oracle Production" workflow manually
   - Watch logs and verify deployment succeeds

## Maintenance Runbook

### 1) Safe DB Changes

When changing schema:

1. Add migration logic in `server/db/schema.js`.
2. Keep migrations idempotent and integrity-checked.
3. Preserve row counts when recreating tables.
4. Verify `schema_migrations` records are written.
5. Test with a copy of production DB before release.

### 2) Adding a New Asset Workflow

1. Update allowed `asset_type` and transaction type checks if needed.
2. Extend parsing/import routes.
3. Update pricing/backfill logic for valuation.
4. Ensure dashboard and allocation queries include/exclude correctly.
5. Add/update tests.

### 3) Troubleshooting Checklist

- Auth failures:
  - check `GOOGLE_CLIENT_ID`, `AUTH_DISABLED`, `ALLOWED_EMAILS`
- Missing valuations:
  - verify investment is active and not excluded from tracking
  - inspect dirty scopes and run backfill preflight/full
- Migration startup errors:
  - if production, set `ALLOW_DB_MIGRATIONS=true` during migration window
  - inspect backups under `data/migration-backups`
- Stale prices:
  - trigger `/api/utils/update-prices`
  - verify scheduler env and logs

## Known Design Constraints

- SQLite is the primary datastore; this is not currently a distributed multi-writer architecture.
- Some analytics are computed from ledger data and may be expensive after large imports.
- Daily rollups are derived data and should be treated as rebuildable caches.

## Suggested Next Improvements

- Add OpenAPI/Swagger for route contracts.
- Add dedicated migration files (versioned) instead of monolithic migration block.
- Add integration tests for import -> dirty scope -> backfill -> dashboard pipeline.
- Add ERD diagram image under `docs/` for onboarding.
