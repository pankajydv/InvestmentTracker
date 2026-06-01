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
const { runDirtyBackfillPreflight, markAllTrackedInvestmentsDirtyFromDate } = require('./dirtyBackfillService');
const {
  fetchMutualFundHistory,
  fetchHistoricalUSDToINR,
} = require('./priceService');
const { getSGBHistoricalPrices } = require('./sgbBhavcopy');
const { hydrateStockSeriesForPhase2 } = require('./marketPriceCache');
const { todayIso } = require('./dateUtils');
const { logAppInfo, logAppWarn, logAppError } = require('./appLogger');
const { scanAndRepairComplianceGaps } = require('./compliance/complianceScanService');
const { auditHistoricalPriceCoverage } = require('./historicalPriceAuditService');
const { runHistoricalPriceRepairWorker } = require('./historicalPriceRepairWorkerService');

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

const INTRADAY_BACKFILL_MAX_SCOPES = parsePositiveIntEnv('INTRADAY_BACKFILL_MAX_SCOPES', 25);
const ENABLE_INTRADAY_COMPLIANCE = String(process.env.ENABLE_INTRADAY_COMPLIANCE || 'false').toLowerCase() === 'true';
const ENABLE_STARTUP_COMPLIANCE = String(process.env.ENABLE_STARTUP_COMPLIANCE || 'false').toLowerCase() === 'true';
const ENABLE_STARTUP_PREFLIGHT = String(process.env.ENABLE_STARTUP_PREFLIGHT || 'false').toLowerCase() === 'true';
const NIGHTLY_MARKET_CACHE_WARM_DAYS = parseNonNegativeIntEnv('NIGHTLY_MARKET_CACHE_WARM_DAYS', 5);
const ENABLE_HISTORICAL_PRICE_AUDIT = parseBooleanEnv('ENABLE_HISTORICAL_PRICE_AUDIT', true);
const HISTORICAL_PRICE_AUDIT_DRY_RUN = false;
const HISTORICAL_PRICE_AUDIT_WINDOW_DAYS = parsePositiveIntEnv('HISTORICAL_PRICE_AUDIT_WINDOW_DAYS', 5);
const ENABLE_HISTORICAL_PRICE_REPAIR_WORKER = parseBooleanEnv('ENABLE_HISTORICAL_PRICE_REPAIR_WORKER', true);
const HISTORICAL_PRICE_REPAIR_BATCH_SIZE = parsePositiveIntEnv('HISTORICAL_PRICE_REPAIR_BATCH_SIZE', 10);
const HISTORICAL_PRICE_REPAIR_MAX_ATTEMPTS = parsePositiveIntEnv('HISTORICAL_PRICE_REPAIR_MAX_ATTEMPTS', 3);

let isHistoricalPriceRepairWorkerRunning = false;

function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

