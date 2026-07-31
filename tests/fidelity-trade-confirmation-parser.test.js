const test = require('node:test');
const assert = require('node:assert/strict');
const { parseFidelityTradeConfirmationText } = require('../server/services/fidelityTradeConfirmationParser');

function confirmation({ quantity, gross, fee, net, transactionNumber, referenceNumber }) {
  return `YOU SOLD ${quantity} AT 450.3100
SECURITY DESCRIPTION SYMBOL: MSFT
MICROSOFT CORP $${gross}
$${fee}
-$${net}
I02946326 1 07-30-26 07-31-26 ${transactionNumber} 594918104
DETAILS:
Sale Date: JUL/30/2026
Proceeds Available: JUL/31/2026
Plan Type: COMPANY STOCK PLAN
FIDELITY STOCK PLAN SERVICES, LLC
REF # 26211-${referenceNumber}
PARTICIPANT NO.
I02946326
Sale Proceeds
Net Cash Proceeds
90015894
WI#`;
}

test('parses Fidelity whole-share sale and fee', () => {
  const parsed = parseFidelityTradeConfirmationText(confirmation({
    quantity: '28', gross: '12,608.68', fee: '0.26', net: '12,608.42',
    transactionNumber: 'NSW6QK', referenceNumber: 'NSW6QK',
  }), 'MSFT-Sell1.pdf');

  assert.equal(parsed.broker, 'Fidelity');
  assert.equal(parsed.participantId, 'I02946326');
  assert.equal(parsed.customerNumber, '90015894');
  assert.equal(parsed.tradeDate, '2026-07-30');
  assert.equal(parsed.settlementDate, '2026-07-31');
  assert.equal(parsed.transactionNumber, 'NSW6QK');
  assert.equal(parsed.cusip, '594918104');
  assert.deepEqual(parsed.trades[0], {
    tradeDate: '2026-07-30', settlementDate: '2026-07-31', security: 'MICROSOFT CORP',
    ticker: 'MSFT', cusip: '594918104', type: 'SELL', quantity: 28, rate: 450.31,
    total: 12608.68, grossProceedsUsd: 12608.68, feesUsd: 0.26, netProceedsUsd: 12608.42,
    transactionNumber: 'NSW6QK', referenceNumber: '26211-NSW6QK',
  });
  assert.equal(parsed.charges.total, 0.26);
});

test('parses Fidelity fractional-share sale with zero fee', () => {
  const parsed = parseFidelityTradeConfirmationText(confirmation({
    quantity: '.791', gross: '356.20', fee: '0.00', net: '356.20',
    transactionNumber: 'Q8X6M3', referenceNumber: 'Q8X6M3',
  }), 'MSFT-Sell2.pdf');

  assert.equal(parsed.trades[0].quantity, 0.791);
  assert.equal(parsed.trades[0].grossProceedsUsd, 356.2);
  assert.equal(parsed.trades[0].feesUsd, 0);
  assert.equal(parsed.trades[0].netProceedsUsd, 356.2);
  assert.equal(parsed.trades[0].transactionNumber, 'Q8X6M3');
});