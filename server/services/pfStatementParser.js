/**
 * EPFO PF Statement Parser
 *
 * Parses EPFO Member Passbook PDFs (EPF/EPS accounts)
 *
 * Returns: {
 *   uan,
 *   memberName,
 *   memberIdNumber,
 *   dateOfBirth,
 *   establishmentId,
 *   establishmentName,
 *   statementYear, // e.g., "2024-2025"
 *   statements: [ { fy, openingBalance, closingBalance, transactions } ]
 * }
 *
 * Each transaction from statement:
 * { date, wageMonth, type, wages, eeContribution, erContribution, epsContribution, description }
 *
 * Transaction type classification:
 * - DEPOSIT: Employee contribution
 * - EMPLOYER_CONTRIBUTION: Employer contribution
 * - EPS_CONTRIBUTION: EPS/Pension contribution (derived as ER - EE)
 * - INTEREST: Interest credit
 * - WITHDRAWAL: Withdrawal or transfer-out
 * - TRANSFER_IN: Transfer-in or VDR
 */

const { PDFParse } = require('pdf-parse');

const MONTH_MAP = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/**
 * Parse a date like "12-04-2024" → "2024-04-12"
 */
function parseDate(dateStr) {
  if (!dateStr) return null;
  const m = dateStr.trim().match(/(\d{1,2})-(\d{2})-(\d{4})/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/**
 * Parse an amount like "1,23,456" or "1,23,456.00" → 123456
 */
function parseAmount(amountStr) {
  if (!amountStr) return 0;
  const cleaned = amountStr.trim().replace(/,/g, '');
  return Math.round(parseFloat(cleaned) || 0);
}

/**
 * Extract a field value from multi-line PDF text using regex
 */
function extractField(text, regex, defaultValue = null) {
  const m = text.match(regex);
  return m ? m[1].trim() : defaultValue;
}

/**
 * Parse all EPFO PDFs and merge transactions
 * @param {Array} files - Array of { buffer, originalname } objects
 * @returns {Promise<Object>} Parsed PF data
 */
async function parsePFStatements(files) {
  const allData = {
    uan: null,
    memberName: null,
    memberIdNumber: null,
    dateOfBirth: null,
    establishmentId: null,
    establishmentName: null,
    statements: [],
    allTransactions: [],
  };

  for (const file of files) {
    try {
      const parsed = await parseSingleStatement(file.buffer);
      if (!parsed) continue;

      // Capture header info from first file
      if (!allData.uan && parsed.uan) {
        allData.uan = parsed.uan;
        allData.memberName = parsed.memberName;
        allData.memberIdNumber = parsed.memberIdNumber;
        allData.dateOfBirth = parsed.dateOfBirth;
        allData.establishmentId = parsed.establishmentId;
        allData.establishmentName = parsed.establishmentName;
      }

      // Store statement-level data
      allData.statements.push({
        fy: parsed.fy,
        openingBalance: parsed.openingBalance,
        closingBalance: parsed.closingBalance,
      });

      // Collect all transactions
      if (parsed.transactions && Array.isArray(parsed.transactions)) {
        allData.allTransactions.push(...parsed.transactions);
      }
    } catch (e) {
      console.error(`Error parsing file ${file.originalname}:`, e.message);
    }
  }

  // Deduplicate transactions by date + type + amounts
  const seen = new Set();
  const uniqueTxns = [];
  for (const txn of allData.allTransactions) {
    const key = `${txn.date}|${txn.type}|${txn.eeContribution}|${txn.erContribution}|${txn.epsContribution}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueTxns.push(txn);
    }
  }

  uniqueTxns.sort((a, b) => a.date.localeCompare(b.date));
  allData.allTransactions = uniqueTxns;

  return allData;
}

/**
 * Parse a single EPFO PDF statement
 */
async function parseSingleStatement(buffer) {
  try {
    const opts = { data: buffer, verbosity: 0 };
    const parser = new PDFParse(opts);
    const result = await parser.getText();
    const text = result.text;

    // Extract header information
    const uan = extractField(text, /[;w\s,u\s|\s]*UAN\s*(\d{12})/i);
    const memberName = extractField(text, /lnL;\s*vkbZMh@uke\s*\|\s*Member\s*ID\/Name\s*[A-Z0-9]+\s*\/\s*(.+?)(?:\n|$)/i);
    const memberIdNumber = extractField(text, /Member\s*ID\/Name\s*([A-Z0-9]+)/i);
    const dob = extractField(text, /tUe\s*frfFk\s*\|\s*Date\s*of\s*Birth\s*(\d{2}-\d{2}-\d{4})/i);
    const establishmentInfo = text.match(/LFkkiuk\s*vkbZMh@uke\s*\|\s*Establishment\s*ID\/Name\s*([A-Z0-9]+)\s*\/\s*(.+?)(?:\n|$)/i);
    const establishmentId = establishmentInfo ? establishmentInfo[1].trim() : null;
    const establishmentName = establishmentInfo ? establishmentInfo[2].trim() : null;
    
    // Extract financial year
    const fyMatch = text.match(/Financial\s*Year\s*-\s*(\d{4})-(\d{4})/i);
    const fy = fyMatch ? `${fyMatch[1]}-${fyMatch[2]}` : null;

    // Extract opening and closing balances
    const lines = text.split('\n');
    let openingBalance = 0;
    let closingBalance = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Opening balance line: "OB Int. Updated upto 31/03/2024 38,06,200 35,56,987 49,241"
      if (line.match(/OB\s+Int\.\s+Updated/i)) {
        const parts = line.split(/\s+/).filter(p => p.length > 0);
        const idx = parts.findIndex(p => p.match(/\d+\/\d+\/\d+/));
        if (idx >= 0 && parts[idx + 1]) {
          openingBalance = parseAmount(parts[idx + 1]);
        }
      }

      // Closing balance line: "Closing Balance as on 31/03/2025 44,58,612 41,76,357 64,241"
      if (line.match(/Closing\s+Balance\s+as\s+on/i)) {
        const parts = line.split(/\s+/).filter(p => p.length > 0);
        const idx = parts.findIndex(p => p.match(/\d+\/\d+\/\d+/));
        if (idx >= 0 && parts[idx + 1]) {
          closingBalance = parseAmount(parts[idx + 1]);
        }
      }
    }

    // Extract transactions
    const transactions = extractTransactions(text);

    return {
      uan,
      memberName: memberName ? memberName.replace(/^(Mr\.|Mrs\.|Ms\.|Shri|Smt\.?)\s*/i, '').trim() : null,
      memberIdNumber,
      dateOfBirth: dob,
      establishmentId,
      establishmentName,
      fy,
      openingBalance,
      closingBalance,
      transactions,
    };
  } catch (e) {
    console.error('Error parsing EPFO PDF:', e.message);
    return null;
  }
}

/**
 * Extract transactions from the statement text
 *
 * Transaction format:
 * "Mar-2024 12-04-2024 CR Cont. For Due-Month 042024 2,21,447 15,000 26,574 25,324 1,250"
 *  Wage    Date      Type+Desc                 Wages  ??? EECont  ERCont  EPSCont
 */
function extractTransactions(text) {
  const transactions = [];
  const lines = text.split('\n');

  // Find the start of transactions (first line that matches the transaction pattern)
  // Skip all header/column label lines
  let transactionStartIdx = -1;
  const transactionPattern = /^[A-Za-z]{3}-\d{4}\s+\d{1,2}-\d{2}-\d{4}\s+.+\s+[\d,]+\s+[\d,]+\s+[\d,]+\s+[\d,]+\s+[\d,]+/;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].match(transactionPattern)) {
      transactionStartIdx = i;
      break;
    }
  }

  if (transactionStartIdx === -1) return transactions;

  // Process lines from transaction start
  for (let i = transactionStartIdx; i < lines.length; i++) {
    const line = lines[i].trim();

    // Skip empty lines
    if (!line.length) continue;

    // Stop at footer markers
    if (line.match(/Total\s+Contributions|Total\s+Transfer-Ins|Total\s+Withdrawals|Interest\s+Updated|Deduction\s+of\s+TDS|Closing\s+Balance|End\s+Of\s+Statement/i)) {
      break;
    }

    // Try to parse transaction line
    const txn = parseTransactionLine(line);
    if (txn) {
      transactions.push(txn);
    }
  }

  return transactions;
}

/**
 * Parse a single transaction line
 * Pattern: WageMonth Date TypeDesc Wages EECont ERCont EPSCont
 */
function parseTransactionLine(line) {
  // Match pattern: MonthYear Date TypeDesc amounts
  // Example: "Mar-2025 15-04-2025 CR Cont. For Due-Month 042025 2,49,993 15,000 29,999 28,749 1,250"
  const pattern = /^([A-Za-z]{3})-(\d{4})\s+(\d{1,2}-\d{2}-\d{4})\s+(.+?)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)$/;
  const m = line.match(pattern);

  if (!m) return null;

  const wageMonth = `${m[2]}-${MONTH_MAP[m[1].toLowerCase()] || '01'}`;
  const date = parseDate(m[3]);
  const typeDesc = m[4].trim();

  if (!date) return null;

  // Amounts in order: wages, unknown(usually 15000), EE, ER, EPS
  const wages = parseAmount(m[5]);
  const eeContribution = parseAmount(m[7]);
  const erContribution = parseAmount(m[8]);
  const epsContribution = parseAmount(m[9]);

  const txn = {
    date,
    wageMonth,
    type: classifyTransactionType(typeDesc, eeContribution, erContribution),
    wages,
    eeContribution,
    erContribution,
    epsContribution,
    description: typeDesc,
  };

  return txn;
}

/**
 * Classify transaction type based on description and amounts
 */
function classifyTransactionType(description, eeAmount, erAmount) {
  const upper = description.toUpperCase();

  // EPS contribution (EE > 0 and ER > 0, ER-EE is EPS)
  if (upper.includes('CR CONT') || upper.includes('CONTRIBUTION')) {
    if (eeAmount > 0 && erAmount > 0) {
      return 'DEPOSIT'; // Employee contribution
    }
  }

  if (upper.includes('WITHDRAWAL') || upper.includes('DEBIT')) {
    return 'WITHDRAWAL';
  }

  if (upper.includes('TRANSFER')) {
    if (upper.includes('VDR')) {
      return 'TRANSFER_IN';
    }
    return 'TRANSFER_IN';
  }

  if (upper.includes('INTEREST') || upper.includes('INT') || upper.includes('CREDIT INTEREST')) {
    return 'INTEREST';
  }

  // Default to DEPOSIT for CR (credit) entries with employee contribution
  if (upper.includes('CR') && eeAmount > 0) {
    return 'DEPOSIT';
  }

  return 'DEPOSIT';
}

module.exports = { parsePFStatements };
