const express = require('express');
const router = express.Router();

module.exports = function (db) {
  // ─── Get all investments ──────────────────────────────────────────────
  router.get('/', (req, res) => {
    const { type, active, portfolio_id, hide_sold } = req.query;
    let query = 'SELECT * FROM investments WHERE 1=1';
    const params = [];

    if (portfolio_id) {
      query += ' AND portfolio_id = ?';
      params.push(portfolio_id);
    }
    if (type) {
      query += ' AND asset_type = ?';
      params.push(type);
    }
    if (active !== undefined) {
      query += ' AND is_active = ?';
      params.push(active === 'true' ? 1 : 0);
    } else {
      query += ' AND is_active = 1';
    }
    if (hide_sold === 'true') {
      query += ` AND (
        asset_type IN ('PPF', 'PF') OR
        COALESCE((
          SELECT SUM(CASE
            WHEN transaction_type IN ('BUY','DEPOSIT','BONUS','RIGHTS','IPO','TRANSFER_IN','SPLIT') THEN COALESCE(units, 0)
            WHEN transaction_type IN ('SELL','WITHDRAWAL','TRANSFER_OUT','CONSOLIDATION') THEN -COALESCE(units, 0)
            ELSE 0 END)
          FROM transactions WHERE investment_id = investments.id
        ), 0) > 0
      )`;
    }

    query += ' ORDER BY asset_type, name';
    const investments = db.prepare(query).all(...params);
    res.json(investments);
  });

  // ─── Get single investment with details ───────────────────────────────
  router.get('/:id', (req, res) => {
    const inv = db.prepare(`
      SELECT i.*, p.name as portfolio_name, p.color as portfolio_color
      FROM investments i
      LEFT JOIN portfolios p ON i.portfolio_id = p.id
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
      account_number, interest_rate, currency, notes, portfolio_id,
    } = req.body;

    if (!name || !asset_type) {
      return res.status(400).json({ error: 'name and asset_type are required' });
    }

    const result = db.prepare(`
      INSERT INTO investments (name, asset_type, ticker_symbol, amfi_code, folio_number, account_number, interest_rate, currency, notes, portfolio_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, asset_type, ticker_symbol || null, amfi_code || null,
      folio_number || null, account_number || null, interest_rate || null,
      currency || 'INR', notes || null, portfolio_id || null);

    const inv = db.prepare('SELECT * FROM investments WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(inv);
  });

  // ─── Update investment ────────────────────────────────────────────────
  router.put('/:id', (req, res) => {
    const {
      name, ticker_symbol, amfi_code, folio_number,
      account_number, interest_rate, currency, notes, is_active, portfolio_id,
    } = req.body;

    db.prepare(`
      UPDATE investments SET
        name = COALESCE(?, name),
        ticker_symbol = COALESCE(?, ticker_symbol),
        amfi_code = COALESCE(?, amfi_code),
        folio_number = COALESCE(?, folio_number),
        account_number = COALESCE(?, account_number),
        interest_rate = COALESCE(?, interest_rate),
        currency = COALESCE(?, currency),
        notes = COALESCE(?, notes),
        is_active = COALESCE(?, is_active),
        portfolio_id = COALESCE(?, portfolio_id),
        updated_at = datetime('now')
      WHERE id = ?
    `).run(name, ticker_symbol, amfi_code, folio_number,
      account_number, interest_rate, currency, notes, is_active, portfolio_id, req.params.id);

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
