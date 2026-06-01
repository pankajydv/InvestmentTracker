const { getSeries } = require('./marketPriceCache');
const { enqueueGapsBatch } = require('./historicalPriceRepairService');

function normalizeDate(value) {
  if (!value) return null;
  const date = String(value).split('T')[0];
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

function addDays(date, days) {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

function diffDays(start, end) {
  const startMs = new Date(`${start}T00:00:00.000Z`).getTime();
  const endMs = new Date(`${end}T00:00:00.000Z`).getTime();
  return Math.max(0, Math.floor((endMs - startMs) / 86400000));
}

function instrumentForInvestment(row) {
  const assetType = String(row.asset_type || '').toUpperCase();
  const symbol = String(row.symbol || '').trim();
  const amfiCode = String(row.amfi_code || '').trim();

  if (assetType === 'MUTUAL_FUND' && amfiCode) {
    return { instrumentType: 'MUTUAL_FUND', symbol: amfiCode, assetType };
  }
  if ((assetType === 'INDIAN_STOCK' || assetType === 'FOREIGN_STOCK' || assetType === 'SGB') && symbol) {
    return { instrumentType: assetType, symbol, assetType };
  }
  return null;
}

function staleLagByInstrument(instrumentType) {
  if (instrumentType === 'MUTUAL_FUND') return 4;
  if (instrumentType === 'SGB') return 6;
  if (instrumentType === 'FX') return 3;
  return 3;
}

function mergeGaps(gaps) {
  if (!Array.isArray(gaps) || gaps.length === 0) return [];
  const grouped = new Map();

  for (const g of gaps) {
    if (!g || !g.instrumentType || !g.symbol || !g.fromDate || !g.toDate) continue;
    const key = `${g.instrumentType}::${g.symbol}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(g);
  }

  const merged = [];
  for (const [key, rows] of grouped.entries()) {
    let minFrom = null;
    let maxTo = null;
    let minPriority = null;
    let sourceEventId = null;
    const reasons = new Set();

    for (const row of rows) {
      if (!minFrom || row.fromDate < minFrom) minFrom = row.fromDate;
      if (!maxTo || row.toDate > maxTo) maxTo = row.toDate;

      const p = Number(row.priority);
      if (Number.isFinite(p)) {
        if (minPriority == null || p < minPriority) minPriority = p;
      }

      if (!sourceEventId && row.sourceEventId) sourceEventId = row.sourceEventId;
      if (row.reason) reasons.add(String(row.reason));
    }

    if (minFrom && maxTo) {
      const first = rows[0] || {};
      merged.push({
        ...first,
        fromDate: minFrom,
        toDate: maxTo,
        reason: Array.from(reasons).join(';'),
        priority: minPriority ?? first.priority,
        sourceEventId: sourceEventId ?? first.sourceEventId,
      });
    }

    void key;
  }

  return merged;
}

function buildActiveInstrumentRows(db, runDate) {
  return db.prepare(`
    SELECT
      i.id,
      i.asset_type,
      i.ticker_symbol AS symbol,
      i.amfi_code,
      MIN(date(t.transaction_date)) AS first_transaction_date,
      SUM(
        CASE
          WHEN t.transaction_type IN ('BUY', 'DEPOSIT', 'BONUS', 'SPLIT', 'IPO', 'TRANSFER_IN', 'SWITCH_IN', 'RIGHTS', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'VEST', 'ESPP_PURCHASE') THEN COALESCE(t.units, 0)
          WHEN t.transaction_type IN ('SELL', 'REDEMPTION', 'WITHDRAWAL', 'TRANSFER_OUT', 'SWITCH_OUT', 'CONSOLIDATION', 'CHARGES', 'AMC') THEN -COALESCE(t.units, 0)
          ELSE 0
        END
      ) AS net_units
    FROM investments i
    JOIN transactions t ON t.investment_id = i.id
    WHERE date(t.transaction_date) <= ?
      AND i.asset_type IN ('INDIAN_STOCK', 'FOREIGN_STOCK', 'SGB', 'MUTUAL_FUND')
      AND COALESCE(i.is_active, 1) = 1
    GROUP BY i.id, i.asset_type, i.ticker_symbol, i.amfi_code
    HAVING net_units > 0
  `).all(runDate);
}

function buildDirtyScopeInstrumentRows(db, runDate) {
  return db.prepare(`
    SELECT
      i.asset_type,
      i.ticker_symbol AS symbol,
      i.amfi_code,
      MIN(date(s.dirty_from_date)) AS dirty_from_date,
      COUNT(*) AS scope_count
    FROM dirty_backfill_scope s
    JOIN investments i ON i.id = s.investment_id
    WHERE s.status IN ('pending', 'running', 'failed')
      AND date(s.dirty_from_date) <= ?
      AND i.asset_type IN ('INDIAN_STOCK', 'FOREIGN_STOCK', 'SGB', 'MUTUAL_FUND')
      AND COALESCE(i.is_active, 1) = 1
    GROUP BY i.asset_type, i.ticker_symbol, i.amfi_code
  `).all(runDate);
}

function assessRecentWindowCoverage(instrument, fromDate, runDate, sourceEventId) {
  const rows = getSeries(instrument.instrumentType, instrument.symbol, fromDate, runDate);
  const maxLag = staleLagByInstrument(instrument.instrumentType);

  if (!rows.length) {
    return [{
      instrumentType: instrument.instrumentType,
      symbol: instrument.symbol,
      fromDate,
      toDate: runDate,
      reason: 'no-cache-in-recent-window',
      sourceEventId,
      priority: 80,
    }];
  }

  const latest = rows[rows.length - 1].date;
  const lag = diffDays(latest, runDate);
  if (lag <= maxLag) return [];

  return [{
    instrumentType: instrument.instrumentType,
    symbol: instrument.symbol,
    fromDate: addDays(latest, 1),
    toDate: runDate,
    reason: `stale-cache-${lag}d`,
    sourceEventId,
    priority: 90,
  }];
}

function assessFullHistoryCoverage(instrument, fromDate, runDate, sourceEventId) {
  const startDate = normalizeDate(fromDate);
  if (!startDate || startDate > runDate) return [];

  const rows = getSeries(instrument.instrumentType, instrument.symbol, startDate, runDate);
  if (!rows.length) {
    return [{
      instrumentType: instrument.instrumentType,
      symbol: instrument.symbol,
      fromDate: startDate,
      toDate: runDate,
      reason: 'full-history-cache-miss',
      sourceEventId,
      priority: 10,
    }];
  }

  const first = rows[0].date;
  const latest = rows[rows.length - 1].date;
  const gaps = [];

  if (first > startDate) {
    gaps.push({
      instrumentType: instrument.instrumentType,
      symbol: instrument.symbol,
      fromDate: startDate,
      toDate: addDays(first, -1),
      reason: 'full-history-gap-start',
      sourceEventId,
      priority: 15,
    });
  }

  const lag = diffDays(latest, runDate);
  const maxLag = staleLagByInstrument(instrument.instrumentType);
  if (lag > maxLag) {
    gaps.push({
      instrumentType: instrument.instrumentType,
      symbol: instrument.symbol,
      fromDate: addDays(latest, 1),
      toDate: runDate,
      reason: `full-history-gap-tail-${lag}d`,
      sourceEventId,
      priority: 20,
    });
  }

  return gaps;
}

function assessDirtyScopeCoverage(instrument, dirtyFromDate, runDate, sourceEventId) {
  const fromDate = normalizeDate(dirtyFromDate);
  if (!fromDate || fromDate > runDate) return [];

  const rows = getSeries(instrument.instrumentType, instrument.symbol, fromDate, runDate);
  if (!rows.length) {
    return [{
      instrumentType: instrument.instrumentType,
      symbol: instrument.symbol,
      fromDate,
      toDate: runDate,
      reason: 'dirty-scope-cache-miss',
      sourceEventId,
      priority: 20,
    }];
  }

  const first = rows[0].date;
  const latest = rows[rows.length - 1].date;
  const gaps = [];

  if (first > fromDate) {
    gaps.push({
      instrumentType: instrument.instrumentType,
      symbol: instrument.symbol,
      fromDate,
      toDate: addDays(first, -1),
      reason: 'dirty-scope-gap-start',
      sourceEventId,
      priority: 30,
    });
  }

  const lag = diffDays(latest, runDate);
  const maxLag = staleLagByInstrument(instrument.instrumentType) + 2;
  if (lag > maxLag) {
    gaps.push({
      instrumentType: instrument.instrumentType,
      symbol: instrument.symbol,
      fromDate: addDays(latest, 1),
      toDate: runDate,
      reason: `dirty-scope-gap-tail-${lag}d`,
      sourceEventId,
      priority: 40,
    });
  }

  return gaps;
}

async function auditHistoricalPriceCoverage(db, options = {}) {
  if (!db) throw new Error('db is required');

  const runDate = normalizeDate(options.runDate) || new Date().toISOString().split('T')[0];
  const recentWindowDays = Math.max(1, Math.min(30, Number(options.recentWindowDays) || 5));
  const dryRun = options.dryRun !== false;
  const sourceEventId = String(options.sourceEventId || `historical-audit:${runDate}`);

  const recentFromDate = addDays(runDate, -(recentWindowDays - 1));
  const activeRows = buildActiveInstrumentRows(db, runDate);
  const dirtyRows = buildDirtyScopeInstrumentRows(db, runDate);

  const candidates = [];

  for (const row of activeRows) {
    const instrument = instrumentForInvestment(row);
    if (!instrument) continue;
    candidates.push(...assessFullHistoryCoverage(instrument, row.first_transaction_date, runDate, sourceEventId));
  }

  let hasForeignHoldings = false;
  let earliestForeignHoldingDate = null;
  for (const row of activeRows) {
    if (String(row.asset_type).toUpperCase() === 'FOREIGN_STOCK') {
      hasForeignHoldings = true;
      const d = normalizeDate(row.first_transaction_date);
      if (d && (!earliestForeignHoldingDate || d < earliestForeignHoldingDate)) {
        earliestForeignHoldingDate = d;
      }
    }
  }

  if (hasForeignHoldings && earliestForeignHoldingDate) {
    candidates.push(...assessFullHistoryCoverage({ instrumentType: 'FX', symbol: 'USDINR=X' }, earliestForeignHoldingDate, runDate, sourceEventId));
  }

  for (const row of dirtyRows) {
    const instrument = instrumentForInvestment(row);
    if (!instrument) continue;
    candidates.push(...assessDirtyScopeCoverage(instrument, row.dirty_from_date, runDate, sourceEventId));
  }

  const mergedGaps = mergeGaps(candidates)
    .filter((g) => g.fromDate <= g.toDate);

  let enqueueSummary = null;
  if (!dryRun && mergedGaps.length > 0) {
    enqueueSummary = enqueueGapsBatch(db, mergedGaps);
  }

  return {
    runDate,
    dryRun,
    recentWindowDays,
    activeInstrumentRows: activeRows.length,
    dirtyScopeInstrumentRows: dirtyRows.length,
    candidateGapCount: candidates.length,
    groupedInstrumentCount: new Set(candidates.map((g) => `${g.instrumentType}::${g.symbol}`)).size,
    envelopeGapCount: mergedGaps.length,
    mergedGapCount: mergedGaps.length,
    sampleGaps: mergedGaps.slice(0, 10),
    enqueueSummary,
  };
}

module.exports = {
  auditHistoricalPriceCoverage,
};
