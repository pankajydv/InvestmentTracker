const express = require('express');
const router = express.Router();
const { fetchHistoricalUSDToINR, fetchUSDToINR } = require('../services/priceService');
const { markDirtyFromTransactions } = require('../services/dirtyBackfillService');
const { logAppInfo, logAppError } = require('../services/appLogger');

/**
 * Normalize transaction_date to YYYY-MM-DD format (no time component)
 * Handles inputs like "2016-03-31", "2016-03-31 00:00:00", or Date objects
 */
function normalizeTransactionDate(dateInput) {
  if (!dateInput) return null;
  
  // Handle Date objects
  if (dateInput instanceof Date) {
    return dateInput.toISOString().split('T')[0];
  }
  
  // Convert to string and extract date part (handles both space and ISO T separators)
  const dateStr = String(dateInput).split(/[ T]/)[0].trim();
  
  // Validate YYYY-MM-DD format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  
  // Verify it's a valid date
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : dateStr;
}

function normalizeIndianCorporateUnits(assetType, transactionType, unitsInput) {
  if (assetType !== 'INDIAN_STOCK') return { ok: true, value: unitsInput };
  if (transactionType !== 'SPLIT' && transactionType !== 'BONUS') return { ok: true, value: unitsInput };

  const units = Number(unitsInput);
  if (!Number.isFinite(units) || units <= 0) {
    return {
      ok: false,
      error: 'For Indian stocks, SPLIT/BONUS units must be a positive whole number',
    };
  }

  const wholeUnits = Math.round(units);
  if (Math.abs(units - wholeUnits) > 0.000001) {
    return {
      ok: false,
      error: 'For Indian stocks, SPLIT/BONUS units must be a positive whole number',
    };
  }

  return { ok: true, value: wholeUnits };
}

// PF transaction types that get merged into a single contribution row per date
const PF_GROUPABLE_TYPES = new Set(['DEPOSIT', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'EPS_CONTRIBUTION']);

/**
 * For PF asset type transactions, group DEPOSIT / EMPLOYER_CONTRIBUTION /
 * VOLUNTARY_CONTRIBUTION / EPS_CONTRIBUTION entries that share the same
 * investment_id + date into a single synthetic PF_CONTRIBUTION row.
 * Non-groupable types (INTEREST, WITHDRAWAL, etc.) pass through unchanged.
 */
function groupPfTransactions(rows) {
  const keyFor = (r) => `${r.portfolio_id || ''}|${r.investment_id}|${r.transaction_date}`;
  const isGroupable = (r) => r.asset_type === 'PF' && PF_GROUPABLE_TYPES.has(r.transaction_type);

  const groupedBuckets = new Map();
  for (const row of rows) {
    if (!isGroupable(row)) continue;
    const key = keyFor(row);
    if (!groupedBuckets.has(key)) groupedBuckets.set(key, []);
    groupedBuckets.get(key).push(row);
  }

  const emitted = new Set();
  const transformed = [];

  for (const row of rows) {
    if (!isGroupable(row)) {
      transformed.push(row);
      continue;
    }
    const key = keyFor(row);
    if (emitted.has(key)) continue;
    emitted.add(key);

    const bucket = groupedBuckets.get(key) || [row];

    // Single rows pass through unchanged
    if (bucket.length === 1) {
      transformed.push(bucket[0]);
      continue;
    }

    let employeeAmount = 0;
    let employerAmount = 0;
    let epsAmount = 0;
    const notes = [];
    const seenNotes = new Set();
    let base = bucket[0];

    for (const b of bucket) {
      if (b.id > base.id) base = b;
      if (b.transaction_type === 'EMPLOYER_CONTRIBUTION') {
        employerAmount += Number(b.amount || 0);
      } else if (b.transaction_type === 'EPS_CONTRIBUTION') {
        epsAmount += Number(b.amount || 0);
      } else {
        // DEPOSIT or VOLUNTARY_CONTRIBUTION -> employee side
        employeeAmount += Number(b.amount || 0);
      }
      const note = (b.notes || '').trim();
      if (note && !seenNotes.has(note)) { seenNotes.add(note); notes.push(note); }
    }

    transformed.push({
      ...base,
      transaction_type: 'PF_CONTRIBUTION',
      amount: employeeAmount + employerAmount + epsAmount,
      employee_amount: employeeAmount,
      employer_amount: employerAmount,
      eps_amount: epsAmount,
      notes: notes.join(' | ') || null,
      is_pf_grouped: 1,
    });
  }
  return transformed;
}

