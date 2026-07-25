/**
 * AIS (Annual Information Statement) PDF Parser.
 *
 * Extracts structured income, TDS/TCS, and financial transaction data
 * from the Income Tax Department's AIS PDF for a given financial year.
 */
const { PDFParse } = require('pdf-parse');

/**
 * Parse an AIS PDF buffer and return structured data.
 * @param {Buffer} pdfBuffer
 * @returns {Promise<Object>}
 */
async function parseAIS(pdfBuffer) {
  const parser = new PDFParse({ data: pdfBuffer, verbosity: 0 });
  const result = await parser.getText();
  const text = result.text;

  const pan = extractPAN(text);
  const name = extractName(text);
  const fy = extractFY(text);

  const salary = extractSalary(text);
  const salaryAnnexure = extractSalaryAnnexure(text);
  const interestOnSecurities = extractInterestOnSecurities(text);
  const pfTaxableInterest = extractPFTaxableInterest(text);
  const lcsTcs = extractLRSTCS(text);
  const savingsInterest = extractSavingsInterest(text);
  const tdInterest = extractTDInterest(text);
  const dividendsSFT = extractDividendsSFT(text);
  const taxPayments = extractTaxPayments(text);

  // Merge salary with annexure breakup (17(1)/17(2)/17(3))
  for (const s of salary) {
    const ann = salaryAnnexure.find((a) => s.source_pan && a.source_pan === s.source_pan);
    if (ann) {
      s.s17_1 = ann.s17_1;
      s.s17_2 = ann.s17_2;
      s.s17_3 = ann.s17_3;
    }
  }

  return {
    pan,
    name,
    fy,
    salary,
    interest_on_securities: interestOnSecurities,
    pf_taxable_interest: pfTaxableInterest,
    lrs_tcs: lcsTcs,
    savings_interest: savingsInterest,
    td_interest: tdInterest,
    dividends_sft: dividendsSFT,
    tax_payments: taxPayments,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function cleanText(t) {
  return t.replace(/\s+/g, ' ').trim();
}

function parseAmount(raw) {
  if (!raw) return 0;
  const cleaned = String(raw).replace(/[,\s]/g, '');
  const val = parseFloat(cleaned);
  return Number.isFinite(val) ? val : 0;
}

function extractPAN(text) {
  const m = text.match(/Permanent\s+Account\s+Number\s+\(PAN\).*?([A-Z]{5}\d{4}[A-Z])/);
  if (m) return m[1];
  // Fallback: PAN appears right after header line
  const m2 = text.match(/Name\s+of\s+Assessee\s+([A-Z]{5}\d{4}[A-Z])/);
  return m2 ? m2[1] : null;
}

function extractName(text) {
  const m = text.match(/Name\s+of\s+Assessee\s+([A-Z]{5}\d{4}[A-Z])\s+.*?\s+(\d{4})\s+([\w\s]+?)(?:\s+Date\s+of\s+Birth)/);
  if (m) return cleanText(m[3]);
  const m2 = text.match(/([A-Z]{5}\d{4}[A-Z])\s+(?:XXXX.*?)\s+([\w\s]+?)\s+Date\s+of\s+Birth/);
  return m2 ? cleanText(m2[2]) : null;
}

function extractFY(text) {
  const m = text.match(/Financial\s+Year\s+(\d{4}-\d{2})/);
  return m ? m[1] : null;
}

/**
 * Extract salary entries from TDS-192 sections.
 * Each entry: { source, source_pan, gross, tds_total, count }
 */
function extractSalary(text) {
  const results = [];
  // Match TDS-192 blocks: code, description, source with PAN, count, amount
  const blockRe = /TDS-192\s+Salary\s+received\s+\(Section\s+192\)\s+(.*?)\s+\((\w+)\)\s+(\d+)\s+([\d,]+)/g;
  let m;
  while ((m = blockRe.exec(text)) !== null) {
    const source = cleanText(m[1]);
    const sourcePan = m[2];
    const count = parseInt(m[3]);
    const gross = parseAmount(m[4]);

    // Sum TDS from quarterly rows that follow
    let tdsTotal = 0;
    const afterBlock = text.substring(m.index + m[0].length, m.index + m[0].length + 3000);
    const tdsRe = /Q\d.*?\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+Active/g;
    let tm;
    let rowCount = 0;
    while ((tm = tdsRe.exec(afterBlock)) !== null && rowCount < count) {
      tdsTotal += parseAmount(tm[2]); // TDS deducted column
      rowCount++;
    }

    results.push({ source, source_pan: sourcePan, gross, tds_total: tdsTotal, count });
  }
  return results;
}

/**
 * Extract salary annexure II breakup (17(1), 17(2), 17(3)).
 */
function extractSalaryAnnexure(text) {
  const results = [];
  const blockRe = /TDS-\s*Ann\.II-\s*SAL\s+Salary\s+\(TDS\s+Annexure\s+II\)\s+(.*?)\s+\((\w+)\)\s+\d+\s+([\d,]+)/g;
  let m;
  while ((m = blockRe.exec(text)) !== null) {
    const sourcePan = m[2];
    const afterBlock = text.substring(m.index + m[0].length, m.index + m[0].length + 1500);
    // Look for: GROSS SALARY U/S 17(1) | VALUE OF PERQUISITES U/S 17(2) | PROFITS IN LIEU 17(3) | GROSS SALARY
    const rowRe = /([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+Active/;
    const rm = afterBlock.match(rowRe);
    if (rm) {
      results.push({
        source_pan: sourcePan,
        s17_1: parseAmount(rm[1]),
        s17_2: parseAmount(rm[2]),
        s17_3: parseAmount(rm[3]),
      });
    }
  }
  return results;
}

/**
 * Extract interest on securities (TDS-193, NCD/bond interest).
 */
function extractInterestOnSecurities(text) {
  const results = [];
  const blockRe = /TDS-193\s+Interest\s+received\s+on\s+securities\s+\(Section\s+193\)\s+(.*?)\s+\((\w+)\)\s+(\d+)\s+([\d,]+)/g;
  let m;
  while ((m = blockRe.exec(text)) !== null) {
    const source = cleanText(m[1]);
    const amount = parseAmount(m[4]);
    const count = parseInt(m[3]);
    // Sum TDS
    let tds = 0;
    const afterBlock = text.substring(m.index + m[0].length, m.index + m[0].length + 3000);
    const tdsRe = /Q\d.*?\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+Active/g;
    let tm;
    let rowCount = 0;
    while ((tm = tdsRe.exec(afterBlock)) !== null && rowCount < count) {
      tds += parseAmount(tm[2]);
      rowCount++;
    }
    results.push({ source, amount, tds });
  }
  return results;
}

/**
 * Extract PF taxable interest (TDS-192A).
 */
function extractPFTaxableInterest(text) {
  const results = [];
  // TDS-192A with (Section 192A) possibly on next line, then source PAN, count, amount
  const blockRe = /TDS-192A\s+Receipt\s+of\s+accumulated\s+balance\s+due\s+to\s+an\s+employee[\s\S]*?\(\w+\)\s+(\d+)\s+([\d,]+)/g;
  let m;
  while ((m = blockRe.exec(text)) !== null) {
    const amount = parseAmount(m[2]);
    const afterBlock = text.substring(m.index + m[0].length, m.index + m[0].length + 1000);
    // Quarterly row: amount_paid, tds_deducted, tds_deposited, Active
    const tdsRe = /([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+Active/;
    const tm = afterBlock.match(tdsRe);
    const tds = tm ? parseAmount(tm[2]) : 0;
    results.push({ source: 'EPFO', amount, tds });
  }
  return results;
}

/**
 * Extract LRS TCS (TCS-206CQ).
 */
function extractLRSTCS(text) {
  const results = [];
  const blockRe = /TCS-206CQ\s+Remittance\s+under\s+LRS.*?\s+(.*?)\s+\((\w+)\)\s+(\d+)\s+([\d,]+)/g;
  let m;
  while ((m = blockRe.exec(text)) !== null) {
    const source = cleanText(m[1]);
    const amount = parseAmount(m[4]);
    const count = parseInt(m[3]);
    let tcs = 0;
    const afterBlock = text.substring(m.index + m[0].length, m.index + m[0].length + 2000);
    const tcsRe = /([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+Active/g;
    let tm;
    let rowCount = 0;
    while ((tm = tcsRe.exec(afterBlock)) !== null && rowCount < count) {
      tcs += parseAmount(tm[2]);
      rowCount++;
    }
    results.push({ source, amount, tcs });
  }
  return results;
}

/**
 * Extract savings bank interest (SFT-016(SB)).
 */
function extractSavingsInterest(text) {
  const results = [];
  const blockRe = /SFT-016\(SB\)\s+Interest\s+income\s+\(SFT-016\)\s+[–-]\s+Savings\s+(.*?)\s+\(\w+(?:\.\w+)?\)\s+\d+\s+([\d,]+)/g;
  let m;
  while ((m = blockRe.exec(text)) !== null) {
    const source = cleanText(m[1]);
    const amount = parseAmount(m[2]);
    // Try to extract account number
    const afterBlock = text.substring(m.index + m[0].length, m.index + m[0].length + 500);
    const accRe = /(\d{5,})\s+Saving\s+([\d,]+)/;
    const am = afterBlock.match(accRe);
    results.push({
      source,
      account_number: am ? am[1] : null,
      amount,
    });
  }
  return results;
}

/**
 * Extract term deposit interest (SFT-016(TD)).
 */
function extractTDInterest(text) {
  const results = [];
  const blockRe = /SFT-016\(TD\)\s+Interest\s+income\s+\(SFT-016\)\s+[–-]\s+Term\s+Deposit\s+(.*?)\s+\(\w+(?:\.\w+)?\)\s+(\d+)\s+([\d,]+)/g;
  let m;
  while ((m = blockRe.exec(text)) !== null) {
    const source = cleanText(m[1]);
    const count = parseInt(m[2]);
    const totalAmount = parseAmount(m[3]);
    // Extract individual FD rows
    const afterBlock = text.substring(m.index + m[0].length, m.index + m[0].length + 2000);
    const fdRe = /(\d{5,})\s+Time\s+Deposit\s+([\d,]+)\s+Active/g;
    let fm;
    const fds = [];
    while ((fm = fdRe.exec(afterBlock)) !== null && fds.length < count) {
      fds.push({ account_number: fm[1], amount: parseAmount(fm[2]) });
    }
    if (fds.length > 0) {
      for (const fd of fds) {
        results.push({ source, account_number: fd.account_number, amount: fd.amount });
      }
    } else {
      results.push({ source, account_number: null, amount: totalAmount });
    }
  }
  return results;
}

/**
 * Extract dividend SFT entries (SFT-015) for cross-verification.
 */
function extractDividendsSFT(text) {
  const results = [];
  const blockRe = /SFT-015\s+Dividend\s+income\s+\(SFT-015\)\s+(.*?)\s+\(\w+(?:\.\w+)?\)\s+\d+\s+([\d,]+)/g;
  let m;
  while ((m = blockRe.exec(text)) !== null) {
    results.push({ source: cleanText(m[1]), amount: parseAmount(m[2]) });
  }
  return results;
}

/**
 * Extract tax payment details from Part B3.
 */
function extractTaxPayments(text) {
  const results = [];
  // Look for self-assessment / advance tax entries
  const blockRe = /(\d{4}-\d{2})\s+Income\s+Tax.*?(?:Self\s+Assessment|Advance\s+Tax|TDS\s+on.*?Property.*?Contractors.*?Professionals.*?Digital\s+Asset)\s+([\d,]+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([\d,]+)\s+(\d+)\s+(\d{2}\/\d{2}\/\d{4})\s+(\d+)/g;
  let m;
  while ((m = blockRe.exec(text)) !== null) {
    results.push({
      fy: m[1],
      amount: parseAmount(m[6]),
      date: m[8],
      bsr_code: m[7],
      challan: m[9],
    });
  }
  return results;
}

module.exports = { parseAIS };
