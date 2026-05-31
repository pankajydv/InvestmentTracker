const { getDb } = require('../db/schema');
const { getMarketHolidays, getWeekends } = require('./holidays/marketHolidayService');
const https = require('https');

let db = null;
let schemaEnsured = false;
const closedDaysByYear = new Map();
const splitEventCache = new Map();
const SPLIT_EVENT_CACHE_TTL_MS = 10 * 60 * 1000;
const LOCF_VOLUME_THRESHOLD = 10_000;
const LOCF_WINDOW_SESSIONS = 20;
const INVESTMENT_CACHE_MIGRATION_KEY = 'market_price_cache_unified_v3_symbol_is_provider_migrated';

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

  conn.exec(`
    DROP INDEX IF EXISTS uq_market_price_cache_investment_date;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_market_price_cache_investment_date
      ON market_price_cache(investment_id, date);
  `);

  schemaEnsured = true;
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

function normalizeDate(date) {
  if (!date) return null;
  return String(date).split('T')[0];
}

function getInvestmentExitCapDate(conn, investmentId) {
  const invId = Number(investmentId);
  if (!Number.isInteger(invId) || invId <= 0) return null;

  const row = conn.prepare(`
    SELECT
      MAX(date(transaction_date)) AS max_txn_date,
      COALESCE(SUM(
        CASE
          WHEN transaction_type IN ('BUY', 'DEPOSIT', 'BONUS', 'SPLIT', 'IPO', 'TRANSFER_IN', 'SWITCH_IN', 'RIGHTS', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'VEST', 'ESPP_PURCHASE') THEN COALESCE(units, 0)
          WHEN transaction_type IN ('SELL', 'REDEMPTION', 'WITHDRAWAL', 'TRANSFER_OUT', 'SWITCH_OUT', 'CONSOLIDATION', 'CHARGES', 'AMC') THEN -COALESCE(units, 0)
          ELSE 0
        END
      ), 0) AS net_units
    FROM transactions
    WHERE investment_id = ?
  `).get(invId);

  const maxTxnDate = normalizeDate(row?.max_txn_date);
  const netUnits = Number(row?.net_units || 0);
  if (!maxTxnDate) return null;
  return netUnits <= 0 ? maxTxnDate : null;
}

function getMarketClosedDaysForYear(year) {
  if (closedDaysByYear.has(year)) return closedDaysByYear.get(year);
  const holidays = getMarketHolidays(year).map((row) => row.date);
  const weekends = getWeekends(year).map((row) => row.date);
  const closed = new Set([...holidays, ...weekends]);
  closedDaysByYear.set(year, closed);
  return closed;
}

function isMarketSessionDate(date) {
  const iso = normalizeDate(date);
  if (!iso) return false;
  const d = new Date(`${iso}T00:00:00.000Z`);
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  return !getMarketClosedDaysForYear(d.getUTCFullYear()).has(iso);
}

function getMarketSessionDates(fromDate, toDate) {
  const start = normalizeDate(fromDate);
  const end = normalizeDate(toDate);
  if (!start || !end) return [];

  const dates = [];
  let cursor = new Date(`${start}T00:00:00.000Z`);
  const stop = new Date(`${end}T00:00:00.000Z`);
  while (cursor <= stop) {
    const iso = cursor.toISOString().split('T')[0];
    if (isMarketSessionDate(iso)) dates.push(iso);
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
  } catch (_) {
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
  } catch (_) {
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
        } catch (_) {
          resolve(includeStatus ? { rows: [], failed: true } : []);
        }
      });
      res.on('error', () => resolve(includeStatus ? { rows: [], failed: true } : []));
    }).on('error', () => resolve(includeStatus ? { rows: [], failed: true } : []));
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

