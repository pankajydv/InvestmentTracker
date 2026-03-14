/**
 * P&L / Trade History Statement Parser
 *
 * Parses profit & loss or trade history Excel/CSV files from various brokers.
 * Returns an array of trades: { tradeDate, security, isin, type, quantity, rate, fees }
 */

const XLSX = require('xlsx');

/**
 * Normalize a header string for matching.
 */
function normalizeHeader(h) {
  return (h || '').toString().toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Find column index by possible header names.
 */
function findColumn(headers, ...names) {
  const normalizedHeaders = headers.map(normalizeHeader);
  for (const name of names) {
    const idx = normalizedHeaders.indexOf(normalizeHeader(name));
    if (idx >= 0) return idx;
  }
  // Partial match
  for (const name of names) {
    const norm = normalizeHeader(name);
    const idx = normalizedHeaders.findIndex(h => h.includes(norm));
    if (idx >= 0) return idx;
  }
  return -1;
}

/**
 * Parse a date string in various formats to YYYY-MM-DD.
 */
function parseDate(val) {
  if (!val) return null;

  // If it's an Excel serial date number
  if (typeof val === 'number') {
    const date = new Date((val - 25569) * 86400000);
    return date.toISOString().split('T')[0];
  }

  const s = val.toString().trim();

  // DD/MM/YYYY or DD-MM-YYYY
  const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;

  // YYYY-MM-DD
  const ymd = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (ymd) return `${ymd[1]}-${ymd[2].padStart(2, '0')}-${ymd[3].padStart(2, '0')}`;

  // DD-Mon-YYYY (e.g., 14-Mar-2026)
  const months = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
  const dmonyr = s.match(/^(\d{1,2})[\/\-]([A-Za-z]{3})[\/\-](\d{4})$/);
  if (dmonyr) {
    const m = months[dmonyr[2].toLowerCase()];
    if (m) return `${dmonyr[3]}-${m}-${dmonyr[1].padStart(2, '0')}`;
  }

  return null;
}

/**
 * Determine transaction type from a string.
 */
function parseTradeType(val) {
  const s = (val || '').toString().toUpperCase().trim();
  if (s === 'B' || s.includes('BUY') || s.includes('PURCHASE')) return 'BUY';
  if (s === 'S' || s.includes('SELL') || s.includes('SALE')) return 'SELL';
  if (s.includes('DIVIDEND')) return 'DIVIDEND';
  if (s.includes('BONUS')) return 'BONUS';
  if (s.includes('SPLIT')) return 'SPLIT';
  if (s.includes('RIGHTS')) return 'RIGHTS';
  if (s.includes('IPO')) return 'IPO';
  return null;
}

/**
 * Parse P&L / trade history from Excel/CSV buffer.
 */
function parsePnLStatement(buffer, fileName, broker) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const trades = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

    if (data.length < 2) continue;

    // Find the header row (first row with recognizable column names)
    let headerRowIdx = -1;
    let headers = [];
    for (let i = 0; i < Math.min(data.length, 15); i++) {
      const row = data[i].map(c => normalizeHeader(c));
      const hasDate = row.some(c => c.includes('date') || c.includes('tradedate'));
      const hasQty = row.some(c => c.includes('qty') || c.includes('quantity') || c.includes('shares'));
      const hasStock = row.some(c => c.includes('stock') || c.includes('scrip') || c.includes('symbol') || c.includes('security') || c.includes('instrument'));
      if (hasDate && (hasQty || hasStock)) {
        headerRowIdx = i;
        headers = data[i].map(c => (c || '').toString());
        break;
      }
    }

    if (headerRowIdx < 0) continue;

    // Map columns
    const dateCol = findColumn(headers, 'Trade Date', 'Date', 'Transaction Date', 'Order Date');
    const stockCol = findColumn(headers, 'Stock Name', 'Scrip', 'Symbol', 'Security', 'Instrument', 'Script Name', 'Company');
    const isinCol = findColumn(headers, 'ISIN', 'Isin No');
    const typeCol = findColumn(headers, 'Type', 'Trade Type', 'Transaction Type', 'Buy/Sell', 'Side', 'Action');
    const qtyCol = findColumn(headers, 'Qty', 'Quantity', 'Shares', 'No of Shares', 'Units', 'Trade Qty');
    const priceCol = findColumn(headers, 'Price', 'Rate', 'Trade Price', 'Avg Price', 'Purchase Price', 'Price Per Unit');
    const buyQtyCol = findColumn(headers, 'Buy Qty', 'Purchase Qty', 'Buy Quantity');
    const sellQtyCol = findColumn(headers, 'Sell Qty', 'Sale Qty', 'Sell Quantity');
    const feesCol = findColumn(headers, 'Brokerage', 'Charges', 'Fees', 'STT', 'Total Charges');

    if (dateCol < 0 || stockCol < 0) continue;

    // Parse data rows
    for (let i = headerRowIdx + 1; i < data.length; i++) {
      const row = data[i];
      if (!row || row.length === 0) continue;

      const dateVal = parseDate(row[dateCol]);
      if (!dateVal) continue;

      const security = (row[stockCol] || '').toString().trim();
      if (!security) continue;

      const isin = isinCol >= 0 ? (row[isinCol] || '').toString().trim() : null;

      let type = null;
      let quantity = 0;

      if (typeCol >= 0) {
        type = parseTradeType(row[typeCol]);
        quantity = Math.abs(parseFloat(row[qtyCol]) || 0);
      } else if (buyQtyCol >= 0 && sellQtyCol >= 0) {
        const buyQty = parseFloat(row[buyQtyCol]) || 0;
        const sellQty = parseFloat(row[sellQtyCol]) || 0;
        if (buyQty > 0) { type = 'BUY'; quantity = buyQty; }
        else if (sellQty > 0) { type = 'SELL'; quantity = sellQty; }
      } else if (qtyCol >= 0) {
        const q = parseFloat(row[qtyCol]) || 0;
        type = q >= 0 ? 'BUY' : 'SELL';
        quantity = Math.abs(q);
      }

      if (!type || quantity <= 0) continue;

      const rate = Math.abs(parseFloat(row[priceCol]) || 0);
      if (rate <= 0) continue;

      const fees = feesCol >= 0 ? Math.abs(parseFloat(row[feesCol]) || 0) : 0;

      trades.push({
        tradeDate: dateVal,
        security,
        isin: isin || null,
        type,
        quantity,
        rate,
        fees,
      });
    }
  }

  return trades;
}

module.exports = { parsePnLStatement };
