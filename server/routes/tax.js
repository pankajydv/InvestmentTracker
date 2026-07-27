/**
 * Tax Report API for Indian Income Tax filing.
 *
 * Covers income from US stock (RSU / ESPP) holdings:
 *   - Schedule 1 Salary: perquisite value of RSU vests & ESPP discount
 *   - Schedule CG: Capital gains (FIFO lot matching, STCG/LTCG classification)
 *   - Schedule OS: Dividend income
 *   - Schedule FA: Foreign asset disclosure (year-end balance, peak value, cost)
 *
 * Indian FY = April 1 – March 31
 * LTCG threshold: >24 months holding period (rate: 12.5% without indexation, post Budget 2024)
 * STCG threshold: ≤24 months (taxed at slab rate)
 *
 * FIFO lot matching: each VEST / ESPP_PURCHASE / BUY is a separate tax lot.
 * Cost of acquisition (COA) = FMV on acquisition date × exchange_rate_used
 *   - For VEST: price_per_unit (FMV at vest) × exchange_rate_used
 *   - For ESPP_PURCHASE: fmv_per_unit × exchange_rate_used (not the discounted price)
 *   - For BUY: price_per_unit × exchange_rate_used
 *
 * Perquisite income:
 *   - VEST: price_per_unit × units × exchange_rate_used (FMV at vest = salary income)
 *   - ESPP_PURCHASE: (fmv_per_unit - price_per_unit) × units × exchange_rate_used
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const { parseAIS } = require('../services/aisParser');
const { parseForm16 } = require('../services/form16Parser');
const { getTaxationRules, getTaxationRulesSummary } = require('../config/taxationRules');

const aisUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const form16Upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const SUPPORTED_TAX_ASSET_TYPES = new Set(['FOREIGN_STOCK', 'INDIAN_STOCK', 'MUTUAL_FUND']);
const FOREIGN_TAX_ASSET_TYPES = new Set(['FOREIGN_STOCK']);
const LOT_CREATING_TYPES = new Set(['BUY', 'IPO', 'VEST', 'ESPP_PURCHASE', 'BONUS', 'SPLIT', 'RIGHTS', 'TRANSFER_IN', 'SWITCH_IN']);
const LOT_DISPOSAL_TYPES = new Set(['SELL', 'REDEMPTION', 'TRANSFER_OUT', 'SWITCH_OUT', 'WITHDRAWAL']);
const TAXABLE_DISPOSAL_TYPES = new Set(['SELL', 'REDEMPTION', 'SWITCH_OUT', 'WITHDRAWAL']);

function daysBetween(startDate, endDate) {
  const msPerDay = 24 * 60 * 60 * 1000;
  return (new Date(endDate) - new Date(startDate)) / msPerDay;
}

function isDebtLikeMutualFund(category) {
  const normalized = String(category || '').trim().toLowerCase();
  return ['debt', 'liquid', 'gilt', 'bond', 'income'].includes(normalized);
}

function gainTypeForInvestment(investment, acquisitionDate, saleDate) {
  const holdingDays = daysBetween(acquisitionDate, saleDate);
  if (investment.asset_type === 'FOREIGN_STOCK') return holdingDays > 730 ? 'LTCG' : 'STCG';
  if (investment.asset_type === 'INDIAN_STOCK') return holdingDays > 365 ? 'LTCG' : 'STCG';
  if (investment.asset_type === 'MUTUAL_FUND') {
    return isDebtLikeMutualFund(investment.category) ? (holdingDays > 730 ? 'LTCG' : 'STCG') : (holdingDays > 365 ? 'LTCG' : 'STCG');
  }
  return holdingDays > 730 ? 'LTCG' : 'STCG';
}

// ── Tax classification (equity-oriented vs non-equity) ───────────────────────
// Primary signal: STT charged on the disposal. STT on MF redemption/switch is
// levied ONLY on equity-oriented funds, so its presence is the most reliable
// real-world indicator (more reliable than SEBI's scheme-category label, which
// can mark an equity FoF as "Other Scheme"). Falls back to category/name.
const DEBT_NAME_RE = /debt|liquid|gilt|\bbond\b|money market|overnight|ultra short|low duration|floater|corporate bond|banking\s*&?\s*psu|credit risk|dynamic bond|short duration|medium duration/i;

function resolveEquityOriented(inv, hasSttOnDisposal) {
  if (inv.asset_type === 'FOREIGN_STOCK') return false; // outside the Indian STT/111A/112A regime
  if (inv.asset_type === 'INDIAN_STOCK') return true;   // listed equity / equity ETF, STT paid
  if (inv.asset_type === 'MUTUAL_FUND') {
    if (hasSttOnDisposal) return true; // STT on redemption ⇒ equity-oriented
    const cat = String(inv.category || '').toLowerCase();
    if (cat.includes('equity')) return true;
    if (DEBT_NAME_RE.test(cat)) return false;
    const name = String(inv.display_name || inv.name || '');
    if (DEBT_NAME_RE.test(name)) return false;
    return true; // default: most Indian MFs are equity-oriented
  }
  return false;
}

function thresholdDaysFor(inv, equityOriented) {
  if (inv.asset_type === 'FOREIGN_STOCK') return 730;
  return equityOriented ? 365 : 730;
}

// Asset class + ITR section for a disposal row.
function classifyForTax(inv, gainType, equityOriented) {
  let assetClass;
  if (inv.asset_type === 'FOREIGN_STOCK') assetClass = 'Foreign';
  else if (equityOriented) assetClass = 'Equity';
  else assetClass = 'Debt';

  let taxSection;
  if (assetClass === 'Equity') taxSection = gainType === 'LTCG' ? '112A' : '111A';
  else taxSection = gainType === 'LTCG' ? '112' : 'SLAB'; // Foreign + Debt

  return { assetClass, taxSection };
}

// ── ITR quarter buckets (for Section 234C advance-tax interest) ──────────────
const FY_QUARTERS = [
  { key: 'Q1', label: 'Up to 15 Jun' },
  { key: 'Q2', label: '16 Jun – 15 Sep' },
  { key: 'Q3', label: '16 Sep – 15 Dec' },
  { key: 'Q4', label: '16 Dec – 15 Mar' },
  { key: 'Q5', label: '16 Mar – 31 Mar' },
];

const CG_SECTION_DEFS = [
  { key: '111A', title: 'STCG – Equity (Section 111A, STT paid)' },
  { key: '112A', title: 'LTCG – Equity (Section 112A, STT paid)' },
  { key: '112', title: 'LTCG – Foreign / Other (Section 112)' },
  { key: 'SLAB', title: 'STCG – Foreign / Other (Slab rate)' },
];

// Map a sale date (YYYY-MM-DD) to its ITR financial-year quarter bucket.
function fyQuarterForDate(dateStr) {
  const parts = String(dateStr || '').split('-').map(Number);
  const m = parts[1];
  const d = parts[2];
  if (!m || !d) return 'Q4';
  const md = m * 100 + d;
  if (md >= 401 && md <= 615) return 'Q1';
  if (md >= 616 && md <= 915) return 'Q2';
  if (md >= 916 && md <= 1215) return 'Q3';
  if ((md >= 1216 && md <= 1231) || (md >= 101 && md <= 315)) return 'Q4';
  if (md >= 316 && md <= 331) return 'Q5';
  return 'Q4';
}

function roundCurrency(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function roundUnits(value) {
  return Math.round((Number(value) || 0) * 10000) / 10000;
}

function normalizeDateOnly(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  return s.split(/[ T]/)[0] || '';
}

function toNumberLoose(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (value == null) return 0;
  const cleaned = String(value).replace(/,/g, '').trim();
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function hasPropertySalesInAis(aisData) {
  if (!aisData) return false;
  const sales = aisData.property_sales || aisData.propertySales;
  if (!sales) return false;
  if (Array.isArray(sales)) return sales.length > 0;
  const rows = Array.isArray(sales.rows) ? sales.rows : [];
  if (rows.length > 0) return true;
  if (toNumberLoose(sales.count) > 0) return true;
  if (toNumberLoose(sales.total_amount) > 0) return true;
  if (toNumberLoose(sales.totalAmount) > 0) return true;
  return false;
}

function hasLegacyAisWithoutPropertyFields(aisData) {
  if (!aisData || typeof aisData !== 'object') return false;
  const hasSalesKey = Object.prototype.hasOwnProperty.call(aisData, 'property_sales')
    || Object.prototype.hasOwnProperty.call(aisData, 'propertySales');
  const hasPurchaseKey = Object.prototype.hasOwnProperty.call(aisData, 'property_purchases')
    || Object.prototype.hasOwnProperty.call(aisData, 'propertyPurchases');
  return !hasSalesKey && !hasPurchaseKey;
}

function calendarYearWindow(calendarYear) {
  const y = Number(calendarYear);
  if (!Number.isFinite(y) || y < 1900 || y > 2500) {
    throw new Error('Invalid calendar year');
  }
  return {
    year: y,
    start: `${y}-01-01`,
    end: `${y}-12-31`,
  };
}

function buildScheduleFaA3Rows(db, { portfolioId, calendarYear }) {
  if (!portfolioId) throw new Error('portfolio_id is required');
  const { year, start, end } = calendarYearWindow(calendarYear);

  const investments = db.prepare(`
    SELECT DISTINCT i.id, COALESCE(i.display_name, i.name) AS investment, i.ticker_symbol AS ticker
    FROM investments i
    JOIN transactions t ON t.investment_id = i.id
    WHERE i.asset_type = 'FOREIGN_STOCK' AND t.portfolio_id = ?
  `).all(portfolioId);

  const investmentIds = investments.map((r) => Number(r.id)).filter((id) => Number.isFinite(id));
  if (!investmentIds.length) {
    return {
      calendar_year: year,
      start_date: start,
      end_date: end,
      rows: [],
      summary: {
        rows: 0,
        surviving_rows: 0,
        unresolved_peak_rows: 0,
        unresolved_closing_rows: 0,
      },
    };
  }

  const invMap = new Map(investments.map((r) => [Number(r.id), r]));
  const idPlaceholders = investmentIds.map(() => '?').join(',');

  const dailyValueSeries = db.prepare(`
    SELECT DATE(dv.date) AS date, SUM(COALESCE(dv.current_value, 0)) AS total_current_value
    FROM daily_values dv
    WHERE dv.portfolio_id = ?
      AND dv.investment_id IN (${idPlaceholders})
      AND DATE(dv.date) >= ? AND DATE(dv.date) <= ?
    GROUP BY DATE(dv.date)
    ORDER BY DATE(dv.date) ASC
  `).all(portfolioId, ...investmentIds, start, end);

  let a2PeakBalanceInr = 0;
  let a2ClosingBalanceInr = 0;
  let a2ClosingDate = null;
  for (const row of dailyValueSeries) {
    const v = Number(row.total_current_value) || 0;
    if (v > a2PeakBalanceInr) a2PeakBalanceInr = v;
    a2ClosingBalanceInr = v;
    a2ClosingDate = normalizeDateOnly(row.date) || a2ClosingDate;
  }

  const divRow = db.prepare(`
    SELECT COALESCE(SUM(COALESCE(t.amount, 0)), 0) AS total_dividends
    FROM transactions t
    WHERE t.portfolio_id = ?
      AND t.investment_id IN (${idPlaceholders})
      AND t.transaction_type = 'DIVIDEND'
      AND DATE(t.transaction_date) >= ? AND DATE(t.transaction_date) <= ?
  `).get(portfolioId, ...investmentIds, start, end);
  const a2GrossPaidCreditedInr = Number(divRow?.total_dividends) || 0;

  const txns = db.prepare(`
    SELECT t.*, i.currency
    FROM transactions t
    JOIN investments i ON i.id = t.investment_id
    WHERE t.portfolio_id = ?
      AND t.investment_id IN (${idPlaceholders})
      AND DATE(t.transaction_date) <= ?
    ORDER BY DATE(t.transaction_date) ASC, t.id ASC
  `).all(portfolioId, ...investmentIds, end);

  const priceRows = db.prepare(`
    SELECT investment_id, date, close, adj_close
    FROM market_price_cache
    WHERE investment_id IN (${idPlaceholders})
      AND date >= ? AND date <= ?
    ORDER BY date ASC
  `).all(...investmentIds, start, end);

  const fxRows = db.prepare(`
    SELECT date, rate
    FROM fx_rate_cache
    WHERE date <= ?
    ORDER BY date ASC
  `).all(end);

  const fxByDate = new Map();
  for (const row of fxRows) {
    const d = normalizeDateOnly(row.date);
    const r = Number(row.rate) || 0;
    if (d && r > 0) fxByDate.set(d, r);
  }

  const fxNearestOnOrBefore = (dateIso) => {
    if (fxByDate.has(dateIso)) return fxByDate.get(dateIso);
    const keys = [...fxByDate.keys()];
    let nearest = null;
    for (const d of keys) {
      if (d <= dateIso) nearest = d;
      else break;
    }
    return nearest ? fxByDate.get(nearest) : null;
  };

  const pricesByInv = new Map();
  for (const row of priceRows) {
    const invId = Number(row.investment_id);
    const date = normalizeDateOnly(row.date);
    const closeUsd = Number(row.close) || Number(row.adj_close) || 0;
    if (!Number.isFinite(invId) || !date || closeUsd <= 0) continue;
    const fx = fxNearestOnOrBefore(date);
    if (!fx || fx <= 0) continue;
    const inrPerUnit = closeUsd * fx;
    if (!pricesByInv.has(invId)) pricesByInv.set(invId, []);
    pricesByInv.get(invId).push({ date, inrPerUnit });
  }

  const lotPoolByInv = new Map();
  const allLotsByInv = new Map();
  let windowActivated = false;

  const ensurePool = (invId) => {
    if (!lotPoolByInv.has(invId)) lotPoolByInv.set(invId, []);
    return lotPoolByInv.get(invId);
  };

  const registerLot = (invId, lot) => {
    ensurePool(invId).push(lot);
    if (!allLotsByInv.has(invId)) allLotsByInv.set(invId, []);
    allLotsByInv.get(invId).push(lot);
  };

  const markExistingLotsAsHeldInWindow = () => {
    for (const lots of allLotsByInv.values()) {
      for (const lot of lots) {
        if ((Number(lot.units_remaining) || 0) > 1e-9) lot.held_in_window = true;
      }
    }
  };

  const unitsAliveAtDate = (lot, dateIso) => {
    if (!lot || !dateIso) return 0;
    if (lot.acquisition_date > dateIso) return 0;
    let soldTillDate = 0;
    for (const ev of lot.sale_events || []) {
      if (ev.date <= dateIso) soldTillDate += Number(ev.units) || 0;
    }
    return Math.max(0, (Number(lot.units_original) || 0) - soldTillDate);
  };

  for (const txn of txns) {
    const invId = Number(txn.investment_id);
    if (!Number.isFinite(invId)) continue;
    const txnDate = normalizeDateOnly(txn.transaction_date);
    if (!txnDate || txnDate > end) continue;
    const txnType = String(txn.transaction_type || '').trim();

    if (!windowActivated && txnDate >= start) {
      markExistingLotsAsHeldInWindow();
      windowActivated = true;
    }

    const units = Number(txn.units) || 0;
    const grossUnits = Number(txn.gross_units) || units;
    const pricePerUnit = Number(txn.price_per_unit) || 0;
    const fmvPerUnit = Number(txn.fmv_per_unit) || pricePerUnit;
    const rate = Number(txn.exchange_rate_used) || null;
    const amountINR = Number(txn.amount) || 0;
    const feesINR = Number(txn.fees) || 0;

    if (txnType === 'VEST' && FOREIGN_TAX_ASSET_TYPES.has('FOREIGN_STOCK')) {
      const costPerUnitINR = units > 0
        ? (rate ? pricePerUnit * grossUnits * rate : amountINR) / units
        : 0;
      const buyFeePerUnitINR = units > 0 ? feesINR / units : 0;
      if (units > 0) {
        registerLot(invId, {
          acquisition_date: txnDate,
          units_original: units,
          units_remaining: units,
          cost_per_unit_inr: costPerUnitINR,
          buy_fee_per_unit_inr: buyFeePerUnitINR,
          sale_events: [],
          sale_proceeds_in_year: 0,
          dividends_in_year: 0,
          held_in_window: txnDate >= start && txnDate <= end,
        });
      }
      continue;
    }

    if (txnType === 'ESPP_PURCHASE' && FOREIGN_TAX_ASSET_TYPES.has('FOREIGN_STOCK')) {
      const costPerUnitINR = units > 0
        ? (rate ? fmvPerUnit * units * rate : amountINR) / units
        : 0;
      const buyFeePerUnitINR = units > 0 ? feesINR / units : 0;
      if (units > 0) {
        registerLot(invId, {
          acquisition_date: txnDate,
          units_original: units,
          units_remaining: units,
          cost_per_unit_inr: costPerUnitINR,
          buy_fee_per_unit_inr: buyFeePerUnitINR,
          sale_events: [],
          sale_proceeds_in_year: 0,
          dividends_in_year: 0,
          held_in_window: txnDate >= start && txnDate <= end,
        });
      }
      continue;
    }

    if (LOT_CREATING_TYPES.has(txnType)) {
      if (units > 0) {
        const grossCostINR = rate && String(txn.currency || '').toUpperCase() === 'USD'
          ? (pricePerUnit * units * rate)
          : amountINR;
        registerLot(invId, {
          acquisition_date: txnDate,
          units_original: units,
          units_remaining: units,
          cost_per_unit_inr: units > 0 ? grossCostINR / units : 0,
          buy_fee_per_unit_inr: units > 0 ? feesINR / units : 0,
          sale_events: [],
          sale_proceeds_in_year: 0,
          dividends_in_year: 0,
          held_in_window: txnDate >= start && txnDate <= end,
        });
      }
      continue;
    }

    if (LOT_DISPOSAL_TYPES.has(txnType)) {
      let remainingToSell = units;
      const pool = ensurePool(invId);
      while (remainingToSell > 1e-9 && pool.length > 0) {
        const lot = pool[0];
        const soldFromLot = Math.min(lot.units_remaining, remainingToSell);
        if (soldFromLot > 0) {
          lot.sale_events.push({ date: txnDate, units: soldFromLot });
          if (txnDate >= start && txnDate <= end && TAXABLE_DISPOSAL_TYPES.has(txnType) && units > 0) {
            lot.sale_proceeds_in_year = roundCurrency((Number(lot.sale_proceeds_in_year) || 0) + ((soldFromLot / units) * amountINR));
          }
        }
        lot.units_remaining -= soldFromLot;
        remainingToSell -= soldFromLot;
        if (lot.units_remaining < 1e-9) pool.shift();
      }
      continue;
    }

    if (txnType === 'DIVIDEND' && txnDate >= start && txnDate <= end) {
      const lots = allLotsByInv.get(invId) || [];
      const aliveLots = lots.filter((l) => unitsAliveAtDate(l, txnDate) > 1e-9);
      const aliveUnits = aliveLots.reduce((s, l) => s + unitsAliveAtDate(l, txnDate), 0);
      if (aliveUnits > 1e-9) {
        for (const lot of aliveLots) {
          const lotUnits = unitsAliveAtDate(lot, txnDate);
          const share = lotUnits / aliveUnits;
          lot.dividends_in_year = roundCurrency((Number(lot.dividends_in_year) || 0) + (amountINR * share));
        }
      }
    }
  }

  if (!windowActivated) markExistingLotsAsHeldInWindow();

  const rows = [];
  let unresolvedPeakRows = 0;
  let unresolvedClosingRows = 0;
  let survivingRows = 0;

  for (const [invId, allLots] of allLotsByInv.entries()) {
    const heldLots = (allLots || []).filter((l) => l.held_in_window);
    if (!heldLots.length) continue;
    const invMeta = invMap.get(invId) || { investment: '', ticker: '' };
    const priceTimeline = pricesByInv.get(invId) || [];
    const closingPoint = priceTimeline.length > 0 ? priceTimeline[priceTimeline.length - 1] : null;

    for (const lot of heldLots) {
      const unitsRemaining = Number(lot.units_remaining) || 0;
      if (unitsRemaining > 1e-9) survivingRows += 1;

      const initialValue = roundCurrency((Number(lot.units_original) || 0) * (Number(lot.cost_per_unit_inr) || 0));

      let peakValue = null;
      for (const p of priceTimeline) {
        if (p.date < lot.acquisition_date) continue;
        const unitsOnDate = unitsAliveAtDate(lot, p.date);
        if (unitsOnDate <= 1e-9) continue;
        const valueOnDate = roundCurrency(unitsOnDate * (Number(p.inrPerUnit) || 0));
        if (peakValue == null || valueOnDate > peakValue) peakValue = valueOnDate;
      }
      if (peakValue == null) unresolvedPeakRows += 1;

      let closingValue = null;
      if (unitsRemaining <= 1e-9) {
        closingValue = 0;
      } else if (closingPoint && Number(closingPoint.inrPerUnit) > 0) {
        closingValue = roundCurrency(unitsRemaining * Number(closingPoint.inrPerUnit));
      } else {
        unresolvedClosingRows += 1;
      }

      rows.push({
        investment_id: invId,
        investment: invMeta.investment,
        ticker: invMeta.ticker || '',
        acquisitionDate: lot.acquisition_date,
        acquiredValue: initialValue,
        peakValue,
        closingValue,
        dividends: roundCurrency(Number(lot.dividends_in_year) || 0),
        sale: roundCurrency(Number(lot.sale_proceeds_in_year) || 0),
      });
    }
  }

  rows.sort((a, b) => {
    const ia = String(a.investment || '').toLowerCase();
    const ib = String(b.investment || '').toLowerCase();
    if (ia < ib) return -1;
    if (ia > ib) return 1;
    const da = normalizeDateOnly(a.acquisitionDate);
    const dbb = normalizeDateOnly(b.acquisitionDate);
    if (da < dbb) return -1;
    if (da > dbb) return 1;
    return 0;
  });

  return {
    calendar_year: year,
    start_date: start,
    end_date: end,
    rows,
    a2_summary: {
      peak_balance_inr: roundCurrency(a2PeakBalanceInr),
      closing_balance_inr: roundCurrency(a2ClosingBalanceInr),
      gross_paid_credited_inr: roundCurrency(a2GrossPaidCreditedInr),
      closing_balance_date: a2ClosingDate,
      source: 'daily_values',
    },
    summary: {
      rows: rows.length,
      surviving_rows: survivingRows,
      unresolved_peak_rows: unresolvedPeakRows,
      unresolved_closing_rows: unresolvedClosingRows,
    },
  };
}

function buildTaxReport(db, fy, portfolioId, ltcgEquityExemption = 125000) {
  if (!fy) throw new Error('fy is required (e.g. 2025-26)');

  const { start: fyStart, end: fyEnd } = parseFY(fy);
  const fyStartStr = fyStart.toISOString().split('T')[0];
  const fyEndStr = fyEnd.toISOString().split('T')[0];

  let invSql = `SELECT * FROM investments WHERE asset_type IN (${[...SUPPORTED_TAX_ASSET_TYPES].map(() => '?').join(',')})`;
  const invParams = [...SUPPORTED_TAX_ASSET_TYPES];
  if (portfolioId) {
    invSql += ` AND id IN (SELECT DISTINCT investment_id FROM transactions WHERE portfolio_id = ?)`;
    invParams.push(portfolioId);
  }
  const investments = db.prepare(invSql).all(...invParams);

  if (investments.length === 0) {
    return {
      fy,
      fy_start: fyStartStr,
      fy_end: fyEndStr,
      perquisite_income: [],
      capital_gains: [],
      dividend_income: [],
      form_67: [],
      schedule_fa: [],
      summary: {
        total_perquisite_inr: 0,
        total_stcg_inr: 0,
        total_ltcg_inr: 0,
        total_dividend_inr: 0,
        stcg_lots: 0,
        ltcg_lots: 0,
        tax_note: 'Capital gains include supported foreign stock, Indian stock, and mutual fund disposals. LTCG threshold varies by asset type/category.',
      },
    };
  }

  const investmentIds = investments.map((i) => i.id);
  const investmentMap = new Map(investments.map((i) => [i.id, i]));
  const idPlaceholders = investmentIds.map(() => '?').join(',');

  let txnSql = `
    SELECT t.*, i.name as investment_name, i.display_name, i.ticker_symbol, i.asset_type as investment_asset_type, i.category as investment_category, i.currency as investment_currency, i.isin_code
    FROM transactions t
    JOIN investments i ON t.investment_id = i.id
    WHERE t.investment_id IN (${idPlaceholders})
  `;
  const txnParams = [...investmentIds];
  if (portfolioId) {
    txnSql += ' AND t.portfolio_id = ?';
    txnParams.push(portfolioId);
  }
  txnSql += ' ORDER BY t.transaction_date ASC, t.id ASC';

  const allTxns = db.prepare(txnSql).all(...txnParams);

  // Fund-level equity-oriented resolution: if ANY disposal of an investment
  // carried STT (fees on an MF redemption/switch are STT), treat it as
  // equity-oriented. This corrects SEBI-label edge cases like equity FoFs.
  const invHasSttOnDisposal = {};
  for (const t of allTxns) {
    if (LOT_DISPOSAL_TYPES.has(t.transaction_type) && Number(t.fees) > 0) {
      invHasSttOnDisposal[t.investment_id] = true;
    }
  }
  const equityOrientedByInv = {};
  for (const inv of investments) {
    equityOrientedByInv[inv.id] = resolveEquityOriented(inv, !!invHasSttOnDisposal[inv.id]);
  }

  const lotPool = {};
  for (const inv of investments) lotPool[inv.id] = [];

  const perquisiteRows = [];
  const capitalGainsRows = [];
  const dividendRows = [];

  for (const txn of allTxns) {
    const inv = investmentMap.get(txn.investment_id);
    if (!inv) continue;
    const invId = txn.investment_id;
    const name = txn.display_name || txn.investment_name;
    const ticker = txn.ticker_symbol || '';
    const rate = txn.exchange_rate_used || null;
    const usdAmt = txn.usd_amount || null;
    const units = Number(txn.units) || 0;
    const grossUnits = Number(txn.gross_units) || units;
    const pricePerUnit = Number(txn.price_per_unit) || 0;
    const fmvPerUnit = Number(txn.fmv_per_unit) || pricePerUnit;
    const amtINR = Number(txn.amount) || 0;
    const feesINR = Number(txn.fees) || 0;
    const txnDate = txn.transaction_date;
    const inFY = txnDate >= fyStartStr && txnDate <= fyEndStr;

    if (txn.transaction_type === 'VEST' && FOREIGN_TAX_ASSET_TYPES.has(inv.asset_type)) {
      const costPerUnitINR = units > 0
        ? (rate ? pricePerUnit * grossUnits * rate : amtINR) / units
        : 0;
      const buyFeePerUnitINR = units > 0 ? feesINR / units : 0;
      if (units > 0) {
        lotPool[invId].push({
          acquisition_date: txnDate,
          units_remaining: units,
          cost_per_unit_inr: costPerUnitINR,
          buy_fee_per_unit_inr: buyFeePerUnitINR,
          buy_stt_per_unit_inr: 0,
          fmv_per_unit: pricePerUnit,
          exchange_rate: rate,
          txn_id: txn.id,
          type: 'VEST',
        });
      }
      if (inFY) {
        const fallbackGrossAmount = rate && pricePerUnit > 0 ? pricePerUnit * grossUnits * rate : amtINR;
        perquisiteRows.push({
          type: 'RSU_VEST',
          asset_type: inv.asset_type,
          date: txnDate,
          investment: name,
          ticker,
          units: grossUnits,
          net_units: units,
          tax_withheld_units: Number(txn.tax_withheld_units) || null,
          fmv_per_share_usd: pricePerUnit,
          exchange_rate: rate,
          perquisite_inr: roundCurrency(fallbackGrossAmount),
          notes: txn.notes || null,
        });
      }
      continue;
    }

    if (txn.transaction_type === 'ESPP_PURCHASE' && FOREIGN_TAX_ASSET_TYPES.has(inv.asset_type)) {
      const costPerUnitINR = units > 0
        ? (rate ? fmvPerUnit * units * rate : amtINR) / units
        : 0;
      const buyFeePerUnitINR = units > 0 ? feesINR / units : 0;
      if (units > 0) {
        lotPool[invId].push({
          acquisition_date: txnDate,
          units_remaining: units,
          cost_per_unit_inr: costPerUnitINR,
          buy_fee_per_unit_inr: buyFeePerUnitINR,
          buy_stt_per_unit_inr: 0,
          fmv_per_unit: fmvPerUnit,
          exchange_rate: rate,
          txn_id: txn.id,
          type: 'ESPP_PURCHASE',
        });
      }
      if (inFY) {
        const discountUSD = fmvPerUnit - pricePerUnit;
        perquisiteRows.push({
          type: 'ESPP_PURCHASE',
          asset_type: inv.asset_type,
          date: txnDate,
          investment: name,
          ticker,
          units,
          purchase_price_usd: pricePerUnit,
          fmv_per_share_usd: fmvPerUnit,
          discount_per_share_usd: Math.round(discountUSD * 10000) / 10000,
          exchange_rate: rate,
          perquisite_inr: roundCurrency(rate ? discountUSD * units * rate : 0),
          notes: txn.notes || null,
        });
      }
      continue;
    }

    if (LOT_CREATING_TYPES.has(txn.transaction_type)) {
      if (units > 0) {
        const grossCostINR = rate && inv.currency === 'USD'
          ? pricePerUnit * units * rate
          : amtINR;
        lotPool[invId].push({
          acquisition_date: txnDate,
          units_remaining: units,
          cost_per_unit_inr: units > 0 ? grossCostINR / units : 0,
          buy_fee_per_unit_inr: units > 0 ? feesINR / units : 0,
          buy_stt_per_unit_inr: units > 0 ? (Number(txn.stt) || 0) / units : 0,
          fmv_per_unit: inv.currency === 'USD' ? fmvPerUnit : pricePerUnit,
          exchange_rate: rate,
          txn_id: txn.id,
          type: txn.transaction_type,
        });
      }
      continue;
    }

    if (LOT_DISPOSAL_TYPES.has(txn.transaction_type)) {
      let remainingToSell = units;
      while (remainingToSell > 1e-9 && lotPool[invId].length > 0) {
        const lot = lotPool[invId][0];
        const soldFromLot = Math.min(lot.units_remaining, remainingToSell);

        if (inFY && soldFromLot > 1e-9 && TAXABLE_DISPOSAL_TYPES.has(txn.transaction_type)) {
          const saleProceedsINR = units > 0
            ? (soldFromLot / units) * amtINR
            : 0;
          const saleSideExpenseINR = units > 0
            ? (soldFromLot / units) * feesINR
            : 0;
          const buySideExpenseINR = (Number(lot.buy_fee_per_unit_inr) || 0) * soldFromLot;
          const saleSideSttINR = units > 0 ? (soldFromLot / units) * (Number(txn.stt) || 0) : 0;
          const buySideSttINR = (Number(lot.buy_stt_per_unit_inr) || 0) * soldFromLot;
          const totalSttINR = buySideSttINR + saleSideSttINR;
          const grossExpenseINR = buySideExpenseINR + saleSideExpenseINR;
          // STT is not a deductible cost/transfer expense for capital gains.
          const deductibleExpenseINR = Math.max(0, grossExpenseINR - totalSttINR);
          const costINR = lot.cost_per_unit_inr * soldFromLot;
          const gainINR = saleProceedsINR - costINR - deductibleExpenseINR;

          const equityOriented = !!equityOrientedByInv[invId];
          const thresholdDays = thresholdDaysFor(inv, equityOriented);
          const gt = daysBetween(lot.acquisition_date, txnDate) > thresholdDays ? 'LTCG' : 'STCG';
          const { assetClass, taxSection } = classifyForTax(inv, gt, equityOriented);

          capitalGainsRows.push({
            asset_type: inv.asset_type,
            asset_class: assetClass,
            tax_section: taxSection,
            equity_oriented: equityOriented,
            category: inv.category || null,
            investment: name,
            ticker,
            isin: inv.isin_code || null,
            lot_type: lot.type,
            transaction_type: txn.transaction_type,
            acquisition_date: lot.acquisition_date,
            sale_date: txnDate,
            units_sold: roundUnits(soldFromLot),
            lot_cost_per_unit_inr: roundCurrency(lot.cost_per_unit_inr),
            sale_price_per_unit: pricePerUnit,
            sale_exchange_rate: rate,
            buy_side_fees_inr: roundCurrency(buySideExpenseINR),
            sale_side_fees_inr: roundCurrency(saleSideExpenseINR),
            stt_inr: roundCurrency(totalSttINR),
            transfer_expense_inr: roundCurrency(deductibleExpenseINR),
            cost_inr: roundCurrency(costINR),
            sale_proceeds_inr: roundCurrency(saleProceedsINR),
            gain_loss_inr: roundCurrency(gainINR),
            gain_type: gt,
            quarter: fyQuarterForDate(txnDate),
            notes: txn.notes || null,
          });
        }

        lot.units_remaining -= soldFromLot;
        remainingToSell -= soldFromLot;
        if (lot.units_remaining < 1e-9) lotPool[invId].shift();
      }
      continue;
    }

    if (txn.transaction_type === 'DIVIDEND' && inFY) {
      dividendRows.push({
        asset_type: inv.asset_type,
        date: txnDate,
        quarter: fyQuarterForDate(txnDate),
        investment: name,
        ticker,
        amount_inr: roundCurrency(amtINR),
        usd_amount: usdAmt ? roundCurrency(usdAmt) : null,
        exchange_rate: rate,
        notes: txn.notes || null,
      });
    }
  }

  const scheduleFA = [];
  for (const inv of investments) {
    if (!FOREIGN_TAX_ASSET_TYPES.has(inv.asset_type)) continue;
    const lots = lotPool[inv.id];
    if (lots.length === 0) continue;

    const totalUnitsHeld = lots.reduce((s, l) => s + l.units_remaining, 0);
    const totalCostINR = lots.reduce((s, l) => s + l.cost_per_unit_inr * l.units_remaining, 0);
    const totalCostUSD = lots.reduce((s, l) => s + (Number(l.fmv_per_unit) || 0) * l.units_remaining, 0);

    const yearEndDV = db.prepare(`
      SELECT price_per_unit, current_value, date FROM daily_values
      WHERE investment_id = ? AND date <= ?
      ORDER BY date DESC LIMIT 1
    `).get(inv.id, fyEndStr);

    const peakDV = db.prepare(`
      SELECT MAX(current_value) as peak_value FROM daily_values
      WHERE investment_id = ? AND date >= ? AND date <= ?
    `).get(inv.id, fyStartStr, fyEndStr);

    scheduleFA.push({
      investment: inv.display_name || inv.name,
      ticker: inv.ticker_symbol || '',
      isin: inv.isin_code || null,
      units_held: roundUnits(totalUnitsHeld),
      acquisition_cost_usd: roundCurrency(totalCostUSD),
      acquisition_cost_inr: roundCurrency(totalCostINR),
      year_end_price_per_unit_inr: yearEndDV ? yearEndDV.price_per_unit : null,
      year_end_value_inr: yearEndDV ? roundCurrency(totalUnitsHeld * (yearEndDV.price_per_unit || 0)) : null,
      year_end_date: yearEndDV ? yearEndDV.date : null,
      peak_value_inr: peakDV ? peakDV.peak_value : null,
    });
  }

  const totalPerquisiteINR = perquisiteRows.reduce((s, r) => s + (r.perquisite_inr || 0), 0);
  const stcgRows = capitalGainsRows.filter((r) => r.gain_type === 'STCG');
  const ltcgRows = capitalGainsRows.filter((r) => r.gain_type === 'LTCG');
  const totalSTCGINR = stcgRows.reduce((s, r) => s + (r.gain_loss_inr || 0), 0);
  const totalLTCGINR = ltcgRows.reduce((s, r) => s + (r.gain_loss_inr || 0), 0);
  const totalDividendINR = dividendRows.reduce((s, r) => s + (r.amount_inr || 0), 0);

  // ── Dividend quarter-wise breakup (for Section 234C advance-tax interest) ──
  const dividendQuarterly = FY_QUARTERS.map((q) => {
    const indian = roundCurrency(dividendRows
      .filter((r) => r.quarter === q.key && r.asset_type !== 'FOREIGN_STOCK')
      .reduce((s, r) => s + (r.amount_inr || 0), 0));
    const foreign = roundCurrency(dividendRows
      .filter((r) => r.quarter === q.key && r.asset_type === 'FOREIGN_STOCK')
      .reduce((s, r) => s + (r.amount_inr || 0), 0));
    return { quarter: q.key, label: q.label, indian, foreign, total: roundCurrency(indian + foreign) };
  });

  // ── Form 67: Foreign Tax Credit on dividends ─────────────────────────────
  // DB stores GROSS dividends (declared_rate × shares) in usd_amount/amount.
  // US federal withholding is 25% for Indian residents (DTAA Article 10).
  // Form 67 requires: country, TIN, gross income, tax paid (all in INR).
  const US_WITHHOLDING_RATE = 0.25;
  const form67Rows = [];
  for (const d of dividendRows) {
    if (d.asset_type !== 'FOREIGN_STOCK' || !d.usd_amount) continue;
    const grossUSD = roundCurrency(d.usd_amount);
    const taxUSD = roundCurrency(d.usd_amount * US_WITHHOLDING_RATE);
    const netUSD = roundCurrency(d.usd_amount * (1 - US_WITHHOLDING_RATE));
    const rate = d.exchange_rate || 1;
    form67Rows.push({
      date: d.date,
      investment: d.investment,
      ticker: d.ticker || null,
      country: 'United States',
      country_code: 'US',
      gross_dividend_usd: grossUSD,
      tax_withheld_usd: taxUSD,
      net_dividend_usd: netUSD,
      exchange_rate: rate,
      gross_dividend_inr: d.amount_inr,
      tax_withheld_inr: roundCurrency(taxUSD * rate),
      net_dividend_inr: roundCurrency(netUSD * rate),
    });
  }
  const totalFTCINR = form67Rows.reduce((s, r) => s + r.tax_withheld_inr, 0);

  // ── Schedule CG sub-sections by ITR section ──────────────────────────────
  const sumBy = (rows, field) => rows.reduce((s, r) => s + (Number(r[field]) || 0), 0);
  const cgSections = CG_SECTION_DEFS.map((def) => {
    const rows = capitalGainsRows.filter((r) => r.tax_section === def.key);
    return {
      key: def.key,
      title: def.title,
      section: def.key,
      rows,
      subtotal: {
        rows: rows.length,
        cost_inr: roundCurrency(sumBy(rows, 'cost_inr')),
        proceeds_inr: roundCurrency(sumBy(rows, 'sale_proceeds_inr')),
        expenditure_inr: roundCurrency(sumBy(rows, 'transfer_expense_inr')),
        stt_inr: roundCurrency(sumBy(rows, 'stt_inr')),
        gain_inr: roundCurrency(sumBy(rows, 'gain_loss_inr')),
      },
    };
  });

  // ── Quarter-wise breakup (gross gains net of fees) per section ────────────
  const cgQuarterly = FY_QUARTERS.map((q) => {
    const entry = { quarter: q.key, label: q.label };
    for (const def of CG_SECTION_DEFS) {
      const g = capitalGainsRows
        .filter((r) => r.tax_section === def.key && r.quarter === q.key)
        .reduce((s, r) => s + (r.gain_loss_inr || 0), 0);
      entry[def.key] = roundCurrency(g);
    }
    entry.total = roundCurrency(CG_SECTION_DEFS.reduce((s, def) => s + entry[def.key], 0));
    return entry;
  });

  // ── CG headline summary (with 112A ₹1.25L exemption) ─────────────────────
  const gainForSection = (key) => roundCurrency(
    sumBy(capitalGainsRows.filter((r) => r.tax_section === key), 'gain_loss_inr'),
  );
  const stcg111a = gainForSection('111A');
  const ltcg112aGross = gainForSection('112A');
  const ltcg112 = gainForSection('112');
  const stcgSlab = gainForSection('SLAB');
  const ltcg112aExemptionUsed = roundCurrency(Math.min(Math.max(ltcg112aGross, 0), ltcgEquityExemption));
  const ltcg112aTaxable = roundCurrency(Math.max(0, ltcg112aGross - ltcgEquityExemption));

  return {
    fy,
    fy_start: fyStartStr,
    fy_end: fyEndStr,
    perquisite_income: perquisiteRows,
    capital_gains: capitalGainsRows,
    cg_sections: cgSections,
    cg_quarterly: cgQuarterly,
    cg_quarter_labels: FY_QUARTERS,
    cg_section_defs: CG_SECTION_DEFS,
    dividend_income: dividendRows,
    dividend_quarterly: dividendQuarterly,
    form_67: form67Rows,
    schedule_fa: scheduleFA,
    summary: {
      total_perquisite_inr: roundCurrency(totalPerquisiteINR),
      total_stcg_inr: roundCurrency(totalSTCGINR),
      total_ltcg_inr: roundCurrency(totalLTCGINR),
      total_dividend_inr: roundCurrency(totalDividendINR),
      total_ftc_inr: roundCurrency(totalFTCINR),
      stcg_lots: stcgRows.length,
      ltcg_lots: ltcgRows.length,
      cg_stcg_111a: stcg111a,
      cg_ltcg_112a_gross: ltcg112aGross,
      cg_ltcg_112a_exemption: ltcg112aExemptionUsed,
      cg_ltcg_112a_taxable: ltcg112aTaxable,
      cg_ltcg_112: ltcg112,
      cg_stcg_slab: stcgSlab,
      ltcg_112a_exemption_limit: ltcgEquityExemption,
      tax_note: 'Equity (STT-paid) → 111A STCG / 112A LTCG with 12-month threshold and ₹1.25L LTCG exemption. Foreign & non-equity → slab STCG / 112 LTCG with 24-month threshold. Equity classification uses STT charged on disposal as the primary signal.',
    },
  };
}

/**
 * Parse Indian Financial Year string like '2025-26' → { start: Date, end: Date }
 * FY 2025-26 = Apr 1 2025 – Mar 31 2026
 */
