const { getDb } = require('../db/schema');
const { getMarketHolidays, getWeekends } = require('./holidays/marketHolidayService');

let db = null;
let schemaEnsured = false;
const closedDaysByYear = new Map();

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
      instrument_type TEXT NOT NULL,
      symbol TEXT NOT NULL,
      date TEXT NOT NULL,
      open REAL,
      high REAL,
      low REAL,
      close REAL,
      adj_close REAL,
      volume REAL,
      source TEXT,
      fetched_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(instrument_type, symbol, date)
    );

    CREATE INDEX IF NOT EXISTS idx_market_price_cache_lookup
      ON market_price_cache(instrument_type, symbol, date);

    CREATE INDEX IF NOT EXISTS idx_market_price_cache_symbol_date
      ON market_price_cache(symbol, date);
  `);
  schemaEnsured = true;
}

function normalizeDate(date) {
  if (!date) return null;
  return String(date).split('T')[0];
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
    volume: point.volume ?? null,
    source: point.source ?? null,
  };
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

function buildLocfPoints(rows, marketSessionDates) {
  const cached = buildRowMap(rows);
  const locf = [];
  let lastKnown = null;

  for (const date of marketSessionDates) {
    const row = cached.get(date);
    if (row && row.close != null) {
      lastKnown = row;
      continue;
    }

    if (lastKnown && lastKnown.close != null) {
      locf.push({
        date,
        close: Number(lastKnown.close),
        source: 'LOCF',
      });
    }
  }

  return locf;
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
  const cachedRows = getSeries(instrumentType, symbol, start, end).filter((row) => row.close != null);

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

  conn.prepare(`
    INSERT INTO market_price_cache (
      instrument_type, symbol, date, open, high, low, close, adj_close, volume, source, fetched_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(instrument_type, symbol, date) DO UPDATE SET
      open = COALESCE(excluded.open, market_price_cache.open),
      high = COALESCE(excluded.high, market_price_cache.high),
      low = COALESCE(excluded.low, market_price_cache.low),
      close = COALESCE(excluded.close, market_price_cache.close),
      adj_close = COALESCE(excluded.adj_close, market_price_cache.adj_close),
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
    point.adjClose ?? null,
    point.volume ?? null,
    point.source ?? null
  );
}

function upsertPriceSeries(instrumentType, symbol, points, source = null) {
  if (!instrumentType || !symbol || !Array.isArray(points) || points.length === 0) return;
  const conn = getCacheDb();
  const stmt = conn.prepare(`
    INSERT INTO market_price_cache (
      instrument_type, symbol, date, open, high, low, close, adj_close, volume, source, fetched_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(instrument_type, symbol, date) DO UPDATE SET
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
        p.adjClose ?? null,
        p.volume ?? null,
        p.source ?? source ?? null
      );
    }
  });

  tx(points);
}

function getSeries(instrumentType, symbol, fromDate, toDate) {
  if (!instrumentType || !symbol) return [];
  const conn = getCacheDb();
  return conn.prepare(`
    SELECT date, open, high, low, close, adj_close, volume, source
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

module.exports = {
  upsertPricePoint,
  upsertPriceSeries,
  getSeries,
  getNearestOnOrBefore,
  getMarketSessionDates,
  hydrateHistoricalPriceSeries,
};
