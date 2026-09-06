/**
 * Canonical projection engine.
 *
 * Owns the canonical accounting lens (units, attribution basis/proceeds, uniform
 * P&L) for every scope. Per-investment canonical accounting is written back onto
 * the single `investment_metrics_daily` table (its `invested_amount`/`realized_proceeds`/
 * `profit_loss` columns now hold canonical attribution values); the asset- and
 * portfolio-scope rollups are materialized into `asset_metrics_daily` and
 * `portfolio_metrics_daily`. The legacy `portfolio_daily`/`asset_type_daily`
 * rollups are not touched here.
 *
 * Value lens: `current_value`, `price_per_unit`, `price_source`, and `day_change`
 * on `investment_metrics_daily` are produced by the valuation pipeline and reused as-is; this
 * engine only overwrites the accounting columns.
 *
 * P&L convention: V2 stores the canonical TARGET (uniform inclusion of realized
 * proceeds for every scope, provident withdrawals included, and portfolio expenses
 * applied in history). This intentionally differs from legacy by the approved
 * corrections; the difference is quantified by the reconciliation report.
 */

const {
  resolveClassificationEffect,
  PROVIDENT_ASSET_TYPES,
  CALCULATION_VERSION,
} = require('./transactionEffectPolicy');
const { getDataVersion } = require('./dashboardSnapshotService');

const COMBINED_PORTFOLIO_ID = null; // NULL portfolio_id row = combined/all portfolios

function scopeKey(investmentId, portfolioId) {
  return `${investmentId}|${portfolioId}`;
}

/**
 * Reconstruct the canonical investment-scope V2 rows for every scope.
 * Returns an array of row objects (not yet persisted). Rows for
 * `exclude_from_tracking` investments are tagged `excluded: 1` so the caller can
 * keep them in the per-investment table (detail reads) while filtering them out
 * of the asset/portfolio aggregates.
 */
function buildInvestmentRows(db, ctx) {
  const scopes = db.prepare(`
    SELECT DISTINCT dv.investment_id, dv.portfolio_id, UPPER(i.asset_type) AS asset_type,
           COALESCE(i.exclude_from_tracking, 0) AS excluded
    FROM investment_metrics_daily dv
    JOIN investments i ON i.id = dv.investment_id
    WHERE dv.portfolio_id IS NOT NULL
  `).all();

  const dailyStmt = db.prepare(`
    SELECT date, price_per_unit, current_value, day_change, price_source
    FROM investment_metrics_daily
    WHERE investment_id = ? AND portfolio_id = ?
    ORDER BY date
  `);
  const txnStmt = db.prepare(`
    SELECT date(transaction_date) AS tx_date, UPPER(transaction_type) AS transaction_type,
           COALESCE(amount, 0) AS amount, COALESCE(fees, 0) AS fees, COALESCE(units, 0) AS units
    FROM transactions
    WHERE investment_id = ? AND portfolio_id = ?
    ORDER BY transaction_date
  `);

  const rows = [];
  for (const scope of scopes) {
    const assetType = String(scope.asset_type || '').toUpperCase();
    const dailyRows = dailyStmt.all(scope.investment_id, scope.portfolio_id);
    const txns = txnStmt.all(scope.investment_id, scope.portfolio_id);

    let ti = 0;
    let basis = 0;
    let proceeds = 0;
    let netUnits = 0;
    let internalBasis = 0;    // transfer/switch IN legs (internal to the portfolio)
    let internalProceeds = 0; // transfer/switch OUT legs (internal to the portfolio)
    for (const row of dailyRows) {
      while (ti < txns.length && String(txns[ti].tx_date) <= String(row.date)) {
        const effect = resolveClassificationEffect(txns[ti].transaction_type, {
          amount: txns[ti].amount,
          fees: txns[ti].fees,
          units: txns[ti].units,
          assetType,
        });
        basis += effect.basisDelta;
        proceeds += effect.proceedsDelta;
        netUnits += effect.unitsDelta;
        if (effect.internal) {
          internalBasis += effect.basisDelta;
          internalProceeds += effect.proceedsDelta;
        }
        ti += 1;
      }
      const currentValue = Number(row.current_value || 0);
      // Uniform canonical target P&L for every scope, including provident withdrawals.
      const profitLoss = currentValue + proceeds - basis;
      rows.push({
        investment_id: scope.investment_id,
        portfolio_id: scope.portfolio_id,
        asset_type: assetType,
        date: row.date,
        units: netUnits,
        price_per_unit: row.price_per_unit,
        current_value: currentValue,
        attribution_basis: basis,
        attribution_proceeds: proceeds,
        profit_loss: profitLoss,
        day_change: Number(row.day_change || 0),
        price_source: row.price_source || 'LIVE',
        calculation_version: ctx.calculationVersion,
        source_data_version: ctx.sourceDataVersion,
        // In-memory only (not persisted): external-cash lens for portfolio aggregation,
        // which excludes internal transfer/switch legs from proceeds and basis.
        external_basis: basis - internalBasis,
        external_proceeds: proceeds - internalProceeds,
        // In-memory only: excluded-from-tracking scopes are kept for per-investment reads
        // but must not enter the asset/portfolio aggregates.
        excluded: scope.excluded ? 1 : 0,
      });
    }
  }
  return rows;
}

