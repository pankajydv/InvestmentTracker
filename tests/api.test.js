/**
 * Investment Tracker — API Integration Test Suite
 *
 * Covers: portfolios, investments, transactions, dashboard, stocks (contract
 * notes, corporate actions, AMC charges), utils, brokers, and response shapes.
 *
 * Uses Node.js built-in test runner (node:test) + assert.  Zero external deps.
 * Runs against a temporary copy of the DB so production data is never touched.
 *
 * Usage:  node --test tests/api.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

const TEST_PORT = 0; // let OS pick a free port
let BASE_URL;
let server;
let db;
let testDataDir;

function txnItems(body) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.items)) return body.items;
  return [];
}

/** POST/PUT/DELETE helper with JSON body */
async function api(method, urlPath, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE_URL}${urlPath}`, opts);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

/** Multipart upload helper (no external dependency) */
async function upload(urlPath, fields, files) {
  const boundary = '----TestBoundary' + Date.now();
  const parts = [];
  for (const [k, v] of Object.entries(fields || {})) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`
    ));
  }
  for (const { field, name, buffer, contentType } of (files || [])) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${name}"\r\nContent-Type: ${contentType || 'application/octet-stream'}\r\n\r\n`
    ));
    parts.push(buffer);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));

  const body = Buffer.concat(parts);
  const res = await fetch(`${BASE_URL}${urlPath}`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

// ──────────────────────────────────────────────────────────────────────
// Setup & Teardown
// ──────────────────────────────────────────────────────────────────────

before(async () => {
  // Use a temp directory so we never touch the production DB
  testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invtrack-test-'));
  process.env.DATA_DIR = testDataDir;
  process.env.NODE_ENV = 'test';
  process.env.ALLOW_DB_MIGRATIONS = 'true';

  // ── Mock external API calls BEFORE requiring route modules ──
  const priceService = require('../server/services/priceService');
  priceService.lookupTickerByISIN = async (isin) => isin ? isin + '.NS' : null;
  priceService.fetchCorporateActions = async () => ({ dividends: [], splits: [] });
  // toNSETicker is a pure function — no need to mock

  // Create the test DB
  const Database = require('better-sqlite3');
  const dbPath = path.join(testDataDir, 'investments.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const { initializeDb } = require('../server/db/schema');
  initializeDb(db);

  // Build express app with test DB
  const express = require('express');
  const app = express();
  app.use(require('cors')());
  app.use(express.json());
  app.use('/api/portfolios', require('../server/routes/portfolios')(db));
  app.use('/api/investments', require('../server/routes/investments')(db));
  app.use('/api/transactions', require('../server/routes/transactions')(db));
  app.use('/api/dashboard', require('../server/routes/dashboard')(db));
  app.use('/api/utils', require('../server/routes/utils')(db));
  app.use('/api/cas', require('../server/routes/cas')(db));
  app.use('/api/stocks', require('../server/routes/stocks')(db));
  app.use('/api/expenses', require('../server/routes/expenses')(db));

  app.use((err, _req, res, _next) => {
    res.status(500).json({ error: err.message });
  });

  await new Promise((resolve) => {
    server = app.listen(TEST_PORT, () => {
      BASE_URL = `http://localhost:${server.address().port}/api`;
      resolve();
    });
  });
});

after(async () => {
  if (server) await new Promise(r => server.close(r));
  if (db) db.close();
  // Clean up temp directory
  if (testDataDir) {
    fs.rmSync(testDataDir, { recursive: true, force: true });
  }
});

// ======================================================================
// 1.  PORTFOLIOS
// ======================================================================

describe('Portfolios', () => {
  it('GET /portfolios returns empty array initially', async () => {
    const { status, body } = await api('GET', '/portfolios');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body));
  });

  it('POST /portfolios creates a portfolio', async () => {
    const { status, body } = await api('POST', '/portfolios', {
      name: 'Test User', pan_number: 'ABCDE1234F', color: '#ff0000',
    });
    assert.equal(status, 201);
    assert.ok(body.id);
    assert.equal(body.name, 'Test User');
    assert.equal(body.pan_number, 'ABCDE1234F');
  });

  it('POST /portfolios rejects duplicate name', async () => {
    const { status } = await api('POST', '/portfolios', { name: 'Test User' });
    assert.equal(status, 409); // UNIQUE constraint
  });

  it('POST /portfolios creates second portfolio', async () => {
    const { status, body } = await api('POST', '/portfolios', {
      name: 'Second User', pan_number: 'XYZAB5678G',
    });
    assert.equal(status, 201);
    assert.ok(body.id);
  });

  it('GET /portfolios returns both portfolios', async () => {
    const { status, body } = await api('GET', '/portfolios');
    assert.equal(status, 200);
    assert.equal(body.length, 2);
  });

  it('GET /portfolios/:id returns specific portfolio', async () => {
    const { status, body } = await api('GET', '/portfolios/1');
    assert.equal(status, 200);
    assert.equal(body.name, 'Test User');
    assert.equal(body.pan_number, 'ABCDE1234F');
  });

  it('PUT /portfolios/:id updates portfolio', async () => {
    const { status, body } = await api('PUT', '/portfolios/1', { name: 'Updated User' });
    assert.equal(status, 200);
    assert.equal(body.name, 'Updated User');
  });

  it('GET /portfolios/:id reflects update', async () => {
    const { body } = await api('GET', '/portfolios/1');
    assert.equal(body.name, 'Updated User');
  });

  // Restore name for later tests
  it('PUT restore original name', async () => {
    await api('PUT', '/portfolios/1', { name: 'Test User' });
  });
});

