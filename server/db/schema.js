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
      email TEXT,
      color TEXT DEFAULT '#f59e0b',
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Asset types: INDIAN_STOCK, MUTUAL_FUND, FOREIGN_STOCK, PPF, SSY, PF, BOND
    CREATE TABLE IF NOT EXISTS investments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      asset_type TEXT NOT NULL CHECK(asset_type IN ('INDIAN_STOCK', 'MUTUAL_FUND', 'FOREIGN_STOCK', 'PPF', 'SSY', 'PF', 'BOND', 'NPS')),
      ticker_symbol TEXT,          -- NSE symbol for Indian stocks, Yahoo ticker for foreign stocks
      amfi_code TEXT,              -- AMFI scheme code for mutual funds
      account_number TEXT,         -- For PPF/SSY/PF accounts
      interest_rate REAL,          -- For PPF/SSY/PF (annual %)
      currency TEXT DEFAULT 'INR', -- INR or USD
      face_value REAL,              -- Face/par value per unit (for bonds)
      coupon_frequency TEXT,        -- MONTHLY, QUARTERLY, SEMI_ANNUAL, ANNUAL (for bonds)
      maturity_date TEXT,           -- Maturity date (for bonds)
      notes TEXT,
      display_name TEXT,              -- User-friendly display name (overrides 'name' in UI)
      isin_code TEXT,                -- ISIN for universal identification
      previous_isin_codes TEXT,      -- Comma-separated historical ISINs (e.g. after stock splits)
      is_active INTEGER DEFAULT 1,   -- 1 = active (price updates), 0 = inactive (delisted etc.)
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Individual buy/sell transactions
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      investment_id INTEGER NOT NULL,
      portfolio_id INTEGER,        -- Owner (family member) portfolio
      transaction_type TEXT NOT NULL CHECK(transaction_type IN ('BUY', 'SELL', 'DEPOSIT', 'WITHDRAWAL', 'DIVIDEND', 'INTEREST', 'SPLIT', 'BONUS', 'RIGHTS', 'MERGER', 'CONSOLIDATION', 'IPO', 'TRANSFER_IN', 'TRANSFER_OUT', 'TRANSFER', 'SWITCH_IN', 'SWITCH_OUT', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'CHARGES')),
      transaction_date TEXT NOT NULL,
      units REAL,                  -- Number of units/shares bought or sold
      price_per_unit REAL,         -- Price at which transaction happened
      amount REAL NOT NULL,        -- Total amount of transaction
      fees REAL DEFAULT 0,         -- Brokerage, stamp duty, etc.
      broker TEXT,                   -- Broker/platform name (e.g., Sharekhan, Groww)
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (investment_id) REFERENCES investments(id) ON DELETE CASCADE
    );

    -- Daily snapshot of each investment's value (per portfolio + combined)
    CREATE TABLE IF NOT EXISTS daily_values (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      investment_id INTEGER NOT NULL,
      portfolio_id INTEGER,          -- NULL = combined/all portfolios
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
      UNIQUE(investment_id, portfolio_id, date)
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

    -- PPF/SSY/PF interest rates history
    CREATE TABLE IF NOT EXISTS interest_rates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rate_type TEXT NOT NULL CHECK(rate_type IN ('PPF', 'SSY', 'PF')),
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
    CREATE INDEX IF NOT EXISTS idx_transactions_investment ON transactions(investment_id);
    CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(transaction_date);
    CREATE INDEX IF NOT EXISTS idx_portfolio_daily_date ON portfolio_daily(date);
    CREATE INDEX IF NOT EXISTS idx_portfolio_daily_portfolio ON portfolio_daily(portfolio_id, date);
    CREATE INDEX IF NOT EXISTS idx_transactions_portfolio ON transactions(portfolio_id);

    -- Portfolio-level expenses (AMC, platform fees, CDSL charges, etc.)
    CREATE TABLE IF NOT EXISTS portfolio_expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      portfolio_id INTEGER NOT NULL,
      expense_type TEXT NOT NULL CHECK(expense_type IN ('AMC', 'PLATFORM_FEE', 'CDSL', 'ACCOUNT_OPENING', 'OTHER')),
      expense_date TEXT NOT NULL,
      amount REAL NOT NULL,
      broker TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (portfolio_id) REFERENCES portfolios(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_portfolio_expenses_portfolio ON portfolio_expenses(portfolio_id);
    CREATE INDEX IF NOT EXISTS idx_portfolio_expenses_date ON portfolio_expenses(expense_date);
  `);

  // ── Migrations ───────────────────────────────────────────────────────────
  // Add email column to portfolios
  const portCols = db.prepare("PRAGMA table_info(portfolios)").all().map(c => c.name);
  if (!portCols.includes('email')) {
    db.exec("ALTER TABLE portfolios ADD COLUMN email TEXT");
  }

  // Add 'locked' column so manually-corrected transactions survive corporate-action sync
  const txnCols = db.prepare("PRAGMA table_info(transactions)").all().map(c => c.name);
  if (!txnCols.includes('locked')) {
    db.exec("ALTER TABLE transactions ADD COLUMN locked INTEGER DEFAULT 0");
  }

  // Add previous_isin_codes column if missing
  const invCols = db.prepare("PRAGMA table_info(investments)").all().map(c => c.name);
  if (!invCols.includes('previous_isin_codes')) {
    db.exec("ALTER TABLE investments ADD COLUMN previous_isin_codes TEXT");
  }

  // Add folio_number to transactions (folio is per-transaction, not per-investment)
  if (!txnCols.includes('folio_number')) {
    db.exec("ALTER TABLE transactions ADD COLUMN folio_number TEXT");
  }

  // Add is_active column (default active) for skipping price updates on delisted investments
  if (!invCols.includes('is_active')) {
    db.exec("ALTER TABLE investments ADD COLUMN is_active INTEGER DEFAULT 1");
  }

  // Add category to investments (Equity, Debt, Hybrid, ELSS, etc.)
  if (!invCols.includes('category')) {
    db.exec("ALTER TABLE investments ADD COLUMN category TEXT");
    // Auto-populate category for mutual funds from name heuristics
    const mfs = db.prepare("SELECT id, name FROM investments WHERE asset_type = 'MUTUAL_FUND' AND category IS NULL").all();
    const updateCat = db.prepare("UPDATE investments SET category = ? WHERE id = ?");
    for (const mf of mfs) {
      const cat = inferMFCategory(mf.name);
      if (cat) updateCat.run(cat, mf.id);
    }
  }

  // Seed default interest rates
  const existingRates = db.prepare('SELECT COUNT(*) as count FROM interest_rates').get();
  if (existingRates.count === 0) {
    const insertRate = db.prepare('INSERT INTO interest_rates (rate_type, rate, effective_from) VALUES (?, ?, ?)');
    insertRate.run('PPF', 7.1, '2020-04-01');
    insertRate.run('SSY', 8.2, '2024-04-01');
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

  // ── Migration: add NPS asset_type and new transaction types ──────────
  // SQLite doesn't allow ALTER CHECK, so we recreate the tables if needed.
  const hasNPS = (() => {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='investments'").get();
    return row && row.sql.includes("'NPS'");
  })();

  if (!hasNPS) {
    console.log('Migrating: adding NPS asset_type and new transaction types...');
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      // Recreate investments table with NPS
      db.exec(`
        CREATE TABLE investments_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          asset_type TEXT NOT NULL CHECK(asset_type IN ('INDIAN_STOCK', 'MUTUAL_FUND', 'FOREIGN_STOCK', 'PPF', 'SSY', 'PF', 'BOND', 'NPS')),
          ticker_symbol TEXT,
          amfi_code TEXT,
          account_number TEXT,
          interest_rate REAL,
          currency TEXT DEFAULT 'INR',
          face_value REAL,
          coupon_frequency TEXT,
          maturity_date TEXT,
          notes TEXT,
          display_name TEXT,
          isin_code TEXT,
          previous_isin_codes TEXT,
          is_active INTEGER DEFAULT 1,
          category TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        )
      `);
      db.exec("INSERT INTO investments_new SELECT id, name, asset_type, ticker_symbol, amfi_code, account_number, interest_rate, currency, face_value, coupon_frequency, maturity_date, notes, display_name, isin_code, previous_isin_codes, COALESCE(is_active, 1), category, created_at, updated_at FROM investments");
      db.exec("DROP TABLE investments");
      db.exec("ALTER TABLE investments_new RENAME TO investments");

      // Recreate transactions table with new types
      db.exec(`
        CREATE TABLE transactions_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          investment_id INTEGER NOT NULL,
          portfolio_id INTEGER,
          transaction_type TEXT NOT NULL CHECK(transaction_type IN ('BUY', 'SELL', 'DEPOSIT', 'WITHDRAWAL', 'DIVIDEND', 'INTEREST', 'SPLIT', 'BONUS', 'RIGHTS', 'MERGER', 'CONSOLIDATION', 'IPO', 'TRANSFER_IN', 'TRANSFER_OUT', 'TRANSFER', 'SWITCH_IN', 'SWITCH_OUT', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'CHARGES')),
          transaction_date TEXT NOT NULL,
          units REAL,
          price_per_unit REAL,
          amount REAL NOT NULL,
          fees REAL DEFAULT 0,
          broker TEXT,
          notes TEXT,
          locked INTEGER DEFAULT 0,
          folio_number TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          FOREIGN KEY (investment_id) REFERENCES investments(id) ON DELETE CASCADE
        )
      `);
      db.exec("INSERT INTO transactions_new SELECT id, investment_id, portfolio_id, transaction_type, transaction_date, units, price_per_unit, amount, fees, broker, notes, locked, folio_number, created_at FROM transactions");
      db.exec("DROP TABLE transactions");
      db.exec("ALTER TABLE transactions_new RENAME TO transactions");

      // Recreate indexes
      db.exec("CREATE INDEX IF NOT EXISTS idx_transactions_investment ON transactions(investment_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(transaction_date)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_transactions_portfolio ON transactions(portfolio_id)");

      db.exec('COMMIT');
      console.log('Migration complete: NPS and new transaction types added.');
    } catch (err) {
      db.exec('ROLLBACK');
      console.error('NPS migration failed:', err);
      throw err;
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }

  // ── Migration: add SSY asset_type and interest rate ──────────────────
  const hasSSY = (() => {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='investments'").get();
    return row && row.sql.includes("'SSY'");
  })();

  if (!hasSSY) {
    console.log('Migrating: adding SSY asset_type...');
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      // Recreate investments table with SSY
      db.exec(`
        CREATE TABLE investments_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          asset_type TEXT NOT NULL CHECK(asset_type IN ('INDIAN_STOCK', 'MUTUAL_FUND', 'FOREIGN_STOCK', 'PPF', 'SSY', 'PF', 'BOND', 'NPS')),
          ticker_symbol TEXT,
          amfi_code TEXT,
          account_number TEXT,
          interest_rate REAL,
          currency TEXT DEFAULT 'INR',
          face_value REAL,
          coupon_frequency TEXT,
          maturity_date TEXT,
          notes TEXT,
          display_name TEXT,
          isin_code TEXT,
          previous_isin_codes TEXT,
          is_active INTEGER DEFAULT 1,
          category TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        )
      `);
      db.exec("INSERT INTO investments_new SELECT id, name, asset_type, ticker_symbol, amfi_code, account_number, interest_rate, currency, face_value, coupon_frequency, maturity_date, notes, display_name, isin_code, previous_isin_codes, COALESCE(is_active, 1), category, created_at, updated_at FROM investments");
      db.exec("DROP TABLE investments");
      db.exec("ALTER TABLE investments_new RENAME TO investments");

      // Recreate indexes on investments
      db.exec("CREATE INDEX IF NOT EXISTS idx_investments_asset_type ON investments(asset_type)");

      // Recreate interest_rates table with SSY rate_type
      db.exec(`
        CREATE TABLE interest_rates_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          rate_type TEXT NOT NULL CHECK(rate_type IN ('PPF', 'SSY', 'PF')),
          rate REAL NOT NULL,
          effective_from TEXT NOT NULL,
          effective_to TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);
      db.exec("INSERT INTO interest_rates_new SELECT * FROM interest_rates");
      db.exec("DROP TABLE interest_rates");
      db.exec("ALTER TABLE interest_rates_new RENAME TO interest_rates");

      // Seed SSY rate if not already present
      const ssyExists = db.prepare("SELECT COUNT(*) as count FROM interest_rates WHERE rate_type = 'SSY'").get();
      if (ssyExists.count === 0) {
        db.prepare("INSERT INTO interest_rates (rate_type, rate, effective_from) VALUES ('SSY', 8.2, '2024-04-01')").run();
      }

      db.exec('COMMIT');
      console.log('Migration complete: SSY asset_type added.');
    } catch (err) {
      db.exec('ROLLBACK');
      console.error('SSY migration failed:', err);
      throw err;
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }

  // ── Migration: add portfolio_id to daily_values ──────────────────────
  const dvCols = db.prepare("PRAGMA table_info(daily_values)").all().map(c => c.name);
  if (!dvCols.includes('portfolio_id')) {
    console.log('Migrating daily_values: adding portfolio_id column (dropping old data)...');
    db.exec('DROP TABLE IF EXISTS daily_values');
    db.exec('DROP TABLE IF EXISTS portfolio_daily');
    db.exec(`
      CREATE TABLE daily_values (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        investment_id INTEGER NOT NULL,
        portfolio_id INTEGER,
        date TEXT NOT NULL,
        price_per_unit REAL,
        total_units REAL,
        current_value REAL NOT NULL,
        invested_amount REAL NOT NULL,
        profit_loss REAL NOT NULL,
        profit_loss_pct REAL,
        day_change REAL DEFAULT 0,
        day_change_pct REAL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (investment_id) REFERENCES investments(id) ON DELETE CASCADE,
        UNIQUE(investment_id, portfolio_id, date)
      );
      CREATE TABLE portfolio_daily (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        portfolio_id INTEGER,
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
      CREATE INDEX idx_daily_values_date ON daily_values(date);
      CREATE INDEX idx_daily_values_investment_date ON daily_values(investment_id, portfolio_id, date);
      CREATE INDEX idx_daily_values_portfolio ON daily_values(portfolio_id, date);
      CREATE INDEX idx_portfolio_daily_date ON portfolio_daily(date);
      CREATE INDEX idx_portfolio_daily_portfolio ON portfolio_daily(portfolio_id, date);
    `);
    console.log('Migration complete: daily_values and portfolio_daily recreated with portfolio_id support.');
  }
}

