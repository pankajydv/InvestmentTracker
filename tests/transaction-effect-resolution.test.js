const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { resolveClassificationEffect } = require('../server/services/transactionEffectPolicy');

describe('canonical classification effect resolution', () => {
  it('treats acquisitions as basis plus units', () => {
    const effect = resolveClassificationEffect('BUY', { amount: 1000, fees: 25, units: 10, assetType: 'INDIAN_STOCK' });
    assert.deepEqual(effect, { unitsDelta: 10, basisDelta: 1025, proceedsDelta: 0, internal: false, reviewStatus: 'APPROVED' });
  });

  it('treats contributions as basis without units', () => {
    const effect = resolveClassificationEffect('ESPP_CONTRIBUTION', { amount: 500, fees: 0, units: 0, assetType: 'FOREIGN_STOCK' });
    assert.equal(effect.basisDelta, 500);
    assert.equal(effect.unitsDelta, 0);
    assert.equal(effect.proceedsDelta, 0);
  });

  it('treats disposals as proceeds net of fees and reduces units', () => {
    const effect = resolveClassificationEffect('SELL', { amount: 2000, fees: 30, units: 5, assetType: 'INDIAN_STOCK' });
    assert.equal(effect.unitsDelta, -5);
    assert.equal(effect.proceedsDelta, 1970);
    assert.equal(effect.basisDelta, 0);
  });

  it('keeps internal transfers and switches out of proceeds by direction', () => {
    const transferIn = resolveClassificationEffect('TRANSFER_IN', { amount: 100, units: 2, assetType: 'MUTUAL_FUND' });
    assert.equal(transferIn.basisDelta, 100);
    assert.equal(transferIn.unitsDelta, 2);
    assert.equal(transferIn.internal, true);

    const switchOut = resolveClassificationEffect('SWITCH_OUT', { amount: 100, units: 2, assetType: 'MUTUAL_FUND' });
    assert.equal(switchOut.proceedsDelta, 100);
    assert.equal(switchOut.unitsDelta, -2);
    assert.equal(switchOut.internal, true);
  });

  it('splits INTEREST by product: external is proceeds, provident is internal accrual', () => {
    const bond = resolveClassificationEffect('INTEREST', { amount: 900, assetType: 'BOND' });
    assert.equal(bond.proceedsDelta, 900);

    for (const assetType of ['PF', 'PPF', 'SSY']) {
      const provident = resolveClassificationEffect('INTEREST', { amount: 900, assetType });
      assert.equal(provident.proceedsDelta, 0);
      assert.equal(provident.basisDelta, 0);
    }
  });

  it('keeps TDS, RECONCILE, BONUS, and SPLIT out of basis and proceeds', () => {
    for (const transactionType of ['TDS', 'RECONCILE']) {
      const effect = resolveClassificationEffect(transactionType, { amount: 1000, units: 0, assetType: 'PF' });
      assert.equal(effect.basisDelta, 0);
      assert.equal(effect.proceedsDelta, 0);
      assert.equal(effect.unitsDelta, 0);
    }

    const bonus = resolveClassificationEffect('BONUS', { amount: 0, units: 7, assetType: 'INDIAN_STOCK' });
    assert.equal(bonus.unitsDelta, 7);
    assert.equal(bonus.basisDelta, 0);
    assert.equal(bonus.proceedsDelta, 0);
  });
});
