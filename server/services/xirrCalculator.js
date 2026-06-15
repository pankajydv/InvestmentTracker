const xirr = require('xirr');

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
    const latestDateInDb = db.prepare(`
      SELECT MAX(date) AS max_date FROM portfolio_daily WHERE portfolio_id IS NOT NULL
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

    // If fromDate is after toDate, swap or adjust
    if (fromDate > toDate) {
      fromDate = toDate;
    }

    // Get opening/closing values using latest available rollup snapshots <= boundary dates.
    let openingValue = 0;
    let closingValue = 0;

    if (portfolioId) {
      const opening = db.prepare(`
        SELECT total_value
        FROM portfolio_daily
        WHERE portfolio_id = ? AND date <= ?
        ORDER BY date DESC
        LIMIT 1
      `).get(portfolioId, fromDate);

      const closing = db.prepare(`
        SELECT total_value
        FROM portfolio_daily
        WHERE portfolio_id = ? AND date <= ?
        ORDER BY date DESC
        LIMIT 1
      `).get(portfolioId, toDate);

      openingValue = Number(opening?.total_value || 0);
      closingValue = Number(closing?.total_value || 0);
    } else {
      const openingDate = db.prepare(`
        SELECT MAX(date) AS max_date
        FROM portfolio_daily
        WHERE portfolio_id IS NOT NULL AND date <= ?
      `).get(fromDate)?.max_date || null;

      const closingDate = db.prepare(`
        SELECT MAX(date) AS max_date
        FROM portfolio_daily
        WHERE portfolio_id IS NOT NULL AND date <= ?
      `).get(toDate)?.max_date || null;

      const opening = openingDate
        ? db.prepare(`
            SELECT SUM(COALESCE(total_value, 0)) AS total_value
            FROM portfolio_daily
            WHERE portfolio_id IS NOT NULL AND date = ?
          `).get(openingDate)
        : null;

      const closing = closingDate
        ? db.prepare(`
            SELECT SUM(COALESCE(total_value, 0)) AS total_value
            FROM portfolio_daily
            WHERE portfolio_id IS NOT NULL AND date = ?
          `).get(closingDate)
        : null;

      openingValue = Number(opening?.total_value || 0);
      closingValue = Number(closing?.total_value || 0);
    }

    // Get all transactions in interval (from_date to to_date, inclusive)
    let txnQuery = `
      SELECT
        DATE(t.transaction_date) AS txn_date,
        t.transaction_type,
        COALESCE(t.amount, 0) AS amount,
        COALESCE(t.fees, 0) AS fees
      FROM transactions t
      WHERE DATE(t.transaction_date) >= ? AND DATE(t.transaction_date) <= ?
        AND t.portfolio_id IS NOT NULL
      ORDER BY DATE(t.transaction_date)
    `;
    let txnParams = [fromDate, toDate];

    if (portfolioId) {
      txnQuery = `
        SELECT
          DATE(t.transaction_date) AS txn_date,
          t.transaction_type,
          COALESCE(t.amount, 0) AS amount,
          COALESCE(t.fees, 0) AS fees
        FROM transactions t
        WHERE DATE(t.transaction_date) >= ? AND DATE(t.transaction_date) <= ?
          AND t.portfolio_id = ?
        ORDER BY DATE(t.transaction_date)
      `;
      txnParams = [fromDate, toDate, portfolioId];
    }

    const transactions = db.prepare(txnQuery).all(...txnParams);

    // Classify transactions as cash inflows or outflows
    const INFLOW_TYPES = new Set([
      'SELL', 'REDEMPTION', 'WITHDRAWAL', 'TRANSFER_IN', 'DIVIDEND',
      'INTEREST', 'BONUS', 'RIGHTS', 'TRANSFER_OUT', 'SWITCH_OUT'
    ]);

    const OUTFLOW_TYPES = new Set([
      'BUY', 'DEPOSIT', 'PURCHASE', 'INVESTMENT', 'TRANSFER_OUT', 'SWITCH_OUT',
      'FEES', 'CHARGES', 'INSURANCE', 'TDS'
    ]);

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
      let amount = Number(txn.amount || 0) + Number(txn.fees || 0);

      // Treat as outflow (negative) if it's a buy/invest/fee
      // Treat as inflow (positive) if it's a sell/dividend/interest
      if (OUTFLOW_TYPES.has(txn.transaction_type)) {
        amount = -Math.abs(amount);
      } else if (INFLOW_TYPES.has(txn.transaction_type)) {
        amount = Math.abs(amount);
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

    // Calculate XIRR
    let xirrPct = null;
    if (cashFlows.length >= 2) {
      try {
        xirrPct = xirr(cashFlows) * 100; // Convert to percentage
      } catch (err) {
        // XIRR calculation failed (e.g., invalid cash flow pattern)
        return {
          xirr_pct: null,
          opening_value: openingValue,
          closing_value: closingValue,
          interval_change: closingValue - openingValue,
          interval_change_pct: openingValue > 0
            ? ((closingValue - openingValue) / openingValue) * 100
            : 0,
          confidence: 'no_xirr',
          error: `XIRR calculation failed: ${err.message}`,
        };
      }
    }

    const intervalChange = closingValue - openingValue;

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
    };
  }
}

module.exports = {
  calculateIntervalXIRR,
};
