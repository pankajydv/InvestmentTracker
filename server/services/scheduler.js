/**
 * Cron scheduler for daily price updates.
 * Intraday runs (9:25 AM–4:25 PM) focus on stocks (frequent updates).
 * Early run (4:25 AM) seeds daily snapshots across asset types.
 * Final run (10:25 PM) updates all asset types after MF NAVs settle.
 */

const { applyEnvDefaults } = require('../config/envDefaults');
applyEnvDefaults();

const cron = require('node-cron');
const { updateAllPrices } = require('./updater');
const { runDirtyBackfillPreflight, markAllTrackedInvestmentsDirtyFromDate, markScopeDirty } = require('./dirtyBackfillService');
const {
  fetchMutualFundHistory,
  fetchHistoricalUSDToINR,
} = require('./priceService');
const { getSGBNseHistoricalPrices } = require('./sgbNseHistorical');
const { hydrateStockSeriesForPhase2 } = require('./marketPriceCache');
const { todayIso, addDaysIso, eachDateIso, istDateFromUnixSeconds } = require('./dateUtils');
const { logAppInfo, logAppWarn, logAppError } = require('./appLogger');
const { scanAndRepairComplianceGaps, refreshComplianceScanFloor } = require('./compliance/complianceScanService');

function parsePositiveIntEnv(name, fallback) {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.floor(parsed);
  return rounded > 0 ? rounded : fallback;
}

function parseNonNegativeIntEnv(name, fallback) {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.floor(parsed);
  return rounded >= 0 ? rounded : fallback;
}

function parseBooleanEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  return String(raw).toLowerCase() === 'true';
}

const ENABLE_INTRADAY_COMPLIANCE = String(process.env.ENABLE_INTRADAY_COMPLIANCE || 'false').toLowerCase() === 'true';
const ENABLE_STARTUP_COMPLIANCE = String(process.env.ENABLE_STARTUP_COMPLIANCE || 'false').toLowerCase() === 'true';
const ENABLE_STARTUP_PREFLIGHT = String(process.env.ENABLE_STARTUP_PREFLIGHT || 'false').toLowerCase() === 'true';
const NIGHTLY_MARKET_CACHE_WARM_DAYS = parseNonNegativeIntEnv('NIGHTLY_MARKET_CACHE_WARM_DAYS', 5);
const ENABLE_FOREIGN_RECONCILE = parseBooleanEnv('ENABLE_FOREIGN_RECONCILE', true);
const FOREIGN_RECONCILE_MAX_LOOKBACK_DAYS = parsePositiveIntEnv('FOREIGN_RECONCILE_MAX_LOOKBACK_DAYS', 10);
const FOREIGN_RECONCILE_SETTLEMENT_CUTOFF_MINUTES_IST = parseNonNegativeIntEnv('FOREIGN_RECONCILE_SETTLEMENT_CUTOFF_MINUTES_IST', (4 * 60) + 25);
// Days of recent daily_values to scan for LOCF rows when reconciling lagging NAV/price feeds.
const LOCF_RECONCILE_LOOKBACK_DAYS = parsePositiveIntEnv('LOCF_RECONCILE_LOOKBACK_DAYS', 5);
// Asset types covered by the generic LOCF-lag self-healing path in the scheduler.
// Must stay in sync with LOCF_LAG_RECONCILE_ASSET_TYPES in updater.js.
// FOREIGN_STOCK is intentionally excluded — handled by ensureForeignReconcileScopes.
const LOCF_LAG_RECONCILE_ASSET_TYPES = ['INDIAN_STOCK', 'MUTUAL_FUND', 'NPS', 'SGB'];
const EXITED_UNITS_EPSILON = 1e-6;

let isSchedulerCycleRunning = false;

function addDays(isoDate, days) {
  return addDaysIso(isoDate, days);
}

function diffDays(startIso, endIso) {
  const startMs = new Date(`${startIso}T00:00:00.000Z`).getTime();
  const endMs = new Date(`${endIso}T00:00:00.000Z`).getTime();
  return Math.max(Math.floor((endMs - startMs) / 86400000), 0);
}

function eachDate(fromDate, toDate) {
  return eachDateIso(fromDate, toDate);
}

function inferStockInstrumentType(symbol) {
  return /\.(NS|BO)$/i.test(String(symbol || '')) ? 'INDIAN_STOCK' : 'FOREIGN_STOCK';
}

