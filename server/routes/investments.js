const express = require('express');
const router = express.Router();
const { calculatePfInterestPreview, calculateSmallSavingsInterestPreview } = require('../services/pfInterestCalculator');
const { logAppInfo, logAppError } = require('../services/appLogger');
const {
  XIRR_CASH_OUTFLOW_TYPES,
  XIRR_CASH_INFLOW_TYPES,
  INVESTED_AMOUNT_INFLOW_TYPES_SQL,
} = require('../constants/transactionTypes');

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

const CASH_OUTFLOW_TYPES = new Set(XIRR_CASH_OUTFLOW_TYPES);

const CASH_INFLOW_TYPES = new Set(XIRR_CASH_INFLOW_TYPES);

const INTERNAL_BALANCE_XIRR_ASSET_TYPES = new Set(['PF', 'PPF', 'SSY']);

function isInternalXirrCashflow(assetType, transactionType) {
  const normalizedAssetType = String(assetType || '').toUpperCase();
  const normalizedType = String(transactionType || '').toUpperCase();

  if (!INTERNAL_BALANCE_XIRR_ASSET_TYPES.has(normalizedAssetType)) {
    return false;
  }

  if (normalizedType === 'INTEREST' || normalizedType === 'TDS') {
    return true;
  }

  // Reconcile rows on balance-based accounts are statement/passbook corrections.
  return normalizedType === 'RECONCILE';
}

function xnpv(rate, flows, baseDate) {
  const msPerDay = 24 * 60 * 60 * 1000;
  return flows.reduce((sum, flow) => {
    const years = (flow.date - baseDate) / msPerDay / 365;
    return sum + flow.amount / ((1 + rate) ** years);
  }, 0);
}

function calculateXirr(flows) {
  if (!Array.isArray(flows) || flows.length < 2) return null;

  let hasPositive = false;
  let hasNegative = false;
  for (const flow of flows) {
    if (flow.amount > 0) hasPositive = true;
    if (flow.amount < 0) hasNegative = true;
  }
  if (!hasPositive || !hasNegative) return null;

  const sortedFlows = [...flows].sort((a, b) => a.date - b.date);
  const baseDate = sortedFlows[0].date;

  let low = -0.9999;
  let high = 10;
  let fLow = xnpv(low, sortedFlows, baseDate);
  let fHigh = xnpv(high, sortedFlows, baseDate);

  for (let i = 0; i < 25 && fLow * fHigh > 0; i += 1) {
    high *= 2;
    fHigh = xnpv(high, sortedFlows, baseDate);
  }

  if (fLow * fHigh > 0) return null;

  for (let i = 0; i < 100; i += 1) {
    const mid = (low + high) / 2;
    const fMid = xnpv(mid, sortedFlows, baseDate);

    if (Math.abs(fMid) < 1e-7) return mid;

    if (fLow * fMid < 0) {
      high = mid;
      fHigh = fMid;
    } else {
      low = mid;
      fLow = fMid;
    }
  }

  return (low + high) / 2;
}

