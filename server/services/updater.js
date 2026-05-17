/**
 * Daily price update service.
 * Fetches latest prices for all active investments and stores daily snapshots.
 */

const {
  fetchMutualFundNAV,
  fetchStockPrice,
  fetchUSDToINR,
  calculatePPFValue,
  toNSETicker,
  resolveAmfiCodeByISIN,
  fetchSGBPrice,
} = require('./priceService');


const { isAfterStaticAssetCutoff } = require('./dateUtils');
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ─── Cancellation support ──────────────────────────────────────────────────
let _cancelled = false;

function cancelUpdate() {
  _cancelled = true;
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

  // Auto-resolve missing AMFI codes for mutual funds using ISIN (single download)
  const mfsWithoutAmfi = investments.filter(i => i.asset_type === 'MUTUAL_FUND' && !i.amfi_code && i.isin_code);
  if (mfsWithoutAmfi.length > 0) {
    console.log(`  Resolving AMFI codes for ${mfsWithoutAmfi.length} mutual fund(s)...`);
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
    }
  }

  // Fetch USD/INR rate for foreign stocks
  let usdToInr = parseFloat(db.prepare("SELECT value FROM config WHERE key = 'usd_to_inr'").get()?.value || '83.5');
  try {
    usdToInr = await fetchUSDToINR();
    db.prepare("UPDATE config SET value = ?, updated_at = datetime('now') WHERE key = 'usd_to_inr'").run(String(usdToInr));
  } catch (e) {
    console.warn('Could not update USD/INR rate, using cached value:', usdToInr);
  }

  const upsertDaily = db.prepare(`
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

  // For combined (NULL portfolio_id) rows, ON CONFLICT doesn't work
  // (SQLite treats NULLs as distinct), so delete-then-insert.
  const deleteDailyCombined = db.prepare(
    'DELETE FROM daily_values WHERE investment_id = ? AND portfolio_id IS NULL AND date = ?'
  );
  const insertDailyCombined = db.prepare(`
    INSERT INTO daily_values (investment_id, portfolio_id, date, price_per_unit, total_units, current_value, invested_amount, realized_gain, profit_loss, profit_loss_pct, price_source, day_change, day_change_pct)
    VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const getInvestedAmount = db.prepare(`
    SELECT COALESCE(SUM(amount + COALESCE(fees, 0)), 0) as total
    FROM transactions WHERE investment_id = ? AND transaction_date <= ? AND transaction_type IN ('BUY', 'DEPOSIT', 'IPO', 'RIGHTS', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'ESPP_CONTRIBUTION')
  `);
  const getInvestedAmountPortfolio = db.prepare(`
    SELECT COALESCE(SUM(amount + COALESCE(fees, 0)), 0) as total
    FROM transactions WHERE investment_id = ? AND portfolio_id = ? AND transaction_date <= ? AND transaction_type IN ('BUY', 'DEPOSIT', 'IPO', 'RIGHTS', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'ESPP_CONTRIBUTION')
  `);

  const getSaleProceeds = db.prepare(`
    SELECT COALESCE(SUM(amount - COALESCE(fees, 0)), 0) as total
    FROM transactions WHERE investment_id = ? AND transaction_date <= ? AND transaction_type IN ('SELL', 'WITHDRAWAL', 'DIVIDEND', 'INTEREST')
  `);
  const getSaleProceedsPortfolio = db.prepare(`
    SELECT COALESCE(SUM(amount - COALESCE(fees, 0)), 0) as total
    FROM transactions WHERE investment_id = ? AND portfolio_id = ? AND transaction_date <= ? AND transaction_type IN ('SELL', 'WITHDRAWAL', 'DIVIDEND', 'INTEREST')
  `);

  const getTotalUnits = db.prepare(`
    SELECT COALESCE(
      SUM(CASE
        WHEN transaction_type IN ('BUY', 'DEPOSIT', 'BONUS', 'SPLIT', 'IPO', 'TRANSFER_IN', 'SWITCH_IN', 'RIGHTS', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION') THEN COALESCE(units, 0)
        WHEN transaction_type IN ('SELL', 'WITHDRAWAL', 'TRANSFER_OUT', 'SWITCH_OUT', 'CONSOLIDATION', 'CHARGES', 'AMC') THEN -COALESCE(units, 0)
        ELSE 0
      END), 0
    ) as total
    FROM transactions WHERE investment_id = ? AND transaction_date <= ?
  `);
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

  const getPrevDay = db.prepare(`
    SELECT price_per_unit, current_value FROM daily_values
    WHERE investment_id = ? AND portfolio_id IS NULL AND date < ?
    ORDER BY date DESC LIMIT 1
  `);
  const getPrevDayPortfolio = db.prepare(`
    SELECT price_per_unit, current_value FROM daily_values
    WHERE investment_id = ? AND portfolio_id = ? AND date < ?
    ORDER BY date DESC LIMIT 1
  `);

  const getDistinctPortfolios = db.prepare(`
    SELECT DISTINCT portfolio_id FROM transactions WHERE investment_id = ? AND portfolio_id IS NOT NULL AND transaction_date <= ?
  `);

  let successCount = 0;
  let errorCount = 0;


  const STATIC_TYPES = new Set(['PPF', 'SSY', 'PF', 'NPS', 'BOND']);
  for (const inv of investments) {
    if (_cancelled) {
      console.log('  ⏹ Update cancelled by user.');
      break;
    }
    // Only skip static assets for today’s row if before cutoff and not a backfill/dirty scope
    if (STATIC_TYPES.has(inv.asset_type) && !isAfterStaticAssetCutoff()) {
      console.log(`  ⏭ Skipping static asset ${inv.name} (type ${inv.asset_type}) before cutoff`);
      continue;
    }

    try {
      let pricePerUnit = 0;
      let priceSource = 'COMPUTED';
      let apiChange = null;
      let apiChangePct = null;

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
              'SELECT price_per_unit FROM daily_values WHERE investment_id = ? AND portfolio_id IS NULL ORDER BY date DESC LIMIT 1'
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
          const latestNav = db.prepare(
            'SELECT price_per_unit FROM transactions WHERE investment_id = ? AND transaction_date <= ? AND price_per_unit > 0 ORDER BY transaction_date DESC LIMIT 1'
          ).get(inv.id, today);
          if (latestNav) {
            pricePerUnit = latestNav.price_per_unit;
            priceSource = 'COMPUTED';
          }
          break;
        }
      }

      // ...existing code for daily_values, rollups, etc...
      const portfolioIds = getDistinctPortfolios.all(inv.id, today).map(r => r.portfolio_id);
      const pidsToProcess = [...portfolioIds, null];
      for (const pid of pidsToProcess) {
        let totalUnits, investedAmount, saleProceeds, currentValue;
        if (inv.asset_type === 'PPF' || inv.asset_type === 'SSY' || inv.asset_type === 'PF') {
          const rateParam = inv._rateHistory || pricePerUnit;
          const txnFilter = pid !== null ? " AND portfolio_id = ?" : "";
          const txnParams = pid !== null ? [inv.id, pid, today] : [inv.id, today];
          const txns = db.prepare(
            `SELECT transaction_date as date, amount FROM transactions WHERE investment_id = ? AND transaction_type IN ('DEPOSIT', 'BUY')${txnFilter} AND transaction_date <= ?`
          ).all(...txnParams);
          currentValue = calculatePPFValue(txns, rateParam);
          totalUnits = 1;
          if (pid !== null) {
            investedAmount = getInvestedAmountPortfolio.get(inv.id, pid, today).total;
            saleProceeds = getSaleProceedsPortfolio.get(inv.id, pid, today).total;
          } else {
            investedAmount = getInvestedAmount.get(inv.id, today).total;
            saleProceeds = getSaleProceeds.get(inv.id, today).total;
          }
        } else {
          if (pid !== null) {
            totalUnits = getTotalUnitsPortfolio.get(inv.id, pid, today).total;
            investedAmount = getInvestedAmountPortfolio.get(inv.id, pid, today).total;
            saleProceeds = getSaleProceedsPortfolio.get(inv.id, pid, today).total;
          } else {
            totalUnits = getTotalUnits.get(inv.id, today).total;
            investedAmount = getInvestedAmount.get(inv.id, today).total;
            saleProceeds = getSaleProceeds.get(inv.id, today).total;
          }
          if (inv.asset_type === 'FOREIGN_STOCK') {
            currentValue = totalUnits * pricePerUnit * usdToInr;
          } else {
            currentValue = totalUnits * pricePerUnit;
          }
        }
        const reinvestedType = inv.asset_type === 'PPF' || inv.asset_type === 'SSY' || inv.asset_type === 'PF';
        const realizedGain = reinvestedType ? 0 : saleProceeds;
        const profitLoss = reinvestedType
          ? (currentValue - investedAmount)
          : (currentValue + realizedGain - investedAmount);
        const profitLossPct = investedAmount > 0 ? (profitLoss / investedAmount) * 100 : 0;
        let dayChange = 0;
        let dayChangePct = 0;
        if (totalUnits > 0) {
          if (apiChange != null && apiChangePct != null) {
            dayChange = totalUnits * apiChange;
            dayChangePct = apiChangePct;
          } else {
            const prevDay = pid !== null
              ? getPrevDayPortfolio.get(inv.id, pid, today)
              : getPrevDay.get(inv.id, today);
            if (prevDay && prevDay.price_per_unit > 0) {
              dayChange = totalUnits * (pricePerUnit - prevDay.price_per_unit);
              dayChangePct = ((pricePerUnit - prevDay.price_per_unit) / prevDay.price_per_unit) * 100;
            }
          }
        }
        const r = (v) => Math.round(v * 100) / 100;
        if (pid !== null) {
          upsertDaily.run(
            inv.id, pid, today,
            r(pricePerUnit), Math.round(totalUnits * 1000) / 1000,
            r(currentValue), r(investedAmount), r(realizedGain), r(profitLoss), r(profitLossPct), priceSource,
            r(dayChange), r(dayChangePct)
          );
        } else {
          deleteDailyCombined.run(inv.id, today);
          insertDailyCombined.run(
            inv.id, today,
            r(pricePerUnit), Math.round(totalUnits * 1000) / 1000,
            r(currentValue), r(investedAmount), r(realizedGain), r(profitLoss), r(profitLossPct), priceSource,
            r(dayChange), r(dayChangePct)
          );
        }
      }
      const combinedUnits = getTotalUnits.get(inv.id, today).total;
      const combinedValue = inv.asset_type === 'FOREIGN_STOCK'
        ? combinedUnits * pricePerUnit * usdToInr
        : (inv.asset_type === 'PPF' || inv.asset_type === 'SSY' || inv.asset_type === 'PF')
          ? (() => { const txns = db.prepare("SELECT transaction_date as date, amount FROM transactions WHERE investment_id = ? AND transaction_type IN ('DEPOSIT', 'BUY') AND transaction_date <= ?").all(inv.id, today); return calculatePPFValue(txns, pricePerUnit); })()
          : combinedUnits * pricePerUnit;
      const combinedPL = combinedValue + getSaleProceeds.get(inv.id, today).total - getInvestedAmount.get(inv.id, today).total;
      console.log(`  ✓ ${inv.name}: ₹${Math.round(combinedValue).toLocaleString()} (${combinedPL >= 0 ? '+' : ''}${Math.round(combinedPL).toLocaleString()})`);
      successCount++;
      await new Promise(r => setTimeout(r, 300));
    } catch (e) {
      console.error(`  ✗ ${inv.name}: ${e.message}`);
      errorCount++;
    }
  }

  // Update portfolio daily snapshots (per-portfolio + combined)
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
 * Update portfolio-level daily snapshots.
 * Creates one row per portfolio_id + one combined row (portfolio_id = NULL).
 */
