const express = require('express');
const router = express.Router();
const { getMarketSessionDates } = require('../services/marketPriceCache');
const { calculateIntervalXIRR } = require('../services/xirrCalculator');
const { getCachedXirr, generateCacheKey } = require('../services/xirrCacheService');
const {
  isSnapshotEnabled,
  ensureDashboardSnapshotTable,
  getDataVersion,
  buildSnapshotKey,
  getCachedSnapshot,
  putSnapshot,
} = require('../services/dashboardSnapshotService');
const { DAY_CHANGE_FALLBACK_MAX_LAG_SESSIONS } = require('../services/freshnessPolicy');
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
const MAX_NON_LOCF_SESSION_LAG = DAY_CHANGE_FALLBACK_MAX_LAG_SESSIONS;

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

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function addDaysIso(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime())) return isoDate;
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return date.toISOString().slice(0, 10);
}

function addYearsIso(isoDate, years) {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime())) return isoDate;
  date.setUTCFullYear(date.getUTCFullYear() + Number(years || 0));
  return date.toISOString().slice(0, 10);
}

function getTrailingYearStartIso(isoDate) {
  return addDaysIso(addYearsIso(isoDate, -1), 1);
}

function parseDateOnly(value) {
  if (!value) return null;
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime())) return null;
  return text;
}

function parsePortfolioIds(query) {
  const raw = query?.portfolio_ids ?? query?.portfolio_id;
  if (raw == null || raw === '') return [];

  const ids = String(raw)
    .split(',')
    .map((part) => Number(String(part).trim()))
    .filter((value) => Number.isInteger(value) && value > 0);

  const uniqueIds = [...new Set(ids)];
  if (!uniqueIds.length) {
    throw new Error('Invalid portfolio id');
  }
  return uniqueIds;
}

function resolveAggregatedSource(row) {
  if (!row) return '-';
  const sourceCount = Number(row.source_count || 0);
  if (sourceCount <= 0) return '-';
  if (sourceCount === 1) return row.min_source || '-';
  return 'MIXED';
}

// Build a portfolio-scope SQL predicate that works for a single portfolio, an arbitrary
// subset, or "all". `ids` is an array of positive integers; an empty array means "all
// portfolios" (portfolio_id IS NOT NULL), matching the historical single/all branches.
function portfolioScopeClause(column, ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    return { clause: `${column} IS NOT NULL`, params: [] };
  }
  const placeholders = ids.map(() => '?').join(', ');
  return { clause: `${column} IN (${placeholders})`, params: [...ids] };
}

// Resolve the [from, to] window for a preset/custom interval from the latest snapshot date.
// Mirrors the /summary handler's date math so subset requests land on identical bounds.
function resolveIntervalWindow(latestDateInDb, intervalParam, customFromDate, customToDate) {
  if (customFromDate && customToDate) {
    return { intervalFromDate: String(customFromDate).trim(), intervalToDate: String(customToDate).trim() };
  }
  if (!latestDateInDb) {
    return { intervalFromDate: '2000-01-01', intervalToDate: '2000-01-01' };
  }
  let intervalFromDate = null;
  let intervalToDate = latestDateInDb;
  const d = new Date(latestDateInDb);
  switch (String(intervalParam || '1D').toUpperCase()) {
    case '1D': d.setDate(d.getDate() - 1); intervalFromDate = d.toISOString().split('T')[0]; break;
    case 'YD': {
      const yTo = new Date(latestDateInDb); yTo.setDate(yTo.getDate() - 1);
      intervalToDate = yTo.toISOString().split('T')[0];
      const yFrom = new Date(intervalToDate); yFrom.setDate(yFrom.getDate() - 1);
      intervalFromDate = yFrom.toISOString().split('T')[0];
      break;
    }
    case '2D': d.setDate(d.getDate() - 2); intervalFromDate = d.toISOString().split('T')[0]; break;
    case '1W': d.setDate(d.getDate() - 7); intervalFromDate = d.toISOString().split('T')[0]; break;
    case '1M': d.setMonth(d.getMonth() - 1); intervalFromDate = d.toISOString().split('T')[0]; break;
    case '3M': d.setMonth(d.getMonth() - 3); intervalFromDate = d.toISOString().split('T')[0]; break;
    case '6M': d.setMonth(d.getMonth() - 6); intervalFromDate = d.toISOString().split('T')[0]; break;
    case '1Y': d.setFullYear(d.getFullYear() - 1); intervalFromDate = d.toISOString().split('T')[0]; break;
    case '2Y': d.setFullYear(d.getFullYear() - 2); intervalFromDate = d.toISOString().split('T')[0]; break;
    case '3Y': d.setFullYear(d.getFullYear() - 3); intervalFromDate = d.toISOString().split('T')[0]; break;
    case '5Y': d.setFullYear(d.getFullYear() - 5); intervalFromDate = d.toISOString().split('T')[0]; break;
    case '7Y': d.setFullYear(d.getFullYear() - 7); intervalFromDate = d.toISOString().split('T')[0]; break;
    case '10Y': d.setFullYear(d.getFullYear() - 10); intervalFromDate = d.toISOString().split('T')[0]; break;
    default: d.setDate(d.getDate() - 1); intervalFromDate = d.toISOString().split('T')[0];
  }
  return { intervalFromDate, intervalToDate };
}

