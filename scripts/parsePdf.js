const fs = require('fs');
const { PDFParse } = require('pdf-parse');

const filePath = 'E:/Finance/Investments/Sharekhan/NSE-Contract-20150904.pdf';
const password = 'ABTPY0766H'; // Anju Yadav's PAN

(async () => {
  const buf = fs.readFileSync(filePath);
  const data = new Uint8Array(buf);
  const parser = new PDFParse({ data, password });
  await parser.load();
  const text = await parser.getText();
  console.log('--- TEXT ---');
  console.log(text);
})();
