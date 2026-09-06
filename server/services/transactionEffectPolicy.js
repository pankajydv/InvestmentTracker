const CALCULATION_VERSION = 1;

const REVIEW_STATUS = Object.freeze({
  APPROVED: 'APPROVED',
  REVIEW_REQUIRED: 'REVIEW_REQUIRED',
});

const EFFECT = Object.freeze({
  NONE: 'NONE',
  INCREASE: 'INCREASE',
  DECREASE: 'DECREASE',
  BASIS: 'BASIS',
  PROCEEDS: 'PROCEEDS',
  INCOME: 'INCOME',
  EXPENSE: 'EXPENSE',
  PRODUCT_SPECIFIC: 'PRODUCT_SPECIFIC',
});

function rule({
  units = EFFECT.NONE,
  portfolio = EFFECT.NONE,
  attribution = EFFECT.NONE,
  income = EFFECT.NONE,
  expense = EFFECT.NONE,
  internal = false,
  reviewStatus = REVIEW_STATUS.APPROVED,
  reviewReason = null,
} = {}) {
  return Object.freeze({
    units,
    portfolio,
    attribution,
    income,
    expense,
    internal,
    reviewStatus,
    reviewReason,
  });
}

const ACQUISITION = rule({
  units: EFFECT.INCREASE,
  portfolio: EFFECT.BASIS,
  attribution: EFFECT.BASIS,
});

const CONTRIBUTION = rule({
  portfolio: EFFECT.BASIS,
  attribution: EFFECT.BASIS,
});

const DISPOSAL = rule({
  units: EFFECT.DECREASE,
  portfolio: EFFECT.PROCEEDS,
  attribution: EFFECT.PROCEEDS,
});

const INTERNAL_IN = rule({
  units: EFFECT.INCREASE,
  attribution: EFFECT.BASIS,
  internal: true,
});

const INTERNAL_OUT = rule({
  units: EFFECT.DECREASE,
  attribution: EFFECT.PROCEEDS,
  internal: true,
});

const TRANSACTION_EFFECT_RULES = Object.freeze({
  BUY: ACQUISITION,
  DEPOSIT: ACQUISITION,
  IPO: ACQUISITION,
  RIGHTS: ACQUISITION,
  EMPLOYER_CONTRIBUTION: ACQUISITION,
  VOLUNTARY_CONTRIBUTION: ACQUISITION,
  // Approved: RSU vests are recorded in INR at the vest-date USD->INR rate, and that
  // recorded amount is the acquisition basis.
  VEST: rule({ units: EFFECT.INCREASE, portfolio: EFFECT.BASIS, attribution: EFFECT.BASIS }),
  ESPP_CONTRIBUTION: CONTRIBUTION,
  // Approved (variant A): EPS is a defined-benefit pension. Contributions are real
  // cost basis, but the EPS investment stays excluded from tracking, so this basis
  // never feeds market-return metrics. No interest accrues; benefit is a future annuity.
  EPS_CONTRIBUTION: CONTRIBUTION,
  SELL: DISPOSAL,
  REDEMPTION: DISPOSAL,
  WITHDRAWAL: DISPOSAL,
  DIVIDEND: rule({ portfolio: EFFECT.PROCEEDS, attribution: EFFECT.PROCEEDS, income: EFFECT.INCOME }),
  // Approved: external interest (bond/SGB) is cash proceeds; provident interest
  // (PF/PPF/SSY) is internal accrual already in the corpus. The resolver splits by asset.
  INTEREST: rule({ portfolio: EFFECT.PRODUCT_SPECIFIC, attribution: EFFECT.PRODUCT_SPECIFIC, income: EFFECT.INCOME }),
  TRANSFER_IN: INTERNAL_IN,
  SWITCH_IN: INTERNAL_IN,
  TRANSFER_OUT: INTERNAL_OUT,
  SWITCH_OUT: INTERNAL_OUT,
  TRANSFER: rule({
    internal: true,
    reviewStatus: REVIEW_STATUS.REVIEW_REQUIRED,
    reviewReason: 'Direction must be normalized to TRANSFER_IN or TRANSFER_OUT.',
  }),
  BONUS: rule({ units: EFFECT.INCREASE }),
  SPLIT: rule({ units: EFFECT.INCREASE }),
  MERGER: rule({
    units: EFFECT.PRODUCT_SPECIFIC,
    reviewStatus: REVIEW_STATUS.REVIEW_REQUIRED,
    reviewReason: 'Replacement security and unit ratio determine the effect.',
  }),
  CONSOLIDATION: rule({
    units: EFFECT.PRODUCT_SPECIFIC,
    reviewStatus: REVIEW_STATUS.REVIEW_REQUIRED,
    reviewReason: 'Stored units may be a delta or replacement quantity.',
  }),
  // Approved: ESPP purchase rows add units; their basis is their own amount (zero in
  // practice) because the real cost lives in ESPP_CONTRIBUTION, so there is no duplication.
  ESPP_PURCHASE: rule({ units: EFFECT.INCREASE, portfolio: EFFECT.PRODUCT_SPECIFIC, attribution: EFFECT.BASIS }),
  // Approved: reconcile entries are balance adjustments only (no basis, proceeds, or
  // units); they nudge provident valuation to match the statement.
  RECONCILE: rule({ portfolio: EFFECT.PRODUCT_SPECIFIC, attribution: EFFECT.PRODUCT_SPECIFIC }),
  // Approved: TDS reduces the provident corpus once via valuation; it is not a separate
  // classification effect (no basis, proceeds, or units here).
  TDS: rule({ expense: EFFECT.PRODUCT_SPECIFIC }),
  // No stored rows; NPS import normalizes CHARGES to AMC. Same rule as AMC as a forward-safe default.
  CHARGES: rule({ units: EFFECT.DECREASE }),
  // Approved: NPS/MF AMC is recovered by cancelling units, so the cost is already
  // realized as a value reduction. It must not also be counted as a separate expense.
  AMC: rule({ units: EFFECT.DECREASE }),
});

