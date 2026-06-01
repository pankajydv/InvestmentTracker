const VALID_FREQUENCIES = new Set(['MONTHLY', 'QUARTERLY', 'SEMI_ANNUAL', 'ANNUAL']);

const FREQUENCY_MONTHS = {
  MONTHLY: 1,
  QUARTERLY: 3,
  SEMI_ANNUAL: 6,
  ANNUAL: 12,
};

const UNIT_INFLOW_TYPES = new Set([
  'BUY', 'DEPOSIT', 'BONUS', 'SPLIT', 'IPO', 'TRANSFER_IN', 'SWITCH_IN',
  'RIGHTS', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'VEST', 'ESPP_PURCHASE',
]);

const UNIT_OUTFLOW_TYPES = new Set([
  'SELL', 'REDEMPTION', 'WITHDRAWAL', 'TRANSFER_OUT', 'SWITCH_OUT', 'CONSOLIDATION', 'CHARGES', 'AMC',
]);

function normalizeIsoDate(value) {
  const raw = String(value || '').trim().split(/[ T]/)[0];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const d = new Date(`${raw}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : raw;
}

function addDaysIso(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}

function addMonthsIso(isoDate, months) {
  const d = new Date(`${isoDate}T00:00:00.000Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + Number(months || 0));
  const endOfMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, endOfMonth));
  return d.toISOString().slice(0, 10);
}

function diffIsoDays(a, b) {
  const left = new Date(`${a}T00:00:00.000Z`).getTime();
  const right = new Date(`${b}T00:00:00.000Z`).getTime();
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
  return Math.round((left - right) / 86400000);
}

function round2(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function normalizeFrequency(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return VALID_FREQUENCIES.has(normalized) ? normalized : null;
}

function parseCouponRateFromText(value) {
  const text = String(value || '');
  if (!text) return null;
  const match = text.match(/(\d{1,2}(?:\.\d{1,4})?)\s*%/);
  if (!match) return null;
  const rate = Number(match[1]);
  return Number.isFinite(rate) && rate > 0 && rate <= 100 ? rate : null;
}

function inferFrequencyFromObservedCouponDates(observedCouponDates) {
  if (!Array.isArray(observedCouponDates) || observedCouponDates.length < 2) return null;

  const sorted = [...observedCouponDates].sort();
  const diffs = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = new Date(`${sorted[i - 1]}T00:00:00.000Z`).getTime();
    const next = new Date(`${sorted[i]}T00:00:00.000Z`).getTime();
    const days = Math.round((next - prev) / 86400000);
    if (Number.isFinite(days) && days > 0) diffs.push(days);
  }

  if (!diffs.length) return null;
  const average = diffs.reduce((sum, d) => sum + d, 0) / diffs.length;

  const candidates = [
    { frequency: 'MONTHLY', days: 30 },
    { frequency: 'QUARTERLY', days: 91 },
    { frequency: 'SEMI_ANNUAL', days: 182 },
    { frequency: 'ANNUAL', days: 365 },
  ];

  let best = null;
  for (const candidate of candidates) {
    const error = Math.abs(candidate.days - average);
    if (!best || error < best.error) {
      best = { frequency: candidate.frequency, error };
    }
  }

  return best && best.error <= 35 ? best.frequency : null;
}

function inferAnnualCouponRate(investment, transactions, frequency) {
  const explicitRate = Number(investment?.coupon_rate || 0);
  if (Number.isFinite(explicitRate) && explicitRate > 0) return explicitRate;

  const parsedFromName = parseCouponRateFromText(investment?.name);
  if (parsedFromName) return parsedFromName;

  const parsedFromNotes = parseCouponRateFromText(investment?.notes);
  if (parsedFromNotes) return parsedFromNotes;

  const normalizedFrequency = normalizeFrequency(frequency);
  const months = normalizedFrequency ? FREQUENCY_MONTHS[normalizedFrequency] : null;
  const faceValue = Number(investment?.face_value || 0);

  if (!(faceValue > 0) || !months) return 0;

  const periodsPerYear = 12 / months;
  const impliedRates = (transactions || [])
    .filter((tx) => String(tx?.transaction_type || '').toUpperCase() === 'INTEREST')
    .map((tx) => {
      const amount = Number(tx?.amount || 0);
      const units = Number(tx?.units || 0);
      if (!(amount > 0) || !(units > 0)) return null;
      const implied = (amount * periodsPerYear * 100) / (units * faceValue);
      return Number.isFinite(implied) && implied > 0 && implied <= 100 ? implied : null;
    })
    .filter((v) => v != null)
    .sort((a, b) => a - b);

  if (!impliedRates.length) return 0;
  const middle = Math.floor(impliedRates.length / 2);
  if (impliedRates.length % 2 === 1) return impliedRates[middle];
  return (impliedRates[middle - 1] + impliedRates[middle]) / 2;
}

function getObservedCouponDates(transactions) {
  const set = new Set();
  for (const tx of transactions || []) {
    const type = String(tx?.transaction_type || '').toUpperCase();
    if (type !== 'INTEREST') continue;
    if (!(Number(tx?.amount || 0) > 0)) continue;

    const date = normalizeIsoDate(tx?.tx_date || tx?.transaction_date);
    if (date) set.add(date);
  }
  return Array.from(set).sort();
}

function findObservedCouponWithinTolerance(observedCouponDates, targetDate, toleranceDays) {
  if (!Array.isArray(observedCouponDates) || !observedCouponDates.length) return null;
  if (!targetDate || !(Number(toleranceDays) >= 0)) return null;

  let best = null;
  let bestAbsDelta = Number.POSITIVE_INFINITY;
  for (const date of observedCouponDates) {
    const deltaDays = diffIsoDays(date, targetDate);
    if (deltaDays == null) continue;
    const absDelta = Math.abs(deltaDays);
    if (absDelta > Number(toleranceDays)) continue;

    if (!best || absDelta < bestAbsDelta) {
      best = { date, deltaDays };
      bestAbsDelta = absDelta;
    }
  }

  return best;
}

