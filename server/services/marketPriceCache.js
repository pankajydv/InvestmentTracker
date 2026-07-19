const { getDb } = require('../db/schema');
const { getMarketHolidays, getWeekends } = require('./holidays/marketHolidayService');
const https = require('https');
const { logAppInfo } = require('./appLogger');

let db = null;
let schemaEnsured = false;
const closedDaysByYear = new Map();
const splitEventCache = new Map();
const SPLIT_EVENT_CACHE_TTL_MS = 10 * 60 * 1000;
const LOCF_VOLUME_THRESHOLD = 10_000;
const LOCF_WINDOW_SESSIONS = 20;
const CONTIGUOUS_MISSING_LOCF_MAX_SESSIONS = 3;
const INVESTMENT_CACHE_MIGRATION_KEY = 'market_price_cache_unified_v3_symbol_is_provider_migrated';
const MARKET_CACHE_ISO_DATE_MIGRATION_KEY = 'market_price_cache_iso_date_migrated_v1';
const ENABLE_CACHE_WRITE_AUDIT = String(process.env.APP_CACHE_WRITE_AUDIT_LOG || 'true').toLowerCase() === 'true';

function emitCacheWriteAudit(event, meta) {
  if (!ENABLE_CACHE_WRITE_AUDIT) return;
  logAppInfo(`[Audit] ${event}`, meta);
}

function addDays(date, days) {
  const iso = normalizeDate(date);
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString().split('T')[0];
}

function getCacheDb() {
  if (!db) db = getDb();
  ensureSchema();
  return db;
}

function ensureSchema() {
  if (schemaEnsured) return;
  const conn = db || getDb();
  conn.exec(`
    CREATE TABLE IF NOT EXISTS market_price_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      investment_id INTEGER,
      instrument_type TEXT NOT NULL,
      symbol TEXT NOT NULL,
      date TEXT NOT NULL,
      open REAL,
      high REAL,
      low REAL,
      close REAL,
      adj_close REAL,
      reverse_factor REAL DEFAULT 1,
      split_history_json TEXT,
      volume INTEGER,
      source TEXT,
      fetched_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(instrument_type, symbol, date)
    );

    CREATE INDEX IF NOT EXISTS idx_market_price_cache_lookup
      ON market_price_cache(instrument_type, symbol, date);

    CREATE INDEX IF NOT EXISTS idx_market_price_cache_symbol_date
      ON market_price_cache(symbol, date);

    CREATE INDEX IF NOT EXISTS idx_market_price_cache_inv_lookup
      ON market_price_cache(investment_id, date);

    CREATE TABLE IF NOT EXISTS fx_rate_cache (
      date TEXT PRIMARY KEY,
      rate REAL NOT NULL,
      source TEXT,
      fetched_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_fx_rate_cache_date
      ON fx_rate_cache(date);

    CREATE TABLE IF NOT EXISTS investment_split_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      investment_id INTEGER NOT NULL,
      event_date TEXT NOT NULL,
      ratio REAL NOT NULL,
      locked INTEGER NOT NULL DEFAULT 0,
      source TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (investment_id) REFERENCES investments(id) ON DELETE CASCADE,
      UNIQUE(investment_id, event_date)
    );

    CREATE INDEX IF NOT EXISTS idx_investment_split_events_lookup
      ON investment_split_events(investment_id, event_date);
  `);

  const existingInfo = conn.prepare("PRAGMA table_info(market_price_cache)").all();
  const existingCols = existingInfo.map((row) => String(row.name || '').toLowerCase());
  const volumeType = String(existingInfo.find((row) => String(row.name || '').toLowerCase() === 'volume')?.type || '').toUpperCase();
  if (
    existingCols.includes('provider_close')
    || existingCols.includes('provider_adj_close')
    || existingCols.includes('adjusted_as_of')
    || existingCols.includes('adjustment_version')
    || existingCols.includes('provider_symbol')
    || (volumeType && !volumeType.includes('INT'))
  ) {
    // Drop legacy provider_* and removed adjustment metadata columns by table rebuild.
    conn.exec(`
      BEGIN;
      CREATE TABLE market_price_cache_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        investment_id INTEGER,
        instrument_type TEXT NOT NULL,
        symbol TEXT NOT NULL,
        date TEXT NOT NULL,
        open REAL,
        high REAL,
        low REAL,
        close REAL,
        adj_close REAL,
        reverse_factor REAL DEFAULT 1,
        split_history_json TEXT,
        volume INTEGER,
        source TEXT,
        fetched_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(instrument_type, symbol, date)
      );

      INSERT INTO market_price_cache_new (
        id, investment_id, instrument_type, symbol, date, open, high, low, close, adj_close, reverse_factor, split_history_json, volume, source, fetched_at, updated_at
      )
      SELECT
        id,
        investment_id,
        instrument_type,
        symbol,
        date,
        open,
        high,
        low,
        close,
        adj_close,
        reverse_factor,
        split_history_json,
        CASE WHEN volume IS NULL THEN NULL ELSE CAST(ROUND(volume) AS INTEGER) END,
        source,
        fetched_at,
        updated_at
      FROM market_price_cache;

      DROP TABLE market_price_cache;
      ALTER TABLE market_price_cache_new RENAME TO market_price_cache;

      CREATE INDEX IF NOT EXISTS idx_market_price_cache_lookup
        ON market_price_cache(instrument_type, symbol, date);
      CREATE INDEX IF NOT EXISTS idx_market_price_cache_symbol_date
        ON market_price_cache(symbol, date);
      CREATE INDEX IF NOT EXISTS idx_market_price_cache_inv_lookup
        ON market_price_cache(investment_id, date);
      COMMIT;
    `);
  }

  const cols = conn.prepare("PRAGMA table_info(market_price_cache)").all().map((row) => String(row.name || '').toLowerCase());
  const ensureColumn = (name, ddl) => {
    if (!cols.includes(String(name).toLowerCase())) {
      conn.exec(`ALTER TABLE market_price_cache ADD COLUMN ${ddl}`);
      cols.push(String(name).toLowerCase());
    }
  };
  ensureColumn('reverse_factor', 'reverse_factor REAL DEFAULT 1');
  ensureColumn('split_history_json', 'split_history_json TEXT');
  ensureColumn('investment_id', 'investment_id INTEGER');
  ensureColumn('volume', 'volume INTEGER');

  conn.exec(`
    CREATE INDEX IF NOT EXISTS idx_market_price_cache_inv_lookup
      ON market_price_cache(investment_id, date);
  `);

  ensureInvestmentCacheMigration(conn);
  ensureMarketCacheIsoDateMigration(conn);
  ensureFxRateCacheMigration(conn);

  conn.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_market_price_cache_date_iso_insert
    BEFORE INSERT ON market_price_cache
    FOR EACH ROW
    WHEN NEW.date NOT GLOB '????-??-??'
    BEGIN
      SELECT RAISE(ABORT, 'market_price_cache.date must be ISO YYYY-MM-DD');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_market_price_cache_date_iso_update
    BEFORE UPDATE OF date ON market_price_cache
    FOR EACH ROW
    WHEN NEW.date NOT GLOB '????-??-??'
    BEGIN
      SELECT RAISE(ABORT, 'market_price_cache.date must be ISO YYYY-MM-DD');
    END;
  `);

  conn.exec(`
    DROP INDEX IF EXISTS uq_market_price_cache_investment_date;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_market_price_cache_investment_date
      ON market_price_cache(investment_id, date);
  `);

  schemaEnsured = true;
}

function ensureMarketCacheIsoDateMigration(conn) {
  try {
    const done = conn.prepare('SELECT value FROM config WHERE key = ?').get(MARKET_CACHE_ISO_DATE_MIGRATION_KEY);
    if (String(done?.value || '') === '1') return;

    const tx = conn.transaction(() => {
      conn.exec(`
        CREATE TEMP TABLE _market_price_cache_iso_stage AS
        SELECT
          id,
          investment_id,
          instrument_type,
          symbol,
          CASE
            WHEN date GLOB '??-??-????' THEN substr(date, 7, 4) || '-' || substr(date, 4, 2) || '-' || substr(date, 1, 2)
            WHEN date GLOB '??/??/????' THEN substr(date, 7, 4) || '-' || substr(date, 4, 2) || '-' || substr(date, 1, 2)
            WHEN date GLOB '????-??-??*' THEN substr(date, 1, 10)
            ELSE date
          END AS normalized_date,
          open,
          high,
          low,
          close,
          adj_close,
          reverse_factor,
          split_history_json,
          volume,
          source,
          fetched_at,
          updated_at
        FROM market_price_cache;

        DELETE FROM market_price_cache;

        INSERT INTO market_price_cache (
          investment_id,
          instrument_type,
          symbol,
          date,
          open,
          high,
          low,
          close,
          adj_close,
          reverse_factor,
          split_history_json,
          volume,
          source,
          fetched_at,
          updated_at
        )
        SELECT
          s.investment_id,
          s.instrument_type,
          s.symbol,
          s.normalized_date,
          s.open,
          s.high,
          s.low,
          s.close,
          s.adj_close,
          COALESCE(s.reverse_factor, 1),
          s.split_history_json,
          s.volume,
          s.source,
          s.fetched_at,
          s.updated_at
        FROM (
          SELECT
            stage.*,
            ROW_NUMBER() OVER (
              PARTITION BY stage.instrument_type, stage.symbol, stage.normalized_date
              ORDER BY
                CASE WHEN stage.investment_id IS NOT NULL THEN 1 ELSE 0 END DESC,
                CASE UPPER(COALESCE(stage.source, ''))
                  WHEN 'LIVE' THEN 3
                  WHEN 'NPSNAV' THEN 3
                  WHEN 'MFAPI' THEN 3
                  WHEN 'LOCF' THEN 1
                  ELSE 2
                END DESC,
                stage.id DESC
            ) AS rn
          FROM _market_price_cache_iso_stage stage
          WHERE stage.normalized_date GLOB '????-??-??'
        ) s
        WHERE s.rn = 1;

        DROP TABLE _market_price_cache_iso_stage;
      `);

      conn.prepare(`
        INSERT INTO config (key, value, updated_at)
        VALUES (?, '1', datetime('now'))
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(MARKET_CACHE_ISO_DATE_MIGRATION_KEY);
    });

    tx();
  } catch (err) {
    console.warn(`[PriceCache] ISO date migration skipped: ${err.message}`);
  }
}

function normalizeSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase();
}

function getCurrentTickerWindowStart(historyRows, tickerSymbol) {
  const ticker = normalizeSymbol(tickerSymbol);
  if (!ticker) return '1900-01-01';
  if (!Array.isArray(historyRows) || historyRows.length === 0) return '1900-01-01';

  let latestValidTo = null;
  for (const row of historyRows) {
    const validTo = normalizeDate(row?.valid_to || null);
    if (!validTo) continue;
    if (!latestValidTo || validTo > latestValidTo) latestValidTo = validTo;
  }

  return latestValidTo ? addDays(latestValidTo, 1) : '1900-01-01';
}

function choosePreferredInvestmentRow(existing, candidate) {
  if (!existing) return candidate;
  if (!candidate) return existing;

  const sourceRank = (src) => {
    const v = String(src || '').toUpperCase();
    if (v === 'LOCF') return 1;
    if (v === 'IPO') return 2;
    return 3;
  };

  const existingRank = sourceRank(existing.source);
  const candidateRank = sourceRank(candidate.source);
  if (candidateRank > existingRank) return candidate;
  if (candidateRank < existingRank) return existing;

  const existingAdj = existing.adjClose ?? null;
  const candidateAdj = candidate.adjClose ?? null;
  if (existingAdj == null && candidateAdj != null) return candidate;
  if (existingAdj != null && candidateAdj == null) return existing;

  const existingClose = existing.close ?? null;
  const candidateClose = candidate.close ?? null;
  if (existingClose == null && candidateClose != null) return candidate;
  if (existingClose != null && candidateClose == null) return existing;

  return candidate;
}

