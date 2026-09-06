const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveClassificationEffect,
  listTransactionEffectRules,
} = require('../server/services/transactionEffectPolicy');

// Standard probe: amount 1000, fees 10, units 5. Basis includes fees (1010),
// proceeds are net of fees (990). Expectations are the canonical classification,
// which may intentionally differ from legacy behavior for review types.
const CTX = { amount: 1000, fees: 10, units: 5, assetType: 'INDIAN_STOCK' };

const EXPECTED = {
  BUY: { unitsDelta: 5, basisDelta: 1010, proceedsDelta: 0 },
  DEPOSIT: { unitsDelta: 5, basisDelta: 1010, proceedsDelta: 0 },
  IPO: { unitsDelta: 5, basisDelta: 1010, proceedsDelta: 0 },
  RIGHTS: { unitsDelta: 5, basisDelta: 1010, proceedsDelta: 0 },
  EMPLOYER_CONTRIBUTION: { unitsDelta: 5, basisDelta: 1010, proceedsDelta: 0 },
  VOLUNTARY_CONTRIBUTION: { unitsDelta: 5, basisDelta: 1010, proceedsDelta: 0 },
  VEST: { unitsDelta: 5, basisDelta: 1010, proceedsDelta: 0 },
  ESPP_CONTRIBUTION: { unitsDelta: 0, basisDelta: 1010, proceedsDelta: 0 },
  EPS_CONTRIBUTION: { unitsDelta: 0, basisDelta: 1010, proceedsDelta: 0 },
  ESPP_PURCHASE: { unitsDelta: 5, basisDelta: 1010, proceedsDelta: 0 },
  TRANSFER_IN: { unitsDelta: 5, basisDelta: 1010, proceedsDelta: 0 },
  SWITCH_IN: { unitsDelta: 5, basisDelta: 1010, proceedsDelta: 0 },
  SELL: { unitsDelta: -5, basisDelta: 0, proceedsDelta: 990 },
  REDEMPTION: { unitsDelta: -5, basisDelta: 0, proceedsDelta: 990 },
  WITHDRAWAL: { unitsDelta: -5, basisDelta: 0, proceedsDelta: 990 },
  TRANSFER_OUT: { unitsDelta: -5, basisDelta: 0, proceedsDelta: 990 },
  SWITCH_OUT: { unitsDelta: -5, basisDelta: 0, proceedsDelta: 990 },
  DIVIDEND: { unitsDelta: 0, basisDelta: 0, proceedsDelta: 990 },
  INTEREST: { unitsDelta: 0, basisDelta: 0, proceedsDelta: 990 },
  BONUS: { unitsDelta: 5, basisDelta: 0, proceedsDelta: 0 },
  SPLIT: { unitsDelta: 5, basisDelta: 0, proceedsDelta: 0 },
  AMC: { unitsDelta: -5, basisDelta: 0, proceedsDelta: 0 },
  CHARGES: { unitsDelta: -5, basisDelta: 0, proceedsDelta: 0 },
  TDS: { unitsDelta: 0, basisDelta: 0, proceedsDelta: 0 },
  RECONCILE: { unitsDelta: 0, basisDelta: 0, proceedsDelta: 0 },
  MERGER: { unitsDelta: 0, basisDelta: 0, proceedsDelta: 0 },
  CONSOLIDATION: { unitsDelta: 0, basisDelta: 0, proceedsDelta: 0 },
  TRANSFER: { unitsDelta: 0, basisDelta: 0, proceedsDelta: 0 },
};

describe('canonical classification matrix (every supported type)', () => {
  it('covers every supported transaction type with an expectation', () => {
    const policyTypes = listTransactionEffectRules().map((r) => r.transactionType).sort();
    assert.deepEqual(policyTypes, Object.keys(EXPECTED).sort());
  });

  for (const [type, expected] of Object.entries(EXPECTED)) {
    it(`classifies ${type} on a market asset`, () => {
      const effect = resolveClassificationEffect(type, CTX);
      assert.equal(effect.unitsDelta, expected.unitsDelta, `${type} unitsDelta`);
      assert.equal(effect.basisDelta, expected.basisDelta, `${type} basisDelta`);
      assert.equal(effect.proceedsDelta, expected.proceedsDelta, `${type} proceedsDelta`);
    });
  }

  it('splits INTEREST by product across all asset types', () => {
    for (const assetType of ['BOND', 'SGB', 'FOREIGN_STOCK', 'INDIAN_STOCK', 'MUTUAL_FUND', 'NPS']) {
      assert.equal(resolveClassificationEffect('INTEREST', { ...CTX, assetType }).proceedsDelta, 990, `${assetType} interest is proceeds`);
    }
    for (const assetType of ['PF', 'PPF', 'SSY']) {
      const effect = resolveClassificationEffect('INTEREST', { ...CTX, assetType });
      assert.equal(effect.proceedsDelta, 0, `${assetType} interest is internal`);
      assert.equal(effect.basisDelta, 0);
    }
  });
});
