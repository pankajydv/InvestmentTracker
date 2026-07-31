import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allocateForeignStockSoldUnits,
  isForeignStockLotFullySold,
} from '../client/src/utils/foreignStockLots.js';

test('allocates referenced sales to their lots and generic sales FIFO', () => {
  const transactions = [
    { id: 1, transaction_date: '2022-01-01', transaction_type: 'VEST', units: 4, notes: 'RSU Vest | Grant A | Award 100 | Tranche 1/2' },
    { id: 2, transaction_date: '2022-03-31', transaction_type: 'ESPP_PURCHASE', units: 3, notes: 'ESPP Purchase | ESPP' },
    { id: 3, transaction_date: '2023-01-01', transaction_type: 'VEST', units: 5, notes: 'RSU Vest | Grant B | Award 200 | Tranche 1/2' },
    { id: 4, transaction_date: '2024-01-01', transaction_type: 'SELL', units: 5, notes: 'RSU Sale | Grant B | Acquired 2023-01-01 | Award 200 | Tranche 1/2' },
    { id: 5, transaction_date: '2025-01-01', transaction_type: 'SELL', units: 5, notes: 'Fidelity Transaction ABC123' },
  ];

  const sold = allocateForeignStockSoldUnits(transactions);

  assert.deepEqual(sold, { 1: 4, 2: 1, 3: 5 });
  assert.equal(isForeignStockLotFullySold(transactions[0], sold), true);
  assert.equal(isForeignStockLotFullySold(transactions[1], sold), false);
  assert.equal(isForeignStockLotFullySold(transactions[2], sold), true);
});

test('does not allocate a sale to future acquisition lots', () => {
  const transactions = [
    { id: 1, transaction_date: '2024-01-01', transaction_type: 'SELL', units: 2, notes: 'Fidelity Transaction EARLY' },
    { id: 2, transaction_date: '2024-02-01', transaction_type: 'VEST', units: 2, notes: 'RSU Vest | Grant | Award 100 | Tranche 1/2' },
  ];

  assert.deepEqual(allocateForeignStockSoldUnits(transactions), {});
});