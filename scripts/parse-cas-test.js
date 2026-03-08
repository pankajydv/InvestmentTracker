// Quick test script to see CAS PDF structure
const fs = require('fs');
const { PDFParse } = require('pdf-parse');

async function main() {
  const dataBuffer = fs.readFileSync('D:\\Downloads\\JAN2026_AA09934529_TXN.pdf');

  try {
    const parser = new PDFParse({ data: dataBuffer, password: 'ABHPY9828Q', verbosity: 0 });
    const result = await parser.getText();
    
    // Write full text to file for analysis
    fs.writeFileSync('scripts/cas-text-output.txt', result.text);
    console.log('Pages:', result.total);
    console.log('Text length:', result.text.length);
    console.log('\n--- First 8000 chars ---\n');
    console.log(result.text.substring(0, 8000));
  } catch (e) {
    console.error('Error:', e.message);
    console.error(e.stack);
  }
}

main();
