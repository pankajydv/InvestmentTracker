const express = require('express');
const router = express.Router();
const { INTEREST_RATES, DATASET_VERSION } = require('../data/interest-rates');

module.exports = function (db) {
  // ─── Get all investments ──────────────────────────────────────────────
  router.get('/', (req, res) => {
    const { type, portfolio_id, hide_sold } = req.query;
    let query = 'SELECT DISTINCT i.* FROM investments i';
    const params = [];

    if (portfolio_id) {
      query += ' JOIN transactions t ON t.investment_id = i.id AND t.portfolio_id = ?';
      params.push(portfolio_id);
    }

    query += ' WHERE 1=1';

    if (type) {
      query += ' AND i.asset_type = ?';
      params.push(type);
    }
    if (hide_sold === 'true') {
      const portfolioTxnFilter = portfolio_id ? ' AND t2.portfolio_id = ?' : '';
      const portfolioTxnParams = portfolio_id ? [portfolio_id] : [];
      query += ` AND (
        i.asset_type IN ('PPF', 'SSY', 'PF') OR
        COALESCE((
          SELECT SUM(CASE
            WHEN t2.transaction_type IN ('BUY','DEPOSIT','BONUS','RIGHTS','IPO','TRANSFER_IN','SWITCH_IN','SPLIT','EMPLOYER_CONTRIBUTION','VOLUNTARY_CONTRIBUTION') THEN COALESCE(t2.units, 0)
            WHEN t2.transaction_type IN ('SELL','WITHDRAWAL','TRANSFER_OUT','SWITCH_OUT','CONSOLIDATION','CHARGES') THEN -COALESCE(t2.units, 0)
            ELSE 0 END)
          FROM transactions t2 WHERE t2.investment_id = i.id${portfolioTxnFilter}
        ), 0) > 0.001
      )`;
      params.push(...portfolioTxnParams);
    }

    query += ' ORDER BY i.asset_type, COALESCE(i.display_name, i.name)';
    const investments = db.prepare(query).all(...params);
    res.json(investments);
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
        COALESCE(SUM(CASE WHEN transaction_type IN ('BUY', 'DEPOSIT', 'BONUS', 'SPLIT', 'IPO', 'TRANSFER_IN', 'SWITCH_IN', 'RIGHTS', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION') THEN COALESCE(units, 0) WHEN transaction_type IN ('SELL', 'WITHDRAWAL', 'TRANSFER_OUT', 'SWITCH_OUT', 'CONSOLIDATION', 'CHARGES') THEN -COALESCE(units, 0) ELSE 0 END), 0) as total_units,
        COALESCE(SUM(CASE WHEN transaction_type IN ('BUY', 'DEPOSIT', 'IPO', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION') THEN amount + COALESCE(fees, 0) ELSE 0 END), 0) as total_invested,
        COALESCE(SUM(CASE WHEN transaction_type IN ('SELL', 'WITHDRAWAL') THEN amount - COALESCE(fees, 0) ELSE 0 END), 0) as sale_proceeds
      FROM transactions WHERE investment_id = ?${portfolioFilter}
    `).get(inv.id, ...portfolioParams);

    // Get transactions
    const transactions = db.prepare(
      `SELECT * FROM transactions WHERE investment_id = ?${portfolioFilter} ORDER BY transaction_date DESC`
    ).all(inv.id, ...portfolioParams);

    res.json({
      ...inv,
      latestValue,
      totalUnits: totals.total_units,
      totalInvested: totals.total_invested,
      saleProceeds: totals.sale_proceeds,
      transactions,
    });
  });

  // ─── Create investment ────────────────────────────────────────────────
  router.post('/', (req, res) => {
    const {
      name, asset_type, ticker_symbol, amfi_code,
      account_number, interest_rate, currency, notes,
      face_value, coupon_frequency, maturity_date,
    } = req.body;

    if (!name || !asset_type) {
      return res.status(400).json({ error: 'name and asset_type are required' });
    }

    const result = db.prepare(`
      INSERT INTO investments (name, asset_type, ticker_symbol, amfi_code, account_number, interest_rate, currency, face_value, coupon_frequency, maturity_date, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, asset_type, ticker_symbol || null, amfi_code || null,
      account_number || null, interest_rate || null,
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
      account_number, interest_rate, currency, notes, portfolio_id,
      face_value, coupon_frequency, maturity_date,
      display_name, isin_code,
    } = req.body;

    // Build dynamic SET clauses — COALESCE for legacy fields, direct set for new fields
    const sets = [];
    const params = [];

    // Legacy fields: only update if provided (COALESCE pattern)
    const coalesceFields = { name, ticker_symbol, amfi_code, account_number, interest_rate, currency, face_value, coupon_frequency, maturity_date, notes };
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

      // Check investments with this asset type — is their interest_rate correct?
      const latestRate = datasetRates.filter(r => !r.effective_to).pop()
        || datasetRates[datasetRates.length - 1];

      let investmentQuery = 'SELECT i.id, i.name, i.display_name, i.interest_rate FROM investments i WHERE i.asset_type = ?';
      const investmentParams = [asset_type];
      if (portfolio_id) {
        investmentQuery += ' AND EXISTS (SELECT 1 FROM transactions t WHERE t.investment_id = i.id AND t.portfolio_id = ?)';
        investmentParams.push(parseInt(portfolio_id));
      }
      const investments = db.prepare(investmentQuery).all(...investmentParams);

      const investmentCorrections = [];
      for (const inv of investments) {
        if (!inv.interest_rate || Math.abs(inv.interest_rate - latestRate.rate) >= 0.001) {
          investmentCorrections.push({
            id: inv.id,
            name: inv.display_name || inv.name,
            current_rate: inv.interest_rate,
            expected_rate: latestRate.rate,
          });
        }
      }

      res.json({
        suggestions,
        corrections,
        deletions,
        investmentCorrections,
        latestRate: latestRate.rate,
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
      const { additions, corrections, deletions, investmentCorrections } = req.body;

      let created = 0, corrected = 0, deleted = 0, investmentsUpdated = 0;

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

        if (investmentCorrections && investmentCorrections.length) {
          const updateInv = db.prepare(
            "UPDATE investments SET interest_rate = ?, updated_at = datetime('now') WHERE id = ?"
          );
          for (const ic of investmentCorrections) {
            updateInv.run(ic.expected_rate, ic.id);
            investmentsUpdated++;
          }
        }
      });

      runAll();
      res.json({ created, corrected, deleted, investmentsUpdated });
    } catch (e) {
      res.status(500).json({ error: 'Failed to import interest rate changes: ' + e.message });
    }
  });

  return router;
};