function ensureInvestmentCacheMigration(conn) {
  try {
    const done = conn.prepare('SELECT value FROM config WHERE key = ?').get(INVESTMENT_CACHE_MIGRATION_KEY);
    if (String(done?.value || '') === '1') return;
    const tx = conn.transaction(() => {
      const cols = conn.prepare("PRAGMA table_info(market_price_cache)").all().map((row) => String(row.name || '').toLowerCase());
      if (cols.includes('provider_symbol')) {
        conn.exec(`
          UPDATE market_price_cache
          SET symbol = TRIM(provider_symbol)
          WHERE investment_id IS NOT NULL
            AND provider_symbol IS NOT NULL
            AND TRIM(provider_symbol) <> ''
            AND (symbol IS NULL OR TRIM(symbol) = '' OR symbol LIKE 'INVESTMENT:%')
        `);
      }

      conn.exec(`
        UPDATE market_price_cache
        SET symbol = (
          SELECT TRIM(i.ticker_symbol)
          FROM investments i
          WHERE i.id = market_price_cache.investment_id
        )
        WHERE investment_id IS NOT NULL
          AND (symbol IS NULL OR TRIM(symbol) = '' OR symbol LIKE 'INVESTMENT:%')
          AND EXISTS (
            SELECT 1
            FROM investments i
            WHERE i.id = market_price_cache.investment_id
              AND i.ticker_symbol IS NOT NULL
              AND TRIM(i.ticker_symbol) <> ''
          )
      `);

      conn.exec(`
        DELETE FROM market_price_cache
        WHERE investment_id IS NOT NULL
          AND id NOT IN (
            SELECT MAX(id)
            FROM market_price_cache
            WHERE investment_id IS NOT NULL
            GROUP BY investment_id, date
          )
      `);

      conn.prepare(`
        INSERT INTO config (key, value, updated_at)
        VALUES (?, '1', datetime('now'))
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(INVESTMENT_CACHE_MIGRATION_KEY);
    });

    tx();
  } catch (err) {
    console.warn(`[PriceCache] Investment cache migration skipped: ${err.message}`);
  }
}

function ensureFxRateCacheMigration(conn) {
  try {
    const done = conn.prepare('SELECT value FROM config WHERE key = ?').get('fx_rate_cache_schema_migration_v1');
    if (String(done?.value || '') === '1') return;

    const cols = conn.prepare("PRAGMA table_info(fx_rate_cache)").all().map((row) => String(row.name || '').toLowerCase());
    
    // Check if old schema exists (has 'pair' column and 'id' as primary key instead of 'date' as primary key)
    if (cols.includes('pair')) {
      const tx = conn.transaction(() => {
        // Backup existing data
        const backup = conn.prepare(`
          SELECT date, rate, source, fetched_at, updated_at
          FROM fx_rate_cache
        `).all();

        console.log(`[PriceCache] FX rate cache migration: backing up ${backup.length} rows`);

        // Drop old table
        conn.exec(`DROP TABLE fx_rate_cache`);

        // Create new table with correct schema
        conn.exec(`
          CREATE TABLE fx_rate_cache (
            date TEXT PRIMARY KEY,
            rate REAL NOT NULL,
            source TEXT,
            fetched_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
          );

          CREATE INDEX IF NOT EXISTS idx_fx_rate_cache_date
            ON fx_rate_cache(date);
        `);

        // Restore data (only insert if date is valid ISO format)
        const insertStmt = conn.prepare(`
          INSERT INTO fx_rate_cache (date, rate, source, fetched_at, updated_at)
          VALUES (?, ?, ?, ?, ?)
        `);

        let restored = 0;
        for (const row of backup) {
          if (row.date && /^\d{4}-\d{2}-\d{2}$/.test(String(row.date).trim())) {
            insertStmt.run(row.date, row.rate, row.source, row.fetched_at, row.updated_at);
            restored++;
          }
        }

        console.log(`[PriceCache] FX rate cache migration: restored ${restored}/${backup.length} rows`);

        // Mark migration as done
        conn.prepare(`
          INSERT INTO config (key, value, updated_at)
          VALUES (?, '1', datetime('now'))
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `).run('fx_rate_cache_schema_migration_v1');
      });

      tx();
      console.log(`[PriceCache] FX rate cache schema migration completed successfully`);
    }
  } catch (err) {
    console.warn(`[PriceCache] FX rate cache schema migration skipped: ${err.message}`);
  }
}

function normalizeDate(date) {
  if (!date) return null;
  const raw = String(date).trim();
  if (!raw) return null;

  const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;

  const dmyDash = raw.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (dmyDash) return `${dmyDash[3]}-${dmyDash[2]}-${dmyDash[1]}`;

  const dmySlash = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (dmySlash) return `${dmySlash[3]}-${dmySlash[2]}-${dmySlash[1]}`;

  return null;
}

function isFxInstrumentType(instrumentType) {
  return String(instrumentType || '').trim().toUpperCase() === 'FX';
}

function getInvestmentHoldingWindows(conn, investmentId) {
  const invId = Number(investmentId);
  if (!Number.isInteger(invId) || invId <= 0) return [];

  const rows = conn.prepare(`
    SELECT
      date(transaction_date) AS tx_date,
      COALESCE(SUM(
        CASE
          WHEN transaction_type IN ('BUY', 'DEPOSIT', 'BONUS', 'SPLIT', 'IPO', 'TRANSFER_IN', 'SWITCH_IN', 'RIGHTS', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'VEST', 'ESPP_PURCHASE') THEN COALESCE(units, 0)
          WHEN transaction_type IN ('SELL', 'REDEMPTION', 'WITHDRAWAL', 'TRANSFER_OUT', 'SWITCH_OUT', 'CONSOLIDATION', 'CHARGES', 'AMC') THEN -COALESCE(units, 0)
          ELSE 0
        END
      ), 0) AS units_delta
    FROM transactions
    WHERE investment_id = ?
    GROUP BY date(transaction_date)
    ORDER BY date(transaction_date) ASC
  `).all(invId);

  if (!rows.length) return [];

  const windows = [];
  let cumulativeUnits = 0;
  let activeStart = null;
  for (const row of rows) {
    const txDate = normalizeDate(row?.tx_date);
    if (!txDate) continue;
    const before = cumulativeUnits;
    cumulativeUnits += Number(row?.units_delta || 0);

    if (before <= 0 && cumulativeUnits > 0) {
      activeStart = txDate;
      continue;
    }

    if (before > 0 && cumulativeUnits <= 0 && activeStart) {
      windows.push({ startDate: activeStart, endDate: txDate });
      activeStart = null;
    }
  }

  if (activeStart) {
    windows.push({ startDate: activeStart, endDate: null });
  }

  return windows;
}

function isDateWithinHoldingWindows(date, windows) {
  if (!date || !Array.isArray(windows) || windows.length === 0) return false;
  for (const window of windows) {
    const startDate = normalizeDate(window?.startDate);
    const endDate = normalizeDate(window?.endDate);
    if (!startDate) continue;
    if (date < startDate) continue;
    if (!endDate || date <= endDate) return true;
  }
  return false;
}

function purgeInvestmentCacheOutsideHoldingWindows(conn, investmentId, windows) {
  const invId = Number(investmentId);
  if (!Number.isInteger(invId) || invId <= 0) return;

  if (!Array.isArray(windows) || windows.length === 0) {
    conn.prepare(`DELETE FROM market_price_cache WHERE investment_id = ?`).run(invId);
    return;
  }

  const clauses = [];
  const params = [invId];
  for (const window of windows) {
    const startDate = normalizeDate(window?.startDate);
    const endDate = normalizeDate(window?.endDate);
    if (!startDate) continue;
    if (endDate) {
      clauses.push('(date >= ? AND date <= ?)');
      params.push(startDate, endDate);
    } else {
      clauses.push('(date >= ?)');
      params.push(startDate);
    }
  }

  if (!clauses.length) {
    conn.prepare(`DELETE FROM market_price_cache WHERE investment_id = ?`).run(invId);
    return;
  }

  conn.prepare(`
    DELETE FROM market_price_cache
    WHERE investment_id = ?
      AND NOT (${clauses.join(' OR ')})
  `).run(...params);
}

function getMarketClosedDaysForYear(year) {
  if (closedDaysByYear.has(year)) return closedDaysByYear.get(year);
  const holidays = getMarketHolidays(year).map((row) => row.date);
  const weekends = getWeekends(year).map((row) => row.date);
  const closed = new Set([...holidays, ...weekends]);
  closedDaysByYear.set(year, closed);
  return closed;
}

function normalizeInstrumentType(instrumentType) {
  return String(instrumentType || '').trim().toUpperCase();
}

function isWeekdaySessionDate(date) {
  const iso = normalizeDate(date);
  if (!iso) return false;
  const d = new Date(`${iso}T00:00:00.000Z`);
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  return true;
}

function isMarketSessionDate(date, instrumentType = null) {
  const iso = normalizeDate(date);
  if (!iso) return false;
  if (!isWeekdaySessionDate(iso)) return false;

  const normalizedType = normalizeInstrumentType(instrumentType);
  if (normalizedType === 'FOREIGN_STOCK' || normalizedType === 'FX') {
    // Foreign-stock and FX sessions should not be filtered by India holiday calendar.
    return true;
  }

  const d = new Date(`${iso}T00:00:00.000Z`);
  return !getMarketClosedDaysForYear(d.getUTCFullYear()).has(iso);
}

function getMarketSessionDates(fromDate, toDate, instrumentType = null) {
  const start = normalizeDate(fromDate);
  const end = normalizeDate(toDate);
  if (!start || !end) return [];

  const dates = [];
  let cursor = new Date(`${start}T00:00:00.000Z`);
  const stop = new Date(`${end}T00:00:00.000Z`);
  while (cursor <= stop) {
    const iso = cursor.toISOString().split('T')[0];
    if (isMarketSessionDate(iso, instrumentType)) dates.push(iso);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function normalizeCachePoint(point) {
  if (!point) return null;
  const date = normalizeDate(point.date);
  if (!date) return null;
  return {
    date,
    open: point.open ?? null,
    high: point.high ?? null,
    low: point.low ?? null,
    close: point.close ?? null,
    adjClose: point.adjClose ?? point.adj_close ?? null,
    reverseFactor: point.reverseFactor ?? point.reverse_factor ?? 1,
    splitHistoryJson: point.splitHistoryJson ?? point.split_history_json ?? null,
    volume: normalizeVolumeValue(point.volume),
    source: point.source ?? null,
  };
}

function normalizeVolumeValue(volume) {
  if (volume == null || volume === '') return null;
  const n = Number(volume);
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

function isIndianStockInstrumentType(instrumentType) {
  return instrumentType === 'INDIAN_STOCK';
}

function isStockInstrumentType(instrumentType) {
  return instrumentType === 'INDIAN_STOCK' || instrumentType === 'FOREIGN_STOCK';
}

function isSplitSupportedInstrumentType(instrumentType) {
  return instrumentType === 'INDIAN_STOCK' || instrumentType === 'FOREIGN_STOCK';
}

function baseIndianSymbol(symbol) {
  return String(symbol || '').trim().replace(/\.(NS|BO)$/i, '').toUpperCase();
}

function hasTransactionColumn(columnName) {
  const conn = getCacheDb();
  try {
    const cols = conn.prepare('PRAGMA table_info(transactions)').all().map((c) => String(c.name || '').toLowerCase());
    return cols.includes(String(columnName || '').toLowerCase());
  } catch (err) {
    console.error(`[PriceCache] Failed to inspect transactions schema for column ${columnName}: ${err.message}`);
    return false;
  }
}

function loadLinkedIndianStockInvestments(symbol) {
  const conn = getCacheDb();
  const trimmed = String(symbol || '').trim();
  if (!trimmed) return [];

  const upperSymbol = trimmed.toUpperCase();
  const symbolBase = baseIndianSymbol(trimmed);

  try {
    return conn.prepare(`
      SELECT DISTINCT i.id
      FROM investments i
      LEFT JOIN investment_symbol_history ish ON ish.investment_id = i.id
      WHERE i.asset_type IN ('INDIAN_STOCK', 'FOREIGN_STOCK')
        AND (
          UPPER(COALESCE(ish.symbol, '')) = ?
          OR UPPER(COALESCE(i.ticker_symbol, '')) = ?
          OR (? <> '' AND UPPER(COALESCE(i.ticker_symbol, '')) = ?)
        )
      ORDER BY i.id ASC
    `).all(upperSymbol, upperSymbol, symbolBase, symbolBase)
      .map((r) => Number(r.id))
      .filter((id) => Number.isInteger(id) && id > 0);
  } catch (err) {
    console.error(`[PriceCache] Failed to load linked investments for symbol ${upperSymbol}: ${err.message}`);
    return [];
  }
}

function inferLocalSplitRatio(db, investmentId, portfolioId, eventDate, addedUnits) {
  const heldRow = db.prepare(`
    SELECT COALESCE(SUM(
      CASE
        WHEN transaction_type IN ('BUY','DEPOSIT','BONUS','SPLIT','IPO','TRANSFER_IN','SWITCH_IN','RIGHTS','EMPLOYER_CONTRIBUTION','VOLUNTARY_CONTRIBUTION','VEST','ESPP_PURCHASE') THEN COALESCE(units, 0)
        WHEN transaction_type IN ('SELL','REDEMPTION','WITHDRAWAL','TRANSFER_OUT','SWITCH_OUT','CONSOLIDATION','CHARGES','AMC') THEN -COALESCE(units, 0)
        ELSE 0
      END
    ), 0) AS held_before
    FROM transactions
    WHERE investment_id = ?
      AND portfolio_id = ?
      AND date(transaction_date) < date(?)
  `).get(investmentId, portfolioId, eventDate);

  const heldBefore = Number(heldRow?.held_before || 0);
  const delta = Number(addedUnits || 0);
  if (!(heldBefore > 0) || !(delta > 0)) return null;
  const ratio = (heldBefore + delta) / heldBefore;
  return ratio > 1 ? ratio : null;
}

function mergeSplitEventsByDate(symbol, yahooRows, localEvents) {
  const yahooByDate = new Map((yahooRows || []).map((r) => [r.date, r]));
  const localByDate = new Map((localEvents || []).map((r) => [r.date, r]));
  const mergedDates = new Set([...yahooByDate.keys(), ...localByDate.keys()]);

  const merged = [];
  for (const date of Array.from(mergedDates).sort()) {
    const y = yahooByDate.get(date);
    const l = localByDate.get(date);
    if (y && l && Math.abs(Number(y.ratio) - Number(l.ratio)) > 1e-9) {
      console.warn(`[PriceCache] Split event mismatch for ${symbol} on ${date}: yahoo=${y.ratio}, local=${l.ratio}, locked_local=${l.locked ? 1 : 0}`);
    }

    if (l?.locked) {
      merged.push({ date, ratio: Number(l.ratio), locked: true, source: 'local_locked' });
    } else if (y) {
      merged.push({ date, ratio: Number(y.ratio), locked: false, source: 'yahoo' });
    } else if (l) {
      merged.push({ date, ratio: Number(l.ratio), locked: !!l.locked, source: 'local' });
    }
  }

  return merged;
}

function loadLocalSplitEventsForInvestmentIds(dbConn, investmentIds, symbolForLog = 'unknown') {
  if (!Array.isArray(investmentIds) || !investmentIds.length) return [];

  const placeholders = investmentIds.map(() => '?').join(',');
  const hasLocked = hasTransactionColumn('locked');
  const lockSelect = hasLocked ? 'COALESCE(t.locked, 0) AS locked' : '0 AS locked';

  const rows = dbConn.prepare(`
    SELECT
      t.id,
      t.investment_id,
      t.portfolio_id,
      date(t.transaction_date) AS event_date,
      COALESCE(t.units, 0) AS units,
      ${lockSelect}
    FROM transactions t
    WHERE t.investment_id IN (${placeholders})
      AND t.transaction_type IN ('SPLIT', 'BONUS')
    ORDER BY date(t.transaction_date) ASC, t.id ASC
  `).all(...investmentIds);

  const byDate = new Map();
  for (const row of rows) {
    const eventDate = normalizeDate(row?.event_date);
    if (!eventDate) continue;

    const ratio = inferLocalSplitRatio(
      dbConn,
      Number(row.investment_id),
      Number(row.portfolio_id),
      eventDate,
      Number(row.units || 0)
    );
    if (!(ratio > 1)) continue;

    const locked = Number(row.locked || 0) === 1;
    const prev = byDate.get(eventDate);
    if (!prev) {
      byDate.set(eventDate, { date: eventDate, ratio, locked, sources: ['local'] });
      continue;
    }

    const conflict = Math.abs(prev.ratio - ratio) > 1e-9;
    if (conflict) {
      console.warn(`[PriceCache] Local split ratio mismatch on ${eventDate} for ${symbolForLog}: existing=${prev.ratio}, new=${ratio}`);
    }
    byDate.set(eventDate, {
      date: eventDate,
      ratio: Math.max(prev.ratio, ratio),
      locked: prev.locked || locked,
      sources: ['local'],
    });
  }

  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

function loadLocalSplitEventsForSymbol(symbol) {
  const dbConn = getCacheDb();
  const investmentIds = loadLinkedIndianStockInvestments(symbol);
  return loadLocalSplitEventsForInvestmentIds(dbConn, investmentIds, symbol);
}

function loadLocalSplitEventsForInvestment(investmentId, symbolForLog = 'unknown') {
  if (!investmentId) return [];
  const dbConn = getCacheDb();
  return loadLocalSplitEventsForInvestmentIds(dbConn, [Number(investmentId)], symbolForLog);
}

function getFirstTxnDateForLinkedInvestments(symbol) {
  const dbConn = getCacheDb();
  const investmentIds = loadLinkedIndianStockInvestments(symbol);
  if (!investmentIds.length) return null;
  const placeholders = investmentIds.map(() => '?').join(',');
  const row = dbConn.prepare(`
    SELECT MIN(date(transaction_date)) AS min_date
    FROM transactions
    WHERE investment_id IN (${placeholders})
  `).get(...investmentIds);
  return normalizeDate(row?.min_date || null);
}

function getFirstTxnDateForInvestment(investmentId) {
  if (!investmentId) return null;
  const dbConn = getCacheDb();
  const row = dbConn.prepare(`
    SELECT MIN(date(transaction_date)) AS min_date
    FROM transactions
    WHERE investment_id = ?
  `).get(Number(investmentId));
  return normalizeDate(row?.min_date || null);
}

function getStoredSplitEventsForInvestment(investmentId) {
  if (!investmentId) return [];
  const dbConn = getCacheDb();
  const rows = dbConn.prepare(`
    SELECT event_date, ratio, locked, source
    FROM investment_split_events
    WHERE investment_id = ?
    ORDER BY event_date ASC
  `).all(Number(investmentId));

  return rows
    .map((row) => ({
      date: normalizeDate(row?.event_date),
      ratio: Number(row?.ratio),
      locked: Number(row?.locked || 0) === 1,
      source: String(row?.source || 'unknown'),
    }))
    .filter((row) => row.date && Number.isFinite(row.ratio) && row.ratio > 1)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

function upsertInvestmentSplitEvents(investmentId, events) {
  if (!investmentId || !Array.isArray(events)) return;
  const dbConn = getCacheDb();
  const normalized = events
    .map((event) => ({
      date: normalizeDate(event?.date),
      ratio: Number(event?.ratio),
      locked: !!event?.locked,
      source: String(event?.source || 'unknown'),
    }))
    .filter((event) => event.date && Number.isFinite(event.ratio) && event.ratio > 1)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));

  const tx = dbConn.transaction((rows) => {
    dbConn.prepare(`DELETE FROM investment_split_events WHERE investment_id = ?`).run(Number(investmentId));
    if (!rows.length) return;
    const stmt = dbConn.prepare(`
      INSERT INTO investment_split_events (investment_id, event_date, ratio, locked, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(investment_id, event_date) DO UPDATE SET
        ratio = excluded.ratio,
        locked = excluded.locked,
        source = excluded.source,
        updated_at = datetime('now')
    `);
    for (const row of rows) {
      stmt.run(Number(investmentId), row.date, row.ratio, row.locked ? 1 : 0, row.source);
    }
  });

  tx(normalized);
}

function fetchYahooSplitEventsRange(symbol, fromDate, toDate, options = {}) {
  const start = normalizeDate(fromDate);
  const end = normalizeDate(toDate);
  const includeStatus = options?.includeStatus === true;
  if (!symbol || !start || !end) {
    return Promise.resolve(includeStatus ? { rows: [], failed: false } : []);
  }

  const period1 = Math.floor(new Date(`${start}T00:00:00.000Z`).getTime() / 1000);
  const period2 = Math.floor(new Date(`${end}T23:59:59.000Z`).getTime() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1d&events=split`;

  return new Promise((resolve) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const result = json.chart?.result?.[0];
          const splitObj = result?.events?.splits || {};
          const rows = Object.entries(splitObj).map(([ts, s]) => ({
            date: new Date(Number(ts) * 1000).toISOString().split('T')[0],
            ratio: Number(s?.numerator || 0) / Number(s?.denominator || 0),
            source: 'yahoo',
          })).filter((r) => r.date && Number.isFinite(r.ratio) && r.ratio > 1);
          rows.sort((a, b) => a.date.localeCompare(b.date));
          resolve(includeStatus ? { rows, failed: false } : rows);
        } catch (err) {
          console.error(`[PriceCache] Failed to parse Yahoo split response for ${symbol}: ${err.message}`);
          resolve(includeStatus ? { rows: [], failed: true } : []);
        }
      });
      res.on('error', (err) => {
        console.error(`[PriceCache] Yahoo split request stream error for ${symbol}: ${err?.message || err}`);
        resolve(includeStatus ? { rows: [], failed: true } : []);
      });
    }).on('error', (err) => {
      console.error(`[PriceCache] Yahoo split request failed for ${symbol}: ${err?.message || err}`);
      resolve(includeStatus ? { rows: [], failed: true } : []);
    });
  });
}

