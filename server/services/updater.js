/**
 * Daily price update service.
 * Fetches latest prices for all active investments and stores daily snapshots.
 */

const {
  fetchMutualFundNAV,
  fetchStockPrice,
  fetchUSDToINR,
  fetchHistoricalUSDToINR,
  toNSETicker,
  resolveAmfiCodeByISIN,
  fetchSGBPrice,
  fetchNPSNAV,
  getMarketDataSourceForNSE,
} = require('./priceService');
const { calculatePfInterestPreview, calculatePfValueAsOfDate, calculateSmallSavingsValueAsOfDate } = require('./pfInterestCalculator');
const { computeBondAccruedCoupon } = require('./bondAccrualService');
const { logAppInfo, logAppWarn, logAppError } = require('./appLogger');
const { getMarketHolidays, getWeekends } = require('./holidays/marketHolidayService');
const {
  INVESTED_AMOUNT_INFLOW_TYPES_SQL,
  REALIZED_CASHFLOW_TYPES,
  REALIZED_CASHFLOW_TYPES_REINVEST_ACCRUAL,
} = require('../constants/transactionTypes');
const {
  quantizeForStorage,
} = require('./numberPrecision');
const { markScopeDirty } = require('./dirtyBackfillService');
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Asset types covered by the generic LOCF-lag self-healing path.
// FOREIGN_STOCK is intentionally excluded — it has a dedicated settlement-aware
// reconcile path in the scheduler (ensureForeignReconcileScopes).
const LOCF_LAG_RECONCILE_ASSET_TYPES = new Set(['INDIAN_STOCK', 'MUTUAL_FUND', 'NPS', 'SGB']);

const DAY_CHANGE_MAX_PREVIOUS_SESSIONS = 3;
const DAY_CHANGE_EPSILON_UNITS = 0.0001;

function addDaysIso(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}

function getMarketClosedSetForYear(year, db, cache) {
  if (!cache.has(year)) {
    const holidays = getMarketHolidays(year, db).map((h) => h.date);
    const weekends = getWeekends(year).map((w) => w.date);
    cache.set(year, new Set([...holidays, ...weekends]));
  }
  return cache.get(year);
}

function isMarketSessionDate(dateIso, db, cache) {
  const d = new Date(`${dateIso}T00:00:00.000Z`);
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false;
  const closed = getMarketClosedSetForYear(d.getUTCFullYear(), db, cache);
  return !closed.has(dateIso);
}

function isMarketLinkedAssetType(assetType) {
  return ['INDIAN_STOCK', 'FOREIGN_STOCK', 'MUTUAL_FUND', 'NPS', 'SGB'].includes(String(assetType || ''));
}

function isWithinPreviousMarketSessions(candidateIso, anchorIso, db, holidayCache, maxSessions = DAY_CHANGE_MAX_PREVIOUS_SESSIONS) {
  if (!candidateIso || !anchorIso || candidateIso >= anchorIso) return false;
  if (!isMarketSessionDate(candidateIso, db, holidayCache)) return false;

  let cursor = addDaysIso(anchorIso, -1);
  let seenSessions = 0;
  while (cursor >= candidateIso) {
    if (isMarketSessionDate(cursor, db, holidayCache)) {
      seenSessions += 1;
      if (seenSessions > maxSessions) return false;
    }
    if (cursor === candidateIso) {
      return seenSessions <= maxSessions;
    }
    cursor = addDaysIso(cursor, -1);
  }
  return false;
}

function getPriorMarketSessionLocfStreak(db, investmentId, portfolioId, asOfDate, holidayCache) {
  const fromDate = addDaysIso(asOfDate, -90);
  const rows = db.prepare(`
    SELECT date, price_source
    FROM daily_values
    WHERE investment_id = ?
      AND portfolio_id = ?
      AND date >= ?
      AND date < ?
    ORDER BY date ASC
  `).all(investmentId, portfolioId, fromDate, asOfDate);

  const byDate = new Map(rows.map((r) => [r.date, String(r.price_source || '')]));
  let cursor = addDaysIso(asOfDate, -1);
  let streak = 0;
  while (cursor >= fromDate) {
    if (isMarketSessionDate(cursor, db, holidayCache)) {
      const source = byDate.get(cursor);
      if (source === 'LOCF') {
        streak += 1;
      } else {
        break;
      }
    }
    cursor = addDaysIso(cursor, -1);
  }
  return streak;
}

// ─── Cancellation support ──────────────────────────────────────────────────
let _cancelled = false;

function cancelUpdate() {
  _cancelled = true;
}

