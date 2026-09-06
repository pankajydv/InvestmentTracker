const Database = require('better-sqlite3');
const path = require('path');

const {
  resolveClassificationEffect,
  PROVIDENT_ASSET_TYPES,
} = require('../server/services/transactionEffectPolicy');

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const databasePath = process.env.DB_PATH || path.join(dataDir, 'investments.db');
const db = new Database(databasePath, { readonly: true, fileMustExist: true });

const UNITS_TOLERANCE = 0.001;
const VALUE_TOLERANCE = 1;

try {
  const latestScopes = db.prepare(`
    SELECT dv.investment_id, dv.portfolio_id, dv.date,
           dv.current_value, dv.total_units, dv.invested_amount,
           dv.realized_proceeds, dv.profit_loss, i.asset_type, i.name, i.is_active
    FROM investment_metrics_daily dv
    JOIN investments i ON i.id = dv.investment_id
    INNER JOIN (
      SELECT investment_id, portfolio_id, MAX(date) AS max_date
      FROM investment_metrics_daily
      WHERE portfolio_id IS NOT NULL
      GROUP BY investment_id, portfolio_id
    ) latest
      ON dv.investment_id = latest.investment_id
      AND dv.portfolio_id = latest.portfolio_id
      AND dv.date = latest.max_date
    WHERE COALESCE(i.exclude_from_tracking, 0) = 0
      AND dv.portfolio_id IS NOT NULL
  `).all();

  const txnStmt = db.prepare(`
    SELECT UPPER(transaction_type) AS transaction_type,
           COALESCE(amount, 0) AS amount,
           COALESCE(fees, 0) AS fees,
           COALESCE(units, 0) AS units,
           MAX(date(transaction_date)) OVER () AS last_txn_date
    FROM transactions
    WHERE investment_id = ? AND portfolio_id = ? AND date(transaction_date) <= ?
  `);

  const findings = [];
  for (const scope of latestScopes) {
    const assetType = String(scope.asset_type || '').toUpperCase();
    if (PROVIDENT_ASSET_TYPES.has(assetType)) continue; // balance-based, ~0 units is normal

    const rows = txnStmt.all(scope.investment_id, scope.portfolio_id, scope.date);
    let netUnits = 0;
    for (const t of rows) {
      netUnits += resolveClassificationEffect(t.transaction_type, {
        amount: t.amount, fees: t.fees, units: t.units, assetType,
      }).unitsDelta;
    }

    const currentValue = Number(scope.current_value || 0);
    if (Math.abs(netUnits) <= UNITS_TOLERANCE && Math.abs(currentValue) > VALUE_TOLERANCE) {
      findings.push({
        investmentId: scope.investment_id,
        portfolioId: scope.portfolio_id,
        name: scope.name,
        assetType,
        isActive: scope.is_active,
        latestStoredDate: scope.date,
        lastTxnDate: rows.length ? rows[0].last_txn_date : null,
        canonicalNetUnits: Number(netUnits.toFixed(4)),
        storedTotalUnits: Number((scope.total_units || 0).toFixed(4)),
        storedCurrentValue: Number(currentValue.toFixed(2)),
        storedProfitLoss: Number((scope.profit_loss || 0).toFixed(2)),
      });
    }
  }

  findings.sort((a, b) => Math.abs(b.storedCurrentValue) - Math.abs(a.storedCurrentValue));

  const totalPhantomValue = findings.reduce((s, f) => s + f.storedCurrentValue, 0);
  const totalPhantomProfitLoss = findings.reduce((s, f) => s + f.storedProfitLoss, 0);

  console.log(JSON.stringify({
    databasePath,
    scopesScanned: latestScopes.length,
    staleExitedHoldingCount: findings.length,
    totalPhantomCurrentValue: Number(totalPhantomValue.toFixed(2)),
    totalPhantomProfitLoss: Number(totalPhantomProfitLoss.toFixed(2)),
    findings,
  }, null, 2));
} finally {
  db.close();
}
