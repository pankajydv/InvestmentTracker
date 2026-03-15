const express = require('express');
const multer = require('multer');
const { lookupTickerByISIN } = require('../services/priceService');
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

      // Parse all uploaded files
      const allParsed = [];
      for (const file of req.files) {
        const notes = parseContractNotes(file.buffer, file.originalname);
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

  return router;
};
