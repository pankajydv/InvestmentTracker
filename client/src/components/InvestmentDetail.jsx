import React, { useEffect, useState, useCallback } from 'react';
import { useParams, Link, useNavigate, useLocation } from 'react-router-dom';
import { Card, Row, Col, Table, Button, Form, Spinner, Badge, Modal, Dropdown, Collapse } from 'react-bootstrap';
import { getInvestment, deleteInvestment, addTransaction, deleteTransaction, updateTransaction, previewInvestmentInterestUpdate, applyInvestmentInterestUpdate, getUSDINRRate, previewEsppContributionsFromPayslips, importEsppContributions, getInvestmentDailyValues } from '../services/api';
import { formatINR, formatNumber, formatPct, formatDate, profitColor, ASSET_TYPE_LABELS, ASSET_TYPE_FULL_NAMES } from '../utils/formatters';
import { parseSGBName, convertDateFormat, calculateCouponDates, getPaidCouponDates, calculateInterestPaid, calculateAccruedInterest, getLastCouponDate, getNextCouponDate } from '../utils/sgbCalculator';
import { ArrowLeft, Trash2, Plus, X, Settings, Pencil, Wallet, PiggyBank, BarChart3, TrendingUp, TrendingDown } from 'lucide-react';
import { usePortfolio } from '../context/PortfolioContext';

const UNIT_ADD_TYPES = ['BUY', 'IPO', 'BONUS', 'SPLIT', 'RIGHTS', 'TRANSFER_IN', 'SWITCH_IN', 'DEPOSIT', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'VEST', 'ESPP_PURCHASE'];
const UNIT_SUB_TYPES = ['SELL', 'REDEMPTION', 'TRANSFER_OUT', 'SWITCH_OUT', 'WITHDRAWAL', 'CONSOLIDATION', 'CHARGES', 'AMC'];
const EDITABLE_TYPES = ['BUY', 'SELL', 'IPO', 'AMC', 'DEPOSIT', 'WITHDRAWAL', 'TRANSFER_IN', 'TRANSFER_OUT', 'TRANSFER', 'SWITCH_IN', 'SWITCH_OUT', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'VEST', 'ESPP_PURCHASE', 'ESPP_CONTRIBUTION', 'DIVIDEND', 'BONUS', 'SPLIT', 'RIGHTS'];
const TYPE_LABELS = {
  DEPOSIT: 'Deposit',
  EMPLOYER_CONTRIBUTION: 'Employer',
  VOLUNTARY_CONTRIBUTION: 'Voluntary',
  ESPP_CONTRIBUTION: 'ESPP Deduction',
  ESPP_PURCHASE: 'ESPP Purchase',
  EPS_CONTRIBUTION: 'EPS',
  INTEREST: 'Interest',
  RECONCILE: 'Reconcile',
  WITHDRAWAL: 'Withdrawal'
};

const CASH_OUTFLOW_TYPES = new Set([
  'BUY', 'VEST', 'ESPP_CONTRIBUTION', 'DEPOSIT', 'IPO', 'TRANSFER_IN', 'SWITCH_IN', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'RIGHTS', 'CHARGES', 'AMC'
]);

const CASH_INFLOW_TYPES = new Set([
  'SELL', 'REDEMPTION', 'WITHDRAWAL', 'TRANSFER_OUT', 'SWITCH_OUT', 'DIVIDEND', 'INTEREST', 'RECONCILE', 'TDS'
]);

const INTERNAL_BALANCE_XIRR_ASSET_TYPES = new Set(['PF', 'PPF', 'SSY']);

function isInternalXirrCashflow(assetType, transactionType) {
  const normalizedAssetType = String(assetType || '').toUpperCase();
  const normalizedType = String(transactionType || '').toUpperCase();

  if (!INTERNAL_BALANCE_XIRR_ASSET_TYPES.has(normalizedAssetType)) {
    return false;
  }

  if (normalizedType === 'INTEREST' || normalizedType === 'TDS') {
    return true;
  }

  return normalizedType === 'RECONCILE';
}

function getTxnTypesForInvestment(investment) {
  if (!investment) return ['BUY', 'SELL', 'DIVIDEND'];

  const isPPFType = investment.asset_type === 'PPF' || investment.asset_type === 'SSY' || investment.asset_type === 'PF';
  const isBondType = investment.asset_type === 'BOND';
  const isSGBType = investment.asset_type === 'SGB';
  const isForeignUsdType = investment.asset_type === 'FOREIGN_STOCK' && investment.currency === 'USD';

  if (isPPFType) return ['DEPOSIT', 'WITHDRAWAL', 'INTEREST', 'RECONCILE'];
  if (isBondType || isSGBType) return ['BUY', 'SELL', 'INTEREST'];
  if (isForeignUsdType) return ['VEST', 'ESPP_CONTRIBUTION', 'ESPP_PURCHASE', 'BUY', 'SELL', 'DIVIDEND'];
  return ['BUY', 'SELL', 'DIVIDEND'];
}

function xnpv(rate, flows, baseDate) {
  const msPerDay = 24 * 60 * 60 * 1000;
  return flows.reduce((sum, flow) => {
    const years = (flow.date - baseDate) / msPerDay / 365;
    return sum + flow.amount / ((1 + rate) ** years);
  }, 0);
}

function calculateXirr(flows) {
  if (!Array.isArray(flows) || flows.length < 2) return null;

  let hasPositive = false;
  let hasNegative = false;
  for (const flow of flows) {
    if (flow.amount > 0) hasPositive = true;
    if (flow.amount < 0) hasNegative = true;
  }
  if (!hasPositive || !hasNegative) return null;

  const sortedFlows = [...flows].sort((a, b) => a.date - b.date);
  const baseDate = sortedFlows[0].date;

  let low = -0.9999;
  let high = 10;
  let fLow = xnpv(low, sortedFlows, baseDate);
  let fHigh = xnpv(high, sortedFlows, baseDate);

  // Expand the upper bound if needed to bracket the root.
  for (let i = 0; i < 25 && fLow * fHigh > 0; i += 1) {
    high *= 2;
    fHigh = xnpv(high, sortedFlows, baseDate);
  }

  if (fLow * fHigh > 0) return null;

  for (let i = 0; i < 100; i += 1) {
    const mid = (low + high) / 2;
    const fMid = xnpv(mid, sortedFlows, baseDate);

    if (Math.abs(fMid) < 1e-7) return mid;

    if (fLow * fMid < 0) {
      high = mid;
      fHigh = fMid;
    } else {
      low = mid;
      fLow = fMid;
    }
  }

  return (low + high) / 2;
}

