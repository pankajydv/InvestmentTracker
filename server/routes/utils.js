const express = require('express');
const router = express.Router();
const { searchMutualFunds, fetchStockPrice, toNSETicker, searchStocks } = require('../services/priceService');
const { updateAllPrices } = require('../services/updater');

module.exports = function (db) {
  // ─── Search mutual funds ──────────────────────────────────────────────
  router.get('/search-mf', async (req, res) => {
    try {
      const { q } = req.query;
      if (!q || q.length < 2) return res.json([]);
      const results = await searchMutualFunds(q);
      res.json(results);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── Search stocks by name ────────────────────────────────────────────
  router.get('/search-stock-name', async (req, res) => {
    try {
      const { q, market } = req.query;
      if (!q || q.length < 2) return res.json([]);
      const results = await searchStocks(q, market);
      res.json(results);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── Search/validate stock ticker ─────────────────────────────────────
  router.get('/search-stock', async (req, res) => {
    try {
      const { symbol, market } = req.query;
      if (!symbol) return res.status(400).json({ error: 'symbol required' });

      const ticker = market === 'NSE' ? toNSETicker(symbol) : symbol;
      const data = await fetchStockPrice(ticker);
      res.json({ ...data, ticker });
    } catch (e) {
      res.status(404).json({ error: `Could not find stock: ${e.message}` });
    }
  });

  // ─── Trigger manual price update ──────────────────────────────────────
  router.post('/update-prices', async (req, res) => {
    try {
      const result = await updateAllPrices(db);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── Get/update config ────────────────────────────────────────────────
  router.get('/config', (req, res) => {
    const config = {};
    const rows = db.prepare('SELECT * FROM config').all();
    for (const row of rows) {
      config[row.key] = row.value;
    }
    res.json(config);
  });

  router.put('/config', (req, res) => {
    const updates = req.body;
    const stmt = db.prepare("INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))");
    for (const [key, value] of Object.entries(updates)) {
      stmt.run(key, String(value));
    }
    res.json({ success: true });
  });

  // ─── Get interest rates ───────────────────────────────────────────────
  router.get('/interest-rates', (req, res) => {
    const rates = db.prepare('SELECT * FROM interest_rates ORDER BY rate_type, effective_from DESC').all();
    res.json(rates);
  });

  router.post('/interest-rates', (req, res) => {
    const { rate_type, rate, effective_from } = req.body;
    if (!rate_type || !rate || !effective_from) {
      return res.status(400).json({ error: 'rate_type, rate, and effective_from are required' });
    }
    db.prepare('INSERT INTO interest_rates (rate_type, rate, effective_from) VALUES (?, ?, ?)')
      .run(rate_type, rate, effective_from);
    res.status(201).json({ success: true });
  });

  return router;
};
