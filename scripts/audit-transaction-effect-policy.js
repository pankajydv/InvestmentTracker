const Database = require('better-sqlite3');
const path = require('path');

const {
  CALCULATION_VERSION,
  REVIEW_STATUS,
  listTransactionEffectRules,
} = require('../server/services/transactionEffectPolicy');

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const databasePath = process.env.DB_PATH || path.join(dataDir, 'investments.db');
const db = new Database(databasePath, { readonly: true, fileMustExist: true });

try {
  const reviewTypes = listTransactionEffectRules()
    .filter(({ reviewStatus }) => reviewStatus === REVIEW_STATUS.REVIEW_REQUIRED)
    .map(({ transactionType }) => transactionType)
    .sort();
  const placeholders = reviewTypes.map(() => '?').join(',');

  const transactions = db.prepare(`
    SELECT
      t.transaction_type,
      i.asset_type,
      COUNT(*) AS row_count,
      ROUND(SUM(t.amount), 2) AS total_amount,
      ROUND(SUM(COALESCE(t.fees, 0)), 2) AS total_fees
    FROM transactions t
    JOIN investments i ON i.id = t.investment_id
    WHERE t.transaction_type IN (${placeholders})
    GROUP BY t.transaction_type, i.asset_type
    ORDER BY t.transaction_type, i.asset_type
  `).all(...reviewTypes);

  const openingBalances = db.prepare(`
    SELECT
      asset_type,
      COUNT(*) AS investment_count,
      ROUND(SUM(opening_balance), 2) AS total_opening_balance
    FROM investments
    WHERE COALESCE(opening_balance, 0) <> 0
    GROUP BY asset_type
    ORDER BY asset_type
  `).all();

  const observedTypes = new Set(transactions.map(({ transaction_type: transactionType }) => transactionType));

  console.log(JSON.stringify({
    calculationVersion: CALCULATION_VERSION,
    reviewTypes,
    unobservedReviewTypes: reviewTypes.filter((transactionType) => !observedTypes.has(transactionType)),
    transactions,
    openingBalances,
  }, null, 2));
} finally {
  db.close();
}