function normalizeMutualFundCode(code) {
  const raw = String(code || '').trim();
  return raw || null;
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

function resolveMutualFundCodeForDate(investmentId, currentCode, date, historyByInvestment) {
  const normalizedCurrent = normalizeMutualFundCode(currentCode);
  const rows = historyByInvestment?.get(Number(investmentId)) || [];
  for (const row of rows) {
    if (!row?.symbol || !row?.validFrom) continue;
    if (date < row.validFrom) continue;
    if (row.validTo && date > row.validTo) continue;
    return normalizeMutualFundCode(row.symbol) || normalizedCurrent;
  }
  return normalizedCurrent;
}

function buildMutualFundCodeWindows(investmentId, currentCode, fromDate, toDate, historyByInvestment) {
  const windows = [];
  let active = null;
  const dates = eachDate(fromDate, toDate);
  for (const date of dates) {
    const code = resolveMutualFundCodeForDate(investmentId, currentCode, date, historyByInvestment);
    if (!code) {
      active = null;
      continue;
    }

    if (!active || active.code !== code) {
      active = { investmentId: Number(investmentId), code, fromDate: date, toDate: date };
      windows.push(active);
      continue;
    }

    active.toDate = date;
  }
  return windows;
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

function getPreviousUsSessionDate(anchorDate) {
  let cursor = anchorDate;
  while (cursor) {
    const day = new Date(`${cursor}T00:00:00.000Z`).getUTCDay();
    if (day !== 0 && day !== 6) return cursor;
    cursor = addDays(cursor, -1);
  }
  return anchorDate;
}

function resolveForeignSettlementDate(now = new Date()) {
  const ist = getIstClock(now);
  const anchor = ist.minutes < FOREIGN_RECONCILE_SETTLEMENT_CUTOFF_MINUTES_IST
    ? addDays(ist.date, -1)
    : ist.date;
  return getPreviousUsSessionDate(anchor);
}

function isIsoWeekday(dateIso) {
  if (!dateIso) return false;
  const day = new Date(`${dateIso}T00:00:00.000Z`).getUTCDay();
  return day !== 0 && day !== 6;
}

function minIsoDate(...dates) {
  const valid = dates.filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d));
  if (!valid.length) return null;
  return valid.reduce((min, cur) => (cur < min ? cur : min), valid[0]);
}

function maxIsoDate(a, b) {
  if (!a) return b || null;
  if (!b) return a || null;
  return a > b ? a : b;
}

function resolvePendingForeignDirtyStartByScope(db, runDate) {
  const rows = db.prepare(`
    SELECT s.investment_id, s.portfolio_id, MIN(date(s.dirty_from_date)) AS dirty_from_date
    FROM dirty_backfill_scope s
    JOIN investments i ON i.id = s.investment_id
    WHERE i.asset_type = 'FOREIGN_STOCK'
      AND s.status IN ('pending', 'running', 'failed')
      AND date(s.dirty_from_date) <= ?
      AND s.investment_id IS NOT NULL
      AND s.portfolio_id IS NOT NULL
    GROUP BY s.investment_id, s.portfolio_id
  `).all(runDate);

  const map = new Map();
  for (const row of rows) {
    const key = `${row.investment_id}:${row.portfolio_id}`;
    map.set(key, String(row.dirty_from_date));
  }
  return map;
}

function resolveLocfSignalStartByScope(db, startDate, endDate) {
  if (!startDate || !endDate || startDate > endDate) return new Map();

  const rows = db.prepare(`
    SELECT dv.investment_id, dv.portfolio_id, MIN(dv.date) AS locf_start
    FROM daily_values dv
    JOIN investments i ON i.id = dv.investment_id
    WHERE i.asset_type = 'FOREIGN_STOCK'
      AND dv.portfolio_id IS NOT NULL
      AND dv.price_source = 'LOCF'
      AND date(dv.date) >= ?
      AND date(dv.date) <= ?
    GROUP BY dv.investment_id, dv.portfolio_id
  `).all(startDate, endDate);

  const map = new Map();
  for (const row of rows) {
    const locfDate = String(row.locf_start || '');
    if (!isIsoWeekday(locfDate)) continue;
    const key = `${row.investment_id}:${row.portfolio_id}`;
    map.set(key, locfDate);
  }
  return map;
}

function resolveActiveForeignScopes(db, runDate) {
  return db.prepare(`
    SELECT
      i.id AS investment_id,
      t.portfolio_id,
      MIN(date(t.transaction_date)) AS min_txn_date,
      MAX(date(t.transaction_date)) AS max_txn_date,
      COALESCE(SUM(
        CASE
          WHEN t.transaction_type IN ('BUY', 'DEPOSIT', 'BONUS', 'SPLIT', 'IPO', 'TRANSFER_IN', 'SWITCH_IN', 'RIGHTS', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'VEST', 'ESPP_PURCHASE') THEN COALESCE(t.units, 0)
          WHEN t.transaction_type IN ('SELL', 'REDEMPTION', 'WITHDRAWAL', 'TRANSFER_OUT', 'SWITCH_OUT', 'CONSOLIDATION', 'CHARGES', 'AMC') THEN -COALESCE(t.units, 0)
          ELSE 0
        END
      ), 0) AS net_units
    FROM investments i
    JOIN transactions t ON t.investment_id = i.id
    WHERE i.asset_type = 'FOREIGN_STOCK'
      AND i.is_active != 0
      AND COALESCE(i.exclude_from_tracking, 0) != 1
      AND t.portfolio_id IS NOT NULL
      AND date(t.transaction_date) <= ?
    GROUP BY i.id, t.portfolio_id
    ORDER BY i.id ASC, t.portfolio_id ASC
  `).all(runDate);
}

