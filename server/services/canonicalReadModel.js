/**
 * Canonical read model.
 *
 * Read-only helpers that source portfolio/asset rollup metrics from the canonical
 * projections (`portfolio_metrics_daily`, `asset_metrics_daily`). Per-investment
 * canonical accounting lives on `investment_metrics_daily` itself. Callers use these unconditionally
 * and fall back to the legacy rollups only when a helper returns null/empty.
 *
 * Field aliases: legacy responses use `total_invested`; the canonical contract
 * uses `net_invested` (external basis less cash proceeds). Both are populated so
 * clients keep working.
 */

const { CALCULATION_VERSION } = require('./transactionEffectPolicy');

function scopeFilter(scopeIds) {
  if (Array.isArray(scopeIds) && scopeIds.length > 0) {
    const placeholders = scopeIds.map(() => '?').join(', ');
    return { clause: `AND portfolio_id IN (${placeholders})`, params: scopeIds };
  }
  return { clause: '', params: [] };
}

/**
 * Summed latest-row portfolio totals across the selected scope from V2.
 * Returns null when no V2 rows exist for the scope (caller should fall back).
 */
function getPortfolioV2Latest(db, scopeIds = [], calculationVersion = CALCULATION_VERSION) {
  const sf = scopeFilter(scopeIds);
  const rows = db.prepare(`
    SELECT p.portfolio_id, p.date, p.current_value, p.net_invested, p.realized_proceeds, p.total_profit_loss, p.total_day_change
    FROM portfolio_metrics_daily p
    INNER JOIN (
      SELECT portfolio_id, MAX(date) AS max_date
      FROM portfolio_metrics_daily
      WHERE calculation_version = ? AND portfolio_id IS NOT NULL ${sf.clause}
      GROUP BY portfolio_id
    ) latest ON p.portfolio_id = latest.portfolio_id AND p.date = latest.max_date
    WHERE p.calculation_version = ?
  `).all(calculationVersion, ...sf.params, calculationVersion);

  if (!rows.length) return null;

  let totalValue = 0; let netInvested = 0; let proceeds = 0; let dayChange = 0; let asOfDate = null;
  for (const r of rows) {
    totalValue += Number(r.current_value || 0);
    netInvested += Number(r.net_invested || 0);
    proceeds += Number(r.realized_proceeds || 0);
    dayChange += Number(r.total_day_change || 0);
    if (!asOfDate || String(r.date) > asOfDate) asOfDate = r.date;
  }
  // Present the legacy client contract from stored values: total_invested is GROSS basis
  // (net_invested + realized_proceeds); total_profit_loss is BEFORE portfolio expenses
  // (current_value - net_invested), which the client nets against expenses itself.
  const grossInvested = netInvested + proceeds;
  const profitLossBeforeExpenses = totalValue - netInvested;
  return {
    date: asOfDate,
    total_value: totalValue,
    net_invested: netInvested,
    realized_proceeds: proceeds,
    total_realized_proceeds: proceeds,
    total_invested: grossInvested,
    total_profit_loss: profitLossBeforeExpenses,
    total_profit_loss_pct: grossInvested > 0 ? (profitLossBeforeExpenses / grossInvested) * 100 : 0,
    day_change: dayChange,
    calculation_version: calculationVersion,
  };
}

/**
 * Portfolio history rows across the selected scope, shaped like the legacy
 * `portfolio_daily` rows the history endpoints already consume.
 */
function getPortfolioV2History(db, scopeIds = [], startDate = null, endDate = null, calculationVersion = CALCULATION_VERSION) {
  const sf = scopeFilter(scopeIds);
  const dateClause = (startDate && endDate) ? 'AND date BETWEEN ? AND ?' : '';
  const dateParams = (startDate && endDate) ? [startDate, endDate] : [];
  const rows = db.prepare(`
    SELECT date,
           SUM(current_value) AS total_value,
           SUM(net_invested) AS net_invested,
           SUM(realized_proceeds) AS realized_proceeds,
           SUM(total_day_change) AS day_change
    FROM portfolio_metrics_daily
    WHERE calculation_version = ? AND portfolio_id IS NOT NULL ${sf.clause} ${dateClause}
    GROUP BY date
    ORDER BY date ASC
  `).all(calculationVersion, ...sf.params, ...dateParams);

  return rows.map((r) => {
    const netInvested = Number(r.net_invested || 0);
    const proceeds = Number(r.realized_proceeds || 0);
    const currentValue = Number(r.total_value || 0);
    // Same legacy contract as getPortfolioV2Latest: gross invested + before-expense P&L.
    const grossInvested = netInvested + proceeds;
    const profitLossBeforeExpenses = currentValue - netInvested;
    return {
      date: r.date,
      total_value: currentValue,
      total_invested: grossInvested,
      net_invested: netInvested,
      total_realized_proceeds: proceeds,
      realized_proceeds: proceeds,
      total_profit_loss: profitLossBeforeExpenses,
      total_profit_loss_pct: grossInvested > 0 ? (profitLossBeforeExpenses / grossInvested) * 100 : 0,
      day_change: Number(r.day_change || 0),
      day_change_pct: 0,
    };
  });
}

