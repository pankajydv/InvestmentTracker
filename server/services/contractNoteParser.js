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

  // Clean up: keep per-trade STT allocated by trade value (STT is not a
  // deductible cost, so downstream tax logic needs it separately). `brokerage`
  // still carries the full charge (incl STT) so `fees` stays the total.
  if (totalSTT > 0 && trades.length > 0) {
    const totalTradeValue = trades.reduce((s, t) => s + t.total, 0);
    for (const trade of trades) {
      trade.stt = totalTradeValue > 0
        ? parseFloat(((trade.total / totalTradeValue) * totalSTT).toFixed(2))
        : parseFloat((totalSTT / trades.length).toFixed(2));
    }
  } else {
    for (const trade of trades) trade.stt = 0;
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

function allocateCharge(total, targets, weightFor, field) {
  const roundedTotal = Math.round((Number(total) || 0) * 100) / 100;
  if (roundedTotal <= 0 || targets.length === 0) return;

  const weights = targets.map((target) => Math.max(0, Number(weightFor(target)) || 0));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  let allocated = 0;
  targets.forEach((target, index) => {
    const amount = index === targets.length - 1
      ? roundedTotal - allocated
      : Math.round((totalWeight > 0 ? roundedTotal * weights[index] / totalWeight : roundedTotal / targets.length) * 100) / 100;
    target[field] = Math.round(((target[field] || 0) + amount) * 100) / 100;
    allocated = Math.round((allocated + amount) * 100) / 100;
  });
}

/**
 * Parse a Groww PDF contract note.
 * The summary table contains both sides of same-day trades, while Annexure
 * "Total ISIN" rows contain only the net settlement quantity.
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

  // Join all text to handle line wraps in security names and table headers.
  const fullText = text.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ');

  // Parse the Groww security summary. It contains gross buy/sell quantities,
  // WAPs and exact brokerage per share before the net settlement columns.
  const summaryRowRegex = /(IN[EF][A-Z0-9]{9})\s+(.+?)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+(-?[\d,.]+)\s+(-?\d+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d,.]+)\s+(-?\d+)\s+(-?\s*[\d,.]+)/g;
  const summaryRows = [];
  let m;
  while ((m = summaryRowRegex.exec(fullText)) !== null) {
    summaryRows.push({
      isin: m[1],
      security: m[2].trim(),
      buyQuantity: Math.abs(parseInt(m[3].replace(/,/g, '')) || 0),
      buyRate: parseFloat(m[4]) || 0,
      buyBrokeragePerShare: parseFloat(m[5]) || 0,
      sellQuantity: Math.abs(parseInt(m[8].replace(/,/g, '')) || 0),
      sellRate: parseFloat(m[9]) || 0,
      sellBrokeragePerShare: parseFloat(m[10]) || 0,
      netQuantity: parseInt(m[13].replace(/,/g, '')) || 0,
      netAmountAfterBrokerage: Math.abs(parseFloat(m[14].replace(/[\s,]/g, ''))) || 0,
    });
  }

  const trades = [];
  const intradayTrades = [];
  const chargeTargets = [];

  for (const row of summaryRows) {
    const matchedQuantity = Math.min(row.buyQuantity, row.sellQuantity);
    if (matchedQuantity > 0) {
      const grossBuyValue = matchedQuantity * row.buyRate;
      const grossSellValue = matchedQuantity * row.sellRate;
      const intraday = {
        tradeDate,
        security: row.security,
        isin: row.isin,
        quantity: matchedQuantity,
        buyRate: row.buyRate,
        sellRate: row.sellRate,
        buyValue: parseFloat(grossBuyValue.toFixed(2)),
        sellValue: parseFloat(grossSellValue.toFixed(2)),
        grossProfit: parseFloat((grossSellValue - grossBuyValue).toFixed(2)),
        brokerage: 0,
        stt: 0,
        fees: 0,
      };
      intradayTrades.push(intraday);
      chargeTargets.push({
        kind: 'intraday',
        record: intraday,
        buyValue: intraday.buyValue,
        sellValue: intraday.sellValue,
        brokerageWeight: matchedQuantity * (row.buyBrokeragePerShare + row.sellBrokeragePerShare),
        sttWeight: intraday.sellValue * (/gold|silver/i.test(row.security) ? 0.00001 : 0.00025),
      });
    }

    const residualBuyQuantity = Math.max(0, row.buyQuantity - matchedQuantity);
    const residualSellQuantity = Math.max(0, row.sellQuantity - matchedQuantity);
    const quantity = residualBuyQuantity || residualSellQuantity;
    if (quantity > 0) {
      const type = residualBuyQuantity > 0 ? 'BUY' : 'SELL';
      const rate = type === 'BUY' ? row.buyRate : row.sellRate;
      const total = parseFloat((quantity * rate).toFixed(2));
      const trade = {
        tradeDate, security: row.security, isin: row.isin, type,
        quantity, rate, total,
        brokerage: 0, stt: 0,
      };
      trades.push(trade);
      chargeTargets.push({
        kind: 'delivery',
        record: trade,
        buyValue: type === 'BUY' ? total : 0,
        sellValue: type === 'SELL' ? total : 0,
        brokerageWeight: quantity * (type === 'BUY' ? row.buyBrokeragePerShare : row.sellBrokeragePerShare),
        sttWeight: type === 'SELL' ? total * (/gold|silver/i.test(row.security) ? 0.00001 : 0.001) : 0,
      });
    }
  }

  // Legacy fallback: older Groww PDFs may omit the gross-side summary layout.
  // Preserve the previous behavior for their non-zero settlement totals.
  if (summaryRows.length === 0) {
    const securityEntries = [];
    const tradeLineRegex = /\d{2}:\d{2}:\d{2}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+(.*?)\s+(BSE|NSE)\s+[BS]\s/g;
    while ((m = tradeLineRegex.exec(fullText)) !== null) {
      securityEntries.push({ name: m[1].trim(), pos: m.index });
    }
    const legacyTotalRegex = /Total\s+(IN[EF][A-Z0-9]{9})\s+([\-\d,]+)\s+([\-\d,.]+)/g;
    while ((m = legacyTotalRegex.exec(fullText)) !== null) {
      const quantity = parseInt(m[2].replace(/,/g, '')) || 0;
      if (quantity === 0) continue;
      const total = Math.abs(parseFloat(m[3].replace(/,/g, ''))) || 0;
      const rate = total / Math.abs(quantity);
      let security = m[1];
      for (const entry of securityEntries) {
        if (entry.pos < m.index) security = entry.name;
      }
      const trade = {
        tradeDate, security, isin: m[1], type: quantity > 0 ? 'BUY' : 'SELL',
        quantity: Math.abs(quantity), rate: parseFloat(rate.toFixed(4)), total,
        brokerage: 0, stt: 0,
      };
      trades.push(trade);
      chargeTargets.push({
        kind: 'delivery', record: trade,
        buyValue: quantity > 0 ? total : 0,
        sellValue: quantity < 0 ? total : 0,
        brokerageWeight: total,
        sttWeight: quantity < 0 ? total * (/gold|silver/i.test(security) ? 0.00001 : 0.001) : 0,
      });
    }
  }

  // Extract charges from summary section using fullText (handles line-wrapped GST descriptions)
  let brokerage = 0, stt = 0, gst = 0, stampDuty = 0;
  let exchangeCharges = 0, sebiCharges = 0, ipftCharges = 0;
  let dpCharges = 0;
  const chargeVal = (regex) => {
    const m = fullText.match(regex);
    return m ? Math.abs(parseFloat(m[1])) : 0;
  };
  brokerage = chargeVal(/Taxable\s+Value\s+of\s+Supply\s*\(Brokerage\)\s+([\-\d.]+)/i);
  exchangeCharges = chargeVal(/Exchange\s+Transaction\s+Charges\s+([\-\d.]+)/i);
  stt = chargeVal(/Securities\s+Transaction\s+Tax\s+([\-\d.]+)/i);
  sebiCharges = chargeVal(/SEBI\s+Turnover\s+Fees\s+([\-\d.]+)/i);
  stampDuty = chargeVal(/Stamp\s+Duty\s+([\-\d.]+)/i);
  ipftCharges = chargeVal(/IPFT\s+Charges\s+([\-\d.]+)/i);
  // GST: match through closing ) to handle descriptions that wrap across lines
  gst += chargeVal(/IGST\s*\([^)]*\)\s*([\-\d.]+)/i);
  gst += chargeVal(/CGST\s*\([^)]*\)\s*([\-\d.]+)/i);
  gst += chargeVal(/SGST\s*\([^)]*\)\s*([\-\d.]+)/i);

  // Extract DP charges from the separate DP section (only present when sells exist)
  // Formats: "DP Charges 67.50 12.15 79.65" or "CDSL DP Charges ... / Groww DP Charges ..."
  // The section ends with a "Total <amount>" line before "Amount Chargeable"
  const dpTotalMatch = text.match(/Total\s+([\d.]+)\s*\r?\n\s*Amount\s+Chargeable/i);
  if (dpTotalMatch) {
    dpCharges = parseFloat(dpTotalMatch[1]) || 0;
  }

  const tradingCharges = brokerage + stt + gst + stampDuty + exchangeCharges + sebiCharges + ipftCharges;
  const totalCharges = parseFloat((tradingCharges + dpCharges).toFixed(2));

  allocateCharge(brokerage, chargeTargets, (target) => target.brokerageWeight || target.buyValue + target.sellValue, 'brokerage');
  allocateCharge(exchangeCharges, chargeTargets, (target) => target.buyValue + target.sellValue, 'exchangeCharges');
  allocateCharge(sebiCharges, chargeTargets, (target) => target.buyValue + target.sellValue, 'sebiCharges');
  allocateCharge(ipftCharges, chargeTargets, (target) => target.buyValue + target.sellValue, 'ipftCharges');
  allocateCharge(gst, chargeTargets, (target) => target.brokerage + target.exchangeCharges + target.sebiCharges + target.ipftCharges, 'gst');
  allocateCharge(stampDuty, chargeTargets.filter((target) => target.buyValue > 0), (target) => target.buyValue, 'stampDuty');
  allocateCharge(stt, chargeTargets.filter((target) => target.sellValue > 0), (target) => target.sttWeight, 'stt');
  allocateCharge(dpCharges, chargeTargets.filter((target) => target.kind === 'delivery' && target.sellValue > 0), () => 1, 'dpCharges');

  for (const target of chargeTargets) {
    const breakdown = {
      brokerage: target.brokerage || 0,
      stt: target.stt || 0,
      gst: target.gst || 0,
      stampDuty: target.stampDuty || 0,
      exchangeCharges: target.exchangeCharges || 0,
      sebiCharges: target.sebiCharges || 0,
      ipftCharges: target.ipftCharges || 0,
      dpCharges: target.dpCharges || 0,
    };
    const fees = parseFloat(Object.values(breakdown).reduce((sum, value) => sum + value, 0).toFixed(2));
    target.record.chargeBreakdown = breakdown;
    target.record.stt = breakdown.stt;
    if (target.kind === 'delivery') {
      target.record.brokerage = fees;
    } else {
      target.record.fees = fees;
      target.record.netProfit = parseFloat((target.record.grossProfit - fees).toFixed(2));
    }
  }

  return {
    broker: 'Groww', clientCode, panNumber, tradeDate,
    trades, intradayTrades,
    charges: {
      total: totalCharges, brokerage, stt, gst,
      stampDuty, exchangeCharges, sebiCharges, ipftCharges, dpCharges,
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

module.exports = { parseContractNotes, parseGrowwPDF };