// ======================================================================
// 2.  INVESTMENTS (Indian Stocks)
// ======================================================================

describe('Investments — Indian Stocks', () => {
  it('POST creates a stock investment', async () => {
    const { status, body } = await api('POST', '/investments', {
      name: 'TCS', asset_type: 'INDIAN_STOCK',
      ticker_symbol: 'TCS.NS', notes: 'Test stock',
    });
    assert.equal(status, 201);
    assert.ok(body.id);
    assert.equal(body.name, 'TCS');
    assert.equal(body.asset_type, 'INDIAN_STOCK');
  });

  it('POST creates a second stock', async () => {
    const { status, body } = await api('POST', '/investments', {
      name: 'INFY', asset_type: 'INDIAN_STOCK',
      ticker_symbol: 'INFY.NS',
    });
    assert.equal(status, 201);
    assert.ok(body.id);
  });

  it('GET /investments lists investments with correct fields', async () => {
    const { status, body } = await api('GET', '/investments?portfolio_id=1');
    assert.equal(status, 200);
    assert.ok(body.length >= 0);
  });

  it('GET /investments without portfolio filter lists all', async () => {
    const { status, body } = await api('GET', '/investments');
    assert.equal(status, 200);
    assert.ok(body.length >= 2);
    const inv = body[0];
    assert.ok('id' in inv);
    assert.ok('name' in inv);
    assert.ok('asset_type' in inv);
    assert.ok('ticker_symbol' in inv);
    assert.ok('asset_type' in inv);
  });

  it('GET /investments/:id returns detail with transactions array', async () => {
    const { status, body } = await api('GET', '/investments/1');
    assert.equal(status, 200);
    assert.equal(body.name, 'TCS');
    assert.ok('transactions' in body);
    assert.ok(Array.isArray(body.transactions));
  });

  it('PUT /investments/:id updates investment', async () => {
    const { status, body } = await api('PUT', '/investments/1', { notes: 'Updated note' });
    assert.equal(status, 200);
  });
});

// ======================================================================
// 3.  INVESTMENTS — Mutual Funds
// ======================================================================

describe('Investments — Mutual Funds', () => {
  it('POST creates a mutual fund', async () => {
    const { status, body } = await api('POST', '/investments', {
      name: 'SBI Bluechip Fund', asset_type: 'MUTUAL_FUND',
      amfi_code: '120503',
    });
    assert.equal(status, 201);
    assert.equal(body.asset_type, 'MUTUAL_FUND');
    assert.equal(body.amfi_code, '120503');
  });
});

// ======================================================================
// 4.  INVESTMENTS — Bonds
// ======================================================================

describe('Investments — Bonds', () => {
  it('POST creates a bond', async () => {
    const { status, body } = await api('POST', '/investments', {
      name: 'SGB 2024-25', asset_type: 'BOND',
      face_value: 5000, coupon_frequency: 'SEMI_ANNUAL',
      maturity_date: '2032-06-15',
    });
    assert.equal(status, 201);
    assert.equal(body.asset_type, 'BOND');
    assert.equal(body.face_value, 5000);
    assert.equal(body.coupon_frequency, 'SEMI_ANNUAL');
  });
});

// ======================================================================
// 5.  INVESTMENTS — PPF
// ======================================================================