async function loadMergedSplitEventsForSymbol(instrumentType, symbol, options = {}) {
  if (!isSplitSupportedInstrumentType(instrumentType)) {
    return options?.includeStatus === true ? { events: [], failed: false } : [];
  }
  const key = `${instrumentType}:${String(symbol || '').toUpperCase()}`;
  const cached = splitEventCache.get(key);
  if (cached && (Date.now() - Number(cached.fetchedAt || 0)) < SPLIT_EVENT_CACHE_TTL_MS) {
    if (options?.includeStatus === true) {
      return { events: cached.events || [], failed: !!cached.failed };
    }
    return cached.events || [];
  }

  const firstTxnDate = getFirstTxnDateForLinkedInvestments(symbol);
  const toDate = normalizeDate(new Date().toISOString());
  const localEvents = loadLocalSplitEventsForSymbol(symbol);
  if (!firstTxnDate) {
    splitEventCache.set(key, { events: localEvents, fetchedAt: Date.now(), failed: false });
    if (options?.includeStatus === true) {
      return { events: localEvents, failed: false };
    }
    return localEvents;
  }

  const yahooResult = await fetchYahooSplitEventsRange(symbol, firstTxnDate, toDate, { includeStatus: true });
  const yahooRows = yahooResult?.rows || [];
  const splitCheckFailed = !!yahooResult?.failed;
  const merged = mergeSplitEventsByDate(symbol, yahooRows, localEvents);

  splitEventCache.set(key, { events: merged, fetchedAt: Date.now(), failed: splitCheckFailed });
  if (options?.includeStatus === true) {
    return { events: merged, failed: splitCheckFailed };
  }
  return merged;
}

async function loadMergedSplitEventsForInvestment(investmentId, instrumentType, symbol, options = {}) {
  if (!investmentId || !isSplitSupportedInstrumentType(instrumentType)) {
    return options?.includeStatus === true ? { events: [], failed: false } : [];
  }

  const normalizedSymbol = String(symbol || '').trim();
  const key = `INV:${Number(investmentId)}:${String(instrumentType || '').toUpperCase()}`;
  const cached = splitEventCache.get(key);
  if (cached && (Date.now() - Number(cached.fetchedAt || 0)) < SPLIT_EVENT_CACHE_TTL_MS) {
    if (options?.includeStatus === true) {
      return { events: cached.events || [], failed: !!cached.failed };
    }
    return cached.events || [];
  }

  const firstTxnDate = getFirstTxnDateForInvestment(investmentId);
  const localEvents = loadLocalSplitEventsForInvestment(investmentId, normalizedSymbol || `INV:${investmentId}`);
  if (!firstTxnDate || !normalizedSymbol) {
    const mergedLocal = localEvents;
    upsertInvestmentSplitEvents(investmentId, mergedLocal);
    splitEventCache.set(key, { events: mergedLocal, fetchedAt: Date.now(), failed: false });
    if (options?.includeStatus === true) return { events: mergedLocal, failed: false };
    return mergedLocal;
  }

  const toDate = normalizeDate(new Date().toISOString());
  const yahooResult = await fetchYahooSplitEventsRange(normalizedSymbol, firstTxnDate, toDate, { includeStatus: true });
  const yahooRows = yahooResult?.rows || [];
  const splitCheckFailed = !!yahooResult?.failed;
  const merged = splitCheckFailed
    ? (() => {
      const stored = getStoredSplitEventsForInvestment(investmentId);
      return stored.length > 0 ? stored : localEvents;
    })()
    : mergeSplitEventsByDate(normalizedSymbol, yahooRows, localEvents);

  upsertInvestmentSplitEvents(investmentId, merged);
  splitEventCache.set(key, { events: merged, fetchedAt: Date.now(), failed: splitCheckFailed });

  if (options?.includeStatus === true) {
    return { events: merged, failed: splitCheckFailed };
  }
  return merged;
}

function computeReverseFactorForDate(events, date) {
  if (!Array.isArray(events) || events.length === 0) return 1;
  let factor = 1;
  for (const event of events) {
    if (event?.date > date && Number(event?.ratio) > 1) {
      factor *= Number(event.ratio);
    }
  }
  return factor > 0 ? factor : 1;
}

function getAppliedSplitEventsForDate(events, date) {
  if (!Array.isArray(events) || !events.length) return [];
  return events
    .filter((event) => event?.date > date && Number(event?.ratio) > 1)
    .map((event) => ({
      date: String(event.date),
      ratio: Number(event.ratio),
      source: String(event.source || 'unknown'),
      locked: !!event.locked,
    }));
}

function maybeReverseAdjustPointsWithEvents(instrumentType, points, events) {
  if (!Array.isArray(points) || points.length === 0) return [];
  if (!isSplitSupportedInstrumentType(instrumentType)) {
    return points.map((p) => {
      return {
        ...p,
        close: p.close ?? null,
        adjClose: p.adjClose ?? p.close ?? null,
        reverseFactor: p.reverseFactor ?? 1,
      };
    });
  }

  return points.map((p) => {
    const factor = computeReverseFactorForDate(events, p.date);
    const rawClose = p.close ?? null;
    const multiplier = Number.isFinite(factor) && factor > 0 ? factor : 1;
    const adjustedClose = rawClose == null ? null : Number(rawClose) * multiplier;

    return {
      ...p,
      // Contract: close is raw provider close, adjClose is split-adjusted valuation close.
      close: rawClose,
      adjClose: adjustedClose,
      reverseFactor: multiplier,
      splitHistoryJson: null,
    };
  });
}

function buildRowMap(rows) {
  const map = new Map();
  for (const row of rows || []) {
    if (!row?.date) continue;
    map.set(row.date, row);
  }
  return map;
}

function requiresStrictOhlcv(instrumentType) {
  const normalizedType = normalizeInstrumentType(instrumentType);
  return ['INDIAN_STOCK', 'FOREIGN_STOCK'].includes(normalizedType);
}

function hasRequiredProviderOhlcv(row, instrumentType) {
  if (!row || row.close == null) return false;

  const source = String(row.source || '').toUpperCase();
  if (source === 'LOCF' || source === 'IPO') return true;

  if (!requiresStrictOhlcv(instrumentType)) return true;

  const hasOpen = row.open != null && Number.isFinite(Number(row.open));
  const hasHigh = row.high != null && Number.isFinite(Number(row.high));
  const hasLow = row.low != null && Number.isFinite(Number(row.low));
  const hasVolume = row.volume != null && Number.isFinite(Number(row.volume));
  return hasOpen && hasHigh && hasLow && hasVolume;
}

