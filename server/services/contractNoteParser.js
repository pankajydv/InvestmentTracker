/**
 * Contract Note Parser Service
 *
 * Parses contract note files (HTM inside ZIP, or PDF) from various brokers.
 * Supports: Sharekhan (HTM format with old/new layouts), Groww (PDF).
 * Returns: { broker, clientCode, panNumber, tradeDate, trades[], charges }
 */

const AdmZip = require('adm-zip');
const { PDFParse } = require('pdf-parse');

/**
 * Convert HTML to cell-delimited rows.
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

/**
 * Detect broker from HTML content.
 */
function detectBroker(text) {
  const upper = text.toUpperCase();
  if (upper.includes('SHAREKHAN')) return 'Sharekhan';
  if (upper.includes('GROWW')) return 'Groww';
  // Groww PDFs may not contain the word "Groww" - detect by format patterns
  if (upper.includes('UNIQUE CLIENT CODE') && upper.includes('CONTRACT NOTE')) return 'Groww';
  if (upper.includes('ZERODHA')) return 'Zerodha';
  if (upper.includes('ICICI SECURITIES') || upper.includes('ICICI DIRECT')) return 'ICICI Direct';
  if (upper.includes('HDFC SECURITIES')) return 'HDFC Securities';
  if (upper.includes('ANGEL')) return 'Angel One';
  if (upper.includes('KOTAK SECURITIES')) return 'Kotak Securities';
  return null;
}

/**
 * Extract PAN from HTML content.
 */
function extractPAN(text) {
  // PAN pattern: 5 letters, 4 digits, 1 letter
  const panMatch = text.match(/(?:PAN[^:]*?:\s*|PAN\s+No\.?\s*:?\s*)([A-Z]{5}\d{4}[A-Z])/i);
  if (panMatch) return panMatch[1].toUpperCase();
  // Fallback: look for standalone PAN-format strings near "PAN"
  const context = text.match(/PAN[\s\S]{0,50}?([A-Z]{5}\d{4}[A-Z])/i);
  if (context) return context[1].toUpperCase();
  return null;
}

/**
 * Extract client code from Sharekhan HTML content or filename.
 */
function extractClientCode(text, fileName) {
  // From filename: 1307737_NSECM5092468_20101104.htm
  const fileMatch = fileName.match(/^(\d{7})_/);
  if (fileMatch) return fileMatch[1];
  // From content: "Client Code" followed by number
  const contentMatch = text.match(/(?:Client\s*Code|Trading[^:]*Client\s*Code)\s*[:\s]*(?:\d+\s*\/\s*)?(\d{7})/i);
  if (contentMatch) return contentMatch[1];
  return null;
}

/**
 * Parse a single Sharekhan HTM contract note.
 * Returns { broker, clientCode, panNumber, tradeDate, trades[], totalCharges }
 */
