const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const Database = require('better-sqlite3');

const { updateDailyValues } = require('../server/services/backfillService');

// Regression: a fully-exited holding whose fractional buy/sell quantities leave a
// tiny positive floating-point unit residual (e.g. 68.528 - 68.502 - 0.026 = ~1e-14)
// must still have its trailing phantom investment_metrics_daily rows deleted on rebuild.
describe('backfill deletes trailing rows after a fractional-unit exit', () => {
  it('removes all post-exit rows despite a positive unit residual', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'invtrack-fracexit-'));
    const db = new Database(path.join(dir, 'investments.db'));
    try {
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = ON');
      require('../server/db/schema').initializeDb(db);

      const portfolioId = Number(db.prepare('INSERT INTO portfolios (name) VALUES (?)').run('Frac Exit').lastInsertRowid);
      const investmentId = Number(db.prepare(`
        INSERT INTO investments (name, asset_type, ticker_symbol, is_active, exclude_from_tracking)
        VALUES (?, 'INDIAN_STOCK', 'FRAC.NS', 1, 0)
      `).run('Frac Exit Fund').lastInsertRowid);

      const insertTxn = db.prepare(`
        INSERT INTO transactions (investment_id, portfolio_id, transaction_type, transaction_date, units, price_per_unit, amount, fees)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0)
      `);
      insertTxn.run(investmentId, portfolioId, 'BUY', '2020-01-02', 68.528, 58.37, 4000);
      insertTxn.run(investmentId, portfolioId, 'SELL', '2020-06-01', 68.502, 76.13, 5214.6);
      insertTxn.run(investmentId, portfolioId, 'SELL', '2020-06-01', 0.026, 75.77, 1.97);

      // Stale phantom rows after the exit, still valuing the old position.
      const insertDaily = db.prepare(`
        INSERT INTO investment_metrics_daily (investment_id, portfolio_id, date, price_per_unit, total_units, current_value, invested_amount, realized_proceeds, profit_loss, price_source, day_change)
        VALUES (?, ?, ?, 100, 68.528, 6852.8, 4000, 5216.57, 8069.37, 'LIVE', 0)
      `);
      for (const d of ['2020-06-02', '2020-06-05', '2020-08-01', '2020-12-01']) {
        insertDaily.run(investmentId, portfolioId, d);
      }

      const investment = db.prepare('SELECT * FROM investments WHERE id = ?').get(investmentId);
      await updateDailyValues(db, {
        scopeList: [{
          investment_id: investmentId,
          portfolio_id: portfolioId,
          dirty_from_date: '2020-06-01',
          requested_dirty_from_date: '2020-06-01',
        }],
        runDate: '2020-12-31',
        invMap: new Map([[investmentId, investment]]),
        cache: {},
      });

      const trailing = db.prepare(`
        SELECT COUNT(*) AS c FROM investment_metrics_daily
        WHERE investment_id = ? AND portfolio_id = ? AND date > '2020-06-01'
      `).get(investmentId, portfolioId).c;
      assert.equal(trailing, 0, 'no investment_metrics_daily rows should remain after the exit date');
    } finally {
      db.close();
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows EBUSY */ }
    }
  });
});
