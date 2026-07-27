const { PDFParse } = require('pdf-parse');

function parseAmount(raw) {
  if (raw == null) return 0;
  const cleaned = String(raw).replace(/[,\s]/g, '');
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function toLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function extractPAN(text) {
  const m = String(text || '').match(/\b[A-Z]{5}[0-9]{4}[A-Z]\b/);
  return m ? m[0] : null;
}

function matchAmountNear(lines, regex, lookahead = 3) {
  for (let i = 0; i < lines.length; i += 1) {
    if (!regex.test(lines[i])) continue;
    for (let k = 0; k <= lookahead; k += 1) {
      const line = lines[i + k] || '';
      const matches = line.match(/([0-9]{1,3}(?:,[0-9]{2,3})*(?:\.[0-9]{2})|[0-9]+\.[0-9]{2})/g);
      if (matches && matches.length > 0) {
        const val = parseAmount(matches[matches.length - 1]);
        if (val >= 0) return val;
      }
    }
  }
  return null;
}

function extractNps80ccd2(lines) {
  // High-confidence pattern seen in this Form-16 layout.
  for (const line of lines) {
    const m = String(line).match(/nps\s+contribution\s+([0-9]{1,3}(?:,[0-9]{2,3})*(?:\.[0-9]{2})|[0-9]+\.[0-9]{2})/i);
    if (m) {
      const v = parseAmount(m[1]);
      if (Number.isFinite(v) && v >= 0) return v;
    }
  }

  // Fallback: search near 80CCD(2) label, but reject suspicious zero-only matches.
  const near = matchAmountNear(
    lines,
    /deduction\s+in\s+respect\s+of\s+contribution\s+by\s+employer\s+to\s+pension\s+scheme\s+under\s+section\s*80ccd\s*\(\s*2\s*\)|80ccd\s*\(\s*2\s*\)/i,
    6,
  );
  if (near == null) return null;
  return near > 0 ? near : null;
}

async function parseForm16(pdfBuffer) {
  const parser = new PDFParse({ data: pdfBuffer, verbosity: 0 });
  const result = await parser.getText();
  const text = result.text || '';
  const lines = toLines(text);

  const nps80ccd2 = extractNps80ccd2(lines);

  const salaryTds192 = matchAmountNear(
    lines,
    /less\s*:\s*tax\s+deducted\s+at\s+source\s+under\s+section\s*192|tax\s+deducted\s+at\s+source\s+under\s+section\s*192/i,
    4,
  );

  const grossSalary = matchAmountNear(lines, /gross\s+salary/i, 4);
  const taxableIncome = matchAmountNear(lines, /total\s+taxable\s+income/i, 2);

  return {
    pan: extractPAN(text),
    nps_employer_80ccd2: nps80ccd2 != null ? Math.round(nps80ccd2) : null,
    salary_tds_192: salaryTds192 != null ? Math.round(salaryTds192) : null,
    gross_salary: grossSalary != null ? Math.round(grossSalary) : null,
    total_taxable_income: taxableIncome != null ? Math.round(taxableIncome) : null,
    extracted_at: new Date().toISOString(),
  };
}

module.exports = { parseForm16 };
