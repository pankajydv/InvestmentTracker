const db = require('better-sqlite3')('./data/investments.db');
const XLSX = require('xlsx');

// Fetch all transactions with investment details
const rows = db.prepare(`
  SELECT 
    t.id as txn_id,
    t.transaction_date as "Date",
    t.transaction_type as "Transaction",
    i.name as "Name",
    i.asset_type as "Type",
    i.ticker_symbol as Ticker,
    i.amfi_code as AMFI_Code,
    i.folio_number as Folio,
    t.units as Quantity,
    t.price_per_unit as Rate,
    t.amount as Amount,
    t.fees as Fees,
    COALESCE(t.broker, i.broker) as Broker,
    i.face_value as Face_Value,
    i.coupon_frequency as Coupon_Freq,
    i.maturity_date as Maturity_Date,
    i.currency as Currency,
    p.name as Portfolio,
    t.notes as Notes,
    t.investment_id as Inv_ID
  FROM transactions t
  JOIN investments i ON t.investment_id = i.id
  JOIN portfolios p ON i.portfolio_id = p.id
  ORDER BY t.transaction_date, t.id
`).all();

console.log('Total transactions:', rows.length);

// Group by year
const byYear = {};
rows.forEach(r => {
  const year = r.Date.substring(0, 4);
  if (!byYear[year]) byYear[year] = [];
  byYear[year].push(r);
});

const wb = XLSX.utils.book_new();

// "All" sheet with every column for zero data loss
const allHeaders = ['Date', 'Transaction', 'Type', 'Name', 'Ticker', 'Quantity', 'Rate', 'Amount', 'Fees', 'Broker', 'Portfolio', 'AMFI Code', 'Folio', 'Face Value', 'Coupon Freq', 'Maturity Date', 'Currency', 'Notes'];
const allData = [allHeaders];
rows.forEach(r => {
  allData.push([
    r.Date, r.Transaction, r.Type, r.Name, r.Ticker,
    r.Quantity, r.Rate, r.Amount, r.Fees,
    r.Broker, r.Portfolio, r.AMFI_Code, r.Folio,
    r.Face_Value, r.Coupon_Freq, r.Maturity_Date, r.Currency, r.Notes
  ]);
});
const wsAll = XLSX.utils.aoa_to_sheet(allData);
wsAll['!cols'] = [
  {wch: 12}, {wch: 14}, {wch: 14}, {wch: 40}, {wch: 16},
  {wch: 10}, {wch: 12}, {wch: 14}, {wch: 10},
  {wch: 14}, {wch: 14}, {wch: 12}, {wch: 14},
  {wch: 12}, {wch: 12}, {wch: 14}, {wch: 8}, {wch: 40}
];
XLSX.utils.book_append_sheet(wb, wsAll, 'All');

// Per-year sheets (like reference Sharekhan.xlsx)
const years = Object.keys(byYear).sort();
years.forEach(year => {
  const yearHeaders = ['Date', 'Transaction', 'Type', 'Name', 'Ticker', 'Quantity', 'Rate', 'Amount', 'Fees', 'Broker', 'Portfolio', 'Notes'];
  const data = [yearHeaders];
  byYear[year].forEach(r => {
    data.push([
      r.Date, r.Transaction, r.Type, r.Name, r.Ticker,
      r.Quantity, r.Rate, r.Amount, r.Fees,
      r.Broker, r.Portfolio, r.Notes
    ]);
  });
  const ws = XLSX.utils.aoa_to_sheet(data);
  ws['!cols'] = [
    {wch: 12}, {wch: 14}, {wch: 14}, {wch: 40}, {wch: 16},
    {wch: 10}, {wch: 12}, {wch: 14}, {wch: 10},
    {wch: 14}, {wch: 14}, {wch: 40}
  ];
  XLSX.utils.book_append_sheet(wb, ws, year);
});

const outPath = 'E:\\Finance\\Investments\\MyInvestments.xlsx';
XLSX.writeFile(wb, outPath);
console.log('Exported to', outPath);
console.log('Sheets:', ['All', ...years].join(', '));
console.log('Rows per year:', Object.entries(byYear).map(([y, r]) => `${y}: ${r.length}`).join(', '));