// Money-weighted, non-1D interval change per asset type plus the portfolio-level interval
// XIRR, computed for an arbitrary portfolio scope. This is the single source of truth shared
// by the /summary handler and the /asset-interval-metrics endpoint so single, subset, and
// "all" scopes stay numerically identical (the % is a non-additive XIRR that cannot be
// reconstructed by averaging per-portfolio values — it must be solved over unioned cashflows).
//   scopeIds: [] => all portfolios; [id] => single; [id,...] => subset.
//   assetTypes: which asset types to emit (types with no in-range snapshots resolve to 0).
function computeScopeIntervalMetrics(db, { scopeIds = [], assetTypes = [], intervalFromDate, intervalToDate }) {
  const emptyResult = {
    byType: {},
    intervalXIRR: {
      interval_change: 0,
      xirr_pct: null,
      confidence: 'error',
      error: 'Interval bounds unavailable',
      from_date: intervalFromDate || null,
      to_date: intervalToDate || null,
    },
  };
  if (!intervalFromDate || !intervalToDate) return emptyResult;

  const dailyScope = portfolioScopeClause('portfolio_id', scopeIds);
  const txnScope = portfolioScopeClause('t.portfolio_id', scopeIds);

  const findBoundsForType = db.prepare(`
    SELECT MIN(date) AS chosen_from, MAX(date) AS chosen_to
    FROM asset_type_daily
    WHERE ${dailyScope.clause} AND asset_type = ? AND date >= ? AND date <= ?
  `);
  // asset_type_daily is unique per (portfolio_id, asset_type, date), so SUM(total_value)
  // equals the single row for one portfolio and the combined value for a subset/all.
  const valueForType = db.prepare(`
    SELECT COALESCE(SUM(total_value), 0) AS total_value
    FROM asset_type_daily
    WHERE ${dailyScope.clause} AND asset_type = ? AND date = ?
  `);
  const intervalTransactionsForType = db.prepare(`
    SELECT
      DATE(t.transaction_date) AS txn_date,
      t.transaction_type,
      COALESCE(t.amount, 0) AS amount,
      COALESCE(t.fees, 0) AS fees,
      t.notes
    FROM transactions t
    JOIN investments i ON i.id = t.investment_id
    WHERE ${txnScope.clause}
      AND i.asset_type = ?
      AND DATE(t.transaction_date) >= ?
      AND DATE(t.transaction_date) <= ?
    ORDER BY DATE(t.transaction_date)
  `);
  const firstActivityDateForType = db.prepare(`
    SELECT MIN(DATE(t.transaction_date)) AS first_date
    FROM transactions t
    JOIN investments i ON i.id = t.investment_id
    WHERE ${txnScope.clause} AND i.asset_type = ?
  `);

  const byType = {};
  const portfolioIntervalCashflows = [];

  for (const assetTypeKey of assetTypes) {
    // Default: no in-range snapshots -> zero interval movement for this type.
    byType[assetTypeKey] = {
      dayChange: 0,
      intervalChangePct: 0,
      intervalFromDate: null,
      intervalToDate: null,
    };

    const bounds = findBoundsForType.get(...dailyScope.params, assetTypeKey, intervalFromDate, intervalToDate);
    const chosenFrom = bounds?.chosen_from || null;
    const chosenTo = bounds?.chosen_to || null;
    if (!chosenFrom || !chosenTo || chosenFrom > chosenTo) continue;

    // Inception window: request reaches back to/before the position ever existed -> opening 0
    // and every contribution counts, collapsing the interval to lifetime P&L.
    const firstActivityDate = firstActivityDateForType.get(...txnScope.params, assetTypeKey)?.first_date || null;
    const isInceptionWindow = !!firstActivityDate && intervalFromDate <= firstActivityDate;

    const openingValue = isInceptionWindow
      ? 0
      : Number(valueForType.get(...dailyScope.params, assetTypeKey, chosenFrom)?.total_value || 0);
    const closingValue = Number(valueForType.get(...dailyScope.params, assetTypeKey, chosenTo)?.total_value || 0);

    const transactionsFromDate = isInceptionWindow ? intervalFromDate : chosenFrom;
    const intervalTransactions = intervalTransactionsForType.all(...txnScope.params, assetTypeKey, transactionsFromDate, chosenTo);

    const intervalCashflows = [];
    if (openingValue !== 0) {
      intervalCashflows.push({ amount: -openingValue, date: new Date(`${chosenFrom}T00:00:00.000Z`) });
    }
    for (const txn of intervalTransactions) {
      const amount = Number(txn.amount) || 0;
      const fees = Number(txn.fees) || 0;
      let cashflow = 0;
      const treatAsInternal = isInternalXirrCashflow(assetTypeKey, txn.transaction_type);
      const treatAsAccrualOnly = isAccrualOnlyXirrCashflow(txn.transaction_type, txn.notes);
      if (treatAsAccrualOnly) {
        cashflow = 0;
      } else if (CASH_OUTFLOW_TYPES.has(txn.transaction_type)) {
        cashflow = -(amount + fees);
      } else if (CASH_INFLOW_TYPES.has(txn.transaction_type) && !treatAsInternal) {
        cashflow = amount - fees;
      }
      if (Math.abs(cashflow) > 1e-9) {
        intervalCashflows.push({ amount: cashflow, date: new Date(`${txn.txn_date}T00:00:00.000Z`) });
      }
    }
    if (closingValue !== 0) {
      intervalCashflows.push({ amount: closingValue, date: new Date(`${chosenTo}T00:00:00.000Z`) });
    }

    portfolioIntervalCashflows.push(...intervalCashflows);

    const intervalXirrRate = calculateXirr(intervalCashflows);
    const intervalNetProfit = intervalCashflows.reduce((sum, flow) => sum + flow.amount, 0);

    byType[assetTypeKey] = {
      dayChange: intervalNetProfit,
      intervalChangePct: intervalXirrRate == null
        ? (openingValue > 0 ? (intervalNetProfit / openingValue) * 100 : 0)
        : intervalXirrRate * 100,
      intervalFromDate: chosenFrom,
      intervalToDate: chosenTo,
    };
  }

  const portfolioIntervalRate = calculateXirr(portfolioIntervalCashflows);
  const portfolioIntervalDayChange = Object.values(byType)
    .reduce((sum, info) => sum + (Number(info.dayChange) || 0), 0);

  return {
    byType,
    intervalXIRR: {
      interval_change: portfolioIntervalDayChange,
      xirr_pct: portfolioIntervalRate == null ? null : portfolioIntervalRate * 100,
      confidence: portfolioIntervalRate == null ? 'error' : 'full',
      error: portfolioIntervalRate == null
        ? 'Interval XIRR could not be solved for the combined cashflows'
        : null,
      from_date: intervalFromDate,
      to_date: intervalToDate,
    },
  };
}

