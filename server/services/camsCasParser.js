/**
 * CAMS / KFintech Consolidated Account Statement (CAS) PDF Parser
 * Extracts full MF transaction history from CAS PDFs issued by CAMS/KFintech.
 *
 * Unlike the CDSL CAS (casParser.js) which shows a point-in-time holdings snapshot,
 * the CAMS CAS contains every transaction ever made across all mutual fund folios.
 */
const { PDFParse } = require('pdf-parse');

// ─── Date helpers ────────────────────────────────────────────────────

const MONTHS = { Jan:'01', Feb:'02', Mar:'03', Apr:'04', May:'05', Jun:'06',
                 Jul:'07', Aug:'08', Sep:'09', Oct:'10', Nov:'11', Dec:'12' };

/** Convert "30-Oct-2023" → "2023-10-30" */
function toISO(ddMonYyyy) {
  const [d, m, y] = ddMonYyyy.split('-');
  return `${y}-${MONTHS[m] || '00'}-${d.padStart(2, '0')}`;
}

/** Parse Indian-format number: "1,70,000.00" → 170000, "(141,128.99)" → -141128.99 */
function parseNum(s) {
  if (!s) return 0;
  s = s.trim();
  const neg = s.startsWith('(') && s.endsWith(')');
  const cleaned = s.replace(/[(),]/g, '');
  const val = parseFloat(cleaned) || 0;
  return neg ? -val : val;
}

// ─── Transaction type mapping ────────────────────────────────────────

/** Map CAS description to our DB transaction_type */
function mapTransactionType(desc) {
  const d = desc.toLowerCase();
  if (d.includes('lateral shift out') || d.includes('switch out'))  return 'SELL';
  if (d.includes('lateral shift in')  || d.includes('switch in'))   return 'BUY';
  if (d.includes('redemption'))                                      return 'SELL';
  if (d.includes('purchase') || d.includes('new purchase'))          return 'BUY';
  if (d.includes('dividend') && d.includes('reinvest'))              return 'BUY';
  if (d.includes('dividend'))                                        return 'DIVIDEND';
  if (d.includes('merger'))                                          return 'MERGER';
  if (d.includes('consolidation'))                                   return 'CONSOLIDATION';
  return 'BUY'; // default
}

// ─── Main parser ─────────────────────────────────────────────────────

/**
 * Parse a CAMS/KFintech CAS PDF
 * @param {Buffer} pdfBuffer - Raw PDF file buffer
 * @param {string} password  - PDF password (usually PAN)
 * @returns {Promise<Object>} Parsed schemes with transactions
 */
async function parseCAMSCAS(pdfBuffer, password) {
  const parser = new PDFParse({ data: pdfBuffer, password, verbosity: 0 });
  const result = await parser.getText();
  const text = result.text;

  const investorName = extractInvestorName(text);
  const email = extractEmail(text);
  const dateRange = extractDateRange(text);
  const portfolioSummary = extractPortfolioSummary(text);
  const schemes = parseSchemes(text);

  return {
    investorName,
    email,
    dateRange,
    portfolioSummary,
    schemes,
    summary: {
      totalSchemes: schemes.length,
      activeSchemes: schemes.filter(s => s.closingBalance > 0).length,
      closedSchemes: schemes.filter(s => s.closingBalance === 0).length,
      totalTransactions: schemes.reduce((sum, s) => sum + s.transactions.length, 0),
    },
  };
}

// ─── Header extraction ───────────────────────────────────────────────

function extractInvestorName(text) {
  // Name appears on its own line after the header, before the address
  const m = text.match(/Page 1 of \d+.*?\n([A-Z][A-Z\s]+)\n/);
  return m ? m[1].trim() : null;
}

function extractEmail(text) {
  const m = text.match(/Email Id:\s*(\S+@\S+)/i);
  return m ? m[1] : null;
}

function extractDateRange(text) {
  const m = text.match(/(\d{2}-[A-Z][a-z]{2}-\d{4})\s+To\s+(\d{2}-[A-Z][a-z]{2}-\d{4})/);
  if (!m) return null;
  return { from: toISO(m[1]), to: toISO(m[2]) };
}

function extractPortfolioSummary(text) {
  const entries = [];
  const m = text.match(/PORTFOLIO SUMMARY\s*([\s\S]*?)Total\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})/);
  if (!m) return entries;

  const lines = m[1].split('\n').filter(l => l.trim());
  for (const line of lines) {
    const lm = line.match(/^\s+(.+?)\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s*$/);
    if (lm) {
      entries.push({
        amc: lm[1].trim(),
        costValue: parseNum(lm[2]),
        marketValue: parseNum(lm[3]),
      });
    }
  }
  return entries;
}