function parseFY(fy) {
  if (!fy || !/^\d{4}-\d{2}$/.test(fy)) {
    throw new Error('Invalid FY format. Use YYYY-YY e.g. 2025-26');
  }
  const startYear = parseInt(fy.split('-')[0]);
  const start = new Date(`${startYear}-04-01`);
  const end = new Date(`${startYear + 1}-03-31`);
  return { start, end, label: fy };
}

// ── New Regime Tax Computation (Dynamic, rule-based) ───────────────────────

/**
 * Compute tax on income using slab structure from taxation rules.
 * @param {number} taxableIncome - Income to be taxed
 * @param {Array} slabs - Slab array from taxation rules (must include upto & rate)
 * @returns {number} Tax amount rounded to nearest rupee
 */
function computeSlabTax(taxableIncome, slabs) {
  let tax = 0;
  let prev = 0;
  for (const slab of slabs) {
    const chunk = Math.min(taxableIncome, slab.upto) - prev;
    if (chunk <= 0) break;
    tax += chunk * slab.rate;
    prev = slab.upto;
  }
  return Math.round(tax);
}

/**
 * Compute surcharge based on total income and surcharge slabs from taxation rules.
 * @param {number} totalIncome - Total taxable income
 * @param {number} baseTax - Tax before surcharge
 * @param {Array} surchargeSlabs - Surcharge slab array from taxation rules
 * @returns {number} Surcharge amount rounded to nearest rupee
 */