function parseSharekhanHTM(text, fileName) {
  const broker = detectBroker(text) || 'Sharekhan';
  const panNumber = extractPAN(text);
  const clientCode = extractClientCode(text, fileName);

  // Extract trade date from filename or content
  let tradeDate = null;
  const dateMatch1 = fileName.match(/_(\d{8})\.htm$/i);
  const dateMatch2 = fileName.match(/(\d{8})\.(htm|pdf)$/i);
  if (dateMatch1) {
    const d = dateMatch1[1];
    tradeDate = `${d.substring(0, 4)}-${d.substring(4, 6)}-${d.substring(6, 8)}`;
  } else if (dateMatch2) {
    const d = dateMatch2[1];
    tradeDate = `${d.substring(0, 4)}-${d.substring(4, 6)}-${d.substring(6, 8)}`;
  }
  if (!tradeDate) {
    const contentDate = text.match(/Trade\s*Date\s*[:\s]*(\d{2})[\/\-](\d{2})[\/\-](\d{4})/i);
    if (contentDate) tradeDate = `${contentDate[3]}-${contentDate[2]}-${contentDate[1]}`;
  }

  if (!tradeDate) return null;

  const trades = [];

  // Parse from the main summary table first - this has brokerage per trade
  // Columns: OrderNo | OrderTime | TradeNo | TradeTime | Security | BuyQty | SellQty | Rate | Total | Brokerage | ServiceTax | STT | Amount
  const allRows = htmlToRows(text);

  // Find the main trade table (with brokerage columns)
  for (let i = 0; i < allRows.length; i++) {
    const row = allRows[i];
    const firstCell = row[0] || '';

    // Check for "As Per Annexure" rows (main summary with brokerage)
    if (/As\s*Per\s*Annexure/i.test(firstCell) && row.length >= 9) {
      // Old format: As Per Annexure | SecurityName | BuyQty | SellQty | Rate | Total | Brokerage | ServiceTax | STT | Amount
      // But the columns might shift depending on layout

      // Find security name - look for text not containing just numbers
      let securityIdx = -1;
      let security = '';
      for (let c = 1; c < Math.min(row.length, 6); c++) {
        const val = row[c].trim();
        if (val && !/^[\d.,\s]+$/.test(val) && val.length > 2) {
          securityIdx = c;
          security = val.replace(/\s+/g, ' ');
          break;
        }
      }
      if (securityIdx < 0) continue;

      // ISIN from "As per Annexure -ISIN -INExxxxxx"
      const isinMatch = firstCell.match(/ISIN\s*-(INE\w+)/i);
      const isin = isinMatch ? isinMatch[1] : null;

      // Parse numeric columns after security name
      const numCols = [];
      for (let c = securityIdx + 1; c < row.length; c++) {
        const val = row[c].replace(/,/g, '').trim();
        numCols.push(parseFloat(val) || 0);
      }

      // Determine buy/sell qty and rate based on column count
      let buyQty = 0, sellQty = 0, rate = 0, total = 0, brokerage = 0, stt = 0;

      if (numCols.length >= 8) {
        // Full format: BuyQty | SellQty | Rate | Total | Brokerage | ServiceTax | STT | Amount
        buyQty = numCols[0]; sellQty = numCols[1]; rate = numCols[2]; total = numCols[3];
        brokerage = numCols[4]; stt = numCols[6];
      } else if (numCols.length >= 5) {
        // Compact: Qty | 0 | Rate | Total | Brokerage ...
        const q1 = numCols[0], q2 = numCols[1];
        rate = numCols[2]; total = numCols[3]; brokerage = numCols[4];
        if (q1 > 0 && q2 === 0) { buyQty = q1; }
        else if (q2 > 0 && q1 === 0) { sellQty = q2; }
        else if (q1 > 0) { buyQty = q1; }
      } else if (numCols.length >= 3) {
        // Minimal: Qty | Rate | Amount
        const qty = numCols[0]; rate = numCols[1];
        buyQty = qty;
      }

      // Handle 2019+ shifted format
      if (rate === 0 && numCols.length >= 4) {
        const tryRate = numCols[3];
        if (tryRate > 0) {
          rate = tryRate;
          const qty = numCols[1] || numCols[0];
          const lastVal = numCols[numCols.length - 1] || numCols[numCols.length - 2];
          if (lastVal < 0) { sellQty = qty; buyQty = 0; }
          else { buyQty = qty; sellQty = 0; }
        }
      }

      const quantity = buyQty > 0 ? buyQty : sellQty;
      const type = buyQty > 0 ? 'BUY' : 'SELL';

      if (security && rate > 0 && quantity > 0) {
        trades.push({
          tradeDate, security, isin, type, quantity, rate,
          total: total || quantity * rate,
          brokerage, stt,
        });
      }
    }
  }

  // Fallback: parse ANNEXURE section for old-format notes (pre-2015)
  if (trades.length === 0) {
    const textUpper = text.toUpperCase();
    const hasAnnexure = textUpper.includes('ANNEXURE');
    if (hasAnnexure) {
      const annexureIdx = textUpper.lastIndexOf('ANNEXURE');
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
            trades.push({
              tradeDate, security, isin: null,
              type: purchaseQty > 0 ? 'BUY' : 'SELL',
              quantity: purchaseQty > 0 ? purchaseQty : saleQty,
              rate, total: (purchaseQty > 0 ? purchaseQty : saleQty) * rate,
              brokerage: 0, stt: 0,
            });
          }
        }
      }
    }
  }

  // Extract total charges from the summary section
  let totalBrokerage = 0, totalSTT = 0, totalServiceTax = 0, totalStampDuty = 0, totalTurnoverCharges = 0, totalEducationCess = 0;
  for (const row of allRows) {
    const label = (row[0] || '').trim().toUpperCase();
    const value = parseFloat((row[1] || '').replace(/,/g, '')) || 0;
    if (label.includes('NET OF CURRENT')) continue;
    if (/^SERVICE\s*TAX/i.test(label)) totalServiceTax = value;
    if (/^STT\s*AMT/i.test(label) || /^SECURITY\s*TRANSACTION/i.test(label)) totalSTT = value;
    if (/^STAMP\s*DUTY/i.test(label)) totalStampDuty = value;
    if (/^TURNOVER\s*CHARGES/i.test(label)) totalTurnoverCharges = value;
    if (/EDUCATION\s*CESS/i.test(label)) totalEducationCess += value;
  }

  // Compute per-trade brokerage from the main table (if available)
  const perTradeBrokerage = trades.reduce((s, t) => s + (t.brokerage || 0), 0);
  const perTradeSTT = trades.reduce((s, t) => s + (t.stt || 0), 0);

  // Use per-trade brokerage if found, otherwise try summary
  if (perTradeBrokerage === 0) {
    for (const row of allRows) {
      for (let c = 0; c < row.length - 1; c++) {
        if (/brokerage/i.test(row[c]) && !row[c].includes('Rate')) {
          const val = parseFloat((row[c + 1] || '').replace(/,/g, '')) || 0;
          if (val > 0) { totalBrokerage = val; break; }
        }
      }
      if (totalBrokerage > 0) break;
    }
  } else {
    totalBrokerage = perTradeBrokerage;
  }
  if (totalSTT === 0) totalSTT = perTradeSTT;

  // Combine ALL charges into one total
  const totalAllCharges = totalBrokerage + totalSTT + totalServiceTax + totalStampDuty + totalTurnoverCharges + totalEducationCess;

  // Pro-rate combined charges across trades by trade value
  if (totalAllCharges > 0 && trades.length > 0) {
    const totalTradeValue = trades.reduce((s, t) => s + t.total, 0);
    for (const trade of trades) {
      trade.brokerage = totalTradeValue > 0
        ? parseFloat(((trade.total / totalTradeValue) * totalAllCharges).toFixed(2))
        : parseFloat((totalAllCharges / trades.length).toFixed(2));
    }
  }

  // Clean up: remove stt from individual trades (now merged into brokerage)
  for (const trade of trades) {
    delete trade.stt;
  }

  return {
    broker,
    clientCode,
    panNumber,
    tradeDate,
    trades,
    charges: {
      total: totalAllCharges,
      brokerage: totalBrokerage,
      stt: totalSTT,
      serviceTax: totalServiceTax,
      stampDuty: totalStampDuty,
      turnoverCharges: totalTurnoverCharges,
      educationCess: totalEducationCess,
    },
  };
}

