/**
 * Sharekhan Import Script
 * 
 * 1. Parse all contract note HTM files
 * 2. Resolve stock names to Yahoo Finance tickers (via ISIN or name search)
 * 3. For stocks with negative net (IPO allotments), fetch IPO listing day data
 * 4. Import all investments and transactions into the database
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const Database = require('better-sqlite3');

const BASE_DIR = 'E:/Finance/Investments/Sharekhan';
const DB_PATH = path.join(__dirname, '..', 'data', 'investments.db');

const CLIENT_MAP = {
  '1307737': { name: 'Pankaj Yadav', portfolioId: 2 },
  '1419863': { name: 'Anju Yadav', portfolioId: 1 },
};

// Known stock name → NSE ticker mapping (fallback if Yahoo search fails)
const KNOWN_TICKERS = {
  'COAL INDIA LIMITED': 'COALINDIA.NS',
  'POWER GRID CORP. OF IND. LTD.': 'POWERGRID.NS',
  'STATE BANK OF INDIA': 'SBIN.NS',
  'JAIPRAKASH ASSOCIATES LTD.': 'JPASSOCIAT.NS',
  'UNITECH LTD.': 'UNITECH.NS',
  'DLF LTD.': 'DLF.NS',
  'ADANI POWER LIMITED': 'ADANIPOWER.NS',
  'MAGNUM VENTURES LIMITED': 'MAGNUMVENT.NS',
  'PUNJAB & SIND BANK': 'PSB.NS',
  'ICICI BANK LTD.': 'ICICIBANK.NS',
  'RELIANCE CAPITAL LTD.': 'RELCAPITAL.NS',
  'RELIANCE POWER LTD.': 'RPOWER.NS',
  'SAIL': 'SAIL.NS',
  'CREDIT ANALYSIS & RESEARCH LTD': 'CARERATING.NS',
  'RELIANCE COMMUNICATION LTD.': 'RCOM.NS',
  'BHARTI INFRATEL LIMITED': 'INDUSTOWER.NS',
  'HERO MOTOCORP LIMITED': 'HEROMOTOCO.NS',
  'AXIS BANK LIMITED': 'AXISBANK.NS',
  'YES BANK LTD.': 'YESBANK.NS',
};

// ISINs from 2015 contract notes
const KNOWN_ISINS = {
  'HERO MOTOCORP LIMITED': 'INE158A01026',
  'AXIS BANK LIMITED': 'INE238A01034',
  'YES BANK LTD.': 'INE528G01019',
};

// ---- HTML Parsing ----

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
  
  const clientMatch = fileName.match(/^(\d+)_/);
  if (!clientMatch) return null;
  const clientId = clientMatch[1];
  
  const dateMatch = fileName.match(/_(\d{8})\.htm$/i);
  if (!dateMatch) return null;
  const dateStr = dateMatch[1];
  const tradeDate = `${dateStr.substring(0,4)}-${dateStr.substring(4,6)}-${dateStr.substring(6,8)}`;
  
  const trades = [];
  const hasAnnexure = text.includes('ANNEXURE');
  
  if (hasAnnexure) {
    const annexureIdx = text.lastIndexOf('ANNEXURE');
    const annexureHtml = text.substring(annexureIdx);
    const rows = htmlToRows(annexureHtml);
    
    let headerFound = false;
    for (const row of rows) {
      if (row[0] && row[0].includes('Order No')) { headerFound = true; continue; }
      if (!headerFound) continue;
      if (row[0] && (row[0].includes('Date:') || row[0].includes('Sharekhan') || row[0].includes('Authorised'))) break;
      
      if (row.length >= 8) {
        const security = row[4].replace(/\s+/g, ' ').trim();
        const purchaseQty = parseInt(row[5]) || 0;
        const saleQty = parseInt(row[6]) || 0;
        const rate = parseFloat(row[7]) || 0;
        
        if (security && rate > 0) {
          trades.push({ tradeDate, security, isin: null, purchaseQty, saleQty, rate,
            type: purchaseQty > 0 ? 'BUY' : 'SELL', quantity: purchaseQty > 0 ? purchaseQty : saleQty });
        }
      }
    }
  } else {
    const rows = htmlToRows(text);
    for (const row of rows) {
      const firstCell = row[0] || '';
      const isinMatch = firstCell.match(/As per Annexure\s*-ISIN\s*-(INE\w+)/i);
      if (isinMatch && row.length >= 5) {
        const isin = isinMatch[1];
        const security = (row[1] || '').replace(/\s+/g, ' ').trim();
        const buyQty = parseInt(row[2]) || 0;
        const sellQty = parseInt(row[3]) || 0;
        const rate = parseFloat(row[4]) || 0;
        
        if (security && rate > 0) {
          trades.push({ tradeDate, security, isin, purchaseQty: buyQty, saleQty: sellQty, rate,
            type: buyQty > 0 ? 'BUY' : 'SELL', quantity: buyQty > 0 ? buyQty : sellQty });
        }
      }
    }
  }
  
  return { clientId, portfolio: CLIENT_MAP[clientId], tradeDate, trades, fileName };
}

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
      const result = parseContractNote(path.join(fullDir, file));
      if (result) results.push(result);
    }
  }
  return results;
}

// ---- Yahoo Finance Helpers ----

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function yahooSearch(query) {
  return new Promise((resolve) => {
    const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=5&newsCount=0`;
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.quotes && json.quotes.length > 0) {
            const nseQuote = json.quotes.find(q => q.symbol?.endsWith('.NS') && q.quoteType === 'EQUITY');
            const bseQuote = json.quotes.find(q => q.symbol?.endsWith('.BO') && q.quoteType === 'EQUITY');
            const anyEquity = json.quotes.find(q => q.quoteType === 'EQUITY');
            const match = nseQuote || bseQuote || anyEquity;
            resolve(match ? { symbol: match.symbol, name: match.shortname || match.longname } : null);
          } else resolve(null);
        } catch (e) { resolve(null); }
      });
      res.on('error', () => resolve(null));
    }).on('error', () => resolve(null));
  });
}

function yahooChart(symbol, period1, period2) {
  return new Promise((resolve) => {
    // period1/period2 are unix timestamps
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1d`;
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const result = json.chart?.result?.[0];
          if (result && result.timestamp) {
            const timestamps = result.timestamp;
            const quotes = result.indicators?.quote?.[0];
            const meta = result.meta;
            resolve({ timestamps, quotes, meta });
          } else resolve(null);
        } catch (e) { resolve(null); }
      });
      res.on('error', () => resolve(null));
    }).on('error', () => resolve(null));
  });
}

async function resolveAllTickers(uniqueStockNames) {
  const tickerMap = {};
  
  for (const stockName of uniqueStockNames) {
    // First check known tickers
    if (KNOWN_TICKERS[stockName]) {
      tickerMap[stockName] = KNOWN_TICKERS[stockName];
      console.log(`  ${stockName} → ${KNOWN_TICKERS[stockName]} (known)`);
      continue;
    }
    
    // Try ISIN if available
    if (KNOWN_ISINS[stockName]) {
      await delay(500);
      const result = await yahooSearch(KNOWN_ISINS[stockName]);
      if (result) {
        tickerMap[stockName] = result.symbol;
        console.log(`  ${stockName} → ${result.symbol} (ISIN: ${KNOWN_ISINS[stockName]})`);
        continue;
      }
    }
    
    // Try Yahoo search by name
    await delay(500);
    const result = await yahooSearch(stockName);
    if (result) {
      tickerMap[stockName] = result.symbol;
      console.log(`  ${stockName} → ${result.symbol} (search)`);
    } else {
      console.log(`  ${stockName} → NOT FOUND!`);
      tickerMap[stockName] = null;
    }
  }
  
  return tickerMap;
}

async function fetchIPOData(ticker, stockName) {
  // Fetch earliest available data (use period1=0 for max range)
  // Yahoo Finance typically has data from the listing date
  const data = await yahooChart(ticker, 0, Math.floor(Date.now() / 1000));
  if (!data || !data.timestamps || data.timestamps.length === 0) {
    console.log(`  ${stockName}: No historical data available`);
    return null;
  }
  
  // First timestamp is the listing date (approximately)
  const firstTimestamp = data.timestamps[0];
  const listingDate = new Date(firstTimestamp * 1000);
  const listingDateStr = listingDate.toISOString().split('T')[0];
  
  // The opening price on the first day is likely close to the issue price
  // The "previousClose" in meta might be the IPO price
  const firstOpen = data.quotes?.open?.[0];
  const firstClose = data.quotes?.close?.[0];
  const metaPrevClose = data.meta?.chartPreviousClose;
  
  // IPO issue price is typically the previousClose of the first candle, 
  // or the meta.chartPreviousClose
  const ipoPrice = metaPrevClose || firstOpen || firstClose;
  
  console.log(`  ${stockName} (${ticker}): Listed ~${listingDateStr}, IPO/Issue Price ≈ ₹${ipoPrice?.toFixed(2)}, First Open ₹${firstOpen?.toFixed(2)}, First Close ₹${firstClose?.toFixed(2)}`);
  
  return {
    listingDate: listingDateStr,
    ipoPrice: ipoPrice,
    firstOpen,
    firstClose,
  };
}

// ---- Main ----

async function main() {
  console.log('=== STEP 1: Parse Contract Notes ===\n');
  const allNotes = getAllContractNotes();
  const allTrades = allNotes.flatMap(n => n.trades.map(t => ({
    ...t,
    clientId: n.clientId,
    portfolioId: n.portfolio?.portfolioId,
    portfolioName: n.portfolio?.name,
  })));
  allTrades.sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
  
  console.log(`Parsed ${allNotes.length} contract notes, ${allTrades.length} trades\n`);
  
  // Compute unique stocks per portfolio
  const stocksByPortfolio = {};
  for (const trade of allTrades) {
    const key = `${trade.portfolioId}:${trade.security}`;
    if (!stocksByPortfolio[key]) {
      stocksByPortfolio[key] = {
        portfolioId: trade.portfolioId,
        portfolioName: trade.portfolioName,
        security: trade.security,
        isin: trade.isin,
        trades: [],
        totalBought: 0,
        totalSold: 0,
      };
    }
    stocksByPortfolio[key].trades.push(trade);
    if (trade.isin) stocksByPortfolio[key].isin = trade.isin;
    stocksByPortfolio[key].totalBought += trade.purchaseQty;
    stocksByPortfolio[key].totalSold += trade.saleQty;
  }
  
  const uniqueStockNames = [...new Set(allTrades.map(t => t.security))];
  
  console.log('=== STEP 2: Resolve Tickers ===\n');
  const tickerMap = await resolveAllTickers(uniqueStockNames);
  
  // Identify negative-net stocks (need IPO buy)
  const negativeNetStocks = Object.values(stocksByPortfolio).filter(s => 
    s.totalBought - s.totalSold < 0
  );
  
  console.log('\n=== STEP 3: Fetch IPO Data for Negative-Net Stocks ===\n');
  const ipoData = {};
  for (const stock of negativeNetStocks) {
    const ticker = tickerMap[stock.security];
    if (!ticker) {
      console.log(`  ${stock.security}: No ticker, skipping IPO lookup`);
      continue;
    }
    await delay(500);
    ipoData[stock.security] = await fetchIPOData(ticker, stock.security);
  }
  
  console.log('\n=== STEP 4: Import to Database ===\n');
  
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  
  const insertInvestment = db.prepare(`
    INSERT INTO investments (name, asset_type, portfolio_id, ticker_symbol, currency, notes, is_active)
    VALUES (?, 'INDIAN_STOCK', ?, ?, 'INR', ?, 1)
  `);
  
  const insertTransaction = db.prepare(`
    INSERT INTO transactions (investment_id, transaction_type, transaction_date, units, price_per_unit, amount, fees, notes)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?)
  `);
  
  const importAll = db.transaction(() => {
    let investmentsCreated = 0;
    let transactionsCreated = 0;
    
    for (const [key, stock] of Object.entries(stocksByPortfolio)) {
      const ticker = tickerMap[stock.security];
      if (!ticker) {
        console.log(`  SKIP ${stock.security} - no ticker resolved`);
        continue;
      }
      
      const net = stock.totalBought - stock.totalSold;
      const notes = `Imported from Sharekhan contract notes. Net: ${net > 0 ? '+' : ''}${net} shares`;
      
      // Create investment
      const result = insertInvestment.run(stock.security, stock.portfolioId, ticker, notes);
      const investmentId = result.lastInsertRowid;
      investmentsCreated++;
      console.log(`  Created investment: ${stock.security} (${ticker}) for ${stock.portfolioName} [ID: ${investmentId}]`);
      
      // If negative net, add IPO buy transaction
      if (net < 0) {
        const missingQty = Math.abs(net);
        const ipo = ipoData[stock.security];
        const ipoPrice = ipo?.ipoPrice || 0;
        const ipoDate = ipo?.listingDate || stock.trades[0]?.tradeDate;
        
        // Add IPO allotment as a BUY before the first sell
        const firstSellDate = stock.trades.find(t => t.type === 'SELL')?.tradeDate || ipoDate;
        // Use listing date if available, otherwise 1 day before first sell
        let buyDate = ipoDate;
        if (!buyDate || buyDate >= firstSellDate) {
          const d = new Date(firstSellDate);
          d.setDate(d.getDate() - 1);
          buyDate = d.toISOString().split('T')[0];
        }
        
        const amount = missingQty * ipoPrice;
        insertTransaction.run(investmentId, 'BUY', buyDate, missingQty, ipoPrice, amount, `IPO allotment (est. price ₹${ipoPrice.toFixed(2)})`);
        transactionsCreated++;
        console.log(`    + IPO BUY: ${missingQty} x ${stock.security} @ ₹${ipoPrice.toFixed(2)} on ${buyDate}`);
      }
      
      // Add all trades
      for (const trade of stock.trades) {
        const amount = trade.quantity * trade.rate;
        insertTransaction.run(investmentId, trade.type, trade.tradeDate, trade.quantity, trade.rate, amount, `Sharekhan trade`);
        transactionsCreated++;
      }
    }
    
    return { investmentsCreated, transactionsCreated };
  });
  
  const result = importAll();
  console.log(`\n=== IMPORT COMPLETE ===`);
  console.log(`Investments created: ${result.investmentsCreated}`);
  console.log(`Transactions created: ${result.transactionsCreated}`);
  
  // Verify
  console.log('\n=== VERIFICATION ===\n');
  const investments = db.prepare('SELECT i.id, i.name, i.ticker_symbol, i.portfolio_id, p.name as portfolio_name FROM investments i JOIN portfolios p ON i.portfolio_id = p.id ORDER BY i.portfolio_id, i.name').all();
  for (const inv of investments) {
    const txns = db.prepare('SELECT transaction_type, COUNT(*) as cnt, SUM(units) as total_units FROM transactions WHERE investment_id = ? GROUP BY transaction_type').all(inv.id);
    const txnSummary = txns.map(t => `${t.transaction_type}: ${t.total_units} units (${t.cnt} txns)`).join(', ');
    console.log(`  [${inv.portfolio_name}] ${inv.name} (${inv.ticker_symbol}): ${txnSummary}`);
  }
  
  db.close();
}

main().catch(console.error);
