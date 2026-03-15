const express = require('express');
const multer = require('multer');
const { lookupTickerByISIN, fetchCorporateActions, toNSETicker } = require('../services/priceService');
const { parseContractNotes } = require('../services/contractNoteParser');
const { parsePnLStatement } = require('../services/pnlParser');

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

      // Parse all uploaded files (pass PAN as password for encrypted PDFs)
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
          chargesBreakdown: allParsed[0].charges || {},
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
        'SELECT id, name, ticker_symbol FROM investments WHERE portfolio_id = ? AND asset_type = ? AND (ticker_symbol = ? OR name = ?)'
      );
      const insertInvestment = db.prepare(`
        INSERT INTO investments (name, asset_type, portfolio_id, ticker_symbol, currency, broker, notes, is_active)
        VALUES (?, 'INDIAN_STOCK', ?, ?, 'INR', ?, ?, 1)
      `);
      // Idempotent: find existing transaction by key fields
      const findTransaction = db.prepare(`
        SELECT id, amount, fees FROM transactions
        WHERE investment_id = ? AND transaction_type = ? AND transaction_date = ? AND units = ? AND price_per_unit = ?
      `);
      const insertTransaction = db.prepare(`
        INSERT INTO transactions (investment_id, transaction_type, transaction_date, units, price_per_unit, amount, fees, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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

          let existing = null;
          if (tickerSymbol) {
            existing = findInvestment.get(portfolioId, 'INDIAN_STOCK', tickerSymbol, displayName);
          }
          if (!existing) {
            existing = findInvestment.get(portfolioId, 'INDIAN_STOCK', displayName, displayName);
          }

          let investmentId;
          if (existing) {
            investmentId = existing.id;
          } else {
            const result = insertInvestment.run(
              displayName, portfolioId, tickerSymbol, broker || 'Unknown',
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
              const newFees = fees > 0 ? fees : existingTxn.fees;
              if (Math.abs(existingTxn.amount - amount) > 0.01 || Math.abs(existingTxn.fees - newFees) > 0.01) {
                updateTransaction.run(amount, newFees, notes, existingTxn.id);
                transactionsUpdated++;
              } else {
                transactionsSkipped++;
              }
            } else {
              insertTransaction.run(
                investmentId, trade.type, trade.tradeDate, trade.quantity,
                trade.rate, amount, fees, notes
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
        INSERT INTO investments (name, asset_type, portfolio_id, ticker_symbol, currency, broker, notes, is_active)
        VALUES (?, 'INDIAN_STOCK', ?, ?, 'INR', ?, ?, 1)
      `);
      const findInvestment = db.prepare(
        'SELECT id FROM investments WHERE portfolio_id = ? AND asset_type = ? AND (ticker_symbol = ? OR name = ?)'
      );
      const insertTransaction = db.prepare(`
        INSERT INTO transactions (investment_id, transaction_type, transaction_date, units, price_per_unit, amount, fees, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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

          let existing = null;
          if (tickerSymbol) {
            existing = findInvestment.get(portfolioId, 'INDIAN_STOCK', tickerSymbol, displayName);
          }
          if (!existing) {
            existing = findInvestment.get(portfolioId, 'INDIAN_STOCK', displayName, displayName);
          }

          let investmentId;
          if (existing) {
            investmentId = existing.id;
          } else {
            const result = insertInvestment.run(
              displayName, portfolioId, tickerSymbol, broker,
              `Imported from ${broker} P&L statement`
            );
            investmentId = result.lastInsertRowid;
            investmentsCreated++;
          }

          for (const trade of stock.trades) {
            const amount = trade.quantity * trade.rate;
            const fees = trade.fees || 0;
            insertTransaction.run(
              investmentId, trade.type, trade.tradeDate, trade.quantity,
              trade.rate, amount, fees, `${broker} P&L import`
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
   * Record an AMC / maintenance charge or refund against the portfolio.
   * Auto-creates a "Demat Account Charges" investment if it doesn't exist.
   * Body: { portfolio_id, date, amount, broker, notes }
   */
  router.post('/amc-charge', express.json(), (req, res) => {
    try {
      const { portfolio_id, date, amount, broker, notes } = req.body;
      if (!portfolio_id) return res.status(400).json({ error: 'portfolio_id is required' });
      if (!date) return res.status(400).json({ error: 'date is required' });
      if (!amount || amount <= 0) return res.status(400).json({ error: 'amount must be positive' });

      const portfolio = db.prepare('SELECT * FROM portfolios WHERE id = ?').get(portfolio_id);
      if (!portfolio) return res.status(404).json({ error: 'Portfolio not found' });

      // Find or create the "Demat Account Charges" investment for this portfolio
      const investmentName = 'Demat Account Charges';
      let investment = db.prepare(
        'SELECT * FROM investments WHERE name = ? AND asset_type = ? AND portfolio_id = ?'
      ).get(investmentName, 'INDIAN_STOCK', portfolio_id);

      if (!investment) {
        const result = db.prepare(
          'INSERT INTO investments (name, asset_type, portfolio_id, broker, notes) VALUES (?, ?, ?, ?, ?)'
        ).run(investmentName, 'INDIAN_STOCK', portfolio_id, broker || null, 'Demat/trading account charges');
        investment = { id: result.lastInsertRowid };
      }

      // Store as AMC type: units=0, price=0, amount=0, fees=charge amount (negative for charge, positive for refund)
      const fees = parseFloat(amount);

      db.prepare(
        'INSERT INTO transactions (investment_id, transaction_type, transaction_date, units, price_per_unit, amount, fees, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(investment.id, 'AMC', date, 0, 0, 0, fees, notes || 'AMC/Maintenance charge');

      res.json({ success: true, investment_id: investment.id });
    } catch (e) {
      console.error('AMC charge error:', e);
      res.status(500).json({ error: 'Failed to record charge: ' + e.message });
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
      if (!portfolio_id || !year) return res.status(400).json({ error: 'portfolio_id and year are required' });

      const yearNum = parseInt(year);
      const portfolioId = parseInt(portfolio_id);

      // Get all Indian stock investments in this portfolio that have a ticker
      const investments = db.prepare(`
        SELECT i.id, i.name, i.ticker_symbol
        FROM investments i
        WHERE i.portfolio_id = ? AND i.asset_type = 'INDIAN_STOCK' AND i.ticker_symbol IS NOT NULL
      `).all(portfolioId);

      const suggestions = [];
      const corrections = [];
      const deletions = [];
      const errors = [];

      for (const inv of investments) {
        // Get all transactions for this investment up to end of year, ordered by date
        const allTxns = db.prepare(`
          SELECT * FROM transactions
          WHERE investment_id = ?
          ORDER BY transaction_date ASC
        `).all(inv.id);

        // Compute holding at any given date, optionally excluding specific transaction IDs
        function holdingAt(date, excludeIds) {
          let units = 0;
          for (const t of allTxns) {
            if (t.transaction_date > date) break;
            if (excludeIds && excludeIds.has(t.id)) continue;
            if (['BUY', 'IPO', 'BONUS', 'SPLIT', 'RIGHTS', 'TRANSFER_IN', 'DEPOSIT'].includes(t.transaction_type)) {
              units += t.units || 0;
            } else if (['SELL', 'TRANSFER_OUT', 'WITHDRAWAL', 'CONSOLIDATION'].includes(t.transaction_type)) {
              units -= t.units || 0;
            }
          }
          return Math.round(units * 1000) / 1000;
        }

        // Get existing corporate action transactions for this investment in this year
        const existingActions = db.prepare(`
          SELECT id, transaction_type, transaction_date, units, amount, price_per_unit, notes
          FROM transactions
          WHERE investment_id = ? AND transaction_date BETWEEN ? AND ?
            AND transaction_type IN ('DIVIDEND', 'SPLIT', 'BONUS')
        `).all(inv.id, `${yearNum}-01-01`, `${yearNum}-12-31`);

        // Fetch from Yahoo Finance
        const ticker = inv.ticker_symbol.includes('.') ? inv.ticker_symbol : toNSETicker(inv.ticker_symbol);
        let actions;
        try {
          actions = await fetchCorporateActions(ticker, yearNum);
        } catch (e) {
          errors.push({ investment: inv.name, error: e.message });
          continue;
        }

        // Track which existing actions are matched to Yahoo data
        const matchedExistingIds = new Set();

        // Helper: check if two dates are within N days of each other
        // Yahoo returns ex-date; users may record record-date or payment-date (up to ~20 days later)
        function daysApart(d1, d2) {
          return Math.abs(new Date(d1) - new Date(d2)) / 86400000;
        }
        const DATE_WINDOW = 20; // days

        // Process dividends
        for (const div of actions.dividends) {
          const holdingUnits = holdingAt(div.date);
          if (holdingUnits <= 0) continue; // Not holding on this date

          const dividendAmount = Math.round(holdingUnits * div.amount * 100) / 100;

          // Find any existing dividend within the date window
          const existing = existingActions.find(e =>
            e.transaction_type === 'DIVIDEND' &&
            daysApart(e.transaction_date, div.date) <= DATE_WINDOW &&
            !matchedExistingIds.has(e.id)
          );

          if (existing) {
            matchedExistingIds.add(existing.id);
            // Check if all fields match exactly — truly nothing to fix
            const dateMatch = existing.transaction_date === div.date;
            const amountMatch = Math.abs(existing.amount - dividendAmount) < 1;
            const unitsMatch = existing.units === holdingUnits;
            const priceMatch = existing.price_per_unit != null && Math.abs(existing.price_per_unit - div.amount) < 0.01;

            if (dateMatch && amountMatch && unitsMatch && priceMatch) {
              continue; // Perfect match, skip
            }

            // Something differs — suggest correction
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
              notes: `Dividend ₹${div.amount}/share × ${holdingUnits} shares`,
            });
            continue;
          }

          // No match at all — new suggestion
          suggestions.push({
            investment_id: inv.id,
            investment_name: inv.name,
            transaction_type: 'DIVIDEND',
            transaction_date: div.date,
            units: holdingUnits,
            price_per_unit: div.amount,
            amount: dividendAmount,
            fees: 0,
            notes: `Dividend ₹${div.amount}/share × ${holdingUnits} shares`,
          });
        }

        // Process splits (Yahoo gives numerator:denominator, e.g., 2:1 means 1 share becomes 2)
        for (const split of actions.splits) {
          // Find any existing split/bonus within the date window first,
          // so we can exclude it from holding calculation (avoid circular count)
          const existing = existingActions.find(e =>
            (e.transaction_type === 'SPLIT' || e.transaction_type === 'BONUS') &&
            daysApart(e.transaction_date, split.date) <= DATE_WINDOW &&
            !matchedExistingIds.has(e.id)
          );

          const excludeIds = existing ? new Set([existing.id]) : null;
          const holdingUnits = holdingAt(split.date, excludeIds);
          if (holdingUnits <= 0) continue;

          const ratio = split.numerator / split.denominator;
          if (ratio <= 1) continue; // Not a forward split or bonus

          // Bonus vs Split heuristic:
          // Yahoo encodes bonus 1:N as (N+1):N (e.g., bonus 1:10 → 11:10, bonus 1:1 → 2:1)
          // True splits are typically 2:1, 5:1, 10:1 where ratio is a clean integer ≥ 2
          // If ratio is a whole number ≥ 2 and denominator is 1, it's a split; otherwise bonus
          const isCleanSplit = split.denominator === 1 && split.numerator >= 2 && Number.isInteger(ratio);
          const txnType = isCleanSplit ? 'SPLIT' : 'BONUS';
          // Bonus: only whole shares allocated (floor). Splits: exact fractional calculation.
          const rawNewUnits = holdingUnits * (ratio - 1);
          const newUnits = txnType === 'BONUS' ? Math.floor(rawNewUnits) : Math.round(rawNewUnits * 1000) / 1000;
          if (newUnits <= 0) continue; // Not enough holding for any bonus shares

          if (existing) {
            matchedExistingIds.add(existing.id);
            const dateMatch = existing.transaction_date === split.date;
            const unitsMatch = (existing.units || 0) === newUnits;
            const typeMatch = existing.transaction_type === txnType;

            if (dateMatch && unitsMatch && typeMatch) {
              continue; // Perfect match
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
              notes: `${txnType === 'BONUS' ? 'Bonus' : 'Split'} ${split.numerator}:${split.denominator} — +${newUnits} new shares`,
            });
            continue;
          }

          // No match — new suggestion
          suggestions.push({
            investment_id: inv.id,
            investment_name: inv.name,
            transaction_type: txnType,
            transaction_date: split.date,
            units: newUnits,
            price_per_unit: 0,
            amount: 0,
            fees: 0,
            notes: `${txnType === 'BONUS' ? 'Bonus' : 'Split'} ${split.numerator}:${split.denominator} — ${holdingUnits} held → +${newUnits} new shares`,
          });
        }

        // Any existing actions NOT matched to Yahoo data → suggest deletion
        for (const ea of existingActions) {
          if (!matchedExistingIds.has(ea.id)) {
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

      const insert = db.prepare(`
        INSERT INTO transactions (investment_id, transaction_type, transaction_date, units, price_per_unit, amount, fees, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const update = db.prepare(`
        UPDATE transactions SET transaction_date = ?, units = ?, price_per_unit = ?, amount = ?, notes = ? WHERE id = ?
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

            insert.run(
              txn.investment_id, txn.transaction_type, txn.transaction_date,
              txn.units || null, txn.price_per_unit || null, txn.amount, txn.fees || 0, txn.notes || null
            );
            created++;
          }
        }

        // Corrections (update existing)
        if (corrections && corrections.length) {
          for (const c of corrections) {
            const existing = db.prepare('SELECT id FROM transactions WHERE id = ?').get(c.id);
            if (!existing) continue;
            update.run(c.transaction_date, c.expected_units, c.expected_price_per_unit, c.expected_amount, c.notes, c.id);
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
