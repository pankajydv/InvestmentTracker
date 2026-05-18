const express = require('express');
const router = express.Router();
const { ONE_DAY_CHANGE_POLICY, getOneDayChangePolicy } = require('../services/assetPolicy');

const CASH_OUTFLOW_TYPES = new Set([
  'BUY', 'VEST', 'ESPP_CONTRIBUTION', 'DEPOSIT', 'IPO', 'TRANSFER_IN', 'SWITCH_IN', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'RIGHTS', 'CHARGES', 'AMC'
]);

const CASH_INFLOW_TYPES = new Set([
  'SELL', 'REDEMPTION', 'WITHDRAWAL', 'TRANSFER_OUT', 'SWITCH_OUT', 'DIVIDEND', 'INTEREST', 'RECONCILE', 'TDS'
]);

const INTERNAL_BALANCE_XIRR_ASSET_TYPES = new Set(['PF', 'PPF', 'SSY']);

function isInternalXirrCashflow(assetType, transactionType) {
  const normalizedAssetType = String(assetType || '').toUpperCase();
  const normalizedType = String(transactionType || '').toUpperCase();

  if (!INTERNAL_BALANCE_XIRR_ASSET_TYPES.has(normalizedAssetType)) {
    return false;
  }

  if (normalizedType === 'INTEREST' || normalizedType === 'TDS') {
    return true;
  }

  return normalizedType === 'RECONCILE';
}

function xnpv(rate, flows, baseDate) {
  const msPerDay = 24 * 60 * 60 * 1000;
  return flows.reduce((sum, flow) => {
    const years = (flow.date - baseDate) / msPerDay / 365;
    return sum + flow.amount / ((1 + rate) ** years);
  }, 0);
}

function calculateXirr(flows) {
  if (!Array.isArray(flows) || flows.length < 2) return null;

  let hasPositive = false;
  let hasNegative = false;
  for (const flow of flows) {
    if (flow.amount > 0) hasPositive = true;
    if (flow.amount < 0) hasNegative = true;
  }
  if (!hasPositive || !hasNegative) return null;

  const sortedFlows = [...flows].sort((a, b) => a.date - b.date);
  const baseDate = sortedFlows[0].date;

  let low = -0.9999;
  let high = 10;
  let fLow = xnpv(low, sortedFlows, baseDate);
  let fHigh = xnpv(high, sortedFlows, baseDate);

  for (let i = 0; i < 25 && fLow * fHigh > 0; i += 1) {
    high *= 2;
    fHigh = xnpv(high, sortedFlows, baseDate);
  }

  if (fLow * fHigh > 0) return null;

  for (let i = 0; i < 100; i += 1) {
    const mid = (low + high) / 2;
    const fMid = xnpv(mid, sortedFlows, baseDate);

    if (Math.abs(fMid) < 1e-7) return mid;

    if (fLow * fMid < 0) {
      high = mid;
      fHigh = fMid;
    } else {
      low = mid;
      fLow = fMid;
    }
  }

  return (low + high) / 2;
}

function diffIsoDays(startIso, endIso) {
  if (!startIso || !endIso) return 1;
  const startMs = new Date(`${startIso}T00:00:00.000Z`).getTime();
  const endMs = new Date(`${endIso}T00:00:00.000Z`).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 1;
  return Math.max(Math.floor((endMs - startMs) / 86400000), 1);
}

function parseMarketHolidaySet(raw) {
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(String(raw));
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d))).map(String));
  } catch {
    return new Set();
  }
}

function isWeekendIso(isoDate) {
  const dt = new Date(`${isoDate}T00:00:00.000Z`);
  const day = dt.getUTCDay();
  return day === 0 || day === 6;
}

function isMarketSessionDate(isoDate, marketHolidaySet) {
  if (!isoDate) return false;
  if (isWeekendIso(isoDate)) return false;
  if (marketHolidaySet?.has(isoDate)) return false;
  return true;
}