/**
 * Parse a Groww PDF contract note.
 * Extracts trades from "Total ISIN qty total" lines and charges from summary section.
 */
function parseGrowwPDF(text, fileName) {
  // Extract PAN
  const panMatch = text.match(/PAN\s+([A-Z]{5}\d{4}[A-Z])/i);
  const panNumber = panMatch ? panMatch[1].toUpperCase() : null;

  // Extract client code
  const clientCodeMatch = text.match(/Unique\s+Client\s+Code\s+(\d+)/i);
  const clientCode = clientCodeMatch ? clientCodeMatch[1] : null;

  // Extract trade date from content
  let tradeDate = null;
  const tradeDateMatch = text.match(/Trade\s+Date\s+(\d{2})-(\d{2})-(\d{4})/i);
  if (tradeDateMatch) {
    tradeDate = `${tradeDateMatch[3]}-${tradeDateMatch[2]}-${tradeDateMatch[1]}`;
  }
  // Fallback: filename like 20240205.pdf
  if (!tradeDate) {
    const fileMatch = fileName.match(/(\d{4})(\d{2})(\d{2})\.pdf$/i);
    if (fileMatch) tradeDate = `${fileMatch[1]}-${fileMatch[2]}-${fileMatch[3]}`;
  }
  if (!tradeDate) return null;

  // Join all text to handle line wraps (order numbers can span multiple lines)
  const fullText = text.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ');

  // Build ISIN → security name map from trade lines
  // Pattern: OrderTime TradeNo TradeTime SecurityName Exchange B/S
  const tradeLineRegex = /\d{2}:\d{2}:\d{2}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+(.*?)\s+(BSE|NSE)\s+([BS])\s/g;
  const secEntries = [];
  let m;
  while ((m = tradeLineRegex.exec(fullText)) !== null) {
    secEntries.push({ name: m[1].trim(), pos: m.index });
  }

  // Also try 2026+ summary table: "ISIN SECURITY_NAME qty ..."
  const isinNames = {};
  const summaryRegex = /(IN[EF]\w{9,10})\s+([A-Za-z][A-Za-z\s\-&.()]+?)\s+\d+\s+[\d.]+/g;
  while ((m = summaryRegex.exec(fullText)) !== null) {
    const name = m[2].trim();
    if (name.length > 1 && !/^(Buy|Sell|Net|Total|ISIN|Security)$/i.test(name)) {
      isinNames[m[1]] = name;
    }
  }

  // Parse "Total ISIN qty netTotal" lines
  const trades = [];
  const totalRegex = /Total\s+(IN[EF]\w{9,10})\s+([\-\d,]+)\s+([\-\d,.]+)/g;
  while ((m = totalRegex.exec(fullText)) !== null) {
    const isin = m[1];
    const qty = parseInt(m[2].replace(/,/g, ''));
    const netTotal = parseFloat(m[3].replace(/,/g, ''));

    // Find security name: last trade line name before this Total, or from summary table
    let secName = '';
    for (const entry of secEntries) {
      if (entry.pos < m.index) secName = entry.name;
    }
    if (!secName) secName = isinNames[isin] || isin;
    if (isinNames[isin] && isinNames[isin].length > secName.length) {
      secName = isinNames[isin]; // prefer longer (more complete) name from summary
    }

    const type = qty > 0 ? 'BUY' : 'SELL';
    const absQty = Math.abs(qty);
    const absTotal = Math.abs(netTotal);
    const rate = absQty > 0 ? parseFloat((absTotal / absQty).toFixed(4)) : 0;

    if (absQty > 0 && rate > 0) {
      trades.push({
        tradeDate, security: secName, isin, type,
        quantity: absQty, rate, total: absTotal,
        brokerage: 0, stt: 0,
      });
    }
  }

  // Extract charges from summary section
  let brokerage = 0, stt = 0, gst = 0, stampDuty = 0;
  let exchangeCharges = 0, sebiCharges = 0, ipftCharges = 0;
  const lines = text.split('\n');
  for (const line of lines) {
    const nums = line.match(/([\-\d.]+)\s*$/);
    if (!nums) continue;
    const val = Math.abs(parseFloat(nums[1]));
    if (isNaN(val) || val === 0) continue;

    if (/Taxable\s+Value.*Brokerage/i.test(line)) brokerage = val;
    else if (/Exchange\s+Transaction\s+Charges/i.test(line)) exchangeCharges = val;
    else if (/IGST/i.test(line) && !/CGST|SGST/i.test(line)) gst += val;
    else if (/CGST/i.test(line)) gst += val;
    else if (/SGST/i.test(line)) gst += val;
    else if (/Securities\s+Transaction\s+Tax/i.test(line)) stt = val;
    else if (/SEBI\s+Turnover/i.test(line)) sebiCharges = val;
    else if (/Stamp\s+Duty/i.test(line)) stampDuty = val;
    else if (/IPFT\s+Charges/i.test(line)) ipftCharges = val;
  }

  const totalCharges = brokerage + stt + gst + stampDuty + exchangeCharges + sebiCharges + ipftCharges;

  // Pro-rate all charges across trades by trade value
  if (totalCharges > 0 && trades.length > 0) {
    const totalTradeValue = trades.reduce((s, t) => s + t.total, 0);
    for (const trade of trades) {
      trade.brokerage = totalTradeValue > 0
        ? parseFloat(((trade.total / totalTradeValue) * totalCharges).toFixed(2))
        : parseFloat((totalCharges / trades.length).toFixed(2));
    }
  }

  for (const trade of trades) delete trade.stt;

  return {
    broker: 'Groww', clientCode, panNumber, tradeDate,
    trades,
    charges: {
      total: totalCharges, brokerage, stt, gst,
      stampDuty, exchangeCharges, sebiCharges, ipftCharges,
    },
  };
}

