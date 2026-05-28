/**
 * Daily price update service.
 * Fetches latest prices for all active investments and stores daily snapshots.
 */

const {
  fetchMutualFundNAV,
  fetchStockPrice,
  fetchUSDToINR,
  toNSETicker,
  resolveAmfiCodeByISIN,
  fetchSGBPrice,
  fetchNPSNAV,
} = require('./priceService');
const { calculatePfInterestPreview, calculatePfValueAsOfDate, calculateSmallSavingsValueAsOfDate } = require('./pfInterestCalculator');
const { logAppInfo, logAppError } = require('./appLogger');
const {
  INVESTED_AMOUNT_INFLOW_TYPES_SQL,
  REALIZED_CASHFLOW_TYPES,
  REALIZED_CASHFLOW_TYPES_REINVEST_ACCRUAL,
} = require('../constants/transactionTypes');
const {
  quantizeForStorage,
} = require('./numberPrecision');
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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
 */
async function updateAllPrices(db, options = {}) {
  _cancelled = false;
  const today = new Date().toISOString().split('T')[0];
  const typeFilter = options.assetTypes;
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

  // Skip fully-sold investments (net units ≤ 0). Balance-based types (PPF/SSY/PF/NPS)
  // don't use units, so they are always included.
  const BALANCE_BASED_TYPES = new Set(['PPF', 'SSY', 'PF', 'NPS']);
  const openInvestmentIds = new Set(
    db.prepare(`
      SELECT investment_id FROM transactions
      WHERE transaction_date <= ?
      GROUP BY investment_id
      HAVING SUM(CASE
        WHEN transaction_type IN ('BUY', 'DEPOSIT', 'BONUS', 'SPLIT', 'IPO', 'TRANSFER_IN', 'SWITCH_IN', 'RIGHTS', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION') THEN COALESCE(units, 0)
        WHEN transaction_type IN ('SELL', 'WITHDRAWAL', 'TRANSFER_OUT', 'SWITCH_OUT', 'CONSOLIDATION', 'CHARGES', 'AMC') THEN -COALESCE(units, 0)
        ELSE 0
      END) > 0.0001
    `).all(today).map(r => r.investment_id)
  );
  investments = investments.filter(i => BALANCE_BASED_TYPES.has(i.asset_type) || openInvestmentIds.has(i.id));

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

  // Fetch USD/INR rate for foreign stocks
  let usdToInr = parseFloat(db.prepare("SELECT value FROM config WHERE key = 'usd_to_inr'").get()?.value || '83.5');
  try {
    usdToInr = await fetchUSDToINR();
    db.prepare("UPDATE config SET value = ?, updated_at = datetime('now') WHERE key = 'usd_to_inr'").run(String(usdToInr));
    logAppInfo('[UpdatePrices] USD/INR rate refreshed', { usdToInr });
  } catch (e) {
    console.warn('Could not update USD/INR rate, using cached value:', usdToInr);
    logAppError('[UpdatePrices] USD/INR refresh failed, using cached value', { error: e.message, usdToInr });
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
        WHEN transaction_type IN ('BUY', 'DEPOSIT', 'BONUS', 'SPLIT', 'IPO', 'TRANSFER_IN', 'SWITCH_IN', 'RIGHTS', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION') THEN COALESCE(units, 0)
        WHEN transaction_type IN ('SELL', 'WITHDRAWAL', 'TRANSFER_OUT', 'SWITCH_OUT', 'CONSOLIDATION', 'CHARGES', 'AMC') THEN -COALESCE(units, 0)
        ELSE 0
      END), 0
    ) as total
    FROM transactions WHERE investment_id = ? AND portfolio_id = ? AND transaction_date <= ?
  `);

  const getPrevDayPortfolio = db.prepare(`
    SELECT price_per_unit, current_value FROM daily_values
    WHERE investment_id = ? AND portfolio_id = ? AND date < ?
    ORDER BY date DESC LIMIT 1
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

  let successCount = 0;
  let errorCount = 0;
  let skippedCount = 0;
  const totalCount = investments.length;
  let heartbeatAt = Date.now();


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
      let pricePerUnit = 0;
      let priceSource = 'COMPUTED';
      let apiChange = null;
      let apiChangePct = null;
      
      console.log(`  [DEBUG] Processing ${inv.name} (id=${inv.id}, type=${inv.asset_type})`);

      switch (inv.asset_type) {
        case 'MUTUAL_FUND': {
          if (inv.amfi_code) {
            const navData = await fetchMutualFundNAV(inv.amfi_code);
            pricePerUnit = navData.nav;
            apiChange = navData.change;
            apiChangePct = navData.changePercent;
            priceSource = 'LIVE';
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
          priceSource = 'LIVE';
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
          priceSource = 'LIVE';
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
              priceSource = 'LIVE';
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
            console.log(`  ${inv.name} (id=${inv.id}): NPS NAV fetch returned nav=${npsData.nav}, previousPrice=${lastKnownPrice}, change=${npsData.change}`);
            pricePerUnit = npsData.nav;
            apiChange = npsData.change;
            apiChangePct = npsData.changePercent;
            priceSource = 'LIVE';
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
          totalUnits = getTotalUnitsPortfolio.get(inv.id, pid, today).total;
          investedAmount = getInvestedAmountPortfolio.get(inv.id, pid, today).total;
          realizedCashflow = getRealizedCashflowPortfolio(inv, pid, today);
          if (inv.asset_type === 'FOREIGN_STOCK') {
            currentValue = totalUnits * pricePerUnit * usdToInr;
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
        const prevDay = getPrevDayPortfolio.get(inv.id, pid, today);
        const prevValue = Number(prevDay?.current_value || 0);
        const netFlowToday = Number(getNetFlowTodayPortfolio.get(inv.id, pid, today)?.net_flow || 0);
        const dayChange = currentValue - prevValue - netFlowToday;
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

module.exports = { updateAllPrices, updatePortfolioDaily, updateAssetTypeDaily, cancelUpdate };