function ensureForeignReconcileScopes(db, runDate, label, catchUp = null) {
  if (!ENABLE_FOREIGN_RECONCILE) {
    return {
      enabled: false,
      settlementDate: null,
      lookbackStart: null,
      enqueued: 0,
      activeScopes: 0,
    };
  }

  const settlementDate = resolveForeignSettlementDate();
  if (!settlementDate || settlementDate > runDate) {
    return {
      enabled: true,
      settlementDate,
      lookbackStart: null,
      enqueued: 0,
      activeScopes: 0,
      skipped: 'settlement-date-outside-run-window',
    };
  }

  const lookbackStart = addDays(settlementDate, -(Math.max(1, Number(FOREIGN_RECONCILE_MAX_LOOKBACK_DAYS || 10)) - 1));
  const pendingDirtyByScope = resolvePendingForeignDirtyStartByScope(db, runDate);
  const locfStartByScope = resolveLocfSignalStartByScope(db, lookbackStart, settlementDate);
  const complianceScanFloor = (() => {
    const primary = db.prepare("SELECT value FROM config WHERE key = 'compliance_scan_floor' LIMIT 1").get();
    const primaryValue = String(primary?.value || '');
    return /^\d{4}-\d{2}-\d{2}$/.test(primaryValue) ? primaryValue : null;
  })();

  const watermarkCatchUpFrom = catchUp?.catchUpFrom && /^\d{4}-\d{2}-\d{2}$/.test(String(catchUp.catchUpFrom))
    ? String(catchUp.catchUpFrom)
    : null;

  const activeScopes = resolveActiveForeignScopes(db, runDate)
    .filter((row) => Number(row.net_units || 0) > EXITED_UNITS_EPSILON);

  let enqueued = 0;
  for (const scope of activeScopes) {
    const key = `${scope.investment_id}:${scope.portfolio_id}`;
    const fallbackStart = settlementDate;
    const mergedStart = minIsoDate(
      fallbackStart,
      pendingDirtyByScope.get(key),
      locfStartByScope.get(key),
      watermarkCatchUpFrom,
      complianceScanFloor
    );
    const boundedStart = maxIsoDate(mergedStart, lookbackStart);
    const finalStart = maxIsoDate(boundedStart, String(scope.min_txn_date || boundedStart));
    if (!finalStart || finalStart > settlementDate) continue;

    const reasonParts = ['foreign-reconcile'];
    if (pendingDirtyByScope.has(key)) reasonParts.push('pending-dirty');
    if (locfStartByScope.has(key)) reasonParts.push('locf-signal');
    if (watermarkCatchUpFrom) reasonParts.push('watermark-catchup');
    if (complianceScanFloor) reasonParts.push('compliance-scan-floor');

    const dirtyDate = markScopeDirty(db, {
      investmentId: scope.investment_id,
      portfolioId: scope.portfolio_id,
      dirtyFromDate: finalStart,
      reason: reasonParts.join('|'),
      sourceEventId: `foreign-reconcile:${runDate}:${settlementDate}`,
    });
    if (dirtyDate) enqueued += 1;
  }

  logAppInfo(`[Scheduler] ${label}: Foreign reconcile scopes prepared`, {
    runDate,
    settlementDate,
    lookbackStart,
    watermarkCatchUpFrom,
    complianceScanFloor,
    activeScopes: activeScopes.length,
    pendingDirtySignals: pendingDirtyByScope.size,
    locfSignals: locfStartByScope.size,
    enqueued,
  });

  return {
    enabled: true,
    settlementDate,
    lookbackStart,
    watermarkCatchUpFrom,
    complianceScanFloor,
    activeScopes: activeScopes.length,
    pendingDirtySignals: pendingDirtyByScope.size,
    locfSignals: locfStartByScope.size,
    enqueued,
  };
}

/**
 * For investments in LOCF_LAG_RECONCILE_ASSET_TYPES whose daily_values carry a
 * LOCF price source on recent market-session days, enqueue a dirty backfill scope
 * starting from the first LOCF date so backfill will re-process those rows once
 * the real NAV/price arrives from the provider (typically 1-2 days late).
 *
 * FOREIGN_STOCK is excluded — its settlement-aware reconcile path
 * (ensureForeignReconcileScopes) handles it each scheduler cycle.
 */
