const fs = require('fs');
const { PDFParse } = require('pdf-parse');

(async () => {
  const buf = fs.readFileSync('D:/Downloads/SEP2016_AA02249235_TXN.pdf');
  const parser = new PDFParse({ data: buf, password: 'ABTPY0766H', verbosity: 0 });
  const text = await parser.getText();
  
  // Write full text to file for analysis
  fs.writeFileSync('scripts/cas_sep2016_text.txt', text.text);
  console.log(`Total chars: ${text.text.length}`);
  console.log(`Total pages: ${text.total}`);
  console.log('\n--- First 8000 chars ---');
  console.log(text.text.substring(0, 8000));
})();
