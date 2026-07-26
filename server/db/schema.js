const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { applyEnvDefaults } = require('../config/envDefaults');

applyEnvDefaults();

function isProductionMode() {
  const appMode = String(process.env.APP_MODE || 'production').toLowerCase();
  return appMode !== 'dev' && appMode !== 'development' && appMode !== 'test';
}

// Use DATA_DIR env var (for Docker persistent volume) or local ./data
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');

function getMainDbPath(db) {
  const row = db.prepare("PRAGMA database_list").all().find(r => r.name === 'main');
  return row && row.file ? row.file : null;
}

function getTableCount(db, tableName) {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM ${tableName}`).get();
  return row ? Number(row.c) : 0;
}

function createPreMigrationBackup(db, label) {
  const dbPath = getMainDbPath(db);
  if (!dbPath || !fs.existsSync(dbPath)) return null;

  const dir = path.join(path.dirname(dbPath), 'migration-backups');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(dir, `investments.pre-migration-${label}-${stamp}.db`);

  // Ensure WAL pages are checkpointed before file copy.
  db.pragma('wal_checkpoint(TRUNCATE)');
  fs.copyFileSync(dbPath, backupPath);
  return backupPath;
}

function ensureRowCountPreserved({ before, after, table, migrationName }) {
  if (after < before) {
    throw new Error(`Migration ${migrationName} reduced row count in ${table}: before=${before}, after=${after}`);
  }
}

function hasMigrationRecord(db, id) {
  const row = db.prepare('SELECT id FROM schema_migrations WHERE id = ?').get(id);
  return !!row;
}

function recordMigration(db, id, status, notes = null) {
  db.prepare(`
    INSERT OR REPLACE INTO schema_migrations (id, status, notes, applied_at)
    VALUES (?, ?, ?, datetime('now'))
  `).run(id, status, notes);
}

function assertDbIntegrity(db, context) {
  const integrity = db.prepare('PRAGMA integrity_check').all();
  const integrityOk = integrity.length === 1 && String(integrity[0].integrity_check).toLowerCase() === 'ok';
  if (!integrityOk) {
    throw new Error(`Integrity check failed after ${context}: ${JSON.stringify(integrity)}`);
  }

  const fk = db.prepare('PRAGMA foreign_key_check').all();
  if (fk.length > 0) {
    throw new Error(`Foreign key check failed after ${context}: ${JSON.stringify(fk)}`);
  }
}

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

    -- Asset types: INDIAN_STOCK, MUTUAL_FUND, FOREIGN_STOCK, PPF, SSY, PF, BOND, SGB
    CREATE TABLE IF NOT EXISTS investments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      asset_type TEXT NOT NULL CHECK(asset_type IN ('INDIAN_STOCK', 'MUTUAL_FUND', 'FOREIGN_STOCK', 'PPF', 'SSY', 'PF', 'BOND', 'NPS', 'SGB')),
      ticker_symbol TEXT,          -- NSE symbol for Indian stocks, Yahoo ticker for foreign stocks
      amfi_code TEXT,              -- AMFI scheme code for mutual funds
      account_number TEXT,         -- For PPF/SSY/PF accounts
      currency TEXT DEFAULT 'INR', -- INR or USD
      face_value REAL,              -- Face/par value per unit (for bonds)
      coupon_rate REAL,             -- Annual coupon rate percentage (for bonds)
      coupon_frequency TEXT,        -- MONTHLY, QUARTERLY, SEMI_ANNUAL, ANNUAL (for bonds)
      maturity_date TEXT,           -- Maturity date (for bonds)
      notes TEXT,
      display_name TEXT,              -- User-friendly display name (overrides 'name' in UI)
      isin_code TEXT,                -- ISIN for universal identification
      previous_isin_codes TEXT,      -- Comma-separated historical ISINs (e.g. after stock splits)
      opening_balance REAL DEFAULT 0, -- For PPF/SSY/PF: balance carried forward from before first imported statement
      is_active INTEGER DEFAULT 1,   -- 1 = active (price updates), 0 = inactive (delisted etc.)
      exclude_from_tracking INTEGER DEFAULT 0, -- 1 = exclude from daily_values calculations and dashboard (e.g. derived investments)
      is_dirty_daily_values INTEGER DEFAULT 0,
      dirty_from_date TEXT,
      last_active_date TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Ticker history for investments where symbols changed over time.
    CREATE TABLE IF NOT EXISTS investment_symbol_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      investment_id INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      valid_from TEXT NOT NULL,
      valid_to TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (investment_id) REFERENCES investments(id) ON DELETE CASCADE
    );

    -- Individual buy/sell transactions
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      investment_id INTEGER NOT NULL,
      portfolio_id INTEGER NOT NULL, -- Owner (family member) portfolio
      transaction_type TEXT NOT NULL CHECK(transaction_type IN ('BUY', 'SELL', 'DEPOSIT', 'WITHDRAWAL', 'DIVIDEND', 'INTEREST', 'RECONCILE', 'TDS', 'SPLIT', 'BONUS', 'RIGHTS', 'MERGER', 'CONSOLIDATION', 'IPO', 'TRANSFER_IN', 'TRANSFER_OUT', 'TRANSFER', 'SWITCH_IN', 'SWITCH_OUT', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'CHARGES', 'AMC', 'REDEMPTION', 'ESPP_CONTRIBUTION')),
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
      realized_proceeds REAL DEFAULT 0, -- Cumulative cash out (realized proceeds)
      profit_loss REAL NOT NULL,   -- current_value - invested_amount
      price_source TEXT DEFAULT 'LIVE' CHECK(price_source IN ('LIVE', 'LOCF', 'COMPUTED', 'PRE', 'POST')),
      day_change REAL DEFAULT 0,   -- Change from previous day
      updated_at TEXT DEFAULT (datetime('now')),
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

    -- Asset-type level daily snapshot (per portfolio + combined/null portfolio)
    CREATE TABLE IF NOT EXISTS asset_type_daily (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      portfolio_id INTEGER,
      asset_type TEXT NOT NULL,
      date TEXT NOT NULL,
      total_value REAL NOT NULL,
      total_invested REAL NOT NULL,
      total_profit_loss REAL NOT NULL,
      total_realized_proceeds REAL DEFAULT 0,
      total_unrealized_gain REAL DEFAULT 0,
      total_profit_loss_pct REAL,
      day_change REAL DEFAULT 0,
      day_change_pct REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(portfolio_id, asset_type, date)
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

    -- Market holidays used by compliance scans and market-session policies
    CREATE TABLE IF NOT EXISTS market_holidays (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL UNIQUE,
      description TEXT,
      year INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Compliance gap tracker for missing derived daily rows
    CREATE TABLE IF NOT EXISTS daily_data_gaps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      gap_start_date TEXT NOT NULL,
      gap_end_date TEXT NOT NULL,
      detected_at TEXT DEFAULT (datetime('now')),
      resolved_at TEXT
    );

    -- Dirty backfill scopes: track impacted ranges that must be recomputed.
    CREATE TABLE IF NOT EXISTS dirty_backfill_scope (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      investment_id INTEGER,
      portfolio_id INTEGER,
      dirty_from_date TEXT NOT NULL,
      dirty_reason TEXT,
      source_event_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'completed', 'failed')),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (investment_id) REFERENCES investments(id) ON DELETE CASCADE
    );

    -- Historical price repair scopes: targeted market price cache repair queue.
    CREATE TABLE IF NOT EXISTS historical_price_repair_scope (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instrument_type TEXT NOT NULL,
      symbol TEXT NOT NULL,
      from_date TEXT NOT NULL,
      to_date TEXT NOT NULL,
      reason TEXT,
      priority INTEGER NOT NULL DEFAULT 100,
      source_event_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'completed', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT
    );

    -- XIRR Cache: Pre-calculated XIRR values for dashboard performance
    -- Pre-calculated after scheduler price updates to avoid expensive computations
    CREATE TABLE IF NOT EXISTS xirr_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cache_key TEXT UNIQUE NOT NULL,
      portfolio_id INTEGER,
      interval TEXT NOT NULL,
      xirr_value REAL,
      interval_change REAL,
      interval_change_pct REAL,
      opening_value REAL,
      closing_value REAL,
      computed_at TEXT NOT NULL,
      valid_until TEXT NOT NULL,
      source TEXT DEFAULT 'scheduler',
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Applied schema migrations (audit + idempotency)
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK(status IN ('applied', 'skipped')),
      notes TEXT,
      applied_at TEXT DEFAULT (datetime('now'))
    );

    -- Indexes for faster queries
    CREATE INDEX IF NOT EXISTS idx_daily_values_date ON daily_values(date);
    CREATE INDEX IF NOT EXISTS idx_daily_values_portfolio_inv_date ON daily_values(portfolio_id, investment_id, date);
    CREATE INDEX IF NOT EXISTS idx_daily_values_portfolio_date_investment ON daily_values(portfolio_id, date, investment_id);
    CREATE INDEX IF NOT EXISTS idx_daily_values_date_investment_portfolio ON daily_values(date, investment_id, portfolio_id);
    CREATE INDEX IF NOT EXISTS idx_transactions_investment ON transactions(investment_id);
    CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(transaction_date);
    CREATE INDEX IF NOT EXISTS idx_portfolio_daily_date ON portfolio_daily(date);
    CREATE INDEX IF NOT EXISTS idx_portfolio_daily_portfolio ON portfolio_daily(portfolio_id, date);
    CREATE INDEX IF NOT EXISTS idx_asset_type_daily_portfolio_date ON asset_type_daily(portfolio_id, date);
    CREATE INDEX IF NOT EXISTS idx_asset_type_daily_type_date ON asset_type_daily(asset_type, date);
    CREATE INDEX IF NOT EXISTS idx_transactions_portfolio ON transactions(portfolio_id);
    CREATE INDEX IF NOT EXISTS idx_transactions_portfolio_investment ON transactions(portfolio_id, investment_id);
    CREATE INDEX IF NOT EXISTS idx_dirty_scope_status_date ON dirty_backfill_scope(status, dirty_from_date);
    CREATE INDEX IF NOT EXISTS idx_dirty_scope_investment_portfolio ON dirty_backfill_scope(investment_id, portfolio_id, status);
    CREATE INDEX IF NOT EXISTS idx_symbol_history_investment_dates ON investment_symbol_history(investment_id, valid_from, valid_to);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_symbol_history_unique_window ON investment_symbol_history(investment_id, symbol, valid_from);
    CREATE INDEX IF NOT EXISTS idx_hist_price_repair_status_priority ON historical_price_repair_scope(status, priority, created_at);
    CREATE INDEX IF NOT EXISTS idx_hist_price_repair_lookup ON historical_price_repair_scope(instrument_type, symbol, from_date, to_date, status);
    CREATE INDEX IF NOT EXISTS idx_market_holidays_year ON market_holidays(year);
    CREATE INDEX IF NOT EXISTS idx_daily_data_gaps_entity ON daily_data_gaps(table_name, entity_id);
    CREATE INDEX IF NOT EXISTS idx_xirr_cache_key ON xirr_cache(cache_key);
    CREATE INDEX IF NOT EXISTS idx_xirr_cache_portfolio ON xirr_cache(portfolio_id, interval);
    CREATE INDEX IF NOT EXISTS idx_xirr_cache_valid ON xirr_cache(valid_until);

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

    -- Tax: manual other income entries (savings interest, TD interest, etc.)
    CREATE TABLE IF NOT EXISTS tax_other_income (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fy TEXT NOT NULL,
      portfolio_id INTEGER,
      category TEXT NOT NULL CHECK(category IN ('SAVINGS_INTEREST','TD_INTEREST','NCD_INTEREST','PF_INTEREST','NPS_80CCD2','CG_TRANSFER_EXPENSE','OS_TRANSFER_EXPENSE','OTHER')),
      source_name TEXT NOT NULL,
      account_number TEXT,
      amount REAL NOT NULL DEFAULT 0,
      tds REAL NOT NULL DEFAULT 0,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_tax_other_income_fy ON tax_other_income(fy, portfolio_id);

    -- Tax: parsed AIS data (salary, TDS/TCS credits, etc.)
    CREATE TABLE IF NOT EXISTS tax_ais_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fy TEXT NOT NULL,
      portfolio_id INTEGER,
      pan TEXT,
      data_json TEXT NOT NULL,
      uploaded_at TEXT DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_tax_ais_data_fy ON tax_ais_data(fy, portfolio_id);

    -- Tax: property capital gains inputs (old/new property amounts and custom costs)
    CREATE TABLE IF NOT EXISTS tax_property_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fy TEXT NOT NULL,
      portfolio_id INTEGER,
      property_side TEXT NOT NULL CHECK(property_side IN ('OLD', 'NEW')),
      item_type TEXT NOT NULL CHECK(item_type IN (
        'SALE_CONSIDERATION',
        'PURCHASE_CONSIDERATION',
        'LAND_COST',
        'CONSTRUCTION_COST',
        'STAMP_DUTY',
        'BROKERAGE',
        'TRANSFER_EXPENSE',
        'IMPROVEMENT_COST',
        'OTHER_COST',
        'CUSTOM'
      )),
      label TEXT NOT NULL,
      amount REAL NOT NULL DEFAULT 0,
      txn_date TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_tax_property_items_fy ON tax_property_items(fy, portfolio_id);

    -- Dashboard performance optimization indexes
    CREATE INDEX IF NOT EXISTS idx_transactions_investment_portfolio ON transactions(investment_id, portfolio_id, transaction_date);
    CREATE INDEX IF NOT EXISTS idx_transactions_price_lookup ON transactions(investment_id, price_per_unit DESC, transaction_date DESC);
    CREATE INDEX IF NOT EXISTS idx_daily_values_latest_lookup ON daily_values(investment_id, portfolio_id, date DESC);
    CREATE INDEX IF NOT EXISTS idx_daily_values_investment_date ON daily_values(investment_id, date DESC);
    CREATE INDEX IF NOT EXISTS idx_portfolio_daily_latest ON portfolio_daily(portfolio_id, date DESC);
    CREATE INDEX IF NOT EXISTS idx_market_holidays_date ON market_holidays(date);
  `);

  const migrationsEnabled = !isProductionMode() || process.env.ALLOW_DB_MIGRATIONS === 'true';

  // Safety net: if a previous failed migration left investments_old populated and
  // investments empty, recover immediately to prevent apparent data loss on restart.
  const hasInvestmentsOld = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='investments_old'").get();
  if (hasInvestmentsOld) {
    const invCount = db.prepare('SELECT COUNT(*) as c FROM investments').get().c;
    const oldCount = db.prepare('SELECT COUNT(*) as c FROM investments_old').get().c;
    if (invCount === 0 && oldCount > 0) {
      const newCols = db.prepare("PRAGMA table_info(investments)").all().map(c => c.name);
      const oldCols = new Set(db.prepare("PRAGMA table_info(investments_old)").all().map(c => c.name));
      const common = newCols.filter(c => oldCols.has(c));
      if (common.length > 0) {
        const recoverSql = `INSERT OR REPLACE INTO investments (${common.join(', ')}) SELECT ${common.join(', ')} FROM investments_old`;
        db.prepare(recoverSql).run();
      }
    }
    // Drop stale investments_old once investments has data and the migration is recorded.
    // This handles the case where the migration was skipped (column already absent) but the
    // backup table from a prior crashed run was never cleaned up.
    const migrationRecorded = hasMigrationRecord(db, '20260412-drop-investment-interest-rate');
    const invCountNow = db.prepare('SELECT COUNT(*) as c FROM investments').get().c;
    if (migrationRecorded && invCountNow > 0) {
      db.exec('DROP TABLE IF EXISTS investments_old');
      console.log('[schema] Dropped stale investments_old backup table.');
    }
  }

  // Migration: drop per-investment interest_rate (rates are global in interest_rates).
  // This migration is transactional and schema-aware to avoid partial data loss.
  const hasColumn = db.prepare("PRAGMA table_info(investments)").all().some(col => col.name === 'interest_rate');
  const interestRateMigrationId = '20260412-drop-investment-interest-rate';
  if (hasColumn && !hasMigrationRecord(db, interestRateMigrationId)) {
    if (!migrationsEnabled) {
      throw new Error(`Pending migration ${interestRateMigrationId} detected but migrations are disabled. Set ALLOW_DB_MIGRATIONS=true and restart.`);
    }

    const beforeInvestments = getTableCount(db, 'investments');
    const backupPath = createPreMigrationBackup(db, 'drop-investment-interest-rate');
    if (backupPath) console.log(`Created migration backup: ${backupPath}`);

    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      db.exec(`
        ALTER TABLE investments RENAME TO investments_old;
        CREATE TABLE investments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          asset_type TEXT NOT NULL CHECK(asset_type IN ('INDIAN_STOCK', 'MUTUAL_FUND', 'FOREIGN_STOCK', 'PPF', 'SSY', 'PF', 'BOND', 'NPS', 'SGB')),
          ticker_symbol TEXT,
          amfi_code TEXT,
          account_number TEXT,
          currency TEXT DEFAULT 'INR',
          face_value REAL,
          coupon_frequency TEXT,
          maturity_date TEXT,
          notes TEXT,
          display_name TEXT,
          isin_code TEXT,
          previous_isin_codes TEXT,
          opening_balance REAL DEFAULT 0,
          is_active INTEGER DEFAULT 1,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          category TEXT
        );
      `);

      const oldCols = new Set(db.prepare("PRAGMA table_info(investments_old)").all().map(c => c.name));
      const selectOr = (col, fallbackExpr) => (oldCols.has(col) ? col : `${fallbackExpr} AS ${col}`);

      db.exec(`
        INSERT INTO investments (
          id, name, asset_type, ticker_symbol, amfi_code, account_number,
          currency, face_value, coupon_frequency, maturity_date, notes,
          display_name, isin_code, previous_isin_codes, opening_balance,
          is_active, created_at, updated_at, category
        )
        SELECT
          ${selectOr('id', 'NULL')},
          ${selectOr('name', "''")},
          ${selectOr('asset_type', "'MUTUAL_FUND'")},
          ${selectOr('ticker_symbol', 'NULL')},
          ${selectOr('amfi_code', 'NULL')},
          ${selectOr('account_number', 'NULL')},
          ${selectOr('currency', "'INR'")},
          ${selectOr('face_value', 'NULL')},
          ${selectOr('coupon_frequency', 'NULL')},
          ${selectOr('maturity_date', 'NULL')},
          ${selectOr('notes', 'NULL')},
          ${selectOr('display_name', 'NULL')},
          ${selectOr('isin_code', 'NULL')},
          ${selectOr('previous_isin_codes', 'NULL')},
          ${selectOr('opening_balance', '0')},
          ${selectOr('is_active', '1')},
          ${selectOr('created_at', "datetime('now')")},
          ${selectOr('updated_at', "datetime('now')")},
          ${selectOr('category', 'NULL')}
        FROM investments_old;
      `);

      const afterInvestments = getTableCount(db, 'investments');
      ensureRowCountPreserved({
        before: beforeInvestments,
        after: afterInvestments,
        table: 'investments',
        migrationName: 'drop-investment-interest-rate',
      });

      db.exec('DROP TABLE investments_old');
      db.exec('COMMIT');
      assertDbIntegrity(db, interestRateMigrationId);
      recordMigration(db, interestRateMigrationId, 'applied');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  } else if (!hasMigrationRecord(db, interestRateMigrationId) && !hasColumn) {
    recordMigration(db, interestRateMigrationId, 'skipped', 'interest_rate already absent');
  }

  // ── Migrations ───────────────────────────────────────────────────────────
  const requireMigrationsEnabled = (migrationId, condition, reason) => {
    if (!condition) return false;
    if (hasMigrationRecord(db, migrationId)) return false;
    if (!migrationsEnabled) {
      throw new Error(`Pending migration ${migrationId} detected but migrations are disabled. Set ALLOW_DB_MIGRATIONS=true and restart. Reason: ${reason}`);
    }
    return true;
  };

  // Add email column to portfolios
  const portCols = db.prepare("PRAGMA table_info(portfolios)").all().map(c => c.name);
  if (requireMigrationsEnabled('20260412-add-portfolios-email', !portCols.includes('email'), 'portfolios.email missing')) {
    db.exec("ALTER TABLE portfolios ADD COLUMN email TEXT");
    assertDbIntegrity(db, '20260412-add-portfolios-email');
    recordMigration(db, '20260412-add-portfolios-email', 'applied');
  } else if (!hasMigrationRecord(db, '20260412-add-portfolios-email') && portCols.includes('email')) {
    recordMigration(db, '20260412-add-portfolios-email', 'skipped', 'already present');
  }

  // Add 'locked' column so manually-corrected transactions survive corporate-action sync
  const txnCols = db.prepare("PRAGMA table_info(transactions)").all().map(c => c.name);
  if (requireMigrationsEnabled('20260412-add-transactions-locked', !txnCols.includes('locked'), 'transactions.locked missing')) {
    db.exec("ALTER TABLE transactions ADD COLUMN locked INTEGER DEFAULT 0");
    assertDbIntegrity(db, '20260412-add-transactions-locked');
    recordMigration(db, '20260412-add-transactions-locked', 'applied');
  } else if (!hasMigrationRecord(db, '20260412-add-transactions-locked') && txnCols.includes('locked')) {
    recordMigration(db, '20260412-add-transactions-locked', 'skipped', 'already present');
  }

  // Enforce transactions.portfolio_id as NOT NULL (schema-level integrity)
  const txnColInfo = db.prepare("PRAGMA table_info(transactions)").all();
  const portfolioIdCol = txnColInfo.find(c => c.name === 'portfolio_id');
  const portfolioIdIsNullable = portfolioIdCol && Number(portfolioIdCol.notnull) === 0;
  const portfolioNotNullMigrationId = '20260412-enforce-transaction-portfolio-not-null';
  if (portfolioIdIsNullable && !hasMigrationRecord(db, portfolioNotNullMigrationId)) {
    if (!migrationsEnabled) {
      throw new Error(`Pending migration ${portfolioNotNullMigrationId} detected but migrations are disabled. Set ALLOW_DB_MIGRATIONS=true and restart.`);
    }

    const nullPortfolioRows = db.prepare('SELECT COUNT(*) AS c FROM transactions WHERE portfolio_id IS NULL').get().c;
    if (nullPortfolioRows > 0) {
      throw new Error(`Migration blocked: ${nullPortfolioRows} transactions have NULL portfolio_id. Please fix data before enforcing NOT NULL.`);
    }

    const beforeTransactions = getTableCount(db, 'transactions');
    const backupPath = createPreMigrationBackup(db, 'enforce-transaction-portfolio-not-null');
    if (backupPath) console.log(`Created migration backup: ${backupPath}`);

    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      db.exec(`
        CREATE TABLE transactions_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          investment_id INTEGER NOT NULL,
          portfolio_id INTEGER NOT NULL,
          transaction_type TEXT NOT NULL CHECK(transaction_type IN ('BUY', 'SELL', 'DEPOSIT', 'WITHDRAWAL', 'DIVIDEND', 'INTEREST', 'SPLIT', 'BONUS', 'RIGHTS', 'MERGER', 'CONSOLIDATION', 'IPO', 'TRANSFER_IN', 'TRANSFER_OUT', 'TRANSFER', 'SWITCH_IN', 'SWITCH_OUT', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'CHARGES', 'AMC', 'REDEMPTION')),
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

      const copiedTransactions = getTableCount(db, 'transactions_new');
      ensureRowCountPreserved({
        before: beforeTransactions,
        after: copiedTransactions,
        table: 'transactions',
        migrationName: 'enforce-transaction-portfolio-not-null',
      });

      db.exec('DROP TABLE transactions');
      db.exec('ALTER TABLE transactions_new RENAME TO transactions');
      db.exec("CREATE INDEX IF NOT EXISTS idx_transactions_investment ON transactions(investment_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(transaction_date)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_transactions_portfolio ON transactions(portfolio_id)");
      db.exec('COMMIT');
      assertDbIntegrity(db, portfolioNotNullMigrationId);
      recordMigration(db, portfolioNotNullMigrationId, 'applied');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  } else if (!hasMigrationRecord(db, portfolioNotNullMigrationId) && !portfolioIdIsNullable) {
    recordMigration(db, portfolioNotNullMigrationId, 'skipped', 'portfolio_id already NOT NULL');
  }

  // Add previous_isin_codes column if missing
  const invCols = db.prepare("PRAGMA table_info(investments)").all().map(c => c.name);
  if (requireMigrationsEnabled('20260412-add-investments-previous-isin-codes', !invCols.includes('previous_isin_codes'), 'investments.previous_isin_codes missing')) {
    db.exec("ALTER TABLE investments ADD COLUMN previous_isin_codes TEXT");
    assertDbIntegrity(db, '20260412-add-investments-previous-isin-codes');
    recordMigration(db, '20260412-add-investments-previous-isin-codes', 'applied');
  } else if (!hasMigrationRecord(db, '20260412-add-investments-previous-isin-codes') && invCols.includes('previous_isin_codes')) {
    recordMigration(db, '20260412-add-investments-previous-isin-codes', 'skipped', 'already present');
  }

  // Add folio_number to transactions (folio is per-transaction, not per-investment)
  if (requireMigrationsEnabled('20260412-add-transactions-folio-number', !txnCols.includes('folio_number'), 'transactions.folio_number missing')) {
    db.exec("ALTER TABLE transactions ADD COLUMN folio_number TEXT");
    assertDbIntegrity(db, '20260412-add-transactions-folio-number');
    recordMigration(db, '20260412-add-transactions-folio-number', 'applied');
  } else if (!hasMigrationRecord(db, '20260412-add-transactions-folio-number') && txnCols.includes('folio_number')) {
    recordMigration(db, '20260412-add-transactions-folio-number', 'skipped', 'already present');
  }

  // Add is_active column (default active) for skipping price updates on delisted investments
  if (requireMigrationsEnabled('20260412-add-investments-is-active', !invCols.includes('is_active'), 'investments.is_active missing')) {
    db.exec("ALTER TABLE investments ADD COLUMN is_active INTEGER DEFAULT 1");
    assertDbIntegrity(db, '20260412-add-investments-is-active');
    recordMigration(db, '20260412-add-investments-is-active', 'applied');
  } else if (!hasMigrationRecord(db, '20260412-add-investments-is-active') && invCols.includes('is_active')) {
    recordMigration(db, '20260412-add-investments-is-active', 'skipped', 'already present');
  }

  // Add exclude_from_tracking column for skipping derived/synthetic investments in daily_values and dashboard
  if (requireMigrationsEnabled('20260412-add-investments-exclude-from-tracking', !invCols.includes('exclude_from_tracking'), 'investments.exclude_from_tracking missing')) {
    db.exec("ALTER TABLE investments ADD COLUMN exclude_from_tracking INTEGER DEFAULT 0");
    assertDbIntegrity(db, '20260412-add-investments-exclude-from-tracking');
    recordMigration(db, '20260412-add-investments-exclude-from-tracking', 'applied');
  } else if (!hasMigrationRecord(db, '20260412-add-investments-exclude-from-tracking') && invCols.includes('exclude_from_tracking')) {
    recordMigration(db, '20260412-add-investments-exclude-from-tracking', 'skipped', 'already present');
  }

  // Add category to investments (Equity, Debt, Hybrid, ELSS, etc.)
  if (requireMigrationsEnabled('20260412-add-investments-category', !invCols.includes('category'), 'investments.category missing')) {
    db.exec("ALTER TABLE investments ADD COLUMN category TEXT");
    // Auto-populate category for mutual funds from name heuristics
    const mfs = db.prepare("SELECT id, name FROM investments WHERE asset_type = 'MUTUAL_FUND' AND category IS NULL").all();
    const updateCat = db.prepare("UPDATE investments SET category = ? WHERE id = ?");
    for (const mf of mfs) {
      const cat = inferMFCategory(mf.name);
      if (cat) updateCat.run(cat, mf.id);
    }
    assertDbIntegrity(db, '20260412-add-investments-category');
    recordMigration(db, '20260412-add-investments-category', 'applied');
  } else if (!hasMigrationRecord(db, '20260412-add-investments-category') && invCols.includes('category')) {
    recordMigration(db, '20260412-add-investments-category', 'skipped', 'already present');
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
    insertConfig.run('backfill_watermark', '');
  }

  // Add opening_balance to investments (for PPF/SSY/PF: balance carried forward from before first imported statement)
  if (requireMigrationsEnabled('20260412-add-investments-opening-balance', !invCols.includes('opening_balance'), 'investments.opening_balance missing')) {
    db.exec("ALTER TABLE investments ADD COLUMN opening_balance REAL DEFAULT 0");
    assertDbIntegrity(db, '20260412-add-investments-opening-balance');
    recordMigration(db, '20260412-add-investments-opening-balance', 'applied');
  } else if (!hasMigrationRecord(db, '20260412-add-investments-opening-balance') && invCols.includes('opening_balance')) {
    recordMigration(db, '20260412-add-investments-opening-balance', 'skipped', 'already present');
  }

  // ── Migration: add NPS asset_type and new transaction types ──────────
  // SQLite doesn't allow ALTER CHECK, so we recreate the tables if needed.
  const hasNPS = (() => {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='investments'").get();
    return row && row.sql.includes("'NPS'");
  })();
  const npsMigrationId = '20260412-add-nps-asset-and-types';

  if (!hasNPS && !hasMigrationRecord(db, npsMigrationId)) {
    if (!migrationsEnabled) {
      throw new Error(`Pending migration ${npsMigrationId} detected but migrations are disabled. Set ALLOW_DB_MIGRATIONS=true and restart.`);
    }

    console.log('Migrating: adding NPS asset_type and new transaction types...');
    const beforeInvestments = getTableCount(db, 'investments');
    const beforeTransactions = getTableCount(db, 'transactions');
    const backupPath = createPreMigrationBackup(db, 'add-nps-asset-and-types');
    if (backupPath) console.log(`Created migration backup: ${backupPath}`);

    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      // Recreate investments table with NPS
      db.exec(`
        CREATE TABLE investments_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          asset_type TEXT NOT NULL CHECK(asset_type IN ('INDIAN_STOCK', 'MUTUAL_FUND', 'FOREIGN_STOCK', 'PPF', 'SSY', 'PF', 'BOND', 'NPS', 'SGB')),
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

      const copiedInvestments = getTableCount(db, 'investments_new');
      ensureRowCountPreserved({
        before: beforeInvestments,
        after: copiedInvestments,
        table: 'investments',
        migrationName: 'add-nps-asset-and-types',
      });

      db.exec("DROP TABLE investments");
      db.exec("ALTER TABLE investments_new RENAME TO investments");

      // Recreate transactions table with new types
      db.exec(`
        CREATE TABLE transactions_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          investment_id INTEGER NOT NULL,
          portfolio_id INTEGER NOT NULL,
          transaction_type TEXT NOT NULL CHECK(transaction_type IN ('BUY', 'SELL', 'DEPOSIT', 'WITHDRAWAL', 'DIVIDEND', 'INTEREST', 'SPLIT', 'BONUS', 'RIGHTS', 'MERGER', 'CONSOLIDATION', 'IPO', 'TRANSFER_IN', 'TRANSFER_OUT', 'TRANSFER', 'SWITCH_IN', 'SWITCH_OUT', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'CHARGES', 'AMC', 'REDEMPTION')),
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

      const copiedTransactions = getTableCount(db, 'transactions_new');
      ensureRowCountPreserved({
        before: beforeTransactions,
        after: copiedTransactions,
        table: 'transactions',
        migrationName: 'add-nps-asset-and-types',
      });

      db.exec("DROP TABLE transactions");
      db.exec("ALTER TABLE transactions_new RENAME TO transactions");

      // Recreate indexes
      db.exec("CREATE INDEX IF NOT EXISTS idx_transactions_investment ON transactions(investment_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(transaction_date)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_transactions_portfolio ON transactions(portfolio_id)");

      db.exec('COMMIT');
      assertDbIntegrity(db, npsMigrationId);
      recordMigration(db, npsMigrationId, 'applied');
      console.log('Migration complete: NPS and new transaction types added.');
    } catch (err) {
      db.exec('ROLLBACK');
      console.error('NPS migration failed:', err);
      throw err;
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  } else if (!hasMigrationRecord(db, npsMigrationId) && hasNPS) {
    recordMigration(db, npsMigrationId, 'skipped', 'NPS already present');
  }

  // ── Migration: add AMC transaction_type ──────────────────────────────
  // Preserve existing data while extending transactions CHECK constraint.
  const hasAMCTransactionType = (() => {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='transactions'").get();
    return row && row.sql && row.sql.includes("'AMC'");
  })();
  const amcMigrationId = '20260412-add-amc-transaction-type';

  if (!hasAMCTransactionType && !hasMigrationRecord(db, amcMigrationId)) {
    if (!migrationsEnabled) {
      throw new Error(`Pending migration ${amcMigrationId} detected but migrations are disabled. Set ALLOW_DB_MIGRATIONS=true and restart.`);
    }

    console.log('Migrating: adding AMC transaction_type...');
    const beforeTransactions = getTableCount(db, 'transactions');
    const backupPath = createPreMigrationBackup(db, 'add-amc-transaction-type');
    if (backupPath) console.log(`Created migration backup: ${backupPath}`);

    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      db.exec(`
        CREATE TABLE transactions_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          investment_id INTEGER NOT NULL,
          portfolio_id INTEGER NOT NULL,
          transaction_type TEXT NOT NULL CHECK(transaction_type IN ('BUY', 'SELL', 'DEPOSIT', 'WITHDRAWAL', 'DIVIDEND', 'INTEREST', 'SPLIT', 'BONUS', 'RIGHTS', 'MERGER', 'CONSOLIDATION', 'IPO', 'TRANSFER_IN', 'TRANSFER_OUT', 'TRANSFER', 'SWITCH_IN', 'SWITCH_OUT', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'CHARGES', 'AMC', 'REDEMPTION')),
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

      const copiedTransactions = getTableCount(db, 'transactions_new');
      ensureRowCountPreserved({
        before: beforeTransactions,
        after: copiedTransactions,
        table: 'transactions',
        migrationName: 'add-amc-transaction-type',
      });

      db.exec('DROP TABLE transactions');
      db.exec('ALTER TABLE transactions_new RENAME TO transactions');
      db.exec("CREATE INDEX IF NOT EXISTS idx_transactions_investment ON transactions(investment_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(transaction_date)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_transactions_portfolio ON transactions(portfolio_id)");
      db.exec('COMMIT');
      assertDbIntegrity(db, amcMigrationId);
      recordMigration(db, amcMigrationId, 'applied');
      console.log('Migration complete: AMC transaction_type added.');
    } catch (err) {
      db.exec('ROLLBACK');
      console.error('AMC migration failed:', err);
      throw err;
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  } else if (!hasMigrationRecord(db, amcMigrationId) && hasAMCTransactionType) {
    recordMigration(db, amcMigrationId, 'skipped', 'AMC type already present');
  }

  // ── Migration: add SSY asset_type and interest rate ──────────────────
  const hasSSY = (() => {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='investments'").get();
    return row && row.sql.includes("'SSY'");
  })();
  const ssyMigrationId = '20260412-add-ssy-asset-type';

  if (!hasSSY && !hasMigrationRecord(db, ssyMigrationId)) {
    if (!migrationsEnabled) {
      throw new Error(`Pending migration ${ssyMigrationId} detected but migrations are disabled. Set ALLOW_DB_MIGRATIONS=true and restart.`);
    }

    console.log('Migrating: adding SSY asset_type...');
    const beforeInvestments = getTableCount(db, 'investments');
    const beforeRates = getTableCount(db, 'interest_rates');
    const backupPath = createPreMigrationBackup(db, 'add-ssy-asset-type');
    if (backupPath) console.log(`Created migration backup: ${backupPath}`);

    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      // Recreate investments table with SSY
      db.exec(`
        CREATE TABLE investments_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          asset_type TEXT NOT NULL CHECK(asset_type IN ('INDIAN_STOCK', 'MUTUAL_FUND', 'FOREIGN_STOCK', 'PPF', 'SSY', 'PF', 'BOND', 'NPS', 'SGB')),
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

      const copiedInvestments = getTableCount(db, 'investments_new');
      ensureRowCountPreserved({
        before: beforeInvestments,
        after: copiedInvestments,
        table: 'investments',
        migrationName: 'add-ssy-asset-type',
      });

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

      const copiedRates = getTableCount(db, 'interest_rates_new');
      ensureRowCountPreserved({
        before: beforeRates,
        after: copiedRates,
        table: 'interest_rates',
        migrationName: 'add-ssy-asset-type',
      });

      db.exec("DROP TABLE interest_rates");
      db.exec("ALTER TABLE interest_rates_new RENAME TO interest_rates");

      // Seed SSY rate if not already present
      const ssyExists = db.prepare("SELECT COUNT(*) as count FROM interest_rates WHERE rate_type = 'SSY'").get();
      if (ssyExists.count === 0) {
        db.prepare("INSERT INTO interest_rates (rate_type, rate, effective_from) VALUES ('SSY', 8.2, '2024-04-01')").run();
      }

      db.exec('COMMIT');
      assertDbIntegrity(db, ssyMigrationId);
      recordMigration(db, ssyMigrationId, 'applied');
      console.log('Migration complete: SSY asset_type added.');
    } catch (err) {
      db.exec('ROLLBACK');
      console.error('SSY migration failed:', err);
      throw err;
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  } else if (!hasMigrationRecord(db, ssyMigrationId) && hasSSY) {
    recordMigration(db, ssyMigrationId, 'skipped', 'SSY already present');
  }

  // ── Migration: add portfolio_id to daily_values ──────────────────────
  // SAFE: Only add column if missing; don't drop data (these are caches, not source data)
  const dvCols = db.prepare("PRAGMA table_info(daily_values)").all().map(c => c.name);
  if (requireMigrationsEnabled('20260412-add-daily-values-portfolio-id', !dvCols.includes('portfolio_id'), 'daily_values.portfolio_id missing')) {
    console.log('Migrating daily_values: adding portfolio_id column (preserving old data)...');
    try {
      db.exec('ALTER TABLE daily_values ADD COLUMN portfolio_id INTEGER DEFAULT NULL');
      db.exec('CREATE INDEX IF NOT EXISTS idx_daily_values_portfolio ON daily_values(portfolio_id, date)');
      assertDbIntegrity(db, '20260412-add-daily-values-portfolio-id');
      recordMigration(db, '20260412-add-daily-values-portfolio-id', 'applied');
      console.log('Migration complete: portfolio_id column added to daily_values.');
    } catch (err) {
      // If ALTER fails, it's likely already present; continue
      console.log('daily_values portfolio_id migration: column may already exist or table is new');
    }
  } else if (!hasMigrationRecord(db, '20260412-add-daily-values-portfolio-id') && dvCols.includes('portfolio_id')) {
    recordMigration(db, '20260412-add-daily-values-portfolio-id', 'skipped', 'already present');
  }

  const pdCols = db.prepare("PRAGMA table_info(portfolio_daily)").all().map(c => c.name);
  if (requireMigrationsEnabled('20260412-add-portfolio-daily-day-change', !pdCols.includes('day_change'), 'portfolio_daily.day_change missing')) {
    console.log('Migrating portfolio_daily: adding day_change columns...');
    try {
      db.exec('ALTER TABLE portfolio_daily ADD COLUMN day_change REAL DEFAULT 0');
      db.exec('ALTER TABLE portfolio_daily ADD COLUMN day_change_pct REAL DEFAULT 0');
      db.exec('CREATE INDEX IF NOT EXISTS idx_portfolio_daily_date ON portfolio_daily(date)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_portfolio_daily_portfolio ON portfolio_daily(portfolio_id, date)');
      assertDbIntegrity(db, '20260412-add-portfolio-daily-day-change');
      recordMigration(db, '20260412-add-portfolio-daily-day-change', 'applied');
      console.log('Migration complete: portfolio_daily columns added.');
    } catch (err) {
      // If ALTER fails, it's likely already present; continue
      console.log('portfolio_daily migration: columns may already exist or table is new');
    }
  } else if (!hasMigrationRecord(db, '20260412-add-portfolio-daily-day-change') && pdCols.includes('day_change')) {
    recordMigration(db, '20260412-add-portfolio-daily-day-change', 'skipped', 'already present');
  }

  // ── Migration: add EPS_CONTRIBUTION transaction_type + merge EPS investments ──────
    // EPS (Employee Pension Scheme) contributions are always tied to a PF account, not a
    // separate investment. This migration:
    //   1. Adds EPS_CONTRIBUTION to the transactions CHECK constraint.
    //   2. For every PF investment whose name contains "EPS", locates the paired non-EPS
    //      PF investment in the same portfolio, moves all EMPLOYER_CONTRIBUTION rows to it
    //      with type EPS_CONTRIBUTION, then marks the EPS investment as inactive.
    const hasEPSContributionType = (() => {
      const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='transactions'").get();
      return row && row.sql && row.sql.includes("'EPS_CONTRIBUTION'");
    })();
    const epsMigrationId = '20260413-add-eps-contribution-type';

    if (!hasEPSContributionType && !hasMigrationRecord(db, epsMigrationId)) {
      if (!migrationsEnabled) {
        throw new Error(`Pending migration ${epsMigrationId} detected but migrations are disabled. Set ALLOW_DB_MIGRATIONS=true and restart.`);
      }

      console.log('Migrating: adding EPS_CONTRIBUTION transaction_type and merging EPS investments...');
      const beforeTransactions = getTableCount(db, 'transactions');
      const backupPath = createPreMigrationBackup(db, 'add-eps-contribution-type');
      if (backupPath) console.log(`Created migration backup: ${backupPath}`);

      db.exec('PRAGMA foreign_keys = OFF');
      db.exec('BEGIN');
      try {
        // Step 1: recreate transactions with EPS_CONTRIBUTION in CHECK
        db.exec(`
          CREATE TABLE transactions_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            investment_id INTEGER NOT NULL,
            portfolio_id INTEGER NOT NULL,
            transaction_type TEXT NOT NULL CHECK(transaction_type IN (
              'BUY', 'SELL', 'DEPOSIT', 'WITHDRAWAL', 'DIVIDEND', 'INTEREST',
              'SPLIT', 'BONUS', 'RIGHTS', 'MERGER', 'CONSOLIDATION', 'IPO',
              'TRANSFER_IN', 'TRANSFER_OUT', 'TRANSFER', 'SWITCH_IN', 'SWITCH_OUT',
              'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'CHARGES', 'AMC',
              'REDEMPTION', 'EPS_CONTRIBUTION'
            )),
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
        db.exec(`INSERT INTO transactions_new
          SELECT id, investment_id, portfolio_id, transaction_type, transaction_date,
                 units, price_per_unit, amount, fees, broker, notes,
                 locked, folio_number, created_at
          FROM transactions`);

        const copiedTransactions = getTableCount(db, 'transactions_new');
        ensureRowCountPreserved({ before: beforeTransactions, after: copiedTransactions, table: 'transactions', migrationName: 'add-eps-contribution-type' });

        db.exec('DROP TABLE transactions');
        db.exec('ALTER TABLE transactions_new RENAME TO transactions');
        db.exec('CREATE INDEX IF NOT EXISTS idx_transactions_investment ON transactions(investment_id)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(transaction_date)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_transactions_portfolio ON transactions(portfolio_id)');

        // Step 2: for each EPS investment, find its paired PF and migrate transactions
      // To find the paired PF, we look at transactions to get portfolio_id (not stored on investments)
      const epsInvestments = db.prepare(`
        SELECT DISTINCT i.id, i.name, i.display_name
        FROM investments i
        WHERE i.asset_type = 'PF'
          AND (i.name LIKE '%EPS%' OR COALESCE(i.display_name, '') LIKE '%EPS%')
      `).all();

      const findPortfolioForInvestment = db.prepare(`
        SELECT DISTINCT t.portfolio_id FROM transactions t
        WHERE t.investment_id = ? LIMIT 1
      `);
      const findPairedPF = db.prepare(`
        SELECT DISTINCT i.id FROM investments i
        INNER JOIN transactions t ON t.investment_id = i.id
        WHERE i.asset_type = 'PF' AND i.id != ?
          AND t.portfolio_id = ?
          AND i.name NOT LIKE '%EPS%'
          AND COALESCE(i.display_name, '') NOT LIKE '%EPS%'
        LIMIT 1
      `);
      const moveTxns = db.prepare(`
        UPDATE transactions
        SET investment_id = ?, transaction_type = 'EPS_CONTRIBUTION'
        WHERE investment_id = ? AND transaction_type = 'EMPLOYER_CONTRIBUTION'
      `);
      const markInactive = db.prepare('UPDATE investments SET is_active = 0 WHERE id = ?');

      let totalMoved = 0;
      for (const eps of epsInvestments) {
        const portRow = findPortfolioForInvestment.get(eps.id);
        if (!portRow) {
          console.log(`EPS migration: investment ${eps.id} (${eps.name || eps.display_name}) has no transactions, skipping`);
          continue;
        }
        const paired = findPairedPF.get(eps.id, portRow.portfolio_id);
        if (!paired) {
          console.log(`EPS migration: no paired PF found for investment ${eps.id} in portfolio ${portRow.portfolio_id}, skipping`);
          }
          const { changes } = moveTxns.run(paired.id, eps.id);
          totalMoved += changes;
          markInactive.run(eps.id);
          console.log(`EPS migration: moved ${changes} EPS_CONTRIBUTION rows from investment ${eps.id} → ${paired.id}`);
        }

        db.exec('COMMIT');
        assertDbIntegrity(db, epsMigrationId);
        recordMigration(db, epsMigrationId, 'applied', `Migrated ${totalMoved} EPS transactions`);
        console.log(`Migration complete: EPS_CONTRIBUTION added, ${totalMoved} transactions merged.`);
      } catch (err) {
        db.exec('ROLLBACK');
        console.error('EPS migration failed:', err);
        throw err;
      } finally {
        db.exec('PRAGMA foreign_keys = ON');
      }
    } else if (!hasMigrationRecord(db, epsMigrationId) && hasEPSContributionType) {
      recordMigration(db, epsMigrationId, 'skipped', 'EPS_CONTRIBUTION already present');
  }

  // ── Migration: add SGB asset_type ──────────────────────────────────
  const hasSGBType = (() => {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='investments'").get();
    return row && row.sql && row.sql.includes("'SGB'");
  })();
  const sgbMigrationId = '20260502-add-sgb-asset-type';

  if (!hasSGBType && !hasMigrationRecord(db, sgbMigrationId)) {
    if (!migrationsEnabled) {
      throw new Error(`Pending migration ${sgbMigrationId} detected but migrations are disabled. Set ALLOW_DB_MIGRATIONS=true and restart.`);
    }

    console.log('Migrating: adding SGB asset_type...');
    const beforeInvestments = getTableCount(db, 'investments');
    const backupPath = createPreMigrationBackup(db, 'add-sgb-asset-type');
    if (backupPath) console.log(`Created migration backup: ${backupPath}`);

    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      // Get current table structure to build safe INSERT statement
      const currentCols = db.prepare("PRAGMA table_info(investments)").all().map(c => c.name);
      console.log('Current investments columns:', currentCols.join(', '));
      
      // Map of all possible columns in order
      const allCols = [
        'id', 'name', 'asset_type', 'ticker_symbol', 'amfi_code', 'account_number',
        'interest_rate', 'currency', 'face_value', 'coupon_frequency', 'maturity_date',
        'notes', 'display_name', 'isin_code', 'previous_isin_codes', 'is_active',
        'category', 'created_at', 'updated_at'
      ];
      
      // Build INSERT statement with only existing columns
      const colsToUse = allCols.filter(c => currentCols.includes(c));
      const selectParts = colsToUse.map(c => c === 'is_active' ? 'COALESCE(is_active, 1)' : c);
      const insertStmt = `INSERT INTO investments_new (${colsToUse.join(', ')}) SELECT ${selectParts.join(', ')} FROM investments`;
      
      console.log('Using columns:', colsToUse.join(', '));
      
      // Recreate investments table with SGB
      db.exec(`
        CREATE TABLE investments_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          asset_type TEXT NOT NULL CHECK(asset_type IN ('INDIAN_STOCK', 'MUTUAL_FUND', 'FOREIGN_STOCK', 'PPF', 'SSY', 'PF', 'BOND', 'NPS', 'SGB')),
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
      
      db.exec(insertStmt);

      const copiedInvestments = getTableCount(db, 'investments_new');
      ensureRowCountPreserved({
        before: beforeInvestments,
        after: copiedInvestments,
        table: 'investments',
        migrationName: 'add-sgb-asset-type',
      });

      db.exec("DROP TABLE investments");
      db.exec("ALTER TABLE investments_new RENAME TO investments");
      db.exec("CREATE INDEX IF NOT EXISTS idx_investments_asset_type ON investments(asset_type)");

      db.exec('COMMIT');
      assertDbIntegrity(db, sgbMigrationId);
      recordMigration(db, sgbMigrationId, 'applied');
      console.log('Migration complete: SGB asset_type added.');
    } catch (err) {
      db.exec('ROLLBACK');
      console.error('SGB migration failed:', err);
      throw err;
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  } else if (!hasMigrationRecord(db, sgbMigrationId) && hasSGBType) {
    recordMigration(db, sgbMigrationId, 'skipped', 'SGB already present');
  }

  // Reconcile investments columns that older table-recreate migrations may have dropped.
  // This is additive and safe to run in all environments.
  const reconcileInvestmentColsMigrationId = '20260509-reconcile-investments-missing-columns';
  const invColsNow = new Set(db.prepare("PRAGMA table_info(investments)").all().map(c => c.name));
  const addedInvestmentCols = [];

  if (!invColsNow.has('opening_balance')) {
    db.exec("ALTER TABLE investments ADD COLUMN opening_balance REAL DEFAULT 0");
    addedInvestmentCols.push('opening_balance');
  }
  if (!invColsNow.has('exclude_from_tracking')) {
    db.exec("ALTER TABLE investments ADD COLUMN exclude_from_tracking INTEGER DEFAULT 0");
    addedInvestmentCols.push('exclude_from_tracking');
  }
  if (!invColsNow.has('coupon_rate')) {
    db.exec("ALTER TABLE investments ADD COLUMN coupon_rate REAL");
    addedInvestmentCols.push('coupon_rate');
  }

  if (addedInvestmentCols.length > 0) {
    assertDbIntegrity(db, reconcileInvestmentColsMigrationId);
    recordMigration(db, reconcileInvestmentColsMigrationId, 'applied', `Added: ${addedInvestmentCols.join(', ')}`);
  } else if (!hasMigrationRecord(db, reconcileInvestmentColsMigrationId)) {
    recordMigration(db, reconcileInvestmentColsMigrationId, 'skipped', 'required columns already present');
  }

  // Normalize transaction_date storage to date-only across all transaction types.
  // Also enforce normalization for future inserts/updates via triggers.
  const normalizeTxnDateMigrationId = '20260509-normalize-transaction-date-storage';
  if (!hasMigrationRecord(db, normalizeTxnDateMigrationId)) {
    if (!migrationsEnabled) {
      throw new Error(`Pending migration ${normalizeTxnDateMigrationId} detected but migrations are disabled. Set ALLOW_DB_MIGRATIONS=true and restart.`);
    }

    db.exec('BEGIN');
    try {
      db.exec(`
        UPDATE transactions
        SET transaction_date = date(transaction_date)
        WHERE transaction_date IS NOT NULL
          AND date(transaction_date) IS NOT NULL
          AND transaction_date != date(transaction_date)
      `);

      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_transactions_normalize_date_after_insert
        AFTER INSERT ON transactions
        FOR EACH ROW
        WHEN NEW.transaction_date IS NOT NULL
         AND date(NEW.transaction_date) IS NOT NULL
         AND NEW.transaction_date != date(NEW.transaction_date)
        BEGIN
          UPDATE transactions
          SET transaction_date = date(NEW.transaction_date)
          WHERE id = NEW.id;
        END;
      `);

      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_transactions_normalize_date_after_update
        AFTER UPDATE OF transaction_date ON transactions
        FOR EACH ROW
        WHEN NEW.transaction_date IS NOT NULL
         AND date(NEW.transaction_date) IS NOT NULL
         AND NEW.transaction_date != date(NEW.transaction_date)
        BEGIN
          UPDATE transactions
          SET transaction_date = date(NEW.transaction_date)
          WHERE id = NEW.id;
        END;
      `);

      db.exec('COMMIT');
      assertDbIntegrity(db, normalizeTxnDateMigrationId);
      recordMigration(db, normalizeTxnDateMigrationId, 'applied', 'normalized existing rows and added normalization triggers');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  // ── Migration: add VEST / ESPP_PURCHASE transaction types + RSU/ESPP columns ──
  // Adds:
  //   - VEST and ESPP_PURCHASE to the transactions CHECK constraint
  //   - exchange_rate_used REAL  (USD/INR RBI rate on the transaction date)
  //   - usd_amount REAL          (raw USD value)
  //   - fmv_per_unit REAL        (FMV per share on date; ESPP only)
  const hasVESTType = (() => {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='transactions'").get();
    return row && row.sql && row.sql.includes("'VEST'");
  })();
  const rsuMigrationId = '20260502-add-rsu-espp-transaction-types';

  if (!hasVESTType && !hasMigrationRecord(db, rsuMigrationId)) {
    if (!migrationsEnabled) {
      throw new Error(`Pending migration ${rsuMigrationId} detected but migrations are disabled. Set ALLOW_DB_MIGRATIONS=true and restart.`);
    }

    console.log('Migrating: adding VEST, ESPP_PURCHASE types and RSU columns...');
    const beforeTransactions = getTableCount(db, 'transactions');
    const backupPath = createPreMigrationBackup(db, 'add-rsu-espp-transaction-types');
    if (backupPath) console.log(`Created migration backup: ${backupPath}`);

    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      db.exec(`
        CREATE TABLE transactions_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          investment_id INTEGER NOT NULL,
          portfolio_id INTEGER NOT NULL,
          transaction_type TEXT NOT NULL CHECK(transaction_type IN (
            'BUY', 'SELL', 'DEPOSIT', 'WITHDRAWAL', 'DIVIDEND', 'INTEREST',
            'SPLIT', 'BONUS', 'RIGHTS', 'MERGER', 'CONSOLIDATION', 'IPO',
            'TRANSFER_IN', 'TRANSFER_OUT', 'TRANSFER', 'SWITCH_IN', 'SWITCH_OUT',
            'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'CHARGES', 'AMC',
            'REDEMPTION', 'EPS_CONTRIBUTION', 'VEST', 'ESPP_PURCHASE', 'ESPP_CONTRIBUTION'
          )),
          transaction_date TEXT NOT NULL,
          units REAL,
          price_per_unit REAL,
          amount REAL NOT NULL,
          fees REAL DEFAULT 0,
          broker TEXT,
          notes TEXT,
          locked INTEGER DEFAULT 0,
          folio_number TEXT,
          exchange_rate_used REAL,
          usd_amount REAL,
          fmv_per_unit REAL,
          gross_units REAL,
          tax_withheld_units REAL,
          stt REAL,
          created_at TEXT DEFAULT (datetime('now')),
          FOREIGN KEY (investment_id) REFERENCES investments(id) ON DELETE CASCADE
        )
      `);

      // Copy existing rows; new columns default to NULL
      const existingCols = db.prepare("PRAGMA table_info(transactions)").all().map(c => c.name);
      const knownCols = [
        'id', 'investment_id', 'portfolio_id', 'transaction_type', 'transaction_date',
        'units', 'price_per_unit', 'amount', 'fees', 'broker', 'notes',
        'locked', 'folio_number', 'created_at',
      ];
      const colsToCopy = knownCols.filter(c => existingCols.includes(c));
      db.exec(`INSERT INTO transactions_new (${colsToCopy.join(', ')}) SELECT ${colsToCopy.join(', ')} FROM transactions`);

      const copiedTransactions = getTableCount(db, 'transactions_new');
      ensureRowCountPreserved({
        before: beforeTransactions,
        after: copiedTransactions,
        table: 'transactions',
        migrationName: 'add-rsu-espp-transaction-types',
      });

      db.exec('DROP TABLE transactions');
      db.exec('ALTER TABLE transactions_new RENAME TO transactions');
      db.exec('CREATE INDEX IF NOT EXISTS idx_transactions_investment ON transactions(investment_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(transaction_date)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_transactions_portfolio ON transactions(portfolio_id)');

      db.exec('COMMIT');
      assertDbIntegrity(db, rsuMigrationId);
      recordMigration(db, rsuMigrationId, 'applied');
      console.log('Migration complete: VEST/ESPP_PURCHASE types and RSU columns added.');
    } catch (err) {
      db.exec('ROLLBACK');
      console.error('RSU/ESPP migration failed:', err);
      throw err;
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  } else if (!hasMigrationRecord(db, rsuMigrationId) && hasVESTType) {
    recordMigration(db, rsuMigrationId, 'skipped', 'VEST type already present');
  }

  // ── Migration: add vest withholding columns on transactions ────────────────
  // Adds:
  //   - gross_units REAL        (pre-tax vested shares; mainly for VEST)
  //   - tax_withheld_units REAL (shares withheld/sold for tax at vest)
  const txnColsWithholding = db.prepare('PRAGMA table_info(transactions)').all().map((c) => c.name);
  const hasGrossUnits = txnColsWithholding.includes('gross_units');
  const hasTaxWithheldUnits = txnColsWithholding.includes('tax_withheld_units');
  const vestWithholdingMigrationId = '20260503-add-vest-withholding-columns';

  if ((!hasGrossUnits || !hasTaxWithheldUnits) && !hasMigrationRecord(db, vestWithholdingMigrationId)) {
    if (!migrationsEnabled) {
      throw new Error(`Pending migration ${vestWithholdingMigrationId} detected but migrations are disabled. Set ALLOW_DB_MIGRATIONS=true and restart.`);
    }

    console.log('Migrating: adding gross_units and tax_withheld_units columns...');
    const beforeTransactions = getTableCount(db, 'transactions');
    const backupPath = createPreMigrationBackup(db, 'add-vest-withholding-columns');
    if (backupPath) console.log(`Created migration backup: ${backupPath}`);

    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      db.exec(`
        CREATE TABLE transactions_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          investment_id INTEGER NOT NULL,
          portfolio_id INTEGER NOT NULL,
          transaction_type TEXT NOT NULL CHECK(transaction_type IN (
            'BUY', 'SELL', 'DEPOSIT', 'WITHDRAWAL', 'DIVIDEND', 'INTEREST', 'RECONCILE',
            'SPLIT', 'BONUS', 'RIGHTS', 'MERGER', 'CONSOLIDATION', 'IPO',
            'TRANSFER_IN', 'TRANSFER_OUT', 'TRANSFER', 'SWITCH_IN', 'SWITCH_OUT',
            'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'CHARGES', 'AMC',
            'REDEMPTION', 'EPS_CONTRIBUTION', 'VEST', 'ESPP_PURCHASE', 'ESPP_CONTRIBUTION'
          )),
          transaction_date TEXT NOT NULL,
          units REAL,
          price_per_unit REAL,
          amount REAL NOT NULL,
          fees REAL DEFAULT 0,
          broker TEXT,
          notes TEXT,
          locked INTEGER DEFAULT 0,
          folio_number TEXT,
          exchange_rate_used REAL,
          usd_amount REAL,
          fmv_per_unit REAL,
          gross_units REAL,
          tax_withheld_units REAL,
          created_at TEXT DEFAULT (datetime('now')),
          FOREIGN KEY (investment_id) REFERENCES investments(id) ON DELETE CASCADE
        )
      `);

      const existingCols = db.prepare('PRAGMA table_info(transactions)').all().map((c) => c.name);
      const knownCols = [
        'id', 'investment_id', 'portfolio_id', 'transaction_type', 'transaction_date',
        'units', 'price_per_unit', 'amount', 'fees', 'broker', 'notes',
        'locked', 'folio_number', 'exchange_rate_used', 'usd_amount', 'fmv_per_unit',
        'gross_units', 'tax_withheld_units', 'stt', 'created_at',
      ];
      const colsToCopy = knownCols.filter((c) => existingCols.includes(c));
      db.exec(`INSERT INTO transactions_new (${colsToCopy.join(', ')}) SELECT ${colsToCopy.join(', ')} FROM transactions`);

      const copiedTransactions = getTableCount(db, 'transactions_new');
      ensureRowCountPreserved({
        before: beforeTransactions,
        after: copiedTransactions,
        table: 'transactions',
        migrationName: 'add-vest-withholding-columns',
      });

      db.exec('DROP TABLE transactions');
      db.exec('ALTER TABLE transactions_new RENAME TO transactions');
      db.exec('CREATE INDEX IF NOT EXISTS idx_transactions_investment ON transactions(investment_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(transaction_date)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_transactions_portfolio ON transactions(portfolio_id)');

      db.exec('COMMIT');
      assertDbIntegrity(db, vestWithholdingMigrationId);
      recordMigration(db, vestWithholdingMigrationId, 'applied');
      console.log('Migration complete: gross_units and tax_withheld_units added.');
    } catch (err) {
      db.exec('ROLLBACK');
      console.error('Vest withholding migration failed:', err);
      throw err;
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  } else if (!hasMigrationRecord(db, vestWithholdingMigrationId) && hasGrossUnits && hasTaxWithheldUnits) {
    recordMigration(db, vestWithholdingMigrationId, 'skipped', 'vesting withholding columns already present');
  }

  // ── Migration: add stt column on transactions ──────────────────────────────
  // Securities Transaction Tax portion of `fees` (bundled charge). Stored
  // separately because STT is NOT a deductible cost/transfer expense for
  // capital-gains computation. `fees` remains the full total for back-compat.
  const txnColsStt = db.prepare('PRAGMA table_info(transactions)').all().map((c) => c.name);
  const sttMigrationId = '20260720-add-transactions-stt';
  if (!txnColsStt.includes('stt') && !hasMigrationRecord(db, sttMigrationId)) {
    if (!migrationsEnabled) {
      throw new Error(`Pending migration ${sttMigrationId} detected but migrations are disabled. Set ALLOW_DB_MIGRATIONS=true and restart.`);
    }
    console.log('Migrating: adding stt column to transactions...');
    const backupPath = createPreMigrationBackup(db, 'add-transactions-stt');
    if (backupPath) console.log(`Created migration backup: ${backupPath}`);
    db.exec('ALTER TABLE transactions ADD COLUMN stt REAL');
    recordMigration(db, sttMigrationId, 'applied');
    console.log('Migration complete: stt column added.');
  } else if (!hasMigrationRecord(db, sttMigrationId) && txnColsStt.includes('stt')) {
    recordMigration(db, sttMigrationId, 'skipped', 'stt column already present');
  }

  // ── Migration: add ESPP_CONTRIBUTION transaction type ────────────────
  const hasEsppContributionType = (() => {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='transactions'").get();
    return row && row.sql && row.sql.includes("'ESPP_CONTRIBUTION'");
  })();
  const esppContributionMigrationId = '20260503-add-espp-contribution-transaction-type';

  if (!hasEsppContributionType && !hasMigrationRecord(db, esppContributionMigrationId)) {
    if (!migrationsEnabled) {
      throw new Error(`Pending migration ${esppContributionMigrationId} detected but migrations are disabled. Set ALLOW_DB_MIGRATIONS=true and restart.`);
    }

    console.log('Migrating: adding ESPP_CONTRIBUTION transaction type...');
    const beforeTransactions = getTableCount(db, 'transactions');
    const backupPath = createPreMigrationBackup(db, 'add-espp-contribution-transaction-type');
    if (backupPath) console.log(`Created migration backup: ${backupPath}`);

    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      db.exec(`
        CREATE TABLE transactions_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          investment_id INTEGER NOT NULL,
          portfolio_id INTEGER NOT NULL,
          transaction_type TEXT NOT NULL CHECK(transaction_type IN (
            'BUY', 'SELL', 'DEPOSIT', 'WITHDRAWAL', 'DIVIDEND', 'INTEREST', 'RECONCILE',
            'SPLIT', 'BONUS', 'RIGHTS', 'MERGER', 'CONSOLIDATION', 'IPO',
            'TRANSFER_IN', 'TRANSFER_OUT', 'TRANSFER', 'SWITCH_IN', 'SWITCH_OUT',
            'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'CHARGES', 'AMC',
            'REDEMPTION', 'EPS_CONTRIBUTION', 'VEST', 'ESPP_PURCHASE', 'ESPP_CONTRIBUTION'
          )),
          transaction_date TEXT NOT NULL,
          units REAL,
          price_per_unit REAL,
          amount REAL NOT NULL,
          fees REAL DEFAULT 0,
          broker TEXT,
          notes TEXT,
          locked INTEGER DEFAULT 0,
          folio_number TEXT,
          exchange_rate_used REAL,
          usd_amount REAL,
          fmv_per_unit REAL,
          gross_units REAL,
          tax_withheld_units REAL,
          stt REAL,
          created_at TEXT DEFAULT (datetime('now')),
          FOREIGN KEY (investment_id) REFERENCES investments(id) ON DELETE CASCADE
        )
      `);

      const existingCols = db.prepare('PRAGMA table_info(transactions)').all().map((c) => c.name);
      const knownCols = [
        'id', 'investment_id', 'portfolio_id', 'transaction_type', 'transaction_date',
        'units', 'price_per_unit', 'amount', 'fees', 'broker', 'notes',
        'locked', 'folio_number', 'exchange_rate_used', 'usd_amount', 'fmv_per_unit',
        'gross_units', 'tax_withheld_units', 'stt', 'created_at',
      ];
      const colsToCopy = knownCols.filter((c) => existingCols.includes(c));
      db.exec(`INSERT INTO transactions_new (${colsToCopy.join(', ')}) SELECT ${colsToCopy.join(', ')} FROM transactions`);

      const copiedTransactions = getTableCount(db, 'transactions_new');
      ensureRowCountPreserved({
        before: beforeTransactions,
        after: copiedTransactions,
        table: 'transactions',
        migrationName: 'add-espp-contribution-transaction-type',
      });

      db.exec('DROP TABLE transactions');
      db.exec('ALTER TABLE transactions_new RENAME TO transactions');
      db.exec('CREATE INDEX IF NOT EXISTS idx_transactions_investment ON transactions(investment_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(transaction_date)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_transactions_portfolio ON transactions(portfolio_id)');

      db.exec('COMMIT');
      assertDbIntegrity(db, esppContributionMigrationId);
      recordMigration(db, esppContributionMigrationId, 'applied');
      console.log('Migration complete: ESPP_CONTRIBUTION type added.');
    } catch (err) {
      db.exec('ROLLBACK');
      console.error('ESPP_CONTRIBUTION migration failed:', err);
      throw err;
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  } else if (!hasMigrationRecord(db, esppContributionMigrationId) && hasEsppContributionType) {
    recordMigration(db, esppContributionMigrationId, 'skipped', 'ESPP_CONTRIBUTION type already present');
  }

  // ── Migration: add RECONCILE transaction type ─────────────────────────────
  const hasReconcileType = (() => {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='transactions'").get();
    return row && row.sql && row.sql.includes("'RECONCILE'");
  })();
  const reconcileTypeMigrationId = '20260509-add-reconcile-transaction-type';

  if (!hasReconcileType && !hasMigrationRecord(db, reconcileTypeMigrationId)) {
    if (!migrationsEnabled) {
      throw new Error(`Pending migration ${reconcileTypeMigrationId} detected but migrations are disabled. Set ALLOW_DB_MIGRATIONS=true and restart.`);
    }

    console.log('Migrating: adding RECONCILE transaction type...');
    const beforeTransactions = getTableCount(db, 'transactions');
    const backupPath = createPreMigrationBackup(db, 'add-reconcile-transaction-type');
    if (backupPath) console.log(`Created migration backup: ${backupPath}`);

    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      db.exec(`
        CREATE TABLE transactions_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          investment_id INTEGER NOT NULL,
          portfolio_id INTEGER NOT NULL,
          transaction_type TEXT NOT NULL CHECK(transaction_type IN (
            'BUY', 'SELL', 'DEPOSIT', 'WITHDRAWAL', 'DIVIDEND', 'INTEREST', 'RECONCILE',
            'SPLIT', 'BONUS', 'RIGHTS', 'MERGER', 'CONSOLIDATION', 'IPO',
            'TRANSFER_IN', 'TRANSFER_OUT', 'TRANSFER', 'SWITCH_IN', 'SWITCH_OUT',
            'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'CHARGES', 'AMC',
            'REDEMPTION', 'EPS_CONTRIBUTION', 'VEST', 'ESPP_PURCHASE', 'ESPP_CONTRIBUTION'
          )),
          transaction_date TEXT NOT NULL,
          units REAL,
          price_per_unit REAL,
          amount REAL NOT NULL,
          fees REAL DEFAULT 0,
          broker TEXT,
          notes TEXT,
          locked INTEGER DEFAULT 0,
          folio_number TEXT,
          exchange_rate_used REAL,
          usd_amount REAL,
          fmv_per_unit REAL,
          gross_units REAL,
          tax_withheld_units REAL,
          stt REAL,
          created_at TEXT DEFAULT (datetime('now')),
          FOREIGN KEY (investment_id) REFERENCES investments(id) ON DELETE CASCADE
        )
      `);

      const existingCols = db.prepare('PRAGMA table_info(transactions)').all().map((c) => c.name);
      const knownCols = [
        'id', 'investment_id', 'portfolio_id', 'transaction_type', 'transaction_date',
        'units', 'price_per_unit', 'amount', 'fees', 'broker', 'notes',
        'locked', 'folio_number', 'exchange_rate_used', 'usd_amount', 'fmv_per_unit',
        'gross_units', 'tax_withheld_units', 'stt', 'created_at',
      ];
      const colsToCopy = knownCols.filter((c) => existingCols.includes(c));
      db.exec(`INSERT INTO transactions_new (${colsToCopy.join(', ')}) SELECT ${colsToCopy.join(', ')} FROM transactions`);

      const copiedTransactions = getTableCount(db, 'transactions_new');
      ensureRowCountPreserved({
        before: beforeTransactions,
        after: copiedTransactions,
        table: 'transactions',
        migrationName: 'add-reconcile-transaction-type',
      });

      db.exec('DROP TABLE transactions');
      db.exec('ALTER TABLE transactions_new RENAME TO transactions');
      db.exec('CREATE INDEX IF NOT EXISTS idx_transactions_investment ON transactions(investment_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(transaction_date)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_transactions_portfolio ON transactions(portfolio_id)');

      // Recreate date-normalization triggers because table recreation drops existing triggers.
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_transactions_normalize_date_after_insert
        AFTER INSERT ON transactions
        FOR EACH ROW
        WHEN NEW.transaction_date IS NOT NULL
         AND date(NEW.transaction_date) IS NOT NULL
         AND NEW.transaction_date != date(NEW.transaction_date)
        BEGIN
          UPDATE transactions
          SET transaction_date = date(NEW.transaction_date)
          WHERE id = NEW.id;
        END;
      `);

      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_transactions_normalize_date_after_update
        AFTER UPDATE OF transaction_date ON transactions
        FOR EACH ROW
        WHEN NEW.transaction_date IS NOT NULL
         AND date(NEW.transaction_date) IS NOT NULL
         AND NEW.transaction_date != date(NEW.transaction_date)
        BEGIN
          UPDATE transactions
          SET transaction_date = date(NEW.transaction_date)
          WHERE id = NEW.id;
        END;
      `);

      db.exec('COMMIT');
      assertDbIntegrity(db, reconcileTypeMigrationId);
      recordMigration(db, reconcileTypeMigrationId, 'applied');
      console.log('Migration complete: RECONCILE transaction type added.');
    } catch (err) {
      db.exec('ROLLBACK');
      console.error('RECONCILE migration failed:', err);
      throw err;
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  } else if (!hasMigrationRecord(db, reconcileTypeMigrationId) && hasReconcileType) {
    recordMigration(db, reconcileTypeMigrationId, 'skipped', 'RECONCILE type already present');
  }

  // ── Migration: add TDS transaction type ───────────────────────────────────
  const hasTdsType = (() => {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='transactions'").get();
    return row && row.sql && row.sql.includes("'TDS'");
  })();
  const tdsTypeMigrationId = '20260509-add-tds-transaction-type';

  if (!hasTdsType && !hasMigrationRecord(db, tdsTypeMigrationId)) {
    if (!migrationsEnabled) {
      throw new Error(`Pending migration ${tdsTypeMigrationId} detected but migrations are disabled. Set ALLOW_DB_MIGRATIONS=true and restart.`);
    }

    console.log('Migrating: adding TDS transaction type...');
    const beforeTransactions = getTableCount(db, 'transactions');
    const backupPath = createPreMigrationBackup(db, 'add-tds-transaction-type');
    if (backupPath) console.log(`Created migration backup: ${backupPath}`);

    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      db.exec(`
        CREATE TABLE transactions_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          investment_id INTEGER NOT NULL,
          portfolio_id INTEGER NOT NULL,
          transaction_type TEXT NOT NULL CHECK(transaction_type IN (
            'BUY', 'SELL', 'DEPOSIT', 'WITHDRAWAL', 'DIVIDEND', 'INTEREST', 'RECONCILE', 'TDS',
            'SPLIT', 'BONUS', 'RIGHTS', 'MERGER', 'CONSOLIDATION', 'IPO',
            'TRANSFER_IN', 'TRANSFER_OUT', 'TRANSFER', 'SWITCH_IN', 'SWITCH_OUT',
            'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'CHARGES', 'AMC',
            'REDEMPTION', 'EPS_CONTRIBUTION', 'VEST', 'ESPP_PURCHASE', 'ESPP_CONTRIBUTION'
          )),
          transaction_date TEXT NOT NULL,
          units REAL,
          price_per_unit REAL,
          amount REAL NOT NULL,
          fees REAL DEFAULT 0,
          broker TEXT,
          notes TEXT,
          locked INTEGER DEFAULT 0,
          folio_number TEXT,
          exchange_rate_used REAL,
          usd_amount REAL,
          fmv_per_unit REAL,
          gross_units REAL,
          tax_withheld_units REAL,
          stt REAL,
          created_at TEXT DEFAULT (datetime('now')),
          FOREIGN KEY (investment_id) REFERENCES investments(id) ON DELETE CASCADE
        )
      `);

      const existingCols = db.prepare('PRAGMA table_info(transactions)').all().map((c) => c.name);
      const knownCols = [
        'id', 'investment_id', 'portfolio_id', 'transaction_type', 'transaction_date',
        'units', 'price_per_unit', 'amount', 'fees', 'broker', 'notes',
        'locked', 'folio_number', 'exchange_rate_used', 'usd_amount', 'fmv_per_unit',
        'gross_units', 'tax_withheld_units', 'stt', 'created_at',
      ];
      const colsToCopy = knownCols.filter((c) => existingCols.includes(c));
      db.exec(`INSERT INTO transactions_new (${colsToCopy.join(', ')}) SELECT ${colsToCopy.join(', ')} FROM transactions`);

      const copiedTransactions = getTableCount(db, 'transactions_new');
      ensureRowCountPreserved({
        before: beforeTransactions,
        after: copiedTransactions,
        table: 'transactions',
        migrationName: 'add-tds-transaction-type',
      });

      db.exec('DROP TABLE transactions');
      db.exec('ALTER TABLE transactions_new RENAME TO transactions');
      db.exec('CREATE INDEX IF NOT EXISTS idx_transactions_investment ON transactions(investment_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(transaction_date)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_transactions_portfolio ON transactions(portfolio_id)');

      // Recreate date-normalization triggers because table recreation drops existing triggers.
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_transactions_normalize_date_after_insert
        AFTER INSERT ON transactions
        FOR EACH ROW
        WHEN NEW.transaction_date IS NOT NULL
         AND date(NEW.transaction_date) IS NOT NULL
         AND NEW.transaction_date != date(NEW.transaction_date)
        BEGIN
          UPDATE transactions
          SET transaction_date = date(NEW.transaction_date)
          WHERE id = NEW.id;
        END;
      `);

      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_transactions_normalize_date_after_update
        AFTER UPDATE OF transaction_date ON transactions
        FOR EACH ROW
        WHEN NEW.transaction_date IS NOT NULL
         AND date(NEW.transaction_date) IS NOT NULL
         AND NEW.transaction_date != date(NEW.transaction_date)
        BEGIN
          UPDATE transactions
          SET transaction_date = date(NEW.transaction_date)
          WHERE id = NEW.id;
        END;
      `);

      db.exec('COMMIT');
      assertDbIntegrity(db, tdsTypeMigrationId);
      recordMigration(db, tdsTypeMigrationId, 'applied');
      console.log('Migration complete: TDS transaction type added.');
    } catch (err) {
      db.exec('ROLLBACK');
      console.error('TDS migration failed:', err);
      throw err;
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  } else if (!hasMigrationRecord(db, tdsTypeMigrationId) && hasTdsType) {
    recordMigration(db, tdsTypeMigrationId, 'skipped', 'TDS type already present');
  }

  // ── Migration: add dirty tracking columns to investments ───────────────
  const dirtyInvCols = db.prepare("PRAGMA table_info(investments)").all().map(c => c.name);
  if (requireMigrationsEnabled(
    '20260510-add-investments-dirty-flags',
    !dirtyInvCols.includes('is_dirty_daily_values') || !dirtyInvCols.includes('dirty_from_date'),
    'investments dirty tracking columns missing'
  )) {
    db.exec('BEGIN');
    try {
      if (!dirtyInvCols.includes('is_dirty_daily_values')) {
        db.exec('ALTER TABLE investments ADD COLUMN is_dirty_daily_values INTEGER DEFAULT 0');
      }
      if (!dirtyInvCols.includes('dirty_from_date')) {
        db.exec('ALTER TABLE investments ADD COLUMN dirty_from_date TEXT');
      }
      db.exec('CREATE INDEX IF NOT EXISTS idx_investments_dirty_date ON investments(is_dirty_daily_values, dirty_from_date)');
      db.exec('COMMIT');
      assertDbIntegrity(db, '20260510-add-investments-dirty-flags');
      recordMigration(db, '20260510-add-investments-dirty-flags', 'applied');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  } else if (!hasMigrationRecord(db, '20260510-add-investments-dirty-flags') && dirtyInvCols.includes('is_dirty_daily_values') && dirtyInvCols.includes('dirty_from_date')) {
    recordMigration(db, '20260510-add-investments-dirty-flags', 'skipped', 'already present');
  }

  // ── Migration: add dirty_backfill_scope table ─────────────────────────
  const hasDirtyScopeTable = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='dirty_backfill_scope'").get();
  if (requireMigrationsEnabled('20260510-add-dirty-backfill-scope-table', !hasDirtyScopeTable, 'dirty_backfill_scope missing')) {
    db.exec('BEGIN');
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS dirty_backfill_scope (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          investment_id INTEGER,
          portfolio_id INTEGER,
          dirty_from_date TEXT NOT NULL,
          dirty_reason TEXT,
          source_event_id TEXT,
          status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'completed', 'failed')),
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          FOREIGN KEY (investment_id) REFERENCES investments(id) ON DELETE CASCADE
        )
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_dirty_scope_status_date ON dirty_backfill_scope(status, dirty_from_date)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_dirty_scope_investment_portfolio ON dirty_backfill_scope(investment_id, portfolio_id, status)');
      db.exec('COMMIT');
      assertDbIntegrity(db, '20260510-add-dirty-backfill-scope-table');
      recordMigration(db, '20260510-add-dirty-backfill-scope-table', 'applied');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  } else if (!hasMigrationRecord(db, '20260510-add-dirty-backfill-scope-table') && hasDirtyScopeTable) {
    recordMigration(db, '20260510-add-dirty-backfill-scope-table', 'skipped', 'already present');
  }

  // ── Migration: ensure daily_values price_source + realized_proceeds columns ─────
  const dvColsNow = new Set(db.prepare('PRAGMA table_info(daily_values)').all().map((c) => c.name));
  const dailyValuesEnhancementId = '20260524-daily-values-price-source-realized-proceeds';
  if (requireMigrationsEnabled(
    dailyValuesEnhancementId,
    !dvColsNow.has('price_source') || !dvColsNow.has('realized_proceeds'),
    'daily_values price_source/realized_proceeds missing'
  )) {
    db.exec('BEGIN');
    try {
      if (!dvColsNow.has('price_source')) {
        db.exec("ALTER TABLE daily_values ADD COLUMN price_source TEXT DEFAULT 'LIVE'");
      }
      if (dvColsNow.has('realized_gain') && !dvColsNow.has('realized_proceeds')) {
        db.exec('ALTER TABLE daily_values RENAME COLUMN realized_gain TO realized_proceeds');
      } else if (!dvColsNow.has('realized_proceeds')) {
        db.exec('ALTER TABLE daily_values ADD COLUMN realized_proceeds REAL DEFAULT 0');
      }
      db.exec('COMMIT');
      assertDbIntegrity(db, dailyValuesEnhancementId);
      recordMigration(db, dailyValuesEnhancementId, 'applied');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  } else if (!hasMigrationRecord(db, dailyValuesEnhancementId) && dvColsNow.has('price_source') && dvColsNow.has('realized_proceeds')) {
    recordMigration(db, dailyValuesEnhancementId, 'skipped', 'already present');
  }

  // ── Migration: rationalize daily_values columns (drop derived columns, add updated_at) ──
  const dvColsRationalize = new Set(db.prepare('PRAGMA table_info(daily_values)').all().map((c) => c.name));
  const dailyValuesRationalizationId = '20260528-daily-values-column-rationalization';
  const dailyValuesNeedsRationalization =
    dvColsRationalize.has('profit_loss_pct')
    || dvColsRationalize.has('day_change_pct')
    || dvColsRationalize.has('created_at')
    || !dvColsRationalize.has('updated_at');

  if (requireMigrationsEnabled(
    dailyValuesRationalizationId,
    dailyValuesNeedsRationalization,
    'daily_values has legacy derived/timestamp columns'
  )) {
    const beforeDailyCount = getTableCount(db, 'daily_values');
    const updatedAtExpr = dvColsRationalize.has('updated_at')
      ? (dvColsRationalize.has('created_at')
        ? 'COALESCE(updated_at, created_at, datetime(\'now\'))'
        : 'COALESCE(updated_at, datetime(\'now\'))')
      : (dvColsRationalize.has('created_at') ? 'COALESCE(created_at, datetime(\'now\'))' : 'datetime(\'now\')');
    const realizedProceedsExpr = dvColsRationalize.has('realized_proceeds') ? 'COALESCE(realized_proceeds, 0)' : '0';
    const priceSourceExpr = dvColsRationalize.has('price_source') ? "COALESCE(price_source, 'LIVE')" : "'LIVE'";
    const dayChangeExpr = dvColsRationalize.has('day_change') ? 'COALESCE(day_change, 0)' : '0';

    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      db.exec(`
        CREATE TABLE daily_values_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          investment_id INTEGER NOT NULL,
          portfolio_id INTEGER,
          date TEXT NOT NULL,
          price_per_unit REAL,
          total_units REAL,
          current_value REAL NOT NULL,
          invested_amount REAL NOT NULL,
          realized_proceeds REAL DEFAULT 0,
          profit_loss REAL NOT NULL,
          price_source TEXT DEFAULT 'LIVE' CHECK(price_source IN ('LIVE', 'LOCF', 'COMPUTED')),
          day_change REAL DEFAULT 0,
          updated_at TEXT DEFAULT (datetime('now')),
          FOREIGN KEY (investment_id) REFERENCES investments(id) ON DELETE CASCADE,
          UNIQUE(investment_id, portfolio_id, date)
        )
      `);

      db.exec(`
        INSERT INTO daily_values_new (
          id,
          investment_id,
          portfolio_id,
          date,
          price_per_unit,
          total_units,
          current_value,
          invested_amount,
          realized_proceeds,
          profit_loss,
          price_source,
          day_change,
          updated_at
        )
        SELECT
          id,
          investment_id,
          portfolio_id,
          date,
          price_per_unit,
          total_units,
          current_value,
          invested_amount,
          ${realizedProceedsExpr},
          profit_loss,
          ${priceSourceExpr},
          ${dayChangeExpr},
          ${updatedAtExpr}
        FROM daily_values
      `);

      db.exec('DROP TABLE daily_values');
      db.exec('ALTER TABLE daily_values_new RENAME TO daily_values');

      db.exec('CREATE INDEX IF NOT EXISTS idx_daily_values_date ON daily_values(date)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_daily_values_portfolio_inv_date ON daily_values(portfolio_id, investment_id, date)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_daily_values_portfolio_date_investment ON daily_values(portfolio_id, date, investment_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_daily_values_date_investment_portfolio ON daily_values(date, investment_id, portfolio_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_daily_values_portfolio ON daily_values(portfolio_id, date)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_daily_values_latest_lookup ON daily_values(investment_id, portfolio_id, date DESC)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_daily_values_investment_date ON daily_values(investment_id, date DESC)');

      // Recreate NOT NULL enforcement triggers dropped during table rebuild.
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_daily_values_portfolio_not_null_insert
        BEFORE INSERT ON daily_values
        WHEN NEW.portfolio_id IS NULL
        BEGIN
          SELECT RAISE(ABORT, 'daily_values.portfolio_id must be non-null');
        END;
      `);

      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_daily_values_portfolio_not_null_update
        BEFORE UPDATE OF portfolio_id ON daily_values
        WHEN NEW.portfolio_id IS NULL
        BEGIN
          SELECT RAISE(ABORT, 'daily_values.portfolio_id must be non-null');
        END;
      `);

      db.exec('COMMIT');
      db.exec('PRAGMA foreign_keys = ON');

      const afterDailyCount = getTableCount(db, 'daily_values');
      ensureRowCountPreserved({
        before: beforeDailyCount,
        after: afterDailyCount,
        table: 'daily_values',
        migrationName: dailyValuesRationalizationId,
      });

      assertDbIntegrity(db, dailyValuesRationalizationId);
      recordMigration(
        db,
        dailyValuesRationalizationId,
        'applied',
        `rows before=${beforeDailyCount}, after=${afterDailyCount}; dropped profit_loss_pct/day_change_pct/created_at, added updated_at`
      );
    } catch (e) {
      db.exec('ROLLBACK');
      db.exec('PRAGMA foreign_keys = ON');
      throw e;
    }
  } else if (!hasMigrationRecord(db, dailyValuesRationalizationId) && !dailyValuesNeedsRationalization) {
    recordMigration(db, dailyValuesRationalizationId, 'skipped', 'already rationalized');
  }

  // ── Migration: remove ILLIQUID_CARRY from daily_values.price_source CHECK constraint ──
  const dailyValuesConstraintMigrationId = '20260531-daily-values-price-source-remove-illiquid-carry';
  const dailyValuesTableSql = String(
    db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='daily_values'").get()?.sql || ''
  ).toUpperCase();
  const hasIlliquidCarryInConstraint = dailyValuesTableSql.includes("'ILLIQUID_CARRY'");

  if (requireMigrationsEnabled(
    dailyValuesConstraintMigrationId,
    hasIlliquidCarryInConstraint,
    'daily_values.price_source CHECK still includes ILLIQUID_CARRY'
  )) {
    const dvColsConstraint = new Set(db.prepare('PRAGMA table_info(daily_values)').all().map((c) => c.name));
    const beforeDailyCount = getTableCount(db, 'daily_values');
    const updatedAtExpr = dvColsConstraint.has('updated_at')
      ? (dvColsConstraint.has('created_at')
        ? 'COALESCE(updated_at, created_at, datetime(\'now\'))'
        : 'COALESCE(updated_at, datetime(\'now\'))')
      : (dvColsConstraint.has('created_at') ? 'COALESCE(created_at, datetime(\'now\'))' : 'datetime(\'now\')');
    const realizedProceedsExpr = dvColsConstraint.has('realized_proceeds') ? 'COALESCE(realized_proceeds, 0)' : '0';
    const dayChangeExpr = dvColsConstraint.has('day_change') ? 'COALESCE(day_change, 0)' : '0';
    const priceSourceExpr = dvColsConstraint.has('price_source')
      ? "CASE WHEN price_source IN ('LIVE', 'LOCF', 'COMPUTED') THEN price_source ELSE 'LIVE' END"
      : "'LIVE'";

    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      db.exec(`
        CREATE TABLE daily_values_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          investment_id INTEGER NOT NULL,
          portfolio_id INTEGER,
          date TEXT NOT NULL,
          price_per_unit REAL,
          total_units REAL,
          current_value REAL NOT NULL,
          invested_amount REAL NOT NULL,
          realized_proceeds REAL DEFAULT 0,
          profit_loss REAL NOT NULL,
          price_source TEXT DEFAULT 'LIVE' CHECK(price_source IN ('LIVE', 'LOCF', 'COMPUTED')),
          day_change REAL DEFAULT 0,
          updated_at TEXT DEFAULT (datetime('now')),
          FOREIGN KEY (investment_id) REFERENCES investments(id) ON DELETE CASCADE,
          UNIQUE(investment_id, portfolio_id, date)
        )
      `);

      db.exec(`
        INSERT INTO daily_values_new (
          id,
          investment_id,
          portfolio_id,
          date,
          price_per_unit,
          total_units,
          current_value,
          invested_amount,
          realized_proceeds,
          profit_loss,
          price_source,
          day_change,
          updated_at
        )
        SELECT
          id,
          investment_id,
          portfolio_id,
          date,
          price_per_unit,
          total_units,
          current_value,
          invested_amount,
          ${realizedProceedsExpr},
          profit_loss,
          ${priceSourceExpr},
          ${dayChangeExpr},
          ${updatedAtExpr}
        FROM daily_values
      `);

      db.exec('DROP TABLE daily_values');
      db.exec('ALTER TABLE daily_values_new RENAME TO daily_values');

      db.exec('CREATE INDEX IF NOT EXISTS idx_daily_values_date ON daily_values(date)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_daily_values_portfolio_inv_date ON daily_values(portfolio_id, investment_id, date)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_daily_values_portfolio_date_investment ON daily_values(portfolio_id, date, investment_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_daily_values_date_investment_portfolio ON daily_values(date, investment_id, portfolio_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_daily_values_portfolio ON daily_values(portfolio_id, date)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_daily_values_latest_lookup ON daily_values(investment_id, portfolio_id, date DESC)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_daily_values_investment_date ON daily_values(investment_id, date DESC)');

      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_daily_values_portfolio_not_null_insert
        BEFORE INSERT ON daily_values
        WHEN NEW.portfolio_id IS NULL
        BEGIN
          SELECT RAISE(ABORT, 'daily_values.portfolio_id must be non-null');
        END;
      `);

      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_daily_values_portfolio_not_null_update
        BEFORE UPDATE OF portfolio_id ON daily_values
        WHEN NEW.portfolio_id IS NULL
        BEGIN
          SELECT RAISE(ABORT, 'daily_values.portfolio_id must be non-null');
        END;
      `);

      db.exec('COMMIT');
      db.exec('PRAGMA foreign_keys = ON');

      const afterDailyCount = getTableCount(db, 'daily_values');
      ensureRowCountPreserved({
        before: beforeDailyCount,
        after: afterDailyCount,
        table: 'daily_values',
        migrationName: dailyValuesConstraintMigrationId,
      });

      assertDbIntegrity(db, dailyValuesConstraintMigrationId);
      recordMigration(
        db,
        dailyValuesConstraintMigrationId,
        'applied',
        `rows before=${beforeDailyCount}, after=${afterDailyCount}; removed ILLIQUID_CARRY from price_source CHECK`
      );
    } catch (e) {
      db.exec('ROLLBACK');
      db.exec('PRAGMA foreign_keys = ON');
      throw e;
    }
  } else if (!hasMigrationRecord(db, dailyValuesConstraintMigrationId) && !hasIlliquidCarryInConstraint) {
    recordMigration(db, dailyValuesConstraintMigrationId, 'skipped', 'constraint already excludes ILLIQUID_CARRY');
  }

  // ── Migration: add PRE and POST to daily_values.price_source CHECK constraint ──
  // Required to store FOREIGN_STOCK pre-market ('PRE') and after-hours ('POST') prices
  // as distinct, upgradeable sources rather than collapsing them to 'LIVE'.
  const dailyValuesPrepPostMigrationId = '20260616-daily-values-price-source-add-pre-post';
  const currentDvTableSql = String(
    db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='daily_values'").get()?.sql || ''
  );
  const needsPrePostConstraint = !currentDvTableSql.includes("'PRE'");

  if (requireMigrationsEnabled(
    dailyValuesPrepPostMigrationId,
    needsPrePostConstraint,
    "daily_values.price_source CHECK does not include 'PRE'/'POST'"
  )) {
    const dvColsPrePost = new Set(db.prepare('PRAGMA table_info(daily_values)').all().map((c) => c.name));
    const beforeCountPrePost = getTableCount(db, 'daily_values');
    const updatedAtExprPP = dvColsPrePost.has('updated_at')
      ? (dvColsPrePost.has('created_at')
        ? "COALESCE(updated_at, created_at, datetime('now'))"
        : "COALESCE(updated_at, datetime('now'))")
      : (dvColsPrePost.has('created_at') ? "COALESCE(created_at, datetime('now'))" : "datetime('now')");
    const priceSourceExprPP = dvColsPrePost.has('price_source')
      ? "CASE WHEN price_source IN ('LIVE','LOCF','COMPUTED','PRE','POST') THEN price_source ELSE 'LIVE' END"
      : "'LIVE'";
    const realizedProceedsExprPP = dvColsPrePost.has('realized_proceeds') ? 'COALESCE(realized_proceeds, 0)' : '0';
    const dayChangeExprPP = dvColsPrePost.has('day_change') ? 'COALESCE(day_change, 0)' : '0';

    // Automatic backup before migration to prevent data loss
    try {
      const fs = require('fs');
      const path = require('path');
      const dbFilePath = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'investments.db');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('Z')[0];
      const backupPath = dbFilePath.replace(/\.db$/, `.db.backup-pre-pre-post-${timestamp}`);
      if (fs.existsSync(dbFilePath)) {
        fs.copyFileSync(dbFilePath, backupPath);
        logAppInfo(`[Schema Migration] Automatic backup created: ${path.basename(backupPath)}`);
      }
    } catch (backupErr) {
      logAppWarn(`[Schema Migration] Automatic backup failed (migration will proceed): ${backupErr.message}`);
    }

    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      db.exec(`
        CREATE TABLE daily_values_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          investment_id INTEGER NOT NULL,
          portfolio_id INTEGER,
          date TEXT NOT NULL,
          price_per_unit REAL,
          total_units REAL,
          current_value REAL NOT NULL,
          invested_amount REAL NOT NULL,
          realized_proceeds REAL DEFAULT 0,
          profit_loss REAL NOT NULL,
          price_source TEXT DEFAULT 'LIVE' CHECK(price_source IN ('LIVE', 'LOCF', 'COMPUTED', 'PRE', 'POST')),
          day_change REAL DEFAULT 0,
          updated_at TEXT DEFAULT (datetime('now')),
          FOREIGN KEY (investment_id) REFERENCES investments(id) ON DELETE CASCADE,
          UNIQUE(investment_id, portfolio_id, date)
        )
      `);
      db.exec(`
        INSERT INTO daily_values_new (
          id, investment_id, portfolio_id, date, price_per_unit, total_units,
          current_value, invested_amount, realized_proceeds, profit_loss,
          price_source, day_change, updated_at
        )
        SELECT
          id, investment_id, portfolio_id, date, price_per_unit, total_units,
          current_value, invested_amount, ${realizedProceedsExprPP}, profit_loss,
          ${priceSourceExprPP}, ${dayChangeExprPP}, ${updatedAtExprPP}
        FROM daily_values
      `);
      db.exec('DROP TABLE daily_values');
      db.exec('ALTER TABLE daily_values_new RENAME TO daily_values');
      db.exec('CREATE INDEX IF NOT EXISTS idx_daily_values_date ON daily_values(date)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_daily_values_portfolio_inv_date ON daily_values(portfolio_id, investment_id, date)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_daily_values_portfolio_date_investment ON daily_values(portfolio_id, date, investment_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_daily_values_date_investment_portfolio ON daily_values(date, investment_id, portfolio_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_daily_values_portfolio ON daily_values(portfolio_id, date)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_daily_values_latest_lookup ON daily_values(investment_id, portfolio_id, date DESC)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_daily_values_investment_date ON daily_values(investment_id, date DESC)');
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_daily_values_portfolio_not_null_insert
        BEFORE INSERT ON daily_values WHEN NEW.portfolio_id IS NULL
        BEGIN SELECT RAISE(ABORT, 'daily_values.portfolio_id must be non-null'); END;
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_daily_values_portfolio_not_null_update
        BEFORE UPDATE OF portfolio_id ON daily_values WHEN NEW.portfolio_id IS NULL
        BEGIN SELECT RAISE(ABORT, 'daily_values.portfolio_id must be non-null'); END;
      `);
      db.exec('COMMIT');
      db.exec('PRAGMA foreign_keys = ON');
      const afterCountPrePost = getTableCount(db, 'daily_values');
      ensureRowCountPreserved({
        before: beforeCountPrePost, after: afterCountPrePost,
        table: 'daily_values', migrationName: dailyValuesPrepPostMigrationId,
      });
      assertDbIntegrity(db, dailyValuesPrepPostMigrationId);
      recordMigration(
        db, dailyValuesPrepPostMigrationId, 'applied',
        `rows before=${beforeCountPrePost}, after=${afterCountPrePost}; added PRE/POST to price_source CHECK`
      );
    } catch (e) {
      db.exec('ROLLBACK');
      db.exec('PRAGMA foreign_keys = ON');
      throw e;
    }
  } else if (!hasMigrationRecord(db, dailyValuesPrepPostMigrationId) && !needsPrePostConstraint) {
    recordMigration(db, dailyValuesPrepPostMigrationId, 'skipped', "constraint already includes 'PRE'/'POST'");
  }

  // ── Migration: add investments.last_active_date ───────────────────────────
  const invColsLatest = new Set(db.prepare('PRAGMA table_info(investments)').all().map((c) => c.name));
  const lastActiveMigrationId = '20260510-add-investments-last-active-date';
  if (requireMigrationsEnabled(lastActiveMigrationId, !invColsLatest.has('last_active_date'), 'investments.last_active_date missing')) {
    db.exec('ALTER TABLE investments ADD COLUMN last_active_date TEXT');
    assertDbIntegrity(db, lastActiveMigrationId);
    recordMigration(db, lastActiveMigrationId, 'applied');
  } else if (!hasMigrationRecord(db, lastActiveMigrationId) && invColsLatest.has('last_active_date')) {
    recordMigration(db, lastActiveMigrationId, 'skipped', 'already present');
  }

  // ── Migration: add asset_type_daily table ─────────────────────────────────
  const hasAssetTypeDaily = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='asset_type_daily'").get();
  const assetTypeDailyMigrationId = '20260510-add-asset-type-daily-table';
  if (requireMigrationsEnabled(assetTypeDailyMigrationId, !hasAssetTypeDaily, 'asset_type_daily missing')) {
    db.exec('BEGIN');
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS asset_type_daily (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          portfolio_id INTEGER,
          asset_type TEXT NOT NULL,
          date TEXT NOT NULL,
          total_value REAL NOT NULL,
          total_invested REAL NOT NULL,
          total_profit_loss REAL NOT NULL,
          total_realized_proceeds REAL DEFAULT 0,
          total_unrealized_gain REAL DEFAULT 0,
          total_profit_loss_pct REAL,
          day_change REAL DEFAULT 0,
          day_change_pct REAL DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now')),
          UNIQUE(portfolio_id, asset_type, date)
        )
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_asset_type_daily_portfolio_date ON asset_type_daily(portfolio_id, date)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_asset_type_daily_type_date ON asset_type_daily(asset_type, date)');
      db.exec('COMMIT');
      assertDbIntegrity(db, assetTypeDailyMigrationId);
      recordMigration(db, assetTypeDailyMigrationId, 'applied');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  } else if (!hasMigrationRecord(db, assetTypeDailyMigrationId) && hasAssetTypeDaily) {
    recordMigration(db, assetTypeDailyMigrationId, 'skipped', 'already present');
  }

  // ── Migration: rename asset_type_daily total_realized_gain -> total_realized_proceeds ──
  const assetTypeDailyCols = new Set(db.prepare('PRAGMA table_info(asset_type_daily)').all().map((c) => c.name));
  const assetTypeDailyRenameMigrationId = '20260524-asset-type-daily-total-realized-proceeds';
  if (requireMigrationsEnabled(
    assetTypeDailyRenameMigrationId,
    assetTypeDailyCols.has('total_realized_gain') && !assetTypeDailyCols.has('total_realized_proceeds'),
    'asset_type_daily total_realized_proceeds missing'
  )) {
    db.exec('ALTER TABLE asset_type_daily RENAME COLUMN total_realized_gain TO total_realized_proceeds');
    assertDbIntegrity(db, assetTypeDailyRenameMigrationId);
    recordMigration(db, assetTypeDailyRenameMigrationId, 'applied');
  } else if (!hasMigrationRecord(db, assetTypeDailyRenameMigrationId) && assetTypeDailyCols.has('total_realized_proceeds')) {
    recordMigration(db, assetTypeDailyRenameMigrationId, 'skipped', 'already present');
  }

  // ── Migration: add historical_price_repair_scope table ───────────────────
  const hasHistoricalPriceRepairScope = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='historical_price_repair_scope'").get();
  const historicalPriceRepairScopeMigrationId = '20260524-add-historical-price-repair-scope-table';
  if (requireMigrationsEnabled(
    historicalPriceRepairScopeMigrationId,
    !hasHistoricalPriceRepairScope,
    'historical_price_repair_scope missing'
  )) {
    db.exec('BEGIN');
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS historical_price_repair_scope (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          instrument_type TEXT NOT NULL,
          symbol TEXT NOT NULL,
          from_date TEXT NOT NULL,
          to_date TEXT NOT NULL,
          reason TEXT,
          priority INTEGER NOT NULL DEFAULT 100,
          source_event_id TEXT,
          status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'completed', 'failed')),
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          completed_at TEXT
        )
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_hist_price_repair_status_priority ON historical_price_repair_scope(status, priority, created_at)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_hist_price_repair_lookup ON historical_price_repair_scope(instrument_type, symbol, from_date, to_date, status)');
      db.exec('COMMIT');
      assertDbIntegrity(db, historicalPriceRepairScopeMigrationId);
      recordMigration(db, historicalPriceRepairScopeMigrationId, 'applied');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  } else if (!hasMigrationRecord(db, historicalPriceRepairScopeMigrationId) && hasHistoricalPriceRepairScope) {
    recordMigration(db, historicalPriceRepairScopeMigrationId, 'skipped', 'already present');
  }

  // ── Migration: add investment_split_events table (investment-level split metadata) ──
  const hasInvestmentSplitEvents = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='investment_split_events'").get();
  const hasMarketPriceCacheTable = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='market_price_cache'").get();
  const investmentSplitEventsMigrationId = '20260601-add-investment-split-events-table';
  if (requireMigrationsEnabled(
    investmentSplitEventsMigrationId,
    !hasInvestmentSplitEvents,
    'investment_split_events missing'
  )) {
    db.exec('BEGIN');
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS investment_split_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          investment_id INTEGER NOT NULL,
          event_date TEXT NOT NULL,
          ratio REAL NOT NULL CHECK(ratio > 1),
          locked INTEGER NOT NULL DEFAULT 0 CHECK(locked IN (0, 1)),
          source TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          FOREIGN KEY (investment_id) REFERENCES investments(id) ON DELETE CASCADE,
          UNIQUE(investment_id, event_date)
        )
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_investment_split_events_lookup ON investment_split_events(investment_id, event_date)');

      const splitRows = hasMarketPriceCacheTable
        ? db.prepare(`
          SELECT m.investment_id, m.split_history_json
          FROM market_price_cache m
          JOIN investments i ON i.id = m.investment_id
          WHERE m.investment_id IS NOT NULL
            AND i.asset_type IN ('INDIAN_STOCK', 'FOREIGN_STOCK')
            AND m.split_history_json IS NOT NULL
            AND m.split_history_json <> ''
        `).all()
        : [];

      const normalizeIsoDate = (value) => {
        const raw = String(value || '').trim();
        if (!raw) return null;
        if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
        const d = new Date(raw);
        if (Number.isNaN(d.getTime())) return null;
        return d.toISOString().split('T')[0];
      };

      const byInvestment = new Map();
      for (const row of splitRows) {
        const invId = Number(row.investment_id || 0);
        if (!(invId > 0)) continue;
        let parsed = [];
        try {
          const raw = JSON.parse(String(row.split_history_json || '[]'));
          parsed = Array.isArray(raw) ? raw : [];
        } catch (_e) {
          parsed = [];
        }

        let perInvestment = byInvestment.get(invId);
        if (!perInvestment) {
          perInvestment = new Map();
          byInvestment.set(invId, perInvestment);
        }

        for (const event of parsed) {
          const eventDate = normalizeIsoDate(event?.date);
          const ratio = Number(event?.ratio);
          if (!eventDate || !Number.isFinite(ratio) || ratio <= 1) continue;
          const locked = !!event?.locked;
          const source = String(event?.source || 'migration_cache_row');

          const prev = perInvestment.get(eventDate);
          if (!prev) {
            perInvestment.set(eventDate, { ratio, locked, source });
            continue;
          }

          perInvestment.set(eventDate, {
            ratio: Math.max(Number(prev.ratio || 0), ratio),
            locked: !!prev.locked || locked,
            source: (locked || prev.locked) ? (locked ? source : prev.source) : source,
          });
        }
      }

      const upsertSplitEvent = db.prepare(`
        INSERT INTO investment_split_events (investment_id, event_date, ratio, locked, source, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        ON CONFLICT(investment_id, event_date) DO UPDATE SET
          ratio = excluded.ratio,
          locked = excluded.locked,
          source = excluded.source,
          updated_at = datetime('now')
      `);

      for (const [invId, eventMap] of byInvestment.entries()) {
        const events = Array.from(eventMap.entries())
          .map(([eventDate, payload]) => ({ eventDate, ...payload }))
          .sort((a, b) => String(a.eventDate).localeCompare(String(b.eventDate)));
        for (const event of events) {
          upsertSplitEvent.run(invId, event.eventDate, Number(event.ratio), event.locked ? 1 : 0, String(event.source || 'migration_cache_row'));
        }
      }

      if (hasMarketPriceCacheTable) {
        db.prepare(`
          UPDATE market_price_cache
          SET split_history_json = NULL,
              updated_at = datetime('now')
          WHERE instrument_type IN ('INDIAN_STOCK', 'FOREIGN_STOCK')
            AND split_history_json IS NOT NULL
            AND split_history_json <> ''
        `).run();
      }

      db.exec('COMMIT');
      assertDbIntegrity(db, investmentSplitEventsMigrationId);
      recordMigration(db, investmentSplitEventsMigrationId, 'applied');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  } else if (!hasMigrationRecord(db, investmentSplitEventsMigrationId) && hasInvestmentSplitEvents) {
    recordMigration(db, investmentSplitEventsMigrationId, 'skipped', 'already present');
  }

  // Ensure backfill watermark key exists even on upgraded DBs.
  db.prepare("INSERT OR IGNORE INTO config (key, value, updated_at) VALUES ('backfill_watermark', '', datetime('now'))").run();
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