function hasCompleteCoverage(cachedRows, marketSessionDates, instrumentType = null, extraCoveredDates = null) {
  if (!marketSessionDates.length) return true;
  const cached = buildRowMap(cachedRows);
  return marketSessionDates.every((date) => {
    if (extraCoveredDates && extraCoveredDates.has(date)) return true;
    if (!cached.has(date)) return false;
    return hasRequiredProviderOhlcv(cached.get(date), instrumentType);
  });
}

function getCachedSplitEventsFromRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  for (const row of rows) {
    const raw = row?.split_history_json ?? row?.splitHistoryJson;
    if (!raw) continue;
    try {
      const parsed = JSON.parse(String(raw));
      if (!Array.isArray(parsed)) continue;
      return parsed
        .map((event) => ({
          date: normalizeDate(event?.date),
          ratio: Number(event?.ratio),
        }))
        .filter((event) => event.date && Number.isFinite(event.ratio) && event.ratio > 1)
        .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    } catch (err) {
      console.error(`[PriceCache] Failed to parse cached split history JSON for date ${row?.date || 'unknown'}: ${err.message}`);
      return [];
    }
  }
  return [];
}

function getCachedSplitEventsForSymbol(instrumentType, symbol) {
  if (!isIndianStockInstrumentType(instrumentType)) return [];
  const conn = getCacheDb();
  const rows = conn.prepare(`
    SELECT date, split_history_json
    FROM market_price_cache
    WHERE instrument_type = ?
      AND symbol = ?
      AND split_history_json IS NOT NULL
      AND split_history_json <> ''
    ORDER BY date ASC
    LIMIT 1
  `).all(instrumentType, symbol);
  return getCachedSplitEventsFromRows(rows);
}

function splitFingerprint(events) {
  if (!Array.isArray(events) || events.length === 0) return '[]';
  return JSON.stringify(
    events
      .map((event) => ({
        date: normalizeDate(event?.date),
        ratio: Number(event?.ratio),
      }))
      .filter((event) => event.date && Number.isFinite(event.ratio) && event.ratio > 1)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
  );
}

function getSeriesMissingStartDate(rows, marketSessionDates, instrumentType = null, extraCoveredDates = null) {
  if (!Array.isArray(marketSessionDates) || marketSessionDates.length === 0) return null;
  const cached = buildRowMap(rows || []);
  return marketSessionDates.find((date) => {
    if (extraCoveredDates && extraCoveredDates.has(date)) return false;
    return !cached.has(date) || !hasRequiredProviderOhlcv(cached.get(date), instrumentType);
  }) || null;
}

function getSparseMissingWindows(rows, marketSessionDates, instrumentType = null, options = {}) {
  if (!Array.isArray(marketSessionDates) || marketSessionDates.length === 0) return [];

  const cached = buildRowMap(rows || []);
  const normalizedType = normalizeInstrumentType(instrumentType);
  const ignorePrefixUntilFirstCovered = !!options.ignorePrefixUntilFirstCovered;
  const extraCovered = options.extraCoveredDates || null;

  let startIndex = 0;
  if (ignorePrefixUntilFirstCovered) {
    const firstCoveredIndex = marketSessionDates.findIndex((date) => (
      cached.has(date) && hasRequiredProviderOhlcv(cached.get(date), normalizedType)
    ));

    // If no coverage exists yet, bootstrap with one full-range window.
    if (firstCoveredIndex < 0) {
      return [{ from: marketSessionDates[0], to: marketSessionDates[marketSessionDates.length - 1] }];
    }
    startIndex = firstCoveredIndex;
  }

  const windows = [];
  let windowStart = null;
  let previousDate = null;

  for (let i = startIndex; i < marketSessionDates.length; i += 1) {
    const date = marketSessionDates[i];
    const covered = (extraCovered && extraCovered.has(date))
      || (cached.has(date) && hasRequiredProviderOhlcv(cached.get(date), normalizedType));

    if (!covered) {
      if (!windowStart) windowStart = date;
      previousDate = date;
      continue;
    }

    if (windowStart) {
      windows.push({ from: windowStart, to: previousDate || windowStart });
      windowStart = null;
      previousDate = null;
    }
  }

  if (windowStart) {
    windows.push({ from: windowStart, to: previousDate || windowStart });
  }

  return windows;
}

function getHydrationMissingWindows(rows, marketSessionDates, instrumentType = null, extraCoveredDates = null) {
  if (!Array.isArray(marketSessionDates) || marketSessionDates.length === 0) return [];

  const normalizedType = normalizeInstrumentType(instrumentType);
  const sparseWindowTypes = new Set(['SGB', 'MUTUAL_FUND', 'NPS', 'FX']);
  const useSparseWindows = sparseWindowTypes.has(normalizedType);

  const sparseWindows = useSparseWindows
    ? getSparseMissingWindows(rows, marketSessionDates, normalizedType, {
      ignorePrefixUntilFirstCovered: normalizedType === 'SGB',
      extraCoveredDates,
    })
    : [];

  if (sparseWindows.length > 0) return sparseWindows;

  const missingStart = getSeriesMissingStartDate(rows, marketSessionDates, normalizedType, extraCoveredDates);
  if (!missingStart) return [];
  return [{ from: missingStart, to: marketSessionDates[marketSessionDates.length - 1] }];
}

function getFullSeries(instrumentType, symbol) {
  if (!instrumentType || !symbol) return [];
  const conn = getCacheDb();
  return conn.prepare(`
    SELECT date, open, high, low, close, adj_close, reverse_factor, split_history_json, volume, source
    FROM market_price_cache
    WHERE instrument_type = ?
      AND symbol = ?
    ORDER BY date ASC
  `).all(instrumentType, symbol);
}

async function hydrateStockSeriesForPhase2({
  investmentId = null,
  instrumentType,
  symbol,
  fromDate,
  toDate,
  fetchRange,
  mapFetchedRows = (rows) => rows,
  sourceLabel = null,
  onWarn = null,
  onInfo = null,
  freshnessSkipFromDate = null,
}) {
  if (!instrumentType || !symbol) return [];

  const start = normalizeDate(fromDate);
  const end = normalizeDate(toDate);
  if (!start || !end) return [];
  const normalizedFreshnessSkipFromDate = normalizeDate(freshnessSkipFromDate);

  const marketSessionDates = getMarketSessionDates(start, end, instrumentType);
  let splitEvents = [];
  let splitCheckFailed = false;
  let splitRebuildTriggered = false;
  if (isSplitSupportedInstrumentType(instrumentType)) {
    const splitResult = investmentId
      ? await loadMergedSplitEventsForInvestment(investmentId, instrumentType, symbol, { includeStatus: true })
      : await loadMergedSplitEventsForSymbol(instrumentType, symbol, { includeStatus: true });
    splitEvents = splitResult?.events || [];
    splitCheckFailed = !!splitResult?.failed;
    if (splitCheckFailed && typeof onWarn === 'function') {
      onWarn(`[MarketCache][SplitCheck] Split check failed for ${symbol}; continuing with cached split metadata`, {
        investmentId,
        instrumentType,
        symbol,
        fromDate: start,
        toDate: end,
      });
    }
  }

  if (isSplitSupportedInstrumentType(instrumentType) && !splitCheckFailed) {
    const fullCachedRows = getFullSeries(instrumentType, symbol).filter((row) => row.close != null);
    if (fullCachedRows.length > 0) {
      const adjustedRows = maybeReverseAdjustPointsWithEvents(
        instrumentType,
        fullCachedRows.map(normalizeCachePoint).filter(Boolean),
        splitEvents
      );
      if (needsReverseAdjustmentWrite(fullCachedRows, adjustedRows)) {
        upsertPriceSeries(instrumentType, symbol, adjustedRows, sourceLabel || null, investmentId);
        splitRebuildTriggered = true;
      }
    }

    if (splitRebuildTriggered && typeof onInfo === 'function') {
      onInfo(`[MarketCache][SplitCheck] Split change detected; rebuilt cached split adjustments for ${symbol}`, {
        investmentId,
        instrumentType,
        symbol,
        splitEvents: splitEvents.length,
      });
    }
  }

  let cachedRows = getSeries(instrumentType, symbol, start, end).filter((row) => row.close != null);
  const locfCoverableForFetch = getLocfCoverableSessionDates(cachedRows, marketSessionDates, instrumentType, normalizedFreshnessSkipFromDate || null);
  if (!hasCompleteCoverage(cachedRows, marketSessionDates, instrumentType, locfCoverableForFetch) && typeof fetchRange === 'function' && marketSessionDates.length > 0) {
    const missingStart = getSeriesMissingStartDate(cachedRows, marketSessionDates, instrumentType, locfCoverableForFetch);
    if (missingStart) {
      const suppressRecentMissing = !!(
        normalizedFreshnessSkipFromDate
        && missingStart >= normalizedFreshnessSkipFromDate
      );
      if (typeof onInfo === 'function') {
        if (suppressRecentMissing) {
          onInfo(
            `[MarketCache] Recent provider-lag window for investment ${investmentId ?? 'unknown'} from ${missingStart} to ${end}; skipping missing report`,
            {
              investmentId,
              fromDate: missingStart,
              toDate: end,
              freshnessSkipFromDate: normalizedFreshnessSkipFromDate,
            }
          );
        } else {
          onInfo(
            `[MarketCache] Missing cache for investment ${investmentId ?? 'unknown'} from ${missingStart} to ${end}`,
            {
              investmentId,
              fromDate: missingStart,
              toDate: end,
            }
          );
        }
      }

      const fetched = await fetchRange(missingStart, end);
      const normalizedFetched = mapFetchedRows(fetched)
        .map(normalizeCachePoint)
        .filter((point) => point && point.date >= missingStart && point.date <= end && point.close != null);

      if (normalizedFetched.length > 0) {
        upsertPriceSeries(instrumentType, symbol, normalizedFetched, sourceLabel || null, investmentId);
      }

      if (typeof onInfo === 'function') {
        if (!(suppressRecentMissing && normalizedFetched.length === 0)) {
          onInfo(
            `[MarketCache] Fetched ${normalizedFetched.length} points for investment ${investmentId ?? 'unknown'} from ${missingStart} to ${end}`,
            {
              investmentId,
              fromDate: missingStart,
              toDate: end,
              fetchedPoints: normalizedFetched.length,
            }
          );
        }
      }
    }
    cachedRows = getSeries(instrumentType, symbol, start, end).filter((row) => row.close != null);
  }

  if (isSplitSupportedInstrumentType(instrumentType) && !splitCheckFailed) {
    const adjustedCached = maybeReverseAdjustPointsWithEvents(
      instrumentType,
      cachedRows.map(normalizeCachePoint).filter(Boolean),
      splitEvents
    );
    if (needsReverseAdjustmentWrite(cachedRows, adjustedCached)) {
      upsertPriceSeries(instrumentType, symbol, adjustedCached, sourceLabel || null, investmentId);
      cachedRows = getSeries(instrumentType, symbol, start, end).filter((row) => row.close != null);
    }
  }

  // LOCF is no longer materialized into the market cache. Provider gaps are carried
  // forward at read time (nearest-on-or-before) when daily_values are computed.

  if (splitRebuildTriggered && typeof onInfo === 'function') {
    onInfo(`[MarketCache][SplitCheck] Completed split-triggered hydrate for ${symbol}`, {
      investmentId,
      instrumentType,
      symbol,
      fromDate: start,
      toDate: end,
      points: cachedRows.length,
    });
  }

  return cachedRows;
}

