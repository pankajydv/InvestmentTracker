function addMonths(isoDate, months) {
  const [year, month, day] = String(isoDate).split('-').map(Number);
  const base = new Date(Date.UTC(year, month - 1, day));
  const target = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + months, base.getUTCDate()));
  const yyyy = target.getUTCFullYear();
  const mm = String(target.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(target.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function shiftToNextWeekday(isoDate) {
  const d = new Date(`${isoDate}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return isoDate;

  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
    d.setUTCDate(d.getUTCDate() + 1);
  }

  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function buildAnnualPlan() {
  const plan = [];
  for (let months = 3; months <= 60; months += 3) {
    plan.push({ months, percent: 5 });
  }
  return plan;
}

const GRANTS = [
  {
    key: 'FY21_ANNUAL',
    label: 'FY21 Annual',
    awardNumber: '0000002791073',
    awardDate: '2021-08-31',
    totalShares: 90,
    plan: buildAnnualPlan(),
  },
  {
    key: 'FY22_ANNUAL',
    label: 'FY22 Annual',
    awardNumber: '0000003034040',
    awardDate: '2022-08-31',
    totalShares: 109,
    plan: buildAnnualPlan(),
  },
  {
    key: 'FY23_ANNUAL',
    label: 'FY23 Annual',
    awardNumber: '0000003237410',
    awardDate: '2023-08-31',
    totalShares: 87,
    plan: buildAnnualPlan(),
  },
  {
    key: 'FY24_ANNUAL',
    label: 'FY24 Annual',
    awardNumber: '0000003480133',
    awardDate: '2024-08-31',
    totalShares: 96,
    plan: buildAnnualPlan(),
  },
  {
    key: 'FY25_ANNUAL',
    label: 'FY25 Annual',
    awardNumber: '0000003698224',
    awardDate: '2025-08-31',
    totalShares: 91,
    plan: buildAnnualPlan(),
  },
  {
    key: 'ON_HIRE',
    label: 'On-Hire',
    awardNumber: '0000002605375',
    awardDate: '2020-12-15',
    totalShares: 234,
    plan: [
      { months: 12, units: 58 },
      { months: 15, units: 15 },
      { months: 18, units: 14 },
      { months: 21, units: 15 },
      { months: 24, units: 15 },
      { months: 27, units: 14 },
      { months: 30, units: 15 },
      { months: 33, units: 14 },
      { months: 36, units: 15 },
      { months: 39, units: 15 },
      { months: 42, units: 14 },
      { months: 45, units: 15 },
      { months: 48, units: 15 },
    ],
  },
  {
    key: 'SPECIAL_SA',
    label: 'Special SA',
    awardNumber: '0000002831614',
    awardDate: '2021-12-15',
    totalShares: 123,
    plan: [
      { months: 6, percent: 10 },
      { months: 12, percent: 10 },
      { months: 18, percent: 10 },
      { months: 24, percent: 10 },
      { months: 30, percent: 15 },
      { months: 36, percent: 15 },
      { months: 42, percent: 15 },
      { months: 48, percent: 15 },
    ],
  },
];

function toYyyyMmDd(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function generateGrantRows(grant) {
  const rows = [];
  let allocatedUnits = 0;

  for (let i = 0; i < grant.plan.length; i += 1) {
    const tranche = grant.plan[i];
    const trancheIndex = i + 1;
    const totalTranches = grant.plan.length;
    const hasExplicitUnits = tranche.units != null;
    const rawUnits = hasExplicitUnits
      ? Number(tranche.units)
      : (grant.totalShares * tranche.percent) / 100;
    const isLast = trancheIndex === totalTranches;
    const units = hasExplicitUnits
      ? Number(tranche.units)
      : (isLast
        ? grant.totalShares - allocatedUnits
        : Math.floor(rawUnits));
    const vestPercent = tranche.percent != null
      ? tranche.percent
      : Number(((units * 100) / grant.totalShares).toFixed(6));

    allocatedUnits += units;

    const vestDate = shiftToNextWeekday(addMonths(grant.awardDate, tranche.months));
    const seq = String(trancheIndex).padStart(2, '0');

    rows.push({
      grant_key: grant.key,
      grant_label: grant.label,
      award_number: grant.awardNumber,
      award_date: grant.awardDate,
      total_granted_shares: grant.totalShares,
      vest_sequence: trancheIndex,
      vest_total_tranches: totalTranches,
      vest_percent: vestPercent,
      vest_month_offset: tranche.months,
      vest_date: vestDate,
      raw_units: Number(rawUnits.toFixed(6)),
      units,
      transaction_type: 'VEST',
      import_key: `${grant.awardNumber}|${vestDate}|${trancheIndex}`,
      notes: `RSU Vest | ${grant.label} | Award ${grant.awardNumber} | Tranche ${seq}/${totalTranches}`,
    });
  }

  return rows;
}

function generateRsuSchedule(options = {}) {
  const includeFuture = options.includeFuture === true;
  const asOfDate = toYyyyMmDd(options.asOfDate) || new Date().toISOString().slice(0, 10);
  const grantKeys = Array.isArray(options.grantKeys) && options.grantKeys.length
    ? new Set(options.grantKeys)
    : null;

  const selected = grantKeys
    ? GRANTS.filter((g) => grantKeys.has(g.key))
    : GRANTS;

  const allRows = selected.flatMap(generateGrantRows);
  const filteredRows = includeFuture
    ? allRows
    : allRows.filter((r) => r.vest_date <= asOfDate);

  const summaryByGrant = selected.map((grant) => {
    const grantRows = allRows.filter((r) => r.grant_key === grant.key);
    const vestedRows = filteredRows.filter((r) => r.grant_key === grant.key);
    const planPercent = Number(
      grantRows.reduce((sum, r) => sum + Number(r.vest_percent || 0), 0).toFixed(6)
    );

    return {
      grant_key: grant.key,
      grant_label: grant.label,
      award_number: grant.awardNumber,
      award_date: grant.awardDate,
      total_granted_shares: grant.totalShares,
      total_plan_percent: planPercent,
      total_tranches: grant.plan.length,
      schedule_units: grantRows.reduce((sum, r) => sum + r.units, 0),
      vested_tranches_as_of: vestedRows.length,
      vested_units_as_of: vestedRows.reduce((sum, r) => sum + r.units, 0),
    };
  });

  return {
    as_of_date: asOfDate,
    include_future: includeFuture,
    grants: selected,
    rows: filteredRows,
    summary_by_grant: summaryByGrant,
    totals: {
      grants: selected.length,
      rows: filteredRows.length,
      units: filteredRows.reduce((sum, r) => sum + r.units, 0),
      all_rows: allRows.length,
      all_units: allRows.reduce((sum, r) => sum + r.units, 0),
    },
  };
}

module.exports = {
  GRANTS,
  generateRsuSchedule,
};
