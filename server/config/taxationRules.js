/**
 * Indian Income Tax Rules by Financial Year
 * 
 * Supports New Tax Regime (Introduced FY 2020-21, Section 115BAC)
 * Old Tax Regime: Not Supported (can be added later)
 * 
 * Sources:
 * - Union Budget documents (PIB.gov.in)
 * - Income Tax Department official circulars
 * - Finance Acts (2020, 2021, 2022, 2023, 2024, 2025, 2026)
 * 
 * Key Changes:
 * - Budget 2023 (FY 2023-24): Restructured slabs & increased standard deduction to ₹75,000
 * - Budget 2024 onwards: Maintained structure with minor threshold adjustments
 */

const TAXATION_RULES = {
  // FY 2026-27 (AY 2027-28)
  '2026-27': {
    status: 'active',
    budgetYear: 2026,
    newRegime: {
      status: 'supported',
      standardDeduction: 75000,
      slabs: [
        { upto: 400000, rate: 0.00, label: '₹0 – ₹4L' },
        { upto: 800000, rate: 0.05, label: '₹4L – ₹8L' },
        { upto: 1200000, rate: 0.10, label: '₹8L – ₹12L' },
        { upto: 1600000, rate: 0.15, label: '₹12L – ₹16L' },
        { upto: 2000000, rate: 0.20, label: '₹16L – ₹20L' },
        { upto: 2400000, rate: 0.25, label: '₹20L – ₹24L' },
        { upto: Infinity, rate: 0.30, label: '₹24L and above' },
      ],
      capitalGains: {
        stcg: {
          rate: 0.20,
          section: '111A (Equity, STT paid)',
          description: 'Short-Term Capital Gain (equity with STT)',
        },
        ltcgEquity: {
          rate: 0.125,
          section: '112A',
          exemption: 125000,
          description: 'Long-Term Capital Gain (equity) – ₹1.25L exempt',
        },
        ltcgForeign: {
          rate: 0.125,
          section: '112',
          description: 'Long-Term Capital Gain (foreign)',
        },
        stcgForeign: {
          rate: 'slab',
          section: 'Slab rate',
          description: 'Short-Term Capital Gain (foreign) – taxed at slab rate',
        },
      },
      rebate87A: {
        limit: 1200000,
        amount: 60000,
        description: 'Rebate under Section 87A for income up to ₹12L (AY 2026-27 onwards under Section 115BAC(1A))',
      },
      surcharge: [
        { upto: 5000000, rate: 0.00, label: 'Up to ₹50L' },
        { upto: 10000000, rate: 0.10, label: '₹50L – ₹1Cr' },
        { upto: 20000000, rate: 0.15, label: '₹1Cr – ₹2Cr' },
        { upto: Infinity, rate: 0.25, label: '₹2Cr and above' },
      ],
      cess: {
        rate: 0.04,
        baseAmount: 'Tax + Surcharge',
        description: 'Health & Education Cess – 4% on total tax + surcharge',
      },
      holdingPeriods: {
        equity: {
          stcgThreshold: 365,
          description: 'Holding ≤365 days = STCG; >365 days = LTCG',
        },
        debt: {
          stcgThreshold: 730,
          description: 'Holding ≤730 days = STCG; >730 days = LTCG',
        },
        foreign: {
          stcgThreshold: 730,
          description: 'Holding ≤730 days = STCG; >730 days = LTCG',
        },
      },
    },
    oldRegime: {
      status: 'not_supported',
      reason: 'Use New Regime for FY 2026-27',
    },
  },

  // FY 2025-26 (AY 2026-27) - Current as of 2026
  '2025-26': {
    status: 'active',
    budgetYear: 2025,
    newRegime: {
      status: 'supported',
      standardDeduction: 75000,
      slabs: [
        { upto: 400000, rate: 0.00, label: '₹0 – ₹4L' },
        { upto: 800000, rate: 0.05, label: '₹4L – ₹8L' },
        { upto: 1200000, rate: 0.10, label: '₹8L – ₹12L' },
        { upto: 1600000, rate: 0.15, label: '₹12L – ₹16L' },
        { upto: 2000000, rate: 0.20, label: '₹16L – ₹20L' },
        { upto: 2400000, rate: 0.25, label: '₹20L – ₹24L' },
        { upto: Infinity, rate: 0.30, label: '₹24L and above' },
      ],
      capitalGains: {
        stcg: {
          rate: 0.20,
          section: '111A (Equity, STT paid)',
          description: 'Short-Term Capital Gain (equity with STT)',
        },
        ltcgEquity: {
          rate: 0.125,
          section: '112A',
          exemption: 125000,
          description: 'Long-Term Capital Gain (equity) – ₹1.25L exempt',
        },
        ltcgForeign: {
          rate: 0.125,
          section: '112',
          description: 'Long-Term Capital Gain (foreign)',
        },
        stcgForeign: {
          rate: 'slab',
          section: 'Slab rate',
          description: 'Short-Term Capital Gain (foreign) – taxed at slab rate',
        },
      },
      rebate87A: {
        limit: 500000,
        amount: 12500,
        description: 'Rebate under Section 87A for income up to ₹5L',
      },
      surcharge: [
        { upto: 5000000, rate: 0.00, label: 'Up to ₹50L' },
        { upto: 10000000, rate: 0.10, label: '₹50L – ₹1Cr' },
        { upto: 20000000, rate: 0.15, label: '₹1Cr – ₹2Cr' },
        { upto: Infinity, rate: 0.25, label: '₹2Cr and above' },
      ],
      cess: {
        rate: 0.04,
        baseAmount: 'Tax + Surcharge',
        description: 'Health & Education Cess – 4% on total tax + surcharge',
      },
      holdingPeriods: {
        equity: {
          stcgThreshold: 365,
          description: 'Holding ≤365 days = STCG; >365 days = LTCG',
        },
        debt: {
          stcgThreshold: 730,
          description: 'Holding ≤730 days = STCG; >730 days = LTCG',
        },
        foreign: {
          stcgThreshold: 730,
          description: 'Holding ≤730 days = STCG; >730 days = LTCG',
        },
      },
    },
    oldRegime: {
      status: 'not_supported',
      reason: 'Use New Regime for FY 2025-26',
    },
  },

  // FY 2024-25 (AY 2025-26)
  '2024-25': {
    status: 'active',
    budgetYear: 2024,
    newRegime: {
      status: 'supported',
      standardDeduction: 75000,
      slabs: [
        { upto: 400000, rate: 0.00, label: '₹0 – ₹4L' },
        { upto: 800000, rate: 0.05, label: '₹4L – ₹8L' },
        { upto: 1200000, rate: 0.10, label: '₹8L – ₹12L' },
        { upto: 1600000, rate: 0.15, label: '₹12L – ₹16L' },
        { upto: 2000000, rate: 0.20, label: '₹16L – ₹20L' },
        { upto: 2400000, rate: 0.25, label: '₹20L – ₹24L' },
        { upto: Infinity, rate: 0.30, label: '₹24L and above' },
      ],
      capitalGains: {
        stcg: {
          rate: 0.20,
          section: '111A (Equity, STT paid)',
          description: 'Short-Term Capital Gain (equity with STT)',
        },
        ltcgEquity: {
          rate: 0.125,
          section: '112A',
          exemption: 125000,
          description: 'Long-Term Capital Gain (equity) – ₹1.25L exempt',
        },
        ltcgForeign: {
          rate: 0.125,
          section: '112',
          description: 'Long-Term Capital Gain (foreign)',
        },
        stcgForeign: {
          rate: 'slab',
          section: 'Slab rate',
          description: 'Short-Term Capital Gain (foreign) – taxed at slab rate',
        },
      },
      rebate87A: {
        limit: 500000,
        amount: 12500,
        description: 'Rebate under Section 87A for income up to ₹5L',
      },
      surcharge: [
        { upto: 5000000, rate: 0.00, label: 'Up to ₹50L' },
        { upto: 10000000, rate: 0.10, label: '₹50L – ₹1Cr' },
        { upto: 20000000, rate: 0.15, label: '₹1Cr – ₹2Cr' },
        { upto: Infinity, rate: 0.25, label: '₹2Cr and above' },
      ],
      cess: {
        rate: 0.04,
        baseAmount: 'Tax + Surcharge',
        description: 'Health & Education Cess – 4% on total tax + surcharge',
      },
      holdingPeriods: {
        equity: {
          stcgThreshold: 365,
          description: 'Holding ≤365 days = STCG; >365 days = LTCG',
        },
        debt: {
          stcgThreshold: 730,
          description: 'Holding ≤730 days = STCG; >730 days = LTCG',
        },
        foreign: {
          stcgThreshold: 730,
          description: 'Holding ≤730 days = STCG; >730 days = LTCG',
        },
      },
    },
    oldRegime: {
      status: 'not_supported',
      reason: 'Use New Regime for FY 2024-25',
    },
  },

  // FY 2023-24 (AY 2024-25) - Budget 2023 restructured slabs
  '2023-24': {
    status: 'active',
    budgetYear: 2023,
    newRegime: {
      status: 'supported',
      standardDeduction: 75000,
      note: 'Budget 2023: Restructured tax slabs & increased standard deduction from ₹50K to ₹75K',
      slabs: [
        { upto: 400000, rate: 0.00, label: '₹0 – ₹4L' },
        { upto: 800000, rate: 0.05, label: '₹4L – ₹8L' },
        { upto: 1200000, rate: 0.10, label: '₹8L – ₹12L' },
        { upto: 1600000, rate: 0.15, label: '₹12L – ₹16L' },
        { upto: 2000000, rate: 0.20, label: '₹16L – ₹20L' },
        { upto: 2400000, rate: 0.25, label: '₹20L – ₹24L' },
        { upto: Infinity, rate: 0.30, label: '₹24L and above' },
      ],
      capitalGains: {
        stcg: {
          rate: 0.20,
          section: '111A (Equity, STT paid)',
          description: 'Short-Term Capital Gain (equity with STT)',
        },
        ltcgEquity: {
          rate: 0.125,
          section: '112A',
          exemption: 125000,
          description: 'Long-Term Capital Gain (equity) – ₹1.25L exempt',
        },
        ltcgForeign: {
          rate: 0.125,
          section: '112',
          description: 'Long-Term Capital Gain (foreign)',
        },
        stcgForeign: {
          rate: 'slab',
          section: 'Slab rate',
          description: 'Short-Term Capital Gain (foreign) – taxed at slab rate',
        },
      },
      rebate87A: {
        limit: 500000,
        amount: 12500,
        description: 'Rebate under Section 87A for income up to ₹5L',
      },
      surcharge: [
        { upto: 5000000, rate: 0.00, label: 'Up to ₹50L' },
        { upto: 10000000, rate: 0.10, label: '₹50L – ₹1Cr' },
        { upto: 20000000, rate: 0.15, label: '₹1Cr – ₹2Cr' },
        { upto: Infinity, rate: 0.25, label: '₹2Cr and above' },
      ],
      cess: {
        rate: 0.04,
        baseAmount: 'Tax + Surcharge',
        description: 'Health & Education Cess – 4% on total tax + surcharge',
      },
      holdingPeriods: {
        equity: {
          stcgThreshold: 365,
          description: 'Holding ≤365 days = STCG; >365 days = LTCG',
        },
        debt: {
          stcgThreshold: 730,
          description: 'Holding ≤730 days = STCG; >730 days = LTCG',
        },
        foreign: {
          stcgThreshold: 730,
          description: 'Holding ≤730 days = STCG; >730 days = LTCG',
        },
      },
    },
    oldRegime: {
      status: 'not_supported',
      reason: 'Use New Regime for FY 2023-24',
    },
  },

  // FY 2022-23 (AY 2023-24) - Original New Regime structure
  '2022-23': {
    status: 'active',
    budgetYear: 2022,
    newRegime: {
      status: 'supported',
      standardDeduction: 50000,
      slabs: [
        { upto: 250000, rate: 0.00, label: '₹0 – ₹2.5L' },
        { upto: 500000, rate: 0.05, label: '₹2.5L – ₹5L' },
        { upto: 750000, rate: 0.10, label: '₹5L – ₹7.5L' },
        { upto: 1000000, rate: 0.15, label: '₹7.5L – ₹10L' },
        { upto: 1250000, rate: 0.20, label: '₹10L – ₹12.5L' },
        { upto: 1500000, rate: 0.25, label: '₹12.5L – ₹15L' },
        { upto: Infinity, rate: 0.30, label: '₹15L and above' },
      ],
      capitalGains: {
        stcg: {
          rate: 0.20,
          section: '111A (Equity, STT paid)',
          description: 'Short-Term Capital Gain (equity with STT)',
        },
        ltcgEquity: {
          rate: 0.125,
          section: '112A',
          exemption: 100000,
          description: 'Long-Term Capital Gain (equity) – ₹1L exempt',
        },
        ltcgForeign: {
          rate: 0.125,
          section: '112',
          description: 'Long-Term Capital Gain (foreign)',
        },
        stcgForeign: {
          rate: 'slab',
          section: 'Slab rate',
          description: 'Short-Term Capital Gain (foreign) – taxed at slab rate',
        },
      },
      rebate87A: {
        limit: 500000,
        amount: 12500,
        description: 'Rebate under Section 87A for income up to ₹5L',
      },
      surcharge: [
        { upto: 5000000, rate: 0.00, label: 'Up to ₹50L' },
        { upto: 10000000, rate: 0.10, label: '₹50L – ₹1Cr' },
        { upto: 20000000, rate: 0.15, label: '₹1Cr – ₹2Cr' },
        { upto: Infinity, rate: 0.25, label: '₹2Cr and above' },
      ],
      cess: {
        rate: 0.04,
        baseAmount: 'Tax + Surcharge',
        description: 'Health & Education Cess – 4% on total tax + surcharge',
      },
      holdingPeriods: {
        equity: {
          stcgThreshold: 365,
          description: 'Holding ≤365 days = STCG; >365 days = LTCG',
        },
        debt: {
          stcgThreshold: 730,
          description: 'Holding ≤730 days = STCG; >730 days = LTCG',
        },
        foreign: {
          stcgThreshold: 730,
          description: 'Holding ≤730 days = STCG; >730 days = LTCG',
        },
      },
    },
    oldRegime: {
      status: 'not_supported',
      reason: 'Use New Regime for FY 2022-23',
    },
  },

  // FY 2021-22 (AY 2022-23) - Original New Regime structure
  '2021-22': {
    status: 'active',
    budgetYear: 2021,
    newRegime: {
      status: 'supported',
      standardDeduction: 50000,
      slabs: [
        { upto: 250000, rate: 0.00, label: '₹0 – ₹2.5L' },
        { upto: 500000, rate: 0.05, label: '₹2.5L – ₹5L' },
        { upto: 750000, rate: 0.10, label: '₹5L – ₹7.5L' },
        { upto: 1000000, rate: 0.15, label: '₹7.5L – ₹10L' },
        { upto: 1250000, rate: 0.20, label: '₹10L – ₹12.5L' },
        { upto: 1500000, rate: 0.25, label: '₹12.5L – ₹15L' },
        { upto: Infinity, rate: 0.30, label: '₹15L and above' },
      ],
      capitalGains: {
        stcg: {
          rate: 0.20,
          section: '111A (Equity, STT paid)',
          description: 'Short-Term Capital Gain (equity with STT)',
        },
        ltcgEquity: {
          rate: 0.125,
          section: '112A',
          exemption: 100000,
          description: 'Long-Term Capital Gain (equity) – ₹1L exempt',
        },
        ltcgForeign: {
          rate: 0.125,
          section: '112',
          description: 'Long-Term Capital Gain (foreign)',
        },
        stcgForeign: {
          rate: 'slab',
          section: 'Slab rate',
          description: 'Short-Term Capital Gain (foreign) – taxed at slab rate',
        },
      },
      rebate87A: {
        limit: 500000,
        amount: 12500,
        description: 'Rebate under Section 87A for income up to ₹5L',
      },
      surcharge: [
        { upto: 5000000, rate: 0.00, label: 'Up to ₹50L' },
        { upto: 10000000, rate: 0.10, label: '₹50L – ₹1Cr' },
        { upto: 20000000, rate: 0.15, label: '₹1Cr – ₹2Cr' },
        { upto: Infinity, rate: 0.25, label: '₹2Cr and above' },
      ],
      cess: {
        rate: 0.04,
        baseAmount: 'Tax + Surcharge',
        description: 'Health & Education Cess – 4% on total tax + surcharge',
      },
      holdingPeriods: {
        equity: {
          stcgThreshold: 365,
          description: 'Holding ≤365 days = STCG; >365 days = LTCG',
        },
        debt: {
          stcgThreshold: 730,
          description: 'Holding ≤730 days = STCG; >730 days = LTCG',
        },
        foreign: {
          stcgThreshold: 730,
          description: 'Holding ≤730 days = STCG; >730 days = LTCG',
        },
      },
    },
    oldRegime: {
      status: 'not_supported',
      reason: 'Use New Regime for FY 2021-22',
    },
  },

  // FY 2020-21 (AY 2021-22) - Introduction of New Tax Regime
  '2020-21': {
    status: 'active',
    budgetYear: 2020,
    newRegime: {
      status: 'supported',
      standardDeduction: 50000,
      note: 'Budget 2020: Introduction of New Tax Regime (Section 115BAC)',
      slabs: [
        { upto: 250000, rate: 0.00, label: '₹0 – ₹2.5L' },
        { upto: 500000, rate: 0.05, label: '₹2.5L – ₹5L' },
        { upto: 750000, rate: 0.10, label: '₹5L – ₹7.5L' },
        { upto: 1000000, rate: 0.15, label: '₹7.5L – ₹10L' },
        { upto: 1250000, rate: 0.20, label: '₹10L – ₹12.5L' },
        { upto: 1500000, rate: 0.25, label: '₹12.5L – ₹15L' },
        { upto: Infinity, rate: 0.30, label: '₹15L and above' },
      ],
      capitalGains: {
        stcg: {
          rate: 0.20,
          section: '111A (Equity, STT paid)',
          description: 'Short-Term Capital Gain (equity with STT)',
        },
        ltcgEquity: {
          rate: 0.125,
          section: '112A',
          exemption: 100000,
          description: 'Long-Term Capital Gain (equity) – ₹1L exempt',
        },
        ltcgForeign: {
          rate: 0.125,
          section: '112',
          description: 'Long-Term Capital Gain (foreign)',
        },
        stcgForeign: {
          rate: 'slab',
          section: 'Slab rate',
          description: 'Short-Term Capital Gain (foreign) – taxed at slab rate',
        },
      },
      rebate87A: {
        limit: 500000,
        amount: 12500,
        description: 'Rebate under Section 87A for income up to ₹5L',
      },
      surcharge: [
        { upto: 5000000, rate: 0.00, label: 'Up to ₹50L' },
        { upto: 10000000, rate: 0.10, label: '₹50L – ₹1Cr' },
        { upto: 20000000, rate: 0.15, label: '₹1Cr – ₹2Cr' },
        { upto: Infinity, rate: 0.25, label: '₹2Cr and above' },
      ],
      cess: {
        rate: 0.04,
        baseAmount: 'Tax + Surcharge',
        description: 'Health & Education Cess – 4% on total tax + surcharge',
      },
      holdingPeriods: {
        equity: {
          stcgThreshold: 365,
          description: 'Holding ≤365 days = STCG; >365 days = LTCG',
        },
        debt: {
          stcgThreshold: 730,
          description: 'Holding ≤730 days = STCG; >730 days = LTCG',
        },
        foreign: {
          stcgThreshold: 730,
          description: 'Holding ≤730 days = STCG; >730 days = LTCG',
        },
      },
    },
    oldRegime: {
      status: 'not_supported',
      reason: 'New Regime introduced in FY 2020-21; Old Regime available but not implemented',
    },
  },
};

