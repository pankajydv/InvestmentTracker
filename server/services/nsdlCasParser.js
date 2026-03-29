/**
 * NSDL Consolidated Account Statement (CAS) PDF Parser
 * Extracts demat holdings (stocks, ETFs/MFs) and mutual fund folios
 * from the CAS PDF issued by NSDL.
 *
 * NSDL CAS is a holdings snapshot (like CDSL CAS), not a transaction
 * history (like CAMS CAS). It covers demat accounts held with NSDL
 * depositories plus mutual fund folios.
 *
 * Output shape matches casParser.js (CDSL) so the same frontend renders both.
 */
const { PDFParse } = require('pdf-parse');

// ─── Helpers ─────────────────────────────────────────────────────────

function parseIndianNumber(str) {
  if (!str) return 0;
  return parseFloat(str.replace(/,/g, '')) || 0;
}

function isHindiLine(line) {
  const hindiChars = (line.match(/[\u0900-\u097F]/g) || []).length;
  const totalChars = line.replace(/\s/g, '').length;
  return totalChars > 0 && (hindiChars / totalChars) > 0.3;
}

/**
 * Detect whether extracted text is from an NSDL CAS.
 * @param {string} text - Full extracted text from the PDF
 * @returns {boolean}
 */
function isNSDLCAS(text) {
  // Primary: explicit NSDL CAS branding
  if (/NSDL\s+Consolidated\s+Account\s+Statement/i.test(text)) return true;
  // Secondary: "NSDL demat account" section header without CDSL markers
  if (/NSDL\s+demat\s+account/i.test(text) && !/CDSL/i.test(text.slice(0, 500))) return true;
  // Tertiary: "Statement for the period" + NSDL markers (DP Id pattern)
  if (/Statement\s+for\s+the\s+period\s+from/i.test(text) &&
      /DP\s*Id\s*:/i.test(text) &&
      /Client\s*Id\s*:/i.test(text)) return true;
  return false;
}

// ─── Main parser ─────────────────────────────────────────────────────

/**
 * Parse an NSDL CAS PDF buffer and extract all holdings.
 * @param {Buffer} pdfBuffer - Raw PDF file buffer
 * @param {string} password  - PAN number used as PDF password
 * @returns {Promise<Object>} Parsed holdings (same shape as CDSL parser)
 */
async function parseNSDLCAS(pdfBuffer, password) {
  const parser = new PDFParse({ data: pdfBuffer, password, verbosity: 0 });
  const result = await parser.getText();
  const text = result.text;

  if (!isNSDLCAS(text)) {
    throw new Error('Not an NSDL CAS PDF');
  }

  const investorName = extractInvestorName(text);
  const portfolioValue = extractPortfolioValue(text);
  const statementPeriod = extractStatementPeriod(text);

  const dematHoldings = parseDematHoldings(text);
  const mfHoldings = parseMFHoldings(text);

  // Classify demat holdings: INE = stocks, INF = MF/ETF
  const stockMap = new Map();
  const dematMFMap = new Map();

  for (const h of dematHoldings) {
    if (h.isin.startsWith('INE')) {
      if (stockMap.has(h.isin)) {
        const existing = stockMap.get(h.isin);
        existing.units += h.units;
        existing.value += h.value;
      } else {
        stockMap.set(h.isin, { ...h, asset_type: 'INDIAN_STOCK' });
      }
    } else if (h.isin.startsWith('INF')) {
      if (dematMFMap.has(h.isin)) {
        const existing = dematMFMap.get(h.isin);
        existing.units += h.units;
        existing.value += h.value;
      } else {
        dematMFMap.set(h.isin, { ...h, asset_type: 'MUTUAL_FUND', source: 'demat' });
      }
    }
  }

  const stocks = [...stockMap.values()];
  const dematMFs = [...dematMFMap.values()];
  const rtaMFs = mfHoldings.map(h => ({ ...h, asset_type: 'MUTUAL_FUND', source: 'rta' }));

  return {
    investorName,
    portfolioValue,
    statementPeriod,
    stocks,
    mutualFunds: [...dematMFs, ...rtaMFs],
    bonds: [],  // NSDL CAS doesn't have a separate bonds section like CDSL
    summary: {
      totalStocks: stocks.length,
      totalMFs: dematMFs.length + rtaMFs.length,
      totalBonds: 0,
      totalHoldings: stocks.length + dematMFs.length + rtaMFs.length,
    },
  };
}

