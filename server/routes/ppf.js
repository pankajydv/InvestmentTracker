/**
 * PPF / SSY Statement Upload Routes
 *
 * POST /api/ppf/preview   — Upload PPF/SSY statement PDFs, get preview
 * POST /api/ppf/import    — Import selected transactions from preview
 */
const express = require('express');
const multer = require('multer');
const { parsePPFStatements } = require('../services/ppfStatementParser');
const { logAppInfo, logAppError } = require('../services/appLogger');
const { markDirtyFromTransactions } = require('../services/dirtyBackfillService');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

module.exports = function (db) {

  /**
   * Build a set of existing PPF/SSY transaction keys for delta detection.
   * Key = accountNumber|date|type|amount
   */
  function getExistingKeys(portfolioId, assetType) {
    const rows = db.prepare(`
      SELECT i.account_number, t.transaction_date, t.transaction_type, t.amount
      FROM transactions t
      JOIN investments i ON i.id = t.investment_id
      WHERE t.portfolio_id = ? AND i.asset_type = ?
    `).all(portfolioId, assetType);

    const keys = new Set();
    for (const r of rows) {
      keys.add(makeKey(r.account_number, r.transaction_date, r.transaction_type, r.amount));
    }
    return keys;
  }

  function makeKey(accountNumber, date, type, amount) {
    return [
      (accountNumber || '').replace(/^0+/, ''),
      date,
      type,
      Math.round(Math.abs(amount || 0) * 100),
    ].join('|');
  }

  /**
   * POST /api/ppf/preview
   * Upload PPF/SSY PDF files and get a preview of transactions.
   * Body (multipart): files[] (PDF), portfolio_id, password (optional)
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

      const parsed = await parsePPFStatements(req.files, req.body.password || '');

      if (!parsed.transactions.length) {
        return res.status(400).json({ error: 'No transactions found in the uploaded files.' });
      }

      // Validate account holder name matches the selected portfolio
      if (parsed.accountName) {
        const portfolioNameLower = portfolio.name.toLowerCase().trim();
        const accountNameLower = parsed.accountName.toLowerCase().trim();
        const portfolioParts = portfolioNameLower.split(/\s+/);
        const accountParts = accountNameLower.split(/\s+/);
        const matchingParts = portfolioParts.filter(p => accountParts.includes(p));
        const nameMatches = portfolioParts.length === 1
          ? accountParts.includes(portfolioParts[0])
          : matchingParts.length >= 2;
        if (!nameMatches) {
          return res.status(400).json({
            error: `Account holder "${parsed.accountName}" does not match portfolio "${portfolio.name}". Please select the correct portfolio.`
          });
        }
      }

      const assetType = parsed.accountType || 'PPF';

      // Get existing keys for delta detection
      const existingKeys = getExistingKeys(portfolioId, assetType);

      // Find existing investment for this account
      const accountNum = parsed.accountNumber || '';
      const existingInvestment = db.prepare(`
        SELECT i.id, i.name, i.account_number
        FROM investments i
        JOIN transactions t ON t.investment_id = i.id AND t.portfolio_id = ?
        WHERE i.asset_type = ? AND (i.account_number = ? OR i.account_number = ?)
      `).get(portfolioId, assetType, accountNum, accountNum.padStart(17, '0'));

      // Mark new vs existing transactions
      const transactions = parsed.transactions.map(txn => {
        const key = makeKey(accountNum, txn.date, txn.type, txn.amount);
        const isNew = !existingKeys.has(key);
        return { ...txn, isNew };
      });

      const newCount = transactions.filter(t => t.isNew).length;

      return res.json({
        accountName: parsed.accountName,
        accountNumber: parsed.accountNumber,
        accountType: assetType,
        interestRate: parsed.interestRate,
        openDate: parsed.openDate,
        maturityDate: parsed.maturityDate,
        openingBalance: parsed.openingBalance || 0,
        existingInvestmentId: existingInvestment?.id || null,
        existingName: existingInvestment?.name || null,
        isNew: !existingInvestment,
        transactions,
        summary: {
          totalTransactions: transactions.length,
          newTransactions: newCount,
          existingTransactions: transactions.length - newCount,
        },
      });
    } catch (e) {
      console.error('PPF preview error:', e);
      logAppError('[PPF/SSY] Preview failed', {
        portfolio_id: Number(req.body?.portfolio_id || 0) || null,
        file_count: Array.isArray(req.files) ? req.files.length : 0,
        error: e.message,
      });
      res.status(500).json({ error: 'Failed to parse PPF/SSY statements: ' + e.message });
    }
  });

  /**
   * POST /api/ppf/import
   * Import PPF/SSY transactions.
   * Body (JSON): { portfolio_id, accountName, accountNumber, accountType, interestRate, openDate, maturityDate, transactions[] }
   */
  router.post('/import', express.json(), async (req, res) => {
    try {
      const { portfolio_id, accountName, accountNumber, accountType, interestRate, openDate, maturityDate, openingBalance, transactions } = req.body;
      if (!portfolio_id || !transactions?.length) {
        return res.status(400).json({ error: 'portfolio_id and transactions array required' });
      }

      const portfolioId = parseInt(portfolio_id);
      const portfolio = db.prepare('SELECT * FROM portfolios WHERE id = ?').get(portfolioId);
      if (!portfolio) return res.status(404).json({ error: 'Portfolio not found' });

      const assetType = accountType || 'PPF';

      const findExisting = db.prepare(`
        SELECT i.id FROM investments i
        JOIN transactions t ON t.investment_id = i.id AND t.portfolio_id = ?
        WHERE i.asset_type = ? AND (i.account_number = ? OR i.account_number = ?)
        LIMIT 1
      `);

      const insertInvestment = db.prepare(`
        INSERT INTO investments (name, asset_type, account_number, currency, notes, category, opening_balance)
        VALUES (?, ?, ?, 'INR', ?, 'Debt', ?)
      `);

      const insertTransaction = db.prepare(`
        INSERT INTO transactions (investment_id, portfolio_id, transaction_type, transaction_date, units, price_per_unit, amount, fees, notes)
        VALUES (?, ?, ?, ?, NULL, NULL, ?, 0, ?)
      `);

      const existingKeys = getExistingKeys(portfolioId, assetType);

      let importedCount = 0;
      let skippedCount = 0;
      const dirtyCandidates = [];

      const importTxn = db.transaction(() => {
        // Find or create investment
        let investmentId = null;
        const acctNum = accountNumber || '';
        const existing = findExisting.get(portfolioId, assetType, acctNum, acctNum.padStart(17, '0'));
        if (existing) {
          investmentId = existing.id;
          // Update interest rate and maturity if provided
          if (interestRate) {
            // Interest rates are stored in global interest_rates table, not per investment.
          }
          if (maturityDate) {
            db.prepare('UPDATE investments SET maturity_date = ? WHERE id = ?').run(maturityDate, investmentId);
          }
          if (openingBalance > 0) {
            db.prepare('UPDATE investments SET opening_balance = ? WHERE id = ?').run(openingBalance, investmentId);
          }
        } else {
          const displayName = `${accountName || portfolio.name} - ${assetType}`;
          const notes = [
            openDate ? `Opened: ${openDate}` : '',
            maturityDate ? `Maturity: ${maturityDate}` : '',
          ].filter(Boolean).join(', ');

          const inv = insertInvestment.run(
            displayName,
            assetType,
            acctNum,
            notes || null,
            openingBalance || 0
          );
          investmentId = inv.lastInsertRowid;
        }

        for (const t of transactions) {
          const key = makeKey(acctNum, t.date, t.type, t.amount);
          if (existingKeys.has(key)) { skippedCount++; continue; }

          insertTransaction.run(
            investmentId, portfolioId,
            t.type, t.date,
            Math.abs(t.amount),
            t.description || ''
          );
          dirtyCandidates.push({ investment_id: investmentId, portfolio_id: portfolioId, transaction_date: t.date });
          existingKeys.add(key);
          importedCount++;
        }

        return investmentId;
      });

      const investmentId = importTxn();

      if (dirtyCandidates.length > 0) {
        markDirtyFromTransactions(db, dirtyCandidates, 'ppf-import', `account:${accountNumber}`);
      }

      logAppInfo('[PPF/SSY] Import completed', {
        portfolio_id: portfolioId,
        investment_id: Number(investmentId || 0) || null,
        account_type: assetType,
        imported: importedCount,
        skipped: skippedCount,
      });

      res.json({
        success: true,
        investmentId,
        imported: importedCount,
        skipped: skippedCount,
      });
    } catch (e) {
      console.error('PPF import error:', e);
      logAppError('[PPF/SSY] Import failed', {
        portfolio_id: Number(req.body?.portfolio_id || 0) || null,
        account_type: req.body?.accountType || 'PPF',
        error: e.message,
      });
      res.status(500).json({ error: 'Failed to import PPF/SSY transactions: ' + e.message });
    }
  });

  return router;
};