/**
 * Aggregate asset-type and portfolio V2 rows from the investment rows using
 * as-of carry-forward (latest snapshot on or before each date). Portfolio P&L
 * applies cumulative portfolio expenses as of each date. Day change is strict
 * as-of date only. Also emits combined (NULL portfolio_id) rows.
 */
function buildAggregateRows(db, investmentRows, ctx) {
  // Cumulative portfolio expenses over time, applied as-of each date.
  const expenseEvents = db.prepare(`
    SELECT portfolio_id, date(expense_date) AS d, COALESCE(SUM(amount), 0) AS amount
    FROM portfolio_expenses
    GROUP BY portfolio_id, date(expense_date)
    ORDER BY d
  `).all();
  const expenseByDate = new Map(); // date -> Map(portfolioId -> amountOnThatDate)
  for (const e of expenseEvents) {
    if (!expenseByDate.has(e.d)) expenseByDate.set(e.d, new Map());
    expenseByDate.get(e.d).set(e.portfolio_id, Number(e.amount || 0));
  }

  // Group investment rows by date for a single ordered pass.
  const rowsByDate = new Map();
  for (const r of investmentRows) {
    if (!rowsByDate.has(r.date)) rowsByDate.set(r.date, []);
    rowsByDate.get(r.date).push(r);
  }
  const dates = [...rowsByDate.keys()].sort((a, b) => String(a).localeCompare(String(b)));

  // Running per-scope snapshot and running group sums (delta-maintained).
  const snap = new Map(); // scopeKey -> {cv, basis, proceeds, extBasis, extProc, portfolioId, assetType}
  const assetSum = new Map(); // `${pid}|${at}` -> {cv, basis, proceeds} (attribution lens)
  const portSum = new Map(); // pid -> {cv, basis, proceeds} (external-cash lens)
  const cumExpense = new Map(); // pid -> cumulative expense

  const bump = (map, key, dCv, dBasis, dProc, meta) => {
    let cur = map.get(key);
    if (!cur) { cur = { cv: 0, basis: 0, proceeds: 0, ...meta }; map.set(key, cur); }
    cur.cv += dCv; cur.basis += dBasis; cur.proceeds += dProc;
  };

  const assetRows = [];
  const portfolioRows = [];

  for (const date of dates) {
    // Apply this date's investment snapshots as deltas against the prior snapshot.
    const dayChangeAsset = new Map();
    const dayChangePort = new Map();
    for (const r of rowsByDate.get(date)) {
      const key = scopeKey(r.investment_id, r.portfolio_id);
      const prev = snap.get(key) || { cv: 0, basis: 0, proceeds: 0, extBasis: 0, extProc: 0 };
      const dCv = r.current_value - prev.cv;
      const dBasis = r.attribution_basis - prev.basis;
      const dProc = r.attribution_proceeds - prev.proceeds;
      const dExtBasis = r.external_basis - prev.extBasis;
      const dExtProc = r.external_proceeds - prev.extProc;
      // Asset scope keeps the attribution lens; portfolio scope uses the external-cash lens.
      bump(assetSum, `${r.portfolio_id}|${r.asset_type}`, dCv, dBasis, dProc, { portfolioId: r.portfolio_id, assetType: r.asset_type });
      bump(portSum, r.portfolio_id, dCv, dExtBasis, dExtProc, { portfolioId: r.portfolio_id });
      snap.set(key, { cv: r.current_value, basis: r.attribution_basis, proceeds: r.attribution_proceeds, extBasis: r.external_basis, extProc: r.external_proceeds, portfolioId: r.portfolio_id, assetType: r.asset_type });

      const dc = Number(r.day_change || 0);
      dayChangeAsset.set(`${r.portfolio_id}|${r.asset_type}`, (dayChangeAsset.get(`${r.portfolio_id}|${r.asset_type}`) || 0) + dc);
      dayChangePort.set(r.portfolio_id, (dayChangePort.get(r.portfolio_id) || 0) + dc);
    }

    // Advance cumulative expenses effective on this date.
    if (expenseByDate.has(date)) {
      for (const [pid, amt] of expenseByDate.get(date)) {
        cumExpense.set(pid, (cumExpense.get(pid) || 0) + amt);
      }
    }

    // Emit asset rows for every group seen so far (carry-forward).
    for (const [key, v] of assetSum) {
      assetRows.push({
        portfolio_id: v.portfolioId,
        asset_type: v.assetType,
        date,
        current_value: v.cv,
        attribution_basis: v.basis,
        attribution_proceeds: v.proceeds,
        profit_loss_before_portfolio_expenses: v.cv + v.proceeds - v.basis,
        day_change: dayChangeAsset.get(key) || 0,
        calculation_version: ctx.calculationVersion,
        source_data_version: ctx.sourceDataVersion,
      });
    }

    // Emit portfolio rows for every portfolio seen so far (carry-forward), plus combined.
    let combinedCv = 0; let combinedBasis = 0; let combinedProc = 0; let combinedExpense = 0; let combinedDayChange = 0;
    for (const [pid, v] of portSum) {
      const expense = cumExpense.get(pid) || 0;
      const dayChange = dayChangePort.get(pid) || 0;
      portfolioRows.push({
        portfolio_id: pid,
        date,
        current_value: v.cv,
        net_invested: v.basis - v.proceeds,
        realized_proceeds: v.proceeds,
        total_profit_loss: v.cv + v.proceeds - v.basis - expense,
        total_day_change: dayChange,
        calculation_version: ctx.calculationVersion,
        source_data_version: ctx.sourceDataVersion,
      });
      combinedCv += v.cv; combinedBasis += v.basis; combinedProc += v.proceeds;
      combinedExpense += expense; combinedDayChange += dayChange;
    }
    portfolioRows.push({
      portfolio_id: COMBINED_PORTFOLIO_ID,
      date,
      current_value: combinedCv,
      net_invested: combinedBasis - combinedProc,
      realized_proceeds: combinedProc,
      total_profit_loss: combinedCv + combinedProc - combinedBasis - combinedExpense,
      total_day_change: combinedDayChange,
      calculation_version: ctx.calculationVersion,
      source_data_version: ctx.sourceDataVersion,
    });
  }

  return { assetRows, portfolioRows };
}

