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
} = require('./priceService');

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

  let investments = db.prepare('SELECT * FROM investments WHERE is_active = 1').all();
  if (typeFilter && typeFilter.length > 0) {
    investments = investments.filter(i => typeFilter.includes(i.asset_type));
  }

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
    INSERT INTO daily_values (investment_id, date, price_per_unit, total_units, current_value, invested_amount, profit_loss, profit_loss_pct, day_change, day_change_pct)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(investment_id, date) DO UPDATE SET
      price_per_unit = excluded.price_per_unit,
      total_units = excluded.total_units,
      current_value = excluded.current_value,
      invested_amount = excluded.invested_amount,
      profit_loss = excluded.profit_loss,
      profit_loss_pct = excluded.profit_loss_pct,
      day_change = excluded.day_change,
      day_change_pct = excluded.day_change_pct
  `);

  const getInvestedAmount = db.prepare(`
    SELECT COALESCE(SUM(amount + COALESCE(fees, 0)), 0) as total
    FROM transactions WHERE investment_id = ? AND transaction_type IN ('BUY', 'DEPOSIT', 'IPO', 'RIGHTS')
  `);

  const getSaleProceeds = db.prepare(`
    SELECT COALESCE(SUM(amount - COALESCE(fees, 0)), 0) as total
    FROM transactions WHERE investment_id = ? AND transaction_type IN ('SELL', 'WITHDRAWAL', 'DIVIDEND', 'INTEREST')
  `);

  const getTotalUnits = db.prepare(`
    SELECT COALESCE(
      SUM(CASE
        WHEN transaction_type IN ('BUY', 'DEPOSIT', 'BONUS', 'SPLIT', 'IPO', 'TRANSFER_IN', 'RIGHTS') THEN COALESCE(units, 0)
        WHEN transaction_type IN ('SELL', 'WITHDRAWAL', 'TRANSFER_OUT', 'CONSOLIDATION') THEN -COALESCE(units, 0)
        ELSE 0
      END), 0
    ) as total
    FROM transactions WHERE investment_id = ?
  `);

  const getPrevDay = db.prepare(`
    SELECT price_per_unit, current_value FROM daily_values
    WHERE investment_id = ? AND date < ?
    ORDER BY date DESC LIMIT 1
  `);

  let successCount = 0;
  let errorCount = 0;

  for (const inv of investments) {
    if (_cancelled) {
      console.log('  ⏹ Update cancelled by user.');
      break;
    }
    try {
      let pricePerUnit = 0;
      let totalUnits = getTotalUnits.get(inv.id).total;
      let investedAmount = getInvestedAmount.get(inv.id).total;
      let saleProceeds = getSaleProceeds.get(inv.id).total;
      let currentValue = 0;
      // Per-share change from the API (used for stocks; null means fall back to DB).
      let apiChange = null;
      let apiChangePct = null;

      switch (inv.asset_type) {
        case 'MUTUAL_FUND': {
          if (inv.amfi_code) {
            const navData = await fetchMutualFundNAV(inv.amfi_code);
            pricePerUnit = navData.nav;
            currentValue = totalUnits * pricePerUnit;
            apiChange = navData.change;
            apiChangePct = navData.changePercent;
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
          await delay(500); // Avoid Yahoo Finance rate limiting
          // ticker_symbol stores full Yahoo symbol (e.g. BAJFINANCE.NS, NSDL.BO)
          const stockTicker = inv.ticker_symbol.includes('.') ? inv.ticker_symbol : toNSETicker(inv.ticker_symbol);
          const stockData = await fetchStockPrice(stockTicker);
          pricePerUnit = stockData.price;
          currentValue = totalUnits * pricePerUnit;
          // Use Yahoo's per-share change (last close vs previous close)
          // so weekends/holidays still show the last trading session's move.
          apiChange = stockData.change;
          apiChangePct = stockData.changePercent;
          break;
        }

        case 'FOREIGN_STOCK': {
          if (!inv.ticker_symbol) {
            console.warn(`  Skipping ${inv.name}: No ticker symbol`);
            continue;
          }
          await delay(500); // Avoid Yahoo Finance rate limiting
          const foreignData = await fetchStockPrice(inv.ticker_symbol);
          pricePerUnit = foreignData.price;
          // Convert to INR for portfolio aggregation
          currentValue = totalUnits * pricePerUnit * usdToInr;
          // Use Yahoo's per-share change
          apiChange = foreignData.change;
          apiChangePct = foreignData.changePercent;
          break;
        }

        case 'BOND': {
          pricePerUnit = inv.face_value || 1000;
          currentValue = totalUnits * pricePerUnit;
          break;
        }

        case 'PPF':
        case 'PF': {
          const rateRow = db.prepare(
            'SELECT rate FROM interest_rates WHERE rate_type = ? ORDER BY effective_from DESC LIMIT 1'
          ).get(inv.asset_type);
          const rate = rateRow ? rateRow.rate : (inv.asset_type === 'PPF' ? 7.1 : 8.25);

          const txns = db.prepare(
            "SELECT transaction_date as date, amount FROM transactions WHERE investment_id = ? AND transaction_type IN ('DEPOSIT', 'BUY')"
          ).all(inv.id);

          currentValue = calculatePPFValue(txns, rate);
          pricePerUnit = rate; // Store rate as "price"
          totalUnits = 1; // PPF doesn't have units concept
          break;
        }
      }

      // Calculate profit/loss: current value + sale proceeds - purchase cost
      const profitLoss = currentValue + saleProceeds - investedAmount;
      const profitLossPct = investedAmount > 0 ? (profitLoss / investedAmount) * 100 : 0;

      // Day change: prefer API-sourced per-share change (stocks get it from
      // Yahoo, MFs compute it from NAV date). This ensures weekends/holidays
      // show the last trading session's move, matching broker apps.
      let dayChange = 0;
      let dayChangePct = 0;
      if (totalUnits > 0) {
        if (apiChange != null && apiChangePct != null) {
          dayChange = totalUnits * apiChange;
          dayChangePct = apiChangePct;
        } else {
          // Fallback: compare against previous DB entry (for bonds etc.)
          const prevDay = getPrevDay.get(inv.id, today);
          if (prevDay && prevDay.price_per_unit > 0) {
            dayChange = totalUnits * (pricePerUnit - prevDay.price_per_unit);
            dayChangePct = ((pricePerUnit - prevDay.price_per_unit) / prevDay.price_per_unit) * 100;
          }
        }
      }

      upsertDaily.run(
        inv.id, today,
        Math.round(pricePerUnit * 100) / 100,
        Math.round(totalUnits * 1000) / 1000,
        Math.round(currentValue * 100) / 100,
        Math.round(investedAmount * 100) / 100,
        Math.round(profitLoss * 100) / 100,
        Math.round(profitLossPct * 100) / 100,
        Math.round(dayChange * 100) / 100,
        Math.round(dayChangePct * 100) / 100
      );

      console.log(`  ✓ ${inv.name}: ₹${Math.round(currentValue).toLocaleString()} (${profitLoss >= 0 ? '+' : ''}${Math.round(profitLoss).toLocaleString()})`);
      successCount++;

      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 300));

    } catch (e) {
      console.error(`  ✗ ${inv.name}: ${e.message}`);
      errorCount++;
    }
  }

  // Update portfolio daily snapshots (per-portfolio + combined)
  updatePortfolioDaily(db, today);

  // Update last price update time
  db.prepare("UPDATE config SET value = ?, updated_at = datetime('now') WHERE key = 'last_price_update'")
    .run(new Date().toISOString());

  const cancelled = _cancelled;
  _cancelled = false;
  console.log(`[${new Date().toISOString()}] Price update ${cancelled ? 'cancelled' : 'done'}. Success: ${successCount}, Errors: ${errorCount}`);
  return { successCount, errorCount, cancelled, date: today };
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

  // Get all distinct portfolio_ids from transactions (including NULL for unassigned)
  const portfolioIds = db.prepare(`
    SELECT DISTINCT t.portfolio_id FROM transactions t
    JOIN investments i ON t.investment_id = i.id
    WHERE i.is_active = 1
  `).all().map(r => r.portfolio_id);

  // Always include combined (null) snapshot
  const allIds = [...new Set([null, ...portfolioIds])];

  for (const pid of allIds) {
    let totals;
    if (pid === null) {
      // Combined: all investments
      totals = db.prepare(`
        SELECT
          COALESCE(SUM(dv.current_value), 0) as total_value,
          COALESCE(SUM(dv.invested_amount), 0) as total_invested,
          COALESCE(SUM(dv.profit_loss), 0) as total_profit_loss,
          COALESCE(SUM(dv.day_change), 0) as day_change
        FROM daily_values dv
        JOIN investments i ON dv.investment_id = i.id
        WHERE dv.date = ? AND i.is_active = 1
      `).get(date);
    } else {
      // Per-portfolio: only investments that have transactions in this portfolio
      totals = db.prepare(`
        SELECT
          COALESCE(SUM(dv.current_value), 0) as total_value,
          COALESCE(SUM(dv.invested_amount), 0) as total_invested,
          COALESCE(SUM(dv.profit_loss), 0) as total_profit_loss,
          COALESCE(SUM(dv.day_change), 0) as day_change
        FROM daily_values dv
        JOIN investments i ON dv.investment_id = i.id
        WHERE dv.date = ? AND i.is_active = 1
          AND EXISTS (SELECT 1 FROM transactions t WHERE t.investment_id = i.id AND t.portfolio_id = ?)
      `).get(date, pid);
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

module.exports = { updateAllPrices, updatePortfolioDaily, cancelUpdate };