function getProvidentValueAsOfDate(db, inv, date, portfolioId = null) {
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
  const rateRows = db.prepare(
    'SELECT rate, effective_from, effective_to FROM interest_rates WHERE rate_type = ? ORDER BY effective_from ASC'
  ).all(inv.asset_type);

  if (inv.asset_type === 'PF') {
    return Number(calculatePfValueAsOfDate({
      openingBalance: Number(inv.opening_balance || 0),
      transactions: txns,
      rateRows,
      fromDate,
      asOfDate: date,
      ignoreExistingInterest: true,
      includeTransferTransactions: true,
    }) || 0);
  }

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

/**
 * Update prices for active investments, optionally filtered by asset type.
 * @param {import('better-sqlite3').Database} db
 * @param {Object} [options]
 * @param {string[]} [options.assetTypes] - If provided, only update these asset types (e.g. ['MUTUAL_FUND'])
 * @param {boolean} [options.sessionOnlyForMarketLinked] - Skip market-linked assets on non-market-session days
 * @param {string} [options.runTag] - Optional label for logs/diagnostics
 */
async function updateAllPrices(db, options = {}) {
  _cancelled = false;
  const today = new Date().toISOString().split('T')[0];
  const typeFilter = options.assetTypes;
  const sessionOnlyForMarketLinked = options.sessionOnlyForMarketLinked === true;
  const runTag = String(options.runTag || '').trim() || null;
  const label = typeFilter ? typeFilter.join(', ') : 'ALL';
  const runStartedAt = Date.now();
  console.log(`[${new Date().toISOString()}] Starting price update (${label}) for ${today}...`);

  let investments = db.prepare('SELECT * FROM investments').all();
  if (typeFilter && typeFilter.length > 0) {
    investments = investments.filter(i => typeFilter.includes(i.asset_type));
  }
  // Skip inactive investments (delisted, etc.)
  investments = investments.filter(i => i.is_active !== 0);
  // Skip investments excluded from tracking (derived/synthetic)
  investments = investments.filter(i => i.exclude_from_tracking !== 1);

  // Skip fully-sold investments (net units <= 0). Only provident/small-savings
  // products are balance-based and should always be included.
  const BALANCE_BASED_TYPES = new Set(['PPF', 'SSY', 'PF']);
  const openInvestmentIds = new Set(
    db.prepare(`
      SELECT investment_id FROM transactions
      WHERE transaction_date <= ?
      GROUP BY investment_id
      HAVING SUM(CASE
        WHEN transaction_type IN ('BUY', 'DEPOSIT', 'BONUS', 'SPLIT', 'IPO', 'TRANSFER_IN', 'SWITCH_IN', 'RIGHTS', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'VEST', 'ESPP_PURCHASE') THEN COALESCE(units, 0)
        WHEN transaction_type IN ('SELL', 'REDEMPTION', 'WITHDRAWAL', 'TRANSFER_OUT', 'SWITCH_OUT', 'CONSOLIDATION', 'CHARGES', 'AMC') THEN -COALESCE(units, 0)
        ELSE 0
      END) > 0.0001
    `).all(today).map(r => r.investment_id)
  );

  const exitedUnitBasedIds = investments
    .filter(i => !BALANCE_BASED_TYPES.has(i.asset_type) && !openInvestmentIds.has(i.id))
    .map(i => i.id);

  investments = investments.filter(i => BALANCE_BASED_TYPES.has(i.asset_type) || openInvestmentIds.has(i.id));

  // Remove same-day rows previously written for fully exited unit-based holdings.
  // This keeps latest valuation anchored to the true exit date (no trailing zero-unit snapshots).
  if (exitedUnitBasedIds.length > 0) {
    const CHUNK = 400;
    for (let i = 0; i < exitedUnitBasedIds.length; i += CHUNK) {
      const chunk = exitedUnitBasedIds.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      db.prepare(`
        DELETE FROM daily_values
        WHERE date = ?
          AND investment_id IN (${placeholders})
      `).run(today, ...chunk);
    }
  }

  logAppInfo('[UpdatePrices] Step 1/3 prepared investment universe', {
    date: today,
    assetFilter: typeFilter || null,
    totalInvestmentsToProcess: investments.length,
  });

  // Auto-resolve missing AMFI codes for mutual funds using ISIN (single download)
  const mfsWithoutAmfi = investments.filter(i => i.asset_type === 'MUTUAL_FUND' && !i.amfi_code && i.isin_code);
  if (mfsWithoutAmfi.length > 0) {
    console.log(`  Resolving AMFI codes for ${mfsWithoutAmfi.length} mutual fund(s)...`);
    logAppInfo('[UpdatePrices] Resolving AMFI codes for missing mappings', {
      count: mfsWithoutAmfi.length,
    });
    try {
      const isinList = mfsWithoutAmfi.map(mf => mf.isin_code);
      const amfiMap = await resolveAmfiCodeByISIN(isinList);
      const updateAmfi = db.prepare('UPDATE investments SET amfi_code = ? WHERE id = ?');
      for (const mf of mfsWithoutAmfi) {
        const result = amfiMap.get(mf.isin_code);
        if (result) {
          updateAmfi.run(result.schemeCode, mf.id);
          mf.amfi_code = result.schemeCode;
          console.log(`    ✓ ${mf.name} → AMFI ${result.schemeCode}`);
        } else {
          console.warn(`    ✗ ${mf.name}: No AMFI match for ISIN ${mf.isin_code}`);
        }
      }
    } catch (e) {
      console.warn(`  AMFI bulk lookup failed: ${e.message}`);
      logAppError('[UpdatePrices] AMFI bulk lookup failed', { error: e.message });
    }
  }

  const hasForeignInScope = investments.some((inv) => inv.asset_type === 'FOREIGN_STOCK');

  // Fetch USD/INR rate for foreign stocks and persist per-day FX cache when needed.
  let usdToInr = parseFloat(db.prepare("SELECT value FROM config WHERE key = 'usd_to_inr'").get()?.value || '83.5');
  if (hasForeignInScope) {
    try {
      usdToInr = await fetchHistoricalUSDToINR(today);
      db.prepare("UPDATE config SET value = ?, updated_at = datetime('now') WHERE key = 'usd_to_inr'").run(String(usdToInr));
      logAppInfo('[UpdatePrices] USD/INR rate refreshed', { usdToInr, source: 'historical_fx_cache' });
    } catch (e) {
      console.warn('Could not update USD/INR historical rate, trying live rate. Using cached value if needed:', usdToInr);
      logAppError('[UpdatePrices] USD/INR historical refresh failed', { error: e.message, usdToInr });
      try {
        usdToInr = await fetchUSDToINR();
        db.prepare("UPDATE config SET value = ?, updated_at = datetime('now') WHERE key = 'usd_to_inr'").run(String(usdToInr));
      } catch (e2) {
        logAppError('[UpdatePrices] USD/INR live refresh failed, using cached value', {
          error: e2.message,
          usdToInr,
        });
      }
    }
  }

  const upsertDaily = db.prepare(`
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

  const getInvestedAmountPortfolio = db.prepare(`
    SELECT COALESCE(SUM(amount + COALESCE(fees, 0)), 0) as total
    FROM transactions WHERE investment_id = ? AND portfolio_id = ? AND transaction_date <= ? AND transaction_type IN (${INVESTED_AMOUNT_INFLOW_TYPES_SQL})
  `);

  function getRealizedCashflowPortfolio(investment, portfolioId, asOfDate) {
    let types = REALIZED_CASHFLOW_TYPES;
    if (investment.asset_type === 'PF' || investment.asset_type === 'PPF' || investment.asset_type === 'SSY') {
      // Provident interest/reconcile are internal accrual adjustments, not external cashflow.
      types = REALIZED_CASHFLOW_TYPES_REINVEST_ACCRUAL;
    }

    const placeholders = types.map(() => '?').join(',');
    const row = db.prepare(`
      SELECT COALESCE(SUM(amount - COALESCE(fees, 0)), 0) as total
      FROM transactions
      WHERE investment_id = ? AND portfolio_id = ? AND transaction_date <= ?
        AND transaction_type IN (${placeholders})
    `).get(investment.id, portfolioId, asOfDate, ...types);
    return Number(row?.total || 0);
  }

  const getTotalUnitsPortfolio = db.prepare(`
    SELECT COALESCE(
      SUM(CASE
        WHEN transaction_type IN ('BUY', 'DEPOSIT', 'BONUS', 'SPLIT', 'IPO', 'TRANSFER_IN', 'SWITCH_IN', 'RIGHTS', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'VEST', 'ESPP_PURCHASE') THEN COALESCE(units, 0)
        WHEN transaction_type IN ('SELL', 'REDEMPTION', 'WITHDRAWAL', 'TRANSFER_OUT', 'SWITCH_OUT', 'CONSOLIDATION', 'CHARGES', 'AMC') THEN -COALESCE(units, 0)
        ELSE 0
      END), 0
    ) as total
    FROM transactions WHERE investment_id = ? AND portfolio_id = ? AND transaction_date <= ?
  `);

  const getPrevRowsPortfolio = db.prepare(`
    SELECT date, price_per_unit, current_value, total_units, price_source
    FROM daily_values
    WHERE investment_id = ? AND portfolio_id = ? AND date < ?
    ORDER BY date DESC
    LIMIT 120
  `);

  const getNetFlowTodayPortfolio = db.prepare(`
    SELECT COALESCE(SUM(CASE
      WHEN transaction_type IN ('BUY', 'DEPOSIT', 'IPO', 'RIGHTS', 'TRANSFER_IN', 'SWITCH_IN', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'ESPP_CONTRIBUTION') THEN COALESCE(amount, 0)
      WHEN transaction_type IN ('SELL', 'REDEMPTION', 'WITHDRAWAL', 'TRANSFER_OUT', 'SWITCH_OUT', 'CHARGES', 'AMC') THEN -COALESCE(amount, 0)
      WHEN transaction_type = 'TDS' THEN -ABS(COALESCE(amount, 0))
      ELSE 0
    END), 0) AS net_flow
    FROM transactions
    WHERE investment_id = ? AND portfolio_id = ? AND date(transaction_date) = ?
  `);

  const getDistinctPortfolios = db.prepare(`
    SELECT DISTINCT portfolio_id FROM transactions WHERE investment_id = ? AND portfolio_id IS NOT NULL AND transaction_date <= ?
  `);

  const getBondTransactionsPortfolio = db.prepare(`
    SELECT
      date(transaction_date) AS tx_date,
      UPPER(transaction_type) AS transaction_type,
      COALESCE(units, 0) AS units,
      COALESCE(amount, 0) AS amount
    FROM transactions
    WHERE investment_id = ?
      AND portfolio_id = ?
      AND date(transaction_date) <= ?
    ORDER BY date(transaction_date) ASC, id ASC
  `);

  const getOpenUnitsPortfolio = db.prepare(`
    SELECT COALESCE(
      SUM(CASE
        WHEN transaction_type IN ('BUY', 'DEPOSIT', 'BONUS', 'SPLIT', 'IPO', 'TRANSFER_IN', 'SWITCH_IN', 'RIGHTS', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'VEST', 'ESPP_PURCHASE') THEN COALESCE(units, 0)
        WHEN transaction_type IN ('SELL', 'REDEMPTION', 'WITHDRAWAL', 'TRANSFER_OUT', 'SWITCH_OUT', 'CONSOLIDATION', 'CHARGES', 'AMC') THEN -COALESCE(units, 0)
        ELSE 0
      END), 0
    ) as total
    FROM transactions WHERE investment_id = ? AND portfolio_id = ? AND transaction_date <= ?
  `);

  const deleteTodaySnapshotForScope = db.prepare(`
    DELETE FROM daily_values
    WHERE investment_id = ? AND portfolio_id = ? AND date = ?
  `);

  let successCount = 0;
  let errorCount = 0;
  let skippedCount = 0;
  const totalCount = investments.length;
  let heartbeatAt = Date.now();
  const marketHolidayCache = new Map();
  const warnedUnexpectedLocf = new Set();
  const isMarketSessionToday = isMarketSessionDate(today, db, marketHolidayCache);

  logAppInfo('[UpdatePrices] Run context', {
    date: today,
    runTag,
    sessionOnlyForMarketLinked,
    isMarketSessionToday,
    assetFilter: typeFilter || null,
  });


  for (const inv of investments) {
    if (_cancelled) {
      console.log('  ⏹ Update cancelled by user.');
      logAppInfo('[UpdatePrices] Cancellation requested; stopping iteration', {
        processed: successCount + errorCount + skippedCount,
        total: totalCount,
      });
      break;
    }

    try {
      if (sessionOnlyForMarketLinked && !isMarketSessionToday && isMarketLinkedAssetType(inv.asset_type)) {
        skippedCount += 1;
        logAppInfo('[UpdatePrices] Skipped market-linked asset on non-session day', {
          investmentId: inv.id,
          investmentName: inv.name,
          assetType: inv.asset_type,
          date: today,
          runTag,
        });
        continue;
      }

      let pricePerUnit = 0;
      let priceSource = 'COMPUTED';
      let apiChange = null;
      let apiChangePct = null;
      
      console.log(`  [DEBUG] Processing ${inv.name} (id=${inv.id}, type=${inv.asset_type})`);

      switch (inv.asset_type) {
        case 'MUTUAL_FUND': {
          if (inv.amfi_code) {
            const navData = await fetchMutualFundNAV(inv.amfi_code);
            // Check if NAV date is today; if not, mark as LOCF (stale)
            const mfNavIsStale = navData.date && navData.date !== today;
            console.log(`  ${inv.name} (id=${inv.id}): MF NAV fetch returned nav=${navData.nav}, navDate=${navData.date}, stale=${mfNavIsStale}`);
            pricePerUnit = navData.nav;
            apiChange = navData.change;
            apiChangePct = navData.changePercent;
            priceSource = mfNavIsStale ? 'LOCF' : 'LIVE';
          } else {
            console.warn(`  ${inv.name}: No AMFI code, computing from transactions only`);
          }
          break;
        }
        case 'INDIAN_STOCK': {
          if (!inv.ticker_symbol) {
            console.warn(`  Skipping ${inv.name}: No ticker symbol`);
            continue;
          }
          await delay(500);
          const stockTicker = inv.ticker_symbol.includes('.') ? inv.ticker_symbol : toNSETicker(inv.ticker_symbol);
          const stockData = await fetchStockPrice(stockTicker);
          pricePerUnit = stockData.price;
          apiChange = stockData.change;
          apiChangePct = stockData.changePercent;
          // NSE-traded stock; check if market was open today
          priceSource = getMarketDataSourceForNSE(today);
          console.log(`  ${inv.name} (id=${inv.id}): INDIAN_STOCK price fetch returned price=${stockData.price}, priceSource=${priceSource}`);
          break;
        }
        case 'FOREIGN_STOCK': {
          if (!inv.ticker_symbol) {
            console.warn(`  Skipping ${inv.name}: No ticker symbol`);
            continue;
          }
          await delay(500);
          const foreignData = await fetchStockPrice(inv.ticker_symbol);
          pricePerUnit = foreignData.price;
          apiChange = foreignData.change;
          apiChangePct = foreignData.changePercent;
          // Foreign stocks on various exchanges; use conservative NSE-hours check
          // (doesn't account for exchange-specific times, but better than always LIVE)
          priceSource = getMarketDataSourceForNSE(today);
          console.log(`  ${inv.name} (id=${inv.id}): FOREIGN_STOCK price fetch returned price=${foreignData.price}, priceSource=${priceSource}`);
          break;
        }
        case 'BOND': {
          pricePerUnit = inv.face_value || 1000;
          break;
        }
        case 'SGB': {
          if (inv.ticker_symbol) {
            try {
              const sgbData = await fetchSGBPrice(inv.ticker_symbol);
              pricePerUnit = sgbData.price;
              apiChange = sgbData.change;
              apiChangePct = sgbData.changePercent;
              // NSE-traded security; check if market was open today
              priceSource = getMarketDataSourceForNSE(today);
              console.log(`  ${inv.name} (id=${inv.id}): SGB price fetch returned price=${sgbData.price}, priceSource=${priceSource}`);
            } catch (e) {
              console.warn(`  ${inv.name}: NSE price fetch failed (${e.message}), falling back to last known price`);
            }
          }
          if (!pricePerUnit) {
            const lastKnown = db.prepare(
              'SELECT price_per_unit FROM daily_values WHERE investment_id = ? ORDER BY date DESC LIMIT 1'
            ).get(inv.id);
            if (lastKnown) pricePerUnit = lastKnown.price_per_unit;
            if (lastKnown) priceSource = 'LOCF';
          }
          if (!pricePerUnit) {
            pricePerUnit = inv.face_value || 5000;
          }
          break;
        }
        case 'PPF':
        case 'SSY':
        case 'PF': {
          const rateRow = db.prepare(
            'SELECT rate FROM interest_rates WHERE rate_type = ? ORDER BY effective_from DESC LIMIT 1'
          ).get(inv.asset_type);
          pricePerUnit = rateRow ? rateRow.rate : (inv.asset_type === 'PPF' ? 7.1 : inv.asset_type === 'SSY' ? 8.2 : 8.25);
          const rateHistory = db.prepare(
            'SELECT rate, effective_from, effective_to FROM interest_rates WHERE rate_type = ? ORDER BY effective_from ASC'
          ).all(inv.asset_type);
          inv._rateHistory = rateHistory.length > 0 ? rateHistory : null;
          break;
        }
        case 'NPS': {
          try {
            // Get last known NAV for realistic variation
            const lastKnownPrice = db.prepare(
              'SELECT price_per_unit FROM daily_values WHERE investment_id = ? ORDER BY date DESC LIMIT 1'
            ).get(inv.id)?.price_per_unit;
            
            await delay(300); // Rate limiting for API calls
            const npsData = await fetchNPSNAV(inv.name, inv.nps_fund_code, lastKnownPrice);
            // NPS NAVs are published after market close and may lag by 1–2 days.
            // If the API's Last Updated date is not today, treat it as LOCF (carry-forward)
            // so we don't falsely label stale data as LIVE.
            const navIsStale = npsData.date && npsData.date !== today;
            console.log(`  ${inv.name} (id=${inv.id}): NPS NAV fetch returned nav=${npsData.nav}, navDate=${npsData.date}, previousPrice=${lastKnownPrice}, change=${npsData.change}, stale=${navIsStale}`);
            pricePerUnit = npsData.nav;
            apiChange = npsData.change;
            apiChangePct = npsData.changePercent;
            priceSource = navIsStale ? 'LOCF' : 'LIVE';
          } catch (e) {
            console.warn(`  ${inv.name}: NPS NAV fetch failed (${e.message}), falling back to last known price`);
            // Fallback 1: use last valid stored daily value (exclude placeholder 99.99)
            const lastStored = db.prepare(
              `SELECT price_per_unit
               FROM daily_values
               WHERE investment_id = ?
                 AND date <= ?
                 AND price_per_unit > 0
                 AND ABS(price_per_unit - 99.99) > 0.000001
               ORDER BY date DESC
               LIMIT 1`
            ).get(inv.id, today);
            if (lastStored?.price_per_unit) {
              pricePerUnit = Number(lastStored.price_per_unit);
              priceSource = 'LOCF';
            }

            // Fallback 2: use last valid transaction price
            if (!pricePerUnit) {
              const lastTxn = db.prepare(
                `SELECT price_per_unit
                 FROM transactions
                 WHERE investment_id = ?
                   AND transaction_date <= ?
                   AND price_per_unit > 0
                   AND ABS(price_per_unit - 99.99) > 0.000001
                 ORDER BY transaction_date DESC, id DESC
                 LIMIT 1`
              ).get(inv.id, today);
              if (lastTxn?.price_per_unit) {
                pricePerUnit = Number(lastTxn.price_per_unit);
                priceSource = 'COMPUTED';
              }
            }
          }
          break;
        }
      }

      // ...existing code for daily_values, rollups, etc...
      const portfolioIds = getDistinctPortfolios.all(inv.id, today).map(r => r.portfolio_id);
      for (const pid of portfolioIds) {
        let totalUnits, investedAmount, realizedCashflow, currentValue;
        if (inv.asset_type === 'PPF' || inv.asset_type === 'SSY' || inv.asset_type === 'PF') {
          currentValue = getProvidentValueAsOfDate(db, inv, today, pid);
          totalUnits = 1;
          investedAmount = getInvestedAmountPortfolio.get(inv.id, pid, today).total;
          realizedCashflow = getRealizedCashflowPortfolio(inv, pid, today);
        } else {
          const scopeOpenUnits = Number(getOpenUnitsPortfolio.get(inv.id, pid, today)?.total || 0);
          if (scopeOpenUnits <= 0.0001) {
            deleteTodaySnapshotForScope.run(inv.id, pid, today);
            continue;
          }

          totalUnits = getTotalUnitsPortfolio.get(inv.id, pid, today).total;
          investedAmount = getInvestedAmountPortfolio.get(inv.id, pid, today).total;
          realizedCashflow = getRealizedCashflowPortfolio(inv, pid, today);
          if (inv.asset_type === 'FOREIGN_STOCK') {
            currentValue = totalUnits * pricePerUnit * usdToInr;
          } else if (inv.asset_type === 'BOND') {
            const bondTransactions = getBondTransactionsPortfolio.all(inv.id, pid, today);
            const accrual = computeBondAccruedCoupon({
              investment: inv,
              transactions: bondTransactions,
              asOfDate: today,
              dayCount: 365,
            });

            currentValue = totalUnits * pricePerUnit + Number(accrual?.accruedCoupon || 0);

            if (accrual?.meta?.missingExpectedCouponPayment) {
              logAppWarn('[UpdatePrices][BondAccrual] Expected coupon transaction missing on scheduled date', {
                investmentId: inv.id,
                investmentName: inv.name,
                portfolioId: pid,
                date: today,
                couponFrequency: accrual?.meta?.couponFrequency || null,
                expectedCouponDate: accrual?.meta?.expectedCouponDate || null,
                lastCouponDate: accrual?.meta?.lastCouponDate || null,
              });
            }
          } else {
            currentValue = totalUnits * pricePerUnit;
          }
        }
        const reinvestedType = inv.asset_type === 'PPF' || inv.asset_type === 'SSY' || inv.asset_type === 'PF';
        const realizedGain = inv.asset_type === 'PF'
          ? realizedCashflow
          : (reinvestedType ? 0 : realizedCashflow);
        const profitLoss = reinvestedType
          ? (currentValue - investedAmount)
          : (currentValue + realizedGain - investedAmount);
        const prevRows = getPrevRowsPortfolio.all(inv.id, pid, today);
        const previousRow = prevRows.find((row) => {
          const rowUnits = Number(row?.total_units || 0);
          if (Math.abs(rowUnits) <= DAY_CHANGE_EPSILON_UNITS) return false;

          if (!isMarketLinkedAssetType(inv.asset_type)) {
            return true;
          }

          if (String(row?.price_source || '') === 'LOCF') return false;
          return isWithinPreviousMarketSessions(row.date, today, db, marketHolidayCache);
        });

        const prevValue = Number(previousRow?.current_value || 0);
        const netFlowToday = Number(getNetFlowTodayPortfolio.get(inv.id, pid, today)?.net_flow || 0);
        const dayChange = previousRow
          ? (currentValue - prevValue - netFlowToday)
          : 0;
        upsertDaily.run(
          inv.id, pid, today,
          quantizeForStorage(pricePerUnit),
          quantizeForStorage(totalUnits),
          quantizeForStorage(currentValue),
          quantizeForStorage(investedAmount),
          quantizeForStorage(realizedGain),
          quantizeForStorage(profitLoss),
          priceSource,
          quantizeForStorage(dayChange)
        );

        const assetType = String(inv.asset_type || '');
        if (
          priceSource === 'LOCF'
          && (LOCF_LAG_RECONCILE_ASSET_TYPES.has(assetType) || assetType === 'FOREIGN_STOCK')
          && isMarketSessionDate(today, db, marketHolidayCache)
        ) {
          const priorStreak = getPriorMarketSessionLocfStreak(db, inv.id, pid, today, marketHolidayCache);
          const currentStreak = priorStreak + 1;
          const warnKey = `${inv.id}:${pid}:${today}`;
          if (currentStreak >= 3 && !warnedUnexpectedLocf.has(warnKey)) {
            warnedUnexpectedLocf.add(warnKey);
            logAppWarn('[UpdatePrices][LOCF] Unexpected LOCF streak reached threshold', {
              investmentId: inv.id,
              investmentName: inv.name,
              portfolioId: pid,
              assetType,
              date: today,
              streak: currentStreak,
            });
          }

          // Enqueue a dirty scope for all lag-reconcile types so backfill
          // re-processes this date once the real price arrives from the provider.
          // FOREIGN_STOCK is excluded here — its settlement-aware reconcile path
          // in ensureForeignReconcileScopes handles it each scheduler cycle.
          if (LOCF_LAG_RECONCILE_ASSET_TYPES.has(assetType)) {
            markScopeDirty(db, {
              investmentId: inv.id,
              portfolioId: pid,
              dirtyFromDate: today,
              reason: 'locf-lag-signal',
              sourceEventId: `update-prices-locf:${today}`,
            });
          }
        }
      }
      const combinedSnapshot = db.prepare(`
        SELECT
          COALESCE(SUM(current_value), 0) AS total_value,
          COALESCE(SUM(profit_loss), 0) AS total_profit_loss
        FROM daily_values
        WHERE investment_id = ? AND date = ?
      `).get(inv.id, today);
      const combinedValue = Number(combinedSnapshot?.total_value || 0);
      const combinedPL = Number(combinedSnapshot?.total_profit_loss || 0);
      console.log(`  ✓ ${inv.name}: ₹${Math.round(combinedValue).toLocaleString()} (${combinedPL >= 0 ? '+' : ''}${Math.round(combinedPL).toLocaleString()})`);
      successCount++;
      const processed = successCount + errorCount + skippedCount;
      logAppInfo('[UpdatePrices][Step-2] Investment updated', {
        investmentId: inv.id,
        investmentName: inv.name,
        assetType: inv.asset_type,
        processed,
        total: totalCount,
      });

      const now = Date.now();
      if (processed === totalCount || now - heartbeatAt >= 30000) {
        const elapsedSec = Math.max(Math.floor((now - runStartedAt) / 1000), 1);
        const avgSecPerItem = processed > 0 ? (elapsedSec / processed) : 0;
        const remaining = Math.max(totalCount - processed, 0);
        const etaSec = Math.max(Math.round(remaining * avgSecPerItem), 0);
        const progressPct = totalCount > 0 ? Number(((processed / totalCount) * 100).toFixed(2)) : 100;

        logAppInfo('[UpdatePrices][Step-2][Heartbeat] Iterating investments', {
          processed,
          total: totalCount,
          remaining,
          successCount,
          errorCount,
          skippedCount,
          progressPct,
          etaSec,
          currentInvestmentId: inv.id,
          currentInvestmentName: inv.name,
        });
        heartbeatAt = now;
      }
      await new Promise(r => setTimeout(r, 300));
    } catch (e) {
      console.error(`  ✗ ${inv.name}: ${e.message}`);
      errorCount++;
      const processed = successCount + errorCount + skippedCount;
      logAppError('[UpdatePrices][Step-2] Investment update failed', {
        investmentId: inv.id,
        investmentName: inv.name,
        assetType: inv.asset_type,
        error: e.message,
        processed,
        total: totalCount,
      });
    }
  }

  // Update portfolio daily snapshots (per-portfolio + combined)
  logAppInfo('[UpdatePrices] Step 3/3 refreshing aggregate snapshots', {
    date: today,
    processed: successCount + errorCount + skippedCount,
    total: totalCount,
  });
  updatePortfolioDaily(db, today);
  updateAssetTypeDaily(db, today);

  // Update last price update time
  db.prepare("UPDATE config SET value = ?, updated_at = datetime('now') WHERE key = 'last_price_update'")
    .run(new Date().toISOString());

  // Persist daily watermark only for fully successful, non-cancelled runs.
  let watermarkUpdated = false;
  if (!_cancelled && errorCount === 0) {
    db.prepare(`
      INSERT INTO config (key, value, updated_at)
      VALUES ('price_update_watermark', ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = datetime('now')
    `).run(today);
    watermarkUpdated = true;
  }

  const cancelled = _cancelled;
  _cancelled = false;
  console.log(`[${new Date().toISOString()}] Price update ${cancelled ? 'cancelled' : 'done'}. Success: ${successCount}, Errors: ${errorCount}`);
  logAppInfo('[UpdatePrices] Completed', {
    date: today,
    cancelled,
    successCount,
    errorCount,
    skippedCount,
    totalProcessed: successCount + errorCount + skippedCount,
    totalCount,
    watermarkUpdated,
    elapsedSec: Math.max(Math.round((Date.now() - runStartedAt) / 1000), 0),
  });
  return {
    successCount,
    errorCount,
    cancelled,
    date: today,
    watermarkUpdated,
    processed: successCount,
    errors: errorCount,
  };
}

/**
 * Update portfolio-level daily snapshots (portfolio-scoped only).
 */
function updatePortfolioDaily(db, date) {
  const insertPortfolioDaily = db.prepare(`
    INSERT INTO portfolio_daily (portfolio_id, date, total_value, total_invested, total_profit_loss, total_profit_loss_pct, day_change, day_change_pct)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const deleteRowsForDate = db.prepare('DELETE FROM portfolio_daily WHERE date = ?');

  const totalsRows = db.prepare(`
    SELECT
      dv.portfolio_id,
      COALESCE(SUM(dv.current_value), 0) as total_value,
      COALESCE(SUM(dv.invested_amount), 0) as total_invested,
      COALESCE(SUM(dv.profit_loss), 0) as total_profit_loss,
      COALESCE(SUM(dv.day_change), 0) as day_change
    FROM daily_values dv
    INNER JOIN (
      SELECT investment_id, portfolio_id, MAX(date) as max_date
      FROM daily_values
      WHERE date <= ? AND portfolio_id IS NOT NULL
      GROUP BY investment_id, portfolio_id
    ) latest ON dv.investment_id = latest.investment_id
      AND dv.portfolio_id = latest.portfolio_id
      AND dv.date = latest.max_date
    GROUP BY dv.portfolio_id
  `).all(date);

  const previousRows = db.prepare(`
    SELECT pd.portfolio_id, pd.total_value
    FROM portfolio_daily pd
    INNER JOIN (
      SELECT portfolio_id, MAX(date) as max_date
      FROM portfolio_daily
      WHERE date < ?
      GROUP BY portfolio_id
    ) prev ON pd.portfolio_id = prev.portfolio_id
      AND pd.date = prev.max_date
  `).all(date);

  const keyOf = (portfolioId) => String(portfolioId);
  const totalsByPortfolio = new Map();
  for (const row of totalsRows) totalsByPortfolio.set(keyOf(row.portfolio_id), row);
  const prevByPortfolio = new Map();
  for (const row of previousRows) prevByPortfolio.set(keyOf(row.portfolio_id), Number(row.total_value || 0));

  // Get all distinct portfolio_ids from transactions
  const portfolioIds = db.prepare(`
    SELECT DISTINCT t.portfolio_id FROM transactions t
    JOIN investments i ON t.investment_id = i.id
    WHERE t.portfolio_id IS NOT NULL
  `).all().map(r => r.portfolio_id);

  // Rebuild rows for this date in one pass (portfolio-scoped only, no combined/NULL)
  deleteRowsForDate.run(date);

  for (const pid of portfolioIds) {
    const totals = totalsByPortfolio.get(keyOf(pid)) || {
      total_value: 0,
      total_invested: 0,
      total_profit_loss: 0,
      day_change: 0,
    };

    const profitPct = totals.total_invested > 0
      ? (totals.total_profit_loss / totals.total_invested) * 100 : 0;

    const prevValue = prevByPortfolio.has(keyOf(pid))
      ? prevByPortfolio.get(keyOf(pid))
      : Number(totals.total_value || 0);
    const dayChangePct = prevValue > 0 ? (totals.day_change / prevValue) * 100 : 0;

    insertPortfolioDaily.run(
      pid,
      date,
      quantizeForStorage(totals.total_value),
      quantizeForStorage(totals.total_invested),
      quantizeForStorage(totals.total_profit_loss),
      quantizeForStorage(profitPct),
      quantizeForStorage(totals.day_change),
      quantizeForStorage(dayChangePct)
    );
  }
}

/**
 * Update asset-type level daily snapshots for each portfolio (no combined/NULL rows).
 */
function updateAssetTypeDaily(db, date) {
  const deleteRows = db.prepare('DELETE FROM asset_type_daily WHERE date = ?');
  const insertRow = db.prepare(`
    INSERT INTO asset_type_daily (
      portfolio_id,
      asset_type,
      date,
      total_value,
      total_invested,
      total_profit_loss,
      total_realized_proceeds,
      total_unrealized_gain,
      total_profit_loss_pct,
      day_change,
      day_change_pct
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Use latest available row per (investment, portfolio) pair so that a partial
  // intraday run (e.g. stocks-only) still carries forward non-updated asset types.
  const aggregateRows = db.prepare(`
    SELECT
      dv.portfolio_id,
      i.asset_type,
      COALESCE(SUM(dv.current_value), 0) AS total_value,
      COALESCE(SUM(dv.invested_amount), 0) AS total_invested,
      COALESCE(SUM(dv.profit_loss), 0) AS total_profit_loss,
      COALESCE(SUM(dv.realized_proceeds), 0) AS total_realized_proceeds,
      COALESCE(SUM(dv.current_value - (dv.invested_amount - dv.realized_proceeds)), 0) AS total_unrealized_gain,
      COALESCE(SUM(dv.day_change), 0) AS day_change
    FROM daily_values dv
    JOIN investments i ON i.id = dv.investment_id
    INNER JOIN (
      SELECT investment_id, portfolio_id, MAX(date) as max_date
      FROM daily_values
      WHERE date <= ? AND portfolio_id IS NOT NULL
      GROUP BY investment_id, portfolio_id
    ) latest ON dv.investment_id = latest.investment_id
      AND dv.portfolio_id = latest.portfolio_id
      AND dv.date = latest.max_date
    WHERE i.exclude_from_tracking != 1
    GROUP BY dv.portfolio_id, i.asset_type
  `);

  const previousRows = db.prepare(`
    SELECT atd.portfolio_id, atd.asset_type, atd.total_value
    FROM asset_type_daily atd
    INNER JOIN (
      SELECT portfolio_id, asset_type, MAX(date) AS max_date
      FROM asset_type_daily
      WHERE date < ?
      GROUP BY portfolio_id, asset_type
    ) prev ON atd.portfolio_id = prev.portfolio_id
      AND atd.asset_type = prev.asset_type
      AND atd.date = prev.max_date
  `).all(date);

  const prevKey = (portfolioId, assetType) => `${String(portfolioId)}::${assetType}`;
  const previousTotals = new Map();
  for (const row of previousRows) {
    previousTotals.set(prevKey(row.portfolio_id, row.asset_type), Number(row.total_value || 0));
  }

  deleteRows.run(date);
  const rows = aggregateRows.all(date);

  for (const row of rows) {
    const totalInvested = Number(row.total_invested || 0);
    const totalProfitLoss = Number(row.total_profit_loss || 0);
    const totalValue = Number(row.total_value || 0);
    const dayChange = Number(row.day_change || 0);

    const totalProfitLossPct = totalInvested > 0
      ? (totalProfitLoss / totalInvested) * 100
      : 0;

    const prevValue = previousTotals.get(prevKey(row.portfolio_id, row.asset_type)) || 0;
    const dayChangePct = prevValue > 0
      ? (dayChange / prevValue) * 100
      : 0;

    insertRow.run(
      row.portfolio_id,
      row.asset_type,
      date,
      quantizeForStorage(totalValue),
      quantizeForStorage(totalInvested),
      quantizeForStorage(totalProfitLoss),
      quantizeForStorage(row.total_realized_proceeds),
      quantizeForStorage(row.total_unrealized_gain),
      quantizeForStorage(totalProfitLossPct),
      quantizeForStorage(dayChange),
      quantizeForStorage(dayChangePct)
    );
  }
}

function buildDateRange(fromDate, toDate) {
  const out = [];
  let d = fromDate;
  while (d <= toDate) {
    out.push(d);
    d = addDaysIso(d, 1);
  }
  return out;
}

function portfolioKey(portfolioId) {
  return String(portfolioId);
}

function assetKey(portfolioId, assetType) {
  return `${String(portfolioId)}::${assetType}`;
}

function ensurePortfolioTotals(map, portfolioId) {
  const key = portfolioKey(portfolioId);
  if (!map.has(key)) {
    map.set(key, {
      total_value: 0,
      total_invested: 0,
      total_profit_loss: 0,
      day_change: 0,
    });
  }
  return map.get(key);
}

function ensureAssetTotals(map, portfolioId, assetType) {
  const key = assetKey(portfolioId, assetType);
  if (!map.has(key)) {
    map.set(key, {
      portfolio_id: portfolioId,
      asset_type: assetType,
      total_value: 0,
      total_invested: 0,
      total_profit_loss: 0,
      total_realized_proceeds: 0,
      total_unrealized_gain: 0,
      day_change: 0,
    });
  }
  return map.get(key);
}

function applySnapshotDelta(portfolioTotals, assetTotals, snapshot, sign) {
  const factor = sign >= 0 ? 1 : -1;
  const value = Number(snapshot.current_value || 0);
  const invested = Number(snapshot.invested_amount || 0);
  const profit = Number(snapshot.profit_loss || 0);
  const realized = Number(snapshot.realized_proceeds || 0);
  const dayChange = Number(snapshot.day_change || 0);
  const unrealized = value - (invested - realized);

  const p = ensurePortfolioTotals(portfolioTotals, snapshot.portfolio_id);
  p.total_value += factor * value;
  p.total_invested += factor * invested;
  p.total_profit_loss += factor * profit;
  p.day_change += factor * dayChange;

  const a = ensureAssetTotals(assetTotals, snapshot.portfolio_id, snapshot.asset_type);
  a.total_value += factor * value;
  a.total_invested += factor * invested;
  a.total_profit_loss += factor * profit;
  a.total_realized_proceeds += factor * realized;
  a.total_unrealized_gain += factor * unrealized;
  a.day_change += factor * dayChange;
}

function updateAggregateDailyRange(db, fromDate, toDate, options = {}) {
  if (!fromDate || !toDate || fromDate > toDate) return;

  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const dates = buildDateRange(fromDate, toDate);

  const rangeSnapshots = db.prepare(`
    SELECT
      dv.date,
      dv.investment_id,
      dv.portfolio_id,
      i.asset_type,
      COALESCE(dv.current_value, 0) AS current_value,
      COALESCE(dv.invested_amount, 0) AS invested_amount,
      COALESCE(dv.profit_loss, 0) AS profit_loss,
      COALESCE(dv.realized_proceeds, 0) AS realized_proceeds,
      COALESCE(dv.day_change, 0) AS day_change
    FROM daily_values dv
    JOIN investments i ON i.id = dv.investment_id
    WHERE dv.date >= ?
      AND dv.date <= ?
      AND dv.portfolio_id IS NOT NULL
      AND i.exclude_from_tracking != 1
    ORDER BY dv.date ASC, dv.investment_id ASC, dv.portfolio_id ASC
  `).all(fromDate, toDate);

  const snapshotsByDate = new Map();
  for (const row of rangeSnapshots) {
    const list = snapshotsByDate.get(row.date) || [];
    list.push(row);
    snapshotsByDate.set(row.date, list);
  }

  const prevPortfolioRows = db.prepare(`
    SELECT pd.portfolio_id, pd.total_value
    FROM portfolio_daily pd
    INNER JOIN (
      SELECT portfolio_id, MAX(date) as max_date
      FROM portfolio_daily
      WHERE date < ?
      GROUP BY portfolio_id
    ) prev ON pd.portfolio_id = prev.portfolio_id
      AND pd.date = prev.max_date
  `).all(fromDate);

  const prevAssetRows = db.prepare(`
    SELECT atd.portfolio_id, atd.asset_type, atd.total_value
    FROM asset_type_daily atd
    INNER JOIN (
      SELECT portfolio_id, asset_type, MAX(date) AS max_date
      FROM asset_type_daily
      WHERE date < ?
      GROUP BY portfolio_id, asset_type
    ) prev ON atd.portfolio_id = prev.portfolio_id
      AND atd.asset_type = prev.asset_type
      AND atd.date = prev.max_date
  `).all(fromDate);

  const prevPortfolioValue = new Map();
  for (const row of prevPortfolioRows) {
    prevPortfolioValue.set(portfolioKey(row.portfolio_id), Number(row.total_value || 0));
  }
  const prevAssetValue = new Map();
  for (const row of prevAssetRows) {
    prevAssetValue.set(assetKey(row.portfolio_id, row.asset_type), Number(row.total_value || 0));
  }

  db.prepare('DELETE FROM portfolio_daily WHERE date >= ? AND date <= ?').run(fromDate, toDate);
  db.prepare('DELETE FROM asset_type_daily WHERE date >= ? AND date <= ?').run(fromDate, toDate);

  const insertPortfolioDaily = db.prepare(`
    INSERT INTO portfolio_daily (portfolio_id, date, total_value, total_invested, total_profit_loss, total_profit_loss_pct, day_change, day_change_pct)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertAssetDaily = db.prepare(`
    INSERT INTO asset_type_daily (
      portfolio_id,
      asset_type,
      date,
      total_value,
      total_invested,
      total_profit_loss,
      total_realized_proceeds,
      total_unrealized_gain,
      total_profit_loss_pct,
      day_change,
      day_change_pct
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    for (let i = 0; i < dates.length; i += 1) {
      const date = dates[i];
      const changed = snapshotsByDate.get(date) || [];
      const portfolioTotalsForDate = new Map();
      const assetTotalsForDate = new Map();

      for (const row of changed) {
        const p = ensurePortfolioTotals(portfolioTotalsForDate, row.portfolio_id);
        p.total_value += Number(row.current_value || 0);
        p.total_invested += Number(row.invested_amount || 0);
        p.total_profit_loss += Number(row.profit_loss || 0);
        p.day_change += Number(row.day_change || 0);

        const a = ensureAssetTotals(assetTotalsForDate, row.portfolio_id, row.asset_type);
        const currentValue = Number(row.current_value || 0);
        const investedAmount = Number(row.invested_amount || 0);
        const profitLoss = Number(row.profit_loss || 0);
        const realizedProceeds = Number(row.realized_proceeds || 0);
        const dayChange = Number(row.day_change || 0);
        const unrealizedGain = currentValue - (investedAmount - realizedProceeds);

        a.total_value += currentValue;
        a.total_invested += investedAmount;
        a.total_profit_loss += profitLoss;
        a.total_realized_proceeds += realizedProceeds;
        a.total_unrealized_gain += unrealizedGain;
        a.day_change += dayChange;
      }

      for (const [pidKey, totals] of portfolioTotalsForDate.entries()) {
        const pid = Number(pidKey);
        const prev = prevPortfolioValue.has(portfolioKey(pid))
          ? prevPortfolioValue.get(portfolioKey(pid))
          : Number(totals.total_value || 0);
        const dayChangePct = prev > 0 ? (Number(totals.day_change || 0) / prev) * 100 : 0;
        const profitPct = Number(totals.total_invested || 0) > 0
          ? (Number(totals.total_profit_loss || 0) / Number(totals.total_invested || 0)) * 100
          : 0;

        insertPortfolioDaily.run(
          pid,
          date,
          quantizeForStorage(totals.total_value),
          quantizeForStorage(totals.total_invested),
          quantizeForStorage(totals.total_profit_loss),
          quantizeForStorage(profitPct),
          quantizeForStorage(totals.day_change),
          quantizeForStorage(dayChangePct)
        );
        prevPortfolioValue.set(portfolioKey(pid), Number(totals.total_value || 0));
      }

      for (const [k, totals] of assetTotalsForDate.entries()) {
        const prev = prevAssetValue.get(k) || 0;
        const dayChangePct = prev > 0 ? (Number(totals.day_change || 0) / prev) * 100 : 0;
        const totalInvested = Number(totals.total_invested || 0);
        const totalProfitLoss = Number(totals.total_profit_loss || 0);
        const totalProfitLossPct = totalInvested > 0 ? (totalProfitLoss / totalInvested) * 100 : 0;

        insertAssetDaily.run(
          totals.portfolio_id,
          totals.asset_type,
          date,
          quantizeForStorage(totals.total_value),
          quantizeForStorage(totals.total_invested),
          quantizeForStorage(totals.total_profit_loss),
          quantizeForStorage(totals.total_realized_proceeds),
          quantizeForStorage(totals.total_unrealized_gain),
          quantizeForStorage(totalProfitLossPct),
          quantizeForStorage(totals.day_change),
          quantizeForStorage(dayChangePct)
        );
        prevAssetValue.set(k, Number(totals.total_value || 0));
      }

      if (onProgress) onProgress(i + 1, dates.length, date);
    }
  });

  tx();
}

module.exports = {
  updateAllPrices,
  updatePortfolioDaily,
  updateAssetTypeDaily,
  updateAggregateDailyRange,
  cancelUpdate,
};
