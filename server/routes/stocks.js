const express = require('express');
const multer = require('multer');
const { PDFParse } = require('pdf-parse');
const { lookupTickerByISIN, fetchCorporateActions, toNSETicker, fetchHistoricalStockPrice, fetchHistoricalOHLC, fetchHistoricalUSDToINR } = require('../services/priceService');
const { parseContractNotes } = require('../services/contractNoteParser');
const { parsePnLStatement } = require('../services/pnlParser');
const { GRANTS, generateRsuSchedule } = require('../services/rsuGrantService');
const { OFFERINGS, generateEsppSchedule } = require('../services/esppGrantService');
const { parseOpenLots, parseClosedLots, reconcileVestTransactions } = require('../services/fidelityVestReconciler');
const { normalizeRows, annotatePreviewRows } = require('../services/esppAcquisitionImportService');
const { markDirtyFromTransactions } = require('../services/dirtyBackfillService');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const CORPORATE_ACTION_UNIT_ADD_TYPES = ['BUY', 'IPO', 'BONUS', 'SPLIT', 'RIGHTS', 'TRANSFER_IN', 'SWITCH_IN', 'DEPOSIT', 'VEST', 'ESPP_PURCHASE'];
const CORPORATE_ACTION_UNIT_SUB_TYPES = ['SELL', 'TRANSFER_OUT', 'SWITCH_OUT', 'WITHDRAWAL', 'CONSOLIDATION'];

const MONTH_INDEX = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
};

