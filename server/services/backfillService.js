const https = require('https');
const { fetchCorporateActions, fetchHistoricalStockPrice, fetchHistoricalOHLC, fetchHistoricalUSDToINR, fetchMutualFundHistory } = require('./priceService');
const { fetchNPSHistory } = require('./priceService');
const {
  calculatePfInterestPreview,
  calculatePfValueAsOfDate,
  calculateSmallSavingsInterestPreview,
  calculateSmallSavingsValueAsOfDate,
} = require('./pfInterestCalculator');
const { getSeries, upsertPriceSeries, hydrateHistoricalPriceSeries } = require('./marketPriceCache');
const { updateAssetTypeDaily, updatePortfolioDaily } = require('./updater');
const { setBackfillProgress } = require('./dirtyBackfillService');
const { toIsoDate, todayIso } = require('./dateUtils');
const { logBackfillInfo, logBackfillError } = require('./appLogger');
const {
  INVESTED_AMOUNT_INFLOW_TYPES_SQL,
  REALIZED_CASHFLOW_TYPES,
  REALIZED_CASHFLOW_TYPES_REINVEST_ACCRUAL,
} = require('../constants/transactionTypes');
const {
  quantizeForStorage,
  quantizeNullableForStorage,
} = require('./numberPrecision');

function clampEndDateToToday(endDate) {
  const end = toIsoDate(endDate) || todayIso();
  const today = todayIso();
  return end > today ? today : end;
}

