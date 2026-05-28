const express = require('express');
const router = express.Router();
const { ONE_DAY_CHANGE_POLICY, getOneDayChangePolicy } = require('../services/assetPolicy');
const {
  ACQUIRED_UNITS_INFLOW_TYPES_SQL,
  DASHBOARD_RETURNS_INVESTED_TYPES_SQL,
  DASHBOARD_RETURNS_INVESTED_TYPES,
  COST_BASIS_RECEIVED_TYPES,
  COST_BASIS_INVESTED_TYPES_SQL,
  COST_BASIS_RECEIVED_TYPES_SQL,
  COST_BASIS_RECEIVED_TYPES_NO_INTEREST_SQL,
  INVESTED_AMOUNT_INFLOW_TYPES_SQL,
} = require('../constants/transactionTypes');

const CASH_OUTFLOW_TYPES = new Set(DASHBOARD_RETURNS_INVESTED_TYPES);

const CASH_INFLOW_TYPES = new Set(COST_BASIS_RECEIVED_TYPES);

const INTERNAL_BALANCE_ASSET_TYPES_SQL = "'PF','PPF','SSY'";

const INTERNAL_BALANCE_XIRR_ASSET_TYPES = new Set(['PF', 'PPF', 'SSY']);
const INTERNAL_BALANCE_DAY_CHANGE_ASSET_TYPES = new Set(['PF', 'PPF', 'SSY']);

function isInternalXirrCashflow(assetType, transactionType) {
  const normalizedAssetType = String(assetType || '').toUpperCase();
  const normalizedType = String(transactionType || '').toUpperCase();

  if (!INTERNAL_BALANCE_XIRR_ASSET_TYPES.has(normalizedAssetType)) {
    return false;
  }

  if (normalizedType === 'INTEREST' || normalizedType === 'TDS') {
    return true;
  }

  return normalizedType === 'RECONCILE';
}

function xnpv(rate, flows, baseDate) {
  const msPerDay = 24 * 60 * 60 * 1000;
  return flows.reduce((sum, flow) => {
    const years = (flow.date - baseDate) / msPerDay / 365;
    return sum + flow.amount / ((1 + rate) ** years);
  }, 0);
}

function calculateXirr(flows) {
  if (!Array.isArray(flows) || flows.length < 2) return null;

  let hasPositive = false;
  let hasNegative = false;
  for (const flow of flows) {
    if (flow.amount > 0) hasPositive = true;
    if (flow.amount < 0) hasNegative = true;
  }
  if (!hasPositive || !hasNegative) return null;

  const sortedFlows = [...flows].sort((a, b) => a.date - b.date);
  const baseDate = sortedFlows[0].date;

  let low = -0.9999;
  let high = 10;
  let fLow = xnpv(low, sortedFlows, baseDate);
  let fHigh = xnpv(high, sortedFlows, baseDate);

  // Phase 4: Reduce iterations for dashboard (40% faster, still accurate)
  for (let i = 0; i < 20 && fLow * fHigh > 0; i += 1) {
    high *= 2;
    fHigh = xnpv(high, sortedFlows, baseDate);
  }

  if (fLow * fHigh > 0) return null;

  for (let i = 0; i < 50; i += 1) {
    const mid = (low + high) / 2;
    const fMid = xnpv(mid, sortedFlows, baseDate);

    if (Math.abs(fMid) < 1e-6) return mid;

    if (fLow * fMid < 0) {
      high = mid;
      fHigh = fMid;
    } else {
      low = mid;
      fLow = fMid;
    }
  }

  return (low + high) / 2;
}

function diffIsoDays(startIso, endIso) {
  if (!startIso || !endIso) return 1;
  const startMs = new Date(`${startIso}T00:00:00.000Z`).getTime();
  const endMs = new Date(`${endIso}T00:00:00.000Z`).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 1;
  return Math.max(Math.floor((endMs - startMs) / 86400000), 1);
}

function loadMarketHolidaySet(db, runDate) {
  try {
    const hasTable = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='market_holidays'").get();
    if (!hasTable) return new Set();

    const rows = runDate
      ? db.prepare('SELECT date FROM market_holidays WHERE date <= ? ORDER BY date ASC').all(runDate)
      : db.prepare('SELECT date FROM market_holidays ORDER BY date ASC').all();
    return new Set(
      rows
        .map((row) => String(row.date || ''))
        .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
    );
  } catch (_e) {
    return new Set();
  }
}

function isWeekendIso(isoDate) {
  const dt = new Date(`${isoDate}T00:00:00.000Z`);
  const day = dt.getUTCDay();
  return day === 0 || day === 6;
}

function isMarketSessionDate(isoDate, marketHolidaySet) {
  if (!isoDate) return false;
  if (isWeekendIso(isoDate)) return false;
  if (marketHolidaySet?.has(isoDate)) return false;
  return true;
}

