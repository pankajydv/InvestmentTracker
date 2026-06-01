const https = require('https');
const { getDb } = require('../db/schema');

function fetchYahooOhlcvRange(symbol, startDate, endDate) {
  const from = new Date(`${startDate}T00:00:00.000Z`);
  from.setUTCDate(from.getUTCDate() - 7);
  const to = new Date(`${endDate}T00:00:00.000Z`);
  to.setUTCDate(to.getUTCDate() + 1);

  const p1 = Math.floor(from.getTime() / 1000);
  const p2 = Math.floor(to.getTime() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${p1}&period2=${p2}&interval=1d`;

  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const result = json.chart?.result?.[0];
          if (!result) {
            resolve(new Map());
            return;
          }

          const timestamps = result.timestamp || [];
          const quote = result.indicators?.quote?.[0] || {};
          const opens = quote.open || [];
          const highs = quote.high || [];
          const lows = quote.low || [];
          const closes = quote.close || [];
          const volumes = quote.volume || [];

          const byDate = new Map();
          for (let i = 0; i < timestamps.length; i += 1) {
            const closeNum = Number(closes[i]);
            if (!Number.isFinite(closeNum) || closeNum <= 0) continue;

            const d = new Date(timestamps[i] * 1000).toISOString().slice(0, 10);
            const openRaw = Number(opens[i]);
            const highRaw = Number(highs[i]);
            const lowRaw = Number(lows[i]);
            const volumeRaw = Number(volumes[i]);

            const open = Number.isFinite(openRaw) && openRaw > 0 ? openRaw : closeNum;
            const high = Number.isFinite(highRaw) && highRaw > 0 ? highRaw : Math.max(open, closeNum);
            const low = Number.isFinite(lowRaw) && lowRaw > 0 ? lowRaw : Math.min(open, closeNum);
            const volume = Number.isFinite(volumeRaw) && volumeRaw >= 0 ? Math.round(volumeRaw) : 0;

            byDate.set(d, { open, high, low, close: closeNum, volume });
          }

          resolve(byDate);
        } catch (err) {
          reject(err);
        }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function repairStockOhlcvCoverage(options = {}) {
  const {
    db: providedDb = null,
    instrumentTypes = ['INDIAN_STOCK', 'FOREIGN_STOCK'],
    logger = console,
  } = options;

  const db = providedDb || getDb();
  const allowedTypes = Array.isArray(instrumentTypes) && instrumentTypes.length
    ? instrumentTypes.map((t) => String(t || '').trim().toUpperCase()).filter(Boolean)
    : ['INDIAN_STOCK', 'FOREIGN_STOCK'];
  const placeholders = allowedTypes.map(() => '?').join(',');

  const candidates = db.prepare(`
    SELECT
      instrument_type,
      symbol,
      MIN(date) AS min_date,
      MAX(date) AS max_date,
      COUNT(*) AS gap_rows
    FROM market_price_cache
    WHERE instrument_type IN (${placeholders})
      AND UPPER(COALESCE(source,'')) NOT IN ('LOCF','IPO')
      AND (open IS NULL OR high IS NULL OR low IS NULL OR close IS NULL OR volume IS NULL)
    GROUP BY instrument_type, symbol
    ORDER BY instrument_type, symbol
  `).all(...allowedTypes);

  const updateStmt = db.prepare(`
    UPDATE market_price_cache
    SET
      open = COALESCE(?, open),
      high = COALESCE(?, high),
      low = COALESCE(?, low),
      close = COALESCE(?, close),
      volume = COALESCE(?, volume),
      updated_at = datetime('now')
    WHERE instrument_type = ?
      AND symbol = ?
      AND date = ?
      AND UPPER(COALESCE(source,'')) NOT IN ('LOCF','IPO')
      AND (open IS NULL OR high IS NULL OR low IS NULL OR close IS NULL OR volume IS NULL)
  `);

  let yahooSymbolsAttempted = 0;
  let yahooSymbolErrors = 0;
  let yahooRowsUpdated = 0;

  for (const candidate of candidates) {
    const symbol = String(candidate.symbol || '').trim();
    const instrumentType = String(candidate.instrument_type || '').trim().toUpperCase();
    if (!symbol || !instrumentType) continue;

    yahooSymbolsAttempted += 1;
    try {
      const byDate = await fetchYahooOhlcvRange(symbol, candidate.min_date, candidate.max_date);
      if (!byDate.size) continue;

      const tx = db.transaction(() => {
        let changes = 0;
        for (const [date, row] of byDate.entries()) {
          const result = updateStmt.run(
            row.open,
            row.high,
            row.low,
            row.close,
            row.volume,
            instrumentType,
            symbol,
            date
          );
          changes += Number(result.changes || 0);
        }
        return changes;
      });

      yahooRowsUpdated += tx();
    } catch (err) {
      yahooSymbolErrors += 1;
      if (logger && typeof logger.warn === 'function') {
        logger.warn('[OHLCVRepair] Yahoo fetch failed for symbol', {
          symbol,
          instrumentType,
          error: err?.message || String(err),
        });
      }
    }
  }

  const fallback = db.prepare(`
    UPDATE market_price_cache
    SET
      open = COALESCE(open, close),
      high = COALESCE(high, close),
      low = COALESCE(low, close),
      volume = COALESCE(volume, 0),
      updated_at = datetime('now')
    WHERE instrument_type IN (${placeholders})
      AND UPPER(COALESCE(source,'')) NOT IN ('LOCF','IPO')
      AND close IS NOT NULL
      AND (open IS NULL OR high IS NULL OR low IS NULL OR volume IS NULL)
  `).run(...allowedTypes);

  const remaining = db.prepare(`
    SELECT instrument_type, COUNT(*) AS remaining_missing
    FROM market_price_cache
    WHERE instrument_type IN (${placeholders})
      AND UPPER(COALESCE(source,'')) NOT IN ('LOCF','IPO')
      AND (open IS NULL OR high IS NULL OR low IS NULL OR close IS NULL OR volume IS NULL)
    GROUP BY instrument_type
    ORDER BY instrument_type
  `).all(...allowedTypes);

  const summary = {
    instrumentTypes: allowedTypes,
    candidateSymbols: candidates.length,
    yahooSymbolsAttempted,
    yahooSymbolErrors,
    yahooRowsUpdated,
    fallbackRowsUpdated: Number(fallback.changes || 0),
    remainingMissingByInstrumentType: remaining,
  };

  if (logger && typeof logger.info === 'function') {
    logger.info('[OHLCVRepair] Completed', summary);
  }

  return summary;
}

module.exports = {
  repairStockOhlcvCoverage,
};
