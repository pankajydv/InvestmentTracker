// Remediate VEST rows that were accepted with FX unresolved (exchange_rate_used<=0 / amount<=0)
// even though units/fmv/usd_amount are correct. Resolves FX from the local FX cache for the
// vest date and backfills exchange_rate_used + INR amount. Idempotent (only touches fx<=0 rows).
const Database = require('better-sqlite3');
const { getNearestOnOrBefore } = require('../server/services/marketPriceCache');
const { markDirtyFromTransactions } = require('../server/services/dirtyBackfillService');

const db = new Database('data/investments.db');
db.pragma('busy_timeout = 8000');

const round2 = (x) => Math.round(Number(x) * 100) / 100;

const rows = db.prepare(`
  SELECT id, investment_id, portfolio_id, DATE(transaction_date) d,
         units, fmv_per_unit fmv, usd_amount usd, amount, exchange_rate_used fx
  FROM transactions
  WHERE transaction_type='VEST'
    AND units > 0 AND fmv_per_unit > 0
    AND (exchange_rate_used IS NULL OR exchange_rate_used <= 0 OR amount IS NULL OR amount <= 0)
  ORDER BY id
`).all();

console.log(`Found ${rows.length} VEST row(s) needing FX backfill.`);
const upd = db.prepare(`
  UPDATE transactions
  SET exchange_rate_used = ?, usd_amount = ?, amount = ?
  WHERE id = ? AND transaction_type = 'VEST'
`);

const dirty = [];
let fixed = 0, skipped = 0;
const tx = db.transaction(() => {
  for (const r of rows) {
    let fx = 0;
    try { fx = Number(getNearestOnOrBefore('FX', 'USDINR=X', r.d)?.close); } catch (_) { fx = 0; }
    if (!(fx > 0)) { console.log(`  id=${r.id} ${r.d}: NO FX in cache -> skip`); skipped++; continue; }
    const usd = Number(r.usd) > 0 ? Number(r.usd) : round2(Number(r.units) * Number(r.fmv));
    const inr = round2(usd * fx);
    upd.run(round2(fx * 10000) / 10000, round2(usd), inr, r.id);
    console.log(`  id=${r.id} ${r.d}: fx=${fx.toFixed(4)} usd=${usd} -> amount=${inr} (was ${r.amount})`);
    dirty.push({ investment_id: r.investment_id, portfolio_id: r.portfolio_id, transaction_date: r.d });
    fixed++;
  }
});
tx();

if (dirty.length) {
  const n = markDirtyFromTransactions(db, dirty, 'rsu-vest-fx-backfill');
  console.log(`Marked ${n} scope(s) dirty for recompute.`);
}
console.log(`Done. fixed=${fixed}, skipped=${skipped}`);
db.close();