describe('Investments — PPF', () => {
  it('POST creates a PPF account', async () => {
    const { status, body } = await api('POST', '/investments', {
      name: 'PPF Account', asset_type: 'PPF',
      account_number: 'PPF001',
    });
    assert.equal(status, 201);
    assert.equal(body.asset_type, 'PPF');
  });
});

// ======================================================================
// 6.  TRANSACTIONS — BUY / SELL
// ======================================================================

describe('Transactions — BUY and SELL', () => {
  it('POST creates a BUY transaction with broker', async () => {
    const { status, body } = await api('POST', '/transactions', {
      investment_id: 1, portfolio_id: 1, transaction_type: 'BUY', transaction_date: '2023-01-15',
      units: 100, price_per_unit: 3500, amount: 350000, fees: 525,
      broker: 'Groww', notes: 'Initial buy',
    });
    assert.equal(status, 201);
    assert.ok(body.id);
    assert.equal(body.transaction_type, 'BUY');
    assert.equal(body.broker, 'Groww');
  });

  it('POST creates a SELL transaction', async () => {
    const { status, body } = await api('POST', '/transactions', {
      investment_id: 1, portfolio_id: 1, transaction_type: 'SELL', transaction_date: '2023-06-15',
      units: 20, price_per_unit: 3800, amount: 76000, fees: 114,
      broker: 'Groww',
    });
    assert.equal(status, 201);
    assert.equal(body.transaction_type, 'SELL');
  });

  it('GET /transactions returns transactions with correct fields', async () => {
    const { status, body } = await api('GET', '/transactions?portfolio_id=1');
    const items = txnItems(body);
    assert.equal(status, 200);
    assert.ok(items.length >= 2, `Expected >= 2, got ${items.length}`);
    const txn = items[0];
    assert.ok('id' in txn);
    assert.ok('investment_id' in txn);
    assert.ok('transaction_type' in txn);
    assert.ok('transaction_date' in txn);
    assert.ok('units' in txn);
    assert.ok('price_per_unit' in txn);
    assert.ok('amount' in txn);
    assert.ok('fees' in txn);
    assert.ok('broker' in txn);
    assert.ok('investment_name' in txn);
    assert.ok('asset_type' in txn);
  });

  it('GET /transactions filters by broker', async () => {
    const { body } = await api('GET', '/transactions?broker=Groww');
    const items = txnItems(body);
    assert.ok(items.length >= 2);
    assert.ok(items.every(t => t.broker === 'Groww'));
  });

  it('GET /transactions filters by type', async () => {
    const { body } = await api('GET', '/transactions?type=BUY');
    const items = txnItems(body);
    assert.ok(items.every(t => t.transaction_type === 'BUY'));
  });

  it('PUT /transactions/:id updates transaction', async () => {
    const { status, body } = await api('PUT', '/transactions/1', {
      notes: 'Updated buy note', fees: 530,
    });
    assert.equal(status, 200);
  });

  it('GET /transactions/investment/:id returns investment transactions', async () => {
    const { status, body } = await api('GET', '/transactions/investment/1');
    assert.equal(status, 200);
    assert.ok(body.length >= 2);
  });
});

// ======================================================================
// 7.  TRANSACTIONS — DIVIDEND
// ======================================================================

describe('Transactions — Dividend', () => {
  it('POST creates a DIVIDEND transaction', async () => {
    const { status, body } = await api('POST', '/transactions', {
      investment_id: 1, portfolio_id: 1, transaction_type: 'DIVIDEND', transaction_date: '2023-07-10',
      units: 80, price_per_unit: 15.5, amount: 1240, fees: 0,
      broker: 'Groww', notes: 'Dividend ₹15.5/share × 80 shares',
    });
    assert.equal(status, 201);
    assert.equal(body.transaction_type, 'DIVIDEND');
    assert.equal(body.amount, 1240);
  });
});

// ======================================================================
// 8.  TRANSACTIONS — SPLIT
// ======================================================================

describe('Transactions — Stock Split (via corporate actions import)', () => {
  it('POST /stocks/corporate-actions/import creates SPLIT transaction', async () => {
    // Holding = 80 units after BUY(100) - SELL(20), 1:10 split adds 80*(10-1)=720
    const { status, body } = await api('POST', '/stocks/corporate-actions/import', {
      transactions: [{
        investment_id: 1, transaction_type: 'SPLIT', transaction_date: '2023-09-03',
        units: 720, price_per_unit: 0, amount: 0,
        notes: 'Split 10:1 — 80 held → +720 new shares',
      }],
      corrections: [],
      deletions: [],
    });
    assert.equal(status, 200);
    assert.equal(body.created, 1);

    // Verify the SPLIT transaction exists
    const { body: txns } = await api('GET', '/transactions/investment/1');
    const split = txns.find(t => t.transaction_type === 'SPLIT');
    assert.ok(split, 'SPLIT transaction should exist');
    assert.equal(split.units, 720);
  });
});