function updatePortfolioDaily(db, date) {
  const upsertPortfolioDaily = db.prepare(`
    INSERT INTO portfolio_daily (portfolio_id, date, total_value, total_invested, total_profit_loss, total_profit_loss_pct, day_change, day_change_pct)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(portfolio_id, date) DO UPDATE SET
      total_value = excluded.total_value,
      total_invested = excluded.total_invested,
      total_profit_loss = excluded.total_profit_loss,
      total_profit_loss_pct = excluded.total_profit_loss_pct,
      day_change = excluded.day_change,
      day_change_pct = excluded.day_change_pct
  `);

  // For NULL portfolio_id, ON CONFLICT doesn't work (NULL != NULL in SQLite),
  // so delete-then-insert instead.
  const deleteCombined = db.prepare(
    'DELETE FROM portfolio_daily WHERE portfolio_id IS NULL AND date = ?'
  );
  const insertCombined = db.prepare(`
    INSERT INTO portfolio_daily (portfolio_id, date, total_value, total_invested, total_profit_loss, total_profit_loss_pct, day_change, day_change_pct)
    VALUES (NULL, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Get all distinct portfolio_ids from transactions
  const portfolioIds = db.prepare(`
    SELECT DISTINCT t.portfolio_id FROM transactions t
    JOIN investments i ON t.investment_id = i.id
    WHERE t.portfolio_id IS NOT NULL
  `).all().map(r => r.portfolio_id);

  // Always include combined (null) snapshot
  const allIds = [null, ...portfolioIds];

  for (const pid of allIds) {
    let totals;
    if (pid === null) {
      // Combined: use latest available row per investment (handles partial intraday runs where
      // only stocks are updated — non-stock types carry forward from their most recent row).
      totals = db.prepare(`
        SELECT
          COALESCE(SUM(dv.current_value), 0) as total_value,
          COALESCE(SUM(dv.invested_amount), 0) as total_invested,
          COALESCE(SUM(dv.profit_loss), 0) as total_profit_loss,
          COALESCE(SUM(dv.day_change), 0) as day_change
        FROM daily_values dv
        INNER JOIN (
          SELECT investment_id, MAX(date) as max_date
          FROM daily_values
          WHERE portfolio_id IS NULL AND date <= ?
          GROUP BY investment_id
        ) latest ON dv.investment_id = latest.investment_id AND dv.date = latest.max_date
        WHERE dv.portfolio_id IS NULL
      `).get(date);
    } else {
      // Per-portfolio: use latest available row per investment (same carry-forward logic).
      totals = db.prepare(`
        SELECT
          COALESCE(SUM(dv.current_value), 0) as total_value,
          COALESCE(SUM(dv.invested_amount), 0) as total_invested,
          COALESCE(SUM(dv.profit_loss), 0) as total_profit_loss,
          COALESCE(SUM(dv.day_change), 0) as day_change
        FROM daily_values dv
        INNER JOIN (
          SELECT investment_id, MAX(date) as max_date
          FROM daily_values
          WHERE portfolio_id = ? AND date <= ?
          GROUP BY investment_id
        ) latest ON dv.investment_id = latest.investment_id AND dv.date = latest.max_date
        WHERE dv.portfolio_id = ?
      `).get(pid, date, pid);
    }

    const profitPct = totals.total_invested > 0
      ? (totals.total_profit_loss / totals.total_invested) * 100 : 0;

    let prevPortfolio;
    if (pid === null) {
      prevPortfolio = db.prepare(
        'SELECT total_value FROM portfolio_daily WHERE portfolio_id IS NULL AND date < ? ORDER BY date DESC LIMIT 1'
      ).get(date);
    } else {
      prevPortfolio = db.prepare(
        'SELECT total_value FROM portfolio_daily WHERE portfolio_id = ? AND date < ? ORDER BY date DESC LIMIT 1'
      ).get(pid, date);
    }

    const prevValue = prevPortfolio ? prevPortfolio.total_value : totals.total_value;
    const dayChangePct = prevValue > 0 ? (totals.day_change / prevValue) * 100 : 0;

    if (pid === null) {
      deleteCombined.run(date);
      insertCombined.run(
        date,
        Math.round(totals.total_value * 100) / 100,
        Math.round(totals.total_invested * 100) / 100,
        Math.round(totals.total_profit_loss * 100) / 100,
        Math.round(profitPct * 100) / 100,
        Math.round(totals.day_change * 100) / 100,
        Math.round(dayChangePct * 100) / 100
      );
    } else {
      upsertPortfolioDaily.run(
        pid,
        date,
        Math.round(totals.total_value * 100) / 100,
        Math.round(totals.total_invested * 100) / 100,
        Math.round(totals.total_profit_loss * 100) / 100,
        Math.round(profitPct * 100) / 100,
        Math.round(totals.day_change * 100) / 100,
        Math.round(dayChangePct * 100) / 100
      );
    }
  }
}

/**
 * Update asset-type level daily snapshots for each portfolio + combined (NULL portfolio_id).
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
      total_realized_gain,
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
      COALESCE(SUM(dv.realized_gain), 0) AS total_realized_gain,
      COALESCE(SUM(dv.current_value - (dv.invested_amount - dv.realized_gain)), 0) AS total_unrealized_gain,
      COALESCE(SUM(dv.day_change), 0) AS day_change
    FROM daily_values dv
    JOIN investments i ON i.id = dv.investment_id
    INNER JOIN (
      SELECT investment_id, portfolio_id, MAX(date) as max_date
      FROM daily_values
      WHERE date <= ?
      GROUP BY investment_id, portfolio_id
    ) latest ON dv.investment_id = latest.investment_id
      AND dv.portfolio_id IS latest.portfolio_id
      AND dv.date = latest.max_date
    WHERE i.exclude_from_tracking != 1
    GROUP BY dv.portfolio_id, i.asset_type
  `);

  const previousTotals = db.prepare(`
    SELECT total_value
    FROM asset_type_daily
    WHERE date < ?
      AND asset_type = ?
      AND ((portfolio_id IS NULL AND ? IS NULL) OR portfolio_id = ?)
    ORDER BY date DESC
    LIMIT 1
  `);

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

    const prev = previousTotals.get(date, row.asset_type, row.portfolio_id, row.portfolio_id);
    const prevValue = Number(prev?.total_value || 0);
    const dayChangePct = prevValue > 0
      ? (dayChange / prevValue) * 100
      : 0;

    insertRow.run(
      row.portfolio_id,
      row.asset_type,
      date,
      Math.round(totalValue * 100) / 100,
      Math.round(totalInvested * 100) / 100,
      Math.round(totalProfitLoss * 100) / 100,
      Math.round(Number(row.total_realized_gain || 0) * 100) / 100,
      Math.round(Number(row.total_unrealized_gain || 0) * 100) / 100,
      Math.round(totalProfitLossPct * 100) / 100,
      Math.round(dayChange * 100) / 100,
      Math.round(dayChangePct * 100) / 100
    );
  }
}

module.exports = { updateAllPrices, updatePortfolioDaily, updateAssetTypeDaily, cancelUpdate };
