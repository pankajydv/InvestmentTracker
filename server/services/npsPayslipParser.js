/**
 * NPS Payslip Parser
 *
 * Extracts the monthly "NPS charges deduction" amount from salary-slip PDFs.
 *
 * Corporate NPS statements (Protean vertical CSV format) no longer include the
 * intermediary/POP charges column, so contribution "fees" cannot be sourced from
 * the NPS statement alone. The salary slip lists these charges as a monthly
 * deduction line item ("NPS charges deduction"). This parser reads that value per
 * month so the NPS import can populate transaction fees.
 *
 * Payslip layout (positioned text via pdfjs-dist):
 *   Header row:  Earnings | Current Month | YTD* | Deductions | Current Month | YTD*
 *   Deductions columns:  name ≈ x303,  current-month ≈ x444-500,  YTD ≈ x521-540
 *
 * Returns: [{ month: 'YYYY-MM', charge, ytd, sourceFile }]
 */

const MONTHS = {
  january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
  july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
};

/** Parse "1,269" / "107" / "(50)" → number (or null). */
function parseNum(s) {
  if (s == null) return null;
  const str = String(s).trim();
  if (!str || str === '-') return null;
  const neg = str.startsWith('(') && str.endsWith(')');
  const cleaned = str.replace(/[(),₹Rs\s]/gi, '');
  const val = parseFloat(cleaned);
  if (!Number.isFinite(val)) return null;
  return neg ? -val : val;
}

/**
 * Parse a single payslip PDF buffer into positioned rows and extract, for each
 * "Payslip for the month of <Month> <Year>" page, the NPS charges deduction.
 */
async function parsePayslipBuffer(buffer, sourceFile) {
  const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;

  const results = [];

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale: 1.0 });
    const content = await page.getTextContent();
    const items = content.items
      .filter(it => it.str && it.str.trim())
      .map(it => ({
        text: it.str.trim(),
        x: Math.round(it.transform[4]),
        y: Math.round(viewport.height - it.transform[5]),
      }))
      .sort((a, b) => a.y - b.y || a.x - b.x);

    // Group items into rows by y-coordinate proximity.
    const rows = [];
    let cur = null;
    for (const item of items) {
      if (!cur || Math.abs(item.y - cur.y) > 4) {
        cur = { y: item.y, items: [] };
        rows.push(cur);
      }
      cur.items.push(item);
    }

    // Month header for this page.
    const pageText = rows.map(r => r.items.map(i => i.text).join(' ')).join('\n');
    const monthMatch = pageText.match(/Payslip\s+for\s+the\s+month\s+of\s+([A-Za-z]+)\s+(\d{4})/i);
    if (!monthMatch) continue;
    const mm = MONTHS[monthMatch[1].toLowerCase()];
    const yyyy = monthMatch[2];
    if (!mm) continue;
    const monthKey = `${yyyy}-${mm}`;

    // Locate the "NPS charges deduction" row. The label sits in the deductions
    // block (x ≈ 303). The current-month value is the numeric item at x ≈ 440-510;
    // the YTD value is at x ≈ 520+.
    const npsRow = rows.find(r =>
      r.items.some(i => /NPS\s+charges?\s+deduction/i.test(i.text)) ||
      /NPS\s+charges?\s+deduction/i.test(r.items.map(i => i.text).join(' '))
    );
    if (!npsRow) continue;

    // Numeric items on the deductions side (x >= 400), left-to-right.
    const dedNums = npsRow.items
      .filter(i => i.x >= 400 && parseNum(i.text) != null)
      .sort((a, b) => a.x - b.x)
      .map(i => parseNum(i.text));

    // First deductions-side number = current month charge; last = YTD.
    const charge = dedNums.length ? dedNums[0] : null;
    const ytd = dedNums.length ? dedNums[dedNums.length - 1] : null;

    if (charge != null && charge >= 0) {
      results.push({ month: monthKey, charge, ytd, sourceFile });
    }
  }

  return results;
}

/**
 * Parse multiple payslip files (multer file objects with .buffer/.originalname).
 * Returns a Map: 'YYYY-MM' → { charge, ytd, sourceFile }.
 * Later files/pages do not overwrite an already-found month.
 */
async function parseNpsPayslips(files) {
  const byMonth = new Map();
  for (const file of files || []) {
    let rows = [];
    try {
      rows = await parsePayslipBuffer(file.buffer, file.originalname);
    } catch (e) {
      // Skip unreadable payslip files; NPS import can proceed without fees.
      continue;
    }
    for (const r of rows) {
      if (!byMonth.has(r.month)) byMonth.set(r.month, r);
    }
  }
  return byMonth;
}

/**
 * Given an NPS contribution credit date (YYYY-MM-DD), return the payslip month
 * (YYYY-MM) it corresponds to. Employer NPS contributions are deducted from a
 * given month's salary and credited to NPS early the following month, so the
 * charge for a credit in month M is found on the payslip for month M-1.
 */
function payslipMonthForCreditDate(dateISO) {
  const m = String(dateISO || '').match(/^(\d{4})-(\d{2})-\d{2}$/);
  if (!m) return null;
  let year = Number(m[1]);
  let month = Number(m[2]) - 1; // previous month
  if (month < 1) { month = 12; year -= 1; }
  return `${year}-${String(month).padStart(2, '0')}`;
}

module.exports = { parseNpsPayslips, payslipMonthForCreditDate };