/**
 * Asset allocation rows from V2 asset metrics: the latest asset-scope row per
 * (portfolio, asset_type) across the scope, summed by asset_type. Shaped like the
 * legacy `/allocation` rows. P&L is before portfolio-only expenses (asset scope).
 * Returns null when no V2 asset rows exist for the scope (caller should fall back).
 */
function getAssetAllocationV2(db, scopeIds = [], calculationVersion = CALCULATION_VERSION) {
  const sf = scopeFilter(scopeIds);
  const values = db.prepare(`
    WITH latest AS (
      SELECT portfolio_id, asset_type, MAX(date) AS max_date
      FROM asset_metrics_daily
      WHERE calculation_version = ? AND portfolio_id IS NOT NULL ${sf.clause}
      GROUP BY portfolio_id, asset_type
    )
    SELECT a.asset_type,
           SUM(a.current_value) AS total_value,
           SUM(a.attribution_basis) AS total_invested,
           SUM(a.attribution_proceeds) AS total_realized_proceeds,
           SUM(a.profit_loss_before_portfolio_expenses) AS total_profit_loss
    FROM asset_metrics_daily a
    INNER JOIN latest l ON a.portfolio_id = l.portfolio_id AND a.asset_type = l.asset_type AND a.date = l.max_date
    WHERE a.calculation_version = ?
    GROUP BY a.asset_type
  `).all(calculationVersion, ...sf.params, calculationVersion);

  if (!values.length) return null;

  const counts = db.prepare(`
    SELECT i.asset_type, COUNT(DISTINCT dv.investment_id) AS count
    FROM investment_metrics_daily dv
    JOIN investments i ON i.id = dv.investment_id
    WHERE COALESCE(i.exclude_from_tracking, 0) = 0 AND dv.portfolio_id IS NOT NULL ${sf.clause.replace(/portfolio_id/g, 'dv.portfolio_id')}
    GROUP BY i.asset_type
  `).all(...sf.params);
  const countByType = new Map(counts.map((c) => [c.asset_type, Number(c.count || 0)]));

  return values.map((r) => ({
    asset_type: r.asset_type,
    count: countByType.get(r.asset_type) || 0,
    total_value: Number(r.total_value || 0),
    total_invested: Number(r.total_invested || 0),
    total_realized_proceeds: Number(r.total_realized_proceeds || 0),
    total_profit_loss: Number(r.total_profit_loss || 0),
  }));
}

/**
 * Asset-type history rows for one asset type across the scope, shaped like the legacy
 * `asset_type_daily` rows the `/performance-by-type` endpoint consumes. Gross invested
 * and before-expense P&L, consistent with the card and allocation.
 */
function getAssetTypeHistoryV2(db, assetType, scopeIds = [], startDate = null, endDate = null, calculationVersion = CALCULATION_VERSION) {
  const sf = scopeFilter(scopeIds);
  const dateClause = (startDate && endDate) ? 'AND date BETWEEN ? AND ?' : '';
  const dateParams = (startDate && endDate) ? [startDate, endDate] : [];
  const rows = db.prepare(`
    SELECT date,
           SUM(current_value) AS total_value,
           SUM(attribution_basis) AS total_invested,
           SUM(attribution_proceeds) AS total_realized_proceeds,
           SUM(profit_loss_before_portfolio_expenses) AS total_profit_loss,
           SUM(day_change) AS day_change
    FROM asset_metrics_daily
    WHERE calculation_version = ? AND portfolio_id IS NOT NULL AND asset_type = ? ${sf.clause} ${dateClause}
    GROUP BY date
    ORDER BY date ASC
  `).all(calculationVersion, assetType, ...sf.params, ...dateParams);

  if (!rows.length) return null;

  return rows.map((r) => {
    const invested = Number(r.total_invested || 0);
    const proceeds = Number(r.total_realized_proceeds || 0);
    const currentValue = Number(r.total_value || 0);
    const profitLoss = Number(r.total_profit_loss || 0);
    return {
      asset_type: assetType,
      date: r.date,
      total_value: currentValue,
      total_invested: invested,
      total_realized_proceeds: proceeds,
      total_unrealized_gain: currentValue - (invested - proceeds),
      total_profit_loss: profitLoss,
      total_profit_loss_pct: invested > 0 ? (profitLoss / invested) * 100 : 0,
      day_change: Number(r.day_change || 0),
      day_change_pct: 0,
    };
  });
}

