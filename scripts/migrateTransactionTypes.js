/**
 * Migrate transactions table to support expanded transaction_type CHECK constraint.
 */
const { getDb } = require('../server/db/schema');
const db = getDb();

db.exec('PRAGMA foreign_keys = OFF');
db.exec('BEGIN TRANSACTION');

try {
  db.exec('ALTER TABLE transactions RENAME TO transactions_old');

  db.exec(`
    CREATE TABLE transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      investment_id INTEGER NOT NULL,
      transaction_type TEXT NOT NULL CHECK(transaction_type IN ('BUY', 'SELL', 'DEPOSIT', 'WITHDRAWAL', 'DIVIDEND', 'INTEREST', 'SPLIT', 'BONUS', 'RIGHTS', 'MERGER', 'CONSOLIDATION', 'IPO', 'TRANSFER_IN', 'TRANSFER_OUT')),
      transaction_date TEXT NOT NULL,
      units REAL,
      price_per_unit REAL,
      amount REAL NOT NULL,
      fees REAL DEFAULT 0,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (investment_id) REFERENCES investments(id) ON DELETE CASCADE
    )
  `);

  db.exec('INSERT INTO transactions SELECT * FROM transactions_old');
  db.exec('DROP TABLE transactions_old');
  db.exec('COMMIT');
  console.log('Migration successful');
} catch (e) {
  db.exec('ROLLBACK');
  console.error('Migration failed:', e.message);
}

db.exec('PRAGMA foreign_keys = ON');

const count = db.prepare('SELECT COUNT(*) as c FROM transactions').get();
console.log('Transactions:', count.c);

const info = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='transactions'").get();
const checkMatch = info.sql.match(/CHECK\([^)]+\)/);
console.log('CHECK:', checkMatch ? checkMatch[0] : 'none');

db.close();
