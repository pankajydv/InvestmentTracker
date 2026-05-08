const express = require('express');
const router = express.Router();
const XLSX = require('xlsx');
const { searchMutualFunds, fetchStockPrice, toNSETicker, searchStocks } = require('../services/priceService');
const { updateAllPrices, cancelUpdate } = require('../services/updater');

const VALID_RATE_TYPES = new Set(['PPF', 'SSY', 'PF']);

function parseDateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : value;
}

function normalizeRatePayload(body) {
  const rate_type = typeof body.rate_type === 'string' ? body.rate_type.trim().toUpperCase() : '';
  const effective_from = parseDateOnly(body.effective_from);
  const effective_to = body.effective_to ? parseDateOnly(body.effective_to) : null;
  const rateNum = Number(body.rate);

  if (!VALID_RATE_TYPES.has(rate_type)) {
    throw new Error('rate_type must be one of PPF, SSY, PF');
  }
  if (!Number.isFinite(rateNum) || rateNum <= 0 || rateNum > 100) {
    throw new Error('rate must be a valid percentage greater than 0 and at most 100');
  }
  if (!effective_from) {
    throw new Error('effective_from must be a valid date in YYYY-MM-DD format');
  }
  if (body.effective_to && !effective_to) {
    throw new Error('effective_to must be a valid date in YYYY-MM-DD format');
  }
  if (effective_to && effective_to < effective_from) {
    throw new Error('effective_to must be greater than or equal to effective_from');
  }

  return {
    rate_type,
    rate: rateNum,
    effective_from,
    effective_to,
  };
}

function findOverlappingRate(db, payload, excludeId = null) {
  const rows = db.prepare(
    'SELECT id, rate_type, rate, effective_from, effective_to FROM interest_rates WHERE rate_type = ? ORDER BY effective_from ASC'
  ).all(payload.rate_type);

  const newFrom = payload.effective_from;
  const newTo = payload.effective_to || '9999-12-31';

  return rows.find((row) => {
    if (excludeId != null && Number(row.id) === Number(excludeId)) return false;
    const rowFrom = row.effective_from;
    const rowTo = row.effective_to || '9999-12-31';
    return newFrom <= rowTo && rowFrom <= newTo;
  }) || null;
}

module.exports = function (db) {

  // ─── Export all data to XLSX ──────────────────────────────────────────
  router.get('/export', (req, res) => {
    try {
      const portfolios = db.prepare('SELECT id, name, pan_number, color, created_at FROM portfolios ORDER BY id').all();
      const hasInterestRate = db.prepare("PRAGMA table_info(investments)")
        .all()
        .some(col => col.name === 'interest_rate');
      const interestRateSelect = hasInterestRate ? 'interest_rate' : 'NULL AS interest_rate';
      const investments = db.prepare(`
        SELECT id, name, display_name, asset_type, category,
               ticker_symbol, amfi_code, isin_code, previous_isin_codes,
               account_number, ${interestRateSelect}, currency,
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
    const dbRates = db.prepare('SELECT * FROM interest_rates ORDER BY rate_type, effective_from DESC').all();

    res.json({
      rates: dbRates,
      source: 'database',
    });
  });

  router.post('/interest-rates', (req, res) => {
    try {
      const payload = normalizeRatePayload(req.body || {});
      const overlap = findOverlappingRate(db, payload);
      if (overlap) {
        return res.status(409).json({
          error: 'Overlapping interest rate range exists for this scheme.',
          conflict: overlap,
        });
      }

      const result = db.prepare(
        'INSERT INTO interest_rates (rate_type, rate, effective_from, effective_to) VALUES (?, ?, ?, ?)'
      ).run(payload.rate_type, payload.rate, payload.effective_from, payload.effective_to);

      const created = db.prepare('SELECT * FROM interest_rates WHERE id = ?').get(result.lastInsertRowid);
      return res.status(201).json({ success: true, rate: created });
    } catch (e) {
      return res.status(400).json({ error: e.message || 'Failed to create interest rate' });
    }
  });

  router.put('/interest-rates/:id', (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid id' });
      }

      const existing = db.prepare('SELECT * FROM interest_rates WHERE id = ?').get(id);
      if (!existing) {
        return res.status(404).json({ error: 'Interest rate entry not found' });
      }

      const payload = normalizeRatePayload(req.body || {});
      const overlap = findOverlappingRate(db, payload, id);
      if (overlap) {
        return res.status(409).json({
          error: 'Overlapping interest rate range exists for this scheme.',
          conflict: overlap,
        });
      }

      db.prepare(
        'UPDATE interest_rates SET rate_type = ?, rate = ?, effective_from = ?, effective_to = ? WHERE id = ?'
      ).run(payload.rate_type, payload.rate, payload.effective_from, payload.effective_to, id);

      const updated = db.prepare('SELECT * FROM interest_rates WHERE id = ?').get(id);
      return res.json({ success: true, rate: updated });
    } catch (e) {
      return res.status(400).json({ error: e.message || 'Failed to update interest rate' });
    }
  });

  router.delete('/interest-rates/:id', (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid id' });
      }

      const existing = db.prepare('SELECT * FROM interest_rates WHERE id = ?').get(id);
      if (!existing) {
        return res.status(404).json({ error: 'Interest rate entry not found' });
      }

      db.prepare('DELETE FROM interest_rates WHERE id = ?').run(id);
      return res.json({ success: true });
    } catch (e) {
      return res.status(400).json({ error: e.message || 'Failed to delete interest rate' });
    }
  });

  return router;
};
