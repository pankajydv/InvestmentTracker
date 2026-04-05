const express = require('express');
const router = express.Router();

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

  return router;
};
