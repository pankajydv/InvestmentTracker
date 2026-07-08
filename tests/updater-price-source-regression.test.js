const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const Database = require('better-sqlite3');
const { initializeDb } = require('../server/db/schema');
const priceService = require('../server/services/priceService');

function addDaysIso(dateIso, days) {
  const d = new Date(`${dateIso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}

describe('Updater price source regressions', () => {
  let db;
  let tmpDir;
  let updateAllPrices;
  let originalFetchStockPrice;
  let originalFetchUSDToINR;
  let stockPriceMock;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invtrack-updater-reg-'));
    const dbPath = path.join(tmpDir, 'test.db');
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initializeDb(db);

    originalFetchStockPrice = priceService.fetchStockPrice;
    originalFetchUSDToINR = priceService.fetchUSDToINR;
    stockPriceMock = async () => {
      throw new Error('stockPriceMock not configured');
    };
    priceService.fetchStockPrice = (...args) => stockPriceMock(...args);
    priceService.fetchUSDToINR = async () => 83.5;

    delete require.cache[require.resolve('../server/services/updater')];
    ({ updateAllPrices } = require('../server/services/updater'));
  });

  afterEach(() => {
    if (db) db.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });

    priceService.fetchStockPrice = originalFetchStockPrice;
    priceService.fetchUSDToINR = originalFetchUSDToINR;
    delete require.cache[require.resolve('../server/services/updater')];
  });

  function seedInvestment({ name, assetType, ticker }) {
    const portfolio = db.prepare('INSERT INTO portfolios (name) VALUES (?)').run('P1');
    const inv = db.prepare(
      `INSERT INTO investments (name, asset_type, ticker_symbol, is_active, exclude_from_tracking)
       VALUES (?, ?, ?, 1, 0)`
    ).run(name, assetType, ticker || null);

    db.prepare(
      `INSERT INTO transactions
       (investment_id, portfolio_id, transaction_type, transaction_date, units, amount, price_per_unit, fees)
       VALUES (?, ?, 'BUY', date('now','-10 day'), 10, 10000, 1000, 0)`
    ).run(inv.lastInsertRowid, portfolio.lastInsertRowid);

    return {
      investmentId: Number(inv.lastInsertRowid),
      portfolioId: Number(portfolio.lastInsertRowid),
    };
  }

  it('does not fabricate stale provider-date LIVE rows for Indian stocks', async () => {
    const { investmentId, portfolioId } = seedInvestment({
      name: 'Angel One',
      assetType: 'INDIAN_STOCK',
      ticker: 'ANGELONE.NS',
    });

    const today = new Date().toISOString().slice(0, 10);
    const staleProviderDate = addDaysIso(today, -2);

    stockPriceMock = async () => ({
      price: 335.25,
      officialClose: 335.25,
      change: 0,
      changePercent: 0,
      date: staleProviderDate,
    });

    const result = await updateAllPrices(db, { assetTypes: ['INDIAN_STOCK'] });
    assert.equal(Number(result.errorCount || 0), 0);

    const todayRow = db.prepare(
      `SELECT date, price_per_unit, price_source
       FROM daily_values
       WHERE investment_id = ? AND portfolio_id = ? AND date = ?
       ORDER BY id DESC LIMIT 1`
    ).get(investmentId, portfolioId, today);

    assert.ok(todayRow, 'Expected updater to write today row');
    assert.equal(todayRow.price_source, 'LOCF');
    assert.ok(Number(todayRow.price_per_unit) > 0);

    const staleLiveRow = db.prepare(
      `SELECT COUNT(*) AS n
       FROM daily_values
       WHERE investment_id = ? AND portfolio_id = ? AND date = ? AND price_source = 'LIVE'`
    ).get(investmentId, portfolioId, staleProviderDate);

    assert.equal(Number(staleLiveRow?.n || 0), 0);
  });

  it('uses foreign close lane for session close and prevents random phase-lane LOCF drift', async () => {
    const { investmentId, portfolioId } = seedInvestment({
      name: 'MSFT',
      assetType: 'FOREIGN_STOCK',
      ticker: 'MSFT',
    });

    const today = new Date().toISOString().slice(0, 10);
    const sessionDate = addDaysIso(today, -1);

    stockPriceMock = async (_symbol, options = {}) => {
      if (options.interval === '1m') {
        return {
          price: 370.33,
          change: 0,
          changePercent: 0,
          date: sessionDate,
          sessionPhase: 'regular',
          sessionDateIst: sessionDate,
          officialClose: null,
        };
      }

      return {
        price: 372.97,
        change: 0,
        changePercent: 0,
        date: sessionDate,
        sessionPhase: 'regular',
        sessionDateIst: sessionDate,
        officialClose: 372.97,
      };
    };

    const result = await updateAllPrices(db, { assetTypes: ['FOREIGN_STOCK'] });
    assert.equal(Number(result.errorCount || 0), 0);

    const closeRow = db.prepare(
      `SELECT price_per_unit, price_source
       FROM daily_values
       WHERE investment_id = ? AND portfolio_id = ? AND date = ?
       ORDER BY id DESC LIMIT 1`
    ).get(investmentId, portfolioId, sessionDate);

    assert.ok(closeRow, 'Expected session-date close row');
    assert.equal(closeRow.price_source, 'LIVE');
    assert.equal(Number(closeRow.price_per_unit), 372.97);

    const todayRow = db.prepare(
      `SELECT price_per_unit, price_source
       FROM daily_values
       WHERE investment_id = ? AND portfolio_id = ? AND date = ?
       ORDER BY id DESC LIMIT 1`
    ).get(investmentId, portfolioId, today);

    assert.ok(todayRow, 'Expected today row');
    assert.equal(todayRow.price_source, 'LOCF');
    assert.equal(Number(todayRow.price_per_unit), 372.97);
  });

  it('preserves POST source across phase transitions (no LIVE->LOCF downgrade)', async () => {
    const { investmentId, portfolioId } = seedInvestment({
      name: 'MSFT',
      assetType: 'FOREIGN_STOCK',
      ticker: 'MSFT',
    });

    const today = new Date().toISOString().slice(0, 10);
    const sessionDate = addDaysIso(today, -1);

    // Step 1: First call writes POST (post-market session)
    stockPriceMock = async (_symbol, options = {}) => {
      if (options.interval === '15m') {
        return {
          price: 388.3,
          change: 0,
          changePercent: 0,
          date: sessionDate,
          sessionPhase: 'post',  // POST market phase
          sessionDateIst: sessionDate,
          officialClose: null,
        };
      }
      return {
        price: 388.3,
        change: 0,
        changePercent: 0,
        date: sessionDate,
        sessionPhase: 'post',
        sessionDateIst: sessionDate,
        officialClose: 388.3,
      };
    };

    let result = await updateAllPrices(db, { assetTypes: ['FOREIGN_STOCK'] });
    assert.equal(Number(result.errorCount || 0), 0);

    let firstRow = db.prepare(
      `SELECT price_per_unit, price_source
       FROM daily_values
       WHERE investment_id = ? AND portfolio_id = ? AND date = ?
       ORDER BY id DESC LIMIT 1`
    ).get(investmentId, portfolioId, today);

    assert.ok(firstRow, 'Expected first run to write today row');
    assert.equal(firstRow.price_source, 'POST', 'First run should write POST (from post-market session)');

    // Step 2: Second call tries to write LOCF (regular session phase)
    stockPriceMock = async (_symbol, options = {}) => {
      if (options.interval === '15m') {
        return {
          price: 388.84,
          change: 0,
          changePercent: 0,
          date: sessionDate,
          sessionPhase: 'regular',  // Market transitioned to REGULAR session
          sessionDateIst: sessionDate,
          officialClose: null,
        };
      }
      return {
        price: 388.84,
        change: 0,
        changePercent: 0,
        date: sessionDate,
        sessionPhase: 'regular',
        sessionDateIst: sessionDate,
        officialClose: 388.84,
      };
    };

    result = await updateAllPrices(db, { assetTypes: ['FOREIGN_STOCK'] });
    assert.equal(Number(result.errorCount || 0), 0);

    let secondRow = db.prepare(
      `SELECT price_per_unit, price_source
       FROM daily_values
       WHERE investment_id = ? AND portfolio_id = ? AND date = ?
       ORDER BY id DESC LIMIT 1`
    ).get(investmentId, portfolioId, today);

    assert.ok(secondRow, 'Expected second run to maintain today row');
    assert.equal(
      secondRow.price_source,
      'POST',
      'Second run should preserve POST (not downgrade to LOCF despite regular phase)'
    );
  });
});
