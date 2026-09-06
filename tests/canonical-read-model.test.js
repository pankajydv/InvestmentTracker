const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');

const {
  getPortfolioV2Latest,
  getPortfolioV2History,
  getAssetAllocationV2,
  getRolloverV2,
} = require('../server/services/canonicalReadModel');

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE portfolio_metrics_daily (
      id INTEGER PRIMARY KEY AUTOINCREMENT, portfolio_id INTEGER, date TEXT NOT NULL, current_value REAL NOT NULL,
      net_invested REAL NOT NULL, realized_proceeds REAL NOT NULL DEFAULT 0, total_profit_loss REAL NOT NULL, total_day_change REAL NOT NULL DEFAULT 0,
      calculation_version INTEGER NOT NULL, source_data_version INTEGER
    );
  `);
  const ins = db.prepare('INSERT INTO portfolio_metrics_daily (portfolio_id, date, current_value, net_invested, realized_proceeds, total_profit_loss, total_day_change, calculation_version, source_data_version) VALUES (?,?,?,?,?,?,?,1,7)');
  // columns: cv, net_invested, realized_proceeds, total_profit_loss(after-exp), day_change
  ins.run(1, '2026-01-01', 1000, 900, 300, 100, 0);
  ins.run(1, '2026-01-02', 1100, 900, 300, 200, 10);
  ins.run(2, '2026-01-01', 500, 400, 100, 100, 0);
  ins.run(2, '2026-01-02', 520, 400, 100, 120, 5);
  return db;
}

test('getPortfolioV2Latest presents gross invested and before-expense P&L from stored columns', () => {
  const db = makeDb();
  const r = getPortfolioV2Latest(db, [1]);
  assert.equal(r.date, '2026-01-02');
  assert.equal(r.total_value, 1100);
  assert.equal(r.net_invested, 900);
  assert.equal(r.total_realized_proceeds, 300);
  assert.equal(r.total_invested, 1200); // gross = net_invested + realized_proceeds
  assert.equal(r.total_profit_loss, 200); // before expenses = current_value - net_invested
  db.close();
});

test('getPortfolioV2Latest sums latest rows across all portfolios when scope is empty', () => {
  const db = makeDb();
  const r = getPortfolioV2Latest(db, []);
  assert.equal(r.total_value, 1100 + 520);
  assert.equal(r.net_invested, 900 + 400);
  assert.equal(r.total_realized_proceeds, 300 + 100);
  assert.equal(r.total_invested, 1300 + 400); // gross
  assert.equal(r.total_profit_loss, 200 + 120); // before expenses
  db.close();
});

test('getPortfolioV2Latest returns null when no rows exist for the scope', () => {
  const db = makeDb();
  assert.equal(getPortfolioV2Latest(db, [99]), null);
  db.close();
});

test('getPortfolioV2History returns ascending rows shaped like portfolio_daily', () => {
  const db = makeDb();
  const rows = getPortfolioV2History(db, [1]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].date, '2026-01-01');
  assert.equal(rows[1].date, '2026-01-02');
  assert.equal(rows[1].total_invested, 1200); // gross
  assert.equal(rows[1].total_realized_proceeds, 300);
  assert.equal(rows[1].total_profit_loss, 200);
  db.close();
});

test('getPortfolioV2History latest row equals getPortfolioV2Latest (card == history invariant)', () => {
  const db = makeDb();
  const latest = getPortfolioV2Latest(db, []);
  const history = getPortfolioV2History(db, []);
  const last = history[history.length - 1];
  assert.equal(last.total_value, latest.total_value);
  assert.equal(last.total_profit_loss, latest.total_profit_loss);
  assert.equal(last.date, latest.date);
  db.close();
});

function makeAssetDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE investments (id INTEGER PRIMARY KEY, asset_type TEXT, exclude_from_tracking INTEGER DEFAULT 0);
    CREATE TABLE asset_metrics_daily (
      id INTEGER PRIMARY KEY AUTOINCREMENT, portfolio_id INTEGER, asset_type TEXT NOT NULL, date TEXT NOT NULL,
      current_value REAL NOT NULL, attribution_basis REAL NOT NULL, attribution_proceeds REAL NOT NULL DEFAULT 0,
      profit_loss_before_portfolio_expenses REAL NOT NULL, day_change REAL NOT NULL DEFAULT 0,
      calculation_version INTEGER NOT NULL, source_data_version INTEGER
    );
    CREATE TABLE investment_metrics_daily (
      id INTEGER PRIMARY KEY AUTOINCREMENT, investment_id INTEGER, portfolio_id INTEGER, date TEXT
    );
  `);
  db.prepare("INSERT INTO investments (id, asset_type) VALUES (1,'STOCK'),(2,'STOCK'),(3,'PF')").run();
  const a = db.prepare('INSERT INTO asset_metrics_daily (portfolio_id, asset_type, date, current_value, attribution_basis, attribution_proceeds, profit_loss_before_portfolio_expenses, day_change, calculation_version, source_data_version) VALUES (?,?,?,?,?,?,?,?,1,1)');
  // STOCK asset in portfolio 1: two dates, take the latest
  a.run(1, 'STOCK', '2026-01-01', 1000, 900, 0, 100, 0);
  a.run(1, 'STOCK', '2026-01-02', 1200, 900, 0, 300, 0);
  a.run(1, 'PF', '2026-01-02', 500, 400, 50, 150, 0);
  const dv = db.prepare('INSERT INTO investment_metrics_daily (investment_id, portfolio_id, date) VALUES (?,?,?)');
  dv.run(1, 1, '2026-01-02');
  dv.run(2, 1, '2026-01-02');
  dv.run(3, 1, '2026-01-02');
  return db;
}

test('getAssetAllocationV2 returns latest asset rows with per-type investment counts', () => {
  const db = makeAssetDb();
  const rows = getAssetAllocationV2(db, [1]);
  const byType = Object.fromEntries(rows.map((r) => [r.asset_type, r]));
  assert.equal(byType.STOCK.total_value, 1200); // latest date row, not 1000
  assert.equal(byType.STOCK.total_invested, 900);
  assert.equal(byType.STOCK.total_profit_loss, 300);
  assert.equal(byType.STOCK.count, 2); // two STOCK investments
  assert.equal(byType.PF.total_value, 500);
  assert.equal(byType.PF.count, 1);
  db.close();
});

test('getAssetAllocationV2 returns null when no asset rows exist for the scope', () => {
  const db = makeAssetDb();
  assert.equal(getAssetAllocationV2(db, [99]), null);
  db.close();
});

test('getRolloverV2 (portfolio scope) shows NET invested and carries forward', () => {
  const db = makeDb();
  const result = getRolloverV2(db, { portfolioIds: [], assetType: null, fromDate: '2026-01-01', toDate: '2026-01-02', page: 1, pageSize: 10 });
  assert.equal(result.rows.length, 2);
  const latest = result.rows[0]; // ordered DESC
  assert.equal(latest.date, '2026-01-02');
  assert.equal(latest.invested_amount, 900 + 400); // NET invested (not gross), matching the card
  assert.equal(latest.realized_proceeds, 300 + 100);
  assert.equal(latest.current_value, 1100 + 520);
  assert.equal(latest.contributing_portfolios, 2);
  db.close();
});
