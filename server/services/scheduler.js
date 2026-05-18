/**
 * Cron scheduler for daily price updates.
 * Intraday runs (9:25 AM–4:25 PM) focus on stocks (frequent updates).
 * Final run (10:25 PM) updates all asset types after MF NAVs settle.
 */

const cron = require('node-cron');
const { updateAllPrices } = require('./updater');
const { runDirtyBackfillPreflight, markAllTrackedInvestmentsDirtyFromDate } = require('./dirtyBackfillService');
const { todayIso } = require('./dateUtils');
const { logAppInfo, logAppError } = require('./appLogger');

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
  const preflight = await runDirtyBackfillPreflight(db, preflightRunDate);
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

  logAppInfo(`[Scheduler] ${label}: Step 4/4 running updateAllPrices`, {
    assetTypes: options.assetTypes || null,
  });
  const result = await updateAllPrices(db, options);
  logAppInfo(`[Scheduler] ${label}: Step 4/4 completed`, {
    runDate,
    preflightRunDate,
    catchUp,
    preflight,
    processed: result?.processed || 0,
    errors: result?.errors || 0,
    watermarkUpdated: !!result?.watermarkUpdated,
  });
  return { catchUp, preflight, result };
}

function startScheduler(db) {
  // Startup catch-up: ensure pending dirty scopes are reconciled even before first cron tick.
  setTimeout(async () => {
    try {
      await runSchedulerCycle(db, 'Startup catch-up', { skipPriceUpdate: true });
      logAppInfo('[Scheduler] Startup preflight completed');
    } catch (e) {
      console.error('[Scheduler] Startup preflight failed:', e.message);
      logAppError('[Scheduler] Startup preflight failed', { error: e.message });
    }
  }, 0);

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
        });
      } catch (e) {
        console.error(`[Scheduler] ${hour}:25 update failed:`, e.message);
        logAppError(`[Scheduler] Intraday run ${hour}:25 failed`, { error: e.message });
      }
    }, {
      timezone: 'Asia/Kolkata',
    });
  });

  // Final run at 10:25 PM IST (after MF NAVs settle) - all asset types
  cron.schedule('25 22 * * 1-5', async () => {
    console.log('[Scheduler] Running 10:25 PM final price update (all asset types)...');
    try {
      await runSchedulerCycle(db, 'Final nightly run (all types)');
    } catch (e) {
      console.error('[Scheduler] Final nightly update failed:', e.message);
      logAppError('[Scheduler] Final nightly run failed', { error: e.message });
    }
  }, {
    timezone: 'Asia/Kolkata',
  });

  console.log('[Scheduler] Daily price updates scheduled:');
  console.log('  - 9:25 AM–4:25 PM IST (hourly, stocks only, weekdays)');
  console.log('  - 10:25 PM IST (all asset types, weekdays)');
  logAppInfo('[Scheduler] Scheduled jobs initialized', {
    timezone: 'Asia/Kolkata',
    intradayRuns: 8,
    nightlyRun: '22:25',
  });
}

module.exports = { startScheduler, runSchedulerCycle };

