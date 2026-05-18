const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { searchMutualFunds, fetchStockPrice, toNSETicker, searchStocks } = require('../services/priceService');
const { updateAllPrices, cancelUpdate } = require('../services/updater');
const { runSchedulerCycle } = require('../services/scheduler');
const { getPendingDirtyScopes, markDirtyForAssetTypeFromDate, markDirtyFromTransactions, runDirtyBackfillPreflight } = require('../services/dirtyBackfillService');
const { todayIso } = require('../services/backfillService');
const { logAppInfo, logAppError, getLogDir } = require('../services/appLogger');

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

  // ─── Trigger manual price update (full scheduler cycle) ────────────────
  // Runs the same flow as the cron scheduler: gap catch-up → dirty backfill
  // preflight → today's price fetch. This ensures missed days are recovered
  // even when triggered manually from the UI.
  router.post('/update-prices', async (req, res) => {
    try {
      logAppInfo('[UI] Manual update-prices (scheduler cycle) requested');
      const cycleResult = await runSchedulerCycle(db, '[UI] Manual trigger');
      logAppInfo('[UI] Manual update-prices (scheduler cycle) completed', {
        processed: cycleResult?.result?.processed || 0,
        errors: cycleResult?.result?.errors || 0,
        catchUpEnqueued: cycleResult?.catchUp?.enqueued || 0,
        preflightRan: cycleResult?.preflight?.ran || false,
      });
      res.json(cycleResult);
    } catch (e) {
      logAppError('[UI] Manual update-prices failed', { error: e.message });
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/cancel-update', (req, res) => {
    cancelUpdate();
    logAppInfo('[UI] Manual cancel-update requested');
    res.json({ cancelled: true });
  });

  // ─── List and download unified logs ───────────────────────────────────
  router.get('/log-files', (req, res) => {
    try {
      const logDir = getLogDir();
      if (!fs.existsSync(logDir)) {
        return res.json({
          files: [],
          log_dir: logDir,
        });
      }

      const rows = fs.readdirSync(logDir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => {
          const fullPath = path.join(logDir, entry.name);
          const stat = fs.statSync(fullPath);
          return {
            name: entry.name,
            size_bytes: Number(stat.size || 0),
            updated_at: new Date(stat.mtimeMs).toISOString(),
          };
        })
        .filter((file) => /^invest-tracker-\d{4}-\d{2}-\d{2}\.log$/.test(file.name))
        .sort((a, b) => b.name.localeCompare(a.name));

      return res.json({
        files: rows,
        log_dir: logDir,
      });
    } catch (e) {
      logAppError('[API] Failed to list log files', { error: e.message });
      return res.status(500).json({ error: e.message || 'Failed to list log files' });
    }
  });

  router.get('/log-files/:name', (req, res) => {
    try {
      const fileName = String(req.params.name || '').trim();
      if (!/^invest-tracker-\d{4}-\d{2}-\d{2}\.log$/.test(fileName)) {
        return res.status(400).json({ error: 'Invalid log file name' });
      }

      const logDir = getLogDir();
      const fullPath = path.join(logDir, fileName);
      if (!fs.existsSync(fullPath)) {
        return res.status(404).json({ error: 'Log file not found' });
      }

      return res.download(fullPath, fileName);
    } catch (e) {
      logAppError('[API] Failed to download log file', { error: e.message });
      return res.status(500).json({ error: e.message || 'Failed to download log file' });
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
    logAppInfo('[Config] Updated', {
      keys: Object.keys(updates || {}),
    });
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

      markDirtyForAssetTypeFromDate(
        db,
        payload.rate_type,
        payload.effective_from,
        'interest-rate-created',
        `interest_rate:${result.lastInsertRowid}`
      );

      const created = db.prepare('SELECT * FROM interest_rates WHERE id = ?').get(result.lastInsertRowid);
      logAppInfo('[InterestRate] Created', {
        interest_rate_id: Number(result.lastInsertRowid),
        rate_type: payload.rate_type,
        rate: payload.rate,
        effective_from: payload.effective_from,
        effective_to: payload.effective_to,
      });
      return res.status(201).json({ success: true, rate: created });
    } catch (e) {
      logAppError('[InterestRate] Create failed', { error: e.message });
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

      const dirtyFrom = payload.effective_from < existing.effective_from ? payload.effective_from : existing.effective_from;

      db.prepare(
        'UPDATE interest_rates SET rate_type = ?, rate = ?, effective_from = ?, effective_to = ? WHERE id = ?'
      ).run(payload.rate_type, payload.rate, payload.effective_from, payload.effective_to, id);

      markDirtyForAssetTypeFromDate(
        db,
        payload.rate_type,
        dirtyFrom,
        'interest-rate-updated',
        `interest_rate:${id}`
      );

      const updated = db.prepare('SELECT * FROM interest_rates WHERE id = ?').get(id);
      logAppInfo('[InterestRate] Updated', {
        interest_rate_id: id,
        rate_type: payload.rate_type,
        rate: payload.rate,
        effective_from: payload.effective_from,
        effective_to: payload.effective_to,
      });
      return res.json({ success: true, rate: updated });
    } catch (e) {
      logAppError('[InterestRate] Update failed', {
        interest_rate_id: Number(req.params.id) || null,
        error: e.message,
      });
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

      markDirtyForAssetTypeFromDate(
        db,
        existing.rate_type,
        existing.effective_from,
        'interest-rate-deleted',
        `interest_rate:${id}`
      );

      logAppInfo('[InterestRate] Deleted', {
        interest_rate_id: id,
        rate_type: existing.rate_type,
        effective_from: existing.effective_from,
      });

      return res.json({ success: true });
    } catch (e) {
      logAppError('[InterestRate] Delete failed', {
        interest_rate_id: Number(req.params.id) || null,
        error: e.message,
      });
      return res.status(400).json({ error: e.message || 'Failed to delete interest rate' });
    }
  });

  // ─── Dirty backfill scope visibility ───────────────────────────────────
  router.get('/dirty-backfill-scopes', (req, res) => {
    try {
      const runDate = parseDateOnly(req.query.run_date) || todayIso();
      const pending = getPendingDirtyScopes(db, runDate);
      res.json({ run_date: runDate, pending_count: pending.length, pending });
    } catch (e) {
      res.status(500).json({ error: e.message || 'Failed to fetch dirty scopes' });
    }
  });

  // ─── Backfill status ───────────────────────────────────────────────────
  router.get('/backfill-status', (req, res) => {
    try {
      const cfgRows = db.prepare(`
        SELECT key, value, updated_at
        FROM config
        WHERE key IN ('backfill_watermark', 'backfill_last_result', 'backfill_last_error', 'backfill_progress')
      `).all();

      const pending = db.prepare("SELECT COUNT(*) AS c FROM dirty_backfill_scope WHERE status = 'pending'").get().c;
      const running = db.prepare("SELECT COUNT(*) AS c FROM dirty_backfill_scope WHERE status = 'running'").get().c;
      const failed = db.prepare("SELECT COUNT(*) AS c FROM dirty_backfill_scope WHERE status = 'failed'").get().c;
      const completed = db.prepare("SELECT COUNT(*) AS c FROM dirty_backfill_scope WHERE status = 'completed'").get().c;

      const cfg = {};
      for (const row of cfgRows) cfg[row.key] = row.value;

      let lastResult = null;
      if (cfg.backfill_last_result) {
        try {
          lastResult = JSON.parse(cfg.backfill_last_result);
        } catch (_) {
          lastResult = { raw: cfg.backfill_last_result };
        }
      }

      let progress = null;
      if (cfg.backfill_progress) {
        try {
          progress = JSON.parse(cfg.backfill_progress);
        } catch (_) {
          progress = { raw: cfg.backfill_progress };
        }
      }

      const percent = progress && Number(progress.total) > 0
        ? Math.round((Number(progress.completed || 0) / Number(progress.total)) * 1000) / 10
        : null;

      res.json({
        watermark: cfg.backfill_watermark || null,
        progress,
        progressPct: percent,
        lastResult,
        lastError: cfg.backfill_last_error || null,
        counts: { pending, running, failed, completed },
      });
    } catch (e) {
      res.status(500).json({ error: e.message || 'Failed to fetch backfill status' });
    }
  });

  // ─── Backfill trigger (from date / investment) ───────────────────────
  router.post('/backfill', async (req, res) => {
    try {
      const body = req.body || {};
      const runDate = parseDateOnly(body.run_date) || todayIso();
      const fromDate = parseDateOnly(body.from_date);
      const investmentId = body.investment_id != null ? Number(body.investment_id) : null;
      const portfolioId = body.portfolio_id != null ? Number(body.portfolio_id) : null;
      const execute = body.execute !== false;
      logAppInfo('[UI] Manual backfill trigger requested', {
        runDate,
        fromDate: fromDate || null,
        investmentId,
        portfolioId,
        execute,
      });

      if (investmentId != null && (!Number.isInteger(investmentId) || investmentId <= 0)) {
        return res.status(400).json({ error: 'investment_id must be a positive integer' });
      }
      if (portfolioId != null && (!Number.isInteger(portfolioId) || portfolioId <= 0)) {
        return res.status(400).json({ error: 'portfolio_id must be a positive integer' });
      }

      let scopes = [];
      if (investmentId != null) {
        scopes = db.prepare(`
          SELECT
            investment_id,
            portfolio_id,
            COALESCE(?, MIN(date(transaction_date))) AS transaction_date
          FROM transactions
          WHERE investment_id = ?
            ${portfolioId != null ? 'AND portfolio_id = ?' : ''}
            AND date(transaction_date) <= ?
          GROUP BY investment_id, portfolio_id
        `).all(...(portfolioId != null ? [fromDate, investmentId, portfolioId, runDate] : [fromDate, investmentId, runDate]));
      } else {
        scopes = db.prepare(`
          SELECT
            investment_id,
            portfolio_id,
            CASE WHEN ? IS NOT NULL THEN ? ELSE MIN(date(transaction_date)) END AS transaction_date
          FROM transactions
          WHERE date(transaction_date) <= ?
            ${portfolioId != null ? 'AND portfolio_id = ?' : ''}
          GROUP BY investment_id, portfolio_id
        `).all(...(portfolioId != null ? [fromDate, fromDate, runDate, portfolioId] : [fromDate, fromDate, runDate]));
      }

      if (!scopes.length) {
        return res.json({ success: true, run_date: runDate, seeded_scopes: 0, executed: false, message: 'No eligible scopes found' });
      }

      const marked = markDirtyFromTransactions(db, scopes, 'manual-backfill-trigger', `manual:${new Date().toISOString()}`);
      if (!execute) {
        logAppInfo('[UI] Manual backfill trigger seeded only', { runDate, seededScopes: marked });
        return res.json({ success: true, run_date: runDate, seeded_scopes: marked, executed: false });
      }

      const result = await runDirtyBackfillPreflight(db, runDate);
      logAppInfo('[UI] Manual backfill trigger executed', { runDate, seededScopes: marked, result });
      return res.json({ success: true, run_date: runDate, seeded_scopes: marked, executed: true, result });
    } catch (e) {
      logAppError('[UI] Manual backfill trigger failed', { error: e.message });
      return res.status(500).json({ error: e.message || 'Backfill trigger failed' });
    }
  });

  // ─── Dirty backfill preflight trigger ─────────────────────────────────
  router.post('/backfill/preflight', async (req, res) => {
    try {
      const body = req.body || {};
      const runDate = parseDateOnly(body.run_date) || todayIso();
      logAppInfo('[UI] Backfill preflight requested', { runDate });
      const result = await runDirtyBackfillPreflight(db, runDate);
      logAppInfo('[UI] Backfill preflight completed', { runDate, result });
      res.json({ success: true, ...result });
    } catch (e) {
      logAppError('[UI] Backfill preflight failed', { error: e.message });
      res.status(500).json({ error: e.message || 'Dirty backfill preflight failed' });
    }
  });

  // ─── Full backfill seed + optional run ────────────────────────────────
  router.post('/backfill/full', async (req, res) => {
    try {
      const body = req.body || {};
      const runDate = parseDateOnly(body.run_date) || todayIso();
      const execute = body.execute !== false;
      logAppInfo('[UI] Full backfill requested', { runDate, execute });

      const scopes = db.prepare(`
        SELECT t.investment_id, t.portfolio_id, MIN(date(t.transaction_date)) AS transaction_date
        FROM transactions t
        JOIN investments i ON i.id = t.investment_id
        WHERE date(t.transaction_date) <= ?
          AND i.is_active != 0
          AND i.exclude_from_tracking != 1
        GROUP BY t.investment_id, t.portfolio_id
      `).all(runDate);

      const marked = markDirtyFromTransactions(db, scopes, 'full-backfill-seed', `run:${runDate}`);

      if (!execute) {
        logAppInfo('[UI] Full backfill seeded only', { runDate, seededScopes: marked });
        return res.json({ success: true, run_date: runDate, seeded_scopes: marked, executed: false });
      }

      const result = await runDirtyBackfillPreflight(db, runDate);
      logAppInfo('[UI] Full backfill completed', { runDate, seededScopes: marked, result });
      return res.json({ success: true, run_date: runDate, seeded_scopes: marked, executed: true, result });
    } catch (e) {
      logAppError('[UI] Full backfill failed', { error: e.message });
      return res.status(500).json({ error: e.message || 'Full backfill failed' });
    }
  });

  return router;
};
