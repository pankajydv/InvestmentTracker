function toYearMonth(dateStr) {
  return String(dateStr || '').slice(0, 7);
}

function addMonths(yearMonth, delta) {
  const [y, m] = yearMonth.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function yearMonthRange(startYm, endYm) {
  const out = [];
  let cur = startYm;
  while (cur <= endYm) {
    out.push(cur);
    cur = addMonths(cur, 1);
  }
  return out;
}

function fiscalYearForMonth(yearMonth) {
  const [y, m] = yearMonth.split('-').map(Number);
  return m >= 4 ? y + 1 : y;
}

function roundTo(value, decimals) {
  const f = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * f) / f;
}

function parseRateEntries(rateRows) {
  return (rateRows || [])
    .map((r) => ({
      rate: Number(r.rate),
      from: String(r.effective_from),
      to: r.effective_to ? String(r.effective_to) : null,
    }))
    .sort((a, b) => a.from.localeCompare(b.from));
}

function toDateOnly(dateStr) {
  return String(dateStr || '').slice(0, 10);
}

function fmtDate(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function lastDayOfMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function safeDateFromYm(ym) {
  const [y, m] = ym.split('-').map(Number);
  return { y, m };
}

function getRateForDate(rateRows, dateStr) {
  for (const r of rateRows) {
    if (dateStr >= r.from && (!r.to || dateStr <= r.to)) return r.rate;
  }
  if (!rateRows.length) return null;
  return rateRows[rateRows.length - 1].rate;
}

/**
 * EPFO-style PF interest preview (simplified post-date-migration).
 *
 * - Contributions are dated on the 10th of the month they belong to (no Shift+1 needed).
 * - Interest computed monthly on month-end running EPF balance.
 * - Interest is accumulated monthly and credited yearly (Mar end).
 * - All transaction types included in running balance with appropriate signs.
 * - RECONCILE rows always included in running balance as checkpoint adjustments.
 */
function calculatePfInterestPreview({
  openingBalance = 0,
  transactions = [],
  rateRows = [],
  fromDate,
  toDate,
  monthlyRoundingDecimals = 2,
  ignoreExistingInterest = true,
  includeTransferTransactions = false,
}) {
  // Define which transaction types increase (credit) or decrease (debit) the balance
  const creditTypes = new Set(['DEPOSIT', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'TRANSFER_IN', 'INTEREST', 'RECONCILE', 'DIVIDEND', 'BONUS', 'RIGHTS', 'MERGER']);
  const debitTypes = new Set(['WITHDRAWAL', 'TRANSFER_OUT', 'CHARGES', 'AMC', 'CONSOLIDATION', 'TDS']);
  const deferredContributionTypes = new Set(['DEPOSIT', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION']);
  if (!includeTransferTransactions) {
    debitTypes.delete('TRANSFER_OUT');
    creditTypes.delete('TRANSFER_IN');
  }

  const startYm = toYearMonth(fromDate);
  const endYm = toYearMonth(toDate);
  if (!startYm || !endYm || startYm > endYm) {
    throw new Error('Invalid from/to range for PF interest calculation.');
  }

  const parsedRates = parseRateEntries(rateRows);

  const postingsByMonth = new Map();
  const deferredContributionsByMonth = new Map();

  for (const t of transactions) {
    const dateStr = String(t.transaction_date || '');
    if (!dateStr || dateStr < fromDate || dateStr > toDate) continue;

    const type = String(t.transaction_type || '');
    let signed = 0;

    // Include ALL transaction types with appropriate signs
    if (type === 'INTEREST' && ignoreExistingInterest) {
      // Skip existing INTEREST rows if ignoring them
      continue;
    } else if (creditTypes.has(type)) {
      signed = Number(t.amount || 0);
    } else if (debitTypes.has(type)) {
      signed = -Math.abs(Number(t.amount || 0));
    } else {
      // Default: treat unknown transaction types as credits
      signed = Number(t.amount || 0);
    }

    const ym = toYearMonth(dateStr);
    if (ym < startYm || ym > endYm) continue;

    postingsByMonth.set(ym, (postingsByMonth.get(ym) || 0) + signed);
    if (deferredContributionTypes.has(type)) {
      deferredContributionsByMonth.set(ym, (deferredContributionsByMonth.get(ym) || 0) + signed);
    }
  }

  const monthlyRows = [];
  const annualRows = [];

  let balance = Number(openingBalance || 0);
  let runningInterest = 0;
  let currentFy = null;
  let fyContribution = 0;

  for (const ym of yearMonthRange(startYm, endYm)) {
    const [yy, mm] = ym.split('-').map(Number);
    const fy = fiscalYearForMonth(ym);
    const monthPostings = roundTo(postingsByMonth.get(ym) || 0, 2);
    const monthDeferredContribution = roundTo(deferredContributionsByMonth.get(ym) || 0, 2);
    const monthContribution = roundTo(Math.max(monthDeferredContribution, 0), 2);

    if (currentFy == null) currentFy = fy;
    if (fy !== currentFy) {
      annualRows.push({
        fy: `FY${currentFy - 1}-${String(currentFy).slice(2)}`,
        contributions: roundTo(fyContribution, 2),
        interest: roundTo(runningInterest, 2),
        balanceAfterInterest: roundTo(balance, 2),
      });
      currentFy = fy;
      fyContribution = 0;
      runningInterest = 0;
    }

    balance = roundTo(balance + monthPostings, 2);
    fyContribution = roundTo(fyContribution + monthContribution, 2);

    const monthEndDate = fmtDate(yy, mm, lastDayOfMonth(yy, mm));
    const rate = getRateForDate(parsedRates, monthEndDate);
    if (rate == null) {
      throw new Error(`No PF interest rate configured for month ${ym}.`);
    }

    // EPFO-style: withdrawals/reconcile impact this month's interest base,
    // while same-month PF contributions start earning from next month.
    const interestBase = roundTo(balance - monthDeferredContribution, 2);
    const rawMonthInterest = interestBase * (Number(rate) / 1200);
    const monthInterest = roundTo(rawMonthInterest, monthlyRoundingDecimals);
    // Keep full precision for annual PF credit and round only at FY close.
    runningInterest += rawMonthInterest;

    const isFyEnd = mm === 3;
    if (isFyEnd) {
      const fyInterest = Math.round(runningInterest);
      balance = roundTo(balance + fyInterest, 2);
      annualRows.push({
        fy: `FY${fy - 1}-${String(fy).slice(2)}`,
        contributions: roundTo(fyContribution, 2),
        interest: fyInterest,
        balanceAfterInterest: roundTo(balance, 2),
      });
      currentFy = null;
      fyContribution = 0;
      runningInterest = 0;
    }

    monthlyRows.push({
      month: ym,
      postingDelta: monthPostings,
      deferredContributionDelta: monthDeferredContribution,
      rate,
      interestBase: roundTo(interestBase, 2),
      monthInterest,
      runningBalance: roundTo(balance, 2),
    });
  }

  if (currentFy != null) {
    const fyInterest = Math.round(runningInterest);
    annualRows.push({
      fy: `FY${currentFy - 1}-${String(currentFy).slice(2)}`,
      contributions: roundTo(fyContribution, 2),
      interest: fyInterest,
      balanceAfterInterest: roundTo(balance, 2),
    });
  }

  return {
    openingBalance: roundTo(Number(openingBalance || 0), 2),
    closingBalance: roundTo(balance, 2),
    totalInterest: Math.round(annualRows.reduce((s, r) => s + Number(r.interest || 0), 0)),
    annualRows,
    monthlyRows,
    options: {
      monthlyRoundingDecimals,
      ignoreExistingInterest,
      includeTransferTransactions,
    },
  };
}

/**
 * PPF/SSY small-savings style interest preview.
 *
 * Rule:
 * - For each month, interest base = minimum balance between close of 5th and end-of-month.
 * - Monthly interest accrues and is credited on fiscal year end (Mar 31).
 */
function calculateSmallSavingsInterestPreview({
  openingBalance = 0,
  transactions = [],
  rateRows = [],
  fromDate,
  toDate,
  monthlyRoundingDecimals = 2,
  ignoreExistingInterest = true,
  includeTransferTransactions = false,
  interestBaseMethod = 'min_balance_between_5th_and_month_end',
  annualRounding = false,
  yearEndCreditOverrides = null,
}) {
  const creditTypes = new Set(['DEPOSIT', 'BUY']);
  const debitTypes = new Set(['WITHDRAWAL']);
  if (includeTransferTransactions) {
    creditTypes.add('TRANSFER_IN');
    debitTypes.add('TRANSFER_OUT');
  }

  const startYm = toYearMonth(fromDate);
  const endYm = toYearMonth(toDate);
  if (!startYm || !endYm || startYm > endYm) {
    throw new Error('Invalid from/to range for PPF/SSY interest calculation.');
  }

  const parsedRates = parseRateEntries(rateRows);

  const postingsByMonth = new Map();
  for (const t of transactions) {
    const dateStr = toDateOnly(t.transaction_date);
    if (!dateStr || dateStr < fromDate || dateStr > toDate) continue;

    const type = String(t.transaction_type || '');
    let signed = 0;
    if (creditTypes.has(type)) signed = Number(t.amount || 0);
    else if (debitTypes.has(type)) signed = -Math.abs(Number(t.amount || 0));
    else if (type === 'RECONCILE' && !ignoreExistingInterest) signed = Number(t.amount || 0);
    else if (type === 'INTEREST' && !ignoreExistingInterest) signed = Number(t.amount || 0);
    else continue;

    const ym = toYearMonth(dateStr);
    if (ym < startYm || ym > endYm) continue;

    if (!postingsByMonth.has(ym)) postingsByMonth.set(ym, []);
    postingsByMonth.get(ym).push({
      date: dateStr,
      amount: signed,
      isReconcile: type === 'RECONCILE',
    });
  }

  for (const arr of postingsByMonth.values()) {
    arr.sort((a, b) => a.date.localeCompare(b.date));
  }

  const monthlyRows = [];
  const annualRows = [];
  let balance = roundTo(Number(openingBalance || 0), 2);
  let runningInterest = 0;
  let currentFy = null;
  let fyContribution = 0;

  for (const ym of yearMonthRange(startYm, endYm)) {
    const { y: yy, m: mm } = safeDateFromYm(ym);
    const fy = fiscalYearForMonth(ym);
    const monthStart = fmtDate(yy, mm, 1);
    const monthEnd = fmtDate(yy, mm, lastDayOfMonth(yy, mm));
    const fifthDate = fmtDate(yy, mm, 5);
    const monthPostings = postingsByMonth.get(ym) || [];
    const regularPostings = monthPostings.filter((p) => !p.isReconcile);
    const reconcilePostings = monthPostings.filter((p) => p.isReconcile);

    if (currentFy == null) currentFy = fy;
    if (fy !== currentFy) {
      annualRows.push({
        fy: `FY${currentFy - 1}-${String(currentFy).slice(2)}`,
        contributions: roundTo(fyContribution, 2),
        interest: roundTo(runningInterest, 2),
        balanceAfterInterest: roundTo(balance, 2),
      });
      currentFy = fy;
      fyContribution = 0;
      runningInterest = 0;
    }

    // Apply postings up to and including the 5th to get base at close of 5th.
    let baseAtFifthClose = balance;
    let monthContribution = 0;
    for (const p of regularPostings) {
      if (p.date <= fifthDate) {
        baseAtFifthClose = roundTo(baseAtFifthClose + p.amount, 2);
      }
      if (p.amount > 0) {
        monthContribution = roundTo(monthContribution + p.amount, 2);
      }
    }

    // Minimum balance from close of 5th to month-end.
    let minBalance = baseAtFifthClose;
    let rolling = baseAtFifthClose;
    for (const p of regularPostings) {
      if (p.date > fifthDate) {
        rolling = roundTo(rolling + p.amount, 2);
        if (rolling < minBalance) minBalance = rolling;
      }
    }

    // Month-end running balance (all postings in month).
    let endBalance = balance;
    for (const p of regularPostings) {
      endBalance = roundTo(endBalance + p.amount, 2);
    }
    const reconcileDelta = roundTo(reconcilePostings.reduce((s, p) => s + p.amount, 0), 2);

    const rate = getRateForDate(parsedRates, monthEnd);
    if (rate == null) {
      throw new Error(`No interest rate configured for month ${ym}.`);
    }

    const eligibleBase = interestBaseMethod === 'month_end_balance' ? endBalance : minBalance;
    const eligibleBalance = roundTo(Math.max(eligibleBase, 0), 2);
    const rawMonthInterest = eligibleBalance * (Number(rate) / 1200);
    const monthInterest = annualRounding
      ? roundTo(rawMonthInterest, 2)
      : roundTo(rawMonthInterest, monthlyRoundingDecimals);
    runningInterest = annualRounding
      ? roundTo(runningInterest + rawMonthInterest, 8)
      : roundTo(runningInterest + monthInterest, 2);
    fyContribution = roundTo(fyContribution + monthContribution, 2);

    balance = roundTo(endBalance + reconcileDelta, 2);

    const isFyEnd = mm === 3;
    if (isFyEnd) {
      const fyEndDate = fmtDate(yy, mm, lastDayOfMonth(yy, mm));
      const overrideInterest = yearEndCreditOverrides && Object.prototype.hasOwnProperty.call(yearEndCreditOverrides, fyEndDate)
        ? Number(yearEndCreditOverrides[fyEndDate])
        : null;
      const fyInterest = overrideInterest != null
        ? roundTo(overrideInterest, 2)
        : (annualRounding ? Math.round(runningInterest) : roundTo(runningInterest, 2));
      balance = roundTo(balance + fyInterest, 2);
      annualRows.push({
        fy: `FY${fy - 1}-${String(fy).slice(2)}`,
        contributions: roundTo(fyContribution, 2),
        interest: fyInterest,
        balanceAfterInterest: roundTo(balance, 2),
      });
      currentFy = null;
      fyContribution = 0;
      runningInterest = 0;
    }

    monthlyRows.push({
      month: ym,
      monthStart,
      monthEnd,
      baseAtFifthClose: roundTo(baseAtFifthClose, 2),
      eligibleBalance,
      postingDelta: roundTo(monthPostings.reduce((s, p) => s + p.amount, 0), 2),
      rate,
      monthInterest,
      runningBalance: roundTo(balance, 2),
    });
  }

  if (currentFy != null) {
    annualRows.push({
      fy: `FY${currentFy - 1}-${String(currentFy).slice(2)}`,
      contributions: roundTo(fyContribution, 2),
      interest: roundTo(runningInterest, 2),
      balanceAfterInterest: roundTo(balance, 2),
    });
  }

  return {
    openingBalance: roundTo(Number(openingBalance || 0), 2),
    closingBalance: roundTo(balance, 2),
    totalInterest: roundTo(annualRows.reduce((s, r) => s + r.interest, 0), 2),
    annualRows,
    monthlyRows,
    options: {
      monthlyRoundingDecimals,
      ignoreExistingInterest,
      includeTransferTransactions,
      interestBaseMethod,
      annualRounding,
      yearEndCreditOverridesApplied: yearEndCreditOverrides ? Object.keys(yearEndCreditOverrides).length : 0,
    },
  };
}

/**
 * Compute PPF/SSY value as-of a specific date using monthly-rule interest base,
 * with daily pro-rata accrual inside the month and annual credit at FY end.
 *
 * Daily accrual is informational for valuation and does NOT compound daily.
 * Principal is increased only on 31-Mar via FY-end credit.
 */
function calculateSmallSavingsValueAsOfDate({
  openingBalance = 0,
  transactions = [],
  rateRows = [],
  fromDate,
  asOfDate,
  includeTransferTransactions = false,
  interestBaseMethod = 'min_balance_between_5th_and_month_end',
  annualRounding = true,
}) {
  const targetDate = toDateOnly(asOfDate);
  const startYm = toYearMonth(fromDate);
  const endYm = toYearMonth(targetDate);
  if (!startYm || !endYm || startYm > endYm) {
    throw new Error('Invalid from/as-of range for small-savings as-of value calculation.');
  }

  const creditTypes = new Set(['DEPOSIT', 'BUY']);
  const debitTypes = new Set(['WITHDRAWAL']);
  if (includeTransferTransactions) {
    creditTypes.add('TRANSFER_IN');
    debitTypes.add('TRANSFER_OUT');
  }

  const parsedRates = parseRateEntries(rateRows);
  let principal = roundTo(Number(openingBalance || 0), 2);
  let runningFyInterest = 0;

  const postingsByMonth = new Map();
  for (const t of transactions) {
    const dateStr = toDateOnly(t.transaction_date);
    if (!dateStr || dateStr < fromDate || dateStr > targetDate) continue;

    const type = String(t.transaction_type || '');
    let signed = null;
    if (creditTypes.has(type)) signed = Number(t.amount || 0);
    else if (debitTypes.has(type)) signed = -Math.abs(Number(t.amount || 0));
    else if (type === 'RECONCILE') signed = Number(t.amount || 0);
    else if (type === 'INTEREST') continue;
    if (signed == null) continue;

    const ym = toYearMonth(dateStr);
    if (ym < startYm || ym > endYm) continue;
    if (!postingsByMonth.has(ym)) postingsByMonth.set(ym, []);
    postingsByMonth.get(ym).push({ date: dateStr, amount: signed });
  }
  for (const arr of postingsByMonth.values()) {
    arr.sort((a, b) => a.date.localeCompare(b.date));
  }

  for (const ym of yearMonthRange(startYm, endYm)) {
    const { y: yy, m: mm } = safeDateFromYm(ym);
    const monthStart = fmtDate(yy, mm, 1);
    const monthEnd = fmtDate(yy, mm, lastDayOfMonth(yy, mm));
    const evalEnd = targetDate < monthEnd ? targetDate : monthEnd;
    const fifthDate = fmtDate(yy, mm, 5);
    const monthPostings = (postingsByMonth.get(ym) || []).filter((p) => p.date <= evalEnd);

    // Compute principal at close of day 5 (or evalEnd if earlier).
    let baseAtFifthClose = principal;
    for (const p of monthPostings) {
      if (p.date <= fifthDate || p.date <= evalEnd && evalEnd < fifthDate) {
        baseAtFifthClose = roundTo(baseAtFifthClose + p.amount, 2);
      }
    }

    // Compute running principal through evalEnd.
    let endPrincipal = principal;
    for (const p of monthPostings) {
      endPrincipal = roundTo(endPrincipal + p.amount, 2);
    }

    // Eligible base according to scheme rule.
    let eligibleBalance;
    if (interestBaseMethod === 'month_end_balance') {
      eligibleBalance = roundTo(Math.max(endPrincipal, 0), 2);
    } else {
      let minBalance = baseAtFifthClose;
      let rolling = baseAtFifthClose;
      for (const p of monthPostings) {
        if (p.date > fifthDate) {
          rolling = roundTo(rolling + p.amount, 2);
          if (rolling < minBalance) minBalance = rolling;
        }
      }
      eligibleBalance = roundTo(Math.max(minBalance, 0), 2);
    }

    const rate = getRateForDate(parsedRates, monthEnd);
    if (rate == null) {
      throw new Error(`No interest rate configured for month ${ym}.`);
    }

    const rawMonthInterest = eligibleBalance * (Number(rate) / 1200);
    const monthDays = lastDayOfMonth(yy, mm);
    const elapsedDays = Number(evalEnd.slice(8, 10));
    const prorataAccrued = rawMonthInterest * (elapsedDays / monthDays);

    const isMonthComplete = evalEnd === monthEnd;
    if (isMonthComplete) {
      principal = endPrincipal;
      runningFyInterest = annualRounding
        ? roundTo(runningFyInterest + rawMonthInterest, 8)
        : roundTo(runningFyInterest + roundTo(rawMonthInterest, 2), 2);

      if (mm === 3) {
        const fyCredit = annualRounding ? Math.round(runningFyInterest) : roundTo(runningFyInterest, 2);
        principal = roundTo(principal + fyCredit, 2);
        runningFyInterest = 0;
      }
      continue;
    }

    // Partial current month: principal excludes current-month interest;
    // add only prorata accrued interest to valuation.
    return roundTo(endPrincipal + runningFyInterest + prorataAccrued, 2);
  }

  // asOfDate is month-end (or after loop completion): include accrued FY interest
  // that is not yet credited until Mar-31.
  return roundTo(principal + runningFyInterest, 2);
}

/**
 * Compute PF value as-of a specific date using EPFO-style monthly base,
 * with daily pro-rata accrual for the current month and FY-end crediting.
 *
 * Daily accrual is valuation-only and does NOT compound daily. Principal is
 * increased only on FY-end credit (March close).
 */
function calculatePfValueAsOfDate({
  openingBalance = 0,
  transactions = [],
  rateRows = [],
  fromDate,
  asOfDate,
  includeTransferTransactions = false,
  ignoreExistingInterest = true,
}) {
  const targetDate = toDateOnly(asOfDate);
  const startYm = toYearMonth(fromDate);
  const endYm = toYearMonth(targetDate);
  if (!startYm || !endYm || startYm > endYm) {
    throw new Error('Invalid from/as-of range for PF as-of value calculation.');
  }

  const creditTypes = new Set(['DEPOSIT', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'TRANSFER_IN', 'INTEREST', 'RECONCILE', 'DIVIDEND', 'BONUS', 'RIGHTS', 'MERGER']);
  const debitTypes = new Set(['WITHDRAWAL', 'TRANSFER_OUT', 'CHARGES', 'AMC', 'CONSOLIDATION', 'TDS']);
  const deferredContributionTypes = new Set(['DEPOSIT', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION']);
  if (!includeTransferTransactions) {
    debitTypes.delete('TRANSFER_OUT');
    creditTypes.delete('TRANSFER_IN');
  }

  const parsedRates = parseRateEntries(rateRows);
  let principal = roundTo(Number(openingBalance || 0), 2);
  let runningFyInterest = 0;

  const postingsByMonth = new Map();
  for (const t of transactions) {
    const dateStr = toDateOnly(t.transaction_date);
    if (!dateStr || dateStr < fromDate || dateStr > targetDate) continue;

    const type = String(t.transaction_type || '');
    let signed = 0;
    if (type === 'INTEREST' && ignoreExistingInterest) {
      continue;
    } else if (creditTypes.has(type)) {
      signed = Number(t.amount || 0);
    } else if (debitTypes.has(type)) {
      signed = -Math.abs(Number(t.amount || 0));
    } else {
      signed = Number(t.amount || 0);
    }

    const ym = toYearMonth(dateStr);
    if (ym < startYm || ym > endYm) continue;
    if (!postingsByMonth.has(ym)) postingsByMonth.set(ym, []);
    postingsByMonth.get(ym).push({
      date: dateStr,
      amount: signed,
      isDeferredContribution: deferredContributionTypes.has(type),
    });
  }
  for (const arr of postingsByMonth.values()) {
    arr.sort((a, b) => a.date.localeCompare(b.date));
  }

  for (const ym of yearMonthRange(startYm, endYm)) {
    const { y: yy, m: mm } = safeDateFromYm(ym);
    const monthEnd = fmtDate(yy, mm, lastDayOfMonth(yy, mm));
    const evalEnd = targetDate < monthEnd ? targetDate : monthEnd;
    const monthPostings = (postingsByMonth.get(ym) || []).filter((p) => p.date <= evalEnd);

    let endPrincipal = principal;
    let deferredContributionDelta = 0;
    for (const p of monthPostings) {
      endPrincipal = roundTo(endPrincipal + p.amount, 2);
      if (p.isDeferredContribution) {
        deferredContributionDelta = roundTo(deferredContributionDelta + p.amount, 2);
      }
    }

    const rate = getRateForDate(parsedRates, monthEnd);
    if (rate == null) {
      throw new Error(`No PF interest rate configured for month ${ym}.`);
    }

    // EPFO-style: same-month PF contributions start earning from next month.
    const interestBase = roundTo(Math.max(endPrincipal - deferredContributionDelta, 0), 2);
    const rawMonthInterest = interestBase * (Number(rate) / 1200);

    const monthDays = lastDayOfMonth(yy, mm);
    const elapsedDays = Number(evalEnd.slice(8, 10));
    const prorataAccrued = rawMonthInterest * (elapsedDays / monthDays);

    const isMonthComplete = evalEnd === monthEnd;
    if (isMonthComplete) {
      principal = endPrincipal;
      runningFyInterest = roundTo(runningFyInterest + rawMonthInterest, 8);

      if (mm === 3) {
        const fyCredit = Math.round(runningFyInterest);
        principal = roundTo(principal + fyCredit, 2);
        runningFyInterest = 0;
      }
      continue;
    }

    // Partial current month: principal excludes current-month interest;
    // add only prorata accrued interest to valuation.
    return roundTo(endPrincipal + runningFyInterest + prorataAccrued, 2);
  }

  // asOfDate is month-end (or after loop completion): include accrued FY
  // interest that is not yet credited until Mar-31.
  return roundTo(principal + runningFyInterest, 2);
}

module.exports = {
  calculatePfInterestPreview,
  calculatePfValueAsOfDate,
  calculateSmallSavingsInterestPreview,
  calculateSmallSavingsValueAsOfDate,
};