function buildLocfPoints(rows, marketSessionDates, instrumentType = null, locfCutoffDate = null, onSkip = null) {
  const cached = buildRowMap(rows);
  const providerBackedByDate = new Map();
  const dateToIndex = new Map();
  const hasLaterProviderByDate = new Map();
  const normalizedType = normalizeInstrumentType(instrumentType);

  // Calculate cutoff: yesterday to avoid filling today/future dates
  let cutoff = locfCutoffDate;
  if (!cutoff) {
    const yesterday = new Date(new Date().toISOString().split('T')[0]);
    yesterday.setDate(yesterday.getDate() - 1);
    cutoff = yesterday.toISOString().split('T')[0];
  }

  const isProviderBackedRow = (row) => String(row?.source || '').toUpperCase() !== 'LOCF';
  for (const row of rows || []) {
    if (!row?.date || row.close == null) continue;
    if (isProviderBackedRow(row)) providerBackedByDate.set(row.date, row);
  }

  for (let i = 0; i < marketSessionDates.length; i += 1) {
    dateToIndex.set(marketSessionDates[i], i);
  }

  let seenLaterProvider = false;
  for (let i = marketSessionDates.length - 1; i >= 0; i -= 1) {
    const date = marketSessionDates[i];
    hasLaterProviderByDate.set(date, seenLaterProvider);
    if (providerBackedByDate.has(date)) seenLaterProvider = true;
  }

  const hasAnyLowVolumeInWindow = (date) => {
    if (normalizedType === 'FX') return true;

    const idx = dateToIndex.get(date);
    if (idx == null) return false;
    const start = Math.max(0, idx - LOCF_WINDOW_SESSIONS);
    const end = Math.min(marketSessionDates.length - 1, idx + LOCF_WINDOW_SESSIONS);

    for (let i = start; i <= end; i += 1) {
      const d = marketSessionDates[i];
      const row = providerBackedByDate.get(d);
      if (!row) continue;
      const v = Number(row.volume);
      if (!Number.isFinite(v) || v < 0) continue;
      if (v <= LOCF_VOLUME_THRESHOLD) return true;
    }
    return false;
  };

  const locf = [];
  let lastKnown = null;
  const skippedDates = [];

  for (const date of marketSessionDates) {
    const row = cached.get(date);
    const providerRow = providerBackedByDate.get(date);
    if (providerRow && providerRow.close != null) {
      lastKnown = providerRow;
      continue;
    }

    if (row && row.close != null) {
      continue;
    }

    // Skip LOCF for recent dates (today and later)
    if (date >= cutoff) {
      skippedDates.push(date);
      continue;
    }

    if (!lastKnown || lastKnown.close == null) continue;
    if (!hasLaterProviderByDate.get(date)) continue;
    if (!hasAnyLowVolumeInWindow(date)) continue;

    if (lastKnown.close != null) {
      locf.push({
        date,
        close: Number(lastKnown.close),
        adjClose: Number(lastKnown.close),
        source: 'LOCF',
      });
    }
  }

  // Log skipped recent dates
  if (skippedDates.length > 0 && typeof onSkip === 'function') {
    onSkip(`Skipped LOCF fill for recent dates (>= ${cutoff})`, { dates: skippedDates });
  }

  return locf;
}

function buildShortContiguousLocfPoints(rows, marketSessionDates, options = {}) {
  const maxGapSessions = Math.max(1, Number(options.maxGapSessions) || CONTIGUOUS_MISSING_LOCF_MAX_SESSIONS);
  const cached = buildRowMap(rows);
  const providerBackedByDate = new Map();
  const hasLaterProviderByDate = new Map();

  const dateToIndex = new Map();
  for (let i = 0; i < marketSessionDates.length; i += 1) {
    dateToIndex.set(marketSessionDates[i], i);
  }

  const isProviderBackedRow = (row) => String(row?.source || '').toUpperCase() !== 'LOCF';
  for (const row of rows || []) {
    if (!row?.date || row.close == null) continue;
    if (isProviderBackedRow(row)) providerBackedByDate.set(row.date, row);
  }

  let seenLaterProvider = false;
  for (let i = marketSessionDates.length - 1; i >= 0; i -= 1) {
    const date = marketSessionDates[i];
    hasLaterProviderByDate.set(date, seenLaterProvider);
    if (providerBackedByDate.has(date)) seenLaterProvider = true;
  }

  let cutoff = options.locfCutoffDate;
  if (!cutoff) {
    const yesterday = new Date(new Date().toISOString().split('T')[0]);
    yesterday.setDate(yesterday.getDate() - 1);
    cutoff = yesterday.toISOString().split('T')[0];
  }

  const segments = [];
  let active = null;
  for (const date of marketSessionDates) {
    const row = cached.get(date);
    if (row && row.close != null) {
      active = null;
      continue;
    }
    if (!active) {
      active = [];
      segments.push(active);
    }
    active.push(date);
  }

  const locf = [];
  let filledSegments = 0;
  let unfilledShortSegments = 0;

  for (const segment of segments) {
    if (!segment.length || segment.length > maxGapSessions) continue;

    if (segment.some((d) => d >= cutoff)) {
      unfilledShortSegments += 1;
      continue;
    }

    const segmentEndDate = segment[segment.length - 1];
    if (!hasLaterProviderByDate.get(segmentEndDate)) {
      unfilledShortSegments += 1;
      continue;
    }

    const firstIdx = dateToIndex.get(segment[0]);
    if (!(Number.isInteger(firstIdx) && firstIdx > 0)) {
      unfilledShortSegments += 1;
      continue;
    }

    let anchorClose = null;
    for (let i = firstIdx - 1; i >= 0; i -= 1) {
      const prevDate = marketSessionDates[i];
      const prevRow = providerBackedByDate.get(prevDate);
      const prevClose = Number(prevRow?.close);
      if (Number.isFinite(prevClose) && prevClose > 0) {
        anchorClose = prevClose;
        break;
      }
    }

    if (!(Number.isFinite(anchorClose) && anchorClose > 0)) {
      unfilledShortSegments += 1;
      continue;
    }

    for (const date of segment) {
      const existing = cached.get(date);
      if (existing && existing.close != null) continue;
      const point = {
        date,
        close: anchorClose,
        adjClose: anchorClose,
        source: 'LOCF',
      };
      cached.set(date, point);
      locf.push(point);
    }
    filledSegments += 1;
  }

  return {
    points: locf,
    filledSessions: locf.length,
    filledSegments,
    unfilledShortSegments,
  };
}

// Returns the set of session dates that LOCF (last-observation-carried-forward) would
// cover for a provider series, WITHOUT materializing any rows in the cache tables. Used
// to compute provider-fetch windows and to suppress sparse-coverage warnings for gaps
// that are expected to be carried forward at read time. Combines short contiguous gaps
// (<= CONTIGUOUS_MISSING_LOCF_MAX_SESSIONS) and longer volume-gated gaps.
function getLocfCoverableSessionDates(rows, marketSessionDates, instrumentType = null, locfCutoffDate = null) {
  const covered = new Set();
  if (!Array.isArray(marketSessionDates) || marketSessionDates.length === 0) return covered;

  const shortGap = buildShortContiguousLocfPoints(rows, marketSessionDates, {
    maxGapSessions: CONTIGUOUS_MISSING_LOCF_MAX_SESSIONS,
    locfCutoffDate,
  });
  for (const point of shortGap.points) {
    if (point?.date) covered.add(point.date);
  }

  const longGap = buildLocfPoints(rows, marketSessionDates, instrumentType, locfCutoffDate);
  for (const point of longGap) {
    if (point?.date) covered.add(point.date);
  }

  return covered;
}

function nearlyEqual(a, b, epsilon = 1e-6) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Math.abs(Number(a) - Number(b)) <= epsilon;
}

function needsReverseAdjustmentWrite(currentRows, adjustedRows) {
  if (!Array.isArray(currentRows) || !Array.isArray(adjustedRows)) return false;
  if (currentRows.length !== adjustedRows.length) return true;

  const byDate = new Map();
  for (const row of currentRows) {
    if (row?.date) byDate.set(row.date, row);
  }

  for (const row of adjustedRows) {
    const cur = byDate.get(row?.date);
    if (!cur) return true;

    if (!nearlyEqual(cur.close, row.close)) return true;
    if (!nearlyEqual(cur.open, row.open)) return true;
    if (!nearlyEqual(cur.high, row.high)) return true;
    if (!nearlyEqual(cur.low, row.low)) return true;
    if (!nearlyEqual(cur.adj_close ?? cur.adjClose, row.adjClose)) return true;
    if (!nearlyEqual(cur.reverse_factor ?? cur.reverseFactor, row.reverseFactor)) return true;

  }

  return false;
}