module.exports = function (db) {
  // --- Get RBI USD/INR rate for a date (used by UI to auto-fill exchange_rate_used) ---
  router.get('/usd-inr-rate', async (req, res) => {
    try {
      const { date } = req.query;
      const rate = date ? await fetchHistoricalUSDToINR(date) : await fetchUSDToINR();
      res.json({ rate, date: date || new Date().toISOString().split('T')[0] });
    } catch (e) {
      logAppError('[Transaction] USD/INR rate fetch failed', { date: req.query?.date || null, error: e.message });
      res.status(500).json({ error: e.message });
    }
  });

  // --- Add transaction ---
  router.post('/', async (req, res) => {
    try {
      const {
        investment_id, transaction_type, transaction_date,
        units, price_per_unit, amount, fees, notes, broker, portfolio_id,
        exchange_rate_used, usd_amount, fmv_per_unit, gross_units, tax_withheld_units,
      } = req.body;

      if (!investment_id || !portfolio_id || !transaction_type || !transaction_date || !amount) {
        return res.status(400).json({ error: 'investment_id, portfolio_id, transaction_type, transaction_date, and amount are required' });
      }

      const inv = db.prepare('SELECT * FROM investments WHERE id = ?').get(investment_id);
      if (!inv) return res.status(404).json({ error: 'Investment not found' });

      const normalizedTransactionDate = normalizeTransactionDate(transaction_date);
      if (!normalizedTransactionDate) {
        return res.status(400).json({ error: 'transaction_date must be a valid date in YYYY-MM-DD format' });
      }

      // Auto-fetch RBI rate for USD investments if not provided
      let resolvedRate = exchange_rate_used || null;
      if (inv.currency === 'USD' && !resolvedRate) {
        try {
          resolvedRate = await fetchHistoricalUSDToINR(normalizedTransactionDate);
        } catch (_) {
          resolvedRate = null;
        }
      }

      const normalizedUnitsCheck = normalizeIndianCorporateUnits(inv.asset_type, transaction_type, units);
      if (!normalizedUnitsCheck.ok) {
        return res.status(400).json({ error: normalizedUnitsCheck.error });
      }
      const normalizedUnits = normalizedUnitsCheck.value;

      const result = db.prepare(`
        INSERT INTO transactions (investment_id, portfolio_id, transaction_type, transaction_date, units, price_per_unit, amount, fees, broker, notes, exchange_rate_used, usd_amount, fmv_per_unit, gross_units, tax_withheld_units)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(investment_id, portfolio_id, transaction_type, normalizedTransactionDate,
        normalizedUnits || null, price_per_unit || null, amount, fees || 0, broker || null, notes || null,
        resolvedRate, usd_amount || null, fmv_per_unit || null, gross_units || null, tax_withheld_units || null);

      const txn = db.prepare('SELECT * FROM transactions WHERE id = ?').get(result.lastInsertRowid);
      markDirtyFromTransactions(
        db,
        [{ investment_id, portfolio_id, transaction_date: normalizedTransactionDate }],
        'transaction-created',
        `txn:${result.lastInsertRowid}`
      );
      logAppInfo('[Transaction] Created', {
        transaction_id: Number(result.lastInsertRowid),
        investment_id: Number(investment_id),
        portfolio_id: Number(portfolio_id),
        transaction_type,
        transaction_date: normalizedTransactionDate,
        amount: Number(amount || 0),
      });
      res.status(201).json(txn);
    } catch (e) {
      logAppError('[Transaction] Create failed', { error: e.message });
      res.status(500).json({ error: e.message || 'Failed to create transaction' });
    }
  });

  // --- Get transactions for an investment ---
  router.get('/investment/:investmentId', (req, res) => {
    const txns = db.prepare(
      'SELECT * FROM transactions WHERE investment_id = ? ORDER BY transaction_date DESC, id DESC'
    ).all(req.params.investmentId);
    res.json(txns);
  });

  // --- Get distinct asset types that have transactions ---
  router.get('/asset-types', (req, res) => {
    const types = db.prepare(
      `SELECT DISTINCT i.asset_type FROM investments i
       INNER JOIN transactions t ON t.investment_id = i.id
       ORDER BY i.asset_type`
    ).all().map(r => r.asset_type);
    res.json(types);
  });

  // --- Get distinct transaction types ---
  router.get('/transaction-types', (req, res) => {
    const { asset_type, portfolio_id } = req.query;
    let sql = `SELECT DISTINCT t.transaction_type FROM transactions t
       JOIN investments i ON t.investment_id = i.id WHERE 1=1`;
    const params = [];
    if (asset_type) { sql += ' AND i.asset_type = ?'; params.push(asset_type); }
    if (portfolio_id) { sql += ' AND t.portfolio_id = ?'; params.push(portfolio_id); }
    sql += ' ORDER BY t.transaction_type';
    const types = db.prepare(sql).all(...params).map(r => r.transaction_type);
    res.json(types);
  });

  // --- Get distinct brokers ---
  router.get('/brokers', (req, res) => {
    const { asset_type, portfolio_id } = req.query;
    let sql = `SELECT DISTINCT t.broker FROM transactions t
       INNER JOIN investments i ON t.investment_id = i.id
       WHERE t.broker IS NOT NULL AND t.broker != ''`;
    const params = [];
    if (asset_type) { sql += ' AND i.asset_type = ?'; params.push(asset_type); }
    if (portfolio_id) { sql += ' AND t.portfolio_id = ?'; params.push(portfolio_id); }
    sql += ' ORDER BY t.broker';
    const brokers = db.prepare(sql).all(...params).map(r => r.broker);
    res.json(brokers);
  });

  // --- Get investment names that have transactions ---
  router.get('/investment-names', (req, res) => {
    const { portfolio_id, asset_type } = req.query;
    let sql = `SELECT DISTINCT COALESCE(i.display_name, i.name) as name FROM investments i
       INNER JOIN transactions t ON t.investment_id = i.id WHERE 1=1`;
    const params = [];
    if (portfolio_id) { sql += ' AND t.portfolio_id = ?'; params.push(portfolio_id); }
    if (asset_type) { sql += ' AND i.asset_type = ?'; params.push(asset_type); }
    sql += ' ORDER BY name';
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

    const rawItems = db.prepare(dataQuery).all(...dataParams);
    const shouldGroupPf = req.query.group_pf === '1' || req.query.group_pf === 'true';
    const items = shouldGroupPf ? groupPfTransactions(rawItems) : rawItems;
    const effectiveTotal = (shouldGroupPf && !hasLimit) ? items.length : total;
    res.json({ items, total: effectiveTotal, limit: safeLimit, offset: safeOffset });
  });

  // --- Update transaction ---
  router.put('/:id', (req, res) => {
    try {
      const existing = db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Transaction not found' });
      const inv = db.prepare('SELECT asset_type FROM investments WHERE id = ?').get(existing.investment_id);

      const {
        transaction_date, units, price_per_unit, amount, fees, notes, broker,
        folio_number, exchange_rate_used, usd_amount, fmv_per_unit,
        gross_units, tax_withheld_units,
      } = req.body;

      const nextUnits = units ?? existing.units;
      const normalizedUnitsCheck = normalizeIndianCorporateUnits(inv?.asset_type, existing.transaction_type, nextUnits);
      if (!normalizedUnitsCheck.ok) {
        return res.status(400).json({ error: normalizedUnitsCheck.error });
      }
      const normalizedUnits = normalizedUnitsCheck.value;

      const nextDate = normalizeTransactionDate(transaction_date || existing.transaction_date) || existing.transaction_date;
      db.prepare(`
        UPDATE transactions
        SET transaction_date = ?, units = ?, price_per_unit = ?, amount = ?, fees = ?, notes = ?, broker = ?, folio_number = ?,
            exchange_rate_used = ?, usd_amount = ?, fmv_per_unit = ?, gross_units = ?, tax_withheld_units = ?
        WHERE id = ?
      `).run(
        nextDate,
        normalizedUnits,
        price_per_unit ?? existing.price_per_unit,
        amount ?? existing.amount,
        fees ?? existing.fees,
        notes !== undefined ? notes : existing.notes,
        broker !== undefined ? broker : existing.broker,
        folio_number !== undefined ? folio_number : existing.folio_number,
        exchange_rate_used !== undefined ? exchange_rate_used : existing.exchange_rate_used,
        usd_amount !== undefined ? usd_amount : existing.usd_amount,
        fmv_per_unit !== undefined ? fmv_per_unit : existing.fmv_per_unit,
        gross_units !== undefined ? gross_units : existing.gross_units,
        tax_withheld_units !== undefined ? tax_withheld_units : existing.tax_withheld_units,
        req.params.id
      );

      const dirtyFrom = existing.transaction_date < nextDate ? existing.transaction_date : nextDate;
      markDirtyFromTransactions(
        db,
        [{ investment_id: existing.investment_id, portfolio_id: existing.portfolio_id, transaction_date: dirtyFrom }],
        'transaction-updated',
        `txn:${existing.id}`
      );

      const txn = db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id);
      logAppInfo('[Transaction] Updated', {
        transaction_id: Number(existing.id),
        investment_id: Number(existing.investment_id),
        portfolio_id: Number(existing.portfolio_id),
        transaction_type: txn?.transaction_type || existing.transaction_type,
        transaction_date: nextDate,
      });
      res.json(txn);
    } catch (e) {
      logAppError('[Transaction] Update failed', { transaction_id: Number(req.params.id), error: e.message });
      res.status(500).json({ error: e.message || 'Failed to update transaction' });
    }
  });

  // --- Delete transaction ---
  router.delete('/:id', (req, res) => {
    try {
      const existing = db.prepare('SELECT id, investment_id, portfolio_id, transaction_date, transaction_type, amount FROM transactions WHERE id = ?').get(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Transaction not found' });

      db.prepare('DELETE FROM transactions WHERE id = ?').run(req.params.id);

      markDirtyFromTransactions(
        db,
        [{ investment_id: existing.investment_id, portfolio_id: existing.portfolio_id, transaction_date: existing.transaction_date }],
        'transaction-deleted',
        `txn:${existing.id}`
      );

      logAppInfo('[Transaction] Deleted', {
        transaction_id: Number(existing.id),
        investment_id: Number(existing.investment_id),
        portfolio_id: Number(existing.portfolio_id),
        transaction_type: existing.transaction_type,
        transaction_date: existing.transaction_date,
        amount: Number(existing.amount || 0),
      });
      res.json({ success: true });
    } catch (e) {
      logAppError('[Transaction] Delete failed', { transaction_id: Number(req.params.id), error: e.message });
      res.status(500).json({ error: e.message || 'Failed to delete transaction' });
    }
  });

  return router;
};