function ensureMarketLinkedLocfReconcileScopes(db, runDate, label) {
  const lookbackStart = addDays(runDate, -(LOCF_RECONCILE_LOOKBACK_DAYS - 1));

  const placeholders = LOCF_LAG_RECONCILE_ASSET_TYPES.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT dv.investment_id, dv.portfolio_id, MIN(dv.date) AS locf_start
    FROM daily_values dv
    JOIN investments i ON i.id = dv.investment_id
    WHERE i.asset_type IN (${placeholders})
      AND dv.portfolio_id IS NOT NULL
      AND dv.price_source = 'LOCF'
      AND date(dv.date) >= ?
      AND date(dv.date) <= ?
    GROUP BY dv.investment_id, dv.portfolio_id
  `).all(...LOCF_LAG_RECONCILE_ASSET_TYPES, lookbackStart, runDate);

  const locfByScope = new Map();
  for (const row of rows) {
    const locfDate = String(row.locf_start || '');
    if (!isIsoWeekday(locfDate)) continue;
    const key = `${row.investment_id}:${row.portfolio_id}`;
    locfByScope.set(key, { investmentId: Number(row.investment_id), portfolioId: Number(row.portfolio_id), locfDate });
  }

  let enqueued = 0;
  for (const { investmentId, portfolioId, locfDate } of locfByScope.values()) {
    const dirtyDate = markScopeDirty(db, {
      investmentId,
      portfolioId,
      dirtyFromDate: locfDate,
      reason: 'locf-lag-reconcile',
      sourceEventId: `locf-reconcile:${runDate}`,
    });
    if (dirtyDate) enqueued += 1;
  }

  logAppInfo(`[Scheduler] ${label}: Market-linked LOCF reconcile scopes prepared`, {
    runDate,
    lookbackStart,
    assetTypes: LOCF_LAG_RECONCILE_ASSET_TYPES,
    locfScopes: locfByScope.size,
    enqueued,
  });

  return { lookbackStart, assetTypes: LOCF_LAG_RECONCILE_ASSET_TYPES, locfScopes: locfByScope.size, enqueued };
}

function fetchStockSeriesFromSource(symbol, startDate, endDate) {
  const from = new Date(`${startDate}T00:00:00.000Z`);
  from.setUTCDate(from.getUTCDate() - 7);
  const to = new Date(`${endDate}T00:00:00.000Z`);
  to.setUTCDate(to.getUTCDate() + 1);

  const p1 = Math.floor(from.getTime() / 1000);
  const p2 = Math.floor(to.getTime() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${p1}&period2=${p2}&interval=1d`;

  const https = require('https');
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const result = json.chart?.result?.[0];
          if (!result) {
            resolve([]);
            return;
          }
          const timestamps = result.timestamp || [];
          const quote = result.indicators?.quote?.[0] || {};
          const opens = quote.open || [];
          const highs = quote.high || [];
          const lows = quote.low || [];
          const closes = quote.close || [];
          const volumes = quote.volume || [];
          const rows = [];
          for (let i = 0; i < timestamps.length; i += 1) {
            const close = closes[i];
            if (close == null) continue;
            const d = istDateFromUnixSeconds(timestamps[i]);
            if (!d) continue;
            const closeNum = Number(close);
            if (!Number.isFinite(closeNum) || closeNum <= 0) continue;

            const openNumRaw = Number(opens[i]);
            const highNumRaw = Number(highs[i]);
            const lowNumRaw = Number(lows[i]);
            const volumeRaw = Number(volumes[i]);

            const openNum = Number.isFinite(openNumRaw) && openNumRaw > 0 ? openNumRaw : closeNum;
            const highNum = Number.isFinite(highNumRaw) && highNumRaw > 0 ? highNumRaw : Math.max(openNum, closeNum);
            const lowNum = Number.isFinite(lowNumRaw) && lowNumRaw > 0 ? lowNumRaw : Math.min(openNum, closeNum);
            const volumeNum = Number.isFinite(volumeRaw) && volumeRaw >= 0 ? Math.round(volumeRaw) : 0;

            rows.push({
              date: d,
              open: openNum,
              high: highNum,
              low: lowNum,
              close: closeNum,
              volume: volumeNum,
              source: 'YAHOO',
            });
          }
          resolve(rows);
        } catch (e) {
          reject(new Error(`Failed to parse stock series for ${symbol}: ${e.message}`));
        }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function warmRecentMarketCache(db, runDate, refreshDays, label) {
  if (!Number.isFinite(refreshDays) || refreshDays <= 0) {
    return { skipped: true, reason: 'disabled', refreshDays: Number(refreshDays || 0) };
  }

  const fromDate = addDays(runDate, -(refreshDays - 1));
  const dateRange = eachDate(fromDate, runDate);
  const activeRows = db.prepare(`
    SELECT
      i.id,
      i.asset_type,
      i.ticker_symbol AS symbol,
      i.amfi_code,
      SUM(
        CASE
          WHEN t.transaction_type IN ('BUY', 'DEPOSIT', 'BONUS', 'SPLIT', 'IPO', 'TRANSFER_IN', 'SWITCH_IN', 'RIGHTS', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'VEST', 'ESPP_PURCHASE') THEN COALESCE(t.units, 0)
          WHEN t.transaction_type IN ('SELL', 'REDEMPTION', 'WITHDRAWAL', 'TRANSFER_OUT', 'SWITCH_OUT', 'CONSOLIDATION', 'CHARGES', 'AMC') THEN -COALESCE(t.units, 0)
          ELSE 0
        END
      ) AS net_units
    FROM investments i
    JOIN transactions t ON t.investment_id = i.id
    WHERE date(t.transaction_date) <= ?
      AND i.asset_type IN ('INDIAN_STOCK', 'FOREIGN_STOCK', 'SGB', 'MUTUAL_FUND')
    GROUP BY i.id, i.asset_type, i.ticker_symbol, i.amfi_code
    HAVING net_units > 0
    ORDER BY i.id ASC
  `).all(runDate);

  const stockSymbols = [...new Set(
    activeRows
      .filter((r) => ['INDIAN_STOCK', 'FOREIGN_STOCK'].includes(r.asset_type) && r.symbol)
      .map((r) => String(r.symbol).trim())
      .filter(Boolean)
  )];
  const sgbSymbols = [...new Set(
    activeRows
      .filter((r) => r.asset_type === 'SGB' && r.symbol)
      .map((r) => String(r.symbol).trim())
      .filter(Boolean)
  )];
  const mfActiveRows = activeRows.filter((r) => r.asset_type === 'MUTUAL_FUND');
  const mfHistoryByInvestment = loadSymbolHistoryByInvestment(db, mfActiveRows.map((r) => r.id));
  const mutualFundWindows = [];
  for (const row of mfActiveRows) {
    const windows = buildMutualFundCodeWindows(row.id, row.amfi_code, fromDate, runDate, mfHistoryByInvestment);
    for (const window of windows) mutualFundWindows.push(window);
  }
  const amfiCodes = [...new Set(mutualFundWindows.map((w) => w.code).filter(Boolean))];
  const hasForeign = activeRows.some((r) => r.asset_type === 'FOREIGN_STOCK');

  logAppInfo(`[Scheduler] ${label}: Nightly cache warm started`, {
    runDate,
    refreshDays,
    fromDate,
    stockSymbols: stockSymbols.length,
    sgbSymbols: sgbSymbols.length,
    mutualFunds: amfiCodes.length,
    mutualFundWindows: mutualFundWindows.length,
    foreignHoldings: hasForeign,
  });

  let stockCalls = 0;
  let sgbCalls = 0;
  let mfCalls = 0;
  let fxCalls = 0;
  let errors = 0;

  for (const symbol of stockSymbols) {
    try {
      await hydrateStockSeriesForPhase2({
        instrumentType: inferStockInstrumentType(symbol),
        symbol,
        fromDate,
        toDate: runDate,
        sourceLabel: 'YAHOO',
        fetchRange: async (missingFrom, missingTo) => fetchStockSeriesFromSource(symbol, missingFrom, missingTo),
        mapFetchedRows: (fetched) => (Array.isArray(fetched) ? fetched : []),
        onWarn: (message, meta) => logAppWarn(message, meta),
        onInfo: (message, meta) => logAppInfo(message, meta),
      });
    } catch (_e) {
      errors += 1;
    }
    stockCalls += 1;
  }

  for (const symbol of sgbSymbols) {
    try {
      await getSGBNseHistoricalPrices(symbol, fromDate, runDate);
    } catch (_e) {
      errors += 1;
    }
    sgbCalls += 1;
  }

  for (const amfiCode of amfiCodes) {
    try {
      await fetchMutualFundHistory(amfiCode);
    } catch (_e) {
      errors += 1;
    }
    mfCalls += 1;
  }

  if (hasForeign) {
    for (const d of dateRange) {
      try {
        await fetchHistoricalUSDToINR(d);
      } catch (_e) {
        errors += 1;
      }
      fxCalls += 1;
    }
  }

  const summary = {
    runDate,
    refreshDays,
    fromDate,
    activeInstruments: activeRows.length,
    stockSymbols: stockSymbols.length,
    sgbSymbols: sgbSymbols.length,
    mutualFunds: amfiCodes.length,
    mutualFundWindows: mutualFundWindows.length,
    stockCalls,
    sgbCalls,
    mfCalls,
    fxCalls,
    errors,
  };

  logAppInfo(`[Scheduler] ${label}: Nightly cache warm completed`, summary);
  return summary;
}

