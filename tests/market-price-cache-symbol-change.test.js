const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// Isolate the cache DB: DATA_DIR is captured at module load in db/setup, so it
// must be set before requiring marketPriceCache.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invtrack-mpc-symbol-'));
process.env.DATA_DIR = tmpDir;
process.env.APP_MODE = 'test';

const Database = require('better-sqlite3');
const { upsertInvestmentPriceSeries } = require('../server/services/marketPriceCache');

describe('market_price_cache symbol change does not abort on (investment_id, date)', () => {
  after(() => {
    // The module keeps the cache DB connection open; best-effort cleanup.
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore EBUSY on Windows; OS reclaims the temp dir later.
    }
  });

  it('replaces a stale-symbol row for the same investment and date without throwing', () => {
    const investmentId = 4242;
    const date = '2020-01-01';

    upsertInvestmentPriceSeries(investmentId, 'MUTUAL_FUND', 'OLD_CODE', [{ date, close: 100 }], 'TEST');

    // Same investment and date, different symbol — previously threw
    // "UNIQUE constraint failed: market_price_cache.investment_id, ...".
    assert.doesNotThrow(() => {
      upsertInvestmentPriceSeries(investmentId, 'MUTUAL_FUND', 'NEW_CODE', [{ date, close: 110 }], 'TEST');
    });

    const readDb = new Database(path.join(tmpDir, 'investments.db'), { readonly: true });
    try {
      const rows = readDb.prepare(
        'SELECT symbol, close FROM market_price_cache WHERE investment_id = ? AND date = ? ORDER BY symbol'
      ).all(investmentId, date);
      assert.equal(rows.length, 1, 'exactly one price row per investment per date');
      assert.equal(rows[0].symbol, 'NEW_CODE');
      assert.equal(rows[0].close, 110);
    } finally {
      readDb.close();
    }
  });
});
