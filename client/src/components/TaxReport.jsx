import React, { useEffect, useMemo, useState } from 'react';
import { Card, Row, Col, Form, Button, Table, Badge, Spinner, Accordion } from 'react-bootstrap';
import { Download, Plus, Trash2 } from 'lucide-react';
import { usePortfolio } from '../context/PortfolioContext';
import CollapsibleSectionHeader from './CollapsibleSectionHeader';
import { getTaxReport, getTaxMeta, getTaxComputation, uploadAIS, getAISData, getOtherIncome, addOtherIncome, updateOtherIncome, deleteOtherIncome } from '../services/api';
import { formatINRExact as formatINR, formatDate, formatNumber, profitColor } from '../utils/formatters';
import { usePrivacyMaskRefresh } from '../utils/privacyMode';
import TaxComputation from './TaxComputation';
import PropertyCapitalGains from './PropertyCapitalGains';

function fyLabel(startYear) {
  return `${startYear}-${String(startYear + 1).slice(-2)}`;
}

// Financial year (Apr–Mar) start year for a given date.
function fyStartYearForDate(date) {
  if (!date) return null;
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  return d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
}

function currentFyStartYear() {
  return fyStartYearForDate(new Date());
}

// Default selection is the last completed financial year.
function defaultFy() {
  return fyLabel(currentFyStartYear() - 1);
}

// Build the FY option list from the current FY down to the earliest FY that has
// investment activity. Never includes a future FY. The last completed FY is
// always present so it can serve as the default.
function buildFyOptions(earliestStartYear) {
  const currentStart = currentFyStartYear();
  const lastCompletedStart = currentStart - 1;
  const minStart = Number.isFinite(earliestStartYear)
    ? Math.min(earliestStartYear, lastCompletedStart)
    : lastCompletedStart;
  const options = [];
  for (let y = currentStart; y >= minStart; y -= 1) {
    options.push(fyLabel(y));
  }
  return options;
}

function toCSV(rows) {
  if (!rows || rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const escapeCell = (v) => {
    if (v == null) return '';
    const s = String(v);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => escapeCell(row[h])).join(','));
  }
  return lines.join('\n');
}