/**
 * Carry-forward rollover rows for the "Daily Portfolio Value History" table. Reads the
 * carry-forward projections (portfolio scope, or asset scope when filtered) so exited
 * holdings are retained and the latest row matches the top card. Returns null when V2 is
 * empty (caller falls back to the legacy exact-date investment_metrics_daily aggregation).
 * Portfolio scope uses the external-cash lens; asset scope uses attribution.
 */
function getRolloverV2(db, { portfolioIds = [], assetType = null, fromDate, toDate, page = 1, pageSize = 366 } = {}, calculationVersion = CALCULATION_VERSION) {
  if (!db.prepare(`SELECT 1 FROM portfolio_metrics_daily LIMIT 1`).get()) return null;
  const sf = scopeFilter(portfolioIds);

  const cfg = assetType
    ? {
        table: 'asset_metrics_daily',
        investedExpr: 'SUM(attribution_basis - attribution_proceeds)', // net invested (attribution)
        proceedsExpr: 'SUM(attribution_proceeds)',
        plExpr: 'SUM(profit_loss_before_portfolio_expenses)',
        dayChangeExpr: 'SUM(day_change)',
        extraWhere: 'AND asset_type = ?',
        extraParams: [assetType],
      }
    : {
        table: 'portfolio_metrics_daily',
        investedExpr: 'SUM(net_invested)', // net invested, matching the top card
        proceedsExpr: 'SUM(realized_proceeds)',
        plExpr: 'SUM(total_profit_loss)',
        dayChangeExpr: 'SUM(total_day_change)',
        extraWhere: '',
        extraParams: [],
      };

  const where = `calculation_version = ? AND portfolio_id IS NOT NULL ${cfg.extraWhere} ${sf.clause} AND date BETWEEN ? AND ?`;
  const params = [calculationVersion, ...cfg.extraParams, ...sf.params, fromDate, toDate];

  const totalRows = Number(db.prepare(`
    SELECT COUNT(*) AS c FROM (
      SELECT date FROM ${cfg.table} WHERE ${where} GROUP BY date
    ) g
  `).get(...params)?.c || 0);

  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const offset = (currentPage - 1) * pageSize;

  const rows = db.prepare(`
    SELECT date,
      SUM(current_value) AS current_value,
      ${cfg.investedExpr} AS invested_amount,
      ${cfg.proceedsExpr} AS realized_proceeds,
      ${cfg.plExpr} AS profit_loss,
      ${cfg.dayChangeExpr} AS day_change,
      COUNT(DISTINCT portfolio_id) AS contributing_portfolios,
      COUNT(*) AS contributing_rows
    FROM ${cfg.table}
    WHERE ${where}
    GROUP BY date
    ORDER BY date DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset);

  const bounds = db.prepare(`
    SELECT MAX(date) AS latest, MIN(date) AS oldest FROM ${cfg.table} WHERE ${where}
  `).get(...params) || {};

  return {
    rows: rows.map((row) => {
      const currentValue = Number(row.current_value) || 0;
      const dayChange = Number(row.day_change) || 0;
      const previousValue = currentValue - dayChange;
      return {
        date: row.date,
        current_value: currentValue,
        invested_amount: Number(row.invested_amount) || 0,
        realized_proceeds: Number(row.realized_proceeds) || 0,
        profit_loss: Number(row.profit_loss) || 0,
        day_change: dayChange,
        day_change_pct: previousValue > 0 ? (dayChange / previousValue) * 100 : 0,
        price_source: 'CANONICAL',
        contributing_rows: Number(row.contributing_rows) || 0,
        contributing_portfolios: Number(row.contributing_portfolios) || 0,
      };
    }),
    totalRows,
    totalPages,
    currentPage,
    latestRowDate: bounds.latest || null,
    oldestRowDate: bounds.oldest || null,
  };
}

module.exports = {
  getPortfolioV2Latest,
  getPortfolioV2History,
  getAssetAllocationV2,
  getAssetTypeHistoryV2,
  getRolloverV2,
};