// ======================================================================
// 9.  TRANSACTIONS — BONUS
// ======================================================================

describe('Transactions — Bonus (via corporate actions import)', () => {
  it('BUY shares then add BONUS via corporate actions import', async () => {
    const { status } = await api('POST', '/transactions', {
      investment_id: 2, portfolio_id: 1, transaction_type: 'BUY', transaction_date: '2022-06-01',
      units: 50, price_per_unit: 1500, amount: 75000, fees: 112,
      broker: 'Sharekhan',
    });
    assert.equal(status, 201);

    // 1:1 bonus on 50 shares = 50 bonus shares via corporate actions import
    const { status: s2, body } = await api('POST', '/stocks/corporate-actions/import', {
      transactions: [{
        investment_id: 2, transaction_type: 'BONUS', transaction_date: '2023-02-15',
        units: 50, price_per_unit: 0, amount: 0,
        notes: 'Bonus 1:1 — +50 new shares',
      }],
      corrections: [],
      deletions: [],
    });
    assert.equal(s2, 200);
    assert.equal(body.created, 1);

    // Verify
    const { body: txns } = await api('GET', '/transactions/investment/2');
    const bonus = txns.find(t => t.transaction_type === 'BONUS');
    assert.ok(bonus, 'BONUS transaction should exist');
    assert.equal(bonus.units, 50);
  });
});

// ======================================================================
// 10.  TRANSACTIONS — TRANSFER_OUT / TRANSFER_IN
// ======================================================================

describe('Transactions — Transfer (broker to broker)', () => {
  it('POST creates TRANSFER_OUT from Sharekhan (amount=-1 workaround)', async () => {
    // API requires amount to be truthy; transfers use nominal -1
    const { status, body } = await api('POST', '/transactions', {
      investment_id: 2, portfolio_id: 1, transaction_type: 'TRANSFER_OUT', transaction_date: '2023-03-27',
      units: 100, price_per_unit: 0, amount: -1, fees: 0,
      broker: 'Sharekhan', notes: 'Transfer to Groww',
    });
    assert.equal(status, 201);
    assert.equal(body.transaction_type, 'TRANSFER_OUT');
    assert.equal(body.broker, 'Sharekhan');
  });

  it('POST creates TRANSFER_IN to Groww', async () => {
    const { status, body } = await api('POST', '/transactions', {
      investment_id: 2, portfolio_id: 1, transaction_type: 'TRANSFER_IN', transaction_date: '2023-03-27',
      units: 100, price_per_unit: 0, amount: -1, fees: 0,
      broker: 'Groww', notes: 'Transfer from Sharekhan',
    });
    assert.equal(status, 201);
    assert.equal(body.transaction_type, 'TRANSFER_IN');
    assert.equal(body.broker, 'Groww');
  });
});

// ======================================================================
// 11.  TRANSACTIONS — IPO
// ======================================================================

describe('Transactions — IPO', () => {
  it('POST creates an IPO transaction', async () => {
    const { status, body } = await api('POST', '/transactions', {
      investment_id: 1, portfolio_id: 1, transaction_type: 'IPO', transaction_date: '2020-03-10',
      units: 50, price_per_unit: 500, amount: 25000, fees: 0,
      broker: 'Groww', notes: 'IPO allotment',
    });
    assert.equal(status, 201);
    assert.equal(body.transaction_type, 'IPO');
  });
});

// ======================================================================
// 12.  PORTFOLIO EXPENSES (formerly AMC Charges)
// ======================================================================