function downloadCSV(filename, rows) {
  const csv = toCSV(rows);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function buildCapitalGainsExportRows(rows) {
  return (rows || []).map((row) => ({
    asset_class: row.asset_class || '',
    tax_section: row.tax_section || '',
    gain_type: row.gain_type || '',
    asset_type: row.asset_type || '',
    investment: row.investment || '',
    isin: row.isin || '',
    lot_type: row.lot_type || '',
    transaction_type: row.transaction_type || '',
    acquisition_date: row.acquisition_date || '',
    sale_date: row.sale_date || '',
    units_sold: row.units_sold ?? '',
    cost_inr: row.cost_inr ?? 0,
    proceeds_inr: row.sale_proceeds_inr ?? 0,
    expenditure_inr: row.transfer_expense_inr ?? 0,
    stt_inr: row.stt_inr ?? 0,
    gain_loss_inr: row.gain_loss_inr ?? 0,
  }));
}

// ── Schedule CG structure (mirrors the backend classification) ───────────────
const CG_SECTIONS = [
  { key: '111A', title: 'STCG — Equity (Section 111A, STT paid)' },
  { key: '112A', title: 'LTCG — Equity (Section 112A, STT paid)' },
  { key: '112', title: 'LTCG — Foreign / Other (Section 112)' },
  { key: 'SLAB', title: 'STCG — Foreign / Other (Slab rate)' },
];

const FY_QUARTERS = [
  { key: 'Q1', label: 'Up to 15 Jun' },
  { key: 'Q2', label: '16 Jun – 15 Sep' },
  { key: 'Q3', label: '16 Sep – 15 Dec' },
  { key: 'Q4', label: '16 Dec – 15 Mar' },
  { key: 'Q5', label: '16 Mar – 31 Mar' },
];

const LTCG_112A_EXEMPTION = 125000;

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function sumField(rows, field) { return round2((rows || []).reduce((s, r) => s + (Number(r[field]) || 0), 0)); }

function toNumberLoose(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (value == null) return 0;
  const cleaned = String(value).replace(/,/g, '').trim();
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function hasPropertySalesInAis(aisData) {
  if (!aisData) return false;
  const sales = aisData.property_sales ?? aisData.propertySales ?? null;
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

function computeSlabTaxLocal(taxableIncome) {
  const slabs = [
    { upto: 400000, rate: 0 },
    { upto: 800000, rate: 0.05 },
    { upto: 1200000, rate: 0.10 },
    { upto: 1600000, rate: 0.15 },
    { upto: 2000000, rate: 0.20 },
    { upto: 2400000, rate: 0.25 },
    { upto: Infinity, rate: 0.30 },
  ];
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

function computeSurchargeLocal(totalIncome, baseTax) {
  if (totalIncome <= 5000000) return 0;
  if (totalIncome <= 10000000) return Math.round(baseTax * 0.10);
  if (totalIncome <= 20000000) return Math.round(baseTax * 0.15);
  return Math.round(baseTax * 0.25);
}

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

// Derive per-section tables, quarter buckets and CG summary from the flat
// capital_gains list (works for both single-portfolio and combined reports).
function buildCgView(capitalGains) {
  const rows = capitalGains || [];
  const sections = CG_SECTIONS.map((def) => {
    const secRows = rows.filter((r) => r.tax_section === def.key);
    return {
      ...def,
      rows: secRows,
      subtotal: {
        count: secRows.length,
        cost: sumField(secRows, 'cost_inr'),
        proceeds: sumField(secRows, 'sale_proceeds_inr'),
        expenditure: sumField(secRows, 'transfer_expense_inr'),
        stt: sumField(secRows, 'stt_inr'),
        gain: sumField(secRows, 'gain_loss_inr'),
      },
    };
  });

  const quarterly = FY_QUARTERS.map((q) => {
    const entry = { quarter: q.key, label: q.label };
    let total = 0;
    for (const def of CG_SECTIONS) {
      const g = sumField(
        rows.filter((r) => r.tax_section === def.key && (r.quarter || fyQuarterForDate(r.sale_date)) === q.key),
        'gain_loss_inr',
      );
      entry[def.key] = g;
      total += g;
    }
    entry.total = round2(total);
    return entry;
  });

  // ITR-ready quarterly: absorb losses from earlier quarters into later quarters per section
  // (ITR Section F doesn't accept negative values)
  const quarterlyITR = FY_QUARTERS.map((q) => ({ quarter: q.key, label: q.label }));
  for (const def of CG_SECTIONS) {
    let carryLoss = 0;
    for (const qEntry of quarterlyITR) {
      const rawQ = quarterly.find((q) => q.quarter === qEntry.quarter);
      const rawVal = rawQ ? rawQ[def.key] : 0;
      const adjusted = rawVal + carryLoss; // carryLoss is negative or zero
      if (adjusted < 0) {
        qEntry[def.key] = 0;
        carryLoss = adjusted; // carry the remaining loss forward
      } else {
        qEntry[def.key] = round2(adjusted);
        carryLoss = 0;
      }
    }
  }
  for (const qEntry of quarterlyITR) {
    qEntry.total = round2(CG_SECTIONS.reduce((s, d) => s + (qEntry[d.key] || 0), 0));
  }

  const ltcg112aGross = sumField(rows.filter((r) => r.tax_section === '112A'), 'gain_loss_inr');
  const summary = {
    stcg111a: sumField(rows.filter((r) => r.tax_section === '111A'), 'gain_loss_inr'),
    ltcg112aGross,
    ltcg112aExemption: round2(Math.min(Math.max(ltcg112aGross, 0), LTCG_112A_EXEMPTION)),
    ltcg112aTaxable: round2(Math.max(0, ltcg112aGross - LTCG_112A_EXEMPTION)),
    ltcg112: sumField(rows.filter((r) => r.tax_section === '112'), 'gain_loss_inr'),
    stcgSlab: sumField(rows.filter((r) => r.tax_section === 'SLAB'), 'gain_loss_inr'),
  };

  return { sections, quarterly, quarterlyITR, summary };
}

function combineTaxReports(reports) {
  if (!Array.isArray(reports) || !reports.length) return null;

  const combined = {
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
      total_ftc_inr: 0,
      tax_note: reports[0]?.summary?.tax_note || '',
    },
  };

  for (const report of reports) {
    combined.perquisite_income.push(...(report?.perquisite_income || []));
    combined.capital_gains.push(...(report?.capital_gains || []));
    combined.dividend_income.push(...(report?.dividend_income || []));
    combined.form_67.push(...(report?.form_67 || []));
    combined.schedule_fa.push(...(report?.schedule_fa || []));

    combined.summary.total_perquisite_inr += Number(report?.summary?.total_perquisite_inr) || 0;
    combined.summary.total_stcg_inr += Number(report?.summary?.total_stcg_inr) || 0;
    combined.summary.total_ltcg_inr += Number(report?.summary?.total_ltcg_inr) || 0;
    combined.summary.total_dividend_inr += Number(report?.summary?.total_dividend_inr) || 0;
    combined.summary.total_ftc_inr += Number(report?.summary?.total_ftc_inr) || 0;
  }

  return combined;
}

export default function TaxReport() {
  usePrivacyMaskRefresh();
  const { selectedId, selectedIds, portfolios } = usePortfolio();
  const [earliestDate, setEarliestDate] = useState(null);
  const options = useMemo(() => buildFyOptions(fyStartYearForDate(earliestDate)), [earliestDate]);
  const [fy, setFy] = useState(() => defaultFy());
  const portfolioId = selectedIds.length === 1 ? String(selectedIds[0]) : '';
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState(null);
  const [computation, setComputation] = useState(null);
  const [error, setError] = useState('');
  const [perquisiteExpanded, setPerquisiteExpanded] = useState(false);
  const [cgQuarterExpanded, setCgQuarterExpanded] = useState(false);
  const [dividendExpanded, setDividendExpanded] = useState(false);
  const [divQuarterExpanded, setDivQuarterExpanded] = useState(false);
  const [interestExpanded, setInterestExpanded] = useState(false);
  const [ais, setAis] = useState(null);
  const [aisLoading, setAisLoading] = useState(false);
  const [otherIncome, setOtherIncome] = useState([]);
  const [taxRefreshNonce, setTaxRefreshNonce] = useState(0);
  const hasSinglePortfolio = selectedIds.length === 1;
  const hasAisPropertySale = useMemo(() => hasPropertySalesInAis(ais), [ais]);
  const hasLegacyPropertyUnknown = useMemo(() => hasLegacyAisWithoutPropertyFields(ais), [ais]);

  // Fetch the earliest transaction date so the FY list reflects real data range.
  useEffect(() => {
    let cancelled = false;
    getTaxMeta(portfolioId || undefined)
      .then((meta) => { if (!cancelled) setEarliestDate(meta?.earliest_transaction_date || null); })
      .catch(() => { if (!cancelled) setEarliestDate(null); });
    return () => { cancelled = true; };
  }, [portfolioId]);

  // Keep the selected FY within the available range (default to last completed FY).
  useEffect(() => {
    if (options.length && !options.includes(fy)) {
      setFy(options.includes(defaultFy()) ? defaultFy() : options[0]);
    }
  }, [options]); // eslint-disable-line react-hooks/exhaustive-deps

  const load = async () => {
    if (!hasSinglePortfolio) {
      setError('Select exactly one portfolio to generate tax computation.');
      setReport(null);
      setComputation(null);
      return;
    }
    setLoading(true);
    setError('');
    try {
      if (portfolioId) {
        const data = await getTaxReport(fy, portfolioId);
        setReport(data);
      } else if (selectedIds.length > 1) {
        const results = await Promise.all(selectedIds.map((id) => getTaxReport(fy, id)));
        setReport(combineTaxReports(results));
      } else {
        const effectivePortfolioId = selectedId || undefined;
        const data = await getTaxReport(fy, effectivePortfolioId);
        setReport(data);
      }
    } catch (e) {
      setError(e.message || 'Failed to load tax report');
      setReport(null);
    } finally {
      setLoading(false);
    }
    // Auto-compute tax after report generation.
    await refreshTaxComputation();
  };

  const summary = report?.summary || {};
  const cgView = useMemo(() => buildCgView(report?.capital_gains), [report]);
  const form67RowsWithIndianTax = useMemo(() => {
    const rows = report?.form_67 || [];
    if (!rows.length || !computation) return rows;

    const foreignDividendINR = rows.reduce((s, r) => s + (Number(r.gross_dividend_inr) || 0), 0);
    if (foreignDividendINR <= 0) {
      return rows.map((r) => ({ ...r, indian_tax_payable_normal_inr: 0 }));
    }

    const t = computation.tax || {};
    const taxableSlab = Number(computation.taxable_slab_income) || 0;
    const totalTaxableIncome = Number(computation.total_taxable_income) || 0;
    const specialTaxTotal = (Number(t.on_stcg_111a) || 0) + (Number(t.on_ltcg_112a) || 0) + (Number(t.on_ltcg_112) || 0);

    const reducedTaxableSlab = Math.max(0, taxableSlab - foreignDividendINR);
    const reducedTotalTaxableIncome = Math.max(0, totalTaxableIncome - foreignDividendINR);
    const reducedTaxOnSlab = computeSlabTaxLocal(reducedTaxableSlab);
    const reducedTotalBeforeSurcharge = reducedTaxOnSlab + specialTaxTotal;
    const reducedRebate87A = reducedTotalTaxableIncome <= 700000 ? Math.min(reducedTaxOnSlab, 25000) : 0;
    const reducedAfterRebate = Math.max(0, reducedTotalBeforeSurcharge - reducedRebate87A);
    const reducedSurcharge = computeSurchargeLocal(reducedTotalTaxableIncome, reducedAfterRebate);
    const reducedCess = Math.round((reducedAfterRebate + reducedSurcharge) * 0.04);
    const reducedTotalLiability = reducedAfterRebate + reducedSurcharge + reducedCess;

    const currentTotalLiability = Number(t.total_liability) || 0;
    const indianTaxOnForeignDividend = Math.max(0, currentTotalLiability - reducedTotalLiability);

    return rows.map((r) => {
      const rowShare = (Number(r.gross_dividend_inr) || 0) / foreignDividendINR;
      return {
        ...r,
        indian_tax_payable_normal_inr: round2(indianTaxOnForeignDividend * rowShare),
      };
    });
  }, [report, computation]);
  const form67NeedsSetup = !ais || !computation;
  const form67MissingSteps = [
    !ais ? 'Upload AIS' : null,
    !computation ? 'Generate Report' : null,
  ].filter(Boolean);
  const compactHeaderClass = 'd-flex align-items-center gap-2 mb-0 tax-subsection-header';
  const compactTitleClass = 'h6 fw-semibold mb-0';

  const refreshTaxComputation = async () => {
    try {
      const comp = await getTaxComputation(fy, portfolioId);
      setComputation(comp);
    } catch (e) {
      setComputation(null);
    } finally {
      setTaxRefreshNonce((n) => n + 1);
    }
  };

  // ── AIS & Other Income ──
  useEffect(() => {
    if (!fy || !hasSinglePortfolio) {
      setAis(null);
      setOtherIncome([]);
      return;
    }
    getAISData(fy, portfolioId).then(setAis).catch(() => setAis(null));
    getOtherIncome(fy, portfolioId).then(setOtherIncome).catch(() => setOtherIncome([]));
  }, [fy, hasSinglePortfolio, portfolioId]);

  const handleAISUpload = async (e) => {
    if (!hasSinglePortfolio) {
      setError('Select exactly one portfolio before uploading AIS.');
      e.target.value = '';
      return;
    }
    const file = e.target.files?.[0];
    if (!file) return;
    setAisLoading(true);
    try {
      const parsed = await uploadAIS(file, fy, portfolioId);
      setAis(parsed);
      const oi = await getOtherIncome(fy, portfolioId);
      setOtherIncome(oi);
      await refreshTaxComputation();
    } catch (err) {
      setError(err.message || 'AIS parse failed');
    } finally {
      setAisLoading(false);
      e.target.value = '';
    }
  };

  const handleAddOI = async (category) => {
    if (!hasSinglePortfolio) {
      setError('Select exactly one portfolio before editing tax data.');
      return;
    }
    const defaultNames = {
      SAVINGS_INTEREST: 'Bank', TD_INTEREST: 'Bank FD', NCD_INTEREST: 'NCD',
      PF_INTEREST: 'EPFO', CG_TRANSFER_EXPENSE: 'Wire transfer', OS_TRANSFER_EXPENSE: 'Remittance', OTHER: 'Other',
    };
    const row = await addOtherIncome({ fy, portfolio_id: portfolioId, category, source_name: defaultNames[category] || 'Other', amount: 0, tds: 0 });
    setOtherIncome((prev) => [...prev, row]);
    await refreshTaxComputation();
  };
  const handleUpdateOI = async (id, field, value) => {
    const row = otherIncome.find((r) => r.id === id);
    if (!row) return;
    await updateOtherIncome(id, { ...row, [field]: value });
    setOtherIncome((prev) => prev.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
    await refreshTaxComputation();
  };
  const handleDeleteOI = async (id) => {
    await deleteOtherIncome(id);
    setOtherIncome((prev) => prev.filter((r) => r.id !== id));
    await refreshTaxComputation();
  };

  return (
    <div className="d-flex flex-column gap-3 tax-modern-page">
      <Card className="shadow-sm">
        <Card.Body>
          <div className="d-flex flex-wrap align-items-end gap-2">
            <div>
              <div className="small text-muted">Financial Year</div>
              <Form.Select size="sm" value={fy} onChange={(e) => setFy(e.target.value)}>
                {options.map((o) => <option key={o} value={o}>{o}</option>)}
              </Form.Select>
            </div>
            <Button size="sm" onClick={load} disabled={loading || !hasSinglePortfolio}>
              {loading ? <Spinner animation="border" size="sm" /> : 'Generate Report'}
            </Button>
            {ais ? (
              <span className="d-flex align-items-center gap-1">
                <Badge bg="success">AIS ✓</Badge>
                <label className="btn btn-sm btn-link text-muted p-0 mb-0 tax-summary-label" style={{ cursor: 'pointer' }}>
                  {aisLoading ? <Spinner animation="border" size="sm" /> : 'change'}
                  <input type="file" accept=".pdf" hidden onChange={handleAISUpload} />
                </label>
              </span>
            ) : (
              <label className="btn btn-sm btn-outline-secondary mb-0">
                {aisLoading ? <Spinner animation="border" size="sm" /> : 'Upload AIS'}
                <input type="file" accept=".pdf" hidden onChange={handleAISUpload} />
              </label>
            )}
          </div>
          {!hasSinglePortfolio && (
            <div className="text-danger small mt-2">
              Select exactly one portfolio to compute tax. Current selection must not be All or multiple portfolios.
            </div>
          )}
          {error && <div className="text-danger small mt-2">{error}</div>}
        </Card.Body>
      </Card>

      {report && (
        <>
          <Row className="g-3">
            {computation ? (
              <>
                <Col xs={6} md={2}><SummaryCard label="Net Salary" value={formatINR(computation.heads?.salary?.net || 0)} /></Col>
                <Col xs={6} md={2}><SummaryCard label="STCG (111A + Slab)" value={formatINR((computation.heads?.capital_gains?.stcg_111a || 0) + (computation.heads?.capital_gains?.stcg_slab || 0))} color={profitColor((computation.heads?.capital_gains?.stcg_111a || 0) + (computation.heads?.capital_gains?.stcg_slab || 0))} /></Col>
                <Col xs={6} md={2}><SummaryCard label="LTCG 112A (Equity)" value={formatINR(computation.heads?.capital_gains?.ltcg_112a_taxable || 0)} color={profitColor(computation.heads?.capital_gains?.ltcg_112a_taxable)} sub={`Gross ${formatINR(computation.heads?.capital_gains?.ltcg_112a_gross || 0)}`} /></Col>
                <Col xs={6} md={2}><SummaryCard label="LTCG 112 (Foreign)" value={formatINR((computation.heads?.capital_gains?.ltcg_112_adjusted ?? computation.heads?.capital_gains?.ltcg_112) || 0)} color={profitColor(computation.heads?.capital_gains?.ltcg_112 || 0)} /></Col>
                <Col xs={6} md={2}><SummaryCard label="Other Sources" value={formatINR(computation.heads?.other_sources?.total || 0)} /></Col>
                <Col xs={6} md={2}><SummaryCard label="Tax Liability" value={formatINR(computation.tax?.total_liability || 0)} color="text-danger" /></Col>
              </>
            ) : (
              <>
                <Col xs={6} md={2}><SummaryCard label="Perquisite (Sch 1)" value={formatINR(summary.total_perquisite_inr || 0)} /></Col>
                <Col xs={6} md={2}><SummaryCard label="STCG 111A (Equity)" value={formatINR(cgView.summary.stcg111a)} color={profitColor(cgView.summary.stcg111a)} /></Col>
                <Col xs={6} md={2}><SummaryCard label="LTCG 112A taxable" value={formatINR(cgView.summary.ltcg112aTaxable)} color={profitColor(cgView.summary.ltcg112aTaxable)} sub={`Gross ${formatINR(cgView.summary.ltcg112aGross)} · exempt ${formatINR(cgView.summary.ltcg112aExemption)}`} /></Col>
                <Col xs={6} md={2}><SummaryCard label="LTCG 112 (Foreign)" value={formatINR(cgView.summary.ltcg112)} color={profitColor(cgView.summary.ltcg112)} /></Col>
                <Col xs={6} md={2}><SummaryCard label="STCG Slab" value={formatINR(cgView.summary.stcgSlab)} color={profitColor(cgView.summary.stcgSlab)} /></Col>
                <Col xs={6} md={2}><SummaryCard label="Dividend (Sch OS)" value={formatINR(summary.total_dividend_inr || 0)} /></Col>
              </>
            )}
          </Row>

          <Accordion alwaysOpen className="shadow-sm">
            {(hasAisPropertySale || hasLegacyPropertyUnknown) && (
              <Accordion.Item eventKey="0">
                <Accordion.Header>Property Capital Gains</Accordion.Header>
                <Accordion.Body>
                  <PropertyCapitalGains
                    fy={fy}
                    portfolioId={portfolioId}
                    ais={ais}
                    showHeader={false}
                    propertySignalUnknown={hasLegacyPropertyUnknown && !hasAisPropertySale}
                    ltcg112={(computation?.heads?.capital_gains?.ltcg_112_after_transfer ?? computation?.heads?.capital_gains?.ltcg_112 ?? cgView.summary.ltcg112) || 0}
                    onSaved={load}
                  />
                </Accordion.Body>
              </Accordion.Item>
            )}

            <Accordion.Item eventKey="1">
              <Accordion.Header>Schedule 1: Salary & Perquisite Income ({report.perquisite_income.length} vests{ais?.salary?.length ? ` · Gross ${formatINR(ais.salary.reduce((s, e) => s + (e.gross || 0), 0))}` : ''})</Accordion.Header>
              <Accordion.Body>
                {ais?.salary?.length > 0 && (
                  <div className="mb-3">
                    <div className="fw-semibold small mb-1">Salary (from AIS)</div>
                    <Table size="sm" className="small">
                      <thead className="table-light">
                        <tr><th>Employer</th><th className="text-end">17(1)</th><th className="text-end">17(2)</th><th className="text-end">Gross</th><th className="text-end">TDS</th></tr>
                      </thead>
                      <tbody>
                        {ais.salary.map((s, i) => (
                          <tr key={i}>
                            <td>{s.source}</td>
                            <td className="text-end">{formatINR(s.s17_1 || 0)}</td>
                            <td className="text-end">{formatINR(s.s17_2 || 0)}</td>
                            <td className="text-end fw-semibold">{formatINR(s.gross || 0)}</td>
                            <td className="text-end">{formatINR(s.tds_total || 0)}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot className="table-light fw-semibold">
                        <tr>
                          <td>Total</td>
                          <td className="text-end">{formatINR(ais.salary.reduce((s, e) => s + (e.s17_1 || 0), 0))}</td>
                          <td className="text-end">{formatINR(ais.salary.reduce((s, e) => s + (e.s17_2 || 0), 0))}</td>
                          <td className="text-end">{formatINR(ais.salary.reduce((s, e) => s + (e.gross || 0), 0))}</td>
                          <td className="text-end">{formatINR(ais.salary.reduce((s, e) => s + (e.tds_total || 0), 0))}</td>
                        </tr>
                      </tfoot>
                    </Table>
                  </div>
                )}
                <SubSectionShell accent="info">
                  <CollapsibleSectionHeader
                    expanded={perquisiteExpanded}
                    onToggle={() => setPerquisiteExpanded((v) => !v)}
                    title="Foreign Equity Perquisites (RSU/ESPP detail)"
                    className={compactHeaderClass}
                    titleClassName={compactTitleClass}
                    summary={`${report.perquisite_income.length} entries · Total ${formatINR(summary.total_perquisite_inr || 0)}`}
                    right={perquisiteExpanded ? (
                      <Button size="sm" variant="outline-secondary" onClick={(e) => { e.stopPropagation(); downloadCSV(`perquisite_${fy}.csv`, report.perquisite_income); }}>
                        <Download size={14} className="me-1" /> Export CSV
                      </Button>
                    ) : null}
                  />
                  {perquisiteExpanded && (
                  <div className="table-responsive">
                    <Table size="sm" hover>
                      <thead><tr><th>Date</th><th>Type</th><th>Investment</th><th>Units</th><th>FMV USD</th><th>Rate</th><th>Perquisite INR</th></tr></thead>
                      <tbody>
                        {report.perquisite_income.map((r, idx) => (
                          <tr key={idx}>
                            <td>{formatDate(r.date)}</td>
                            <td>{r.type}</td>
                            <td>{r.investment}</td>
                            <td>{formatNumber(r.units || 0, 4)}</td>
                            <td>{r.fmv_per_share_usd != null ? `$${formatNumber(r.fmv_per_share_usd, 2)}` : '-'}</td>
                            <td>{r.exchange_rate || '-'}</td>
                            <td>{formatINR(r.perquisite_inr || 0)}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot className="table-light fw-semibold">
                        <tr>
                          <td colSpan={6}>Total</td>
                          <td>{formatINR(summary.total_perquisite_inr || 0)}</td>
                        </tr>
                      </tfoot>
                    </Table>
                  </div>
                  )}
                </SubSectionShell>
              </Accordion.Body>
            </Accordion.Item>

            <Accordion.Item eventKey="2">
              <Accordion.Header>Schedule CG: Capital Gains ({report.capital_gains.length} lots across {cgView.sections.filter((s) => s.rows.length).length} categories)</Accordion.Header>
              <Accordion.Body>
                <div className="d-flex justify-content-end mb-2">
                  <Button size="sm" variant="outline-secondary" onClick={() => downloadCSV(`capital_gains_${fy}.csv`, buildCapitalGainsExportRows(report.capital_gains))}>
                    <Download size={14} className="me-1" /> Export All CSV
                  </Button>
                </div>
                {cgView.sections.map((sec) => (
                  <SubSectionShell key={sec.key} accent="secondary" className="mb-2">
                    <CGSection section={sec} fy={fy} />
                  </SubSectionShell>
                ))}
                {/* Transfer expense for foreign CG */}
                <TransferExpenseInput
                  label="Cost of Transfer — Wire/Remittance Charges (Section 48)"
                  category="CG_TRANSFER_EXPENSE"
                  rows={otherIncome}
                  fy={fy}
                  portfolioId={portfolioId}
                  onAdd={handleAddOI}
                  onUpdate={handleUpdateOI}
                  onDelete={handleDeleteOI}
                />
                <SubSectionShell accent="secondary" className="mt-3">
                  <CollapsibleSectionHeader
                    expanded={cgQuarterExpanded}
                    onToggle={() => setCgQuarterExpanded((v) => !v)}
                    title="Quarter-wise breakup (for Section 234C)"
                    className={compactHeaderClass}
                    titleClassName={compactTitleClass}
                  />
                  {cgQuarterExpanded && (
                  <div className="table-responsive mt-2">
                    <Table size="sm" bordered className="small">
                      <thead className="table-light">
                        <tr>
                          <th>Quarter</th>
                          {CG_SECTIONS.map((d) => <th key={d.key} className="text-end">{d.key}</th>)}
                          <th className="text-end">Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {cgView.quarterlyITR.map((q) => (
                          <tr key={q.quarter}>
                            <td className="text-nowrap">{q.quarter} · {q.label}</td>
                            {CG_SECTIONS.map((d) => (
                              <td key={d.key} className={`text-end ${profitColor(q[d.key])}`}>{formatINR(q[d.key])}</td>
                            ))}
                            <td className={`text-end fw-semibold ${profitColor(q.total)}`}>{formatINR(q.total)}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot className="table-light fw-semibold">
                        <tr>
                          <td>Annual Total</td>
                          {CG_SECTIONS.map((d) => {
                            const colTotal = cgView.quarterlyITR.reduce((s, q) => s + (q[d.key] || 0), 0);
                            return <td key={d.key} className={`text-end ${profitColor(colTotal)}`}>{formatINR(colTotal)}</td>;
                          })}
                          <td className={`text-end ${profitColor(cgView.quarterlyITR.reduce((s, q) => s + (q.total || 0), 0))}`}>
                            {formatINR(cgView.quarterlyITR.reduce((s, q) => s + (q.total || 0), 0))}
                          </td>
                        </tr>
                      </tfoot>
                    </Table>
                  </div>
                  )}
                </SubSectionShell>
              </Accordion.Body>
            </Accordion.Item>

            <Accordion.Item eventKey="3">
              <Accordion.Header>Schedule OS: Other Sources (Dividends {report.dividend_income.length} + Interest {otherIncome.length} entries)</Accordion.Header>
              <Accordion.Body>
                {/* Dividends */}
                <SubSectionShell accent="primary">
                  <CollapsibleSectionHeader
                    expanded={dividendExpanded}
                    onToggle={() => setDividendExpanded((v) => !v)}
                    title="Dividend Income"
                    className={compactHeaderClass}
                    titleClassName={compactTitleClass}
                    summary={`${report.dividend_income.length} entries · Total ${formatINR(summary.total_dividend_inr || 0)}`}
                    right={dividendExpanded ? (
                      <Button size="sm" variant="outline-secondary" onClick={(e) => { e.stopPropagation(); downloadCSV(`dividend_${fy}.csv`, report.dividend_income); }}>
                        <Download size={14} className="me-1" /> Export CSV
                      </Button>
                    ) : null}
                  />
                  {dividendExpanded && (
                  <div className="table-responsive mb-1">
                    <Table size="sm" hover>
                      <thead><tr><th>Date</th><th>Investment</th><th>USD</th><th>Rate</th><th>INR</th></tr></thead>
                      <tbody>
                        {report.dividend_income.map((r, idx) => (
                          <tr key={idx}>
                            <td>{formatDate(r.date)}</td>
                            <td>{r.investment}</td>
                            <td>{r.usd_amount != null ? `$${formatNumber(r.usd_amount, 2)}` : '-'}</td>
                            <td>{r.exchange_rate || '-'}</td>
                            <td>{formatINR(r.amount_inr || 0)}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot className="table-light fw-semibold">
                        <tr><td colSpan={4}>Total Dividends</td><td>{formatINR(summary.total_dividend_inr || 0)}</td></tr>
                      </tfoot>
                    </Table>
                  </div>
                  )}
                </SubSectionShell>

                {report.dividend_quarterly && (
                  <SubSectionShell accent="secondary">
                    <CollapsibleSectionHeader
                      expanded={divQuarterExpanded}
                      onToggle={() => setDivQuarterExpanded((v) => !v)}
                      title="Dividend quarter-wise breakup"
                      className={compactHeaderClass}
                      titleClassName={compactTitleClass}
                    />
                    {divQuarterExpanded && (
                    <div className="table-responsive mt-2 mb-3">
                      <Table size="sm" bordered className="small">
                        <thead className="table-light">
                          <tr><th>Quarter</th><th className="text-end">Indian</th><th className="text-end">Foreign</th><th className="text-end">Total</th></tr>
                        </thead>
                        <tbody>
                          {report.dividend_quarterly.map((q) => (
                            <tr key={q.quarter}>
                              <td className="text-nowrap">{q.quarter} · {q.label}</td>
                              <td className="text-end">{formatINR(q.indian)}</td>
                              <td className="text-end">{formatINR(q.foreign)}</td>
                              <td className="text-end fw-semibold">{formatINR(q.total)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </Table>
                    </div>
                    )}
                  </SubSectionShell>
                )}

                {/* Interest & Other */}
                <TransferExpenseInput
                  label="Deduction u/s 57 — Dividend Remittance Charges"
                  category="OS_TRANSFER_EXPENSE"
                  rows={otherIncome}
                  fy={fy}
                  portfolioId={portfolioId}
                  onAdd={handleAddOI}
                  onUpdate={handleUpdateOI}
                  onDelete={handleDeleteOI}
                />
                <SubSectionShell accent="warning">
                  <CollapsibleSectionHeader
                    expanded={interestExpanded}
                    onToggle={() => setInterestExpanded((v) => !v)}
                    title="Interest & Other Income"
                    className={compactHeaderClass}
                    titleClassName={compactTitleClass}
                    summary={`${otherIncome.length} entries · Total ${formatINR(otherIncome.reduce((s, r) => s + (r.amount || 0), 0))}`}
                  />
                  {interestExpanded && (
                    <div className="mt-2">
                      <OtherIncomeEditor rows={otherIncome} onAdd={handleAddOI} onUpdate={handleUpdateOI} onDelete={handleDeleteOI} />
                    </div>
                  )}
                </SubSectionShell>

                {/* Schedule OS Total */}
                <div className="mt-3 p-2 bg-light border rounded d-flex justify-content-between fw-bold">
                  <span>Total Schedule OS (Other Sources)</span>
                  <span>{formatINR((summary.total_dividend_inr || 0) + otherIncome.reduce((s, r) => s + (r.amount || 0), 0))}</span>
                </div>
              </Accordion.Body>
            </Accordion.Item>

            <Accordion.Item eventKey="4">
              <Accordion.Header>Form 67: Foreign Tax Credit ({report.form_67.length} dividends · FTC {formatINR(summary.total_ftc_inr || 0)})</Accordion.Header>
              <Accordion.Body>
                <SubSectionShell accent="info">
                  {form67NeedsSetup && (
                    <div className="alert alert-warning small py-2 mb-2" role="alert">
                      <strong>Tip:</strong> For complete Form-67 fields (including tax payable on such income under normal provisions in India),
                      please finish: {form67MissingSteps.join(' and ')}.
                    </div>
                  )}
                  <div className="d-flex align-items-center justify-content-between mb-2">
                    <div className="h6 fw-semibold mb-0">FTC Detail <span className="text-muted small fw-normal">{report.form_67.length} entries · Tax withheld {formatINR(summary.total_ftc_inr || 0)}</span></div>
                    <Button size="sm" variant="outline-secondary" onClick={() => downloadCSV(`form67_${fy}.csv`, report.form_67)}>
                      <Download size={14} className="me-1" /> Export CSV
                    </Button>
                  </div>
                  <div className="table-responsive mt-2">
                    <Table size="sm" hover>
                    <thead><tr><th>Date</th><th>Investment</th><th>Country</th><th>Gross USD</th><th>Tax USD</th><th>Net USD</th><th>Rate</th><th>Gross INR</th><th>Tax Withheld INR</th><th>Net INR</th></tr></thead>
                    <tbody>
                      {form67RowsWithIndianTax.map((r, idx) => (
                        <tr key={idx}>
                          <td>{formatDate(r.date)}</td>
                          <td>{r.investment}</td>
                          <td>{r.country_code}</td>
                          <td>${formatNumber(r.gross_dividend_usd, 2)}</td>
                          <td>${formatNumber(r.tax_withheld_usd, 2)}</td>
                          <td>${formatNumber(r.net_dividend_usd, 2)}</td>
                          <td>{r.exchange_rate || '-'}</td>
                          <td>{formatINR(r.gross_dividend_inr)}</td>
                          <td>{formatINR(r.tax_withheld_inr)}</td>
                          <td>{formatINR(r.net_dividend_inr)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="table-light fw-semibold">
                      <tr>
                        <td colSpan={7}>Total</td>
                        <td>{formatINR(form67RowsWithIndianTax.reduce((s, r) => s + (r.gross_dividend_inr || 0), 0))}</td>
                        <td>{formatINR(form67RowsWithIndianTax.reduce((s, r) => s + (r.tax_withheld_inr || 0), 0))}</td>
                        <td>{formatINR(form67RowsWithIndianTax.reduce((s, r) => s + (r.net_dividend_inr || 0), 0))}</td>
                      </tr>
                    </tfoot>
                    </Table>
                  </div>
                  <div className="mt-2 p-2 bg-light border rounded d-flex justify-content-between small">
                    <span className="fw-semibold">Tax payable on such income under normal provisions in India</span>
                    <span className="fw-bold">{formatINR(form67RowsWithIndianTax.reduce((s, r) => s + (r.indian_tax_payable_normal_inr || 0), 0))}</span>
                  </div>
                  <div className="small text-muted mt-2">US federal withholding at 25%. Gross = Net ÷ 0.75. Tax payable in India is computed using a tax-delta method from current computation (with vs without foreign dividend income). File Form 67 before the due date to claim FTC under Section 90/91.</div>
                </SubSectionShell>
              </Accordion.Body>
            </Accordion.Item>

            <Accordion.Item eventKey="5">
              <Accordion.Header>Schedule FA: Foreign Asset Disclosure ({report.schedule_fa.length})</Accordion.Header>
              <Accordion.Body>
                <SubSectionShell accent="secondary">
                  <div className="d-flex align-items-center justify-content-between mb-2">
                    <div className="h6 fw-semibold mb-0">Foreign Assets <span className="text-muted small fw-normal">{report.schedule_fa.length} holdings</span></div>
                    <Button size="sm" variant="outline-secondary" onClick={() => downloadCSV(`schedule_fa_${fy}.csv`, report.schedule_fa)}>
                      <Download size={14} className="me-1" /> Export CSV
                    </Button>
                  </div>
                  <div className="table-responsive">
                    <Table size="sm" hover>
                    <thead><tr><th>Investment</th><th>Ticker</th><th>Units Held</th><th>Acq Cost USD</th><th>Acq Cost INR</th><th>Year-End Value INR</th><th>Peak Value INR</th></tr></thead>
                    <tbody>
                      {report.schedule_fa.map((r, idx) => (
                        <tr key={idx}>
                          <td>{r.investment}</td>
                          <td>{r.ticker || '-'}</td>
                          <td>{formatNumber(r.units_held || 0, 4)}</td>
                          <td>${formatNumber(r.acquisition_cost_usd || 0, 2)}</td>
                          <td>{formatINR(r.acquisition_cost_inr || 0)}</td>
                          <td>{r.year_end_value_inr != null ? formatINR(r.year_end_value_inr) : '-'}</td>
                          <td>{r.peak_value_inr != null ? formatINR(r.peak_value_inr) : '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                    </Table>
                  </div>
                </SubSectionShell>
              </Accordion.Body>
            </Accordion.Item>

            <TaxComputation
              fy={fy}
              portfolioId={portfolioId}
              refreshNonce={taxRefreshNonce}
              onRecomputed={refreshTaxComputation}
            />
          </Accordion>

          <div className="small text-muted">{summary.tax_note}</div>
        </>
      )}
    </div>
  );
}

function SummaryCard({ label, value, color = '', sub = '' }) {
  return (
    <Card className="shadow-sm h-100">
      <Card.Body className="py-3">
        <div className="tax-summary-label">{label}</div>
        <div className={`fs-6 fw-bold ${color}`}>{value}</div>
        {sub ? <div className="tax-summary-sub">{sub}</div> : null}
      </Card.Body>
    </Card>
  );
}

function SubSectionShell({ children, accent = 'primary', className = '' }) {
  return (
    <div
      className={`tax-subsection ${className}`.trim()}
      style={{ borderLeft: `4px solid var(--bs-${accent})` }}
    >
      {children}
    </div>
  );
}

function subtotalOf(rows) {
  return {
    count: (rows || []).length,
    cost: sumField(rows, 'cost_inr'),
    proceeds: sumField(rows, 'sale_proceeds_inr'),
    expenditure: sumField(rows, 'transfer_expense_inr'),
    stt: sumField(rows, 'stt_inr'),
    gain: sumField(rows, 'gain_loss_inr'),
  };
}

// Sub-groups within the equity sections (111A / 112A).
const EQUITY_SUBGROUPS = [
  { key: 'SHARES', label: 'Shares & ETFs', match: (r) => r.asset_type === 'INDIAN_STOCK' },
  { key: 'MF', label: 'Mutual Funds', match: (r) => r.asset_type === 'MUTUAL_FUND' },
];

function CgDataRow({ r, showLot }) {
  return (
    <tr>
      <td>{r.investment}</td>
      <td className="tax-cell-meta">{r.isin || '-'}</td>
      <td><Badge bg={r.asset_class === 'Equity' ? 'primary' : r.asset_class === 'Foreign' ? 'info' : 'secondary'}>{r.asset_class}</Badge></td>
      {showLot && <td>{r.lot_type}</td>}
      <td className="text-nowrap">{formatDate(r.acquisition_date)}</td>
      <td className="text-nowrap">{formatDate(r.sale_date)}</td>
      <td className="text-end">{formatNumber(r.units_sold || 0, 4)}</td>
      <td className="text-end">{formatINR(r.cost_inr || 0)}</td>
      <td className="text-end">{formatINR(r.sale_proceeds_inr || 0)}</td>
      <td className="text-end">{formatINR(r.transfer_expense_inr || 0)}</td>
      <td className="text-end text-muted">{formatINR(r.stt_inr || 0)}</td>
      <td className={`text-end ${profitColor(r.gain_loss_inr || 0)}`}>{formatINR(r.gain_loss_inr || 0)}</td>
      <td><Badge bg={r.gain_type === 'LTCG' ? 'success' : 'warning'}>{r.gain_type}</Badge></td>
    </tr>
  );
}

function CgTotalRow({ label, st, leadCols, strong = false }) {
  return (
    <tr className={strong ? 'fw-bold table-active' : 'fw-semibold table-light'}>
      <td colSpan={leadCols}>{label}{st.count != null ? ` (${st.count})` : ''}</td>
      <td className="text-end">{formatINR(st.cost)}</td>
      <td className="text-end">{formatINR(st.proceeds)}</td>
      <td className="text-end">{formatINR(st.expenditure)}</td>
      <td className="text-end text-muted">{formatINR(st.stt)}</td>
      <td className={`text-end ${profitColor(st.gain)}`}>{formatINR(st.gain)}</td>
      <td />
    </tr>
  );
}

function CGSection({ section, fy }) {
  const [expanded, setExpanded] = useState(false);
  const hasRows = section.rows.length > 0;
  const isEquity = section.key === '111A' || section.key === '112A';
  const showLot = !isEquity; // Lot (VEST/ESPP/BUY) is only meaningful for foreign/other lots
  const leadCols = showLot ? 7 : 6; // columns before the Cost column
  const totalColumns = leadCols + 6; // Cost, Proceeds, Expenditure, STT, Gain/Loss, Term

  const groups = isEquity
    ? EQUITY_SUBGROUPS
      .map((g) => ({ label: g.label, rows: section.rows.filter(g.match) }))
      .filter((g) => g.rows.length)
    : [{ label: null, rows: section.rows }];

  return (
    <div className="mb-0">
      <CollapsibleSectionHeader
        expanded={expanded}
        onToggle={() => setExpanded((v) => !v)}
        title={section.title}
        className="d-flex align-items-center gap-2 mb-0 tax-subsection-header"
        titleClassName="h6 fw-semibold mb-0"
        summary={hasRows ? `${section.rows.length} lots · Gain/Loss ${formatINR(section.subtotal.gain)}` : 'No disposals'}
        right={expanded && hasRows ? (
          <Button size="sm" variant="outline-secondary" onClick={(e) => { e.stopPropagation(); downloadCSV(`cg_${section.key}_${fy}.csv`, buildCapitalGainsExportRows(section.rows)); }}>
            <Download size={14} className="me-1" /> CSV
          </Button>
        ) : null}
      />
      {!hasRows ? null : expanded ? (
        <div className="table-responsive">
          <Table size="sm" hover className="small">
            <thead className="table-light">
              <tr>
                <th>Investment</th>
                <th>ISIN</th>
                <th>Class</th>
                {showLot && <th>Lot</th>}
                <th>Acq Date</th>
                <th>Sale Date</th>
                <th className="text-end">Units</th>
                <th className="text-end">Cost ₹</th>
                <th className="text-end">Proceeds ₹</th>
                <th className="text-end">Expenditure ₹</th>
                <th className="text-end">STT ₹</th>
                <th className="text-end">Gain/Loss ₹</th>
                <th>Term</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g, gi) => (
                <React.Fragment key={gi}>
                  {g.label && (
                    <tr className="table-secondary">
                      <td colSpan={totalColumns} className="fw-semibold">{g.label}</td>
                    </tr>
                  )}
                  {g.rows.map((r, idx) => <CgDataRow key={idx} r={r} showLot={showLot} />)}
                  {isEquity && <CgTotalRow label={`Subtotal — ${g.label}`} st={subtotalOf(g.rows)} leadCols={leadCols} />}
                </React.Fragment>
              ))}
            </tbody>
            <tfoot>
              <CgTotalRow label="Total" st={section.subtotal} leadCols={leadCols} strong />
            </tfoot>
          </Table>
        </div>
      ) : null}
    </div>
  );
}

// ── Inline transfer expense input (for CG Section 48 and OS Section 57) ──
function TransferExpenseInput({ label, category, rows, fy, portfolioId, onAdd, onUpdate, onDelete }) {
  const existing = rows.find((r) => r.category === category);
  const [localVal, setLocalVal] = useState('');
  const [editing, setEditing] = useState(false);

  return (
    <div className="my-2 p-2 border rounded bg-light">
      <div className="d-flex align-items-center justify-content-between">
        <span className="small fw-semibold">{label}</span>
        {!existing ? (
          <span className="d-flex align-items-center gap-2">
            <span className="small text-muted">Not set</span>
            <Button size="sm" variant="outline-primary" className="py-0 px-2" onClick={() => onAdd(category)}>Set</Button>
          </span>
        ) : (
          <span className="d-flex align-items-center gap-2">
            <Form.Control size="sm" type="number"
              value={editing ? localVal : (existing.amount || '')}
              style={{ width: 130 }}
              onFocus={() => { setLocalVal(String(existing.amount || '')); setEditing(true); }}
              onChange={(e) => setLocalVal(e.target.value)}
              onBlur={() => { onUpdate(existing.id, 'amount', Number(localVal) || 0); setEditing(false); }} />
            <span className="small text-muted">= {formatINR(existing.amount || 0)}</span>
            <Button size="sm" variant="link" className="text-danger p-0" onClick={() => onDelete(existing.id)}>
              <Trash2 size={14} />
            </Button>
          </span>
        )}
      </div>
    </div>
  );
}

// ── Inline Other Income Editor for unified Schedule OS ──
const OI_CATEGORIES = [
  { key: 'SAVINGS_INTEREST', label: 'Savings Bank Interest', showTDS: false },
  { key: 'TD_INTEREST', label: 'Term Deposit Interest', showTDS: false },
  { key: 'NCD_INTEREST', label: 'Interest on Securities (NCD/Bond)', showTDS: true },
  { key: 'PF_INTEREST', label: 'PF Interest (EE > ₹2.5L)', showTDS: true },
  { key: 'OTHER', label: 'Other Income', showTDS: true },
];

function OtherIncomeEditor({ rows, onAdd, onUpdate, onDelete }) {
  return (
    <div>
      {OI_CATEGORIES.map(({ key, label, showTDS }) => {
        const catRows = rows.filter((r) => r.category === key);
        const total = catRows.reduce((s, r) => s + (r.amount || 0), 0);
        const totalTDS = showTDS ? catRows.reduce((s, r) => s + (r.tds || 0), 0) : 0;
        return (
          <div key={key} className="mb-3">
            <div className="d-flex align-items-center justify-content-between mb-1">
              <span className="fw-semibold small">{label}</span>
              <Button size="sm" variant="outline-primary" className="py-0 px-1" onClick={() => onAdd(key)}>
                <Plus size={14} /> Add
              </Button>
            </div>
            {catRows.length > 0 && (
              <Table size="sm" className="small mb-0">
                <thead className="table-light">
                  <tr><th>Source</th><th style={{ width: 130 }}>Amount</th>{showTDS && <th style={{ width: 100 }}>TDS</th>}<th style={{ width: 36 }}></th></tr>
                </thead>
                <tbody>
                  {catRows.map((r) => <OIRow key={r.id} row={r} showTDS={showTDS} onUpdate={onUpdate} onDelete={onDelete} />)}
                </tbody>
                <tfoot className="table-light fw-semibold">
                  <tr><td>Total</td><td>{formatINR(total)}</td>{showTDS && <td>{formatINR(totalTDS)}</td>}<td></td></tr>
                </tfoot>
              </Table>
            )}
            {catRows.length === 0 && <div className="text-muted small">No entries</div>}
          </div>
        );
      })}
    </div>
  );
}

function OIRow({ row, showTDS, onUpdate, onDelete }) {
  const [amt, setAmt] = useState(String(row.amount || ''));
  const [tds, setTds] = useState(String(row.tds || ''));

  return (
    <tr>
      <td className="text-muted">{row.source_name || '—'}</td>
      <td>
        <Form.Control size="sm" type="number" value={amt}
          onChange={(e) => setAmt(e.target.value)}
          onBlur={() => onUpdate(row.id, 'amount', Number(amt) || 0)} />
      </td>
      {showTDS && (
        <td>
          <Form.Control size="sm" type="number" value={tds}
            onChange={(e) => setTds(e.target.value)}
            onBlur={() => onUpdate(row.id, 'tds', Number(tds) || 0)} />
        </td>
      )}
      <td><Button size="sm" variant="link" className="text-danger p-0" onClick={() => onDelete(row.id)}><Trash2 size={14} /></Button></td>
    </tr>
  );
}