// ─── Scheme parsing ──────────────────────────────────────────────────

// Known AMC names (from CAS)
const AMC_NAMES = [
  'AXIS Mutual Fund', 'HDFC Mutual Fund', 'HSBC Mutual Fund',
  'ICICI Prudential Mutual Fund', 'PPFAS Mutual Fund',
  'Franklin Templeton Mutual Fund', 'Quant MF',
  'MOTILAL OSWAL MUTUAL FUND', 'Nippon India Mutual Fund',
  'SBI Mutual Fund', 'Aditya Birla Sun Life Mutual Fund',
  'DSP Mutual Fund', 'Kotak Mutual Fund', 'Tata Mutual Fund',
  'UTI Mutual Fund', 'Mirae Asset Mutual Fund', 'Bandhan Mutual Fund',
  'Edelweiss Mutual Fund', 'Invesco Mutual Fund',
  'L&T Mutual Fund', 'Sundaram Mutual Fund', 'Canara Robeco Mutual Fund',
  'PGIM India Mutual Fund', 'WhiteOak Capital Mutual Fund',
  'Navi Mutual Fund', '360 ONE Mutual Fund', 'JM Financial Mutual Fund',
  'Mahindra Manulife Mutual Fund', 'Baroda BNP Paribas Mutual Fund',
  'Union Mutual Fund', 'Quantum Mutual Fund', 'SAMCO Mutual Fund',
  'Shriram Mutual Fund', 'Trust Mutual Fund', 'ITI Mutual Fund',
  'Groww Mutual Fund', 'Zerodha Fund House', 'Helios Mutual Fund',
  'NJ Mutual Fund', 'Old Bridge Mutual Fund',
];

/**
 * Parse all scheme blocks from the CAS text
 */
function parseSchemes(text) {
  const schemes = [];
  // Remove page headers that break the flow
  const cleaned = text.replace(
    /CAMSCASWS-\S+.*?Consolidated Account Statement[\s\S]*?Balance\n/g, ''
  ).replace(/--- PAGE BREAK ---/g, '')
   .replace(/\(INR\)\s*\(INR\)\s*Balance/g, ''); // stray header remnants

  const lines = cleaned.split('\n');
  let currentAmc = '';
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();

    // Check for AMC name lines
    const amcMatch = AMC_NAMES.find(a => line === a || line.toUpperCase() === a.toUpperCase());
    if (amcMatch) {
      currentAmc = amcMatch;
      i++;
      continue;
    }

    // Check for ISIN - marks a scheme block start
    // Scheme line contains ISIN: INFxxxxxxxx
    if (/ISIN:\s*INF\w+/i.test(line)) {
      const result = parseSchemeBlock(lines, i, currentAmc);
      if (result.scheme) {
        schemes.push(result.scheme);
      }
      i = result.nextIndex;
      continue;
    }

    // Multi-line scheme header: ISIN may be on next line(s)
    // Check if current line has scheme code pattern and next lines have ISIN
    if (/^[A-Z0-9]+\s*-/.test(line) && !line.includes('ISIN:')) {
      // Look ahead up to 3 lines for ISIN
      let combined = line;
      let found = false;
      for (let k = 1; k <= 3 && i + k < lines.length; k++) {
        combined += ' ' + lines[i + k].trim();
        if (/ISIN:\s*INF\w+/i.test(combined)) {
          found = true;
          break;
        }
      }
      if (found) {
        const result = parseSchemeBlock(lines, i, currentAmc);
        if (result.scheme) {
          schemes.push(result.scheme);
        }
        i = result.nextIndex;
        continue;
      }
    }

    i++;
  }

  return schemes;
}

/**
 * Parse a single scheme block starting at `startIdx`
 * Returns the scheme object and the next line index to continue from
 */
