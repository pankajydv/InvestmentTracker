const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { searchMutualFunds, fetchStockPrice, toNSETicker, searchStocks } = require('../services/priceService');
const { updateAllPrices, cancelUpdate } = require('../services/updater');
const { runSchedulerCycle } = require('../services/scheduler');
const { getPendingDirtyScopes, markDirtyForAssetTypeFromDate, markDirtyFromTransactions, runDirtyBackfillPreflight, markDirtyScopesFromSelector } = require('../services/dirtyBackfillService');
const { ONE_DAY_CHANGE_POLICY, getOneDayChangePolicy, getUnexpectedLocfPolicy } = require('../services/assetPolicy');
const { getComplianceScanState, scanAndRepairComplianceGaps } = require('../services/compliance/complianceScanService');
const { todayIso } = require('../services/backfillService');
const { logAppInfo, logAppError, getLogDir } = require('../services/appLogger');

const VALID_RATE_TYPES = new Set(['PPF', 'SSY', 'PF']);
const UNIT_INFLOW_TYPES = new Set([
  'BUY', 'DEPOSIT', 'BONUS', 'SPLIT', 'IPO', 'TRANSFER_IN', 'SWITCH_IN', 'RIGHTS',
  'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'VEST', 'ESPP_PURCHASE',
]);
const UNIT_OUTFLOW_TYPES = new Set([
  'SELL', 'REDEMPTION', 'WITHDRAWAL', 'TRANSFER_OUT', 'SWITCH_OUT', 'CONSOLIDATION', 'CHARGES', 'AMC',
]);
const LOCF_SOURCES = new Set(['LOCF']);
const IPO_PRELISTING_CARRY_MAX_DAYS = 12;
const MARKET_LINKED_ASSET_TYPES = new Set(['INDIAN_STOCK', 'FOREIGN_STOCK', 'MUTUAL_FUND', 'NPS', 'SGB']);
const MARKET_DATA_CUTOFF_MINUTES_IST = Object.freeze({
  INDIAN_STOCK: 17 * 60 + 45,
  // US equities settle after midnight IST; keep same-day LOCF as pending through IST day.
  FOREIGN_STOCK: 23 * 60 + 59,
  SGB: 19 * 60,
  MUTUAL_FUND: 23 * 60,
  NPS: 23 * 60,
  DEFAULT: 23 * 60,
});
const FOREIGN_UNEXPECTED_LOCF_RECENT_DAYS = 4;
const FOREIGN_UNEXPECTED_LOCF_THRESHOLD_SESSIONS = 1;

const complianceJobStore = new Map();
let complianceJobSeq = 0;

function nowIso() {
  return new Date().toISOString();
}

function normalizeComplianceMode(value, fallback = 'none') {
  const raw = String(value || fallback).toLowerCase();
  if (raw === 'full' || raw === 'deep') return 'full';
  if (raw === 'incremental' || raw === 'fast') return 'incremental';
  return fallback;
}

function parseBooleanLike(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value == null) return fallback;
  const raw = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(raw)) return false;
  return fallback;
}

function pruneComplianceJobs(limit = 200) {
  if (complianceJobStore.size <= limit) return;
  const rows = Array.from(complianceJobStore.values())
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const removeCount = complianceJobStore.size - limit;
  for (let i = 0; i < removeCount; i += 1) {
    complianceJobStore.delete(rows[i].id);
  }
}

function jobView(job) {
  if (!job) return null;
  return {
    id: job.id,
    type: 'compliance_scan',
    mode: job.mode,
    status: job.status,
    phase: job.phase,
    progressPct: job.progressPct,
    trigger: job.trigger,
    runDate: job.runDate,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error,
    result: job.result,
    window: job.window,
  };
}

function createComplianceJob(mode, metadata = {}) {
  const id = `cmp-${Date.now()}-${++complianceJobSeq}`;
  const job = {
    id,
    mode,
    status: 'queued',
    phase: 'queued',
    progressPct: 0,
    trigger: metadata.trigger || 'manual',
    runDate: parseDateOnly(metadata.runDate) || todayIso(),
    createdAt: nowIso(),
    startedAt: null,
    finishedAt: null,
    error: null,
    result: null,
    window: null,
  };
  complianceJobStore.set(id, job);
  pruneComplianceJobs();
  return job;
}

function runComplianceJobAsync(job) {
  setImmediate(() => {
    try {
      job.status = 'running';
      job.phase = 'starting';
      job.progressPct = 1;
      job.startedAt = nowIso();

      const result = scanAndRepairComplianceGaps({
        mode: job.mode,
        runDate: job.runDate,
        db,
        onProgress: (progress) => {
          if (progress?.phase) job.phase = String(progress.phase);
          if (Number.isFinite(Number(progress?.percent))) {
            const pct = Math.max(0, Math.min(100, Number(progress.percent)));
            job.progressPct = pct;
          }
          if (progress?.window) job.window = progress.window;
        },
      });

      job.status = 'completed';
      job.phase = 'completed';
      job.progressPct = 100;
      job.finishedAt = nowIso();
      job.result = {
        mode: result.mode,
        runDate: result.runDate,
        gapsDetected: result.gapsDetected,
        repairsEnqueued: result.repairsEnqueued,
      };
      job.window = result.window || job.window;
      logAppInfo('[ComplianceJob] Completed', jobView(job));
    } catch (e) {
      job.status = 'failed';
      job.phase = 'failed';
      job.finishedAt = nowIso();
      job.error = e.message || 'Compliance job failed';
      logAppError('[ComplianceJob] Failed', {
        id: job.id,
        mode: job.mode,
        error: job.error,
      });
    }
  });
}

function parseDateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : value;
}

function normalizeRatePayload(body) {
  const rate_type = typeof body.rate_type === 'string' ? body.rate_type.trim().toUpperCase() : '';
  const effective_from = parseDateOnly(body.effective_from);
  const effective_to = body.effective_to ? parseDateOnly(body.effective_to) : null;
  const rateNum = Number(body.rate);

  if (!VALID_RATE_TYPES.has(rate_type)) {
    throw new Error('rate_type must be one of PPF, SSY, PF');
  }
  if (!Number.isFinite(rateNum) || rateNum <= 0 || rateNum > 100) {
    throw new Error('rate must be a valid percentage greater than 0 and at most 100');
  }
  if (!effective_from) {
    throw new Error('effective_from must be a valid date in YYYY-MM-DD format');
  }
  if (body.effective_to && !effective_to) {
    throw new Error('effective_to must be a valid date in YYYY-MM-DD format');
  }
  if (effective_to && effective_to < effective_from) {
    throw new Error('effective_to must be greater than or equal to effective_from');
  }

  return {
    rate_type,
    rate: rateNum,
    effective_from,
    effective_to,
  };
}

