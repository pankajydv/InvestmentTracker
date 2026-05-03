const express = require('express');
const multer = require('multer');
const { lookupTickerByISIN, fetchCorporateActions, toNSETicker, fetchHistoricalStockPrice, fetchHistoricalUSDToINR } = require('../services/priceService');
const { parseContractNotes } = require('../services/contractNoteParser');
const { parsePnLStatement } = require('../services/pnlParser');
const { GRANTS, generateRsuSchedule } = require('../services/rsuGrantService');
const { parseOpenLots, parseClosedLots, reconcileVestTransactions } = require('../services/fidelityVestReconciler');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

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
      const { portfolio_id, year } = req.query;
      if (!year) return res.status(400).json({ error: 'year is required' });

      const yearNum = parseInt(year);
      const portfolioId = portfolio_id ? parseInt(portfolio_id) : null;

      // Get all Indian stock investments (optionally scoped to portfolio) that have a ticker
      let investmentQuery;
      let investmentParams;
      if (portfolioId) {
        investmentQuery = `
          SELECT DISTINCT i.id, i.name, i.ticker_symbol
          FROM investments i
          JOIN transactions t ON t.investment_id = i.id AND t.portfolio_id = ?
          WHERE i.asset_type = 'INDIAN_STOCK' AND i.ticker_symbol IS NOT NULL`;
        investmentParams = [portfolioId];
      } else {
        investmentQuery = `
          SELECT DISTINCT i.id, i.name, i.ticker_symbol
          FROM investments i
          WHERE i.asset_type = 'INDIAN_STOCK' AND i.ticker_symbol IS NOT NULL
            AND EXISTS (SELECT 1 FROM transactions t WHERE t.investment_id = i.id)`;
        investmentParams = [];
      }
      const investments = db.prepare(investmentQuery).all(...investmentParams);

      const suggestions = [];
      const corrections = [];
      const deletions = [];
      const errors = [];

      for (const inv of investments) {
        // Get all transactions for this investment, ordered by date
        const allTxns = db.prepare(`
          SELECT * FROM transactions
          WHERE investment_id = ?
          ORDER BY transaction_date ASC
        `).all(inv.id);

        // Fetch from Yahoo Finance (once per investment, outside portfolio loop)
        const ticker = inv.ticker_symbol.includes('.') ? inv.ticker_symbol : toNSETicker(inv.ticker_symbol);
        let actions;
        try {
          actions = await fetchCorporateActions(ticker, yearNum);
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
        const CORPORATE_TYPES = ['BONUS', 'SPLIT', 'RIGHTS', 'MERGER', 'CONSOLIDATION', 'DIVIDEND', 'INTEREST'];
        function holdingAt(date, excludeIds, excludeSameDayTrading) {
          let units = 0;
          for (const t of allTxns) {
            if (t.transaction_date > date) break;
            if (scopeByPortfolio && t.portfolio_id !== pid) continue;
            if (excludeIds && excludeIds.has(t.id)) continue;
            if (excludeSameDayTrading && t.transaction_date === date && !CORPORATE_TYPES.includes(t.transaction_type)) continue;
            if (['BUY', 'IPO', 'BONUS', 'SPLIT', 'RIGHTS', 'TRANSFER_IN', 'SWITCH_IN', 'DEPOSIT'].includes(t.transaction_type)) {
              units += t.units || 0;
            } else if (['SELL', 'TRANSFER_OUT', 'SWITCH_OUT', 'WITHDRAWAL', 'CONSOLIDATION'].includes(t.transaction_type)) {
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
          ? `SELECT id, transaction_type, transaction_date, units, amount, price_per_unit, notes, locked
             FROM transactions
             WHERE investment_id = ? AND portfolio_id = ? AND transaction_date BETWEEN ? AND ?
               AND transaction_type IN ('DIVIDEND', 'SPLIT', 'BONUS')`
          : `SELECT id, transaction_type, transaction_date, units, amount, price_per_unit, notes, locked
             FROM transactions
             WHERE investment_id = ? AND transaction_date BETWEEN ? AND ?
               AND transaction_type IN ('DIVIDEND', 'SPLIT', 'BONUS')`;
        const existingActions = scopeByPortfolio
          ? db.prepare(existingActionsQuery).all(inv.id, pid, `${yearNum}-01-01`, `${yearNum}-12-31`)
          : db.prepare(existingActionsQuery).all(inv.id, `${yearNum}-01-01`, `${yearNum}-12-31`);

        // Track which existing actions are matched to Yahoo data
        const matchedExistingIds = new Set();

        // Helper: check if two dates are within N days of each other
        function daysApart(d1, d2) {
          return Math.abs(new Date(d1) - new Date(d2)) / 86400000;
        }
        const DATE_WINDOW = 20; // days

        // Process dividends
        for (const div of actions.dividends) {
          const holdingUnits = holdingAt(div.date, null, true);
          if (holdingUnits <= 0) continue;

          const dividendAmount = Math.round(holdingUnits * div.amount * 100) / 100;

          // Find any existing dividend within the date window
          const existing = existingActions.find(e =>
            e.transaction_type === 'DIVIDEND' &&
            daysApart(e.transaction_date, div.date) <= DATE_WINDOW &&
            !matchedExistingIds.has(e.id)
          );

          if (existing) {
            matchedExistingIds.add(existing.id);

            // Locked transactions are never proposed as corrections
            if (existing.locked) continue;

            const dateMatch = existing.transaction_date === div.date;
            const amountMatch = Math.abs(existing.amount - dividendAmount) < 1;
            const unitsMatch = existing.units === holdingUnits;
            const priceMatch = existing.price_per_unit != null && Math.abs(existing.price_per_unit - div.amount) < 0.01;

            if (dateMatch && amountMatch && unitsMatch && priceMatch) {
              continue; // Perfect match, skip
            }

            corrections.push({
              id: existing.id,
              investment_id: inv.id,
              investment_name: inv.name,
              transaction_type: 'DIVIDEND',
              transaction_date: div.date,
              current_units: existing.units,
              current_amount: existing.amount,
              current_price_per_unit: existing.price_per_unit,
              current_date: existing.transaction_date,
              expected_units: holdingUnits,
              expected_amount: dividendAmount,
              expected_price_per_unit: div.amount,
              broker: brokerAt(div.date),
              portfolio_id: pid,
              notes: `Dividend \u20B9${div.amount}/share \u00D7 ${holdingUnits} shares`,
            });
            continue;
          }

          suggestions.push({
            investment_id: inv.id,
            investment_name: inv.name,
            transaction_type: 'DIVIDEND',
            transaction_date: div.date,
            units: holdingUnits,
            price_per_unit: div.amount,
            amount: dividendAmount,
            fees: 0,
            broker: brokerAt(div.date),
            portfolio_id: pid,
            notes: `Dividend \u20B9${div.amount}/share \u00D7 ${holdingUnits} shares`,
          });
        }

        // Process splits
        for (const split of actions.splits) {
          const existing = existingActions.find(e =>
            (e.transaction_type === 'SPLIT' || e.transaction_type === 'BONUS') &&
            daysApart(e.transaction_date, split.date) <= DATE_WINDOW &&
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

          if (existing) {
            matchedExistingIds.add(existing.id);

            // Locked transactions are never proposed as corrections
            if (existing.locked) continue;

            const dateMatch = existing.transaction_date === split.date;
            const unitsMatch = (existing.units || 0) === newUnits;
            const typeMatch = existing.transaction_type === txnType;

            if (dateMatch && unitsMatch && typeMatch) {
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
              expected_amount: 0,
              expected_price_per_unit: 0,
              broker: brokerAt(split.date),
              portfolio_id: pid,
              notes: `${txnType === 'BONUS' ? 'Bonus' : 'Split'} ${split.numerator}:${split.denominator} \u2014 +${newUnits} new shares`,
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
            amount: 0,
            fees: 0,
            broker: brokerAt(split.date),
            portfolio_id: pid,
            notes: `${txnType === 'BONUS' ? 'Bonus' : 'Split'} ${split.numerator}:${split.denominator} \u2014 ${holdingUnits} held \u2192 +${newUnits} new shares`,
          });
        }

        // Any existing actions NOT matched to Yahoo data → suggest deletion (skip locked)
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
              reason: 'No matching corporate action found in Yahoo Finance data',
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
        INSERT INTO transactions (investment_id, transaction_type, transaction_date, units, price_per_unit, amount, fees, notes, broker, portfolio_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const update = db.prepare(`
        UPDATE transactions SET transaction_date = ?, units = ?, price_per_unit = ?, amount = ?, notes = ?, broker = ?, portfolio_id = ? WHERE id = ?
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
              txn.broker || null, portfolioId
            );
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
            update.run(c.transaction_date, c.expected_units, c.expected_price_per_unit, c.expected_amount, c.notes, c.broker || null, portfolioId, c.id);
            corrected++;
          }
        }

        // Deletions
        if (deletions && deletions.length) {
          for (const d of deletions) {
            const existing = db.prepare('SELECT id FROM transactions WHERE id = ?').get(d.id);
            if (!existing) continue;
            remove.run(d.id);
            deleted++;
          }
        }
      });

      runAll();
      res.json({ created, skipped, corrected, deleted });
    } catch (e) {
      res.status(500).json({ error: 'Failed to import corporate actions: ' + e.message });
    }
  });

  return router;
};