function eachDate(fromDate, toDate) {
  const out = [];
  let d = new Date(`${fromDate}T00:00:00.000Z`);
  const end = new Date(`${toDate}T00:00:00.000Z`);
  while (d <= end) {
    out.push(d.toISOString().split('T')[0]);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function addDays(dateIso, days) {
  const d = new Date(`${dateIso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString().split('T')[0];
}

function inferStockInstrumentType(symbol) {
  return /\.(NS|BO)$/i.test(String(symbol || '')) ? 'INDIAN_STOCK' : 'FOREIGN_STOCK';
}

const AGGREGATE_RESUME_KEY = 'backfill_aggregate_resume_v1';

function readAggregateResumeState(db) {
  const row = db.prepare('SELECT value FROM config WHERE key = ? LIMIT 1').get(AGGREGATE_RESUME_KEY);
  if (!row?.value) return null;

  try {
    const parsed = JSON.parse(String(row.value));
    if (!parsed || typeof parsed !== 'object') return null;
    if (!toIsoDate(parsed.runDate) || !toIsoDate(parsed.rangeStart) || !toIsoDate(parsed.rangeEnd)) return null;
    if (parsed.nextDate != null && !toIsoDate(parsed.nextDate)) return null;
    return {
      runDate: toIsoDate(parsed.runDate),
      rangeStart: toIsoDate(parsed.rangeStart),
      rangeEnd: toIsoDate(parsed.rangeEnd),
      nextDate: parsed.nextDate ? toIsoDate(parsed.nextDate) : null,
    };
  } catch (_) {
    return null;
  }
}

function writeAggregateResumeState(db, payload) {
  db.prepare(`
    INSERT INTO config (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `).run(AGGREGATE_RESUME_KEY, JSON.stringify(payload));
}

function clearAggregateResumeState(db) {
  db.prepare('DELETE FROM config WHERE key = ?').run(AGGREGATE_RESUME_KEY);
}

function progressLogStride(total, maxSteps = 10) {
  const t = Number(total || 0);
  if (t <= 0) return 1;
  return Math.max(1, Math.ceil(t / Math.max(1, maxSteps)));
}

function shouldHeartbeat(lastAtMs, intervalMs = 60_000) {
  return (Date.now() - Number(lastAtMs || 0)) >= intervalMs;
}

function normalizeMfDate(dateValue) {
  const value = String(dateValue || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const m = value.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}

function isValidNpsNav(nav) {
  const n = Number(nav);
  if (!Number.isFinite(n) || n <= 0) return false;
  // Guard against placeholder/test NAV pollution.
  if (Math.abs(n - 99.99) < 1e-6) return false;
  return true;
}

function nearestOnOrBefore(seriesMap, date) {
  if (!seriesMap || !seriesMap.size) return null;
  let bestDate = null;
  let bestValue = null;
  for (const [d, v] of seriesMap.entries()) {
    if (d <= date && (bestDate == null || d > bestDate)) {
      bestDate = d;
      bestValue = v;
    }
  }
  return bestValue;
}

function fetchStockSeries(symbol, startDate, endDate) {
  const instrumentType = inferStockInstrumentType(symbol);
  const cacheStart = addDays(startDate, -7);
  const cacheRows = getSeries(instrumentType, symbol, cacheStart, endDate);
  const cached = new Map();
  for (const row of cacheRows) {
    if (row.close != null) cached.set(row.date, Number(row.close));
  }

  if (cached.size > 0) {
    const latestCached = Array.from(cached.keys()).sort().pop();
    if (latestCached && latestCached >= addDays(endDate, -1)) {
      return Promise.resolve(cached);
    }
  }

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
          const closes = result.indicators?.quote?.[0]?.close || [];
          const series = new Map();
          const rowsForCache = [];
          for (let i = 0; i < timestamps.length; i += 1) {
            const close = closes[i];
            if (close == null) continue;
            const d = new Date(timestamps[i] * 1000).toISOString().split('T')[0];
            series.set(d, Number(close));
            rowsForCache.push({ date: d, close: Number(close), source: 'YAHOO' });
          }
          if (rowsForCache.length > 0) {
            upsertPriceSeries(instrumentType, symbol, rowsForCache, 'YAHOO');
          }
          resolve(series);
        } catch (e) {
          reject(new Error(`Failed to parse stock series for ${symbol}: ${e.message}`));
        }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

function getStoredPriceOnOrBefore(db, investmentId, portfolioId, date) {
  if (portfolioId == null) return null;
  const row = db.prepare(
    'SELECT date, price_per_unit FROM daily_values WHERE investment_id = ? AND portfolio_id = ? AND date <= ? ORDER BY date DESC LIMIT 1'
  ).get(investmentId, portfolioId, date);
  return row ? { price: Number(row.price_per_unit || 0), source: row.date === date ? 'LIVE' : 'LOCF' } : null;
}

async function getPriceForDate(db, inv, date, cache, portfolioId) {
  if (inv.asset_type === 'BOND') {
    return { price: Number(inv.face_value || 1000), source: 'COMPUTED' };
  }

  if (inv.asset_type === 'MUTUAL_FUND') {
    if (!inv.amfi_code) return { price: 0, source: 'COMPUTED' };
    if (!cache.mf.has(inv.amfi_code)) {
      const history = await fetchMutualFundHistory(inv.amfi_code).catch(() => []);
      const map = new Map();
      for (const row of history) {
        const d = normalizeMfDate(row.date);
        if (!d) continue;
        map.set(d, Number(row.nav));
      }
      cache.mf.set(inv.amfi_code, map);
    }
    const map = cache.mf.get(inv.amfi_code);
    const exact = map.get(date);
    if (exact != null) return { price: Number(exact), source: 'LIVE' };
    const nearest = nearestOnOrBefore(map, date);
    if (nearest != null) return { price: Number(nearest), source: 'LOCF' };
    const stored = getStoredPriceOnOrBefore(db, inv.id, portfolioId, date);
    if (stored && stored.price > 0) return stored;
    return { price: 0, source: 'COMPUTED' };
  }

  if (inv.asset_type === 'SGB') {
    // SGB: Use NSE bhavcopy for historical, fallback to NSE quote for today
    const symbol = inv.ticker_symbol;
    if (!symbol) return { price: 0, source: 'COMPUTED' };
    if (!cache.sgb) cache.sgb = new Map();
    if (!cache.sgb.has(symbol)) {
      try {
        const { fetchSGBHistoricalRaw } = require('./sgbBhavcopy');
        const from = cache.sgbRangeBySymbol?.get(symbol) || cache.rangeStart || date;
        const to = cache.rangeEnd || date;

        // Check if DB cache is already fresh enough (bhavcopy is T-1; tolerate 1-day gap)
        // This mirrors fetchStockSeries recency check to avoid re-downloading every run.
        const recentRows = getSeries('SGB', symbol, addDays(to, -5), to).filter((r) => r.close != null);
        const latestCachedDate = recentRows.map((r) => r.date).sort().pop();
        if (latestCachedDate && latestCachedDate >= addDays(to, -1)) {
          // Cache is fresh — load full range from DB, skip HTTP fetch
          const allRows = getSeries('SGB', symbol, from, to).filter((r) => r.close != null);
          const hist = new Map();
          for (const row of allRows) hist.set(row.date, Number(row.close));
          logBackfillInfo(`[SGB][Bhavcopy] Loaded ${hist.size} price points for ${symbol} from cache (latest: ${latestCachedDate})`);
          cache.sgb.set(symbol, hist);
        } else {
          logBackfillInfo(`[SGB][Bhavcopy] Cache stale or missing for ${symbol} (latest: ${latestCachedDate || 'none'}), fetching up to ${to} from source`);
          const rows = await hydrateHistoricalPriceSeries({
            instrumentType: 'SGB',
            symbol,
            fromDate: from,
            toDate: to,
            sourceLabel: 'NSE_BHAVCOPY',
            fetchRange: async (missingFrom, missingTo) => fetchSGBHistoricalRaw(symbol, missingFrom, missingTo),
            mapFetchedRows: (fetched) => (Array.isArray(fetched) ? fetched : []),
          });
          const hist = new Map();
          for (const row of rows) {
            if (row?.date && row.close != null) hist.set(row.date, Number(row.close));
          }
          logBackfillInfo(`[SGB][Bhavcopy] Fetched ${hist.size} price points for ${symbol}`);
          cache.sgb.set(symbol, hist);
        }
      } catch (e) {
        logBackfillError(`[SGB][Bhavcopy] Failed to fetch prices for ${symbol}: ${e.message}`);
        cache.sgb.set(symbol, new Map());
      }
    }
    const hist = cache.sgb.get(symbol);
    if (hist && hist.has(date)) {
      return { price: Number(hist.get(date)), source: 'LIVE' };
    }
    // fallback: try latest NSE quote for today
    if (date === todayIso()) {
      try {
        const { fetchSGBPrice } = require('./priceService');
        const live = await fetchSGBPrice(symbol);
        if (live && live.price > 0) return { price: Number(live.price), source: 'LIVE' };
      } catch (e) {}
    }
    // fallback: LOCF from hist
    if (hist && hist.size > 0) {
      // find nearest on or before
      const keys = Array.from(hist.keys()).filter(k => k <= date).sort();
      if (keys.length > 0) return { price: Number(hist.get(keys[keys.length-1])), source: 'LOCF' };
    }
    // fallback: stored
    const stored = getStoredPriceOnOrBefore(db, inv.id, portfolioId, date);
    if (stored && stored.price > 0) return stored;
    return { price: 0, source: 'COMPUTED' };
  }
  if (inv.asset_type === 'INDIAN_STOCK' || inv.asset_type === 'FOREIGN_STOCK') {
    const symbol = inv.ticker_symbol;
    if (!symbol) return { price: 0, source: 'COMPUTED' };
    if (!cache.stock.has(symbol)) {
      const symbolStart = cache.stockRangeBySymbol?.get(symbol) || cache.rangeStart;
      const series = await fetchStockSeries(symbol, symbolStart, cache.rangeEnd).catch(() => new Map());
      cache.stock.set(symbol, series);
    }
    const series = cache.stock.get(symbol);
    const exact = series.get(date);
    if (exact != null) {
      return { price: Number(exact), source: 'LIVE' };
    }
    const nearest = nearestOnOrBefore(series, date);
    if (nearest != null) {
      return { price: Number(nearest), source: 'LOCF' };
    }

    if (cache.allowNetworkFallback === true) {
      const historical = await fetchHistoricalStockPrice(symbol, date).catch(() => null);
      if (historical != null) {
        return { price: Number(historical), source: 'LOCF' };
      }
    }

    const stored = getStoredPriceOnOrBefore(db, inv.id, portfolioId, date);
    if (stored && stored.price > 0) return stored;
    return { price: 0, source: 'COMPUTED' };
  }

  if (inv.asset_type === 'NPS') {
    if (inv.nps_fund_code) {
      if (!cache.nps.has(inv.nps_fund_code)) {
        const history = await fetchNPSHistory(inv.nps_fund_code, cache.rangeStart || date, cache.rangeEnd || date).catch(() => []);
        const map = new Map();
        for (const row of history) {
          const d = normalizeMfDate(row.date);
          if (!d) continue;
          if (!isValidNpsNav(row.nav)) continue;
          map.set(d, Number(row.nav));
        }
        cache.nps.set(inv.nps_fund_code, map);
      }

      const map = cache.nps.get(inv.nps_fund_code);
      const exact = map.get(date);
      if (isValidNpsNav(exact)) return { price: Number(exact), source: 'LIVE' };
      const nearest = nearestOnOrBefore(map, date);
      if (isValidNpsNav(nearest)) return { price: Number(nearest), source: 'LOCF' };
    }

    const row = db.prepare(`
      SELECT price_per_unit FROM transactions
      WHERE investment_id = ?
        AND transaction_date <= ?
        AND price_per_unit > 0
        AND ABS(price_per_unit - 99.99) > 0.000001
      ORDER BY transaction_date DESC, id DESC
      LIMIT 1
    `).get(inv.id, date);
    if (isValidNpsNav(row?.price_per_unit)) return { price: Number(row.price_per_unit), source: 'COMPUTED' };
    const stored = getStoredPriceOnOrBefore(db, inv.id, portfolioId, date);
    if (stored && isValidNpsNav(stored.price)) return stored;
    return { price: 0, source: 'COMPUTED' };
  }

  return { price: 0, source: 'COMPUTED' };
}

function getRateRows(db, rateType) {
  return db.prepare(
    'SELECT rate, effective_from, effective_to FROM interest_rates WHERE rate_type = ? ORDER BY effective_from ASC'
  ).all(rateType);
}

function getProvidentValue(db, inv, date, portfolioId) {
  const portfolioFilter = portfolioId != null ? ' AND portfolio_id = ?' : '';
  const params = portfolioId != null ? [inv.id, date, portfolioId] : [inv.id, date];
  const txns = db.prepare(`
    SELECT date(transaction_date) AS transaction_date, transaction_type, amount
    FROM transactions
    WHERE investment_id = ? AND date(transaction_date) <= ?${portfolioFilter}
    ORDER BY transaction_date ASC, id ASC
  `).all(...params);

  if (!txns.length && !(Number(inv.opening_balance) > 0)) return 0;

  const fromDate = txns.length ? txns[0].transaction_date : date;
  const rateRows = getRateRows(db, inv.asset_type);

  if (inv.asset_type === 'PF') {
    return Number(calculatePfValueAsOfDate({
      openingBalance: Number(inv.opening_balance || 0),
      transactions: txns,
      rateRows,
      fromDate,
      asOfDate: date,
      // Existing INTEREST rows in PF statements are year-end credits that are
      // already represented in historical postings. Recomputing interest while
      // also including those rows double-counts and inflates daily values.
      ignoreExistingInterest: true,
      includeTransferTransactions: true,
    }) || 0);
  }

  if (inv.asset_type === 'PPF' || inv.asset_type === 'SSY') {
    return Number(calculateSmallSavingsValueAsOfDate({
      openingBalance: Number(inv.opening_balance || 0),
      transactions: txns,
      rateRows,
      fromDate,
      asOfDate: date,
      includeTransferTransactions: true,
      interestBaseMethod: inv.asset_type === 'SSY' ? 'month_end_balance' : 'min_balance_between_5th_and_month_end',
      annualRounding: true,
    }) || 0);
  }

  const preview = calculateSmallSavingsInterestPreview({
    openingBalance: Number(inv.opening_balance || 0),
    transactions: txns,
    rateRows,
    fromDate,
    toDate: date,
    ignoreExistingInterest: false,
    includeTransferTransactions: true,
    interestBaseMethod: inv.asset_type === 'SSY' ? 'month_end_balance' : 'min_balance_between_5th_and_month_end',
    annualRounding: inv.asset_type === 'SSY' || inv.asset_type === 'PPF',
  });
  return Number(preview.closingBalance || 0);
}

function upsertDailyRow(db, row, statements = null) {
  // Only write portfolio-scoped rows (portfolio_id NOT NULL)
  if (row.portfolio_id == null) return;

  const normalizedRow = {
    ...row,
    price_per_unit: quantizeForStorage(row.price_per_unit),
    total_units: quantizeForStorage(row.total_units),
    current_value: quantizeForStorage(row.current_value),
    invested_amount: quantizeForStorage(row.invested_amount),
    realized_proceeds: quantizeForStorage(row.realized_proceeds),
    profit_loss: quantizeForStorage(row.profit_loss),
    day_change: quantizeForStorage(row.day_change),
  };

  const upsertScoped = statements?.upsertScoped || db.prepare(`
    INSERT INTO daily_values (investment_id, portfolio_id, date, price_per_unit, total_units, current_value, invested_amount, realized_proceeds, profit_loss, price_source, day_change, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(investment_id, portfolio_id, date) DO UPDATE SET
      price_per_unit = excluded.price_per_unit,
      total_units = excluded.total_units,
      current_value = excluded.current_value,
      invested_amount = excluded.invested_amount,
      realized_proceeds = excluded.realized_proceeds,
      profit_loss = excluded.profit_loss,
      price_source = excluded.price_source,
      day_change = excluded.day_change,
      updated_at = datetime('now')
  `);

  upsertScoped.run(
    normalizedRow.investment_id,
    normalizedRow.portfolio_id,
    normalizedRow.date,
    normalizedRow.price_per_unit,
    normalizedRow.total_units,
    normalizedRow.current_value,
    normalizedRow.invested_amount,
    normalizedRow.realized_proceeds,
    normalizedRow.profit_loss,
    normalizedRow.price_source,
    normalizedRow.day_change
  );
}

function round2(n) {
  return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
}

function computeRealizedProceeds(db, inv, date, portfolioId) {
  const portfolioFilter = portfolioId != null ? ' AND portfolio_id = ?' : '';
  const params = portfolioId != null ? [inv.id, date, portfolioId] : [inv.id, date];

  let types = REALIZED_CASHFLOW_TYPES;
  if (inv.asset_type === 'PF' || inv.asset_type === 'PPF' || inv.asset_type === 'SSY') {
    types = REALIZED_CASHFLOW_TYPES_REINVEST_ACCRUAL;
  }

  const placeholders = types.map(() => '?').join(',');
  const row = db.prepare(`
    SELECT COALESCE(SUM(amount - COALESCE(fees, 0)), 0) AS total
    FROM transactions
    WHERE investment_id = ? AND transaction_date <= ?${portfolioFilter}
      AND transaction_type IN (${placeholders})
  `).get(...params, ...types);
  return Number(row?.total || 0);
}

function computeNetFlowForDate(db, inv, date, portfolioId, statements = null) {
  const getNetFlow = statements?.getNetFlow || db.prepare(`
    SELECT COALESCE(SUM(CASE
      WHEN transaction_type IN ('BUY', 'DEPOSIT', 'IPO', 'RIGHTS', 'TRANSFER_IN', 'SWITCH_IN', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'ESPP_CONTRIBUTION') THEN COALESCE(amount, 0)
      WHEN transaction_type IN ('SELL', 'REDEMPTION', 'WITHDRAWAL', 'TRANSFER_OUT', 'SWITCH_OUT', 'CHARGES', 'AMC') THEN -COALESCE(amount, 0)
      WHEN transaction_type = 'TDS' THEN -ABS(COALESCE(amount, 0))
      ELSE 0
    END), 0) AS net_flow
    FROM transactions
    WHERE investment_id = ? AND date(transaction_date) = ?
  `);
  const getNetFlowPortfolio = statements?.getNetFlowPortfolio || db.prepare(`
    SELECT COALESCE(SUM(CASE
      WHEN transaction_type IN ('BUY', 'DEPOSIT', 'IPO', 'RIGHTS', 'TRANSFER_IN', 'SWITCH_IN', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'ESPP_CONTRIBUTION') THEN COALESCE(amount, 0)
      WHEN transaction_type IN ('SELL', 'REDEMPTION', 'WITHDRAWAL', 'TRANSFER_OUT', 'SWITCH_OUT', 'CHARGES', 'AMC') THEN -COALESCE(amount, 0)
      WHEN transaction_type = 'TDS' THEN -ABS(COALESCE(amount, 0))
      ELSE 0
    END), 0) AS net_flow
    FROM transactions
    WHERE investment_id = ? AND portfolio_id = ? AND date(transaction_date) = ?
  `);

  const row = portfolioId != null
    ? getNetFlowPortfolio.get(inv.id, portfolioId, date)
    : getNetFlow.get(inv.id, date);
  return Number(row?.net_flow || 0);
}

async function recomputeScopeRows(db, inv, portfolioId, fromDate, toDate, cache, onProgress = null) {
    // Only handle portfolio-scoped rows (portfolio_id NOT NULL)
    if (portfolioId == null) return 0;

    const dailyStatements = {
      upsertScoped: db.prepare(`
        INSERT INTO daily_values (investment_id, portfolio_id, date, price_per_unit, total_units, current_value, invested_amount, realized_proceeds, profit_loss, price_source, day_change, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(investment_id, portfolio_id, date) DO UPDATE SET
          price_per_unit = excluded.price_per_unit,
          total_units = excluded.total_units,
          current_value = excluded.current_value,
          invested_amount = excluded.invested_amount,
          realized_proceeds = excluded.realized_proceeds,
          profit_loss = excluded.profit_loss,
          price_source = excluded.price_source,
          day_change = excluded.day_change,
          updated_at = datetime('now')
      `),
    };

  const dates = eachDate(fromDate, toDate);
  const portfolioFilter = portfolioId != null ? ' AND portfolio_id = ?' : '';
  const baseParams = portfolioId != null ? [inv.id, portfolioId] : [inv.id];

  const latestTxnDateRow = db.prepare(`
    SELECT MAX(date(transaction_date)) AS latest_date
    FROM transactions
    WHERE investment_id = ?${portfolioFilter}
      AND date(transaction_date) <= ?
  `).get(...baseParams, toDate);
  const latestTxnDate = latestTxnDateRow?.latest_date || null;

  // Only delete portfolio-scoped rows
  const deleteSql = 'DELETE FROM daily_values WHERE investment_id = ? AND portfolio_id = ? AND date >= ? AND date <= ?';
  const deleteParams = [inv.id, portfolioId, fromDate, toDate];
  db.prepare(deleteSql).run(...deleteParams);

  const getUnits = db.prepare(`
    SELECT COALESCE(SUM(CASE
      WHEN transaction_type IN ('BUY', 'DEPOSIT', 'BONUS', 'SPLIT', 'IPO', 'TRANSFER_IN', 'SWITCH_IN', 'RIGHTS', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'VEST', 'ESPP_PURCHASE') THEN COALESCE(units, 0)
      WHEN transaction_type IN ('SELL', 'REDEMPTION', 'WITHDRAWAL', 'TRANSFER_OUT', 'SWITCH_OUT', 'CONSOLIDATION', 'CHARGES', 'AMC') THEN -COALESCE(units, 0)
      ELSE 0
    END), 0) AS total
    FROM transactions
    WHERE investment_id = ?${portfolioFilter} AND transaction_date <= ?
  `);
  const getInvested = db.prepare(`
    SELECT COALESCE(SUM(amount + COALESCE(fees, 0)), 0) AS total
    FROM transactions
    WHERE investment_id = ?${portfolioFilter} AND transaction_date <= ?
      AND transaction_type IN (${INVESTED_AMOUNT_INFLOW_TYPES_SQL})
  `);
  // Only query portfolio-scoped rows
  const getPrev = db.prepare(
    'SELECT current_value FROM daily_values WHERE investment_id = ? AND portfolio_id = ? AND date < ? ORDER BY date DESC LIMIT 1'
  );
  const getNetFlow = db.prepare(`
    SELECT COALESCE(SUM(CASE
      WHEN transaction_type IN ('BUY', 'DEPOSIT', 'IPO', 'RIGHTS', 'TRANSFER_IN', 'SWITCH_IN', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'ESPP_CONTRIBUTION') THEN COALESCE(amount, 0)
      WHEN transaction_type IN ('SELL', 'REDEMPTION', 'WITHDRAWAL', 'TRANSFER_OUT', 'SWITCH_OUT', 'CHARGES', 'AMC') THEN -COALESCE(amount, 0)
      WHEN transaction_type = 'TDS' THEN -ABS(COALESCE(amount, 0))
      ELSE 0
    END), 0) AS net_flow
    FROM transactions
    WHERE investment_id = ? AND date(transaction_date) = ?
  `);
  const getNetFlowPortfolio = db.prepare(`
    SELECT COALESCE(SUM(CASE
      WHEN transaction_type IN ('BUY', 'DEPOSIT', 'IPO', 'RIGHTS', 'TRANSFER_IN', 'SWITCH_IN', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'ESPP_CONTRIBUTION') THEN COALESCE(amount, 0)
      WHEN transaction_type IN ('SELL', 'REDEMPTION', 'WITHDRAWAL', 'TRANSFER_OUT', 'SWITCH_OUT', 'CHARGES', 'AMC') THEN -COALESCE(amount, 0)
      WHEN transaction_type = 'TDS' THEN -ABS(COALESCE(amount, 0))
      ELSE 0
    END), 0) AS net_flow
    FROM transactions
    WHERE investment_id = ? AND portfolio_id = ? AND date(transaction_date) = ?
  `);

  let written = 0;
  let lastNonZeroDate = null;
  let exitDate = null;
  const dayStride = progressLogStride(dates.length, 20);
  const isProvidentAsset = inv.asset_type === 'PF' || inv.asset_type === 'PPF' || inv.asset_type === 'SSY';
  for (const date of dates) {
    const unitsRow = getUnits.get(...baseParams, date);
    const units = Number(unitsRow?.total || 0);
    const invested = Number(getInvested.get(...baseParams, date)?.total || 0);

    // Stop writing trailing zero-unit rows after exit for all unit-based assets.
    if (latestTxnDate && date > latestTxnDate && units <= 0 && !isProvidentAsset) {
      break;
    }

    const priced = await getPriceForDate(db, inv, date, cache, portfolioId);
    let price = Number(priced.price || 0);
    let priceSource = priced.source || 'COMPUTED';
    let currentValue = 0;
    let totalUnits = units;

    if (isProvidentAsset) {
      currentValue = getProvidentValue(db, inv, date, portfolioId);
      totalUnits = 1;
      if (!price) {
        const rateRow = db.prepare(
          'SELECT rate FROM interest_rates WHERE rate_type = ? AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?) ORDER BY effective_from DESC LIMIT 1'
        ).get(inv.asset_type, date, date);
        price = Number(rateRow?.rate || 0);
      }
      priceSource = 'COMPUTED';
    } else if (inv.asset_type === 'FOREIGN_STOCK') {
      const fxKey = date;
      let fxRate = cache.fx.get(fxKey);
      if (fxRate == null) {
        fxRate = await fetchHistoricalUSDToINR(date).catch(() => 0);
        cache.fx.set(fxKey, Number(fxRate || 0));
      }
      currentValue = units * price * Number(fxRate || 0);
    } else {
      currentValue = units * price;
    }

    const realized = computeRealizedProceeds(db, inv, date, portfolioId);
    const reinvestType = inv.asset_type === 'PF' || inv.asset_type === 'PPF' || inv.asset_type === 'SSY';
    const realizedGain = inv.asset_type === 'PF'
      ? realized
      : (reinvestType ? 0 : realized);
    const profitLoss = reinvestType
      ? currentValue - invested
      : currentValue + realized - invested;
    const profitLossPct = invested > 0 ? (profitLoss / invested) * 100 : 0;

    if (units > 0.000001) {
      lastNonZeroDate = date;
    } else if (latestTxnDate && date >= latestTxnDate && !exitDate) {
      exitDate = date;
    }

    // Query portfolio-scoped rows
    const prev = getPrev.get(inv.id, portfolioId, date);
    const prevValue = Number(prev?.current_value || 0);
    const netFlow = computeNetFlowForDate(db, inv, date, portfolioId, {
      getNetFlow,
      getNetFlowPortfolio,
    });
    const dayChange = currentValue - prevValue - netFlow;
    const dayChangePct = prevValue > 0 ? (dayChange / prevValue) * 100 : 0;

    upsertDailyRow(db, {
      investment_id: inv.id,
      portfolio_id: portfolioId,
      date,
      price_per_unit: price,
      total_units: isProvidentAsset
        ? 1
        : units,
      current_value: currentValue,
      invested_amount: invested,
      realized_proceeds: realizedGain,
      profit_loss: profitLoss,
      price_source: priceSource,
      day_change: dayChange,
    }, dailyStatements);
    written += 1;

    if (typeof onProgress === 'function' && (written === dates.length || written % dayStride === 0)) {
      onProgress({
        processedDays: written,
        totalDays: dates.length,
        date,
      });
    }

    // Yield periodically so heartbeat/log updates are not starved by long sync loops.
    if (written % 200 === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  if (latestTxnDate && (lastNonZeroDate || exitDate)) {
    db.prepare(
      'UPDATE investments SET last_active_date = ?, updated_at = datetime(\'now\') WHERE id = ?'
    ).run(lastNonZeroDate || exitDate || latestTxnDate, inv.id);
  } else if (!latestTxnDate) {
    db.prepare(
      'UPDATE investments SET last_active_date = NULL, updated_at = datetime(\'now\') WHERE id = ?'
    ).run(inv.id);
  }

  return written;
}

function holdingUnitsAtDate(db, investmentId, portfolioId, date, excludeSameDayTrading = false, excludeSameDayCorporateUnitAdds = false) {
  const rows = db.prepare(`
    SELECT transaction_type, COALESCE(units, 0) AS units, transaction_date
    FROM transactions
    WHERE investment_id = ? AND portfolio_id = ? AND transaction_date <= ?
    ORDER BY transaction_date ASC, id ASC
  `).all(investmentId, portfolioId, date);

  const corporateTypes = new Set(['BONUS', 'SPLIT', 'RIGHTS', 'MERGER', 'CONSOLIDATION', 'DIVIDEND', 'INTEREST']);
  const sameDayCorporateUnitAdds = new Set(['BONUS', 'SPLIT', 'RIGHTS']);
  let units = 0;
  for (const row of rows) {
    if (excludeSameDayTrading && row.transaction_date === date && !corporateTypes.has(row.transaction_type)) {
      continue;
    }
    if (excludeSameDayCorporateUnitAdds && row.transaction_date === date && sameDayCorporateUnitAdds.has(row.transaction_type)) {
      continue;
    }

    if (['BUY', 'IPO', 'BONUS', 'SPLIT', 'RIGHTS', 'TRANSFER_IN', 'SWITCH_IN', 'DEPOSIT', 'VEST', 'ESPP_PURCHASE'].includes(row.transaction_type)) {
      units += Number(row.units || 0);
    } else if (['SELL', 'TRANSFER_OUT', 'SWITCH_OUT', 'WITHDRAWAL', 'CONSOLIDATION', 'CHARGES', 'AMC'].includes(row.transaction_type)) {
      units -= Number(row.units || 0);
    }
  }
  return Math.round(units * 1000) / 1000;
}

function toRecordSnapshot(row) {
  if (!row) return null;
  return {
    units: Number(row.units == null ? 0 : row.units),
    pricePerUnit: Number(row.price_per_unit == null ? 0 : row.price_per_unit),
    amount: Number(row.amount == null ? 0 : row.amount),
    notes: row.notes || null,
    broker: row.broker || null,
    fxRate: row.exchange_rate_used == null ? null : Number(row.exchange_rate_used),
    usdAmount: row.usd_amount == null ? null : Number(row.usd_amount),
  };
}

async function syncCorporateActionsForScope(db, inv, portfolioId, fromDate, toDate, cache) {
  if (portfolioId == null) return 0;
  if (inv.asset_type !== 'INDIAN_STOCK' && inv.asset_type !== 'FOREIGN_STOCK') return 0;
  if (!inv.ticker_symbol) return 0;

  const fromYear = Number(fromDate.slice(0, 4));
  const toYear = Number(toDate.slice(0, 4));
  const ticker = inv.asset_type === 'INDIAN_STOCK' && !inv.ticker_symbol.includes('.')
    ? `${inv.ticker_symbol}.NS`
    : inv.ticker_symbol;

  const insertTxn = db.prepare(`
    INSERT INTO transactions (
      investment_id,
      portfolio_id,
      transaction_type,
      transaction_date,
      units,
      price_per_unit,
      amount,
      fees,
      notes,
      broker,
      exchange_rate_used,
      usd_amount
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
  `);

  const selectByKey = db.prepare(`
    SELECT id, locked, units, price_per_unit, amount, notes, broker, exchange_rate_used, usd_amount
    FROM transactions
    WHERE investment_id = ?
      AND portfolio_id = ?
      AND transaction_date = ?
      AND transaction_type = ?
    ORDER BY id ASC
  `);

  const updateById = db.prepare(`
    UPDATE transactions
    SET units = ?,
        price_per_unit = ?,
        amount = ?,
        notes = ?,
        broker = ?,
        exchange_rate_used = ?,
        usd_amount = ?
    WHERE id = ?
  `);

  const deleteById = db.prepare('DELETE FROM transactions WHERE id = ?');

  const nearlyEqual = (a, b) => {
    const x = Number(a == null ? 0 : a);
    const y = Number(b == null ? 0 : b);
    return Math.abs(x - y) < 0.000001;
  };

  function upsertCorporateActionTxn(desired) {
    const normalizedDesired = {
      ...desired,
      units: quantizeForStorage(desired.units),
      pricePerUnit: quantizeForStorage(desired.pricePerUnit),
      amount: quantizeForStorage(desired.amount),
      fxRate: quantizeNullableForStorage(desired.fxRate),
      usdAmount: quantizeNullableForStorage(desired.usdAmount),
    };

    const rows = selectByKey.all(
      normalizedDesired.investmentId,
      normalizedDesired.portfolioId,
      normalizedDesired.date,
      normalizedDesired.transactionType
    );

    if (!rows.length) {
      const insertRes = insertTxn.run(
        normalizedDesired.investmentId,
        normalizedDesired.portfolioId,
        normalizedDesired.transactionType,
        normalizedDesired.date,
        normalizedDesired.units,
        normalizedDesired.pricePerUnit,
        normalizedDesired.amount,
        normalizedDesired.notes,
        normalizedDesired.broker,
        normalizedDesired.fxRate,
        normalizedDesired.usdAmount
      );
      return {
        changeType: 'inserted',
        recordId: Number(insertRes.lastInsertRowid),
        previous: null,
        next: {
          units: Number(normalizedDesired.units == null ? 0 : normalizedDesired.units),
          pricePerUnit: Number(normalizedDesired.pricePerUnit == null ? 0 : normalizedDesired.pricePerUnit),
          amount: Number(normalizedDesired.amount == null ? 0 : normalizedDesired.amount),
          notes: normalizedDesired.notes || null,
          broker: normalizedDesired.broker || null,
          fxRate: normalizedDesired.fxRate == null ? null : Number(normalizedDesired.fxRate),
          usdAmount: normalizedDesired.usdAmount == null ? null : Number(normalizedDesired.usdAmount),
        },
        deletedDuplicateIds: [],
        locked: false,
      };
    }

    const lockedRow = rows.find((r) => Number(r.locked || 0) === 1);
    const canonical = lockedRow || rows[0];
    let changed = false;
    const deletedDuplicateIds = [];

    for (const r of rows) {
      if (r.id === canonical.id) continue;
      if (Number(r.locked || 0) === 1) continue;
      deleteById.run(r.id);
      deletedDuplicateIds.push(r.id);
      changed = true;
    }

    if (Number(canonical.locked || 0) === 1) {
      return {
        changeType: changed ? 'updated' : 'unchanged',
        recordId: canonical.id,
        previous: toRecordSnapshot(canonical),
        next: toRecordSnapshot(canonical),
        deletedDuplicateIds,
        locked: true,
      };
    }

    const needsUpdate =
      !nearlyEqual(canonical.units, normalizedDesired.units) ||
      !nearlyEqual(canonical.price_per_unit, normalizedDesired.pricePerUnit) ||
      !nearlyEqual(canonical.amount, normalizedDesired.amount) ||
      String(canonical.notes || '') !== String(normalizedDesired.notes || '') ||
      String(canonical.broker || '') !== String(normalizedDesired.broker || '') ||
      !nearlyEqual(canonical.exchange_rate_used, normalizedDesired.fxRate) ||
      !nearlyEqual(canonical.usd_amount, normalizedDesired.usdAmount);

    if (needsUpdate) {
      updateById.run(
        normalizedDesired.units,
        normalizedDesired.pricePerUnit,
        normalizedDesired.amount,
        normalizedDesired.notes,
        normalizedDesired.broker,
        normalizedDesired.fxRate,
        normalizedDesired.usdAmount,
        canonical.id
      );
      changed = true;
    }

    return {
      changeType: changed ? 'updated' : 'unchanged',
      recordId: canonical.id,
      previous: toRecordSnapshot(canonical),
      next: {
        units: Number(normalizedDesired.units == null ? 0 : normalizedDesired.units),
        pricePerUnit: Number(normalizedDesired.pricePerUnit == null ? 0 : normalizedDesired.pricePerUnit),
        amount: Number(normalizedDesired.amount == null ? 0 : normalizedDesired.amount),
        notes: normalizedDesired.notes || null,
        broker: normalizedDesired.broker || null,
        fxRate: normalizedDesired.fxRate == null ? null : Number(normalizedDesired.fxRate),
        usdAmount: normalizedDesired.usdAmount == null ? null : Number(normalizedDesired.usdAmount),
      },
      deletedDuplicateIds,
      locked: false,
    };
  }

  let inserted = 0;
  let updated = 0;
  let earliestChangedDate = null;
  const caChanges = [];

  const markChangedDate = (date) => {
    if (!date) return;
    if (!earliestChangedDate || date < earliestChangedDate) {
      earliestChangedDate = date;
    }
  };

  for (let year = fromYear; year <= toYear; year += 1) {
    const actionCacheKey = `${inv.id}:${portfolioId}:${year}`;
    let actions = cache.actions.get(actionCacheKey);
    if (!actions) {
      actions = await fetchCorporateActions(ticker, year, { assetType: inv.asset_type }).catch(() => ({ dividends: [], splits: [] }));
      cache.actions.set(actionCacheKey, actions || { dividends: [], splits: [] });
    }

    for (const div of actions.dividends || []) {
      const eventDate = inv.asset_type === 'FOREIGN_STOCK'
        ? (div.payment_date || div.date)
        : div.date;
      const recordDate = inv.asset_type === 'FOREIGN_STOCK'
        ? (div.record_date || div.date)
        : div.date;

      if (!eventDate || eventDate < fromDate || eventDate > toDate) continue;
      // Dividend entitlement calculated on previous day's holding (record date - 1)
      const prevDay = new Date(recordDate || eventDate);
      prevDay.setDate(prevDay.getDate() - 1);
      const prevDayStr = prevDay.toISOString().split('T')[0];
      const units = holdingUnitsAtDate(db, inv.id, portfolioId, prevDayStr, true, true);
      if (units <= 0) continue;

      const perShare = Number(div.amount || 0);
      if (!(perShare > 0)) continue;

      let fxRate = null;
      let usdAmount = null;
      let amount = units * perShare;
      if (inv.asset_type === 'FOREIGN_STOCK') {
        usdAmount = amount;
        fxRate = cache.fx.get(eventDate);
        if (fxRate == null) {
          fxRate = await fetchHistoricalUSDToINR(eventDate).catch(() => 0);
          cache.fx.set(eventDate, Number(fxRate || 0));
        }
        if (!(fxRate > 0)) continue;
        amount = usdAmount * Number(fxRate);
      }

      const notes = `AutoBackfill CA Dividend ${perShare} x ${units}`;
      const change = upsertCorporateActionTxn({
        investmentId: inv.id,
        portfolioId,
        transactionType: 'DIVIDEND',
        date: eventDate,
        units,
        pricePerUnit: perShare,
        amount,
        notes,
        broker: null,
        fxRate: fxRate ? Number(fxRate) : null,
        usdAmount,
      });
      const changeType = change?.changeType || 'unchanged';
      if (changeType !== 'unchanged') {
        if (changeType === 'inserted') inserted += 1;
        else updated += 1;
        markChangedDate(eventDate);
        caChanges.push({
          action: changeType,
          recordId: change.recordId,
          investmentId: inv.id,
          investmentName: inv.name,
          portfolioId,
          transactionType: 'DIVIDEND',
          transactionDate: eventDate,
          previous: change.previous,
          next: change.next,
          deletedDuplicateIds: change.deletedDuplicateIds || [],
          locked: !!change.locked,
        });
      }
    }

    for (const split of actions.splits || []) {
      const eventDate = split.date;
      if (!eventDate || eventDate < fromDate || eventDate > toDate) continue;

      const ratio = Number(split.numerator || 0) / Number(split.denominator || 0);
      if (!(ratio > 1)) continue;

      // Split/bonus entitlement is based on previous day's holdings.
      const prevDay = new Date(eventDate);
      prevDay.setDate(prevDay.getDate() - 1);
      const prevDayStr = prevDay.toISOString().split('T')[0];
      const held = holdingUnitsAtDate(db, inv.id, portfolioId, prevDayStr, true, true);
      if (held <= 0) continue;

      const cleanSplit = Number(split.denominator) === 1 && Number(split.numerator) >= 2 && Number.isInteger(ratio);
      const txnType = cleanSplit ? 'SPLIT' : 'BONUS';
      const addedUnitsRaw = held * (ratio - 1);
      const isIndianStock = inv.asset_type === 'INDIAN_STOCK';
      const addedUnits = isIndianStock
        ? Math.max(0, Math.floor(addedUnitsRaw + 0.000000001))
        : addedUnitsRaw;
      if (addedUnits <= 0) continue;

      // For Indian stocks, bonus/split grants are whole shares and residue is cash payout.
      const fractional = isIndianStock
        ? Math.max(0, addedUnitsRaw - addedUnits)
        : (txnType === 'BONUS' ? Math.max(0, addedUnitsRaw - addedUnits) : 0);
      let fractionalAmount = 0;
      if (fractional > 0.0001) {
        // Use previous day's LOW price for fractional payout calculation
        const prevDay = new Date(eventDate);
        prevDay.setDate(prevDay.getDate() - 1);
        const prevDayStr = prevDay.toISOString().split('T')[0];
        const ohlc = await fetchHistoricalOHLC(ticker, prevDayStr).catch(() => null);
        const lowPrice = ohlc?.low || 0;
        fractionalAmount = lowPrice > 0 ? (fractional * lowPrice) : 0;
      }

      const notes = fractional > 0.0001
        ? `AutoBackfill CA ${txnType} ${split.numerator}:${split.denominator} + \u20B9${fractionalAmount} fractional payout`
        : `AutoBackfill CA ${txnType} ${split.numerator}:${split.denominator}`;
      const change = upsertCorporateActionTxn({
        investmentId: inv.id,
        portfolioId,
        transactionType: txnType,
        date: eventDate,
        units: addedUnits,
        pricePerUnit: 0,
        amount: fractionalAmount,
        notes,
        broker: null,
        fxRate: null,
        usdAmount: null,
      });
      const changeType = change?.changeType || 'unchanged';
      if (changeType !== 'unchanged') {
        if (changeType === 'inserted') inserted += 1;
        else updated += 1;
        markChangedDate(eventDate);
        caChanges.push({
          action: changeType,
          recordId: change.recordId,
          investmentId: inv.id,
          investmentName: inv.name,
          portfolioId,
          transactionType: txnType,
          transactionDate: eventDate,
          previous: change.previous,
          next: change.next,
          deletedDuplicateIds: change.deletedDuplicateIds || [],
          locked: !!change.locked,
        });
      }
    }
  }

  return {
    inserted,
    updated,
    modified: inserted + updated,
    earliestChangedDate,
    caChanges,
  };
}

function normalizeScopesForRun(db, scopes, runDate) {
  const eligible = (scopes || []).filter((s) => String(s.dirty_from_date) <= runDate);
  const grouped = new Map();
  const portfolioIdsByInvestment = new Map();

  const addScope = (investmentId, portfolioId, dirtyFromDate) => {
    const invId = investmentId == null ? 'null' : String(investmentId);
    const pid = String(portfolioId);
    const key = `${invId}:${pid}`;
    const existing = grouped.get(key);
    if (!existing || dirtyFromDate < existing.dirty_from_date) {
      grouped.set(key, {
        investment_id: investmentId,
        portfolio_id: portfolioId,
        dirty_from_date: dirtyFromDate,
      });
    }
  };

  for (const s of eligible) {
    if (s.investment_id == null) continue;

    if (s.portfolio_id != null) {
      addScope(s.investment_id, s.portfolio_id, s.dirty_from_date);
      continue;
    }

    // Legacy/global scopes can still be present (for example scheduler catch-up).
    // Expand them to concrete transaction portfolios so recompute is not skipped.
    if (!portfolioIdsByInvestment.has(s.investment_id)) {
      const portfolioRows = db.prepare(`
        SELECT DISTINCT portfolio_id
        FROM transactions
        WHERE investment_id = ?
          AND portfolio_id IS NOT NULL
          AND date(transaction_date) <= ?
      `).all(s.investment_id, runDate);
      portfolioIdsByInvestment.set(
        s.investment_id,
        portfolioRows
          .map((row) => row.portfolio_id)
          .filter((pid) => pid != null)
      );
    }

    const portfolioIds = portfolioIdsByInvestment.get(s.investment_id) || [];
    for (const pid of portfolioIds) {
      addScope(s.investment_id, pid, s.dirty_from_date);
    }
  }

  return {
    eligible,
    scopeList: Array.from(grouped.values()).filter((s) => s.investment_id != null),
  };
}

function mergeDirtyDateIntoScopes(scopeList, investmentId, portfolioId, dirtyFromDate) {
  if (!dirtyFromDate || investmentId == null) return;
  let matched = false;

  for (const s of scopeList) {
    if (s.investment_id !== investmentId) continue;
    const samePortfolio = (s.portfolio_id == null && portfolioId == null) || s.portfolio_id === portfolioId;
    if (!samePortfolio) continue;
    if (dirtyFromDate < s.dirty_from_date) {
      s.dirty_from_date = dirtyFromDate;
    }
    matched = true;
  }

  if (!matched) {
    scopeList.push({
      investment_id: investmentId,
      portfolio_id: portfolioId,
      dirty_from_date: dirtyFromDate,
    });
  }

  if (portfolioId != null) {
    mergeDirtyDateIntoScopes(scopeList, investmentId, null, dirtyFromDate);
  }
}

function getImpactedInvestmentStartDates(db, scopeList, runDate) {
  const invIds = Array.from(new Set(scopeList.map((s) => s.investment_id).filter((id) => id != null)));
  const startByInvestment = new Map();
  if (!invIds.length) return startByInvestment;

  const placeholders = invIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT investment_id, MIN(date(transaction_date)) AS min_txn_date
    FROM transactions
    WHERE investment_id IN (${placeholders})
    GROUP BY investment_id
  `).all(...invIds);

  const minScopeDateByInvestment = new Map();
  for (const s of scopeList) {
    const current = minScopeDateByInvestment.get(s.investment_id);
    if (!current || s.dirty_from_date < current) {
      minScopeDateByInvestment.set(s.investment_id, s.dirty_from_date);
    }
  }

  for (const invId of invIds) {
    const row = rows.find((r) => r.investment_id === invId);
    const minTxnDate = row?.min_txn_date || null;
    const minDirtyDate = minScopeDateByInvestment.get(invId) || null;

    const txnStart = minTxnDate ? addDays(minTxnDate, -1) : null;
    const dirtyStart = minDirtyDate ? addDays(minDirtyDate, -1) : null;

    // Reuse prior backfill windows by preferring the later start date.
    // start = max((earliest_txn - 1d), (least_dirty - 1d)) with safe fallbacks.
    let startDate = null;
    if (txnStart && dirtyStart) {
      startDate = txnStart >= dirtyStart ? txnStart : dirtyStart;
    } else {
      startDate = txnStart || dirtyStart || addDays(runDate, -1);
    }

    startByInvestment.set(invId, startDate);
  }

  return startByInvestment;
}

function getMarketHistoryFetchStartDates(db, scopeList, invMap, runDate) {
  const marketInvIds = Array.from(new Set(
    scopeList
      .map((s) => s.investment_id)
      .filter((id) => {
        const inv = invMap.get(id);
        return inv && ['INDIAN_STOCK', 'FOREIGN_STOCK', 'SGB'].includes(inv.asset_type);
      })
  ));

  const startByInvestment = new Map();
  if (!marketInvIds.length) return startByInvestment;

  const placeholders = marketInvIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT investment_id, MIN(date(transaction_date)) AS min_txn_date
    FROM transactions
    WHERE investment_id IN (${placeholders})
    GROUP BY investment_id
  `).all(...marketInvIds);

  const minScopeDateByInvestment = new Map();
  for (const s of scopeList) {
    const inv = invMap.get(s.investment_id);
    if (!inv || !['INDIAN_STOCK', 'FOREIGN_STOCK', 'SGB'].includes(inv.asset_type)) continue;
    const current = minScopeDateByInvestment.get(s.investment_id);
    if (!current || s.dirty_from_date < current) {
      minScopeDateByInvestment.set(s.investment_id, s.dirty_from_date);
    }
  }

  for (const invId of marketInvIds) {
    const row = rows.find((r) => r.investment_id === invId);
    const minTxnDate = row?.min_txn_date || null;
    const minDirtyDate = minScopeDateByInvestment.get(invId) || null;

    const txnStart = minTxnDate ? addDays(minTxnDate, -1) : null;
    const dirtyStart = minDirtyDate ? addDays(minDirtyDate, -1) : null;

    let startDate = null;
    if (txnStart && dirtyStart) {
      startDate = txnStart >= dirtyStart ? txnStart : dirtyStart;
    } else {
      startDate = txnStart || dirtyStart || runDate;
    }

    startByInvestment.set(invId, startDate);
  }

  return startByInvestment;
}

async function preloadStockHistoryForRun(invMap, scopeList, runDate, fetchStartByInvestment, cache) {
  const symbolStart = new Map();
  const sgbSymbolStart = new Map();
  for (const s of scopeList) {
    const inv = invMap.get(s.investment_id);
    if (!inv) continue;
    if (!['INDIAN_STOCK', 'FOREIGN_STOCK', 'SGB'].includes(inv.asset_type)) continue;
    if (!inv.ticker_symbol) continue;
    const startDate = fetchStartByInvestment.get(inv.id) || s.dirty_from_date;
    const targetMap = inv.asset_type === 'SGB' ? sgbSymbolStart : symbolStart;
    const existing = targetMap.get(inv.ticker_symbol);
    if (!existing || startDate < existing) {
      targetMap.set(inv.ticker_symbol, startDate);
    }
  }

  cache.stockRangeBySymbol = symbolStart;
  cache.sgbRangeBySymbol = sgbSymbolStart;
  const totalSymbols = symbolStart.size;
  if (totalSymbols > 0) {
    logBackfillInfo(`[Backfill][Step-1] Prefetching historical prices for ${totalSymbols} symbol(s)...`);
  }

  let fetched = 0;
  const stride = progressLogStride(totalSymbols, 8);
  for (const [symbol, startDate] of symbolStart.entries()) {
    if (cache.stock.has(symbol)) continue;
    const series = await fetchStockSeries(symbol, startDate, runDate).catch(() => new Map());
    cache.stock.set(symbol, series);
    fetched += 1;
    if (fetched === totalSymbols || fetched % stride === 0) {
      logBackfillInfo(`[Backfill][Step-1] Price prefetch ${fetched}/${totalSymbols}`);
    }
  }

  if (totalSymbols > 0) {
    logBackfillInfo('[Backfill][Step-1] Historical price prefetch completed.');
  }
}

async function processAutoBackfillCAEntries(db, options = {}) {
  const {
    scopeList = [],
    runDate = todayIso(),
    invMap = new Map(),
    cache,
    startByInvestment = new Map(),
  } = options;

  let inserted = 0;
  let updated = 0;
  let earliestChangedDate = null;
  const allCaChanges = [];

  const invIds = Array.from(new Set(scopeList.map((s) => s.investment_id).filter((id) => id != null)));
  const corporateActionSyncPairs = new Map();
  if (invIds.length) {
    const placeholders = invIds.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT DISTINCT investment_id, portfolio_id
      FROM transactions
      WHERE investment_id IN (${placeholders})
        AND portfolio_id IS NOT NULL
        AND date(transaction_date) <= ?
    `).all(...invIds, runDate);

    for (const row of rows) {
      const key = `${row.investment_id}:${row.portfolio_id}`;
      if (corporateActionSyncPairs.has(key)) continue;
      corporateActionSyncPairs.set(key, {
        investmentId: row.investment_id,
        portfolioId: row.portfolio_id,
        fromDate: startByInvestment.get(row.investment_id) || runDate,
      });
    }
  }

  const bringDirtyDateEarlier = db.prepare(`
    UPDATE dirty_backfill_scope
    SET dirty_from_date = CASE
      WHEN dirty_from_date <= ? THEN dirty_from_date
      ELSE ?
    END,
    updated_at = datetime('now')
    WHERE investment_id = ?
      AND ((portfolio_id IS NULL AND ? IS NULL) OR portfolio_id = ?)
      AND status IN ('pending', 'running')
  `);

  const totalPairs = corporateActionSyncPairs.size;
  logBackfillInfo(`[Backfill][Step-1] Processing AutoBackfill CA for ${totalPairs} investment-portfolio pair(s)...`);
  const stride = progressLogStride(totalPairs, 10);
  let donePairs = 0;

  for (const pair of corporateActionSyncPairs.values()) {
    const inv = invMap.get(pair.investmentId);
    if (inv) {
      const result = await syncCorporateActionsForScope(db, inv, pair.portfolioId, pair.fromDate, runDate, cache);
      inserted += Number(result?.inserted || 0);
      updated += Number(result?.updated || 0);
      if (Array.isArray(result?.caChanges) && result.caChanges.length) {
        allCaChanges.push(...result.caChanges);
      }
      const changedDate = result?.earliestChangedDate || null;
      if (changedDate && (!earliestChangedDate || changedDate < earliestChangedDate)) {
        earliestChangedDate = changedDate;
      }

      if (changedDate) {
        mergeDirtyDateIntoScopes(scopeList, pair.investmentId, pair.portfolioId, changedDate);
        bringDirtyDateEarlier.run(changedDate, changedDate, pair.investmentId, pair.portfolioId, pair.portfolioId);
        bringDirtyDateEarlier.run(changedDate, changedDate, pair.investmentId, null, null);
      }
    }

    donePairs += 1;
    if (donePairs === totalPairs || donePairs % stride === 0) {
      logBackfillInfo(`[Backfill][Step-1] CA sync ${donePairs}/${totalPairs} | inserted=${inserted}, updated=${updated}`);
    }
  }

  logBackfillInfo(`[Backfill][Step-1] Completed AutoBackfill CA. inserted=${inserted}, updated=${updated}, modified=${inserted + updated}`);
  if (allCaChanges.length) {
    for (const change of allCaChanges) {
      logBackfillInfo('[Backfill][Step-1][CA-Change] ' + JSON.stringify(change));
    }
  }

  return {
    inserted,
    updated,
    modified: inserted + updated,
    earliestChangedDate,
    caChanges: allCaChanges,
  };
}

async function updateDailyValues(db, options = {}) {
  const {
    scopeList = [],
    runDate = todayIso(),
    invMap = new Map(),
    cache,
  } = options;

  const details = [];
  let totalRows = 0;
  let completedScopes = 0;
  let earliestTouchedDate = runDate;
  const totalScopes = scopeList.length;
  const stride = progressLogStride(totalScopes, 10);
  let lastScopeHeartbeatAt = Date.now();

  logBackfillInfo(`[Backfill][Step-2] Recomputing daily values for ${totalScopes} scope(s)...`);

  for (const scope of scopeList) {
    const inv = invMap.get(scope.investment_id);
    if (!inv) continue;

    const fromDate = scope.dirty_from_date;
    if (fromDate < earliestTouchedDate) earliestTouchedDate = fromDate;

    setBackfillProgress(db, {
      phase: 'running',
      total: scopeList.length,
      completed: completedScopes,
      current: {
        investment_id: scope.investment_id,
        portfolio_id: scope.portfolio_id,
        dirty_from_date: fromDate,
      },
      message: `Recomputing ${scope.investment_id}:${scope.portfolio_id ?? 'ALL'}`,
      runDate,
      startedAt: new Date().toISOString(),
    });

    const rows = await recomputeScopeRows(
      db,
      inv,
      scope.portfolio_id,
      fromDate,
      runDate,
      cache,
      ({ processedDays, totalDays, date }) => {
        if (!shouldHeartbeat(lastScopeHeartbeatAt, 60_000) && processedDays !== totalDays) return;
        lastScopeHeartbeatAt = Date.now();

        const scopeLabel = `${scope.investment_id}:${scope.portfolio_id ?? 'ALL'}`;
        const message = `Running scope ${completedScopes + 1}/${scopeList.length} (${scopeLabel}) day ${processedDays}/${totalDays} @ ${date}`;

        setBackfillProgress(db, {
          phase: 'running',
          total: scopeList.length,
          completed: completedScopes,
          current: {
            investment_id: scope.investment_id,
            portfolio_id: scope.portfolio_id,
            dirty_from_date: fromDate,
          },
          message,
          runDate,
          startedAt: new Date().toISOString(),
        });

        logBackfillInfo(`[Backfill][Step-2][Heartbeat] ${message}`);
      }
    );
    totalRows += rows;
    completedScopes += 1;
    details.push({
      investment_id: scope.investment_id,
      portfolio_id: scope.portfolio_id,
      from_date: fromDate,
      to_date: runDate,
      rows,
    });

    setBackfillProgress(db, {
      phase: 'running',
      total: scopeList.length,
      completed: completedScopes,
      current: null,
      message: `Completed ${completedScopes}/${scopeList.length}`,
      runDate,
      startedAt: new Date().toISOString(),
    });

    if (completedScopes === totalScopes || completedScopes % stride === 0) {
      logBackfillInfo(`[Backfill][Step-2] Scope ${completedScopes}/${totalScopes} complete | rowsWritten=${totalRows}`);
    }
  }

  const previousResume = readAggregateResumeState(db);
  const canResume = previousResume
    && previousResume.runDate === runDate
    && previousResume.rangeStart === earliestTouchedDate
    && previousResume.rangeEnd === runDate
    && previousResume.nextDate
    && previousResume.nextDate >= earliestTouchedDate
    && previousResume.nextDate <= runDate;

  const aggregateStartDate = canResume ? previousResume.nextDate : earliestTouchedDate;
  const aggregateDates = eachDate(aggregateStartDate, runDate);
  const aggregateTotal = aggregateDates.length;
  const aggregateStride = progressLogStride(aggregateTotal, 20);
  let lastAggregateHeartbeatAt = Date.now();
  const aggregateStartedAtMs = Date.now();

  if (canResume) {
    logBackfillInfo(`[Backfill][Step-2] Resuming aggregate refresh from ${aggregateStartDate} (range ${earliestTouchedDate} to ${runDate})...`);
  } else {
    logBackfillInfo(`[Backfill][Step-2] Refreshing aggregate tables from ${earliestTouchedDate} to ${runDate}...`);
  }

  writeAggregateResumeState(db, {
    runDate,
    rangeStart: earliestTouchedDate,
    rangeEnd: runDate,
    nextDate: aggregateStartDate,
  });

  setBackfillProgress(db, {
    phase: 'finalizing',
    total: scopeList.length,
    completed: scopeList.length,
    current: null,
    message: `Refreshing daily aggregates: completed=0, remaining=${aggregateTotal}, progress=0.00%`,
    runDate,
    startedAt: new Date().toISOString(),
  });

  for (let i = 0; i < aggregateDates.length; i += 1) {
    const d = aggregateDates[i];
    db.exec('BEGIN IMMEDIATE');
    try {
      updatePortfolioDaily(db, d);
      updateAssetTypeDaily(db, d);
      db.exec('COMMIT');
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch (_) {
        // best-effort rollback
      }
      throw e;
    }

    const done = i + 1;
    const nextDate = done < aggregateTotal ? addDays(d, 1) : null;
    if (nextDate) {
      writeAggregateResumeState(db, {
        runDate,
        rangeStart: earliestTouchedDate,
        rangeEnd: runDate,
        nextDate,
      });
    }

    const shouldLog = done === aggregateTotal || (done % aggregateStride === 0) || shouldHeartbeat(lastAggregateHeartbeatAt, 60_000);
    if (shouldLog) {
      lastAggregateHeartbeatAt = Date.now();
      const remaining = Math.max(aggregateTotal - done, 0);
      const pct = aggregateTotal > 0 ? (done / aggregateTotal) * 100 : 100;
      const elapsedMs = Math.max(Date.now() - aggregateStartedAtMs, 1);
      const perDayMs = done > 0 ? elapsedMs / done : 0;
      const etaMs = Math.max(Math.round(perDayMs * remaining), 0);
      const etaSeconds = Math.ceil(etaMs / 1000);
      const message = `Refreshing daily aggregates: completed=${done}/${aggregateTotal}, remaining=${remaining}, progress=${pct.toFixed(2)}%, current_date=${d}, eta_seconds=${etaSeconds}`;
      setBackfillProgress(db, {
        phase: 'finalizing',
        total: scopeList.length,
        completed: scopeList.length,
        current: null,
        message,
        runDate,
        startedAt: new Date().toISOString(),
      });
      logBackfillInfo(`[Backfill][Step-2][Heartbeat] ${message}`);
    }

    if (done % 60 === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  clearAggregateResumeState(db);

  setBackfillProgress(db, {
    phase: 'finalizing',
    total: scopeList.length,
    completed: scopeList.length,
    current: null,
    message: 'Refreshing daily aggregates',
    runDate,
    startedAt: new Date().toISOString(),
  });

  logBackfillInfo(`[Backfill][Step-2] Completed daily recompute. scopes=${totalScopes}, rowsWritten=${totalRows}`);

  return {
    rowsWritten: totalRows,
    details,
    earliestTouchedDate,
  };
}

/**
 * Backfill scopes whose dirty_from_date is <= runDate.
 * Future-dated scopes are intentionally skipped until their date arrives.
 */
async function backfillDirtyScopes(db, scopes, options = {}) {
  const runDate = clampEndDateToToday(options.runDate || todayIso());
  const { eligible, scopeList } = normalizeScopesForRun(db, scopes, runDate);

  logBackfillInfo(`[Backfill] Eligible scopes for ${runDate}: ${eligible.length}/${(scopes || []).length}`);

  if (!eligible.length) {
    return {
      runDate,
      processed: 0,
      skippedFuture: (scopes || []).length,
      details: [],
    };
  }

  const invIds = Array.from(new Set(scopeList.map((s) => s.investment_id)));
  const invMap = new Map();
  if (invIds.length) {
    const placeholders = invIds.map(() => '?').join(',');
    const rows = db.prepare(`SELECT * FROM investments WHERE id IN (${placeholders})`).all(...invIds);
    for (const row of rows) invMap.set(row.id, row);
  }

  const startByInvestment = getImpactedInvestmentStartDates(db, scopeList, runDate);
  const fetchStartByInvestment = getMarketHistoryFetchStartDates(db, scopeList, invMap, runDate);
  const cache = {
    mf: new Map(),
    nps: new Map(),
    stock: new Map(),
    fx: new Map(),
    actions: new Map(),
    stockRangeBySymbol: new Map(),
    allowNetworkFallback: false,
    rangeStart: Array.from(fetchStartByInvestment.values()).reduce((m, s) => (m == null || s < m ? s : m), null)
      || scopeList.reduce((m, s) => (m == null || s.dirty_from_date < m ? s.dirty_from_date : m), null)
      || runDate,
    rangeEnd: runDate,
  };

  await preloadStockHistoryForRun(invMap, scopeList, runDate, fetchStartByInvestment, cache);

  const step1Result = await processAutoBackfillCAEntries(db, {
    scopeList,
    runDate,
    invMap,
    cache,
    startByInvestment,
  });

  if (options.step1Only === true) {
    logBackfillInfo(`[Backfill] Step-1 only mode completed. modified=${Number(step1Result?.modified || 0)}`);
    return {
      runDate,
      processed: scopeList.length,
      skippedFuture: (scopes || []).length - eligible.length,
      rowsWritten: 0,
      details: [],
      step1: step1Result,
    };
  }

  const step2Result = await updateDailyValues(db, {
    scopeList,
    runDate,
    invMap,
    cache,
  });

  return {
    runDate,
    processed: scopeList.length,
    skippedFuture: (scopes || []).length - eligible.length,
    rowsWritten: step2Result.rowsWritten,
    details: step2Result.details,
    step1: step1Result,
  };
}

async function runBackfillInTwoSteps(db, options = {}) {
  const runDate = clampEndDateToToday(options.runDate || todayIso());
  const scopes = options.scopes || [];
  logBackfillInfo(`[Backfill] Starting two-step backfill for ${runDate} with ${scopes.length} scope(s)...`);

  const result = await backfillDirtyScopes(db, scopes, { runDate });
  logBackfillInfo('[Backfill] Two-step backfill completed.');
  return result;
}

async function backfillNPSHistoricalNAV(db, investmentId, startDate, endDate) {
  const { fetchNPSHistory } = require('./priceService');
  const { logBackfillInfo, logBackfillError } = require('./appLogger');

  try {
    logBackfillInfo(`[NPS Backfill] Starting backfill for investment ${investmentId} from ${startDate} to ${endDate}`);

    const inv = db.prepare('SELECT id, nps_fund_code FROM investments WHERE id = ?').get(investmentId);
    if (!inv?.nps_fund_code) {
      logBackfillInfo(`[NPS Backfill] Skipping ${investmentId}: nps_fund_code is missing`);
      return;
    }

    // Fetch historical NAV data
    const history = await fetchNPSHistory(inv.nps_fund_code, startDate, endDate);
    if (!history || history.length === 0) {
      logBackfillInfo(`[NPS Backfill] No historical data found for investment ${investmentId}`);
      return;
    }

    const from = toIsoDate(startDate);
    const to = toIsoDate(endDate);
    const filtered = [];
    const seen = new Set();
    for (const row of history) {
      const d = normalizeMfDate(row?.date);
      if (!d) continue;
      if (from && d < from) continue;
      if (to && d > to) continue;
      if (!isValidNpsNav(row?.nav)) continue;
      const key = `${investmentId}|${d}`;
      if (seen.has(key)) continue;
      seen.add(key);
      filtered.push({ date: d, nav: Number(row.nav) });
    }
    if (filtered.length === 0) {
      logBackfillInfo(`[NPS Backfill] No valid NAV rows for investment ${investmentId} in requested date range`);
      return;
    }

    const portfolioIds = db.prepare(`
      SELECT DISTINCT portfolio_id
      FROM transactions
      WHERE investment_id = ?
        AND portfolio_id IS NOT NULL
        AND date(transaction_date) <= ?
    `).all(investmentId, to).map((r) => r.portfolio_id);

    if (!portfolioIds.length) {
      logBackfillInfo(`[NPS Backfill] Skipping ${investmentId}: no portfolio-scoped transactions found`);
      return;
    }

    // Insert or update daily values for each concrete portfolio scope.
    const upsertStmt = db.prepare(`
      INSERT INTO daily_values (
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
      VALUES (?, ?, ?, ?, 0, 0, 0, 0, 0, ?, 0, datetime('now'))
      ON CONFLICT(investment_id, portfolio_id, date) DO UPDATE SET
        price_per_unit = excluded.price_per_unit,
        price_source = excluded.price_source,
        updated_at = datetime('now')
    `);

    db.transaction(() => {
      for (const { date, nav } of filtered) {
        for (const pid of portfolioIds) {
          upsertStmt.run(investmentId, pid, date, nav, 'BACKFILL');
        }
      }
    })();

    logBackfillInfo(`[NPS Backfill] Successfully backfilled ${filtered.length * portfolioIds.length} rows for investment ${investmentId}`);
  } catch (error) {
    logBackfillError(`[NPS Backfill] Failed to backfill for investment ${investmentId}: ${error.message}`);
  }
}

module.exports = {
  backfillDirtyScopes,
  clampEndDateToToday,
  todayIso,
  toIsoDate,
  runBackfillInTwoSteps,
  processAutoBackfillCAEntries,
  updateDailyValues,
  backfillNPSHistoricalNAV,
};
