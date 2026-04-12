const express = require('express');
const router = express.Router();

module.exports = function (db) {
  // ─── Add transaction ──────────────────────────────────────────────────
  router.post('/', (req, res) => {
    const {
      investment_id, transaction_type, transaction_date,
      units, price_per_unit, amount, fees, notes, broker, portfolio_id,
    } = req.body;

    if (!investment_id || !portfolio_id || !transaction_type || !transaction_date || !amount) {
      return res.status(400).json({ error: 'investment_id, portfolio_id, transaction_type, transaction_date, and amount are required' });
    }

    const inv = db.prepare('SELECT * FROM investments WHERE id = ?').get(investment_id);
    if (!inv) return res.status(404).json({ error: 'Investment not found' });

    const result = db.prepare(`
      INSERT INTO transactions (investment_id, portfolio_id, transaction_type, transaction_date, units, price_per_unit, amount, fees, broker, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(investment_id, portfolio_id, transaction_type, transaction_date,
      units || null, price_per_unit || null, amount, fees || 0, broker || null, notes || null);

    const txn = db.prepare('SELECT * FROM transactions WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(txn);
  });

  // ─── Get transactions for an investment ───────────────────────────────
  router.get('/investment/:investmentId', (req, res) => {
    const txns = db.prepare(
      'SELECT * FROM transactions WHERE investment_id = ? ORDER BY transaction_date DESC, id DESC'
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

  // ─── Get distinct transaction types (optionally filtered by asset type / portfolio) ───
  router.get('/transaction-types', (req, res) => {
    const { asset_type, portfolio_id } = req.query;
    let sql = `SELECT DISTINCT t.transaction_type FROM transactions t
       JOIN investments i ON t.investment_id = i.id WHERE 1=1`;
    const params = [];
    if (asset_type) {
      sql += ` AND i.asset_type = ?`;
      params.push(asset_type);
    }
    if (portfolio_id) {
      sql += ` AND t.portfolio_id = ?`;
      params.push(portfolio_id);
    }
    sql += ` ORDER BY t.transaction_type`;
    const types = db.prepare(sql).all(...params).map(r => r.transaction_type);
    res.json(types);
  });

  // ─── Get distinct brokers ─────────────────────────────────────────────
  router.get('/brokers', (req, res) => {
    const { asset_type, portfolio_id } = req.query;
    let sql = `SELECT DISTINCT t.broker FROM transactions t
       INNER JOIN investments i ON t.investment_id = i.id
       WHERE t.broker IS NOT NULL AND t.broker != ''`;
    const params = [];
    if (asset_type) {
      sql += ` AND i.asset_type = ?`;
      params.push(asset_type);
    }
    if (portfolio_id) {
      sql += ` AND t.portfolio_id = ?`;
      params.push(portfolio_id);
    }
    sql += ` ORDER BY t.broker`;
    const brokers = db.prepare(sql).all(...params).map(r => r.broker);
    res.json(brokers);
  });

  // ─── Get investment names that have transactions ──────────────────────
  router.get('/investment-names', (req, res) => {
    const { portfolio_id, asset_type } = req.query;
    let sql = `SELECT DISTINCT COALESCE(i.display_name, i.name) as name FROM investments i
       INNER JOIN transactions t ON t.investment_id = i.id WHERE 1=1`;
    const params = [];
    if (portfolio_id) {
      sql += ` AND t.portfolio_id = ?`;
      params.push(portfolio_id);
    }
    if (asset_type) {
      sql += ` AND i.asset_type = ?`;
      params.push(asset_type);
    }
    sql += ` ORDER BY name`;
    const names = db.prepare(sql).all(...params).map(r => r.name);
    res.json(names);
  });

  router.get('/', (req, res) => {
    const { from, to, type, portfolio_id, broker, investment_id, investment_name, limit, offset } = req.query;
    let where = ' WHERE 1=1';
    const filterParams = [];

    if (portfolio_id) { where += ' AND t.portfolio_id = ?'; filterParams.push(portfolio_id); }
    if (from) { where += ' AND t.transaction_date >= ?'; filterParams.push(from); }
    if (to) { where += ' AND t.transaction_date <= ?'; filterParams.push(to); }
    if (type) {
      const types = type.split(',').map(t => t.trim()).filter(Boolean);
      if (types.length === 1) {
        where += ' AND t.transaction_type = ?';
        filterParams.push(types[0]);
      } else if (types.length > 1) {
        where += ` AND t.transaction_type IN (${types.map(() => '?').join(',')})`;
        filterParams.push(...types);
      }
    }
    if (broker) { where += ' AND t.broker = ?'; filterParams.push(broker); }
    if (investment_id) { where += ' AND t.investment_id = ?'; filterParams.push(investment_id); }
    if (investment_name) { where += ' AND COALESCE(i.display_name, i.name) = ?'; filterParams.push(investment_name); }
    if (req.query.asset_type) { where += ' AND i.asset_type = ?'; filterParams.push(req.query.asset_type); }

    const countQuery = `
      SELECT COUNT(*) AS total
      FROM transactions t
      JOIN investments i ON t.investment_id = i.id
      ${where}
    `;
    const total = db.prepare(countQuery).get(...filterParams).total;

    let dataQuery = `
      SELECT t.*, COALESCE(i.display_name, i.name) as investment_name, i.asset_type,
        t.broker as broker, p.name as portfolio_name, p.color as portfolio_color
      FROM transactions t
      JOIN investments i ON t.investment_id = i.id
      LEFT JOIN portfolios p ON t.portfolio_id = p.id
      ${where}
      ORDER BY t.transaction_date DESC, t.id DESC
    `;

    const dataParams = [...filterParams];

    const parsedLimit = Number(limit);
    const parsedOffset = Number(offset);
    const hasLimit = Number.isFinite(parsedLimit) && parsedLimit > 0;
    const hasOffset = Number.isFinite(parsedOffset) && parsedOffset >= 0;

    // Optional server-side pagination controls.
    let safeLimit = null;
    let safeOffset = 0;
    if (hasLimit) {
      safeLimit = Math.min(Math.floor(parsedLimit), 200);
      dataQuery += ' LIMIT ?';
      dataParams.push(safeLimit);
      if (hasOffset) {
        safeOffset = Math.floor(parsedOffset);
        dataQuery += ' OFFSET ?';
        dataParams.push(safeOffset);
      }
    }

    const items = db.prepare(dataQuery).all(...dataParams);
    res.json({ items, total, limit: safeLimit, offset: safeOffset });
  });

  // ─── Update transaction ───────────────────────────────────────────────
  router.put('/:id', (req, res) => {
    const existing = db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Transaction not found' });

    const { transaction_date, units, price_per_unit, amount, fees, notes, broker, folio_number } = req.body;
    db.prepare(`
      UPDATE transactions
      SET transaction_date = ?, units = ?, price_per_unit = ?, amount = ?, fees = ?, notes = ?, broker = ?, folio_number = ?
      WHERE id = ?
    `).run(
      transaction_date || existing.transaction_date,
      units ?? existing.units,
      price_per_unit ?? existing.price_per_unit,
      amount ?? existing.amount,
      fees ?? existing.fees,
      notes !== undefined ? notes : existing.notes,
      broker !== undefined ? broker : existing.broker,
      folio_number !== undefined ? folio_number : existing.folio_number,
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
