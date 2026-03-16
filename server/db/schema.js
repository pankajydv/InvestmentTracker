const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Use DATA_DIR env var (for Docker persistent volume) or local ./data
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');

function getDb() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  const db = new Database(path.join(DATA_DIR, 'investments.db'));

  // Enable WAL mode for better concurrency
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  return db;
}

function initializeDb(db) {
  db.exec(`
    -- Family portfolios (each family member has one)
    CREATE TABLE IF NOT EXISTS portfolios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      pan_number TEXT,
      color TEXT DEFAULT '#f59e0b',
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Asset types: INDIAN_STOCK, MUTUAL_FUND, FOREIGN_STOCK, PPF, PF, BOND
    CREATE TABLE IF NOT EXISTS investments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      asset_type TEXT NOT NULL CHECK(asset_type IN ('INDIAN_STOCK', 'MUTUAL_FUND', 'FOREIGN_STOCK', 'PPF', 'PF', 'BOND')),
      portfolio_id INTEGER,          -- Owner (family member) portfolio
      ticker_symbol TEXT,          -- NSE symbol for Indian stocks, Yahoo ticker for foreign stocks
      amfi_code TEXT,              -- AMFI scheme code for mutual funds
      folio_number TEXT,           -- Folio number for MF
      account_number TEXT,         -- For PPF/PF accounts
      interest_rate REAL,          -- For PPF/PF (annual %)
      currency TEXT DEFAULT 'INR', -- INR or USD
      broker TEXT,                 -- Broker/platform name (e.g., Sharekhan, Zerodha)
      face_value REAL,              -- Face/par value per unit (for bonds)
      coupon_frequency TEXT,        -- MONTHLY, QUARTERLY, SEMI_ANNUAL, ANNUAL (for bonds)
      maturity_date TEXT,           -- Maturity date (for bonds)
      notes TEXT,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Individual buy/sell transactions
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      investment_id INTEGER NOT NULL,
      transaction_type TEXT NOT NULL CHECK(transaction_type IN ('BUY', 'SELL', 'REDEMPTION', 'DEPOSIT', 'WITHDRAWAL', 'DIVIDEND', 'INTEREST', 'SPLIT', 'BONUS', 'RIGHTS', 'MERGER', 'CONSOLIDATION', 'IPO', 'TRANSFER_IN', 'TRANSFER_OUT', 'AMC')),
      transaction_date TEXT NOT NULL,
      units REAL,                  -- Number of units/shares bought or sold
      price_per_unit REAL,         -- Price at which transaction happened
      amount REAL NOT NULL,        -- Total amount of transaction
      fees REAL DEFAULT 0,         -- Brokerage, stamp duty, etc.
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (investment_id) REFERENCES investments(id) ON DELETE CASCADE
    );

    -- Daily snapshot of each investment's value
    CREATE TABLE IF NOT EXISTS daily_values (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      investment_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      price_per_unit REAL,         -- NAV or stock price
      total_units REAL,            -- Total units held on that day
      current_value REAL NOT NULL, -- total_units * price_per_unit
      invested_amount REAL NOT NULL, -- Total amount invested till date
      profit_loss REAL NOT NULL,   -- current_value - invested_amount
      profit_loss_pct REAL,        -- Percentage gain/loss
      day_change REAL DEFAULT 0,   -- Change from previous day
      day_change_pct REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (investment_id) REFERENCES investments(id) ON DELETE CASCADE,
      UNIQUE(investment_id, date)
    );

    -- Portfolio-level daily snapshot (one row per portfolio per day, plus NULL portfolio_id = combined)
    CREATE TABLE IF NOT EXISTS portfolio_daily (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      portfolio_id INTEGER,        -- NULL means combined/all portfolios
      date TEXT NOT NULL,
      total_value REAL NOT NULL,
      total_invested REAL NOT NULL,
      total_profit_loss REAL NOT NULL,
      total_profit_loss_pct REAL,
      day_change REAL DEFAULT 0,
      day_change_pct REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(portfolio_id, date)
    );

    -- PPF/PF interest rates history
    CREATE TABLE IF NOT EXISTS interest_rates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rate_type TEXT NOT NULL CHECK(rate_type IN ('PPF', 'PF')),
      rate REAL NOT NULL,
      effective_from TEXT NOT NULL,
      effective_to TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- App configuration
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Indexes for faster queries
    CREATE INDEX IF NOT EXISTS idx_daily_values_date ON daily_values(date);
    CREATE INDEX IF NOT EXISTS idx_daily_values_investment_date ON daily_values(investment_id, date);
    CREATE INDEX IF NOT EXISTS idx_transactions_investment ON transactions(investment_id);
    CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(transaction_date);
    CREATE INDEX IF NOT EXISTS idx_portfolio_daily_date ON portfolio_daily(date);
    CREATE INDEX IF NOT EXISTS idx_portfolio_daily_portfolio ON portfolio_daily(portfolio_id, date);
    CREATE INDEX IF NOT EXISTS idx_investments_portfolio ON investments(portfolio_id);
  `);

  // Seed default interest rates
  const existingRates = db.prepare('SELECT COUNT(*) as count FROM interest_rates').get();
  if (existingRates.count === 0) {
    const insertRate = db.prepare('INSERT INTO interest_rates (rate_type, rate, effective_from) VALUES (?, ?, ?)');
    insertRate.run('PPF', 7.1, '2020-04-01');
    insertRate.run('PF', 8.25, '2024-04-01');
  }

  // Seed default config
  const existingConfig = db.prepare('SELECT COUNT(*) as count FROM config').get();
  if (existingConfig.count === 0) {
    const insertConfig = db.prepare('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)');
    insertConfig.run('usd_to_inr', '83.50');
    insertConfig.run('last_price_update', '');
    insertConfig.run('auto_update_enabled', 'true');
    insertConfig.run('update_time', '18:00'); // 6 PM IST
  }
}

module.exports = { getDb, initializeDb };
