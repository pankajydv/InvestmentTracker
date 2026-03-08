const express = require('express');
const multer = require('multer');
const { parseCAS } = require('../services/casParser');
const { lookupTickerByISIN } = require('../services/priceService');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } }); // 20MB max

module.exports = function (db) {
  /**
   * POST /api/cas/preview
   * Upload a CAS PDF and get a preview of detected holdings.
   * Body (multipart): file (PDF), portfolio_id
   */
  router.post('/preview', upload.single('file'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No PDF file uploaded' });
      if (!req.body.portfolio_id) return res.status(400).json({ error: 'portfolio_id is required' });

      const portfolioId = parseInt(req.body.portfolio_id);
      const portfolio = db.prepare('SELECT * FROM portfolios WHERE id = ?').get(portfolioId);
      if (!portfolio) return res.status(404).json({ error: 'Portfolio not found' });
      if (!portfolio.pan_number) return res.status(400).json({ error: 'Portfolio has no PAN number set. Add PAN first.' });

      const result = await parseCAS(req.file.buffer, portfolio.pan_number);

      // Check which holdings already exist in DB for this portfolio
      const existingInvestments = db.prepare(
        'SELECT id, name, asset_type, ticker_symbol, amfi_code, folio_number FROM investments WHERE portfolio_id = ? AND is_active = 1'
      ).all(portfolioId);

      // Mark each parsed holding with existing status
      const markExisting = (holding) => {
        const match = existingInvestments.find(inv => {
          // Match by folio number for RTA MFs
          if (holding.folio && inv.folio_number && inv.folio_number === holding.folio) return true;
          // Match by name similarity (fuzzy)
          const nameNorm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
          if (nameNorm(inv.name).includes(nameNorm(holding.name).substring(0, 15))) return true;
          if (nameNorm(holding.name).includes(nameNorm(inv.name).substring(0, 15))) return true;
          return false;
        });
        return {
          ...holding,
          existingInvestmentId: match?.id || null,
          existingName: match?.name || null,
          isNew: !match,
        };
      };

      const stocks = result.stocks.map(markExisting);
      const mutualFunds = result.mutualFunds.map(markExisting);
      const bonds = result.bonds.map(markExisting);

      res.json({
        investorName: result.investorName,
        portfolioValue: result.portfolioValue,
        stocks,
        mutualFunds,
        bonds,
        summary: result.summary,
      });
    } catch (e) {
      console.error('CAS parse error:', e);
      if (e.message?.includes('password') || e.message?.includes('decrypt')) {
        return res.status(400).json({ error: 'Wrong password (PAN number). Cannot decrypt PDF.' });
      }
      res.status(500).json({ error: 'Failed to parse CAS PDF: ' + e.message });
    }
  });

  /**
   * POST /api/cas/import
   * Import selected holdings from a CAS preview into the database.
   * Body (JSON): { portfolio_id, holdings: [{ isin, name, asset_type, units, price, value, invested, folio, nav, source }] }
   */
  router.post('/import', express.json(), async (req, res) => {
    try {
      const { portfolio_id, holdings } = req.body;
      if (!portfolio_id || !holdings?.length) {
        return res.status(400).json({ error: 'portfolio_id and holdings array required' });
      }

      const portfolio = db.prepare('SELECT * FROM portfolios WHERE id = ?').get(portfolio_id);
      if (!portfolio) return res.status(404).json({ error: 'Portfolio not found' });

      // Resolve ticker symbols for stocks via ISIN lookup (before DB transaction)
      for (const h of holdings) {
        if ((h.asset_type === 'INDIAN_STOCK') && h.isin) {
          try {
            const ticker = await lookupTickerByISIN(h.isin);
            if (ticker) h._resolvedTicker = ticker;
          } catch (e) {
            console.warn(`Could not resolve ticker for ${h.name} (${h.isin}):`, e.message);
          }
        }
      }

      const insertInvestment = db.prepare(`
        INSERT INTO investments (name, asset_type, ticker_symbol, amfi_code, folio_number, currency, portfolio_id, notes)
        VALUES (?, ?, ?, ?, ?, 'INR', ?, ?)
      `);

      const insertTransaction = db.prepare(`
        INSERT INTO transactions (investment_id, transaction_type, transaction_date, units, price_per_unit, amount)
        VALUES (?, 'BUY', ?, ?, ?, ?)
      `);

      const today = new Date().toISOString().split('T')[0];
      const results = [];

      const importTxn = db.transaction(() => {
        for (const h of holdings) {
          const assetType = h.asset_type || 'MUTUAL_FUND';
          const tickerSymbol = h._resolvedTicker || null;
          const amfiCode = null;  // We have ISIN, not AMFI code
          const folio = h.folio || null;
          const notes = `Imported from CAS PDF. ISIN: ${h.isin}`;

          const inv = insertInvestment.run(
            h.name, assetType, tickerSymbol, amfiCode, folio, portfolio_id, notes
          );

          // Create initial BUY transaction
          const units = h.units || 0;
          const pricePerUnit = h.nav || h.price || 0;
          const amount = h.invested || h.value || (units * pricePerUnit);

          if (units > 0 && amount > 0) {
            insertTransaction.run(inv.lastInsertRowid, today, units, pricePerUnit, amount);
          }

          results.push({
            id: inv.lastInsertRowid,
            name: h.name,
            type: assetType,
            units,
            value: h.value,
          });
        }
      });

      importTxn();

      res.json({
        success: true,
        imported: results.length,
        investments: results,
      });
    } catch (e) {
      console.error('CAS import error:', e);
      res.status(500).json({ error: 'Failed to import: ' + e.message });
    }
  });

  return router;
};
