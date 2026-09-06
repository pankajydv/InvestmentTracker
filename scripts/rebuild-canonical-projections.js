const Database = require('better-sqlite3');
const path = require('path');

const { rebuildCanonicalProjections } = require('../server/services/canonicalProjectionEngine');
const { CALCULATION_VERSION } = require('../server/services/transactionEffectPolicy');

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const databasePath = process.env.DB_PATH || path.join(dataDir, 'investments.db');
const db = new Database(databasePath, { fileMustExist: true });

const round2 = (v) => Math.round(Number(v || 0) * 100) / 100;

try {
  const t0 = Date.now();
  const result = rebuildCanonicalProjections(db);
  const elapsedSeconds = Number(((Date.now() - t0) / 1000).toFixed(1));

  // Parity check: canonical V2 portfolio P&L (target) versus legacy portfolio_daily
  // at each portfolio's latest date. The delta should equal the approved corrections
  // (uniform withdrawal proceeds + portfolio expenses), not an unexplained difference.
  const v2Latest = db.prepare(`
    SELECT p.portfolio_id, p.date, p.current_value, p.net_invested, p.total_profit_loss
    FROM portfolio_metrics_daily p
    INNER JOIN (
      SELECT portfolio_id, MAX(date) AS max_date
      FROM portfolio_metrics_daily WHERE calculation_version = ? AND portfolio_id IS NOT NULL
      GROUP BY portfolio_id
    ) latest ON p.portfolio_id = latest.portfolio_id AND p.date = latest.max_date
    WHERE p.calculation_version = ?
  `).all(CALCULATION_VERSION, CALCULATION_VERSION);

  const legacyStmt = db.prepare(`
    SELECT total_value, total_invested, total_profit_loss
    FROM portfolio_daily WHERE portfolio_id = ? AND date = ?
  `);
  const legacyLatestStmt = db.prepare(`
    SELECT date, total_value, total_profit_loss
    FROM portfolio_daily WHERE portfolio_id = ? ORDER BY date DESC LIMIT 1
  `);
  const nameStmt = db.prepare('SELECT name FROM portfolios WHERE id = ?');

  const parity = [];
  for (const r of v2Latest) {
    const legacyExact = legacyStmt.get(r.portfolio_id, r.date);
    const legacyLatest = legacyLatestStmt.get(r.portfolio_id);
    const legacyPL = Number((legacyExact || legacyLatest || {}).total_profit_loss || 0);
    parity.push({
      portfolioId: r.portfolio_id,
      name: nameStmt.get(r.portfolio_id)?.name || null,
      date: r.date,
      v2CurrentValue: round2(r.current_value),
      v2NetInvested: round2(r.net_invested),
      v2ProfitLoss: round2(r.total_profit_loss),
      legacyProfitLoss: round2(legacyPL),
      deltaVsLegacy: round2(r.total_profit_loss - legacyPL),
    });
  }
  parity.sort((a, b) => Math.abs(b.deltaVsLegacy) - Math.abs(a.deltaVsLegacy));

  console.log(JSON.stringify({
    calculationVersion: result.calculationVersion,
    sourceDataVersion: result.sourceDataVersion,
    databasePath,
    elapsedSeconds,
    investmentRowCount: result.investmentRowCount,
    assetRowCount: result.assetRowCount,
    portfolioRowCount: result.portfolioRowCount,
    invariantViolationCount: result.invariantViolationCount,
    parityVsLegacy: parity,
    note: 'deltaVsLegacy is the canonical target minus legacy stored P&L; it should equal the approved corrections (uniform withdrawal proceeds + portfolio expenses), not an unexplained difference.',
  }, null, 2));
} finally {
  db.close();
}