function parseSchemeBlock(lines, startIdx, amc) {
  // 1) Collect the scheme header (may span multiple lines until "Opening Unit Balance" or date)
  let headerText = '';
  let i = startIdx;

  // Collect header lines until we hit "Opening Unit Balance" or a transaction date
  while (i < lines.length) {
    const line = lines[i].trim();
    headerText += ' ' + line;

    if (/Opening Unit Balance/i.test(line)) {
      i++;
      break;
    }
    // If we hit a date pattern (transaction start) without finding Opening Unit Balance
    if (i > startIdx + 6 && /^\d{2}-[A-Z][a-z]{2}-\d{4}\b/.test(line)) {
      break;
    }
    i++;
  }

  // 2) Parse scheme info from header
  const scheme = parseSchemeHeader(headerText, amc);
  if (!scheme) return { scheme: null, nextIndex: i };

  // 3) Parse transactions until "Closing Unit Balance"
  const transactions = [];
  let latestNav = null;
  let latestNavDate = null;
  let marketValue = null;
  let exitLoadText = '';
  let closingBalance = 0;
  let totalCostValue = 0;
  let pendingTxn = null; // For multi-line transactions

  const flushPending = () => {
    if (pendingTxn) {
      transactions.push(pendingTxn);
      pendingTxn = null;
    }
  };

  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line) { i++; continue; }

    // End of scheme block
    const closingMatch = line.match(/Closing Unit Balance:\s*([\d,.]+)\s+Total Cost Value:\s*([\d,.]+)/);
    if (closingMatch) {
      flushPending();
      closingBalance = parseNum(closingMatch[1]);
      totalCostValue = parseNum(closingMatch[2]);
      i++;
      break;
    }

    // Sometimes Closing is embedded in a long exit load line
    if (/Closing Unit Balance:/i.test(line)) {
      flushPending();
      const cm = line.match(/Closing Unit Balance:\s*([\d,.]+)/);
      const cv = line.match(/Total Cost Value:\s*([\d,.]+)/);
      if (cm) closingBalance = parseNum(cm[1]);
      if (cv) totalCostValue = parseNum(cv[1]);
      i++;
      break;
    }

    // NAV line
    const navMatch = line.match(/NAV on\s+(\d{2}-[A-Z][a-z]{2}-\d{4}):\s*INR\s+([\d,.]+)\s+Market Value.*?INR\s+([\d,.]+)/);
    if (navMatch) {
      flushPending();
      latestNavDate = toISO(navMatch[1]);
      latestNav = parseNum(navMatch[2]);
      marketValue = parseNum(navMatch[3]);
      i++;
      continue;
    }

    // Exit/Entry load info collection
    if (/^(Entry Load|Exit Load|Current\s*:?\s*Entry)/i.test(line)) {
      flushPending();
      exitLoadText += line + ' ';
      i++;
      // Collect continuation lines until next scheme block marker or Closing
      while (i < lines.length) {
        const next = lines[i].trim();
        if (!next || /Closing Unit Balance:/i.test(next) || /^\d{2}-[A-Z][a-z]{2}-\d{4}/.test(next) ||
            /ISIN:/i.test(next) || /^PAN:/i.test(next) || /^KYC:/i.test(next)) break;
        exitLoadText += next + ' ';
        // Check if Closing is embedded
        if (/Closing Unit Balance:/i.test(next)) break;
        i++;
      }
      continue;
    }

    // Skip disclaimer / "Please ensure" lines (part of load info block)
    if (/^"Please ensure|^Please ensure|^"Effective from|^Investors are|^We wish to|^Any redemption|^Please refer|^For subscriptions/i.test(line)) {
      exitLoadText += line + ' ';
      i++;
      continue;
    }

    // Skip page headers that weren't cleaned
    if (/^Page \d+ of \d+/.test(line)) { i++; continue; }
    if (/^CAMSCASWS-/.test(line)) { i++; continue; }

    // Info lines (not transactions): *** text ***
    if (/^\*{2,3}.*\*{2,3}$/.test(line)) { i++; continue; }

    // Check for AMC name (new section = end of scheme)
    if (AMC_NAMES.some(a => line === a || line.toUpperCase() === a.toUpperCase())) {
      flushPending();
      break;
    }

    // New PAN/KYC line → new scheme starts (end current)
    if (/^(PAN:|KYC:)/.test(line) && transactions.length > 0) {
      flushPending();
      break;
    }

    // Transaction date line
    const dateMatch = line.match(/^(\d{2}-[A-Z][a-z]{2}-\d{4})\s+(.+)/);
    if (dateMatch) {
      const dateStr = dateMatch[1];
      const rest = dateMatch[2].trim();

      // Stamp duty: "2.00 *** Stamp Duty ***"
      const stampMatch = rest.match(/^([\d,.]+)\s+\*{3}\s*Stamp Duty\s*\*{3}/i);
      if (stampMatch) {
        const stampDuty = parseNum(stampMatch[1]);
        // Attach to most recent BUY transaction
        if (pendingTxn && pendingTxn.type === 'BUY') {
          pendingTxn.stampDuty = (pendingTxn.stampDuty || 0) + stampDuty;
        } else if (transactions.length > 0) {
          const last = transactions[transactions.length - 1];
          if (last.type === 'BUY') last.stampDuty = (last.stampDuty || 0) + stampDuty;
        }
        i++;
        continue;
      }

      // STT paid: "1.41 *** STT Paid ***"
      const sttMatch = rest.match(/^([\d,.]+)\s+\*{3}\s*STT Paid\s*\*{3}/i);
      if (sttMatch) {
        const stt = parseNum(sttMatch[1]);
        // Attach to most recent SELL transaction
        if (pendingTxn && pendingTxn.type === 'SELL') {
          pendingTxn.stt = (pendingTxn.stt || 0) + stt;
        } else if (transactions.length > 0) {
          const last = transactions[transactions.length - 1];
          if (last.type === 'SELL') last.stt = (last.stt || 0) + stt;
        }
        i++;
        continue;
      }

      // Info lines with dates: "***Registration of Nominee***"
      if (/^\*{2,3}/.test(rest)) { i++; continue; }

      // Regular transaction: amount price units description balance
      // Amount and units can be in parentheses for sells
      const txnMatch = rest.match(
        /^(\([\d,.]+\)|[\d,.]+)\s+([\d,.]+)\s+(\([\d,.]+\)|[\d,.]+)\s+(.+)/
      );
      if (txnMatch) {
        flushPending();

        const amount = parseNum(txnMatch[1]);
        const price = parseNum(txnMatch[2]);
        const units = parseNum(txnMatch[3]);
        let descAndBalance = txnMatch[4].trim();

        // Extract balance from end of description
        // Balance is the last number (possibly with commas) at the end
        const { description, balance } = extractBalanceFromDesc(descAndBalance);

        const txnType = mapTransactionType(description);

        pendingTxn = {
          date: toISO(dateStr),
          amount: Math.abs(amount),
          price,
          units: Math.abs(units),
          type: txnType,
          description: cleanDescription(description),
          balance: balance,
          stampDuty: 0,
          stt: 0,
        };
        i++;
        continue;
      }

      // No match — might be a continuation or odd line
      i++;
      continue;
    }

    // Continuation line for multi-line transaction description
    if (pendingTxn && !/^(NAV on|Entry Load|Exit Load|Current|Closing Unit|PAN:|KYC:)/.test(line)) {
      // This line continues the previous transaction's description
      // Check if it ends with a balance number
      const combined = pendingTxn.description + ' ' + line;
      const { description, balance } = extractBalanceFromDesc(combined);
      pendingTxn.description = cleanDescription(description);
      if (balance !== null) pendingTxn.balance = balance;
      i++;
      continue;
    }

    i++;
  }

  flushPending();

  scheme.transactions = mergeFragmentedTransactions(transactions);
  scheme.latestNav = latestNav;
  scheme.latestNavDate = latestNavDate;
  scheme.marketValue = marketValue;
  scheme.exitLoad = cleanExitLoad(exitLoadText);
  scheme.closingBalance = closingBalance;
  scheme.totalCostValue = totalCostValue;

  return { scheme, nextIndex: i };
}

