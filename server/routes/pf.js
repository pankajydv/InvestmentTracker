/**
 * PF / EPS Statement Upload Routes
 *
 * POST /api/pf/preview   — Upload PF statement PDFs, get preview
 * POST /api/pf/import    — Import selected transactions from preview
 * POST /api/pf/manual    — Add PF transaction manually
 */
const express = require('express');
const multer = require('multer');
const { parsePFStatements } = require('../services/pfStatementParser');
const { logAppInfo, logAppError } = require('../services/appLogger');
const { markDirtyFromTransactions } = require('../services/dirtyBackfillService');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

module.exports = function (db) {

  /**
   * Build a set of existing PF transaction keys for delta detection.
   * Key = date|type|amount (by transaction type)
   */
  function getExistingKeys(portfolioId) {
    const rows = db.prepare(`
      SELECT t.transaction_date, t.transaction_type, t.amount
      FROM transactions t
      JOIN investments i ON i.id = t.investment_id
      WHERE t.portfolio_id = ? AND i.asset_type = 'PF'
    `).all(portfolioId);

    const exactKeys = new Set();
    const epsMonthKeys = new Set();
    for (const r of rows) {
      exactKeys.add(makeKey(r.transaction_date, r.transaction_type, r.amount));
      if (r.transaction_type === 'EPS_CONTRIBUTION') {
        epsMonthKeys.add(makeMonthKey(r.transaction_date, r.transaction_type, r.amount));
      }
    }
    return { exactKeys, epsMonthKeys };
  }

  function makeKey(date, type, amount) {
    return [date, type, Math.round(Math.abs(amount || 0) * 100)].join('|');
  }

  function makeMonthKey(date, type, amount) {
    const ym = (date || '').slice(0, 7);
    return [ym, type, Math.round(Math.abs(amount || 0) * 100)].join('|');
  }

  function findMainPFInvestment(portfolioId) {
    return db.prepare(`
      SELECT i.id, i.name
      FROM investments i
      JOIN transactions t ON t.investment_id = i.id AND t.portfolio_id = ?
      WHERE i.asset_type = 'PF' AND i.name NOT LIKE '%EPS%'
      GROUP BY i.id, i.name
      ORDER BY
        SUM(CASE WHEN t.transaction_type IN ('DEPOSIT', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION') THEN 1 ELSE 0 END) DESC,
        i.id ASC
      LIMIT 1
    `).get(portfolioId);
  }

  function findLinkedEPSInvestment(portfolioId) {
    return db.prepare(`
      SELECT i.id, i.name
      FROM investments i
      JOIN transactions t ON t.investment_id = i.id AND t.portfolio_id = ?
      WHERE i.asset_type = 'PF' AND i.name LIKE '%EPS%'
      GROUP BY i.id, i.name
      ORDER BY i.id ASC
      LIMIT 1
    `).get(portfolioId);
  }

  function createMainPFInvestment(portfolio, parsed) {
    const stmt = db.prepare(`
      INSERT INTO investments (name, asset_type, account_number, currency, category)
      VALUES (?, 'PF', ?, 'INR', 'Debt')
    `);
    const accountNumber = parsed?.uan || `PF-${portfolio.id}`;
    const displayName = `${portfolio.name} PF (Unified)`;
    const result = stmt.run(displayName, accountNumber);
    return { id: result.lastInsertRowid, name: displayName };
  }

  function createLinkedEPSInvestment(portfolio, parsed) {
    const stmt = db.prepare(`
      INSERT INTO investments (name, asset_type, account_number, currency, category)
      VALUES (?, 'PF', ?, 'INR', 'Debt')
    `);
    const accountNumber = parsed?.uan ? `UAN-${parsed.uan}-EPS` : `EPS-${portfolio.id}`;
    const displayName = `${portfolio.name} - EPS`;
    const result = stmt.run(displayName, accountNumber);
    return { id: result.lastInsertRowid, name: displayName };
  }

  function getPFStatementLabel(date) {
    const d = new Date(date);
    if (Number.isNaN(d.getTime())) return 'PF Statement';
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;
    const fyStart = month >= 4 ? year : year - 1;
    const fyEndShort = String((fyStart + 1) % 100).padStart(2, '0');
    return `PF ${fyStart}-${fyEndShort}`;
  }

  function buildBasePFNote(txn, fallbackAccountRef) {
    const accountRef = txn.accountRef || fallbackAccountRef || 'Unknown';
    const statementLabel = txn.statementLabel || getPFStatementLabel(txn.date);
    return `A/c: ${accountRef}, From: ${statementLabel}`;
  }

  function buildUploadPFNote(txn, fallbackAccountRef) {
    const base = buildBasePFNote(txn, fallbackAccountRef);
    if (txn.type === 'EPS_CONTRIBUTION') {
      const ee = Number(txn.eeAmount || 0).toFixed(2);
      const er = Number(txn.erAmount || 0).toFixed(2);
      const eps = Number(txn.epsAmount || txn.amount || 0).toFixed(2);
      return `Derived from EPF split: Employee PF ${ee} - Employer EPF ${er} = EPS ${eps}. ${base}`;
    }
    return base;
  }

  /**
   * POST /api/pf/preview
   * Upload PF PDF files and get a preview of transactions.
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

      const parsed = await parsePFStatements(req.files);

      if (!parsed.allTransactions || !parsed.allTransactions.length) {
        return res.status(400).json({ error: 'No transactions found in the uploaded files.' });
      }

      // Validate member name matches portfolio
      if (parsed.memberName) {
        const portfolioNameLower = portfolio.name.toLowerCase().trim();
        const memberNameLower = parsed.memberName.toLowerCase().trim();
        const portfolioParts = portfolioNameLower.split(/\s+/);
        const memberParts = memberNameLower.split(/\s+/);
        const matchingParts = portfolioParts.filter(p => memberParts.includes(p));
        const nameMatches = portfolioParts.length === 1
          ? memberParts.includes(portfolioParts[0])
          : matchingParts.length >= 2;
        if (!nameMatches) {
          return res.status(400).json({
            error: `Account holder "${parsed.memberName}" does not match portfolio "${portfolio.name}". Please select the correct portfolio.`
          });
        }
      }

      // Resolve existing PF + EPS accounts for this portfolio (if present)
      const pfInvestment = findMainPFInvestment(portfolioId);
      const epsInvestment = findLinkedEPSInvestment(portfolioId);

      // Get existing keys for delta detection
      const { exactKeys, epsMonthKeys } = getExistingKeys(portfolioId);

      // Transform parsed transactions to match expected format
      // We need to split each parsed transaction into separate DB transactions
      const transformedTransactions = [];
      const accountRef = parsed.memberIdNumber || parsed.uan || 'Unknown';
      for (const txn of parsed.allTransactions) {
        // Employee Contribution (DEPOSIT)
        if (txn.eeContribution > 0) {
          transformedTransactions.push({
            date: txn.date,
            investmentId: pfInvestment?.id || null,
            type: 'DEPOSIT',
            amount: txn.eeContribution,
            eeAmount: txn.eeContribution,
            erAmount: 0,
            epsAmount: 0,
            wageMonth: txn.wageMonth,
            accountRef,
            statementLabel: getPFStatementLabel(txn.date),
            originalDescription: txn.description,
          });
        }

        // Employer Contribution
        if (txn.erContribution > 0) {
          transformedTransactions.push({
            date: txn.date,
            investmentId: pfInvestment?.id || null,
            type: 'EMPLOYER_CONTRIBUTION',
            amount: txn.erContribution,
            eeAmount: 0,
            erAmount: txn.erContribution,
            epsAmount: 0,
            wageMonth: txn.wageMonth,
            accountRef,
            statementLabel: getPFStatementLabel(txn.date),
            originalDescription: txn.description,
          });
        }

        // EPS Contribution (goes to EPS investment 201)
        if (txn.epsContribution > 0) {
          transformedTransactions.push({
            date: txn.date,
            investmentId: null, // Will be filled with EPS investment ID
            type: 'EPS_CONTRIBUTION',
            amount: txn.epsContribution,
            eeAmount: 0,
            erAmount: 0,
            epsAmount: txn.epsContribution,
            isEPS: true,
            wageMonth: txn.wageMonth,
            accountRef,
            statementLabel: getPFStatementLabel(txn.date),
            originalDescription: `EPS - ${txn.description}`,
          });
        }
      }

      // Mark new vs existing transactions
      const transactions = transformedTransactions.map(txn => {
        const exactKey = makeKey(txn.date, txn.type, txn.amount);
        let isNew = !exactKeys.has(exactKey);

        // EPS postings may be booked at month-end in DB while statement line date is mid-month.
        if (txn.type === 'EPS_CONTRIBUTION' && isNew) {
          const monthKey = makeMonthKey(txn.date, txn.type, txn.amount);
          if (epsMonthKeys.has(monthKey)) {
            isNew = false;
          }
        }

        return { ...txn, isNew };
      });

      const newCount = transactions.filter(t => t.isNew).length;

      return res.json({
        uan: parsed.uan,
        memberName: parsed.memberName,
        memberIdNumber: parsed.memberIdNumber,
        dateOfBirth: parsed.dateOfBirth,
        establishmentName: parsed.establishmentName,
        statements: parsed.statements,
        pfInvestmentId: pfInvestment?.id || null,
        pfInvestmentName: pfInvestment?.name || null,
        epsInvestmentId: epsInvestment?.id || null,
        epsInvestmentName: epsInvestment?.name || null,
        transactions,
        summary: {
          totalTransactions: transactions.length,
          newTransactions: newCount,
          existingTransactions: transactions.length - newCount,
        },
      });
    } catch (e) {
      console.error('PF preview error:', e);
      logAppError('[PF] Preview failed', {
        portfolio_id: Number(req.body?.portfolio_id || 0) || null,
        file_count: Array.isArray(req.files) ? req.files.length : 0,
        error: e.message,
      });
      res.status(500).json({ error: 'Failed to parse PF statements: ' + e.message });
    }
  });

  /**
   * POST /api/pf/import
   * Import PF transactions.
   * Body: { portfolio_id, pfInvestmentId, transactions[] }
   */
  router.post('/import', express.json(), async (req, res) => {
    try {
      const { portfolio_id, pfInvestmentId, transactions, uan } = req.body;
      if (!portfolio_id || !transactions?.length) {
        return res.status(400).json({ error: 'portfolio_id and transactions array required' });
      }

      const portfolioId = parseInt(portfolio_id);
      const portfolio = db.prepare('SELECT * FROM portfolios WHERE id = ?').get(portfolioId);
      if (!portfolio) return res.status(404).json({ error: 'Portfolio not found' });

      // Resolve or create main PF + linked EPS accounts for this portfolio.
      let resolvedMainPF = null;
      if (pfInvestmentId) {
        const provided = db.prepare(`
          SELECT id, name FROM investments WHERE id = ? AND asset_type = 'PF' AND name NOT LIKE '%EPS%'
        `).get(parseInt(pfInvestmentId));
        if (provided) resolvedMainPF = provided;
      }
      if (!resolvedMainPF) {
        resolvedMainPF = findMainPFInvestment(portfolioId);
      }
      if (!resolvedMainPF) {
        resolvedMainPF = createMainPFInvestment(portfolio, { uan });
      }

      let resolvedEPS = findLinkedEPSInvestment(portfolioId);
      if (!resolvedEPS) {
        resolvedEPS = createLinkedEPSInvestment(portfolio, { uan });
      }

      const { exactKeys, epsMonthKeys } = getExistingKeys(portfolioId);

      const insertTransaction = db.prepare(`
        INSERT INTO transactions (investment_id, portfolio_id, transaction_type, transaction_date, amount, units, price_per_unit, fees, notes)
        VALUES (?, ?, ?, ?, ?, NULL, NULL, 0, ?)
      `);

      const dirtyCandidates = [];

      const importTxn = db.transaction(() => {
        let importedCount = 0;
        let skippedCount = 0;

        for (const txn of transactions) {
          if (!txn.isNew) {
            skippedCount++;
            continue;
          }

          const exactKey = makeKey(txn.date, txn.type, txn.amount);
          let isDuplicate = exactKeys.has(exactKey);
          if (!isDuplicate && txn.type === 'EPS_CONTRIBUTION') {
            const monthKey = makeMonthKey(txn.date, txn.type, txn.amount);
            isDuplicate = epsMonthKeys.has(monthKey);
          }
          if (isDuplicate) {
            skippedCount++;
            continue;
          }

          const invId = txn.isEPS ? resolvedEPS.id : resolvedMainPF.id;
          const notes = buildUploadPFNote(txn, uan);

          try {
            insertTransaction.run(
              invId,
              portfolioId,
              txn.type,
              txn.date,
              txn.amount,
              notes
            );
            dirtyCandidates.push({ investment_id: invId, portfolio_id: portfolioId, transaction_date: txn.date });
            exactKeys.add(exactKey);
            if (txn.type === 'EPS_CONTRIBUTION') {
              epsMonthKeys.add(makeMonthKey(txn.date, txn.type, txn.amount));
            }
            importedCount++;
          } catch (e) {
            console.error('Error inserting transaction:', e);
          }
        }

        return { importedCount, skippedCount };
      });

      const result = importTxn();

      if (dirtyCandidates.length > 0) {
        markDirtyFromTransactions(db, dirtyCandidates, 'pf-import', `uan:${uan}`);
      }

      logAppInfo('[PF] Import completed', {
        portfolio_id: portfolioId,
        main_pf_investment_id: resolvedMainPF?.id || null,
        eps_investment_id: resolvedEPS?.id || null,
        imported: Number(result.importedCount || 0),
        skipped: Number(result.skippedCount || 0),
      });

      return res.json({
        success: true,
        imported: result.importedCount,
        skipped: result.skippedCount,
      });
    } catch (e) {
      console.error('PF import error:', e);
      logAppError('[PF] Import failed', {
        portfolio_id: Number(req.body?.portfolio_id || 0) || null,
        error: e.message,
      });
      res.status(500).json({ error: 'Failed to import PF transactions: ' + e.message });
    }
  });

  /**
   * POST /api/pf/manual
   * Add PF transaction manually
   * Body: { portfolio_id, date, type, eeAmount, erAmount, epsAmount, notes }
   */
  router.post('/manual', express.json(), async (req, res) => {
    try {
      const { portfolio_id, date, type, amount, eeAmount, erAmount, epsAmount, notes } = req.body;

      if (!portfolio_id || !date || !type) {
        return res.status(400).json({ error: 'portfolio_id, date, and type are required' });
      }

      const normalizedType = String(type || '').trim().toUpperCase();
      const explicitAmount = amount === undefined || amount === null || amount === '' ? null : Number(amount);
      const legacyEeAmount = eeAmount === undefined || eeAmount === null || eeAmount === '' ? null : Number(eeAmount);
      const legacyErAmount = erAmount === undefined || erAmount === null || erAmount === '' ? null : Number(erAmount);
      const legacyEpsAmount = epsAmount === undefined || epsAmount === null || epsAmount === '' ? null : Number(epsAmount);

      if (explicitAmount != null && (!Number.isFinite(explicitAmount) || explicitAmount <= 0)) {
        return res.status(400).json({ error: 'amount must be a positive number' });
      }

      if (explicitAmount == null && legacyEeAmount == null && legacyErAmount == null && legacyEpsAmount == null) {
        return res.status(400).json({ error: 'amount is required' });
      }

      const portfolioId = parseInt(portfolio_id);
      const portfolio = db.prepare('SELECT * FROM portfolios WHERE id = ?').get(portfolioId);
      if (!portfolio) return res.status(404).json({ error: 'Portfolio not found' });

      // Get PF investment
      const pfInv = db.prepare(`
        SELECT i.id, i.account_number
        FROM investments i
        JOIN transactions t ON t.investment_id = i.id AND t.portfolio_id = ?
        WHERE i.asset_type = 'PF' AND i.name NOT LIKE '%EPS%'
        GROUP BY i.id
        ORDER BY i.id
        LIMIT 1
      `).get(portfolioId);

      if (!pfInv) return res.status(400).json({ error: 'PF investment not found' });

      const findEpsInv = db.prepare(`
        SELECT i.id
        FROM investments i
        JOIN transactions t ON t.investment_id = i.id AND t.portfolio_id = ?
        WHERE i.asset_type = 'PF' AND i.name LIKE '%EPS%'
        GROUP BY i.id
        LIMIT 1
      `);

      const createEpsInv = db.prepare(`
        INSERT INTO investments (name, asset_type, account_number, currency, category)
        VALUES (?, 'PF', ?, 'INR', 'Debt')
      `);

      const insertTransaction = db.prepare(`
        INSERT INTO transactions (investment_id, portfolio_id, transaction_type, transaction_date, amount, fees, notes)
        VALUES (?, ?, ?, ?, ?, 0, ?)
      `);

      const dirtyCandidates = [];

      const accountRef = pfInv.account_number || `PF-${portfolioId}`;
      const statementLabel = getPFStatementLabel(date);
      const baseManualNote = (notes || '').trim() || `Manual Entry (${normalizedType})`;
      const makeNote = (extra = null, fallbackAccountRef = accountRef) => {
        const prefix = `A/c: ${fallbackAccountRef}, From: ${statementLabel}`;
        const noteParts = [prefix];
        if (extra) noteParts.push(extra);
        noteParts.push(`Note: ${baseManualNote}`);
        return noteParts.join(', ');
      };

      const isContributionType = ['DEPOSIT', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'EPS_CONTRIBUTION'].includes(normalizedType);

      const importTxn = db.transaction(() => {
        let insertedCount = 0;
        let epsInvestmentId = null;

        const existingEpsInv = findEpsInv.get(portfolioId);
        if (existingEpsInv) {
          epsInvestmentId = existingEpsInv.id;
        } else {
          const created = createEpsInv.run(`${portfolio.name} - EPS`, `EPS-${portfolioId}`);
          epsInvestmentId = created.lastInsertRowid;
        }

        if (explicitAmount != null) {
          const targetInvestmentId = normalizedType === 'EPS_CONTRIBUTION' ? epsInvestmentId : pfInv.id;
          const note = normalizedType === 'EPS_CONTRIBUTION'
            ? makeNote(null, `EPS-${portfolioId}`)
            : makeNote();
          insertTransaction.run(targetInvestmentId, portfolioId, normalizedType, date, explicitAmount, note);
          dirtyCandidates.push({ investment_id: targetInvestmentId, portfolio_id: portfolioId, transaction_date: date });
          insertedCount++;
        } else {
          // Legacy split-mode support for older UI payloads.
          if (legacyEeAmount != null && legacyEeAmount > 0 && (normalizedType === 'DEPOSIT' || normalizedType === 'EMPLOYEE_CONTRIBUTION')) {
            insertTransaction.run(pfInv.id, portfolioId, 'DEPOSIT', date, legacyEeAmount, makeNote());
            dirtyCandidates.push({ investment_id: pfInv.id, portfolio_id: portfolioId, transaction_date: date });
            insertedCount++;
          }

          if (legacyErAmount != null && legacyErAmount > 0 && (normalizedType === 'EMPLOYER_CONTRIBUTION' || normalizedType === 'DEPOSIT' || normalizedType === 'EMPLOYEE_CONTRIBUTION')) {
            insertTransaction.run(pfInv.id, portfolioId, 'EMPLOYER_CONTRIBUTION', date, legacyErAmount, makeNote());
            dirtyCandidates.push({ investment_id: pfInv.id, portfolio_id: portfolioId, transaction_date: date });
            insertedCount++;
          }

          if (legacyEpsAmount != null && legacyEpsAmount > 0 && epsInvestmentId) {
            insertTransaction.run(epsInvestmentId, portfolioId, 'EPS_CONTRIBUTION', date, legacyEpsAmount, makeNote(null, `EPS-${portfolioId}`));
            dirtyCandidates.push({ investment_id: epsInvestmentId, portfolio_id: portfolioId, transaction_date: date });
            insertedCount++;
          }
        }

        return insertedCount;
      });

      const count = importTxn();

      if (dirtyCandidates.length > 0) {
        markDirtyFromTransactions(db, dirtyCandidates, 'pf-manual-add', `account:${accountRef}`);
      }

      logAppInfo('[PF] Manual transaction added', {
        portfolio_id: portfolioId,
        date,
        type,
        inserted: Number(count || 0),
      });

      return res.json({
        success: true,
        inserted: count,
      });
    } catch (e) {
      console.error('PF manual add error:', e);
      logAppError('[PF] Manual add failed', {
        portfolio_id: Number(req.body?.portfolio_id || 0) || null,
        date: req.body?.date || null,
        type: req.body?.type || null,
        error: e.message,
      });
      res.status(500).json({ error: 'Failed to add manual PF transaction: ' + e.message });
    }
  });

  return router;
};