function findOverlappingRate(db, payload, excludeId = null) {
  const rows = db.prepare(
    'SELECT id, rate_type, rate, effective_from, effective_to FROM interest_rates WHERE rate_type = ? ORDER BY effective_from ASC'
  ).all(payload.rate_type);

  const newFrom = payload.effective_from;
  const newTo = payload.effective_to || '9999-12-31';

  return rows.find((row) => {
    if (excludeId != null && Number(row.id) === Number(excludeId)) return false;
    const rowFrom = row.effective_from;
    const rowTo = row.effective_to || '9999-12-31';
    return newFrom <= rowTo && rowFrom <= newTo;
  }) || null;
}

function loadMarketHolidaySet(db, runDate) {
  const rows = runDate
    ? db.prepare('SELECT date FROM market_holidays WHERE date <= ? ORDER BY date ASC').all(runDate)
    : db.prepare('SELECT date FROM market_holidays ORDER BY date ASC').all();
  return new Set(
    rows
      .map((row) => String(row.date || ''))
      .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
  );
}

function isWeekendIso(isoDate) {
  const dt = new Date(`${isoDate}T00:00:00.000Z`);
  const day = dt.getUTCDay();
  return day === 0 || day === 6;
}

function isMarketSessionDate(isoDate, marketHolidaySet, assetType = null) {
  if (!isoDate) return false;
  if (isWeekendIso(isoDate)) return false;
  if (String(assetType || '').toUpperCase() === 'FOREIGN_STOCK') {
    // We don't maintain a US holiday calendar; for foreign stocks use weekday-only sessions.
    return true;
  }
  if (marketHolidaySet?.has(isoDate)) return false;
  return true;
}

