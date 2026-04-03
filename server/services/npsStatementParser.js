/**
 * NPS Statement Parser
 *
 * Parses NPS transaction statements from:
 * 1. Protean CSV files (two column layouts: with/without charges column)
 * 2. Karvy/Protean PDF files
 *
 * Transaction types use standard BUY/SELL/TRANSFER_IN/CHARGES.
 * Employer vs Voluntary distinction is captured in the `broker` field
 * (from the "Uploaded By" column in the Contribution/Redemption section).
 *
 * Returns: { pran, subscriberName, schemeChoice, schemes[], transactions[] }
 * Each scheme = { name, shortCode } (e.g. "SBI PENSION FUND SCHEME E - TIER I")
 * Each transaction = { date, particulars, type, schemeName, amount, nav, units, charges, broker }
 */
const { PDFParse } = require('pdf-parse');

// ─── Helpers ─────────────────────────────────────────────────────────

/** Parse Indian-format number: "1,70,000.00" → 170000, "(141,128.99)" → -141128.99 */
function parseNum(s) {
  if (!s) return 0;
  s = s.trim();
  if (!s || s === '-') return 0;
  const neg = s.startsWith('(') && s.endsWith(')');
  const cleaned = s.replace(/[(),Rs₹\s]/g, '');
  const val = parseFloat(cleaned) || 0;
  return neg ? -val : val;
}

/** Convert "05-Jan-2018" or "05-Jan-18" or "11-May-2021" → "2018-01-05" */
const MONTHS = { Jan:'01', Feb:'02', Mar:'03', Apr:'04', May:'05', Jun:'06',
                 Jul:'07', Aug:'08', Sep:'09', Oct:'10', Nov:'11', Dec:'12' };

function toISO(dateStr) {
  if (!dateStr) return null;
  dateStr = dateStr.trim();
  const m = dateStr.match(/^(\d{1,2})-(\w{3})-(\d{2,4})$/);
  if (!m) return null;
  const day = m[1].padStart(2, '0');
  const mon = MONTHS[m[2]];
  if (!mon) return null;
  let year = m[3];
  if (year.length === 2) year = (parseInt(year) > 50 ? '19' : '20') + year;
  return `${year}-${mon}-${day}`;
}

/**
 * Classify NPS transaction from its "Particulars" text.
 * Returns: 'BUY' | 'CHARGES' | 'TRANSFER_IN' | 'SKIP' | 'SIGN_DEPENDENT_REBALANCE' | 'SIGN_DEPENDENT_PFM'
 *
 * Contributions (employer and voluntary) → BUY
 * Billing/charges → CHARGES
 * Rebalancing → depends on sign (positive=BUY, negative=SELL)
 * Migration/PFM change → depends on sign (positive=TRANSFER_IN, negative=SELL)
 */
function classifyTransaction(particulars) {
  const p = particulars.toLowerCase().trim();

  if (p.includes('opening balance') || p.includes('closing balance')) return 'SKIP';
  if (p.includes('billing for')) return 'CHARGES';
  if (p.includes('rebalancing')) return 'SIGN_DEPENDENT_REBALANCE';
  if (p.includes('migration') || p.includes('units credited on account of migration')) return 'TRANSFER_IN';
  if (p.includes('pfm change request') || p.includes('t2 to t1') || p.includes('tier ii to tier i')) return 'SIGN_DEPENDENT_PFM';
  // All contributions (employer and voluntary) → BUY
  if (p.includes('contribution') || p.includes('by contribution') || p.includes('voluntary contribution')) return 'BUY';

  // Default: treat as sign-dependent
  return 'SIGN_DEPENDENT_REBALANCE';
}

/**
 * Resolve final type for sign-dependent transaction types.
 */
function resolveType(baseType, amount) {
  if (baseType === 'SIGN_DEPENDENT_REBALANCE') {
    return amount >= 0 ? 'BUY' : 'SELL';
  }
  if (baseType === 'SIGN_DEPENDENT_PFM') {
    return amount >= 0 ? 'TRANSFER_IN' : 'SELL';
  }
  return baseType;
}

/**
 * Extract scheme names from column header cells (CSV).
 * Looks for patterns like "SBI PENSION FUND SCHEME E - TIER I Amount (Rs)"
 * and extracts the scheme name before " Amount", " NAV", " Units".
 */
