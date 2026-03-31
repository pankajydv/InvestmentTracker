/**
 * Export all investment data to Excel for full backup/restore.
 *
 * Sheets:
 *   Portfolios        – portfolio definitions
 *   Investments        – all investment instruments
 *   Transactions       – every transaction (with portfolio_name for readability)
 *   Expenses           – portfolio-level expenses
 *   Interest_Rates     – PPF/PF rate history
 *   Config             – app configuration
 *
 * Usage:
 *   node scripts/export_to_excel.js [output_path]
 *   Default output: E:\Finance\Investments\MyInvestments.xlsx
 */

const Database = require('better-sqlite3');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'data', 'investments.db');
const DEFAULT_OUTPUT = String.raw`E:\Finance\Investments\MyInvestments.xlsx`;
const OUTPUT = process.argv[2] || DEFAULT_OUTPUT;

const db = new Database(DB_PATH, { readonly: true });
db.pragma('foreign_keys = ON');

// ── helpers ────────────────────────────────────────────────────────────────
function queryAll(sql) {
  return db.prepare(sql).all();
}

function makeSheet(rows) {
  if (!rows.length) return XLSX.utils.aoa_to_sheet([['(empty)']]);
  return XLSX.utils.json_to_sheet(rows);
}

function autoWidth(ws, rows) {
  if (!rows.length) return;
  const keys = Object.keys(rows[0]);
  ws['!cols'] = keys.map(k => {
    let max = k.length;
    for (const r of rows) {
      const v = r[k];
      if (v != null) {
        const len = String(v).length;
        if (len > max) max = len;
      }
    }
    return { wch: Math.min(max + 2, 60) };
  });
}

// ── 1. Portfolios ──────────────────────────────────────────────────────────
const portfolios = queryAll('SELECT id, name, pan_number, color, created_at FROM portfolios ORDER BY id');
console.log(`Portfolios: ${portfolios.length}`);

// ── 2. Investments ─────────────────────────────────────────────────────────
const investments = queryAll(`
  SELECT id, name, display_name, asset_type, category,
         ticker_symbol, amfi_code, isin_code, previous_isin_codes,
         account_number, interest_rate, currency,
         face_value, coupon_frequency, maturity_date,
         notes, created_at, updated_at
  FROM investments ORDER BY id
`);
console.log(`Investments: ${investments.length}`);

// ── 3. Transactions (with portfolio name + investment name for readability)
const transactions = queryAll(`
  SELECT t.id, t.investment_id, i.name AS investment_name,
         t.portfolio_id, p.name AS portfolio_name,
         t.transaction_type, t.transaction_date,
         t.units, t.price_per_unit, t.amount, t.fees,
         t.folio_number, t.broker, t.locked, t.notes, t.created_at
  FROM transactions t
  JOIN investments i ON i.id = t.investment_id
  JOIN portfolios p ON p.id = t.portfolio_id
  ORDER BY t.portfolio_id, t.investment_id, t.transaction_date, t.id
`);
console.log(`Transactions: ${transactions.length}`);

// ── 4. Expenses ────────────────────────────────────────────────────────────
const expenses = queryAll(`
  SELECT e.id, e.portfolio_id, p.name AS portfolio_name,
         e.expense_type, e.expense_date, e.amount, e.broker, e.notes, e.created_at
  FROM portfolio_expenses e
  JOIN portfolios p ON p.id = e.portfolio_id
  ORDER BY e.portfolio_id, e.expense_date, e.id
`);
console.log(`Expenses: ${expenses.length}`);

// ── 5. Interest rates ──────────────────────────────────────────────────────
const rates = queryAll('SELECT id, rate_type, rate, effective_from, effective_to, created_at FROM interest_rates ORDER BY id');
console.log(`Interest rates: ${rates.length}`);

// ── 6. Config ──────────────────────────────────────────────────────────────
const config = queryAll('SELECT key, value, updated_at FROM config ORDER BY key');
console.log(`Config entries: ${config.length}`);

db.close();

// ── Build workbook ─────────────────────────────────────────────────────────
const wb = XLSX.utils.book_new();

const sheets = [
  ['Portfolios', portfolios],
  ['Investments', investments],
  ['Transactions', transactions],
  ['Expenses', expenses],
  ['Interest_Rates', rates],
  ['Config', config],
];

for (const [name, data] of sheets) {
  const ws = makeSheet(data);
  if (data.length) autoWidth(ws, data);
  XLSX.utils.book_append_sheet(wb, ws, name);
}

// Ensure output directory exists
const outDir = path.dirname(OUTPUT);
if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

XLSX.writeFile(wb, OUTPUT);
console.log(`\nExported to: ${OUTPUT}`);
console.log('Sheets: ' + sheets.map(s => s[0]).join(', '));