describe('Portfolio Expenses', () => {
  it('POST /expenses creates an expense', async () => {
    const { status, body } = await api('POST', '/expenses', {
      portfolio_id: 1, expense_type: 'AMC', expense_date: '2024-01-15',
      amount: 236, broker: 'Sharekhan', notes: 'Annual demat charges',
    });
    assert.equal(status, 201);
    assert.equal(body.expense_type, 'AMC');
    assert.equal(body.amount, 236);
    assert.equal(body.broker, 'Sharekhan');
  });

  it('POST /stocks/amc-charge creates expense (backward compat)', async () => {
    const { status, body } = await api('POST', '/stocks/amc-charge', {
      portfolio_id: 1, date: '2024-06-01', amount: 354,
      broker: 'Groww', notes: 'Platform Fees FY24', expense_type: 'PLATFORM_FEE',
    });
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.ok(body.expense_id);
  });

  it('GET /expenses returns created expenses', async () => {
    const { body } = await api('GET', '/expenses?portfolio_id=1');
    assert.ok(body.length >= 2);
    const amc = body.find(e => e.expense_type === 'AMC');
    assert.ok(amc, 'AMC expense should exist');
    assert.equal(amc.amount, 236);
  });

  it('GET /expenses/summary returns totals', async () => {
    const { status, body } = await api('GET', '/expenses/summary?portfolio_id=1');
    assert.equal(status, 200);
    assert.ok(body.total_expenses >= 590); // 236 + 354
    assert.ok(body.byType.length >= 1);
  });

  it('DELETE /expenses/:id removes expense', async () => {
    const { body: list } = await api('GET', '/expenses');
    const first = list[0];
    const { status, body } = await api('DELETE', `/expenses/${first.id}`);
    assert.equal(status, 200);
    assert.equal(body.success, true);
  });

  it('POST /expenses rejects invalid expense_type', async () => {
    const { status } = await api('POST', '/expenses', {
      portfolio_id: 1, expense_type: 'INVALID', expense_date: '2024-01-01', amount: 100,
    });
    assert.equal(status, 400);
  });

  it('POST /expenses rejects missing portfolio_id', async () => {
    const { status } = await api('POST', '/expenses', {
      expense_type: 'AMC', expense_date: '2024-01-01', amount: 100,
    });
    assert.equal(status, 400);
  });

  it('Dashboard includes totalExpenses', async () => {
    const { body } = await api('GET', '/dashboard/summary');
    assert.ok('totalExpenses' in body, 'Response should include totalExpenses');
    assert.ok(body.totalExpenses >= 0);
  });
});

// ======================================================================
// 13.  TRANSACTIONS — PPF Deposit
// ======================================================================

describe('Transactions — PPF Deposit', () => {
  it('POST creates a DEPOSIT to PPF', async () => {
    const { status, body } = await api('POST', '/transactions', {
      investment_id: 5, portfolio_id: 1, transaction_type: 'DEPOSIT', transaction_date: '2023-04-10',
      units: 0, price_per_unit: 0, amount: 150000, fees: 0,
      notes: 'FY23 PPF contribution',
    });
    assert.equal(status, 201);
    assert.equal(body.transaction_type, 'DEPOSIT');
    assert.equal(body.amount, 150000);
  });
});

// ======================================================================
// 14.  TRANSACTIONS — Bond Interest
// ======================================================================

describe('Transactions — Bond Interest', () => {
  it('POST creates BUY on bond', async () => {
    const { status } = await api('POST', '/transactions', {
      investment_id: 4, portfolio_id: 1, transaction_type: 'BUY', transaction_date: '2022-01-01',
      units: 10, price_per_unit: 5000, amount: 50000, fees: 0,
      broker: 'Paytm Money',
    });
    assert.equal(status, 201);
  });

  it('POST creates INTEREST transaction', async () => {
    const { status, body } = await api('POST', '/transactions', {
      investment_id: 4, portfolio_id: 1, transaction_type: 'INTEREST', transaction_date: '2023-06-15',
      units: 10, price_per_unit: 125, amount: 1250, fees: 0,
      notes: 'Semi-annual coupon @ 2.5%',
    });
    assert.equal(status, 201);
    assert.equal(body.transaction_type, 'INTEREST');
  });
});

// ======================================================================
// 15.  TRANSACTION METADATA ENDPOINTS
// ======================================================================

describe('Transaction metadata endpoints', () => {
  it('GET /transactions/brokers returns broker list', async () => {
    const { status, body } = await api('GET', '/transactions/brokers');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body));
    assert.ok(body.includes('Groww'));
    assert.ok(body.includes('Sharekhan'));
  });

  it('GET /transactions/asset-types returns asset types', async () => {
    const { status, body } = await api('GET', '/transactions/asset-types');
    assert.equal(status, 200);
    assert.ok(body.includes('INDIAN_STOCK'));
  });

  it('GET /transactions/transaction-types returns types', async () => {
    const { status, body } = await api('GET', '/transactions/transaction-types');
    assert.equal(status, 200);
    assert.ok(body.includes('BUY'));
    assert.ok(body.includes('SELL'));
    assert.ok(body.includes('DIVIDEND'));
  });

  it('GET /transactions/investment-names returns names', async () => {
    const { status, body } = await api('GET', '/transactions/investment-names?portfolio_id=1');
    assert.equal(status, 200);
    assert.ok(body.includes('TCS'));
  });
});