module.exports = function (db) {
  // ─── Get all investments ──────────────────────────────────────────────
  router.get('/', (req, res) => {
    const { type, portfolio_id, hide_sold } = req.query;
    let query = 'SELECT DISTINCT i.* FROM investments i';
    const params = [];

    query += ' WHERE 1=1';

    if (portfolio_id) {
      query += ' AND (EXISTS (SELECT 1 FROM transactions t WHERE t.investment_id = i.id AND t.portfolio_id = ?) OR NOT EXISTS (SELECT 1 FROM transactions t WHERE t.investment_id = i.id))';
      params.push(portfolio_id);
    }

    if (type) {
      query += ' AND i.asset_type = ?';
      params.push(type);
    }
    if (hide_sold === 'true') {
      const portfolioTxnFilter = portfolio_id ? ' AND t2.portfolio_id = ?' : '';
      const portfolioTxnParams = portfolio_id ? [portfolio_id] : [];
      query += ` AND (
        i.asset_type IN ('PPF', 'SSY', 'PF') OR
        NOT EXISTS (
          SELECT 1
          FROM transactions t2
          WHERE t2.investment_id = i.id${portfolioTxnFilter}
        ) OR
        COALESCE((
          SELECT SUM(CASE
            WHEN t2.transaction_type IN ('BUY','DEPOSIT','BONUS','RIGHTS','IPO','TRANSFER_IN','SWITCH_IN','SPLIT','EMPLOYER_CONTRIBUTION','VOLUNTARY_CONTRIBUTION','VEST','ESPP_PURCHASE') THEN COALESCE(t2.units, 0)
            WHEN t2.transaction_type IN ('SELL','REDEMPTION','WITHDRAWAL','TRANSFER_OUT','SWITCH_OUT','CONSOLIDATION','CHARGES','AMC') THEN -COALESCE(t2.units, 0)
            ELSE 0 END)
          FROM transactions t2 WHERE t2.investment_id = i.id${portfolioTxnFilter}
        ), 0) > 0.001
      )`;
      params.push(...portfolioTxnParams, ...portfolioTxnParams);
    }

    query += ' ORDER BY i.asset_type, COALESCE(i.display_name, i.name)';
    const investments = db.prepare(query).all(...params);

    const portfolioIdNum = portfolio_id ? parseInt(portfolio_id, 10) : null;

    const latestValueByPortfolioStmt = db.prepare('SELECT * FROM daily_values WHERE investment_id = ? AND portfolio_id = ? ORDER BY date DESC LIMIT 1');
    const txnsByPortfolioStmt = db.prepare('SELECT transaction_type, transaction_date, amount, fees FROM transactions WHERE investment_id = ? AND portfolio_id = ?');

    const enriched = investments.map((inv) => {
      // For portfolio-scoped queries or combined: aggregate from all portfolio-scoped rows
      const latestValues = portfolioIdNum
        ? latestValueByPortfolioStmt.all(inv.id, portfolioIdNum)
        : db.prepare('SELECT * FROM daily_values WHERE investment_id = ? ORDER BY date DESC LIMIT 1').all(inv.id);
      let latestValue = latestValues[0] || null;
      
      // If portfolio-specific row not found and portfolio_id was specified, try combined
      if (!latestValue && portfolioIdNum) {
        latestValue = db.prepare('SELECT * FROM daily_values WHERE investment_id = ? ORDER BY date DESC LIMIT 1').get(inv.id);
      }

      const txns = portfolioIdNum
        ? txnsByPortfolioStmt.all(inv.id, portfolioIdNum)
        : db.prepare('SELECT transaction_type, transaction_date, amount, fees FROM transactions WHERE investment_id = ?').all(inv.id);
      const xirrCashflows = [];

      for (const txn of txns) {
        const txnDate = new Date(txn.transaction_date);
        if (Number.isNaN(txnDate.getTime())) continue;

        const amount = Number(txn.amount) || 0;
        const fees = Number(txn.fees) || 0;
        let cashflow = 0;
        const treatAsInternal = isInternalXirrCashflow(inv.asset_type, txn.transaction_type);

        if (CASH_OUTFLOW_TYPES.has(txn.transaction_type)) {
          cashflow = -(amount + fees);
        } else if (CASH_INFLOW_TYPES.has(txn.transaction_type) && !treatAsInternal) {
          cashflow = amount - fees;
        }

        if (Math.abs(cashflow) > 1e-9) {
          xirrCashflows.push({ amount: cashflow, date: txnDate });
        }
      }

      const terminalValue = Number(latestValue?.current_value) || 0;
      if (terminalValue > 0 && latestValue?.date) {
        const valuationDate = new Date(latestValue.date);
        if (!Number.isNaN(valuationDate.getTime())) {
          xirrCashflows.push({ amount: terminalValue, date: valuationDate });
        }
      }

      const xirrRate = calculateXirr(xirrCashflows);

      return {
        ...inv,
        absolute_return_pct: latestValue?.profit_loss_pct ?? null,
        xirr_pct: xirrRate == null ? null : xirrRate * 100,
      };
    });

    res.json(enriched);
  });

  // ─── Get single investment with details ───────────────────────────────
  router.get('/:id', (req, res) => {
    const inv = db.prepare(`
      SELECT i.*
      FROM investments i
      WHERE i.id = ?
    `).get(req.params.id);
    if (!inv) return res.status(404).json({ error: 'Investment not found' });

    // Get latest daily value (portfolio-scoped or combined)
    const portfolioId = req.query.portfolio_id;
    const portfolioFilter = portfolioId ? ' AND portfolio_id = ?' : '';
    const portfolioParams = portfolioId ? [parseInt(portfolioId, 10)] : [];
    let latestValue;
    if (portfolioId) {
      latestValue = db.prepare(
        'SELECT * FROM daily_values WHERE investment_id = ? AND portfolio_id = ? ORDER BY date DESC LIMIT 1'
      ).get(inv.id, parseInt(portfolioId, 10));
    } else {
      latestValue = db.prepare(
          'SELECT * FROM daily_values WHERE investment_id = ? ORDER BY date DESC LIMIT 1'
      ).get(inv.id);
    }
    const totals = db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN transaction_type IN ('BUY', 'DEPOSIT', 'BONUS', 'SPLIT', 'IPO', 'TRANSFER_IN', 'SWITCH_IN', 'RIGHTS', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'VEST', 'ESPP_PURCHASE') THEN COALESCE(units, 0) WHEN transaction_type IN ('SELL', 'REDEMPTION', 'WITHDRAWAL', 'TRANSFER_OUT', 'SWITCH_OUT', 'CONSOLIDATION', 'CHARGES', 'AMC') THEN -COALESCE(units, 0) ELSE 0 END), 0) as total_units,
        COALESCE(SUM(CASE WHEN transaction_type IN (${INVESTED_AMOUNT_INFLOW_TYPES_SQL}) THEN amount + COALESCE(fees, 0) ELSE 0 END), 0) as total_invested,
        COALESCE(SUM(CASE WHEN transaction_type IN ('SELL', 'REDEMPTION', 'WITHDRAWAL', 'TRANSFER_OUT', 'SWITCH_OUT') THEN amount - COALESCE(fees, 0) ELSE 0 END), 0) as sale_proceeds
      FROM transactions WHERE investment_id = ?${portfolioFilter}
    `).get(inv.id, ...portfolioParams);

    // Get transactions
    const transactions = db.prepare(
      `SELECT * FROM transactions WHERE investment_id = ?${portfolioFilter} ORDER BY transaction_date DESC`
    ).all(inv.id, ...portfolioParams);

    // Get folio summary and options (for MF)
    let folio_summary = null;
    let folio_options = [];
    
    if (inv.asset_type === 'MUTUAL_FUND') {
      // Get all unique folios for this investment with their net units
      const folios = db.prepare(`
        SELECT 
          folio_number,
          COALESCE(SUM(CASE 
            WHEN transaction_type IN ('BUY', 'DEPOSIT', 'BONUS', 'SPLIT', 'IPO', 'TRANSFER_IN', 'SWITCH_IN', 'RIGHTS', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'VEST', 'ESPP_PURCHASE') THEN COALESCE(units, 0)
            WHEN transaction_type IN ('SELL', 'REDEMPTION', 'WITHDRAWAL', 'TRANSFER_OUT', 'SWITCH_OUT', 'CONSOLIDATION', 'CHARGES', 'AMC') THEN -COALESCE(units, 0)
            ELSE 0 END), 0) as net_units
        FROM transactions 
        WHERE investment_id = ?${portfolioFilter}
        AND folio_number IS NOT NULL
        GROUP BY folio_number
        ORDER BY folio_number
      `).all(inv.id, ...portfolioParams);

      folio_options = folios.map(f => ({
        folio_number: f.folio_number,
        net_units: f.net_units,
        is_open: f.net_units > 0.0001
      }));

      const totalFolios = folio_options.length;
      const openFolios = folio_options.filter(f => f.is_open).length;
      const closedFolios = totalFolios - openFolios;

      folio_summary = {
        total: totalFolios,
        open: openFolios,
        closed: closedFolios
      };
    }

    res.json({
      ...inv,
      latestValue,
      totalUnits: totals.total_units,
      totalInvested: totals.total_invested,
      saleProceeds: totals.sale_proceeds,
      transactions,
      folio_summary,
      folio_options,
    });
  });

  // ─── Create investment ────────────────────────────────────────────────
  router.post('/', (req, res) => {
    try {
      const {
        name, asset_type, ticker_symbol, amfi_code,
        account_number, currency, notes,
        face_value, coupon_frequency, maturity_date,
      } = req.body;

      if (!name || !asset_type) {
        return res.status(400).json({ error: 'name and asset_type are required' });
      }

      const result = db.prepare(`
        INSERT INTO investments (name, asset_type, ticker_symbol, amfi_code, account_number, currency, face_value, coupon_frequency, maturity_date, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(name, asset_type, ticker_symbol || null, amfi_code || null,
        account_number || null,
        currency || 'INR', face_value || null,
        coupon_frequency || null, maturity_date || null,
        notes || null);

      const inv = db.prepare('SELECT * FROM investments WHERE id = ?').get(result.lastInsertRowid);
      logAppInfo('[Investment] Created', {
        investment_id: Number(inv?.id || result.lastInsertRowid),
        name: inv?.name || name,
        asset_type: inv?.asset_type || asset_type,
        ticker_symbol: inv?.ticker_symbol || null,
      });
      res.status(201).json(inv);
    } catch (e) {
      logAppError('[Investment] Create failed', { error: e.message });
      res.status(500).json({ error: e.message || 'Failed to create investment' });
    }
  });

  // ─── Update investment ────────────────────────────────────────────────
  router.put('/:id', (req, res) => {
    try {
      const {
        name, ticker_symbol, amfi_code,
        account_number, currency, notes, portfolio_id,
        face_value, coupon_frequency, maturity_date,
        display_name, isin_code,
      } = req.body;

      const existing = db.prepare('SELECT * FROM investments WHERE id = ?').get(req.params.id);
      if (!existing) {
        return res.status(404).json({ error: 'Investment not found' });
      }

      // Build dynamic SET clauses — COALESCE for legacy fields, direct set for new fields
      const sets = [];
      const params = [];

      // Legacy fields: only update if provided (COALESCE pattern)
      const coalesceFields = { name, ticker_symbol, amfi_code, account_number, currency, face_value, coupon_frequency, maturity_date, notes };
      for (const [col, val] of Object.entries(coalesceFields)) {
        sets.push(`${col} = COALESCE(?, ${col})`);
        params.push(val !== undefined ? val : null);
      }

      // New fields: only update if explicitly present in body
      if (display_name !== undefined) { sets.push('display_name = ?'); params.push(display_name || null); }
      if (isin_code !== undefined) { sets.push('isin_code = ?'); params.push(isin_code || null); }
      if (req.body.is_active !== undefined) { sets.push('is_active = ?'); params.push(req.body.is_active ? 1 : 0); }
      if (req.body.exclude_from_tracking !== undefined) { sets.push('exclude_from_tracking = ?'); params.push(req.body.exclude_from_tracking ? 1 : 0); }

      sets.push("updated_at = datetime('now')");
      params.push(req.params.id);

      db.prepare(`UPDATE investments SET ${sets.join(', ')} WHERE id = ?`).run(...params);

      const inv = db.prepare('SELECT * FROM investments WHERE id = ?').get(req.params.id);
      logAppInfo('[Investment] Updated', {
        investment_id: Number(req.params.id),
        name: inv?.name || existing.name,
        asset_type: inv?.asset_type || existing.asset_type,
        portfolio_id: portfolio_id ?? null,
      });
      res.json(inv);
    } catch (e) {
      logAppError('[Investment] Update failed', { investment_id: Number(req.params.id), error: e.message });
      res.status(500).json({ error: e.message || 'Failed to update investment' });
    }
  });

  // ─── Delete investment ────────────────────────────────────────────────
  router.delete('/:id', (req, res) => {
    try {
      const existing = db.prepare('SELECT id, name, asset_type FROM investments WHERE id = ?').get(req.params.id);
      if (!existing) {
        return res.status(404).json({ error: 'Investment not found' });
      }
      db.prepare('DELETE FROM investments WHERE id = ?').run(req.params.id);
      logAppInfo('[Investment] Deleted', {
        investment_id: Number(existing.id),
        name: existing.name,
        asset_type: existing.asset_type,
      });
      res.json({ success: true });
    } catch (e) {
      logAppError('[Investment] Delete failed', { investment_id: Number(req.params.id), error: e.message });
      res.status(500).json({ error: e.message || 'Failed to delete investment' });
    }
  });

  function parseBool(v, defaultVal = false) {
    if (v == null) return defaultVal;
    const s = String(v).toLowerCase();
    return s === '1' || s === 'true' || s === 'yes';
  }

  function fyEndDateFromLabel(fyLabel) {
    const m = String(fyLabel || '').match(/^FY(\d{4})-(\d{2})$/);
    if (!m) return null;
    const startYear = parseInt(m[1], 10);
    const endYear = startYear + 1;
    return `${endYear}-03-31`;
  }

  function normalizeDateOnly(input) {
    if (input == null) return null;
    const s = String(input).trim();
    if (!s) return null;
    const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
    if (!m) return null;
    return m[1];
  }

  function getRateRowsForType(assetType) {
    const dbRates = db.prepare(
      'SELECT rate, effective_from, effective_to FROM interest_rates WHERE rate_type = ? ORDER BY effective_from ASC'
    ).all(assetType);
    if (!dbRates.length) {
      throw new Error(`No interest rates found in database for ${assetType}. Please add rates in interest_rates table.`);
    }
    return dbRates;
  }

  function getInterestInvestment(invId) {
    const invCols = new Set(db.prepare("PRAGMA table_info(investments)").all().map(c => c.name));
    const openingBalanceExpr = invCols.has('opening_balance')
      ? 'opening_balance'
      : '0 AS opening_balance';
    return db.prepare(`SELECT id, name, asset_type, ${openingBalanceExpr} FROM investments WHERE id = ?`).get(invId);
  }

  function getInterestPreview(inv, queryParams) {
    const requestedPortfolioId = queryParams.portfolio_id != null
      ? parseInt(queryParams.portfolio_id, 10)
      : null;

    const portfolioFilter = Number.isFinite(requestedPortfolioId) ? ' AND portfolio_id = ?' : '';
    const portfolioArgs = Number.isFinite(requestedPortfolioId) ? [requestedPortfolioId] : [];

    const minDateRow = db.prepare(`
      SELECT MIN(date(transaction_date)) AS d
      FROM transactions
      WHERE investment_id = ?${portfolioFilter}
    `).get(inv.id, ...portfolioArgs);
    const maxDateRow = db.prepare(`
      SELECT MAX(date(transaction_date)) AS d
      FROM transactions
      WHERE investment_id = ?${portfolioFilter}
    `).get(inv.id, ...portfolioArgs);

    if (!minDateRow?.d || !maxDateRow?.d) {
      throw new Error('No transactions found for this investment.');
    }

    const fromDate = normalizeDateOnly(queryParams.from_date) || normalizeDateOnly(minDateRow.d);
    const toDate = normalizeDateOnly(queryParams.to_date) || normalizeDateOnly(maxDateRow.d);
    if (!fromDate || !toDate || !/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
      throw new Error('from_date and to_date must be YYYY-MM-DD');
    }

    const defaultMonthlyRoundingDecimals = (inv.asset_type === 'SSY' || inv.asset_type === 'PPF') ? 0 : 2;
    const monthlyRoundingDecimals = queryParams.monthly_rounding_decimals != null
      ? parseInt(queryParams.monthly_rounding_decimals, 10)
      : defaultMonthlyRoundingDecimals;
    const ignoreExistingInterest = queryParams.ignore_existing_interest !== 'false';
    const includeTransferTransactions = parseBool(queryParams.include_transfer_transactions, false);

    const txns = db.prepare(`
      SELECT id, date(transaction_date) AS transaction_date, transaction_type, amount, portfolio_id
      FROM transactions
      WHERE investment_id = ?${portfolioFilter}
      ORDER BY transaction_date, id
    `).all(inv.id, ...portfolioArgs);

    const existingInterestRows = db.prepare(`
      SELECT id, transaction_date, transaction_type, amount, notes, portfolio_id
      FROM transactions
      WHERE investment_id = ?
        AND transaction_type IN ('INTEREST', 'RECONCILE')
        AND date(transaction_date) >= ?
        AND date(transaction_date) <= ?${portfolioFilter}
      ORDER BY transaction_date ASC, id ASC
    `).all(inv.id, fromDate, toDate, ...portfolioArgs);

    const existingByDate = new Map();
    const aggregateReconcileWithInterest = inv.asset_type === 'SSY' || inv.asset_type === 'PPF';
    for (const r of existingInterestRows) {
      // Always fetch INTEREST rows; fetch RECONCILE only if we need to aggregate with INTEREST internally
      if (r.transaction_type !== 'INTEREST' && !aggregateReconcileWithInterest) {
        continue;
      }
      // Normalize transaction_date to YYYY-MM-DD format (handle both with and without time component)
      const normalizedDate = r.transaction_date.split(' ')[0];
      if (!existingByDate.has(normalizedDate)) {
        existingByDate.set(normalizedDate, {
          rows: [],
          interest_rows: [],        // Track INTEREST rows separately for display filtering
          reconcile_rows: [],       // Track RECONCILE rows separately
          total_amount: 0,          // For carry-forward: INTEREST + RECONCILE
          interest_only_amount: 0,  // For display comparison: INTEREST-only
          primary_interest_id: null,
          portfolio_id: r.portfolio_id,
        });
      }
      const agg = existingByDate.get(normalizedDate);
      agg.rows.push(r);
      
      if (r.transaction_type === 'INTEREST') {
        agg.interest_rows.push(r);
        agg.interest_only_amount = Number(agg.interest_only_amount || 0) + Number(r.amount || 0);
        if (agg.primary_interest_id == null) {
          agg.primary_interest_id = r.id;
        }
      } else if (r.transaction_type === 'RECONCILE') {
        agg.reconcile_rows.push(r);
      }
      
      // total_amount = INTEREST + RECONCILE (for carry-forward accuracy)
      agg.total_amount = Number(agg.total_amount || 0) + Number(r.amount || 0);
    }

    const yearEndCreditOverrides = {};
    if (inv.asset_type === 'SSY' && ignoreExistingInterest) {
      for (const [dateKey, agg] of existingByDate.entries()) {
        if (/^\d{4}-03-31$/.test(dateKey)) {
          yearEndCreditOverrides[dateKey] = Math.round(Number(agg.total_amount || 0));
        }
      }
    }

    const rateRows = getRateRowsForType(inv.asset_type);

    const calculator = inv.asset_type === 'PF'
      ? calculatePfInterestPreview
      : calculateSmallSavingsInterestPreview;

    const preview = calculator({
      openingBalance: inv.opening_balance || 0,
      transactions: txns,
      rateRows,
      fromDate,
      toDate,
      monthlyRoundingDecimals,
      ignoreExistingInterest,
      includeTransferTransactions,
      interestBaseMethod: inv.asset_type === 'SSY' ? 'month_end_balance' : 'min_balance_between_5th_and_month_end',
      annualRounding: inv.asset_type === 'SSY' || inv.asset_type === 'PPF',
      yearEndCreditOverrides,
    });

    const proposedEntries = preview.annualRows
      .map((row) => {
        const creditDate = fyEndDateFromLabel(row.fy);
        if (!creditDate || creditDate < fromDate || creditDate > toDate) return null;

        const existing = existingByDate.get(creditDate) || null;
        const amount = (inv.asset_type === 'SSY' || inv.asset_type === 'PPF')
          ? Math.round(Number(row.interest || 0))
          : Math.round(Number(row.interest || 0) * 100) / 100;
        if (amount <= 0) return null;

        // CRITICAL: Compare against INTEREST-only amount, not aggregate (INTEREST + RECONCILE).
        // This ensures Interest Update Preview only shows mismatched INTEREST entries.
        // RECONCILE rows are used internally for carry-forward but never shown in the preview.
        const hasInterestEntry = existing && existing.interest_rows.length > 0;
        
        // If only RECONCILE exists (no INTEREST), don't show in preview
        if (existing && !hasInterestEntry) {
          return null;
        }

        // Compare calculated amount against INTEREST-only amount (not aggregate with RECONCILE)
        const comparisonAmount = existing ? Number(existing.interest_only_amount || 0) : 0;
        const drift = existing ? Math.abs(comparisonAmount - amount) : null;
        const sameAmount = existing && drift <= 1;
        const previewNote = existing && drift > 0 && drift <= 1
          ? 'Ignore the ₹1 drift from DB calculations.'
          : null;
        const action = existing ? (sameAmount ? 'unchanged' : 'update') : 'insert';

        return {
          fy: row.fy,
          date: creditDate,
          amount,
          existing_id: existing?.primary_interest_id || null,
          existing_date: existing?.interest_rows?.[0]?.transaction_date
            ? normalizeTransactionDate(existing.interest_rows[0].transaction_date)
            : null,
          existing_amount: existing ? Number(existing.interest_only_amount) : null,
          existing_notes: existing?.rows?.map((x) => x.notes).filter(Boolean).join(' | ') || null,
          existing_row_count: existing?.rows?.length || 0,
          interest_row_count: existing?.interest_rows?.length || 0,
          reconcile_row_count: existing?.reconcile_rows?.length || 0,
          preview_note: previewNote,
          has_existing_entries: !!existing,
          portfolio_id: existing?.portfolio_id || requestedPortfolioId || null,
          action,
        };
      })
      .filter(Boolean);

    const distinctPortfolios = db.prepare(
      'SELECT DISTINCT portfolio_id FROM transactions WHERE investment_id = ? ORDER BY portfolio_id'
    ).all(inv.id).map(r => r.portfolio_id).filter(v => v != null);

    return {
      investment: { id: inv.id, name: inv.name, asset_type: inv.asset_type },
      window: { from_date: fromDate, to_date: toDate },
      options: {
        monthly_rounding_decimals: monthlyRoundingDecimals,
        ignore_existing_interest: ignoreExistingInterest,
        include_transfer_transactions: includeTransferTransactions,
        portfolio_id: Number.isFinite(requestedPortfolioId) ? requestedPortfolioId : null,
      },
      preview,
      proposed_entries: proposedEntries,
      portfolio_context: {
        requested_portfolio_id: Number.isFinite(requestedPortfolioId) ? requestedPortfolioId : null,
        inferred_portfolio_ids: distinctPortfolios,
      },
    };
  }

  // ─── Interest Preview (PF/PPF/SSY) ───────────────────────────────────
  router.get('/:id/interest/preview', (req, res) => {
    try {
      const invId = parseInt(req.params.id, 10);
      if (!Number.isFinite(invId)) {
        return res.status(400).json({ error: 'Invalid investment id' });
      }

      const inv = getInterestInvestment(invId);
      if (!inv) return res.status(404).json({ error: 'Investment not found' });
      if (!['PF', 'PPF', 'SSY'].includes(inv.asset_type)) {
        return res.status(400).json({ error: 'Interest preview is supported only for PF, PPF, and SSY investments.' });
      }

      const result = getInterestPreview(inv, req.query || {});
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: 'Failed interest preview: ' + e.message });
    }
  });

  // Legacy alias: keep existing PF endpoint for compatibility
  router.get('/:id/pf-interest/epfo-preview', (req, res) => {
    try {
      const invId = parseInt(req.params.id, 10);
      if (!Number.isFinite(invId)) {
        return res.status(400).json({ error: 'Invalid investment id' });
      }

      const inv = getInterestInvestment(invId);
      if (!inv) return res.status(404).json({ error: 'Investment not found' });
      if (inv.asset_type !== 'PF') {
        return res.status(400).json({ error: 'EPFO preview is supported only for PF investments.' });
      }

      const result = getInterestPreview(inv, req.query || {});

      const fromDate = result.window.from_date;
      const toDate = result.window.to_date;
      const contributionTotal = db.prepare(
        "SELECT ROUND(COALESCE(SUM(amount),0),2) AS amt FROM transactions " +
        "WHERE investment_id = ? AND transaction_date >= ? AND transaction_date <= ? " +
        "AND transaction_type IN ('DEPOSIT','EMPLOYER_CONTRIBUTION','VOLUNTARY_CONTRIBUTION')"
      ).get(invId, fromDate, toDate).amt;

      const checkpointTransferIn = db.prepare(
        "SELECT ROUND(COALESCE(SUM(amount),0),2) AS amt FROM transactions " +
        "WHERE investment_id = ? AND transaction_type = 'TRANSFER_IN' AND date(transaction_date) = ?"
      ).get(invId, toDate).amt;

      const opening = Number(inv.opening_balance || 0);
      const checkpointImpliedBalance = Math.round((opening + contributionTotal + checkpointTransferIn) * 100) / 100;
      const checkpointGap = Math.round((checkpointImpliedBalance - result.preview.closingBalance) * 100) / 100;

      res.json({
        investment: result.investment,
        window: result.window,
        preview: result.preview,
        checkpoint: {
          transfer_in_on_to_date: checkpointTransferIn,
          implied_balance_using_transfer_checkpoint: checkpointImpliedBalance,
          gap_implied_minus_modeled: checkpointGap,
        },
        proposed_entries: result.proposed_entries,
      });
    } catch (e) {
      res.status(500).json({ error: 'Failed EPFO PF interest preview: ' + e.message });
    }
  });

  // ─── Interest Apply (PF/PPF/SSY) ─────────────────────────────────────
  router.post('/:id/interest/apply', express.json(), (req, res) => {
    try {
      const invId = parseInt(req.params.id, 10);
      if (!Number.isFinite(invId)) {
        return res.status(400).json({ error: 'Invalid investment id' });
      }

      const inv = getInterestInvestment(invId);
      if (!inv) return res.status(404).json({ error: 'Investment not found' });
      if (!['PF', 'PPF', 'SSY'].includes(inv.asset_type)) {
        return res.status(400).json({ error: 'Interest apply is supported only for PF, PPF, and SSY investments.' });
      }

      const queryLikeParams = {
        ...req.body,
        portfolio_id: req.body?.portfolio_id ?? null,
      };
      const previewResult = getInterestPreview(inv, queryLikeParams);

      const replaceExisting = parseBool(req.body?.replace_existing, false);
      const dryRun = parseBool(req.body?.dry_run, false);

      const selectedEntries = Array.isArray(req.body?.selected_entries)
        ? req.body.selected_entries
        : null;
      const buildEntryKey = (e) => `${String(e.fy || '')}|${String(e.date || '')}|${(Math.round(Number(e.amount || 0) * 100) / 100).toFixed(2)}`;
      const selectedEntryKeys = selectedEntries
        ? new Set(selectedEntries.map(buildEntryKey))
        : null;

      const explicitPortfolioId = req.body?.portfolio_id != null
        ? parseInt(req.body.portfolio_id, 10)
        : null;
      const inferredPortfolioIds = previewResult.portfolio_context.inferred_portfolio_ids || [];

      let targetPortfolioId = Number.isFinite(explicitPortfolioId) ? explicitPortfolioId : null;
      if (targetPortfolioId == null) {
        if (inferredPortfolioIds.length === 1) {
          targetPortfolioId = inferredPortfolioIds[0];
        } else {
          return res.status(400).json({
            error: 'portfolio_id is required when the investment has transactions in multiple portfolios.',
            inferred_portfolio_ids: inferredPortfolioIds,
          });
        }
      }

      const insertStmt = db.prepare(
        "INSERT INTO transactions (investment_id, portfolio_id, transaction_type, transaction_date, amount, fees, notes) " +
        "VALUES (?, ?, 'INTEREST', ?, ?, 0, ?)"
      );
      const updateStmt = db.prepare(
        "UPDATE transactions SET amount = ?, notes = ? WHERE id = ?"
      );
      // CRITICAL: Only delete INTEREST rows, not RECONCILE.
      // RECONCILE rows are permanent anchors for carry-forward calculations and must be preserved.
      const replaceDayEntriesStmt = db.prepare(
        "DELETE FROM transactions WHERE investment_id = ? AND portfolio_id = ? AND date(transaction_date) = ? AND transaction_type = 'INTEREST'"
      );

      let inserted = 0;
      let updated = 0;
      let skipped = 0;
      const appliedEntries = [];

      const runApply = db.transaction(() => {
        for (const entry of previewResult.proposed_entries) {
          const note = `Auto interest update (${inv.asset_type} model) ${entry.fy}`;

          if (selectedEntryKeys && !selectedEntryKeys.has(buildEntryKey(entry))) {
            skipped += 1;
            appliedEntries.push({ ...entry, result: 'skipped_not_selected' });
            continue;
          }

          if (entry.action === 'unchanged') {
            skipped += 1;
            appliedEntries.push({ ...entry, result: 'skipped_unchanged' });
            continue;
          }

          if (entry.has_existing_entries) {
            if (!replaceExisting) {
              skipped += 1;
              appliedEntries.push({ ...entry, result: 'skipped_existing' });
              continue;
            }
            if (!dryRun) {
              // For SSY: if multiple INTEREST rows or RECONCILE exists alongside INTEREST,
              // delete all INTEREST rows (only) and insert fresh INTEREST.
              // RECONCILE rows are preserved as permanent anchors.
              const shouldReplaceAllDateRows = inv.asset_type === 'SSY' 
                && (entry.interest_row_count > 1 || entry.reconcile_row_count > 0 || !entry.existing_id);
              if (shouldReplaceAllDateRows) {
                replaceDayEntriesStmt.run(inv.id, targetPortfolioId, normalizeTransactionDate(entry.date));
                insertStmt.run(inv.id, targetPortfolioId, normalizeTransactionDate(entry.date), entry.amount, note);
              } else {
                updateStmt.run(entry.amount, note, entry.existing_id);
              }
            }
            updated += 1;
            appliedEntries.push({ ...entry, result: dryRun ? 'would_update' : 'updated' });
            continue;
          }

          if (!dryRun) insertStmt.run(inv.id, targetPortfolioId, normalizeTransactionDate(entry.date), entry.amount, note);
          inserted += 1;
          appliedEntries.push({ ...entry, result: dryRun ? 'would_insert' : 'inserted' });
        }
      });

      if (selectedEntryKeys && selectedEntryKeys.size === 0) {
        return res.status(400).json({ error: 'No preview entries selected to apply.' });
      }

      runApply();

      logAppInfo('[Interest] Applied', {
        investment_id: Number(inv.id),
        asset_type: inv.asset_type,
        target_portfolio_id: targetPortfolioId,
        dry_run: dryRun,
        replace_existing: replaceExisting,
        inserted,
        updated,
        skipped,
      });

      res.json({
        success: true,
        dry_run: dryRun,
        replace_existing: replaceExisting,
        investment: previewResult.investment,
        target_portfolio_id: targetPortfolioId,
        summary: { inserted, updated, skipped },
        applied_entries: appliedEntries,
      });
    } catch (e) {
      logAppError('[Interest] Apply failed', { investment_id: Number(req.params.id), error: e.message });
      res.status(500).json({ error: 'Failed interest apply: ' + e.message });
    }
  });

  // ─── Interest Rate Sync: Preview ──────────────────────────────────────
  /**
   * GET /api/investments/interest-rate-sync/preview?asset_type=PPF
   * DB-only mode: reference-dataset sync is intentionally disabled.
   */
  router.get('/interest-rate-sync/preview', (req, res) => {
    try {
      const { asset_type } = req.query;
      if (!asset_type || !['PPF', 'SSY', 'PF'].includes(asset_type)) {
        return res.status(400).json({ error: 'asset_type must be PPF, SSY, or PF' });
      }
      return res.status(400).json({
        error: 'Interest rate reference sync is disabled. This application now uses database-managed rates only.',
      });
    } catch (e) {
      res.status(500).json({ error: 'Failed to preview interest rate sync: ' + e.message });
    }
  });

  // ─── Interest Rate Sync: Import ───────────────────────────────────────
  /**
   * POST /api/investments/interest-rate-sync/import
   * Apply interest rate changes: add, correct, delete rates + update investment interest_rate.
   */
  router.post('/interest-rate-sync/import', (req, res) => {
    try {
      const { additions, corrections, deletions } = req.body;

      let created = 0, corrected = 0, deleted = 0;

      const runAll = db.transaction(() => {
        if (additions && additions.length) {
          const insert = db.prepare(
            'INSERT INTO interest_rates (rate_type, rate, effective_from, effective_to) VALUES (?, ?, ?, ?)'
          );
          for (const a of additions) {
            insert.run(a.rate_type, a.rate, a.effective_from, a.effective_to || null);
            created++;
          }
        }

        if (corrections && corrections.length) {
          const update = db.prepare(
            'UPDATE interest_rates SET rate = ?, effective_to = ? WHERE id = ?'
          );
          for (const c of corrections) {
            update.run(c.expected_rate, c.expected_effective_to || null, c.id);
            corrected++;
          }
        }

        if (deletions && deletions.length) {
          const remove = db.prepare('DELETE FROM interest_rates WHERE id = ?');
          for (const d of deletions) {
            remove.run(d.id);
            deleted++;
          }
        }
      });

      runAll();
      logAppInfo('[InterestRateSync] Imported changes', {
        created,
        corrected,
        deleted,
      });
      res.json({ created, corrected, deleted });
    } catch (e) {
      logAppError('[InterestRateSync] Import failed', { error: e.message });
      res.status(500).json({ error: 'Failed to import interest rate changes: ' + e.message });
    }
  });

  return router;
};