function resolvePriceWatermark(db) {
  const cfg = db.prepare(`
    SELECT value
    FROM config
    WHERE key = 'price_update_watermark'
    LIMIT 1
  `).get();

  if (cfg?.value && /^\d{4}-\d{2}-\d{2}$/.test(String(cfg.value))) {
    return String(cfg.value);
  }

  const maxDaily = db.prepare('SELECT MAX(date) AS max_date FROM daily_values').get();
  if (maxDaily?.max_date && /^\d{4}-\d{2}-\d{2}$/.test(String(maxDaily.max_date))) {
    return String(maxDaily.max_date);
  }

  return null;
}

function ensureSchedulerCatchUpScopes(db, runDate, label) {
  const watermark = resolvePriceWatermark(db);
  if (!watermark) {
    logAppInfo(`[Scheduler] ${label}: no price watermark found; skipping gap enqueue`, { runDate });
    return { watermark: null, catchUpFrom: null, gapDays: 0, enqueued: 0 };
  }

  const catchUpFrom = addDays(watermark, 1);
  if (catchUpFrom > runDate) {
    return { watermark, catchUpFrom: null, gapDays: 0, enqueued: 0 };
  }

  const reason = 'scheduler-downtime-catchup';
  const sourceEventId = `scheduler-catchup:${runDate}`;
  const enqueued = markAllTrackedInvestmentsDirtyFromDate(db, catchUpFrom, reason, sourceEventId);
  const gapDays = diffDays(catchUpFrom, runDate) + 1;

  logAppInfo(`[Scheduler] ${label}: enqueued catch-up dirty scopes`, {
    watermark,
    catchUpFrom,
    runDate,
    gapDays,
    enqueued,
  });

  return { watermark, catchUpFrom, gapDays, enqueued };
}