function extractSchemeNamesFromHeader(headerCells) {
  const schemes = [];
  const seen = new Set();
  for (const cell of headerCells) {
    const trimmed = cell.trim();
    // Match: "<SCHEME NAME> Amount (Rs)" or "<SCHEME NAME> NAV (Rs)" or "<SCHEME NAME> Units"
    // Requires the keyword at the end to avoid matching charges column
    const m = trimmed.match(/^(.+?)\s+(?:Amount|NAV|Units)\s*(?:\(Rs\))?\s*$/i);
    if (m) {
      let name = m[1].trim().replace(/\s*\(Rs\)\s*$/, '').trim();
      if (!seen.has(name)) {
        seen.add(name);
        const codeMatch = name.match(/SCHEME\s+([A-Z])\s*-/i);
        schemes.push({ name, shortCode: codeMatch ? codeMatch[1] : '' });
      }
    }
  }
  return schemes;
}

/**
 * Regex-based scheme name extraction (for PDF where we don't have clean cells).
 * Handles names with hyphens like "ICICI Prudential Pension Fund - Scheme E - TIER I".
 */
function extractSchemeNamesFromText(text) {
  const schemes = [];
  const seen = new Set();
  const re = /([A-Z][A-Za-z\s.()-]+?SCHEME\s+[A-Z]\s*-\s*TIER\s+[IV]+)/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = m[1].trim().replace(/\s+/g, ' ');
    if (!seen.has(name)) {
      seen.add(name);
      const codeMatch = name.match(/SCHEME\s+([A-Z])\s*-/i);
      schemes.push({ name, shortCode: codeMatch ? codeMatch[1] : '' });
    }
  }
  return schemes;
}


/**
 * Resolve a possibly-truncated scheme to its full name.
 * PDF transaction headers may show "FUND SCHEME E - TIER I" instead of
 * "SBI PENSION FUND SCHEME E - TIER I". Match by short code (E, C, G).
 */
function resolveScheme(truncated, knownSchemes) {
  // If already known, return as-is
  if (knownSchemes.find(x => x.name === truncated.name)) return truncated;
  // Match by short code
  if (truncated.shortCode) {
    const match = knownSchemes.find(x => x.shortCode === truncated.shortCode);
    if (match) return match;
  }
  return truncated;
}


// ─── CSV Parser ──────────────────────────────────────────────────────