/**
 * Infer mutual fund category from scheme name
 */
function inferMFCategory(name) {
  const n = name.toLowerCase();
  if (n.includes('elss') || n.includes('tax saver') || n.includes('tax saving')) return 'ELSS';
  if (n.includes('liquid') || n.includes('money market') || n.includes('overnight')) return 'Liquid';
  if (n.includes('gilt') || n.includes('debt') || n.includes('bond') || n.includes('income') ||
      n.includes('credit risk') || n.includes('banking & psu') || n.includes('banking and psu') ||
      n.includes('corporate bond') || n.includes('dynamic bond') || n.includes('short duration') ||
      n.includes('medium duration') || n.includes('long duration') || n.includes('ultra short') ||
      n.includes('low duration') || n.includes('floater') || n.includes('floating rate')) return 'Debt';
  if (n.includes('hybrid') || n.includes('balanced') || n.includes('equity savings') ||
      n.includes('multi asset') || n.includes('arbitrage')) return 'Hybrid';
  if (n.includes('index') || n.includes('nifty') || n.includes('sensex') || n.includes('etf')) return 'Index/ETF';
  if (n.includes('international') || n.includes('global') || n.includes('us equity') ||
      n.includes('nasdaq') || n.includes('emerging market') || n.includes('world')) return 'International';
  if (n.includes('large cap') || n.includes('largecap') || n.includes('mid cap') || n.includes('midcap') ||
      n.includes('small cap') || n.includes('smallcap') || n.includes('flexi cap') || n.includes('flexicap') ||
      n.includes('multi cap') || n.includes('multicap') || n.includes('focused') || n.includes('value') ||
      n.includes('contra') || n.includes('dividend yield') || n.includes('opportunities') ||
      n.includes('sectoral') || n.includes('thematic') || n.includes('consumption') ||
      n.includes('infrastructure') || n.includes('pharma') || n.includes('banking') ||
      n.includes('technology') || n.includes('equity') || n.includes('growth')) return 'Equity';
  return 'Equity';
}

module.exports = { getDb, initializeDb };