/**
 * Core scheduler cycle: catch-up gap detection → dirty backfill preflight → price update.
 * Exported so it can be triggered from the API (manual "Update Prices" in the UI) in addition
 * to the cron jobs.
 *
 * @param {object} db   - better-sqlite3 database instance
 * @param {string} label - descriptive label for logging
 * @param {object} [options]
 * @param {boolean} [options.skipPriceUpdate] - run preflight only, skip actual price fetch
 * @param {string[]} [options.assetTypes]     - restrict price update to these asset types
 */
async function runSchedulerCycle(db, label, options = {}) {
  if (isSchedulerCycleRunning) {
    logAppWarn(`[Scheduler] ${label}: Skipping cycle because another scheduler cycle is already running`, {
      requestedLabel: label,
    });
    return { skipped: true, reason: 'scheduler-cycle-already-running' };
  }

  isSchedulerCycleRunning = true;
  try {
  const runDate = todayIso();
  logAppInfo(`[Scheduler] ${label}: Step 1/4 scheduler cycle started`, {
    runDate,
    options,
  });
  const preflightRunDate = runDate;

  const dirtyInvestments = db.prepare(`
    SELECT id, name, asset_type, dirty_from_date
    FROM investments
    WHERE is_dirty_daily_values = 1
    ORDER BY dirty_from_date ASC, id ASC
    LIMIT 50
  `).all();

  const pendingScopes = db.prepare(`
    SELECT id, investment_id, portfolio_id, dirty_from_date, status, dirty_reason
    FROM dirty_backfill_scope
    WHERE status IN ('pending', 'running', 'failed')
      AND dirty_from_date <= ?
    ORDER BY dirty_from_date ASC, id ASC
    LIMIT 100
  `).all(preflightRunDate);

  logAppInfo(`[Scheduler] ${label}: Step 2/4 dirty scope snapshot`, {
    preflightRunDate,
    dirtyInvestmentCount: dirtyInvestments.length,
    pendingScopeCount: pendingScopes.length,
    dirtyInvestments,
    pendingScopes,
  });

  console.log(`[Scheduler] ${label}: preflight dirty backfill check for ${preflightRunDate}...`);
  logAppInfo(`[Scheduler] ${label}: started`, {
    runDate,
    preflightRunDate,
    options,
  });

  logAppInfo(`[Scheduler] ${label}: Step 3/4 running catch-up + dirty preflight (Backfill Step-1 Cache-Warm -> Step-2 CA -> Step-3 Recompute -> Step-4 Aggregate Refresh)`, {
    preflightRunDate,
  });
  const catchUp = ensureSchedulerCatchUpScopes(db, preflightRunDate, label);
  const foreignReconcile = ensureForeignReconcileScopes(db, preflightRunDate, label, catchUp);
  const locfReconcile = ensureMarketLinkedLocfReconcileScopes(db, preflightRunDate, label);
  const preflight = await runDirtyBackfillPreflight(db, preflightRunDate);
  logAppInfo(`[Scheduler] ${label}: Step 3/4 completed (catch-up + backfill preflight)`, {
    catchUp,
    foreignReconcile,
    locfReconcile,
    preflight,
  });

  if (options.skipPriceUpdate) {
    logAppInfo(`[Scheduler] ${label}: Step 4/4 skipped price update (preflight-only)`, {
      runDate,
      preflightRunDate,
      catchUp,
      foreignReconcile,
      locfReconcile,
      preflight,
    });
    return { preflightOnly: true, catchUp, foreignReconcile, locfReconcile, preflight };
  }

  const warmRecentCacheDays = Number(options.warmRecentCacheDays || 0);
  let cacheWarm = null;

  if (warmRecentCacheDays > 0) {
    cacheWarm = await warmRecentMarketCache(db, runDate, warmRecentCacheDays, label);
  }

  logAppInfo(`[Scheduler] ${label}: Step 4/4 running updateAllPrices`, {
    assetTypes: options.assetTypes || null,
    warmRecentCacheDays: warmRecentCacheDays > 0 ? warmRecentCacheDays : null,
    historicalRepairMode: 'step1-generalized-only',
  });
  const result = await updateAllPrices(db, options);
  const refreshedScanFloor = refreshComplianceScanFloor(db, runDate);
  logAppInfo(`[Scheduler] ${label}: Step 4/4 completed`, {
    runDate,
    preflightRunDate,
    catchUp,
    foreignReconcile,
    locfReconcile,
    preflight,
    cacheWarm,
    historicalRepairMode: 'step1-generalized-only',
    processed: result?.processed || 0,
    errors: result?.errors || 0,
    watermarkUpdated: !!result?.watermarkUpdated,
    complianceScanFloor: refreshedScanFloor,
  });
  return { catchUp, foreignReconcile, locfReconcile, preflight, result };
  } finally {
    isSchedulerCycleRunning = false;
  }
}

