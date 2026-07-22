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

const LTCG_112A_EXEMPTION = 125000;

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

function buildTaxReport(db, fy, portfolioId) {
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
  const ltcg112aExemptionUsed = roundCurrency(Math.min(Math.max(ltcg112aGross, 0), LTCG_112A_EXEMPTION));
  const ltcg112aTaxable = roundCurrency(Math.max(0, ltcg112aGross - LTCG_112A_EXEMPTION));

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
    schedule_fa: scheduleFA,
    summary: {
      total_perquisite_inr: roundCurrency(totalPerquisiteINR),
      total_stcg_inr: roundCurrency(totalSTCGINR),
      total_ltcg_inr: roundCurrency(totalLTCGINR),
      total_dividend_inr: roundCurrency(totalDividendINR),
      stcg_lots: stcgRows.length,
      ltcg_lots: ltcgRows.length,
      cg_stcg_111a: stcg111a,
      cg_ltcg_112a_gross: ltcg112aGross,
      cg_ltcg_112a_exemption: ltcg112aExemptionUsed,
      cg_ltcg_112a_taxable: ltcg112aTaxable,
      cg_ltcg_112: ltcg112,
      cg_stcg_slab: stcgSlab,
      ltcg_112a_exemption_limit: LTCG_112A_EXEMPTION,
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

  return router;
};
