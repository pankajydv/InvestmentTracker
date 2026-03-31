const express = require('express');
const router = express.Router();
const XLSX = require('xlsx');
const { searchMutualFunds, fetchStockPrice, toNSETicker, searchStocks } = require('../services/priceService');
const { updateAllPrices, cancelUpdate } = require('../services/updater');

module.exports = function (db) {

  // ─── Export all data to XLSX ──────────────────────────────────────────
  router.get('/export', (req, res) => {
    try {
      const portfolios = db.prepare('SELECT id, name, pan_number, color, created_at FROM portfolios ORDER BY id').all();
      const investments = db.prepare(`
        SELECT id, name, display_name, asset_type, category,
               ticker_symbol, amfi_code, isin_code, previous_isin_codes,
               account_number, interest_rate, currency,
               face_value, coupon_frequency, maturity_date,
               notes, created_at, updated_at
        FROM investments ORDER BY id
      `).all();
      const transactions = db.prepare(`
        SELECT t.id, t.investment_id, i.name AS investment_name,
               t.portfolio_id, p.name AS portfolio_name,
               t.transaction_type, t.transaction_date,
               t.units, t.price_per_unit, t.amount, t.fees,
               t.folio_number, t.broker, t.locked, t.notes, t.created_at
        FROM transactions t
        JOIN investments i ON i.id = t.investment_id
        JOIN portfolios p ON p.id = t.portfolio_id
        ORDER BY t.portfolio_id, t.investment_id, t.transaction_date, t.id
      `).all();
      const expenses = db.prepare(`
        SELECT e.id, e.portfolio_id, p.name AS portfolio_name,
               e.expense_type, e.expense_date, e.amount, e.broker, e.notes, e.created_at
        FROM portfolio_expenses e
        JOIN portfolios p ON p.id = e.portfolio_id
        ORDER BY e.portfolio_id, e.expense_date, e.id
      `).all();
      const rates = db.prepare('SELECT id, rate_type, rate, effective_from, effective_to, created_at FROM interest_rates ORDER BY id').all();
      const config = db.prepare('SELECT key, value, updated_at FROM config ORDER BY key').all();

      const wb = XLSX.utils.book_new();
      const sheets = [
        ['Portfolios', portfolios],
        ['Investments', investments],
        ['Transactions', transactions],
        ['Expenses', expenses],
        ['Interest_Rates', rates],
        ['Config', config],
      ];
      for (const [name, data] of sheets) {
        const ws = data.length
          ? XLSX.utils.json_to_sheet(data)
          : XLSX.utils.aoa_to_sheet([['(empty)']]);
        if (data.length) {
          const keys = Object.keys(data[0]);
          ws['!cols'] = keys.map(k => {
            let max = k.length;
            for (const r of data) {
              const v = r[k];
              if (v != null) { const len = String(v).length; if (len > max) max = len; }
            }
            return { wch: Math.min(max + 2, 60) };
          });
        }
        XLSX.utils.book_append_sheet(wb, ws, name);
      }

      const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      const dateStr = new Date().toISOString().slice(0, 10);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="InvestmentTracker_${dateStr}.xlsx"`);
      res.send(buf);
    } catch (e) {
      console.error('Export error:', e);
      res.status(500).json({ error: 'Export failed: ' + e.message });
    }
  });
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
      const options = {};
      // Accept optional assetType filter (single string or array)
      if (req.body && req.body.assetTypes) {
        options.assetTypes = Array.isArray(req.body.assetTypes)
          ? req.body.assetTypes : [req.body.assetTypes];
      }
      const result = await updateAllPrices(db, options);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/cancel-update', (req, res) => {
    cancelUpdate();
    res.json({ cancelled: true });
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
