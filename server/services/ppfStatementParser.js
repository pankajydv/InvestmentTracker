/**
 * PPF / SSY Statement Parser
 *
 * Parses PPF and Sukanya Samriddhi Yojana (SSY) account statement PDFs
 * (SBI format — single-page passbook statements).
 *
 * Returns: { accountName, accountNumber, accountType, interestRate,
 *            openDate, maturityDate, openingBalance, statementFrom, statementTo,
 *            transactions[] }
 *
 * Each transaction = { date, description, type, amount, balance }
 *   type: 'DEPOSIT' | 'INTEREST' | 'WITHDRAWAL'
 */
const { PDFParse } = require('pdf-parse');

const MONTH_MAP = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/**
 * Parse a date like "3 Oct 2019" or "31 Mar\n2020" → "2019-10-03"
 */
function parseDate(raw) {
  if (!raw) return null;
  const cleaned = raw.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
  const m = cleaned.match(/(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/);
  if (!m) return null;
  const day = m[1].padStart(2, '0');
  const mon = MONTH_MAP[m[2].toLowerCase()];
  if (!mon) return null;
  return `${m[3]}-${mon}-${day}`;
}

/**
 * Parse a comma-formatted number like "1,50,000.00" → 150000
 */
function parseAmount(raw) {
  if (!raw) return 0;
  return parseFloat(raw.replace(/,/g, '')) || 0;
}

/**
 * Classify a transaction description into a type.
 */
function classifyTransaction(description) {
  const upper = description.toUpperCase();
  if (upper.includes('CREDIT INTEREST') || upper.includes('INT.CAPITALISED')) {
    return 'INTEREST';
  }
  if (upper.includes('WITHDRAWAL') || upper.includes('DEBIT') || upper.includes('TO TRANSFER')) {
    return 'WITHDRAWAL';
  }
  // Default: any credit (BY TRANSFER, BY CASH, BY CHEQUE, etc.) is a deposit
  return 'DEPOSIT';
}

/**
 * Parse multiple PPF/SSY statement PDFs and merge transactions.
 * @param {Array} files - Array of { buffer, originalname } objects
 * @param {string} password - PDF password (if any)
 * @returns {Promise<Object>} Combined parsed data
 */
async function parsePPFStatements(files, password) {
  const allTransactions = [];
  let accountInfo = null;

  for (const file of files) {
    const parsed = await parseSingleStatement(file.buffer, password);
    if (!accountInfo && parsed.accountName) {
      accountInfo = {
        accountName: parsed.accountName,
        accountNumber: parsed.accountNumber,
        accountType: parsed.accountType,
        interestRate: parsed.interestRate,
        openDate: parsed.openDate,
        maturityDate: parsed.maturityDate,
        openingBalance: parsed.openingBalance || 0,
        statementFrom: parsed.statementFrom,
      };
    } else if (accountInfo && parsed.statementFrom && parsed.statementFrom < accountInfo.statementFrom) {
      // Keep the opening balance from the earliest statement
      accountInfo.openingBalance = parsed.openingBalance || 0;
      accountInfo.statementFrom = parsed.statementFrom;
    }
    allTransactions.push(...parsed.transactions);
  }

  // Deduplicate by date+type+amount
  const seen = new Set();
  const uniqueTxns = [];
  for (const txn of allTransactions) {
    const key = `${txn.date}|${txn.type}|${txn.amount}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueTxns.push(txn);
    }
  }

  // Sort chronologically
  uniqueTxns.sort((a, b) => a.date.localeCompare(b.date));

  return {
    ...(accountInfo || {}),
    transactions: uniqueTxns,
  };
}

/**
 * Parse a single PPF/SSY statement PDF.
 */
async function parseSingleStatement(buffer, password) {
  const opts = { data: buffer, verbosity: 0 };
  if (password) opts.password = password;
  const parser = new PDFParse(opts);
  const result = await parser.getText();
  const text = result.text;

  // Extract header fields
  const accountName = extractField(text, /Account\s*Name\s*:\s*(.+)/i);
  const accountNumber = extractField(text, /Account\s*Number\s*:\s*(\S+)/i);
  const accountDesc = extractField(text, /Account\s*Description\s*:\s*(.+)/i);
  const interestRateStr = extractField(text, /Interest\s*Rate\s*\(%\s*p\.a\.\)\s*:\s*([\d.]+)/i);
  const openDateStr = extractField(text, /Open\s*Date\s*:\s*(.+)/i);
  const maturityDateStr = extractField(text, /Maturity\s*Date\s*:\s*(.+)/i);
  const balanceStr = extractField(text, /Balance\s*as\s*on\s*\d+\s*\w+\s*\d+\s*:\s*([\d,]+\.?\d*)/i);
  const stmtRange = text.match(/Account\s*Statement\s*from\s*(\d+\s+\w+\s+\d+)\s*to\s*(\d+\s+\w+\s+\d+)/i);

  // Determine account type from description
  let accountType = 'PPF';
  if (accountDesc && /sukanya|samriddhi|ssy/i.test(accountDesc)) {
    accountType = 'SSY';
  }

  const interestRate = interestRateStr ? parseFloat(interestRateStr) : null;
  const openDate = openDateStr ? parseDate(openDateStr) : null;
  const maturityDate = maturityDateStr ? parseDate(maturityDateStr) : null;
  const openingBalance = balanceStr ? parseAmount(balanceStr) : 0;
  const statementFrom = stmtRange ? parseDate(stmtRange[1]) : null;
  const statementTo = stmtRange ? parseDate(stmtRange[2]) : null;

  // Extract transactions
  const transactions = extractTransactions(text);

  return {
    accountName: accountName ? accountName.replace(/^(Mr\.|Mrs\.|Ms\.|Miss\.|Shri|Smt\.?)\s*/i, '').trim() : null,
    accountNumber: accountNumber ? accountNumber.replace(/^0+/, '') : null,
    accountType,
    interestRate,
    openDate,
    maturityDate,
    openingBalance,
    statementFrom,
    statementTo,
    transactions,
  };
}

/**
 * Extract a single field from statement text.
 */
function extractField(text, regex) {
  const m = text.match(regex);
  return m ? m[1].trim() : null;
}

/**
 * Extract transactions from the statement text.
 *
 * The PDF text for each transaction row typically looks like:
 *   "3 Oct 2019 3 Oct 2019 BY TRANSFER-INB Deposit ... 1,50,000.00 4,16,999.00"
 *   "31 Mar\n2020 31 Mar\n2020 CREDIT INTEREST-- 28,795.00 4,45,794.00"
 *
 * Strategy: find all amounts (Indian comma format) on each logical line,
 * then work backwards — last amount is balance, second-to-last is credit or debit.
 */
function extractTransactions(text) {
  const transactions = [];

  // Split text after the header row marker
  const headerMarker = /Debit\s+Credit\s+Balance/i;
  const headerIdx = text.search(headerMarker);
  if (headerIdx === -1) return transactions;

  let txnText = text.substring(headerIdx);
  // Remove the header line itself
  txnText = txnText.replace(headerMarker, '');
  // Remove page footer
  txnText = txnText.replace(/--\s*\d+\s*of\s*\d+\s*--/g, '');

  // Normalize multi-line dates: "31 Mar\n2020" → "31 Mar 2020"
  // The PDF often breaks date across lines
  txnText = txnText.replace(/(\d{1,2}\s+[A-Za-z]{3})\s*\n\s*(\d{4})/g, '$1 $2');

  // Split into logical transaction blocks.
  // Each transaction starts with a date pattern like "3 Oct 2019" or "31 Mar 2020"
  // We look for the date pattern that starts a new transaction (txn date + value date).
  const txnBlocks = [];
  const datePattern = /(\d{1,2}\s+[A-Za-z]{3}\s+\d{4})/g;

  // Find all date occurrences
  const dates = [];
  let dm;
  while ((dm = datePattern.exec(txnText)) !== null) {
    dates.push({ index: dm.index, text: dm[1] });
  }

  // Group: each transaction has two consecutive dates (txn date, value date)
  // followed by description and amounts. We split by pairs of dates.
  // Simpler approach: split by finding lines that start with a date
  const lines = txnText.split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0);

  let currentBlock = '';
  for (const line of lines) {
    // Check if this line starts a new transaction (starts with a date)
    if (/^\d{1,2}\s+[A-Za-z]{3}\s+\d{4}/.test(line) && currentBlock.length > 0) {
      txnBlocks.push(currentBlock);
      currentBlock = line;
    } else {
      currentBlock += ' ' + line;
    }
  }
  if (currentBlock.length > 0) txnBlocks.push(currentBlock);

  // Parse each block
  for (const block of txnBlocks) {
    // Extract the first date (txn date)
    const dateMatch = block.match(/(\d{1,2}\s+[A-Za-z]{3}\s+\d{4})/);
    if (!dateMatch) continue;
    const date = parseDate(dateMatch[1]);
    if (!date) continue;

    // Extract all amounts (Indian format: digits with commas, optional decimals)
    const amountRegex = /([\d,]+\.\d{2})/g;
    const amounts = [];
    let am;
    while ((am = amountRegex.exec(block)) !== null) {
      amounts.push(parseAmount(am[1]));
    }

    // Need at least 2 amounts (credit/debit + balance)
    if (amounts.length < 2) continue;

    const balance = amounts[amounts.length - 1];
    const amount = amounts[amounts.length - 2];
    if (amount === 0) continue;

    // Get the description text (between dates and amounts)
    const description = block
      .replace(/[\d,]+\.\d{2}/g, '') // remove amounts
      .replace(/\d{1,2}\s+[A-Za-z]{3}\s+\d{4}/g, '') // remove dates
      .replace(/\s+/g, ' ')
      .trim();

    const type = classifyTransaction(description);

    transactions.push({
      date,
      description: description.substring(0, 200), // cap length
      type,
      amount,
      balance,
    });
  }

  return transactions;
}

module.exports = { parsePPFStatements };