async function hydrateHistoricalPriceSeries({
  instrumentType,
  symbol,
  fromDate,
  toDate,
  fetchRange,
  mapFetchedRows = (rows) => rows,
  sourceLabel = null,
  onInfo = null,
  contextMeta = null,
  freshnessSkipFromDate = null,
}) {
  if (!instrumentType || !symbol) return [];

  const start = normalizeDate(fromDate);
  const end = normalizeDate(toDate);
  if (!start || !end) return [];
  const normalizedFreshnessSkipFromDate = normalizeDate(freshnessSkipFromDate);
  const allowProviderCalendarOverflow = instrumentType === 'MUTUAL_FUND' || instrumentType === 'NPS';

  const marketSessionDates = getMarketSessionDates(start, end, instrumentType);
  const contextInvestmentId = Number.isFinite(Number(contextMeta?.investmentId))
    ? Number(contextMeta.investmentId)
    : null;
  let cachedRows = getSeries(instrumentType, symbol, start, end).filter((row) => row.close != null);
  const splitEvents = isSplitSupportedInstrumentType(instrumentType)
    ? await loadMergedSplitEventsForSymbol(instrumentType, symbol)
    : [];

  if (isSplitSupportedInstrumentType(instrumentType) && cachedRows.length > 0) {
    const normalizedCached = cachedRows.map(normalizeCachePoint).filter(Boolean);
    const adjustedCached = maybeReverseAdjustPointsWithEvents(instrumentType, normalizedCached, splitEvents);
    if (needsReverseAdjustmentWrite(cachedRows, adjustedCached)) {
      upsertPriceSeries(instrumentType, symbol, adjustedCached, sourceLabel || null, contextInvestmentId);
      cachedRows = getSeries(instrumentType, symbol, start, end).filter((row) => row.close != null);
    }
  }

  const locfCoverableForFetch = getLocfCoverableSessionDates(cachedRows, marketSessionDates, instrumentType, normalizedFreshnessSkipFromDate || null);
  if (hasCompleteCoverage(cachedRows, marketSessionDates, instrumentType, locfCoverableForFetch)) {
    return cachedRows;
  }

  if (typeof fetchRange === 'function' && marketSessionDates.length > 0) {
    const windows = getHydrationMissingWindows(cachedRows, marketSessionDates, instrumentType, locfCoverableForFetch);

    if (windows.length > 0) {
      let totalFetchedPoints = 0;
      let totalProcessedWindows = 0;
      let totalSuppressedRecentWindows = 0;
      for (const window of windows) {
        if (!window?.from || !window?.to) continue;
        totalProcessedWindows += 1;

        const suppressRecentMissing = !!(
          normalizedFreshnessSkipFromDate
          && window.from >= normalizedFreshnessSkipFromDate
        );

        if (typeof onInfo === 'function') {
          const investmentIdFromMeta = contextMeta?.investmentId ?? null;
          if (!suppressRecentMissing) {
            onInfo(
              `[MarketCache] Missing cache for investment ${investmentIdFromMeta ?? 'unknown'} from ${window.from} to ${window.to}`,
              {
                investmentId: investmentIdFromMeta,
                fromDate: window.from,
                toDate: window.to,
              }
            );
          }
        }

        const fetched = await fetchRange(window.from, window.to);
        const normalizedFetched = mapFetchedRows(fetched)
          .map(normalizeCachePoint)
          .filter((point) => {
            if (!point || point.close == null) return false;
            if (point.date < window.from) return false;
            const windowUpperBound = allowProviderCalendarOverflow ? end : window.to;
            return point.date <= windowUpperBound;
          });

        totalFetchedPoints += normalizedFetched.length;
        if (suppressRecentMissing && normalizedFetched.length === 0) {
          totalSuppressedRecentWindows += 1;
        }

        if (normalizedFetched.length > 0) {
          upsertPriceSeries(instrumentType, symbol, normalizedFetched, sourceLabel || null, contextInvestmentId);
          if (isSplitSupportedInstrumentType(instrumentType) && splitEvents.length > 0) {
            const newlyFetched = getSeries(instrumentType, symbol, window.from, window.to).filter((row) => row.close != null);
            const adjustedFetched = maybeReverseAdjustPointsWithEvents(
              instrumentType,
              newlyFetched.map(normalizeCachePoint).filter(Boolean),
              splitEvents
            );
            if (needsReverseAdjustmentWrite(newlyFetched, adjustedFetched)) {
              upsertPriceSeries(instrumentType, symbol, adjustedFetched, sourceLabel || null, contextInvestmentId);
            }
          }
        }
      }

      if (typeof onInfo === 'function') {
        const investmentIdFromMeta = contextMeta?.investmentId ?? null;
        if (!(
          totalProcessedWindows > 0
          && totalSuppressedRecentWindows === totalProcessedWindows
          && totalFetchedPoints === 0
        )) {
          onInfo(
            `[MarketCache] Fetched ${totalFetchedPoints} points for investment ${investmentIdFromMeta ?? 'unknown'} from ${start} to ${end}`,
            {
              investmentId: investmentIdFromMeta,
              fromDate: start,
              toDate: end,
              fetchedPoints: totalFetchedPoints,
            }
          );
        }
      }
    }
  }

  // LOCF is no longer materialized into the price cache. Provider gaps are carried
  // forward at read time (nearest-on-or-before) when daily_values are computed.
  return getSeries(instrumentType, symbol, start, end).filter((row) => row.close != null);
}

function upsertPricePoint(point) {
  if (!point || !point.instrumentType || !point.symbol || !point.date) return;
  // Persist LOCF only for FX; other instruments derive LOCF at read time.
  if (
    String(point.source ?? '').toUpperCase() === 'LOCF'
    && !isFxInstrumentType(point.instrumentType)
  ) return;
  const conn = getCacheDb();
  const normalizedDate = normalizeDate(point.date);
  if (!normalizedDate) return;
  if (isFxInstrumentType(point.instrumentType)) {
    const rate = Number(point.close);
    if (!Number.isFinite(rate) || rate <= 0) return;
    const existingFx = ENABLE_CACHE_WRITE_AUDIT
      ? conn.prepare('SELECT rate, source FROM fx_rate_cache WHERE date = ? LIMIT 1').get(normalizedDate)
      : null;
    conn.prepare(`
      INSERT INTO fx_rate_cache (date, rate, source, fetched_at, updated_at)
      VALUES (?, ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(date) DO UPDATE SET
        rate = COALESCE(excluded.rate, fx_rate_cache.rate),
        source = COALESCE(excluded.source, fx_rate_cache.source),
        updated_at = datetime('now')
    `).run(
      normalizedDate,
      rate,
      point.source ?? null
    );
    emitCacheWriteAudit('fxc.write', {
      action: existingFx ? 'update' : 'insert',
      date: normalizedDate,
      rate,
      source: point.source ?? null,
      previousSource: existingFx?.source || null,
      previousRate: existingFx?.rate == null ? null : Number(existingFx.rate),
      phase: 'market_cache',
    });
    return;
  }
  const resolvedAdjClose = isStockInstrumentType(point.instrumentType)
    ? (point.adjClose ?? point.close ?? null)
    : (point.adjClose ?? null);
  const splitHistoryValue = isSplitSupportedInstrumentType(point.instrumentType)
    ? null
    : (point.splitHistoryJson ?? null);

  const existingMarket = ENABLE_CACHE_WRITE_AUDIT
    ? conn.prepare(
      'SELECT investment_id, close, source FROM market_price_cache WHERE instrument_type = ? AND symbol = ? AND date = ? LIMIT 1'
    ).get(point.instrumentType, point.symbol, normalizedDate)
    : null;

  conn.prepare(`
    INSERT INTO market_price_cache (
      instrument_type, symbol, date, open, high, low, close, adj_close, reverse_factor, split_history_json, volume, source, fetched_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(instrument_type, symbol, date) DO UPDATE SET
      open = COALESCE(excluded.open, market_price_cache.open),
      high = COALESCE(excluded.high, market_price_cache.high),
      low = COALESCE(excluded.low, market_price_cache.low),
      close = COALESCE(excluded.close, market_price_cache.close),
      adj_close = COALESCE(excluded.adj_close, market_price_cache.adj_close),
      reverse_factor = COALESCE(excluded.reverse_factor, market_price_cache.reverse_factor),
      split_history_json = excluded.split_history_json,
      volume = COALESCE(excluded.volume, market_price_cache.volume),
      source = COALESCE(excluded.source, market_price_cache.source),
      updated_at = datetime('now')
  `).run(
    point.instrumentType,
    point.symbol,
    normalizedDate,
    point.open ?? null,
    point.high ?? null,
    point.low ?? null,
    point.close ?? null,
    resolvedAdjClose,
    point.reverseFactor ?? 1,
    splitHistoryValue,
    point.volume ?? null,
    point.source ?? null
  );

  emitCacheWriteAudit('mpc.write', {
    action: existingMarket ? 'update' : 'insert',
    investmentId: existingMarket?.investment_id ?? null,
    instrumentType: point.instrumentType,
    symbol: point.symbol,
    date: normalizedDate,
    close: point.close ?? null,
    volume: point.volume ?? null,
    source: point.source ?? null,
    previousSource: existingMarket?.source || null,
    previousClose: existingMarket?.close == null ? null : Number(existingMarket.close),
    phase: 'market_cache',
  });
}

