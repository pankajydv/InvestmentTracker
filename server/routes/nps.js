/**
 * NPS Statement Upload Routes
 *
 * POST /api/nps/preview   — Upload NPS statement files, get preview
 * POST /api/nps/import    — Import selected transactions from preview
 */
const express = require('express');
const multer = require('multer');
const { parseNPSStatements } = require('../services/npsStatementParser');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

module.exports = function (db) {

  function normalizeNPSType(type) {
    return type === 'CHARGES' ? 'AMC' : type;
  }

  /**
   * Build a set of existing NPS transaction keys for delta detection.
   * Key = schemeName|date|type|amount|units
   */
  function getExistingNPSKeys(portfolioId) {
    const rows = db.prepare(`
      SELECT i.name, t.transaction_date, t.transaction_type, t.amount, t.units
      FROM transactions t
      JOIN investments i ON i.id = t.investment_id
      WHERE t.portfolio_id = ? AND i.asset_type = 'NPS'
    `).all(portfolioId);

    const keys = new Set();
    for (const r of rows) {
      keys.add(makeNPSKey(r.name, r.transaction_date, r.transaction_type, r.amount, r.units));
    }
    return keys;
  }

  function makeNPSKey(schemeName, date, type, amount, units) {
    return [
      schemeName.toUpperCase(),
      date,
      normalizeNPSType(type),
      Math.round(Math.abs(amount || 0) * 100),
      Math.round(Math.abs(units || 0) * 1000),
    ].join('|');
  }

  /**
   * POST /api/nps/preview
   * Upload NPS CSV files and get a preview of transactions per scheme.
   * Body (multipart): files[] (CSV), portfolio_id
   */
  router.post('/preview', upload.array('files', 20), async (req, res) => {
    try {
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'No files uploaded' });
      }
      if (!req.body.portfolio_id) {
        return res.status(400).json({ error: 'portfolio_id is required' });
      }

      const portfolioId = parseInt(req.body.portfolio_id);
      const portfolio = db.prepare('SELECT * FROM portfolios WHERE id = ?').get(portfolioId);
      if (!portfolio) return res.status(404).json({ error: 'Portfolio not found' });

      const parsed = await parseNPSStatements(req.files, req.body.password || '');

      if (!parsed.schemes.length && !parsed.transactions.length) {
        return res.status(400).json({ error: 'No NPS transactions found in the uploaded files.' });
      }

      // Validate subscriber name matches the selected portfolio
      if (parsed.subscriberName) {
        const portfolioNameLower = portfolio.name.toLowerCase().trim();
        const subscriberNameLower = parsed.subscriberName.toLowerCase().trim();
        // Check if portfolio name is contained in subscriber name or vice versa
        const portfolioParts = portfolioNameLower.split(/\s+/);
        const subscriberParts = subscriberNameLower.split(/\s+/);
        const matchingParts = portfolioParts.filter(p => subscriberParts.includes(p));
        // Require at least 2 matching name parts, or full match for single-word names
        const nameMatches = portfolioParts.length === 1
          ? subscriberParts.includes(portfolioParts[0])
          : matchingParts.length >= 2;
        if (!nameMatches) {
          return res.status(400).json({
            error: `Subscriber name "${parsed.subscriberName}" in the NPS statement does not match the selected portfolio "${portfolio.name}". Please select the correct portfolio.`
          });
        }
      }

      // Get existing keys for delta detection
      const existingKeys = getExistingNPSKeys(portfolioId);

      // Find existing NPS investments for this portfolio
      const existingInvestments = db.prepare(`
        SELECT DISTINCT i.id, i.name, i.account_number
        FROM investments i
        JOIN transactions t ON t.investment_id = i.id AND t.portfolio_id = ?
        WHERE i.asset_type = 'NPS'
      `).all(portfolioId);

      // Group transactions by scheme
      const schemeMap = {};
      for (const txn of parsed.transactions) {
        if (!schemeMap[txn.schemeName]) {
          const existing = existingInvestments.find(inv => inv.name.toUpperCase() === txn.schemeName.toUpperCase());
          schemeMap[txn.schemeName] = {
            schemeName: txn.schemeName,
            pran: parsed.pran,
            existingInvestmentId: existing?.id || null,
            existingName: existing?.name || null,
            isNew: !existing,
            transactions: [],
            newTransactionCount: 0,
            existingTransactionCount: 0,
          };
        }
        const key = makeNPSKey(txn.schemeName, txn.date, txn.type, txn.amount, txn.units);
        const isNew = !existingKeys.has(key);
        schemeMap[txn.schemeName].transactions.push({ ...txn, isNew });
        if (isNew) schemeMap[txn.schemeName].newTransactionCount++;
        else schemeMap[txn.schemeName].existingTransactionCount++;
      }

      const schemes = Object.values(schemeMap);
      const totalTxns = schemes.reduce((s, sc) => s + sc.transactions.length, 0);
      const newTxns = schemes.reduce((s, sc) => s + sc.newTransactionCount, 0);

      return res.json({
        pran: parsed.pran,
        subscriberName: parsed.subscriberName,
        schemeChoice: parsed.schemeChoice,
        schemes,
        summary: {
          totalSchemes: schemes.length,
          totalTransactions: totalTxns,
          newTransactions: newTxns,
          existingTransactions: totalTxns - newTxns,
        },
      });
    } catch (e) {
      console.error('NPS preview error:', e);
      res.status(500).json({ error: 'Failed to parse NPS statements: ' + e.message });
    }
  });

  /**
   * POST /api/nps/import
   * Import selected NPS transactions.
   * Body (JSON): { portfolio_id, pran, schemes: [{ schemeName, transactions: [{ date, type, amount, nav, units }] }] }
   */
  router.post('/import', express.json(), async (req, res) => {
    try {
      const { portfolio_id, pran, schemes } = req.body;
      if (!portfolio_id || !schemes?.length) {
        return res.status(400).json({ error: 'portfolio_id and schemes array required' });
      }

      const portfolioId = parseInt(portfolio_id);
      const portfolio = db.prepare('SELECT * FROM portfolios WHERE id = ?').get(portfolioId);
      if (!portfolio) return res.status(404).json({ error: 'Portfolio not found' });

      const findByName = db.prepare('SELECT id FROM investments WHERE UPPER(name) = UPPER(?) AND asset_type = ?');

      const insertInvestment = db.prepare(`
        INSERT INTO investments (name, asset_type, account_number, currency, notes)
        VALUES (?, 'NPS', ?, 'INR', ?)
      `);

      const insertTransaction = db.prepare(`
        INSERT INTO transactions (investment_id, portfolio_id, transaction_type, transaction_date, units, price_per_unit, amount, fees, broker, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const existingKeys = getExistingNPSKeys(portfolioId);

      // Pre-compute tier totals per (date, type) for contribution notes
      // Key: "date|type|tier" → total amount across all schemes in that tier
      const tierTotals = {};
      for (const scheme of schemes) {
        for (const t of (scheme.transactions || [])) {
          if (t.type !== 'EMPLOYER_CONTRIBUTION' && t.type !== 'VOLUNTARY_CONTRIBUTION') continue;
          const tierMatch = scheme.schemeName.match(/TIER\s+(I{1,2})/i);
          const tier = tierMatch ? tierMatch[1].toUpperCase() : 'I';
          const key = `${t.date}|${t.type}|${tier}`;
          tierTotals[key] = (tierTotals[key] || 0) + Math.abs(t.amount || 0);
        }
      }

      function formatTotalFull(total) {
        if (!Number.isFinite(total) || total <= 0) return '0';
        return Math.round(total).toLocaleString('en-IN');
      }

      function compactYearRange(range) {
        const m = String(range || '').match(/(\d{4})\s*-\s*(\d{4})/);
        if (!m) return range;
        return `${m[1]}-${m[2].slice(2)}`;
      }

      /** Convert verbose particulars to concise notes. */
      function compactParticulars(particulars, normalizedType) {
        const p = String(particulars || '').trim();
        if (!p) return '';

        // Examples: "Billing for Q2 2020-2021", "Billing for the Quarter 3 2018-2019"
        const q = p.match(/billing\s+for\s+(?:the\s+)?(?:quarter\s*-?\s*|q\s*)(\d)\s*,?\s*(\d{4}\s*-\s*\d{4})/i);
        if (q) {
          return `Billing Q${q[1]}, ${compactYearRange(q[2])}`;
        }

        if (/persistency switch out/i.test(p)) return 'Persistency Out';
        if (/inter\s+pfm\s+switch\s+out/i.test(p) || /pfm\s+change\s+request/i.test(p)) return 'Inter PFM Out';
        if (/inter\s+pfm\s+switch\s+in/i.test(p)) return 'Inter PFM In';
        if (/tier\s*ii\s*to\s*tier\s*i|t2\s*to\s*t1/i.test(p)) return 'T2->T1';
        if (/one\s*way\s*switch/i.test(p) && normalizedType === 'TRANSFER_OUT') return 'One-way Out';
        if (/one\s*way\s*switch/i.test(p) && normalizedType === 'TRANSFER_IN') return 'One-way In';
        if (/rebalancing/i.test(p)) return 'Rebalancing';

        return p;
      }

      /** Generate notes for a contribution transaction */
      function makeContribNotes(schemeName, date, type, amount) {
        const schemeMatch = schemeName.match(/SCHEME\s+([A-Z])\s*-/i);
        const schemeLetter = schemeMatch ? schemeMatch[1] : '?';
        const tierMatch = schemeName.match(/TIER\s+(I{1,2})/i);
        const tier = tierMatch ? tierMatch[1].toUpperCase() : 'I';
        const key = `${date}|${type}|${tier}`;
        const total = tierTotals[key] || Math.abs(amount);
        const pct = total > 0 ? Math.round((Math.abs(amount) / total) * 100) : 0;
        return `Total=${formatTotalFull(total)}, ${schemeLetter}=${pct}%`;
      }

      let importedCount = 0;
      let skippedCount = 0;
      const results = [];

      const importTxn = db.transaction(() => {
        for (const scheme of schemes) {
          const schemeName = scheme.schemeName;

          // Find or create investment
          let investmentId = null;
          const existing = findByName.get(schemeName, 'NPS');
          if (existing) {
            investmentId = existing.id;
            // Update PRAN if not set
            if (pran) {
              db.prepare('UPDATE investments SET account_number = COALESCE(account_number, ?) WHERE id = ?').run(pran, investmentId);
            }
          } else {
            const inv = insertInvestment.run(schemeName, pran || null, `PRAN: ${pran || 'N/A'}`);
            investmentId = inv.lastInsertRowid;
          }

          let schemeImported = 0;
          for (const t of (scheme.transactions || [])) {
            const normalizedType = normalizeNPSType(t.type);
            const key = makeNPSKey(schemeName, t.date, normalizedType, t.amount, t.units);
            if (existingKeys.has(key)) { skippedCount++; continue; }

            const notes = (normalizedType === 'EMPLOYER_CONTRIBUTION' || normalizedType === 'VOLUNTARY_CONTRIBUTION')
              ? makeContribNotes(schemeName, t.date, normalizedType, t.amount)
              : compactParticulars(t.particulars || '', normalizedType);

            insertTransaction.run(
              investmentId, portfolioId,
              normalizedType, t.date,
              Math.abs(t.units || 0),
              Math.abs(t.nav || 0),
              Math.abs(t.amount || 0),
              normalizedType === 'AMC' ? 0 : Math.abs(t.charges || 0),
              t.broker || '',
              notes
            );
            existingKeys.add(key);
            importedCount++;
            schemeImported++;
          }

          results.push({ id: investmentId, name: schemeName, imported: schemeImported });
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
      console.error('NPS import error:', e);
      res.status(500).json({ error: 'Failed to import NPS transactions: ' + e.message });
    }
  });

  return router;
};
