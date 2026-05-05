function toYyyyMmDd(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

const ESPP_RULES = {
  contributionRateDefaultPct: 15,
  contributionRateMinPct: 1,
  contributionRateMaxPct: 15,
  planDiscountPct: 10,
  annualFairMarketValueCapUsd: 25000,
  purchasePriceRule: 'FMV_CLOSE_ON_OFFER_END_DATE',
  purchaseDepositedTo: 'Stock Plan Account',
  mandatoryHoldingDaysAfterExercise: 0,
};

const OFFERINGS = [
  {
    key: 'FY26_Q1',
    label: 'FY26 Q1',
    offeringStart: '2026-04-01',
    offeringEnd: '2026-06-30',
    purchaseDate: '2026-06-30',
  },
];

function generateEsppSchedule(options = {}) {
  const includeFuture = options.includeFuture === true;
  const asOfDate = toYyyyMmDd(options.asOfDate) || new Date().toISOString().slice(0, 10);
  const offeringKeys = Array.isArray(options.offeringKeys) && options.offeringKeys.length
    ? new Set(options.offeringKeys)
    : null;

  const selected = offeringKeys
    ? OFFERINGS.filter((o) => offeringKeys.has(o.key))
    : OFFERINGS;

  const allRows = selected.map((offering) => ({
    offering_key: offering.key,
    grant_label: `ESPP ${offering.label}`,
    offering_label: offering.label,
    offering_start: offering.offeringStart,
    offering_end: offering.offeringEnd,
    purchase_date: offering.purchaseDate,
    discount_pct: ESPP_RULES.planDiscountPct,
    contribution_rate_default_pct: ESPP_RULES.contributionRateDefaultPct,
    contribution_rate_range: `${ESPP_RULES.contributionRateMinPct}% - ${ESPP_RULES.contributionRateMaxPct}%`,
    annual_fmv_cap_usd: ESPP_RULES.annualFairMarketValueCapUsd,
    purchase_price_rule: ESPP_RULES.purchasePriceRule,
    transaction_type: 'ESPP_PURCHASE',
    import_key: `${offering.key}|${offering.purchaseDate}`,
    notes: `ESPP Purchase | ESPP ${offering.label} | Offering ${offering.offeringStart} to ${offering.offeringEnd} | Discount ${ESPP_RULES.planDiscountPct}% | Rate ${ESPP_RULES.contributionRateDefaultPct}% | Key ${offering.key}`,
  }));

  const filteredRows = includeFuture
    ? allRows
    : allRows.filter((r) => r.purchase_date <= asOfDate);

  return {
    as_of_date: asOfDate,
    include_future: includeFuture,
    rules: ESPP_RULES,
    offerings: selected,
    rows: filteredRows,
    totals: {
      offerings: selected.length,
      rows: filteredRows.length,
      all_rows: allRows.length,
    },
  };
}

module.exports = {
  ESPP_RULES,
  OFFERINGS,
  generateEsppSchedule,
};
