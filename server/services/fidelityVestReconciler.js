const XLSX = require('xlsx');

const MONTHS = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

function toNumber(value) {
  if (value === null || value === undefined) return null;
  const txt = String(value).replace(/,/g, '').trim();
  if (!txt || txt === '-') return null;
  const n = Number(txt);
  return Number.isFinite(n) ? n : null;
}

function parseDateToIso(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw || raw === '-') return null;

  // DEC/31/2021
  let m = raw.match(/^([A-Za-z]{3})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const mon = MONTHS[m[1].toLowerCase()];
    if (!mon) return null;
    const day = String(parseInt(m[2], 10)).padStart(2, '0');
    return `${m[3]}-${mon}-${day}`;
  }

  // Mar-31-2026
  m = raw.match(/^([A-Za-z]{3})-(\d{1,2})-(\d{4})$/);
  if (m) {
    const mon = MONTHS[m[1].toLowerCase()];
    if (!mon) return null;
    const day = String(parseInt(m[2], 10)).padStart(2, '0');
    return `${m[3]}-${mon}-${day}`;
  }

  // YYYY-MM-DD or parseable date fallback
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }
  return null;
}

function readRows(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', raw: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
}

function parseOpenLots(buffer) {
  const rows = readRows(buffer);
  const out = [];

  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i] || [];
    const acquiredDate = parseDateToIso(row[0]);
    const quantity = toNumber(row[1]);
    if (!acquiredDate || !quantity || quantity <= 0) continue;

    const costBasis = toNumber(row[2]);
    const costBasisPerShare = toNumber(row[3]);
    const shareSource = String(row[9] || '').trim().toUpperCase() || null;

    out.push({
      source_file: 'open',
      acquired_date: acquiredDate,
      quantity,
      cost_basis: costBasis,
      cost_basis_per_share: costBasisPerShare,
      share_source: shareSource,
      raw: row,
    });
  }

  return out;
}

function parseClosedLots(buffer) {
  const rows = readRows(buffer);
  const out = [];

  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i] || [];
    const acquiredDate = parseDateToIso(row[0]);
    const quantity = toNumber(row[1]);
    if (!acquiredDate || !quantity || quantity <= 0) continue;

    // Closed-lot export has these columns in data rows:
    // [date acquired, qty, date sold, proceeds, cost basis, gain/loss, term]
    const costBasis = toNumber(row[4]);
    const costBasisPerShare = costBasis && quantity ? Number((costBasis / quantity).toFixed(6)) : null;

    out.push({
      source_file: 'closed',
      acquired_date: acquiredDate,
      quantity,
      cost_basis: costBasis,
      cost_basis_per_share: costBasisPerShare,
      share_source: null,
      raw: row,
    });
  }

  return out;
}

function distributeByGrossUnits(items, totalNetUnits) {
  const totalGross = items.reduce((s, it) => s + it.gross_units, 0);
  if (totalGross <= 0) return items.map((it) => ({ ...it, net_units: it.gross_units }));

  let assigned = 0;
  const out = items.map((it, idx) => {
    let net = idx === items.length - 1
      ? Number((totalNetUnits - assigned).toFixed(4))
      : Number((totalNetUnits * (it.gross_units / totalGross)).toFixed(4));

    if (net < 0) net = 0;
    if (net > it.gross_units) net = it.gross_units;
    assigned += net;

    return {
      ...it,
      net_units: net,
      tax_withheld_units: Number((it.gross_units - net).toFixed(4)),
    };
  });

  return out;
}

function rowCostBasis(row) {
  if (row.cost_basis != null) return Number(row.cost_basis);
  if (row.cost_basis_per_share != null) return Number(row.cost_basis_per_share) * Number(row.quantity || 0);
  return null;
}

