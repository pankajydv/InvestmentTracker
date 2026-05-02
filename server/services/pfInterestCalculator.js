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

module.exports = { calculatePfInterestPreview };