/**
 * Merge fragmented transactions that are clearly parts of a single transaction.
 * CAS PDFs sometimes split a single transfer/purchase into multiple lines
 * (e.g., 0.001 units + 68.527 units on the same date at the same NAV).
 * This merges consecutive transactions with the same date, type, and price.
 */
function mergeFragmentedTransactions(transactions) {
  if (transactions.length <= 1) return transactions;

  const merged = [];
  let i = 0;

  while (i < transactions.length) {
    const current = { ...transactions[i] };
    // Look ahead for consecutive transactions with same date, type, and price
    while (i + 1 < transactions.length) {
      const next = transactions[i + 1];
      if (next.date === current.date &&
          next.type === current.type &&
          next.price === current.price) {
        // Merge: sum units and amount, keep the later balance, combine descriptions
        current.units = +(current.units + next.units).toFixed(4);
        current.amount = +(current.amount + next.amount).toFixed(2);
        current.stampDuty = (current.stampDuty || 0) + (next.stampDuty || 0);
        current.stt = (current.stt || 0) + (next.stt || 0);
        if (next.balance !== null) current.balance = next.balance;
        if (next.description && next.description !== current.description) {
          current.description = current.description + '; ' + next.description;
        }
        i++;
      } else {
        break;
      }
    }
    merged.push(current);
    i++;
  }

  return merged;
}

