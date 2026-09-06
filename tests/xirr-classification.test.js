const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  isInternalXirrCashflow,
  isAccrualOnlyXirrCashflow,
  XIRR_OUTFLOW_TYPES,
  XIRR_INFLOW_TYPES,
} = require('../server/services/xirrClassification');

describe('shared XIRR classification (policy-backed)', () => {
  it('classifies acquisition-side types as outflow and disposal-side as inflow', () => {
    for (const type of ['BUY', 'VEST', 'IPO', 'TRANSFER_IN', 'SWITCH_IN', 'RIGHTS', 'ESPP_CONTRIBUTION', 'CHARGES', 'AMC']) {
      assert.equal(XIRR_OUTFLOW_TYPES.has(type), true, `${type} should be outflow`);
      assert.equal(XIRR_INFLOW_TYPES.has(type), false, `${type} should not be inflow`);
    }
    for (const type of ['SELL', 'REDEMPTION', 'WITHDRAWAL', 'TRANSFER_OUT', 'SWITCH_OUT', 'DIVIDEND', 'INTEREST']) {
      assert.equal(XIRR_INFLOW_TYPES.has(type), true, `${type} should be inflow`);
      assert.equal(XIRR_OUTFLOW_TYPES.has(type), false, `${type} should not be outflow`);
    }
  });

  it('does not classify no-cash corporate actions as either direction', () => {
    for (const type of ['BONUS', 'SPLIT', 'MERGER', 'CONSOLIDATION']) {
      assert.equal(XIRR_OUTFLOW_TYPES.has(type), false);
      assert.equal(XIRR_INFLOW_TYPES.has(type), false);
    }
  });

  it('treats interest, TDS, and reconcile as internal only for provident assets', () => {
    for (const assetType of ['PF', 'PPF', 'SSY']) {
      assert.equal(isInternalXirrCashflow(assetType, 'INTEREST'), true);
      assert.equal(isInternalXirrCashflow(assetType, 'TDS'), true);
      assert.equal(isInternalXirrCashflow(assetType, 'RECONCILE'), true);
      assert.equal(isInternalXirrCashflow(assetType, 'DEPOSIT'), false);
      assert.equal(isInternalXirrCashflow(assetType, 'WITHDRAWAL'), false);
    }
  });

  it('never treats non-provident asset flows as internal', () => {
    for (const assetType of ['INDIAN_STOCK', 'MUTUAL_FUND', 'FOREIGN_STOCK', 'BOND', 'SGB', 'NPS']) {
      assert.equal(isInternalXirrCashflow(assetType, 'INTEREST'), false);
      assert.equal(isInternalXirrCashflow(assetType, 'TDS'), false);
      assert.equal(isInternalXirrCashflow(assetType, 'RECONCILE'), false);
    }
  });

  it('flags accrual-only interest by note marker', () => {
    assert.equal(isAccrualOnlyXirrCashflow('INTEREST', 'auto_accrual_internal credit'), true);
    assert.equal(isAccrualOnlyXirrCashflow('INTEREST', 'ACCRUAL_ONLY_INTERNAL'), true);
    assert.equal(isAccrualOnlyXirrCashflow('INTEREST', 'regular payout'), false);
    assert.equal(isAccrualOnlyXirrCashflow('DIVIDEND', 'AUTO_ACCRUAL_INTERNAL'), false);
  });
});
