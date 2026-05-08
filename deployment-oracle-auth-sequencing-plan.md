# Oracle Deployment + Google Auth Sequencing Plan

## Goal
Host the app on Oracle Cloud Free Tier with HTTPS, DNS, and Google OAuth allowlisted access for:
- pankaj.ydv@gmail.com
- hianju.yadav@gmail.com
- yashita.ydv@gmail.com

## Recommended Strategy
Use a hybrid sequence:
- Implement auth-capable code now (local-first)
- Finalize OAuth after Oracle + stable HTTPS hostname are ready

This avoids exposing unauthenticated data and reduces rework.

## Phase 1: Implement Auth in Code (Local)
1. Add backend auth module and session middleware
2. Add Google ID token verification (`google-auth-library`)
3. Add allowlist check for 3 Gmail accounts
4. Add auth endpoints:
   - `POST /api/auth/google`
   - `GET /api/auth/me`
   - `POST /api/auth/logout`
5. Protect all business APIs with `requireAuth`
6. Add frontend login gate and authenticated app shell
7. Test locally with localhost OAuth callback

## Phase 2: Oracle Deploy (Safe/Private)
1. Create Oracle Always Free VM
2. Deploy app container with persistent volume for SQLite
3. Keep service private initially (or IP-restricted)
4. Validate app boot, data mount, and scheduler operations

## Phase 3: DNS + HTTPS
1. Create free DNS hostname/subdomain
2. Point DNS A record to Oracle VM public IP
3. Configure reverse proxy (recommended: Caddy)
4. Enable free TLS via Let's Encrypt
5. Verify HTTPS from laptop and mobile

## Phase 4: Finalize Google OAuth (Production)
1. Add production HTTPS origin in Google Cloud Console
2. Add production redirect URI
3. Keep localhost entries for dev
4. Validate login for allowlisted emails only
5. Validate blocked behavior for non-allowlisted emails

## Phase 5: Public Launch
1. Open firewall for `80/443`
2. Run smoke tests:
   - login/logout
   - session persistence
   - protected APIs blocked when unauthenticated
3. Family device validation (Android/iOS/laptops)

## Phase 6: PWA (After Core Stability)
1. Add web app manifest
2. Add icons and install metadata
3. Add service worker (start minimal)
4. Test install behavior on Android and iOS

## Why This Order
- Deploying first without auth risks exposing private financial data
- Completing OAuth before stable DNS/HTTPS causes callback URL rework
- This sequence gives fastest safe path with least repetition

## Acceptance Criteria
- Only allowlisted users can access dashboard/APIs
- App is reachable over valid HTTPS on laptop and mobile
- Sessions are secure and persistent
- SQLite data persists across restarts
- PWA install works on supported devices