/**
 * Parse scheme header text to extract code, name, ISIN, folio, registrar, etc.
 */
function parseSchemeHeader(headerText, amc) {
  // Extract ISIN
  const isinMatch = headerText.match(/ISIN:\s*(INF\w+)/i);
  if (!isinMatch) return null;
  let isin = isinMatch[1];
  // Fix truncated ISINs split across lines – ISIN should be 12 chars (INF + 9)
  if (isin.length < 12) {
    const pos = headerText.indexOf(isin) + isin.length;
    const restAfter = headerText.substring(pos, pos + 20).replace(/^\s+/, '');
    const contMatch = restAfter.match(/^([A-Z0-9]+)/);
    if (contMatch) isin = isin + contMatch[1];
  }

  // Extract folio (digits, spaces, slashes only – avoid capturing investor name)
  const folioMatch = headerText.match(/Folio No:\s*([\d\s/]+)/);
  const folio = folioMatch ? folioMatch[1].trim() : '';

  // Extract registrar
  const regMatch = headerText.match(/Registrar\s*:\s*(CAMS|KFINTECH|KARVY)/i);
  const registrar = regMatch ? regMatch[1].toUpperCase() : '';

  // Extract scheme code and name
  // Pattern: "CODE - Scheme Name ... - ISIN:"
  const schemeMatch = headerText.match(/\b([A-Z0-9]+(?:[A-Z0-9]*)?)\s*-\s*(.*?)\s*-?\s*ISIN:/);
  let schemeCode = '';
  let schemeName = '';
  if (schemeMatch) {
    schemeCode = schemeMatch[1].trim();
    schemeName = schemeMatch[2].trim();
    // Remove trailing metadata: "(Advisor : ...)", "(Non-Demat)", "(Demat)", "(formerly ...)"
    schemeName = schemeName
      .replace(/\(Advisor\s*:.*?\)/gi, '')
      .replace(/\(Non-Demat\s*\)/gi, '')
      .replace(/\(Demat\s*\)/gi, '')
      .replace(/\(erstwhile\s+.*?\)/gi, '')
      .replace(/\(formerly\s+.*?\)/gi, '')
      .replace(/\(Formerly\s+.*?\)/gi, '')
      .replace(/Registrar\s*:.*$/i, '')
      .replace(/\s+/g, ' ')
      .replace(/\s*-\s*$/, '')
      .trim();
  }

  // Demat or Non-Demat
  const isDemat = /\(Demat\s*\)/i.test(headerText);

  // Opening unit balance
  const openMatch = headerText.match(/Opening Unit Balance:\s*([\d,.]+)/);
  const openingBalance = openMatch ? parseNum(openMatch[1]) : 0;

  // Nominees
  const nominees = [];
  const nomMatch = headerText.match(/Nominee 1:\s*(.*?)\s+Nominee 2:\s*(.*?)\s+Nominee 3:\s*(.*?)(?:\s+Opening|$)/);
  if (nomMatch) {
    for (let k = 1; k <= 3; k++) {
      const n = (nomMatch[k] || '').replace(/\.\s*$/, '').trim();
      if (n) nominees.push(n);
    }
  }

  // Investor name on this folio
  const nameMatch = headerText.match(/Folio No:.*?\n?\s*([A-Z][A-Za-z\s]+?)(?:\s+Nominee|\s*$)/);
  const investorOnFolio = nameMatch ? nameMatch[1].trim() : '';

  return {
    amc,
    schemeCode,
    schemeName,
    isin,
    folio,
    registrar,
    isDemat,
    openingBalance,
    nominees,
    investorOnFolio,
    // These will be set after parsing the block:
    transactions: [],
    latestNav: null,
    latestNavDate: null,
    marketValue: null,
    exitLoad: '',
    closingBalance: 0,
    totalCostValue: 0,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Extract the unit balance from the end of a description string.
 * The balance is always the last number (possibly with commas) at the very end.
 * E.g., "Purchase 457.381" → { description: "Purchase", balance: 457.381 }
 *       "Redemption less TDS, STT 0.000" → { description: "Redemption less TDS, STT", balance: 0 }
 *       "Redemption - Electronic Payment-BSE - - CITIN25509572355 ,\nless STT794.110"
 *         → { description: "Redemption - Electronic Payment-BSE", balance: 794.110 }
 */
function extractBalanceFromDesc(text) {
  // Try to find a balance at the end: a number possibly stuck to text
  // e.g., "less STT794.110" or "Purchase 457.381" or "some text 1,538.870"
  const balMatch = text.match(/([\d,]+\.\d{2,4})\s*$/);
  if (balMatch) {
    const balance = parseNum(balMatch[1]);
    let desc = text.substring(0, text.length - balMatch[0].length).trim();
    // Handle case where balance is glued to text: "STT0.000"
    const gluedMatch = desc.match(/(.*?)(\d[\d,]*\.[\d]+)$/);
    if (gluedMatch && gluedMatch[2] === balMatch[1]) {
      desc = gluedMatch[1].trim();
    }
    return { description: desc, balance };
  }

  // Try integer balance (unlikely but handle)
  const intMatch = text.match(/\s+(\d[\d,]*)\s*$/);
  if (intMatch) {
    return { description: text.substring(0, text.length - intMatch[0].length).trim(), balance: parseNum(intMatch[1]) };
  }

  return { description: text, balance: null };
}

/** Clean up transaction description */
function cleanDescription(desc) {
  return desc
    .replace(/\s*-\s*-\s*INZ\w+/g, '')      // Remove broker codes
    .replace(/\s*-\s*-\s*CITIN\w+/g, '')     // Remove ticket IDs
    .replace(/\s*-\s*-\s*\d{9,}/g, '')       // Remove numeric IDs
    .replace(/\s*,\s*$/g, '')                 // Trailing comma
    .replace(/\(NAV Dt : [\d/]+\)/g, '')      // NAV date notes
    .replace(/\(INR\)\s*\(INR\)\s*Balance/g, '') // Stray page header remnants
    .replace(/\(INR\)/g, '')                  // Leftover (INR) tokens
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s-]+$/, '');                  // Trailing dashes/spaces
}

