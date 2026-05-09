import React, { useEffect, useState, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Card, Table, Spinner, Form, Modal, Button, Row, Col } from 'react-bootstrap';
import { getTransactions, getBrokers, getTransactionTypes, getInvestmentNames, getPortfolios, updateTransaction, deleteTransaction } from '../services/api';
import { formatNumber, formatDate, ASSET_TYPE_LABELS, ASSET_TYPE_COLORS } from '../utils/formatters';
import { usePortfolio } from '../context/PortfolioContext';

const TRANSACTION_TYPES_DEFAULT = [
  'BUY', 'SELL', 'DIVIDEND', 'INTEREST', 'RECONCILE', 'BONUS', 'IPO', 'AMC', 'TRANSFER',
];

// User-action types that can be edited/deleted (not corporate actions)
const EDITABLE_TYPES = ['BUY', 'SELL', 'IPO', 'AMC', 'DEPOSIT', 'WITHDRAWAL', 'TRANSFER_IN', 'TRANSFER_OUT', 'TRANSFER', 'SWITCH_IN', 'SWITCH_OUT', 'CHARGES'];

const UNIT_ADD_TYPES = ['BUY', 'IPO', 'BONUS', 'SPLIT', 'RIGHTS', 'TRANSFER_IN', 'SWITCH_IN', 'DEPOSIT', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION'];
const UNIT_SUB_TYPES = ['SELL', 'TRANSFER_OUT', 'SWITCH_OUT', 'WITHDRAWAL', 'CONSOLIDATION', 'CHARGES'];
const DEBT_LIKE_TYPES = new Set(['PPF', 'SSY', 'PF']);

const TYPE_LABELS = { EMPLOYER_CONTRIBUTION: 'EMPLOYER', VOLUNTARY_CONTRIBUTION: 'VOLUNTARY', EPS_CONTRIBUTION: 'EPS', PF_CONTRIBUTION: 'CONTRIBUTION', RECONCILE: 'RECONCILE' };
const CORPORATE_TYPES = new Set(['SPLIT', 'BONUS', 'RIGHTS', 'MERGER', 'CONSOLIDATION', 'DIVIDEND', 'INTEREST']);

function txnSortKey(t) { return CORPORATE_TYPES.has(t.transaction_type) ? 0 : 1; }

function isDebtLikeAssetType(assetType) {
  return DEBT_LIKE_TYPES.has(assetType);
}

function formatYmd(date) {
  return date.toISOString().slice(0, 10);
}

function getDurationRange(duration) {
  const today = new Date();
  const now = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (duration === 'ALL' || duration === 'CUSTOM') return { from: '', to: '' };

  if (duration === 'LAST_1_MONTH') {
    const from = new Date(now);
    from.setMonth(from.getMonth() - 1);
    return { from: formatYmd(from), to: formatYmd(now) };
  }

  if (duration === 'THIS_YEAR') {
    const from = new Date(now.getFullYear(), 0, 1);
    return { from: formatYmd(from), to: formatYmd(now) };
  }

  if (duration === 'LAST_1_YEAR') {
    const from = new Date(now);
    from.setFullYear(from.getFullYear() - 1);
    return { from: formatYmd(from), to: formatYmd(now) };
  }

  const currentFyStartYear = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  if (duration === 'THIS_FINANCIAL_YEAR') {
    const from = new Date(currentFyStartYear, 3, 1);
    return { from: formatYmd(from), to: formatYmd(now) };
  }

  if (duration === 'LAST_FINANCIAL_YEAR') {
    const from = new Date(currentFyStartYear - 1, 3, 1);
    const to = new Date(currentFyStartYear, 2, 31);
    return { from: formatYmd(from), to: formatYmd(to) };
  }

  return { from: '', to: '' };
}

function computeHoldingMap(transactions) {
  // Group by investment_id, process oldest-first to build running balance
  // Corporate actions come before regular trades on the same date
  const byInvestment = {};
  const sorted = [...transactions].sort((a, b) => a.transaction_date.localeCompare(b.transaction_date) || txnSortKey(a) - txnSortKey(b) || a.id - b.id);
  const map = {};
  for (const txn of sorted) {
    const key = txn.investment_id;
    if (!(key in byInvestment)) byInvestment[key] = 0;
    if (UNIT_ADD_TYPES.includes(txn.transaction_type)) {
      byInvestment[key] += txn.units || 0;
    } else if (UNIT_SUB_TYPES.includes(txn.transaction_type)) {
      byInvestment[key] -= txn.units || 0;
    }
    const rounded = Math.round(byInvestment[key] * 10000) / 10000;
    map[txn.id] = rounded === 0 ? 0 : rounded; // avoid -0
  }
  return map;
}

const TYPE_BADGE = {
  BUY: 'badge-buy',
  DEPOSIT: 'badge-deposit',
  IPO: 'badge-ipo',
  TRANSFER_IN: 'badge-buy',
  BONUS: 'badge-bonus',
  RIGHTS: 'badge-bonus',
  SPLIT: 'badge-split',
  DIVIDEND: 'badge-dividend',
  INTEREST: 'badge-interest',
  RECONCILE: 'badge-interest',
  MERGER: 'badge-merger',
  CONSOLIDATION: 'badge-merger',
  SELL: 'badge-sell',
  WITHDRAWAL: 'badge-withdrawal',
  TRANSFER_OUT: 'badge-sell',
  SWITCH_IN: 'badge-buy',
  SWITCH_OUT: 'badge-sell',
  TRANSFER: 'badge-merger',
  AMC: 'badge-charges',
  CHARGES: 'badge-charges',
  EMPLOYER_CONTRIBUTION: 'badge-buy',
  VOLUNTARY_CONTRIBUTION: 'badge-buy',
  EPS_CONTRIBUTION: 'badge-interest',
  PF_CONTRIBUTION: 'badge-buy',
};

export default function Transactions() {
  const [searchParams, setSearchParams] = useSearchParams();
  const isInitialLoad = useRef(true);
  const { selectedId, selectedIds } = usePortfolio();
  const [transactions, setTransactions] = useState([]);
  const [totalTransactions, setTotalTransactions] = useState(0);
  const [portfolioMeta, setPortfolioMeta] = useState({});
  const [brokers, setBrokers] = useState([]);
  const [transactionTypes, setTransactionTypes] = useState(TRANSACTION_TYPES_DEFAULT);
  const [investmentNames, setInvestmentNames] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterType, setFilterType] = useState(() => {
    const v = searchParams.get('type');
    return v ? v.split(',') : [];
  });
  const [filterBroker, setFilterBroker] = useState(() => searchParams.get('broker') || '');
  const [filterInvestment, setFilterInvestment] = useState(() => searchParams.get('investment') || '');
  const [filterDuration, setFilterDuration] = useState(() => {
    const v = searchParams.get('duration');
    if (v) return v;
    return searchParams.get('from') || searchParams.get('to') ? 'CUSTOM' : 'ALL';
  });
  const [filterStartDate, setFilterStartDate] = useState(() => searchParams.get('from') || '');
  const [filterEndDate, setFilterEndDate] = useState(() => searchParams.get('to') || '');
  const [typeDropdownOpen, setTypeDropdownOpen] = useState(false);
  const typeDropdownRef = useRef(null);
  const [pageByType, setPageByType] = useState({});
  const [pageSizeByType, setPageSizeByType] = useState({});

  // Sync filter/pagination state → URL search params
  useEffect(() => {
    const params = new URLSearchParams();
    if (filterType.length) params.set('type', filterType.join(','));
    if (filterBroker) params.set('broker', filterBroker);
    if (filterInvestment) params.set('investment', filterInvestment);
    if (filterDuration !== 'ALL') params.set('duration', filterDuration);
    if (filterStartDate) params.set('from', filterStartDate);
    if (filterEndDate) params.set('to', filterEndDate);
    setSearchParams(params, { replace: true });
  }, [filterType, filterBroker, filterInvestment, filterDuration, filterStartDate, filterEndDate]);

  // Save scroll position before unload / navigation
  useEffect(() => {
    const saveScroll = () => sessionStorage.setItem('txn_scrollY', String(window.scrollY));
    window.addEventListener('beforeunload', saveScroll);
    return () => {
      saveScroll();
      window.removeEventListener('beforeunload', saveScroll);
    };
  }, []);

  // Restore scroll position after initial data load
  useEffect(() => {
    if (!loading && isInitialLoad.current) {
      isInitialLoad.current = false;
      const saved = sessionStorage.getItem('txn_scrollY');
      if (saved != null) {
        // Use requestAnimationFrame to ensure DOM has rendered
        requestAnimationFrame(() => window.scrollTo(0, parseInt(saved, 10)));
        sessionStorage.removeItem('txn_scrollY');
      }
    }
  }, [loading]);

  // Edit/Delete state
  const [editTxn, setEditTxn] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [deleteText, setDeleteText] = useState('');

  // Compute which fields changed in edit form
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
    return changes;
  };
  const editChanges = getChanges();
  const hasChanges = editChanges.length > 0;

  const handleEdit = (txn) => {
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
      });
      setEditTxn(null);
      loadTransactions();
    } catch (e) {
      alert('Failed to update: ' + e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id) => {
    try {
      await deleteTransaction(id);
      setDeleteConfirm(null);
      loadTransactions();
    } catch (e) {
      alert('Failed to delete: ' + e.message);
    }
  };

  useEffect(() => {
    getPortfolios().then((rows) => {
      const map = {};
      for (const p of rows || []) {
        map[p.id] = { name: p.name, color: p.color };
      }
      setPortfolioMeta(map);
    }).catch(() => {});
  }, []);

  // Load brokers based on selected portfolio and active filters
  useEffect(() => {
    const params = {};
    if (filterType.length) params.type = filterType.join(',');
    if (filterInvestment) params.investment_name = filterInvestment;
    if (filterStartDate) params.from = filterStartDate;
    if (filterEndDate) params.to = filterEndDate;

    const load = async () => {
      try {
        let values = [];
        if (selectedIds.length > 1) {
          const lists = await Promise.all(selectedIds.map((id) => getBrokers({ ...params, portfolio_id: id })));
          values = Array.from(new Set(lists.flat())).sort((a, b) => String(a).localeCompare(String(b)));
        } else {
          if (selectedId) params.portfolio_id = selectedId;
          values = await getBrokers(params);
        }
        setBrokers(values);
        setFilterBroker((prev) => values.includes(prev) ? prev : '');
      } catch (_) {
        // ignore filter metadata fetch errors
      }
    };

    load();
  }, [selectedId, selectedIds, filterType, filterInvestment, filterStartDate, filterEndDate]);

  // Load transaction types based on selected portfolio and active filters
  useEffect(() => {
    const load = async () => {
      try {
        let types = [];
        if (selectedIds.length > 1) {
          const lists = await Promise.all(selectedIds.map((id) => getTransactionTypes({ portfolio_id: id })));
          types = Array.from(new Set(lists.flat()));
        } else {
          const params = {};
          if (selectedId) params.portfolio_id = selectedId;
          types = await getTransactionTypes(params);
        }

        const effectiveTypes = types.length ? types : TRANSACTION_TYPES_DEFAULT;
        setTransactionTypes(effectiveTypes);
        // Clear any selected types that aren't available in the new list
        setFilterType(prev => {
          const next = prev.filter(t => effectiveTypes.includes(t));
          return next.length === prev.length ? prev : next;
        });
      } catch (_) {
        // ignore filter metadata fetch errors
      }
    };

    load();
  }, [selectedId, selectedIds]);

  // Close type dropdown on outside click
  useEffect(() => {
    const handleClick = (e) => {
      if (typeDropdownRef.current && !typeDropdownRef.current.contains(e.target)) {
        setTypeDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  useEffect(() => {
    const params = {};
    if (filterType.length) params.type = filterType.join(',');
    if (filterBroker) params.broker = filterBroker;
    if (filterStartDate) params.from = filterStartDate;
    if (filterEndDate) params.to = filterEndDate;

    const load = async () => {
      try {
        let names = [];
        if (selectedIds.length > 1) {
          const lists = await Promise.all(selectedIds.map((id) => getInvestmentNames({ ...params, portfolio_id: id })));
          names = Array.from(new Set(lists.flat())).sort((a, b) => String(a).localeCompare(String(b)));
        } else {
          if (selectedId) params.portfolio_id = selectedId;
          names = await getInvestmentNames(params);
        }
        setInvestmentNames(names);
        setFilterInvestment(prev => names.includes(prev) ? prev : '');
      } catch (_) {
        // ignore filter metadata fetch errors
      }
    };

    load();
  }, [selectedId, selectedIds, filterType, filterBroker, filterStartDate, filterEndDate]);

  useEffect(() => {
    loadTransactions();
  }, [selectedId, selectedIds, filterType, filterBroker, filterInvestment, filterStartDate, filterEndDate]);

  const loadTransactions = async () => {
    try {
      setLoading(true);
      const params = {};
      if (filterType.length) params.type = filterType.join(',');
      if (filterBroker) params.broker = filterBroker;
      if (filterInvestment) params.investment_name = filterInvestment;
      if (filterStartDate) params.from = filterStartDate;
      if (filterEndDate) params.to = filterEndDate;
      params.group_pf = '1';

      if (selectedIds.length > 1) {
        const results = await Promise.all(
          selectedIds.map((id) => getTransactions({ ...params, portfolio_id: id }))
        );
        const mergedMap = new Map();
        for (const result of results) {
          const items = Array.isArray(result) ? result : (result.items || []);
          for (const row of items) {
            if (!mergedMap.has(row.id)) mergedMap.set(row.id, row);
          }
        }
        const merged = Array.from(mergedMap.values()).sort((a, b) => {
          const dateCmp = String(b.transaction_date || '').localeCompare(String(a.transaction_date || ''));
          if (dateCmp !== 0) return dateCmp;
          return (b.id || 0) - (a.id || 0);
        });
        setTransactions(merged);
        setTotalTransactions(merged.length);
      } else {
        if (selectedId) params.portfolio_id = selectedId;
        const result = await getTransactions(params);
        if (Array.isArray(result)) {
          setTransactions(result);
          setTotalTransactions(result.length);
        } else {
          setTransactions(result.items || []);
          setTotalTransactions(result.total || 0);
        }
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const resetPage = () => setPageByType({});

  const holdingMap = computeHoldingMap(transactions);

  // Compute running balance map for debt-like assets (PPF/SSY/PF)
  const balanceMap = {};
  const byInvestment = {};
  const sorted = [...transactions].sort((a, b) => a.transaction_date.localeCompare(b.transaction_date) || a.id - b.id);
  for (const txn of sorted) {
    const key = txn.investment_id;
    if (!(key in byInvestment)) byInvestment[key] = 0;
    if (txn.transaction_type === 'PF_CONTRIBUTION') {
      // EPS portion not included — it goes to pension, not the withdrawable PF corpus
      byInvestment[key] += (txn.employee_amount || 0) + (txn.employer_amount || 0);
    } else if (['DEPOSIT', 'INTEREST', 'EMPLOYER_CONTRIBUTION', 'VOLUNTARY_CONTRIBUTION'].includes(txn.transaction_type)) {
      byInvestment[key] += txn.amount || 0;
    } else if (txn.transaction_type === 'WITHDRAWAL') {
      byInvestment[key] -= txn.amount || 0;
    }
    balanceMap[txn.id] = byInvestment[key];
  }

  const groupedTransactions = transactions.reduce((acc, txn) => {
    const key = txn.asset_type || 'OTHER';
    if (!acc[key]) acc[key] = [];
    acc[key].push(txn);
    return acc;
  }, {});

  const groupedTotals = transactions.reduce((acc, txn) => {
    const key = txn.asset_type || 'OTHER';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  const groupedAssetTypes = Object.keys(groupedTotals).sort((a, b) => {
    const labelA = ASSET_TYPE_LABELS[a] || a;
    const labelB = ASSET_TYPE_LABELS[b] || b;
    return labelA.localeCompare(labelB);
  });

  const visibleGroupedAssetTypes = Object.keys(groupedTransactions).sort((a, b) => {
    const labelA = ASSET_TYPE_LABELS[a] || a;
    const labelB = ASSET_TYPE_LABELS[b] || b;
    return labelA.localeCompare(labelB);
  });

  useEffect(() => {
    // Keep per-type page numbers in valid bounds after filtering/data changes.
    setPageByType((prev) => {
      let changed = false;
      const next = {};
      for (const type of visibleGroupedAssetTypes) {
        const size = pageSizeByType[type] || 25;
        const total = groupedTransactions[type]?.length || 0;
        const pages = Math.max(1, Math.ceil(total / size));
        const page = Math.min(prev[type] || 1, pages);
        next[type] = page;
        if (page !== (prev[type] || 1)) changed = true;
      }
      const prevKeys = Object.keys(prev);
      if (prevKeys.length !== Object.keys(next).length) changed = true;
      return changed ? next : prev;
    });
  }, [visibleGroupedAssetTypes, groupedTransactions, pageSizeByType]);

  const handleDurationChange = (value) => {
    setFilterDuration(value);
    resetPage();
    if (value === 'CUSTOM') return;
    const range = getDurationRange(value);
    setFilterStartDate(range.from);
    setFilterEndDate(range.to);
  };

  const jumpToAssetType = (type) => {
    const el = document.getElementById(`section-txn-${type}`);
    if (!el) return;
    const stickyHeader = document.querySelector('[data-txn-sticky-header="1"]');
    const appNavHeight = 56;
    const stickyHeight = stickyHeader ? stickyHeader.getBoundingClientRect().height : 120;
    const stickyOffset = appNavHeight + stickyHeight + 8;
    const top = el.getBoundingClientRect().top + window.scrollY - stickyOffset;
    window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  };

  const isEditingDebtLike = editTxn ? isDebtLikeAssetType(editTxn.asset_type) : false;

  return (
    <div className="d-flex flex-column gap-3">
      <div data-txn-sticky-header="1" style={{ position: 'sticky', top: 56, zIndex: 10, backgroundColor: '#f8f9fa', paddingBottom: '0.5rem', marginTop: '-0.5rem', paddingTop: '0.5rem' }}
        className="d-flex flex-column gap-3"
      >
      <div className="d-flex align-items-center justify-content-between">
        <h1 className="h4 fw-bold mb-0">Transactions</h1>
        <span className="d-flex align-items-center gap-2 small text-muted">
          {totalTransactions} transaction{totalTransactions !== 1 ? 's' : ''}
          <button
            onClick={loadTransactions}
            disabled={loading}
            className="btn btn-outline-secondary btn-sm d-inline-flex align-items-center justify-content-center p-0"
            style={{ width: 28, height: 28 }}
            title="Refresh transactions"
          >
            <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"
              className={loading ? 'spin' : ''}
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M4 4v5h5M20 20v-5h-5M4.93 9a8 8 0 0113.14-2.07L20 9M19.07 15a8 8 0 01-13.14 2.07L4 15"
              />
            </svg>
          </button>
        </span>
      </div>

      {/* Filter bar */}
      <div className="d-flex flex-wrap align-items-center gap-2">
        <div className="d-flex align-items-center gap-2 position-relative" ref={typeDropdownRef}>
          <label className="small fw-semibold text-muted text-uppercase">Type</label>
          <button
            onClick={() => setTypeDropdownOpen(!typeDropdownOpen)}
            className="btn btn-outline-secondary btn-sm d-flex align-items-center gap-1"
            style={{ minWidth: 120 }}
          >
            {filterType.length === 0 ? (
              <span>All Types</span>
            ) : (
              <span className="d-flex flex-wrap gap-1">
                {filterType.map(t => (
                  <span key={t} className={`badge ${TYPE_BADGE[t] || 'bg-secondary text-white'} d-inline-flex align-items-center`}>
                    {t.replace(/_/g, ' ')}
                    <button
                      onClick={(e) => { e.stopPropagation(); setFilterType(filterType.filter(x => x !== t)); resetPage(); }}
                      className="btn-close btn-close-white ms-1"
                      style={{ fontSize: '0.5rem' }}
                    />
                  </span>
                ))}
              </span>
            )}
            <svg className="ms-auto flex-shrink-0" width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {typeDropdownOpen && (
            <div className="position-absolute top-100 start-0 mt-1 bg-white border rounded shadow-lg py-1" style={{ zIndex: 20, minWidth: 160 }}>
              {transactionTypes.map(t => {
                const selected = filterType.includes(t);
                return (
                  <button
                    key={t}
                    onClick={() => {
                      setFilterType(selected ? filterType.filter(x => x !== t) : [...filterType, t]);
                      resetPage();
                    }}
                    className={`d-flex align-items-center gap-2 w-100 text-start px-3 py-1 small border-0 bg-transparent ${selected ? 'fw-semibold' : ''}`}
                    style={{ cursor: 'pointer' }}
                    onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#f8f9fa'}
                    onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                  >
                    <span
                      className="d-inline-flex align-items-center justify-content-center rounded border"
                      style={{
                        width: 16, height: 16, fontSize: '0.65rem',
                        ...(selected ? { backgroundColor: '#0d6efd', borderColor: '#0d6efd', color: '#fff' } : { borderColor: '#dee2e6' })
                      }}
                    >
                      {selected && '✓'}
                    </span>
                    <span className={`badge ${TYPE_BADGE[t] || 'bg-secondary text-white'}`}>
                      {t.replace(/_/g, ' ')}
                    </span>
                  </button>
                );
              })}
              {filterType.length > 0 && (
                <>
                  <hr className="my-1" />
                  <button
                    onClick={() => { setFilterType([]); setTypeDropdownOpen(false); resetPage(); }}
                    className="w-100 text-start px-3 py-1 small text-muted border-0 bg-transparent"
                    style={{ cursor: 'pointer' }}
                    onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#f8f9fa'}
                    onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                  >
                    Clear selection
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        <div className="d-flex align-items-center gap-2">
          <label className="small fw-semibold text-muted text-uppercase">Investment</label>
          <Form.Select
            size="sm"
            value={filterInvestment}
              onChange={(e) => { setFilterInvestment(e.target.value); resetPage(); }}
            style={{ maxWidth: 190 }}
          >
            <option value="">All Investments</option>
            {investmentNames.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </Form.Select>
        </div>

        {brokers.length > 0 && (
          <div className="d-flex align-items-center gap-2">
            <label className="small fw-semibold text-muted text-uppercase">Broker</label>
            <Form.Select
              size="sm"
              value={filterBroker}
              onChange={(e) => { setFilterBroker(e.target.value); resetPage(); }}
              style={{ width: 130 }}
            >
              <option value="">All Brokers</option>
              {brokers.map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
            </Form.Select>
          </div>
        )}

        <div className="d-flex align-items-center gap-2" style={{ whiteSpace: 'nowrap' }}>
          <label className="small fw-semibold text-muted text-uppercase">Duration</label>
          <Form.Select
            size="sm"
            value={filterDuration}
            onChange={(e) => handleDurationChange(e.target.value)}
            style={{ width: 180 }}
          >
            <option value="ALL">All Time</option>
            <option value="LAST_1_MONTH">1 Month</option>
            <option value="LAST_FINANCIAL_YEAR">Last Financial Year</option>
            <option value="THIS_FINANCIAL_YEAR">This Financial Year</option>
            <option value="THIS_YEAR">This Year</option>
            <option value="LAST_1_YEAR">Last 1 Year</option>
            <option value="CUSTOM">Custom</option>
          </Form.Select>

          {filterDuration === 'CUSTOM' && (
            <>
              <Form.Control
                type="date"
                size="sm"
                value={filterStartDate}
                onChange={(e) => { setFilterStartDate(e.target.value); resetPage(); }}
                style={{ width: 126 }}
                placeholder="From"
              />
              <span className="text-muted small">to</span>
              <Form.Control
                type="date"
                size="sm"
                value={filterEndDate}
                onChange={(e) => { setFilterEndDate(e.target.value); resetPage(); }}
                style={{ width: 126 }}
                placeholder="To"
              />
            </>
          )}
        </div>

        {(filterType.length > 0 || filterBroker || filterInvestment || filterDuration !== 'ALL' || filterStartDate || filterEndDate) && (
          <button
            onClick={() => {
              setFilterType([]);
              setFilterBroker('');
              setFilterInvestment('');
              setFilterDuration('ALL');
              setFilterStartDate('');
              setFilterEndDate('');
              resetPage();
            }}
            className="btn btn-link btn-sm text-muted text-decoration-underline p-0"
          >
            Clear filters
          </button>
        )}
      </div>

      {!loading && groupedAssetTypes.length > 1 && (
        <div className="d-flex align-items-center gap-2 flex-nowrap overflow-auto pb-1">
          <span className="small fw-semibold text-muted text-uppercase flex-shrink-0">Navigate</span>
          {groupedAssetTypes.map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => jumpToAssetType(type)}
              className="text-decoration-none px-2 py-1 rounded border bg-white small flex-shrink-0"
              style={{ borderLeft: `4px solid ${ASSET_TYPE_COLORS[type] || '#6c757d'}` }}
            >
              <span className="fw-semibold" style={{ color: ASSET_TYPE_COLORS[type] || '#495057' }}>
                {ASSET_TYPE_LABELS[type] || type}
              </span>
              <span className="ms-1 text-muted">{groupedTotals[type] || 0}</span>
            </button>
          ))}
        </div>
      )}

      </div>

      {loading ? (
        <Card className="shadow-sm">
          <div className="d-flex justify-content-center py-5">
            <Spinner animation="border" variant="primary" />
          </div>
        </Card>
      ) : totalTransactions === 0 ? (
        <Card className="shadow-sm">
          <div className="p-5 text-center text-muted">
            <p>No transactions found.</p>
            {(filterType.length > 0 || filterBroker || filterInvestment || filterDuration !== 'ALL' || filterStartDate || filterEndDate) ? (
              <button onClick={() => {
                setFilterType([]);
                setFilterBroker('');
                setFilterInvestment('');
                setFilterDuration('ALL');
                setFilterStartDate('');
                setFilterEndDate('');
                resetPage();
              }}
                className="btn btn-link text-primary mt-2">
                Clear filters
              </button>
            ) : (
              <Link to="/investments/add" className="btn btn-link text-primary mt-2">
                Add your first investment
              </Link>
            )}
          </div>
        </Card>
      ) : (
        <>
          {visibleGroupedAssetTypes.map((type) => {
            const allTxns = groupedTransactions[type] || [];
            const isDebtLike = isDebtLikeAssetType(type);
            const isPf = type === 'PF';
            const totalForType = groupedTotals[type] || allTxns.length;
            const sectionPageSize = pageSizeByType[type] || 25;
            const sectionTotalPages = Math.max(1, Math.ceil(allTxns.length / sectionPageSize));
            const sectionCurrentPage = Math.min(pageByType[type] || 1, sectionTotalPages);
            const sectionStart = (sectionCurrentPage - 1) * sectionPageSize;
            const sectionEnd = sectionStart + sectionPageSize;
            const txns = allTxns.slice(sectionStart, sectionEnd);
            return (
              <Card key={type} id={`section-txn-${type}`} className="shadow-sm">
                <Card.Header className="bg-white d-flex justify-content-between align-items-center">
                  <h2 className="h6 fw-semibold mb-0">{ASSET_TYPE_LABELS[type] || type}</h2>
                  <span className="small text-muted">
                    {txns.length}
                    {totalForType !== txns.length ? ` / ${totalForType}` : ''}
                    {' '}transaction{totalForType !== 1 ? 's' : ''}
                  </span>
                </Card.Header>
                <div className="responsive-table">
                  <Table hover size="sm" className="mb-0 small">
                    <thead className="table-light">
                      <tr>
                        <th className="px-3 py-2">Date</th>
                        <th className="px-3 py-2">Investment</th>
                        <th className="px-3 py-2">Type</th>
                        {!isDebtLike && <th className="px-3 py-2 text-end">Units</th>}
                        {!isDebtLike && <th className="px-3 py-2 text-end">Price/Unit</th>}
                        {isPf ? (
                          <><th className="px-3 py-2 text-end">Employee</th><th className="px-3 py-2 text-end">Employer</th><th className="px-3 py-2 text-end">EPS</th><th className="px-3 py-2 text-end">Total</th></>
                        ) : (
                          <th className="px-3 py-2 text-end">Amount</th>
                        )}
                        {!isDebtLike && <th className="px-3 py-2 text-end">Fees</th>}
                        {isDebtLike ? <th className="px-3 py-2 text-end">Balance</th> : <th className="px-3 py-2 text-end">Holding</th>}
                        {!isDebtLike && <th className="px-3 py-2">Broker</th>}
                        <th className="px-3 py-2">Notes</th>
                        <th className="px-3 py-2 text-center" style={{ width: 80 }}>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {txns.map((txn) => (
                        <tr key={txn.id}>
                          <td className="px-3 py-2 text-nowrap">{formatDate(txn.transaction_date)}</td>
                          <td className="px-3 py-2">
                            <div className="d-flex align-items-center gap-2">
                              <Link to={`/investments/${txn.investment_id}`} state={{ from: 'transactions', transactionsSearch: window.location.search }} className="text-primary fw-medium text-decoration-none">
                                {txn.investment_name}
                              </Link>
                              {(selectedIds.length !== 1) && txn.portfolio_name && (
                                <span
                                  title={(portfolioMeta[txn.portfolio_id]?.name || txn.portfolio_name || 'Portfolio')}
                                  aria-label={(portfolioMeta[txn.portfolio_id]?.name || txn.portfolio_name || 'Portfolio')}
                                  style={{
                                    width: 10,
                                    height: 10,
                                    borderRadius: '50%',
                                    display: 'inline-block',
                                    backgroundColor: portfolioMeta[txn.portfolio_id]?.color || txn.portfolio_color || '#6c757d',
                                    border: '1px solid rgba(0,0,0,0.15)',
                                    cursor: 'help',
                                    flexShrink: 0
                                  }}
                                >
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-3 py-2">
                            <span className={`badge ${TYPE_BADGE[txn.transaction_type] || 'bg-secondary text-white'}`}>
                              {TYPE_LABELS[txn.transaction_type] || txn.transaction_type.replace(/_/g, ' ')}
                            </span>
                          </td>
                          {!isDebtLike && <td className="px-3 py-2 text-end">{txn.units ? formatNumber(txn.units, 4) : '-'}</td>}
                          {!isDebtLike && <td className="px-3 py-2 text-end">{txn.price_per_unit ? `₹${formatNumber(txn.price_per_unit, 2)}` : '-'}</td>}
                          {isPf ? (
                            <>
                              <td className="px-3 py-2 text-end">{txn.employee_amount != null ? `₹${formatNumber(txn.employee_amount, 2)}` : '-'}</td>
                              <td className="px-3 py-2 text-end">{txn.employer_amount != null ? `₹${formatNumber(txn.employer_amount, 2)}` : '-'}</td>
                              <td className="px-3 py-2 text-end text-muted">{txn.eps_amount > 0 ? `₹${formatNumber(txn.eps_amount, 2)}` : '-'}</td>
                              <td className="px-3 py-2 text-end fw-medium">₹{formatNumber(txn.amount, 2)}</td>
                            </>
                          ) : (
                            <td className="px-3 py-2 text-end fw-medium">₹{formatNumber(txn.amount, 2)}</td>
                          )}
                          {!isDebtLike && <td className="px-3 py-2 text-end text-muted">{txn.fees ? `₹${formatNumber(txn.fees, 2)}` : '-'}</td>}
                          {isDebtLike
                            ? <td className="px-3 py-2 text-end fw-medium">₹{formatNumber(balanceMap[txn.id], 2)}</td>
                            : <td className="px-3 py-2 text-end">{holdingMap[txn.id] != null ? formatNumber(holdingMap[txn.id], 4) : '-'}</td>}
                          {!isDebtLike && <td className="px-3 py-2 text-muted" style={{ fontSize: '0.75rem' }}>{txn.broker || '-'}</td>}
                          <td className="px-3 py-2 text-muted text-truncate" style={{ maxWidth: 150 }} title={txn.notes || ''}>{txn.notes || '-'}</td>
                          <td className="px-3 py-2 text-center">
                            {EDITABLE_TYPES.includes(txn.transaction_type) && (
                              <div className="d-flex justify-content-center gap-1 row-actions">
                                <button
                                  className="btn btn-link btn-sm p-0 text-primary"
                                  title="Edit"
                                  onClick={() => handleEdit(txn)}
                                >
                                  <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                                  </svg>
                                </button>
                                <button
                                  className="btn btn-link btn-sm p-0 text-danger"
                                  title="Delete"
                                  onClick={() => { setDeleteConfirm(txn); setDeleteText(''); }}
                                >
                                  <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                  </svg>
                                </button>
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </div>
                <div className="d-flex align-items-center justify-content-between px-3 py-2 border-top small">
                  <div className="d-flex align-items-center gap-2">
                    <span className="text-muted">Rows per page:</span>
                    <Form.Select
                      size="sm"
                      value={sectionPageSize}
                      onChange={(e) => {
                        const nextSize = Number(e.target.value);
                        setPageSizeByType((prev) => ({ ...prev, [type]: nextSize }));
                        setPageByType((prev) => ({ ...prev, [type]: 1 }));
                      }}
                      style={{ width: 'auto' }}
                    >
                      {[10, 25, 50, 100].map(n => (
                        <option key={n} value={n}>{n}</option>
                      ))}
                    </Form.Select>
                  </div>
                  <div className="d-flex align-items-center gap-2">
                    <span className="text-muted">
                      {sectionStart + 1}–{Math.min(sectionEnd, totalForType)} of {totalForType}
                    </span>
                    <Button
                      variant="outline-secondary"
                      size="sm"
                      disabled={sectionCurrentPage <= 1}
                      onClick={() => setPageByType((prev) => ({ ...prev, [type]: Math.max(1, (prev[type] || 1) - 1) }))}
                    >
                      ‹ Prev
                    </Button>
                    <span className="d-flex align-items-center gap-1 text-muted">
                      Page
                      <Form.Control
                        type="number"
                        size="sm"
                        min={1}
                        max={sectionTotalPages}
                        value={sectionCurrentPage}
                        onChange={(e) => {
                          const val = parseInt(e.target.value, 10);
                          if (val >= 1 && val <= sectionTotalPages) {
                            setPageByType((prev) => ({ ...prev, [type]: val }));
                          }
                        }}
                        style={{ width: 54, textAlign: 'center' }}
                      />
                      of {sectionTotalPages}
                    </span>
                    <Button
                      variant="outline-secondary"
                      size="sm"
                      disabled={sectionCurrentPage >= sectionTotalPages}
                      onClick={() => setPageByType((prev) => ({ ...prev, [type]: Math.min(sectionTotalPages, (prev[type] || 1) + 1) }))}
                    >
                      Next ›
                    </Button>
                  </div>
                </div>
              </Card>
            );
          })}
        </>
      )}


      {/* Edit Modal */}
      <Modal show={!!editTxn} onHide={() => setEditTxn(null)} centered size="lg">
        <Modal.Header closeButton>
          <Modal.Title className="h6">
            Edit {editTxn?.transaction_type?.replace(/_/g, ' ')} — {editTxn?.investment_name}
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {editTxn && (
            <div className="d-flex flex-column gap-3">
              <Row className="g-3">
                {!isEditingDebtLike && <Col sm={6}>
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
              {editTxn.transaction_type !== 'AMC' && !isEditingDebtLike && (
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
                {!isEditingDebtLike && <Col sm={6}>
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
                </Col>}
              </Row>
              {!isEditingDebtLike && <Row className="g-3">
                <Col sm={6}>
                  <Form.Group>
                    <Form.Label className="small fw-semibold">Broker</Form.Label>
                    <Form.Control
                      type="text"
                      size="sm"
                      value={editForm.broker}
                      onChange={(e) => setEditForm({ ...editForm, broker: e.target.value })}
                    />
                  </Form.Group>
                </Col>
              </Row>}
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

      {/* Delete Confirmation Modal */}
      <Modal show={!!deleteConfirm} onHide={() => setDeleteConfirm(null)} centered size="sm">
        <Modal.Header closeButton>
          <Modal.Title className="h6">Delete Transaction</Modal.Title>
        </Modal.Header>
        <Modal.Body className="small">
          Are you sure you want to delete this <strong>{deleteConfirm?.transaction_type}</strong> transaction
          for <strong>{deleteConfirm?.investment_name}</strong> on <strong>{formatDate(deleteConfirm?.transaction_date)}</strong>
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
          <Button variant="danger" size="sm" onClick={() => handleDelete(deleteConfirm.id)} disabled={deleteText !== 'DELETE'}>Delete</Button>
        </Modal.Footer>
      </Modal>
    </div>
  );
}
