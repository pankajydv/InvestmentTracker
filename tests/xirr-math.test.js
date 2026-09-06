const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { computeXirrRate } = require('../server/services/xirrMath');

const daysFromEpoch = (iso) => new Date(`${iso}T00:00:00.000Z`);

describe('xirrMath.computeXirrRate (robust bisection)', () => {
  it('returns null without both an inflow and an outflow', () => {
    assert.equal(computeXirrRate([{ date: daysFromEpoch('2020-01-01'), amount: -100 }]), null);
    assert.equal(computeXirrRate([
      { date: daysFromEpoch('2020-01-01'), amount: 100 },
      { date: daysFromEpoch('2021-01-01'), amount: 200 },
    ]), null);
  });

  it('solves a simple one-year 10% return', () => {
    const rate = computeXirrRate([
      { date: daysFromEpoch('2020-01-01'), amount: -1000 },
      { date: daysFromEpoch('2021-01-01'), amount: 1100 },
    ]);
    assert.ok(rate != null);
    assert.ok(Math.abs(rate - 0.10) < 0.005, `expected ~0.10, got ${rate}`);
  });

  it('converges on a multi-flow schedule the npm library rejected', () => {
    const rate = computeXirrRate([
      { date: daysFromEpoch('2021-01-01'), amount: -100000 },
      { date: daysFromEpoch('2021-06-01'), amount: -50000 },
      { date: daysFromEpoch('2022-01-01'), amount: -30000 },
      { date: daysFromEpoch('2023-01-01'), amount: 220000 },
    ]);
    assert.ok(rate != null && Number.isFinite(rate));
  });
});
