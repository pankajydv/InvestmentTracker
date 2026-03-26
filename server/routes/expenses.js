const express = require('express');
const router = express.Router();

module.exports = function (db) {
  /**
   * GET /api/expenses
   * List expenses, optionally filtered by portfolio_id and/or expense_type.
   */
  router.get('/', (req, res) => {
    const { portfolio_id, expense_type } = req.query;
    let sql = `
      SELECT e.*, p.name as portfolio_name, p.color as portfolio_color
      FROM portfolio_expenses e
      JOIN portfolios p ON p.id = e.portfolio_id
      WHERE 1=1
    `;
    const params = [];

    if (portfolio_id) {
      sql += ' AND e.portfolio_id = ?';
      params.push(portfolio_id);
    }
    if (expense_type) {
      sql += ' AND e.expense_type = ?';
      params.push(expense_type);
    }

    sql += ' ORDER BY e.expense_date DESC';

    const expenses = db.prepare(sql).all(...params);
    res.json(expenses);
  });

  /**
   * GET /api/expenses/summary
   * Total expenses, optionally filtered by portfolio_id.
   * Returns total and per-type breakdown.
   */
  router.get('/summary', (req, res) => {
    const { portfolio_id } = req.query;
    const filter = portfolio_id ? ' WHERE portfolio_id = ?' : '';
    const params = portfolio_id ? [portfolio_id] : [];

    const total = db.prepare(
      `SELECT COALESCE(SUM(amount), 0) as total_expenses FROM portfolio_expenses${filter}`
    ).get(...params);

    const byType = db.prepare(
      `SELECT expense_type, COALESCE(SUM(amount), 0) as total, COUNT(*) as count
       FROM portfolio_expenses${filter} GROUP BY expense_type ORDER BY total DESC`
    ).all(...params);

    res.json({ total_expenses: total.total_expenses, byType });
  });

  /**
   * POST /api/expenses
   * Create a new expense.
   * Body: { portfolio_id, expense_type, expense_date, amount, broker, notes }
   */
  router.post('/', express.json(), (req, res) => {
    const { portfolio_id, expense_type, expense_date, amount, broker, notes } = req.body;

    if (!portfolio_id) return res.status(400).json({ error: 'portfolio_id is required' });
    if (!expense_type) return res.status(400).json({ error: 'expense_type is required' });
    if (!expense_date) return res.status(400).json({ error: 'expense_date is required' });
    if (!amount || amount <= 0) return res.status(400).json({ error: 'amount must be positive' });

    const validTypes = ['AMC', 'PLATFORM_FEE', 'CDSL', 'ACCOUNT_OPENING', 'OTHER'];
    if (!validTypes.includes(expense_type)) {
      return res.status(400).json({ error: `expense_type must be one of: ${validTypes.join(', ')}` });
    }

    const portfolio = db.prepare('SELECT * FROM portfolios WHERE id = ?').get(portfolio_id);
    if (!portfolio) return res.status(404).json({ error: 'Portfolio not found' });

    const result = db.prepare(
      'INSERT INTO portfolio_expenses (portfolio_id, expense_type, expense_date, amount, broker, notes) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(portfolio_id, expense_type, expense_date, parseFloat(amount), broker || null, notes || null);

    const expense = db.prepare('SELECT * FROM portfolio_expenses WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(expense);
  });

  /**
   * DELETE /api/expenses/:id
   */
  router.delete('/:id', (req, res) => {
    const expense = db.prepare('SELECT * FROM portfolio_expenses WHERE id = ?').get(req.params.id);
    if (!expense) return res.status(404).json({ error: 'Expense not found' });

    db.prepare('DELETE FROM portfolio_expenses WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  });

  return router;
};