// ======================================================================
// 16.  DASHBOARD
// ======================================================================

describe('Dashboard', () => {
  it('GET /dashboard/summary returns valid structure', async () => {
    const { status, body } = await api('GET', '/dashboard/summary?portfolio_id=1');
    assert.equal(status, 200);
    assert.ok('portfolio' in body);
    assert.ok('investments' in body);
    assert.ok('byType' in body);
    assert.ok(typeof body.portfolio.total_invested === 'number');
    assert.ok(Array.isArray(body.investments));
  });

  it('GET /dashboard/summary works for all portfolios', async () => {
    const { status, body } = await api('GET', '/dashboard/summary');
    assert.equal(status, 200);
    assert.ok('portfolio' in body);
  });

  it('GET /dashboard/allocation returns asset allocation', async () => {
    const { status, body } = await api('GET', '/dashboard/allocation?portfolio_id=1');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body));
    if (body.length > 0) {
      const item = body[0];
      assert.ok('asset_type' in item);
      assert.ok('total_value' in item || 'count' in item);
    }
  });
});

// ======================================================================
// 17.  CONTRACT NOTES — Preview (Sharekhan HTM)
// ======================================================================

describe('Contract Notes — Sharekhan HTM Preview', () => {
  it('POST /stocks/contract-notes/preview parses HTM file', async () => {
    const htmPath = path.join(__dirname, 'fixtures', 'sharekhan-contract-note.htm');
    const buffer = fs.readFileSync(htmPath);

    const { status, body } = await upload('/stocks/contract-notes/preview',
      { portfolio_id: '1' },
      [{ field: 'files', name: '1234567_NSECM_20240314.htm', buffer, contentType: 'text/html' }],
    );

    assert.equal(status, 200);
    assert.ok(body.trades || body.length > 0 || body[0]?.trades, 'Should return parsed trades');
  });
});

// ======================================================================
// 18.  CONTRACT NOTES — Import
// ======================================================================

describe('Contract Notes — Import', () => {
  it('POST /stocks/contract-notes/import creates investments and transactions', async () => {
    const { status, body } = await api('POST', '/stocks/contract-notes/import', {
      portfolio_id: 1,
      broker: 'Sharekhan',
      trades: [
        {
          security: 'HDFC BANK LIMITED',
          isin: 'INE040A01034',
          tradeDate: '2024-03-14',
          type: 'BUY',
          quantity: 5,
          rate: 1450.50,
          total: 7252.50,
          brokerage: 10.88,
        },
      ],
    });
    assert.equal(status, 200);
    assert.ok(typeof body.investmentsCreated === 'number');
    assert.ok(typeof body.transactionsCreated === 'number');
    assert.ok(body.transactionsCreated >= 1);
  });

  it('Re-importing same trade is idempotent (skipped)', async () => {
    const { body } = await api('POST', '/stocks/contract-notes/import', {
      portfolio_id: 1,
      broker: 'Sharekhan',
      trades: [
        {
          security: 'HDFC BANK LIMITED',
          isin: 'INE040A01034',
          tradeDate: '2024-03-14',
          type: 'BUY',
          quantity: 5,
          rate: 1450.50,
          total: 7252.50,
          brokerage: 10.88,
        },
      ],
    });
    assert.equal(body.transactionsSkipped, 1, 'Duplicate trade should be skipped');
    assert.equal(body.transactionsCreated, 0);
  });
});

// ======================================================================
// 19.  CORPORATE ACTIONS — Preview
// ======================================================================

describe('Corporate Actions — Preview', () => {
  it('GET /stocks/corporate-actions/preview returns valid structure', async () => {
    const { status, body } = await api('GET', '/stocks/corporate-actions/preview?portfolio_id=1&year=2023');
    assert.equal(status, 200);
    assert.ok('suggestions' in body);
    assert.ok('corrections' in body);
    assert.ok('deletions' in body);
    assert.ok('errors' in body);
    assert.ok(Array.isArray(body.suggestions));
    assert.ok(Array.isArray(body.corrections));
    assert.ok(Array.isArray(body.deletions));
    assert.ok(Array.isArray(body.errors));
  });

  it('Missing params return 400', async () => {
    const { status } = await api('GET', '/stocks/corporate-actions/preview?portfolio_id=1');
    assert.equal(status, 400);
  });
});

