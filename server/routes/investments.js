const express = require('express');
const router = express.Router();

module.exports = function (db) {
  // ─── Get all investments ──────────────────────────────────────────────
  router.get('/', (req, res) => {
    const { type, active, portfolio_id, hide_sold } = req.query;
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
    if (active !== undefined) {
      query += ' AND i.is_active = ?';
      params.push(active === 'true' ? 1 : 0);
    } else {
      query += ' AND i.is_active = 1';
    }
    if (hide_sold === 'true') {
      const portfolioTxnFilter = portfolio_id ? ' AND t2.portfolio_id = ?' : '';
      const portfolioTxnParams = portfolio_id ? [portfolio_id] : [];
      query += ` AND (
        i.asset_type IN ('PPF', 'PF') OR
        COALESCE((
          SELECT SUM(CASE
            WHEN t2.transaction_type IN ('BUY','DEPOSIT','BONUS','RIGHTS','IPO','TRANSFER_IN','SPLIT') THEN COALESCE(t2.units, 0)
            WHEN t2.transaction_type IN ('SELL','WITHDRAWAL','TRANSFER_OUT','CONSOLIDATION') THEN -COALESCE(t2.units, 0)
            ELSE 0 END)
          FROM transactions t2 WHERE t2.investment_id = i.id${portfolioTxnFilter}
        ), 0) > 0
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

    // Get latest daily value
    const latestValue = db.prepare(
      'SELECT * FROM daily_values WHERE investment_id = ? ORDER BY date DESC LIMIT 1'
    ).get(inv.id);

    // Get total units and invested amount
    const totals = db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN transaction_type IN ('BUY', 'DEPOSIT', 'BONUS', 'SPLIT', 'IPO', 'TRANSFER_IN', 'RIGHTS') THEN COALESCE(units, 0) WHEN transaction_type IN ('SELL', 'WITHDRAWAL', 'TRANSFER_OUT', 'CONSOLIDATION') THEN -COALESCE(units, 0) ELSE 0 END), 0) as total_units,
        COALESCE(SUM(CASE WHEN transaction_type IN ('BUY', 'DEPOSIT', 'IPO') THEN amount + COALESCE(fees, 0) ELSE 0 END), 0) as total_invested,
        COALESCE(SUM(CASE WHEN transaction_type IN ('SELL', 'WITHDRAWAL') THEN amount - COALESCE(fees, 0) ELSE 0 END), 0) as sale_proceeds
      FROM transactions WHERE investment_id = ?
    `).get(inv.id);

    // Get transactions
    const transactions = db.prepare(
      'SELECT * FROM transactions WHERE investment_id = ? ORDER BY transaction_date DESC'
    ).all(inv.id);

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
      name, asset_type, ticker_symbol, amfi_code, folio_number,
      account_number, interest_rate, currency, notes,
      face_value, coupon_frequency, maturity_date,
    } = req.body;

    if (!name || !asset_type) {
      return res.status(400).json({ error: 'name and asset_type are required' });
    }

    const result = db.prepare(`
      INSERT INTO investments (name, asset_type, ticker_symbol, amfi_code, folio_number, account_number, interest_rate, currency, face_value, coupon_frequency, maturity_date, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, asset_type, ticker_symbol || null, amfi_code || null,
      folio_number || null, account_number || null, interest_rate || null,
      currency || 'INR', face_value || null,
      coupon_frequency || null, maturity_date || null,
      notes || null);

    const inv = db.prepare('SELECT * FROM investments WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(inv);
  });

  // ─── Update investment ────────────────────────────────────────────────
  router.put('/:id', (req, res) => {
    const {
      name, ticker_symbol, amfi_code, folio_number,
      account_number, interest_rate, currency, notes, is_active, portfolio_id,
      face_value, coupon_frequency, maturity_date,
      display_name, isin_code,
    } = req.body;

    // Build dynamic SET clauses — COALESCE for legacy fields, direct set for new fields
    const sets = [];
    const params = [];

    // Legacy fields: only update if provided (COALESCE pattern)
    const coalesceFields = { name, ticker_symbol, amfi_code, folio_number, account_number, interest_rate, currency, face_value, coupon_frequency, maturity_date, notes, is_active };
    for (const [col, val] of Object.entries(coalesceFields)) {
      sets.push(`${col} = COALESCE(?, ${col})`);
      params.push(val !== undefined ? val : null);
    }

    // New fields: only update if explicitly present in body
    if (display_name !== undefined) { sets.push('display_name = ?'); params.push(display_name || null); }
    if (isin_code !== undefined) { sets.push('isin_code = ?'); params.push(isin_code || null); }

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