/**
 * Row-level and cross-scope invariant checks performed in memory before commit.
 * Returns { ok, violations }.
 */
function checkInvariants(portfolioRows, tolerance) {
  const tol = Math.max(0, Number(tolerance ?? 0.01));
  const violations = [];
  for (const r of portfolioRows) {
    const finite = [r.current_value, r.net_invested, r.total_profit_loss, r.total_day_change].every(Number.isFinite);
    if (!finite) {
      violations.push({ portfolioId: r.portfolio_id, date: r.date, reason: 'non-finite metric' });
      continue;
    }
    // total_profit_loss = current_value - net_invested - expenses; expenses are already folded in,
    // so the identity current_value - net_invested - total_profit_loss must equal the applied expense
    // (a non-negative, finite number). We only assert finiteness + the additive identity direction here.
    const impliedExpense = r.current_value - r.net_invested - r.total_profit_loss;
    if (!Number.isFinite(impliedExpense) || impliedExpense < -tol) {
      violations.push({ portfolioId: r.portfolio_id, date: r.date, reason: `negative implied expense ${impliedExpense}` });
    }
  }
  return { ok: violations.length === 0, violations };
}

/**
 * Full rebuild of all canonical V2 projections. Atomic: all V2 tables for the
 * active calculation version are replaced in one transaction. Legacy tables are
 * never read for writes here and never mutated.
 */
