/**
 * Tax Report API for Indian Income Tax filing.
 *
 * Covers income from US stock (RSU / ESPP) holdings:
 *   - Schedule 1 Salary: perquisite value of RSU vests & ESPP discount
 *   - Schedule CG: Capital gains (FIFO lot matching, STCG/LTCG classification)
 *   - Schedule OS: Dividend income
 *   - Schedule FA: Foreign asset disclosure (year-end balance, peak value, cost)
 *
 * Indian FY = April 1 – March 31
 * LTCG threshold: >24 months holding period (rate: 12.5% without indexation, post Budget 2024)
 * STCG threshold: ≤24 months (taxed at slab rate)
 *
 * FIFO lot matching: each VEST / ESPP_PURCHASE / BUY is a separate tax lot.
 * Cost of acquisition (COA) = FMV on acquisition date × exchange_rate_used
 *   - For VEST: price_per_unit (FMV at vest) × exchange_rate_used
 *   - For ESPP_PURCHASE: fmv_per_unit × exchange_rate_used (not the discounted price)
 *   - For BUY: price_per_unit × exchange_rate_used
 *
 * Perquisite income:
 *   - VEST: price_per_unit × units × exchange_rate_used (FMV at vest = salary income)
 *   - ESPP_PURCHASE: (fmv_per_unit - price_per_unit) × units × exchange_rate_used
 */

const express = require('express');
const router = express.Router();

const SUPPORTED_TAX_ASSET_TYPES = new Set(['FOREIGN_STOCK', 'INDIAN_STOCK', 'MUTUAL_FUND']);
const FOREIGN_TAX_ASSET_TYPES = new Set(['FOREIGN_STOCK']);
const LOT_CREATING_TYPES = new Set(['BUY', 'IPO', 'VEST', 'ESPP_PURCHASE', 'BONUS', 'SPLIT', 'RIGHTS', 'TRANSFER_IN', 'SWITCH_IN']);
const LOT_DISPOSAL_TYPES = new Set(['SELL', 'REDEMPTION', 'TRANSFER_OUT', 'SWITCH_OUT', 'WITHDRAWAL']);
const TAXABLE_DISPOSAL_TYPES = new Set(['SELL', 'REDEMPTION', 'SWITCH_OUT', 'WITHDRAWAL']);

function daysBetween(startDate, endDate) {
  const msPerDay = 24 * 60 * 60 * 1000;
  return (new Date(endDate) - new Date(startDate)) / msPerDay;
}

function isDebtLikeMutualFund(category) {
  const normalized = String(category || '').trim().toLowerCase();
  return ['debt', 'liquid', 'gilt', 'bond', 'income'].includes(normalized);
}

function gainTypeForInvestment(investment, acquisitionDate, saleDate) {
  const holdingDays = daysBetween(acquisitionDate, saleDate);
  if (investment.asset_type === 'FOREIGN_STOCK') return holdingDays > 730 ? 'LTCG' : 'STCG';
  if (investment.asset_type === 'INDIAN_STOCK') return holdingDays > 365 ? 'LTCG' : 'STCG';
  if (investment.asset_type === 'MUTUAL_FUND') {
    return isDebtLikeMutualFund(investment.category) ? (holdingDays > 730 ? 'LTCG' : 'STCG') : (holdingDays > 365 ? 'LTCG' : 'STCG');
  }
  return holdingDays > 730 ? 'LTCG' : 'STCG';
}

