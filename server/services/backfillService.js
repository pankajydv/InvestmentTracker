const https = require('https');
const { fetchCorporateActions, fetchHistoricalStockPrice, fetchHistoricalOHLC, fetchHistoricalUSDToINR, fetchMutualFundHistory } = require('./priceService');
const { calculatePfInterestPreview, calculateSmallSavingsInterestPreview } = require('./pfInterestCalculator');
const { updateAssetTypeDaily, updatePortfolioDaily } = require('./updater');
const { setBackfillProgress } = require('./dirtyBackfillService');
const { toIsoDate, todayIso } = require('./dateUtils');

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

function normalizeMfDate(dateValue) {
  const value = String(dateValue || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const m = value.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
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
          for (let i = 0; i < timestamps.length; i += 1) {
            const close = closes[i];
            if (close == null) continue;
            const d = new Date(timestamps[i] * 1000).toISOString().split('T')[0];
            series.set(d, Number(close));
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
  const sql = portfolioId == null
    ? 'SELECT date, price_per_unit FROM daily_values WHERE investment_id = ? AND portfolio_id IS NULL AND date <= ? ORDER BY date DESC LIMIT 1'
    : 'SELECT date, price_per_unit FROM daily_values WHERE investment_id = ? AND portfolio_id = ? AND date <= ? ORDER BY date DESC LIMIT 1';
  const row = portfolioId == null
    ? db.prepare(sql).get(investmentId, date)
    : db.prepare(sql).get(investmentId, portfolioId, date);
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

  if (inv.asset_type === 'INDIAN_STOCK' || inv.asset_type === 'FOREIGN_STOCK' || inv.asset_type === 'SGB') {
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
    const row = db.prepare(`
      SELECT price_per_unit FROM transactions
      WHERE investment_id = ? AND transaction_date <= ? AND price_per_unit > 0
      ORDER BY transaction_date DESC, id DESC
      LIMIT 1
    `).get(inv.id, date);
    if (row?.price_per_unit) return { price: Number(row.price_per_unit), source: 'COMPUTED' };
    const stored = getStoredPriceOnOrBefore(db, inv.id, portfolioId, date);
    if (stored && stored.price > 0) return stored;
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
    const preview = calculatePfInterestPreview({
      openingBalance: Number(inv.opening_balance || 0),
      transactions: txns,
      rateRows,
      fromDate,
      toDate: date,
      ignoreExistingInterest: false,
      includeTransferTransactions: true,
    });
    return Number(preview.closingBalance || 0);
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
  const upsertScoped = statements?.upsertScoped || db.prepare(`
    INSERT INTO daily_values (investment_id, portfolio_id, date, price_per_unit, total_units, current_value, invested_amount, realized_gain, profit_loss, profit_loss_pct, price_source, day_change, day_change_pct)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(investment_id, portfolio_id, date) DO UPDATE SET
      price_per_unit = excluded.price_per_unit,
      total_units = excluded.total_units,
      current_value = excluded.current_value,
      invested_amount = excluded.invested_amount,
      realized_gain = excluded.realized_gain,
      profit_loss = excluded.profit_loss,
      profit_loss_pct = excluded.profit_loss_pct,
      price_source = excluded.price_source,
      day_change = excluded.day_change,
      day_change_pct = excluded.day_change_pct
  `);
  const deleteCombined = statements?.deleteCombined || db.prepare('DELETE FROM daily_values WHERE investment_id = ? AND portfolio_id IS NULL AND date = ?');
  const insertCombined = statements?.insertCombined || db.prepare(`
    INSERT INTO daily_values (investment_id, portfolio_id, date, price_per_unit, total_units, current_value, invested_amount, realized_gain, profit_loss, profit_loss_pct, price_source, day_change, day_change_pct)
    VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  if (row.portfolio_id == null) {
    deleteCombined.run(row.investment_id, row.date);
    insertCombined.run(
      row.investment_id,
      row.date,
      row.price_per_unit,
      row.total_units,
      row.current_value,
      row.invested_amount,
      row.realized_gain,
      row.profit_loss,
      row.profit_loss_pct,
      row.price_source,
      row.day_change,
      row.day_change_pct
    );
    return;
  }

  upsertScoped.run(
    row.investment_id,
    row.portfolio_id,
    row.date,
    row.price_per_unit,
    row.total_units,
    row.current_value,
    row.invested_amount,
    row.realized_gain,
    row.profit_loss,
    row.profit_loss_pct,
    row.price_source,
    row.day_change,
    row.day_change_pct
  );
}

function round2(n) {
  return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
}

function computeRealizedProceeds(db, inv, date, portfolioId) {
  const portfolioFilter = portfolioId != null ? ' AND portfolio_id = ?' : '';
  const params = portfolioId != null ? [inv.id, date, portfolioId] : [inv.id, date];

  let types = ['SELL', 'WITHDRAWAL', 'DIVIDEND', 'INTEREST'];
  if (inv.asset_type === 'PF' || inv.asset_type === 'PPF' || inv.asset_type === 'SSY') {
    types = ['SELL', 'WITHDRAWAL', 'DIVIDEND'];
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

async function recomputeScopeRows(db, inv, portfolioId, fromDate, toDate, cache) {
    const dailyStatements = {
      upsertScoped: db.prepare(`
        INSERT INTO daily_values (investment_id, portfolio_id, date, price_per_unit, total_units, current_value, invested_amount, realized_gain, profit_loss, profit_loss_pct, price_source, day_change, day_change_pct)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(investment_id, portfolio_id, date) DO UPDATE SET
          price_per_unit = excluded.price_per_unit,
          total_units = excluded.total_units,
          current_value = excluded.current_value,
          invested_amount = excluded.invested_amount,
          realized_gain = excluded.realized_gain,
          profit_loss = excluded.profit_loss,
          profit_loss_pct = excluded.profit_loss_pct,
          price_source = excluded.price_source,
          day_change = excluded.day_change,
          day_change_pct = excluded.day_change_pct
      `),
      deleteCombined: db.prepare('DELETE FROM daily_values WHERE investment_id = ? AND portfolio_id IS NULL AND date = ?'),
      insertCombined: db.prepare(`
        INSERT INTO daily_values (investment_id, portfolio_id, date, price_per_unit, total_units, current_value, invested_amount, realized_gain, profit_loss, profit_loss_pct, price_source, day_change, day_change_pct)
        VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

  const deleteSql = portfolioId != null
    ? 'DELETE FROM daily_values WHERE investment_id = ? AND portfolio_id = ? AND date >= ? AND date <= ?'
    : 'DELETE FROM daily_values WHERE investment_id = ? AND portfolio_id IS NULL AND date >= ? AND date <= ?';
  const deleteParams = portfolioId != null ? [inv.id, portfolioId, fromDate, toDate] : [inv.id, fromDate, toDate];
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
      AND transaction_type IN ('BUY','DEPOSIT','IPO','RIGHTS','EMPLOYER_CONTRIBUTION','VOLUNTARY_CONTRIBUTION','ESPP_CONTRIBUTION')
  `);
  const getPrev = db.prepare(portfolioId != null
    ? 'SELECT current_value FROM daily_values WHERE investment_id = ? AND portfolio_id = ? AND date < ? ORDER BY date DESC LIMIT 1'
    : 'SELECT current_value FROM daily_values WHERE investment_id = ? AND portfolio_id IS NULL AND date < ? ORDER BY date DESC LIMIT 1');

  let written = 0;
  let lastNonZeroDate = null;
  let exitDate = null;
  for (const date of dates) {
    const unitsRow = getUnits.get(...baseParams, date);
    const units = Number(unitsRow?.total || 0);
    const invested = Number(getInvested.get(...baseParams, date)?.total || 0);

    // Stop writing trailing zero-unit rows after the investment has exited in this scope.
    if (latestTxnDate && date > latestTxnDate && units <= 0) {
      break;
    }

    const priced = await getPriceForDate(db, inv, date, cache, portfolioId);
    let price = Number(priced.price || 0);
    let priceSource = priced.source || 'COMPUTED';
    let currentValue = 0;
    let totalUnits = units;

    if (inv.asset_type === 'PF' || inv.asset_type === 'PPF' || inv.asset_type === 'SSY') {
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
    const profitLoss = reinvestType
      ? currentValue - invested
      : currentValue + realized - invested;
    const profitLossPct = invested > 0 ? (profitLoss / invested) * 100 : 0;

    if (units > 0.000001) {
      lastNonZeroDate = date;
    } else if (latestTxnDate && date >= latestTxnDate && !exitDate) {
      exitDate = date;
    }

    const prev = portfolioId != null
      ? getPrev.get(inv.id, portfolioId, date)
      : getPrev.get(inv.id, date);
    const prevValue = Number(prev?.current_value || 0);
    const dayChange = currentValue - prevValue;
    const dayChangePct = prevValue > 0 ? (dayChange / prevValue) * 100 : 0;

    upsertDailyRow(db, {
      investment_id: inv.id,
      portfolio_id: portfolioId,
      date,
      price_per_unit: round2(price),
      total_units: inv.asset_type === 'PF' || inv.asset_type === 'PPF' || inv.asset_type === 'SSY'
        ? 1
        : Math.round(units * 1000) / 1000,
      current_value: round2(currentValue),
      invested_amount: round2(invested),
      realized_gain: round2(reinvestType ? 0 : realized),
      profit_loss: round2(profitLoss),
      profit_loss_pct: round2(profitLossPct),
      price_source: priceSource,
      day_change: round2(dayChange),
      day_change_pct: round2(dayChangePct),
    }, dailyStatements);
    written += 1;
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
    const rows = selectByKey.all(
      desired.investmentId,
      desired.portfolioId,
      desired.date,
      desired.transactionType
    );

    if (!rows.length) {
      insertTxn.run(
        desired.investmentId,
        desired.portfolioId,
        desired.transactionType,
        desired.date,
        desired.units,
        desired.pricePerUnit,
        desired.amount,
        desired.notes,
        desired.broker,
        desired.fxRate,
        desired.usdAmount
      );
      return 'inserted';
    }

    const lockedRow = rows.find((r) => Number(r.locked || 0) === 1);
    const canonical = lockedRow || rows[0];
    let changed = false;

    for (const r of rows) {
      if (r.id === canonical.id) continue;
      if (Number(r.locked || 0) === 1) continue;
      deleteById.run(r.id);
      changed = true;
    }

    if (Number(canonical.locked || 0) === 1) {
      return changed ? 'updated' : 'unchanged';
    }

    const needsUpdate =
      !nearlyEqual(canonical.units, desired.units) ||
      !nearlyEqual(canonical.price_per_unit, desired.pricePerUnit) ||
      !nearlyEqual(canonical.amount, desired.amount) ||
      String(canonical.notes || '') !== String(desired.notes || '') ||
      String(canonical.broker || '') !== String(desired.broker || '') ||
      !nearlyEqual(canonical.exchange_rate_used, desired.fxRate) ||
      !nearlyEqual(canonical.usd_amount, desired.usdAmount);

    if (needsUpdate) {
      updateById.run(
        desired.units,
        desired.pricePerUnit,
        desired.amount,
        desired.notes,
        desired.broker,
        desired.fxRate,
        desired.usdAmount,
        canonical.id
      );
      changed = true;
    }

    return changed ? 'updated' : 'unchanged';
  }

  let inserted = 0;
  let updated = 0;
  let earliestChangedDate = null;

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
        usdAmount = Math.round(amount * 100) / 100;
        fxRate = cache.fx.get(eventDate);
        if (fxRate == null) {
          fxRate = await fetchHistoricalUSDToINR(eventDate).catch(() => 0);
          cache.fx.set(eventDate, Number(fxRate || 0));
        }
        if (!(fxRate > 0)) continue;
        amount = usdAmount * Number(fxRate);
      }

      const notes = `AutoBackfill CA Dividend ${perShare} x ${units}`;
      const changeType = upsertCorporateActionTxn({
        investmentId: inv.id,
        portfolioId,
        transactionType: 'DIVIDEND',
        date: eventDate,
        units,
        pricePerUnit: perShare,
        amount: round2(amount),
        notes,
        broker: null,
        fxRate: fxRate ? Number(fxRate) : null,
        usdAmount,
      });
      if (changeType !== 'unchanged') {
        if (changeType === 'inserted') inserted += 1;
        else updated += 1;
        markChangedDate(eventDate);
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
      const addedUnits = txnType === 'BONUS'
        ? Math.floor(addedUnitsRaw)
        : Math.round(addedUnitsRaw * 1000) / 1000;
      if (addedUnits <= 0) continue;

      // Fractional bonus entitlement → cash payout (using previous day's LOW price)
      const fractional = txnType === 'BONUS' ? Math.round((addedUnitsRaw - addedUnits) * 1e6) / 1e6 : 0;
      let fractionalAmount = 0;
      if (fractional > 0.0001) {
        // Use previous day's LOW price for fractional payout calculation
        const prevDay = new Date(eventDate);
        prevDay.setDate(prevDay.getDate() - 1);
        const prevDayStr = prevDay.toISOString().split('T')[0];
        const ohlc = await fetchHistoricalOHLC(ticker, prevDayStr).catch(() => null);
        const lowPrice = ohlc?.low || 0;
        fractionalAmount = lowPrice > 0 ? Math.round(fractional * lowPrice * 100) / 100 : 0;
      }

      const notes = fractional > 0.0001
        ? `AutoBackfill CA ${txnType} ${split.numerator}:${split.denominator} + \u20B9${fractionalAmount} fractional payout`
        : `AutoBackfill CA ${txnType} ${split.numerator}:${split.denominator}`;
      const changeType = upsertCorporateActionTxn({
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
      if (changeType !== 'unchanged') {
        if (changeType === 'inserted') inserted += 1;
        else updated += 1;
        markChangedDate(eventDate);
      }
    }
  }

  return {
    inserted,
    updated,
    modified: inserted + updated,
    earliestChangedDate,
  };
}

function normalizeScopesForRun(scopes, runDate) {
  const eligible = (scopes || []).filter((s) => String(s.dirty_from_date) <= runDate);
  const grouped = new Map();

  for (const s of eligible) {
    const invId = s.investment_id == null ? 'null' : String(s.investment_id);
    const pid = s.portfolio_id == null ? 'null' : String(s.portfolio_id);
    const key = `${invId}:${pid}`;
    const existing = grouped.get(key);
    if (!existing || s.dirty_from_date < existing.dirty_from_date) {
      grouped.set(key, {
        investment_id: s.investment_id,
        portfolio_id: s.portfolio_id,
        dirty_from_date: s.dirty_from_date,
      });
    }

    if (s.investment_id != null && s.portfolio_id != null) {
      const combinedKey = `${invId}:null`;
      const combinedExisting = grouped.get(combinedKey);
      if (!combinedExisting || s.dirty_from_date < combinedExisting.dirty_from_date) {
        grouped.set(combinedKey, {
          investment_id: s.investment_id,
          portfolio_id: null,
          dirty_from_date: s.dirty_from_date,
        });
      }
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

async function preloadStockHistoryForRun(invMap, scopeList, runDate, startByInvestment, cache) {
  const symbolStart = new Map();
  for (const s of scopeList) {
    const inv = invMap.get(s.investment_id);
    if (!inv) continue;
    if (!['INDIAN_STOCK', 'FOREIGN_STOCK', 'SGB'].includes(inv.asset_type)) continue;
    if (!inv.ticker_symbol) continue;
    const startDate = startByInvestment.get(inv.id) || s.dirty_from_date;
    const existing = symbolStart.get(inv.ticker_symbol);
    if (!existing || startDate < existing) {
      symbolStart.set(inv.ticker_symbol, startDate);
    }
  }

  cache.stockRangeBySymbol = symbolStart;
  for (const [symbol, startDate] of symbolStart.entries()) {
    if (cache.stock.has(symbol)) continue;
    const series = await fetchStockSeries(symbol, startDate, runDate).catch(() => new Map());
    cache.stock.set(symbol, series);
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

  for (const pair of corporateActionSyncPairs.values()) {
    const inv = invMap.get(pair.investmentId);
    if (!inv) continue;
    const result = await syncCorporateActionsForScope(db, inv, pair.portfolioId, pair.fromDate, runDate, cache);
    inserted += Number(result?.inserted || 0);
    updated += Number(result?.updated || 0);
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

  return {
    inserted,
    updated,
    modified: inserted + updated,
    earliestChangedDate,
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

    const rows = await recomputeScopeRows(db, inv, scope.portfolio_id, fromDate, runDate, cache);
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
  }

  for (const d of eachDate(earliestTouchedDate, runDate)) {
    updatePortfolioDaily(db, d);
    updateAssetTypeDaily(db, d);
  }

  setBackfillProgress(db, {
    phase: 'finalizing',
    total: scopeList.length,
    completed: scopeList.length,
    current: null,
    message: 'Refreshing daily aggregates',
    runDate,
    startedAt: new Date().toISOString(),
  });

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
  const { eligible, scopeList } = normalizeScopesForRun(scopes, runDate);

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
  const cache = {
    mf: new Map(),
    stock: new Map(),
    fx: new Map(),
    actions: new Map(),
    stockRangeBySymbol: new Map(),
    allowNetworkFallback: false,
    rangeStart: Array.from(startByInvestment.values()).reduce((m, s) => (m == null || s < m ? s : m), null)
      || scopeList.reduce((m, s) => (m == null || s.dirty_from_date < m ? s.dirty_from_date : m), null)
      || runDate,
    rangeEnd: runDate,
  };

  await preloadStockHistoryForRun(invMap, scopeList, runDate, startByInvestment, cache);

  const step1Result = await processAutoBackfillCAEntries(db, {
    scopeList,
    runDate,
    invMap,
    cache,
    startByInvestment,
  });

  if (options.step1Only === true) {
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
  console.log(`[Backfill] Starting two-step backfill for ${runDate} with ${scopes.length} scope(s)...`);

  const result = await backfillDirtyScopes(db, scopes, { runDate });
  console.log('[Backfill] Two-step backfill completed.');
  return result;
}

module.exports = {
  backfillDirtyScopes,
  clampEndDateToToday,
  todayIso,
  toIsoDate,
  runBackfillInTwoSteps,
  processAutoBackfillCAEntries,
  updateDailyValues,
};
