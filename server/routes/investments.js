const express = require('express');
const router = express.Router();
const { INTEREST_RATES, DATASET_VERSION } = require('../data/interest-rates');

const CASH_OUTFLOW_TYPES = new Set([
  'BUY', 'DEPOSIT', 'IPO', 'TRANSFER_IN', 'SWITCH_IN', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'RIGHTS', 'CHARGES', 'AMC'
]);

const CASH_INFLOW_TYPES = new Set([
  'SELL', 'REDEMPTION', 'WITHDRAWAL', 'TRANSFER_OUT', 'SWITCH_OUT', 'DIVIDEND', 'INTEREST'
]);

function xnpv(rate, flows, baseDate) {
  const msPerDay = 24 * 60 * 60 * 1000;
  return flows.reduce((sum, flow) => {
    const years = (flow.date - baseDate) / msPerDay / 365;
    return sum + flow.amount / ((1 + rate) ** years);
  }, 0);
}

function calculateXirr(flows) {
  if (!Array.isArray(flows) || flows.length < 2) return null;

  let hasPositive = false;
  let hasNegative = false;
  for (const flow of flows) {
    if (flow.amount > 0) hasPositive = true;
    if (flow.amount < 0) hasNegative = true;
  }
  if (!hasPositive || !hasNegative) return null;

  const sortedFlows = [...flows].sort((a, b) => a.date - b.date);
  const baseDate = sortedFlows[0].date;

  let low = -0.9999;
  let high = 10;
  let fLow = xnpv(low, sortedFlows, baseDate);
  let fHigh = xnpv(high, sortedFlows, baseDate);

  for (let i = 0; i < 25 && fLow * fHigh > 0; i += 1) {
    high *= 2;
    fHigh = xnpv(high, sortedFlows, baseDate);
  }

  if (fLow * fHigh > 0) return null;

  for (let i = 0; i < 100; i += 1) {
    const mid = (low + high) / 2;
    const fMid = xnpv(mid, sortedFlows, baseDate);

    if (Math.abs(fMid) < 1e-7) return mid;

    if (fLow * fMid < 0) {
      high = mid;
      fHigh = fMid;
    } else {
      low = mid;
      fLow = fMid;
    }
  }

  return (low + high) / 2;
}

/**
 * Get the effective interest rate for a given asset type and date.
 * Returns the rate that was active on the given date, or the latest rate if date is after all rates.
 */
function getEffectiveRate(assetType, date) {
  if (!['PPF', 'SSY', 'PF'].includes(assetType)) return null;
  
  const rates = INTEREST_RATES.filter(r => r.rate_type === assetType);
  
  for (const rate of rates) {
    const effectiveFrom = new Date(rate.effective_from);
    const effectiveTo = rate.effective_to ? new Date(rate.effective_to) : new Date('2099-12-31');
    const compareDate = new Date(date);
    
    if (compareDate >= effectiveFrom && compareDate <= effectiveTo) {
      return rate.rate;
    }
  }
  
  // Fallback to latest rate if date is before first rate
  return rates.length > 0 ? rates[rates.length - 1].rate : null;
}

