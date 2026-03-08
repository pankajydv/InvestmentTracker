/**
 * Dump raw text from the CAS PDF for analysis
 */
const fs = require('fs');
const { PDFParse } = require('pdf-parse');

const CAS_PATH = 'D:\\Downloads\\MAY2025_AA02249235_TXN.pdf';
const PASSWORD = 'ABTPY0766H';

(async () => {
  const buf = fs.readFileSync(CAS_PATH);
  const parser = new PDFParse({ data: buf, password: PASSWORD, verbosity: 0 });
  const result = await parser.getText();
  
  // Write full text to file for inspection
  const outPath = 'd:\\Code\\InvestmentTracker\\scripts\\cas_text_dump.txt';
  fs.writeFileSync(outPath, result.text);
  console.log(`Wrote ${result.text.length} chars to ${outPath}`);
  console.log(`Pages: ${result.pages.length}`);
  
  // Print first 5000 chars to get a sense of the format
  console.log('\n=== FIRST 5000 CHARS ===');
  console.log(result.text.substring(0, 5000));
})().catch(e => console.error(e.message));