// ── Migration: add nps_fund_code column for external NPS NAV fetching
function ensureNPSFundCodeMigration(db) {
  const migrationId = '20260518-add-investments-nps-fund-code';
  const invCols = db.prepare("PRAGMA table_info(investments)").all().map(c => c.name);
  
  const migrationsEnabled = !isProductionMode() || process.env.ALLOW_DB_MIGRATIONS === 'true';
  const hasMigration = db.prepare('SELECT id FROM schema_migrations WHERE id = ?').get(migrationId);
  
  if (!hasMigration && !invCols.includes('nps_fund_code')) {
    if (!migrationsEnabled) {
      throw new Error(`Pending migration ${migrationId} detected but migrations are disabled. Set ALLOW_DB_MIGRATIONS=true and restart.`);
    }
    db.exec("ALTER TABLE investments ADD COLUMN nps_fund_code TEXT");
    assertDbIntegrity(db, migrationId);
    db.prepare(`
      INSERT OR REPLACE INTO schema_migrations (id, status, notes, applied_at)
      VALUES (?, ?, ?, datetime('now'))
    `).run(migrationId, 'applied', null);
    console.log(`[Migration] Applied ${migrationId}`);
  } else if (!hasMigration && invCols.includes('nps_fund_code')) {
    db.prepare(`
      INSERT OR REPLACE INTO schema_migrations (id, status, notes, applied_at)
      VALUES (?, ?, ?, datetime('now'))
    `).run(migrationId, 'skipped', 'already present');
  }
}