module.exports = function (db) {
  // ─── Get all investments ──────────────────────────────────────────────
  router.get('/', (req, res) => {
    const { type, portfolio_id, hide_sold } = req.query;
    let query = 'SELECT DISTINCT i.* FROM investments i';
    const params = [];

    query += ' WHERE 1=1';

    if (portfolio_id) {
      query += ' AND (EXISTS (SELECT 1 FROM transactions t WHERE t.investment_id = i.id AND t.portfolio_id = ?) OR NOT EXISTS (SELECT 1 FROM transactions t WHERE t.investment_id = i.id))';
      params.push(portfolio_id);
    }

    if (type) {
      query += ' AND i.asset_type = ?';
      params.push(type);
    }
    if (hide_sold === 'true') {
      const portfolioTxnFilter = portfolio_id ? ' AND t2.portfolio_id = ?' : '';
      const portfolioTxnParams = portfolio_id ? [portfolio_id] : [];
      query += ` AND (
        i.asset_type IN ('PPF', 'SSY', 'PF') OR
        NOT EXISTS (
          SELECT 1
          FROM transactions t2
          WHERE t2.investment_id = i.id${portfolioTxnFilter}
        ) OR
        COALESCE((
          SELECT SUM(CASE
            WHEN t2.transaction_type IN ('BUY','DEPOSIT','BONUS','RIGHTS','IPO','TRANSFER_IN','SWITCH_IN','SPLIT','EMPLOYER_CONTRIBUTION','VOLUNTARY_CONTRIBUTION') THEN COALESCE(t2.units, 0)
            WHEN t2.transaction_type IN ('SELL','REDEMPTION','WITHDRAWAL','TRANSFER_OUT','SWITCH_OUT','CONSOLIDATION','CHARGES','AMC') THEN -COALESCE(t2.units, 0)
            ELSE 0 END)
          FROM transactions t2 WHERE t2.investment_id = i.id${portfolioTxnFilter}
        ), 0) > 0.001
      )`;
      params.push(...portfolioTxnParams, ...portfolioTxnParams);
    }

    query += ' ORDER BY i.asset_type, COALESCE(i.display_name, i.name)';
    const investments = db.prepare(query).all(...params);

    const portfolioIdNum = portfolio_id ? parseInt(portfolio_id, 10) : null;

    const latestValueByPortfolioStmt = db.prepare('SELECT * FROM daily_values WHERE investment_id = ? AND portfolio_id = ? ORDER BY date DESC LIMIT 1');
    const latestValueGlobalStmt = db.prepare('SELECT * FROM daily_values WHERE investment_id = ? AND portfolio_id IS NULL ORDER BY date DESC LIMIT 1');

    const txnsByPortfolioStmt = db.prepare('SELECT transaction_type, transaction_date, amount, fees FROM transactions WHERE investment_id = ? AND portfolio_id = ?');
    const txnsGlobalStmt = db.prepare('SELECT transaction_type, transaction_date, amount, fees FROM transactions WHERE investment_id = ? AND portfolio_id IS NULL');

    const enriched = investments.map((inv) => {
      let latestValue;
      if (portfolioIdNum) {
        latestValue = latestValueByPortfolioStmt.get(inv.id, portfolioIdNum) || latestValueGlobalStmt.get(inv.id);
      } else {
        latestValue = latestValueGlobalStmt.get(inv.id);
      }

      let txns;
      if (portfolioIdNum) {
        txns = txnsByPortfolioStmt.all(inv.id, portfolioIdNum);
        if (txns.length === 0) txns = txnsGlobalStmt.all(inv.id);
      } else {
        txns = txnsGlobalStmt.all(inv.id);
      }
      const xirrCashflows = [];

      for (const txn of txns) {
        const txnDate = new Date(txn.transaction_date);
        if (Number.isNaN(txnDate.getTime())) continue;

        const amount = Number(txn.amount) || 0;
        const fees = Number(txn.fees) || 0;
        let cashflow = 0;

        if (CASH_OUTFLOW_TYPES.has(txn.transaction_type)) {
          cashflow = -(amount + fees);
        } else if (CASH_INFLOW_TYPES.has(txn.transaction_type)) {
          cashflow = amount - fees;
        }

        if (Math.abs(cashflow) > 1e-9) {
          xirrCashflows.push({ amount: cashflow, date: txnDate });
        }
      }

      const terminalValue = Number(latestValue?.current_value) || 0;
      if (terminalValue > 0 && latestValue?.date) {
        const valuationDate = new Date(latestValue.date);
        if (!Number.isNaN(valuationDate.getTime())) {
          xirrCashflows.push({ amount: terminalValue, date: valuationDate });
        }
      }

      const xirrRate = calculateXirr(xirrCashflows);

      return {
        ...inv,
        absolute_return_pct: latestValue?.profit_loss_pct ?? null,
        xirr_pct: xirrRate == null ? null : xirrRate * 100,
      };
    });

    res.json(enriched);
  });

  // ─── Get single investment with details ───────────────────────────────
  router.get('/:id', (req, res) => {
    const inv = db.prepare(`
      SELECT i.*
      FROM investments i
      WHERE i.id = ?
    `).get(req.params.id);
    if (!inv) return res.status(404).json({ error: 'Investment not found' });

    // Get latest daily value (portfolio-scoped or combined)
    const portfolioId = req.query.portfolio_id;
    let latestValue;
    if (portfolioId) {
      latestValue = db.prepare(
        'SELECT * FROM daily_values WHERE investment_id = ? AND portfolio_id = ? ORDER BY date DESC LIMIT 1'
      ).get(inv.id, parseInt(portfolioId));
    } else {
      latestValue = db.prepare(
        'SELECT * FROM daily_values WHERE investment_id = ? AND portfolio_id IS NULL ORDER BY date DESC LIMIT 1'
      ).get(inv.id);
    }

    // Get total units and invested amount
    const portfolioFilter = portfolioId ? ' AND portfolio_id = ?' : '';
    const portfolioParams = portfolioId ? [parseInt(portfolioId)] : [];

    const totals = db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN transaction_type IN ('BUY', 'DEPOSIT', 'BONUS', 'SPLIT', 'IPO', 'TRANSFER_IN', 'SWITCH_IN', 'RIGHTS', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION') THEN COALESCE(units, 0) WHEN transaction_type IN ('SELL', 'REDEMPTION', 'WITHDRAWAL', 'TRANSFER_OUT', 'SWITCH_OUT', 'CONSOLIDATION', 'CHARGES', 'AMC') THEN -COALESCE(units, 0) ELSE 0 END), 0) as total_units,
        COALESCE(SUM(CASE WHEN transaction_type IN ('BUY', 'DEPOSIT', 'IPO', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION') THEN amount + COALESCE(fees, 0) ELSE 0 END), 0) as total_invested,
        COALESCE(SUM(CASE WHEN transaction_type IN ('SELL', 'REDEMPTION', 'WITHDRAWAL') THEN amount - COALESCE(fees, 0) ELSE 0 END), 0) as sale_proceeds
      FROM transactions WHERE investment_id = ?${portfolioFilter}
    `).get(inv.id, ...portfolioParams);

    // Get transactions
    const transactions = db.prepare(
      `SELECT * FROM transactions WHERE investment_id = ?${portfolioFilter} ORDER BY transaction_date DESC`
    ).all(inv.id, ...portfolioParams);

    // Get folio summary and options (for MF)
    let folio_summary = null;
    let folio_options = [];
    
    if (inv.asset_type === 'MUTUAL_FUND') {
      // Get all unique folios for this investment with their net units
      const folios = db.prepare(`
        SELECT 
          folio_number,
          COALESCE(SUM(CASE 
            WHEN transaction_type IN ('BUY', 'DEPOSIT', 'BONUS', 'SPLIT', 'IPO', 'TRANSFER_IN', 'SWITCH_IN', 'RIGHTS', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION') THEN COALESCE(units, 0)
            WHEN transaction_type IN ('SELL', 'REDEMPTION', 'WITHDRAWAL', 'TRANSFER_OUT', 'SWITCH_OUT', 'CONSOLIDATION', 'CHARGES', 'AMC') THEN -COALESCE(units, 0)
            ELSE 0 END), 0) as net_units
        FROM transactions 
        WHERE investment_id = ?${portfolioFilter}
        AND folio_number IS NOT NULL
        GROUP BY folio_number
        ORDER BY folio_number
      `).all(inv.id, ...portfolioParams);

      folio_options = folios.map(f => ({
        folio_number: f.folio_number,
        net_units: f.net_units,
        is_open: f.net_units > 0.0001
      }));

      const totalFolios = folio_options.length;
      const openFolios = folio_options.filter(f => f.is_open).length;
      const closedFolios = totalFolios - openFolios;

      folio_summary = {
        total: totalFolios,
        open: openFolios,
        closed: closedFolios
      };
    }

    res.json({
      ...inv,
      latestValue,
      totalUnits: totals.total_units,
      totalInvested: totals.total_invested,
      saleProceeds: totals.sale_proceeds,
      transactions,
      folio_summary,
      folio_options,
    });
  });

  // ─── Create investment ────────────────────────────────────────────────
  router.post('/', (req, res) => {
    const {
      name, asset_type, ticker_symbol, amfi_code,
      account_number, currency, notes,
      face_value, coupon_frequency, maturity_date,
    } = req.body;

    if (!name || !asset_type) {
      return res.status(400).json({ error: 'name and asset_type are required' });
    }

    const result = db.prepare(`
      INSERT INTO investments (name, asset_type, ticker_symbol, amfi_code, account_number, currency, face_value, coupon_frequency, maturity_date, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, asset_type, ticker_symbol || null, amfi_code || null,
      account_number || null,
      currency || 'INR', face_value || null,
      coupon_frequency || null, maturity_date || null,
      notes || null);

    const inv = db.prepare('SELECT * FROM investments WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(inv);
  });

  // ─── Update investment ────────────────────────────────────────────────
  router.put('/:id', (req, res) => {
    const {
      name, ticker_symbol, amfi_code,
      account_number, currency, notes, portfolio_id,
      face_value, coupon_frequency, maturity_date,
      display_name, isin_code,
    } = req.body;

    // Build dynamic SET clauses — COALESCE for legacy fields, direct set for new fields
    const sets = [];
    const params = [];

    // Legacy fields: only update if provided (COALESCE pattern)
    const coalesceFields = { name, ticker_symbol, amfi_code, account_number, currency, face_value, coupon_frequency, maturity_date, notes };
    for (const [col, val] of Object.entries(coalesceFields)) {
      sets.push(`${col} = COALESCE(?, ${col})`);
      params.push(val !== undefined ? val : null);
    }

    // New fields: only update if explicitly present in body
    if (display_name !== undefined) { sets.push('display_name = ?'); params.push(display_name || null); }
    if (isin_code !== undefined) { sets.push('isin_code = ?'); params.push(isin_code || null); }
    if (req.body.is_active !== undefined) { sets.push('is_active = ?'); params.push(req.body.is_active ? 1 : 0); }

    sets.push("updated_at = datetime('now')");
    params.push(req.params.id);

    db.prepare(`UPDATE investments SET ${sets.join(', ')} WHERE id = ?`).run(...params);

    const inv = db.prepare('SELECT * FROM investments WHERE id = ?').get(req.params.id);
    res.json(inv);
  });

  // ─── Delete investment ────────────────────────────────────────────────
  router.delete('/:id', (req, res) => {
    db.prepare('DELETE FROM investments WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  });

  // ─── Interest Rate Sync: Preview ──────────────────────────────────────
  /**
   * GET /api/investments/interest-rate-sync/preview?asset_type=PPF[&portfolio_id=1]
   * Compare hardcoded rate dataset with what's in the interest_rates table.
   * Also checks investments.interest_rate against the latest effective rate.
   */
  router.get('/interest-rate-sync/preview', (req, res) => {
    try {
      const { asset_type, portfolio_id } = req.query;
      if (!asset_type || !['PPF', 'SSY', 'PF'].includes(asset_type)) {
        return res.status(400).json({ error: 'asset_type must be PPF, SSY, or PF' });
      }

      const datasetRates = INTEREST_RATES.filter(r => r.rate_type === asset_type);
      const dbRates = db.prepare(
        'SELECT * FROM interest_rates WHERE rate_type = ? ORDER BY effective_from ASC'
      ).all(asset_type);

      const suggestions = [];
      const corrections = [];
      const deletions = [];

      // Index DB rates by effective_from for fast lookup
      const dbByDate = {};
      for (const r of dbRates) { dbByDate[r.effective_from] = r; }

      const matchedDbIds = new Set();

      // Compare dataset → DB
      for (const expected of datasetRates) {
        const existing = dbByDate[expected.effective_from];

        if (existing) {
          matchedDbIds.add(existing.id);
          const rateMatch = Math.abs(existing.rate - expected.rate) < 0.001;
          const endMatch = (existing.effective_to || null) === (expected.effective_to || null);

          if (rateMatch && endMatch) continue; // perfect match

          corrections.push({
            id: existing.id,
            rate_type: asset_type,
            effective_from: expected.effective_from,
            effective_to: expected.effective_to,
            current_rate: existing.rate,
            current_effective_to: existing.effective_to,
            expected_rate: expected.rate,
            expected_effective_to: expected.effective_to,
          });
        } else {
          suggestions.push({
            rate_type: asset_type,
            rate: expected.rate,
            effective_from: expected.effective_from,
            effective_to: expected.effective_to,
          });
        }
      }

      // DB entries not in dataset → propose deletion
      for (const r of dbRates) {
        if (!matchedDbIds.has(r.id)) {
          deletions.push({
            id: r.id,
            rate_type: r.rate_type,
            rate: r.rate,
            effective_from: r.effective_from,
            effective_to: r.effective_to,
            reason: 'No matching rate in the reference dataset',
          });
        }
      }

      // Rates are now global only, no per-investment rate corrections needed

      res.json({
        suggestions,
        corrections,
        deletions,
        datasetVersion: DATASET_VERSION,
        rateType: asset_type,
      });
    } catch (e) {
      res.status(500).json({ error: 'Failed to preview interest rate sync: ' + e.message });
    }
  });

  // ─── Interest Rate Sync: Import ───────────────────────────────────────
  /**
   * POST /api/investments/interest-rate-sync/import
   * Apply interest rate changes: add, correct, delete rates + update investment interest_rate.
   */
  router.post('/interest-rate-sync/import', (req, res) => {
    try {
      const { additions, corrections, deletions } = req.body;

      let created = 0, corrected = 0, deleted = 0;

      const runAll = db.transaction(() => {
        if (additions && additions.length) {
          const insert = db.prepare(
            'INSERT INTO interest_rates (rate_type, rate, effective_from, effective_to) VALUES (?, ?, ?, ?)'
          );
          for (const a of additions) {
            insert.run(a.rate_type, a.rate, a.effective_from, a.effective_to || null);
            created++;
          }
        }

        if (corrections && corrections.length) {
          const update = db.prepare(
            'UPDATE interest_rates SET rate = ?, effective_to = ? WHERE id = ?'
          );
          for (const c of corrections) {
            update.run(c.expected_rate, c.expected_effective_to || null, c.id);
            corrected++;
          }
        }

        if (deletions && deletions.length) {
          const remove = db.prepare('DELETE FROM interest_rates WHERE id = ?');
          for (const d of deletions) {
            remove.run(d.id);
            deleted++;
          }
        }
      });

      runAll();
      res.json({ created, corrected, deleted });
    } catch (e) {
      res.status(500).json({ error: 'Failed to import interest rate changes: ' + e.message });
    }
  });

  return router;
};
