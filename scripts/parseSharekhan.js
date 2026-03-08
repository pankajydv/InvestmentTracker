/**
 * Parse all Sharekhan contract note HTM files from E:\Finance\Investments\Sharekhan
 * and output a summary of all trades for review before importing.
 */
const fs = require('fs');
const path = require('path');

const BASE_DIR = 'E:/Finance/Investments/Sharekhan';

// Client to portfolio mapping
const CLIENT_MAP = {
  '1307737': { name: 'Pankaj Yadav', portfolioId: 2 },
  '1419863': { name: 'Anju Yadav', portfolioId: 1 },
};

/**
 * Convert HTML to cell-delimited rows.
 * Returns array of rows, each row is array of cell text values.
 */
function htmlToRows(html) {
  const rows = [];
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  let rowMatch;
  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const cells = [];
    let cellMatch;
    while ((cellMatch = cellRegex.exec(rowMatch[1])) !== null) {
      const cellText = cellMatch[1]
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      cells.push(cellText);
    }
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

function parseContractNote(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const fileName = path.basename(filePath);
  
  // Extract client ID from filename (e.g., "1307737_NSECM5092468_20101104.htm")
  const clientMatch = fileName.match(/^(\d+)_/);
  if (!clientMatch) return null;
  const clientId = clientMatch[1];
  
  // Extract date from filename
  const dateMatch = fileName.match(/_(\d{8})\.htm$/i);
  if (!dateMatch) return null;
  const dateStr = dateMatch[1]; // YYYYMMDD
  const tradeDate = `${dateStr.substring(0,4)}-${dateStr.substring(4,6)}-${dateStr.substring(6,8)}`;
  
  const trades = [];
  const textUpper = text.toUpperCase();
  const hasAnnexure = textUpper.includes('ANNEXURE');
  // Check if it has the newer ISIN-based format (2015+ with "As per Annexure -ISIN -INExxxxx")
  const hasISINFormat = /As per Annexure\s*-ISIN\s*-INE/i.test(text);
  
  if (hasAnnexure && !hasISINFormat) {
    // Old format (2010-2015): Has ANNEXURE section with rows:
    // OrderNo | OrderTime | TradeNo | TradeTime | Security | PurchaseQty | SaleQty | Rate
    const annexureIdx = textUpper.lastIndexOf('ANNEXURE');
    const annexureHtml = text.substring(annexureIdx);
    const rows = htmlToRows(annexureHtml);
    
    // Skip header row (starts with "Order No.")
    let headerFound = false;
    for (const row of rows) {
      if (row[0] && row[0].includes('Order No')) {
        headerFound = true;
        continue;
      }
      if (!headerFound) continue;
      
      // Stop at footer rows (e.g., "Date:", "For Sharekhan", "Authorised")
      if (row[0] && (row[0].includes('Date:') || row[0].includes('Sharekhan') || row[0].includes('Authorised'))) {
        break;
      }
      
      // Expect 8 cells: OrderNo, OrderTime, TradeNo, TradeTime, Security, PurchaseQty, SaleQty, Rate
      if (row.length >= 8) {
        const security = row[4].replace(/\s+/g, ' ').trim();
        const purchaseQty = parseInt(row[5]) || 0;
        const saleQty = parseInt(row[6]) || 0;
        const rate = parseFloat(row[7]) || 0;
        
        if (security && rate > 0) {
          trades.push({
            tradeDate,
            security,
            isin: null,
            purchaseQty,
            saleQty,
            rate,
            type: purchaseQty > 0 ? 'BUY' : 'SELL',
            quantity: purchaseQty > 0 ? purchaseQty : saleQty,
          });
        }
      }
    }
  }
  
  // New format (2015+) OR fallback if old format found no trades
  if (trades.length === 0) {
    // New format (2015+): No ANNEXURE, trade data in main table
    // "As per Annexure -ISIN -{ISIN}" | SecurityName | BuyQty | SellQty | GrossRate | ...
    // Some 2015 files have "As per Annexure" WITHOUT the ISIN suffix
    // In 2019+ format an extra empty column appears after security name, shifting cols by 1
    const rows = htmlToRows(text);
    for (const row of rows) {
      const firstCell = row[0] || '';
      const isinMatch = firstCell.match(/As per Annexure\s*-ISIN\s*-(INE\w+)/i);
      const annexureMatch = !isinMatch && /As per Annexure/i.test(firstCell);
      if ((isinMatch || annexureMatch) && row.length >= 5) {
        const isin = isinMatch ? isinMatch[1] : null;
        const security = (row[1] || '').replace(/\s+/g, ' ').trim();

        // Try standard layout first: Name | BuyQty | SellQty | Rate (cols 2,3,4)
        let buyQty = parseInt(row[2]) || 0;
        let sellQty = parseInt(row[3]) || 0;
        let rate = parseFloat(row[4]) || 0;

        // If rate is 0 but col 5 has a rate, it's the 2019+ shifted format:
        // Name | (empty) | Qty | 0 | GrossRate (cols 2,3,4,5)
        if (rate === 0 && row.length >= 6 && parseFloat(row[5]) > 0) {
          const qty = parseInt(row[3]) || 0;
          rate = parseFloat(row[5]);
          // Determine buy/sell from the net amount sign (last non-empty cell is negative for sells)
          const lastVal = parseFloat(row[row.length - 2]) || parseFloat(row[row.length - 1]) || 0;
          if (lastVal < 0) {
            // Negative net = sell (broker pays out after deductions)
            sellQty = qty;
            buyQty = 0;
          } else {
            buyQty = qty;
            sellQty = 0;
          }
        }
        
        if (security && rate > 0) {
          trades.push({
            tradeDate,
            security,
            isin,
            purchaseQty: buyQty,
            saleQty: sellQty,
            rate,
            type: buyQty > 0 ? 'BUY' : 'SELL',
            quantity: buyQty > 0 ? buyQty : sellQty,
          });
        }
      }
    }
  }
  
  return {
    clientId,
    portfolio: CLIENT_MAP[clientId],
    tradeDate,
    trades,
    fileName,
  };
}

// Scan all directories
function getAllContractNotes() {
  const results = [];
  const dirs = fs.readdirSync(BASE_DIR).filter(d => {
    const fullPath = path.join(BASE_DIR, d);
    return fs.statSync(fullPath).isDirectory() && d.match(/^\d{4}-/);
  });
  
  for (const dir of dirs) {
    const fullDir = path.join(BASE_DIR, dir);
    const files = fs.readdirSync(fullDir).filter(f => f.endsWith('.htm') && !f.includes('Qtr'));
    
    for (const file of files) {
      const fullPath = path.join(fullDir, file);
      const result = parseContractNote(fullPath);
      if (result) {
        results.push(result);
      }
    }
  }
  
  return results;
}

const allNotes = getAllContractNotes();

console.log(`\n=== SHAREKHAN CONTRACT NOTES SUMMARY ===\n`);
console.log(`Total files parsed: ${allNotes.length}`);
console.log(`Files with trades: ${allNotes.filter(n => n.trades.length > 0).length}`);
console.log(`Files without trades: ${allNotes.filter(n => n.trades.length === 0).length}`);

// Group by client
for (const [clientId, info] of Object.entries(CLIENT_MAP)) {
  const clientNotes = allNotes.filter(n => n.clientId === clientId);
  console.log(`\n--- ${info.name} (Client ${clientId}, Portfolio ${info.portfolioId}) ---`);
  console.log(`Contract notes: ${clientNotes.length}`);
  
  const allTrades = clientNotes.flatMap(n => n.trades);
  console.log(`Total trades: ${allTrades.length}`);
  
  // Unique stocks
  const stocks = [...new Set(allTrades.map(t => t.security))];
  console.log(`Unique stocks: ${stocks.length}`);
  stocks.forEach(s => {
    const stockTrades = allTrades.filter(t => t.security === s);
    const buys = stockTrades.filter(t => t.type === 'BUY');
    const sells = stockTrades.filter(t => t.type === 'SELL');
    const totalBought = buys.reduce((sum, t) => sum + t.quantity, 0);
    const totalSold = sells.reduce((sum, t) => sum + t.quantity, 0);
    console.log(`  ${s}: Bought ${totalBought}, Sold ${totalSold}, Net ${totalBought - totalSold}`);
  });
}

// Show files with no trades
const noTrades = allNotes.filter(n => n.trades.length === 0);
if (noTrades.length > 0) {
  console.log('\n--- FILES WITH NO TRADES PARSED ---');
  noTrades.forEach(n => console.log(`  ${n.fileName} (${n.tradeDate})`));
}

// Show all trades chronologically
console.log('\n=== ALL TRADES (Chronological) ===\n');
const allTrades = allNotes.flatMap(n => n.trades.map(t => ({
  ...t,
  clientName: n.portfolio?.name,
  portfolioId: n.portfolio?.portfolioId,
})));
allTrades.sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
allTrades.forEach(t => {
  console.log(`${t.tradeDate} | ${t.clientName} | ${t.type} | ${t.quantity} x ${t.security} @ ${t.rate}`);
});