/** Extract human-readable exit load from raw text */
function cleanExitLoad(raw) {
  if (!raw) return '';
  let text = raw
    .replace(/"Please ensure[\s\S]*?immediately\."\s*/g, '')
    .replace(/"Effective from[\s\S]*?"/g, '')
    .replace(/Investors are requested[\s\S]*?aforesaid effective date\.\s*/g, '')
    .replace(/Please refer[\s\S]*?\n/g, '')
    .replace(/We wish to inform[\s\S]*?investing\.\s*/g, '')
    .replace(/Scheme [Nn]ame of[\s\S]*?(?=Entry|Exit|Closing|\s*$)/g, '')
    .replace(/GST Identification[\s\S]*?(?=Entry|Exit|Closing|\s*$)/g, '')
    .replace(/\*Due to change[\s\S]*?(?=Current|Entry|Exit|Closing|\s*$)/g, '')
    .replace(/STT @[\s\S]*?(?=Entry|Exit|Closing|$)/g, '')
    .replace(/As per SEBI[\s\S]*?(?=Entry|Exit|Closing|$)/g, '')
    .replace(/TDS shall[\s\S]*?(?=Entry|Exit|Closing|$)/g, '')
    .replace(/W\.e\.f\.\s+1st July 2020[\s\S]*?(?=Entry|Exit|Closing|$)/g, '')
    .replace(/For applicability[\s\S]*?(?=Entry|Exit|Closing|$)/g, '')
    .replace(/For lumpsum[\s\S]*?(?=Entry|Exit|Closing|$)/g, '')
    .replace(/For SIP\/STP[\s\S]*?(?=Entry|Exit|Closing|$)/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Extract just the exit load part
  const exitMatch = text.match(/Exit Load\s*[:\-]?\s*(.+)/i);
  if (exitMatch) {
    let el = exitMatch[1].trim();
    // Trim excess
    el = el.replace(/\s*Current\s*:.*$/i, '').replace(/\s*Entry\s*Load.*$/i, '').trim();
    if (/^nil$/i.test(el) || /^nil[,.]?\s*$/i.test(el)) return 'NIL';
    return el.substring(0, 300); // Cap length
  }

  if (/exit load.*nil/i.test(text) || /nil.*exit/i.test(text)) return 'NIL';
  return text.substring(0, 300);
}

module.exports = { parseCAMSCAS };