function normalizeTransactionType(transactionType) {
  return String(transactionType || '').trim().toUpperCase();
}

function getTransactionEffectRule(transactionType) {
  const normalizedType = normalizeTransactionType(transactionType);
  const effectRule = TRANSACTION_EFFECT_RULES[normalizedType];
  if (!effectRule) {
    throw new Error(`Unsupported transaction type: ${normalizedType || '<empty>'}`);
  }
  return effectRule;
}

function listTransactionEffectRules() {
  return Object.entries(TRANSACTION_EFFECT_RULES).map(([transactionType, effectRule]) => ({
    transactionType,
    ...effectRule,
  }));
}

const PROVIDENT_ASSET_TYPES = new Set(['PF', 'PPF', 'SSY']);

// Resolves a rule into signed classification deltas in the investment-attribution
// lens (the scope that `investment_metrics_daily` stores): units held, acquisition basis, and
// realized proceeds. Valuation-embedded effects (provident interest/reconcile,
// TDS corpus reduction, fee unit cancellation) are intentionally not expressed as
// classification deltas here; they belong to valuation, not to this lens.
function resolveClassificationEffect(transactionType, context = {}) {
  const effectRule = getTransactionEffectRule(transactionType);
  const amount = Number(context.amount || 0);
  const fees = Number(context.fees || 0);
  const units = Number(context.units || 0);
  const assetType = String(context.assetType || '').toUpperCase();
  const isProvident = PROVIDENT_ASSET_TYPES.has(assetType);

  let unitsDelta = 0;
  if (effectRule.units === EFFECT.INCREASE) unitsDelta = units;
  else if (effectRule.units === EFFECT.DECREASE) unitsDelta = -units;

  let basisDelta = 0;
  let proceedsDelta = 0;
  if (effectRule.attribution === EFFECT.BASIS) {
    basisDelta = amount + fees;
  } else if (effectRule.attribution === EFFECT.PROCEEDS) {
    proceedsDelta = amount - fees;
  } else if (effectRule.attribution === EFFECT.PRODUCT_SPECIFIC) {
    // External interest is realized proceeds; provident interest is internal
    // accrual already carried in the corpus valuation, not a proceeds event.
    if (normalizeTransactionType(transactionType) === 'INTEREST' && !isProvident) {
      proceedsDelta = amount - fees;
    }
  }

  return {
    unitsDelta,
    basisDelta,
    proceedsDelta,
    internal: effectRule.internal === true,
    reviewStatus: effectRule.reviewStatus,
  };
}

// Day-change external-cash lens: transactions that move external cash on their date.
// Day change strips these so it reflects valuation movement, not deposits/withdrawals.
// This is a distinct lens from the basis/proceeds classification (it excludes income
// and non-cash acquisitions like VEST, and includes fee outflows).
const EXTERNAL_CASH_IN_TYPES = Object.freeze([
  'BUY', 'DEPOSIT', 'IPO', 'RIGHTS', 'TRANSFER_IN', 'SWITCH_IN',
  'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'ESPP_CONTRIBUTION',
]);
const EXTERNAL_CASH_OUT_TYPES = Object.freeze([
  'SELL', 'REDEMPTION', 'WITHDRAWAL', 'TRANSFER_OUT', 'SWITCH_OUT', 'CHARGES', 'AMC',
]);
// TDS reduces external cash by its absolute amount regardless of stored sign.
const EXTERNAL_CASH_ABS_NEGATIVE_TYPES = Object.freeze(['TDS']);

function toSqlInList(types) {
  return types.map((t) => `'${String(t).replace(/'/g, "''")}'`).join(', ');
}

module.exports = {
  CALCULATION_VERSION,
  EFFECT,
  REVIEW_STATUS,
  PROVIDENT_ASSET_TYPES,
  EXTERNAL_CASH_IN_TYPES,
  EXTERNAL_CASH_OUT_TYPES,
  EXTERNAL_CASH_ABS_NEGATIVE_TYPES,
  toSqlInList,
  getTransactionEffectRule,
  listTransactionEffectRules,
  resolveClassificationEffect,
  normalizeTransactionType,
};