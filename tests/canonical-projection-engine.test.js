const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');

const { rebuildCanonicalProjections } = require('../server/services/canonicalProjectionEngine');

// Builds a minimal in-memory DB with the tables the engine reads and writes.
function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE portfolios (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE investments (
      id INTEGER PRIMARY KEY, asset_type TEXT, exclude_from_tracking INTEGER DEFAULT 0
    );
    CREATE TABLE transactions (
      id INTEGER PRIMARY KEY, investment_id INTEGER, portfolio_id INTEGER,
      transaction_type TEXT, transaction_date TEXT, amount REAL, fees REAL, units REAL
    );
    CREATE TABLE investment_metrics_daily (
      id INTEGER PRIMARY KEY, investment_id INTEGER, portfolio_id INTEGER, date TEXT,
      price_per_unit REAL, current_value REAL, invested_amount REAL DEFAULT 0,
      realized_proceeds REAL DEFAULT 0, profit_loss REAL DEFAULT 0,
      day_change REAL DEFAULT 0, price_source TEXT DEFAULT 'LIVE'
    );
    CREATE TABLE portfolio_expenses (id INTEGER PRIMARY KEY, portfolio_id INTEGER, expense_date TEXT, amount REAL);
    CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE asset_metrics_daily (
      id INTEGER PRIMARY KEY AUTOINCREMENT, portfolio_id INTEGER, asset_type TEXT NOT NULL, date TEXT NOT NULL,
      current_value REAL NOT NULL, attribution_basis REAL NOT NULL, attribution_proceeds REAL NOT NULL DEFAULT 0,
      profit_loss_before_portfolio_expenses REAL NOT NULL, day_change REAL NOT NULL DEFAULT 0,
      calculation_version INTEGER NOT NULL, source_data_version INTEGER, updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(portfolio_id, asset_type, date, calculation_version)
    );
    CREATE TABLE portfolio_metrics_daily (
      id INTEGER PRIMARY KEY AUTOINCREMENT, portfolio_id INTEGER, date TEXT NOT NULL, current_value REAL NOT NULL,
      net_invested REAL NOT NULL, realized_proceeds REAL NOT NULL DEFAULT 0, total_profit_loss REAL NOT NULL, total_day_change REAL NOT NULL DEFAULT 0,
      calculation_version INTEGER NOT NULL, source_data_version INTEGER, updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(portfolio_id, date, calculation_version)
    );
  `);

  db.prepare('INSERT INTO portfolios (id, name) VALUES (1, ?)').run('P1');
  // inv1 non-provident, inv2 provident, inv3 excluded.
  db.prepare('INSERT INTO investments (id, asset_type, exclude_from_tracking) VALUES (1, ?, 0)').run('STOCK');
  db.prepare('INSERT INTO investments (id, asset_type, exclude_from_tracking) VALUES (2, ?, 0)').run('PF');
  db.prepare('INSERT INTO investments (id, asset_type, exclude_from_tracking) VALUES (3, ?, 1)').run('STOCK');

  const tx = db.prepare('INSERT INTO transactions (investment_id, portfolio_id, transaction_type, transaction_date, amount, fees, units) VALUES (?,?,?,?,?,?,?)');
  tx.run(1, 1, 'BUY', '2026-01-01', 1000, 0, 10);
  tx.run(1, 1, 'SELL', '2026-01-03', 500, 0, 4);
  tx.run(2, 1, 'DEPOSIT', '2026-01-01', 1000, 0, 0);
  tx.run(2, 1, 'WITHDRAWAL', '2026-01-03', 200, 0, 0);
  tx.run(3, 1, 'BUY', '2026-01-01', 5000, 0, 50); // excluded investment, must be ignored

  const dv = db.prepare('INSERT INTO investment_metrics_daily (investment_id, portfolio_id, date, price_per_unit, current_value) VALUES (?,?,?,?,?)');
  dv.run(1, 1, '2026-01-01', 100, 1000);
  dv.run(1, 1, '2026-01-02', 110, 1100);
  dv.run(1, 1, '2026-01-03', 116.67, 700);
  dv.run(2, 1, '2026-01-01', 1, 1000);
  dv.run(2, 1, '2026-01-02', 1, 1010);
  dv.run(2, 1, '2026-01-03', 1, 820);
  dv.run(3, 1, '2026-01-01', 100, 5000);

  db.prepare('INSERT INTO portfolio_expenses (portfolio_id, expense_date, amount) VALUES (1, ?, 50)').run('2026-01-02');
  return db;
}

const round2 = (v) => Math.round(Number(v) * 100) / 100;

test('excluded investments get per-investment rows but stay out of aggregates', () => {
  const db = makeDb();
  const result = rebuildCanonicalProjections(db);
  assert.equal(result.investmentRowCount, 7, 'inv1 (3 days) + inv2 (3 days) + inv3 excluded (1 day)');
  assert.equal(result.invariantViolationCount, 0);
  // Excluded inv3 still gets canonical accounting written onto its investment_metrics_daily row.
  const inv3 = db.prepare("SELECT invested_amount, profit_loss FROM investment_metrics_daily WHERE investment_id = 3 AND date = '2026-01-01'").get();
  assert.equal(round2(inv3.invested_amount), 5000, 'excluded inv3 basis is canonical');
  assert.equal(round2(inv3.profit_loss), 0, 'cv 5000 - basis 5000');
  // It must NOT enter aggregates: STOCK current_value on 01-01 is inv1 only (1000), not inv1+inv3 (6000).
  const stock0101 = db.prepare("SELECT current_value FROM asset_metrics_daily WHERE portfolio_id = 1 AND asset_type = 'STOCK' AND date = '2026-01-01'").get();
  assert.equal(round2(stock0101.current_value), 1000, 'excluded inv3 must not inflate the STOCK aggregate');
  db.close();
});

test('non-provident investment: basis, proceeds, and uniform target P&L', () => {
  const db = makeDb();
  rebuildCanonicalProjections(db);
  const rows = db.prepare("SELECT date, invested_amount AS attribution_basis, realized_proceeds AS attribution_proceeds, profit_loss FROM investment_metrics_daily WHERE investment_id = 1 ORDER BY date").all();
  assert.deepEqual(rows.map((r) => round2(r.profit_loss)), [0, 100, 200]);
  assert.deepEqual(rows.map((r) => round2(r.attribution_proceeds)), [0, 0, 500]);
  db.close();
});

test('provident investment: withdrawal counts as proceeds in the target P&L', () => {
  const db = makeDb();
  rebuildCanonicalProjections(db);
  const last = db.prepare("SELECT invested_amount AS attribution_basis, realized_proceeds AS attribution_proceeds, profit_loss FROM investment_metrics_daily WHERE investment_id = 2 AND date = '2026-01-03'").get();
  assert.equal(round2(last.attribution_basis), 1000);
  assert.equal(round2(last.attribution_proceeds), 200);
  // target: cv(820) + proceeds(200) - basis(1000) = 20
  assert.equal(round2(last.profit_loss), 20);
  db.close();
});

test('portfolio aggregation applies expenses and honors the net_invested identity', () => {
  const db = makeDb();
  rebuildCanonicalProjections(db);
  const rows = db.prepare('SELECT date, current_value, net_invested, realized_proceeds, total_profit_loss FROM portfolio_metrics_daily WHERE portfolio_id = 1 ORDER BY date').all();
  // 01-01: pl 0; 01-02: cv2110 - basis2000 - expense50 = 60; 01-03: cv1520 + proceeds700 - basis2000 - expense50 = 170
  assert.deepEqual(rows.map((r) => round2(r.total_profit_loss)), [0, 60, 170]);
  assert.equal(round2(rows[2].net_invested), 1300); // basis 2000 - proceeds 700
  assert.equal(round2(rows[2].realized_proceeds), 700); // 500 (sell) + 200 (withdrawal)
  // invariant: total_profit_loss = current_value - net_invested - expenses(50)
  assert.equal(round2(rows[2].current_value - rows[2].net_invested - 50), round2(rows[2].total_profit_loss));
  db.close();
});

test('combined (NULL portfolio) row equals the single portfolio total', () => {
  const db = makeDb();
  rebuildCanonicalProjections(db);
  const combined = db.prepare("SELECT total_profit_loss FROM portfolio_metrics_daily WHERE portfolio_id IS NULL AND date = '2026-01-03'").get();
  const p1 = db.prepare("SELECT total_profit_loss FROM portfolio_metrics_daily WHERE portfolio_id = 1 AND date = '2026-01-03'").get();
  assert.equal(round2(combined.total_profit_loss), round2(p1.total_profit_loss));
  db.close();
});

test('asset-type rows reproduce each investment attribution before expenses', () => {
  const db = makeDb();
  rebuildCanonicalProjections(db);
  const stock = db.prepare("SELECT profit_loss_before_portfolio_expenses FROM asset_metrics_daily WHERE portfolio_id = 1 AND asset_type = 'STOCK' AND date = '2026-01-03'").get();
  const pf = db.prepare("SELECT profit_loss_before_portfolio_expenses FROM asset_metrics_daily WHERE portfolio_id = 1 AND asset_type = 'PF' AND date = '2026-01-03'").get();
  assert.equal(round2(stock.profit_loss_before_portfolio_expenses), 200);
  assert.equal(round2(pf.profit_loss_before_portfolio_expenses), 20);
  db.close();
});

test('rebuild is idempotent (re-running replaces, not duplicates)', () => {
  const db = makeDb();
  rebuildCanonicalProjections(db);
  const first = db.prepare("SELECT profit_loss FROM investment_metrics_daily WHERE investment_id = 1 AND date = '2026-01-03'").get().profit_loss;
  const firstCount = db.prepare('SELECT COUNT(*) c FROM investment_metrics_daily').get().c;
  rebuildCanonicalProjections(db);
  const second = db.prepare("SELECT profit_loss FROM investment_metrics_daily WHERE investment_id = 1 AND date = '2026-01-03'").get().profit_loss;
  const secondCount = db.prepare('SELECT COUNT(*) c FROM investment_metrics_daily').get().c;
  assert.equal(round2(first), round2(second));
  assert.equal(firstCount, secondCount);
  db.close();
});

// Internal SWITCH between two MF holdings in the same portfolio: the switch is not
// external cash, so the portfolio proceeds must exclude it, while investment attribution keeps it.
function makeSwitchDb() {
  const db = makeDb();
  db.prepare('INSERT INTO investments (id, asset_type, exclude_from_tracking) VALUES (4, ?, 0)').run('MUTUAL_FUND');
  db.prepare('INSERT INTO investments (id, asset_type, exclude_from_tracking) VALUES (5, ?, 0)').run('MUTUAL_FUND');
  const tx = db.prepare('INSERT INTO transactions (investment_id, portfolio_id, transaction_type, transaction_date, amount, fees, units) VALUES (?,?,?,?,?,?,?)');
  tx.run(4, 1, 'BUY', '2026-01-01', 1000, 0, 10);
  tx.run(4, 1, 'SWITCH_OUT', '2026-01-02', 400, 0, 4); // internal out
  tx.run(5, 1, 'SWITCH_IN', '2026-01-02', 400, 0, 4);  // internal in
  const dv = db.prepare('INSERT INTO investment_metrics_daily (investment_id, portfolio_id, date, price_per_unit, current_value) VALUES (?,?,?,?,?)');
  dv.run(4, 1, '2026-01-01', 100, 1000);
  dv.run(4, 1, '2026-01-02', 100, 600);
  dv.run(5, 1, '2026-01-02', 100, 400);
  return db;
}

test('portfolio proceeds exclude internal SWITCH; investment attribution keeps it', () => {
  const db = makeSwitchDb();
  rebuildCanonicalProjections(db);
  // Investment 4 attribution proceeds include the SWITCH_OUT (400).
  const inv4 = db.prepare("SELECT realized_proceeds AS attribution_proceeds FROM investment_metrics_daily WHERE investment_id = 4 AND date = '2026-01-02'").get();
  assert.equal(round2(inv4.attribution_proceeds), 400);
  // Portfolio realized_proceeds must EXCLUDE the internal switch (only the real SELL 500 + withdrawal 200 from makeDb remain).
  const port = db.prepare("SELECT realized_proceeds FROM portfolio_metrics_daily WHERE portfolio_id = 1 AND date = '2026-01-03'").get();
  assert.equal(round2(port.realized_proceeds), 700); // 500 SELL + 200 WITHDRAWAL, no switch
  db.close();
});
