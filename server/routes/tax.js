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
      if (!fy) return res.status(400).json({ error: 'fy is required (e.g. 2025-26)' });

      const { start: fyStart, end: fyEnd } = parseFY(fy);
      const fyStartStr = fyStart.toISOString().split('T')[0];  // YYYY-MM-DD
      const fyEndStr   = fyEnd.toISOString().split('T')[0];

      // Fetch all FOREIGN_STOCK investments (optionally filtered by portfolio)
      let invSql = `SELECT * FROM investments WHERE asset_type = 'FOREIGN_STOCK' AND currency = 'USD'`;
      const invParams = [];
      if (portfolio_id) {
        invSql += ` AND id IN (SELECT DISTINCT investment_id FROM transactions WHERE portfolio_id = ?)`;
        invParams.push(portfolio_id);
      }
      const investments = db.prepare(invSql).all(...invParams);

      if (investments.length === 0) {
        return res.json({
          fy,
          perquisite_income: [],
          capital_gains: [],
          dividend_income: [],
          schedule_fa: [],
          summary: { total_perquisite_inr: 0, total_stcg_inr: 0, total_ltcg_inr: 0, total_dividend_inr: 0 },
        });
      }

      const investmentIds = investments.map(i => i.id);
      const idPlaceholders = investmentIds.map(() => '?').join(',');

      // Fetch all transactions for these investments (all time — needed for FIFO lots that acquired before FY)
      let txnSql = `
        SELECT t.*, i.name as investment_name, i.display_name, i.ticker_symbol
        FROM transactions t
        JOIN investments i ON t.investment_id = i.id
        WHERE t.investment_id IN (${idPlaceholders})
      `;
      const txnParams = [...investmentIds];
      if (portfolio_id) {
        txnSql += ' AND t.portfolio_id = ?';
        txnParams.push(portfolio_id);
      }
      txnSql += ' ORDER BY t.transaction_date ASC, t.id ASC';

      const allTxns = db.prepare(txnSql).all(...txnParams);

      // ── Build FIFO lot pool per investment ───────────────────────────────
      // Lot structure: { investment_id, acquisition_date, units_remaining, cost_per_unit_inr, fmv_per_unit_usd, exchange_rate, txn_id, type }
      const lotPool = {};  // investment_id → lot[]
      for (const inv of investments) {
        lotPool[inv.id] = [];
      }

      // Types that create lots (add units)
      const LOT_CREATING_TYPES = new Set(['BUY', 'IPO', 'VEST', 'ESPP_PURCHASE', 'BONUS', 'SPLIT', 'RIGHTS', 'TRANSFER_IN']);
      // Types that consume lots (remove units)
      const LOT_CONSUMING_TYPES = new Set(['SELL', 'REDEMPTION', 'TRANSFER_OUT']);

      // ── Section accumulators ─────────────────────────────────────────────
      const perquisiteRows = [];
      const capitalGainsRows = [];
      const dividendRows = [];

      // Process transactions chronologically
      for (const txn of allTxns) {
        const invId = txn.investment_id;
        const name = txn.display_name || txn.investment_name;
        const ticker = txn.ticker_symbol || '';
        const rate = txn.exchange_rate_used || null;
        const usdAmt = txn.usd_amount || null;
        const units = Number(txn.units) || 0;
        const grossUnits = Number(txn.gross_units) || units;
        const priceUSD = Number(txn.price_per_unit) || 0;
        const fmvUSD = Number(txn.fmv_per_unit) || priceUSD; // fmv_per_unit or fallback to price
        const amtINR = Number(txn.amount) || 0;
        const txnDate = txn.transaction_date;
        const inFY = txnDate >= fyStartStr && txnDate <= fyEndStr;

        if (txn.transaction_type === 'VEST') {
          // Cost of lot for capital gains = FMV at vest (price_per_unit is FMV here)
          const costPerUnitINR = rate ? priceUSD * rate : amtINR / (units || 1);
          if (units > 0) {
            lotPool[invId].push({
              acquisition_date: txnDate,
              units_remaining: units,
              cost_per_unit_inr: costPerUnitINR,
              fmv_per_unit_usd: priceUSD,
              exchange_rate: rate,
              txn_id: txn.id,
              type: 'VEST',
            });
          }
          // Perquisite income (only if in this FY)
          if (inFY) {
            const fallbackGrossAmount = rate && priceUSD > 0 ? priceUSD * grossUnits * rate : amtINR;
            const perqINR = fallbackGrossAmount;
            perquisiteRows.push({
              type: 'RSU_VEST',
              date: txnDate,
              investment: name,
              ticker,
              units: grossUnits,
              net_units: units,
              tax_withheld_units: Number(txn.tax_withheld_units) || null,
              fmv_per_share_usd: priceUSD,
              exchange_rate: rate,
              perquisite_inr: Math.round(perqINR * 100) / 100,
              notes: txn.notes || null,
            });
          }

        } else if (txn.transaction_type === 'ESPP_PURCHASE') {
          // Cost for CG = FMV on purchase date (fmv_per_unit), NOT the discounted price
          const costPerUnitINR = rate ? fmvUSD * rate : (usdAmt ? usdAmt * rate / units : amtINR / (units || 1));
          if (units > 0) {
            lotPool[invId].push({
              acquisition_date: txnDate,
              units_remaining: units,
              cost_per_unit_inr: costPerUnitINR,
              fmv_per_unit_usd: fmvUSD,
              exchange_rate: rate,
              txn_id: txn.id,
              type: 'ESPP_PURCHASE',
            });
          }
          // Perquisite = discount element (FMV - purchase price) × units × rate
          if (inFY) {
            const discountUSD = fmvUSD - priceUSD;
            const perqINR = rate ? discountUSD * units * rate : 0;
            perquisiteRows.push({
              type: 'ESPP_PURCHASE',
              date: txnDate,
              investment: name,
              ticker,
              units,
              purchase_price_usd: priceUSD,
              fmv_per_share_usd: fmvUSD,
              discount_per_share_usd: Math.round(discountUSD * 10000) / 10000,
              exchange_rate: rate,
              perquisite_inr: Math.round(perqINR * 100) / 100,
              notes: txn.notes || null,
            });
          }

        } else if (txn.transaction_type === 'BUY' || txn.transaction_type === 'IPO') {
          // Market purchase — cost = price paid
          const costPerUnitINR = rate ? priceUSD * rate : amtINR / (units || 1);
          if (units > 0) {
            lotPool[invId].push({
              acquisition_date: txnDate,
              units_remaining: units,
              cost_per_unit_inr: costPerUnitINR,
              fmv_per_unit_usd: priceUSD,
              exchange_rate: rate,
              txn_id: txn.id,
              type: txn.transaction_type,
            });
          }

        } else if (LOT_CONSUMING_TYPES.has(txn.transaction_type)) {
          // FIFO consumption — generate capital gains if sale is in FY
          let remainingToSell = units;
          const saleRateINR = rate || (priceUSD > 0 ? amtINR / units : 0);

          while (remainingToSell > 1e-9 && lotPool[invId].length > 0) {
            const lot = lotPool[invId][0];
            const soldFromLot = Math.min(lot.units_remaining, remainingToSell);

            if (inFY && soldFromLot > 1e-9) {
              const saleProceedsINR = priceUSD > 0 && rate
                ? priceUSD * soldFromLot * rate
                : (soldFromLot / units) * amtINR;
              const costINR = lot.cost_per_unit_inr * soldFromLot;
              const gainINR = saleProceedsINR - costINR;

              capitalGainsRows.push({
                investment: name,
                ticker,
                lot_type: lot.type,
                acquisition_date: lot.acquisition_date,
                sale_date: txnDate,
                units_sold: Math.round(soldFromLot * 10000) / 10000,
                lot_cost_per_unit_inr: Math.round(lot.cost_per_unit_inr * 100) / 100,
                sale_price_per_unit_usd: priceUSD,
                sale_exchange_rate: rate,
                cost_inr: Math.round(costINR * 100) / 100,
                sale_proceeds_inr: Math.round(saleProceedsINR * 100) / 100,
                gain_loss_inr: Math.round(gainINR * 100) / 100,
                gain_type: gainType(lot.acquisition_date, txnDate),
                notes: txn.notes || null,
              });
            }

            lot.units_remaining -= soldFromLot;
            remainingToSell -= soldFromLot;
            if (lot.units_remaining < 1e-9) lotPool[invId].shift();
          }

        } else if (txn.transaction_type === 'DIVIDEND' && inFY) {
          dividendRows.push({
            date: txnDate,
            investment: name,
            ticker,
            amount_inr: Math.round(amtINR * 100) / 100,
            usd_amount: usdAmt ? Math.round(usdAmt * 100) / 100 : null,
            exchange_rate: rate,
            notes: txn.notes || null,
          });
        }
      }

      // ── Schedule FA: Year-end holdings ───────────────────────────────────
      // For each investment, sum remaining lots' cost and get year-end price from daily_values
      const scheduleFA = [];
      for (const inv of investments) {
        const lots = lotPool[inv.id];
        if (lots.length === 0) continue;

        const totalUnitsHeld = lots.reduce((s, l) => s + l.units_remaining, 0);
        const totalCostINR = lots.reduce((s, l) => s + l.cost_per_unit_inr * l.units_remaining, 0);
        const totalCostUSD = lots.reduce((s, l) => s + l.fmv_per_unit_usd * l.units_remaining, 0);

        // Get year-end price from daily_values
        const yearEndDV = db.prepare(`
          SELECT price_per_unit, current_value, date FROM daily_values
          WHERE investment_id = ? AND date <= ?
          ORDER BY date DESC LIMIT 1
        `).get(inv.id, fyEndStr);

        // Peak value during FY
        const peakDV = db.prepare(`
          SELECT MAX(current_value) as peak_value FROM daily_values
          WHERE investment_id = ? AND date >= ? AND date <= ?
        `).get(inv.id, fyStartStr, fyEndStr);

        scheduleFA.push({
          investment: inv.display_name || inv.name,
          ticker: inv.ticker_symbol || '',
          isin: inv.isin_code || null,
          units_held: Math.round(totalUnitsHeld * 10000) / 10000,
          acquisition_cost_usd: Math.round(totalCostUSD * 100) / 100,
          acquisition_cost_inr: Math.round(totalCostINR * 100) / 100,
          year_end_price_per_unit_inr: yearEndDV ? yearEndDV.price_per_unit : null,
          year_end_value_inr: yearEndDV ? Math.round(totalUnitsHeld * (yearEndDV.price_per_unit || 0) * 100) / 100 : null,
          year_end_date: yearEndDV ? yearEndDV.date : null,
          peak_value_inr: peakDV ? peakDV.peak_value : null,
        });
      }

      // ── Summary ──────────────────────────────────────────────────────────
      const totalPerquisiteINR = perquisiteRows.reduce((s, r) => s + (r.perquisite_inr || 0), 0);
      const stcgRows = capitalGainsRows.filter(r => r.gain_type === 'STCG');
      const ltcgRows = capitalGainsRows.filter(r => r.gain_type === 'LTCG');
      const totalSTCGINR = stcgRows.reduce((s, r) => s + r.gain_loss_inr, 0);
      const totalLTCGINR = ltcgRows.reduce((s, r) => s + r.gain_loss_inr, 0);
      const totalDividendINR = dividendRows.reduce((s, r) => s + r.amount_inr, 0);

      res.json({
        fy,
        fy_start: fyStartStr,
        fy_end: fyEndStr,
        perquisite_income: perquisiteRows,
        capital_gains: capitalGainsRows,
        dividend_income: dividendRows,
        schedule_fa: scheduleFA,
        summary: {
          total_perquisite_inr: Math.round(totalPerquisiteINR * 100) / 100,
          total_stcg_inr: Math.round(totalSTCGINR * 100) / 100,
          total_ltcg_inr: Math.round(totalLTCGINR * 100) / 100,
          total_dividend_inr: Math.round(totalDividendINR * 100) / 100,
          stcg_lots: stcgRows.length,
          ltcg_lots: ltcgRows.length,
          tax_note: 'LTCG rate 12.5% (post Budget 2024, no indexation). STCG at applicable slab rate. Perquisite/Dividend at slab rate.',
        },
      });
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
