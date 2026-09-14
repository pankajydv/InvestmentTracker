const test = require('node:test');
const assert = require('node:assert/strict');

const { parseRsuGrantDocument, generateRsuSchedule } = require('../server/services/rsuGrantService');

test('parses an arbitrary Microsoft award document without a catalog entry', () => {
  const html = `
    <html><body>
      Award Number 0000009999999
      on 08/31/2026 (the &ldquo;Award Date&rdquo;) hereby award to Employee
      100 Stock Awards (&ldquo;SAs&rdquo;)
      5.0000% 3 months from Award Date
      5.0000% 6 months from Award Date
    </body></html>
  `;

  const grant = parseRsuGrantDocument(Buffer.from(html), 'arbitrary-award.doc');
  assert.equal(grant.key, 'AWARD_0000009999999');
  assert.equal(grant.label, 'Microsoft Stock Award (SA)');
  assert.equal(grant.awardDate, '2026-08-31');
  assert.equal(grant.totalShares, 100);
  assert.deepEqual(grant.plan, [
    { vestDate: '2026-11-30', months: 3, percent: 5 },
    { vestDate: '2027-03-01', months: 6, percent: 5 },
  ]);

  const schedule = generateRsuSchedule({ grants: [grant], includeFuture: true });
  assert.equal(schedule.totals.all_units, 10);
  assert.equal(schedule.rows[0].award_number, '0000009999999');
});

test('distributes rounded annual RSU shares across vesting tranches', () => {
  const html = `
    <html><body>
      Award Number 0000004166020
      on 08/31/2026 (the &ldquo;Award Date&rdquo;) hereby award to Employee
      91 Stock Awards (&ldquo;SAs&rdquo;)
      ${Array.from({ length: 20 }, (_, index) => `5.0000% ${index * 3 + 3} months from Award Date`).join(' ')}
      2026 STOCK PLAN Non-US Annual Agreement
    </body></html>
  `;

  const grant = parseRsuGrantDocument(Buffer.from(html), 'annual-award.doc');
  const schedule = generateRsuSchedule({ grants: [grant], includeFuture: true });
  const units = schedule.rows.map((row) => row.units);

  assert.deepEqual(units.slice(0, 4), [5, 4, 5, 4]);
  assert.equal(units.at(-1), 5);
  assert.equal(schedule.totals.all_units, 91);
});