function buildUnitDeltaByDate(transactions) {
  const map = new Map();
  for (const tx of transactions || []) {
    const date = normalizeIsoDate(tx?.tx_date || tx?.transaction_date);
    if (!date) continue;

    const type = String(tx?.transaction_type || '').toUpperCase();
    const units = Number(tx?.units || 0);
    if (!Number.isFinite(units) || units === 0) continue;

    let delta = 0;
    if (UNIT_INFLOW_TYPES.has(type)) delta = units;
    else if (UNIT_OUTFLOW_TYPES.has(type)) delta = -units;
    if (delta === 0) continue;

    map.set(date, Number(map.get(date) || 0) + delta);
  }
  return map;
}

function unitsOnOrBefore(date, unitDeltaByDate) {
  let units = 0;
  const keys = Array.from(unitDeltaByDate.keys()).sort();
  for (const key of keys) {
    if (key > date) break;
    units += Number(unitDeltaByDate.get(key) || 0);
  }
  return units;
}

function computeBondAccruedCoupon({
  investment,
  transactions,
  asOfDate,
  dayCount = 365,
  missingCouponToleranceDays = 2,
}) {
  const normalizedAsOf = normalizeIsoDate(asOfDate);
  if (!normalizedAsOf) {
    return {
      accruedCoupon: 0,
      meta: {
        skipped: true,
        reason: 'invalid_as_of_date',
      },
    };
  }

  if (String(investment?.asset_type || '').toUpperCase() !== 'BOND') {
    return {
      accruedCoupon: 0,
      meta: {
        skipped: true,
        reason: 'not_bond',
      },
    };
  }

  const observedCouponDates = getObservedCouponDates(transactions);
  const observedSet = new Set(observedCouponDates);

  let couponFrequency = normalizeFrequency(investment?.coupon_frequency);
  if (!couponFrequency) {
    couponFrequency = inferFrequencyFromObservedCouponDates(observedCouponDates);
  }

  const annualCouponRate = inferAnnualCouponRate(investment, transactions || [], couponFrequency);
  const faceValue = Number(investment?.face_value || 0);

  const hasCouponPaymentOnAsOf = observedSet.has(normalizedAsOf);
  const couponsThroughAsOf = observedCouponDates.filter((date) => date <= normalizedAsOf);
  const lastCouponDate = couponsThroughAsOf.length ? couponsThroughAsOf[couponsThroughAsOf.length - 1] : null;

  const frequencyMonths = couponFrequency ? FREQUENCY_MONTHS[couponFrequency] : null;
  const expectedCouponDate = (lastCouponDate && frequencyMonths)
    ? addMonthsIso(lastCouponDate, frequencyMonths)
    : null;

  const nearbyCoupon = expectedCouponDate
    ? findObservedCouponWithinTolerance(observedCouponDates, expectedCouponDate, missingCouponToleranceDays)
    : null;
  const hasCouponWithinExpectedTolerance = Boolean(nearbyCoupon);

  const missingExpectedCouponPayment = Boolean(
    expectedCouponDate
    && expectedCouponDate === normalizedAsOf
    && !hasCouponPaymentOnAsOf
    && !hasCouponWithinExpectedTolerance
  );

  const baseMeta = {
    dayCount,
    annualCouponRate: Number(annualCouponRate || 0),
    couponFrequency: couponFrequency || null,
    observedCouponDates,
    lastCouponDate,
    expectedCouponDate,
    hasCouponPaymentOnAsOf,
    missingCouponToleranceDays: Number(missingCouponToleranceDays || 0),
    hasCouponWithinExpectedTolerance,
    nearbyCouponDate: nearbyCoupon?.date || null,
    nearbyCouponDeltaDays: nearbyCoupon?.deltaDays ?? null,
    missingExpectedCouponPayment,
  };

  if (!(faceValue > 0) || !(annualCouponRate > 0) || !lastCouponDate || !couponFrequency) {
    return {
      accruedCoupon: 0,
      meta: {
        ...baseMeta,
        skipped: true,
        reason: 'insufficient_coupon_inputs',
      },
    };
  }

  // Model A: if coupon payout is posted on as-of date, accrued receivable resets to zero.
  if (hasCouponPaymentOnAsOf) {
    return {
      accruedCoupon: 0,
      meta: {
        ...baseMeta,
        skipped: false,
        resetOnCouponDate: true,
      },
    };
  }

  const accrualStartDate = addDaysIso(lastCouponDate, 1);
  if (accrualStartDate > normalizedAsOf) {
    return {
      accruedCoupon: 0,
      meta: {
        ...baseMeta,
        skipped: false,
        reason: 'no_elapsed_days',
      },
    };
  }

  const unitDeltaByDate = buildUnitDeltaByDate(transactions || []);
  let units = unitsOnOrBefore(lastCouponDate, unitDeltaByDate);

  const dailyRate = (faceValue * (annualCouponRate / 100)) / Number(dayCount || 365);
  let accrued = 0;

  let cursor = accrualStartDate;
  while (cursor <= normalizedAsOf) {
    units += Number(unitDeltaByDate.get(cursor) || 0);
    if (units > 0) {
      accrued += units * dailyRate;
    }
    cursor = addDaysIso(cursor, 1);
  }

  return {
    accruedCoupon: round2(accrued),
    meta: {
      ...baseMeta,
      skipped: false,
      accrualStartDate,
    },
  };
}

module.exports = {
  computeBondAccruedCoupon,
  normalizeFrequency,
};
