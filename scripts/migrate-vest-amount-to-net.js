/*
 * One-time migration: recompute VEST transaction `amount` (and `usd_amount`)
 * to the NET post-tax value actually delivered to the holder.
 *
 * Rationale: RSU VEST rows store `units` = net (post-tax) shares delivered and
 * `price_per_unit` = vest-date FMV (both verified correct), but the legacy
 * `amount`/`usd_amount` were recorded as GROSS (pre-tax) value and are also
 * internally inconsistent for some grants. The invested capital that the holder
 * actually kept is the net value = units * price_per_unit (native), converted to
 * INR at the vest-date FX (exchange_rate_used).
 *
 * Gross value remains recoverable from gross_units * price_per_unit, so no data
 * is lost. Run with `--apply` to write; default is a dry run.
 *
 * After applying, daily_values / asset_type_daily / portfolio_daily for the
 * affected investments must be recomputed (dirty-scope backfill).
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const APPLY = process.argv.includes('--apply');
const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'investments.db');
const db = new Database(dbPath);
db.pragma('busy_timeout = 10000');

function fmt(n) {
  return Math.round(Number(n) || 0).toLocaleString('en-IN');
}

if (APPLY) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(path.dirname(dbPath), 'migration-backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `investments.db.pre-vest-net-${ts}`);
  db.exec(`VACUUM INTO '${backupPath.replace(/\\/g, "/").replace(/'/g, "''")}'`);
  console.log('Backup snapshot written:', backupPath, '\n');
}

const rows = db.prepare(`
  SELECT t.id, t.investment_id, i.name, i.currency,
         t.units, t.price_per_unit, t.amount, t.usd_amount, t.exchange_rate_used,
         t.gross_units
  FROM transactions t
  JOIN investments i ON i.id = t.investment_id
  WHERE t.transaction_type = 'VEST'
`).all();

const upd = db.prepare('UPDATE transactions SET amount = ?, usd_amount = ? WHERE id = ?');
const perInv = {};
let changed = 0;
let skipped = 0;
const skippedRows = [];

const run = db.transaction(() => {
  for (const r of rows) {
    const units = Number(r.units) || 0;
    const ppu = Number(r.price_per_unit) || 0;
    const isUsd = String(r.currency || '').toUpperCase() === 'USD';
    const fx = Number(r.exchange_rate_used) || 0;

    if (units <= 0 || ppu <= 0 || (isUsd && fx <= 0)) {
      skipped += 1;
      skippedRows.push({ id: r.id, name: r.name, units, ppu, fx, currency: r.currency });
      continue;
    }

    const nativeVal = units * ppu;                 // net value in native currency
    const newAmount = isUsd ? nativeVal * fx : nativeVal; // INR
    const newUsd = isUsd ? nativeVal : r.usd_amount;      // USD (unchanged for non-USD)

    const k = r.name;
    if (!perInv[k]) perInv[k] = { n: 0, oldInr: 0, newInr: 0 };
    perInv[k].n += 1;
    perInv[k].oldInr += Number(r.amount) || 0;
    perInv[k].newInr += newAmount;

    if (APPLY) upd.run(newAmount, newUsd, r.id);
    changed += 1;
  }
});
run();

console.log(`VEST rows scanned: ${rows.length} | ${APPLY ? 'updated' : 'would update'}: ${changed} | skipped: ${skipped}\n`);
console.log('Per investment (INR invested basis):');
for (const [name, s] of Object.entries(perInv)) {
  console.log(`  ${name.padEnd(24)} rows=${s.n} | old(gross)=₹${fmt(s.oldInr)} -> new(net)=₹${fmt(s.newInr)} | reduction=₹${fmt(s.oldInr - s.newInr)}`);
}
if (skippedRows.length) {
  console.log('\nSkipped rows (missing units/price/fx):');
  for (const s of skippedRows) console.log('  ', JSON.stringify(s));
}
if (!APPLY) console.log('\nDRY RUN — no changes written. Re-run with `--apply` to commit.');
else console.log('\nAPPLIED. Recompute daily_values/aggregates for the affected investments next.');

db.close();