/**
 * Parse contract notes from a buffer (supports ZIP containing HTM files, or single HTM).
 * @param {Buffer} buffer - File content
 * @param {string} fileName - Original filename
 * @param {string} [password] - Password for encrypted PDFs (e.g. PAN number)
 * @returns {Promise<Array>} Array of parsed note objects { broker, clientCode, panNumber, tradeDate, trades[], charges }
 */
async function parseContractNotes(buffer, fileName, password) {
  const isZip = /\.zip$/i.test(fileName);
  const isPdf = /\.pdf$/i.test(fileName);
  const results = [];

  if (isPdf) {
    const opts = { data: buffer };
    if (password) opts.password = password;
    const parser = new PDFParse(opts);
    const result = await parser.getText();
    const text = result.text;
    await parser.destroy();
    const broker = detectBroker(text);
    let parsed = null;
    if (broker === 'Groww') {
      parsed = parseGrowwPDF(text, fileName);
    }
    if (parsed && parsed.trades.length > 0) {
      results.push(parsed);
    }
  } else if (isZip) {
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries();
    for (const entry of entries) {
      if (entry.isDirectory) continue;
      if (!/\.htm[l]?$/i.test(entry.entryName)) continue;
      const text = entry.getData().toString('utf8');
      const broker = detectBroker(text);
      let parsed = null;
      if (broker === 'Sharekhan') {
        parsed = parseSharekhanHTM(text, entry.entryName);
      } else {
        // Try Sharekhan parser as generic fallback
        parsed = parseSharekhanHTM(text, entry.entryName);
      }
      if (parsed && parsed.trades.length > 0) {
        results.push(parsed);
      }
    }
  } else if (/\.htm[l]?$/i.test(fileName)) {
    const text = buffer.toString('utf8');
    const parsed = parseSharekhanHTM(text, fileName);
    if (parsed && parsed.trades.length > 0) {
      results.push(parsed);
    }
  }

  return results;
}

module.exports = { parseContractNotes };

