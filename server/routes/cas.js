const express = require('express');
const multer = require('multer');
const { parseCAS } = require('../services/casParser');
const { parseCAMSCAS } = require('../services/camsCasParser');
const { parseNSDLCAS } = require('../services/nsdlCasParser');
const { markDirtyFromTransactions } = require('../services/dirtyBackfillService');
const { logAppInfo, logAppError } = require('../services/appLogger');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } }); // 20MB max

module.exports = function (db) {

  // ─── Helpers for CAMS delta detection ───────────────────────────────

  /**
   * Build a set of existing transaction keys for fast delta lookup.
   * Key = isin|date|type|amount|units|folio (rounded to avoid float mismatch)
   */
  function getExistingTransactionKeys(portfolioId) {
    const rows = db.prepare(`
      SELECT i.isin_code, t.transaction_date, t.transaction_type, t.amount, t.units, t.folio_number
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
        normalizeTxnType(r.transaction_type),
        Math.round(Math.abs(r.amount || 0) * 100),
        Math.round(Math.abs(r.units || 0) * 1000),
        (r.folio_number || '').replace(/\s/g, ''),
      ].join('|');
      keys.add(key);
    }
    return keys;
  }

  // Like getExistingTransactionKeys but returns key → { id, fees, stt, locked }
  // so an import can UPDATE STT/fees on already-present transactions.
  function getExistingTransactionMap(portfolioId) {
    const rows = db.prepare(`
      SELECT t.id, i.isin_code, t.transaction_date, t.transaction_type, t.amount, t.units, t.folio_number, t.fees, t.stt, t.locked
      FROM transactions t
      JOIN investments i ON i.id = t.investment_id
      WHERE t.portfolio_id = ? AND i.asset_type = 'MUTUAL_FUND'
    `).all(portfolioId);
    const map = new Map();
    for (const r of rows) {
      if (!r.isin_code) continue;
      const key = [
        r.isin_code,
        r.transaction_date,
        normalizeTxnType(r.transaction_type),
        Math.round(Math.abs(r.amount || 0) * 100),
        Math.round(Math.abs(r.units || 0) * 1000),
        (r.folio_number || '').replace(/\s/g, ''),
      ].join('|');
      map.set(key, { id: r.id, fees: r.fees, stt: r.stt, locked: r.locked });
    }
    return map;
  }

  /**
   * Normalize transaction type for duplicate comparison.
   * SWITCH_IN and BUY are equivalent, SWITCH_OUT and SELL are equivalent.
   */
  function normalizeTxnType(type) {
    if (type === 'SWITCH_IN') return 'BUY';
    if (type === 'SWITCH_OUT') return 'SELL';
    return type;
  }

  function makeTxnKey(isin, date, type, amount, units, folio) {
    return [
      isin,
      date,
      normalizeTxnType(type),
      Math.round(Math.abs(amount || 0) * 100),
      Math.round(Math.abs(units || 0) * 1000),
      (folio || '').replace(/\s/g, ''),
    ].join('|');
  }

  // Resolve a (possibly old/renamed) statement ISIN to the current investment's
  // ISIN via previous_isin_codes — the same idea the stock import uses. Lets
  // merged funds (e.g. Principal → Sundaram) dedup correctly instead of being
  // flagged as new every import.
  function buildIsinCanonicalMap() {
    const rows = db.prepare("SELECT isin_code, previous_isin_codes FROM investments WHERE asset_type = 'MUTUAL_FUND' AND isin_code IS NOT NULL").all();
    const map = new Map();
    for (const r of rows) {
      map.set(r.isin_code, r.isin_code);
      if (r.previous_isin_codes) {
        for (const prev of String(r.previous_isin_codes).split(',').map((s) => s.trim()).filter(Boolean)) {
          if (!map.has(prev)) map.set(prev, r.isin_code);
        }
      }
    }
    return map;
  }
  function canonicalizeIsin(isin, canonMap) {
    if (!isin) return isin;
    return (canonMap && canonMap.get(isin)) || isin;
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
      } catch (e) {
        logAppError(`CAS preview: CAMS parse failed, trying CDSL fallback: ${e.message}`);
      }

      if (camsParsed && camsParsed.schemes && camsParsed.schemes.length > 0) {
        // ── CAMS/KFintech CAS (transaction history) ──
        const existingTxns = getExistingTransactionMap(portfolioId);
        const isinCanon = buildIsinCanonicalMap();

        // Find existing investments by ISIN — search globally, not scoped to
        // the selected portfolio, to avoid creating duplicates when two portfolios
        // hold different folios of the same fund.
        const existingByIsin = {};
        const invRows = db.prepare(
          `SELECT DISTINCT i.id, i.name, i.isin_code
           FROM investments i
           WHERE i.asset_type = 'MUTUAL_FUND'
             AND i.isin_code IS NOT NULL AND i.isin_code != ''`
        ).all();
        for (const inv of invRows) {
          if (inv.isin_code) existingByIsin[inv.isin_code] = inv;
        }

        const schemes = camsParsed.schemes.map(s => {
          const existingInv = existingByIsin[canonicalizeIsin(s.isin, isinCanon)] || null;
          const transactions = s.transactions.map(t => {
            const key = makeTxnKey(canonicalizeIsin(s.isin, isinCanon), t.date, t.type, t.amount, t.units, s.folio);
            const newStt = t.stt || 0;
            const newFees = (t.stampDuty || 0) + (t.stt || 0);
            const existing = existingTxns.get(key);
            if (!existing) {
              return { ...t, status: 'new', isNew: true, new_stt: newStt, new_fees: newFees };
            }
            const sttDiff = existing.stt == null || Math.abs((existing.stt || 0) - newStt) > 0.005;
            const feesDiff = Math.abs((existing.fees || 0) - newFees) > 0.005;
            if (!existing.locked && (sttDiff || feesDiff)) {
              return {
                ...t,
                status: 'update',
                isNew: false,
                existing_stt: existing.stt,
                new_stt: newStt,
                existing_fees: existing.fees,
                new_fees: newFees,
              };
            }
            return { ...t, status: 'unchanged', isNew: false };
          });
          const newCount = transactions.filter(t => t.status === 'new').length;
          const updateCount = transactions.filter(t => t.status === 'update').length;
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
            newTransactionCount: newCount,
            updateTransactionCount: updateCount,
            existingTransactionCount: transactions.length - newCount,
          };
        });

        const totalTxns = schemes.reduce((s, sc) => s + sc.transactions.length, 0);
        const newTxns = schemes.reduce((s, sc) => s + sc.newTransactionCount, 0);
        const updateTxns = schemes.reduce((s, sc) => s + sc.updateTransactionCount, 0);

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
            updateTransactions: updateTxns,
            existingTransactions: totalTxns - newTxns,
          },
        });
      }

      // ── CDSL CAS (holdings snapshot) ──
      let cdslParsed = null;
      try {
        cdslParsed = await parseCAS(req.file.buffer, password);
      } catch (e) {
        logAppError(`CAS preview: CDSL parse failed, trying NSDL fallback: ${e.message}`);
      }

      if (cdslParsed && cdslParsed.mutualFunds.length > 0) {
        // Check which holdings already exist in DB for this portfolio
        const existingInvestments = db.prepare(
          `SELECT DISTINCT i.id, i.name, i.asset_type, i.ticker_symbol, i.amfi_code, i.isin_code,
                  (SELECT GROUP_CONCAT(DISTINCT t2.folio_number) FROM transactions t2 WHERE t2.investment_id = i.id AND t2.folio_number IS NOT NULL) as folios
           FROM investments i
           JOIN transactions t ON t.investment_id = i.id AND t.portfolio_id = ?
           WHERE 1=1`
        ).all(portfolioId);

        const markExisting = (holding) => {
          const match = existingInvestments.find(inv => {
            if (holding.isin && inv.isin_code && inv.isin_code === holding.isin) return true;
            if (holding.folio && inv.folios && inv.folios.split(',').some(f => f.trim() === holding.folio)) return true;
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
      } catch (e) {
        logAppError(`CAS preview: NSDL parse failed: ${e.message}`);
      }

      if (nsdlParsed && nsdlParsed.mutualFunds.length > 0) {
        const existingInvestments = db.prepare(
          `SELECT DISTINCT i.id, i.name, i.asset_type, i.ticker_symbol, i.amfi_code, i.isin_code,
                  (SELECT GROUP_CONCAT(DISTINCT t2.folio_number) FROM transactions t2 WHERE t2.investment_id = i.id AND t2.folio_number IS NOT NULL) as folios
           FROM investments i
           JOIN transactions t ON t.investment_id = i.id AND t.portfolio_id = ?
           WHERE 1=1`
        ).all(portfolioId);

        const markExistingNSDL = (holding) => {
          const match = existingInvestments.find(inv => {
            if (holding.isin && inv.isin_code && inv.isin_code === holding.isin) return true;
            if (holding.folio && inv.folios && inv.folios.split(',').some(f => f.trim() === holding.folio)) return true;
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
      logAppError('[CAS] Preview failed', {
        portfolio_id: Number(req.body?.portfolio_id || 0) || null,
        file_name: req.file?.originalname || null,
        error: e.message,
      });
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

      const findByIsin = db.prepare('SELECT id, name FROM investments WHERE isin_code = ?');
      const findByPreviousIsin = db.prepare("SELECT id, name FROM investments WHERE (',' || previous_isin_codes || ',') LIKE '%,' || ? || ',%'");

      const insertInvestment = db.prepare(`
        INSERT INTO investments (name, asset_type, ticker_symbol, isin_code, currency, notes)
        VALUES (?, 'MUTUAL_FUND', NULL, ?, 'INR', ?)
      `);

      const insertTransaction = db.prepare(`
        INSERT INTO transactions (investment_id, portfolio_id, transaction_type, transaction_date, units, price_per_unit, amount, fees, stt, broker, notes, folio_number)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      // Update STT/fees on an already-present transaction (idempotent re-import).
      const updateTransactionStt = db.prepare('UPDATE transactions SET stt = ?, fees = ? WHERE id = ?');

      // Build key → existing row map so re-import can correct STT on existing rows.
      const existingTxns = getExistingTransactionMap(portfolioId);
      const isinCanon = buildIsinCanonicalMap();

      let importedCount = 0;
      let updatedCount = 0;
      let skippedCount = 0;
      const results = [];
      const dirtyCandidates = [];

      const importTxn = db.transaction(() => {
        for (const scheme of schemes) {
          const isin = scheme.isin;
          const folio = scheme.folio ? scheme.folio.replace(/\s/g, '') : null;
          const schemeName = scheme.schemeName;

          // Find or create investment. Match current ISIN first, then a
          // previous/renamed ISIN (merged funds), before creating a new one.
          let investmentId = null;
          if (isin) {
            const byIsin = findByIsin.get(isin);
            if (byIsin) investmentId = byIsin.id;
            else {
              const byPrev = findByPreviousIsin.get(isin);
              if (byPrev) investmentId = byPrev.id;
            }
          }
          if (!investmentId) {
            const inv = insertInvestment.run(
              schemeName, isin,
              `Imported from CAMS/KFintech CAS. AMC: ${scheme.amc || ''}`
            );
            investmentId = inv.lastInsertRowid;
          } else {
            // Backfill isin if missing
            if (isin) db.prepare('UPDATE investments SET isin_code = COALESCE(isin_code, ?) WHERE id = ?').run(isin, investmentId);
          }

          let schemeImported = 0;
          for (const t of (scheme.transactions || [])) {
            const key = makeTxnKey(canonicalizeIsin(isin, isinCanon), t.date, t.type, t.amount, t.units, folio);
            const newStt = t.stt || 0;
            const newFees = (t.stampDuty || 0) + (t.stt || 0);
            const feeNotes = [];
            if (t.stampDuty > 0) feeNotes.push(`Stamp Duty: ₹${t.stampDuty}`);
            if (t.stt > 0) feeNotes.push(`STT: ₹${t.stt}`);
            const notes = [t.description || '', ...feeNotes].filter(Boolean).join('; ');

            // Existing transaction: correct STT/fees if they differ (skip locked rows).
            const existing = existingTxns.get(key);
            if (existing) {
              const sttDiff = existing.stt == null || Math.abs((existing.stt || 0) - newStt) > 0.005;
              const feesDiff = Math.abs((existing.fees || 0) - newFees) > 0.005;
              if (!existing.locked && (sttDiff || feesDiff)) {
                updateTransactionStt.run(newStt, newFees, existing.id);
                updatedCount++;
              } else {
                skippedCount++;
              }
              continue;
            }

            const info = insertTransaction.run(
              investmentId, portfolioId,
              t.type, t.date,
              Math.abs(t.units || 0), t.price || 0, Math.abs(t.amount || 0),
              newFees, newStt, 'CAMS CAS', notes, folio
            );
            dirtyCandidates.push({ investment_id: investmentId, portfolio_id: portfolioId, transaction_date: t.date });
            existingTxns.set(key, { id: info.lastInsertRowid, fees: newFees, stt: newStt, locked: 0 });
            importedCount++;
            schemeImported++;
          }

          results.push({ id: investmentId, name: schemeName, isin, imported: schemeImported });
        }
      });

      importTxn();

      if (dirtyCandidates.length > 0) {
        markDirtyFromTransactions(db, dirtyCandidates, 'cams-cas-import', `portfolio:${portfolioId}`);
      }

      logAppInfo('[CAS] CAMS import completed', {
        portfolio_id: portfolioId,
        schemes: results.length,
        imported: importedCount,
        updated: updatedCount,
        skipped: skippedCount,
      });

      res.json({
        success: true,
        imported: importedCount,
        updated: updatedCount,
        skipped: skippedCount,
        schemes: results,
      });
    } catch (e) {
      console.error('CAMS CAS import error:', e);
      logAppError('[CAS] CAMS import failed', {
        portfolio_id: Number(req.body?.portfolio_id || 0) || null,
        error: e.message,
      });
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
        'SELECT id, name FROM investments WHERE isin_code = ?'
      );

      const insertInvestment = db.prepare(`
        INSERT INTO investments (name, asset_type, isin_code, currency, notes)
        VALUES (?, 'MUTUAL_FUND', ?, 'INR', ?)
      `);

      const insertTransaction = db.prepare(`
        INSERT INTO transactions (investment_id, portfolio_id, transaction_type, transaction_date, units, price_per_unit, amount, folio_number)
        VALUES (?, ?, 'BUY', ?, ?, ?, ?, ?)
      `);

      const today = new Date().toISOString().split('T')[0];
      const results = [];
      const dirtyCandidates = [];

      const importTxn = db.transaction(() => {
        for (const h of mfHoldings) {
          const folio = h.folio || null;
          const notes = `Imported from CAS PDF. ISIN: ${h.isin}`;

          // Check for existing investment by ISIN (folios are per-transaction)
          let existingId = null;
          if (h.isin) {
            const byIsin = findByIsin.get(h.isin);
            if (byIsin) existingId = byIsin.id;
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
              h.name, h.isin || null, notes
            );
            investmentId = inv.lastInsertRowid;
          }

          // Create initial BUY transaction
          const units = h.units || 0;
          const pricePerUnit = h.nav || h.price || 0;
          const amount = h.invested || h.value || (units * pricePerUnit);

          if (units > 0 && amount > 0) {
            insertTransaction.run(investmentId, portfolio_id, today, units, pricePerUnit, amount, folio);
            dirtyCandidates.push({ investment_id: investmentId, portfolio_id: portfolio_id, transaction_date: today });
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

      if (dirtyCandidates.length > 0) {
        markDirtyFromTransactions(db, dirtyCandidates, 'cas-holdings-import', `portfolio:${portfolio_id}`);
      }

      logAppInfo('[CAS] Holdings import completed', {
        portfolio_id: Number(portfolio_id),
        imported: results.length,
      });

      res.json({
        success: true,
        imported: results.length,
        investments: results,
      });
    } catch (e) {
      console.error('CAS import error:', e);
      logAppError('[CAS] Holdings import failed', {
        portfolio_id: Number(req.body?.portfolio_id || 0) || null,
        error: e.message,
      });
      res.status(500).json({ error: 'Failed to import: ' + e.message });
    }
  });

  return router;
};