function toMonthEndIso(monthName, yearValue) {
  const monthIdx = MONTH_INDEX[String(monthName || '').toLowerCase()];
  const year = Number(yearValue);
  if (!Number.isInteger(monthIdx) || !Number.isInteger(year)) return null;
  const d = new Date(Date.UTC(year, monthIdx + 1, 0));
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function toIsoDateUTC(year, monthIndex, day) {
  const y = Number(year);
  const m = Number(monthIndex);
  const d = Number(day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  const dt = new Date(Date.UTC(y, m, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m || dt.getUTCDate() !== d) return null;
  const yyyy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function parseDateTokenToIso(value) {
  const input = String(value || '').trim().replace(/,/g, '');
  if (!input) return null;

  let match = input.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/);
  if (match) {
    const day = Number(match[1]);
    const month = Number(match[2]) - 1;
    let year = Number(match[3]);
    if (year < 100) year += 2000;
    return toIsoDateUTC(year, month, day);
  }

  match = input.match(/^(\d{1,2})[\/-]([A-Za-z]{3,9})[\/-](\d{2,4})$/);
  if (match) {
    const day = Number(match[1]);
    const month = MONTH_INDEX[String(match[2]).toLowerCase().slice(0, 3)
      .replace('jan', 'january')
      .replace('feb', 'february')
      .replace('mar', 'march')
      .replace('apr', 'april')
      .replace('jun', 'june')
      .replace('jul', 'july')
      .replace('aug', 'august')
      .replace('sep', 'september')
      .replace('oct', 'october')
      .replace('nov', 'november')
      .replace('dec', 'december')];
    let year = Number(match[3]);
    if (year < 100) year += 2000;
    if (!Number.isInteger(month)) return null;
    return toIsoDateUTC(year, month, day);
  }

  match = input.match(/^([A-Za-z]{3,9})\s+(\d{1,2})\s+(\d{2,4})$/);
  if (match) {
    const month = MONTH_INDEX[String(match[1]).toLowerCase().slice(0, 3)
      .replace('jan', 'january')
      .replace('feb', 'february')
      .replace('mar', 'march')
      .replace('apr', 'april')
      .replace('jun', 'june')
      .replace('jul', 'july')
      .replace('aug', 'august')
      .replace('sep', 'september')
      .replace('oct', 'october')
      .replace('nov', 'november')
      .replace('dec', 'december')];
    const day = Number(match[2]);
    let year = Number(match[3]);
    if (year < 100) year += 2000;
    if (!Number.isInteger(month)) return null;
    return toIsoDateUTC(year, month, day);
  }

  return null;
}

function toDefaultSalaryDateIso(monthName, yearValue) {
  const monthIdx = MONTH_INDEX[String(monthName || '').toLowerCase()];
  const year = Number(yearValue);
  if (!Number.isInteger(monthIdx) || !Number.isInteger(year)) return null;

  const salaryDate = new Date(Date.UTC(year, monthIdx, 28));
  while (salaryDate.getUTCDay() === 0 || salaryDate.getUTCDay() === 6) {
    salaryDate.setUTCDate(salaryDate.getUTCDate() - 1);
  }

  const yyyy = salaryDate.getUTCFullYear();
  const mm = String(salaryDate.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(salaryDate.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function extractSalaryPaymentDateIso(text, monthName, yearValue) {
  const lines = String(text || '').split(/\r?\n+/).map((s) => s.trim()).filter(Boolean);
  const payDateLine = lines.find((line) => /\bpay\s*date\b|\bsalary\s*(paid|credited)\b/i.test(line));

  if (payDateLine) {
    const tokenPatterns = [
      /(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/,
      /(\d{1,2}[\/-][A-Za-z]{3,9}[\/-]\d{2,4})/,
      /([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{2,4})/,
    ];

    for (const pattern of tokenPatterns) {
      const match = payDateLine.match(pattern);
      if (!match) continue;
      const parsed = parseDateTokenToIso(match[1]);
      if (parsed) return parsed;
    }
  }

  return toDefaultSalaryDateIso(monthName, yearValue);
}

function parseNumber(value) {
  if (value == null) return null;
  const clean = String(value).replace(/,/g, '').trim();
  if (!clean) return null;
  const num = Number(clean);
  return Number.isFinite(num) ? num : null;
}

function parseEsppContributionRowsFromPayslipText(pageText, sourceFileName, pageNo) {
  const text = String(pageText || '');
  const monthMatch = text.match(/Payslip\s+for\s+the\s+month\s+of\s+([A-Za-z]+)\s+(\d{4})/i);
  if (!monthMatch) return [];

  const monthName = monthMatch[1];
  const year = Number(monthMatch[2]);
  const monthIdx = MONTH_INDEX[String(monthName || '').toLowerCase()];
  if (!Number.isInteger(monthIdx) || !Number.isInteger(year)) return [];
  const contributionDate = extractSalaryPaymentDateIso(text, monthName, year);
  if (!contributionDate) return [];

  const monthKey = `${year}-${String(monthIdx + 1).padStart(2, '0')}`;
  const lines = text.split(/\r?\n+/).map((s) => s.trim()).filter(Boolean);
  const esppLine = lines.find((line) => /\bESPP\b/i.test(line) && !/TCS\s+on\s+ESPP/i.test(line));
  if (!esppLine) return [];

  const compactText = text.replace(/\s+/g, ' ');
  const deductionFirstLayout = /YTD\*\s+Earnings\s+Current\s+Month\s+Deductions\s+Current\s+Month\s+YTD\*/i.test(compactText);
  const esppParts = esppLine.split(/\bESPP\b/i);
  const afterEspp = esppParts.length > 1 ? esppParts.slice(1).join(' ') : '';
  const afterNumbers = (afterEspp.match(/-?\d[\d,]*(?:\.\d+)?/g) || [])
    .map(parseNumber)
    .filter((n) => Number.isFinite(n) && n >= 0);
  if (!afterNumbers.length) return [];

  // PDF extraction alternates between two layouts:
  // 1) Earnings-first pages: ESPP current month amount is the first numeric token after ESPP.
  // 2) Deductions-first pages: ESPP current month amount is the last numeric token after ESPP.
  const selectedAmount = deductionFirstLayout
    ? afterNumbers[afterNumbers.length - 1]
    : afterNumbers.find((n) => n > 0) ?? afterNumbers[afterNumbers.length - 1];
  const monthlyContribution = Number(selectedAmount);
  if (!(monthlyContribution > 0)) return [];

  return [{
    import_key: `ESPP_CONTRIB|${monthKey}`,
    month_key: monthKey,
    contribution_date: contributionDate,
    amount: Number(monthlyContribution.toFixed(2)),
    source_file: sourceFileName,
    source_page: pageNo,
    raw_line: esppLine,
  }];
}

async function extractEsppContributionsFromPayslipFiles(files) {
  const byMonthKey = new Map();

  for (const file of files || []) {
    const parser = new PDFParse({ data: file.buffer });
    const parsed = await parser.getText();
    await parser.destroy();
    const pages = Array.isArray(parsed.pages) ? parsed.pages : [];

    for (let i = 0; i < pages.length; i += 1) {
      const page = pages[i] || {};
      const rows = parseEsppContributionRowsFromPayslipText(page.text, file.originalname, page.page || (i + 1));
      for (const row of rows) {
        if (!byMonthKey.has(row.month_key)) {
          byMonthKey.set(row.month_key, row);
        }
      }
    }
  }

  return Array.from(byMonthKey.values()).sort((a, b) => a.month_key.localeCompare(b.month_key));
}

module.exports = function (db) {
  /**
   * POST /api/stocks/contract-notes/preview
   * Upload contract note files (ZIP/HTM) and return a preview of parsed trades.
   * Validates PAN against selected portfolio.
   * Body (multipart): files[], portfolio_id
   */
  router.post('/contract-notes/preview', upload.array('files', 20), async (req, res) => {
    try {
      if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded' });
      if (!req.body.portfolio_id) return res.status(400).json({ error: 'portfolio_id is required' });

      const portfolioId = parseInt(req.body.portfolio_id);
      const portfolio = db.prepare('SELECT * FROM portfolios WHERE id = ?').get(portfolioId);
      if (!portfolio) return res.status(404).json({ error: 'Portfolio not found' });

      // Parse all uploaded files
      const allParsed = [];
      for (const file of req.files) {
        const notes = await parseContractNotes(file.buffer, file.originalname, portfolio.pan_number);
        allParsed.push(...notes);
      }

      if (allParsed.length === 0) {
        return res.status(400).json({ error: 'No trades found in the uploaded files. Check the file format.' });
      }

      // Validate PAN - the contract note PAN must match the portfolio PAN
      const notePAN = allParsed[0].panNumber;
      if (notePAN && portfolio.pan_number && notePAN !== portfolio.pan_number.toUpperCase()) {
        return res.status(400).json({
          error: `Contract note belongs to PAN ${notePAN} but selected portfolio "${portfolio.name}" has PAN ${portfolio.pan_number}. Please select the correct portfolio.`
        });
      }

      // Derive broker from parsed notes
      const broker = allParsed[0].broker || 'Unknown';

      // Flatten all trades across all notes
      const trades = [];
      for (const note of allParsed) {
        for (const trade of note.trades) {
          trades.push({
            security: trade.security,
            isin: trade.isin || null,
            tradeDate: trade.tradeDate,
            type: trade.type,
            quantity: trade.quantity,
            rate: trade.rate,
            total: trade.total,
            brokerage: trade.brokerage || 0,
          });
        }
      }

      // Summary
      const buys = trades.filter(t => t.type === 'BUY');
      const sells = trades.filter(t => t.type === 'SELL');
      const totalCharges = allParsed.reduce((s, n) => s + (n.charges?.total || 0), 0);

      // Aggregate charges breakdown across all parsed notes
      const chargesBreakdown = {};
      for (const note of allParsed) {
        if (!note.charges) continue;
        for (const [key, val] of Object.entries(note.charges)) {
          chargesBreakdown[key] = (chargesBreakdown[key] || 0) + (val || 0);
        }
      }

      res.json({
        broker,
        panNumber: notePAN,
        clientCode: allParsed[0].clientCode,
        portfolioName: portfolio.name,
        trades,
        summary: {
          totalBuys: buys.length,
          totalBuyValue: buys.reduce((s, t) => s + t.total, 0),
          totalBuyShares: buys.reduce((s, t) => s + t.quantity, 0),
          totalSells: sells.length,
          totalSellValue: sells.reduce((s, t) => s + t.total, 0),
          totalSellShares: sells.reduce((s, t) => s + t.quantity, 0),
          totalBrokerage: totalCharges,
          chargesBreakdown,
        },
      });
    } catch (e) {
      console.error('Contract note preview error:', e);
      res.status(500).json({ error: 'Failed to parse contract notes: ' + e.message });
    }
  });

  /**
   * POST /api/stocks/contract-notes/import
   * Import approved trades from contract note preview.
   * Idempotent: matches existing transactions by (investment_id, date, type, units, price) and updates if different.
   * Body (JSON): { portfolio_id, broker, trades: [{ security, isin, tradeDate, type, quantity, rate, total, brokerage }] }
   */
  router.post('/contract-notes/import', express.json(), async (req, res) => {
    try {
      const { portfolio_id, broker, trades } = req.body;
      if (!portfolio_id || !trades?.length) {
        return res.status(400).json({ error: 'portfolio_id and trades are required' });
      }

      const portfolioId = parseInt(portfolio_id);
      const portfolio = db.prepare('SELECT * FROM portfolios WHERE id = ?').get(portfolioId);
      if (!portfolio) return res.status(404).json({ error: 'Portfolio not found' });

      const findInvestment = db.prepare(
        'SELECT id, name, ticker_symbol FROM investments WHERE asset_type = ? AND (ticker_symbol = ? OR name = ?)'
      );
      const findByIsin = db.prepare(
        'SELECT id, name, ticker_symbol FROM investments WHERE isin_code = ?'
      );
      const findByPreviousIsin = db.prepare(
        "SELECT id, name, ticker_symbol FROM investments WHERE (',' || previous_isin_codes || ',') LIKE '%,' || ? || ',%'"
      );
      const findByTickerBase = db.prepare(
        `SELECT id, name, ticker_symbol FROM investments WHERE asset_type = 'INDIAN_STOCK'
         AND REPLACE(REPLACE(ticker_symbol, '.NS', ''), '.BO', '') = ? LIMIT 1`
      );
      const insertInvestment = db.prepare(`
        INSERT INTO investments (name, asset_type, ticker_symbol, isin_code, currency, notes)
        VALUES (?, 'INDIAN_STOCK', ?, ?, 'INR', ?)
      `);
      // Idempotent: find existing transaction by key fields
      const findTransaction = db.prepare(`
        SELECT id, amount, fees FROM transactions
        WHERE investment_id = ? AND transaction_type = ? AND transaction_date = ? AND units = ? AND price_per_unit = ?
      `);
      const insertTransaction = db.prepare(`
        INSERT INTO transactions (investment_id, portfolio_id, transaction_type, transaction_date, units, price_per_unit, amount, fees, broker, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const updateTransaction = db.prepare(`
        UPDATE transactions SET amount = ?, fees = ?, notes = ? WHERE id = ?
      `);

      let investmentsCreated = 0;
      let transactionsCreated = 0;
      let transactionsUpdated = 0;
      let transactionsSkipped = 0;
      const errors = [];

      // Group trades by stock for investment resolution
      const stockMap = {};
      for (const trade of trades) {
        const key = trade.isin || trade.security;
        if (!stockMap[key]) {
          stockMap[key] = { security: trade.security, isin: trade.isin, trades: [] };
        }
        stockMap[key].trades.push(trade);
      }

      for (const [key, stock] of Object.entries(stockMap)) {
        try {
          let ticker = null;
          if (stock.isin) {
            ticker = await lookupTickerByISIN(stock.isin);
          }
          if (!ticker) {
            ticker = await lookupTickerByISIN(stock.security);
          }

          const tickerSymbol = ticker || null;
          const displayName = stock.security;

          // Match existing investment: ISIN first (current + historical), then ticker, then name
          let existing = null;
          if (stock.isin) {
            existing = findByIsin.get(stock.isin);
          }
          if (!existing && stock.isin) {
            existing = findByPreviousIsin.get(stock.isin);
          }
          if (!existing && tickerSymbol) {
            existing = findInvestment.get('INDIAN_STOCK', tickerSymbol, displayName);
          }
          if (!existing) {
            existing = findInvestment.get('INDIAN_STOCK', displayName, displayName);
          }

          let investmentId;
          if (existing) {
            investmentId = existing.id;
            // Backfill isin_code if we have it and the existing record doesn't
            if (stock.isin) {
              db.prepare('UPDATE investments SET isin_code = COALESCE(isin_code, ?) WHERE id = ?').run(stock.isin, investmentId);
            }
          } else {
            const result = insertInvestment.run(
              displayName, tickerSymbol, stock.isin || null,
              `Imported from ${broker || 'broker'} contract note`
            );
            investmentId = result.lastInsertRowid;
            investmentsCreated++;
          }

          for (const trade of stock.trades) {
            const amount = trade.total || trade.quantity * trade.rate;
            const fees = trade.brokerage || 0;
            const notes = `${broker || 'Broker'} contract note`;

            // Idempotent check
            const existingTxn = findTransaction.get(
              investmentId, trade.type, trade.tradeDate, trade.quantity, trade.rate
            );

            if (existingTxn) {
              // Check if anything changed
              if (Math.abs(existingTxn.amount - amount) > 0.01 || Math.abs(existingTxn.fees - fees) > 0.01) {
                updateTransaction.run(amount, fees, notes, existingTxn.id);
                transactionsUpdated++;
              } else {
                transactionsSkipped++;
              }
            } else {
              insertTransaction.run(
                investmentId, portfolioId, trade.type, trade.tradeDate, trade.quantity,
                trade.rate, amount, fees, broker || 'Unknown', notes
              );
              transactionsCreated++;
            }
          }
        } catch (e) {
          errors.push(`${stock.security}: ${e.message}`);
        }
      }

      res.json({
        investmentsCreated,
        transactionsCreated,
        transactionsUpdated,
        transactionsSkipped,
        errors: errors.length > 0 ? errors : undefined,
      });
    } catch (e) {
      console.error('Contract note import error:', e);
      res.status(500).json({ error: 'Failed to import trades: ' + e.message });
    }
  });

  /**
   * POST /api/stocks/pnl
   * Upload a P&L / trade history file (Excel/CSV) and import trades.
   * Body (multipart): file, broker, portfolio_id
   */
  router.post('/pnl', upload.single('file'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
      if (!req.body.portfolio_id) return res.status(400).json({ error: 'portfolio_id is required' });
      if (!req.body.broker) return res.status(400).json({ error: 'broker is required' });

      const portfolioId = parseInt(req.body.portfolio_id);
      const broker = req.body.broker;

      const portfolio = db.prepare('SELECT * FROM portfolios WHERE id = ?').get(portfolioId);
      if (!portfolio) return res.status(404).json({ error: 'Portfolio not found' });

      const allTrades = parsePnLStatement(req.file.buffer, req.file.originalname, broker);

      if (allTrades.length === 0) {
        return res.status(400).json({ error: 'No trades found in the uploaded file. Check the file format.' });
      }

      const stockMap = {};
      for (const trade of allTrades) {
        const key = trade.isin || trade.security;
        if (!stockMap[key]) {
          stockMap[key] = { security: trade.security, isin: trade.isin, trades: [] };
        }
        stockMap[key].trades.push(trade);
      }

      const insertInvestment = db.prepare(`
        INSERT INTO investments (name, asset_type, ticker_symbol, currency, notes, isin_code)
        VALUES (?, 'INDIAN_STOCK', ?, 'INR', ?, ?)
      `);
      const findByIsin = db.prepare(
        'SELECT id FROM investments WHERE isin_code = ?'
      );
      const findByPreviousIsin = db.prepare(
        "SELECT id FROM investments WHERE (',' || previous_isin_codes || ',') LIKE '%,' || ? || ',%'"
      );
      const findByTickerBase = db.prepare(
        "SELECT id FROM investments WHERE REPLACE(REPLACE(ticker_symbol, '.NS', ''), '.BO', '') = ?"
      );
      const findInvestment = db.prepare(
        'SELECT id FROM investments WHERE asset_type = ? AND (ticker_symbol = ? OR name = ?)'
      );
      const insertTransaction = db.prepare(`
        INSERT INTO transactions (investment_id, portfolio_id, transaction_type, transaction_date, units, price_per_unit, amount, fees, broker, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      let investmentsCreated = 0;
      let transactionsCreated = 0;
      const errors = [];

      for (const [key, stock] of Object.entries(stockMap)) {
        try {
          let ticker = null;
          if (stock.isin) {
            ticker = await lookupTickerByISIN(stock.isin);
          }
          if (!ticker) {
            ticker = await lookupTickerByISIN(stock.security);
          }

          const tickerSymbol = ticker || null;
          const displayName = stock.security;

          // Match existing investment: ISIN first (current + historical), then ticker base, then legacy match
          let existing = null;
          if (stock.isin) {
            existing = findByIsin.get(stock.isin);
          }
          if (!existing && stock.isin) {
            existing = findByPreviousIsin.get(stock.isin);
          }
          if (!existing && tickerSymbol) {
            const base = tickerSymbol.replace(/\.(NS|BO)$/, '');
            existing = findByTickerBase.get(base);
          }
          if (!existing && tickerSymbol) {
            existing = findInvestment.get('INDIAN_STOCK', tickerSymbol, displayName);
          }
          if (!existing) {
            existing = findInvestment.get('INDIAN_STOCK', displayName, displayName);
          }

          let investmentId;
          if (existing) {
            investmentId = existing.id;
            // Backfill isin_code if we have ISIN but existing record doesn't
            if (stock.isin) {
              db.prepare('UPDATE investments SET isin_code = ? WHERE id = ? AND isin_code IS NULL').run(stock.isin, investmentId);
            }
          } else {
            const result = insertInvestment.run(
              displayName, tickerSymbol,
              `Imported from ${broker} P&L statement`,
              stock.isin || null
            );
            investmentId = result.lastInsertRowid;
            investmentsCreated++;
          }

          for (const trade of stock.trades) {
            const amount = trade.quantity * trade.rate;
            const fees = trade.fees || 0;
            insertTransaction.run(
              investmentId, portfolioId, trade.type, trade.tradeDate, trade.quantity,
              trade.rate, amount, fees, broker, `${broker} P&L import`
            );
            transactionsCreated++;
          }
        } catch (e) {
          errors.push(`${stock.security}: ${e.message}`);
        }
      }

      res.json({
        investmentsCreated,
        transactionsCreated,
        totalTrades: allTrades.length,
        errors: errors.length > 0 ? errors : undefined,
      });
    } catch (e) {
      console.error('P&L import error:', e);
      res.status(500).json({ error: 'Failed to process P&L statement: ' + e.message });
    }
  });

  /**
   * POST /api/stocks/amc-charge
   * Record an AMC / maintenance charge as a portfolio expense.
   * Body: { portfolio_id, date, amount, broker, notes, expense_type }
   */
  router.post('/amc-charge', express.json(), (req, res) => {
    try {
      const { portfolio_id, date, amount, broker, notes, expense_type } = req.body;
      if (!portfolio_id) return res.status(400).json({ error: 'portfolio_id is required' });
      if (!date) return res.status(400).json({ error: 'date is required' });
      if (!amount || amount <= 0) return res.status(400).json({ error: 'amount must be positive' });

      const portfolio = db.prepare('SELECT * FROM portfolios WHERE id = ?').get(portfolio_id);
      if (!portfolio) return res.status(404).json({ error: 'Portfolio not found' });

      const validTypes = ['AMC', 'PLATFORM_FEE', 'CDSL', 'ACCOUNT_OPENING', 'OTHER'];
      const type = validTypes.includes(expense_type) ? expense_type : 'AMC';

      const result = db.prepare(
        'INSERT INTO portfolio_expenses (portfolio_id, expense_type, expense_date, amount, broker, notes) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(portfolio_id, type, date, parseFloat(amount), broker || null, notes || 'AMC/Maintenance charge');

      res.json({ success: true, expense_id: result.lastInsertRowid });
    } catch (e) {
      console.error('AMC charge error:', e);
      res.status(500).json({ error: 'Failed to record charge: ' + e.message });
    }
  });

  // ESPP Grants (offering-based purchases)
  // Preview ESPP offering rows and mark already imported rows.
  router.get('/espp-grants/preview', (req, res) => {
    try {
      const investmentId = req.query.investment_id ? parseInt(req.query.investment_id, 10) : null;
      const portfolioId = req.query.portfolio_id ? parseInt(req.query.portfolio_id, 10) : null;
      const includeFuture = String(req.query.include_future || '').toLowerCase() === 'true';
      const asOfDate = req.query.as_of_date || null;
      const offeringKeys = req.query.offering_keys
        ? String(req.query.offering_keys).split(',').map((s) => s.trim()).filter(Boolean)
        : null;

      const schedule = generateEsppSchedule({ includeFuture, asOfDate, offeringKeys });

      if (!investmentId || !portfolioId) {
        return res.json({
          ...schedule,
          known_offerings: OFFERINGS.length,
          imported_rows: 0,
          rows: schedule.rows.map((row) => ({ ...row, already_imported: false })),
        });
      }

      const existing = db.prepare(`
        SELECT id, transaction_date, notes
        FROM transactions
        WHERE investment_id = ?
          AND portfolio_id = ?
          AND transaction_type = 'ESPP_PURCHASE'
          AND notes LIKE 'ESPP Purchase | %'
      `).all(investmentId, portfolioId);

      const importedKeys = new Set();
      for (const txn of existing) {
        const keyMatch = String(txn.notes || '').match(/Key\s+([A-Z0-9_]+)/i);
        if (!keyMatch) continue;
        importedKeys.add(`${keyMatch[1]}|${txn.transaction_date}`);
      }

      const rows = schedule.rows.map((row) => ({
        ...row,
        already_imported: importedKeys.has(row.import_key),
      }));

      res.json({
        ...schedule,
        known_offerings: OFFERINGS.length,
        imported_rows: rows.filter((r) => r.already_imported).length,
        rows,
      });
    } catch (e) {
      res.status(500).json({ error: 'Failed to preview ESPP grants: ' + e.message });
    }
  });

  // Import ESPP purchase placeholders in idempotent mode.
  router.post('/espp-grants/import', async (req, res) => {
    try {
      const {
        investment_id,
        portfolio_id,
        include_future,
        as_of_date,
        offering_keys,
        overwrite_existing,
      } = req.body || {};

      const investmentId = parseInt(investment_id, 10);
      const portfolioId = parseInt(portfolio_id, 10);
      if (!investmentId || !portfolioId) {
        return res.status(400).json({ error: 'investment_id and portfolio_id are required' });
      }

      const investment = db.prepare('SELECT id, ticker_symbol, currency FROM investments WHERE id = ?').get(investmentId);
      if (!investment) return res.status(404).json({ error: 'Investment not found' });

      const schedule = generateEsppSchedule({
        includeFuture: include_future === true,
        asOfDate: as_of_date || null,
        offeringKeys: Array.isArray(offering_keys) ? offering_keys : null,
      });

      const rows = schedule.rows;
      if (!rows.length) {
        return res.json({ created: 0, skipped: 0, removed_existing: 0, total_rows: 0 });
      }

      const existing = db.prepare(`
        SELECT id, transaction_date, notes
        FROM transactions
        WHERE investment_id = ?
          AND portfolio_id = ?
          AND transaction_type = 'ESPP_PURCHASE'
          AND notes LIKE 'ESPP Purchase | %'
      `).all(investmentId, portfolioId);

      const existingByKey = new Map();
      for (const txn of existing) {
        const keyMatch = String(txn.notes || '').match(/Key\s+([A-Z0-9_]+)/i);
        if (!keyMatch) continue;
        const key = `${keyMatch[1]}|${txn.transaction_date}`;
        existingByKey.set(key, txn.id);
      }

      const insertTxn = db.prepare(`
        INSERT INTO transactions (
          investment_id, portfolio_id, transaction_type, transaction_date,
          units, price_per_unit, amount, fees, broker, notes,
          exchange_rate_used, usd_amount, fmv_per_unit, gross_units, tax_withheld_units
        ) VALUES (?, ?, 'ESPP_PURCHASE', ?, NULL, ?, 0, 0, 'Fidelity', ?, ?, NULL, ?, NULL, NULL)
      `);
      const deleteTxn = db.prepare('DELETE FROM transactions WHERE id = ?');

      let removedExisting = 0;
      let created = 0;
      let skipped = 0;

      const pricingByDate = new Map();
      for (const row of rows) {
        if (!investment.ticker_symbol) {
          pricingByDate.set(row.purchase_date, { fmv_per_unit: null, exchange_rate_used: null });
          continue;
        }

        try {
          const [fmvPerUnit, fxRate] = await Promise.all([
            fetchHistoricalStockPrice(investment.ticker_symbol, row.purchase_date),
            investment.currency === 'USD' ? fetchHistoricalUSDToINR(row.purchase_date) : Promise.resolve(null),
          ]);
          pricingByDate.set(row.purchase_date, {
            fmv_per_unit: fmvPerUnit != null ? Number(fmvPerUnit) : null,
            exchange_rate_used: fxRate != null ? Number(fxRate) : null,
          });
        } catch (_) {
          pricingByDate.set(row.purchase_date, { fmv_per_unit: null, exchange_rate_used: null });
        }
      }

      const runAll = db.transaction(() => {
        for (const row of rows) {
          const existingId = existingByKey.get(row.import_key);
          if (existingId && overwrite_existing === true) {
            deleteTxn.run(existingId);
            removedExisting += 1;
          } else if (existingId) {
            skipped += 1;
            continue;
          }

          const pricing = pricingByDate.get(row.purchase_date) || { fmv_per_unit: null, exchange_rate_used: null };
          const purchasePrice = pricing.fmv_per_unit != null
            ? Number((pricing.fmv_per_unit * (1 - row.discount_pct / 100)).toFixed(4))
            : null;

          insertTxn.run(
            investmentId,
            portfolioId,
            row.purchase_date,
            purchasePrice,
            row.notes,
            pricing.exchange_rate_used,
            pricing.fmv_per_unit,
          );
          created += 1;
        }
      });

      runAll();

      res.json({
        created,
        skipped,
        removed_existing: removedExisting,
        total_rows: rows.length,
        as_of_date: schedule.as_of_date,
        include_future: schedule.include_future,
      });
    } catch (e) {
      res.status(500).json({ error: 'Failed to import ESPP grants: ' + e.message });
    }
  });

  // Parse payslip PDFs and preview monthly ESPP payroll contributions.
  router.post('/espp-contributions/preview', upload.array('files', 20), async (req, res) => {
    try {
      const investmentId = req.body?.investment_id ? parseInt(req.body.investment_id, 10) : null;
      const portfolioId = req.body?.portfolio_id ? parseInt(req.body.portfolio_id, 10) : null;
      if (!investmentId || !portfolioId) {
        return res.status(400).json({ error: 'investment_id and portfolio_id are required' });
      }
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'No payslip files uploaded' });
      }

      const rows = await extractEsppContributionsFromPayslipFiles(req.files);

      const existing = db.prepare(`
        SELECT id, transaction_date, notes
        FROM transactions
        WHERE investment_id = ?
          AND portfolio_id = ?
          AND transaction_type = 'ESPP_CONTRIBUTION'
      `).all(investmentId, portfolioId);

      const existingKeys = new Set();
      for (const txn of existing) {
        const keyMatch = String(txn.notes || '').match(/Key\s+(ESPP_CONTRIB\|\d{4}-\d{2})/i);
        if (keyMatch) {
          existingKeys.add(keyMatch[1].toUpperCase());
          continue;
        }
        existingKeys.add(`ESPP_CONTRIB|${String(txn.transaction_date || '').slice(0, 7)}`.toUpperCase());
      }

      const previewRows = rows.map((r) => ({
        ...r,
        already_imported: existingKeys.has(String(r.import_key).toUpperCase()),
      }));

      res.json({
        files_processed: req.files.length,
        rows_found: previewRows.length,
        imported_rows: previewRows.filter((r) => r.already_imported).length,
        rows: previewRows,
      });
    } catch (e) {
      res.status(500).json({ error: 'Failed to preview ESPP contributions: ' + e.message });
    }
  });

  // Import monthly ESPP contribution rows from preview payload.
  router.post('/espp-contributions/import', express.json(), (req, res) => {
    try {
      const {
        investment_id,
        portfolio_id,
        overwrite_existing,
        rows,
      } = req.body || {};

      const investmentId = parseInt(investment_id, 10);
      const portfolioId = parseInt(portfolio_id, 10);
      if (!investmentId || !portfolioId) {
        return res.status(400).json({ error: 'investment_id and portfolio_id are required' });
      }
      if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ error: 'rows is required and must be a non-empty array' });
      }

      const investment = db.prepare('SELECT id FROM investments WHERE id = ?').get(investmentId);
      if (!investment) return res.status(404).json({ error: 'Investment not found' });

      const existing = db.prepare(`
        SELECT id, transaction_date, notes
        FROM transactions
        WHERE investment_id = ?
          AND portfolio_id = ?
          AND transaction_type = 'ESPP_CONTRIBUTION'
      `).all(investmentId, portfolioId);

      const existingByKey = new Map();
      for (const txn of existing) {
        const keyMatch = String(txn.notes || '').match(/Key\s+(ESPP_CONTRIB\|\d{4}-\d{2})/i);
        if (keyMatch) {
          existingByKey.set(keyMatch[1].toUpperCase(), txn.id);
        } else {
          existingByKey.set(`ESPP_CONTRIB|${String(txn.transaction_date || '').slice(0, 7)}`.toUpperCase(), txn.id);
        }
      }

      const insertTxn = db.prepare(`
        INSERT INTO transactions (
          investment_id, portfolio_id, transaction_type, transaction_date,
          units, price_per_unit, amount, fees, broker, notes,
          exchange_rate_used, usd_amount, fmv_per_unit, gross_units, tax_withheld_units
        ) VALUES (?, ?, 'ESPP_CONTRIBUTION', ?, NULL, NULL, ?, 0, 'Payroll', ?, NULL, NULL, NULL, NULL, NULL)
      `);
      const deleteTxn = db.prepare('DELETE FROM transactions WHERE id = ?');

      let created = 0;
      let skipped = 0;
      let removedExisting = 0;

      const runAll = db.transaction(() => {
        for (const row of rows) {
          const importKey = String(row.import_key || '').toUpperCase();
          const amount = Number(row.amount || 0);
          const contributionDate = String(row.contribution_date || '');
          const monthKey = String(row.month_key || contributionDate.slice(0, 7));
          if (!importKey || !contributionDate || !(amount > 0)) {
            skipped += 1;
            continue;
          }

          const existingId = existingByKey.get(importKey);
          if (existingId && overwrite_existing === true) {
            deleteTxn.run(existingId);
            removedExisting += 1;
          } else if (existingId) {
            skipped += 1;
            continue;
          }

          const noteParts = [
            `ESPP Contribution | Month ${monthKey}`,
            row.source_file ? `Source ${row.source_file}` : null,
            `Key ${importKey}`,
          ].filter(Boolean);

          insertTxn.run(
            investmentId,
            portfolioId,
            contributionDate,
            Number(amount.toFixed(2)),
            noteParts.join(' | '),
          );
          created += 1;
        }
      });

      runAll();

      res.json({
        created,
        skipped,
        removed_existing: removedExisting,
        total_rows: rows.length,
      });
    } catch (e) {
      res.status(500).json({ error: 'Failed to import ESPP contributions: ' + e.message });
    }
  });

  // Preview quarterly ESPP acquisition rows (prepared from OCR/UI extraction).
  router.post('/espp-acquisitions/preview', express.json(), (req, res) => {
    try {
      const investmentId = req.body?.investment_id ? parseInt(req.body.investment_id, 10) : null;
      const portfolioId = req.body?.portfolio_id ? parseInt(req.body.portfolio_id, 10) : null;
      const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
      const sourceLabel = req.body?.source ? String(req.body.source).trim() : '';

      if (!investmentId || !portfolioId) {
        return res.status(400).json({ error: 'investment_id and portfolio_id are required' });
      }
      if (!rows.length) {
        return res.status(400).json({ error: 'rows is required and must be a non-empty array' });
      }

      const investment = db.prepare('SELECT id FROM investments WHERE id = ?').get(investmentId);
      if (!investment) return res.status(404).json({ error: 'Investment not found' });

      const normalized = normalizeRows(rows, sourceLabel);

      const existing = db.prepare(`
        SELECT id, transaction_date, units, price_per_unit, usd_amount, notes
        FROM transactions
        WHERE investment_id = ?
          AND portfolio_id = ?
          AND transaction_type = 'ESPP_PURCHASE'
      `).all(investmentId, portfolioId);

      const previewRows = annotatePreviewRows(normalized, existing);

      res.json({
        rows_found: previewRows.length,
        imported_rows: previewRows.filter((r) => r.already_imported).length,
        rows: previewRows,
      });
    } catch (e) {
      res.status(500).json({ error: 'Failed to preview ESPP acquisitions: ' + e.message });
    }
  });

  // Import quarterly ESPP acquisition rows as ESPP_PURCHASE (share acquisition only, amount=0).
  router.post('/espp-acquisitions/import', express.json(), async (req, res) => {
    try {
      const investmentId = req.body?.investment_id ? parseInt(req.body.investment_id, 10) : null;
      const portfolioId = req.body?.portfolio_id ? parseInt(req.body.portfolio_id, 10) : null;
      const overwriteExisting = req.body?.overwrite_existing === true;
      const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
      const sourceLabel = req.body?.source ? String(req.body.source).trim() : '';

      if (!investmentId || !portfolioId) {
        return res.status(400).json({ error: 'investment_id and portfolio_id are required' });
      }
      if (!rows.length) {
        return res.status(400).json({ error: 'rows is required and must be a non-empty array' });
      }

      const investment = db.prepare('SELECT id FROM investments WHERE id = ?').get(investmentId);
      if (!investment) return res.status(404).json({ error: 'Investment not found' });

      const normalized = normalizeRows(rows, sourceLabel);

      const existing = db.prepare(`
        SELECT id, transaction_date, units, price_per_unit, usd_amount, notes
        FROM transactions
        WHERE investment_id = ?
          AND portfolio_id = ?
          AND transaction_type = 'ESPP_PURCHASE'
      `).all(investmentId, portfolioId);

      const previewRows = annotatePreviewRows(normalized, existing);

      const rateByDate = new Map();
      for (const row of previewRows) {
        if (!rateByDate.has(row.purchase_date)) {
          const rate = await fetchHistoricalUSDToINR(row.purchase_date);
          rateByDate.set(row.purchase_date, Number(rate));
        }
      }

      const insertTxn = db.prepare(`
        INSERT INTO transactions (
          investment_id, portfolio_id, transaction_type, transaction_date,
          units, price_per_unit, amount, fees, broker, notes,
          exchange_rate_used, usd_amount, fmv_per_unit, gross_units, tax_withheld_units
        ) VALUES (?, ?, 'ESPP_PURCHASE', ?, ?, ?, 0, 0, 'Fidelity', ?, ?, ?, ?, NULL, NULL)
      `);

      const deleteTxn = db.prepare('DELETE FROM transactions WHERE id = ?');

      let created = 0;
      let skipped = 0;
      let removedExisting = 0;

      const runAll = db.transaction(() => {
        for (const row of previewRows) {
          if (row.already_imported && overwriteExisting && row.existing_transaction_id) {
            deleteTxn.run(row.existing_transaction_id);
            removedExisting += 1;
          } else if (row.already_imported) {
            skipped += 1;
            continue;
          }

          insertTxn.run(
            investmentId,
            portfolioId,
            row.purchase_date,
            row.purchase_quantity,
            row.purchase_price,
            row.notes,
            rateByDate.get(row.purchase_date) || null,
            row.purchase_value,
            row.fmv_purchase_date,
          );
          created += 1;
        }
      });

      runAll();

      res.json({
        created,
        skipped,
        removed_existing: removedExisting,
        total_rows: previewRows.length,
      });
    } catch (e) {
      res.status(500).json({ error: 'Failed to import ESPP acquisitions: ' + e.message });
    }
  });

  // RSU Grants (MSFT annual, on-hire, special)
  // Preview schedule rows and optionally mark already imported rows.
  router.get('/rsu-grants/preview', (req, res) => {
    try {
      const investmentId = req.query.investment_id ? parseInt(req.query.investment_id, 10) : null;
      const portfolioId = req.query.portfolio_id ? parseInt(req.query.portfolio_id, 10) : null;
      const includeFuture = String(req.query.include_future || '').toLowerCase() === 'true';
      const asOfDate = req.query.as_of_date || null;
      const grantKeys = req.query.grant_keys
        ? String(req.query.grant_keys).split(',').map((s) => s.trim()).filter(Boolean)
        : null;

      const schedule = generateRsuSchedule({ includeFuture, asOfDate, grantKeys });

      if (!investmentId || !portfolioId) {
        return res.json({
          ...schedule,
          imported_rows: 0,
          rows: schedule.rows.map((row) => ({ ...row, already_imported: false })),
        });
      }

      const existing = db.prepare(`
        SELECT id, transaction_date, notes
        FROM transactions
        WHERE investment_id = ?
          AND portfolio_id = ?
          AND transaction_type = 'VEST'
          AND notes LIKE 'RSU Vest | %'
      `).all(investmentId, portfolioId);

      const importedKeys = new Set();
      for (const txn of existing) {
        const notes = String(txn.notes || '');
        const awardMatch = notes.match(/Award\s+(\d+)/i);
        const trancheMatch = notes.match(/Tranche\s+(\d+)\//i);
        if (!awardMatch || !trancheMatch) continue;
        importedKeys.add(`${awardMatch[1]}|${txn.transaction_date}|${parseInt(trancheMatch[1], 10)}`);
      }

      const rows = schedule.rows.map((row) => ({
        ...row,
        already_imported: importedKeys.has(row.import_key),
      }));

      res.json({
        ...schedule,
        imported_rows: rows.filter((r) => r.already_imported).length,
        rows,
      });
    } catch (e) {
      res.status(500).json({ error: 'Failed to preview RSU grants: ' + e.message });
    }
  });

  // Upload stock grant documents and map them to known RSU awards.
  router.post('/rsu-grants/documents/preview', upload.array('files', 20), (req, res) => {
    try {
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'No files uploaded' });
      }

      const grantByAward = new Map(GRANTS.map((g) => [String(g.awardNumber), g]));
      const grantKeys = new Set();
      const fileSummaries = [];

      const parseText = (buffer) => {
        const utf8 = buffer.toString('utf8');
        const latin1 = buffer.toString('latin1');
        const utf16 = buffer.toString('utf16le');
        return [utf8, latin1, utf16].join('\n');
      };

      const extractMatch = (text, regex) => {
        const match = text.match(regex);
        return match ? String(match[1]).trim() : null;
      };

      const detectAwardNumber = (text) => {
        const cleaned = String(text || '');

        const labeled = extractMatch(cleaned, /award\s+number\s*[:\-]?\s*([0-9]{7,})/i);
        if (labeled && grantByAward.has(labeled)) return labeled;

        // Fast path: exact known award number appears anywhere in the extracted text.
        for (const award of grantByAward.keys()) {
          if (cleaned.includes(award)) return award;
        }

        // Fallback: normalize potentially split digits (e.g. "0 0 0 0 ...") and try matching.
        const candidates = cleaned.match(/[0-9][0-9\s\-]{8,}[0-9]/g) || [];
        for (const raw of candidates) {
          const digits = raw.replace(/\D/g, '');
          if (grantByAward.has(digits)) return digits;
        }

        return null;
      };

      for (const file of req.files) {
        const text = parseText(file.buffer);
        const awardNumber = detectAwardNumber(text);
        const awardDate = extractMatch(text, /award\s+date\s*[:\-]?\s*([0-9]{2}[\/\-][0-9]{2}[\/\-][0-9]{4})/i);
        const sharesMatchA = text.match(/total\s+(?:number\s+of\s+)?shares(?:\s+subject\s+to\s+the\s+award)?\s*[:\-]?\s*([0-9,]+)/i);
        const sharesMatchB = text.match(/([0-9,]+)\s+shares\s+subject\s+to\s+the\s+award/i);
        const sharesRaw = sharesMatchA?.[1] || sharesMatchB?.[1] || null;
        const shares = sharesRaw ? Number(String(sharesRaw).replace(/,/g, '')) : null;

        const grant = awardNumber ? grantByAward.get(awardNumber) : null;
        if (grant) grantKeys.add(grant.key);

        fileSummaries.push({
          file_name: file.originalname,
          award_number: awardNumber,
          award_date: awardDate,
          extracted_shares: shares,
          matched_grant_key: grant ? grant.key : null,
          matched_grant_label: grant ? grant.label : null,
        });
      }

      const matchedGrants = GRANTS
        .filter((g) => grantKeys.has(g.key))
        .map((g) => ({
          key: g.key,
          label: g.label,
          award_number: g.awardNumber,
          award_date: g.awardDate,
          total_shares: g.totalShares,
        }));

      res.json({
        files_processed: req.files.length,
        matched_count: matchedGrants.length,
        grant_keys: Array.from(grantKeys),
        matched_grants: matchedGrants,
        file_summaries: fileSummaries,
      });
    } catch (e) {
      res.status(500).json({ error: 'Failed to parse stock grant documents: ' + e.message });
    }
  });

  // Import RSU VEST transactions in idempotent mode.
  router.post('/rsu-grants/import', async (req, res) => {
    try {
      const {
        investment_id,
        portfolio_id,
        include_future,
        as_of_date,
        grant_keys,
        overwrite_existing,
      } = req.body || {};

      const investmentId = parseInt(investment_id, 10);
      const portfolioId = parseInt(portfolio_id, 10);
      if (!investmentId || !portfolioId) {
        return res.status(400).json({ error: 'investment_id and portfolio_id are required' });
      }

      const investment = db.prepare('SELECT id, ticker_symbol, currency FROM investments WHERE id = ?').get(investmentId);
      if (!investment) return res.status(404).json({ error: 'Investment not found' });

      const schedule = generateRsuSchedule({
        includeFuture: include_future === true,
        asOfDate: as_of_date || null,
        grantKeys: Array.isArray(grant_keys) ? grant_keys : null,
      });

      const rows = schedule.rows;
      if (!rows.length) {
        return res.json({ created: 0, skipped: 0, removed_existing: 0, total_rows: 0 });
      }

      const existing = db.prepare(`
        SELECT id, transaction_date, notes
        FROM transactions
        WHERE investment_id = ?
          AND portfolio_id = ?
          AND transaction_type = 'VEST'
          AND notes LIKE 'RSU Vest | %'
      `).all(investmentId, portfolioId);

      const existingByKey = new Map();
      for (const txn of existing) {
        const notes = String(txn.notes || '');
        const awardMatch = notes.match(/Award\s+(\d+)/i);
        const trancheMatch = notes.match(/Tranche\s+(\d+)\//i);
        if (!awardMatch || !trancheMatch) continue;
        const key = `${awardMatch[1]}|${txn.transaction_date}|${parseInt(trancheMatch[1], 10)}`;
        existingByKey.set(key, txn.id);
      }

      const insertTxn = db.prepare(`
        INSERT INTO transactions (
          investment_id, portfolio_id, transaction_type, transaction_date,
          units, price_per_unit, amount, fees, broker, notes,
          exchange_rate_used, usd_amount, fmv_per_unit, gross_units, tax_withheld_units
        ) VALUES (?, ?, 'VEST', ?, NULL, ?, ?, 0, 'Fidelity', ?, ?, ?, NULL, ?, ?)
      `);
      const deleteTxn = db.prepare('DELETE FROM transactions WHERE id = ?');

      let removedExisting = 0;
      let created = 0;
      let skipped = 0;

      const today = new Date().toISOString().slice(0, 10);
      const pricingByDate = new Map();

      for (const row of rows) {
        if (row.vest_date > today) continue;
        if (!investment.ticker_symbol) continue;
        try {
          const [pricePerUnit, fxRate] = await Promise.all([
            fetchHistoricalStockPrice(investment.ticker_symbol, row.vest_date),
            investment.currency === 'USD' ? fetchHistoricalUSDToINR(row.vest_date) : Promise.resolve(null),
          ]);
          pricingByDate.set(row.vest_date, {
            price_per_unit: pricePerUnit != null ? Number(pricePerUnit) : null,
            exchange_rate_used: fxRate != null ? Number(fxRate) : null,
          });
        } catch (_) {
          pricingByDate.set(row.vest_date, { price_per_unit: null, exchange_rate_used: null });
        }
      }

      const runAll = db.transaction(() => {
        for (const row of rows) {
          const existingId = existingByKey.get(row.import_key);
          if (existingId && overwrite_existing === true) {
            deleteTxn.run(existingId);
            removedExisting += 1;
          } else if (existingId) {
            skipped += 1;
            continue;
          }

          const pricing = pricingByDate.get(row.vest_date) || { price_per_unit: null, exchange_rate_used: null };
          const usdAmount = pricing.price_per_unit != null ? Number((row.units * pricing.price_per_unit).toFixed(4)) : null;
          const amount = pricing.price_per_unit != null && pricing.exchange_rate_used != null
            ? Number((usdAmount * pricing.exchange_rate_used).toFixed(2))
            : 0;

          insertTxn.run(
            investmentId,                       // investment_id
            portfolioId,                        // portfolio_id
            row.vest_date,                      // transaction_date (position 4 in VALUES)
            pricing.price_per_unit,             // price_per_unit (position 6 in VALUES)
            amount,                             // amount (position 7 in VALUES)
            row.notes,                          // notes (position 10 in VALUES)
            pricing.exchange_rate_used,         // exchange_rate_used (position 11 in VALUES)
            usdAmount,                          // usd_amount (position 12 in VALUES)
            row.units,                          // gross_units (position 14 in VALUES)
            null,                               // tax_withheld_units (position 15 in VALUES)
          );
          created += 1;
        }
      });

      runAll();

      res.json({
        created,
        skipped,
        removed_existing: removedExisting,
        total_rows: rows.length,
        as_of_date: schedule.as_of_date,
        include_future: schedule.include_future,
      });
    } catch (e) {
      res.status(500).json({ error: 'Failed to import RSU grants: ' + e.message });
    }
  });

  // Reconcile imported RSU VEST rows using Fidelity open/closed lot exports.
  // This infers net vested shares and tax-withheld shares, and aligns vest FMV.
  router.post('/rsu-grants/reconcile-fidelity', upload.fields([
    { name: 'open_lots', maxCount: 1 },
    { name: 'closed_lots', maxCount: 1 },
  ]), async (req, res) => {
    try {
      const investmentId = parseInt(req.body?.investment_id, 10);
      const portfolioId = req.body?.portfolio_id ? parseInt(req.body.portfolio_id, 10) : null;
      const dryRun = String(req.body?.dry_run || '').toLowerCase() === 'true';
      const overwritePrice = String(req.body?.overwrite_price || 'true').toLowerCase() !== 'false';
      const notesContains = req.body?.notes_contains ? String(req.body.notes_contains).toLowerCase() : null;

      if (!investmentId) {
        return res.status(400).json({ error: 'investment_id is required' });
      }

      const investment = db.prepare('SELECT id, ticker_symbol, currency FROM investments WHERE id = ?').get(investmentId);
      if (!investment) {
        return res.status(404).json({ error: 'Investment not found' });
      }

      const openFile = req.files?.open_lots?.[0] || null;
      const closedFile = req.files?.closed_lots?.[0] || null;
      if (!openFile && !closedFile) {
        return res.status(400).json({ error: 'At least one file is required: open_lots or closed_lots' });
      }

      let vestTxns = db.prepare(`
        SELECT id, transaction_date, units, gross_units, price_per_unit, notes
        FROM transactions
        WHERE investment_id = ?
          AND transaction_type = 'VEST'
          ${portfolioId ? 'AND portfolio_id = ?' : ''}
        ORDER BY transaction_date ASC, id ASC
      `).all(...(portfolioId ? [investmentId, portfolioId] : [investmentId]));

      if (notesContains) {
        vestTxns = vestTxns.filter((t) => String(t.notes || '').toLowerCase().includes(notesContains));
      }

      if (!vestTxns.length) {
        return res.json({
          updated: 0,
          matched_txns: 0,
          matched_dates: 0,
          skipped_dates: [],
          skipped_rows: [],
          notes_filter: notesContains || null,
          message: 'No VEST transactions found for the given investment.',
        });
      }

      const openRows = openFile ? parseOpenLots(openFile.buffer) : [];
      const closedRows = closedFile ? parseClosedLots(closedFile.buffer) : [];

      const reconciliation = reconcileVestTransactions({
        vestTransactions: vestTxns,
        openLotsRows: openRows,
        closedLotsRows: closedRows,
      });

      const updates = reconciliation.updates;
      if (!updates.length || dryRun) {
        return res.json({
          updated: 0,
          matched_txns: reconciliation.matched_txns,
          matched_dates: reconciliation.matched_dates,
          skipped_dates: reconciliation.skipped_dates,
          skipped_rows: reconciliation.skipped_rows,
          notes_filter: notesContains || null,
          preview: updates,
          dry_run: dryRun,
        });
      }

      const dates = Array.from(new Set(updates.map((u) => u.matched_lot_date || u.date)));
      const fxByDate = new Map();
      for (const date of dates) {
        let fx = null;
        if (investment.currency === 'USD') {
          try {
            fx = await fetchHistoricalUSDToINR(date);
          } catch (_) {
            fx = null;
          }
        }
        fxByDate.set(date, fx != null ? Number(fx) : null);
      }

      const updateTxn = db.prepare(`
        UPDATE transactions
        SET transaction_date = ?,
            units = ?,
            gross_units = ?,
            tax_withheld_units = ?,
            price_per_unit = ?,
            exchange_rate_used = ?,
            usd_amount = ?,
            amount = ?
        WHERE id = ?
      `);

      let updated = 0;
      const runAll = db.transaction(() => {
        for (const u of updates) {
          const row = db.prepare('SELECT price_per_unit, exchange_rate_used FROM transactions WHERE id = ?').get(u.id);
          if (!row) continue;

          const effectiveDate = u.matched_lot_date || u.date;

          const price = overwritePrice && u.vest_price_usd != null
            ? Number(u.vest_price_usd)
            : (row.price_per_unit != null ? Number(row.price_per_unit) : null);
          const fx = fxByDate.get(effectiveDate) != null
            ? Number(fxByDate.get(effectiveDate))
            : (row.exchange_rate_used != null ? Number(row.exchange_rate_used) : null);
          const usdAmount = price != null ? Number((u.gross_units * price).toFixed(4)) : null;
          const amount = usdAmount != null && fx != null ? Number((usdAmount * fx).toFixed(2)) : 0;

          updateTxn.run(
            effectiveDate,
            u.net_units,
            u.gross_units,
            u.tax_withheld_units,
            price,
            fx,
            usdAmount,
            amount,
            u.id,
          );
          updated += 1;
        }
      });

      runAll();

      res.json({
        updated,
        matched_txns: reconciliation.matched_txns,
        matched_dates: reconciliation.matched_dates,
        skipped_dates: reconciliation.skipped_dates,
        skipped_rows: reconciliation.skipped_rows,
        notes_filter: notesContains || null,
        preview: updates,
        dry_run: false,
      });
    } catch (e) {
      res.status(500).json({ error: 'Failed to reconcile RSU fidelity lots: ' + e.message });
    }
  });

  // ─── Corporate Actions: Preview ─────────────────────────────────────────────
  /**
   * GET /api/stocks/corporate-actions/preview?portfolio_id=1&year=2019
   * Fetch missing corporate actions (dividends, splits/bonus) for all stocks
   * held in the portfolio during the given year.
   */
  router.get('/corporate-actions/preview', async (req, res) => {
    try {
      const { portfolio_id, year, asset_type } = req.query;
      if (!year) return res.status(400).json({ error: 'year is required' });

      const yearNum = parseInt(year);
      const portfolioId = portfolio_id ? parseInt(portfolio_id) : null;
      const assetType = asset_type === 'FOREIGN_STOCK' ? 'FOREIGN_STOCK' : 'INDIAN_STOCK';
      const currencySymbol = assetType === 'FOREIGN_STOCK' ? '$' : '₹';

      // Get all stock investments of the requested type (optionally scoped to portfolio) that have a ticker
      let investmentQuery;
      let investmentParams;
      if (portfolioId) {
        investmentQuery = `
          SELECT DISTINCT i.id, i.name, i.ticker_symbol
          FROM investments i
          JOIN transactions t ON t.investment_id = i.id AND t.portfolio_id = ?
          WHERE i.asset_type = ? AND i.ticker_symbol IS NOT NULL`;
        investmentParams = [portfolioId, assetType];
      } else {
        investmentQuery = `
          SELECT DISTINCT i.id, i.name, i.ticker_symbol
          FROM investments i
          WHERE i.asset_type = ? AND i.ticker_symbol IS NOT NULL
            AND EXISTS (SELECT 1 FROM transactions t WHERE t.investment_id = i.id)`;
        investmentParams = [assetType];
      }
      const investments = db.prepare(investmentQuery).all(...investmentParams);

      const suggestions = [];
      const corrections = [];
      const deletions = [];
      const errors = [];
      const fxByDate = new Map();

      async function getFxForDate(date) {
        if (fxByDate.has(date)) return fxByDate.get(date);
        const fx = await fetchHistoricalUSDToINR(date);
        const normalized = Number.isFinite(fx) ? fx : null;
        fxByDate.set(date, normalized);
        return normalized;
      }

      for (const inv of investments) {
        // Get all transactions for this investment, ordered by date
        const allTxns = db.prepare(`
          SELECT * FROM transactions
          WHERE investment_id = ?
          ORDER BY transaction_date ASC
        `).all(inv.id);

        // Fetch provider corporate actions (foreign dividends from NASDAQ, splits from Yahoo)
        const ticker = assetType === 'FOREIGN_STOCK'
          ? inv.ticker_symbol
          : (inv.ticker_symbol.includes('.') ? inv.ticker_symbol : toNSETicker(inv.ticker_symbol));
        let actions;
        try {
          actions = await fetchCorporateActions(ticker, yearNum, { assetType });
          const actionWarnings = Array.isArray(actions?.warnings) ? actions.warnings : [];
          for (const warning of actionWarnings) {
            errors.push({ investment: inv.name, error: warning });
          }
        } catch (e) {
          errors.push({ investment: inv.name, error: e.message });
          continue;
        }

        // Determine which portfolios to process
        const processPortfolios = portfolioId
          ? [portfolioId]
          : [...new Set(allTxns.filter(t => t.portfolio_id).map(t => t.portfolio_id))];

        // When processing all portfolios, scope holdingAt to each portfolio
        const scopeByPortfolio = !portfolioId;

        for (const pid of processPortfolios) {

        // Compute holding at any given date, optionally excluding specific transaction IDs.
        // When excludeSameDayTrading is true, same-day BUY/SELL/IPO transactions are
        // excluded so corporate actions are applied only to shares held at record date.
        // When excludeSameDayCorporateUnitAdds is true, same-day BONUS/SPLIT are also excluded
        // (used for dividend entitlement so a same-day bonus doesn't inflate the count).
        const CORPORATE_TYPES = ['BONUS', 'SPLIT', 'RIGHTS', 'MERGER', 'CONSOLIDATION', 'DIVIDEND', 'INTEREST'];
        const SAME_DAY_UNIT_ADD_CORPORATE = ['BONUS', 'SPLIT', 'RIGHTS'];
        function holdingAt(date, excludeIds, excludeSameDayTrading, excludeSameDayCorporateUnitAdds) {
          let units = 0;
          for (const t of allTxns) {
            if (t.transaction_date > date) break;
            if (scopeByPortfolio && t.portfolio_id !== pid) continue;
            if (excludeIds && excludeIds.has(t.id)) continue;
            if (excludeSameDayTrading && t.transaction_date === date && !CORPORATE_TYPES.includes(t.transaction_type)) continue;
            if (excludeSameDayCorporateUnitAdds && t.transaction_date === date && SAME_DAY_UNIT_ADD_CORPORATE.includes(t.transaction_type)) continue;
            if (CORPORATE_ACTION_UNIT_ADD_TYPES.includes(t.transaction_type)) {
              units += t.units || 0;
            } else if (CORPORATE_ACTION_UNIT_SUB_TYPES.includes(t.transaction_type)) {
              units -= t.units || 0;
            }
          }
          return Math.round(units * 1000) / 1000;
        }

        // Determine which broker holds the shares at a given date within this portfolio.
        function brokerAt(date) {
          let broker = null;
          for (const t of allTxns) {
            if (t.transaction_date > date) break;
            if (t.portfolio_id !== pid) continue;
            if (t.broker) {
              if (t.transaction_type !== 'TRANSFER_OUT' && t.transaction_type !== 'SWITCH_OUT') {
                broker = t.broker;
              } else if (!broker) {
                broker = t.broker;
              }
            }
          }
          return broker;
        }

        // Get existing corporate action transactions for this investment/portfolio in this year
        const existingActionsQuery = scopeByPortfolio
          ? `SELECT id, transaction_type, transaction_date, units, amount, price_per_unit, notes, locked, exchange_rate_used, usd_amount
             FROM transactions
             WHERE investment_id = ? AND portfolio_id = ? AND transaction_date BETWEEN ? AND ?
               AND transaction_type IN ('DIVIDEND', 'SPLIT', 'BONUS')`
          : `SELECT id, transaction_type, transaction_date, units, amount, price_per_unit, notes, locked, exchange_rate_used, usd_amount
             FROM transactions
             WHERE investment_id = ? AND transaction_date BETWEEN ? AND ?
               AND transaction_type IN ('DIVIDEND', 'SPLIT', 'BONUS')`;
        const existingActions = scopeByPortfolio
          ? db.prepare(existingActionsQuery).all(inv.id, pid, `${yearNum}-01-01`, `${yearNum}-12-31`)
          : db.prepare(existingActionsQuery).all(inv.id, `${yearNum}-01-01`, `${yearNum}-12-31`);

        // Track which existing actions are matched to Yahoo data
        const matchedExistingIds = new Set();

        // Process dividends
        for (const div of actions.dividends) {
          const isForeignDividend = assetType === 'FOREIGN_STOCK';
          const entitlementDate = isForeignDividend ? (div.record_date || div.date) : div.date;
          const payoutDate = isForeignDividend ? (div.payment_date || div.date) : div.date;
          if (!entitlementDate || !payoutDate) {
            errors.push({
              investment: inv.name,
              error: `Dividend missing required record/payment date (${JSON.stringify(div)})`,
            });
            continue;
          }

          // Dividend entitlement calculated on previous day's holding (ex-date - 1)
          const prevDay = new Date(entitlementDate);
          prevDay.setDate(prevDay.getDate() - 1);
          const prevDayStr = prevDay.toISOString().split('T')[0];
          const holdingUnits = holdingAt(prevDayStr, null, true, true);
          if (holdingUnits <= 0) continue;
          const usdDividendAmount = Math.round(holdingUnits * div.amount * 100) / 100;
          const fxRate = isForeignDividend ? await getFxForDate(payoutDate) : null;
          if (isForeignDividend && !(fxRate > 0)) {
            errors.push({
              investment: inv.name,
              error: `Missing USD/INR FX for ${payoutDate}; cannot compute INR dividend amount`,
            });
            continue;
          }
          const dividendAmount = isForeignDividend
            ? Math.round(usdDividendAmount * fxRate * 100) / 100
            : usdDividendAmount;

          // Match existing dividend strictly by provider date.
          const existing = existingActions.find(e =>
            e.transaction_type === 'DIVIDEND' &&
            e.transaction_date === payoutDate &&
            !matchedExistingIds.has(e.id)
          );

          if (existing) {
            matchedExistingIds.add(existing.id);

            // Locked transactions are never proposed as corrections
            if (existing.locked) continue;

            const dateMatch = existing.transaction_date === payoutDate;
            const amountMatch = Math.abs(existing.amount - dividendAmount) < 1;
            const unitsMatch = existing.units === holdingUnits;
            const priceMatch = existing.price_per_unit != null && Math.abs(existing.price_per_unit - div.amount) < 0.01;
            const usdMatch = !isForeignDividend || (existing.usd_amount != null && Math.abs(existing.usd_amount - usdDividendAmount) < 0.01);
            const fxMatch = !isForeignDividend || (existing.exchange_rate_used != null && Math.abs(existing.exchange_rate_used - fxRate) < 0.01);

            if (dateMatch && amountMatch && unitsMatch && priceMatch && usdMatch && fxMatch) {
              continue; // Perfect match, skip
            }

            corrections.push({
              id: existing.id,
              investment_id: inv.id,
              investment_name: inv.name,
              transaction_type: 'DIVIDEND',
              transaction_date: payoutDate,
              current_units: existing.units,
              current_amount: existing.amount,
              current_price_per_unit: existing.price_per_unit,
              current_date: existing.transaction_date,
              expected_units: holdingUnits,
              expected_amount: dividendAmount,
              expected_price_per_unit: div.amount,
              expected_exchange_rate_used: fxRate,
              expected_usd_amount: isForeignDividend ? usdDividendAmount : null,
              broker: brokerAt(payoutDate),
              portfolio_id: pid,
              currency_symbol: currencySymbol,
              notes: isForeignDividend
                ? `Dividend ${currencySymbol}${div.amount}/share \u00D7 ${holdingUnits} shares (Record ${entitlementDate}, Payment ${payoutDate}, FX \u20B9${fxRate}/$)`
                : `Dividend ${currencySymbol}${div.amount}/share \u00D7 ${holdingUnits} shares`,
            });
            continue;
          }

          suggestions.push({
            investment_id: inv.id,
            investment_name: inv.name,
            transaction_type: 'DIVIDEND',
            transaction_date: payoutDate,
            units: holdingUnits,
            price_per_unit: div.amount,
            amount: dividendAmount,
            exchange_rate_used: fxRate,
            usd_amount: isForeignDividend ? usdDividendAmount : null,
            fees: 0,
            broker: brokerAt(payoutDate),
            portfolio_id: pid,
            currency_symbol: currencySymbol,
            notes: isForeignDividend
              ? `Dividend ${currencySymbol}${div.amount}/share \u00D7 ${holdingUnits} shares (Record ${entitlementDate}, Payment ${payoutDate}, FX \u20B9${fxRate}/$)`
              : `Dividend ${currencySymbol}${div.amount}/share \u00D7 ${holdingUnits} shares`,
          });
        }

        // Process splits
        for (const split of actions.splits) {
          const existing = existingActions.find(e =>
            (e.transaction_type === 'SPLIT' || e.transaction_type === 'BONUS') &&
            e.transaction_date === split.date &&
            !matchedExistingIds.has(e.id)
          );

          const excludeIds = existing ? new Set([existing.id]) : null;
          const holdingUnits = holdingAt(split.date, excludeIds, true);
          if (holdingUnits <= 0) continue;

          const ratio = split.numerator / split.denominator;
          if (ratio <= 1) continue;

          const isCleanSplit = split.denominator === 1 && split.numerator >= 2 && Number.isInteger(ratio);
          const txnType = isCleanSplit ? 'SPLIT' : 'BONUS';
          const rawNewUnits = holdingUnits * (ratio - 1);
          const newUnits = txnType === 'BONUS' ? Math.floor(rawNewUnits) : Math.round(rawNewUnits * 1000) / 1000;
          if (newUnits <= 0) continue;

          // Fractional bonus entitlement → cash payout (using previous day's LOW price)
          const fractional = txnType === 'BONUS' ? Math.round((rawNewUnits - newUnits) * 1e6) / 1e6 : 0;
          let fractionalAmount = 0;
          if (fractional > 0.0001) {
            // Use previous day's LOW price for fractional payout calculation
            const prevDay = new Date(split.date);
            prevDay.setDate(prevDay.getDate() - 1);
            const prevDayStr = prevDay.toISOString().split('T')[0];
            const ohlc = await fetchHistoricalOHLC(ticker, prevDayStr).catch(() => null);
            const lowPrice = ohlc?.low || 0;
            fractionalAmount = lowPrice > 0 ? Math.round(fractional * lowPrice * 100) / 100 : 0;
          }

          if (existing) {
            matchedExistingIds.add(existing.id);

            // Locked transactions are never proposed as corrections
            if (existing.locked) continue;

            const dateMatch = existing.transaction_date === split.date;
            const unitsMatch = (existing.units || 0) === newUnits;
            const typeMatch = existing.transaction_type === txnType;
            const amountMatch = Math.abs((existing.amount || 0) - fractionalAmount) < 1;

            if (dateMatch && unitsMatch && typeMatch && amountMatch) {
              continue;
            }

            corrections.push({
              id: existing.id,
              investment_id: inv.id,
              investment_name: inv.name,
              transaction_type: txnType,
              transaction_date: split.date,
              current_units: existing.units,
              current_amount: existing.amount,
              current_price_per_unit: existing.price_per_unit,
              current_date: existing.transaction_date,
              expected_units: newUnits,
              expected_amount: fractionalAmount,
              expected_price_per_unit: 0,
              broker: brokerAt(split.date),
              portfolio_id: pid,
              notes: fractional > 0.0001
                ? `${txnType === 'BONUS' ? 'Bonus' : 'Split'} ${split.numerator}:${split.denominator} \u2014 +${newUnits} new shares + \u20B9${fractionalAmount} fractional payout (${fractional.toFixed(4)} shares)`
                : `${txnType === 'BONUS' ? 'Bonus' : 'Split'} ${split.numerator}:${split.denominator} \u2014 +${newUnits} new shares`,
            });
            continue;
          }

          suggestions.push({
            investment_id: inv.id,
            investment_name: inv.name,
            transaction_type: txnType,
            transaction_date: split.date,
            units: newUnits,
            price_per_unit: 0,
            amount: fractionalAmount,
            fees: 0,
            broker: brokerAt(split.date),
            portfolio_id: pid,
            notes: fractional > 0.0001
              ? `${txnType === 'BONUS' ? 'Bonus' : 'Split'} ${split.numerator}:${split.denominator} \u2014 ${holdingUnits} held \u2192 +${newUnits} new shares + \u20B9${fractionalAmount} fractional payout (${fractional.toFixed(4)} shares)`
              : `${txnType === 'BONUS' ? 'Bonus' : 'Split'} ${split.numerator}:${split.denominator} \u2014 ${holdingUnits} held \u2192 +${newUnits} new shares`,
          });
        }

        // Any existing actions NOT matched to provider data → suggest deletion (skip locked)
        for (const ea of existingActions) {
          if (!matchedExistingIds.has(ea.id) && !ea.locked) {
            deletions.push({
              id: ea.id,
              investment_id: inv.id,
              investment_name: inv.name,
              transaction_type: ea.transaction_type,
              transaction_date: ea.transaction_date,
              units: ea.units,
              amount: ea.amount,
              price_per_unit: ea.price_per_unit,
              notes: ea.notes,
              reason: 'No matching corporate action found in provider data',
            });
          }
        }

        } // end portfolio loop

        // Small delay to avoid rate limiting
        await new Promise(r => setTimeout(r, 300));
      }

      suggestions.sort((a, b) => a.transaction_date.localeCompare(b.transaction_date));
      corrections.sort((a, b) => a.transaction_date.localeCompare(b.transaction_date));
      deletions.sort((a, b) => a.transaction_date.localeCompare(b.transaction_date));

      res.json({ suggestions, corrections, deletions, errors, year: yearNum });
    } catch (e) {
      res.status(500).json({ error: 'Failed to fetch corporate actions: ' + e.message });
    }
  });

  // ─── Corporate Actions: Import ──────────────────────────────────────────────
  /**
   * POST /api/stocks/corporate-actions/import
   * Import approved corporate action transactions.
   * Body: { transactions: [...] }
   */
  router.post('/corporate-actions/import', (req, res) => {
    try {
      const { transactions, corrections, deletions } = req.body;
      const dirtyCandidates = [];

      const inferPortfolioId = (investmentId) => {
        const row = db.prepare(`
          SELECT portfolio_id
          FROM transactions
          WHERE investment_id = ? AND portfolio_id IS NOT NULL
          ORDER BY transaction_date DESC, id DESC
          LIMIT 1
        `).get(investmentId);
        return row ? row.portfolio_id : null;
      };

      const insert = db.prepare(`
        INSERT INTO transactions (investment_id, transaction_type, transaction_date, units, price_per_unit, amount, fees, notes, broker, portfolio_id, exchange_rate_used, usd_amount)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const update = db.prepare(`
        UPDATE transactions
        SET transaction_date = ?, units = ?, price_per_unit = ?, amount = ?, notes = ?, broker = ?, portfolio_id = ?, exchange_rate_used = ?, usd_amount = ?
        WHERE id = ?
      `);

      const remove = db.prepare(`DELETE FROM transactions WHERE id = ?`);

      let created = 0, skipped = 0, corrected = 0, deleted = 0;

      const runAll = db.transaction(() => {
        // New transactions
        if (transactions && transactions.length) {
          for (const txn of transactions) {
            // Final duplicate check
            const exists = db.prepare(`
              SELECT id FROM transactions
              WHERE investment_id = ? AND transaction_type = ? AND transaction_date = ?
                AND ABS(amount - ?) < 1 AND ABS(COALESCE(units, 0) - ?) < 1
            `).get(txn.investment_id, txn.transaction_type, txn.transaction_date, txn.amount, txn.units || 0);

            if (exists) {
              skipped++;
              continue;
            }

            const portfolioId = txn.portfolio_id ?? inferPortfolioId(txn.investment_id);
            if (portfolioId == null) {
              throw new Error(`Missing portfolio_id for investment_id ${txn.investment_id}. Provide portfolio_id in import payload.`);
            }

            insert.run(
              txn.investment_id, txn.transaction_type, txn.transaction_date,
              txn.units || null, txn.price_per_unit || null, txn.amount, txn.fees || 0, txn.notes || null,
              txn.broker || null, portfolioId, txn.exchange_rate_used || null, txn.usd_amount || null
            );
            dirtyCandidates.push({
              investment_id: txn.investment_id,
              portfolio_id: portfolioId,
              transaction_date: txn.transaction_date,
            });
            created++;
          }
        }

        // Corrections (update existing)
        if (corrections && corrections.length) {
          for (const c of corrections) {
            const existing = db.prepare('SELECT id FROM transactions WHERE id = ?').get(c.id);
            if (!existing) continue;
            const portfolioId = c.portfolio_id ?? inferPortfolioId(c.investment_id);
            if (portfolioId == null) {
              throw new Error(`Missing portfolio_id for corrected transaction id ${c.id}. Provide portfolio_id in correction payload.`);
            }
            update.run(
              c.transaction_date,
              c.expected_units,
              c.expected_price_per_unit,
              c.expected_amount,
              c.notes,
              c.broker || null,
              portfolioId,
              c.expected_exchange_rate_used || null,
              c.expected_usd_amount || null,
              c.id
            );
            dirtyCandidates.push({
              investment_id: c.investment_id,
              portfolio_id: portfolioId,
              transaction_date: c.transaction_date || c.current_date,
            });
            corrected++;
          }
        }

        // Deletions
        if (deletions && deletions.length) {
          for (const d of deletions) {
            const existing = db.prepare('SELECT id, investment_id, portfolio_id, transaction_date FROM transactions WHERE id = ?').get(d.id);
            if (!existing) continue;
            dirtyCandidates.push({
              investment_id: existing.investment_id,
              portfolio_id: existing.portfolio_id,
              transaction_date: existing.transaction_date,
            });
            remove.run(d.id);
            deleted++;
          }
        }
      });

      runAll();
      markDirtyFromTransactions(db, dirtyCandidates, 'corporate-actions-import');
      res.json({ created, skipped, corrected, deleted });
    } catch (e) {
      res.status(500).json({ error: 'Failed to import corporate actions: ' + e.message });
    }
  });

  return router;
};
