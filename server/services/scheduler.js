/**
 * Cron scheduler for daily price updates.
 * Intraday runs (9:25 AM–4:25 PM) focus on stocks (frequent updates).
 * Final run (10:25 PM) updates all asset types after MF NAVs settle.
 */

const cron = require('node-cron');
const { updateAllPrices } = require('./updater');
const { runDirtyBackfillPreflight } = require('./dirtyBackfillService');
const { todayIso } = require('./backfillService');

function startScheduler(db) {
  const runScheduledUpdate = async (label, options = {}) => {
    const runDate = todayIso();
    console.log(`[Scheduler] ${label}: preflight dirty backfill check for ${runDate}...`);
    await runDirtyBackfillPreflight(db, runDate);
    await updateAllPrices(db, options);
  };

  // Startup catch-up: ensure pending dirty scopes are reconciled even before first cron tick.
  setTimeout(async () => {
    try {
      await runDirtyBackfillPreflight(db, todayIso());
    } catch (e) {
      console.error('[Scheduler] Startup preflight failed:', e.message);
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
        await runScheduledUpdate(`Intraday run ${hour}:25`, {
          assetTypes: ['INDIAN_STOCK', 'FOREIGN_STOCK'],
        });
      } catch (e) {
        console.error(`[Scheduler] ${hour}:25 update failed:`, e.message);
      }
    }, {
      timezone: 'Asia/Kolkata',
    });
  });

  // Final run at 10:25 PM IST (after MF NAVs settle) - all asset types
  cron.schedule('25 22 * * 1-5', async () => {
    console.log('[Scheduler] Running 10:25 PM final price update (all asset types)...');
    try {
      await runScheduledUpdate('Final nightly run (all types)');
    } catch (e) {
      console.error('[Scheduler] Final nightly update failed:', e.message);
    }
  }, {
    timezone: 'Asia/Kolkata',
  });

  console.log('[Scheduler] Daily price updates scheduled:');
  console.log('  - 9:25 AM–4:25 PM IST (hourly, stocks only, weekdays)');
  console.log('  - 10:25 PM IST (all asset types, weekdays)');
}

module.exports = { startScheduler };
