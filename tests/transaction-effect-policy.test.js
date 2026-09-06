const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  EFFECT,
  REVIEW_STATUS,
  getTransactionEffectRule,
  listTransactionEffectRules,
  resolveClassificationEffect,
} = require('../server/services/transactionEffectPolicy');

const SUPPORTED_TRANSACTION_TYPES = [
  'BUY', 'SELL', 'DEPOSIT', 'WITHDRAWAL', 'DIVIDEND', 'INTEREST', 'RECONCILE', 'TDS',
  'SPLIT', 'BONUS', 'RIGHTS', 'MERGER', 'CONSOLIDATION', 'IPO', 'TRANSFER_IN',
  'TRANSFER_OUT', 'TRANSFER', 'SWITCH_IN', 'SWITCH_OUT', 'EMPLOYER_CONTRIBUTION',
  'VOLUNTARY_CONTRIBUTION', 'CHARGES', 'AMC', 'REDEMPTION', 'ESPP_CONTRIBUTION',
  'VEST', 'ESPP_PURCHASE', 'EPS_CONTRIBUTION',
];

describe('canonical transaction effect policy', () => {
  it('classifies every supported transaction type exactly once', () => {
    const policyTypes = listTransactionEffectRules().map(({ transactionType }) => transactionType).sort();
    assert.deepEqual(policyTypes, [...SUPPORTED_TRANSACTION_TYPES].sort());
  });

  it('keeps transfers and switches out of portfolio cash movement', () => {
    for (const transactionType of ['TRANSFER_IN', 'TRANSFER_OUT', 'SWITCH_IN', 'SWITCH_OUT']) {
      const effectRule = getTransactionEffectRule(transactionType);
      assert.equal(effectRule.internal, true);
      assert.equal(effectRule.portfolio, EFFECT.NONE);
    }

    assert.equal(getTransactionEffectRule('switch_in').attribution, EFFECT.BASIS);
    assert.equal(getTransactionEffectRule('SWITCH_OUT').attribution, EFFECT.PROCEEDS);
  });

  it('treats disposals, dividends, and withdrawals as portfolio proceeds', () => {
    for (const transactionType of ['SELL', 'REDEMPTION', 'WITHDRAWAL', 'DIVIDEND']) {
      assert.equal(getTransactionEffectRule(transactionType).portfolio, EFFECT.PROCEEDS);
    }
  });

  it('marks product-dependent and unresolved legacy semantics for review', () => {
    for (const transactionType of [
      'TRANSFER', 'MERGER', 'CONSOLIDATION',
    ]) {
      const effectRule = getTransactionEffectRule(transactionType);
      assert.equal(effectRule.reviewStatus, REVIEW_STATUS.REVIEW_REQUIRED);
      assert.ok(effectRule.reviewReason);
    }
  });

  it('marks the confirmed valuation-lens types as approved', () => {
    for (const transactionType of ['VEST', 'ESPP_PURCHASE', 'INTEREST', 'RECONCILE', 'TDS', 'CHARGES', 'AMC', 'EPS_CONTRIBUTION']) {
      assert.equal(getTransactionEffectRule(transactionType).reviewStatus, REVIEW_STATUS.APPROVED);
    }
  });

  it('treats approved CHARGES as unit cancellation like AMC', () => {
    const effect = resolveClassificationEffect('CHARGES', { amount: 50, units: 0.25, assetType: 'NPS' });
    assert.equal(effect.unitsDelta, -0.25);
    assert.equal(effect.basisDelta, 0);
    assert.equal(effect.proceedsDelta, 0);
  });

  it('treats approved AMC as unit cancellation, not a separate expense', () => {
    const effect = resolveClassificationEffect('AMC', { amount: 100, units: 0.5, assetType: 'NPS' });
    assert.equal(getTransactionEffectRule('AMC').reviewStatus, REVIEW_STATUS.APPROVED);
    assert.equal(effect.unitsDelta, -0.5);
    assert.equal(effect.basisDelta, 0);
    assert.equal(effect.proceedsDelta, 0);
  });

  it('treats approved EPS_CONTRIBUTION as basis without units', () => {
    const effect = resolveClassificationEffect('EPS_CONTRIBUTION', { amount: 1250, units: 0, assetType: 'PF' });
    assert.equal(getTransactionEffectRule('EPS_CONTRIBUTION').reviewStatus, REVIEW_STATUS.APPROVED);
    assert.equal(effect.basisDelta, 1250);
    assert.equal(effect.unitsDelta, 0);
    assert.equal(effect.proceedsDelta, 0);
  });

  it('returns immutable rules and rejects unknown types', () => {
    const buyRule = getTransactionEffectRule('BUY');
    assert.equal(Object.isFrozen(buyRule), true);
    assert.throws(() => getTransactionEffectRule('UNKNOWN'), /Unsupported transaction type/);
    assert.throws(() => getTransactionEffectRule(), /Unsupported transaction type/);
  });
});