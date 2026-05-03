/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { fetchHistoricalUSDToINR } = require('../server/services/priceService');
const {
  parseOpenLots,
  parseClosedLots,
  reconcileVestTransactions,
} = require('../server/services/fidelityVestReconciler');

function getArg(name, fallback = null) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] || fallback;
}

(async () => {
  const dbPath = getArg('db', path.join('data', 'investments.db'));
  const investmentId = Number(getArg('investment-id'));
  const portfolioId = getArg('portfolio-id') ? Number(getArg('portfolio-id')) : null;
  const openPath = getArg('open');
  const closedPath = getArg('closed');
  const apply = process.argv.includes('--apply');
  const overwritePrice = !process.argv.includes('--keep-price');
  const notesContains = getArg('notes-contains');

  if (!investmentId || (!openPath && !closedPath)) {
    console.error('Usage: node scripts/reconcile_rsu_fidelity.js --investment-id <id> [--portfolio-id <id>] --open <openLots.csv> --closed <closedLots.csv> [--notes-contains <text>] [--apply] [--keep-price] [--db data/investments.db]');
    process.exit(1);
  }

  const db = new Database(dbPath);
  const inv = db.prepare('SELECT id, name, ticker_symbol, currency FROM investments WHERE id = ?').get(investmentId);
  if (!inv) {
    console.error(`Investment ${investmentId} not found`);
    process.exit(1);
  }

  let vestTxns = db.prepare(`
    SELECT id, transaction_date, units, gross_units, price_per_unit, notes
    FROM transactions
    WHERE investment_id = ?
      AND transaction_type = 'VEST'
      ${portfolioId ? 'AND portfolio_id = ?' : ''}
    ORDER BY transaction_date ASC, id ASC
  `).all(...(portfolioId ? [investmentId, portfolioId] : [investmentId]));

  if (notesContains) {
    const needle = String(notesContains).toLowerCase();
    vestTxns = vestTxns.filter((t) => String(t.notes || '').toLowerCase().includes(needle));
  }

  if (!vestTxns.length) {
    console.log('No VEST transactions found for this investment/portfolio filter.');
    process.exit(0);
  }

  const openRows = openPath ? parseOpenLots(fs.readFileSync(openPath)) : [];
  const closedRows = closedPath ? parseClosedLots(fs.readFileSync(closedPath)) : [];

  const reconciliation = reconcileVestTransactions({
    vestTransactions: vestTxns,
    openLotsRows: openRows,
    closedLotsRows: closedRows,
  });

  console.log(JSON.stringify({
    investment: inv,
    notes_filter: notesContains || null,
    matched_dates: reconciliation.matched_dates,
    matched_txns: reconciliation.matched_txns,
    skipped_dates: reconciliation.skipped_dates,
    sample_updates: reconciliation.updates.slice(0, 12),
  }, null, 2));

  // Load existing DB values for tolerance check
  const selectTxn = db.prepare(`
    SELECT id, transaction_date, gross_units, units, tax_withheld_units, price_per_unit
    FROM transactions WHERE id = ?
  `);

  function isWithinTolerance(existing, computed, toleranceFraction = 0.0001) {
    // Check if computed values are essentially the same as existing values
    const checkNum = (a, b) => {
      if (a == null && b == null) return true;
      if (a == null || b == null) return false;
      const aDec = Number(a);
      const bDec = Number(b);
      const maxDiff = Math.max(Math.abs(aDec), Math.abs(bDec)) * toleranceFraction;
      return Math.abs(aDec - bDec) <= Math.max(maxDiff, 0.0001);
    };

    return (
      checkNum(existing.gross_units, computed.gross_units)
      && checkNum(existing.units, computed.net_units)
      && checkNum(existing.tax_withheld_units, computed.tax_withheld_units)
      && checkNum(existing.price_per_unit, computed.price_per_unit)
    );
  }

  // Filter updates: skip those already matching within tolerance
  const effectiveUpdates = [];
  const skippedUpdates = [];

  for (const u of reconciliation.updates) {
    const existing = selectTxn.get(u.id);
    if (!existing) {
      effectiveUpdates.push(u);
      continue;
    }

    if (isWithinTolerance(existing, u)) {
      skippedUpdates.push({
        id: u.id,
        date: u.date,
        reason: 'already matches within tolerance',
        existing,
        computed: u,
      });
    } else {
      effectiveUpdates.push(u);
    }
  }

  console.log(`\n=== Tolerance Filter Results ===`);
  console.log(`Total reconciled: ${reconciliation.updates.length}`);
  console.log(`Would update: ${effectiveUpdates.length}`);
  console.log(`Already correct (skip): ${skippedUpdates.length}`);

  if (skippedUpdates.length > 0) {
    console.log('\nSkipped (already correct):');
    for (const s of skippedUpdates.slice(0, 5)) {
      console.log(`  id ${s.id}: gross=${s.existing.gross_units} net=${s.existing.units} withheld=${s.existing.tax_withheld_units} price=${s.existing.price_per_unit}`);
    }
    if (skippedUpdates.length > 5) console.log(`  ... and ${skippedUpdates.length - 5} more`);
  }

  if (effectiveUpdates.length > 0) {
    console.log('\nWould be updated:');
    for (const u of effectiveUpdates.slice(0, 5)) {
      const existing = selectTxn.get(u.id);
      console.log(`  id ${u.id} (${u.date}):`);
      console.log(`    gross: ${existing.gross_units} → ${u.gross_units}`);
      console.log(`    net:   ${existing.units} → ${u.net_units}`);
      console.log(`    wthold: ${existing.tax_withheld_units} → ${u.tax_withheld_units}`);
      console.log(`    price: ${existing.price_per_unit} → ${u.vest_price_usd}`);
    }
    if (effectiveUpdates.length > 5) console.log(`  ... and ${effectiveUpdates.length - 5} more`);
  }

  if (!apply || !effectiveUpdates.length) {
    console.log('\nPreview only. Re-run with --apply to persist changes.');
    process.exit(0);
  }

  const dates = Array.from(new Set(effectiveUpdates.map((u) => u.matched_lot_date || u.date)));
  const fxByDate = new Map();
  for (const date of dates) {
    let fx = null;
    if (inv.currency === 'USD') {
      try {
        fx = await fetchHistoricalUSDToINR(date);
      } catch (_) {
        fx = null;
      }
    }
    fxByDate.set(date, fx != null ? Number(fx) : null);
  }

  const updateTxn = db.prepare(`
    UPDATE transactions
    SET transaction_date = ?,
      units = ?,
        gross_units = ?,
        tax_withheld_units = ?,
        price_per_unit = ?,
        exchange_rate_used = ?,
        usd_amount = ?,
        amount = ?
    WHERE id = ?
  `);

  const applyAll = db.transaction(() => {
    for (const u of effectiveUpdates) {
      const existing = selectTxn.get(u.id);
      if (!existing) continue;

      const effectiveDate = u.matched_lot_date || u.date;

      const price = overwritePrice && u.vest_price_usd != null
        ? Number(u.vest_price_usd)
        : (existing.price_per_unit != null ? Number(existing.price_per_unit) : null);
      const fx = fxByDate.get(effectiveDate) != null
        ? Number(fxByDate.get(effectiveDate))
        : (existing.exchange_rate_used != null ? Number(existing.exchange_rate_used) : null);
      const usdAmount = price != null ? Number((u.gross_units * price).toFixed(4)) : null;
      const amount = usdAmount != null && fx != null ? Number((usdAmount * fx).toFixed(2)) : 0;

      updateTxn.run(
        effectiveDate,
        u.net_units,
        u.gross_units,
        u.tax_withheld_units,
        price,
        fx,
        usdAmount,
        amount,
        u.id,
      );
    }
  });

  applyAll();
  console.log(`\nApplied reconciliation to ${effectiveUpdates.length} VEST transactions (${skippedUpdates.length} already correct).`);
})();