function aggregateRows(rows) {
  const agg = {
    net_units: 0,
    cost_basis_usd: 0,
    priced_units: 0,
    open_sp_units: 0,
    closed_units: 0,
  };

  for (const row of rows) {
    agg.net_units += Number(row.quantity || 0);
    const cb = rowCostBasis(row);
    if (cb != null) {
      agg.cost_basis_usd += cb;
      agg.priced_units += Number(row.quantity || 0);
    }
    if (row.source_file === 'open' && row.share_source === 'SP') agg.open_sp_units += Number(row.quantity || 0);
    if (row.source_file === 'closed') agg.closed_units += Number(row.quantity || 0);
  }

  agg.net_units = Number(agg.net_units.toFixed(4));
  agg.cost_basis_usd = Number(agg.cost_basis_usd.toFixed(6));
  agg.priced_units = Number(agg.priced_units.toFixed(4));
  agg.open_sp_units = Number(agg.open_sp_units.toFixed(4));
  agg.closed_units = Number(agg.closed_units.toFixed(4));
  return agg;
}

function selectBestSubset(rows, grossTotal) {
  const items = (rows || []).filter((r) => Number(r.quantity || 0) > 0);
  if (!items.length || !(grossTotal > 0)) return [];

  const scale = 10000;
  const capacity = Math.round(grossTotal * scale);

  const qty = items.map((r) => Math.round(Number(r.quantity || 0) * scale));
  const total = qty.reduce((s, q) => s + q, 0);
  if (total <= capacity) return items;

  // For typical lot counts per date, brute force is fast and gives exact best fit.
  if (items.length <= 20) {
    let bestMask = 0;
    let bestSum = 0;
    const n = items.length;
    const maxMask = 1 << n;
    for (let mask = 1; mask < maxMask; mask += 1) {
      let sum = 0;
      for (let i = 0; i < n; i += 1) {
        if (mask & (1 << i)) sum += qty[i];
      }
      if (sum <= capacity && sum > bestSum) {
        bestSum = sum;
        bestMask = mask;
      }
      if (bestSum === capacity) break;
    }

    if (bestMask === 0) return [];
    const chosen = [];
    for (let i = 0; i < n; i += 1) {
      if (bestMask & (1 << i)) chosen.push(items[i]);
    }
    return chosen;
  }

  // Fallback for unusually large row counts: greedy by quantity descending.
  const sorted = [...items].sort((a, b) => Number(b.quantity || 0) - Number(a.quantity || 0));
  let running = 0;
  const chosen = [];
  for (const row of sorted) {
    const q = Math.round(Number(row.quantity || 0) * scale);
    if (running + q <= capacity) {
      chosen.push(row);
      running += q;
    }
  }
  return chosen;
}

