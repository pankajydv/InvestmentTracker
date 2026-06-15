const express = require('express');
const router = express.Router();
const { getMarketSessionDates } = require('../services/marketPriceCache');
const { calculateIntervalXIRR } = require('../services/xirrCalculator');
const { logAppWarn } = require('../services/appLogger');
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
const MARKET_LINKED_DAY_CHANGE_ASSET_TYPES = new Set([
  'INDIAN_STOCK',
  'FOREIGN_STOCK',
  'SGB',
  'MUTUAL_FUND',
  'NPS',
]);
const MAX_NON_LOCF_SESSION_LAG = 4;

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

function isAccrualOnlyXirrCashflow(transactionType, notes) {
  const normalizedType = String(transactionType || '').toUpperCase();
  if (normalizedType !== 'INTEREST') return false;
  const noteText = String(notes || '').toUpperCase();
  return noteText.includes('AUTO_ACCRUAL_INTERNAL') || noteText.includes('ACCRUAL_ONLY_INTERNAL');
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

function isNonLocfSource(row) {
  if (!row) return false;
  if (row.has_non_locf != null) return Number(row.has_non_locf) > 0;
  return String(row.price_source || '').toUpperCase() !== 'LOCF';
}

function sessionDistance(candidateDate, targetDate, assetType) {
  if (!candidateDate || !targetDate) return Number.POSITIVE_INFINITY;
  if (candidateDate > targetDate) return Number.POSITIVE_INFINITY;

  const start = new Date(`${candidateDate}T00:00:00.000Z`);
  if (!Number.isFinite(start.getTime())) return Number.POSITIVE_INFINITY;
  start.setUTCDate(start.getUTCDate() + 1);
  const strictStart = start.toISOString().slice(0, 10);

  if (strictStart > targetDate) return 0;
  const sessions = getMarketSessionDates(strictStart, targetDate, assetType);
  if (!Array.isArray(sessions) || sessions.length === 0) return 0;
  return sessions.length;
}

function resolveDisplayDayChangeFromRows(rowsDesc, assetType) {
  const latestRow = Array.isArray(rowsDesc) && rowsDesc.length ? rowsDesc[0] : null;
  if (!latestRow) {
    return {
      dayChange: 0,
      asOfDate: null,
      usedFallback: false,
      staleFallback: false,
    };
  }

  const normalizedType = String(assetType || '').toUpperCase();
  if (!MARKET_LINKED_DAY_CHANGE_ASSET_TYPES.has(normalizedType)) {
    return {
      dayChange: Number(latestRow.day_change || 0),
      asOfDate: latestRow.date || null,
      usedFallback: false,
      staleFallback: false,
    };
  }

  if (isNonLocfSource(latestRow)) {
    return {
      dayChange: Number(latestRow.day_change || 0),
      asOfDate: latestRow.date || null,
      usedFallback: false,
      staleFallback: false,
    };
  }

  for (let idx = 1; idx < rowsDesc.length; idx += 1) {
    const candidate = rowsDesc[idx];
    if (!isNonLocfSource(candidate)) continue;
    const lag = sessionDistance(candidate.date, latestRow.date, normalizedType);
    if (lag <= MAX_NON_LOCF_SESSION_LAG) {
      return {
        dayChange: Number(candidate.day_change || 0),
        asOfDate: candidate.date || null,
        usedFallback: true,
        staleFallback: false,
      };
    }
    break;
  }

  return {
    dayChange: 0,
    asOfDate: null,
    usedFallback: true,
    staleFallback: true,
  };
}

function assignDisplayDayChangeForSeries(rows) {
  const byInvestment = new Map();
  for (const row of rows || []) {
    const key = Number(row.investment_id);
    if (!byInvestment.has(key)) byInvestment.set(key, []);
    byInvestment.get(key).push(row);
  }

  for (const groupRows of byInvestment.values()) {
    groupRows.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    for (let i = 0; i < groupRows.length; i += 1) {
      const target = groupRows[i];
      const contextRows = groupRows.slice(i);
      const resolved = resolveDisplayDayChangeFromRows(contextRows, target.asset_type);
      target.day_change = Number(resolved.dayChange || 0);
      target.day_change_as_of_date = resolved.asOfDate || null;
      target.day_change_uses_fallback = !!resolved.usedFallback;
      target.day_change_fallback_stale = !!resolved.staleFallback;
      const prevValue = Number(target.current_value || 0) - Number(target.day_change || 0);
      target.day_change_pct = prevValue > 0
        ? (Number(target.day_change || 0) / prevValue) * 100
        : 0;
    }
  }

  return rows;
}

function summarizeAsOfDates(items, selector) {
  const nonEmpty = (items || [])
    .map((item) => selector(item))
    .filter(Boolean);
  const unique = [...new Set(nonEmpty)];
  if (!unique.length) return { asOfDate: null, mixed: false };
  if (unique.length === 1) return { asOfDate: unique[0], mixed: false };
  return { asOfDate: null, mixed: true };
}

function getClockInTimeZone(timeZone, now = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(now);
  const values = {};
  for (const part of parts) {
    if (!part?.type || part.type === 'literal') continue;
    values[part.type] = part.value;
  }

  const date = `${values.year}-${values.month}-${values.day}`;
  const hour = Number(values.hour || 0);
  const minute = Number(values.minute || 0);
  return {
    date,
    minutes: (hour * 60) + minute,
  };
}

function isClockWithinSession(minutes, openMinutes, closeMinutes) {
  return Number.isFinite(minutes) && minutes >= openMinutes && minutes <= closeMinutes;
}

function getDashboardMarketState(now = new Date()) {
  const indiaClock = getClockInTimeZone('Asia/Kolkata', now);
  const usClock = getClockInTimeZone('America/New_York', now);

  const indiaSessionDay = getMarketSessionDates(indiaClock.date, indiaClock.date, 'INDIAN_STOCK').length > 0;
  const usSessionDay = getMarketSessionDates(usClock.date, usClock.date, 'FOREIGN_STOCK').length > 0;

  const indiaOpen = indiaSessionDay && isClockWithinSession(indiaClock.minutes, (9 * 60) + 15, (15 * 60) + 30);
  const usOpen = usSessionDay && isClockWithinSession(usClock.minutes, (9 * 60) + 30, (16 * 60));

  return {
    india: {
      timeZone: 'Asia/Kolkata',
      sessionDate: indiaClock.date,
      isSessionDay: indiaSessionDay,
      isOpen: indiaOpen,
      sessionHours: '09:15-15:30',
    },
    us: {
      timeZone: 'America/New_York',
      sessionDate: usClock.date,
      isSessionDay: usSessionDay,
      isOpen: usOpen,
      sessionHours: '09:30-16:00',
    },
  };
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

    // Check if prices are stale (today's data missing from aggregates)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = today.toISOString().split('T')[0];
    
    const latestAggregateDate = db.prepare(`
      SELECT MAX(date) AS max_date FROM portfolio_daily WHERE portfolio_id IS NOT NULL
    `).get()?.max_date;

    let stalePricesWarning = null;
    if (!latestAggregateDate || latestAggregateDate < todayStr) {
      stalePricesWarning = {
        code: 'STALE_PRICES',
        severity: 'warning',
        latestDate: latestAggregateDate,
        expectedDate: todayStr,
        message: 'Data is outdated. Please click "Update Prices" to refresh today\'s information.',
      };
    }

    // Parse interval params for XIRR calculation
    const intervalParam = String(req.query.interval || '1D').trim().toUpperCase();
    let intervalFromDate = null;
    let intervalToDate = null;

    // Find latest available date in database instead of using "today"
    const latestDateInDb = db.prepare(`
      SELECT MAX(date) AS max_date FROM portfolio_daily WHERE portfolio_id IS NOT NULL
    `).get()?.max_date;

    if (req.query.custom_from_date && req.query.custom_to_date) {
      // Custom date range
      intervalFromDate = String(req.query.custom_from_date).trim();
      intervalToDate = String(req.query.custom_to_date).trim();
    } else if (latestDateInDb) {
      // Preset intervals: calculate backwards from latest available date
      const toDate = new Date(latestDateInDb);
      intervalToDate = latestDateInDb;

      const d = new Date(latestDateInDb);
      switch (intervalParam) {
        case '1D':
          d.setDate(d.getDate() - 1);
          intervalFromDate = d.toISOString().split('T')[0];
          break;
        case '2D':
          d.setDate(d.getDate() - 2);
          intervalFromDate = d.toISOString().split('T')[0];
          break;
        case '1W':
          d.setDate(d.getDate() - 7);
          intervalFromDate = d.toISOString().split('T')[0];
          break;
        case '1M':
          d.setMonth(d.getMonth() - 1);
          intervalFromDate = d.toISOString().split('T')[0];
          break;
        case '3M':
          d.setMonth(d.getMonth() - 3);
          intervalFromDate = d.toISOString().split('T')[0];
          break;
        case '6M':
          d.setMonth(d.getMonth() - 6);
          intervalFromDate = d.toISOString().split('T')[0];
          break;
        case '1Y':
          d.setFullYear(d.getFullYear() - 1);
          intervalFromDate = d.toISOString().split('T')[0];
          break;
        case '2Y':
          d.setFullYear(d.getFullYear() - 2);
          intervalFromDate = d.toISOString().split('T')[0];
          break;
        case '3Y':
          d.setFullYear(d.getFullYear() - 3);
          intervalFromDate = d.toISOString().split('T')[0];
          break;
        case '5Y':
          d.setFullYear(d.getFullYear() - 5);
          intervalFromDate = d.toISOString().split('T')[0];
          break;
        case '7Y':
          d.setFullYear(d.getFullYear() - 7);
          intervalFromDate = d.toISOString().split('T')[0];
          break;
        case '10Y':
          d.setFullYear(d.getFullYear() - 10);
          intervalFromDate = d.toISOString().split('T')[0];
          break;
        default:
          // Default to 1D
          d.setDate(d.getDate() - 1);
          intervalFromDate = d.toISOString().split('T')[0];
      }
    } else {
      // No data available, set dummy dates
      intervalFromDate = '2000-01-01';
      intervalToDate = '2000-01-01';
    }

    // Calculate XIRR for the interval
    let intervalXIRR = null;
    try {
      const xirrResult = calculateIntervalXIRR(
        db,
        portfolio_id ? Number(portfolio_id) : null,
        intervalFromDate,
        intervalToDate
      );
      intervalXIRR = {
        xirr_pct: xirrResult.xirr_pct,
        interval_change: xirrResult.interval_change,
        interval_change_pct: xirrResult.interval_change_pct,
        opening_value: xirrResult.opening_value,
        closing_value: xirrResult.closing_value,
        confidence: xirrResult.confidence,
        error: xirrResult.error,
        requested_from_date: xirrResult.requested_from_date || intervalFromDate,
        requested_to_date: xirrResult.requested_to_date || intervalToDate,
        from_date: xirrResult.from_date || intervalFromDate,
        to_date: xirrResult.to_date || intervalToDate,
      };
    } catch (err) {
      intervalXIRR = {
        xirr_pct: null,
        interval_change: 0,
        interval_change_pct: 0,
        opening_value: 0,
        closing_value: 0,
        confidence: 'error',
        error: err.message,
        from_date: intervalFromDate,
        to_date: intervalToDate,
      };
    }

    // For preset 1D, align the card to strict day_change (not value-delta interval math).
    const isPresetOneDay = !req.query.custom_from_date && !req.query.custom_to_date && intervalParam === '1D';
    const marketState = getDashboardMarketState(new Date());
    let oneDayCardSource = 'not_applicable';
    let oneDayCardSourceReason = 'interval_not_1d';

    if (isPresetOneDay) {
      const anyTrackedMarketOpen = marketState.india.isOpen || marketState.us.isOpen;
      oneDayCardSource = anyTrackedMarketOpen ? 'top_card' : 'table_derived';
      oneDayCardSourceReason = anyTrackedMarketOpen ? 'market_open' : 'all_markets_closed';
    }

    if (isPresetOneDay && intervalToDate) {
      if (portfolio_id) {
        const latestOneDay = db.prepare(`
          SELECT total_value, day_change
          FROM portfolio_daily
          WHERE portfolio_id = ? AND date = ?
          LIMIT 1
        `).get(portfolio_id, intervalToDate);

        const previousOneDay = db.prepare(`
          SELECT total_value
          FROM portfolio_daily
          WHERE portfolio_id = ? AND date < ?
          ORDER BY date DESC
          LIMIT 1
        `).get(portfolio_id, intervalToDate);

        const prevTotal = Number(previousOneDay?.total_value || 0);
        const dayChange = Number(latestOneDay?.day_change || 0);
        const latestTotal = Number(latestOneDay?.total_value || 0);

        intervalXIRR = {
          ...intervalXIRR,
          interval_change: dayChange,
          interval_change_pct: prevTotal > 0 ? (dayChange / prevTotal) * 100 : 0,
          opening_value: prevTotal,
          closing_value: latestTotal,
          from_date: intervalToDate,
          to_date: intervalToDate,
        };
      } else {
        const latestOneDay = db.prepare(`
          SELECT
            SUM(COALESCE(total_value, 0)) AS total_value,
            SUM(COALESCE(day_change, 0)) AS day_change
          FROM portfolio_daily
          WHERE portfolio_id IS NOT NULL AND date = ?
        `).get(intervalToDate);

        const previousDate = db.prepare(`
          SELECT MAX(date) AS prev_date
          FROM portfolio_daily
          WHERE portfolio_id IS NOT NULL AND date < ?
        `).get(intervalToDate)?.prev_date || null;

        const previousOneDay = previousDate
          ? db.prepare(`
              SELECT SUM(COALESCE(total_value, 0)) AS total_value
              FROM portfolio_daily
              WHERE portfolio_id IS NOT NULL AND date = ?
            `).get(previousDate)
          : null;

        const prevTotal = Number(previousOneDay?.total_value || 0);
        const dayChange = Number(latestOneDay?.day_change || 0);
        const latestTotal = Number(latestOneDay?.total_value || 0);

        intervalXIRR = {
          ...intervalXIRR,
          interval_change: dayChange,
          interval_change_pct: prevTotal > 0 ? (dayChange / prevTotal) * 100 : 0,
          opening_value: prevTotal,
          closing_value: latestTotal,
          from_date: intervalToDate,
          to_date: intervalToDate,
        };
      }
    }

    // Get strict latest rollup snapshot for top-level 1-day change.
    let latest;
    let rollupWarning = null;
    if (portfolio_id) {
      latest = db.prepare(
        'SELECT * FROM portfolio_daily WHERE portfolio_id = ? ORDER BY date DESC LIMIT 1'
      ).get(portfolio_id);

      const previous = latest?.date
        ? db.prepare('SELECT total_value FROM portfolio_daily WHERE portfolio_id = ? AND date < ? ORDER BY date DESC LIMIT 1').get(portfolio_id, latest.date)
        : null;
      const prevTotal = Number(previous?.total_value || 0);
      latest = {
        ...(latest || {}),
        day_change_pct: prevTotal > 0
          ? (Number(latest?.day_change || 0) / prevTotal) * 100
          : 0,
      };
    } else {
      const maxRollupDate = db.prepare(`
        SELECT MAX(date) AS max_date
        FROM portfolio_daily
        WHERE portfolio_id IS NOT NULL
      `).get()?.max_date || null;

      if (maxRollupDate) {
        const portfoliosTotal = Number(db.prepare('SELECT COUNT(*) AS count FROM portfolios').get()?.count || 0);
        const portfoliosCovered = Number(db.prepare(`
          SELECT COUNT(DISTINCT portfolio_id) AS count
          FROM portfolio_daily
          WHERE portfolio_id IS NOT NULL AND date = ?
        `).get(maxRollupDate)?.count || 0);

        if (portfoliosCovered < portfoliosTotal) {
          rollupWarning = {
            code: 'PORTFOLIO_ROLLUP_DATE_MISMATCH',
            severity: 'warning',
            maxDate: maxRollupDate,
            portfoliosCovered,
            portfoliosTotal,
            missingPortfolioCount: Math.max(portfoliosTotal - portfoliosCovered, 0),
            message: 'Portfolio rollup rows are not aligned on a single latest date.',
          };
        }

        const latestAgg = db.prepare(`
          SELECT
            ? AS date,
            SUM(total_value) as total_value,
            SUM(total_invested) as total_invested,
            SUM(total_profit_loss) as total_profit_loss,
            CASE WHEN SUM(total_invested) > 0 THEN (SUM(total_profit_loss) / SUM(total_invested)) * 100 ELSE 0 END as total_profit_loss_pct,
            SUM(day_change) as day_change
          FROM portfolio_daily
          WHERE portfolio_id IS NOT NULL AND date = ?
        `).get(maxRollupDate, maxRollupDate);

        const previousDate = db.prepare(`
          SELECT MAX(date) AS prev_date
          FROM portfolio_daily
          WHERE portfolio_id IS NOT NULL AND date < ?
        `).get(maxRollupDate)?.prev_date || null;

        const previousTotal = previousDate
          ? Number(db.prepare(`
              SELECT SUM(total_value) AS total_value
              FROM portfolio_daily
              WHERE portfolio_id IS NOT NULL AND date = ?
            `).get(previousDate)?.total_value || 0)
          : 0;

        latest = {
          ...(latestAgg || {}),
          day_change_pct: previousTotal > 0
            ? (Number(latestAgg?.day_change || 0) / previousTotal) * 100
            : 0,
        };
      } else {
        latest = {
          date: null,
          total_value: 0,
          total_invested: 0,
          total_profit_loss: 0,
          total_profit_loss_pct: 0,
          day_change: 0,
          day_change_pct: 0,
        };
      }
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
            dv.total_units,
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
            CASE WHEN UPPER(COALESCE(dv.price_source, '')) <> 'LOCF' THEN 1 ELSE 0 END AS has_non_locf,
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
            SUM(COALESCE(dv.total_units, 0)) AS total_units,
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
            MAX(CASE WHEN UPPER(COALESCE(dv.price_source, '')) <> 'LOCF' THEN 1 ELSE 0 END) AS has_non_locf,
            ROW_NUMBER() OVER (PARTITION BY dv.investment_id ORDER BY dv.date DESC) as row_num
          FROM daily_values dv
          WHERE dv.investment_id IN (SELECT id FROM investments WHERE exclude_from_tracking = 0)
          GROUP BY dv.investment_id, dv.date
        `).all();

    // Create lookup map for latest daily values for current request scope
    const latestDvByInvestment = new Map();
    const dvRowsByInvestment = new Map();
    for (const dv of allDailyValuesRaw) {
      const key = `${dv.investment_id}_${portfolio_id || 'null'}`;
      if (!dvRowsByInvestment.has(key)) dvRowsByInvestment.set(key, []);
      dvRowsByInvestment.get(key).push(dv);
      if (dv.row_num === 1) {
        latestDvByInvestment.set(key, dv);
      }
    }
    for (const rows of dvRowsByInvestment.values()) {
      rows.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
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

    const oneDayDebugSummary = null;

    // Phase 3: Use pre-fetched daily values - no more per-investment queries
    for (const inv of investments) {
      // Fully sold investments should not influence current 1-day change cards,
      // even when they are shown in tables. Keep internal balance products exempt.
      const totalUnits = Number(inv.total_units) || 0;
      const isInternalBalanceAsset = INTERNAL_BALANCE_DAY_CHANGE_ASSET_TYPES.has(String(inv.asset_type || '').toUpperCase());
      const isNonHeldPosition = !isInternalBalanceAsset && Math.abs(totalUnits) <= 0.001;
      if (isNonHeldPosition) {
        inv.day_change = 0;
        inv.day_change_pct = 0;
        continue;
      }

      const dvKey = `${inv.id}_${portfolio_id || 'null'}`;
      const latestRow = latestDvByInvestment.get(dvKey);
      const rowsDesc = dvRowsByInvestment.get(dvKey) || [];

      if (!latestRow) {
        inv.day_change = 0;
        inv.day_change_pct = 0;
        inv.day_change_as_of_date = null;
        inv.day_change_uses_fallback = false;
        continue;
      }

      const dayChangeResolved = resolveDisplayDayChangeFromRows(rowsDesc, inv.asset_type);

      inv.day_change = Number(dayChangeResolved.dayChange || 0);
      inv.day_change_pct = latestRow.current_value > 0
        ? (inv.day_change / latestRow.current_value) * 100
        : 0;
      inv.day_change_as_of_date = dayChangeResolved.asOfDate || null;
      inv.day_change_uses_fallback = !!dayChangeResolved.usedFallback;
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
    if (isPresetOneDay && latestSnapshotDate) {
      for (const inv of investments) {
        if (!inv.date || inv.date >= latestSnapshotDate) continue;

        const normalizedType = String(inv.asset_type || '').toUpperCase();
        const isLaggedMarketLinked = MARKET_LINKED_DAY_CHANGE_ASSET_TYPES.has(normalizedType)
          && sessionDistance(inv.date, latestSnapshotDate, normalizedType) <= MAX_NON_LOCF_SESSION_LAG;
        if (isLaggedMarketLinked) continue;

        inv.day_change = 0;
        inv.day_change_pct = 0;
        inv.day_change_as_of_date = null;
        inv.day_change_uses_fallback = false;
      }
    }

    // Non-1D intervals: replace per-investment 1-day values with interval-scoped sums.
    if (!isPresetOneDay && intervalFromDate && intervalToDate) {
      const findBoundsForInvestment = portfolio_id
        ? db.prepare(`
            SELECT
              MIN(date) AS chosen_from,
              MAX(date) AS chosen_to
            FROM daily_values
            WHERE investment_id = ?
              AND portfolio_id = ?
              AND date >= ?
              AND date <= ?
          `)
        : db.prepare(`
            SELECT
              MIN(date) AS chosen_from,
              MAX(date) AS chosen_to
            FROM daily_values
            WHERE investment_id = ?
              AND portfolio_id IS NOT NULL
              AND date >= ?
              AND date <= ?
          `);

      const sumIntervalDayChangeForInvestment = portfolio_id
        ? db.prepare(`
            SELECT COALESCE(SUM(day_change), 0) AS interval_day_change
            FROM daily_values
            WHERE investment_id = ?
              AND portfolio_id = ?
              AND date >= ?
              AND date <= ?
          `)
        : db.prepare(`
            SELECT COALESCE(SUM(day_change), 0) AS interval_day_change
            FROM daily_values
            WHERE investment_id = ?
              AND portfolio_id IS NOT NULL
              AND date >= ?
              AND date <= ?
          `);

      const openingValueForInvestment = portfolio_id
        ? db.prepare(`
            SELECT COALESCE(current_value, 0) AS current_value
            FROM daily_values
            WHERE investment_id = ?
              AND portfolio_id = ?
              AND date = ?
            LIMIT 1
          `)
        : db.prepare(`
            SELECT COALESCE(SUM(current_value), 0) AS current_value
            FROM daily_values
            WHERE investment_id = ?
              AND portfolio_id IS NOT NULL
              AND date = ?
          `);

      for (const inv of investments) {
        const bounds = portfolio_id
          ? findBoundsForInvestment.get(inv.id, portfolio_id, intervalFromDate, intervalToDate)
          : findBoundsForInvestment.get(inv.id, intervalFromDate, intervalToDate);

        const chosenFrom = bounds?.chosen_from || null;
        const chosenTo = bounds?.chosen_to || null;
        if (!chosenFrom || !chosenTo || chosenFrom > chosenTo) {
          inv.day_change = 0;
          inv.day_change_pct = 0;
          inv.day_change_as_of_date = null;
          inv.day_change_uses_fallback = false;
          inv.interval_from_date = null;
          inv.interval_to_date = null;
          continue;
        }

        const intervalDayChange = portfolio_id
          ? Number(sumIntervalDayChangeForInvestment.get(inv.id, portfolio_id, chosenFrom, chosenTo)?.interval_day_change || 0)
          : Number(sumIntervalDayChangeForInvestment.get(inv.id, chosenFrom, chosenTo)?.interval_day_change || 0);

        const openingValue = portfolio_id
          ? Number(openingValueForInvestment.get(inv.id, portfolio_id, chosenFrom)?.current_value || 0)
          : Number(openingValueForInvestment.get(inv.id, chosenFrom)?.current_value || 0);

        inv.day_change = intervalDayChange;
        inv.day_change_pct = openingValue > 0 ? (intervalDayChange / openingValue) * 100 : 0;
        inv.day_change_as_of_date = chosenTo;
        inv.day_change_uses_fallback = false;
        inv.interval_from_date = chosenFrom;
        inv.interval_to_date = chosenTo;
      }
    }

    if (isPresetOneDay && oneDayCardSource === 'table_derived') {
      const tableClosingValue = investments.reduce((sum, inv) => sum + (Number(inv.current_value) || 0), 0);
      const tableIntervalChange = investments.reduce((sum, inv) => sum + (Number(inv.day_change) || 0), 0);
      const tableOpeningValue = tableClosingValue - tableIntervalChange;
      const tableAsOfDate = latestSnapshotDate || intervalToDate || null;

      intervalXIRR = {
        ...intervalXIRR,
        interval_change: tableIntervalChange,
        interval_change_pct: tableOpeningValue > 0 ? (tableIntervalChange / tableOpeningValue) * 100 : 0,
        opening_value: tableOpeningValue,
        closing_value: tableClosingValue,
        from_date: tableAsOfDate,
        to_date: tableAsOfDate,
      };
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
        const emptyAsOfSummary = summarizeAsOfDates([], () => null);
        byType[inv.asset_type] = {
          investments: [],
          totalValue: Number(totals?.totalValue) || 0,
          totalInvested: Number(totals?.totalInvested) || 0,
          totalProfitLoss: Number(totals?.totalProfitLoss) || 0,
          totalRealizedGain: Number(totals?.totalRealizedGain) || 0,
          dayChange: 0,
          dayChangeAsOfDate: emptyAsOfSummary.asOfDate,
          dayChangeAsOfMixed: emptyAsOfSummary.mixed,
          dayChangeFallbackCount: 0,
        };
      }
      byType[inv.asset_type].investments.push(inv);
      byType[inv.asset_type].dayChange += Number(inv.day_change) || 0;
      if (inv.day_change_uses_fallback) {
        byType[inv.asset_type].dayChangeFallbackCount += 1;
      }
    }

    for (const info of Object.values(byType)) {
      const asOfSummary = summarizeAsOfDates(info.investments, (inv) => inv.day_change_as_of_date || null);
      info.dayChangeAsOfDate = asOfSummary.asOfDate;
      info.dayChangeAsOfMixed = asOfSummary.mixed;
      info.intervalChangePct = null;
      info.intervalFromDate = null;
      info.intervalToDate = null;
    }

    // Non-1D: compute asset-type interval change from asset_type_daily using strict in-range bounds.
    if (!isPresetOneDay && intervalFromDate && intervalToDate) {
      const findBoundsForType = portfolio_id
        ? db.prepare(`
            SELECT
              MIN(date) AS chosen_from,
              MAX(date) AS chosen_to
            FROM asset_type_daily
            WHERE portfolio_id = ?
              AND asset_type = ?
              AND date >= ?
              AND date <= ?
          `)
        : db.prepare(`
            SELECT
              MIN(date) AS chosen_from,
              MAX(date) AS chosen_to
            FROM asset_type_daily
            WHERE portfolio_id IS NOT NULL
              AND asset_type = ?
              AND date >= ?
              AND date <= ?
          `);

      const sumIntervalDayChangeForType = portfolio_id
        ? db.prepare(`
            SELECT COALESCE(SUM(day_change), 0) AS interval_day_change
            FROM asset_type_daily
            WHERE portfolio_id = ?
              AND asset_type = ?
              AND date >= ?
              AND date <= ?
          `)
        : db.prepare(`
            SELECT COALESCE(SUM(day_change), 0) AS interval_day_change
            FROM asset_type_daily
            WHERE portfolio_id IS NOT NULL
              AND asset_type = ?
              AND date >= ?
              AND date <= ?
          `);

      const openingValueForType = portfolio_id
        ? db.prepare(`
            SELECT COALESCE(total_value, 0) AS total_value
            FROM asset_type_daily
            WHERE portfolio_id = ?
              AND asset_type = ?
              AND date = ?
            LIMIT 1
          `)
        : db.prepare(`
            SELECT COALESCE(SUM(total_value), 0) AS total_value
            FROM asset_type_daily
            WHERE portfolio_id IS NOT NULL
              AND asset_type = ?
              AND date = ?
          `);

      const closingValueForType = portfolio_id
        ? db.prepare(`
            SELECT COALESCE(total_value, 0) AS total_value
            FROM asset_type_daily
            WHERE portfolio_id = ?
              AND asset_type = ?
              AND date = ?
            LIMIT 1
          `)
        : db.prepare(`
            SELECT COALESCE(SUM(total_value), 0) AS total_value
            FROM asset_type_daily
            WHERE portfolio_id IS NOT NULL
              AND asset_type = ?
              AND date = ?
          `);

      const netFlowForType = portfolio_id
        ? db.prepare(`
            SELECT COALESCE(SUM(CASE
              WHEN t.transaction_type IN ('BUY', 'DEPOSIT', 'IPO', 'RIGHTS', 'TRANSFER_IN', 'SWITCH_IN', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'ESPP_CONTRIBUTION') THEN COALESCE(t.amount, 0)
              WHEN t.transaction_type IN ('SELL', 'REDEMPTION', 'WITHDRAWAL', 'TRANSFER_OUT', 'SWITCH_OUT', 'CHARGES', 'AMC') THEN -COALESCE(t.amount, 0)
              WHEN t.transaction_type = 'TDS' THEN -ABS(COALESCE(t.amount, 0))
              ELSE 0
            END), 0) AS net_flow
            FROM transactions t
            JOIN investments i ON i.id = t.investment_id
            WHERE t.portfolio_id = ?
              AND i.asset_type = ?
              AND DATE(t.transaction_date) >= ?
              AND DATE(t.transaction_date) <= ?
          `)
        : db.prepare(`
            SELECT COALESCE(SUM(CASE
              WHEN t.transaction_type IN ('BUY', 'DEPOSIT', 'IPO', 'RIGHTS', 'TRANSFER_IN', 'SWITCH_IN', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'ESPP_CONTRIBUTION') THEN COALESCE(t.amount, 0)
              WHEN t.transaction_type IN ('SELL', 'REDEMPTION', 'WITHDRAWAL', 'TRANSFER_OUT', 'SWITCH_OUT', 'CHARGES', 'AMC') THEN -COALESCE(t.amount, 0)
              WHEN t.transaction_type = 'TDS' THEN -ABS(COALESCE(t.amount, 0))
              ELSE 0
            END), 0) AS net_flow
            FROM transactions t
            JOIN investments i ON i.id = t.investment_id
            WHERE t.portfolio_id IS NOT NULL
              AND i.asset_type = ?
              AND DATE(t.transaction_date) >= ?
              AND DATE(t.transaction_date) <= ?
          `);

      for (const [assetTypeKey, info] of Object.entries(byType)) {
        const bounds = portfolio_id
          ? findBoundsForType.get(portfolio_id, assetTypeKey, intervalFromDate, intervalToDate)
          : findBoundsForType.get(assetTypeKey, intervalFromDate, intervalToDate);

        const chosenFrom = bounds?.chosen_from || null;
        const chosenTo = bounds?.chosen_to || null;
        if (!chosenFrom || !chosenTo || chosenFrom > chosenTo) {
          info.dayChange = 0;
          info.intervalChangePct = 0;
          info.intervalFromDate = null;
          info.intervalToDate = null;
          continue;
        }

        const intervalDayChange = portfolio_id
          ? Number(sumIntervalDayChangeForType.get(portfolio_id, assetTypeKey, chosenFrom, chosenTo)?.interval_day_change || 0)
          : Number(sumIntervalDayChangeForType.get(assetTypeKey, chosenFrom, chosenTo)?.interval_day_change || 0);

        const openingValue = portfolio_id
          ? Number(openingValueForType.get(portfolio_id, assetTypeKey, chosenFrom)?.total_value || 0)
          : Number(openingValueForType.get(assetTypeKey, chosenFrom)?.total_value || 0);

        const closingValue = portfolio_id
          ? Number(closingValueForType.get(portfolio_id, assetTypeKey, chosenTo)?.total_value || 0)
          : Number(closingValueForType.get(assetTypeKey, chosenTo)?.total_value || 0);

        const netFlow = portfolio_id
          ? Number(netFlowForType.get(portfolio_id, assetTypeKey, chosenFrom, chosenTo)?.net_flow || 0)
          : Number(netFlowForType.get(assetTypeKey, chosenFrom, chosenTo)?.net_flow || 0);

        info.dayChange = intervalDayChange;
        info.intervalChangePct = openingValue > 0 ? (intervalDayChange / openingValue) * 100 : 0;
        info.intervalFromDate = chosenFrom;
        info.intervalToDate = chosenTo;

        const snapshotDerivedIntervalChange = closingValue - openingValue - netFlow;
        const deviationAbs = Math.abs(intervalDayChange - snapshotDerivedIntervalChange);
        const deviationThreshold = Math.max(1, Math.abs(intervalDayChange) * 0.0025);
        if (deviationAbs > deviationThreshold) {
          logAppWarn('[Interval][AssetType] day_change and snapshot-flow interval deviation', {
            portfolio_id: portfolio_id ? Number(portfolio_id) : null,
            asset_type: assetTypeKey,
            requested_from_date: intervalFromDate,
            requested_to_date: intervalToDate,
            chosen_from_date: chosenFrom,
            chosen_to_date: chosenTo,
            opening_value: openingValue,
            closing_value: closingValue,
            net_external_cashflows: netFlow,
            interval_change_from_day_change: intervalDayChange,
            interval_change_from_snapshot_flow: snapshotDerivedIntervalChange,
            deviation_abs: deviationAbs,
            deviation_threshold: deviationThreshold,
          });
        }
      }
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
      day_change: Number(latest?.day_change || 0),
    };
    derivedPortfolio.day_change_as_of_date = null;
    derivedPortfolio.day_change_as_of_mixed = false;
    derivedPortfolio.total_profit_loss_pct = derivedPortfolio.total_invested > 0
      ? (derivedPortfolio.total_profit_loss / derivedPortfolio.total_invested) * 100
      : 0;

    derivedPortfolio.day_change_pct = Number(latest?.day_change_pct || 0);

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
      SELECT t.investment_id, t.transaction_type, t.transaction_date, COALESCE(t.amount, 0) as amount, COALESCE(t.fees, 0) as fees, t.notes, i.asset_type
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
      const treatAsAccrualOnly = isAccrualOnlyXirrCashflow(txn.transaction_type, txn.notes);
      const assetTypeKey = String(txn.asset_type || '').toUpperCase();
      const investmentId = Number(txn.investment_id);

      if (!xirrCashflowsByAssetType.has(assetTypeKey)) {
        xirrCashflowsByAssetType.set(assetTypeKey, []);
      }
      if (!xirrCashflowsByInvestmentId.has(investmentId)) {
        xirrCashflowsByInvestmentId.set(investmentId, []);
      }

      if (treatAsAccrualOnly) {
        cashflow = 0;
      } else if (CASH_OUTFLOW_TYPES.has(txn.transaction_type)) {
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

    const intervalMeta = {
      selectedInterval: intervalParam,
      isPresetOneDay,
      oneDayCardSource,
      oneDayCardSourceReason,
      marketState,
    };

    res.json({
      portfolio: portfolioSummary,
      investments,
      byType,
      portfolioCount,
      totalExpenses: expenseTotals.total_expenses,
      rollupWarning,
      stalePricesWarning,
      xirrMode,
      intervalXIRR,
      intervalMeta,
      lastUpdate: db.prepare("SELECT value FROM config WHERE key = 'last_price_update'").get()?.value,
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

    assignDisplayDayChangeForSeries(investmentData);

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

    const portfolioDayChangeByDate = new Map();
    const typeDayChangeByKey = new Map();
    for (const row of investmentData) {
      const dateKey = String(row.date || '');
      const assetKey = String(row.asset_type || '');
      portfolioDayChangeByDate.set(
        dateKey,
        (Number(portfolioDayChangeByDate.get(dateKey) || 0) + Number(row.day_change || 0))
      );
      const typeMapKey = `${dateKey}::${assetKey}`;
      typeDayChangeByKey.set(
        typeMapKey,
        (Number(typeDayChangeByKey.get(typeMapKey) || 0) + Number(row.day_change || 0))
      );
    }

    portfolioData = portfolioData.map((row) => {
      const adjustedDayChange = Number(portfolioDayChangeByDate.get(String(row.date || '')) || 0);
      const prevValue = Number(row.total_value || 0) - adjustedDayChange;
      return {
        ...row,
        day_change: adjustedDayChange,
        day_change_pct: prevValue > 0 ? (adjustedDayChange / prevValue) * 100 : 0,
      };
    });

    typeRows = typeRows.map((row) => {
      const mapKey = `${String(row.date || '')}::${String(row.asset_type || '')}`;
      const adjustedDayChange = Number(typeDayChangeByKey.get(mapKey) || 0);
      const prevValue = Number(row.total_value || 0) - adjustedDayChange;
      return {
        ...row,
        day_change: adjustedDayChange,
        day_change_pct: prevValue > 0 ? (adjustedDayChange / prevValue) * 100 : 0,
      };
    });

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

    const typeInvestmentRows = portfolio_id
      ? db.prepare(`
          SELECT
            dv.investment_id,
            dv.date,
            dv.current_value,
            dv.day_change,
            dv.price_source,
            i.asset_type
          FROM daily_values dv
          JOIN investments i ON i.id = dv.investment_id
          WHERE i.asset_type = ?
            AND dv.portfolio_id = ?
            AND dv.date BETWEEN ? AND ?
          ORDER BY dv.date ASC
        `).all(asset_type, portfolio_id, startDate, endDate)
      : db.prepare(`
          SELECT
            dv.investment_id,
            dv.date,
            SUM(COALESCE(dv.current_value, 0)) AS current_value,
            SUM(COALESCE(dv.day_change, 0)) AS day_change,
            MAX(dv.price_source) AS price_source,
            i.asset_type,
            MAX(CASE WHEN UPPER(COALESCE(dv.price_source, '')) <> 'LOCF' THEN 1 ELSE 0 END) AS has_non_locf
          FROM daily_values dv
          JOIN investments i ON i.id = dv.investment_id
          WHERE i.asset_type = ?
            AND dv.date BETWEEN ? AND ?
          GROUP BY dv.investment_id, dv.date, i.asset_type
          ORDER BY dv.date ASC
        `).all(asset_type, startDate, endDate);

    assignDisplayDayChangeForSeries(typeInvestmentRows);
    const adjustedDayChangeByDate = new Map();
    for (const row of typeInvestmentRows) {
      const dateKey = String(row.date || '');
      adjustedDayChangeByDate.set(
        dateKey,
        (Number(adjustedDayChangeByDate.get(dateKey) || 0) + Number(row.day_change || 0))
      );
    }

    const adjustedRows = rows.map((row) => {
      const adjustedDayChange = Number(adjustedDayChangeByDate.get(String(row.date || '')) || 0);
      const prevValue = Number(row.total_value || 0) - adjustedDayChange;
      return {
        ...row,
        day_change: adjustedDayChange,
        day_change_pct: prevValue > 0 ? (adjustedDayChange / prevValue) * 100 : 0,
      };
    });

    return res.json({
      asset_type,
      period: period || 'custom',
      startDate,
      endDate,
      data: adjustedRows,
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

    const investmentMeta = db.prepare('SELECT asset_type FROM investments WHERE id = ?').get(req.params.investmentId) || {};
    const normalizedAssetType = String(investmentMeta.asset_type || '').toUpperCase();
    const seriesRows = (data || []).map((row) => ({
      ...row,
      asset_type: normalizedAssetType,
    }));
    assignDisplayDayChangeForSeries(seriesRows);

    res.json(seriesRows.map((row) => {
      const { asset_type: _assetType, ...rest } = row;
      return rest;
    }));
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
