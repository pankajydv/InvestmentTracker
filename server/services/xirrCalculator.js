const { logAppWarn } = require('./appLogger');
const { computeXirrRate } = require('./xirrMath');
const {
  XIRR_OUTFLOW_TYPES,
  XIRR_INFLOW_TYPES,
  isInternalXirrCashflow,
  isAccrualOnlyXirrCashflow,
} = require('./xirrClassification');
const { EXTERNAL_CASH_IN_TYPES, EXTERNAL_CASH_OUT_TYPES, toSqlInList, CALCULATION_VERSION } = require('./transactionEffectPolicy');

// Interval-XIRR opening/closing values and date bounds come from the canonical portfolio
// projection when present, so the boundaries match the card and history.
function portfolioV2Source() {
  return {
    table: 'portfolio_metrics_daily',
    valueCol: 'current_value',
    dayChangeCol: 'total_day_change',
    calcClause: `AND calculation_version = ${Number(CALCULATION_VERSION)}`,
  };
}

function getScopedPortfolioDateBounds(db, portfolioId, requestedFrom, requestedTo) {
  const src = portfolioV2Source(db);
  if (portfolioId) {
    const row = db.prepare(`
      SELECT
        MIN(date) AS chosen_from,
        MAX(date) AS chosen_to
      FROM ${src.table}
      WHERE portfolio_id = ?
        AND date >= ?
        AND date <= ?
        ${src.calcClause}
    `).get(portfolioId, requestedFrom, requestedTo);
    return {
      from: row?.chosen_from || null,
      to: row?.chosen_to || null,
    };
  }

  const row = db.prepare(`
    SELECT
      MIN(date) AS chosen_from,
      MAX(date) AS chosen_to
    FROM ${src.table}
    WHERE portfolio_id IS NOT NULL
      AND date >= ?
      AND date <= ?
      ${src.calcClause}
  `).get(requestedFrom, requestedTo);

  return {
    from: row?.chosen_from || null,
    to: row?.chosen_to || null,
  };
}

function getPortfolioValueOnDate(db, portfolioId, date) {
  if (!date) return 0;
  const src = portfolioV2Source(db);
  if (portfolioId) {
    return Number(db.prepare(`
      SELECT COALESCE(${src.valueCol}, 0) AS total_value
      FROM ${src.table}
      WHERE portfolio_id = ? AND date = ? ${src.calcClause}
      LIMIT 1
    `).get(portfolioId, date)?.total_value || 0);
  }

  return Number(db.prepare(`
    SELECT COALESCE(SUM(${src.valueCol}), 0) AS total_value
    FROM ${src.table}
    WHERE portfolio_id IS NOT NULL AND date = ? ${src.calcClause}
  `).get(date)?.total_value || 0);
}

function sumPortfolioDayChange(db, portfolioId, fromDate, toDate) {
  if (!fromDate || !toDate || fromDate > toDate) return 0;
  const src = portfolioV2Source(db);
  if (portfolioId) {
    return Number(db.prepare(`
      SELECT COALESCE(SUM(${src.dayChangeCol}), 0) AS day_change
      FROM ${src.table}
      WHERE portfolio_id = ?
        AND date > ?
        AND date <= ?
        ${src.calcClause}
    `).get(portfolioId, fromDate, toDate)?.day_change || 0);
  }

  return Number(db.prepare(`
    SELECT COALESCE(SUM(${src.dayChangeCol}), 0) AS day_change
    FROM ${src.table}
    WHERE portfolio_id IS NOT NULL
      AND date > ?
      AND date <= ?
      ${src.calcClause}
  `).get(fromDate, toDate)?.day_change || 0);
}

function sumScopedNetExternalFlows(db, portfolioId, fromDate, toDate) {
  if (!fromDate || !toDate || fromDate > toDate) return 0;

  const baseSql = `
    SELECT COALESCE(SUM(CASE
      WHEN transaction_type IN (${toSqlInList(EXTERNAL_CASH_IN_TYPES)}) THEN COALESCE(amount, 0)
      WHEN transaction_type IN (${toSqlInList(EXTERNAL_CASH_OUT_TYPES)}) THEN -COALESCE(amount, 0)
      WHEN transaction_type = 'TDS' THEN -ABS(COALESCE(amount, 0))
      ELSE 0
    END), 0) AS net_flow
    FROM transactions
    WHERE DATE(transaction_date) > ?
      AND DATE(transaction_date) <= ?
  `;

  if (portfolioId) {
    return Number(db.prepare(`${baseSql} AND portfolio_id = ?`).get(fromDate, toDate, portfolioId)?.net_flow || 0);
  }

  return Number(db.prepare(`${baseSql} AND portfolio_id IS NOT NULL`).get(fromDate, toDate)?.net_flow || 0);
}