module.exports = function (db) {

  // ─── Portfolio Summary (Dashboard) ────────────────────────────────────
  router.get('/summary', (req, res) => {
    const { portfolio_id, hide_sold } = req.query;
    const oneDayDebugRaw = String(req.query.one_day_debug || '').trim().toLowerCase();
    const includeOneDayDebug = oneDayDebugRaw === 'true' || oneDayDebugRaw === '1' || oneDayDebugRaw === 'yes';

    // Get latest portfolio snapshot
    let latest;
    if (portfolio_id) {
      latest = db.prepare(
        'SELECT * FROM portfolio_daily WHERE portfolio_id = ? ORDER BY date DESC LIMIT 1'
      ).get(portfolio_id);
    } else {
      latest = db.prepare(
        'SELECT * FROM portfolio_daily WHERE portfolio_id IS NULL ORDER BY date DESC LIMIT 1'
      ).get();
    }

    // Build WHERE clause for portfolio filter
    const portfolioFilter = portfolio_id ? ' AND EXISTS (SELECT 1 FROM transactions t WHERE t.investment_id = i.id AND t.portfolio_id = ?)' : '';
    const portfolioParams = portfolio_id ? [portfolio_id] : [];

    // Build hide-sold filter
    const soldFilter = hide_sold === 'true'
      ? ` AND (i.asset_type IN ('PPF','SSY','PF') OR NOT EXISTS (SELECT 1 FROM transactions t2 WHERE t2.investment_id = i.id${portfolio_id ? ' AND t2.portfolio_id = ?' : ''}) OR COALESCE((SELECT SUM(CASE WHEN t2.transaction_type IN ('BUY','DEPOSIT','BONUS','RIGHTS','IPO','TRANSFER_IN','SWITCH_IN','SPLIT','EMPLOYER_CONTRIBUTION','VOLUNTARY_CONTRIBUTION','VEST','ESPP_PURCHASE') THEN COALESCE(t2.units,0) WHEN t2.transaction_type IN ('SELL','REDEMPTION','WITHDRAWAL','TRANSFER_OUT','SWITCH_OUT','CONSOLIDATION','CHARGES','AMC') THEN -COALESCE(t2.units,0) ELSE 0 END) FROM transactions t2 WHERE t2.investment_id = i.id${portfolio_id ? ' AND t2.portfolio_id = ?' : ''}),0) > 0.001)`
      : '';
    const soldParams = (hide_sold === 'true' && portfolio_id) ? [portfolio_id, portfolio_id] : [];

    // Build daily_values portfolio filter
    const dvPortfolioJoin = portfolio_id
      ? 'AND dv.portfolio_id = ?'
      : 'AND dv.portfolio_id IS NULL';
    const dvPortfolioSub = portfolio_id
      ? 'AND portfolio_id = ?'
      : 'AND portfolio_id IS NULL';
    const dvParams = portfolio_id ? [portfolio_id] : [];

    // Get individual investment summaries
    const investments = db.prepare(`
      SELECT
        i.id, COALESCE(i.display_name, i.name) as name, i.asset_type, i.ticker_symbol, i.amfi_code, i.currency,
        i.isin_code, i.display_name,
        dv.date,
        COALESCE(dv.price_per_unit,
          (SELECT price_per_unit FROM transactions WHERE investment_id = i.id AND price_per_unit > 0 ORDER BY transaction_date DESC LIMIT 1),
          0) as price_per_unit,
        (SELECT COALESCE(SUM(CASE
          WHEN transaction_type IN ('BUY','DEPOSIT','BONUS','SPLIT','IPO','TRANSFER_IN','SWITCH_IN','RIGHTS','EMPLOYER_CONTRIBUTION','VOLUNTARY_CONTRIBUTION','VEST','ESPP_PURCHASE') THEN COALESCE(units,0)
          WHEN transaction_type IN ('SELL','REDEMPTION','WITHDRAWAL','TRANSFER_OUT','SWITCH_OUT','CONSOLIDATION','CHARGES','AMC') THEN -COALESCE(units,0)
          ELSE 0 END), 0) FROM transactions WHERE investment_id = i.id) as total_units,
        COALESCE(dv.current_value, 0) as current_value,
        COALESCE(dv.invested_amount,
          (SELECT COALESCE(SUM(amount + COALESCE(fees, 0)), 0) FROM transactions
           WHERE investment_id = i.id AND transaction_type IN ('BUY','DEPOSIT','IPO','RIGHTS','EMPLOYER_CONTRIBUTION','VOLUNTARY_CONTRIBUTION','VEST','ESPP_CONTRIBUTION'))) as invested_amount,
        COALESCE(dv.profit_loss, 0) as profit_loss,
        COALESCE(dv.profit_loss_pct, 0) as profit_loss_pct,
        COALESCE(dv.day_change, 0) as day_change,
        COALESCE(dv.day_change_pct, 0) as day_change_pct
      FROM investments i
      LEFT JOIN daily_values dv ON i.id = dv.investment_id
        ${dvPortfolioJoin}
        AND dv.date = (SELECT MAX(date) FROM daily_values WHERE investment_id = i.id ${dvPortfolioSub})
      WHERE 1=1${portfolioFilter}${soldFilter} AND i.exclude_from_tracking = 0
      ORDER BY i.asset_type, i.name
    `).all(...dvParams, ...dvParams, ...portfolioParams, ...soldParams);

    const oneDayDebugSummary = includeOneDayDebug
      ? {
          enabled: true,
          requestedWith: req.query.one_day_debug,
          policyCounts: {
            MARKET_SESSION: 0,
            NAV_SNAPSHOT: 0,
            ACCRUAL_SNAPSHOT: 0,
            SNAPSHOT: 0,
          },
          noDailyValueCount: 0,
          noPreviousRowCount: 0,
          marketAnchoredCount: 0,
          marketLatestFallbackCount: 0,
        }
      : null;

    const marketHolidayConfig = db.prepare(`
      SELECT value
      FROM config
      WHERE key IN ('market_holidays_nse', 'market_holidays')
      ORDER BY CASE key WHEN 'market_holidays_nse' THEN 0 ELSE 1 END
      LIMIT 1
    `).get();
    const marketHolidaySet = parseMarketHolidaySet(marketHolidayConfig?.value);

    const latestDvForInvestment = db.prepare(`
      SELECT date, current_value, price_source
      FROM daily_values
      WHERE investment_id = ? ${portfolio_id ? 'AND portfolio_id = ?' : 'AND portfolio_id IS NULL'}
      ORDER BY date DESC
      LIMIT 1
    `);
    const latestMarketDvForInvestment = db.prepare(`
      SELECT date, current_value, price_source
      FROM daily_values
      WHERE investment_id = ? ${portfolio_id ? 'AND portfolio_id = ?' : 'AND portfolio_id IS NULL'}
        AND COALESCE(price_source, '') NOT IN ('LOCF', 'NSE_BHAVCOPY_LOCF')
      ORDER BY date DESC
      LIMIT 90
    `);
    const previousDvForAnchorDate = db.prepare(`
      SELECT date, current_value
      FROM daily_values
      WHERE investment_id = ? ${portfolio_id ? 'AND portfolio_id = ?' : 'AND portfolio_id IS NULL'}
        AND date < ?
      ORDER BY date DESC
      LIMIT 1
    `);
    const netFlowOnAnchorDate = db.prepare(`
      SELECT COALESCE(SUM(CASE
        WHEN transaction_type IN ('BUY', 'DEPOSIT', 'IPO', 'RIGHTS', 'TRANSFER_IN', 'SWITCH_IN', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'ESPP_CONTRIBUTION') THEN COALESCE(amount, 0)
        WHEN transaction_type IN ('SELL', 'REDEMPTION', 'WITHDRAWAL', 'TRANSFER_OUT', 'SWITCH_OUT', 'CHARGES', 'AMC', 'TDS') THEN -COALESCE(amount, 0)
        ELSE 0
      END), 0) AS net_flow
      FROM transactions
      WHERE investment_id = ? ${portfolio_id ? 'AND portfolio_id = ?' : ''}
        AND date(transaction_date) = ?
    `);
    const netFlowInRange = db.prepare(`
      SELECT COALESCE(SUM(CASE
        WHEN transaction_type IN ('BUY', 'DEPOSIT', 'IPO', 'RIGHTS', 'TRANSFER_IN', 'SWITCH_IN', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'ESPP_CONTRIBUTION') THEN COALESCE(amount, 0)
        WHEN transaction_type IN ('SELL', 'REDEMPTION', 'WITHDRAWAL', 'TRANSFER_OUT', 'SWITCH_OUT', 'CHARGES', 'AMC', 'TDS') THEN -COALESCE(amount, 0)
        ELSE 0
      END), 0) AS net_flow
      FROM transactions
      WHERE investment_id = ? ${portfolio_id ? 'AND portfolio_id = ?' : ''}
        AND date(transaction_date) > ?
        AND date(transaction_date) <= ?
    `);

    for (const inv of investments) {
      const policy = getOneDayChangePolicy(inv.asset_type);
      if (includeOneDayDebug) {
        oneDayDebugSummary.policyCounts[policy] = (oneDayDebugSummary.policyCounts[policy] || 0) + 1;
      }
      const latestRow = portfolio_id
        ? latestDvForInvestment.get(inv.id, portfolio_id)
        : latestDvForInvestment.get(inv.id);

      if (!latestRow) {
        inv.day_change = 0;
        inv.day_change_pct = 0;
        if (includeOneDayDebug) {
          oneDayDebugSummary.noDailyValueCount += 1;
          inv.one_day_debug = {
            policy,
            reason: 'NO_DAILY_VALUE',
          };
        }
        continue;
      }

      const useSessionAnchoring = policy === ONE_DAY_CHANGE_POLICY.MARKET_SESSION
        || policy === ONE_DAY_CHANGE_POLICY.NAV_SNAPSHOT;
      let anchorRow = latestRow;
      let anchoredToMarketSession = false;
      let marketSessionRows = null;
      if (useSessionAnchoring) {
        const marketCandidatesRaw = portfolio_id
          ? latestMarketDvForInvestment.all(inv.id, portfolio_id)
          : latestMarketDvForInvestment.all(inv.id);
        const marketCandidates = marketCandidatesRaw;
        marketSessionRows = marketCandidates.filter((row) =>
          isMarketSessionDate(row.date, marketHolidaySet)
        );

        if (marketSessionRows.length > 0) {
          anchorRow = marketSessionRows[0];
          anchoredToMarketSession = true;
        }
        if (includeOneDayDebug && policy === ONE_DAY_CHANGE_POLICY.MARKET_SESSION) {
          if (anchoredToMarketSession) {
            oneDayDebugSummary.marketAnchoredCount += 1;
          } else {
            oneDayDebugSummary.marketLatestFallbackCount += 1;
          }
        }
      }

      const previousRow = useSessionAnchoring
        ? ((marketSessionRows || []).find((row) => row.date < anchorRow.date)
          || (portfolio_id
            ? previousDvForAnchorDate.get(inv.id, portfolio_id, anchorRow.date)
            : previousDvForAnchorDate.get(inv.id, anchorRow.date)))
        : (portfolio_id
          ? previousDvForAnchorDate.get(inv.id, portfolio_id, anchorRow.date)
          : previousDvForAnchorDate.get(inv.id, anchorRow.date));

      if (!previousRow) {
        inv.day_change = 0;
        inv.day_change_pct = 0;
        if (includeOneDayDebug) {
          oneDayDebugSummary.noPreviousRowCount += 1;
          inv.one_day_debug = {
            policy,
            latestDate: latestRow.date,
            anchorDate: anchorRow.date,
            anchorPriceSource: anchorRow.price_source || null,
            anchoredToMarketSession,
            marketHolidayCount: marketHolidaySet.size,
            reason: 'NO_PREVIOUS_ROW',
          };
        }
        continue;
      }

      const netFlow = portfolio_id
        ? Number(netFlowOnAnchorDate.get(inv.id, portfolio_id, anchorRow.date)?.net_flow || 0)
        : Number(netFlowOnAnchorDate.get(inv.id, anchorRow.date)?.net_flow || 0);
      const netFlowRange = portfolio_id
        ? Number(netFlowInRange.get(inv.id, portfolio_id, previousRow.date, anchorRow.date)?.net_flow || 0)
        : Number(netFlowInRange.get(inv.id, previousRow.date, anchorRow.date)?.net_flow || 0);

      const prevValue = Number(previousRow.current_value || 0);
      const anchorValue = Number(anchorRow.current_value || 0);
      const rawDayChange = policy === ONE_DAY_CHANGE_POLICY.ACCRUAL_SNAPSHOT
        ? (anchorValue - prevValue - netFlowRange)
        : (anchorValue - prevValue - netFlow);
      const daySpan = diffIsoDays(previousRow.date, anchorRow.date);
      const dayChange = policy === ONE_DAY_CHANGE_POLICY.ACCRUAL_SNAPSHOT
        ? (rawDayChange / daySpan)
        : rawDayChange;
      const dayChangePct = prevValue > 0 ? (dayChange / prevValue) * 100 : 0;

      inv.day_change = dayChange;
      inv.day_change_pct = dayChangePct;
      if (includeOneDayDebug) {
        inv.one_day_debug = {
          policy,
          latestDate: latestRow.date,
          anchorDate: anchorRow.date,
          previousDate: previousRow.date,
          anchorPriceSource: anchorRow.price_source || null,
          anchoredToMarketSession,
          marketHolidayCount: marketHolidaySet.size,
          daySpan,
          netFlow,
          netFlowRange,
          rawDayChange,
          computedDayChange: dayChange,
          computedDayChangePct: dayChangePct,
        };
      }
    }

    // Add folio information for MF investments
    for (const inv of investments) {
      if (inv.asset_type === 'MUTUAL_FUND') {
        const folios = db.prepare(`
          SELECT 
            folio_number,
            COALESCE(SUM(CASE 
              WHEN transaction_type IN ('BUY', 'DEPOSIT', 'BONUS', 'SPLIT', 'IPO', 'TRANSFER_IN', 'SWITCH_IN', 'RIGHTS', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'VEST', 'ESPP_PURCHASE') THEN COALESCE(units, 0)
              WHEN transaction_type IN ('SELL', 'REDEMPTION', 'WITHDRAWAL', 'TRANSFER_OUT', 'SWITCH_OUT', 'CONSOLIDATION', 'CHARGES', 'AMC') THEN -COALESCE(units, 0)
              ELSE 0 END), 0) as net_units
          FROM transactions 
          WHERE investment_id = ? ${portfolio_id ? 'AND portfolio_id = ?' : ''}
          AND folio_number IS NOT NULL
          GROUP BY folio_number
        `).all(portfolio_id ? [inv.id, portfolio_id] : [inv.id]);
        
        inv.open_folios_count = folios.filter(f => f.net_units > 0.0001).length;
        inv.total_folios_count = folios.length;
      }
    }

    const latestSnapshotDate = investments.reduce((maxDate, inv) => {
      if (!inv.date) return maxDate;
      return !maxDate || inv.date > maxDate ? inv.date : maxDate;
    }, null);

    // Group by asset type
    const byType = {};
    for (const inv of investments) {
      if (!byType[inv.asset_type]) {
        byType[inv.asset_type] = { 
          investments: [], 
          totalValue: 0, 
          totalInvested: 0, 
          totalProfitLoss: 0,
          dayChange: 0 
        };
      }
      byType[inv.asset_type].investments.push(inv);
      byType[inv.asset_type].totalValue += inv.current_value || 0;
      byType[inv.asset_type].totalInvested += inv.invested_amount || 0;
      byType[inv.asset_type].totalProfitLoss += inv.profit_loss || 0;
      byType[inv.asset_type].dayChange += inv.day_change || 0;
    }

    const derivedPortfolio = {
      date: latestSnapshotDate || latest?.date || null,
      total_value: investments.reduce((sum, inv) => sum + (Number(inv.current_value) || 0), 0),
      total_invested: investments.reduce((sum, inv) => sum + (Number(inv.invested_amount) || 0), 0),
      total_profit_loss: investments.reduce((sum, inv) => sum + (Number(inv.profit_loss) || 0), 0),
      day_change: investments.reduce((sum, inv) => sum + (Number(inv.day_change) || 0), 0),
    };
    derivedPortfolio.total_profit_loss_pct = derivedPortfolio.total_invested > 0
      ? (derivedPortfolio.total_profit_loss / derivedPortfolio.total_invested) * 100
      : 0;

    const previousPortfolioSnapshot = portfolio_id
      ? db.prepare(
          'SELECT total_value FROM portfolio_daily WHERE portfolio_id = ? AND date < ? ORDER BY date DESC LIMIT 1'
        ).get(portfolio_id, derivedPortfolio.date || '9999-12-31')
      : db.prepare(
          'SELECT total_value FROM portfolio_daily WHERE portfolio_id IS NULL AND date < ? ORDER BY date DESC LIMIT 1'
        ).get(derivedPortfolio.date || '9999-12-31');
    const previousPortfolioValue = Number(previousPortfolioSnapshot?.total_value || 0);
    derivedPortfolio.day_change_pct = previousPortfolioValue > 0
      ? (derivedPortfolio.day_change / previousPortfolioValue) * 100
      : 0;

    // Calculate percentages of portfolio
    const totalValue = derivedPortfolio.total_value;
    for (const inv of investments) {
      inv.portfolio_pct = totalValue > 0 ? ((inv.current_value || 0) / totalValue) * 100 : 0;
    }

    // Get portfolio count info
    const portfolioCount = db.prepare('SELECT COUNT(*) as count FROM portfolios').get().count;

    // Get expense totals
    const expenseFilter = portfolio_id ? ' WHERE portfolio_id = ?' : '';
    const expenseParams = portfolio_id ? [portfolio_id] : [];
    const expenseTotals = db.prepare(
      `SELECT COALESCE(SUM(amount), 0) as total_expenses FROM portfolio_expenses${expenseFilter}`
    ).get(...expenseParams);

    const txnFilter = portfolio_id ? 'WHERE portfolio_id = ?' : '';
    const txnParams = portfolio_id ? [portfolio_id] : [];
    const transactionRows = db.prepare(`
      SELECT t.transaction_type, t.transaction_date, COALESCE(t.amount, 0) as amount, COALESCE(t.fees, 0) as fees, i.asset_type
      FROM transactions t
      JOIN investments i ON i.id = t.investment_id
      ${portfolio_id ? 'WHERE t.portfolio_id = ?' : ''}
    `).all(...txnParams);

    const xirrCashflows = [];
    for (const txn of transactionRows) {
      const txnDate = new Date(txn.transaction_date);
      if (Number.isNaN(txnDate.getTime())) continue;

      const amount = Number(txn.amount) || 0;
      const fees = Number(txn.fees) || 0;
      let cashflow = 0;
      const treatAsInternal = isInternalXirrCashflow(txn.asset_type, txn.transaction_type);

      if (CASH_OUTFLOW_TYPES.has(txn.transaction_type)) {
        cashflow = -(amount + fees);
      } else if (CASH_INFLOW_TYPES.has(txn.transaction_type) && !treatAsInternal) {
        cashflow = amount - fees;
      }

      if (Math.abs(cashflow) > 1e-9) {
        xirrCashflows.push({ amount: cashflow, date: txnDate });
      }
    }

    const expenseRows = db.prepare(`
      SELECT expense_date, COALESCE(amount, 0) as amount
      FROM portfolio_expenses${expenseFilter}
    `).all(...expenseParams);

    for (const expense of expenseRows) {
      const expenseDate = new Date(expense.expense_date);
      if (Number.isNaN(expenseDate.getTime())) continue;

      const amount = Number(expense.amount) || 0;
      if (amount > 0) {
        xirrCashflows.push({ amount: -amount, date: expenseDate });
      }
    }

    const terminalValue = Number(derivedPortfolio.total_value) || 0;
    if (terminalValue > 0 && derivedPortfolio.date) {
      const valuationDate = new Date(derivedPortfolio.date);
      if (!Number.isNaN(valuationDate.getTime())) {
        xirrCashflows.push({ amount: terminalValue, date: valuationDate });
      }
    }

    const xirrRate = calculateXirr(xirrCashflows);
    const xirrPct = xirrRate == null ? null : xirrRate * 100;
    const portfolioSummary = {
      ...latest,
      ...derivedPortfolio,
      xirr_pct: xirrPct,
    };

    res.json({
      portfolio: portfolioSummary,
      investments,
      byType,
      portfolioCount,
      totalExpenses: expenseTotals.total_expenses,
      lastUpdate: db.prepare("SELECT value FROM config WHERE key = 'last_price_update'").get()?.value,
      oneDayDebug: includeOneDayDebug
        ? {
            ...oneDayDebugSummary,
            marketHolidayCount: marketHolidaySet.size,
            totalInvestments: investments.length,
          }
        : undefined,
    });
  });

  // ─── Performance over time periods ─────────────────────────────────────
  router.get('/performance', (req, res) => {
    const { period, from, to, portfolio_id, asset_type } = req.query;

    let startDate, endDate;
    const now = new Date();
    endDate = now.toISOString().split('T')[0];

    if (from && to) {
      startDate = from;
      endDate = to;
    } else {
      switch (period) {
        case '1D': startDate = new Date(now - 1 * 86400000).toISOString().split('T')[0]; break;
        case '7D': startDate = new Date(now - 7 * 86400000).toISOString().split('T')[0]; break;
        case '1M': { const d = new Date(now); d.setMonth(d.getMonth() - 1); startDate = d.toISOString().split('T')[0]; break; }
        case '3M': { const d = new Date(now); d.setMonth(d.getMonth() - 3); startDate = d.toISOString().split('T')[0]; break; }
        case '6M': { const d = new Date(now); d.setMonth(d.getMonth() - 6); startDate = d.toISOString().split('T')[0]; break; }
        case '1Y': { const d = new Date(now); d.setFullYear(d.getFullYear() - 1); startDate = d.toISOString().split('T')[0]; break; }
        case '2Y': { const d = new Date(now); d.setFullYear(d.getFullYear() - 2); startDate = d.toISOString().split('T')[0]; break; }
        case '3Y': { const d = new Date(now); d.setFullYear(d.getFullYear() - 3); startDate = d.toISOString().split('T')[0]; break; }
        case '5Y': { const d = new Date(now); d.setFullYear(d.getFullYear() - 5); startDate = d.toISOString().split('T')[0]; break; }
        default: { const d = new Date(now); d.setMonth(d.getMonth() - 1); startDate = d.toISOString().split('T')[0]; }
      }
    }

    // Portfolio level performance — filtered by portfolio_id
    let portfolioData;
    if (portfolio_id) {
      portfolioData = db.prepare(`
        SELECT * FROM portfolio_daily
        WHERE portfolio_id = ? AND date BETWEEN ? AND ?
        ORDER BY date ASC
      `).all(portfolio_id, startDate, endDate);
    } else {
      portfolioData = db.prepare(`
        SELECT * FROM portfolio_daily
        WHERE portfolio_id IS NULL AND date BETWEEN ? AND ?
        ORDER BY date ASC
      `).all(startDate, endDate);
    }

    // Per-investment performance (portfolio-scoped daily_values)
    const dvFilter = portfolio_id ? 'AND dv.portfolio_id = ?' : 'AND dv.portfolio_id IS NULL';
    const investmentFilter = portfolio_id ? ' AND EXISTS (SELECT 1 FROM transactions t WHERE t.investment_id = i.id AND t.portfolio_id = ?)' : '';
    const investmentParams = portfolio_id
      ? [startDate, endDate, portfolio_id, portfolio_id]
      : [startDate, endDate];

    const investmentData = db.prepare(`
      SELECT dv.*, COALESCE(i.display_name, i.name) as name, i.asset_type
      FROM daily_values dv
      JOIN investments i ON dv.investment_id = i.id
      WHERE dv.date BETWEEN ? AND ? ${dvFilter}${investmentFilter}
      ORDER BY dv.date ASC, i.name ASC
    `).all(...investmentParams);

    const typeFilterClause = asset_type ? 'AND atd.asset_type = ?' : '';
    const typeParams = portfolio_id
      ? [startDate, endDate, portfolio_id, ...(asset_type ? [asset_type] : [])]
      : [startDate, endDate, ...(asset_type ? [asset_type] : [])];
    const typeRows = db.prepare(`
      SELECT atd.*
      FROM asset_type_daily atd
      WHERE atd.date BETWEEN ? AND ?
        ${portfolio_id ? 'AND atd.portfolio_id = ?' : 'AND atd.portfolio_id IS NULL'}
        ${typeFilterClause}
      ORDER BY atd.date ASC, atd.asset_type ASC
    `).all(...typeParams);

    const performanceByAssetType = {};
    for (const row of typeRows) {
      if (!performanceByAssetType[row.asset_type]) {
        performanceByAssetType[row.asset_type] = {
          asset_type: row.asset_type,
          dailyData: [],
        };
      }
      performanceByAssetType[row.asset_type].dailyData.push(row);
    }

    // Calculate period returns
    const startSnapshot = portfolioData[0];
    const endSnapshot = portfolioData[portfolioData.length - 1];
    let periodReturn = 0;
    let periodReturnPct = 0;

    if (startSnapshot && endSnapshot) {
      periodReturn = endSnapshot.total_value - startSnapshot.total_value;
      periodReturnPct = startSnapshot.total_value > 0
        ? (periodReturn / startSnapshot.total_value) * 100 : 0;
    }

    res.json({
      period: period || 'custom',
      startDate,
      endDate,
      portfolioData,
      investmentData,
      performanceByAssetType,
      periodReturn: Math.round(periodReturn * 100) / 100,
      periodReturnPct: Math.round(periodReturnPct * 100) / 100,
    });
  });

  // ─── Asset-type performance time series ──────────────────────────────
  router.get('/performance-by-type', (req, res) => {
    const { asset_type, period, from, to, portfolio_id } = req.query;
    if (!asset_type) {
      return res.status(400).json({ error: 'asset_type is required' });
    }

    let startDate;
    let endDate;
    const now = new Date();
    endDate = now.toISOString().split('T')[0];

    if (from && to) {
      startDate = from;
      endDate = to;
    } else {
      switch (period) {
        case '1D': startDate = new Date(now - 1 * 86400000).toISOString().split('T')[0]; break;
        case '7D': startDate = new Date(now - 7 * 86400000).toISOString().split('T')[0]; break;
        case '1M': { const d = new Date(now); d.setMonth(d.getMonth() - 1); startDate = d.toISOString().split('T')[0]; break; }
        case '3M': { const d = new Date(now); d.setMonth(d.getMonth() - 3); startDate = d.toISOString().split('T')[0]; break; }
        case '6M': { const d = new Date(now); d.setMonth(d.getMonth() - 6); startDate = d.toISOString().split('T')[0]; break; }
        case '1Y': { const d = new Date(now); d.setFullYear(d.getFullYear() - 1); startDate = d.toISOString().split('T')[0]; break; }
        case '2Y': { const d = new Date(now); d.setFullYear(d.getFullYear() - 2); startDate = d.toISOString().split('T')[0]; break; }
        case '3Y': { const d = new Date(now); d.setFullYear(d.getFullYear() - 3); startDate = d.toISOString().split('T')[0]; break; }
        case '5Y': { const d = new Date(now); d.setFullYear(d.getFullYear() - 5); startDate = d.toISOString().split('T')[0]; break; }
        default: { const d = new Date(now); d.setMonth(d.getMonth() - 1); startDate = d.toISOString().split('T')[0]; }
      }
    }

    const rows = db.prepare(`
      SELECT *
      FROM asset_type_daily
      WHERE asset_type = ?
        ${portfolio_id ? 'AND portfolio_id = ?' : 'AND portfolio_id IS NULL'}
        AND date BETWEEN ? AND ?
      ORDER BY date ASC
    `).all(
      ...(portfolio_id ? [asset_type, portfolio_id, startDate, endDate] : [asset_type, startDate, endDate])
    );

    return res.json({
      asset_type,
      period: period || 'custom',
      startDate,
      endDate,
      data: rows,
    });
  });

  // ─── Individual investment performance ────────────────────────────────
  router.get('/performance/:investmentId', (req, res) => {
    const { period, portfolio_id } = req.query;
    const now = new Date();
    let startDate;

    switch (period) {
      case '1D': startDate = new Date(now - 2 * 86400000).toISOString().split('T')[0]; break;
      case '7D': startDate = new Date(now - 7 * 86400000).toISOString().split('T')[0]; break;
      case '1M': { const d = new Date(now); d.setMonth(d.getMonth() - 1); startDate = d.toISOString().split('T')[0]; break; }
      case '3M': { const d = new Date(now); d.setMonth(d.getMonth() - 3); startDate = d.toISOString().split('T')[0]; break; }
      case '6M': { const d = new Date(now); d.setMonth(d.getMonth() - 6); startDate = d.toISOString().split('T')[0]; break; }
      case '1Y': { const d = new Date(now); d.setFullYear(d.getFullYear() - 1); startDate = d.toISOString().split('T')[0]; break; }
      case '3Y': { const d = new Date(now); d.setFullYear(d.getFullYear() - 3); startDate = d.toISOString().split('T')[0]; break; }
      case '5Y': { const d = new Date(now); d.setFullYear(d.getFullYear() - 5); startDate = d.toISOString().split('T')[0]; break; }
      default: { const d = new Date(now); d.setFullYear(d.getFullYear() - 1); startDate = d.toISOString().split('T')[0]; }
    }

    const dvPidFilter = portfolio_id ? 'AND portfolio_id = ?' : 'AND portfolio_id IS NULL';
    const dvPidParams = portfolio_id ? [portfolio_id] : [];

    const data = db.prepare(`
      SELECT * FROM daily_values
      WHERE investment_id = ? ${dvPidFilter} AND date >= ?
      ORDER BY date ASC
    `).all(req.params.investmentId, ...dvPidParams, startDate);

    res.json(data);
  });

  // ─── Asset allocation breakdown ───────────────────────────────────────
  router.get('/allocation', (req, res) => {
    const { portfolio_id } = req.query;
    const portfolioFilter = portfolio_id ? ' AND EXISTS (SELECT 1 FROM transactions t WHERE t.investment_id = i.id AND t.portfolio_id = ?)' : '';
    const dvJoin = portfolio_id ? 'AND dv.portfolio_id = ?' : 'AND dv.portfolio_id IS NULL';
    const dvSub = portfolio_id ? 'AND portfolio_id = ?' : 'AND portfolio_id IS NULL';
    const dvParams = portfolio_id ? [portfolio_id] : [];
    const pfParams = portfolio_id ? [portfolio_id] : [];

    const allocation = db.prepare(`
      SELECT
        i.asset_type,
        COUNT(*) as count,
        COALESCE(SUM(dv.current_value), 0) as total_value,
        COALESCE(SUM(dv.invested_amount), 0) as total_invested,
        COALESCE(SUM(dv.profit_loss), 0) as total_profit_loss
      FROM investments i
      LEFT JOIN daily_values dv ON i.id = dv.investment_id
        ${dvJoin}
        AND dv.date = (SELECT MAX(date) FROM daily_values WHERE investment_id = i.id ${dvSub})
      WHERE 1=1${portfolioFilter}
      GROUP BY i.asset_type
    `).all(...dvParams, ...dvParams, ...pfParams);

    res.json(allocation);
  });

  return router;
};