function upsertPriceSeries(instrumentType, symbol, points, source = null, investmentId = null) {
  if (!instrumentType || !symbol || !Array.isArray(points) || points.length === 0) return;
  const conn = getCacheDb();
  // Persist LOCF only for FX; other instruments keep LOCF as read-time behavior.
  const providerPoints = isFxInstrumentType(instrumentType)
    ? points
    : points.filter((p) => String(p?.source ?? source ?? '').toUpperCase() !== 'LOCF');
  if (providerPoints.length === 0) return;
  const normalizedPoints = providerPoints.map(normalizeCachePoint).filter(Boolean);
  if (isFxInstrumentType(instrumentType)) {
    const stmtFx = conn.prepare(`
      INSERT INTO fx_rate_cache (date, rate, source, fetched_at, updated_at)
      VALUES (?, ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(date) DO UPDATE SET
        rate = COALESCE(excluded.rate, fx_rate_cache.rate),
        source = COALESCE(excluded.source, fx_rate_cache.source),
        updated_at = datetime('now')
    `);
    const txFx = conn.transaction((rows) => {
      const selectFx = ENABLE_CACHE_WRITE_AUDIT
        ? conn.prepare('SELECT rate, source FROM fx_rate_cache WHERE date = ? LIMIT 1')
        : null;
      for (const p of rows) {
        const d = normalizeDate(p.date);
        const rate = Number(p.close);
        if (!d || !Number.isFinite(rate) || rate <= 0) continue;
        const existingFx = selectFx ? selectFx.get(d) : null;
        stmtFx.run(d, rate, p.source ?? source ?? null);
        emitCacheWriteAudit('fxc.write', {
          action: existingFx ? 'update' : 'insert',
          date: d,
          rate,
          source: p.source ?? source ?? null,
          previousSource: existingFx?.source || null,
          previousRate: existingFx?.rate == null ? null : Number(existingFx.rate),
          phase: 'market_cache',
        });
      }
    });

    txFx(normalizedPoints);
    return;
  }
  const shouldAutofillAdjClose = isStockInstrumentType(instrumentType);
  const splitHistoryValueForRows = isSplitSupportedInstrumentType(instrumentType) ? null : undefined;
  const invId = investmentId != null ? Number(investmentId) : null;
  const stmt = conn.prepare(`
    INSERT INTO market_price_cache (
      investment_id, instrument_type, symbol, date, open, high, low, close, adj_close, reverse_factor, split_history_json, volume, source, fetched_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(instrument_type, symbol, date) DO UPDATE SET
      investment_id = COALESCE(excluded.investment_id, market_price_cache.investment_id),
      open = COALESCE(excluded.open, market_price_cache.open),
      high = COALESCE(excluded.high, market_price_cache.high),
      low = COALESCE(excluded.low, market_price_cache.low),
      close = COALESCE(excluded.close, market_price_cache.close),
      adj_close = COALESCE(excluded.adj_close, market_price_cache.adj_close),
      reverse_factor = COALESCE(excluded.reverse_factor, market_price_cache.reverse_factor),
      split_history_json = excluded.split_history_json,
      volume = COALESCE(excluded.volume, market_price_cache.volume),
      source = COALESCE(excluded.source, market_price_cache.source),
      updated_at = datetime('now')
  `);

  const tx = conn.transaction((rows) => {
    const selectMarket = ENABLE_CACHE_WRITE_AUDIT
      ? conn.prepare(
        'SELECT investment_id, close, source FROM market_price_cache WHERE instrument_type = ? AND symbol = ? AND date = ? LIMIT 1'
      )
      : null;
    for (const p of rows) {
      const d = normalizeDate(p.date);
      if (!d) continue;
      const existingMarket = selectMarket ? selectMarket.get(instrumentType, symbol, d) : null;
      stmt.run(
        invId,
        instrumentType,
        symbol,
        d,
        p.open ?? null,
        p.high ?? null,
        p.low ?? null,
        p.close ?? null,
        shouldAutofillAdjClose ? (p.adjClose ?? p.close ?? null) : (p.adjClose ?? null),
        p.reverseFactor ?? 1,
        splitHistoryValueForRows === null ? null : (p.splitHistoryJson ?? null),
        p.volume ?? null,
        p.source ?? source ?? null
      );
      emitCacheWriteAudit('mpc.write', {
        action: existingMarket ? 'update' : 'insert',
        investmentId: invId ?? existingMarket?.investment_id ?? null,
        instrumentType,
        symbol,
        date: d,
        close: p.close ?? null,
        volume: p.volume ?? null,
        source: p.source ?? source ?? null,
        previousSource: existingMarket?.source || null,
        previousClose: existingMarket?.close == null ? null : Number(existingMarket.close),
        phase: 'market_cache',
      });
    }
  });

  tx(normalizedPoints);
}

function getSeries(instrumentType, symbol, fromDate, toDate) {
  if (!instrumentType || !symbol) return [];
  const conn = getCacheDb();
  if (isFxInstrumentType(instrumentType)) {
    return conn.prepare(`
      SELECT date, NULL AS open, NULL AS high, NULL AS low, rate AS close, NULL AS adj_close, 1 AS reverse_factor, NULL AS split_history_json, NULL AS volume, source
      FROM fx_rate_cache
      WHERE date >= ?
        AND date <= ?
      ORDER BY date ASC
    `).all(normalizeDate(fromDate), normalizeDate(toDate));
  }
  return conn.prepare(`
    SELECT date, open, high, low, close, adj_close, reverse_factor, split_history_json, volume, source
    FROM market_price_cache
    WHERE instrument_type = ?
      AND symbol = ?
      AND date >= ?
      AND date <= ?
    ORDER BY date ASC
  `).all(instrumentType, symbol, normalizeDate(fromDate), normalizeDate(toDate));
}

function getNearestOnOrBefore(instrumentType, symbol, date) {
  if (!instrumentType || !symbol || !date) return null;
  const conn = getCacheDb();
  if (isFxInstrumentType(instrumentType)) {
    return conn.prepare(`
      SELECT date, NULL AS open, NULL AS high, NULL AS low, rate AS close, NULL AS adj_close, NULL AS volume, source
      FROM fx_rate_cache
      WHERE date <= ?
      ORDER BY date DESC
      LIMIT 1
    `).get(normalizeDate(date));
  }
  return conn.prepare(`
    SELECT date, open, high, low, close, adj_close, volume, source
    FROM market_price_cache
    WHERE instrument_type = ?
      AND symbol = ?
      AND date <= ?
    ORDER BY date DESC
    LIMIT 1
  `).get(instrumentType, symbol, normalizeDate(date));
}

function upsertInvestmentPriceSeries(investmentId, instrumentType, providerSymbol, points, source = null) {
  if (!investmentId || !instrumentType || !Array.isArray(points) || points.length === 0) return;
  const conn = getCacheDb();
  const investmentSymbol = String(providerSymbol || '').trim();
  if (!investmentSymbol) return;
  // Investment-level series writes target market_price_cache; keep LOCF non-persistent.
  const providerPoints = points.filter((p) => String(p?.source ?? source ?? '').toUpperCase() !== 'LOCF');
  if (!providerPoints.length) return;
  const normalizedPoints = providerPoints.map(normalizeCachePoint).filter(Boolean);
  if (!normalizedPoints.length) return;

  const stmt = conn.prepare(`
    INSERT INTO market_price_cache (
      investment_id, instrument_type, symbol, date, open, high, low, close, adj_close, reverse_factor, split_history_json, volume, source, fetched_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(instrument_type, symbol, date) DO UPDATE SET
      investment_id = COALESCE(excluded.investment_id, market_price_cache.investment_id),
      instrument_type = COALESCE(excluded.instrument_type, market_price_cache.instrument_type),
      symbol = COALESCE(excluded.symbol, market_price_cache.symbol),
      open = COALESCE(excluded.open, market_price_cache.open),
      high = COALESCE(excluded.high, market_price_cache.high),
      low = COALESCE(excluded.low, market_price_cache.low),
      close = COALESCE(excluded.close, market_price_cache.close),
      adj_close = COALESCE(excluded.adj_close, market_price_cache.adj_close),
      volume = COALESCE(excluded.volume, market_price_cache.volume),
      source = COALESCE(excluded.source, market_price_cache.source),
      updated_at = datetime('now')
  `);

  const tx = conn.transaction((rows) => {
    const selectMarket = ENABLE_CACHE_WRITE_AUDIT
      ? conn.prepare(
        'SELECT investment_id, close, source FROM market_price_cache WHERE instrument_type = ? AND symbol = ? AND date = ? LIMIT 1'
      )
      : null;
    for (const p of rows) {
      const d = normalizeDate(p.date);
      if (!d) continue;
      const existingMarket = selectMarket ? selectMarket.get(String(instrumentType || '').toUpperCase(), investmentSymbol, d) : null;
      stmt.run(
        Number(investmentId),
        String(instrumentType || '').toUpperCase(),
        investmentSymbol,
        d,
        p.open ?? null,
        p.high ?? null,
        p.low ?? null,
        p.close ?? null,
        isStockInstrumentType(instrumentType) ? (p.adjClose ?? p.close ?? null) : (p.adjClose ?? null),
        p.volume ?? null,
        p.source ?? source ?? null
      );
      emitCacheWriteAudit('mpc.write', {
        action: existingMarket ? 'update' : 'insert',
        investmentId: Number(investmentId),
        instrumentType: String(instrumentType || '').toUpperCase(),
        symbol: investmentSymbol,
        date: d,
        close: p.close ?? null,
        volume: p.volume ?? null,
        source: p.source ?? source ?? null,
        previousSource: existingMarket?.source || null,
        previousClose: existingMarket?.close == null ? null : Number(existingMarket.close),
        phase: 'market_cache',
      });
    }
  });

  tx(normalizedPoints);

}

function getInvestmentSeries(investmentId, fromDate, toDate) {
  if (!investmentId || !fromDate || !toDate) return [];
  const conn = getCacheDb();
  return conn.prepare(`
    SELECT date, open, high, low, close, adj_close, volume, source, instrument_type, symbol
    FROM market_price_cache
    WHERE investment_id = ?
      AND date >= ?
      AND date <= ?
    ORDER BY date ASC
  `).all(Number(investmentId), normalizeDate(fromDate), normalizeDate(toDate));
}

function getInvestmentNearestOnOrBefore(investmentId, date) {
  if (!investmentId || !date) return null;
  const conn = getCacheDb();
  return conn.prepare(`
    SELECT date, open, high, low, close, adj_close, volume, source, instrument_type, symbol
    FROM market_price_cache
    WHERE investment_id = ?
      AND date <= ?
    ORDER BY date DESC
    LIMIT 1
  `).get(Number(investmentId), normalizeDate(date));
}

module.exports = {
  upsertPricePoint,
  upsertPriceSeries,
  upsertInvestmentPriceSeries,
  getSeries,
  getInvestmentSeries,
  getNearestOnOrBefore,
  getInvestmentNearestOnOrBefore,
  getMarketSessionDates,
  getSeriesMissingStartDate,
  getLocfCoverableSessionDates,
  hydrateHistoricalPriceSeries,
  hydrateStockSeriesForPhase2,
};