function getIstClock(now = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
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

function getMarketDataCutoffMinutesForAsset(assetType) {
  return MARKET_DATA_CUTOFF_MINUTES_IST[assetType] ?? MARKET_DATA_CUTOFF_MINUTES_IST.DEFAULT;
}

function classifySameDayLocfState(scope, runDate, rowDate, rowPriceSource) {
  if (!scope || !MARKET_LINKED_ASSET_TYPES.has(String(scope.asset_type || ''))) {
    return { pending: false, overdue: false };
  }
  if (runDate !== rowDate) return { pending: false, overdue: false };
  if (!LOCF_SOURCES.has(String(rowPriceSource || ''))) return { pending: false, overdue: false };

  const istNow = getIstClock();
  if (runDate !== istNow.date) return { pending: false, overdue: false };

  const cutoffMinutes = getMarketDataCutoffMinutesForAsset(String(scope.asset_type || ''));
  if (istNow.minutes < cutoffMinutes) {
    return { pending: true, overdue: false };
  }
  return { pending: false, overdue: true };
}

function mergeComplianceReason(existingReason, nextReason) {
  const left = String(existingReason || '').trim();
  const right = String(nextReason || '').trim();
  if (!left) return right || null;
  if (!right) return left;
  if (left === right) return left;
  return `${left} | ${right}`;
}

function eachDate(fromDate, toDate) {
  const out = [];
  let d = new Date(`${fromDate}T00:00:00.000Z`);
  const end = new Date(`${toDate}T00:00:00.000Z`);
  while (d <= end) {
    out.push(d.toISOString().split('T')[0]);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function addDaysIso(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

function normalizeIndianStockSymbol(symbol) {
  const raw = String(symbol || '').trim();
  if (!raw) return null;
  if (raw.includes('.')) return raw;
  return `${raw}.NS`;
}

function loadSymbolHistoryByInvestment(db, investmentIds = []) {
  const ids = Array.from(new Set((investmentIds || []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)));
  const map = new Map();
  if (!ids.length) return map;

  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT investment_id, symbol, date(valid_from) AS valid_from, date(valid_to) AS valid_to
    FROM investment_symbol_history
    WHERE investment_id IN (${placeholders})
    ORDER BY investment_id ASC, valid_from ASC, id ASC
  `).all(...ids);

  for (const row of rows) {
    const investmentId = Number(row.investment_id);
    const list = map.get(investmentId) || [];
    list.push({
      symbol: String(row.symbol || '').trim(),
      validFrom: String(row.valid_from || ''),
      validTo: row.valid_to ? String(row.valid_to) : null,
    });
    map.set(investmentId, list);
  }

  return map;
}

function resolveIndianSymbolForDate(scope, date, symbolHistoryByInvestment = null) {
  const rows = symbolHistoryByInvestment?.get(Number(scope.investment_id)) || [];
  for (const row of rows) {
    if (!row?.symbol || !row?.validFrom) continue;
    if (date < row.validFrom) continue;
    if (row.validTo && date > row.validTo) continue;
    return normalizeIndianStockSymbol(row.symbol);
  }
  return normalizeIndianStockSymbol(scope.ticker_symbol);
}

function getFirstTradableDateByInvestment(db, scopes, symbolHistoryByInvestment, runDate) {
  const map = new Map();
  const byInvestment = new Map();

  for (const scope of scopes || []) {
    if (scope.asset_type !== 'INDIAN_STOCK') continue;
    if (!byInvestment.has(scope.investment_id)) {
      byInvestment.set(scope.investment_id, scope);
    }
  }

  for (const scope of byInvestment.values()) {
    const symbols = new Set();
    const current = normalizeIndianStockSymbol(scope.ticker_symbol);
    if (current) symbols.add(current);

    const historyRows = symbolHistoryByInvestment?.get(Number(scope.investment_id)) || [];
    for (const row of historyRows) {
      const normalized = normalizeIndianStockSymbol(row?.symbol);
      if (normalized) symbols.add(normalized);
    }

    const symbolList = Array.from(symbols);
    if (!symbolList.length) continue;

    const placeholders = symbolList.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT symbol, date
      FROM market_price_cache
      WHERE instrument_type = 'INDIAN_STOCK'
        AND symbol IN (${placeholders})
        AND date <= ?
        AND close IS NOT NULL
      ORDER BY date ASC
    `).all(...symbolList, runDate);

    for (const row of rows) {
      const effective = resolveIndianSymbolForDate(scope, row.date, symbolHistoryByInvestment);
      if (effective && effective === String(row.symbol)) {
        map.set(Number(scope.investment_id), String(row.date));
        break;
      }
    }
  }

  return map;
}

function buildScopeHealth(db, scope, runDate, marketHolidaySet, firstTradableByInvestment = null) {
  const txns = db.prepare(`
    SELECT
      date(transaction_date) AS date,
      transaction_type,
      COALESCE(units, 0) AS units
    FROM transactions
    WHERE investment_id = ?
      AND portfolio_id = ?
      AND date(transaction_date) <= ?
    ORDER BY date(transaction_date) ASC, id ASC
  `).all(scope.investment_id, scope.portfolio_id, runDate);

  const firstTxnDate = txns[0]?.date || null;
  if (!firstTxnDate) {
    return {
      ...scope,
      first_txn_date: null,
      latest_expected_date: null,
      last_row_date: null,
      first_missing_date: null,
      missing_count: 0,
      unexpected_locf_count: 0,
      pending_locf_count: 0,
      compliance_error_count: 0,
      overdue_locf_count: 0,
      stale: false,
    };
  }

  const needsMarketSessions = (() => {
    const policy = getOneDayChangePolicy(scope.asset_type);
    return policy === ONE_DAY_CHANGE_POLICY.MARKET_SESSION || policy === ONE_DAY_CHANGE_POLICY.NAV_SNAPSHOT;
  })();
  const unexpectedLocfPolicy = getUnexpectedLocfPolicy(scope.asset_type);

  const isBalanceBased = scope.asset_type === 'PF' || scope.asset_type === 'PPF' || scope.asset_type === 'SSY';
  const dateDeltas = new Map();
  const txnDateSet = new Set();
  let firstUnitInflowTxn = null;

  for (const txn of txns) {
    txnDateSet.add(txn.date);
    if (!isBalanceBased) {
      const t = String(txn.transaction_type || '').toUpperCase();
      if (!firstUnitInflowTxn && UNIT_INFLOW_TYPES.has(t) && Number(txn.units || 0) > 0) {
        firstUnitInflowTxn = {
          date: txn.date,
          transaction_type: t,
        };
      }
      let delta = 0;
      if (UNIT_INFLOW_TYPES.has(t)) delta = Number(txn.units || 0);
      else if (UNIT_OUTFLOW_TYPES.has(t)) delta = -Number(txn.units || 0);
      if (delta !== 0) {
        dateDeltas.set(txn.date, Number(dateDeltas.get(txn.date) || 0) + delta);
      }
    }
  }

  let expectedStartDate = firstTxnDate;
  const tickerSymbol = String(scope.ticker_symbol || '').trim();
  const isIpoFirstIndianStock = scope.asset_type === 'INDIAN_STOCK'
    && firstUnitInflowTxn?.transaction_type === 'IPO';
  let ipoCarryComplianceErrorCount = 0;
  let ipoCarryComplianceErrorReason = null;
  if (isIpoFirstIndianStock && tickerSymbol) {
    const firstTradableDate = firstTradableByInvestment?.get(Number(scope.investment_id)) || null;
    const carryEndDate = addDaysIso(firstUnitInflowTxn.date, IPO_PRELISTING_CARRY_MAX_DAYS - 1);
    if (runDate > carryEndDate && (!firstTradableDate || firstTradableDate > carryEndDate)) {
      ipoCarryComplianceErrorCount = 1;
      ipoCarryComplianceErrorReason = 'IPO_CARRY_WINDOW_EXCEEDED';
    }
    if (firstTradableDate && firstTradableDate > expectedStartDate) {
      expectedStartDate = firstTradableDate;
    } else if (!firstTradableDate) {
      expectedStartDate = null;
    }
  }

  if (!expectedStartDate || expectedStartDate > runDate) {
    return {
      ...scope,
      first_txn_date: firstTxnDate,
      latest_expected_date: null,
      last_row_date: null,
      first_missing_date: null,
      missing_count: 0,
      unexpected_locf_count: 0,
      pending_locf_count: 0,
      compliance_error_count: ipoCarryComplianceErrorCount,
      overdue_locf_count: 0,
      compliance_error_reason: ipoCarryComplianceErrorReason,
      stale: false,
    };
  }

  const expectedDates = [];
  let runningUnits = 0;
  if (!isBalanceBased && expectedStartDate > firstTxnDate) {
    for (const [date, delta] of dateDeltas.entries()) {
      if (date < expectedStartDate) runningUnits += Number(delta || 0);
    }
  }
  for (const date of eachDate(expectedStartDate, runDate)) {
    const delta = Number(dateDeltas.get(date) || 0);
    const hasTxn = txnDateSet.has(date);
    const unitsAfter = runningUnits + delta;

    let expected = false;
    if (isBalanceBased) {
      expected = true;
    } else {
      // Only require daily rows when the scope has a non-zero position before or after the date.
      // This avoids flagging pre-holding cash-only events (for example ESPP_CONTRIBUTION with zero units)
      // as missing daily_values rows.
      expected = runningUnits > 0.000001 || unitsAfter > 0.000001;
    }

    // Keep daily health strict for historical dates, but avoid flagging same-day
    // PF/PPF/SSY as missing before the accrual valuation run writes today's row.
    if (isBalanceBased && date === runDate) {
      expected = false;
    }

    if (expected && (!needsMarketSessions || isMarketSessionDate(date, marketHolidaySet, scope.asset_type))) {
      expectedDates.push(date);
    }

    runningUnits = unitsAfter;
  }

  if (!expectedDates.length) {
    return {
      ...scope,
      first_txn_date: firstTxnDate,
      latest_expected_date: null,
      last_row_date: null,
      first_missing_date: null,
      missing_count: 0,
      unexpected_locf_count: 0,
      pending_locf_count: 0,
      compliance_error_count: ipoCarryComplianceErrorCount,
      overdue_locf_count: 0,
      compliance_error_reason: ipoCarryComplianceErrorReason,
      stale: false,
    };
  }

  const dailyRows = db.prepare(`
    SELECT date, price_source
    FROM daily_values
    WHERE investment_id = ?
      AND portfolio_id = ?
      AND date >= ?
      AND date <= ?
  `).all(scope.investment_id, scope.portfolio_id, expectedStartDate, runDate);

  const rowByDate = new Map();
  let lastRowDate = null;
  for (const row of dailyRows) {
    rowByDate.set(row.date, row);
    if (!lastRowDate || row.date > lastRowDate) lastRowDate = row.date;
  }

  let missingCount = 0;
  let unexpectedLocfCount = 0;
  let pendingLocfCount = 0;
  let overdueLocfCount = 0;
  let firstMissingDate = null;
  let locfStreak = 0;
  let complianceErrorReason = ipoCarryComplianceErrorReason;
  const latestExpectedDate = expectedDates[expectedDates.length - 1] || null;
  const effectiveRecentWindowDays = String(scope.asset_type || '').toUpperCase() === 'FOREIGN_STOCK'
    ? Math.min(
      Math.max(1, Number(unexpectedLocfPolicy.recentWindowDays) || 180),
      FOREIGN_UNEXPECTED_LOCF_RECENT_DAYS
    )
    : Math.max(1, Number(unexpectedLocfPolicy.recentWindowDays) || 180);
  const effectiveThresholdSessions = String(scope.asset_type || '').toUpperCase() === 'FOREIGN_STOCK'
    ? Math.min(
      Math.max(1, Number(unexpectedLocfPolicy.thresholdSessions) || 5),
      FOREIGN_UNEXPECTED_LOCF_THRESHOLD_SESSIONS
    )
    : Math.max(1, Number(unexpectedLocfPolicy.thresholdSessions) || 5);
  const unexpectedLocfStartDate = latestExpectedDate
    ? addDaysIso(latestExpectedDate, -(effectiveRecentWindowDays - 1))
    : null;

  for (const date of expectedDates) {
    const row = rowByDate.get(date);
    if (!row) {
      missingCount += 1;
      if (!firstMissingDate) firstMissingDate = date;
      locfStreak = 0;
      continue;
    }

    if (date === runDate) {
      const locfState = classifySameDayLocfState(scope, runDate, date, row.price_source);
      if (locfState.pending) {
        pendingLocfCount += 1;
        locfStreak = 0;
        continue;
      }
      if (locfState.overdue) {
        overdueLocfCount += 1;
        complianceErrorReason = mergeComplianceReason(complianceErrorReason, 'MARKET_DATA_NOT_SETTLED_AFTER_CUTOFF');
      }
    }

    const isUnexpectedWindowDate = !unexpectedLocfStartDate || date >= unexpectedLocfStartDate;
    const isUnexpectedLocfCandidate = isUnexpectedWindowDate
      && LOCF_SOURCES.has(String(row.price_source || ''))
      && isMarketSessionDate(date, marketHolidaySet, scope.asset_type);

    if (isUnexpectedLocfCandidate) {
      locfStreak += 1;
      if (locfStreak > Math.max(0, effectiveThresholdSessions)) {
        unexpectedLocfCount += 1;
      }
    } else {
      locfStreak = 0;
    }
  }

  return {
    ...scope,
    first_txn_date: firstTxnDate,
    latest_expected_date: latestExpectedDate,
    last_row_date: lastRowDate,
    first_missing_date: firstMissingDate,
    missing_count: missingCount,
    unexpected_locf_count: unexpectedLocfCount,
    pending_locf_count: pendingLocfCount,
    overdue_locf_count: overdueLocfCount,
    compliance_error_count: ipoCarryComplianceErrorCount + overdueLocfCount,
    compliance_error_reason: complianceErrorReason,
    stale: !!latestExpectedDate && (!lastRowDate || lastRowDate < latestExpectedDate),
  };
}

module.exports = function (db) {

  router.get('/daily-values-health', (req, res) => {
    try {
      const runDate = parseDateOnly(req.query.run_date) || todayIso();
      const portfolioId = req.query.portfolio_id ? Number(req.query.portfolio_id) : null;

      if (portfolioId != null && (!Number.isInteger(portfolioId) || portfolioId <= 0)) {
        return res.status(400).json({ error: 'portfolio_id must be a positive integer' });
      }

      const marketHolidaySet = loadMarketHolidaySet(db, runDate);

      const scopes = db.prepare(`
        SELECT
          i.id AS investment_id,
          i.name AS investment_name,
          i.asset_type,
          i.ticker_symbol,
          t.portfolio_id,
          p.name AS portfolio_name
        FROM investments i
        INNER JOIN transactions t ON t.investment_id = i.id
        LEFT JOIN portfolios p ON p.id = t.portfolio_id
        WHERE t.portfolio_id IS NOT NULL
          AND i.is_active != 0
          AND COALESCE(i.exclude_from_tracking, 0) != 1
          ${portfolioId != null ? 'AND t.portfolio_id = ?' : ''}
        GROUP BY i.id, t.portfolio_id
        ORDER BY i.id ASC, t.portfolio_id ASC
      `).all(...(portfolioId != null ? [portfolioId] : []));

      const symbolHistoryByInvestment = loadSymbolHistoryByInvestment(
        db,
        scopes.map((scope) => Number(scope.investment_id))
      );

      const firstTradableByInvestment = getFirstTradableDateByInvestment(db, scopes, symbolHistoryByInvestment, runDate);

      const details = scopes.map((scope) => buildScopeHealth(db, scope, runDate, marketHolidaySet, firstTradableByInvestment));

      const issues = details
        .filter((row) => row.missing_count > 0 || row.unexpected_locf_count > 0 || row.compliance_error_count > 0 || row.stale)
        .sort((a, b) => {
          if (b.compliance_error_count !== a.compliance_error_count) return b.compliance_error_count - a.compliance_error_count;
          if (b.missing_count !== a.missing_count) return b.missing_count - a.missing_count;
          if (b.unexpected_locf_count !== a.unexpected_locf_count) return b.unexpected_locf_count - a.unexpected_locf_count;
          return String(a.first_missing_date || '').localeCompare(String(b.first_missing_date || ''));
        });

      const counts = {
        scopes_checked: details.length,
        issue_scopes: issues.length,
        compliance_errors: details.reduce((sum, row) => sum + Number(row.compliance_error_count || 0), 0),
        missing_rows: details.reduce((sum, row) => sum + Number(row.missing_count || 0), 0),
        unexpected_locf: details.reduce((sum, row) => sum + Number(row.unexpected_locf_count || 0), 0),
        pending_locf: details.reduce((sum, row) => sum + Number(row.pending_locf_count || 0), 0),
        overdue_locf: details.reduce((sum, row) => sum + Number(row.overdue_locf_count || 0), 0),
        stale_scopes: details.filter((row) => row.stale).length,
      };

      const status = counts.missing_rows > 0 || counts.compliance_errors > 0
        ? 'error'
        : (counts.unexpected_locf > 0 || counts.stale_scopes > 0 ? 'warning' : 'ok');

      const compliance = getComplianceScanState(runDate, db);

      res.json({
        run_date: runDate,
        status,
        counts,
        compliance,
        issues,
      });
    } catch (e) {
      logAppError('[Health] daily-values-health failed', { error: e.message });
      res.status(500).json({ error: e.message || 'Failed to compute daily values health' });
    }
  });

  // ─── Export all data to XLSX ──────────────────────────────────────────
  router.get('/export', (req, res) => {
    try {
      const portfolios = db.prepare('SELECT id, name, pan_number, color, created_at FROM portfolios ORDER BY id').all();
      const hasInterestRate = db.prepare("PRAGMA table_info(investments)")
        .all()
        .some(col => col.name === 'interest_rate');
      const interestRateSelect = hasInterestRate ? 'interest_rate' : 'NULL AS interest_rate';
      const investments = db.prepare(`
        SELECT id, name, display_name, asset_type, category,
               ticker_symbol, amfi_code, isin_code, previous_isin_codes,
               account_number, ${interestRateSelect}, currency,
               face_value, coupon_frequency, maturity_date,
               notes, created_at, updated_at
        FROM investments ORDER BY id
      `).all();
      const transactions = db.prepare(`
        SELECT t.id, t.investment_id, i.name AS investment_name,
               t.portfolio_id, p.name AS portfolio_name,
               t.transaction_type, t.transaction_date,
               t.units, t.price_per_unit, t.amount, t.fees,
               t.folio_number, t.broker, t.locked, t.notes, t.created_at
        FROM transactions t
        JOIN investments i ON i.id = t.investment_id
        JOIN portfolios p ON p.id = t.portfolio_id
        ORDER BY t.portfolio_id, t.investment_id, t.transaction_date, t.id
      `).all();
      const expenses = db.prepare(`
        SELECT e.id, e.portfolio_id, p.name AS portfolio_name,
               e.expense_type, e.expense_date, e.amount, e.broker, e.notes, e.created_at
        FROM portfolio_expenses e
        JOIN portfolios p ON p.id = e.portfolio_id
        ORDER BY e.portfolio_id, e.expense_date, e.id
      `).all();
      const rates = db.prepare('SELECT id, rate_type, rate, effective_from, effective_to, created_at FROM interest_rates ORDER BY id').all();
      const config = db.prepare('SELECT key, value, updated_at FROM config ORDER BY key').all();

      const wb = XLSX.utils.book_new();
      const sheets = [
        ['Portfolios', portfolios],
        ['Investments', investments],
        ['Transactions', transactions],
        ['Expenses', expenses],
        ['Interest_Rates', rates],
        ['Config', config],
      ];
      for (const [name, data] of sheets) {
        const ws = data.length
          ? XLSX.utils.json_to_sheet(data)
          : XLSX.utils.aoa_to_sheet([['(empty)']]);
        if (data.length) {
          const keys = Object.keys(data[0]);
          ws['!cols'] = keys.map(k => {
            let max = k.length;
            for (const r of data) {
              const v = r[k];
              if (v != null) { const len = String(v).length; if (len > max) max = len; }
            }
            return { wch: Math.min(max + 2, 60) };
          });
        }
        XLSX.utils.book_append_sheet(wb, ws, name);
      }

      const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      const dateStr = new Date().toISOString().slice(0, 10);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="InvestmentTracker_${dateStr}.xlsx"`);
      res.send(buf);
    } catch (e) {
      console.error('Export error:', e);
      res.status(500).json({ error: 'Export failed: ' + e.message });
    }
  });
  // ─── Search mutual funds ──────────────────────────────────────────────
  router.get('/search-mf', async (req, res) => {
    try {
      const { q } = req.query;
      if (!q || q.length < 2) return res.json([]);
      const results = await searchMutualFunds(q);
      res.json(results);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── Search stocks by name ────────────────────────────────────────────
  router.get('/search-stock-name', async (req, res) => {
    try {
      const { q, market } = req.query;
      if (!q || q.length < 2) return res.json([]);
      const results = await searchStocks(q, market);
      res.json(results);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── Search/validate stock ticker ─────────────────────────────────────
  router.get('/search-stock', async (req, res) => {
    try {
      const { symbol, market } = req.query;
      if (!symbol) return res.status(400).json({ error: 'symbol required' });

      const ticker = market === 'NSE' ? toNSETicker(symbol) : symbol;
      const data = await fetchStockPrice(ticker);
      res.json({ ...data, ticker });
    } catch (e) {
      res.status(404).json({ error: `Could not find stock: ${e.message}` });
    }
  });

  // ─── Trigger manual price update (full scheduler cycle) ────────────────
  // Runs the same flow as the cron scheduler: gap catch-up → dirty backfill
  // preflight → today's price fetch. This ensures missed days are recovered
  // even when triggered manually from the UI.
  router.post('/update-prices', async (req, res) => {
    try {
      const complianceMode = normalizeComplianceMode(
        req.body?.compliance_mode || req.query?.compliance_mode,
        'none'
      );
      const complianceAsync = parseBooleanLike(
        req.body?.compliance_async ?? req.query?.compliance_async,
        complianceMode !== 'none'
      );

      logAppInfo('[UI] Manual update-prices (scheduler cycle) requested', {
        complianceMode,
        complianceAsync,
      });
      const cycleResult = await runSchedulerCycle(db, '[UI] Manual trigger');

      let complianceResult = null;
      if (complianceMode !== 'none') {
        if (complianceAsync) {
          const job = createComplianceJob(complianceMode, {
            trigger: 'manual-update-prices',
            runDate: todayIso(),
          });
          runComplianceJobAsync(job);
          complianceResult = {
            async: true,
            job: jobView(job),
          };
        } else {
          const syncResult = scanAndRepairComplianceGaps({ mode: complianceMode, db });
          complianceResult = {
            async: false,
            mode: syncResult.mode,
            runDate: syncResult.runDate,
            window: syncResult.window,
            gapsDetected: syncResult.gapsDetected,
            repairsEnqueued: syncResult.repairsEnqueued,
          };
        }
      }

      logAppInfo('[UI] Manual update-prices (scheduler cycle) completed', {
        processed: cycleResult?.result?.processed || 0,
        errors: cycleResult?.result?.errors || 0,
        catchUpEnqueued: cycleResult?.catchUp?.enqueued || 0,
        preflightRan: cycleResult?.preflight?.ran || false,
        complianceMode,
        complianceAsync,
        complianceGapsDetected: complianceResult?.gapsDetected || 0,
        complianceRepairsEnqueued: complianceResult?.repairsEnqueued || 0,
        complianceJobId: complianceResult?.job?.id || null,
      });
      res.json({
        ...cycleResult,
        compliance: complianceResult || null,
      });
    } catch (e) {
      logAppError('[UI] Manual update-prices failed', { error: e.message });
      res.status(500).json({ error: e.message });
    }
  });

  // ─── Compliance jobs: async trigger + list/status ──────────────────────
  router.post('/compliance-jobs', (req, res) => {
    try {
      const mode = normalizeComplianceMode(req.body?.mode || req.query?.mode, 'incremental');
      const runDate = parseDateOnly(req.body?.run_date || req.query?.run_date) || todayIso();
      const job = createComplianceJob(mode, {
        trigger: 'manual-compliance-job',
        runDate,
      });
      runComplianceJobAsync(job);
      res.status(202).json({
        success: true,
        job: jobView(job),
      });
    } catch (e) {
      logAppError('[ComplianceJob] Create failed', { error: e.message });
      res.status(500).json({ error: e.message || 'Failed to create compliance job' });
    }
  });

  router.get('/compliance-jobs', (req, res) => {
    try {
      const onlyActive = parseBooleanLike(req.query.active, false);
      const limitRaw = Number(req.query.limit);
      const limit = Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.min(Math.floor(limitRaw), 500)
        : 100;

      const rows = Array.from(complianceJobStore.values())
        .filter((job) => !onlyActive || job.status === 'queued' || job.status === 'running')
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, limit)
        .map(jobView);

      res.json({
        total: rows.length,
        active_only: onlyActive,
        jobs: rows,
      });
    } catch (e) {
      logAppError('[ComplianceJob] List failed', { error: e.message });
      res.status(500).json({ error: e.message || 'Failed to list compliance jobs' });
    }
  });

  router.get('/compliance-jobs/:id', (req, res) => {
    try {
      const id = String(req.params.id || '').trim();
      const job = complianceJobStore.get(id);
      if (!job) return res.status(404).json({ error: 'Compliance job not found' });
      res.json({ job: jobView(job) });
    } catch (e) {
      logAppError('[ComplianceJob] Fetch failed', { error: e.message });
      res.status(500).json({ error: e.message || 'Failed to fetch compliance job' });
    }
  });

  // ─── Lightweight compliance status ─────────────────────────────────────
  router.get('/compliance-status', (req, res) => {
    try {
      const runDate = parseDateOnly(req.query.run_date) || todayIso();
      const compliance = getComplianceScanState(runDate, db);
      const status = compliance.openGapCount > 0
        ? 'warning'
        : (compliance.hasBacklog ? 'pending' : 'ok');
      res.json({
        run_date: runDate,
        status,
        compliance,
      });
    } catch (e) {
      logAppError('[Health] compliance-status failed', { error: e.message });
      res.status(500).json({ error: e.message || 'Failed to fetch compliance status' });
    }
  });

  router.post('/cancel-update', (req, res) => {
    cancelUpdate();
    logAppInfo('[UI] Manual cancel-update requested');
    res.json({ cancelled: true });
  });

  // ─── List and download unified logs ───────────────────────────────────
  router.get('/log-files', (req, res) => {
    try {
      const logDir = getLogDir();
      if (!fs.existsSync(logDir)) {
        return res.json({
          files: [],
          log_dir: logDir,
        });
      }

      const rows = fs.readdirSync(logDir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => {
          const fullPath = path.join(logDir, entry.name);
          const stat = fs.statSync(fullPath);
          return {
            name: entry.name,
            size_bytes: Number(stat.size || 0),
            updated_at: new Date(stat.mtimeMs).toISOString(),
          };
        })
        .filter((file) => /^invest-tracker-\d{4}-\d{2}-\d{2}\.log$/.test(file.name))
        .sort((a, b) => b.name.localeCompare(a.name));

      return res.json({
        files: rows,
        log_dir: logDir,
      });
    } catch (e) {
      logAppError('[API] Failed to list log files', { error: e.message });
      return res.status(500).json({ error: e.message || 'Failed to list log files' });
    }
  });

  router.get('/log-files/:name', (req, res) => {
    try {
      const fileName = String(req.params.name || '').trim();
      if (!/^invest-tracker-\d{4}-\d{2}-\d{2}\.log$/.test(fileName)) {
        return res.status(400).json({ error: 'Invalid log file name' });
      }

      const logDir = getLogDir();
      const fullPath = path.join(logDir, fileName);
      if (!fs.existsSync(fullPath)) {
        return res.status(404).json({ error: 'Log file not found' });
      }

      return res.download(fullPath, fileName);
    } catch (e) {
      logAppError('[API] Failed to download log file', { error: e.message });
      return res.status(500).json({ error: e.message || 'Failed to download log file' });
    }
  });

  // ─── Get/update config ────────────────────────────────────────────────
  router.get('/config', (req, res) => {
    const config = {};
    const rows = db.prepare('SELECT * FROM config').all();
    for (const row of rows) {
      config[row.key] = row.value;
    }
    res.json(config);
  });

  router.put('/config', (req, res) => {
    const updates = req.body;
    const stmt = db.prepare("INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))");
    for (const [key, value] of Object.entries(updates)) {
      stmt.run(key, String(value));
    }
    logAppInfo('[Config] Updated', {
      keys: Object.keys(updates || {}),
    });
    res.json({ success: true });
  });

  // ─── Get interest rates ───────────────────────────────────────────────
  router.get('/interest-rates', (req, res) => {
    const dbRates = db.prepare('SELECT * FROM interest_rates ORDER BY rate_type, effective_from DESC').all();

    res.json({
      rates: dbRates,
      source: 'database',
    });
  });

  router.post('/interest-rates', (req, res) => {
    try {
      const payload = normalizeRatePayload(req.body || {});
      const overlap = findOverlappingRate(db, payload);
      if (overlap) {
        return res.status(409).json({
          error: 'Overlapping interest rate range exists for this scheme.',
          conflict: overlap,
        });
      }

      const result = db.prepare(
        'INSERT INTO interest_rates (rate_type, rate, effective_from, effective_to) VALUES (?, ?, ?, ?)'
      ).run(payload.rate_type, payload.rate, payload.effective_from, payload.effective_to);

      markDirtyForAssetTypeFromDate(
        db,
        payload.rate_type,
        payload.effective_from,
        'interest-rate-created',
        `interest_rate:${result.lastInsertRowid}`
      );

      const created = db.prepare('SELECT * FROM interest_rates WHERE id = ?').get(result.lastInsertRowid);
      logAppInfo('[InterestRate] Created', {
        interest_rate_id: Number(result.lastInsertRowid),
        rate_type: payload.rate_type,
        rate: payload.rate,
        effective_from: payload.effective_from,
        effective_to: payload.effective_to,
      });
      return res.status(201).json({ success: true, rate: created });
    } catch (e) {
      logAppError('[InterestRate] Create failed', { error: e.message });
      return res.status(400).json({ error: e.message || 'Failed to create interest rate' });
    }
  });

  router.put('/interest-rates/:id', (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid id' });
      }

      const existing = db.prepare('SELECT * FROM interest_rates WHERE id = ?').get(id);
      if (!existing) {
        return res.status(404).json({ error: 'Interest rate entry not found' });
      }

      const payload = normalizeRatePayload(req.body || {});
      const overlap = findOverlappingRate(db, payload, id);
      if (overlap) {
        return res.status(409).json({
          error: 'Overlapping interest rate range exists for this scheme.',
          conflict: overlap,
        });
      }

      const dirtyFrom = payload.effective_from < existing.effective_from ? payload.effective_from : existing.effective_from;

      db.prepare(
        'UPDATE interest_rates SET rate_type = ?, rate = ?, effective_from = ?, effective_to = ? WHERE id = ?'
      ).run(payload.rate_type, payload.rate, payload.effective_from, payload.effective_to, id);

      markDirtyForAssetTypeFromDate(
        db,
        payload.rate_type,
        dirtyFrom,
        'interest-rate-updated',
        `interest_rate:${id}`
      );

      const updated = db.prepare('SELECT * FROM interest_rates WHERE id = ?').get(id);
      logAppInfo('[InterestRate] Updated', {
        interest_rate_id: id,
        rate_type: payload.rate_type,
        rate: payload.rate,
        effective_from: payload.effective_from,
        effective_to: payload.effective_to,
      });
      return res.json({ success: true, rate: updated });
    } catch (e) {
      logAppError('[InterestRate] Update failed', {
        interest_rate_id: Number(req.params.id) || null,
        error: e.message,
      });
      return res.status(400).json({ error: e.message || 'Failed to update interest rate' });
    }
  });

  router.delete('/interest-rates/:id', (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid id' });
      }

      const existing = db.prepare('SELECT * FROM interest_rates WHERE id = ?').get(id);
      if (!existing) {
        return res.status(404).json({ error: 'Interest rate entry not found' });
      }

      db.prepare('DELETE FROM interest_rates WHERE id = ?').run(id);

      markDirtyForAssetTypeFromDate(
        db,
        existing.rate_type,
        existing.effective_from,
        'interest-rate-deleted',
        `interest_rate:${id}`
      );

      logAppInfo('[InterestRate] Deleted', {
        interest_rate_id: id,
        rate_type: existing.rate_type,
        effective_from: existing.effective_from,
      });

      return res.json({ success: true });
    } catch (e) {
      logAppError('[InterestRate] Delete failed', {
        interest_rate_id: Number(req.params.id) || null,
        error: e.message,
      });
      return res.status(400).json({ error: e.message || 'Failed to delete interest rate' });
    }
  });

  // ─── Dirty backfill scope visibility ───────────────────────────────────
  router.get('/dirty-backfill-scopes', (req, res) => {
    try {
      const runDate = parseDateOnly(req.query.run_date) || todayIso();
      const pending = getPendingDirtyScopes(db, runDate);
      res.json({ run_date: runDate, pending_count: pending.length, pending });
    } catch (e) {
      res.status(500).json({ error: e.message || 'Failed to fetch dirty scopes' });
    }
  });

  // ─── Mark dirty scopes from generic selector + date strategy ──────────
  router.post('/dirty-backfill-scopes/mark', async (req, res) => {
    try {
      const body = req.body || {};
      const dryRun = body.dry_run === true;
      const executeNow = body.execute_now === true;
      const runDate = parseDateOnly(body.run_date) || todayIso();

      const selector = body.selector || {};
      const dateStrategy = body.date_strategy || { type: 'scope_first_transaction' };
      const reason = body.reason || 'manual-mark-dirty-scope';
      const sourceEventId = body.source_event_id || `manual:${new Date().toISOString()}`;

      logAppInfo('[UI] Mark dirty scopes requested', {
        dry_run: dryRun,
        execute_now: executeNow,
        run_date: runDate,
        selector,
        date_strategy: dateStrategy,
      });

      // Validate selector inputs
      if (selector.portfolio_ids) {
        if (!Array.isArray(selector.portfolio_ids)) {
          return res.status(400).json({ error: 'selector.portfolio_ids must be an array' });
        }
        for (const pid of selector.portfolio_ids) {
          if (!Number.isInteger(pid) || pid <= 0) {
            return res.status(400).json({ error: 'selector.portfolio_ids must contain positive integers' });
          }
        }
      }

      if (selector.investment_ids) {
        if (!Array.isArray(selector.investment_ids)) {
          return res.status(400).json({ error: 'selector.investment_ids must be an array' });
        }
        for (const iid of selector.investment_ids) {
          if (!Number.isInteger(iid) || iid <= 0) {
            return res.status(400).json({ error: 'selector.investment_ids must contain positive integers' });
          }
        }
      }

      if (selector.asset_types) {
        if (!Array.isArray(selector.asset_types)) {
          return res.status(400).json({ error: 'selector.asset_types must be an array' });
        }
        const validAssetTypes = new Set(['INDIAN_STOCK', 'FOREIGN_STOCK', 'MUTUAL_FUND', 'NPS', 'SGB', 'PPF', 'SSY', 'PF', 'CASH']);
        for (const at of selector.asset_types) {
          if (!validAssetTypes.has(String(at).toUpperCase())) {
            return res.status(400).json({ error: `Invalid asset_type: ${at}` });
          }
        }
      }

      // Validate date strategy
      const strategyType = String(dateStrategy.type || 'scope_first_transaction').toLowerCase();
      if (!['fixed_date', 'scope_first_transaction', 'max_of_fixed_and_scope_first'].includes(strategyType)) {
        return res.status(400).json({ error: `Invalid date_strategy.type: ${dateStrategy.type}` });
      }

      if (strategyType === 'fixed_date' && !parseDateOnly(dateStrategy.from_date)) {
        return res.status(400).json({ error: 'date_strategy.type=fixed_date requires from_date (YYYY-MM-DD)' });
      }

      // In dry-run mode, return what would be enqueued without writing
      if (dryRun) {
        const { buildSelectorMatches, computeScopeDatesFromStrategy } = require('../services/dirtyBackfillService');
        const matches = buildSelectorMatches(db, selector);
        const scopesWithDates = computeScopeDatesFromStrategy(db, matches, dateStrategy);

        logAppInfo('[UI] Mark dirty scopes dry-run', {
          matched_count: matches.length,
          scopes_count: scopesWithDates.length,
        });

        return res.json({
          success: true,
          dry_run: true,
          run_date: runDate,
          matched_count: matches.length,
          scopes_count: scopesWithDates.length,
          scopes: scopesWithDates.slice(0, 100),
          message: scopesWithDates.length > 100 ? `Showing first 100 of ${scopesWithDates.length} scopes` : undefined,
        });
      }

      // Perform actual marking
      const { markDirtyScopesFromSelector } = require('../services/dirtyBackfillService');
      const result = markDirtyScopesFromSelector(db, selector, dateStrategy, {
        reason,
        sourceEventId,
        runDate,
      });

      logAppInfo('[UI] Mark dirty scopes completed', {
        matched_count: result.matched_count,
        enqueued_count: result.enqueued_count,
        errors_count: result.errors.length,
      });

      // Execute preflight if requested
      if (executeNow && result.enqueued_count > 0) {
        const preflight = await runDirtyBackfillPreflight(db, runDate);
        logAppInfo('[UI] Mark dirty scopes executed preflight', { ...preflight });
        return res.json({
          success: true,
          matched_count: result.matched_count,
          enqueued_count: result.enqueued_count,
          errors: result.errors,
          executed_now: true,
          preflight_result: preflight,
        });
      }

      res.json({
        success: true,
        matched_count: result.matched_count,
        enqueued_count: result.enqueued_count,
        errors: result.errors,
        executed_now: false,
      });
    } catch (e) {
      logAppError('[UI] Mark dirty scopes failed', { error: e.message });
      return res.status(500).json({ error: e.message || 'Failed to mark dirty scopes' });
    }
  });

  // ─── Backfill status ───────────────────────────────────────────────────
  router.get('/backfill-status', (req, res) => {
    try {
      const cfgRows = db.prepare(`
        SELECT key, value, updated_at
        FROM config
        WHERE key IN ('backfill_watermark', 'backfill_last_result', 'backfill_last_error', 'backfill_progress')
      `).all();

      const pending = db.prepare("SELECT COUNT(*) AS c FROM dirty_backfill_scope WHERE status = 'pending'").get().c;
      const running = db.prepare("SELECT COUNT(*) AS c FROM dirty_backfill_scope WHERE status = 'running'").get().c;
      const failed = db.prepare("SELECT COUNT(*) AS c FROM dirty_backfill_scope WHERE status = 'failed'").get().c;
      const completed = db.prepare("SELECT COUNT(*) AS c FROM dirty_backfill_scope WHERE status = 'completed'").get().c;

      const cfg = {};
      for (const row of cfgRows) cfg[row.key] = row.value;

      let lastResult = null;
      if (cfg.backfill_last_result) {
        try {
          lastResult = JSON.parse(cfg.backfill_last_result);
        } catch (e) {
          logAppError(`Backfill status: failed to parse backfill_last_result JSON: ${e.message}`);
          lastResult = { raw: cfg.backfill_last_result };
        }
      }

      let progress = null;
      if (cfg.backfill_progress) {
        try {
          progress = JSON.parse(cfg.backfill_progress);
        } catch (e) {
          logAppError(`Backfill status: failed to parse backfill_progress JSON: ${e.message}`);
          progress = { raw: cfg.backfill_progress };
        }
      }

      const percent = progress && Number(progress.total) > 0
        ? Math.round((Number(progress.completed || 0) / Number(progress.total)) * 1000) / 10
        : null;

      res.json({
        watermark: cfg.backfill_watermark || null,
        progress,
        progressPct: percent,
        lastResult,
        lastError: cfg.backfill_last_error || null,
        counts: { pending, running, failed, completed },
      });
    } catch (e) {
      res.status(500).json({ error: e.message || 'Failed to fetch backfill status' });
    }
  });

  // ─── Backfill trigger (from date / investment) ───────────────────────
  router.post('/backfill', async (req, res) => {
    try {
      const body = req.body || {};
      const runDate = parseDateOnly(body.run_date) || todayIso();
      const fromDate = parseDateOnly(body.from_date);
      const investmentId = body.investment_id != null ? Number(body.investment_id) : null;
      const portfolioId = body.portfolio_id != null ? Number(body.portfolio_id) : null;
      const execute = body.execute !== false;
      logAppInfo('[UI] Manual backfill trigger requested', {
        runDate,
        fromDate: fromDate || null,
        investmentId,
        portfolioId,
        execute,
      });

      if (investmentId != null && (!Number.isInteger(investmentId) || investmentId <= 0)) {
        return res.status(400).json({ error: 'investment_id must be a positive integer' });
      }
      if (portfolioId != null && (!Number.isInteger(portfolioId) || portfolioId <= 0)) {
        return res.status(400).json({ error: 'portfolio_id must be a positive integer' });
      }

      let scopes = [];
      if (investmentId != null) {
        scopes = db.prepare(`
          SELECT
            investment_id,
            portfolio_id,
            COALESCE(?, MIN(date(transaction_date))) AS transaction_date
          FROM transactions
          WHERE investment_id = ?
            ${portfolioId != null ? 'AND portfolio_id = ?' : ''}
            AND date(transaction_date) <= ?
          GROUP BY investment_id, portfolio_id
        `).all(...(portfolioId != null ? [fromDate, investmentId, portfolioId, runDate] : [fromDate, investmentId, runDate]));
      } else {
        scopes = db.prepare(`
          SELECT
            investment_id,
            portfolio_id,
            CASE WHEN ? IS NOT NULL THEN ? ELSE MIN(date(transaction_date)) END AS transaction_date
          FROM transactions
          WHERE date(transaction_date) <= ?
            ${portfolioId != null ? 'AND portfolio_id = ?' : ''}
          GROUP BY investment_id, portfolio_id
        `).all(...(portfolioId != null ? [fromDate, fromDate, runDate, portfolioId] : [fromDate, fromDate, runDate]));
      }

      if (!scopes.length) {
        return res.json({ success: true, run_date: runDate, seeded_scopes: 0, executed: false, message: 'No eligible scopes found' });
      }

      const marked = markDirtyFromTransactions(db, scopes, 'manual-backfill-trigger', `manual:${new Date().toISOString()}`);
      if (!execute) {
        logAppInfo('[UI] Manual backfill trigger seeded only', { runDate, seededScopes: marked });
        return res.json({ success: true, run_date: runDate, seeded_scopes: marked, executed: false });
      }

      const result = await runDirtyBackfillPreflight(db, runDate);
      logAppInfo('[UI] Manual backfill trigger executed', { runDate, seededScopes: marked, result });
      return res.json({ success: true, run_date: runDate, seeded_scopes: marked, executed: true, result });
    } catch (e) {
      logAppError('[UI] Manual backfill trigger failed', { error: e.message });
      return res.status(500).json({ error: e.message || 'Backfill trigger failed' });
    }
  });

  // ─── Dirty backfill preflight trigger ─────────────────────────────────
  router.post('/backfill/preflight', async (req, res) => {
    try {
      const body = req.body || {};
      const runDate = parseDateOnly(body.run_date) || todayIso();
      logAppInfo('[UI] Backfill preflight requested', { runDate });
      const result = await runDirtyBackfillPreflight(db, runDate);
      logAppInfo('[UI] Backfill preflight completed', { runDate, result });
      res.json({ success: true, ...result });
    } catch (e) {
      logAppError('[UI] Backfill preflight failed', { error: e.message });
      res.status(500).json({ error: e.message || 'Dirty backfill preflight failed' });
    }
  });

  // ─── Full backfill seed + optional run ────────────────────────────────
  router.post('/backfill/full', async (req, res) => {
    try {
      const body = req.body || {};
      const runDate = parseDateOnly(body.run_date) || todayIso();
      const execute = body.execute !== false;
      logAppInfo('[UI] Full backfill requested', { runDate, execute });

      const scopes = db.prepare(`
        SELECT t.investment_id, t.portfolio_id, MIN(date(t.transaction_date)) AS transaction_date
        FROM transactions t
        JOIN investments i ON i.id = t.investment_id
        WHERE date(t.transaction_date) <= ?
          AND i.is_active != 0
          AND i.exclude_from_tracking != 1
        GROUP BY t.investment_id, t.portfolio_id
      `).all(runDate);

      const marked = markDirtyFromTransactions(db, scopes, 'full-backfill-seed', `run:${runDate}`);

      if (!execute) {
        logAppInfo('[UI] Full backfill seeded only', { runDate, seededScopes: marked });
        return res.json({ success: true, run_date: runDate, seeded_scopes: marked, executed: false });
      }

      const result = await runDirtyBackfillPreflight(db, runDate);
      logAppInfo('[UI] Full backfill completed', { runDate, seededScopes: marked, result });
      return res.json({ success: true, run_date: runDate, seeded_scopes: marked, executed: true, result });
    } catch (e) {
      logAppError('[UI] Full backfill failed', { error: e.message });
      return res.status(500).json({ error: e.message || 'Full backfill failed' });
    }
  });

  return router;
};
