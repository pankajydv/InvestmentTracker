// Test the CAS parser with the sample PDF
const fs = require('fs');
const path = require('path');
const { parseCAS } = require('../server/services/casParser');

async function test() {
  const pdfPath = 'D:\\Downloads\\JAN2026_AA09934529_TXN.pdf';
  
  if (!fs.existsSync(pdfPath)) {
    console.error('PDF not found at:', pdfPath);
    process.exit(1);
  }

  const buffer = fs.readFileSync(pdfPath);
  console.log('PDF size:', buffer.length, 'bytes');
  
  try {
    const result = await parseCAS(buffer, 'ABHPY9828Q');
    
    console.log('\n=== CAS Parse Results ===');
    console.log('Investor:', result.investorName);
    console.log('Portfolio Value:', result.portfolioValue);
    console.log('\nSummary:', result.summary);
    
    console.log('\n--- STOCKS ---');
    for (const s of result.stocks) {
      console.log(`  ${s.isin} | ${s.name} | ${s.units} units @ ₹${s.price} = ₹${s.value}`);
    }
    
    console.log('\n--- MUTUAL FUNDS ---');
    for (const mf of result.mutualFunds) {
      const src = mf.source === 'demat' ? '[DEMAT]' : `[RTA folio:${mf.folio}]`;
      console.log(`  ${src} ${mf.isin} | ${mf.name} | ${mf.units} units @ ₹${mf.nav || mf.price} = ₹${mf.value}`);
    }
    
    console.log('\n--- BONDS ---');
    for (const b of result.bonds) {
      console.log(`  ${b.isin} | ${b.name} | ${b.quantity} @ ₹${b.marketValue} = ₹${b.value}`);
    }
    
  } catch (e) {
    console.error('Parse error:', e.message);
    console.error(e.stack);
  }
}

test();