/**
 * Calculate XIRR for an interval.
 * 
 * @param {Object} db - Database instance
 * @param {number} portfolioId - Portfolio ID (null for combined mode)
 * @param {string} fromDate - Start date (YYYY-MM-DD), inclusive
 * @param {string} toDate - End date (YYYY-MM-DD), inclusive
 * @returns {Object} { xirr_pct, opening_value, closing_value, interval_change, confidence, error }
 */
function calculateIntervalXIRR(db, portfolioId, fromDate, toDate) {
  try {
    // Validate dates are in database
    const boundsSrc = portfolioV2Source(db);
    const latestDateInDb = db.prepare(`
      SELECT MAX(date) AS max_date FROM ${boundsSrc.table} WHERE portfolio_id IS NOT NULL ${boundsSrc.calcClause}
    `).get()?.max_date;

    if (!latestDateInDb) {
      return {
        xirr_pct: null,
        opening_value: 0,
        closing_value: 0,
        interval_change: 0,
        interval_change_pct: 0,
        confidence: 'no_data',
        error: 'No portfolio data available',
      };
    }

    // If toDate is in the future, use latest available date instead
    if (toDate > latestDateInDb) {
      toDate = latestDateInDb;
    }

    // If fromDate is after toDate, collapse to a 1-point window.
    if (fromDate > toDate) {
      fromDate = toDate;
    }

    // Non-1D intervals must snap strictly inside requested bounds.
    const requestedFrom = fromDate;
    const requestedTo = toDate;
    const chosen = getScopedPortfolioDateBounds(db, portfolioId, requestedFrom, requestedTo);
    if (!chosen.from || !chosen.to || chosen.from > chosen.to) {
      return {
        xirr_pct: null,
        opening_value: 0,
        closing_value: 0,
        interval_change: 0,
        interval_change_pct: 0,
        confidence: 'no_data',
        error: 'No portfolio snapshot data inside requested interval',
        requested_from_date: requestedFrom,
        requested_to_date: requestedTo,
        from_date: null,
        to_date: null,
      };
    }
    fromDate = chosen.from;
    toDate = chosen.to;

    const openingValue = getPortfolioValueOnDate(db, portfolioId, fromDate);
    const closingValue = getPortfolioValueOnDate(db, portfolioId, toDate);

    // The opening snapshot is end-of-day on fromDate, so only later flows belong
    // to the interval. Including fromDate transactions would count them twice.
    let txnQuery = `
      SELECT
        DATE(t.transaction_date) AS txn_date,
        t.transaction_type,
        t.notes,
        i.asset_type,
        COALESCE(t.amount, 0) AS amount,
        COALESCE(t.fees, 0) AS fees
      FROM transactions t
      JOIN investments i ON i.id = t.investment_id
      WHERE DATE(t.transaction_date) > ? AND DATE(t.transaction_date) <= ?
        AND t.portfolio_id IS NOT NULL
        AND COALESCE(i.exclude_from_tracking, 0) = 0
      ORDER BY DATE(t.transaction_date)
    `;
    let txnParams = [fromDate, toDate];

    if (portfolioId) {
      txnQuery = `
        SELECT
          DATE(t.transaction_date) AS txn_date,
          t.transaction_type,
          t.notes,
          i.asset_type,
          COALESCE(t.amount, 0) AS amount,
          COALESCE(t.fees, 0) AS fees
        FROM transactions t
        JOIN investments i ON i.id = t.investment_id
        WHERE DATE(t.transaction_date) > ? AND DATE(t.transaction_date) <= ?
          AND t.portfolio_id = ?
          AND COALESCE(i.exclude_from_tracking, 0) = 0
        ORDER BY DATE(t.transaction_date)
      `;
      txnParams = [fromDate, toDate, portfolioId];
    }

    const transactions = db.prepare(txnQuery).all(...txnParams);

    // Build cash flows for XIRR
    const cashFlows = [];

    // Opening value as negative (investor's initial investment perspective)
    // Use from_date as the opening anchor for interval math.
    if (openingValue !== 0) {
      cashFlows.push({
        date: new Date(fromDate),
        amount: -openingValue, // Negative = cash outflow (investor's perspective)
      });
    }

    // Add transaction cash flows
    for (const txn of transactions) {
      // Provident internal accrual and auto-accrued interest are not external cash.
      if (isInternalXirrCashflow(txn.asset_type, txn.transaction_type)) continue;
      if (isAccrualOnlyXirrCashflow(txn.transaction_type, txn.notes)) continue;

      let amount = Number(txn.amount || 0) + Number(txn.fees || 0);

      // Outflow (negative) = money invested; inflow (positive) = money received.
      // Types in neither set (corporate actions, zero-amount markers) carry no cash.
      if (XIRR_OUTFLOW_TYPES.has(txn.transaction_type)) {
        amount = -Math.abs(amount);
      } else if (XIRR_INFLOW_TYPES.has(txn.transaction_type)) {
        amount = Math.abs(amount);
      } else {
        continue;
      }

      if (amount !== 0) {
        cashFlows.push({
          date: new Date(txn.txn_date),
          amount: amount,
        });
      }
    }

    // Closing value as positive (investor receives back)
    if (closingValue !== 0) {
      cashFlows.push({
        date: new Date(toDate),
        amount: closingValue, // Positive = cash inflow (investor's perspective)
      });
    }

    // Calculate XIRR with a robust bisection estimator.
    let xirrPct = null;
    if (cashFlows.length >= 2) {
      const rate = computeXirrRate(cashFlows);
      if (rate == null) {
        return {
          xirr_pct: null,
          opening_value: openingValue,
          closing_value: closingValue,
          interval_change: sumPortfolioDayChange(db, portfolioId, fromDate, toDate),
          interval_change_pct: openingValue > 0
            ? (sumPortfolioDayChange(db, portfolioId, fromDate, toDate) / openingValue) * 100
            : 0,
          confidence: 'no_xirr',
          error: 'XIRR did not converge for the interval cash flows',
          requested_from_date: requestedFrom,
          requested_to_date: requestedTo,
          from_date: fromDate,
          to_date: toDate,
        };
      }
      xirrPct = rate * 100;
    }

    const intervalChange = sumPortfolioDayChange(db, portfolioId, fromDate, toDate);
    const netFlow = sumScopedNetExternalFlows(db, portfolioId, fromDate, toDate);
    const snapshotDerivedIntervalChange = closingValue - openingValue - netFlow;
    const deviationAbs = Math.abs(intervalChange - snapshotDerivedIntervalChange);
    const deviationThreshold = Math.max(1, Math.abs(intervalChange) * 0.0025);
    if (deviationAbs > deviationThreshold) {
      logAppWarn('[Interval][Portfolio] day_change and snapshot-flow interval deviation', {
        portfolio_id: portfolioId || null,
        requested_from_date: requestedFrom,
        requested_to_date: requestedTo,
        chosen_from_date: fromDate,
        chosen_to_date: toDate,
        opening_value: openingValue,
        closing_value: closingValue,
        net_external_cashflows: netFlow,
        interval_change_from_day_change: intervalChange,
        interval_change_from_snapshot_flow: snapshotDerivedIntervalChange,
        deviation_abs: deviationAbs,
        deviation_threshold: deviationThreshold,
      });
    }

    return {
      xirr_pct: xirrPct,
      opening_value: openingValue,
      closing_value: closingValue,
      interval_change: intervalChange,
      interval_change_pct: openingValue > 0
        ? (intervalChange / openingValue) * 100
        : 0,
      confidence: xirrPct !== null ? 'full' : 'partial',
      error: null,
      requested_from_date: requestedFrom,
      requested_to_date: requestedTo,
      from_date: fromDate,
      to_date: toDate,
    };
  } catch (err) {
    return {
      xirr_pct: null,
      opening_value: 0,
      closing_value: 0,
      interval_change: 0,
      interval_change_pct: 0,
      confidence: 'error',
      error: err.message,
      requested_from_date: fromDate,
      requested_to_date: toDate,
      from_date: null,
      to_date: null,
    };
  }
}

module.exports = {
  calculateIntervalXIRR,
};
