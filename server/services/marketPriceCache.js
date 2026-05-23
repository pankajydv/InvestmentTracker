const { getDb } = require('../db/schema');

let db = null;
let schemaEnsured = false;

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
};