function ensureRemoveCombinedAggregatesMigration(db) {
  const migrationId = '20260522-remove-combined-aggregates-enforce-scoped-rows';
  const hasMigration = db.prepare('SELECT id FROM schema_migrations WHERE id = ?').get(migrationId);

  if (!hasMigration) {
    db.exec('BEGIN');
    try {
      const deletedDaily = db.prepare('DELETE FROM daily_values WHERE portfolio_id IS NULL').run().changes;
      const deletedPortfolio = db.prepare('DELETE FROM portfolio_daily WHERE portfolio_id IS NULL').run().changes;
      const deletedAssetType = db.prepare('DELETE FROM asset_type_daily WHERE portfolio_id IS NULL').run().changes;

      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_daily_values_portfolio_not_null_insert
        BEFORE INSERT ON daily_values
        WHEN NEW.portfolio_id IS NULL
        BEGIN
          SELECT RAISE(ABORT, 'daily_values.portfolio_id must be non-null');
        END;
      `);

      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_daily_values_portfolio_not_null_update
        BEFORE UPDATE OF portfolio_id ON daily_values
        WHEN NEW.portfolio_id IS NULL
        BEGIN
          SELECT RAISE(ABORT, 'daily_values.portfolio_id must be non-null');
        END;
      `);

      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_portfolio_daily_portfolio_not_null_insert
        BEFORE INSERT ON portfolio_daily
        WHEN NEW.portfolio_id IS NULL
        BEGIN
          SELECT RAISE(ABORT, 'portfolio_daily.portfolio_id must be non-null');
        END;
      `);

      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_portfolio_daily_portfolio_not_null_update
        BEFORE UPDATE OF portfolio_id ON portfolio_daily
        WHEN NEW.portfolio_id IS NULL
        BEGIN
          SELECT RAISE(ABORT, 'portfolio_daily.portfolio_id must be non-null');
        END;
      `);

      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_asset_type_daily_portfolio_not_null_insert
        BEFORE INSERT ON asset_type_daily
        WHEN NEW.portfolio_id IS NULL
        BEGIN
          SELECT RAISE(ABORT, 'asset_type_daily.portfolio_id must be non-null');
        END;
      `);

      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_asset_type_daily_portfolio_not_null_update
        BEFORE UPDATE OF portfolio_id ON asset_type_daily
        WHEN NEW.portfolio_id IS NULL
        BEGIN
          SELECT RAISE(ABORT, 'asset_type_daily.portfolio_id must be non-null');
        END;
      `);

      db.exec('COMMIT');
      assertDbIntegrity(db, migrationId);
      const notes = `removed NULL rows daily_values=${deletedDaily}, portfolio_daily=${deletedPortfolio}, asset_type_daily=${deletedAssetType}`;
      db.prepare(`
        INSERT OR REPLACE INTO schema_migrations (id, status, notes, applied_at)
        VALUES (?, ?, ?, datetime('now'))
      `).run(migrationId, 'applied', notes);
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

module.exports = {
  getDb,
  initializeDb,
  ensureNPSFundCodeMigration,
  ensureRemoveCombinedAggregatesMigration,
};