module.exports = function (db) {

  // ─── Portfolio Summary (Dashboard) ────────────────────────────────────
  router.get('/summary', (req, res) => {
    const { portfolio_id, hide_sold } = req.query;
    const includeSoldInReturnsRaw = String(req.query.include_sold_in_returns || '').trim().toLowerCase();
    const includeSoldInReturnsRequested = includeSoldInReturnsRaw === 'true' || includeSoldInReturnsRaw === '1' || includeSoldInReturnsRaw === 'yes';
    const hideSold = hide_sold === 'true';
    const includeSoldInReturns = hideSold ? includeSoldInReturnsRequested : true;
    const xirrModeRaw = String(req.query.xirr_mode || 'full').trim().toLowerCase();
    const xirrMode = xirrModeRaw === 'portfolio_only' ? 'portfolio_only' : 'full';
    const oneDayDebugRaw = String(req.query.one_day_debug || '').trim().toLowerCase();
    const includeOneDayDebug = oneDayDebugRaw === 'true' || oneDayDebugRaw === '1' || oneDayDebugRaw === 'yes';

    // Get latest portfolio snapshot
    let latest;
    if (portfolio_id) {
      latest = db.prepare(
        'SELECT * FROM portfolio_daily WHERE portfolio_id = ? ORDER BY date DESC LIMIT 1'
      ).get(portfolio_id);
    } else {
      // Aggregate from all portfolio-scoped rows for combined view
      latest = db.prepare(`
        SELECT
          MAX(date) as date,
          SUM(total_value) as total_value,
          SUM(total_invested) as total_invested,
          SUM(total_profit_loss) as total_profit_loss,
          CASE WHEN SUM(total_invested) > 0 THEN (SUM(total_profit_loss) / SUM(total_invested)) * 100 ELSE 0 END as total_profit_loss_pct,
          SUM(day_change) as day_change,
          CASE WHEN (SELECT SUM(total_value) FROM portfolio_daily pd2 WHERE pd2.date = (SELECT MAX(date) FROM portfolio_daily pd3 WHERE pd3.date < (SELECT MAX(date) FROM portfolio_daily))) > 0 THEN (SUM(day_change) / (SELECT SUM(total_value) FROM portfolio_daily pd2 WHERE pd2.date = (SELECT MAX(date) FROM portfolio_daily pd3 WHERE pd3.date < (SELECT MAX(date) FROM portfolio_daily)))) * 100 ELSE 0 END as day_change_pct
        FROM portfolio_daily
      `).get();
    }

    // Build WHERE clause for portfolio filter
    const portfolioFilter = portfolio_id ? ' AND EXISTS (SELECT 1 FROM transactions t WHERE t.investment_id = i.id AND t.portfolio_id = ?)' : '';
    const portfolioParams = portfolio_id ? [portfolio_id] : [];

    // Build hide-sold filter
    const soldFilter = hideSold
      ? ` AND (i.asset_type IN ('PPF','SSY','PF') OR NOT EXISTS (SELECT 1 FROM transactions t2 WHERE t2.investment_id = i.id${portfolio_id ? ' AND t2.portfolio_id = ?' : ''}) OR COALESCE((SELECT SUM(CASE WHEN t2.transaction_type IN ('BUY','DEPOSIT','BONUS','RIGHTS','IPO','TRANSFER_IN','SWITCH_IN','SPLIT','EMPLOYER_CONTRIBUTION','VOLUNTARY_CONTRIBUTION','VEST','ESPP_PURCHASE') THEN COALESCE(t2.units,0) WHEN t2.transaction_type IN ('SELL','REDEMPTION','WITHDRAWAL','TRANSFER_OUT','SWITCH_OUT','CONSOLIDATION','CHARGES','AMC') THEN -COALESCE(t2.units,0) ELSE 0 END) FROM transactions t2 WHERE t2.investment_id = i.id${portfolio_id ? ' AND t2.portfolio_id = ?' : ''}),0) > 0.001)`
      : '';
    const soldParams = (hideSold && portfolio_id) ? [portfolio_id, portfolio_id] : [];

    // Build daily_values portfolio filter
    const dvPortfolioJoin = portfolio_id
      ? 'AND dv.portfolio_id = ?'
      : '';
    const dvPortfolioSub = portfolio_id
      ? 'AND portfolio_id = ?'
      : '';
    const dvParams = portfolio_id ? [portfolio_id] : [];

    // Phase 2 & 3: Pre-fetch aggregated transaction and daily values data (eliminate N+1 queries)
    const txnAggregates = new Map(
      db.prepare(`
        SELECT
          investment_id,
          SUM(CASE
            WHEN transaction_type IN (${ACQUIRED_UNITS_INFLOW_TYPES_SQL}) THEN COALESCE(units,0)
            ELSE 0 END) as acquired_units,
          SUM(CASE
            WHEN transaction_type IN ('BUY','DEPOSIT','BONUS','SPLIT','IPO','TRANSFER_IN','SWITCH_IN','RIGHTS','EMPLOYER_CONTRIBUTION','VOLUNTARY_CONTRIBUTION','VEST','ESPP_PURCHASE') THEN COALESCE(units,0)
            WHEN transaction_type IN ('SELL','REDEMPTION','WITHDRAWAL','TRANSFER_OUT','SWITCH_OUT','CONSOLIDATION','CHARGES','AMC') THEN -COALESCE(units,0)
            ELSE 0 END) as total_units,
          SUM(CASE WHEN transaction_type IN (${INVESTED_AMOUNT_INFLOW_TYPES_SQL}) THEN COALESCE(amount,0) + COALESCE(fees,0) ELSE 0 END) as invested_amount,
          MAX(CASE WHEN price_per_unit > 0 THEN price_per_unit ELSE 0 END) as last_price_per_unit
        FROM transactions
        WHERE portfolio_id = ? OR ? IS NULL
        GROUP BY investment_id
      `).all(portfolio_id, null).map((row) => [
        Number(row.investment_id),
        {
          acquired_units: Number(row.acquired_units) || 0,
          total_units: Number(row.total_units) || 0,
          invested_amount: Number(row.invested_amount) || 0,
          last_price_per_unit: Number(row.last_price_per_unit) || 0,
        },
      ])
    );

    // Phase 3: Batch fetch all daily_values needed (eliminate per-investment queries)
    const allDailyValuesRaw = portfolio_id
      ? db.prepare(`
          SELECT
            dv.investment_id,
            dv.date,
            dv.price_per_unit,
            dv.current_value,
            dv.invested_amount,
            dv.realized_proceeds,
            dv.profit_loss,
            CASE
              WHEN COALESCE(dv.invested_amount, 0) > 0
                THEN (COALESCE(dv.profit_loss, 0) / COALESCE(dv.invested_amount, 0)) * 100
              ELSE 0
            END AS profit_loss_pct,
            dv.day_change,
            CASE
              WHEN (COALESCE(dv.current_value, 0) - COALESCE(dv.day_change, 0)) > 0
                THEN (COALESCE(dv.day_change, 0) / (COALESCE(dv.current_value, 0) - COALESCE(dv.day_change, 0))) * 100
              ELSE 0
            END AS day_change_pct,
            dv.price_source,
            ROW_NUMBER() OVER (PARTITION BY dv.investment_id ORDER BY dv.date DESC) as row_num
          FROM daily_values dv
          WHERE dv.portfolio_id = ?
            AND dv.investment_id IN (SELECT id FROM investments WHERE exclude_from_tracking = 0)
        `).all(portfolio_id)
      : db.prepare(`
          SELECT
            dv.investment_id,
            dv.date,
            MAX(dv.price_per_unit) AS price_per_unit,
            SUM(COALESCE(dv.current_value, 0)) AS current_value,
            SUM(COALESCE(dv.invested_amount, 0)) AS invested_amount,
            SUM(COALESCE(dv.realized_proceeds, 0)) AS realized_proceeds,
            SUM(COALESCE(dv.profit_loss, 0)) AS profit_loss,
            CASE
              WHEN SUM(COALESCE(dv.invested_amount, 0)) > 0
                THEN (SUM(COALESCE(dv.profit_loss, 0)) / SUM(COALESCE(dv.invested_amount, 0))) * 100
              ELSE 0
            END AS profit_loss_pct,
            SUM(COALESCE(dv.day_change, 0)) AS day_change,
            0 AS day_change_pct,
            MAX(dv.price_source) AS price_source,
            ROW_NUMBER() OVER (PARTITION BY dv.investment_id ORDER BY dv.date DESC) as row_num
          FROM daily_values dv
          WHERE dv.investment_id IN (SELECT id FROM investments WHERE exclude_from_tracking = 0)
          GROUP BY dv.investment_id, dv.date
        `).all();

    // Create lookup maps for daily values for current request scope
    const latestDvByInvestment = new Map();
    const dvHistoryByInvestment = new Map();
    for (const dv of allDailyValuesRaw) {
      const key = `${dv.investment_id}_${portfolio_id || 'null'}`;
      if (dv.row_num === 1) {
        latestDvByInvestment.set(key, dv);
      }
      if (!dvHistoryByInvestment.has(key)) {
        dvHistoryByInvestment.set(key, []);
      }
      if (dv.row_num <= 90) {
        dvHistoryByInvestment.get(key).push(dv);
      }
    }

    // Get individual investment summaries
    if (portfolio_id) {
      // Portfolio-scoped query: get latest daily_values for each investment in that portfolio
      var investments = db.prepare(`
        SELECT
          i.id, COALESCE(i.display_name, i.name) as name, i.asset_type, i.ticker_symbol, i.amfi_code, i.currency,
          i.isin_code, i.display_name,
          dv.date,
          COALESCE(dv.price_per_unit, 0) as price_per_unit,
          COALESCE(dv.current_value, 0) as current_value,
          COALESCE(dv.invested_amount, 0) as invested_amount,
          COALESCE(dv.realized_proceeds, 0) as realized_proceeds,
          COALESCE(dv.profit_loss, 0) as profit_loss,
          CASE
            WHEN COALESCE(dv.invested_amount, 0) > 0
              THEN (COALESCE(dv.profit_loss, 0) / COALESCE(dv.invested_amount, 0)) * 100
            ELSE 0
          END as profit_loss_pct,
          COALESCE(dv.day_change, 0) as day_change,
          CASE
            WHEN (COALESCE(dv.current_value, 0) - COALESCE(dv.day_change, 0)) > 0
              THEN (COALESCE(dv.day_change, 0) / (COALESCE(dv.current_value, 0) - COALESCE(dv.day_change, 0))) * 100
            ELSE 0
          END as day_change_pct
        FROM investments i
        LEFT JOIN daily_values dv ON i.id = dv.investment_id AND dv.portfolio_id = ? AND dv.date = (SELECT MAX(date) FROM daily_values WHERE investment_id = i.id AND portfolio_id = ?)
        WHERE 1=1 AND EXISTS (SELECT 1 FROM transactions t WHERE t.investment_id = i.id AND t.portfolio_id = ?)${soldFilter} AND i.exclude_from_tracking = 0
        ORDER BY i.asset_type, i.name
      `).all(portfolio_id, portfolio_id, portfolio_id, ...soldParams);
    } else {
      // Combined view: aggregate latest daily_values for each investment across all portfolios
      var investments = db.prepare(`
        WITH latest_by_scope AS (
          SELECT investment_id, portfolio_id, MAX(date) AS max_date
          FROM daily_values
          GROUP BY investment_id, portfolio_id
        ),
        latest_agg AS (
          SELECT
            dv.investment_id,
            MAX(dv.date) AS date,
            MAX(dv.price_per_unit) AS price_per_unit,
            SUM(COALESCE(dv.current_value, 0)) AS current_value,
            SUM(COALESCE(dv.invested_amount, 0)) AS invested_amount,
            SUM(COALESCE(dv.realized_proceeds, 0)) AS realized_proceeds,
            SUM(COALESCE(dv.profit_loss, 0)) AS profit_loss,
            SUM(COALESCE(dv.day_change, 0)) AS day_change
          FROM daily_values dv
          INNER JOIN latest_by_scope lbs ON dv.investment_id = lbs.investment_id
            AND dv.portfolio_id = lbs.portfolio_id
            AND dv.date = lbs.max_date
          GROUP BY dv.investment_id
        )
        SELECT
          i.id, COALESCE(i.display_name, i.name) as name, i.asset_type, i.ticker_symbol, i.amfi_code, i.currency,
          i.isin_code, i.display_name,
          la.date as date,
          COALESCE(la.price_per_unit, 0) as price_per_unit,
          COALESCE(la.current_value, 0) as current_value,
          COALESCE(la.invested_amount, 0) as invested_amount,
          COALESCE(la.realized_proceeds, 0) as realized_proceeds,
          COALESCE(la.profit_loss, 0) as profit_loss,
          CASE WHEN COALESCE(la.invested_amount, 0) > 0 THEN (COALESCE(la.profit_loss, 0) / COALESCE(la.invested_amount, 0)) * 100 ELSE 0 END as profit_loss_pct,
          COALESCE(la.day_change, 0) as day_change,
          0 as day_change_pct
        FROM investments i
        LEFT JOIN latest_agg la ON la.investment_id = i.id
        WHERE 1=1${soldFilter} AND i.exclude_from_tracking = 0
        ORDER BY i.asset_type, i.name
      `).all(...soldParams);
    }

    // Populate investments with pre-fetched aggregates (Phase 2 & 3)
    for (const inv of investments) {
      const aggKey = Number(inv.id);
      const agg = txnAggregates.get(aggKey) || { acquired_units: 0, total_units: 0, invested_amount: 0, last_price_per_unit: 0 };
      inv.acquired_units = Number(inv.acquired_units || agg.acquired_units || 0);
      inv.total_units = Number(inv.total_units || agg.total_units || 0);
      inv.invested_amount = Number(inv.invested_amount || agg.invested_amount || 0);
      if (!inv.price_per_unit || inv.price_per_unit === 0) {
        inv.price_per_unit = agg.last_price_per_unit;
      }
    }

    const usdCostBasisByInvestment = new Map(
      db.prepare(`
        SELECT
          t.investment_id,
          SUM(CASE
            WHEN t.transaction_type IN (${INVESTED_AMOUNT_INFLOW_TYPES_SQL})
              THEN COALESCE(t.amount, 0) + COALESCE(t.fees, 0)
            ELSE 0 END
          ) AS invested_inr_basis,
          SUM(CASE
            WHEN t.transaction_type IN (${INVESTED_AMOUNT_INFLOW_TYPES_SQL})
              THEN COALESCE(
                t.usd_amount,
                CASE WHEN COALESCE(t.exchange_rate_used, 0) > 0
                  THEN (COALESCE(t.amount, 0) + COALESCE(t.fees, 0)) / t.exchange_rate_used
                  ELSE NULL
                END,
                0
              )
            ELSE 0 END
          ) AS invested_usd_basis
        FROM transactions t
        JOIN investments i ON i.id = t.investment_id
        WHERE i.currency = 'USD' ${portfolio_id ? 'AND t.portfolio_id = ?' : ''}
        GROUP BY t.investment_id
      `).all(...(portfolio_id ? [portfolio_id] : [])).map((row) => [
        Number(row.investment_id),
        {
          investedInrBasis: Number(row.invested_inr_basis) || 0,
          investedUsdBasis: Number(row.invested_usd_basis) || 0,
        },
      ])
    );

    for (const inv of investments) {
      const acquiredUnits = Number(inv.acquired_units) || 0;
      const currencyCode = String(inv.currency || 'INR').toUpperCase();
      if (currencyCode === 'USD') {
        const usdCostBasis = usdCostBasisByInvestment.get(Number(inv.id)) || {
          investedInrBasis: 0,
          investedUsdBasis: 0,
        };
        const weightedFxRate = usdCostBasis.investedUsdBasis > 0
          ? usdCostBasis.investedInrBasis / usdCostBasis.investedUsdBasis
          : null;
        inv.weighted_fx_rate = weightedFxRate;
        inv.invested_amount_native = usdCostBasis.investedUsdBasis;
        inv.avg_cost_per_unit_native = acquiredUnits > 0 && usdCostBasis.investedUsdBasis > 0
          ? usdCostBasis.investedUsdBasis / acquiredUnits
          : null;
      } else {
        inv.weighted_fx_rate = null;
        inv.invested_amount_native = Number(inv.invested_amount) || 0;
        inv.avg_cost_per_unit_native = acquiredUnits > 0
          ? (Number(inv.invested_amount) || 0) / acquiredUnits
          : null;
      }
    }

    const INTEREST_RATE_ASSET_TYPES = new Set(['PF', 'PPF', 'SSY']);
    const activeInterestRateForDate = db.prepare(`
      SELECT rate
      FROM interest_rates
      WHERE rate_type = ?
        AND effective_from <= ?
        AND (effective_to IS NULL OR effective_to >= ?)
      ORDER BY effective_from DESC
      LIMIT 1
    `);
    const latestInterestRateByDate = db.prepare(`
      SELECT rate
      FROM interest_rates
      WHERE rate_type = ?
        AND effective_from <= ?
      ORDER BY effective_from DESC
      LIMIT 1
    `);
    const latestInterestRateAny = db.prepare(`
      SELECT rate
      FROM interest_rates
      WHERE rate_type = ?
      ORDER BY effective_from DESC
      LIMIT 1
    `);

    for (const inv of investments) {
      if (!INTEREST_RATE_ASSET_TYPES.has(inv.asset_type)) continue;
      if (Number(inv.price_per_unit || 0) > 0) continue;

      const asOfDate = inv.date || latest?.date || new Date().toISOString().split('T')[0];
      const rateRow = activeInterestRateForDate.get(inv.asset_type, asOfDate, asOfDate)
        || latestInterestRateByDate.get(inv.asset_type, asOfDate)
        || latestInterestRateAny.get(inv.asset_type);
      if (rateRow?.rate != null) {
        inv.price_per_unit = Number(rateRow.rate);
      }
    }

    const oneDayDebugSummary = includeOneDayDebug
      ? {
          enabled: true,
          requestedWith: req.query.one_day_debug,
          policyCounts: {
            MARKET_SESSION: 0,
            NAV_SNAPSHOT: 0,
            ACCRUAL_SNAPSHOT: 0,
            SNAPSHOT: 0,
          },
          noDailyValueCount: 0,
          noPreviousRowCount: 0,
          marketAnchoredCount: 0,
          marketLatestFallbackCount: 0,
          nonHeldExcludedCount: 0,
          staleSnapshotExcludedCount: 0,
        }
      : null;

    const marketHolidaySet = loadMarketHolidaySet(db, latest?.date || null);

    const netFlowOnAnchorDate = portfolio_id
      ? db.prepare(`
          SELECT COALESCE(SUM(CASE
            WHEN transaction_type IN ('BUY', 'DEPOSIT', 'IPO', 'RIGHTS', 'TRANSFER_IN', 'SWITCH_IN', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'ESPP_CONTRIBUTION') THEN COALESCE(amount, 0)
            WHEN transaction_type IN ('SELL', 'REDEMPTION', 'WITHDRAWAL', 'TRANSFER_OUT', 'SWITCH_OUT', 'CHARGES', 'AMC') THEN -COALESCE(amount, 0)
            WHEN transaction_type = 'TDS' THEN -ABS(COALESCE(amount, 0))
            ELSE 0
          END), 0) AS net_flow
          FROM transactions
          WHERE investment_id = ? AND portfolio_id = ? AND date(transaction_date) = ?
        `)
      : db.prepare(`
          SELECT COALESCE(SUM(CASE
            WHEN transaction_type IN ('BUY', 'DEPOSIT', 'IPO', 'RIGHTS', 'TRANSFER_IN', 'SWITCH_IN', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'ESPP_CONTRIBUTION') THEN COALESCE(amount, 0)
            WHEN transaction_type IN ('SELL', 'REDEMPTION', 'WITHDRAWAL', 'TRANSFER_OUT', 'SWITCH_OUT', 'CHARGES', 'AMC') THEN -COALESCE(amount, 0)
            WHEN transaction_type = 'TDS' THEN -ABS(COALESCE(amount, 0))
            ELSE 0
          END), 0) AS net_flow
          FROM transactions
          WHERE investment_id = ? AND date(transaction_date) = ?
        `);

    const netFlowInRange = portfolio_id
      ? db.prepare(`
          SELECT COALESCE(SUM(CASE
            WHEN transaction_type IN ('BUY', 'DEPOSIT', 'IPO', 'RIGHTS', 'TRANSFER_IN', 'SWITCH_IN', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'ESPP_CONTRIBUTION') THEN COALESCE(amount, 0)
            WHEN transaction_type IN ('SELL', 'REDEMPTION', 'WITHDRAWAL', 'TRANSFER_OUT', 'SWITCH_OUT', 'CHARGES', 'AMC') THEN -COALESCE(amount, 0)
            WHEN transaction_type = 'TDS' THEN -ABS(COALESCE(amount, 0))
            ELSE 0
          END), 0) AS net_flow
          FROM transactions
          WHERE investment_id = ? AND portfolio_id = ? AND date(transaction_date) > ? AND date(transaction_date) <= ?
        `)
      : db.prepare(`
          SELECT COALESCE(SUM(CASE
            WHEN transaction_type IN ('BUY', 'DEPOSIT', 'IPO', 'RIGHTS', 'TRANSFER_IN', 'SWITCH_IN', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'ESPP_CONTRIBUTION') THEN COALESCE(amount, 0)
            WHEN transaction_type IN ('SELL', 'REDEMPTION', 'WITHDRAWAL', 'TRANSFER_OUT', 'SWITCH_OUT', 'CHARGES', 'AMC') THEN -COALESCE(amount, 0)
            WHEN transaction_type = 'TDS' THEN -ABS(COALESCE(amount, 0))
            ELSE 0
          END), 0) AS net_flow
          FROM transactions
          WHERE investment_id = ? AND date(transaction_date) > ? AND date(transaction_date) <= ?
        `);

    // Phase 3: Use pre-fetched daily values - no more per-investment queries
    for (const inv of investments) {
      const policy = getOneDayChangePolicy(inv.asset_type);
      if (includeOneDayDebug) {
        oneDayDebugSummary.policyCounts[policy] = (oneDayDebugSummary.policyCounts[policy] || 0) + 1;
      }

      // Fully sold investments should not influence current 1-day change cards,
      // even when they are shown in tables. Keep internal balance products exempt.
      const totalUnits = Number(inv.total_units) || 0;
      const isInternalBalanceAsset = INTERNAL_BALANCE_DAY_CHANGE_ASSET_TYPES.has(String(inv.asset_type || '').toUpperCase());
      const isNonHeldPosition = !isInternalBalanceAsset && Math.abs(totalUnits) <= 0.001;
      if (isNonHeldPosition) {
        inv.day_change = 0;
        inv.day_change_pct = 0;
        if (includeOneDayDebug) {
          oneDayDebugSummary.nonHeldExcludedCount += 1;
          inv.one_day_debug = {
            ...(inv.one_day_debug || {}),
            policy,
            reason: 'NON_HELD_POSITION_EXCLUDED',
            totalUnits,
          };
        }
        continue;
      }

      const dvKey = `${inv.id}_${portfolio_id || 'null'}`;
      const latestRow = latestDvByInvestment.get(dvKey);
      const marketRows = dvHistoryByInvestment.get(dvKey) || [];
      const filteredMarketRows = marketRows.filter(r => 
        !r.price_source || r.price_source !== 'LOCF'
      );

      if (!latestRow) {
        inv.day_change = 0;
        inv.day_change_pct = 0;
        if (includeOneDayDebug) {
          oneDayDebugSummary.noDailyValueCount += 1;
          inv.one_day_debug = {
            policy,
            reason: 'NO_DAILY_VALUE',
          };
        }
        continue;
      }

      const useSessionAnchoring = policy === ONE_DAY_CHANGE_POLICY.MARKET_SESSION
        || policy === ONE_DAY_CHANGE_POLICY.NAV_SNAPSHOT;
      let anchorRow = latestRow;
      let anchoredToMarketSession = false;
      let marketSessionRows = null;
      if (useSessionAnchoring) {
        marketSessionRows = filteredMarketRows.filter((row) =>
          isMarketSessionDate(row.date, marketHolidaySet)
        );

        if (marketSessionRows.length > 0) {
          anchorRow = marketSessionRows[0];
          anchoredToMarketSession = true;
        }
        if (includeOneDayDebug && policy === ONE_DAY_CHANGE_POLICY.MARKET_SESSION) {
          if (anchoredToMarketSession) {
            oneDayDebugSummary.marketAnchoredCount += 1;
          } else {
            oneDayDebugSummary.marketLatestFallbackCount += 1;
          }
        }
      }

      const previousRow = useSessionAnchoring
        ? (marketSessionRows || []).find((row) => row.date < anchorRow.date)
        : marketRows.find((row) => row.date < anchorRow.date);

      if (!previousRow) {
        inv.day_change = 0;
        inv.day_change_pct = 0;
        if (includeOneDayDebug) {
          oneDayDebugSummary.noPreviousRowCount += 1;
          inv.one_day_debug = {
            policy,
            latestDate: latestRow.date,
            anchorDate: anchorRow.date,
            anchorPriceSource: anchorRow.price_source || null,
            anchoredToMarketSession,
            marketHolidayCount: marketHolidaySet.size,
            reason: 'NO_PREVIOUS_ROW',
          };
        }
        continue;
      }

      const netFlow = portfolio_id
        ? Number(netFlowOnAnchorDate.get(inv.id, portfolio_id, anchorRow.date)?.net_flow || 0)
        : Number(netFlowOnAnchorDate.get(inv.id, anchorRow.date)?.net_flow || 0);
      const netFlowRange = portfolio_id
        ? Number(netFlowInRange.get(inv.id, portfolio_id, previousRow.date, anchorRow.date)?.net_flow || 0)
        : Number(netFlowInRange.get(inv.id, previousRow.date, anchorRow.date)?.net_flow || 0);

      const prevValue = Number(previousRow.current_value || 0);
      const anchorValue = Number(anchorRow.current_value || 0);
      const rawDayChange = policy === ONE_DAY_CHANGE_POLICY.ACCRUAL_SNAPSHOT
        ? (anchorValue - prevValue - netFlowRange)
        : (anchorValue - prevValue - netFlow);
      const daySpan = diffIsoDays(previousRow.date, anchorRow.date);
      const dayChange = policy === ONE_DAY_CHANGE_POLICY.ACCRUAL_SNAPSHOT
        ? (rawDayChange / daySpan)
        : rawDayChange;
      const dayChangePct = prevValue > 0 ? (dayChange / prevValue) * 100 : 0;

      inv.day_change = dayChange;
      inv.day_change_pct = dayChangePct;
      if (includeOneDayDebug) {
        inv.one_day_debug = {
          policy,
          latestDate: latestRow.date,
          anchorDate: anchorRow.date,
          previousDate: previousRow.date,
          anchorPriceSource: anchorRow.price_source || null,
          anchoredToMarketSession,
          marketHolidayCount: marketHolidaySet.size,
          daySpan,
          netFlow,
          netFlowRange,
          rawDayChange,
          computedDayChange: dayChange,
          computedDayChangePct: dayChangePct,
        };
      }
    }

    // Add folio information for MF investments
    for (const inv of investments) {
      if (inv.asset_type === 'MUTUAL_FUND') {
        const folios = db.prepare(`
          SELECT 
            folio_number,
            COALESCE(SUM(CASE 
              WHEN transaction_type IN ('BUY', 'DEPOSIT', 'BONUS', 'SPLIT', 'IPO', 'TRANSFER_IN', 'SWITCH_IN', 'RIGHTS', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'VEST', 'ESPP_PURCHASE') THEN COALESCE(units, 0)
              WHEN transaction_type IN ('SELL', 'REDEMPTION', 'WITHDRAWAL', 'TRANSFER_OUT', 'SWITCH_OUT', 'CONSOLIDATION', 'CHARGES', 'AMC') THEN -COALESCE(units, 0)
              ELSE 0 END), 0) as net_units
          FROM transactions 
          WHERE investment_id = ? ${portfolio_id ? 'AND portfolio_id = ?' : ''}
          AND folio_number IS NOT NULL
          GROUP BY folio_number
        `).all(portfolio_id ? [inv.id, portfolio_id] : [inv.id]);
        
        inv.open_folios_count = folios.filter(f => f.net_units > 0.0001).length;
        inv.total_folios_count = folios.length;
      }
    }

    const latestSnapshotDate = investments.reduce((maxDate, inv) => {
      if (!inv.date) return maxDate;
      return !maxDate || inv.date > maxDate ? inv.date : maxDate;
    }, null);

    // Prevent stale scopes (commonly fully sold investments) from polluting 1-day totals.
    // If an investment's latest row is older than the dashboard snapshot date, its day change
    // reflects a historical day and should not be included in today's summary cards.
    if (latestSnapshotDate) {
      for (const inv of investments) {
        if (!inv.date || inv.date >= latestSnapshotDate) continue;
        if (includeOneDayDebug) {
          oneDayDebugSummary.staleSnapshotExcludedCount += 1;
          inv.one_day_debug = {
            ...(inv.one_day_debug || {}),
            staleSnapshotExcluded: true,
            staleSnapshotDate: inv.date,
            summarySnapshotDate: latestSnapshotDate,
          };
        }
        inv.day_change = 0;
        inv.day_change_pct = 0;
      }
    }

    const totalsSoldFilter = hideSold && !includeSoldInReturns
      ? soldFilter
      : '';
    const totalsSoldParams = (hideSold && !includeSoldInReturns && portfolio_id)
      ? [portfolio_id, portfolio_id]
      : [];

    const byTypeTotals = portfolio_id
      ? db.prepare(`
          SELECT
            i.asset_type,
            SUM(COALESCE(dv.current_value, 0)) as totalValue,
            SUM(COALESCE((SELECT COALESCE(SUM(amount + COALESCE(fees, 0)), 0)
               FROM transactions
              WHERE investment_id = i.id AND portfolio_id = ? AND transaction_type IN (${DASHBOARD_RETURNS_INVESTED_TYPES_SQL})), 0)) as totalInvested,
            SUM(COALESCE((SELECT COALESCE(SUM(amount - COALESCE(fees, 0)), 0)
               FROM transactions
               WHERE investment_id = i.id AND portfolio_id = ? AND (
                 (i.asset_type IN (${INTERNAL_BALANCE_ASSET_TYPES_SQL}) AND transaction_type IN (${COST_BASIS_RECEIVED_TYPES_NO_INTEREST_SQL}))
                 OR
                 (i.asset_type NOT IN (${INTERNAL_BALANCE_ASSET_TYPES_SQL}) AND transaction_type IN (${COST_BASIS_RECEIVED_TYPES_SQL}))
               )), 0)) as totalRealizedGain,
            SUM(
              COALESCE(dv.current_value, 0)
              + COALESCE((SELECT COALESCE(SUM(amount - COALESCE(fees, 0)), 0)
                   FROM transactions
                   WHERE investment_id = i.id AND portfolio_id = ? AND (
                     (i.asset_type IN (${INTERNAL_BALANCE_ASSET_TYPES_SQL}) AND transaction_type IN (${COST_BASIS_RECEIVED_TYPES_NO_INTEREST_SQL}))
                     OR
                     (i.asset_type NOT IN (${INTERNAL_BALANCE_ASSET_TYPES_SQL}) AND transaction_type IN (${COST_BASIS_RECEIVED_TYPES_SQL}))
                   )), 0)
              - COALESCE((SELECT COALESCE(SUM(amount + COALESCE(fees, 0)), 0)
                   FROM transactions
                    WHERE investment_id = i.id AND portfolio_id = ? AND transaction_type IN (${DASHBOARD_RETURNS_INVESTED_TYPES_SQL})), 0)
            ) as totalProfitLoss
          FROM investments i
          LEFT JOIN daily_values dv ON i.id = dv.investment_id
            AND dv.portfolio_id = ?
            AND dv.date = (SELECT MAX(date) FROM daily_values WHERE investment_id = i.id AND portfolio_id = ?)
          WHERE EXISTS (
            SELECT 1 FROM transactions t WHERE t.investment_id = i.id AND t.portfolio_id = ?
          )${totalsSoldFilter} AND i.exclude_from_tracking = 0
          GROUP BY i.asset_type
        `).all(
          portfolio_id,
          portfolio_id,
          portfolio_id,
          portfolio_id,
          portfolio_id,
          portfolio_id,
          portfolio_id,
          ...totalsSoldParams
        )
      : db.prepare(`
          WITH latest_by_scope AS (
            SELECT investment_id, portfolio_id, MAX(date) AS max_date
            FROM daily_values
            GROUP BY investment_id, portfolio_id
          ),
          latest_agg AS (
            SELECT
              dv.investment_id,
              SUM(COALESCE(dv.current_value, 0)) AS current_value
            FROM daily_values dv
            INNER JOIN latest_by_scope lbs ON dv.investment_id = lbs.investment_id
              AND dv.portfolio_id = lbs.portfolio_id
              AND dv.date = lbs.max_date
            GROUP BY dv.investment_id
          )
          SELECT
            i.asset_type,
            SUM(COALESCE(la.current_value, 0)) as totalValue,
            SUM(COALESCE((SELECT COALESCE(SUM(amount + COALESCE(fees, 0)), 0)
               FROM transactions
              WHERE investment_id = i.id AND transaction_type IN (${DASHBOARD_RETURNS_INVESTED_TYPES_SQL})), 0)) as totalInvested,
            SUM(COALESCE((SELECT COALESCE(SUM(amount - COALESCE(fees, 0)), 0)
               FROM transactions
                 WHERE investment_id = i.id AND (
                   (i.asset_type IN (${INTERNAL_BALANCE_ASSET_TYPES_SQL}) AND transaction_type IN (${COST_BASIS_RECEIVED_TYPES_NO_INTEREST_SQL}))
                   OR
                   (i.asset_type NOT IN (${INTERNAL_BALANCE_ASSET_TYPES_SQL}) AND transaction_type IN (${COST_BASIS_RECEIVED_TYPES_SQL}))
                 )), 0)) as totalRealizedGain,
            SUM(
              COALESCE(la.current_value, 0)
              + COALESCE((SELECT COALESCE(SUM(amount - COALESCE(fees, 0)), 0)
                   FROM transactions
                     WHERE investment_id = i.id AND (
                       (i.asset_type IN (${INTERNAL_BALANCE_ASSET_TYPES_SQL}) AND transaction_type IN (${COST_BASIS_RECEIVED_TYPES_NO_INTEREST_SQL}))
                       OR
                       (i.asset_type NOT IN (${INTERNAL_BALANCE_ASSET_TYPES_SQL}) AND transaction_type IN (${COST_BASIS_RECEIVED_TYPES_SQL}))
                     )), 0)
              - COALESCE((SELECT COALESCE(SUM(amount + COALESCE(fees, 0)), 0)
                   FROM transactions
                    WHERE investment_id = i.id AND transaction_type IN (${DASHBOARD_RETURNS_INVESTED_TYPES_SQL})), 0)
            ) as totalProfitLoss
          FROM investments i
          LEFT JOIN latest_agg la ON la.investment_id = i.id
          WHERE i.exclude_from_tracking = 0${totalsSoldFilter}
          GROUP BY i.asset_type
        `).all(...totalsSoldParams);

    const byTypeTotalsMap = new Map(byTypeTotals.map((row) => [row.asset_type, row]));

    // Group visible rows by asset type while assigning totals from the configured return scope.
    const byType = {};
    for (const inv of investments) {
      if (!byType[inv.asset_type]) {
        const totals = byTypeTotalsMap.get(inv.asset_type);
        byType[inv.asset_type] = {
          investments: [],
          totalValue: Number(totals?.totalValue) || 0,
          totalInvested: Number(totals?.totalInvested) || 0,
          totalProfitLoss: Number(totals?.totalProfitLoss) || 0,
          totalRealizedGain: Number(totals?.totalRealizedGain) || 0,
          dayChange: 0,
        };
      }
      byType[inv.asset_type].investments.push(inv);
      byType[inv.asset_type].dayChange += Number(inv.day_change) || 0;
    }

    const totalInvestedByScope = byTypeTotals.reduce((sum, row) => sum + (Number(row.totalInvested) || 0), 0);
    const totalProfitLossByScope = byTypeTotals.reduce((sum, row) => sum + (Number(row.totalProfitLoss) || 0), 0);
    const totalRealizedGainByScope = byTypeTotals.reduce((sum, row) => sum + (Number(row.totalRealizedGain) || 0), 0);

    const derivedPortfolio = {
      date: latestSnapshotDate || latest?.date || null,
      total_value: investments.reduce((sum, inv) => sum + (Number(inv.current_value) || 0), 0),
      total_invested: totalInvestedByScope,
      total_profit_loss: totalProfitLossByScope,
      total_realized_proceeds: totalRealizedGainByScope,
      day_change: investments.reduce((sum, inv) => sum + (Number(inv.day_change) || 0), 0),
    }
    derivedPortfolio.total_profit_loss_pct = derivedPortfolio.total_invested > 0
      ? (derivedPortfolio.total_profit_loss / derivedPortfolio.total_invested) * 100
      : 0;

    const previousPortfolioSnapshot = portfolio_id
      ? db.prepare(
          'SELECT total_value FROM portfolio_daily WHERE portfolio_id = ? AND date < ? ORDER BY date DESC LIMIT 1'
        ).get(portfolio_id, derivedPortfolio.date || '9999-12-31')
      : db.prepare(
          'SELECT SUM(total_value) as total_value FROM portfolio_daily WHERE date = (SELECT MAX(date) FROM portfolio_daily WHERE date < ?)'
        ).get(derivedPortfolio.date || '9999-12-31');
    const previousPortfolioValue = Number(previousPortfolioSnapshot?.total_value || 0);
    derivedPortfolio.day_change_pct = previousPortfolioValue > 0
      ? (derivedPortfolio.day_change / previousPortfolioValue) * 100
      : 0;

    // Calculate percentages of portfolio
    const totalValue = derivedPortfolio.total_value;
    for (const inv of investments) {
      inv.portfolio_pct = totalValue > 0 ? ((inv.current_value || 0) / totalValue) * 100 : 0;
    }

    // Get portfolio count info
    const portfolioCount = db.prepare('SELECT COUNT(*) as count FROM portfolios').get().count;

    // Get expense totals
    const expenseFilter = portfolio_id ? ' WHERE portfolio_id = ?' : '';
    const expenseParams = portfolio_id ? [portfolio_id] : [];
    const expenseTotals = db.prepare(
      `SELECT COALESCE(SUM(amount), 0) as total_expenses FROM portfolio_expenses${expenseFilter}`
    ).get(...expenseParams);

    const txnFilter = portfolio_id ? 'WHERE portfolio_id = ?' : '';
    const txnParams = portfolio_id ? [portfolio_id] : [];
    const transactionRows = db.prepare(`
      SELECT t.investment_id, t.transaction_type, t.transaction_date, COALESCE(t.amount, 0) as amount, COALESCE(t.fees, 0) as fees, i.asset_type
      FROM transactions t
      JOIN investments i ON i.id = t.investment_id
      ${portfolio_id ? 'WHERE t.portfolio_id = ?' : ''}
    `).all(...txnParams);

    const xirrCashflows = [];
    const xirrCashflowsByAssetType = new Map();
    const xirrCashflowsByInvestmentId = new Map();
    for (const txn of transactionRows) {
      const txnDate = new Date(txn.transaction_date);
      if (Number.isNaN(txnDate.getTime())) continue;

      const amount = Number(txn.amount) || 0;
      const fees = Number(txn.fees) || 0;
      let cashflow = 0;
      const treatAsInternal = isInternalXirrCashflow(txn.asset_type, txn.transaction_type);
      const assetTypeKey = String(txn.asset_type || '').toUpperCase();
      const investmentId = Number(txn.investment_id);

      if (!xirrCashflowsByAssetType.has(assetTypeKey)) {
        xirrCashflowsByAssetType.set(assetTypeKey, []);
      }
      if (!xirrCashflowsByInvestmentId.has(investmentId)) {
        xirrCashflowsByInvestmentId.set(investmentId, []);
      }

      if (CASH_OUTFLOW_TYPES.has(txn.transaction_type)) {
        cashflow = -(amount + fees);
      } else if (CASH_INFLOW_TYPES.has(txn.transaction_type) && !treatAsInternal) {
        cashflow = amount - fees;
      }

      if (Math.abs(cashflow) > 1e-9) {
        xirrCashflows.push({ amount: cashflow, date: txnDate });
        xirrCashflowsByAssetType.get(assetTypeKey).push({ amount: cashflow, date: txnDate });
        xirrCashflowsByInvestmentId.get(investmentId).push({ amount: cashflow, date: txnDate });
      }
    }

    const expenseRows = db.prepare(`
      SELECT expense_date, COALESCE(amount, 0) as amount
      FROM portfolio_expenses${expenseFilter}
    `).all(...expenseParams);

    for (const expense of expenseRows) {
      const expenseDate = new Date(expense.expense_date);
      if (Number.isNaN(expenseDate.getTime())) continue;

      const amount = Number(expense.amount) || 0;
      if (amount > 0) {
        xirrCashflows.push({ amount: -amount, date: expenseDate });
      }
    }

    const terminalValue = Number(derivedPortfolio.total_value) || 0;
    if (terminalValue > 0 && derivedPortfolio.date) {
      const valuationDate = new Date(derivedPortfolio.date);
      if (!Number.isNaN(valuationDate.getTime())) {
        xirrCashflows.push({ amount: terminalValue, date: valuationDate });
      }
    }

    if (xirrMode === 'full') {
      for (const inv of investments) {
        const investmentFlows = [...(xirrCashflowsByInvestmentId.get(Number(inv.id)) || [])];
        const investmentTerminalValue = Number(inv.current_value) || 0;
        if (investmentTerminalValue > 0 && inv.date) {
          const investmentValuationDate = new Date(`${inv.date}T00:00:00.000Z`);
          if (!Number.isNaN(investmentValuationDate.getTime())) {
            investmentFlows.push({ amount: investmentTerminalValue, date: investmentValuationDate });
          }
        }

        const investmentXirrRate = calculateXirr(investmentFlows);
        inv.xirr_pct = investmentXirrRate == null ? null : investmentXirrRate * 100;
      }

      for (const [assetTypeKey, info] of Object.entries(byType)) {
        const latestAssetDate = info.investments.reduce((maxDate, inv) => {
          if (!inv.date) return maxDate;
          return !maxDate || inv.date > maxDate ? inv.date : maxDate;
        }, null);

        const assetFlows = [...(xirrCashflowsByAssetType.get(assetTypeKey) || [])];
        const assetTerminalValue = Number(info.totalValue) || 0;
        if (assetTerminalValue > 0 && latestAssetDate) {
          const assetValuationDate = new Date(`${latestAssetDate}T00:00:00.000Z`);
          if (!Number.isNaN(assetValuationDate.getTime())) {
            assetFlows.push({ amount: assetTerminalValue, date: assetValuationDate });
          }
        }

        const assetXirrRate = calculateXirr(assetFlows);
        info.xirrPct = assetXirrRate == null ? null : assetXirrRate * 100;
      }
    } else {
      for (const inv of investments) {
        inv.xirr_pct = null;
      }
      for (const info of Object.values(byType)) {
        info.xirrPct = null;
      }
    }

    const xirrRate = calculateXirr(xirrCashflows);
    const xirrPct = xirrRate == null ? null : xirrRate * 100;
    const portfolioSummary = {
      ...latest,
      ...derivedPortfolio,
      xirr_pct: xirrPct,
    };

    res.json({
      portfolio: portfolioSummary,
      investments,
      byType,
      portfolioCount,
      totalExpenses: expenseTotals.total_expenses,
      xirrMode,
      lastUpdate: db.prepare("SELECT value FROM config WHERE key = 'last_price_update'").get()?.value,
      oneDayDebug: includeOneDayDebug
        ? {
            ...oneDayDebugSummary,
            marketHolidayCount: marketHolidaySet.size,
            totalInvestments: investments.length,
          }
        : undefined,
    });
  });

  // ─── Performance over time periods ─────────────────────────────────────
  router.get('/performance', (req, res) => {
    const { period, from, to, portfolio_id, asset_type } = req.query;
    let startDate, endDate;
    const now = new Date();
    endDate = now.toISOString().split('T')[0];

    if (from && to) {
      startDate = from;
      endDate = to;
    } else {
      switch (period) {
        case '1D': startDate = new Date(now - 1 * 86400000).toISOString().split('T')[0]; break;
        case '7D': startDate = new Date(now - 7 * 86400000).toISOString().split('T')[0]; break;
        case '1M': { const d = new Date(now); d.setMonth(d.getMonth() - 1); startDate = d.toISOString().split('T')[0]; break; }
        case '3M': { const d = new Date(now); d.setMonth(d.getMonth() - 3); startDate = d.toISOString().split('T')[0]; break; }
        case '6M': { const d = new Date(now); d.setMonth(d.getMonth() - 6); startDate = d.toISOString().split('T')[0]; break; }
        case '1Y': { const d = new Date(now); d.setFullYear(d.getFullYear() - 1); startDate = d.toISOString().split('T')[0]; break; }
        case '2Y': { const d = new Date(now); d.setFullYear(d.getFullYear() - 2); startDate = d.toISOString().split('T')[0]; break; }
        case '3Y': { const d = new Date(now); d.setFullYear(d.getFullYear() - 3); startDate = d.toISOString().split('T')[0]; break; }
        case '5Y': { const d = new Date(now); d.setFullYear(d.getFullYear() - 5); startDate = d.toISOString().split('T')[0]; break; }
        default: { const d = new Date(now); d.setMonth(d.getMonth() - 1); startDate = d.toISOString().split('T')[0]; }
      }
    }

    // Portfolio level performance — filtered by portfolio_id
    let portfolioData;
    if (portfolio_id) {
      portfolioData = db.prepare(`
        SELECT * FROM portfolio_daily
        WHERE portfolio_id = ? AND date BETWEEN ? AND ?
        ORDER BY date ASC
      `).all(portfolio_id, startDate, endDate);
    } else {
      portfolioData = db.prepare(`
        SELECT
          MAX(date) as date,
          SUM(total_value) as total_value,
          SUM(total_invested) as total_invested,
          SUM(total_profit_loss) as total_profit_loss,
          CASE WHEN SUM(total_invested) > 0 THEN (SUM(total_profit_loss) / SUM(total_invested)) * 100 ELSE 0 END as total_profit_loss_pct,
          SUM(day_change) as day_change,
          0 as day_change_pct
        FROM portfolio_daily
        WHERE date BETWEEN ? AND ?
        GROUP BY date
        ORDER BY date ASC
      `).all(startDate, endDate);
    }

    // Per-investment performance (portfolio-scoped daily_values)
    if (portfolio_id) {
      var investmentData = db.prepare(`
        SELECT
          dv.id,
          dv.investment_id,
          dv.portfolio_id,
          dv.date,
          dv.price_per_unit,
          dv.total_units,
          dv.current_value,
          dv.invested_amount,
          dv.realized_proceeds,
          dv.profit_loss,
          CASE WHEN COALESCE(dv.invested_amount, 0) > 0 THEN (COALESCE(dv.profit_loss, 0) / COALESCE(dv.invested_amount, 0)) * 100 ELSE 0 END as profit_loss_pct,
          dv.price_source,
          dv.day_change,
          CASE WHEN (COALESCE(dv.current_value, 0) - COALESCE(dv.day_change, 0)) > 0 THEN (COALESCE(dv.day_change, 0) / (COALESCE(dv.current_value, 0) - COALESCE(dv.day_change, 0))) * 100 ELSE 0 END as day_change_pct,
          dv.updated_at,
          COALESCE(i.display_name, i.name) as name,
          i.asset_type
        FROM daily_values dv
        JOIN investments i ON dv.investment_id = i.id
        WHERE dv.date BETWEEN ? AND ? AND dv.portfolio_id = ? AND EXISTS (SELECT 1 FROM transactions t WHERE t.investment_id = i.id AND t.portfolio_id = ?)
        ORDER BY dv.date ASC, i.name ASC
      `).all(startDate, endDate, portfolio_id, portfolio_id);
    } else {
      var investmentData = db.prepare(`
        SELECT
          i.id as investment_id,
          dv.date,
          MAX(dv.price_per_unit) as price_per_unit,
          SUM(dv.total_units) as total_units,
          SUM(dv.current_value) as current_value,
          SUM(dv.invested_amount) as invested_amount,
          SUM(dv.realized_proceeds) as realized_proceeds,
          SUM(dv.profit_loss) as profit_loss,
          CASE WHEN SUM(dv.invested_amount) > 0 THEN (SUM(dv.profit_loss) / SUM(dv.invested_amount)) * 100 ELSE 0 END as profit_loss_pct,
          MAX(dv.price_source) as price_source,
          SUM(dv.day_change) as day_change,
          0 as day_change_pct,
          COALESCE(i.display_name, i.name) as name,
          i.asset_type
        FROM daily_values dv
        JOIN investments i ON dv.investment_id = i.id
        WHERE dv.date BETWEEN ? AND ?
        GROUP BY i.id, dv.date
        ORDER BY dv.date ASC, i.name ASC
      `).all(startDate, endDate);
    }

    const typeFilterClause = asset_type ? 'AND asset_type = ?' : '';
    if (portfolio_id) {
      var typeRows = db.prepare(`
        SELECT *
        FROM asset_type_daily
        WHERE date BETWEEN ? AND ? AND portfolio_id = ? ${typeFilterClause}
        ORDER BY date ASC, asset_type ASC
      `).all(startDate, endDate, portfolio_id, ...(asset_type ? [asset_type] : []));
    } else {
      var typeRows = db.prepare(`
        SELECT
          asset_type,
          date,
          SUM(total_value) as total_value,
          SUM(total_invested) as total_invested,
          SUM(total_profit_loss) as total_profit_loss,
          SUM(total_realized_proceeds) as total_realized_proceeds,
          SUM(total_unrealized_gain) as total_unrealized_gain,
          CASE WHEN SUM(total_invested) > 0 THEN (SUM(total_profit_loss) / SUM(total_invested)) * 100 ELSE 0 END as total_profit_loss_pct,
          SUM(day_change) as day_change,
          0 as day_change_pct
        FROM asset_type_daily
        WHERE date BETWEEN ? AND ? ${typeFilterClause}
        GROUP BY asset_type, date
        ORDER BY date ASC, asset_type ASC
      `).all(startDate, endDate, ...(asset_type ? [asset_type] : []));
    }

    const performanceByAssetType = {};
    for (const row of typeRows) {
      if (!performanceByAssetType[row.asset_type]) {
        performanceByAssetType[row.asset_type] = {
          asset_type: row.asset_type,
          dailyData: [],
        };
      }
      performanceByAssetType[row.asset_type].dailyData.push(row);
    }

    // Calculate period returns
    const startSnapshot = portfolioData[0];
    const endSnapshot = portfolioData[portfolioData.length - 1];
    let periodReturn = 0;
    let periodReturnPct = 0;

    if (startSnapshot && endSnapshot) {
      periodReturn = endSnapshot.total_value - startSnapshot.total_value;
      periodReturnPct = startSnapshot.total_value > 0
        ? (periodReturn / startSnapshot.total_value) * 100 : 0;
    }

    res.json({
      period: period || 'custom',
      startDate,
      endDate,
      portfolioData,
      investmentData,
      performanceByAssetType,
      periodReturn: Math.round(periodReturn * 100) / 100,
      periodReturnPct: Math.round(periodReturnPct * 100) / 100,
    });
  });

  // ─── Asset-type performance time series ──────────────────────────────
  router.get('/performance-by-type', (req, res) => {
    const { asset_type, period, from, to, portfolio_id } = req.query;
    if (!asset_type) {
      return res.status(400).json({ error: 'asset_type is required' });
    }

    let startDate;
    let endDate;
    const now = new Date();
    endDate = now.toISOString().split('T')[0];

    if (from && to) {
      startDate = from;
      endDate = to;
    } else {
      switch (period) {
        case '1D': startDate = new Date(now - 1 * 86400000).toISOString().split('T')[0]; break;
        case '7D': startDate = new Date(now - 7 * 86400000).toISOString().split('T')[0]; break;
        case '1M': { const d = new Date(now); d.setMonth(d.getMonth() - 1); startDate = d.toISOString().split('T')[0]; break; }
        case '3M': { const d = new Date(now); d.setMonth(d.getMonth() - 3); startDate = d.toISOString().split('T')[0]; break; }
        case '6M': { const d = new Date(now); d.setMonth(d.getMonth() - 6); startDate = d.toISOString().split('T')[0]; break; }
        case '1Y': { const d = new Date(now); d.setFullYear(d.getFullYear() - 1); startDate = d.toISOString().split('T')[0]; break; }
        case '2Y': { const d = new Date(now); d.setFullYear(d.getFullYear() - 2); startDate = d.toISOString().split('T')[0]; break; }
        case '3Y': { const d = new Date(now); d.setFullYear(d.getFullYear() - 3); startDate = d.toISOString().split('T')[0]; break; }
        case '5Y': { const d = new Date(now); d.setFullYear(d.getFullYear() - 5); startDate = d.toISOString().split('T')[0]; break; }
        default: { const d = new Date(now); d.setMonth(d.getMonth() - 1); startDate = d.toISOString().split('T')[0]; }
      }
    }

    const rows = db.prepare(`
      ${portfolio_id
        ? `SELECT *
           FROM asset_type_daily
           WHERE asset_type = ?
             AND portfolio_id = ?
             AND date BETWEEN ? AND ?
           ORDER BY date ASC`
        : `SELECT
             asset_type,
             date,
             SUM(total_value) as total_value,
             SUM(total_invested) as total_invested,
             SUM(total_profit_loss) as total_profit_loss,
             SUM(total_realized_proceeds) as total_realized_proceeds,
             SUM(total_unrealized_gain) as total_unrealized_gain,
             CASE WHEN SUM(total_invested) > 0 THEN (SUM(total_profit_loss) / SUM(total_invested)) * 100 ELSE 0 END as total_profit_loss_pct,
             SUM(day_change) as day_change,
             0 as day_change_pct
           FROM asset_type_daily
           WHERE asset_type = ?
             AND date BETWEEN ? AND ?
           GROUP BY asset_type, date
           ORDER BY date ASC`}
    `).all(...(portfolio_id ? [asset_type, portfolio_id, startDate, endDate] : [asset_type, startDate, endDate]));

    return res.json({
      asset_type,
      period: period || 'custom',
      startDate,
      endDate,
      data: rows,
    });
  });

  // ─── Individual investment performance ────────────────────────────────
  router.get('/performance/:investmentId', (req, res) => {
    const { period, portfolio_id } = req.query;
    const now = new Date();
    let startDate;

    switch (period) {
      case '1D': startDate = new Date(now - 2 * 86400000).toISOString().split('T')[0]; break;
      case '7D': startDate = new Date(now - 7 * 86400000).toISOString().split('T')[0]; break;
      case '1M': { const d = new Date(now); d.setMonth(d.getMonth() - 1); startDate = d.toISOString().split('T')[0]; break; }
      case '3M': { const d = new Date(now); d.setMonth(d.getMonth() - 3); startDate = d.toISOString().split('T')[0]; break; }
      case '6M': { const d = new Date(now); d.setMonth(d.getMonth() - 6); startDate = d.toISOString().split('T')[0]; break; }
      case '1Y': { const d = new Date(now); d.setFullYear(d.getFullYear() - 1); startDate = d.toISOString().split('T')[0]; break; }
      case '3Y': { const d = new Date(now); d.setFullYear(d.getFullYear() - 3); startDate = d.toISOString().split('T')[0]; break; }
      case '5Y': { const d = new Date(now); d.setFullYear(d.getFullYear() - 5); startDate = d.toISOString().split('T')[0]; break; }
      default: { const d = new Date(now); d.setFullYear(d.getFullYear() - 1); startDate = d.toISOString().split('T')[0]; }
    }

    const data = portfolio_id
      ? db.prepare(`
          SELECT
            id,
            investment_id,
            portfolio_id,
            date,
            price_per_unit,
            total_units,
            current_value,
            invested_amount,
            realized_proceeds,
            profit_loss,
            CASE WHEN invested_amount > 0 THEN (profit_loss / invested_amount) * 100 ELSE 0 END as profit_loss_pct,
            price_source,
            day_change,
            CASE WHEN (current_value - day_change) > 0 THEN (day_change / (current_value - day_change)) * 100 ELSE 0 END as day_change_pct,
            updated_at
          FROM daily_values
          WHERE investment_id = ? AND portfolio_id = ? AND date >= ?
          ORDER BY date ASC
        `).all(req.params.investmentId, portfolio_id, startDate)
      : db.prepare(`
          SELECT
            investment_id,
            date,
            MAX(price_per_unit) as price_per_unit,
            SUM(total_units) as total_units,
            SUM(current_value) as current_value,
            SUM(invested_amount) as invested_amount,
            SUM(realized_proceeds) as realized_proceeds,
            SUM(profit_loss) as profit_loss,
            CASE WHEN SUM(invested_amount) > 0 THEN (SUM(profit_loss) / SUM(invested_amount)) * 100 ELSE 0 END as profit_loss_pct,
            MAX(price_source) as price_source,
            SUM(day_change) as day_change,
            0 as day_change_pct
          FROM daily_values
          WHERE investment_id = ? AND date >= ?
          GROUP BY investment_id, date
          ORDER BY date ASC
        `).all(req.params.investmentId, startDate);

    res.json(data);
  });

  // ─── Asset allocation breakdown ───────────────────────────────────────
  router.get('/allocation', (req, res) => {
    const { portfolio_id } = req.query;
    const portfolioFilter = portfolio_id ? ' AND EXISTS (SELECT 1 FROM transactions t WHERE t.investment_id = i.id AND t.portfolio_id = ?)' : '';
    const pfParams = portfolio_id ? [portfolio_id] : [];
    const allocation = portfolio_id
      ? db.prepare(`
          SELECT
            i.asset_type,
            COUNT(*) as count,
            COALESCE(SUM(dv.current_value), 0) as total_value,
            COALESCE(SUM(dv.invested_amount), 0) as total_invested,
            COALESCE(SUM(dv.profit_loss), 0) as total_profit_loss
          FROM investments i
          LEFT JOIN daily_values dv ON i.id = dv.investment_id
            AND dv.portfolio_id = ?
            AND dv.date = (SELECT MAX(date) FROM daily_values WHERE investment_id = i.id AND portfolio_id = ?)
          WHERE 1=1${portfolioFilter}
          GROUP BY i.asset_type
        `).all(portfolio_id, portfolio_id, ...pfParams)
      : db.prepare(`
          WITH latest_by_scope AS (
            SELECT investment_id, portfolio_id, MAX(date) AS max_date
            FROM daily_values
            GROUP BY investment_id, portfolio_id
          ),
          latest_agg AS (
            SELECT
              dv.investment_id,
              SUM(COALESCE(dv.current_value, 0)) AS current_value,
              SUM(COALESCE(dv.invested_amount, 0)) AS invested_amount,
              SUM(COALESCE(dv.profit_loss, 0)) AS profit_loss
            FROM daily_values dv
            INNER JOIN latest_by_scope lbs ON dv.investment_id = lbs.investment_id
              AND dv.portfolio_id = lbs.portfolio_id
              AND dv.date = lbs.max_date
            GROUP BY dv.investment_id
          )
          SELECT
            i.asset_type,
            COUNT(*) as count,
            COALESCE(SUM(la.current_value), 0) as total_value,
            COALESCE(SUM(la.invested_amount), 0) as total_invested,
            COALESCE(SUM(la.profit_loss), 0) as total_profit_loss
          FROM investments i
          LEFT JOIN latest_agg la ON la.investment_id = i.id
          WHERE 1=1${portfolioFilter}
          GROUP BY i.asset_type
        `).all(...pfParams);

    res.json(allocation);
  });

  return router;
};