function roundCurrency(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function roundUnits(value) {
  return Math.round((Number(value) || 0) * 10000) / 10000;
}

function buildTaxReport(db, fy, portfolioId) {
  if (!fy) throw new Error('fy is required (e.g. 2025-26)');

  const { start: fyStart, end: fyEnd } = parseFY(fy);
  const fyStartStr = fyStart.toISOString().split('T')[0];
  const fyEndStr = fyEnd.toISOString().split('T')[0];

  let invSql = `SELECT * FROM investments WHERE asset_type IN (${[...SUPPORTED_TAX_ASSET_TYPES].map(() => '?').join(',')})`;
  const invParams = [...SUPPORTED_TAX_ASSET_TYPES];
  if (portfolioId) {
    invSql += ` AND id IN (SELECT DISTINCT investment_id FROM transactions WHERE portfolio_id = ?)`;
    invParams.push(portfolioId);
  }
  const investments = db.prepare(invSql).all(...invParams);

  if (investments.length === 0) {
    return {
      fy,
      fy_start: fyStartStr,
      fy_end: fyEndStr,
      perquisite_income: [],
      capital_gains: [],
      dividend_income: [],
      schedule_fa: [],
      summary: {
        total_perquisite_inr: 0,
        total_stcg_inr: 0,
        total_ltcg_inr: 0,
        total_dividend_inr: 0,
        stcg_lots: 0,
        ltcg_lots: 0,
        tax_note: 'Capital gains include supported foreign stock, Indian stock, and mutual fund disposals. LTCG threshold varies by asset type/category.',
      },
    };
  }

  const investmentIds = investments.map((i) => i.id);
  const investmentMap = new Map(investments.map((i) => [i.id, i]));
  const idPlaceholders = investmentIds.map(() => '?').join(',');

  let txnSql = `
    SELECT t.*, i.name as investment_name, i.display_name, i.ticker_symbol, i.asset_type as investment_asset_type, i.category as investment_category, i.currency as investment_currency, i.isin_code
    FROM transactions t
    JOIN investments i ON t.investment_id = i.id
    WHERE t.investment_id IN (${idPlaceholders})
  `;
  const txnParams = [...investmentIds];
  if (portfolioId) {
    txnSql += ' AND t.portfolio_id = ?';
    txnParams.push(portfolioId);
  }
  txnSql += ' ORDER BY t.transaction_date ASC, t.id ASC';

  const allTxns = db.prepare(txnSql).all(...txnParams);

  const lotPool = {};
  for (const inv of investments) lotPool[inv.id] = [];

  const perquisiteRows = [];
  const capitalGainsRows = [];
  const dividendRows = [];

  for (const txn of allTxns) {
    const inv = investmentMap.get(txn.investment_id);
    if (!inv) continue;
    const invId = txn.investment_id;
    const name = txn.display_name || txn.investment_name;
    const ticker = txn.ticker_symbol || '';
    const rate = txn.exchange_rate_used || null;
    const usdAmt = txn.usd_amount || null;
    const units = Number(txn.units) || 0;
    const grossUnits = Number(txn.gross_units) || units;
    const pricePerUnit = Number(txn.price_per_unit) || 0;
    const fmvPerUnit = Number(txn.fmv_per_unit) || pricePerUnit;
    const amtINR = Number(txn.amount) || 0;
    const feesINR = Number(txn.fees) || 0;
    const txnDate = txn.transaction_date;
    const inFY = txnDate >= fyStartStr && txnDate <= fyEndStr;

    if (txn.transaction_type === 'VEST' && FOREIGN_TAX_ASSET_TYPES.has(inv.asset_type)) {
      const costPerUnitINR = units > 0
        ? (rate ? pricePerUnit * grossUnits * rate : amtINR) / units
        : 0;
      const buyFeePerUnitINR = units > 0 ? feesINR / units : 0;
      if (units > 0) {
        lotPool[invId].push({
          acquisition_date: txnDate,
          units_remaining: units,
          cost_per_unit_inr: costPerUnitINR,
          buy_fee_per_unit_inr: buyFeePerUnitINR,
          fmv_per_unit: pricePerUnit,
          exchange_rate: rate,
          txn_id: txn.id,
          type: 'VEST',
        });
      }
      if (inFY) {
        const fallbackGrossAmount = rate && pricePerUnit > 0 ? pricePerUnit * grossUnits * rate : amtINR;
        perquisiteRows.push({
          type: 'RSU_VEST',
          asset_type: inv.asset_type,
          date: txnDate,
          investment: name,
          ticker,
          units: grossUnits,
          net_units: units,
          tax_withheld_units: Number(txn.tax_withheld_units) || null,
          fmv_per_share_usd: pricePerUnit,
          exchange_rate: rate,
          perquisite_inr: roundCurrency(fallbackGrossAmount),
          notes: txn.notes || null,
        });
      }
      continue;
    }

    if (txn.transaction_type === 'ESPP_PURCHASE' && FOREIGN_TAX_ASSET_TYPES.has(inv.asset_type)) {
      const costPerUnitINR = units > 0
        ? (rate ? fmvPerUnit * units * rate : amtINR) / units
        : 0;
      const buyFeePerUnitINR = units > 0 ? feesINR / units : 0;
      if (units > 0) {
        lotPool[invId].push({
          acquisition_date: txnDate,
          units_remaining: units,
          cost_per_unit_inr: costPerUnitINR,
          buy_fee_per_unit_inr: buyFeePerUnitINR,
          fmv_per_unit: fmvPerUnit,
          exchange_rate: rate,
          txn_id: txn.id,
          type: 'ESPP_PURCHASE',
        });
      }
      if (inFY) {
        const discountUSD = fmvPerUnit - pricePerUnit;
        perquisiteRows.push({
          type: 'ESPP_PURCHASE',
          asset_type: inv.asset_type,
          date: txnDate,
          investment: name,
          ticker,
          units,
          purchase_price_usd: pricePerUnit,
          fmv_per_share_usd: fmvPerUnit,
          discount_per_share_usd: Math.round(discountUSD * 10000) / 10000,
          exchange_rate: rate,
          perquisite_inr: roundCurrency(rate ? discountUSD * units * rate : 0),
          notes: txn.notes || null,
        });
      }
      continue;
    }

    if (LOT_CREATING_TYPES.has(txn.transaction_type)) {
      if (units > 0) {
        const grossCostINR = rate && inv.currency === 'USD'
          ? pricePerUnit * units * rate
          : amtINR;
        lotPool[invId].push({
          acquisition_date: txnDate,
          units_remaining: units,
          cost_per_unit_inr: units > 0 ? grossCostINR / units : 0,
          buy_fee_per_unit_inr: units > 0 ? feesINR / units : 0,
          fmv_per_unit: inv.currency === 'USD' ? fmvPerUnit : pricePerUnit,
          exchange_rate: rate,
          txn_id: txn.id,
          type: txn.transaction_type,
        });
      }
      continue;
    }

    if (LOT_DISPOSAL_TYPES.has(txn.transaction_type)) {
      let remainingToSell = units;
      while (remainingToSell > 1e-9 && lotPool[invId].length > 0) {
        const lot = lotPool[invId][0];
        const soldFromLot = Math.min(lot.units_remaining, remainingToSell);

        if (inFY && soldFromLot > 1e-9 && TAXABLE_DISPOSAL_TYPES.has(txn.transaction_type)) {
          const saleProceedsINR = units > 0
            ? (soldFromLot / units) * amtINR
            : 0;
          const saleSideExpenseINR = units > 0
            ? (soldFromLot / units) * feesINR
            : 0;
          const buySideExpenseINR = (Number(lot.buy_fee_per_unit_inr) || 0) * soldFromLot;
          const totalExpenseINR = buySideExpenseINR + saleSideExpenseINR;
          const costINR = lot.cost_per_unit_inr * soldFromLot;
          const gainINR = saleProceedsINR - costINR - totalExpenseINR;

          capitalGainsRows.push({
            asset_type: inv.asset_type,
            category: inv.category || null,
            investment: name,
            ticker,
            isin: inv.isin_code || null,
            lot_type: lot.type,
            transaction_type: txn.transaction_type,
            acquisition_date: lot.acquisition_date,
            sale_date: txnDate,
            units_sold: roundUnits(soldFromLot),
            lot_cost_per_unit_inr: roundCurrency(lot.cost_per_unit_inr),
            sale_price_per_unit: pricePerUnit,
            sale_exchange_rate: rate,
            buy_side_fees_inr: roundCurrency(buySideExpenseINR),
            sale_side_fees_inr: roundCurrency(saleSideExpenseINR),
            transfer_expense_inr: roundCurrency(totalExpenseINR),
            cost_inr: roundCurrency(costINR),
            sale_proceeds_inr: roundCurrency(saleProceedsINR),
            gain_loss_inr: roundCurrency(gainINR),
            gain_type: gainTypeForInvestment(inv, lot.acquisition_date, txnDate),
            notes: txn.notes || null,
          });
        }

        lot.units_remaining -= soldFromLot;
        remainingToSell -= soldFromLot;
        if (lot.units_remaining < 1e-9) lotPool[invId].shift();
      }
      continue;
    }

    if (txn.transaction_type === 'DIVIDEND' && inFY) {
      dividendRows.push({
        asset_type: inv.asset_type,
        date: txnDate,
        investment: name,
        ticker,
        amount_inr: roundCurrency(amtINR),
        usd_amount: usdAmt ? roundCurrency(usdAmt) : null,
        exchange_rate: rate,
        notes: txn.notes || null,
      });
    }
  }

  const scheduleFA = [];
  for (const inv of investments) {
    if (!FOREIGN_TAX_ASSET_TYPES.has(inv.asset_type)) continue;
    const lots = lotPool[inv.id];
    if (lots.length === 0) continue;

    const totalUnitsHeld = lots.reduce((s, l) => s + l.units_remaining, 0);
    const totalCostINR = lots.reduce((s, l) => s + l.cost_per_unit_inr * l.units_remaining, 0);
    const totalCostUSD = lots.reduce((s, l) => s + (Number(l.fmv_per_unit) || 0) * l.units_remaining, 0);

    const yearEndDV = db.prepare(`
      SELECT price_per_unit, current_value, date FROM daily_values
      WHERE investment_id = ? AND date <= ?
      ORDER BY date DESC LIMIT 1
    `).get(inv.id, fyEndStr);

    const peakDV = db.prepare(`
      SELECT MAX(current_value) as peak_value FROM daily_values
      WHERE investment_id = ? AND date >= ? AND date <= ?
    `).get(inv.id, fyStartStr, fyEndStr);

    scheduleFA.push({
      investment: inv.display_name || inv.name,
      ticker: inv.ticker_symbol || '',
      isin: inv.isin_code || null,
      units_held: roundUnits(totalUnitsHeld),
      acquisition_cost_usd: roundCurrency(totalCostUSD),
      acquisition_cost_inr: roundCurrency(totalCostINR),
      year_end_price_per_unit_inr: yearEndDV ? yearEndDV.price_per_unit : null,
      year_end_value_inr: yearEndDV ? roundCurrency(totalUnitsHeld * (yearEndDV.price_per_unit || 0)) : null,
      year_end_date: yearEndDV ? yearEndDV.date : null,
      peak_value_inr: peakDV ? peakDV.peak_value : null,
    });
  }

  const totalPerquisiteINR = perquisiteRows.reduce((s, r) => s + (r.perquisite_inr || 0), 0);
  const stcgRows = capitalGainsRows.filter((r) => r.gain_type === 'STCG');
  const ltcgRows = capitalGainsRows.filter((r) => r.gain_type === 'LTCG');
  const totalSTCGINR = stcgRows.reduce((s, r) => s + (r.gain_loss_inr || 0), 0);
  const totalLTCGINR = ltcgRows.reduce((s, r) => s + (r.gain_loss_inr || 0), 0);
  const totalDividendINR = dividendRows.reduce((s, r) => s + (r.amount_inr || 0), 0);

  return {
    fy,
    fy_start: fyStartStr,
    fy_end: fyEndStr,
    perquisite_income: perquisiteRows,
    capital_gains: capitalGainsRows,
    dividend_income: dividendRows,
    schedule_fa: scheduleFA,
    summary: {
      total_perquisite_inr: roundCurrency(totalPerquisiteINR),
      total_stcg_inr: roundCurrency(totalSTCGINR),
      total_ltcg_inr: roundCurrency(totalLTCGINR),
      total_dividend_inr: roundCurrency(totalDividendINR),
      stcg_lots: stcgRows.length,
      ltcg_lots: ltcgRows.length,
      tax_note: 'Capital gains include supported foreign stock, Indian stock, and mutual fund disposals. Foreign-stock LTCG uses a 24-month threshold; listed Indian equity and equity-like funds use 12 months; debt-like mutual funds use 24 months.',
    },
  };
}

/**
 * Parse Indian Financial Year string like '2025-26' → { start: Date, end: Date }
 * FY 2025-26 = Apr 1 2025 – Mar 31 2026
 */
function parseFY(fy) {
  if (!fy || !/^\d{4}-\d{2}$/.test(fy)) {
    throw new Error('Invalid FY format. Use YYYY-YY e.g. 2025-26');
  }
  const startYear = parseInt(fy.split('-')[0]);
  const start = new Date(`${startYear}-04-01`);
  const end = new Date(`${startYear + 1}-03-31`);
  return { start, end, label: fy };
}

/**
 * Determine if a lot is LTCG (held > 24 months) or STCG.
 */
function gainType(acquisitionDate, saleDate) {
  const acq = new Date(acquisitionDate);
  const sal = new Date(saleDate);
  const months = (sal.getFullYear() - acq.getFullYear()) * 12 + (sal.getMonth() - acq.getMonth());
  // Precise: use days for the last partial month check
  const msPerDay = 24 * 60 * 60 * 1000;
  const days = (sal - acq) / msPerDay;
  return days > 730 ? 'LTCG' : 'STCG'; // 730 days ≈ 24 months (simplified)
}

module.exports = function (db) {

  /**
   * GET /api/tax/us-stocks?fy=2025-26&portfolio_id=1
   *
   * Returns a comprehensive tax report for US stock holdings in the given FY.
   * Sections:
   *   - perquisite_income[]     : VEST and ESPP_PURCHASE events (Schedule 1 Salary)
   *   - capital_gains[]         : SELL events matched against FIFO lots (Schedule CG)
   *   - dividend_income[]       : DIVIDEND events (Schedule OS)
   *   - schedule_fa             : Year-end holdings for foreign asset disclosure
   *   - summary                 : Totals per section
   */
  router.get('/us-stocks', (req, res) => {
    try {
      const { fy, portfolio_id } = req.query;
      res.json(buildTaxReport(db, fy, portfolio_id));
    } catch (e) {
      console.error('Tax report error:', e);
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * GET /api/tax/us-stocks/csv?fy=2025-26&section=capital_gains&portfolio_id=1
   *
   * Download a section as CSV for ITR filing.
   * Supported sections: perquisite_income | capital_gains | dividend_income | schedule_fa
   */
  router.get('/us-stocks/csv', (req, res) => {
    try {
      const { fy, section, portfolio_id } = req.query;
      if (!fy || !section) return res.status(400).json({ error: 'fy and section are required' });

      // Re-use the main endpoint logic by calling a sub-request
      // We'll do it inline by delegating to the same logic via a synthetic call
      // — simpler: just call the DB query logic directly via a helper redirect
      const url = `/api/tax/us-stocks?fy=${fy}${portfolio_id ? `&portfolio_id=${portfolio_id}` : ''}`;
      req.url = `/us-stocks?fy=${fy}${portfolio_id ? `&portfolio_id=${portfolio_id}` : ''}`;

      // We can't easily self-call, so we'll compute the report inline.
      // Instead, the client will fetch the JSON and convert to CSV itself (see TaxReport.jsx).
      // This endpoint exists as a placeholder for future server-side CSV generation.
      res.status(501).json({ error: 'Use the /api/tax/us-stocks endpoint and the client CSV export button.' });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