function parseNPSCSV(csvContent) {
  const lines = csvContent.split('\n').map(l => l.replace(/\r$/, ''));

  let pran = '';
  let subscriberName = '';
  let schemeChoice = '';
  const schemes = [];
  const contributions = []; // from Contribution/Redemption section
  const transactions = []; // from Transaction Details section

  let section = 'header'; // header | contribution | transaction

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("PRAN,")) {
      pran = line.split(',')[1].replace(/'/g, '').trim();
    }
    if (line.startsWith("Subscriber Name,")) {
      subscriberName = line.split(',')[1].replace(/^Shri\s+|^Smt\s+|^Ms\s+|^Mr\s+/i, '').trim();
    }
    if (line.includes('Scheme Choice')) {
      const m = line.match(/Scheme Choice\s*-?\s*(.+)/);
      if (m) schemeChoice = m[1].trim();
    }

    // Extract scheme names from "Investment Details" Particulars,References,... header
    if (line.startsWith('Particulars,References,')) {
      const cells = parseCSVLine(line);
      const headerSchemes = extractSchemeNamesFromHeader(cells);
      for (const s of headerSchemes) {
        if (!schemes.find(x => x.name === s.name)) schemes.push(s);
      }
    }

    // Contribution/Redemption section
    if (line.includes('Contribution/Redemption Details')) {
      section = 'contribution';
      continue;
    }
    if (line.includes('Transaction Details')) {
      section = 'transaction';
      continue;
    }

    if (section === 'contribution') {
      if (line.startsWith('Date,Particulars') || !line.trim()) continue;
      const cells = parseCSVLine(line);
      if (cells.length >= 6) {
        const date = toISO(cells[0].trim());
        if (!date) continue;
        const particulars = cells[1].trim();
        // "Uploaded By" is column index 2, e.g. "HDFC Securities Limited (5000542)"
        const uploadedBy = cells[2] ? cells[2].trim().replace(/\s*\(\d+\)\s*$/, '') : '';
        const employee = parseNum(cells[3]);
        const employer = parseNum(cells[4]);
        const total = parseNum(cells[5]);
        contributions.push({ date, particulars, uploadedBy, employee, employer, total });
      }
    }

    if (section === 'transaction') {
      // Detect the Transaction Details header line
      if (line.startsWith('Date,Particulars')) {
        const headerCells = parseCSVLine(line);
        const hasChargesCol = headerCells.some(c =>
          c.toLowerCase().includes('intermediary charges') ||
          c.toLowerCase().includes('withdrawal/ deduction')
        );

        // Extract scheme names from header columns
        const headerSchemes = extractSchemeNamesFromHeader(headerCells);
        for (const s of headerSchemes) {
          if (!schemes.find(x => x.name === s.name)) schemes.push(s);
        }

        // Build date → uploadedBy lookup from contributions
        const brokerMap = new Map();
        for (const c of contributions) {
          if (c.uploadedBy) brokerMap.set(c.date, c.uploadedBy);
        }

        // Parse all subsequent transaction lines
        for (let j = i + 1; j < lines.length; j++) {
          const txnLine = lines[j].trim();
          if (!txnLine) continue;

          const cells = parseCSVLine(txnLine);
          if (cells.length < 4) continue;

          const date = toISO(cells[0].trim());
          if (!date) continue;

          const particulars = cells[1].trim();
          if (!particulars) continue;

          const baseType = classifyTransaction(particulars);
          if (baseType === 'SKIP') continue;

          // Determine broker from contribution map (for BUY transactions)
          let broker = '';
          if (baseType === 'BUY') {
            broker = brokerMap.get(date) || '';
          }

          // Column layout:
          // With charges: [date, particulars, charges, E-amt, E-nav, E-units, C-amt, ...]
          // Without:      [date, particulars, E-amt, E-nav, E-units, C-amt, ...]
          const offset = hasChargesCol ? 3 : 2;
          const charges = hasChargesCol ? parseNum(cells[2]) : 0;

          for (let s = 0; s < schemes.length; s++) {
            const amtIdx = offset + s * 3;
            const navIdx = offset + s * 3 + 1;
            const unitsIdx = offset + s * 3 + 2;

            const amount = parseNum(cells[amtIdx]);
            const nav = parseNum(cells[navIdx]);
            const units = parseNum(cells[unitsIdx]);

            if (amount === 0 && units === 0) continue;

            const txnType = resolveType(baseType, amount);

            transactions.push({
              date,
              particulars,
              type: txnType,
              schemeName: schemes[s].name,
              amount: Math.abs(amount),
              nav: Math.abs(nav),
              units: Math.abs(units),
              charges: s === 0 ? Math.abs(charges) : 0,
              broker,
            });
          }
        }
        break;
      }
    }
  }

  return { pran, subscriberName, schemeChoice, schemes, contributions, transactions };
}

/**
 * Simple CSV line parser handling commas inside quoted fields
 */
function parseCSVLine(line) {
  const cells = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      cells.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}


// ─── PDF Parser (Karvy/Protean) ──────────────────────────────────────

