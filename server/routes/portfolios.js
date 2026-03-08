const express = require('express');
const router = express.Router();

module.exports = function (db) {
  // ─── Get all portfolios ─────────────────────────────────────────────
  router.get('/', (req, res) => {
    const portfolios = db.prepare('SELECT * FROM portfolios ORDER BY name').all();

    // Enrich with summary stats from latest daily_values
    const enriched = portfolios.map((p) => {
      const stats = db.prepare(`
        SELECT
          COUNT(DISTINCT i.id) as investment_count,
          COALESCE(SUM(dv.current_value), 0) as total_value,
          COALESCE(SUM(dv.invested_amount), 0) as total_invested,
          COALESCE(SUM(dv.profit_loss), 0) as total_profit_loss,
          COALESCE(SUM(dv.day_change), 0) as day_change
        FROM investments i
        LEFT JOIN daily_values dv ON i.id = dv.investment_id
          AND dv.date = (SELECT MAX(date) FROM daily_values WHERE investment_id = i.id)
        WHERE i.is_active = 1 AND i.portfolio_id = ?
      `).get(p.id);

      return { ...p, ...stats };
    });

    res.json(enriched);
  });

  // ─── Get single portfolio ──────────────────────────────────────────
  router.get('/:id', (req, res) => {
    const portfolio = db.prepare('SELECT * FROM portfolios WHERE id = ?').get(req.params.id);
    if (!portfolio) return res.status(404).json({ error: 'Portfolio not found' });
    res.json(portfolio);
  });

  // ─── Create portfolio ─────────────────────────────────────────────
  router.post('/', (req, res) => {
    const { name, color, pan_number } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    try {
      const result = db.prepare('INSERT INTO portfolios (name, color, pan_number) VALUES (?, ?, ?)').run(name, color || '#f59e0b', pan_number || null);
      const portfolio = db.prepare('SELECT * FROM portfolios WHERE id = ?').get(result.lastInsertRowid);
      res.status(201).json(portfolio);
    } catch (e) {
      if (e.message.includes('UNIQUE')) {
        return res.status(409).json({ error: 'A portfolio with this name already exists' });
      }
      throw e;
    }
  });

  // ─── Update portfolio ─────────────────────────────────────────────
  router.put('/:id', (req, res) => {
    const { name, color, pan_number } = req.body;
    db.prepare(`
      UPDATE portfolios SET
        name = COALESCE(?, name),
        color = COALESCE(?, color),
        pan_number = COALESCE(?, pan_number)
      WHERE id = ?
    `).run(name, color, pan_number, req.params.id);
    const portfolio = db.prepare('SELECT * FROM portfolios WHERE id = ?').get(req.params.id);
    res.json(portfolio);
  });

  // ─── Delete portfolio ─────────────────────────────────────────────
  router.delete('/:id', (req, res) => {
    // Unassign investments first (don't delete them)
    db.prepare('UPDATE investments SET portfolio_id = NULL WHERE portfolio_id = ?').run(req.params.id);
    db.prepare('DELETE FROM portfolios WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  });

  return router;
};
