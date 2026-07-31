const EPSILON = 0.0001;

function explicitLotKey(txn) {
  const text = String(txn?.notes || '');
  const acquiredDate = text.match(/Acquired\s+(\d{4}-\d{2}-\d{2})/i)?.[1];
  if (!acquiredDate) return null;

  if (/^ESPP Sale\s*\|/i.test(text)) return `ESPP|${acquiredDate}`;

  const award = text.match(/Award\s+(\d+)/i)?.[1];
  const tranche = text.match(/Tranche\s+(\d+\/\d+)/i)?.[1];
  return award && tranche ? `VEST|${acquiredDate}|${award}|${tranche}` : null;
}

function acquisitionLotKey(txn) {
  if (txn?.transaction_type === 'ESPP_PURCHASE') return `ESPP|${txn.transaction_date}`;
  if (txn?.transaction_type !== 'VEST') return null;

  const text = String(txn.notes || '');
  const award = text.match(/Award\s+(\d+)/i)?.[1];
  const tranche = text.match(/Tranche\s+(\d+\/\d+)/i)?.[1];
  return award && tranche ? `VEST|${txn.transaction_date}|${award}|${tranche}` : null;
}

export function allocateForeignStockSoldUnits(transactions) {
  const soldByTransactionId = {};
  const lots = [];
  const lotsByKey = new Map();
  const ordered = [...(transactions || [])].sort((left, right) =>
    String(left.transaction_date || '').localeCompare(String(right.transaction_date || ''))
      || Number(left.id || 0) - Number(right.id || 0));

  const allocate = (lot, requestedUnits) => {
    const soldUnits = Math.min(lot.remainingUnits, requestedUnits);
    lot.remainingUnits -= soldUnits;
    soldByTransactionId[lot.transactionId] = (soldByTransactionId[lot.transactionId] || 0) + soldUnits;
    return requestedUnits - soldUnits;
  };

  for (const txn of ordered) {
    const units = Number(txn.units || 0);
    const lotKey = acquisitionLotKey(txn);
    if (lotKey && units > EPSILON) {
      const lot = { transactionId: txn.id, remainingUnits: units };
      lots.push(lot);
      lotsByKey.set(lotKey, lot);
      continue;
    }

    if (txn.transaction_type !== 'SELL' || units <= EPSILON) continue;

    const referencedLot = lotsByKey.get(explicitLotKey(txn));
    if (referencedLot) {
      allocate(referencedLot, units);
      continue;
    }

    let remainingToAllocate = units;
    for (const lot of lots) {
      if (remainingToAllocate <= EPSILON) break;
      if (lot.remainingUnits <= EPSILON) continue;
      remainingToAllocate = allocate(lot, remainingToAllocate);
    }
  }

  return soldByTransactionId;
}

export function isForeignStockLotFullySold(txn, soldByTransactionId) {
  if (!txn || (txn.transaction_type !== 'VEST' && txn.transaction_type !== 'ESPP_PURCHASE')) return false;
  const units = Number(txn.units || 0);
  const soldUnits = Number(soldByTransactionId?.[txn.id] || 0);
  return units > EPSILON && soldUnits >= units - EPSILON;
}