function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return isoDate;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dayDiff(fromIso, toIso) {
  const a = new Date(`${fromIso}T00:00:00Z`);
  const b = new Date(`${toIso}T00:00:00Z`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0;
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

function reconcileVestTransactions({ vestTransactions, openLotsRows, closedLotsRows, priceTolerancePct = 0.15 }) {
  const txns = Array.isArray(vestTransactions) ? vestTransactions : [];
  const byDate = new Map();

  for (const txn of txns) {
    const date = String(txn.transaction_date || '');
    if (!date) continue;
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push({
      id: txn.id,
      transaction_date: date,
      units: Number(txn.units) || 0,
      gross_units: Number(txn.gross_units) || Number(txn.units) || 0,
      price_per_unit: Number(txn.price_per_unit) || null,
      notes: txn.notes || null,
    });
  }

  const vestDates = new Set(byDate.keys());
  const candidateDates = new Set();
  for (const d of vestDates) {
    for (let offset = 0; offset <= 3; offset += 1) {
      candidateDates.add(addDays(d, offset));
    }
  }
  const rows = [...(openLotsRows || []), ...(closedLotsRows || [])];

  const lotRowsByDate = new Map();
  const skippedRows = [];

  for (const row of rows) {
    if (!candidateDates.has(row.acquired_date)) continue;

    const dateTxns = byDate.get(row.acquired_date) || [];
    const dateRefPrice = dateTxns.find((t) => t.price_per_unit)?.price_per_unit || null;
    const rowPrice = row.cost_basis_per_share || null;

    let include = true;
    let skipReason = null;

    // Open lots: prefer SP rows; for non-SP rows (e.g. DO), allow only when
    // price is close to vest FMV to avoid false matches.
    if (row.source_file === 'open' && row.share_source && row.share_source !== 'SP') {
      if (dateRefPrice && rowPrice) {
        const diffPct = Math.abs(rowPrice - dateRefPrice) / dateRefPrice;
        if (diffPct > priceTolerancePct) {
          include = false;
          skipReason = `open lot source ${row.share_source} price mismatch (${(diffPct * 100).toFixed(2)}%)`;
        }
      }
    }

    // Closed lots don't expose source, so use price proximity to vest FMV when available.
    if (include && row.source_file === 'closed' && dateRefPrice && rowPrice) {
      const diffPct = Math.abs(rowPrice - dateRefPrice) / dateRefPrice;
      if (diffPct > priceTolerancePct) {
        include = false;
        skipReason = `closed lot price mismatch (${(diffPct * 100).toFixed(2)}%)`;
      }
    }

    if (!include) {
      skippedRows.push({ acquired_date: row.acquired_date, quantity: row.quantity, reason: skipReason });
      continue;
    }

    if (!lotRowsByDate.has(row.acquired_date)) lotRowsByDate.set(row.acquired_date, []);
    lotRowsByDate.get(row.acquired_date).push(row);
  }

  const updates = [];
  const skippedDates = [];

  for (const [date, txnsForDate] of byDate.entries()) {
    const grossTotal = txnsForDate.reduce((s, t) => s + t.gross_units, 0);

    if (grossTotal <= 0) {
      skippedDates.push({ date, reason: 'gross units missing' });
      continue;
    }

    let bestCandidate = null;
    // Support weekend/holiday vesting: check same day and next 3 days.
    for (let offset = 0; offset <= 3; offset += 1) {
      const candidateDate = addDays(date, offset);
      const rowsForDate = lotRowsByDate.get(candidateDate) || [];
      if (!rowsForDate.length) continue;

      const aggAll = aggregateRows(rowsForDate);
      let selectedRows = rowsForDate;

      if (aggAll.net_units > grossTotal * 1.05) {
        selectedRows = selectBestSubset(rowsForDate, grossTotal);
      }

      const agg = aggregateRows(selectedRows);
      if (agg.net_units <= 0) continue;

      const diff = Math.abs(grossTotal - agg.net_units);
      const candidate = {
        candidateDate,
        selectedRows,
        agg,
        diff,
        offset,
      };

      if (!bestCandidate) {
        bestCandidate = candidate;
        continue;
      }

      if (candidate.diff < bestCandidate.diff) {
        bestCandidate = candidate;
      } else if (candidate.diff === bestCandidate.diff && candidate.offset < bestCandidate.offset) {
        bestCandidate = candidate;
      }
    }

    if (!bestCandidate) {
      skippedDates.push({ date, reason: 'no matching lots' });
      continue;
    }

    const agg = bestCandidate.agg;
    const matchedLotDate = bestCandidate.candidateDate;
    const netTotal = Number(agg.net_units.toFixed(4));

    if (netTotal <= 0) {
      skippedDates.push({ date, reason: 'no matching lots' });
      continue;
    }

    if (netTotal > grossTotal * 1.05) {
      skippedDates.push({
        date,
        reason: `actual net (${netTotal}) exceeds gross (${grossTotal}) by >5%`,
      });
      continue;
    }

    const weightedPrice = agg.priced_units > 0
      ? Number((agg.cost_basis_usd / agg.priced_units).toFixed(6))
      : null;

    const distributed = distributeByGrossUnits(txnsForDate, netTotal);
    for (const item of distributed) {
      updates.push({
        id: item.id,
        date,
        matched_lot_date: matchedLotDate,
        gross_units: Number(item.gross_units.toFixed(4)),
        net_units: Number(item.net_units.toFixed(4)),
        tax_withheld_units: Number(item.tax_withheld_units.toFixed(4)),
        vest_price_usd: weightedPrice,
        inferred_from_open_sp_units: Number(agg.open_sp_units.toFixed(4)),
        inferred_from_closed_units: Number(agg.closed_units.toFixed(4)),
      });
    }
  }

  return {
    updates,
    skipped_dates: skippedDates,
    skipped_rows: skippedRows,
    matched_dates: Array.from(new Set(updates.map((u) => u.date))).length,
    matched_txns: updates.length,
  };
}

module.exports = {
  parseOpenLots,
  parseClosedLots,
  reconcileVestTransactions,
};
