const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  EXTERNAL_CASH_IN_TYPES,
  EXTERNAL_CASH_OUT_TYPES,
  EXTERNAL_CASH_ABS_NEGATIVE_TYPES,
  toSqlInList,
} = require('../server/services/transactionEffectPolicy');

// Locks the day-change capital-flow lens so the consolidated consumers stay
// behavior-neutral with the historical inline lists.
describe('day-change capital-flow lens', () => {
  it('matches the approved capital-in and capital-out membership exactly', () => {
    assert.deepEqual([...EXTERNAL_CASH_IN_TYPES], [
      'BUY', 'DEPOSIT', 'IPO', 'RIGHTS', 'TRANSFER_IN', 'SWITCH_IN',
      'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'ESPP_CONTRIBUTION', 'VEST',
    ]);
    assert.deepEqual([...EXTERNAL_CASH_OUT_TYPES], [
      'SELL', 'REDEMPTION', 'WITHDRAWAL', 'TRANSFER_OUT', 'SWITCH_OUT', 'CHARGES', 'AMC',
    ]);
    assert.deepEqual([...EXTERNAL_CASH_ABS_NEGATIVE_TYPES], ['TDS']);
  });

  it('excludes income and non-basis events from the capital-flow lens', () => {
    for (const type of ['DIVIDEND', 'INTEREST', 'ESPP_PURCHASE', 'BONUS', 'SPLIT', 'RECONCILE']) {
      assert.equal(EXTERNAL_CASH_IN_TYPES.includes(type), false, `${type} not cash-in`);
      assert.equal(EXTERNAL_CASH_OUT_TYPES.includes(type), false, `${type} not cash-out`);
    }
  });

  it('treats a recorded-cost RSU vest as performance-neutral capital introduced', () => {
    assert.equal(EXTERNAL_CASH_IN_TYPES.includes('VEST'), true);
    assert.equal(EXTERNAL_CASH_OUT_TYPES.includes('VEST'), false);
  });

  it('produces a safe SQL IN list', () => {
    assert.equal(toSqlInList(['BUY', 'SELL']), "'BUY', 'SELL'");
    assert.equal(toSqlInList(["O'X"]), "'O''X'");
  });
});