/**
 * Get taxation rules for a specific financial year and regime.
 * Returns null if the year/regime combination is not supported.
 *
 * @param {string} fy - Financial year in format 'YYYY-YY' (e.g., '2025-26')
 * @param {string} regime - 'newRegime' or 'oldRegime' (default: 'newRegime')
 * @returns {Object|null} Taxation rules object or null if not found
 */
function getTaxationRules(fy, regime = 'newRegime') {
  const fyData = TAXATION_RULES[fy];
  if (!fyData) return null;

  const regimeData = fyData[regime];
  if (!regimeData) return null;

  if (regimeData.status === 'not_supported') {
    return {
      status: 'not_supported',
      reason: regimeData.reason,
    };
  }

  return regimeData;
}

/**
 * List all supported financial years (in descending order).
 * Optionally filtered by regime availability.
 *
 * @param {string} regime - Optional: 'newRegime' or 'oldRegime'
 * @returns {Array<string>} Array of FY strings (e.g., ['2025-26', '2024-25', ...])
 */
function listSupportedYears(regime = 'newRegime') {
  return Object.keys(TAXATION_RULES)
    .filter((fy) => {
      const regimeData = TAXATION_RULES[fy][regime];
      return regimeData && regimeData.status === 'supported';
    })
    .sort()
    .reverse();
}

/**
 * Get summary of taxation rules for UI display.
 * Includes key parameters like slabs, standard deduction, LTCG rates, etc.
 *
 * @param {string} fy - Financial year in format 'YYYY-YY'
 * @param {string} regime - 'newRegime' or 'oldRegime'
 * @returns {Object|null} Summarized rules object for UI rendering
 */
function getTaxationRulesSummary(fy, regime = 'newRegime') {
  const rules = getTaxationRules(fy, regime);
  if (!rules || rules.status === 'not_supported') return null;

  return {
    fy,
    regime,
    standardDeduction: rules.standardDeduction,
    slabs: rules.slabs,
    capitalGains: rules.capitalGains,
    rebate87A: rules.rebate87A,
    surcharge: rules.surcharge,
    cess: rules.cess,
    holdingPeriods: rules.holdingPeriods,
  };
}

module.exports = {
  TAXATION_RULES,
  getTaxationRules,
  listSupportedYears,
  getTaxationRulesSummary,
};
