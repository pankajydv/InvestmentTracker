const { fetchMutualFundHistory, fetchHistoricalOHLC, fetchHistoricalUSDToINRRange } = require('./priceService');
const { getSGBHistoricalPrices } = require('./sgbBhavcopy');
const {
  claimPendingBatch,
  markCompleted,
  markFailed,
  markRetryPending,
  summarizeRepairQueue,
} = require('./historicalPriceRepairService');
const { logAppInfo, logAppError } = require('./appLogger');

function normalizeDate(value) {
  if (!value) return null;
  const d = String(value).split('T')[0];
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
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

async function processStockScope(symbol, fromDate, toDate) {
  const dates = eachDate(fromDate, toDate);
  let ok = 0;
  for (const d of dates) {
    try {
      await fetchHistoricalOHLC(symbol, d);
      ok += 1;
    } catch (_) {
      // Best effort. We validate aggregate success after loop.
    }
  }
  if (ok === 0) {
    throw new Error(`No stock prices fetched for ${symbol} in range ${fromDate}..${toDate}`);
  }
  return { attemptedDays: dates.length, successfulDays: ok };
}

async function processFxScope(fromDate, toDate) {
  const summary = await fetchHistoricalUSDToINRRange(fromDate, toDate);
  if (!summary || Number(summary.successfulDays || 0) === 0) {
    throw new Error(`No FX rates fetched in range ${fromDate}..${toDate}`);
  }
  return summary;
}

async function processScope(scope) {
  const instrumentType = String(scope.instrument_type || '').toUpperCase();
  const symbol = String(scope.symbol || '').trim();
  const fromDate = normalizeDate(scope.from_date);
  const toDate = normalizeDate(scope.to_date);

  if (!instrumentType || !symbol || !fromDate || !toDate) {
    throw new Error(`Invalid scope payload id=${scope.id}`);
  }

  const fetchContext = {
    id: scope.id,
    instrumentType,
    symbol,
    fromDate,
    toDate,
    attempts: scope.attempts,
  };

  if (instrumentType === 'INDIAN_STOCK' || instrumentType === 'FOREIGN_STOCK') {
    logAppInfo('[HistPriceRepairWorker] scope event: starting stock historical fetch', fetchContext);
    return processStockScope(symbol, fromDate, toDate);
  }

  if (instrumentType === 'SGB') {
    logAppInfo('[HistPriceRepairWorker] scope event: starting SGB bhavcopy fetch', fetchContext);
    const points = await getSGBHistoricalPrices(symbol, fromDate, toDate);
    if (!points || points.size === 0) {
      throw new Error(`No SGB prices fetched for ${symbol} in range ${fromDate}..${toDate}`);
    }
    return { successfulDays: points.size };
  }

  if (instrumentType === 'MUTUAL_FUND') {
    logAppInfo('[HistPriceRepairWorker] scope event: starting mutual fund history fetch', fetchContext);
    const history = await fetchMutualFundHistory(symbol);
    if (!Array.isArray(history) || history.length === 0) {
      throw new Error(`No mutual fund history fetched for ${symbol}`);
    }
    return { totalHistoryRows: history.length };
  }

  if (instrumentType === 'FX') {
    logAppInfo('[HistPriceRepairWorker] scope event: starting FX USDINR range fetch', fetchContext);
    return processFxScope(fromDate, toDate);
  }

  throw new Error(`Unsupported instrument_type=${instrumentType}`);
}

async function runHistoricalPriceRepairWorker(db, options = {}) {
  const batchSize = Math.max(1, Math.min(100, Number(options.batchSize) || 10));
  const maxAttempts = Math.max(1, Math.min(10, Number(options.maxAttempts) || 3));
  const label = options.label || 'Scheduler';

  const claimed = claimPendingBatch(db, batchSize);
  if (!claimed.length) {
    const queue = summarizeRepairQueue(db);
    return {
      label,
      batchSize,
      maxAttempts,
      claimed: 0,
      completed: 0,
      retried: 0,
      failed: 0,
      queue,
    };
  }

  logAppInfo(`[HistPriceRepairWorker] ${label}: claimed scopes`, {
    claimed: claimed.length,
    batchSize,
    maxAttempts,
  });

  let completed = 0;
  let retried = 0;
  let failed = 0;

  for (const scope of claimed) {
    const startedAt = Date.now();
    const scopeContext = {
      id: scope.id,
      instrumentType: scope.instrument_type,
      symbol: scope.symbol,
      fromDate: scope.from_date,
      toDate: scope.to_date,
      attempts: scope.attempts,
    };

    logAppInfo(`[HistPriceRepairWorker] ${label}: scope started`, scopeContext);

    try {
      const details = await processScope(scope);
      markCompleted(db, scope.id);
      completed += 1;
      logAppInfo(`[HistPriceRepairWorker] ${label}: scope completed`, {
        ...scopeContext,
        elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
        details,
      });
    } catch (e) {
      const message = e?.message || String(e);
      const attempts = Number(scope.attempts || 0);
      if (attempts < maxAttempts) {
        markRetryPending(db, scope.id, message);
        retried += 1;
        logAppError(`[HistPriceRepairWorker] ${label}: scope requeued`, {
          ...scopeContext,
          elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
          attempts,
          maxAttempts,
          error: message,
        });
      } else {
        markFailed(db, scope.id, message);
        failed += 1;
        logAppError(`[HistPriceRepairWorker] ${label}: scope failed`, {
          ...scopeContext,
          elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
          attempts,
          maxAttempts,
          error: message,
        });
      }
    }
  }

  const queue = summarizeRepairQueue(db);
  const summary = {
    label,
    batchSize,
    maxAttempts,
    claimed: claimed.length,
    completed,
    retried,
    failed,
    queue,
  };

  logAppInfo(`[HistPriceRepairWorker] ${label}: batch completed`, summary);
  return summary;
}

module.exports = {
  runHistoricalPriceRepairWorker,
};