// ─── Extraction functions ────────────────────────────────────────────

function extractInvestorName(text) {
  // Pattern 1: "Account Holder(s): NAME (PAN: XXXXX)"
  let m = text.match(/Account\s+Holder\(?s?\)?\s*:\s*([A-Z][A-Z\s]+?)(?:\s*\(PAN)/i);
  if (m) return m[1].trim();
  // Pattern 2: "Name (PAN: XXXXX)"  right after CAS ID
  m = text.match(/(?:CAS\s+ID\s*:.+?\n)\s*([A-Z][A-Z\s]+?)(?:\s*\(PAN|\s*\n)/i);
  if (m) return m[1].trim();
  // Pattern 3: generic — investor name above PAN on a line
  m = text.match(/([A-Z][A-Z\s]{3,30})\s*\(PAN\s*:\s*[A-Z]{5}\d{4}[A-Z]\)/);
  if (m) return m[1].trim();
  return null;
}

function extractPortfolioValue(text) {
  // "Total Portfolio Value: 12,34,567.89" or "Total Portfolio Value 12,34,567.89"
  const m = text.match(/Total\s+Portfolio\s+Value\s*:?\s*([\d,]+\.\d+)/i);
  return m ? parseIndianNumber(m[1]) : null;
}

function extractStatementPeriod(text) {
  const m = text.match(
    /(?:statement\s+)?for\s+the\s+period\s+(?:from\s+)?(\d{2}-[A-Za-z]{3}-\d{4})\s+to\s+(\d{2}-[A-Za-z]{3}-\d{4})/i
  );
  if (m) return { from: m[1], to: m[2] };
  return null;
}

// ─── DEMAT HOLDINGS ──────────────────────────────────────────────────

/**
 * Parse demat equity/MF holdings.
 * NSDL CAS has tabular sections under "NSDL demat account" headers.
 * Each row: [Sr.No] ISIN SecurityName FaceValue NumShares MarketRate MarketValue
 *
 * Typical text when extracted with pdf-parse:
 *   1 INE009A01021 INFOSYS LTD 5.00 50 1,545.60 77,280.00
 * Or multi-line:
 *   INE009A01021 INFOSYS LIMITED
 *   NEW EQUITY SHARES OF RS 5 EACH
 *   5.00 50 1,545.60 77,280.00
 */
function parseDematHoldings(text) {
  const holdings = [];
  const seen = new Set();

  // Extract section(s) between demat account headers and the next major section
  // Possible section markers depend on the actual NSDL CAS layout
  const sections = [];

  // Try to isolate NSDL demat sections
  const dematPattern = /(?:NSDL\s+demat\s+account|CDSL\s+demat\s+account|Demat\s+Account\s+Holdings?|HOLDING\s+STATEMENT)/gi;
  const endPattern = /(?:Mutual\s+Fund\s+Folios|Mutual\s+Fund\s+Units|Total\s+Portfolio\s+Value|Disclaimer|For\s+any\s+queries)/i;

  let dematMatch;
  while ((dematMatch = dematPattern.exec(text)) !== null) {
    const startIdx = dematMatch.index;
    const remaining = text.slice(startIdx);
    const endMatch = endPattern.exec(remaining.slice(200)); // skip at least 200 chars
    const endIdx = endMatch ? startIdx + 200 + endMatch.index : text.length;
    sections.push(text.slice(startIdx, endIdx));
  }

  // If no explicit sections found, try the whole text for ISIN-based extraction
  if (sections.length === 0) {
    sections.push(text);
  }

  for (const section of sections) {
    const lines = section.split('\n');
    let i = 0;

    while (i < lines.length) {
      const line = lines[i].trim();

      // Look for ISIN on this line
      const isinMatch = line.match(/(IN[EF]\w{9,10})\b/);
      if (isinMatch) {
        const isin = isinMatch[1];
        let allText = line;
        i++;

        // Collect continuation lines until we find numeric data
        while (i < lines.length) {
          const nextLine = lines[i].trim();
          if (!nextLine || isHindiLine(nextLine)) { i++; continue; }

          // Check if this is a new ISIN line
          if (/^(?:\d+\s+)?IN[EF]\w{9,10}\b/.test(nextLine)) break;

          // Check for numeric row: face_value num_shares market_price market_value
          // Or: num_shares [--] [--] [--] free_bal price value (CDSL-style in NSDL)
          const numMatch = nextLine.match(
            /^([\d,.]+)\s+([\d,.]+)\s+([\d,.]+)\s+([\d,.]+)$/
          );
          if (numMatch) {
            // 4 numbers: face_value, num_shares, market_price, market_value
            const faceVal = parseIndianNumber(numMatch[1]);
            const units = parseIndianNumber(numMatch[2]);
            const price = parseIndianNumber(numMatch[3]);
            const value = parseIndianNumber(numMatch[4]);
            if (units > 0) {
              const name = cleanSecurityName(allText, isin);
              const key = `${isin}-${units}-${value}`;
              if (!seen.has(key)) {
                seen.add(key);
                holdings.push({ isin, name, units, price, value });
              }
            }
            i++;
            break;
          }

          // Also check: data might be inline with ISIN
          // e.g. "INE009A01021 INFOSYS LTD 5.00 50 1,545.60 77,280.00"
          const inlineMatch = allText.match(
            /IN[EF]\w{9,10}\s+(.+?)\s+([\d,.]+)\s+([\d,.]+)\s+([\d,.]+)\s+([\d,.]+)\s*$/
          );
          if (inlineMatch) {
            const units = parseIndianNumber(inlineMatch[3]);
            const price = parseIndianNumber(inlineMatch[4]);
            const value = parseIndianNumber(inlineMatch[5]);
            if (units > 0) {
              const name = cleanSecurityName(inlineMatch[1], isin);
              const key = `${isin}-${units}-${value}`;
              if (!seen.has(key)) {
                seen.add(key);
                holdings.push({ isin, name, units, price, value });
              }
            }
            break;
          }

          // Another inline pattern: "1 INE009A01021 INFOSYS LTD 5.00 50 1,545.60 77,280.00"
          const numberedInline = allText.match(
            /\d+\s+IN[EF]\w{9,10}\s+(.+?)\s+([\d,.]+)\s+([\d,.]+)\s+([\d,.]+)\s+([\d,.]+)\s*$/
          );
          if (numberedInline) {
            const units = parseIndianNumber(numberedInline[3]);
            const price = parseIndianNumber(numberedInline[4]);
            const value = parseIndianNumber(numberedInline[5]);
            if (units > 0) {
              const name = cleanSecurityName(numberedInline[1], isin);
              const key = `${isin}-${units}-${value}`;
              if (!seen.has(key)) {
                seen.add(key);
                holdings.push({ isin, name, units, price, value });
              }
            }
            break;
          }

          // Check for NSDL-specific pattern with dashes
          // num -- -- -- free_bal price value
          const dashMatch = nextLine.match(
            /^([\d,.]+)\s+--\s+--\s+--\s+([\d,.]+)\s+([\d,.]+)\s+([\d,.]+)$/
          );
          if (dashMatch) {
            const units = parseIndianNumber(dashMatch[1]);
            const price = parseIndianNumber(dashMatch[3]);
            const value = parseIndianNumber(dashMatch[4]);
            if (units > 0) {
              const name = cleanSecurityName(allText, isin);
              const key = `${isin}-${units}-${value}`;
              if (!seen.has(key)) {
                seen.add(key);
                holdings.push({ isin, name, units, price, value });
              }
            }
            i++;
            break;
          }

          allText += ' ' + nextLine;
          i++;
        }
      } else {
        i++;
      }
    }
  }

  return holdings;
}

/**
 * Clean security name from raw text around ISIN line.
 */
function cleanSecurityName(raw, isin) {
  let name = raw
    .replace(/[\u0900-\u097F]/g, '')          // Remove Hindi
    .replace(new RegExp(isin, 'g'), '')         // Remove ISIN itself
    .replace(/^\d+\s*/, '')                     // Remove leading serial number
    .replace(/[\n\r]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // For "COMPANY NAME#DESCRIPTION" format
  if (name.includes('#')) {
    const parts = name.split('#');
    const afterHash = parts.slice(1).join('#').trim();
    const beforeHash = parts[0].trim();
    if (/\b(MF|FUND|ETF|GROWTH|BEES)\b/i.test(afterHash)) {
      name = afterHash;
    } else {
      name = beforeHash;
    }
  }

  // Clean trailing equity description
  name = name.replace(/\s*(?:NEW\s+)?EQUITY\s+SHARES.*$/i, '');
  name = name.replace(/\s*(?:NEW\s+)?EQ\.?\s+SH.*$/i, '');
  name = name.replace(/\s*FACE\s+VAL.*$/i, '');
  name = name.replace(/\s*OF\s+RS\.?\s+\d.*$/i, '');
  name = name.replace(/\s*#\s*$/, '');
  name = name.replace(/[-\s]+$/, '');
  // Remove trailing numbers (face value etc.)
  name = name.replace(/\s+[\d,.]+\s*$/, '');

  return name.trim();
}

// ─── MUTUAL FUND HOLDINGS ────────────────────────────────────────────

/**
 * Parse "Mutual Fund Folios" section in NSDL CAS.
 * NSDL CAS shows MF holdings with: ISIN, Scheme Name, Folio, Units, NAV, Cost, Value, P&L
 *
 * Typical format per entry (may span multiple lines):
 *   INF846K01K35 Axis Small Cap Fund Direct Growth 910174581715/0 1,538.870 118.45 1,70,000.00 1,82,227.17 12,227.17 7.19
 * Or tabular:
 *   ISIN | UCC | Scheme | Folio | Units | Avg Cost | Total Cost | NAV | Value | P&L | Return%
 */
function parseMFHoldings(text) {
  const holdings = [];

  // Isolate the MF section
  const sectionMatch = text.match(
    /(?:Mutual\s+Fund\s+Folios?|Mutual\s+Fund\s+Units\s+Held)[^\n]*\n([\s\S]*?)(?:Total\s+Portfolio\s+Value|Disclaimer|For\s+any\s+queries|$)/i
  );
  if (!sectionMatch) return holdings;

  let section = sectionMatch[1];

  // Remove header rows
  section = section.replace(/(?:Sr\.?\s*No\.?|ISIN|Scheme\s+Name|Folio\s+No|Units|NAV|Cost|Value|Gain|Loss|Return)[^\n]*\n/gi, '');

  const lines = section.split('\n');
  const flatLines = lines
    .map(l => l.trim())
    .filter(l => l && !isHindiLine(l))
    .join(' ');

  // Pattern 1: ISIN followed by scheme details and numbers
  // INF... SchemeName Folio Units [AvgCost] [TotalCost/Invested] NAV Value [P&L] [Return%]
  const entryPattern = /(INF\w{9,10})\s+(.+?)\s+([\w/]+)\s+([\d,.]+)\s+([\d,.]+)\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+(-?[\d,]+\.\d{2})\s+(-?[\d.]+)/g;
  let match;

  while ((match = entryPattern.exec(flatLines)) !== null) {
    const isin = match[1];
    let schemeName = match[2].trim();
    const folio = match[3];
    const units = parseIndianNumber(match[4]);
    const nav = parseIndianNumber(match[5]);
    const invested = parseIndianNumber(match[6]);
    const value = parseIndianNumber(match[7]);
    const profitLoss = parseIndianNumber(match[8]);
    const profitLossPct = parseFloat(match[9]);

    // Clean scheme name: remove leading code if present ("SCDG -")
    schemeName = schemeName.replace(/^[\w\d]+\s*-\s*/, '').trim();

    holdings.push({
      isin,
      name: schemeName,
      folio,
      units,
      nav,
      invested,
      value,
      profitLoss,
      profitLossPct,
    });
  }

  // Pattern 2: If pattern 1 found nothing, try simpler ISIN-based extraction
  // Some NSDL CAS layouts have fewer columns: ISIN Name Units NAV Value
  if (holdings.length === 0) {
    const simplePattern = /(INF\w{9,10})\s+(.+?)\s+([\d,.]+)\s+([\d,.]+)\s+([\d,]+\.\d{2})/g;
    while ((match = simplePattern.exec(flatLines)) !== null) {
      const isin = match[1];
      let name = match[2].trim();
      const units = parseIndianNumber(match[3]);
      const nav = parseIndianNumber(match[4]);
      const value = parseIndianNumber(match[5]);

      name = name.replace(/^[\w\d]+\s*-\s*/, '').trim();

      holdings.push({
        isin,
        name,
        folio: null,
        units,
        nav,
        invested: null,
        value,
        profitLoss: null,
        profitLossPct: null,
      });
    }
  }

  return holdings;
}

module.exports = { parseNSDLCAS, isNSDLCAS };
