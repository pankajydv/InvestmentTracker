/*
 * Mark dirty-backfill scopes for investments whose VEST `amount` was migrated
 * to net (see migrate-vest-amount-to-net.js), so the next scheduler/backfill run
 * recomputes daily_values + aggregates with the corrected invested basis.
 *
 * Marks each (investment, portfolio) scope dirty from the investment's first
 * transaction date. Idempotent (merges with any existing pending scope).
 */
const path = require('path');
const Database = require('better-sqlite3');
const { markScopeDirty } = require('../server/services/dirtyBackfillService');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'investments.db');
const db = new Database(dbPath);
db.pragma('busy_timeout = 10000');

// Investments that have VEST transactions (the ones the migration touched)
const investmentIds = db.prepare(`
  SELECT DISTINCT investment_id AS id
  FROM transactions
  WHERE transaction_type = 'VEST'
`).all().map((r) => r.id);

const reason = 'vest-amount-net-migration';
const sourceEventId = `vest-net-${new Date().toISOString()}`;

let marked = 0;
for (const investmentId of investmentIds) {
  const scopes = db.prepare(`
    SELECT DISTINCT portfolio_id AS pid, MIN(DATE(transaction_date)) AS firstDate
    FROM transactions
    WHERE investment_id = ?
    GROUP BY portfolio_id
  `).all(investmentId);

  for (const s of scopes) {
    const d = markScopeDirty(db, {
      investmentId,
      portfolioId: s.pid,
      dirtyFromDate: s.firstDate,
      reason,
      sourceEventId,
    });
    console.log(`  marked dirty: investment=${investmentId} portfolio=${s.pid} from=${d}`);
    if (d) marked += 1;
  }
}

console.log(`\nDone. Scopes marked dirty: ${marked}. Next scheduler/backfill run will recompute them.`);
db.close();