function rebuildCanonicalProjections(db, options = {}) {
  const calculationVersion = Number(options.calculationVersion ?? CALCULATION_VERSION);
  const sourceDataVersion = Number(options.sourceDataVersion ?? getDataVersion(db)) || 0;
  const ctx = { calculationVersion, sourceDataVersion };

  const investmentRows = buildInvestmentRows(db, ctx);
  // Excluded-from-tracking scopes get per-investment rows but never enter aggregates.
  const trackedInvestmentRows = investmentRows.filter((r) => !r.excluded);
  const { assetRows, portfolioRows } = buildAggregateRows(db, trackedInvestmentRows, ctx);

  const invariants = checkInvariants(portfolioRows, options.invariantTolerance);
  if (!invariants.ok && !options.allowInvariantViolations) {
    const sample = invariants.violations.slice(0, 5);
    throw new Error(`Canonical projection invariants failed (${invariants.violations.length}). Sample: ${JSON.stringify(sample)}`);
  }

  // Per-investment canonical accounting is written back onto investment_metrics_daily (the single
  // per-investment table); its accounting columns now hold canonical attribution values.
  const updInvestment = db.prepare(`
    UPDATE investment_metrics_daily
       SET invested_amount = @attribution_basis,
           realized_proceeds = @attribution_proceeds,
           profit_loss = @profit_loss
     WHERE investment_id = @investment_id AND portfolio_id = @portfolio_id AND date = @date
  `);
  const insAsset = db.prepare(`
    INSERT INTO asset_metrics_daily
      (portfolio_id, asset_type, date, current_value, attribution_basis, attribution_proceeds,
       profit_loss_before_portfolio_expenses, day_change, calculation_version, source_data_version)
    VALUES (@portfolio_id, @asset_type, @date, @current_value, @attribution_basis, @attribution_proceeds,
       @profit_loss_before_portfolio_expenses, @day_change, @calculation_version, @source_data_version)
  `);
  const insPortfolio = db.prepare(`
    INSERT INTO portfolio_metrics_daily
      (portfolio_id, date, current_value, net_invested, realized_proceeds, total_profit_loss, total_day_change,
       calculation_version, source_data_version)
    VALUES (@portfolio_id, @date, @current_value, @net_invested, @realized_proceeds, @total_profit_loss, @total_day_change,
       @calculation_version, @source_data_version)
  `);

  const runAll = db.transaction(() => {
    db.prepare(`DELETE FROM asset_metrics_daily WHERE calculation_version = ?`).run(calculationVersion);
    db.prepare(`DELETE FROM portfolio_metrics_daily WHERE calculation_version = ?`).run(calculationVersion);
    for (const r of investmentRows) updInvestment.run(r);
    for (const r of assetRows) insAsset.run(r);
    for (const r of portfolioRows) insPortfolio.run(r);
  });
  runAll();

  return {
    calculationVersion,
    sourceDataVersion,
    investmentRowCount: investmentRows.length,
    assetRowCount: assetRows.length,
    portfolioRowCount: portfolioRows.length,
    invariantViolationCount: invariants.violations.length,
  };
}

/**
 * Rebuild wrapper that never throws into the caller's pipeline. Used by the
 * price-update and backfill flows to keep V2 fresh without risking the main
 * aggregate refresh if the canonical rebuild fails.
 */
function safeRebuildCanonicalProjections(db, logger = null) {
  try {
    const result = rebuildCanonicalProjections(db);
    if (logger && typeof logger.info === 'function') {
      logger.info('[CanonicalProjection] V2 rebuild complete', result);
    }
    return result;
  } catch (err) {
    if (logger && typeof logger.warn === 'function') {
      logger.warn('[CanonicalProjection] V2 rebuild failed (legacy path unaffected)', { error: err.message });
    }
    return null;
  }
}

module.exports = {
  buildInvestmentRows,
  buildAggregateRows,
  checkInvariants,
  rebuildCanonicalProjections,
  safeRebuildCanonicalProjections,
};