function computeSurcharge(totalIncome, baseTax, surchargeSlabs) {
  for (const slab of surchargeSlabs) {
    if (totalIncome <= slab.upto) {
      return Math.round(baseTax * slab.rate);
    }
  }
  // If income exceeds all slabs, use the highest rate
  const lastSlab = surchargeSlabs[surchargeSlabs.length - 1];
  return Math.round(baseTax * lastSlab.rate);
}

function buildTaxComputation(db, fy, portfolioId) {
  // ── Fetch taxation rules for this financial year ──
  const taxRules = getTaxationRules(fy, 'newRegime');
  if (!taxRules || taxRules.status === 'not_supported') {
    throw new Error(`Tax computation not supported for FY ${fy} in New Regime`);
  }

  const standardDeduction = taxRules.standardDeduction;
  const slabs = taxRules.slabs;
  const surchargeSlabs = taxRules.surcharge;
  const stcgRate = taxRules.capitalGains.stcg.rate;
  const ltcgRate = taxRules.capitalGains.ltcgEquity.rate;
  const ltcgEquityExemption = taxRules.capitalGains.ltcgEquity.exemption;
  const rebate87ALimit = taxRules.rebate87A.limit;
  const rebate87AAmount = taxRules.rebate87A.amount;
  const cessRate = taxRules.cess.rate;

  // 1. Investment report (CG, dividends, perquisites)
  const investmentReport = buildTaxReport(db, fy, portfolioId, ltcgEquityExemption);

  // 2. AIS data
  const aisRow = portfolioId
    ? db.prepare('SELECT data_json FROM tax_ais_data WHERE fy = ? AND portfolio_id = ?').get(fy, portfolioId)
    : db.prepare('SELECT data_json FROM tax_ais_data WHERE fy = ? AND portfolio_id IS NULL').get(fy);
  const ais = aisRow ? JSON.parse(aisRow.data_json) : null;
  const hasAisPropertySale = hasPropertySalesInAis(ais);

  const form16Row = portfolioId
    ? db.prepare('SELECT data_json FROM tax_form16_data WHERE fy = ? AND portfolio_id = ?').get(fy, portfolioId)
    : db.prepare('SELECT data_json FROM tax_form16_data WHERE fy = ? AND portfolio_id IS NULL').get(fy);
  const form16 = form16Row ? JSON.parse(form16Row.data_json) : null;

  // 3. Other income entries
  const otherIncome = portfolioId
    ? db.prepare('SELECT * FROM tax_other_income WHERE fy = ? AND portfolio_id = ? ORDER BY category, id').all(fy, portfolioId)
    : db.prepare('SELECT * FROM tax_other_income WHERE fy = ? AND portfolio_id IS NULL ORDER BY category, id').all(fy);

  // 3b. Persisted property capital gains helper rows
  const propertyItems = portfolioId
    ? db.prepare('SELECT * FROM tax_property_items WHERE fy = ? AND portfolio_id = ? ORDER BY property_side, id').all(fy, portfolioId)
    : db.prepare('SELECT * FROM tax_property_items WHERE fy = ? AND portfolio_id IS NULL ORDER BY property_side, id').all(fy);
  const legacyPropertyUnknown = hasLegacyAisWithoutPropertyFields(ais);
  const effectivePropertyItems = (hasAisPropertySale || (legacyPropertyUnknown && propertyItems.length > 0)) ? propertyItems : [];

  // ── Head 1: Salary ──
  const salaryEntries = ais?.salary || [];
  const grossSalary = salaryEntries.reduce((s, e) => s + (e.gross || 0), 0);
  const salaryTDS = salaryEntries.reduce((s, e) => s + (e.tds_total || 0), 0);
  const netSalary = Math.max(0, grossSalary - standardDeduction);

  // ── Head 4: Capital Gains (taxed separately at special rates) ──
  const cg = investmentReport.summary || {};
  const stcg111a = cg.cg_stcg_111a || 0;
  const ltcg112aGross = cg.cg_ltcg_112a_gross || 0;
  const ltcg112aExemption = cg.cg_ltcg_112a_exemption || 0;
  const ltcg112aTaxable = cg.cg_ltcg_112a_taxable || 0;
  const ltcg112 = cg.cg_ltcg_112 || 0;
  const stcgSlab = cg.cg_stcg_slab || 0;
  const totalCG = stcg111a + ltcg112aTaxable + ltcg112 + stcgSlab;

  // ── Head 5: Other Sources ──
  const dividendINR = cg.total_dividend_inr || 0;
  const savingsInterest = otherIncome.filter((r) => r.category === 'SAVINGS_INTEREST').reduce((s, r) => s + r.amount, 0);
  const tdInterest = otherIncome.filter((r) => r.category === 'TD_INTEREST').reduce((s, r) => s + r.amount, 0);
  const ncdInterest = otherIncome.filter((r) => r.category === 'NCD_INTEREST').reduce((s, r) => s + r.amount, 0);
  const pfInterest = otherIncome.filter((r) => r.category === 'PF_INTEREST').reduce((s, r) => s + r.amount, 0);
  const otherOS = otherIncome.filter((r) => r.category === 'OTHER').reduce((s, r) => s + r.amount, 0);
  const osTransferExpense = otherIncome.filter((r) => r.category === 'OS_TRANSFER_EXPENSE').reduce((s, r) => s + r.amount, 0);
  const cgTransferExpense = otherIncome.filter((r) => r.category === 'CG_TRANSFER_EXPENSE').reduce((s, r) => s + r.amount, 0);
  const totalOS = Math.max(0, dividendINR + savingsInterest + tdInterest + ncdInterest + pfInterest + otherOS - osTransferExpense);
  const otherIncomeTDS = otherIncome.filter((r) => !['CG_TRANSFER_EXPENSE', 'OS_TRANSFER_EXPENSE', 'NPS_80CCD2'].includes(r.category)).reduce((s, r) => s + (r.tds || 0), 0);

  // ── Adjust LTCG 112 for transfer expenses (Section 48) ──
  const ltcg112AfterTransfer = Math.max(0, ltcg112 - cgTransferExpense);

  // ── Property Capital Gains helper (manual rows) ──
  // OLD side: one sale row + multiple cost rows (land/construction/stamp/etc.)
  const oldSale = effectivePropertyItems
    .filter((r) => r.property_side === 'OLD' && r.item_type === 'SALE_CONSIDERATION')
    .reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const oldCost = effectivePropertyItems
    .filter((r) => r.property_side === 'OLD' && r.item_type !== 'SALE_CONSIDERATION')
    .reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const oldPropertyGainLoss = Math.round((oldSale - oldCost) * 100) / 100;
  const oldPropertyLTCGBefore54 = Math.max(0, oldPropertyGainLoss);
  const oldPropertyLTCL = Math.max(0, -oldPropertyGainLoss);

  // Section 54 helper: exemption against old-property LTCG based on new-house
  // investment captured in NEW-side rows.
  const newPropertyEligibleInvestment = effectivePropertyItems
    .filter((r) => r.property_side === 'NEW')
    .reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const section54ExemptionUsed = Math.min(oldPropertyLTCGBefore54, Math.max(0, newPropertyEligibleInvestment));
  const oldPropertyLTCGAfter54 = Math.max(0, oldPropertyLTCGBefore54 - section54ExemptionUsed);

  // Apply property gain/loss on LTCG-112 bucket.
  const ltcg112WithPropertyGain = ltcg112AfterTransfer + oldPropertyLTCGAfter54;
  const propertyLtclSetoffUsed = Math.min(ltcg112WithPropertyGain, oldPropertyLTCL);
  const propertyLtclCarryForward = Math.max(0, oldPropertyLTCL - propertyLtclSetoffUsed);
  const ltcg112Adjusted = Math.max(0, ltcg112WithPropertyGain - propertyLtclSetoffUsed);

  const totalCGAdjusted = stcg111a + ltcg112aTaxable + ltcg112Adjusted + stcgSlab;

  // ── Gross Total Income ──
  const grossTotalIncome = netSalary + totalCGAdjusted + totalOS;

  // ── Deductions (New Regime: only 80CCD(2) employer NPS) ──
  const { start: fyStart, end: fyEnd } = parseFY(fy);
  const fyStartStr = fyStart.toISOString().split('T')[0];
  const fyEndStr = fyEnd.toISOString().split('T')[0];
  let npsQuery = `
    SELECT COALESCE(SUM(t.amount), 0) as total
    FROM transactions t
    JOIN investments i ON i.id = t.investment_id
    WHERE i.asset_type = 'NPS'
      AND t.transaction_type = 'EMPLOYER_CONTRIBUTION'
      AND t.transaction_date >= ? AND t.transaction_date <= ?
      AND i.name LIKE '%TIER I%'
  `;
  const npsParams = [fyStartStr, fyEndStr];
  if (portfolioId) {
    npsQuery += ' AND t.portfolio_id = ?';
    npsParams.push(portfolioId);
  }
  const npsEmployerContribution = Math.round(db.prepare(npsQuery).get(...npsParams).total);
  const form16Nps80ccd2 = Number(form16?.nps_employer_80ccd2);
  const deduction80CCD2 = Number.isFinite(form16Nps80ccd2) && form16Nps80ccd2 > 0
    ? Math.max(0, Math.round(form16Nps80ccd2))
    : npsEmployerContribution;
  const nps80CCD2Computed = npsEmployerContribution;
  const nps80CCD2Source = Number.isFinite(form16Nps80ccd2) && form16Nps80ccd2 > 0 ? 'FORM16' : 'NPS_TRANSACTIONS';
  const totalDeductions = deduction80CCD2;
  const totalTaxableIncome = Math.max(0, grossTotalIncome - totalDeductions);

  // ── Income grouping by tax rate (applied to taxable income after deductions) ──
  // Slab-rate income: Salary + Other Sources + STCG at slab (foreign STCG)
  const slabIncome = netSalary + totalOS + stcgSlab;
  // Special-rate CG: taxed at flat rates, not slab
  const specialRateCG = stcg111a + ltcg112aTaxable + ltcg112Adjusted;

  // ── Tax computation ──
  const taxOnSlabIncome = computeSlabTax(Math.max(0, slabIncome - deduction80CCD2), slabs);
  const taxOnSTCG111A = Math.round(Math.max(0, stcg111a) * stcgRate);
  const taxOnLTCG112A = Math.round(Math.max(0, ltcg112aTaxable) * ltcgRate);
  const taxOnLTCG112 = Math.round(Math.max(0, ltcg112Adjusted) * ltcgRate);

  // ── Total tax before surcharge/cess ──
  const totalTaxBeforeSurcharge = taxOnSlabIncome + taxOnSTCG111A + taxOnLTCG112A + taxOnLTCG112;

  // ── Section 87A rebate ──
  let rebate87A = 0;
  if (totalTaxableIncome <= rebate87ALimit) {
    rebate87A = Math.min(taxOnSlabIncome, rebate87AAmount);
  }
  const taxAfterRebate = Math.max(0, totalTaxBeforeSurcharge - rebate87A);

  // ── Surcharge ──
  const surcharge = computeSurcharge(totalTaxableIncome, taxAfterRebate, surchargeSlabs);

  // ── Cess ──
  const cess = Math.round((taxAfterRebate + surcharge) * cessRate);

  // ── Total tax liability ──
  const totalTaxLiability = taxAfterRebate + surcharge + cess;

  // ── Credits ──
  const ftcINR = cg.total_ftc_inr || 0;
  const lrsTCS = ais?.lrs_tcs?.reduce((s, r) => s + (r.tcs || 0), 0) || 0;
  const pfTDS = otherIncome.filter((r) => r.category === 'PF_INTEREST').reduce((s, r) => s + (r.tds || 0), 0);
  const totalTDS = salaryTDS + otherIncomeTDS;
  const totalCredits = totalTDS + lrsTCS + ftcINR;

  // ── Net payable / refund ──
  const netPayable = totalTaxLiability - totalCredits;

  return {
    fy,
    heads: {
      salary: {
        entries: salaryEntries,
        gross: grossSalary,
        standard_deduction: grossSalary > 0 ? standardDeduction : 0,
        net: netSalary,
        tds: salaryTDS,
      },
      capital_gains: {
        stcg_111a: stcg111a,
        ltcg_112a_gross: ltcg112aGross,
        ltcg_112a_exemption: ltcg112aExemption,
        ltcg_112a_taxable: ltcg112aTaxable,
        ltcg_112: ltcg112,
        ltcg_112_after_transfer: ltcg112AfterTransfer,
        property_ltcg_before_54: oldPropertyLTCGBefore54,
        property_section_54_exemption: section54ExemptionUsed,
        property_ltcg_added: oldPropertyLTCGAfter54,
        property_ltcl_setoff_used: propertyLtclSetoffUsed,
        property_ltcl_carry_forward: propertyLtclCarryForward,
        ltcg_112_adjusted: ltcg112Adjusted,
        ltcg_112_transfer_expense: cgTransferExpense,
        stcg_slab: stcgSlab,
        total: totalCGAdjusted,
      },
      other_sources: {
        dividends: dividendINR,
        savings_interest: savingsInterest,
        td_interest: tdInterest,
        ncd_interest: ncdInterest,
        pf_interest: pfInterest,
        other: otherOS,
        transfer_expense: osTransferExpense,
        total: totalOS,
        tds: otherIncomeTDS,
      },
    },
    slab_income: slabIncome,
    taxable_slab_income: Math.max(0, slabIncome - deduction80CCD2),
    special_rate_cg: specialRateCG,
    gross_total_income: grossTotalIncome,
    deductions: {
      nps_employer_80ccd2: deduction80CCD2,
      nps_employer_80ccd2_computed: nps80CCD2Computed,
      nps_employer_80ccd2_source: nps80CCD2Source,
      total: totalDeductions,
    },
    property_capital_gains: {
      enabled: hasAisPropertySale || legacyPropertyUnknown,
      source_unknown: legacyPropertyUnknown,
      rows_count: effectivePropertyItems.length,
      old_sale: oldSale,
      old_cost: oldCost,
      old_gain_loss: oldPropertyGainLoss,
      old_ltcg_before_54: oldPropertyLTCGBefore54,
      section_54_exemption_used: section54ExemptionUsed,
      old_ltcg_added: oldPropertyLTCGAfter54,
      old_ltcl_available: oldPropertyLTCL,
      old_ltcl_setoff_used: propertyLtclSetoffUsed,
      old_ltcl_carry_forward: propertyLtclCarryForward,
      new_property_eligible_investment: newPropertyEligibleInvestment,
    },
    total_taxable_income: totalTaxableIncome,
    tax: {
      on_slab_income: taxOnSlabIncome,
      on_stcg_111a: taxOnSTCG111A,
      on_ltcg_112a: taxOnLTCG112A,
      on_ltcg_112: taxOnLTCG112,
      total_before_surcharge: totalTaxBeforeSurcharge,
      rebate_87a: rebate87A,
      after_rebate: taxAfterRebate,
      surcharge,
      cess,
      total_liability: totalTaxLiability,
    },
    credits: {
      salary_tds: salaryTDS,
      other_tds: otherIncomeTDS - pfTDS,
      pf_tds: pfTDS,
      lrs_tcs: lrsTCS,
      ftc: ftcINR,
      total: totalCredits,
    },
    net_payable: netPayable,
    taxation_rules: {
      fy,
      regime: 'newRegime',
      standard_deduction: standardDeduction,
      slabs: slabs.map((s) => ({ upto: s.upto, rate: s.rate, label: s.label })),
      capital_gains: {
        stcg: { rate: stcgRate, section: taxRules.capitalGains.stcg.section, description: taxRules.capitalGains.stcg.description },
        ltcg_equity: { rate: ltcgRate, section: taxRules.capitalGains.ltcgEquity.section, exemption: ltcgEquityExemption, description: taxRules.capitalGains.ltcgEquity.description },
        ltcg_foreign: { rate: ltcgRate, section: taxRules.capitalGains.ltcgForeign.section, description: taxRules.capitalGains.ltcgForeign.description },
      },
      rebate_87a: { limit: rebate87ALimit, amount: rebate87AAmount, description: taxRules.rebate87A.description },
      surcharge: surchargeSlabs.map((s) => ({ upto: s.upto, rate: s.rate, label: s.label })),
      cess: { rate: cessRate, description: taxRules.cess.description },
    },
  };
}