function diffDays(startIso, endIso) {
  const startMs = new Date(`${startIso}T00:00:00.000Z`).getTime();
  const endMs = new Date(`${endIso}T00:00:00.000Z`).getTime();
  return Math.max(Math.floor((endMs - startMs) / 86400000), 0);
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

function inferStockInstrumentType(symbol) {
  return /\.(NS|BO)$/i.test(String(symbol || '')) ? 'INDIAN_STOCK' : 'FOREIGN_STOCK';
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
          const closes = result.indicators?.quote?.[0]?.close || [];
          const rows = [];
          for (let i = 0; i < timestamps.length; i += 1) {
            const close = closes[i];
            if (close == null) continue;
            const d = new Date(timestamps[i] * 1000).toISOString().split('T')[0];
            rows.push({ date: d, close: Number(close), source: 'YAHOO' });
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
  const amfiCodes = [...new Set(
    activeRows
      .filter((r) => r.asset_type === 'MUTUAL_FUND' && r.amfi_code)
      .map((r) => String(r.amfi_code).trim())
      .filter(Boolean)
  )];
  const hasForeign = activeRows.some((r) => r.asset_type === 'FOREIGN_STOCK');

  logAppInfo(`[Scheduler] ${label}: Nightly cache warm started`, {
    runDate,
    refreshDays,
    fromDate,
    stockSymbols: stockSymbols.length,
    sgbSymbols: sgbSymbols.length,
    mutualFunds: amfiCodes.length,
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
      await getSGBHistoricalPrices(symbol, fromDate, runDate);
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

  logAppInfo(`[Scheduler] ${label}: Step 3/4 running catch-up + dirty preflight`, {
    preflightRunDate,
  });
  const catchUp = ensureSchedulerCatchUpScopes(db, preflightRunDate, label);
  const preflight = await runDirtyBackfillPreflight(db, preflightRunDate, {
    maxScopes: options.backfillMaxScopes,
  });
  logAppInfo(`[Scheduler] ${label}: Step 3/4 completed`, {
    catchUp,
    preflight,
  });

  if (options.skipPriceUpdate) {
    logAppInfo(`[Scheduler] ${label}: Step 4/4 skipped price update (preflight-only)`, {
      runDate,
      preflightRunDate,
      catchUp,
      preflight,
    });
    return { preflightOnly: true, catchUp, preflight };
  }

  const warmRecentCacheDays = Number(options.warmRecentCacheDays || 0);
  let cacheWarm = null;
  let historicalPriceAudit = null;
  let historicalPriceRepair = null;

  const runHistoricalPriceAudit = options.enableHistoricalPriceAudit !== false;
  if (runHistoricalPriceAudit && ENABLE_HISTORICAL_PRICE_AUDIT) {
    try {
      historicalPriceAudit = await auditHistoricalPriceCoverage(db, {
        runDate,
        recentWindowDays: Number(options.historicalPriceAuditWindowDays || HISTORICAL_PRICE_AUDIT_WINDOW_DAYS),
        dryRun: options.historicalPriceAuditDryRun !== false ? HISTORICAL_PRICE_AUDIT_DRY_RUN : false,
        sourceEventId: `scheduler-audit:${runDate}:${label}`,
      });
      logAppInfo(`[Scheduler] ${label}: Historical price audit completed`, historicalPriceAudit);
    } catch (auditError) {
      logAppError(`[Scheduler] ${label}: Historical price audit failed`, {
        error: auditError?.message || String(auditError),
      });
    }
  }

  const runHistoricalPriceRepairWorkerNow = options.enableHistoricalPriceRepairWorker !== false;
  if (runHistoricalPriceRepairWorkerNow && ENABLE_HISTORICAL_PRICE_REPAIR_WORKER) {
    if (isHistoricalPriceRepairWorkerRunning) {
      logAppInfo(`[Scheduler] ${label}: Historical price repair worker already running, skipping this cycle`, {
        batchSize: Number(options.historicalPriceRepairBatchSize || HISTORICAL_PRICE_REPAIR_BATCH_SIZE),
      });
    } else {
      isHistoricalPriceRepairWorkerRunning = true;
      try {
        historicalPriceRepair = await runHistoricalPriceRepairWorker(db, {
          batchSize: Number(options.historicalPriceRepairBatchSize || HISTORICAL_PRICE_REPAIR_BATCH_SIZE),
          maxAttempts: Number(options.historicalPriceRepairMaxAttempts || HISTORICAL_PRICE_REPAIR_MAX_ATTEMPTS),
          label,
        });
      } catch (repairError) {
        logAppError(`[Scheduler] ${label}: Historical price repair worker failed`, {
          error: repairError?.message || String(repairError),
        });
      } finally {
        isHistoricalPriceRepairWorkerRunning = false;
      }
    }
  }

  if (warmRecentCacheDays > 0) {
    cacheWarm = await warmRecentMarketCache(db, runDate, warmRecentCacheDays, label);
  }

  logAppInfo(`[Scheduler] ${label}: Step 4/4 running updateAllPrices`, {
    assetTypes: options.assetTypes || null,
    warmRecentCacheDays: warmRecentCacheDays > 0 ? warmRecentCacheDays : null,
    historicalPriceAuditEnabled: runHistoricalPriceAudit && ENABLE_HISTORICAL_PRICE_AUDIT,
    historicalPriceAuditDryRun: HISTORICAL_PRICE_AUDIT_DRY_RUN,
    historicalPriceRepairWorkerEnabled: runHistoricalPriceRepairWorkerNow && ENABLE_HISTORICAL_PRICE_REPAIR_WORKER,
    historicalPriceRepairBatchSize: HISTORICAL_PRICE_REPAIR_BATCH_SIZE,
  });
  const result = await updateAllPrices(db, options);
  logAppInfo(`[Scheduler] ${label}: Step 4/4 completed`, {
    runDate,
    preflightRunDate,
    catchUp,
    preflight,
    historicalPriceAudit,
    historicalPriceRepair,
    cacheWarm,
    processed: result?.processed || 0,
    errors: result?.errors || 0,
    watermarkUpdated: !!result?.watermarkUpdated,
  });
  return { catchUp, preflight, historicalPriceAudit, historicalPriceRepair, result };
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

  // Hourly intraday runs (9:25 AM–4:25 PM IST, weekdays) - stocks only
  // These capture intraday stock price movements while MF NAVs are still static
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
      console.log(`[Scheduler] Running ${hour}:25 intraday price update (stocks only)...`);
      try {
        await runSchedulerCycle(db, `Intraday run ${hour}:25`, {
          assetTypes: ['INDIAN_STOCK', 'FOREIGN_STOCK'],
          backfillMaxScopes: INTRADAY_BACKFILL_MAX_SCOPES,
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
  console.log('  - 9:25 AM–4:25 PM IST (hourly, stocks only, weekdays)');
  console.log('  - 10:25 PM IST (all asset types, weekdays)');
  logAppInfo('[Scheduler] Scheduled jobs initialized', {
    timezone: 'Asia/Kolkata',
    earlyMorningAccrualRun: '04:25',
    intradayRuns: 8,
    nightlyRun: '22:25',
    intradayBackfillMaxScopes: INTRADAY_BACKFILL_MAX_SCOPES,
    nightlyMarketCacheWarmDays: NIGHTLY_MARKET_CACHE_WARM_DAYS,
    historicalPriceAuditEnabled: ENABLE_HISTORICAL_PRICE_AUDIT,
    historicalPriceAuditWindowDays: HISTORICAL_PRICE_AUDIT_WINDOW_DAYS,
    historicalPriceAuditDryRun: HISTORICAL_PRICE_AUDIT_DRY_RUN,
    historicalPriceRepairWorkerEnabled: ENABLE_HISTORICAL_PRICE_REPAIR_WORKER,
    historicalPriceRepairBatchSize: HISTORICAL_PRICE_REPAIR_BATCH_SIZE,
    historicalPriceRepairMaxAttempts: HISTORICAL_PRICE_REPAIR_MAX_ATTEMPTS,
    intradayComplianceEnabled: ENABLE_INTRADAY_COMPLIANCE,
    startupPreflightEnabled: ENABLE_STARTUP_PREFLIGHT,
    startupComplianceEnabled: ENABLE_STARTUP_COMPLIANCE,
  });
}

module.exports = { startScheduler, runSchedulerCycle };