## Notes
- DNS should not be bypassed for production OAuth + HTTPS + PWA experience
- Free TLS certificates are possible (Let's Encrypt), no certificate purchase required

## Phase 7: Post-Hosting Workstream
After Oracle hosting, DNS, HTTPS, Google auth, and PWA baseline are complete, execute the Historical Daily Backfill & Asset-Type P/L Engine plan.

### Historical Daily Backfill & Asset-Type P/L Engine

#### Goal
Generate daily time-series of portfolio value, invested amount, and gain/loss by asset type and portfolio for any date range including custom periods. Backfill from each investment's first transaction date to today, and stop computing once an investment exits.

#### Key Decisions
- Dividend treatment:
  - PPF/SSY/PF: interest stays in portfolio value.
  - SGB/INDIAN_STOCK/FOREIGN_STOCK/BOND: dividend/interest is cash-out and counted in P/L, but not in current value.
- Backfill start: per investment first transaction date (not global 2006).
- Recompute scope: impacted investments/portfolios only from earliest affected date.
- Price fallback: LOCF (carry forward last known price) with a price source flag.

#### Architecture

1. Schema changes ([server/db/schema.js](server/db/schema.js))
   - Add `price_source TEXT DEFAULT 'LIVE'` to `daily_values` (LIVE, LOCF, COMPUTED).
   - Add `realized_gain REAL DEFAULT 0` to `daily_values`.
   - Add `last_active_date TEXT` to `investments`.
   - Add `backfill_watermark` config key.
   - Add `asset_type_daily` table for pre-aggregated asset-type series:
     - `(portfolio_id, asset_type, date, total_value, total_invested, total_profit_loss, total_realized_gain, total_unrealized_gain, total_profit_loss_pct, day_change, day_change_pct)`
     - `UNIQUE(portfolio_id, asset_type, date)`

2. Backfill service ([server/services/backfillService.js](server/services/backfillService.js))
   - Implement `backfillRange(db, startDate, endDate, { investmentIds, portfolioIds })`.
   - Iterate date-wise and process active investments for each date.
   - For each `(investment, portfolio, date)` compute:
     - units up to date
     - invested amount up to date
     - realized gain up to date (cash-out types)
     - price for date (historical API or LOCF)
     - current value and profit/loss
   - Upsert into `daily_values` with `price_source`.
   - If holdings are zero going forward, set `last_active_date` and stop for that investment.
   - Batch commit per date using SQLite transaction.

3. Reuse/extend updater ([server/services/updater.js](server/services/updater.js))
   - Reuse `updatePortfolioDaily(db, date)`.
   - Add `updateAssetTypeDaily(db, date)` to aggregate from `daily_values` to `asset_type_daily`.
   - Ensure both are called in backfill and normal updates.

4. Historical price support ([server/services/priceService.js](server/services/priceService.js))
   - Add `fetchHistoricalNAV(amfiCode, date)` for MFs.
   - Add `fetchHistoricalStockPrice(ticker, date)` for stocks.
   - Use LOCF beyond provider coverage.

5. Recompute triggers ([server/routes/transactions.js](server/routes/transactions.js), [server/routes/stocks.js](server/routes/stocks.js))
   - After POST/PUT/DELETE transaction and corporate action import:
     - detect impacted investment/portfolio pairs
     - find earliest affected date
     - delete daily snapshots from that date for impacted scope
     - rerun backfill from affected date to today
   - Run sync for small windows, async for large windows.

6. API extensions ([server/routes/dashboard.js](server/routes/dashboard.js), [server/routes/utils.js](server/routes/utils.js))
   - Extend `GET /dashboard/performance` with `performanceByAssetType`.
   - Add `GET /dashboard/performance-by-type?asset_type=...` endpoint.
   - Add admin endpoints:
     - `POST /utils/backfill`
     - `GET /utils/backfill-status`

7. Frontend minimal updates ([client/src/components/Performance.jsx](client/src/components/Performance.jsx), [client/src/services/api.js](client/src/services/api.js))
   - Add asset-type filter tabs in Performance.
   - Add `getPerformanceByType(assetType, period, from, to, portfolioId)` API helper.

#### Delivery Phases
1. Schema + flags
2. Historical price fetchers
3. Backfill service
4. Recompute triggers
5. API extensions
6. Frontend filter support

#### Verification Checklist
1. Backfill a known MF and verify units x NAV on sampled dates.
2. Import a backdated split and verify recomputed rows from that date onward.
3. Verify `asset_type_daily` totals match summed `daily_values` per type/date.
4. Verify custom period response includes `performanceByAssetType`.
5. Validate LOCF row generation for assets without historical feed.
6. Validate PF/PPF compounding versus expected rate-history outputs.
7. Validate dividend cash-out affects P/L but not current value for cash-out types.

#### Scope Exclusions
- No XIRR/TWR pre-computation (keep client-side for now)
- No multi-currency portfolio reporting (INR totals only)
- No historical stock price guarantee before provider coverage; LOCF fallback
- No automatic seeding of pre-2006 PF/PPF rates beyond existing interest rate data
