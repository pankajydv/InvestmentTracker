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
 * EPFO-style PF interest preview.
 *
 * - Interest computed monthly on month-end running EPF balance.
 * - Interest is accumulated monthly and credited yearly (Mar end).
 * - EPS_CONTRIBUTION excluded from EPF corpus.
 */
function calculatePfInterestPreview({
  openingBalance = 0,
  transactions = [],
  rateRows = [],
  fromDate,
  toDate,
  contributionMonthShift = 0,
  monthlyRoundingDecimals = 2,
  ignoreExistingInterest = true,
  includeTransferTransactions = false,
}) {
  const epfCreditTypes = new Set(['DEPOSIT', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION']);
  const epfDebitTypes = new Set(['WITHDRAWAL']);
  if (includeTransferTransactions) {
    epfCreditTypes.add('TRANSFER_IN');
    epfDebitTypes.add('TRANSFER_OUT');
  }
  const contributionTypes = new Set(['DEPOSIT', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION']);

  const startYm = toYearMonth(fromDate);
  const endYm = toYearMonth(toDate);
  if (!startYm || !endYm || startYm > endYm) {
    throw new Error('Invalid from/to range for PF interest calculation.');
  }

  const parsedRates = parseRateEntries(rateRows);

  const postingsByMonth = new Map();

  for (const t of transactions) {
    const dateStr = String(t.transaction_date || '');
    if (!dateStr || dateStr < fromDate || dateStr > toDate) continue;

    const type = String(t.transaction_type || '');
    let signed = 0;

    if (epfCreditTypes.has(type)) signed = Number(t.amount || 0);
    else if (epfDebitTypes.has(type)) signed = -Math.abs(Number(t.amount || 0));
    else if (type === 'INTEREST' && !ignoreExistingInterest) signed = Number(t.amount || 0);
    else continue;

    let ym = toYearMonth(dateStr);
    if (contributionMonthShift && contributionTypes.has(type)) {
      ym = addMonths(ym, contributionMonthShift);
    }
    if (ym < startYm || ym > endYm) continue;

    postingsByMonth.set(ym, (postingsByMonth.get(ym) || 0) + signed);
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
    const monthContribution = roundTo(Math.max(monthPostings, 0), 2);

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

    const monthEndDate = `${yy}-${String(mm).padStart(2, '0')}-31`;
    const rate = getRateForDate(parsedRates, monthEndDate);
    if (rate == null) {
      throw new Error(`No PF interest rate configured for month ${ym}.`);
    }

    const monthInterest = roundTo(balance * (Number(rate) / 1200), monthlyRoundingDecimals);
    runningInterest = roundTo(runningInterest + monthInterest, 2);

    const isFyEnd = mm === 3;
    if (isFyEnd) {
      balance = roundTo(balance + runningInterest, 2);
      annualRows.push({
        fy: `FY${fy - 1}-${String(fy).slice(2)}`,
        contributions: roundTo(fyContribution, 2),
        interest: roundTo(runningInterest, 2),
        balanceAfterInterest: roundTo(balance, 2),
      });
      currentFy = null;
      fyContribution = 0;
      runningInterest = 0;
    }

    monthlyRows.push({
      month: ym,
      postingDelta: monthPostings,
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
      contributionMonthShift,
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

module.exports = { calculatePfInterestPreview, calculateSmallSavingsInterestPreview };