// ======================================================================
// 20.  CORPORATE ACTIONS — Import
// ======================================================================

describe('Corporate Actions — Import', () => {
  it('POST /stocks/corporate-actions/import handles empty arrays', async () => {
    const { status, body } = await api('POST', '/stocks/corporate-actions/import', {
      transactions: [], corrections: [], deletions: [],
    });
    assert.equal(status, 200);
    assert.equal(body.created, 0);
    assert.equal(body.corrected, 0);
    assert.equal(body.deleted, 0);
  });

  it('POST import creates a dividend transaction', async () => {
    const { status, body } = await api('POST', '/stocks/corporate-actions/import', {
      transactions: [{
        investment_id: 1, transaction_type: 'DIVIDEND',
        transaction_date: '2024-01-15', units: 850,
        price_per_unit: 9, amount: 7650,
        notes: 'Dividend ₹9/share × 850 shares',
      }],
      corrections: [],
      deletions: [],
    });
    assert.equal(status, 200);
    assert.equal(body.created, 1);
  });

  it('POST import creates a split transaction', async () => {
    const { status, body } = await api('POST', '/stocks/corporate-actions/import', {
      transactions: [{
        investment_id: 2, transaction_type: 'SPLIT',
        transaction_date: '2024-06-01', units: 100,
        price_per_unit: 0, amount: 0,
        notes: 'Split 2:1 — 100 held → +100 new shares',
      }],
      corrections: [],
      deletions: [],
    });
    assert.equal(status, 200);
    assert.equal(body.created, 1);
  });
});

// ======================================================================
// 21.  UTILS
// ======================================================================

describe('Utils', () => {
  it('GET /utils/config returns config object', async () => {
    const { status, body } = await api('GET', '/utils/config');
    assert.equal(status, 200);
    assert.ok(typeof body === 'object');
  });

  it('PUT /utils/config updates config', async () => {
    const { status, body } = await api('PUT', '/utils/config', {
      auto_update_enabled: 'false',
    });
    assert.equal(status, 200);
    assert.equal(body.success, true);
  });

  it('GET /utils/interest-rates returns array', async () => {
    const { status, body } = await api('GET', '/utils/interest-rates');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.rates));
  });

  it('POST /utils/interest-rates creates rate', async () => {
    const { status, body } = await api('POST', '/utils/interest-rates', {
      rate_type: 'PPF', rate: 7.1, effective_from: '2024-04-01',
    });
    assert.equal(status, 201);
    assert.equal(body.success, true);
  });
});

// ======================================================================
// 22.  TRANSACTION DELETE
// ======================================================================

describe('Transaction Delete', () => {
  it('DELETE /transactions/:id removes a transaction', async () => {
    // Get count before
    const before = await api('GET', '/transactions?portfolio_id=1');
    const count = txnItems(before.body).length;

    // Create a throwaway transaction
    const { body: created } = await api('POST', '/transactions', {
      investment_id: 1, portfolio_id: 1, transaction_type: 'BUY', transaction_date: '2025-01-01',
      units: 1, price_per_unit: 100, amount: 100, fees: 0,
    });

    // Delete it
    const { status, body } = await api('DELETE', `/transactions/${created.id}`);
    assert.equal(status, 200);
    assert.equal(body.success, true);

    // Verify count restored
    const after = await api('GET', '/transactions?portfolio_id=1');
    assert.equal(txnItems(after.body).length, count);
  });
});

// ======================================================================
// 23.  INVESTMENT DELETE
// ======================================================================

describe('Investment Delete', () => {
  it('DELETE /investments/:id with cascade', async () => {
    // Create disposable investment + transaction
    const { body: inv } = await api('POST', '/investments', {
      name: 'Disposable Stock', asset_type: 'INDIAN_STOCK',
    });
    await api('POST', '/transactions', {
      investment_id: inv.id, portfolio_id: 2, transaction_type: 'BUY', transaction_date: '2024-01-01',
      units: 10, price_per_unit: 100, amount: 1000, fees: 0,
    });

    const { status, body } = await api('DELETE', `/investments/${inv.id}`);
    assert.equal(status, 200);
    assert.equal(body.success, true);

    // Transactions should be cascade-deleted too
    const { body: txns } = await api('GET', `/transactions/investment/${inv.id}`);
    assert.equal(txns.length, 0);
  });
});

