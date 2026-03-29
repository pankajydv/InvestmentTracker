const express = require('express');
const multer = require('multer');
const { parseCAS } = require('../services/casParser');
const { parseCAMSCAS } = require('../services/camsCasParser');
const { parseNSDLCAS } = require('../services/nsdlCasParser');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } }); // 20MB max

module.exports = function (db) {

  // ─── Helpers for CAMS delta detection ───────────────────────────────

  /**
   * Build a set of existing transaction keys for fast delta lookup.
   * Key = isin|date|type|amount|units (rounded to avoid float mismatch)
   */
  function getExistingTransactionKeys(portfolioId) {
    const rows = db.prepare(`
      SELECT i.isin_code, t.transaction_date, t.transaction_type, t.amount, t.units
      FROM transactions t
      JOIN investments i ON i.id = t.investment_id
      WHERE t.portfolio_id = ? AND i.asset_type = 'MUTUAL_FUND'
    `).all(portfolioId);

    const keys = new Set();
    for (const r of rows) {
      if (!r.isin_code) continue;
      const key = [
        r.isin_code,
        r.transaction_date,
        r.transaction_type,
        Math.round(Math.abs(r.amount || 0) * 100),
        Math.round(Math.abs(r.units || 0) * 1000),
      ].join('|');
      keys.add(key);
    }
    return keys;
  }

  function makeTxnKey(isin, date, type, amount, units) {
    return [
      isin,
      date,
      type,
      Math.round(Math.abs(amount || 0) * 100),
      Math.round(Math.abs(units || 0) * 1000),
    ].join('|');
  }

  /**
   * POST /api/cas/preview
   * Upload a CAS PDF and get a preview of detected holdings.
   * Auto-detects CDSL vs CAMS/KFintech CAS.
   * Body (multipart): file (PDF), portfolio_id
   */
  router.post('/preview', upload.single('file'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No PDF file uploaded' });
      if (!req.body.portfolio_id) return res.status(400).json({ error: 'portfolio_id is required' });

      const portfolioId = parseInt(req.body.portfolio_id);
      const portfolio = db.prepare('SELECT * FROM portfolios WHERE id = ?').get(portfolioId);
      if (!portfolio) return res.status(404).json({ error: 'Portfolio not found' });

      const password = req.body.password || portfolio.pan_number;
      if (!password) return res.status(400).json({ error: 'No password provided and portfolio has no PAN number set. Please enter the PDF password or add PAN to the portfolio first.' });

      // Try CAMS/KFintech parser first
      let camsParsed = null;
      try {
        camsParsed = await parseCAMSCAS(req.file.buffer, password);
      } catch (_) { /* not a CAMS CAS — fall through to CDSL */ }

      if (camsParsed && camsParsed.schemes && camsParsed.schemes.length > 0) {
        // ── CAMS/KFintech CAS (transaction history) ──
        const existingKeys = getExistingTransactionKeys(portfolioId);

        // Find existing investments by ISIN for matching
        const existingByIsin = {};
        const invRows = db.prepare(
          `SELECT DISTINCT i.id, i.name, i.isin_code, i.folio_number
           FROM investments i
           JOIN transactions t ON t.investment_id = i.id AND t.portfolio_id = ?
           WHERE i.is_active = 1 AND i.asset_type = 'MUTUAL_FUND'`
        ).all(portfolioId);
        for (const inv of invRows) {
          if (inv.isin_code) existingByIsin[inv.isin_code] = inv;
        }

        const schemes = camsParsed.schemes.map(s => {
          const existingInv = existingByIsin[s.isin] || null;
          const transactions = s.transactions.map(t => {
            const key = makeTxnKey(s.isin, t.date, t.type, t.amount, t.units);
            return { ...t, isNew: !existingKeys.has(key) };
          });
          const newTxns = transactions.filter(t => t.isNew);
          return {
            amc: s.amc,
            schemeCode: s.schemeCode,
            schemeName: s.schemeName,
            isin: s.isin,
            folio: s.folio,
            registrar: s.registrar,
            closingBalance: s.closingBalance,
            totalCostValue: s.totalCostValue,
            latestNav: s.latestNav,
            marketValue: s.marketValue,
            exitLoad: s.exitLoad,
            existingInvestmentId: existingInv?.id || null,
            existingName: existingInv?.name || null,
            isNew: !existingInv,
            transactions,
            newTransactionCount: newTxns.length,
            existingTransactionCount: transactions.length - newTxns.length,
          };
        });

        const totalTxns = schemes.reduce((s, sc) => s + sc.transactions.length, 0);
        const newTxns = schemes.reduce((s, sc) => s + sc.newTransactionCount, 0);

        return res.json({
          casType: 'cams',
          investorName: camsParsed.investorName,
          dateRange: camsParsed.dateRange,
          schemes,
          summary: {
            totalSchemes: schemes.length,
            activeSchemes: schemes.filter(s => s.closingBalance > 0).length,
            closedSchemes: schemes.filter(s => s.closingBalance === 0).length,
            totalTransactions: totalTxns,
            newTransactions: newTxns,
            existingTransactions: totalTxns - newTxns,
          },
        });
      }

      // ── CDSL CAS (holdings snapshot) ──
      let cdslParsed = null;
      try {
        cdslParsed = await parseCAS(req.file.buffer, password);
      } catch (_) { /* not a CDSL CAS — fall through to NSDL */ }

      if (cdslParsed && cdslParsed.mutualFunds.length > 0) {
        // Check which holdings already exist in DB for this portfolio
        const existingInvestments = db.prepare(
          `SELECT DISTINCT i.id, i.name, i.asset_type, i.ticker_symbol, i.amfi_code, i.folio_number
           FROM investments i
           JOIN transactions t ON t.investment_id = i.id AND t.portfolio_id = ?
           WHERE i.is_active = 1`
        ).all(portfolioId);

        const markExisting = (holding) => {
          const match = existingInvestments.find(inv => {
            if (holding.folio && inv.folio_number && inv.folio_number === holding.folio) return true;
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

        const mutualFunds = cdslParsed.mutualFunds.map(markExisting);
        return res.json({
          casType: 'cdsl',
          investorName: cdslParsed.investorName,
          portfolioValue: cdslParsed.portfolioValue,
          mutualFunds,
          summary: {
            totalMFs: mutualFunds.length,
            totalHoldings: mutualFunds.length,
          },
        });
      }

      // ── NSDL CAS (holdings snapshot) — final fallback ──
      let nsdlParsed = null;
      try {
        nsdlParsed = await parseNSDLCAS(req.file.buffer, password);
      } catch (_) { /* not an NSDL CAS either */ }

      if (nsdlParsed && nsdlParsed.mutualFunds.length > 0) {
        const existingInvestments = db.prepare(
          `SELECT DISTINCT i.id, i.name, i.asset_type, i.ticker_symbol, i.amfi_code, i.folio_number
           FROM investments i
           JOIN transactions t ON t.investment_id = i.id AND t.portfolio_id = ?
           WHERE i.is_active = 1`
        ).all(portfolioId);

        const markExistingNSDL = (holding) => {
          const match = existingInvestments.find(inv => {
            if (holding.isin && inv.isin_code && inv.isin_code === holding.isin) return true;
            if (holding.folio && inv.folio_number && inv.folio_number === holding.folio) return true;
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

        const mutualFunds = nsdlParsed.mutualFunds.map(markExistingNSDL);
        return res.json({
          casType: 'nsdl',
          investorName: nsdlParsed.investorName,
          portfolioValue: nsdlParsed.portfolioValue,
          statementPeriod: nsdlParsed.statementPeriod,
          mutualFunds,
          summary: {
            totalMFs: mutualFunds.length,
            totalHoldings: mutualFunds.length,
          },
        });
      }

      // None of the parsers matched
      throw new Error('Could not detect CAS type. The PDF may not be a supported CAS format (CAMS/KFintech, CDSL, or NSDL).');
    } catch (e) {
      console.error('CAS parse error:', e);
      if (e.message?.includes('password') || e.message?.includes('decrypt')) {
        return res.status(400).json({ error: 'Wrong password (PAN number). Cannot decrypt PDF.' });
      }
      res.status(500).json({ error: 'Failed to parse CAS PDF: ' + e.message });
    }
  });

  /**
   * POST /api/cas/cams-import
   * Import selected CAMS/KFintech CAS transactions into the database.
   * Body (JSON): { portfolio_id, schemes: [{ isin, schemeName, folio, amc, transactions: [...] }] }
   */
  router.post('/cams-import', express.json(), async (req, res) => {
    try {
      const { portfolio_id, schemes } = req.body;
      if (!portfolio_id || !schemes?.length) {
        return res.status(400).json({ error: 'portfolio_id and schemes array required' });
      }
      const portfolioId = parseInt(portfolio_id);
      const portfolio = db.prepare('SELECT * FROM portfolios WHERE id = ?').get(portfolioId);
      if (!portfolio) return res.status(404).json({ error: 'Portfolio not found' });

      const findByIsin = db.prepare('SELECT id, name FROM investments WHERE isin_code = ? AND is_active = 1');
      const findByFolio = db.prepare('SELECT id, name FROM investments WHERE folio_number = ? AND is_active = 1');

      const insertInvestment = db.prepare(`
        INSERT INTO investments (name, asset_type, ticker_symbol, folio_number, isin_code, currency, notes)
        VALUES (?, 'MUTUAL_FUND', NULL, ?, ?, 'INR', ?)
      `);

      const insertTransaction = db.prepare(`
        INSERT INTO transactions (investment_id, portfolio_id, transaction_type, transaction_date, units, price_per_unit, amount, fees, broker, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      // Build existing keys to skip duplicates (double safety — preview already filtered)
      const existingKeys = getExistingTransactionKeys(portfolioId);

      let importedCount = 0;
      let skippedCount = 0;
      const results = [];

      const importTxn = db.transaction(() => {
        for (const scheme of schemes) {
          const isin = scheme.isin;
          const folio = scheme.folio || null;
          const schemeName = scheme.schemeName;

          // Find or create investment
          let investmentId = null;
          if (isin) {
            const byIsin = findByIsin.get(isin);
            if (byIsin) investmentId = byIsin.id;
          }
          if (!investmentId && folio) {
            const byFolio = findByFolio.get(folio);
            if (byFolio) investmentId = byFolio.id;
          }
          if (!investmentId) {
            const inv = insertInvestment.run(
              schemeName, folio, isin,
              `Imported from CAMS/KFintech CAS. AMC: ${scheme.amc || ''}`
            );
            investmentId = inv.lastInsertRowid;
          } else {
            // Backfill isin/folio if missing
            if (isin) db.prepare('UPDATE investments SET isin_code = COALESCE(isin_code, ?) WHERE id = ?').run(isin, investmentId);
            if (folio) db.prepare('UPDATE investments SET folio_number = COALESCE(folio_number, ?) WHERE id = ?').run(folio, investmentId);
          }

          let schemeImported = 0;
          for (const t of (scheme.transactions || [])) {
            // Skip non-new transactions
            const key = makeTxnKey(isin, t.date, t.type, t.amount, t.units);
            if (existingKeys.has(key)) { skippedCount++; continue; }

            const fees = (t.stampDuty || 0) + (t.stt || 0);
            const feeNotes = [];
            if (t.stampDuty > 0) feeNotes.push(`Stamp Duty: ₹${t.stampDuty}`);
            if (t.stt > 0) feeNotes.push(`STT: ₹${t.stt}`);
            const notes = [t.description || '', ...feeNotes].filter(Boolean).join('; ');

            insertTransaction.run(
              investmentId, portfolioId,
              t.type, t.date,
              Math.abs(t.units || 0), t.price || 0, Math.abs(t.amount || 0),
              fees, 'CAMS CAS', notes
            );
            existingKeys.add(key); // prevent duplicates within same import
            importedCount++;
            schemeImported++;
          }

          results.push({ id: investmentId, name: schemeName, isin, imported: schemeImported });
        }
      });

      importTxn();

      res.json({
        success: true,
        imported: importedCount,
        skipped: skippedCount,
        schemes: results,
      });
    } catch (e) {
      console.error('CAMS CAS import error:', e);
      res.status(500).json({ error: 'Failed to import: ' + e.message });
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

      // Only allow mutual fund holdings from CAS import
      const mfHoldings = holdings.filter(h => (h.asset_type || 'MUTUAL_FUND') === 'MUTUAL_FUND');
      if (mfHoldings.length === 0) {
        return res.status(400).json({ error: 'No mutual fund holdings to import. CAS import only supports mutual funds.' });
      }

      const findByIsin = db.prepare(
        'SELECT id, name FROM investments WHERE isin_code = ? AND is_active = 1'
      );
      const findByFolio = db.prepare(
        'SELECT id, name FROM investments WHERE folio_number = ? AND is_active = 1'
      );

      const insertInvestment = db.prepare(`
        INSERT INTO investments (name, asset_type, folio_number, isin_code, currency, notes)
        VALUES (?, 'MUTUAL_FUND', ?, ?, 'INR', ?)
      `);

      const insertTransaction = db.prepare(`
        INSERT INTO transactions (investment_id, portfolio_id, transaction_type, transaction_date, units, price_per_unit, amount)
        VALUES (?, ?, 'BUY', ?, ?, ?, ?)
      `);

      const today = new Date().toISOString().split('T')[0];
      const results = [];

      const importTxn = db.transaction(() => {
        for (const h of mfHoldings) {
          const folio = h.folio || null;
          const notes = `Imported from CAS PDF. ISIN: ${h.isin}`;

          // Check for existing investment by ISIN or folio
          let existingId = null;
          if (h.isin) {
            const byIsin = findByIsin.get(h.isin);
            if (byIsin) existingId = byIsin.id;
          }
          if (!existingId && folio) {
            const byFolio = findByFolio.get(folio);
            if (byFolio) existingId = byFolio.id;
          }

          let investmentId;
          if (existingId) {
            investmentId = existingId;
            // Backfill isin_code if missing
            if (h.isin) {
              db.prepare('UPDATE investments SET isin_code = COALESCE(isin_code, ?) WHERE id = ?').run(h.isin, investmentId);
            }
          } else {
            const inv = insertInvestment.run(
              h.name, folio, h.isin || null, notes
            );
            investmentId = inv.lastInsertRowid;
          }

          // Create initial BUY transaction
          const units = h.units || 0;
          const pricePerUnit = h.nav || h.price || 0;
          const amount = h.invested || h.value || (units * pricePerUnit);

          if (units > 0 && amount > 0) {
            insertTransaction.run(investmentId, portfolio_id, today, units, pricePerUnit, amount);
          }

          results.push({
            id: investmentId,
            name: h.name,
            type: 'MUTUAL_FUND',
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