async function parseNPSPDF(pdfBuffer) {
  const parser = new PDFParse({ data: pdfBuffer, verbosity: 0 });
  const result = await parser.getText();
  const text = result.text;
  const lines = text.split('\n').map(l => l.trim()).filter(l => l);

  let pran = '';
  let subscriberName = '';
  let schemeChoice = '';
  const schemes = [];
  const contributions = [];
  const transactions = [];

  // Merge lines to reconstruct dates split across lines ("05-Jan-\n2018")
  const merged = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/\d{2}-\w{3}-$/.test(line) && i + 1 < lines.length && /^\d{4}\b/.test(lines[i + 1])) {
      merged.push(line + lines[i + 1]);
      i++;
    } else {
      merged.push(line);
    }
  }

  let section = 'header';
  let currentSchemes = [];
  const contributionMap = new Map();

  for (let i = 0; i < merged.length; i++) {
    const line = merged[i];

    // Extract PRAN
    if (line.startsWith('PRAN') && !pran) {
      const m = line.match(/PRAN\s+(\d+)/);
      if (m) pran = m[1];
    }

    // Extract subscriber name
    if (line.startsWith('Subscriber Name') && !subscriberName) {
      const m = line.match(/Subscriber Name\s+(?:Shri|Smt|Ms|Mr)?\s*(.+)/i);
      if (m) subscriberName = m[1].trim();
    }

    // Extract scheme choice
    if (line.includes('Scheme Choice') && !schemeChoice) {
      const m = line.match(/Scheme Choice\s*-?\s*(.+)/);
      if (m) schemeChoice = m[1].trim();
    }

    // Extract clean scheme names from "Scheme 1 SBI PENSION FUND SCHEME E - TIER I 71.00%"
    const schemeLineMatch = line.match(/^Scheme\s+\d+\s+(.+?SCHEME\s+[A-Z]\s*-\s*TIER\s+[IV]+)/i);
    if (schemeLineMatch) {
      const name = schemeLineMatch[1].trim().replace(/\s+/g, ' ');
      if (!schemes.find(x => x.name === name)) {
        const codeMatch = name.match(/SCHEME\s+([A-Z])\s*-/i);
        schemes.push({ name, shortCode: codeMatch ? codeMatch[1] : '' });
      }
    }

    // Detect schemes from content
    if (line.includes('Particulars') && (line.includes('SCHEME') || line.includes('FUND') || line.includes('Fund'))) {
      const schemeNames = extractSchemeNamesFromText(line);
      for (let k = i + 1; k < Math.min(i + 6, merged.length); k++) {
        schemeNames.push(...extractSchemeNamesFromText(merged[k]));
      }
      for (const s of schemeNames) {
        if (!schemes.find(x => x.name === s.name)) schemes.push(s);
      }
    }

    if (line.includes('Amount') && line.includes('Units') && (line.includes('SCHEME') || line.includes('FUND') || line.includes('Fund'))) {
      for (const s of extractSchemeNamesFromText(line)) {
        if (!schemes.find(x => x.name === s.name)) schemes.push(s);
      }
    }

    // Section detection
    if (line.includes('Contribution/Redemption Details')) {
      section = 'contribution';
      continue;
    }
    if (line.startsWith('Transaction Details')) {
      section = 'transaction';
      currentSchemes = [];
      for (let k = i + 1; k < Math.min(i + 10, merged.length); k++) {
        for (const s of extractSchemeNamesFromText(merged[k])) {
          // Try to match truncated name to a clean scheme by short code
          const resolved = resolveScheme(s, schemes);
          currentSchemes.push(resolved);
          if (!schemes.find(x => x.name === resolved.name)) schemes.push(resolved);
        }
        if (merged[k].includes('Amount') && merged[k].includes('Units')) break;
      }
      continue;
    }

    if (section === 'transaction' && line.startsWith('Date') && line.includes('Particulars')) {
      currentSchemes = [];
      for (let k = i + 1; k < Math.min(i + 10, merged.length); k++) {
        for (const s of extractSchemeNamesFromText(merged[k])) {
          const resolved = resolveScheme(s, schemes);
          currentSchemes.push(resolved);
          if (!schemes.find(x => x.name === resolved.name)) schemes.push(resolved);
        }
        if (merged[k].includes('Amount') && merged[k].includes('Units')) break;
      }
      continue;
    }

    // Parse contribution lines
    if (section === 'contribution') {
      const dateMatch = line.match(/^(\d{2}-\w{3}-\d{4})\s+(.+)/);
      if (dateMatch) {
        const date = toISO(dateMatch[1]);
        const rest = dateMatch[2];
        const nums = rest.match(/([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s*$/);
        if (date && nums) {
          const employee = parseNum(nums[1]);
          const employer = parseNum(nums[2]);
          const total = parseNum(nums[3]);
          const particulars = rest.substring(0, rest.indexOf(nums[0])).trim().replace(/,\s*$/, '');
          // PDF doesn't have "Uploaded By" cleanly — derive from employer vs employee amounts
          let broker = '';
          if (employer > 0 && employee === 0) broker = 'Employer';
          else if (employee > 0 && employer === 0) broker = 'Voluntary';
          contributions.push({ date, particulars, uploadedBy: broker, employee, employer, total });
          contributionMap.set(date, broker);
        }
      }
    }

    // Parse transaction detail lines
    if (section === 'transaction') {
      if (line.startsWith('Amount') || line.startsWith('NAV') || line.startsWith('Notes') ||
          line.startsWith('View More') || line.startsWith('Retired') || line.startsWith('Home') ||
          /^--\s*\d+\s*of\s*\d+\s*--$/.test(line)) continue;

      // Match date at start — with or without trailing text
      const dateWithTextMatch = line.match(/^(\d{2}-\w{3}-\d{4})\s+(.+)/);
      const dateOnlyMatch = !dateWithTextMatch && line.match(/^(\d{2}-\w{3}-\d{4})\s*$/);
      if (!dateWithTextMatch && !dateOnlyMatch) continue;

      const date = toISO(dateWithTextMatch ? dateWithTextMatch[1] : dateOnlyMatch[1]);
      if (!date) continue;
      let rest = dateWithTextMatch ? dateWithTextMatch[2].trim() : '';

      // Collect subsequent non-date lines: text lines (particulars) and number lines (amounts/NAVs)
      let dataLine = rest;
      let navLine = '';
      const collectedNumLines = [];
      for (let k = i + 1; k < Math.min(i + 12, merged.length); k++) {
        const nextLine = merged[k].trim();
        if (!nextLine) continue;
        // Stop if we hit a new date, section header, or page marker
        if (/^\d{2}-\w{3}-\d{4}/.test(nextLine)) break;
        if (nextLine.startsWith('Date') || nextLine.startsWith('Transaction Details') ||
            nextLine.startsWith('Notes') || nextLine.startsWith('--') ||
            nextLine.includes('SCHEME') || nextLine.startsWith('Particulars')) break;

        // Check if line is all numbers (amounts/units or NAVs)
        const cleaned = nextLine.replace(/\s+/g, ' ').trim();
        if (/^[\d.,\s()-]+$/.test(cleaned)) {
          collectedNumLines.push(nextLine);
        } else {
          // Text line — append to particulars/data
          dataLine += (dataLine ? ' ' : '') + nextLine;
        }
      }

      // Concatenate collected number lines and determine amounts vs NAVs
      // Pattern: amounts/units come first, then NAVs on a separate line.
      // Individual numbers per line (rebalancing) need to be joined.
      // A NAV line typically has exactly schemeCount numbers (one per scheme).
      if (collectedNumLines.length > 0) {
        const hasNumbersInData = /[\d.]+/.test(dataLine) && /[a-zA-Z]/.test(dataLine);
        if (hasNumbersInData) {
          // dataLine already has text + numbers (same-line format like billing)
          // First collected num line is NAVs
          navLine = collectedNumLines[0] || '';
        } else if (collectedNumLines.length === 2) {
          // Two number lines: first = amounts/units, second = NAVs
          dataLine += (dataLine ? ' ' : '') + collectedNumLines[0];
          navLine = collectedNumLines[1];
        } else {
          // Multiple individual number lines — join all into amounts, last line = NAVs
          // Heuristic: a NAV line has schemeCount-ish numbers (3 for E/C/G),
          // while amount lines have 2*schemeCount numbers (amount+units per scheme)
          const schemeCount = currentSchemes.length || 3;
          const allNums = collectedNumLines.join(' ');
          const numTokens = allNums.trim().split(/\s+/).filter(t => t);
          // If total tokens = 2*schemeCount + schemeCount (amounts + NAVs), split
          if (numTokens.length === 3 * schemeCount) {
            const amtPart = numTokens.slice(0, 2 * schemeCount).join(' ');
            const navPart = numTokens.slice(2 * schemeCount).join(' ');
            dataLine += (dataLine ? ' ' : '') + amtPart;
            navLine = navPart;
          } else {
            // Join all as amounts, no separate NAVs
            dataLine += (dataLine ? ' ' : '') + allNums;
          }
        }
      }

      // If dataLine has no particulars text, it's a direct contribution ("Investment in NPS")
      if (!dataLine.match(/[a-zA-Z]/)) {
        dataLine = 'Investment in NPS ' + dataLine;
      }

      const parsedTxns = parsePDFTransactionLine(date, dataLine, navLine, currentSchemes.length || 3, contributionMap);
      if (parsedTxns) {
        for (const txn of parsedTxns) {
          const schemeIdx = txn.schemeIndex;
          if (schemeIdx < currentSchemes.length) {
            txn.schemeName = currentSchemes[schemeIdx].name;
          } else if (schemeIdx < schemes.length) {
            txn.schemeName = schemes[schemeIdx].name;
          }
          delete txn.schemeIndex;
          transactions.push(txn);
        }
      }
    }
  }

  return { pran, subscriberName, schemeChoice, schemes, contributions, transactions };
}

/**
 * Parse a PDF transaction data line into per-scheme transactions.
 */
function parsePDFTransactionLine(date, dataLine, navLine, schemeCount, contributionMap) {
  const parts = dataLine.match(/^(.*?)\s+([-(\d][\d.,()]+(?:\s+[-(\d][\d.,()]+)*)$/);
  if (!parts) return null;

  const particulars = parts[1].trim();
  const numbersStr = parts[2].trim();
  const numTokens = numbersStr.split(/\s+/).map(s => parseNum(s)).filter(n => !isNaN(n));
  const navNums = navLine ? navLine.trim().split(/\s+/).map(s => parseNum(s)).filter(n => !isNaN(n)) : [];

  const baseType = classifyTransaction(particulars);
  if (baseType === 'SKIP') return null;

  // For BUY (contribution) transactions, look up the broker from contribution map
  const broker = baseType === 'BUY' ? (contributionMap.get(date) || '') : '';
  const results = [];
  const isBilling = baseType === 'CHARGES';

  let chargesTotal = 0;
  let schemeNums;
  if (isBilling && numTokens.length >= 1) {
    chargesTotal = Math.abs(numTokens[0]);
    schemeNums = numTokens.slice(1);
  } else {
    schemeNums = numTokens;
  }

  for (let s = 0; s < schemeCount; s++) {
    const amtIdx = s * 2;
    const unitsIdx = s * 2 + 1;
    if (amtIdx >= schemeNums.length) break;

    const amount = schemeNums[amtIdx];
    const units = schemeNums[unitsIdx] || 0;
    const nav = navNums[s] || (units !== 0 ? Math.abs(amount / units) : 0);

    if (amount === 0 && units === 0) continue;

    const txnType = resolveType(baseType, amount);

    results.push({
      date,
      particulars,
      type: isBilling ? 'CHARGES' : txnType,
      schemeIndex: s,
      schemeName: '',
      amount: Math.abs(amount),
      nav: Math.abs(nav),
      units: Math.abs(units),
      charges: s === 0 ? chargesTotal : 0,
      broker: isBilling ? '' : broker,
    });
  }

  return results.length > 0 ? results : null;
}


// ─── Main entry point ────────────────────────────────────────────────

async function parseNPSStatements(files) {
  let pran = '';
  let subscriberName = '';
  let schemeChoice = '';
  const allSchemes = [];
  const allTransactions = [];

  for (const file of files) {
    const isCSV = file.originalname.toLowerCase().endsWith('.csv');
    const isPDF = file.originalname.toLowerCase().endsWith('.pdf');

    let parsed;
    if (isCSV) {
      const content = file.buffer.toString('utf-8');
      parsed = parseNPSCSV(content);
    } else if (isPDF) {
      parsed = await parseNPSPDF(file.buffer);
    } else {
      continue;
    }

    if (!pran && parsed.pran) pran = parsed.pran;
    if (!subscriberName && parsed.subscriberName) subscriberName = parsed.subscriberName;
    if (!schemeChoice && parsed.schemeChoice) schemeChoice = parsed.schemeChoice;

    for (const s of parsed.schemes) {
      if (!allSchemes.find(x => x.name === s.name)) allSchemes.push(s);
    }
    allTransactions.push(...parsed.transactions);
  }

  // Deduplicate transactions by (date, schemeName, type, amount, units)
  const seen = new Set();
  const uniqueTransactions = [];
  for (const txn of allTransactions) {
    const key = `${txn.date}|${txn.schemeName}|${txn.type}|${Math.round(txn.amount * 100)}|${Math.round(txn.units * 1000)}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueTransactions.push(txn);
    }
  }

  uniqueTransactions.sort((a, b) => a.date.localeCompare(b.date));

  return {
    pran,
    subscriberName,
    schemeChoice,
    schemes: allSchemes,
    transactions: uniqueTransactions,
  };
}

module.exports = { parseNPSStatements, parseNPSCSV, parseNPSPDF };
