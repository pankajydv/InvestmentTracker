/**
 * CDSL Consolidated Account Statement (CAS) PDF Parser
 * Extracts mutual fund holdings, demat holdings (stocks + ETFs/MFs), and bonds
 * from the CAS PDF issued by CDSL.
 */
const { PDFParse } = require('pdf-parse');

/**
 * Parse a CAS PDF buffer and extract all holdings
 * @param {Buffer} pdfBuffer - Raw PDF file buffer
 * @param {string} password - PAN number used as PDF password
 * @returns {Promise<Object>} Parsed holdings grouped by type
 */
async function parseCAS(pdfBuffer, password) {
  const parser = new PDFParse({ data: pdfBuffer, password, verbosity: 0 });
  const result = await parser.getText();
  const text = result.text;

  // Extract investor name
  const investorName = extractInvestorName(text);
  const portfolioValue = extractPortfolioValue(text);

  // Parse each section
  const dematHoldings = parseDematHoldings(text);
  const mfHoldings = parseMFHoldings(text);
  const bondHoldings = parseBondHoldings(text);

  // Classify demat holdings: INE = stocks, INF = MF/ETF
  const stockMap = new Map();
  const dematMFMap = new Map();

  for (const h of dematHoldings) {
    if (h.isin.startsWith('INE')) {
      // Deduplicate stocks by ISIN (merge if held on multiple DP accounts)
      if (stockMap.has(h.isin)) {
        const existing = stockMap.get(h.isin);
        existing.units += h.units;
        existing.value += h.value;
      } else {
        stockMap.set(h.isin, { ...h, asset_type: 'INDIAN_STOCK' });
      }
    } else if (h.isin.startsWith('INF')) {
      // Deduplicate demat MFs by ISIN
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
    stocks,
    mutualFunds: [...dematMFs, ...rtaMFs],
    bonds: bondHoldings,
    summary: {
      totalStocks: stocks.length,
      totalMFs: dematMFs.length + rtaMFs.length,
      totalBonds: bondHoldings.length,
      totalHoldings: stocks.length + dematMFs.length + rtaMFs.length + bondHoldings.length,
    },
  };
}

function extractInvestorName(text) {
  const match = text.match(/single name of\s*\n?\s*([A-Z][A-Z\s]+?)(?:\s*\(\s*PAN)/i);
  if (match) return match[1].trim();
  return null;
}

function extractPortfolioValue(text) {
  const match = text.match(/Total Portfolio Value\s+([\d,]+\.\d+)/);
  return match ? parseIndianNumber(match[1]) : null;
}

// ─── DEMAT HOLDINGS ───────────────────────────────────────────────────

/**
 * Parse all "HOLDING STATEMENT AS ON" sections (demat stocks + MFs/ETFs)
 * Text format (multi-line per holding):
 *   ISIN COMPANY_NAME#DESCRIPTION
 *   CONTINUATION_NAME
 *   CONTINUATION... units -- -- -- freebal price value
 */
function parseDematHoldings(text) {
  const holdings = [];

  // Extract ALL text between "HOLDING STATEMENT AS ON" and "HOLDING STATEMENT OF BONDS"
  // (or end of demat section). This may span multiple DP accounts and pages.
  const bigSection = text.match(
    /HOLDING STATEMENT AS ON[\s\S]*?(?=HOLDING STATEMENT OF BONDS|For any queries regarding demat|MUTUAL FUND UNITS HELD)/
  );
  if (!bigSection) return holdings;

  const sectionText = bigSection[0];
  const lines = sectionText.split('\n');
  const seen = new Set(); // Track ISIN+line combos to avoid dupes from Hindi repetition

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();

    // Look for lines starting with an ISIN code
    const isinMatch = line.match(/^(IN[EF]\w{9,10})\b/);
    if (isinMatch) {
      const isin = isinMatch[1];
      // Collect the security name and numeric data
      // Name starts on the same line after the ISIN, may span multiple lines
      // Ends when we hit the numeric pattern: number -- -- -- number number number,number
      let allText = line.substring(isin.length).trim();
      i++;

      // Keep collecting lines until we find the numeric data row
      while (i < lines.length) {
        const nextLine = lines[i].trim();
        if (!nextLine || isHindiLine(nextLine)) { i++; continue; }

        // Check if this line has the numeric pattern: N.NNN -- -- -- N.NNN N.NNN N,NN,NNN.NN
        const numMatch = nextLine.match(
          /^([\d,.]+)\s+--\s+--\s+--\s+([\d,.]+)\s+([\d,.]+)\s+([\d,.]+)$/
        );
        if (numMatch) {
          const units = parseIndianNumber(numMatch[1]);
          const price = parseIndianNumber(numMatch[3]);
          const value = parseIndianNumber(numMatch[4]);

          if (units > 0) {
            const name = cleanDematName(allText);
            const key = `${isin}-${units}-${value}`;
            if (!seen.has(key)) {
              seen.add(key);
              holdings.push({ isin, name, units, price, value });
            }
          }
          i++;
          break;
        }

        // Also check: data may be concatenated to end of a name line
        const inlineMatch = nextLine.match(
          /(.*?)\s+([\d,.]+)\s+--\s+--\s+--\s+([\d,.]+)\s+([\d,.]+)\s+([\d,.]+)$/
        );
        if (inlineMatch) {
          allText += ' ' + inlineMatch[1];
          const units = parseIndianNumber(inlineMatch[2]);
          const price = parseIndianNumber(inlineMatch[4]);
          const value = parseIndianNumber(inlineMatch[5]);

          if (units > 0) {
            const name = cleanDematName(allText);
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

  return holdings;
}

/**
 * Clean demat security name
 */
function cleanDematName(raw) {
  let name = raw
    .replace(/[\u0900-\u097F]/g, '')    // Remove Hindi
    .replace(/[\n\r]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // For format "COMPANY NAME#SCHEME DESCRIPTION"
  if (name.includes('#')) {
    const parts = name.split('#');
    // For stocks: "BAJAJ FINANCE LIMITED#NEW EQUITY SHARES..." -> "BAJAJ FINANCE LIMITED"
    // For MFs: "HDFC AMC LTD#HDFC MF-FOCUSED FUND-DIRECT-GROWTH" -> "HDFC MF-FOCUSED FUND-DIRECT-GROWTH"
    const afterHash = parts.slice(1).join('#').trim();
    const beforeHash = parts[0].trim();

    // If afterHash looks like an MF (has "MF" or "FUND" or "ETF"), use it
    if (/\b(MF|FUND|ETF|GROWTH|BEES)\b/i.test(afterHash)) {
      name = afterHash;
    } else {
      // Use the company name (before #)
      name = beforeHash;
    }
  }

  // Clean trailing description for stocks
  name = name.replace(/\s*NEW\s+EQUITY\s+SHARES.*$/i, '');
  name = name.replace(/\s*NEW\s+EQ\s+SH.*$/i, '');
  name = name.replace(/\s*EQUITY\s+SHARES.*$/i, '');
  name = name.replace(/\s*#\s*$/, '');
  name = name.replace(/[-\s]+$/, '');

  return name.trim();
}

// ─── MUTUAL FUND (RTA) HOLDINGS ──────────────────────────────────────

/**
 * Parse "MUTUAL FUND UNITS HELD WITH MF/RTA" section
 * One row per scheme+folio, format:
 *   SchemeCode - SchemeName ISIN FolioNo ClosingUnits NAV Invested Valuation P/L P/L%
 * Entries can span multiple lines.
 */
function parseMFHoldings(text) {
  const holdings = [];

  // Isolate the MF section: from "MUTUAL FUND UNITS HELD AS ON" to "Grand Total"
  const sectionMatch = text.match(
    /MUTUAL FUND UNITS HELD AS ON[^\n]*\n([\s\S]*?)Grand Total/
  );
  if (!sectionMatch) return holdings;

  let section = sectionMatch[1];

  // Remove the header row
  section = section.replace(/Scheme Name\s+ISIN[\s\S]*?Loss\(%\)\s*\n?/, '');

  // Strategy: find each ISIN (INF...) and extract the numeric data that follows it
  // Then look backwards for the scheme name
  // The raw text around each entry looks like:
  //   "SCDG - Axis Small\nCap Fund Direct\nGrowth INF846K01K35 910174581715/0 1538.87 116.75 1,70,000.00 1,79,663.07 9,663.07 5.68"
  
  // Join all non-Hindi, non-empty lines into one string to flatten multi-line entries
  const lines = section.split('\n');
  const flatLines = lines
    .map(l => l.trim())
    .filter(l => l && !isHindiLine(l))
    .join(' ');

  // Now match: SchemeName ISIN Folio Units NAV Invested Valuation PL PL%
  const entryPattern = /([\w\d]+\s*-\s*[\s\S]*?)(INF\w{9,10})\s+([\w/]+)\s+(\d[\d,.]*)\s+(\d[\d,.]*)\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+(-?[\d,]+\.\d{2})\s+(-?[\d.]+)/g;
  let match;

  while ((match = entryPattern.exec(flatLines)) !== null) {
    let rawName = match[1].trim();
    const isin = match[2];
    const folio = match[3];
    const units = parseIndianNumber(match[4]);
    const nav = parseIndianNumber(match[5]);
    const invested = parseIndianNumber(match[6]);
    const value = parseIndianNumber(match[7]);
    const profitLoss = parseIndianNumber(match[8]);
    const profitLossPct = parseFloat(match[9]);

    // Clean scheme name: remove leading code like "SCDG - " or "8042 - "
    let schemeName = rawName.replace(/^[\w\d]+\s*-\s*/, '').trim();

    // Remove any previous entry's trailing data that leaked into this name
    // (happens when entries are concatenated)
    const lastNumIdx = schemeName.search(/-?\d[\d,.]*\s+(?:[\w\d]+\s*-\s*)/);
    if (lastNumIdx > 0) {
      const tail = schemeName.substring(lastNumIdx);
      const codeMatch = tail.match(/[\w\d]+\s*-\s*(.*)/);
      if (codeMatch) schemeName = codeMatch[1].trim();
    }

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

  return holdings;
}

// ─── BOND HOLDINGS ───────────────────────────────────────────────────

function parseBondHoldings(text) {
  const holdings = [];

  const sectionMatch = text.match(
    /HOLDING STATEMENT OF BONDS[\s\S]*?Portfolio Value for Bond/
  );
  if (!sectionMatch) return holdings;

  const section = sectionMatch[0];
  const lines = section.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const isinMatch = line.match(/^(IN[EF]\w{9,10})\s+(.+)/);
    if (!isinMatch) continue;

    const isin = isinMatch[1];
    let rest = isinMatch[2];

    // Collect continuation lines
    while (i + 1 < lines.length) {
      const next = lines[i + 1].trim();
      if (!next || isHindiLine(next) || /^IN[EF]/.test(next) || /^Portfolio Value/.test(next)) break;
      rest += ' ' + next;
      i++;
    }

    // Pattern: Name CouponRate MaturityDate Quantity FaceValue MarketValue TotalValue
    const bondMatch = rest.match(
      /(.+?)\s+(\d+\.\d+)\s+(\d{8})\s+([\d,.]+)\s+([\d,.]+)\s+([\d,.]+)\s+([\d,.]+)$/
    );
    if (bondMatch) {
      const quantity = parseIndianNumber(bondMatch[4]);
      if (quantity === 0) continue;
      holdings.push({
        isin,
        name: bondMatch[1].trim(),
        coupon: parseFloat(bondMatch[2]),
        maturityDate: bondMatch[3],
        quantity,
        faceValue: parseIndianNumber(bondMatch[5]),
        marketValue: parseIndianNumber(bondMatch[6]),
        value: parseIndianNumber(bondMatch[7]),
      });
    }
  }

  return holdings;
}

// ─── HELPERS ─────────────────────────────────────────────────────────

function parseIndianNumber(str) {
  if (!str) return 0;
  return parseFloat(str.replace(/,/g, '')) || 0;
}

function isHindiLine(line) {
  const hindiChars = (line.match(/[\u0900-\u097F]/g) || []).length;
  const totalChars = line.replace(/\s/g, '').length;
  return totalChars > 0 && (hindiChars / totalChars) > 0.3;
}

module.exports = { parseCAS };
