/**
 * Parse Anju's CDSL CAS PDF and compare stock holdings with DB
 * to find missing BUY transactions.
 */
const fs = require('fs');
const path = require('path');
const { parseCAS } = require('../server/services/casParser');
const db = require('better-sqlite3')('./data/investments.db');

const CAS_PATH = 'D:\\Downloads\\MAY2025_AA02249235_TXN.pdf';
const PASSWORD = 'ABTPY0766H'; // Anju's PAN
const PORTFOLIO_ID = 1; // Anju Yadav

(async () => {
  console.log('=== Parsing CDSL CAS PDF ===');
  console.log('File:', CAS_PATH);
  
  const pdfBuffer = fs.readFileSync(CAS_PATH);
  const result = await parseCAS(pdfBuffer, PASSWORD);
  
  console.log('\nInvestor:', result.investorName);
  console.log('Portfolio Value:', result.portfolioValue);
  console.log('Stocks found:', result.stocks.length);
  console.log('MFs found:', result.mutualFunds.length, '(skipping)');
  console.log('Bonds found:', result.bonds.length);
  
  console.log('\n=== CAS Stock Holdings ===');
  for (const s of result.stocks) {
    console.log(`  ${s.isin} | ${s.name} | ${s.units} units | Rs ${s.value}`);
  }
  
  // Get current DB state for Anju's stocks
  console.log('\n=== Comparing with DB (portfolio_id=1) ===');
  
  const dbInvestments = db.prepare(`
    SELECT i.id, i.name, i.notes,
      COALESCE(SUM(CASE 
        WHEN t.transaction_type IN ('BUY','BONUS','SPLIT','IPO','TRANSFER_IN','RIGHTS') THEN t.units 
        WHEN t.transaction_type IN ('SELL','TRANSFER_OUT') THEN -t.units 
        ELSE 0 END), 0) as net_units
    FROM investments i
    LEFT JOIN transactions t ON t.investment_id = i.id
    WHERE i.portfolio_id = ?
      AND i.asset_type = 'INDIAN_STOCK'
    GROUP BY i.id
  `).all(PORTFOLIO_ID);
  
  // Build a map of ISIN -> DB investment
  const dbByIsin = new Map();
  const dbByName = new Map();
  for (const inv of dbInvestments) {
    const isinMatch = inv.notes?.match(/ISIN:\s*(INE\w+)/);
    if (isinMatch) {
      dbByIsin.set(isinMatch[1], inv);
    }
    dbByName.set(inv.name.toUpperCase().trim(), inv);
  }
  
  const missing = [];
  const mismatched = [];
  
  for (const casStock of result.stocks) {
    const dbMatch = dbByIsin.get(casStock.isin);
    
    if (!dbMatch) {
      // Stock exists in CAS but not in DB at all
      missing.push({ ...casStock, reason: 'NOT_IN_DB' });
    } else if (Math.abs(dbMatch.net_units - casStock.units) > 0.001) {
      // Stock exists but unit count differs
      mismatched.push({
        ...casStock,
        db_id: dbMatch.id,
        db_name: dbMatch.name,
        db_units: dbMatch.net_units,
        diff: casStock.units - dbMatch.net_units
      });
    }
  }
  
  if (missing.length > 0) {
    console.log('\n--- MISSING from DB (new stocks to add) ---');
    for (const m of missing) {
      console.log(`  ${m.isin} | ${m.name} | ${m.units} units | Rs ${m.value}`);
    }
  }
  
  if (mismatched.length > 0) {
    console.log('\n--- MISMATCHED units (need adjustment) ---');
    for (const m of mismatched) {
      console.log(`  ${m.isin} | ${m.name}`);
      console.log(`    CAS: ${m.units} units | DB (${m.db_name}): ${m.db_units} units | Diff: ${m.diff > 0 ? '+' : ''}${m.diff}`);
    }
  }
  
  if (missing.length === 0 && mismatched.length === 0) {
    console.log('\nAll CAS stocks match the DB! Nothing to add.');
  }
  
  // Also show DB stocks not in CAS (sold/fully exited - should have net 0)
  const casIsins = new Set(result.stocks.map(s => s.isin));
  const exitedButNonZero = dbInvestments.filter(inv => {
    const isinMatch = inv.notes?.match(/ISIN:\s*(INE\w+)/);
    return isinMatch && !casIsins.has(isinMatch[1]) && Math.abs(inv.net_units) > 0.001;
  });
  
  if (exitedButNonZero.length > 0) {
    console.log('\n--- DB stocks NOT in CAS but with non-zero balance ---');
    for (const e of exitedButNonZero) {
      console.log(`  ${e.name} | DB net: ${e.net_units} (should be 0)`);
    }
  }
  
  db.close();
})().catch(err => {
  console.error('Error:', err.message);
  db.close();
  process.exit(1);
});
