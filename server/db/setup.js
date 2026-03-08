const { getDb, initializeDb } = require('./schema');

console.log('Setting up database...');
const db = getDb();
initializeDb(db);
console.log('Database setup complete!');

// Optionally seed sample data
const args = process.argv.slice(2);
if (args.includes('--seed')) {
  console.log('Seeding sample data...');

  // Create family portfolios
  const insertPortfolio = db.prepare('INSERT OR IGNORE INTO portfolios (name, color, pan_number) VALUES (?, ?, ?)');
  insertPortfolio.run('Anju Yadav', '#f59e0b', null);
  insertPortfolio.run('Pankaj Yadav', '#3b82f6', 'ABHPY9828Q');
  console.log('Created 2 family portfolios: Anju Yadav, Pankaj Yadav');

  const anjuId = db.prepare("SELECT id FROM portfolios WHERE name = 'Anju Yadav'").get().id;
  const pankajId = db.prepare("SELECT id FROM portfolios WHERE name = 'Pankaj Yadav'").get().id;

  const insertInvestment = db.prepare(`
    INSERT INTO investments (name, asset_type, ticker_symbol, amfi_code, folio_number, currency, portfolio_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const insertTransaction = db.prepare(`
    INSERT INTO transactions (investment_id, transaction_type, transaction_date, units, price_per_unit, amount)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  // Anju's Mutual Funds (₹47.24L invested, ₹56.65L current)
  const anjuFunds = [
    { name: 'Axis Small Cap Dir-G', amfi: '125354', folio: '', units: 2800, costPerUnit: 115.78, totalCost: 324184 },
    { name: 'HDFC Focused Dir-G', amfi: '119063', folio: '', units: 1300, costPerUnit: 257.16, totalCost: 334308 },
    { name: 'ICICI Pru Large Cap Dir-G', amfi: '120586', folio: '', units: 4500, costPerUnit: 113.63, totalCost: 511335 },
    { name: 'SBI Contra Dir-G', amfi: '120578', folio: '', units: 400, costPerUnit: 406.21, totalCost: 162484 },
  ];

  // Pankaj's Mutual Funds (rest of the portfolio)
  const pankajFunds = [
    { name: 'Axis Small Cap Dir-G', amfi: '125354', folio: '', units: 2900, costPerUnit: 115.78, totalCost: 335762 },
    { name: 'HDFC Flexi Cap Dir-G', amfi: '118989', folio: '35377403', units: 132, costPerUnit: 2266.66, totalCost: 299985 },
    { name: 'HDFC Focused Dir-G', amfi: '119063', folio: '', units: 1383, costPerUnit: 257.16, totalCost: 355658 },
    { name: 'ICICI Pru Large Cap Dir-G', amfi: '120586', folio: '', units: 4617, costPerUnit: 113.63, totalCost: 524670 },
    { name: 'Motilal Oswal Midcap Dir-G', amfi: '147622', folio: '', units: 4748, costPerUnit: 112.67, totalCost: 534984 },
    { name: 'Parag Parikh Flexi Cap Dir-G', amfi: '122639', folio: '', units: 8108, costPerUnit: 80.78, totalCost: 654967 },
    { name: 'SBI Contra Dir-G', amfi: '120578', folio: '', units: 412, costPerUnit: 406.21, totalCost: 167499 },
  ];

  const seedTransaction = db.transaction(() => {
    for (const fund of anjuFunds) {
      const result = insertInvestment.run(
        fund.name, 'MUTUAL_FUND', null, fund.amfi, fund.folio || null, 'INR', anjuId
      );
      insertTransaction.run(
        result.lastInsertRowid, 'BUY', '2023-01-15', fund.units, fund.costPerUnit, fund.totalCost
      );
    }
    for (const fund of pankajFunds) {
      const result = insertInvestment.run(
        fund.name, 'MUTUAL_FUND', null, fund.amfi, fund.folio || null, 'INR', pankajId
      );
      insertTransaction.run(
        result.lastInsertRowid, 'BUY', '2023-01-15', fund.units, fund.costPerUnit, fund.totalCost
      );
    }
  });

  seedTransaction();
  console.log(`Seeded ${anjuFunds.length} funds for Anju, ${pankajFunds.length} funds for Pankaj.`);
}

db.close();
console.log('Done!');