function hasCompleteCoverage(cachedRows, marketSessionDates) {
  if (!marketSessionDates.length) return true;
  const cached = buildRowMap(cachedRows);
  return marketSessionDates.every((date) => cached.has(date) && cached.get(date)?.close != null);
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
    } catch (_) {
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

function getSeriesMissingStartDate(rows, marketSessionDates) {
  if (!Array.isArray(marketSessionDates) || marketSessionDates.length === 0) return null;
  const cached = buildRowMap(rows || []);
  return marketSessionDates.find((date) => !cached.has(date) || cached.get(date)?.close == null) || null;
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
}) {
  if (!instrumentType || !symbol) return [];

  const start = normalizeDate(fromDate);
  const end = normalizeDate(toDate);
  if (!start || !end) return [];

  const marketSessionDates = getMarketSessionDates(start, end);
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
        upsertPriceSeries(instrumentType, symbol, adjustedRows, sourceLabel || null);
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
  if (!hasCompleteCoverage(cachedRows, marketSessionDates) && typeof fetchRange === 'function' && marketSessionDates.length > 0) {
    const missingStart = getSeriesMissingStartDate(cachedRows, marketSessionDates);
    if (missingStart) {
      const fetched = await fetchRange(missingStart, end);
      const normalizedFetched = mapFetchedRows(fetched)
        .map(normalizeCachePoint)
        .filter((point) => point && point.date >= missingStart && point.date <= end && point.close != null);

      if (normalizedFetched.length > 0) {
        upsertPriceSeries(instrumentType, symbol, normalizedFetched, sourceLabel || null);
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
      upsertPriceSeries(instrumentType, symbol, adjustedCached, sourceLabel || null);
      cachedRows = getSeries(instrumentType, symbol, start, end).filter((row) => row.close != null);
    }
  }

  const locfPoints = buildLocfPoints(cachedRows, marketSessionDates);
  if (locfPoints.length > 0) {
    upsertPriceSeries(instrumentType, symbol, locfPoints, 'LOCF');
    cachedRows = getSeries(instrumentType, symbol, start, end).filter((row) => row.close != null);
  }

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

function buildLocfPoints(rows, marketSessionDates) {
  const cached = buildRowMap(rows);
  const providerBackedByDate = new Map();
  const dateToIndex = new Map();
  const hasLaterProviderByDate = new Map();

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

  return locf;
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
}) {
  if (!instrumentType || !symbol) return [];

  const start = normalizeDate(fromDate);
  const end = normalizeDate(toDate);
  if (!start || !end) return [];

  const marketSessionDates = getMarketSessionDates(start, end);
  let cachedRows = getSeries(instrumentType, symbol, start, end).filter((row) => row.close != null);
  const splitEvents = isSplitSupportedInstrumentType(instrumentType)
    ? await loadMergedSplitEventsForSymbol(instrumentType, symbol)
    : [];

  if (isSplitSupportedInstrumentType(instrumentType) && cachedRows.length > 0) {
    const normalizedCached = cachedRows.map(normalizeCachePoint).filter(Boolean);
    const adjustedCached = maybeReverseAdjustPointsWithEvents(instrumentType, normalizedCached, splitEvents);
    if (needsReverseAdjustmentWrite(cachedRows, adjustedCached)) {
      upsertPriceSeries(instrumentType, symbol, adjustedCached, sourceLabel || null);
      cachedRows = getSeries(instrumentType, symbol, start, end).filter((row) => row.close != null);
    }
  }

  if (hasCompleteCoverage(cachedRows, marketSessionDates)) {
    return cachedRows;
  }

  if (typeof fetchRange === 'function' && marketSessionDates.length > 0) {
    const cached = buildRowMap(cachedRows);
    const missingStart = marketSessionDates.find((date) => !cached.has(date) || cached.get(date)?.close == null);
    if (missingStart) {
      const fetched = await fetchRange(missingStart, end);
      const normalizedFetched = mapFetchedRows(fetched)
        .map(normalizeCachePoint)
        .filter((point) => point && point.date >= missingStart && point.date <= end && point.close != null);

      if (normalizedFetched.length > 0) {
        upsertPriceSeries(instrumentType, symbol, normalizedFetched, sourceLabel || null);
        if (isSplitSupportedInstrumentType(instrumentType) && splitEvents.length > 0) {
          const newlyFetched = getSeries(instrumentType, symbol, missingStart, end).filter((row) => row.close != null);
          const adjustedFetched = maybeReverseAdjustPointsWithEvents(
            instrumentType,
            newlyFetched.map(normalizeCachePoint).filter(Boolean),
            splitEvents
          );
          if (needsReverseAdjustmentWrite(newlyFetched, adjustedFetched)) {
            upsertPriceSeries(instrumentType, symbol, adjustedFetched, sourceLabel || null);
          }
        }
      }
    }
  }

  const refreshed = getSeries(instrumentType, symbol, start, end).filter((row) => row.close != null);
  const locfPoints = buildLocfPoints(refreshed, marketSessionDates);
  if (locfPoints.length > 0) {
    upsertPriceSeries(instrumentType, symbol, locfPoints, 'LOCF');
  }

  return getSeries(instrumentType, symbol, start, end).filter((row) => row.close != null);
}

function upsertPricePoint(point) {
  if (!point || !point.instrumentType || !point.symbol || !point.date) return;
  const conn = getCacheDb();
  const normalizedDate = normalizeDate(point.date);
  if (!normalizedDate) return;
  const resolvedAdjClose = isStockInstrumentType(point.instrumentType)
    ? (point.adjClose ?? point.close ?? null)
    : (point.adjClose ?? null);
  const splitHistoryValue = isSplitSupportedInstrumentType(point.instrumentType)
    ? null
    : (point.splitHistoryJson ?? null);

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
}

function upsertPriceSeries(instrumentType, symbol, points, source = null) {
  if (!instrumentType || !symbol || !Array.isArray(points) || points.length === 0) return;
  const conn = getCacheDb();
  const normalizedPoints = points.map(normalizeCachePoint).filter(Boolean);
  const shouldAutofillAdjClose = isStockInstrumentType(instrumentType);
  const splitHistoryValueForRows = isSplitSupportedInstrumentType(instrumentType) ? null : undefined;
  const stmt = conn.prepare(`
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
  `);

  const tx = conn.transaction((rows) => {
    for (const p of rows) {
      const d = normalizeDate(p.date);
      if (!d) continue;
      stmt.run(
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
    }
  });

  tx(normalizedPoints);
}

function getSeries(instrumentType, symbol, fromDate, toDate) {
  if (!instrumentType || !symbol) return [];
  const conn = getCacheDb();
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
  const normalizedPoints = points.map(normalizeCachePoint).filter(Boolean);
  if (!normalizedPoints.length) return;
  const exitCapDate = getInvestmentExitCapDate(conn, investmentId);
  const effectivePoints = exitCapDate
    ? normalizedPoints.filter((p) => p?.date && p.date <= exitCapDate)
    : normalizedPoints;
  if (!effectivePoints.length) return;

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
    if (exitCapDate) {
      conn.prepare(`
        DELETE FROM market_price_cache
        WHERE investment_id = ?
          AND date > ?
      `).run(Number(investmentId), exitCapDate);
    }

    for (const p of rows) {
      const d = normalizeDate(p.date);
      if (!d) continue;
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
    }
  });

  tx(effectivePoints);
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
  hydrateHistoricalPriceSeries,
  hydrateStockSeriesForPhase2,
};
