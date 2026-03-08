/**
 * Cron scheduler for daily price updates.
 * Runs at 6:30 PM IST (after Indian market close) on weekdays.
 */

const cron = require('node-cron');
const { updateAllPrices } = require('./updater');

function startScheduler(db) {
  // Run at 6:30 PM IST (13:00 UTC) on weekdays (Mon-Fri)
  // Indian markets close at 3:30 PM, NAVs are usually available by 6 PM
  cron.schedule('0 18 * * 1-5', async () => {
    console.log('[Scheduler] Running scheduled price update...');
    try {
      await updateAllPrices(db);
    } catch (e) {
      console.error('[Scheduler] Price update failed:', e.message);
    }
  }, {
    timezone: 'Asia/Kolkata',
  });

  // Also run at 10 PM IST for foreign stock updates (US market closes ~7 AM IST next day)
  cron.schedule('0 22 * * 1-5', async () => {
    console.log('[Scheduler] Running evening price update for foreign stocks...');
    try {
      await updateAllPrices(db);
    } catch (e) {
      console.error('[Scheduler] Evening update failed:', e.message);
    }
  }, {
    timezone: 'Asia/Kolkata',
  });

  console.log('[Scheduler] Daily price update scheduled at 6:30 PM & 10:00 PM IST (weekdays)');
}

module.exports = { startScheduler };