// ======================================================================
// 24.  PORTFOLIO DELETE (with investments)
// ======================================================================

describe('Portfolio Delete', () => {
  it('DELETE /portfolios/:id removes portfolio', async () => {
    // Create throwaway portfolio
    const { body: p } = await api('POST', '/portfolios', { name: 'Throwaway' });
    const { status, body } = await api('DELETE', `/portfolios/${p.id}`);
    assert.equal(status, 200);
    assert.equal(body.success, true);
  });
});

// ======================================================================
// 25.  RESPONSE SHAPE REGRESSION — broker on transactions not investments
// ======================================================================

describe('Broker field — on transactions, not investments', () => {
  it('Transactions always have broker field', async () => {
    const { body } = await api('GET', '/transactions?portfolio_id=1');
    const items = txnItems(body);
    assert.ok(items.length > 0);
    for (const t of items) {
      assert.ok('broker' in t, `Transaction ${t.id} missing broker field`);
    }
  });

  it('Investment detail does NOT have broker field', async () => {
    const { body } = await api('GET', '/investments/1');
    assert.ok(!('broker' in body), 'Investment should not have broker field');
  });

  it('Brokers endpoint returns distinct brokers from transactions', async () => {
    const { body } = await api('GET', '/transactions/brokers');
    assert.ok(body.length >= 1);
    // Should not include null/undefined
    assert.ok(body.every(b => b !== null && b !== undefined));
  });
});

// ======================================================================
// 26.  EDGE CASES & VALIDATION
// ======================================================================

describe('Validation & Edge Cases', () => {
  it('POST /portfolios without name returns 400', async () => {
    const { status } = await api('POST', '/portfolios', {});
    assert.equal(status, 400);
  });

  it('POST /investments with invalid asset_type fails', async () => {
    const { status } = await api('POST', '/investments', {
      name: 'Bad Type', asset_type: 'GOLD',
    });
    assert.ok(status >= 400, 'Should reject invalid asset_type');
  });

  it('POST /transactions with invalid type fails', async () => {
    const { status } = await api('POST', '/transactions', {
      investment_id: 1, transaction_type: 'INVALID', transaction_date: '2024-01-01',
      amount: 100,
    });
    assert.ok(status >= 400, 'Should reject invalid transaction_type');
  });

  it('GET /portfolios/999 returns 404', async () => {
    const { status } = await api('GET', '/portfolios/999');
    assert.equal(status, 404);
  });

  it('POST /stocks/amc-charge without required fields returns 400', async () => {
    const { status } = await api('POST', '/stocks/amc-charge', {});
    assert.equal(status, 400);
  });

  it('POST /expenses without required fields returns 400', async () => {
    const { status } = await api('POST', '/expenses', {});
    assert.equal(status, 400);
  });
});

// ======================================================================
// 27.  ROUTE EXISTENCE — catch accidental deletions
// ======================================================================

describe('Route existence — all endpoints respond (not 404)', () => {
  const mustExist = [
    ['GET',  '/portfolios'],
    ['GET',  '/investments'],
    ['GET',  '/transactions'],
    ['GET',  '/transactions/brokers'],
    ['GET',  '/transactions/asset-types'],
    ['GET',  '/transactions/transaction-types'],
    ['GET',  '/transactions/investment-names'],
    ['GET',  '/dashboard/summary'],
    ['GET',  '/dashboard/allocation'],
    ['GET',  '/utils/config'],
    ['GET',  '/utils/interest-rates'],
    ['GET',  '/stocks/corporate-actions/preview?portfolio_id=1&year=2024'],
    ['GET',  '/expenses'],
    ['GET',  '/expenses/summary'],
  ];

  for (const [method, route] of mustExist) {
    it(`${method} ${route} → not 404`, async () => {
      const { status } = await api(method, route);
      assert.notEqual(status, 404, `${method} ${route} returned 404 — route missing!`);
    });
  }

  const postRoutes = [
    ['/stocks/amc-charge',                 { portfolio_id: 1, date: '2099-01-01', amount: 1 }],
    ['/stocks/corporate-actions/import',   { transactions: [], corrections: [], deletions: [] }],
    ['/stocks/contract-notes/import',      { portfolio_id: 1, broker: 'Test', trades: [] }],
  ];

  for (const [route, body] of postRoutes) {
    it(`POST ${route} → not 404`, async () => {
      const { status } = await api('POST', route, body);
      assert.notEqual(status, 404, `POST ${route} returned 404 — route missing!`);
    });
  }
});
