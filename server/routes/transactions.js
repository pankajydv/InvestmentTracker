const express = require('express');
const router = express.Router();

module.exports = function (db) {
  // ─── Add transaction ──────────────────────────────────────────────────
  router.post('/', (req, res) => {
    const {
      investment_id, transaction_type, transaction_date,
      units, price_per_unit, amount, fees, notes,
    } = req.body;

    if (!investment_id || !transaction_type || !transaction_date || !amount) {
      return res.status(400).json({ error: 'investment_id, transaction_type, transaction_date, and amount are required' });
    }

    const inv = db.prepare('SELECT * FROM investments WHERE id = ?').get(investment_id);
    if (!inv) return res.status(404).json({ error: 'Investment not found' });

    const result = db.prepare(`
      INSERT INTO transactions (investment_id, transaction_type, transaction_date, units, price_per_unit, amount, fees, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(investment_id, transaction_type, transaction_date,
      units || null, price_per_unit || null, amount, fees || 0, notes || null);

    const txn = db.prepare('SELECT * FROM transactions WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(txn);
  });

  // ─── Get transactions for an investment ───────────────────────────────
  router.get('/investment/:investmentId', (req, res) => {
    const txns = db.prepare(
      'SELECT * FROM transactions WHERE investment_id = ? ORDER BY transaction_date DESC'
    ).all(req.params.investmentId);
    res.json(txns);
  });

  // ─── Get all transactions ─────────────────────────────────────────────
  // ─── Get distinct asset types that have transactions ──────────────────
  router.get('/asset-types', (req, res) => {
    const types = db.prepare(
      `SELECT DISTINCT i.asset_type FROM investments i
       INNER JOIN transactions t ON t.investment_id = i.id
       ORDER BY i.asset_type`
    ).all().map(r => r.asset_type);
    res.json(types);
  });

  // ─── Get distinct transaction types (optionally filtered by asset type) ───
  router.get('/transaction-types', (req, res) => {
    const { asset_type } = req.query;
    let sql = `SELECT DISTINCT t.transaction_type FROM transactions t
       JOIN investments i ON t.investment_id = i.id`;
    const params = [];
    if (asset_type) {
      sql += ` WHERE i.asset_type = ?`;
      params.push(asset_type);
    }
    sql += ` ORDER BY t.transaction_type`;
    const types = db.prepare(sql).all(...params).map(r => r.transaction_type);
    res.json(types);
  });

  // ─── Get distinct brokers ─────────────────────────────────────────────
  router.get('/brokers', (req, res) => {
    const { asset_type } = req.query;
    let sql = `SELECT DISTINCT i.broker FROM investments i
       INNER JOIN transactions t ON t.investment_id = i.id
       WHERE i.broker IS NOT NULL AND i.broker != ''`;
    const params = [];
    if (asset_type) {
      sql += ` AND i.asset_type = ?`;
      params.push(asset_type);
    }
    sql += ` ORDER BY i.broker`;
    const brokers = db.prepare(sql).all(...params).map(r => r.broker);
    res.json(brokers);
  });

  // ─── Get investment names that have transactions ──────────────────────
  router.get('/investment-names', (req, res) => {
    const { portfolio_id, asset_type } = req.query;
    let sql = `SELECT DISTINCT i.name FROM investments i
       INNER JOIN transactions t ON t.investment_id = i.id WHERE 1=1`;
    const params = [];
    if (portfolio_id) {
      sql += ` AND i.portfolio_id = ?`;
      params.push(portfolio_id);
    }
    if (asset_type) {
      sql += ` AND i.asset_type = ?`;
      params.push(asset_type);
    }
    sql += ` ORDER BY i.name`;
    const names = db.prepare(sql).all(...params).map(r => r.name);
    res.json(names);
  });

  router.get('/', (req, res) => {
    const { from, to, type, portfolio_id, broker, investment_id, investment_name } = req.query;
    let query = `
      SELECT t.*, i.name as investment_name, i.asset_type, i.portfolio_id,
        i.broker as broker, p.name as portfolio_name
      FROM transactions t
      JOIN investments i ON t.investment_id = i.id
      LEFT JOIN portfolios p ON i.portfolio_id = p.id
      WHERE 1=1
    `;
    const params = [];

    if (portfolio_id) { query += ' AND i.portfolio_id = ?'; params.push(portfolio_id); }
    if (from) { query += ' AND t.transaction_date >= ?'; params.push(from); }
    if (to) { query += ' AND t.transaction_date <= ?'; params.push(to); }
    if (type) {
      const types = type.split(',').map(t => t.trim()).filter(Boolean);
      if (types.length === 1) {
        query += ' AND t.transaction_type = ?';
        params.push(types[0]);
      } else if (types.length > 1) {
        query += ` AND t.transaction_type IN (${types.map(() => '?').join(',')})`;
        params.push(...types);
      }
    }
    if (broker) { query += ' AND i.broker = ?'; params.push(broker); }
    if (investment_id) { query += ' AND t.investment_id = ?'; params.push(investment_id); }
    if (investment_name) { query += ' AND i.name = ?'; params.push(investment_name); }
    if (req.query.asset_type) { query += ' AND i.asset_type = ?'; params.push(req.query.asset_type); }

    query += ' ORDER BY t.transaction_date DESC LIMIT 500';
    const txns = db.prepare(query).all(...params);
    res.json(txns);
  });

  // ─── Update transaction ───────────────────────────────────────────────
  router.put('/:id', (req, res) => {
    const existing = db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Transaction not found' });

    const { transaction_date, units, price_per_unit, amount, fees, notes } = req.body;
    db.prepare(`
      UPDATE transactions
      SET transaction_date = ?, units = ?, price_per_unit = ?, amount = ?, fees = ?, notes = ?
      WHERE id = ?
    `).run(
      transaction_date || existing.transaction_date,
      units ?? existing.units,
      price_per_unit ?? existing.price_per_unit,
      amount ?? existing.amount,
      fees ?? existing.fees,
      notes !== undefined ? notes : existing.notes,
      req.params.id
    );

    const txn = db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id);
    res.json(txn);
  });

  // ─── Delete transaction ───────────────────────────────────────────────
  router.delete('/:id', (req, res) => {
    db.prepare('DELETE FROM transactions WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  });

  return router;
};