export default function InvestmentDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { selectedId } = usePortfolio();
  const cameFrom = location.state?.from;
  const transactionsSearch = location.state?.transactionsSearch || '';
  const investmentsSearch = location.state?.investmentsSearch || '';
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [transactionsExpanded, setTransactionsExpanded] = useState(false);
  const [dailyValuesExpanded, setDailyValuesExpanded] = useState(false);
  const [dailyValuesLoading, setDailyValuesLoading] = useState(false);
  const [dailyValuesError, setDailyValuesError] = useState('');
  const [dailyValuesData, setDailyValuesData] = useState(null);
  const [dailyValuesShowMore, setDailyValuesShowMore] = useState(false);
  const [dailyValuesFilters, setDailyValuesFilters] = useState({
    from: '',
    to: '',
    page: 1,
    pageSize: 365,
  });
  const [showAddTxn, setShowAddTxn] = useState(false);
  const [selectedInterval, setSelectedInterval] = useState('1D');
  const [showCustomDatePicker, setShowCustomDatePicker] = useState(false);
  const [customFromDate, setCustomFromDate] = useState('');
  const [customToDate, setCustomToDate] = useState('');
  const [txnForm, setTxnForm] = useState({
    transaction_type: 'BUY',
    transaction_date: new Date().toISOString().split('T')[0],
    units: '',
    price_per_unit: '',
    amount: '',
    fees: '0',
    notes: '',
    exchange_rate_used: '',
    usd_amount: '',
    fmv_per_unit: '',
  });
  const [rateLoading, setRateLoading] = useState(false);

  const txnTypes = getTxnTypesForInvestment(data);

  useEffect(() => {
    if (!showAddTxn) return;
    if (!txnTypes.includes(txnForm.transaction_type)) {
      setTxnForm((prev) => ({ ...prev, transaction_type: txnTypes[0] }));
    }
  }, [showAddTxn, txnTypes, txnForm.transaction_type]);

  useEffect(() => { loadData(); }, [id, selectedId, selectedInterval]);

  // Auto-fetch RBI rate when date or type changes for USD investments
  const fetchRBIRate = useCallback(async (date) => {
    if (!data || data.currency !== 'USD') return;
    if (!date) return;
    try {
      setRateLoading(true);
      const result = await getUSDINRRate(date);
      setTxnForm(prev => ({ ...prev, exchange_rate_used: result.rate ? String(result.rate) : prev.exchange_rate_used }));
    } catch (_) { /* silently ignore */ } finally {
      setRateLoading(false);
    }
  }, [data]);

  useEffect(() => {
    if (showAddTxn && data?.asset_type === 'FOREIGN_STOCK' && data?.currency === 'USD' && txnForm.transaction_date) {
      fetchRBIRate(txnForm.transaction_date);
    }
  }, [showAddTxn, data, txnForm.transaction_date, fetchRBIRate]);

  const loadData = async () => {
    try {
      setLoading(true);
      const result = await getInvestment(id, selectedId, {
        interval: selectedInterval,
        customFromDate: selectedInterval === 'CUSTOM' ? customFromDate : undefined,
        customToDate: selectedInterval === 'CUSTOM' ? customToDate : undefined,
      });
      setData(result);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const loadDailyValuesData = useCallback(async (filters = null) => {
    const effectiveFilters = filters || dailyValuesFilters;
    try {
      setDailyValuesLoading(true);
      setDailyValuesError('');
      const result = await getInvestmentDailyValues(id, {
        from: effectiveFilters.from,
        to: effectiveFilters.to,
        page: effectiveFilters.page,
        pageSize: effectiveFilters.pageSize,
        portfolioId: selectedId,
      });
      setDailyValuesData(result);
    } catch (e) {
      setDailyValuesError(e.message || 'Failed to load daily values');
      setDailyValuesData(null);
    } finally {
      setDailyValuesLoading(false);
    }
  }, [id, selectedId, dailyValuesFilters]);

  useEffect(() => {
    if (!dailyValuesExpanded) return;
    loadDailyValuesData();
  }, [dailyValuesExpanded, loadDailyValuesData]);

  const handleDelete = async () => {
    if (!window.confirm('Delete this investment and all its data?')) return;
    await deleteInvestment(id);
    navigate(`/investments${investmentsSearch ? `?${investmentsSearch}` : ''}`);
  };

  const handleAddTransaction = async (e) => {
    e.preventDefault();
    try {
      let amount = parseFloat(txnForm.amount);
      // For USD investments: auto-compute INR amount from USD × rate if not set
      const rate = txnForm.exchange_rate_used ? parseFloat(txnForm.exchange_rate_used) : null;
      const usdUnits = txnForm.units ? parseFloat(txnForm.units) : null;
      const priceUSD = txnForm.price_per_unit ? parseFloat(txnForm.price_per_unit) : null;
      if (!amount && usdUnits && priceUSD && rate) {
        amount = usdUnits * priceUSD * rate;
      } else if (!amount && usdUnits && priceUSD) {
        amount = usdUnits * priceUSD;
      }

      await addTransaction({
        investment_id: parseInt(id),
        portfolio_id: selectedId || null,
        transaction_type: txnForm.transaction_type,
        transaction_date: txnForm.transaction_date,
        units: usdUnits,
        price_per_unit: priceUSD,
        amount,
        fees: parseFloat(txnForm.fees) || 0,
        notes: txnForm.notes || null,
        exchange_rate_used: rate,
        usd_amount: txnForm.usd_amount ? parseFloat(txnForm.usd_amount) : (usdUnits && priceUSD ? usdUnits * priceUSD : null),
        fmv_per_unit: txnForm.fmv_per_unit ? parseFloat(txnForm.fmv_per_unit) : null,
      });
      setShowAddTxn(false);
      setTxnForm({
        transaction_type: txnTypes[0], transaction_date: new Date().toISOString().split('T')[0],
        units: '', price_per_unit: '', amount: '', fees: '0', notes: '',
        exchange_rate_used: '', usd_amount: '', fmv_per_unit: '',
      });
      loadData();
    } catch (e) {
      alert('Error: ' + e.message);
    }
  };

  // Edit modal state
  const [editTxn, setEditTxn] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [saving, setSaving] = useState(false);

  // Folio filter state
  const [selectedFolio, setSelectedFolio] = useState('ALL');
  const [selectedGrants, setSelectedGrants] = useState([]);
  const [selectedTypes, setSelectedTypes] = useState([]);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [hideFutureVestings, setHideFutureVestings] = useState(false);

  // Delete confirmation modal state
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [deleteText, setDeleteText] = useState('');
  const [interestUpdating, setInterestUpdating] = useState(false);
  const [showInterestPreviewModal, setShowInterestPreviewModal] = useState(false);
  const [interestPreviewRows, setInterestPreviewRows] = useState([]);
  const [interestPreviewWindow, setInterestPreviewWindow] = useState(null);
  const [interestHiddenExistingCount, setInterestHiddenExistingCount] = useState(0);
  const [selectedInterestRows, setSelectedInterestRows] = useState({});
  const [showEsppModal, setShowEsppModal] = useState(false);
  const [esppPayslipFiles, setEsppPayslipFiles] = useState([]);
  const [esppContributionLoading, setEsppContributionLoading] = useState(false);
  const [esppContributionImporting, setEsppContributionImporting] = useState(false);
  const [esppContributionPreview, setEsppContributionPreview] = useState(null);
  const [esppContributionOverwrite, setEsppContributionOverwrite] = useState(false);
  const [esppContributionStatus, setEsppContributionStatus] = useState(null);

  const getChanges = () => {
    if (!editTxn) return [];
    const changes = [];
    if ((editForm.folio_number || '') !== (editTxn.folio_number || '')) changes.push('Folio');
    if (editForm.transaction_date !== editTxn.transaction_date) changes.push('Date');
    if (String(editForm.units || '') !== String(editTxn.units || '')) changes.push('Units');
    if (String(editForm.price_per_unit || '') !== String(editTxn.price_per_unit || '')) changes.push('Price/Unit');
    if (String(editForm.amount || '') !== String(editTxn.amount || '')) changes.push('Amount');
    if (String(editForm.fees || '') !== String(editTxn.fees || '')) changes.push('Charges');
    if ((editForm.broker || '') !== (editTxn.broker || '')) changes.push('Broker');
    if ((editForm.notes || '') !== (editTxn.notes || '')) changes.push('Notes');
    if (String(editForm.exchange_rate_used || '') !== String(editTxn.exchange_rate_used || '')) changes.push('Exchange Rate');
    if (String(editForm.fmv_per_unit || '') !== String(editTxn.fmv_per_unit || '')) changes.push('FMV/Unit');
    return changes;
  };
  const editChanges = getChanges();
  const hasChanges = editChanges.length > 0;

  const handleEditTxn = (txn) => {
    setEditTxn(txn);
    setEditForm({
      folio_number: txn.folio_number || '',
      transaction_date: txn.transaction_date,
      units: txn.units || '',
      price_per_unit: txn.price_per_unit || '',
      amount: txn.amount || '',
      fees: txn.fees || '',
      broker: txn.broker || '',
      notes: txn.notes || '',
      exchange_rate_used: txn.exchange_rate_used || '',
      fmv_per_unit: txn.fmv_per_unit || '',
    });
  };

  const handleEditSave = async () => {
    try {
      setSaving(true);
      await updateTransaction(editTxn.id, {
        folio_number: editForm.folio_number || null,
        transaction_date: editForm.transaction_date,
        units: editForm.units ? Number(editForm.units) : null,
        price_per_unit: editForm.price_per_unit ? Number(editForm.price_per_unit) : null,
        amount: Number(editForm.amount),
        fees: editForm.fees ? Number(editForm.fees) : 0,
        broker: editForm.broker || null,
        notes: editForm.notes || null,
        exchange_rate_used: editForm.exchange_rate_used ? Number(editForm.exchange_rate_used) : null,
        fmv_per_unit: editForm.fmv_per_unit ? Number(editForm.fmv_per_unit) : null,
      });
      setEditTxn(null);
      loadData();
    } catch (e) {
      alert('Failed to update: ' + e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteTxn = async (id) => {
    try {
      await deleteTransaction(id);
      setDeleteConfirm(null);
      loadData();
    } catch (e) {
      alert('Failed to delete: ' + e.message);
    }
  };

  const handleInterestUpdate = async () => {
    try {
      setInterestUpdating(true);
      const preview = await previewInvestmentInterestUpdate(id, {
        portfolio_id: selectedId || undefined,
      });

      const entries = preview.proposed_entries || [];
      // Show both INSERT (new) and UPDATE (changed amount/date) entries
      // Hide only unchanged entries that have no note attached.
      // Noise-tolerant rows stay visible so the user can see why they were ignored.
      const entriesToShow = entries.filter(e => e.action !== 'unchanged' || e.preview_note);
      const hiddenUnchangedCount = entries.length - entriesToShow.length;

      if (!entriesToShow.length) {
        alert('No missing or updated interest entries for the selected period.');
        return;
      }

      const initialSelection = {};
      entriesToShow.forEach((entry, idx) => { initialSelection[idx] = entry.action !== 'unchanged'; });

      setInterestPreviewRows(entriesToShow);
      setInterestHiddenExistingCount(hiddenUnchangedCount);
      setInterestPreviewWindow(preview.window || null);
      setSelectedInterestRows(initialSelection);
      setShowInterestPreviewModal(true);
    } catch (e) {
      alert('Interest update failed: ' + e.message);
    } finally {
      setInterestUpdating(false);
    }
  };

  const handleApplySelectedInterestRows = async () => {
    const selected = interestPreviewRows.filter((_, idx) => !!selectedInterestRows[idx]);
    if (!selected.length) {
      alert('Select at least one entry to insert or update.');
      return;
    }

    try {
      setInterestUpdating(true);
      const applied = await applyInvestmentInterestUpdate(id, {
        portfolio_id: selectedId || undefined,
        replace_existing: true,
        selected_entries: selected.map((e) => ({ fy: e.fy, date: e.date, amount: e.amount })),
      });

      setShowInterestPreviewModal(false);
      alert(`Interest update completed. Inserted: ${applied.summary.inserted}, Updated: ${applied.summary.updated}, Skipped: ${applied.summary.skipped}`);
      await loadData();
    } catch (e) {
      alert('Interest update failed: ' + e.message);
    } finally {
      setInterestUpdating(false);
    }
  };

  const handlePreviewEsppContributions = async () => {
    setEsppContributionStatus(null);
    if (!selectedId) {
      alert('Select a portfolio first to preview ESPP contributions.');
      return;
    }
    if (!esppPayslipFiles.length) {
      alert('Select one or more payslip PDF files first.');
      return;
    }

    try {
      setEsppContributionLoading(true);
      const result = await previewEsppContributionsFromPayslips(esppPayslipFiles, Number(id), Number(selectedId));
      setEsppContributionPreview(result);
    } catch (e) {
      alert('ESPP contribution preview failed: ' + e.message);
    } finally {
      setEsppContributionLoading(false);
    }
  };

  const handleImportEsppContributions = async () => {
    setEsppContributionStatus(null);
    if (!selectedId) {
      setEsppContributionStatus({ type: 'danger', text: 'Select a portfolio first to import ESPP contributions.' });
      return;
    }
    if (!esppContributionPreview?.rows?.length) {
      setEsppContributionStatus({ type: 'danger', text: 'Preview contributions first.' });
      return;
    }

    try {
      setEsppContributionImporting(true);
      const result = await importEsppContributions({
        investment_id: Number(id),
        portfolio_id: Number(selectedId),
        overwrite_existing: esppContributionOverwrite,
        rows: esppContributionPreview.rows,
      });
      await loadData();
      await handlePreviewEsppContributions();
      setEsppContributionStatus({
        type: 'success',
        text: `Import complete. Created: ${result.created}, Skipped: ${result.skipped}, Replaced: ${result.removed_existing}.`,
      });
    } catch (e) {
      setEsppContributionStatus({ type: 'danger', text: 'Import failed: ' + e.message });
    } finally {
      setEsppContributionImporting(false);
    }
  };

  const updateTxnField = (field, value) => {
    const updated = { ...txnForm, [field]: value };
    // Date change: auto-fetch RBI rate for USD investments
    if (field === 'transaction_date' && isForeignUSD && value) {
      fetchRBIRate(value);
    }
    // Auto-calc INR amount for USD investments
    if (isForeignUSD) {
      const u = parseFloat(updated.units) || 0;
      const p = parseFloat(updated.price_per_unit) || 0;
      const r = parseFloat(updated.exchange_rate_used) || 0;
      if (u > 0 && p > 0 && r > 0 && (field === 'units' || field === 'price_per_unit' || field === 'exchange_rate_used')) {
        updated.usd_amount = String(Math.round(u * p * 100) / 100);
        updated.amount = String(Math.round(u * p * r * 100) / 100);
      }
    } else if ((field === 'units' || field === 'price_per_unit') && updated.units && updated.price_per_unit) {
      updated.amount = (parseFloat(updated.units) * parseFloat(updated.price_per_unit)).toFixed(2);
    }
    setTxnForm(updated);
  };

  if (loading) return <div className="d-flex justify-content-center py-5"><Spinner animation="border" variant="primary" /></div>;
  if (!data) return <div className="text-danger">Investment not found</div>;

  const isPPF = data.asset_type === 'PPF' || data.asset_type === 'SSY' || data.asset_type === 'PF';
  const isSSY = data.asset_type === 'SSY';
  const isPPFOnly = data.asset_type === 'PPF';
  const isPFOnly = data.asset_type === 'PF';
  const interestPreviewDecimals = isPPF ? 0 : 2;
  const isEpsInvestment = isPPF && /eps/i.test(String(data.name || ''));
  const isBond = data.asset_type === 'BOND';
  const isSGB = data.asset_type === 'SGB';
  const isForeignUSD = data.asset_type === 'FOREIGN_STOCK' && data.currency === 'USD';
  const isMSFTStock = /MSFT/i.test(String(data.ticker_symbol || '')) || /microsoft/i.test(String(data.name || ''));
  const canImportEspp = isForeignUSD && isMSFTStock;

  const totalInvested = Number(data.totalInvested) || 0;
  const currentValue = Number(data.latestValue?.current_value) || 0;
  const saleProceeds = Number(data.saleProceeds) || 0;
  const cumulativeValue = currentValue + saleProceeds;
  const totalProfitLoss = cumulativeValue - totalInvested;
  const absoluteReturnPct = totalInvested > 0
    ? (totalProfitLoss / totalInvested) * 100
    : null;

  const xirrCashflows = (data.transactions || []).reduce((acc, txn) => {
    const txnDate = new Date(txn.transaction_date);
    if (Number.isNaN(txnDate.getTime())) return acc;

    const amount = Number(txn.amount) || 0;
    const fees = Number(txn.fees) || 0;
    let cashflow = 0;
    const treatAsInternal = isInternalXirrCashflow(data.asset_type, txn.transaction_type);

    if (CASH_OUTFLOW_TYPES.has(txn.transaction_type)) {
      cashflow = -(amount + fees);
    } else if (CASH_INFLOW_TYPES.has(txn.transaction_type) && !treatAsInternal) {
      cashflow = amount - fees;
    }

    if (Math.abs(cashflow) > 1e-9) {
      acc.push({ amount: cashflow, date: txnDate });
    }

    return acc;
  }, []);

  const terminalValue = currentValue;
  if (terminalValue > 0 && data.latestValue?.date) {
    const valuationDate = new Date(data.latestValue.date);
    if (!Number.isNaN(valuationDate.getTime())) {
      xirrCashflows.push({ amount: terminalValue, date: valuationDate });
    }
  }

  const xirrRate = calculateXirr(xirrCashflows);
  const xirrPct = xirrRate == null ? null : xirrRate * 100;
  const realizedGain = saleProceeds;
  const detailDayChange = Number(data.dayChangeDisplay ?? data.latestValue?.day_change ?? 0);
  const detailDayChangeAsOf = data.dayChangeAsOfDate || null;
  const detailDayChangeUsesFallback = !!data.dayChangeUsesFallback;
  const intervalMetrics = data.intervalXIRR || {};
  const intervalChange = Number(intervalMetrics.interval_change || 0);
  const intervalChangePct = Number(intervalMetrics.interval_change_pct || 0);
  const intervalXirrPct = intervalMetrics.xirr_pct == null ? null : Number(intervalMetrics.xirr_pct);
  const isDayChangeMode = selectedInterval === '1D' || selectedInterval === 'YD';
  const todayIso = new Date().toISOString().split('T')[0];
  const placeholderVestCount = isForeignUSD
    ? (data.transactions || []).filter((txn) => txn.transaction_type === 'VEST'
      && (Number(txn.amount) || 0) === 0
      && txn.price_per_unit == null
      && txn.gross_units == null
      && txn.tax_withheld_units == null).length
    : 0;
  const visibleTransactions = isForeignUSD
    ? (data.transactions || []).filter((txn) => {
        const isPlaceholderVest = txn.transaction_type === 'VEST'
          && (Number(txn.amount) || 0) === 0
          && txn.price_per_unit == null
          && txn.gross_units == null
          && txn.tax_withheld_units == null;
        const isFutureVest = hideFutureVestings
          && txn.transaction_type === 'VEST'
          && String(txn.transaction_date || '') > todayIso;
        return !isPlaceholderVest && !isFutureVest;
      })
    : (data.transactions || []);
  const hiddenPlaceholderCount = placeholderVestCount;
  const hasFolioColumn = !isPPF && visibleTransactions.some((t) => t.folio_number);
  const folioOptions = (data.folio_options || []).map((f) => f.folio_number).filter(Boolean);

  const parseGrantMeta = (txnOrNotes) => {
    const txn = txnOrNotes && typeof txnOrNotes === 'object' && !Array.isArray(txnOrNotes)
      ? txnOrNotes
      : null;
    const text = String(txn ? txn.notes : txnOrNotes || '');
    const transactionType = String(txn?.transaction_type || '').toUpperCase();

    if (transactionType === 'ESPP_CONTRIBUTION' || transactionType === 'ESPP_PURCHASE') {
      return {
        grantLabel: 'ESPP',
        awardNumber: null,
        tranche: null,
      };
    }

    const rsuGrantMatch = text.match(/^RSU Vest\s*\|\s*([^|]+?)\s*\|/i);
    const esppGrantMatch = text.match(/^ESPP Purchase\s*\|\s*([^|]+?)\s*\|/i);
    const rsuSaleMatch = text.match(/^RSU Sale\s*\|\s*([^|]+?)\s*\|/i);
    const esppSaleMatch = text.match(/^ESPP Sale\s*\|\s*([^|]+?)\s*\|/i);
    const grantMatch = rsuGrantMatch || esppGrantMatch || rsuSaleMatch || esppSaleMatch;
    const awardMatch = text.match(/Award\s+(\d+)/i);
    const trancheMatch = text.match(/Tranche\s+(\d+\/\d+)/i);
    return {
      grantLabel: grantMatch ? grantMatch[1].trim() : null,
      awardNumber: awardMatch ? awardMatch[1] : null,
      tranche: trancheMatch ? trancheMatch[1] : null,
    };
  };

  const formatGrantUnits = (value) => {
    const num = Number(value);
    if (!Number.isFinite(num)) return '-';
    return Math.abs(num - Math.round(num)) < 1e-6
      ? String(Math.round(num))
      : formatNumber(num, 3);
  };

  const awardTotalToVest = (data.transactions || []).reduce((acc, txn) => {
    if (txn.transaction_type !== 'VEST') return acc;
    if (txn.gross_units == null) return acc;
    const meta = parseGrantMeta(txn);
    if (!meta.awardNumber) return acc;
    acc[meta.awardNumber] = (acc[meta.awardNumber] || 0) + Number(txn.gross_units || 0);
    return acc;
  }, {});

  const cumulativeAwardGrossByTxnId = (() => {
    const byTxn = {};
    const runningByAward = {};
    const vestRows = (data.transactions || [])
      .filter((txn) => txn.transaction_type === 'VEST' && txn.gross_units != null)
      .slice()
      .sort((a, b) => a.transaction_date.localeCompare(b.transaction_date) || a.id - b.id);

    for (const txn of vestRows) {
      const meta = parseGrantMeta(txn);
      if (!meta.awardNumber) continue;
      runningByAward[meta.awardNumber] = (runningByAward[meta.awardNumber] || 0) + Number(txn.gross_units || 0);
      byTxn[txn.id] = runningByAward[meta.awardNumber];
    }

    return byTxn;
  })();

  const grantOptions = Array.from(new Set(
    visibleTransactions
      .map((t) => parseGrantMeta(t).grantLabel)
      .filter(Boolean)
  )).sort((a, b) => a.localeCompare(b));

  const typeOptions = Array.from(new Set(
    visibleTransactions
      .map((t) => t.transaction_type)
      .filter(Boolean)
  )).sort((a, b) => a.localeCompare(b));

  const toggleSelection = (currentValues, value, setter) => {
    if (currentValues.includes(value)) {
      setter(currentValues.filter((v) => v !== value));
    } else {
      setter([...currentValues, value]);
    }
  };

  const soldUnitsByVestLotKey = (data.transactions || []).reduce((acc, txn) => {
    if (txn.transaction_type !== 'SELL') return acc;
    const text = String(txn.notes || '');
    const acqDate = text.match(/Acquired\s+(\d{4}-\d{2}-\d{2})/i)?.[1];
    const award = text.match(/Award\s+(\d+)/i)?.[1] || null;
    const tranche = text.match(/Tranche\s+(\d+\/\d+)/i)?.[1] || null;
    if (!acqDate || !award || !tranche) return acc;
    const key = `${acqDate}|${award}|${tranche}`;
    acc[key] = (acc[key] || 0) + Number(txn.units || 0);
    return acc;
  }, {});

  const soldUnitsByEsppDate = (data.transactions || []).reduce((acc, txn) => {
    if (txn.transaction_type !== 'SELL') return acc;
    const text = String(txn.notes || '');
    if (!/^ESPP Sale\s*\|/i.test(text)) return acc;
    const acqDate = text.match(/Acquired\s+(\d{4}-\d{2}-\d{2})/i)?.[1];
    if (!acqDate) return acc;
    acc[acqDate] = (acc[acqDate] || 0) + Number(txn.units || 0);
    return acc;
  }, {});

  const isFullySoldLot = (txn) => {
    if (!txn || (txn.transaction_type !== 'VEST' && txn.transaction_type !== 'ESPP_PURCHASE')) return false;

    if (txn.transaction_type === 'ESPP_PURCHASE') {
      const soldUnits = Number(soldUnitsByEsppDate[txn.transaction_date] || 0);
      return soldUnits > 0 && soldUnits >= (Number(txn.units || 0) - 0.0001);
    }

    const meta = parseGrantMeta(txn);
    if (!meta.awardNumber || !meta.tranche) return false;
    const key = `${txn.transaction_date}|${meta.awardNumber}|${meta.tranche}`;
    const soldUnits = Number(soldUnitsByVestLotKey[key] || 0);
    return soldUnits > 0 && soldUnits >= (Number(txn.units || 0) - 0.0001);
  };

  // SGB calculations
  let sgbDetails = null;
  if (isSGB) {
    const parsed = parseSGBName(data.name);
    if (parsed) {
      const maturityDate = convertDateFormat(parsed.maturity_date); // DD/MM/YYYY to YYYY-MM-DD
      const buyTransactions = (data.transactions || []).filter(t => t.transaction_type === 'BUY').sort((a, b) => new Date(a.transaction_date) - new Date(b.transaction_date));
      const issueDate = buyTransactions.length > 0 ? buyTransactions[0].transaction_date : null;
      
      let couponDates = [];
      let totalInterestPaid = 0;
      let accruedInterest = 0;
      
      if (issueDate && maturityDate) {
        couponDates = calculateCouponDates(issueDate, maturityDate);
        const paidCoupons = getPaidCouponDates(couponDates);
        totalInterestPaid = calculateInterestPaid(data.totalUnits, parsed.coupon_rate, 1, paidCoupons);
        
        // Get accrued interest
        const lastCoupon = getLastCouponDate(paidCoupons);
        const nextCoupon = lastCoupon ? getNextCouponDate(lastCoupon) : couponDates.length > 0 ? couponDates[0] : null;
        if (lastCoupon && nextCoupon) {
          accruedInterest = calculateAccruedInterest(data.totalUnits, parsed.coupon_rate, 1, lastCoupon, nextCoupon);
        }
      }
      
      sgbDetails = {
        coupon_rate: parsed.coupon_rate,
        maturity_date: maturityDate,
        series: parsed.series,
        total_interest_paid: totalInterestPaid,
        accrued_interest: accruedInterest,
        issue_date: issueDate,
      };
    }
  }

  const detailItems = [
    data.isin_code ? { label: 'ISIN', value: data.isin_code } : null,
    data.amfi_code ? { label: 'AMFI', value: data.amfi_code } : null,
    data.asset_type === 'MUTUAL_FUND' && data.folio_summary
      ? { label: 'Folios', value: `Open: ${data.folio_summary.open} | Closed: ${data.folio_summary.closed}` }
      : null,
    !isPPF ? { label: 'Total Units', value: formatNumber(data.totalUnits, 4) } : null,
    isPPF && data.account_number ? { label: 'Account', value: data.account_number } : null,
    !isPPF && data.latestValue ? { label: 'Last Price', value: `₹${formatNumber(data.latestValue.price_per_unit, 2)}` } : null,
    !isPPF && data.ticker_symbol ? { label: 'Ticker', value: data.ticker_symbol } : null,
    data.category ? { label: 'Category', value: data.category } : null,
    isPPF && data.interest_rate ? { label: 'Interest', value: `${data.interest_rate}% p.a.` } : null,
    isSSY ? { label: 'Interest Calc', value: 'Month-end balance x rate/1200; rounded at FY end' } : null,
    isPPFOnly ? { label: 'Interest Calc', value: 'Min balance (5th-month-end) x rate/1200; rounded at FY end' } : null,
    isPFOnly ? { label: 'Interest Calc', value: 'Month-end balance (excluding same-month PF contributions) x rate/1200; rounded at FY end' } : null,
    isPPF && data.maturity_date ? { label: 'Maturity', value: formatDate(data.maturity_date) } : null,
    isPPF && data.opening_balance > 0 ? { label: 'Opening Balance', value: `₹${formatNumber(data.opening_balance, 2)}` } : null,
    isBond && data.coupon_rate ? { label: 'Coupon Rate', value: `${formatNumber(data.coupon_rate, 4)}% p.a.` } : null,
    isBond && data.coupon_frequency ? { label: 'Frequency', value: String(data.coupon_frequency || '').replace(/_/g, ' ') } : null,
    isBond && data.maturity_date ? { label: 'Maturity Date', value: formatDate(data.maturity_date) } : null,
    isSGB && sgbDetails && sgbDetails.coupon_rate ? { label: 'Coupon Rate', value: `${sgbDetails.coupon_rate}% p.a.` } : null,
    isSGB && sgbDetails && sgbDetails.maturity_date ? { label: 'Maturity', value: formatDate(sgbDetails.maturity_date) } : null,
    isSGB && sgbDetails && sgbDetails.series ? { label: 'Series', value: sgbDetails.series } : null,
    isSGB && sgbDetails && sgbDetails.total_interest_paid > 0 ? { label: 'Interest Paid', value: `₹${formatNumber(sgbDetails.total_interest_paid, 2)}` } : null,
    isSGB && sgbDetails && sgbDetails.accrued_interest > 0 ? { label: 'Accrued Interest', value: `₹${formatNumber(sgbDetails.accrued_interest, 2)}` } : null,
    !isPPF && data.latestValue
      ? {
          label: detailDayChangeAsOf ? `1D Change (As of ${formatDate(detailDayChangeAsOf)})` : '1D Change',
          value: formatNumber(detailDayChange, 0),
          color: profitColor(detailDayChange),
        }
      : null,
  ].filter(Boolean);

  const getTxnTypeLabel = (type) => {
    if (type === 'DEPOSIT' && Number(data.id) === 199) return 'Employee';
    return TYPE_LABELS[type] || type.replace(/_/g, ' ');
  };

  return (
    <div>
      {/* Header */}
      <div className="d-flex flex-column flex-sm-row justify-content-between align-items-start gap-3 mb-4">
        <div>
          <Link to={cameFrom === 'transactions' ? `/transactions${transactionsSearch}` : `/investments${investmentsSearch ? `?${investmentsSearch}` : ''}`} className="small text-muted text-decoration-none d-flex align-items-center gap-1 mb-2">
            <ArrowLeft size={16} /> Back to {cameFrom === 'transactions' ? 'Transactions' : 'Investments'}
          </Link>
          <h1 className="h4 fw-bold mb-1">{data.display_name || data.name}</h1>
          <div className="d-flex align-items-center gap-2">
            <Badge bg="primary" className="bg-opacity-10 text-primary" title={ASSET_TYPE_FULL_NAMES[data.asset_type]}>{ASSET_TYPE_LABELS[data.asset_type]}</Badge>
            {data.is_active === 0 && <Badge bg="secondary">Inactive</Badge>}
          </div>
        </div>
        <div className="d-flex gap-2">
          <Button variant="primary" size="sm" onClick={() => setShowAddTxn(true)} className="d-flex align-items-center gap-1">
            <Plus size={16} /> Add Transaction
          </Button>
          {isPPF && (
            <Button variant="outline-primary" size="sm" onClick={handleInterestUpdate} disabled={interestUpdating} className="d-flex align-items-center gap-1">
              {interestUpdating ? 'Updating...' : 'Update Interest'}
            </Button>
          )}
          {canImportEspp && (
            <Button variant="outline-primary" size="sm" onClick={() => setShowEsppModal(true)} className="d-flex align-items-center gap-1">
              Import ESPP Contributions
            </Button>
          )}
          <Link to={`/investments/${id}/settings`} state={{ from: cameFrom, transactionsSearch, investmentsSearch }} className="btn btn-outline-secondary btn-sm d-flex align-items-center gap-1">
            <Settings size={16} /> Settings
          </Link>
          <Button variant="outline-danger" size="sm" onClick={handleDelete} className="d-flex align-items-center gap-1">
            <Trash2 size={16} /> Delete
          </Button>
        </div>
      </div>

      {/* Summary Cards */}
      <Row className="g-3 mb-4">
        <Col md={6} lg={3}>
          <Card className="shadow-sm h-100">
            <Card.Body className="py-3">
              <div className="d-flex align-items-center gap-2 text-muted small mb-1">
                <Wallet size={16} /> Current Value
              </div>
              <div className="fw-bold" style={{ fontSize: '1.9rem', lineHeight: 1.1 }}>{formatINR(currentValue)}</div>
              <div className="text-muted small">Total Invested: {formatINR(totalInvested)}</div>
              <div className="text-muted small">Cash Proceeds: {formatINR(realizedGain)}</div>
            </Card.Body>
          </Card>
        </Col>
        <Col md={6} lg={3}>
          <Card className="shadow-sm h-100">
            <Card.Body className="py-3">
              <div className="d-flex align-items-center justify-content-between gap-2 mb-2">
                <div className="d-flex align-items-center gap-2 text-muted small">
                  {intervalChange >= 0 ? (
                    <TrendingUp size={16} className="text-success" />
                  ) : (
                    <TrendingDown size={16} className="text-danger" />
                  )}
                  <span>
                    {selectedInterval === 'CUSTOM'
                      ? `${customFromDate} to ${customToDate}`
                      : selectedInterval === '1D'
                        ? '1 Day Change'
                        : selectedInterval === 'YD'
                          ? 'Yesterday Change'
                        : `${selectedInterval} Change`}
                  </span>
                </div>
                <div style={{ fontSize: '0.85rem' }}>
                  <select
                    className="form-select form-select-sm"
                    value={selectedInterval}
                    onChange={(e) => {
                      const val = e.target.value;
                      if (val === 'CUSTOM') {
                        setShowCustomDatePicker(true);
                      } else {
                        setSelectedInterval(val);
                        setShowCustomDatePicker(false);
                      }
                    }}
                    style={{ maxWidth: '100px', fontSize: '0.85rem' }}
                  >
                    <option value="1D">1D</option>
                    <option value="YD">YD</option>
                    <option value="2D">2D</option>
                    <option value="1W">1W</option>
                    <option value="1M">1M</option>
                    <option value="3M">3M</option>
                    <option value="6M">6M</option>
                    <option value="1Y">1Y</option>
                    <option value="2Y">2Y</option>
                    <option value="3Y">3Y</option>
                    <option value="5Y">5Y</option>
                    <option value="7Y">7Y</option>
                    <option value="10Y">10Y</option>
                    <option value="CUSTOM">Custom</option>
                  </select>
                </div>
              </div>

              {showCustomDatePicker && (
                <div className="mb-2 p-2 bg-light rounded small">
                  <div className="d-flex gap-2 mb-2">
                    <input
                      type="date"
                      className="form-control form-control-sm"
                      value={customFromDate}
                      onChange={(e) => setCustomFromDate(e.target.value)}
                      placeholder="From"
                    />
                    <input
                      type="date"
                      className="form-control form-control-sm"
                      value={customToDate}
                      onChange={(e) => setCustomToDate(e.target.value)}
                      placeholder="To"
                    />
                  </div>
                  <Button
                    size="sm"
                    onClick={() => {
                      if (!customFromDate || !customToDate) return;
                      setSelectedInterval('CUSTOM');
                      setShowCustomDatePicker(false);
                      loadData();
                    }}
                    className="w-100"
                  >
                    Apply
                  </Button>
                </div>
              )}

              <div className={`fw-bold ${profitColor(intervalChange)}`} style={{ fontSize: '1.9rem', lineHeight: 1.1 }}>
                {formatINR(intervalChange)}
              </div>
              {isDayChangeMode && (
                <>
                  <div className={`small ${profitColor(intervalChangePct)}`}>
                    Change: {formatPct(intervalChangePct)}
                  </div>
                  {detailDayChangeUsesFallback && detailDayChangeAsOf && (
                    <div className="small text-muted">
                      As of {formatDate(detailDayChangeAsOf)}
                    </div>
                  )}
                </>
              )}
              {!isDayChangeMode && intervalXirrPct != null && (
                <div className={`small ${profitColor(intervalXirrPct)}`}>
                  Annualized (XIRR): {formatPct(intervalXirrPct)}
                </div>
              )}
            </Card.Body>
          </Card>
        </Col>
        <Col md={6} lg={3}>
          <Card className="shadow-sm h-100">
            <Card.Body className="py-3">
              <div className="d-flex align-items-center gap-2 text-muted small mb-1">
                <BarChart3 size={16} /> Cumulative Value
              </div>
              <div className="fw-bold" style={{ fontSize: '1.9rem', lineHeight: 1.1 }}>{formatINR(cumulativeValue)}</div>
              <div className="text-muted small">Current + Cash Out</div>
            </Card.Body>
          </Card>
        </Col>
        <Col md={6} lg={3}>
          <Card className="shadow-sm h-100">
            <Card.Body className="py-3">
              <div className="d-flex align-items-center gap-2 text-muted small mb-1">
                <PiggyBank size={16} /> Total P&amp;L
              </div>
              <div className={`fw-bold ${profitColor(totalProfitLoss)}`} style={{ fontSize: '1.9rem', lineHeight: 1.1 }}>
                {totalProfitLoss >= 0 ? '+' : ''}{formatINR(totalProfitLoss)}
              </div>
              <div className={`small ${profitColor(absoluteReturnPct)}`}>
                <span>Abs: {formatPct(absoluteReturnPct)}</span>
                <span className="mx-2 text-muted">|</span>
                <span>XIRR: {xirrPct == null ? 'N/A' : formatPct(xirrPct)}</span>
              </div>
            </Card.Body>
          </Card>
        </Col>
      </Row>

      {/* Details */}
      <Card className="shadow-sm mb-4">
        <Card.Body>
          <h2 className="h6 fw-semibold mb-2">Details</h2>
          <div className="d-flex flex-wrap gap-3 small">
            {detailItems.map((item) => (
              <span
                key={item.label}
                className="rounded-3 px-3 py-2 bg-light"
                style={{ whiteSpace: 'nowrap', cursor: 'default', lineHeight: 1.2 }}
              >
                <span className="text-muted" style={{ fontSize: '0.72rem', letterSpacing: '0.02em' }}>{item.label}:</span>{' '}
                <span className={item.color || ''}>{item.value}</span>
              </span>
            ))}
          </div>
        </Card.Body>
      </Card>

      {/* Add Transaction Form */}
      {showAddTxn && (
        <Card className="shadow-sm mb-4 border-primary">
          <Card.Body>
            <div className="d-flex justify-content-between align-items-center mb-3">
              <h2 className="h6 fw-semibold mb-0">Add Transaction</h2>
              <button onClick={() => setShowAddTxn(false)} className="btn-close" />
            </div>
            <Form onSubmit={handleAddTransaction}>
              <Row className="g-3">
                <Col md={4}>
                  <Form.Label className="small">Type</Form.Label>
                  <Form.Select size="sm" value={txnForm.transaction_type} onChange={(e) => updateTxnField('transaction_type', e.target.value)}>
                    {txnTypes.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
                  </Form.Select>
                </Col>
                <Col md={4}>
                  <Form.Label className="small">Date</Form.Label>
                  <Form.Control size="sm" type="date" value={txnForm.transaction_date}
                    onChange={(e) => updateTxnField('transaction_date', e.target.value)} required />
                </Col>
                {!isPPF && (
                  <>
                    {txnForm.transaction_type !== 'ESPP_CONTRIBUTION' && (
                      <>
                        <Col md={4}>
                          <Form.Label className="small">Units</Form.Label>
                          <Form.Control size="sm" type="number" step="0.001" value={txnForm.units}
                            onChange={(e) => updateTxnField('units', e.target.value)} placeholder="Number of units" />
                        </Col>
                        <Col md={4}>
                          <Form.Label className="small">{isForeignUSD ? 'Price/Unit (USD)' : 'Price per Unit'}</Form.Label>
                          <Form.Control size="sm" type="number" step="0.0001" value={txnForm.price_per_unit}
                            onChange={(e) => updateTxnField('price_per_unit', e.target.value)} placeholder={isForeignUSD ? 'FMV in USD' : 'Price per unit'} />
                        </Col>
                        {isForeignUSD && txnForm.transaction_type === 'ESPP_PURCHASE' && (
                          <Col md={4}>
                            <Form.Label className="small">FMV/Unit on Purchase Date (USD)</Form.Label>
                            <Form.Control size="sm" type="number" step="0.0001" value={txnForm.fmv_per_unit}
                              onChange={(e) => updateTxnField('fmv_per_unit', e.target.value)} placeholder="Market price (USD)" />
                          </Col>
                        )}
                        {isForeignUSD && (
                          <Col md={4}>
                            <Form.Label className="small d-flex align-items-center gap-1">
                              RBI Rate (₹/USD) {rateLoading && <Spinner animation="border" size="sm" />}
                            </Form.Label>
                            <Form.Control size="sm" type="number" step="0.0001" value={txnForm.exchange_rate_used}
                              onChange={(e) => updateTxnField('exchange_rate_used', e.target.value)} placeholder="Auto-fetched from RBI" />
                          </Col>
                        )}
                      </>
                    )}
                  </>
                )}
                <Col md={4}>
                  <Form.Label className="small">Amount (₹){isForeignUSD && txnForm.usd_amount ? ` — USD ${txnForm.usd_amount}` : ''}</Form.Label>
                  <Form.Control size="sm" type="number" step="0.01" value={txnForm.amount}
                    onChange={(e) => updateTxnField('amount', e.target.value)} placeholder="Total amount in ₹" required />
                </Col>
                <Col md={4}>
                  <Form.Label className="small">Charges (₹)</Form.Label>
                  <Form.Control size="sm" type="number" step="0.01" value={txnForm.fees}
                    onChange={(e) => updateTxnField('fees', e.target.value)} />
                </Col>
                <Col md={4}>
                  <Form.Label className="small">Notes</Form.Label>
                  <Form.Control size="sm" type="text" value={txnForm.notes}
                    onChange={(e) => updateTxnField('notes', e.target.value)} placeholder="Optional" />
                </Col>
                <Col xs={12}>
                  <Button type="submit" variant="primary" size="sm">Add Transaction</Button>
                </Col>
              </Row>
            </Form>
          </Card.Body>
        </Card>
      )}

      {/* Transactions Table */}
      <Card className="shadow-sm transactions-card">
        <Card.Header className="bg-white px-3 py-2">
          <div className="d-flex flex-column flex-md-row justify-content-between align-items-start align-items-md-center gap-2">
            <div>
              <h2 className="h6 fw-semibold mb-1">Transactions</h2>
              <div className="small text-muted">All transaction rows for this investment.</div>
            </div>
            <div className="d-flex flex-wrap justify-content-md-end align-items-center gap-2 ms-md-auto">
              <Button
                size="sm"
                variant="outline-secondary"
                onClick={() => setTransactionsExpanded((prev) => !prev)}
                aria-expanded={transactionsExpanded}
              >
                {transactionsExpanded ? 'Collapse Transactions' : 'Expand Transactions'}
              </Button>

              {!transactionsExpanded ? null : (
                <>
              {isForeignUSD && (
                <Dropdown autoClose="outside">
                  <Dropdown.Toggle variant="outline-secondary" size="sm">
                    {selectedGrants.length === 0 ? 'Grants' : `${selectedGrants.length} grant(s)`}
                  </Dropdown.Toggle>
                  <Dropdown.Menu style={{ minWidth: 240, maxHeight: 260, overflowY: 'auto' }}>
                    {grantOptions.length === 0 ? (
                      <div className="px-3 py-2 text-muted small">No grants</div>
                    ) : grantOptions.map((grant) => (
                      <div key={grant} className="px-3 py-1">
                        <Form.Check
                          type="checkbox"
                          className="small mb-0"
                          label={grant}
                          checked={selectedGrants.includes(grant)}
                          onChange={() => toggleSelection(selectedGrants, grant, setSelectedGrants)}
                        />
                      </div>
                    ))}
                  </Dropdown.Menu>
                </Dropdown>
              )}

              <Dropdown autoClose="outside">
                <Dropdown.Toggle variant="outline-secondary" size="sm">
                  {selectedTypes.length === 0 ? 'Types' : `${selectedTypes.length} type(s)`}
                </Dropdown.Toggle>
                <Dropdown.Menu style={{ minWidth: 220, maxHeight: 260, overflowY: 'auto' }}>
                  {typeOptions.map((type) => (
                    <div key={type} className="px-3 py-1">
                      <Form.Check
                        type="checkbox"
                        className="small mb-0"
                        label={getTxnTypeLabel(type)}
                        checked={selectedTypes.includes(type)}
                        onChange={() => toggleSelection(selectedTypes, type, setSelectedTypes)}
                      />
                    </div>
                  ))}
                </Dropdown.Menu>
              </Dropdown>

              <Form.Control
                size="sm"
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                style={{ width: 132 }}
                aria-label="Date from"
              />
              <Form.Control
                size="sm"
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                style={{ width: 132 }}
                aria-label="Date to"
              />

              {hasFolioColumn && (
                <Form.Select
                  size="sm"
                  value={selectedFolio}
                  onChange={(e) => setSelectedFolio(e.target.value)}
                  style={{ width: 150 }}
                >
                  <option value="ALL">All folios</option>
                  {folioOptions.map((folio) => (
                    <option key={folio} value={folio}>{folio}</option>
                  ))}
                </Form.Select>
              )}

              {(selectedGrants.length > 0 || selectedTypes.length > 0 || dateFrom || dateTo || selectedFolio !== 'ALL') && (
                <Button
                  size="sm"
                  variant="outline-secondary"
                  onClick={() => {
                    setSelectedGrants([]);
                    setSelectedTypes([]);
                    setDateFrom('');
                    setDateTo('');
                    setSelectedFolio('ALL');
                  }}
                >
                  Clear
                </Button>
              )}

              {isForeignUSD && (
                <Form.Check
                  type="switch"
                  id="hide-future-vestings"
                  label="Hide future vestings"
                  checked={hideFutureVestings}
                  onChange={(e) => setHideFutureVestings(e.target.checked)}
                  className="small"
                />
              )}
                </>
              )}
            </div>
          </div>
        </Card.Header>
        <Collapse in={transactionsExpanded}>
          <div>
            {visibleTransactions.length === 0 ? (
              <Card.Body className="text-center text-muted py-4">
                No transactions recorded yet. Add your first transaction above.
              </Card.Body>
            ) : (
              <div className="responsive-table">
                {hiddenPlaceholderCount > 0 && (
                  <div className="px-3 py-2 small text-muted border-bottom">
                    Hidden {hiddenPlaceholderCount} placeholder RSU rows with no amount/price/withholding data.
                  </div>
                )}
                <Table hover size="sm" className="mb-0 small transactions-table">
                  <thead className="table-light">
                    <tr>
                      <th className="px-3 text-nowrap">Date</th>
                      <th className="px-3">Type</th>
                      {!isPPF && <th className="px-3 text-end">Units</th>}
                      {isForeignUSD && <th className="px-3 text-end">Withheld</th>}
                      {isForeignUSD && <th className="px-3 text-end">FX</th>}
                      {!isPPF && <th className="px-3 text-end">Price</th>}
                      <th className="px-3 text-end">Amt</th>
                      {!isPPF && <th className="px-3 text-end">Fees</th>}
                      {isPPF && <th className="px-3 text-end">Balance</th>}
                      {!isPPF && <th className="px-3 text-end">Hold</th>}
                      {hasFolioColumn && <th className="px-3">Folio</th>}
                      {isForeignUSD && <th className="px-3">Grant</th>}
                      <th className="px-3">Notes</th>
                      <th className="px-3 text-center" style={{ width: 64 }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      // Compute running holding from oldest to newest
                      // Corporate actions come before regular trades on the same date
                      const CORPORATE_TYPES = new Set(['SPLIT', 'BONUS', 'RIGHTS', 'MERGER', 'CONSOLIDATION', 'DIVIDEND', 'INTEREST']);
                      const txnSortKey = (t) => CORPORATE_TYPES.has(t.transaction_type) ? 0 : 1;
                      const sorted = [...visibleTransactions].sort((a, b) => a.transaction_date.localeCompare(b.transaction_date) || txnSortKey(a) - txnSortKey(b) || a.id - b.id);
                      const holdingMap = {};
                      const balanceMap = {};
                      const creditTypes = isEpsInvestment
                        ? ['EPS_CONTRIBUTION', 'INTEREST', 'TRANSFER_IN']
                        : ['DEPOSIT', 'INTEREST', 'RECONCILE', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION', 'TRANSFER_IN'];
                      let unitBal = 0;
                      let amtBal = data.opening_balance || 0;
                      for (const txn of sorted) {
                        if (UNIT_ADD_TYPES.includes(txn.transaction_type)) unitBal += txn.units || 0;
                        else if (UNIT_SUB_TYPES.includes(txn.transaction_type)) unitBal -= txn.units || 0;
                        if (Math.abs(unitBal) < 1e-6) unitBal = 0;
                        holdingMap[txn.id] = unitBal;
                        // EPS-only ledgers should accumulate EPS rows; EPF-ledgers should exclude EPS rows.
                        if (creditTypes.includes(txn.transaction_type)) {
                          amtBal += txn.amount || 0;
                        } else if (['WITHDRAWAL', 'TRANSFER_OUT'].includes(txn.transaction_type)) {
                          amtBal -= txn.amount || 0;
                        }
                        balanceMap[txn.id] = amtBal;
                      }
                      const hasFolio = visibleTransactions.some(t => t.folio_number);
                      const filteredByFolio = selectedFolio === 'ALL'
                        ? [...sorted]
                        : [...sorted].filter((t) => t.folio_number === selectedFolio);
                      const filteredByGrant = isForeignUSD && selectedGrants.length > 0
                        ? filteredByFolio.filter((t) => selectedGrants.includes(parseGrantMeta(t).grantLabel))
                        : filteredByFolio;
                      const filteredByType = selectedTypes.length > 0
                        ? filteredByGrant.filter((t) => selectedTypes.includes(t.transaction_type))
                        : filteredByGrant;
                      const filteredByDate = filteredByType.filter((t) => {
                        if (dateFrom && String(t.transaction_date || '') < dateFrom) return false;
                        if (dateTo && String(t.transaction_date || '') > dateTo) return false;
                        return true;
                      });
                      const filteredSorted = filteredByDate.reverse();
                      return filteredSorted.map((txn) => {
                        const grantMeta = parseGrantMeta(txn);
                        const totalToVest = grantMeta.awardNumber ? awardTotalToVest[grantMeta.awardNumber] : null;
                        const cumulativeVested = cumulativeAwardGrossByTxnId[txn.id];
                        const grantProgress = cumulativeVested != null && totalToVest != null
                          ? `${formatGrantUnits(cumulativeVested)}/${formatGrantUnits(totalToVest)}`
                          : null;
                        return (
                      <tr
                        key={txn.id}
                        style={(() => {
                          if (txn.transaction_type === 'SELL') return { opacity: 0.68, backgroundColor: '#f8f9fa' };
                          if (isFullySoldLot(txn)) return { opacity: 0.62, backgroundColor: '#f3f4f6' };
                          return undefined;
                        })()}
                      >
                        <td className="px-3 text-nowrap">{formatDate(txn.transaction_date)}</td>
                        <td className="px-3">
                          <span className={`badge rounded-pill badge-${txn.transaction_type.toLowerCase()}`}>
                            {getTxnTypeLabel(txn.transaction_type)}
                          </span>
                        </td>
                        {!isPPF && (
                          <td className="px-3 text-end">
                            {txn.units ? formatNumber(txn.units, 4) : '-'}
                            {isForeignUSD && txn.gross_units != null && txn.tax_withheld_units != null && Math.abs(Number(txn.gross_units || 0) - Number(txn.units || 0)) > 0.000001 ? (
                              <div className="text-muted" style={{ fontSize: '0.75rem', whiteSpace: 'nowrap' }}>
                                Gross {formatNumber(txn.gross_units, 4)}
                              </div>
                            ) : null}
                          </td>
                        )}
                        {isForeignUSD && <td className="px-3 text-end">{txn.tax_withheld_units != null ? formatNumber(txn.tax_withheld_units, 4) : '-'}</td>}
                        {isForeignUSD && <td className="px-3 text-end">{txn.exchange_rate_used != null ? `₹${formatNumber(txn.exchange_rate_used, 4)}/$` : '-'}</td>}
                        {!isPPF && (
                          <td className="px-3 text-end">
                            {txn.price_per_unit ? `${isForeignUSD ? '$' : '₹'}${formatNumber(txn.price_per_unit, 2)}` : '-'}
                            {isForeignUSD && txn.fmv_per_unit != null ? (
                              <div className="text-muted" style={{ fontSize: '0.75rem', whiteSpace: 'nowrap' }}>
                                FMV ${formatNumber(txn.fmv_per_unit, 2)}
                              </div>
                            ) : null}
                          </td>
                        )}
                        <td className="px-3 text-end fw-medium">
                          ₹{formatNumber(txn.amount, 2)}
                          {isForeignUSD && txn.usd_amount ? (
                            <div className="text-muted" style={{ fontSize: '0.75rem', whiteSpace: 'nowrap' }}>
                              ${formatNumber(txn.usd_amount, 2)}
                            </div>
                          ) : null}
                        </td>
                        {!isPPF && <td className="px-3 text-end">{txn.fees > 0 ? `₹${formatNumber(txn.fees, 2)}` : '-'}</td>}
                        {isPPF && <td className="px-3 text-end fw-medium">₹{formatNumber(balanceMap[txn.id], 2)}</td>}
                        {!isPPF && <td className="px-3 text-end">{holdingMap[txn.id] != null ? formatNumber(holdingMap[txn.id], 4) : '-'}</td>}
                        {!isPPF && hasFolio && <td className="px-3 text-muted" style={{ fontSize: '0.8rem' }}>{txn.folio_number || '-'}</td>}
                        {isForeignUSD && (
                          <td className="px-3">
                            <div className="fw-medium text-body" style={{ whiteSpace: 'nowrap' }}>
                              {grantMeta.grantLabel || '-'}
                            </div>
                            {grantProgress ? <div className="text-muted" style={{ fontSize: '0.75rem', lineHeight: 1.1 }}>{grantProgress}</div> : null}
                          </td>
                        )}
                        <td className="px-3 text-muted" style={{ maxWidth: 150, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={txn.notes || ''}>{txn.notes || '-'}</td>
                        <td className="px-3">
                          {EDITABLE_TYPES.includes(txn.transaction_type) && (
                            <div className="d-flex gap-1 row-actions">
                              <button onClick={() => handleEditTxn(txn)} className="btn btn-link btn-sm p-0 text-primary" title="Edit">
                                <Pencil size={14} />
                              </button>
                              <button onClick={() => { setDeleteConfirm(txn); setDeleteText(''); }} className="btn btn-link btn-sm p-0 text-danger" title="Delete">
                                <Trash2 size={14} />
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                        );
                      });
                    })()}
                  </tbody>
                </Table>
              </div>
            )}
          </div>
        </Collapse>
      </Card>

      <Card className="shadow-sm mt-4">
        <Card.Body>
          <div className="d-flex flex-column flex-lg-row justify-content-between align-items-start align-items-lg-center gap-2 mb-3">
            <div>
              <h2 className="h6 fw-semibold mb-1">Daily Values</h2>
              <div className="small text-muted">Stored daily snapshots for this investment in the current detail-page scope.</div>
            </div>
            <Button
              size="sm"
              variant="outline-secondary"
              onClick={() => {
                const nextExpanded = !dailyValuesExpanded;
                setDailyValuesExpanded(nextExpanded);
                if (nextExpanded && !dailyValuesData && !dailyValuesLoading) {
                  loadDailyValuesData();
                }
              }}
              aria-expanded={dailyValuesExpanded}
            >
              {dailyValuesExpanded ? 'Collapse Daily Values' : 'Expand Daily Values'}
            </Button>
          </div>

          <Collapse in={dailyValuesExpanded}>
            <div>
              <Form
                className="d-flex flex-wrap align-items-end gap-2 mb-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  loadDailyValuesData();
                }}
              >
                <Form.Group>
                  <Form.Label className="small mb-1">From</Form.Label>
                  <Form.Control
                    size="sm"
                    type="date"
                    value={dailyValuesFilters.from}
                    onChange={(e) => setDailyValuesFilters((prev) => ({ ...prev, from: e.target.value, page: 1 }))}
                  />
                </Form.Group>
                <Form.Group>
                  <Form.Label className="small mb-1">To</Form.Label>
                  <Form.Control
                    size="sm"
                    type="date"
                    value={dailyValuesFilters.to}
                    onChange={(e) => setDailyValuesFilters((prev) => ({ ...prev, to: e.target.value, page: 1 }))}
                  />
                </Form.Group>
                <Form.Group>
                  <Form.Label className="small mb-1">Rows per page</Form.Label>
                  <Form.Control
                    size="sm"
                    type="number"
                    min="1"
                    max="5000"
                    value={dailyValuesFilters.pageSize}
                    onChange={(e) => setDailyValuesFilters((prev) => ({
                      ...prev,
                      pageSize: Math.max(1, Math.min(5000, Number(e.target.value || 365))),
                      page: 1,
                    }))}
                    style={{ width: 110 }}
                  />
                </Form.Group>
                <Form.Group>
                  <Form.Label className="small mb-1">Page</Form.Label>
                  <Form.Control
                    size="sm"
                    type="number"
                    min="1"
                    value={dailyValuesFilters.page}
                    onChange={(e) => setDailyValuesFilters((prev) => ({
                      ...prev,
                      page: Math.max(1, Number(e.target.value || 1)),
                    }))}
                    style={{ width: 90 }}
                  />
                </Form.Group>
                <Button size="sm" type="submit" variant="outline-primary" disabled={dailyValuesLoading}>
                  {dailyValuesLoading ? 'Loading...' : 'Refresh'}
                </Button>
              </Form>

              {dailyValuesError && <div className="text-danger small mb-2">{dailyValuesError}</div>}

              {dailyValuesData?.pagination && (
                <div className="d-flex flex-wrap align-items-center gap-2 small mb-3">
                  <Button
                    size="sm"
                    variant="outline-secondary"
                    disabled={dailyValuesLoading || !dailyValuesData.pagination.has_previous}
                    onClick={() => {
                      const nextFilters = { ...dailyValuesFilters, page: Math.max(1, dailyValuesFilters.page - 1) };
                      setDailyValuesFilters(nextFilters);
                      loadDailyValuesData(nextFilters);
                    }}
                  >
                    Previous
                  </Button>
                  <Button
                    size="sm"
                    variant="outline-secondary"
                    disabled={dailyValuesLoading || !dailyValuesData.pagination.has_next}
                    onClick={() => {
                      const nextFilters = { ...dailyValuesFilters, page: dailyValuesFilters.page + 1 };
                      setDailyValuesFilters(nextFilters);
                      loadDailyValuesData(nextFilters);
                    }}
                  >
                    Next
                  </Button>
                  <span className="rounded-3 px-2 py-1 bg-light">
                    Page {dailyValuesData.pagination.page} of {dailyValuesData.pagination.total_pages}
                  </span>
                  <span className="rounded-3 px-2 py-1 bg-light">
                    Latest shown: {dailyValuesData.window?.displayed_from || '-'}
                  </span>
                  <span className="rounded-3 px-2 py-1 bg-light">
                    Oldest shown: {dailyValuesData.window?.displayed_to || '-'}
                  </span>
                </div>
              )}

              {dailyValuesData?.summary && (
                <div className="d-flex flex-wrap gap-2 small mb-3">
                  <span className="rounded-3 px-2 py-1 bg-light">Rows in window: {dailyValuesData.summary.rows_in_window}</span>
                  <span className="rounded-3 px-2 py-1 bg-light">Rows returned: {dailyValuesData.summary.rows_returned}</span>
                  <span className="rounded-3 px-2 py-1 bg-light">Latest row: {dailyValuesData.summary.latest_row_date || '-'}</span>
                  <span className="rounded-3 px-2 py-1 bg-light">Oldest row: {dailyValuesData.summary.oldest_row_date || '-'}</span>
                </div>
              )}

              <div className="d-flex justify-content-between align-items-center mb-2">
                <h3 className="h6 fw-semibold mb-0">Daily Value Rows</h3>
                <Button
                  size="sm"
                  variant="link"
                  className="p-0 text-decoration-none"
                  onClick={() => setDailyValuesShowMore((prev) => !prev)}
                >
                  {dailyValuesShowMore ? '<< Less fields' : 'More fields >>'}
                </Button>
              </div>
              {dailyValuesLoading ? (
                <div className="py-3 d-flex align-items-center gap-2 text-muted small">
                  <Spinner animation="border" size="sm" /> Loading daily values...
                </div>
              ) : (
                <div className="responsive-table">
                  <Table size="sm" className="mb-0 align-middle small">
                    <thead>
                      <tr>
                        <th>Date</th>
                        {!selectedId && <th>Scope</th>}
                        <th className="text-end">Price</th>
                        <th className="text-end">Current Value</th>
                        <th className="text-end">1D Change</th>
                        <th>Source</th>
                        {dailyValuesShowMore && <th className="text-end">Units</th>}
                        {dailyValuesShowMore && <th className="text-end">Invested</th>}
                        {dailyValuesShowMore && <th className="text-end">Realized</th>}
                        {dailyValuesShowMore && <th className="text-end">P/L</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {(dailyValuesData?.rows || []).length === 0 ? (
                        <tr>
                          <td colSpan={
                            selectedId
                              ? (dailyValuesShowMore ? 9 : 5)
                              : (dailyValuesShowMore ? 10 : 6)
                          } className="text-center text-muted py-3">No daily values in selected window.</td>
                        </tr>
                      ) : (
                        dailyValuesData.rows.map((row) => (
                          <tr key={row.id}>
                            <td>{row.date}</td>
                            {!selectedId && <td>{row.portfolio_id == null ? 'All portfolios' : `Portfolio ${row.portfolio_id}`}</td>}
                            <td className="text-end">{row.price_per_unit == null ? '-' : formatNumber(row.price_per_unit, 4)}</td>
                            <td className="text-end">{row.current_value == null ? '-' : formatINR(row.current_value)}</td>
                            <td className={`text-end ${profitColor(row.day_change)}`}>{row.day_change == null ? '-' : formatINR(row.day_change)}</td>
                            <td>{row.price_source || '-'}</td>
                            {dailyValuesShowMore && <td className="text-end">{row.total_units == null ? '-' : formatNumber(row.total_units, 4)}</td>}
                            {dailyValuesShowMore && <td className="text-end">{row.invested_amount == null ? '-' : formatINR(row.invested_amount)}</td>}
                            {dailyValuesShowMore && <td className="text-end">{row.realized_proceeds == null ? '-' : formatINR(row.realized_proceeds)}</td>}
                            {dailyValuesShowMore && <td className={`text-end ${profitColor(row.profit_loss)}`}>{row.profit_loss == null ? '-' : formatINR(row.profit_loss)}</td>}
                          </tr>
                        ))
                      )}
                    </tbody>
                  </Table>
                </div>
              )}
            </div>
          </Collapse>
        </Card.Body>
      </Card>

      {/* Edit Transaction Modal */}
      <Modal show={!!editTxn} onHide={() => setEditTxn(null)} centered size="lg">
        <Modal.Header closeButton>
          <Modal.Title className="h6">
            Edit {editTxn?.transaction_type?.replace(/_/g, ' ')} — {formatDate(editTxn?.transaction_date)}
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {editTxn && (
            <div className="d-flex flex-column gap-3">
              <Row className="g-3">
                {!isPPF && <Col sm={6}>
                  <Form.Group>
                    <Form.Label className="small fw-semibold">Folio</Form.Label>
                    <Form.Control
                      type="text"
                      size="sm"
                      value={editForm.folio_number}
                      onChange={(e) => setEditForm({ ...editForm, folio_number: e.target.value })}
                    />
                  </Form.Group>
                </Col>}
                <Col sm={6}>
                  <Form.Group>
                    <Form.Label className="small fw-semibold">Date</Form.Label>
                    <Form.Control
                      type="date"
                      size="sm"
                      value={editForm.transaction_date || ''}
                      onChange={(e) => setEditForm({ ...editForm, transaction_date: e.target.value })}
                    />
                  </Form.Group>
                </Col>
              </Row>
              {editTxn.transaction_type !== 'AMC' && editTxn.transaction_type !== 'ESPP_CONTRIBUTION' && !isPPF && (
                <Row className="g-3">
                  <Col sm={6}>
                    <Form.Group>
                      <Form.Label className="small fw-semibold">Units</Form.Label>
                      <Form.Control
                        type="number"
                        size="sm"
                        step="any"
                        value={editForm.units}
                        onChange={(e) => setEditForm({ ...editForm, units: e.target.value })}
                      />
                    </Form.Group>
                  </Col>
                  <Col sm={6}>
                    <Form.Group>
                      <Form.Label className="small fw-semibold">Price/Unit</Form.Label>
                      <Form.Control
                        type="number"
                        size="sm"
                        step="any"
                        value={editForm.price_per_unit}
                        onChange={(e) => setEditForm({ ...editForm, price_per_unit: e.target.value })}
                      />
                    </Form.Group>
                  </Col>
                </Row>
              )}
              <Row className="g-3">
                <Col sm={6}>
                  <Form.Group>
                    <Form.Label className="small fw-semibold">Amount</Form.Label>
                    <Form.Control
                      type="number"
                      size="sm"
                      step="any"
                      value={editForm.amount}
                      onChange={(e) => setEditForm({ ...editForm, amount: e.target.value })}
                    />
                  </Form.Group>
                </Col>
                <Col sm={6}>
                  <Form.Group>
                    <Form.Label className="small fw-semibold">Charges</Form.Label>
                    <Form.Control
                      type="number"
                      size="sm"
                      step="any"
                      value={editForm.fees}
                      onChange={(e) => setEditForm({ ...editForm, fees: e.target.value })}
                    />
                  </Form.Group>
                </Col>
              </Row>
              {isForeignUSD && editTxn?.transaction_type !== 'ESPP_CONTRIBUTION' && (
                <Row className="g-3">
                  <Col sm={6}>
                    <Form.Group>
                      <Form.Label className="small fw-semibold">RBI Rate (₹/USD)</Form.Label>
                      <Form.Control
                        type="number"
                        size="sm"
                        step="any"
                        value={editForm.exchange_rate_used}
                        onChange={(e) => setEditForm({ ...editForm, exchange_rate_used: e.target.value })}
                        placeholder="Exchange rate used"
                      />
                    </Form.Group>
                  </Col>
                  {editTxn?.transaction_type === 'ESPP_PURCHASE' && (
                    <Col sm={6}>
                      <Form.Group>
                        <Form.Label className="small fw-semibold">FMV/Unit (USD)</Form.Label>
                        <Form.Control
                          type="number"
                          size="sm"
                          step="any"
                          value={editForm.fmv_per_unit}
                          onChange={(e) => setEditForm({ ...editForm, fmv_per_unit: e.target.value })}
                          placeholder="Fair market value per share"
                        />
                      </Form.Group>
                    </Col>
                  )}
                </Row>
              )}
              <Row className="g-3">
                {!isPPF && <Col sm={6}>
                  <Form.Group>
                    <Form.Label className="small fw-semibold">Broker</Form.Label>
                    <Form.Control
                      type="text"
                      size="sm"
                      value={editForm.broker}
                      onChange={(e) => setEditForm({ ...editForm, broker: e.target.value })}
                    />
                  </Form.Group>
                </Col>}
              </Row>
              <Form.Group>
                <Form.Label className="small fw-semibold">Notes</Form.Label>
                <Form.Control
                  as="textarea"
                  size="sm"
                  rows={2}
                  value={editForm.notes}
                  onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
                />
              </Form.Group>
            </div>
          )}
        </Modal.Body>
        {hasChanges && (
          <div className="px-3 pb-2">
            <div className="small text-muted bg-light rounded p-2">
              <strong>Changes:</strong> {editChanges.join(', ')}
            </div>
          </div>
        )}
        <Modal.Footer>
          <Button variant="secondary" size="sm" onClick={() => setEditTxn(null)}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={handleEditSave} disabled={saving || !hasChanges}>
            {saving ? 'Saving...' : hasChanges ? 'Save Changes' : 'No Changes'}
          </Button>
        </Modal.Footer>
      </Modal>

      <Modal show={showInterestPreviewModal} onHide={() => setShowInterestPreviewModal(false)} centered size="lg">
        <Modal.Header closeButton>
          <Modal.Title className="h6">Interest Update Preview</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <div className="small text-muted mb-2">
            New and updated FY-end interest entries are shown below. Select exactly what you want to insert or update.
          </div>
          {interestPreviewWindow ? (
            <div className="small mb-2">
              <strong>Window:</strong> {formatDate(interestPreviewWindow.from_date)} to {formatDate(interestPreviewWindow.to_date)}
            </div>
          ) : null}
          {interestHiddenExistingCount > 0 ? (
            <div className="small mb-2 text-muted">
              {interestHiddenExistingCount} unchanged FY entries (matching both date and amount) are hidden from this list.
            </div>
          ) : null}
          <div className="responsive-table" style={{ maxHeight: 280, overflowY: 'auto' }}>
            <Table size="sm" hover className="mb-0 small">
              <thead className="table-light">
                <tr>
                  <th>
                    <Form.Check
                      type="checkbox"
                      checked={interestPreviewRows.length > 0 && interestPreviewRows.every((_, idx) => !!selectedInterestRows[idx])}
                      onChange={(e) => {
                        const next = {};
                        if (e.target.checked) interestPreviewRows.forEach((_, idx) => { next[idx] = true; });
                        setSelectedInterestRows(next);
                      }}
                    />
                  </th>
                  <th>FY</th>
                  <th>Date</th>
                  <th className="text-end">Interest Amount</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {interestPreviewRows.map((row, idx) => (
                  <tr key={`${row.fy}-${row.date}-${idx}`} className={!selectedInterestRows[idx] ? 'text-muted' : ''}>
                    <td>
                      <Form.Check
                        type="checkbox"
                        checked={!!selectedInterestRows[idx]}
                        onChange={(e) => setSelectedInterestRows({ ...selectedInterestRows, [idx]: e.target.checked })}
                      />
                    </td>
                    <td>{row.fy}</td>
                    <td>
                      {row.action === 'update' && row.existing_id && row.date !== row.existing_date ? (
                        <div style={{ fontSize: '0.9em' }}>
                          <div style={{ textDecoration: 'line-through', color: '#6c757d' }}>
                            {formatDate(row.existing_date)}
                          </div>
                          <div style={{ color: '#28a745', fontWeight: '500' }}>
                            {formatDate(row.date)}
                          </div>
                        </div>
                      ) : (
                        formatDate(row.date)
                      )}
                    </td>
                    <td className="text-end">
                      {row.action === 'update' && row.existing_id && Math.abs(Number(row.existing_amount || 0) - Number(row.amount || 0)) >= 0.005 ? (
                        <div style={{ fontSize: '0.9em' }}>
                          <div style={{ textDecoration: 'line-through', color: '#6c757d' }}>
                            ₹{formatNumber(row.existing_amount, interestPreviewDecimals)}
                          </div>
                          <div style={{ color: '#28a745', fontWeight: '500' }}>
                            ₹{formatNumber(row.amount, interestPreviewDecimals)}
                          </div>
                        </div>
                      ) : (
                        `₹${formatNumber(row.amount, interestPreviewDecimals)}`
                      )}
                    </td>
                    <td>
                      {row.action === 'insert' ? (
                        <Badge bg="success">New</Badge>
                      ) : row.action === 'update' ? (
                        <Badge bg="info">Update</Badge>
                      ) : (
                        <Badge bg="secondary">Unchanged</Badge>
                      )}
                      {row.preview_note ? (
                        <div className="small text-muted mt-1">{row.preview_note}</div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
          <div className="small mt-2">
            Selected: <strong>{interestPreviewRows.filter((_, idx) => !!selectedInterestRows[idx]).length}</strong> / {interestPreviewRows.length}
          </div>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" size="sm" onClick={() => setShowInterestPreviewModal(false)}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={handleApplySelectedInterestRows} disabled={interestUpdating}>
            {interestUpdating ? 'Applying...' : 'Apply Selected Entries'}
          </Button>
        </Modal.Footer>
      </Modal>

      <Modal show={showEsppModal} onHide={() => setShowEsppModal(false)} centered size="lg">
        <Modal.Header closeButton>
          <Modal.Title className="h6">Import ESPP Contributions</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <div className="small fw-semibold mb-2">Monthly ESPP Contributions (from payslips)</div>
          <div className="small text-muted mb-2">
            Upload yearly/monthly payslip PDFs to create monthly <strong>ESPP Contribution</strong> cash outflow entries for XIRR timing.
            Contribution date is derived from payslip pay date when available; otherwise defaults to 28th (preponed to previous working day on weekends).
          </div>
          <Row className="g-2 align-items-end mb-2">
            <Col md={7}>
              <Form.Label className="small mb-1">Payslip PDF files</Form.Label>
              <Form.Control
                type="file"
                size="sm"
                multiple
                accept=".pdf"
                onChange={(e) => {
                  const files = Array.from(e.target.files || []);
                  setEsppPayslipFiles(files);
                  setEsppContributionStatus(null);
                }}
              />
            </Col>
            <Col md={5}>
              <div className="d-flex gap-2">
                <Button size="sm" variant="outline-primary" onClick={handlePreviewEsppContributions} disabled={esppContributionLoading || !esppPayslipFiles.length}>
                  {esppContributionLoading ? 'Previewing...' : 'Preview Contributions'}
                </Button>
                <Form.Check
                  type="switch"
                  id="espp-contrib-overwrite"
                  label="Replace existing"
                  checked={esppContributionOverwrite}
                  onChange={(e) => setEsppContributionOverwrite(e.target.checked)}
                />
              </div>
            </Col>
          </Row>

          {esppContributionPreview?.rows?.length ? (
            <>
              <div className="small mb-2">
                <strong>Rows:</strong> {esppContributionPreview.rows_found || esppContributionPreview.rows.length} |{' '}
                <strong>Already Imported:</strong> {esppContributionPreview.imported_rows || 0}
              </div>
              <div className="responsive-table" style={{ maxHeight: 220, overflowY: 'auto' }}>
                <Table size="sm" hover className="mb-0 small">
                  <thead className="table-light">
                    <tr>
                      <th>Month</th>
                      <th>Date</th>
                      <th className="text-end">Amount</th>
                      <th>Source</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {esppContributionPreview.rows.map((row) => (
                      <tr key={row.import_key}>
                        <td>{row.month_key}</td>
                        <td>{formatDate(row.contribution_date)}</td>
                        <td className="text-end">₹{formatNumber(row.amount, 2)}</td>
                        <td>{row.source_file}</td>
                        <td>
                          {row.already_imported
                            ? <Badge bg="secondary">Existing</Badge>
                            : <Badge bg="success">New</Badge>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            </>
          ) : null}
          {esppContributionStatus?.text ? (
            <div className={`small mt-2 ${esppContributionStatus.type === 'danger' ? 'text-danger' : 'text-success'}`}>
              {esppContributionStatus.text}
            </div>
          ) : null}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" size="sm" onClick={() => setShowEsppModal(false)}>Close</Button>
          <Button variant="outline-primary" size="sm" onClick={handleImportEsppContributions} disabled={esppContributionImporting || !esppContributionPreview?.rows?.length}>
            {esppContributionImporting ? 'Importing Contributions...' : 'Import Contributions'}
          </Button>
        </Modal.Footer>
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal show={!!deleteConfirm} onHide={() => setDeleteConfirm(null)} centered size="sm">
        <Modal.Header closeButton>
          <Modal.Title className="h6">Delete Transaction</Modal.Title>
        </Modal.Header>
        <Modal.Body className="small">
          Are you sure you want to delete this <strong>{deleteConfirm?.transaction_type?.replace(/_/g, ' ')}</strong> transaction
          on <strong>{formatDate(deleteConfirm?.transaction_date)}</strong>
          {deleteConfirm?.amount ? <> for <strong>₹{formatNumber(deleteConfirm.amount, 2)}</strong></> : null}?
          <div className="mt-3">
            <Form.Label className="small fw-semibold">Type <span className="text-danger">DELETE</span> to confirm</Form.Label>
            <Form.Control
              size="sm"
              value={deleteText}
              onChange={(e) => setDeleteText(e.target.value)}
              placeholder="Type DELETE"
              autoFocus
            />
          </div>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" size="sm" onClick={() => setDeleteConfirm(null)}>Cancel</Button>
          <Button variant="danger" size="sm" onClick={() => handleDeleteTxn(deleteConfirm.id)} disabled={deleteText !== 'DELETE'}>Delete</Button>
        </Modal.Footer>
      </Modal>
    </div>
  );
}

function SummaryCard({ label, value, color = '' }) {
  return (
    <Card className="shadow-sm h-100">
      <Card.Body className="py-3">
        <div className="text-muted" style={{ fontSize: '0.75rem' }}>{label}</div>
        <div className={`fs-6 fw-bold ${color}`}>{value}</div>
      </Card.Body>
    </Card>
  );
}

function Detail({ label, value, color = '' }) {
  return (
    <div>
      <div className="text-muted">{label}</div>
      <div className={`fw-medium ${color}`}>{value}</div>
    </div>
  );
}