async function runComplianceScan(db, label, options = {}) {
  try {
    const mode = options.mode || 'full';
    logAppInfo(`[Scheduler] ${label}: Running compliance scan`, { mode });
    const result = scanAndRepairComplianceGaps({ mode, db });

    logAppInfo(`[Scheduler] ${label}: Compliance scan completed`, {
      mode: result.mode,
      runDate: result.runDate,
      gapsDetected: result.gapsDetected,
      repairsEnqueued: result.repairsEnqueued,
      window: result.window,
    });
    return result;
  } catch (e) {
    console.error(`[Scheduler] ${label}: Compliance scan failed:`, e.message);
    logAppError(`[Scheduler] ${label}: Compliance scan failed`, { error: e.message });
    return null;
  }
}

function startScheduler(db) {
  // Startup should be lightweight by default. Preflight/compliance are opt-in only.
  if (ENABLE_STARTUP_PREFLIGHT) {
    setTimeout(async () => {
      try {
        await runSchedulerCycle(db, 'Startup catch-up', { skipPriceUpdate: true });
        if (ENABLE_STARTUP_COMPLIANCE) {
          await runComplianceScan(db, 'Startup catch-up', { mode: 'incremental' });
        }
        logAppInfo('[Scheduler] Startup preflight completed');
      } catch (e) {
        console.error('[Scheduler] Startup preflight failed:', e.message);
        logAppError('[Scheduler] Startup preflight failed', { error: e.message });
      }
    }, 0);
  } else {
    logAppInfo('[Scheduler] Startup preflight skipped by configuration', {
      enableStartupPreflight: ENABLE_STARTUP_PREFLIGHT,
      enableStartupCompliance: ENABLE_STARTUP_COMPLIANCE,
    });
  }

  // Hourly intraday runs (9:25 AM–4:25 PM IST, weekdays).
  // Includes MF/NPS retry polling so delayed provider NAVs can be picked up earlier
  // in the day; once yesterday's LIVE row exists, intraday provider calls are skipped.
  const intradayTimes = [
    '25 9 * * 1-5',    // 9:25 AM
    '25 10 * * 1-5',   // 10:25 AM
    '25 11 * * 1-5',   // 11:25 AM
    '25 12 * * 1-5',   // 12:25 PM
    '25 13 * * 1-5',   // 1:25 PM
    '25 14 * * 1-5',   // 2:25 PM
    '25 15 * * 1-5',   // 3:25 PM
    '25 16 * * 1-5',   // 4:25 PM
  ];

  intradayTimes.forEach((cronTime, index) => {
    cron.schedule(cronTime, async () => {
      const hour = [9, 10, 11, 12, 13, 14, 15, 16][index];
      const runDate = todayIso();
      const yesterday = addDays(runDate, -1);
      console.log(`[Scheduler] Running ${hour}:25 intraday price update (Indian stocks + SGB + MF/NPS retries)...`);
      try {
        await runSchedulerCycle(db, `Intraday run ${hour}:25`, {
          assetTypes: ['INDIAN_STOCK', 'SGB', 'MUTUAL_FUND', 'NPS'],
          reuseLiveTodayAssetTypes: ['MUTUAL_FUND', 'NPS'],
          reuseLiveDateByAssetType: {
            MUTUAL_FUND: yesterday,
            NPS: yesterday,
          },
          runTag: `intraday_${hour}_25`,
        });
        if (ENABLE_INTRADAY_COMPLIANCE) {
          await runComplianceScan(db, `Intraday run ${hour}:25`, { mode: 'incremental' });
        }
      } catch (e) {
        console.error(`[Scheduler] ${hour}:25 update failed:`, e.message);
        logAppError(`[Scheduler] Intraday run ${hour}:25 failed`, { error: e.message });
      }
    }, {
      timezone: 'Asia/Kolkata',
    });
  });

  // US-market tracking runs during the India evening window.
  // Foreign stocks refresh through the US session, while MF/NPS participate
  // only until today's record becomes LIVE so provider calls are avoided after settlement.
  const usMarketTimes = [
    '25 19 * * 1-5',  // 7:25 PM
    '25 20 * * 1-5',  // 8:25 PM
    '25 21 * * 1-5',  // 9:25 PM
    '25 23 * * 1-5',  // 11:25 PM
  ];

  usMarketTimes.forEach((cronTime, index) => {
    cron.schedule(cronTime, async () => {
      const hour = [19, 20, 21, 23][index];
      console.log(`[Scheduler] Running ${hour}:25 US-market update (foreign + conditional MF/NPS)...`);
      try {
        await runSchedulerCycle(db, `US-market run ${hour}:25`, {
          assetTypes: ['FOREIGN_STOCK', 'MUTUAL_FUND', 'NPS'],
          reuseLiveTodayAssetTypes: ['MUTUAL_FUND', 'NPS'],
          runTag: `us_market_${hour}_25`,
        });
      } catch (e) {
        console.error(`[Scheduler] ${hour}:25 US-market update failed:`, e.message);
        logAppError(`[Scheduler] US-market run ${hour}:25 failed`, { error: e.message });
      }
    }, {
      timezone: 'Asia/Kolkata',
    });
  });

  // Early-morning seed run at 4:25 AM IST (all days) - all asset types.
  // Market-linked assets are processed only on market-session days.
  cron.schedule('25 4 * * *', async () => {
    console.log('[Scheduler] Running 4:25 AM seed update (all asset types, session-aware)...');
    try {
      await runSchedulerCycle(db, 'Early morning seed run (all types)', {
        sessionOnlyForMarketLinked: true,
        runTag: 'early_morning_seed',
      });
    } catch (e) {
      console.error('[Scheduler] 4:25 AM seed update failed:', e.message);
      logAppError('[Scheduler] Early morning seed run failed', { error: e.message });
    }
  }, {
    timezone: 'Asia/Kolkata',
  });

  // Final run at 10:25 PM IST (after MF NAVs settle) - all asset types
  cron.schedule('25 22 * * 1-5', async () => {
    console.log('[Scheduler] Running 10:25 PM final price update (all asset types)...');
    try {
      await runSchedulerCycle(db, 'Final nightly run (all types)', {
        warmRecentCacheDays: NIGHTLY_MARKET_CACHE_WARM_DAYS,
        reuseLiveTodayAssetTypes: ['MUTUAL_FUND', 'NPS'],
        runTag: 'final_nightly',
      });
      await runComplianceScan(db, 'Final nightly run (all types)', { mode: 'full' });
    } catch (e) {
      console.error('[Scheduler] Final nightly update failed:', e.message);
      logAppError('[Scheduler] Final nightly run failed', { error: e.message });
    }
  }, {
    timezone: 'Asia/Kolkata',
  });

  console.log('[Scheduler] Daily price updates scheduled:');
  console.log('  - 4:25 AM IST (all asset types; market-linked only on session days, daily)');
  console.log('  - 9:25 AM–4:25 PM IST (hourly, Indian stocks + SGB + MF/NPS retries, weekdays)');
  console.log('  - 7:25 PM, 8:25 PM, 9:25 PM, 11:25 PM IST (foreign stocks + conditional MF/NPS, weekdays)');
  console.log('  - 10:25 PM IST (all asset types, weekdays)');
  logAppInfo('[Scheduler] Scheduled jobs initialized', {
    timezone: 'Asia/Kolkata',
    earlyMorningAccrualRun: '04:25',
    intradayRuns: 8,
    usMarketRuns: ['19:25', '20:25', '21:25', '23:25'],
    nightlyRun: '22:25',
    nightlyMarketCacheWarmDays: NIGHTLY_MARKET_CACHE_WARM_DAYS,
    historicalRepairMode: 'step1-generalized-only',
    foreignReconcileEnabled: ENABLE_FOREIGN_RECONCILE,
    foreignReconcileMaxLookbackDays: FOREIGN_RECONCILE_MAX_LOOKBACK_DAYS,
    foreignReconcileSettlementCutoffMinutesIst: FOREIGN_RECONCILE_SETTLEMENT_CUTOFF_MINUTES_IST,
    intradayComplianceEnabled: ENABLE_INTRADAY_COMPLIANCE,
    startupPreflightEnabled: ENABLE_STARTUP_PREFLIGHT,
    startupComplianceEnabled: ENABLE_STARTUP_COMPLIANCE,
  });
}

module.exports = { startScheduler, runSchedulerCycle };