/**
 * Determine if a lot is LTCG (held > 24 months) or STCG.
 */
function gainType(acquisitionDate, saleDate) {
  const acq = new Date(acquisitionDate);
  const sal = new Date(saleDate);
  const months = (sal.getFullYear() - acq.getFullYear()) * 12 + (sal.getMonth() - acq.getMonth());
  // Precise: use days for the last partial month check
  const msPerDay = 24 * 60 * 60 * 1000;
  const days = (sal - acq) / msPerDay;
  return days > 730 ? 'LTCG' : 'STCG'; // 730 days ≈ 24 months (simplified)
}

module.exports = function (db) {

  /**
   * GET /api/tax/us-stocks?fy=2025-26&portfolio_id=1
   *
   * Returns a comprehensive tax report for US stock holdings in the given FY.
   * Sections:
   *   - perquisite_income[]     : VEST and ESPP_PURCHASE events (Schedule 1 Salary)
   *   - capital_gains[]         : SELL events matched against FIFO lots (Schedule CG)
   *   - dividend_income[]       : DIVIDEND events (Schedule OS)
   *   - schedule_fa             : Year-end holdings for foreign asset disclosure
   *   - summary                 : Totals per section
   */
  router.get('/us-stocks', (req, res) => {
    try {
      const { fy, portfolio_id } = req.query;
      if (!portfolio_id) return res.status(400).json({ error: 'portfolio_id is required' });
      res.json(buildTaxReport(db, fy, portfolio_id));
    } catch (e) {
      console.error('Tax report error:', e);
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * GET /api/tax/meta?portfolio_id=1
   *
   * Returns lightweight metadata used to build the FY selector without hardcoding:
   *   - earliest_transaction_date : oldest transaction date across supported asset types
   */
  router.get('/meta', (req, res) => {
    try {
      const { portfolio_id } = req.query;
      const assetPlaceholders = [...SUPPORTED_TAX_ASSET_TYPES].map(() => '?').join(',');
      let sql = `
        SELECT MIN(DATE(t.transaction_date)) AS earliest_transaction_date
        FROM transactions t
        JOIN investments i ON i.id = t.investment_id
        WHERE i.asset_type IN (${assetPlaceholders})
      `;
      const params = [...SUPPORTED_TAX_ASSET_TYPES];
      if (portfolio_id) {
        sql += ' AND t.portfolio_id = ?';
        params.push(portfolio_id);
      }
      const row = db.prepare(sql).get(...params);
      res.json({ earliest_transaction_date: row?.earliest_transaction_date || null });
    } catch (e) {
      console.error('Tax meta error:', e);
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * GET /api/tax/us-stocks/csv?fy=2025-26&section=capital_gains&portfolio_id=1
   *
   * Download a section as CSV for ITR filing.
   * Supported sections: perquisite_income | capital_gains | dividend_income | schedule_fa
   */
  router.get('/us-stocks/csv', (req, res) => {
    try {
      const { fy, section, portfolio_id } = req.query;
      if (!fy || !section) return res.status(400).json({ error: 'fy and section are required' });

      // Re-use the main endpoint logic by calling a sub-request
      // We'll do it inline by delegating to the same logic via a synthetic call
      // — simpler: just call the DB query logic directly via a helper redirect
      const url = `/api/tax/us-stocks?fy=${fy}${portfolio_id ? `&portfolio_id=${portfolio_id}` : ''}`;
      req.url = `/us-stocks?fy=${fy}${portfolio_id ? `&portfolio_id=${portfolio_id}` : ''}`;

      // We can't easily self-call, so we'll compute the report inline.
      // Instead, the client will fetch the JSON and convert to CSV itself (see TaxReport.jsx).
      // This endpoint exists as a placeholder for future server-side CSV generation.
      res.status(501).json({ error: 'Use the /api/tax/us-stocks endpoint and the client CSV export button.' });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Schedule FA A3 lot-wise valuation (calendar-year based) ───────────────
  router.get('/schedule-fa-a3', (req, res) => {
    try {
      const { portfolio_id, calendar_year } = req.query;
      if (!portfolio_id) return res.status(400).json({ error: 'portfolio_id is required' });
      if (!calendar_year) return res.status(400).json({ error: 'calendar_year is required' });
      const result = buildScheduleFaA3Rows(db, {
        portfolioId: Number(portfolio_id),
        calendarYear: Number(calendar_year),
      });
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── AIS Upload ──────────────────────────────────────────────────────────────
  router.post('/ais', aisUpload.single('file'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No PDF file uploaded' });
      const fy = req.body.fy;
      const portfolioId = req.body.portfolio_id || null;
      if (!fy) return res.status(400).json({ error: 'fy is required' });
      if (!portfolioId) return res.status(400).json({ error: 'portfolio_id is required' });

      const parsed = await parseAIS(req.file.buffer);

      // Store parsed data
      db.prepare(`
        INSERT OR REPLACE INTO tax_ais_data (fy, portfolio_id, pan, data_json, uploaded_at)
        VALUES (?, ?, ?, ?, datetime('now'))
      `).run(fy, portfolioId, parsed.pan, JSON.stringify(parsed));

      // Auto-create other_income rows from AIS (savings + TD interest) if none exist
      const existingCount = db.prepare('SELECT COUNT(*) as c FROM tax_other_income WHERE fy = ? AND (portfolio_id = ? OR (portfolio_id IS NULL AND ? IS NULL))').get(fy, portfolioId, portfolioId).c;
      if (existingCount === 0) {
        const ins = db.prepare(`
          INSERT INTO tax_other_income (fy, portfolio_id, category, source_name, account_number, amount, tds, notes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const s of parsed.savings_interest) {
          ins.run(fy, portfolioId, 'SAVINGS_INTEREST', s.source, s.account_number, s.amount, 0, 'From AIS');
        }
        for (const t of parsed.td_interest) {
          ins.run(fy, portfolioId, 'TD_INTEREST', t.source, t.account_number, t.amount, 0, 'From AIS');
        }
        for (const n of parsed.interest_on_securities) {
          ins.run(fy, portfolioId, 'NCD_INTEREST', n.source, null, n.amount, n.tds, 'From AIS');
        }
        for (const p of parsed.pf_taxable_interest) {
          ins.run(fy, portfolioId, 'PF_INTEREST', p.source, null, p.amount, p.tds, 'From AIS');
        }
      }

      res.json(parsed);
    } catch (e) {
      console.error('AIS parse error:', e);
      res.status(500).json({ error: e.message });
    }
  });

  // ── AIS Data (previously uploaded) ─────────────────────────────────────────
  router.get('/ais', (req, res) => {
    try {
      const { fy, portfolio_id } = req.query;
      if (!fy) return res.status(400).json({ error: 'fy is required' });
      if (!portfolio_id) return res.status(400).json({ error: 'portfolio_id is required' });
      const row = db.prepare('SELECT data_json, uploaded_at FROM tax_ais_data WHERE fy = ? AND portfolio_id = ?').get(fy, portfolio_id);
      if (!row) return res.json(null);
      res.json({ ...JSON.parse(row.data_json), uploaded_at: row.uploaded_at });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Form-16 Upload (optional, used for 80CCD(2) authority) ───────────────
  router.post('/form16', form16Upload.single('file'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No PDF file uploaded' });
      const fy = req.body.fy;
      const portfolioId = req.body.portfolio_id || null;
      if (!fy) return res.status(400).json({ error: 'fy is required' });
      if (!portfolioId) return res.status(400).json({ error: 'portfolio_id is required' });

      const parsed = await parseForm16(req.file.buffer);

      db.prepare(`
        INSERT OR REPLACE INTO tax_form16_data (fy, portfolio_id, pan, data_json, uploaded_at)
        VALUES (?, ?, ?, ?, datetime('now'))
      `).run(fy, portfolioId, parsed.pan, JSON.stringify(parsed));

      res.json(parsed);
    } catch (e) {
      console.error('Form-16 parse error:', e);
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/form16', (req, res) => {
    try {
      const { fy, portfolio_id } = req.query;
      if (!fy) return res.status(400).json({ error: 'fy is required' });
      if (!portfolio_id) return res.status(400).json({ error: 'portfolio_id is required' });
      const row = db.prepare('SELECT data_json, uploaded_at FROM tax_form16_data WHERE fy = ? AND portfolio_id = ?').get(fy, portfolio_id);
      if (!row) return res.json(null);
      res.json({ ...JSON.parse(row.data_json), uploaded_at: row.uploaded_at });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Other Income CRUD ──────────────────────────────────────────────────────
  router.get('/other-income', (req, res) => {
    try {
      const { fy, portfolio_id } = req.query;
      if (!fy) return res.status(400).json({ error: 'fy is required' });
      if (!portfolio_id) return res.status(400).json({ error: 'portfolio_id is required' });
      const rows = db.prepare('SELECT * FROM tax_other_income WHERE fy = ? AND portfolio_id = ? ORDER BY category, id').all(fy, portfolio_id);
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/other-income', (req, res) => {
    try {
      const { fy, portfolio_id, category, source_name, account_number, amount, tds, notes } = req.body;
      if (!fy || !category || !source_name) {
        return res.status(400).json({ error: 'fy, category, and source_name are required' });
      }
      if (!portfolio_id) return res.status(400).json({ error: 'portfolio_id is required' });
      const result = db.prepare(`
        INSERT INTO tax_other_income (fy, portfolio_id, category, source_name, account_number, amount, tds, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(fy, portfolio_id || null, category, source_name, account_number || null, Number(amount) || 0, Number(tds) || 0, notes || null);
      const row = db.prepare('SELECT * FROM tax_other_income WHERE id = ?').get(result.lastInsertRowid);
      res.json(row);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.put('/other-income/:id', (req, res) => {
    try {
      const { source_name, account_number, amount, tds, notes } = req.body;
      db.prepare(`
        UPDATE tax_other_income SET source_name = ?, account_number = ?, amount = ?, tds = ?, notes = ?
        WHERE id = ?
      `).run(source_name, account_number || null, Number(amount) || 0, Number(tds) || 0, notes || null, req.params.id);
      const row = db.prepare('SELECT * FROM tax_other_income WHERE id = ?').get(req.params.id);
      res.json(row);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.delete('/other-income/:id', (req, res) => {
    try {
      db.prepare('DELETE FROM tax_other_income WHERE id = ?').run(req.params.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Property Capital Gains Items CRUD ─────────────────────────────────────
  router.get('/property-items', (req, res) => {
    try {
      const { fy, portfolio_id } = req.query;
      if (!fy) return res.status(400).json({ error: 'fy is required' });
      if (!portfolio_id) return res.status(400).json({ error: 'portfolio_id is required' });
      const rows = db.prepare('SELECT * FROM tax_property_items WHERE fy = ? AND portfolio_id = ? ORDER BY property_side, id').all(fy, portfolio_id);
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/property-items', (req, res) => {
    try {
      const { fy, portfolio_id, property_side, item_type, label, amount, txn_date, notes } = req.body;
      if (!fy || !property_side || !item_type || !label) {
        return res.status(400).json({ error: 'fy, property_side, item_type, and label are required' });
      }
      if (!portfolio_id) return res.status(400).json({ error: 'portfolio_id is required' });
      const result = db.prepare(`
        INSERT INTO tax_property_items (fy, portfolio_id, property_side, item_type, label, amount, txn_date, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        fy,
        portfolio_id || null,
        property_side,
        item_type,
        label,
        Number(amount) || 0,
        txn_date || null,
        notes || null,
      );
      const row = db.prepare('SELECT * FROM tax_property_items WHERE id = ?').get(result.lastInsertRowid);
      res.json(row);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.put('/property-items/bulk', (req, res) => {
    try {
      const { fy, portfolio_id, rows } = req.body;
      if (!fy) return res.status(400).json({ error: 'fy is required' });
      if (!portfolio_id) return res.status(400).json({ error: 'portfolio_id is required' });
      if (!Array.isArray(rows)) return res.status(400).json({ error: 'rows must be an array' });

      const replaceRows = db.transaction((fyValue, portfolioValue, inputRows) => {
        db.prepare('DELETE FROM tax_property_items WHERE fy = ? AND portfolio_id = ?').run(fyValue, portfolioValue);
        const insert = db.prepare(`
          INSERT INTO tax_property_items (fy, portfolio_id, property_side, item_type, label, amount, txn_date, notes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const row of inputRows) {
          const itemType = row.item_type || 'CUSTOM';
          const label = itemType === 'CUSTOM'
            ? (row.label || 'Custom Cost')
            : (row.label || itemType);
          insert.run(
            fyValue,
            portfolioValue,
            row.property_side,
            itemType,
            label,
            Number(row.amount) || 0,
            row.txn_date || null,
            row.notes || null,
          );
        }
        return db.prepare('SELECT * FROM tax_property_items WHERE fy = ? AND portfolio_id = ? ORDER BY property_side, id').all(fyValue, portfolioValue);
      });

      res.json(replaceRows(fy, portfolio_id, rows));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.put('/property-items/:id', (req, res) => {
    try {
      const { property_side, item_type, label, amount, txn_date, notes } = req.body;
      const current = db.prepare('SELECT * FROM tax_property_items WHERE id = ?').get(req.params.id);
      if (!current) return res.status(404).json({ error: 'Row not found' });
      db.prepare(`
        UPDATE tax_property_items
        SET property_side = ?, item_type = ?, label = ?, amount = ?, txn_date = ?, notes = ?
        WHERE id = ?
      `).run(
        property_side || current.property_side,
        item_type || current.item_type,
        label || current.label,
        amount == null ? current.amount : (Number(amount) || 0),
        txn_date || null,
        notes || null,
        req.params.id,
      );
      const row = db.prepare('SELECT * FROM tax_property_items WHERE id = ?').get(req.params.id);
      res.json(row);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.delete('/property-items/:id', (req, res) => {
    try {
      db.prepare('DELETE FROM tax_property_items WHERE id = ?').run(req.params.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Tax Computation (New Regime) ───────────────────────────────────────────
  router.get('/computation', (req, res) => {
    try {
      const { fy, portfolio_id } = req.query;
      if (!fy) return res.status(400).json({ error: 'fy is required' });
      if (!portfolio_id) return res.status(400).json({ error: 'portfolio_id is required' });
      res.json(buildTaxComputation(db, fy, portfolio_id));
    } catch (e) {
      console.error('Tax computation error:', e);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