module.exports = function (db) {

  try {
    ensureDashboardSnapshotTable(db);
  } catch (_e) {
    // fail open: snapshot reads/writes guard themselves individually
  }

  // ─── Portfolio Summary (Dashboard) ────────────────────────────────────
  router.get('/summary', (req, res) => {
    const { portfolio_id, hide_sold } = req.query;
    const includeSoldInReturnsRaw = String(req.query.include_sold_in_returns || '').trim().toLowerCase();
    const includeSoldInReturnsRequested = includeSoldInReturnsRaw === 'true' || includeSoldInReturnsRaw === '1' || includeSoldInReturnsRaw === 'yes';
    const hideSold = hide_sold === 'true';
    const includeSoldInReturns = hideSold ? includeSoldInReturnsRequested : true;
    const xirrModeRaw = String(req.query.xirr_mode || 'full').trim().toLowerCase();
    const xirrMode = xirrModeRaw === 'portfolio_only' ? 'portfolio_only' : 'full';

    // ── Snapshot read-through cache ────────────────────────────────────────
    // Serve a previously-built payload when it matches the current data version.
    // Any miss / version mismatch / error falls through to a live recompute.
    let snapshotKey = null;
    let snapshotVersion = null;
    if (isSnapshotEnabled()) {
      try {
        snapshotVersion = getDataVersion(db);
        snapshotKey = buildSnapshotKey({
          portfolioId: portfolio_id != null ? portfolio_id : null,
          hideSold,
          includeFullySoldInReturns: includeSoldInReturns,
          xirrMode,
          interval: String(req.query.interval || '1D').trim().toUpperCase(),
          customFromDate: req.query.custom_from_date || null,
          customToDate: req.query.custom_to_date || null,
        });
        if (snapshotKey) {
          const cachedPayload = getCachedSnapshot(db, snapshotKey, snapshotVersion);
          if (cachedPayload) {
            return res.json(cachedPayload);
          }
        }
      } catch (_e) {
        // Fail open: fall through to live computation.
        snapshotKey = null;
      }
    }

    // Check if prices are stale (today's data missing from aggregates)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = today.toISOString().split('T')[0];
    
    // Consolidate MAX(date) queries: fetch once and reuse
    const latestDateResult = db.prepare(`
      SELECT MAX(date) AS max_date FROM portfolio_daily WHERE portfolio_id IS NOT NULL
    `).get();
    const latestAggregateDate = latestDateResult?.max_date;
    const latestDateInDb = latestAggregateDate;

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
    // (reuse latestDateInDb from above - already fetched)

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
        case 'YD': {
          const yTo = new Date(latestDateInDb);
          yTo.setDate(yTo.getDate() - 1);
          intervalToDate = yTo.toISOString().split('T')[0];
          const yFrom = new Date(intervalToDate);
          yFrom.setDate(yFrom.getDate() - 1);
          intervalFromDate = yFrom.toISOString().split('T')[0];
          break;
        }
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
    
    // Try to use cached XIRR for preset intervals (1D, YD, 1W)
    if (!req.query.custom_from_date && !req.query.custom_to_date) {
      const cacheKey = generateCacheKey(portfolio_id ? Number(portfolio_id) : null, intervalParam);
      const cachedXirr = getCachedXirr(db, cacheKey);
      if (cachedXirr) {
        intervalXIRR = {
          xirr_pct: cachedXirr.xirr_pct,
          interval_change: cachedXirr.interval_change,
          interval_change_pct: cachedXirr.interval_change_pct,
          opening_value: cachedXirr.opening_value,
          closing_value: cachedXirr.closing_value,
          confidence: cachedXirr.confidence,
          error: null,
          requested_from_date: intervalFromDate,
          requested_to_date: intervalToDate,
          from_date: intervalFromDate,
          to_date: intervalToDate,
          cached_at: cachedXirr.cached_at,
        };
      }
    }
    
    // If no cache hit, calculate fresh XIRR
    if (!intervalXIRR) {
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
    }

    // For preset 1D/YD, align the card to strict day_change (not value-delta interval math).
    const isPresetOneDay = !req.query.custom_from_date && !req.query.custom_to_date && intervalParam === '1D';
    const isPresetYesterday = !req.query.custom_from_date && !req.query.custom_to_date && intervalParam === 'YD';
    const marketState = getDashboardMarketState(new Date());
    let oneDayCardSource = 'not_applicable';
    let oneDayCardSourceReason = 'interval_not_1d';

    if (isPresetOneDay) {
      // Keep 1D card semantics strict: always use rollup day_change for latest snapshot.
      oneDayCardSource = 'top_card';
      oneDayCardSourceReason = 'strict_rollup';
    }

    if ((isPresetOneDay || isPresetYesterday) && intervalToDate) {
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
        inv.day_change_opening_value = 0;
        inv.day_change_as_of_date = null;
        inv.day_change_uses_fallback = false;
        continue;
      }

      const scopedRows = isPresetYesterday && intervalToDate
        ? rowsDesc.filter((row) => row.date && row.date <= intervalToDate)
        : rowsDesc;
      const scopedLatestRow = scopedRows[0] || null;

      if (!scopedLatestRow) {
        inv.day_change = 0;
        inv.day_change_pct = 0;
        inv.day_change_opening_value = 0;
        inv.day_change_as_of_date = null;
        inv.day_change_uses_fallback = false;
        continue;
      }

      const dayChangeResolved = resolveDisplayDayChangeFromRows(scopedRows, inv.asset_type);

      inv.day_change = Number(dayChangeResolved.dayChange || 0);
      const prevValue = Number(scopedLatestRow.current_value || 0) - Number(inv.day_change || 0);
      inv.day_change_pct = prevValue > 0
        ? (inv.day_change / prevValue) * 100
        : 0;
      inv.day_change_opening_value = prevValue > 0 ? prevValue : 0;
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
    if (!isPresetOneDay && !isPresetYesterday && intervalFromDate && intervalToDate) {
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

    // Intentionally no table-derived overwrite for preset 1D.

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
          dayChangeOpeningValue: 0,
          dayChangeAsOfDate: emptyAsOfSummary.asOfDate,
          dayChangeAsOfMixed: emptyAsOfSummary.mixed,
          dayChangeFallbackCount: 0,
        };
      }
      byType[inv.asset_type].investments.push(inv);
      byType[inv.asset_type].dayChange += Number(inv.day_change) || 0;
      byType[inv.asset_type].dayChangeOpeningValue += Number(inv.day_change_opening_value) || 0;
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

    // 1D/Yesterday: compute intervalChangePct directly from accumulated dayChange vs totalValue.
    if (isPresetOneDay || isPresetYesterday) {
      for (const info of Object.values(byType)) {
        const prevValue = isPresetYesterday
          ? (Number(info.dayChangeOpeningValue) || 0)
          : ((Number(info.totalValue) || 0) - (Number(info.dayChange) || 0));
        info.intervalChangePct = prevValue > 0 ? ((Number(info.dayChange) || 0) / prevValue) * 100 : 0;
      }
    }

    // Non-1D: compute asset-type interval change from asset_type_daily using strict in-range
    // bounds. Delegated to the shared scope-aware helper (computeScopeIntervalMetrics) so the
    // single-portfolio, "all", and arbitrary-subset scopes are numerically identical — the % is
    // a non-additive XIRR that must be solved over unioned cashflows, not averaged.
    if (!isPresetOneDay && !isPresetYesterday && intervalFromDate && intervalToDate) {
      const metrics = computeScopeIntervalMetrics(db, {
        scopeIds: portfolio_id ? [Number(portfolio_id)] : [],
        assetTypes: Object.keys(byType),
        intervalFromDate,
        intervalToDate,
      });
      for (const [assetTypeKey, info] of Object.entries(byType)) {
        const m = metrics.byType[assetTypeKey];
        if (!m) continue;
        info.dayChange = m.dayChange;
        info.intervalChangePct = m.intervalChangePct;
        info.intervalFromDate = m.intervalFromDate;
        info.intervalToDate = m.intervalToDate;
      }
      intervalXIRR = { ...intervalXIRR, ...metrics.intervalXIRR };
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

    const responsePayload = {
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
      dataVersion: snapshotVersion != null ? snapshotVersion : getDataVersion(db),
    };

    // Store into the read-through cache under the version observed at request start.
    // If the version advanced mid-request, the next read simply misses and recomputes.
    if (isSnapshotEnabled() && snapshotKey && snapshotVersion != null) {
      putSnapshot(db, snapshotKey, snapshotVersion, responsePayload);
    }

    res.json(responsePayload);
  });

  // ─── Asset-type interval metrics for an arbitrary portfolio subset ─────
  // The /summary endpoint only understands a single portfolio or "all". For a genuine subset
  // (e.g. 2 of 3 portfolios) the client combines the additive fields locally but cannot rebuild
  // the non-additive interval XIRR / %. This endpoint computes those exactly for any scope using
  // the same shared engine as /summary, and is snapshot-cached + version-gated for speed.
  router.get('/asset-interval-metrics', (req, res) => {
    try {
      let scopeIds;
      try {
        scopeIds = parsePortfolioIds(req.query);
      } catch (_e) {
        return res.status(400).json({ error: 'Invalid portfolio id' });
      }

      const intervalParam = String(req.query.interval || '1D').trim().toUpperCase();
      const customFromDate = req.query.custom_from_date || null;
      const customToDate = req.query.custom_to_date || null;

      const latestDateInDb = db.prepare(`
        SELECT MAX(date) AS max_date FROM portfolio_daily WHERE portfolio_id IS NOT NULL
      `).get()?.max_date || null;
      const { intervalFromDate, intervalToDate } = resolveIntervalWindow(
        latestDateInDb, intervalParam, customFromDate, customToDate,
      );

      // Snapshot cache (version-gated). Skip ad-hoc custom ranges to bound the key space.
      const cacheKey = (customFromDate || customToDate)
        ? null
        : JSON.stringify({
            kind: 'interval-metrics',
            scope: scopeIds.length ? scopeIds.slice().sort((a, b) => a - b).join(',') : 'all',
            interval: intervalParam,
          });
      let version = null;
      if (isSnapshotEnabled() && cacheKey) {
        try {
          version = getDataVersion(db);
          const cached = getCachedSnapshot(db, cacheKey, version);
          if (cached) return res.json(cached);
        } catch (_e) {
          version = null;
        }
      }

      const dailyScope = portfolioScopeClause('portfolio_id', scopeIds);
      const assetTypes = db.prepare(`
        SELECT DISTINCT asset_type
        FROM asset_type_daily
        WHERE ${dailyScope.clause} AND date >= ? AND date <= ?
      `).all(...dailyScope.params, intervalFromDate, intervalToDate).map((r) => r.asset_type);

      const metrics = computeScopeIntervalMetrics(db, {
        scopeIds, assetTypes, intervalFromDate, intervalToDate,
      });
      const payload = { ...metrics, from_date: intervalFromDate, to_date: intervalToDate };

      if (isSnapshotEnabled() && cacheKey && version != null) {
        try { putSnapshot(db, cacheKey, version, payload); } catch (_e) { /* fail open */ }
      }

      return res.json(payload);
    } catch (e) {
      return res.status(500).json({ error: e.message || 'Failed to compute interval metrics' });
    }
  });

  // ─── Data version (lightweight cache-validation probe) ─────────────────
  router.get('/version', (req, res) => {
    res.json({
      dataVersion: getDataVersion(db),
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

  router.get('/rollover', (req, res) => {
    try {
      const portfolioIds = parsePortfolioIds(req.query);
      const assetType = String(req.query.asset_type || '').trim().toUpperCase() || null;
      const toDate = parseDateOnly(req.query.to) || todayIso();
      const fromDate = parseDateOnly(req.query.from) || getTrailingYearStartIso(toDate);

      if (fromDate > toDate) {
        return res.status(400).json({ error: 'from must be less than or equal to to' });
      }

      const pageRaw = Number(req.query.page);
      const page = Number.isFinite(pageRaw) && pageRaw > 0
        ? Math.floor(pageRaw)
        : 1;

      const pageSizeRaw = Number(req.query.page_size);
      const legacyLimitRaw = Number(req.query.limit);
      const pageSize = Number.isFinite(pageSizeRaw) && pageSizeRaw > 0
        ? Math.min(Math.floor(pageSizeRaw), 5000)
        : (Number.isFinite(legacyLimitRaw) && legacyLimitRaw > 0
          ? Math.min(Math.floor(legacyLimitRaw), 5000)
          : 366);

      const filters = [
        'dv.date >= ?',
        'dv.date <= ?',
        'i.exclude_from_tracking = 0',
      ];
      const params = [fromDate, toDate];

      if (assetType) {
        filters.push('i.asset_type = ?');
        params.push(assetType);
      }

      if (portfolioIds.length > 0) {
        filters.push(`dv.portfolio_id IN (${portfolioIds.map(() => '?').join(', ')})`);
        params.push(...portfolioIds);
      } else {
        filters.push('dv.portfolio_id IS NOT NULL');
      }

      const whereClause = filters.join(' AND ');
      const totalRows = Number(db.prepare(`
        SELECT COUNT(*) AS count
        FROM (
          SELECT dv.date
          FROM daily_values dv
          JOIN investments i ON i.id = dv.investment_id
          WHERE ${whereClause}
          GROUP BY dv.date
        ) grouped_dates
      `).get(...params)?.count || 0);

      const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
      const currentPage = Math.min(page, totalPages);
      const offset = (currentPage - 1) * pageSize;

      const rows = db.prepare(`
        SELECT
          dv.date,
          SUM(COALESCE(dv.current_value, 0)) AS current_value,
          SUM(COALESCE(dv.invested_amount, 0)) AS invested_amount,
          SUM(COALESCE(dv.realized_proceeds, 0)) AS realized_proceeds,
          SUM(COALESCE(dv.profit_loss, 0)) AS profit_loss,
          SUM(COALESCE(dv.day_change, 0)) AS day_change,
          COUNT(*) AS contributing_rows,
          COUNT(DISTINCT dv.portfolio_id) AS contributing_portfolios,
          COUNT(DISTINCT COALESCE(dv.price_source, 'UNKNOWN')) AS source_count,
          MIN(COALESCE(dv.price_source, 'UNKNOWN')) AS min_source
        FROM daily_values dv
        JOIN investments i ON i.id = dv.investment_id
        WHERE ${whereClause}
        GROUP BY dv.date
        ORDER BY dv.date DESC
        LIMIT ? OFFSET ?
      `).all(...params, pageSize, offset);

      const bounds = db.prepare(`
        SELECT
          MAX(dv.date) AS latest_row_date,
          MIN(dv.date) AS oldest_row_date
        FROM daily_values dv
        JOIN investments i ON i.id = dv.investment_id
        WHERE ${whereClause}
      `).get(...params) || {};

      const normalizedRows = rows.map((row) => {
        const currentValue = Number(row.current_value) || 0;
        const dayChange = Number(row.day_change) || 0;
        const previousValue = currentValue - dayChange;
        return {
          date: row.date,
          current_value: currentValue,
          invested_amount: Number(row.invested_amount) || 0,
          realized_proceeds: Number(row.realized_proceeds) || 0,
          profit_loss: Number(row.profit_loss) || 0,
          day_change: dayChange,
          day_change_pct: previousValue > 0 ? (dayChange / previousValue) * 100 : 0,
          price_source: resolveAggregatedSource(row),
          contributing_rows: Number(row.contributing_rows) || 0,
          contributing_portfolios: Number(row.contributing_portfolios) || 0,
        };
      });

      res.json({
        scope: {
          asset_type: assetType,
          portfolio_ids: portfolioIds,
          portfolio_scope: portfolioIds.length === 0
            ? 'all'
            : (portfolioIds.length === 1 ? 'single' : 'selected'),
        },
        pagination: {
          page: currentPage,
          page_size: pageSize,
          total_pages: totalPages,
          total_rows: totalRows,
          has_previous: currentPage > 1,
          has_next: currentPage < totalPages,
        },
        window: {
          requested_from: fromDate,
          requested_to: toDate,
          displayed_from: normalizedRows[0]?.date || null,
          displayed_to: normalizedRows[normalizedRows.length - 1]?.date || null,
        },
        summary: {
          rows_in_window: totalRows,
          rows_returned: normalizedRows.length,
          latest_row_date: bounds.latest_row_date || null,
          oldest_row_date: bounds.oldest_row_date || null,
        },
        rows: normalizedRows,
      });
    } catch (e) {
      return res.status(400).json({ error: e.message || 'Failed to fetch dashboard rollover rows' });
    }
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

  // ─── Batch Endpoint: Combines summary + health + allocation in single request ────
  router.get('/batch', (req, res) => {
    try {
      const batchRequests = String(req.query.requests || 'summary,health').toLowerCase().split(',').map(r => r.trim());
      const result = {};

      // Include summary if requested
      if (batchRequests.includes('summary')) {
        // Reuse summary logic
        const summaryReq = { query: req.query };
        let summaryData = null;
        let summaryErr = null;

        try {
          // Consolidate MAX(date) query once
          const latestDateResult = db.prepare(`
            SELECT MAX(date) AS max_date FROM portfolio_daily WHERE portfolio_id IS NOT NULL
          `).get();
          const latestDateInDb = latestDateResult?.max_date;

          // Get summary data (simplified version)
          const portfolio_id = req.query.portfolio_id;
          const hideSold = req.query.hide_sold === 'true';
          const includeFullySoldInReturns = req.query.include_sold_in_returns === 'true';

          if (portfolio_id) {
            summaryData = db.prepare(
              'SELECT * FROM portfolio_daily WHERE portfolio_id = ? ORDER BY date DESC LIMIT 1'
            ).get(portfolio_id);
          } else {
            if (latestDateInDb) {
              summaryData = db.prepare(`
                SELECT
                  ? AS date,
                  SUM(total_value) as total_value,
                  SUM(total_invested) as total_invested,
                  SUM(total_profit_loss) as total_profit_loss,
                  SUM(day_change) as day_change
                FROM portfolio_daily
                WHERE portfolio_id IS NOT NULL AND date = ?
              `).get(latestDateInDb, latestDateInDb);
            }
          }
          result.summary = { status: 'ok', data: summaryData, latest_date: latestDateInDb };
        } catch (e) {
          summaryErr = e.message;
          result.summary = { status: 'error', error: summaryErr };
        }
      }

      // Include health if requested
      if (batchRequests.includes('health')) {
        try {
          const portfolio_id = req.query.portfolio_id;
          const runDate = req.query.run_date || new Date().toISOString().split('T')[0];

          // Get daily_values health
          const allHealthData = portfolio_id
            ? db.prepare(`
                SELECT
                  COUNT(*) AS total_scopes,
                  COUNT(CASE WHEN julianday(?) - julianday(MAX(dv.date)) > 14 THEN 1 END) AS stale_scopes,
                  COUNT(CASE WHEN dv.total_units = 0 AND dv.current_value > 1 THEN 1 END) AS zero_units_nonzero_value
                FROM (
                  SELECT investment_id, MAX(date) AS date, total_units, current_value
                  FROM daily_values
                  WHERE portfolio_id = ?
                  GROUP BY investment_id
                ) dv
              `).get(runDate, portfolio_id)
            : db.prepare(`
                SELECT
                  COUNT(*) AS total_scopes,
                  COUNT(CASE WHEN julianday(?) - julianday(MAX(dv.date)) > 14 THEN 1 END) AS stale_scopes,
                  COUNT(CASE WHEN dv.total_units = 0 AND dv.current_value > 1 THEN 1 END) AS zero_units_nonzero_value
                FROM (
                  SELECT investment_id, portfolio_id, MAX(date) AS date, total_units, current_value
                  FROM daily_values
                  GROUP BY investment_id, portfolio_id
                ) dv
              `).get(runDate);

          result.health = {
            status: 'ok',
            run_date: runDate,
            total_scopes: allHealthData?.total_scopes || 0,
            stale_scopes: allHealthData?.stale_scopes || 0,
            zero_units_issues: allHealthData?.zero_units_nonzero_value || 0,
          };
        } catch (e) {
          result.health = { status: 'error', error: e.message };
        }
      }

      // Include allocation if requested
      if (batchRequests.includes('allocation')) {
        try {
          const portfolio_id = req.query.portfolio_id;
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
                GROUP BY i.asset_type
              `).all(portfolio_id, portfolio_id)
            : db.prepare(`
                WITH latest_by_scope AS (
                  SELECT investment_id, portfolio_id, MAX(date) AS max_date
                  FROM daily_values
                  GROUP BY investment_id, portfolio_id
                )
                SELECT
                  i.asset_type,
                  COUNT(*) as count,
                  COALESCE(SUM(dv.current_value), 0) as total_value,
                  COALESCE(SUM(dv.invested_amount), 0) as total_invested,
                  COALESCE(SUM(dv.profit_loss), 0) as total_profit_loss
                FROM investments i
                LEFT JOIN daily_values dv ON i.id = dv.investment_id
                  AND dv.date IN (
                    SELECT max_date FROM latest_by_scope
                    WHERE investment_id = dv.investment_id
                  )
                GROUP BY i.asset_type
              `).all();

          result.allocation = { status: 'ok', data: allocation };
        } catch (e) {
          result.allocation = { status: 'error', error: e.message };
        }
      }

      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
