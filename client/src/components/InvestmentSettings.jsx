import React, { useEffect, useState, useCallback } from 'react';
import { useParams, Link, useLocation } from 'react-router-dom';
import { Card, Form, Button, Row, Col, Spinner, Alert, Table, Collapse } from 'react-bootstrap';
import {
  getInvestment,
  updateInvestment,
  getInvestmentSymbolHistory,
  createInvestmentSymbolHistory,
  updateInvestmentSymbolHistory,
  deleteInvestmentSymbolHistory,
  getInvestmentHistoricalPrices,
  getInvestmentFxRateCache,
  getInvestments,
} from '../services/api';
import { ArrowLeft, Save } from 'lucide-react';
import { ASSET_TYPE_LABELS, formatNumber } from '../utils/formatters';
import CollapsibleSectionHeader from './CollapsibleSectionHeader';

const MARKET_DRIVEN_ASSET_TYPES = new Set(['INDIAN_STOCK', 'FOREIGN_STOCK', 'MUTUAL_FUND', 'NPS', 'SGB', 'BOND']);

function normalizeTickerForAssetType(input, assetType) {
  const raw = String(input || '').trim().toUpperCase();
  if (!raw) return null;
  const type = String(assetType || '').toUpperCase();
  if (type === 'INDIAN_STOCK') {
    return raw.includes('.') ? raw : `${raw}.NS`;
  }
  if (type === 'FOREIGN_STOCK') {
    return raw.replace(/\.(NS|BO)$/i, '');
  }
  return raw;
}

function addDaysIso(date, days) {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}

function minIsoDate(a, b) {
  return a <= b ? a : b;
}

function isValidIsoDate(date) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(date || ''));
}

function calculateFxRateCacheDateRangeFromInvestments(investments = []) {
  const today = new Date().toISOString().slice(0, 10);
  const fsInvestments = (investments || []).filter(
    (inv) => String(inv?.asset_type || '').toUpperCase() === 'FOREIGN_STOCK'
  );

  if (!fsInvestments.length) {
    return { from: addDaysIso(today, -365), to: today, page: 1, pageSize: 365 };
  }

  const globalStarts = [];
  const globalEnds = [];

  for (const inv of fsInvestments) {
    const txns = Array.isArray(inv?.transactions) ? inv.transactions : [];
    const datedTxns = txns
      .map((txn) => ({
        date: String(txn?.transaction_date || '').slice(0, 10),
        type: String(txn?.transaction_type || '').toUpperCase(),
        units: Number(txn?.units || 0),
      }))
      .filter((txn) => isValidIsoDate(txn.date))
      .sort((a, b) => a.date.localeCompare(b.date));

    if (!datedTxns.length) continue;
    globalStarts.push(datedTxns[0].date);

    let runningUnits = 0;
    let latestExitDate = null;

    for (const txn of datedTxns) {
      if (txn.type === 'BUY' || txn.type === 'BONUS' || txn.type === 'RIGHTS' || txn.type === 'IPO' || txn.type === 'TRANSFER_IN' || txn.type === 'SPLIT' || txn.type === 'VEST' || txn.type === 'ESPP_PURCHASE') {
        runningUnits += txn.units;
      } else if (txn.type === 'SELL' || txn.type === 'REDEMPTION' || txn.type === 'TRANSFER_OUT') {
        runningUnits -= txn.units;
      }

      if (runningUnits <= 1e-6) {
        latestExitDate = txn.date;
      }
    }

    const investmentEndDate = runningUnits > 1e-6
      ? today
      : (latestExitDate && latestExitDate < today ? latestExitDate : today);
    globalEnds.push(investmentEndDate);
  }

  const from = globalStarts.length ? globalStarts.sort()[0] : addDaysIso(today, -365);
  const to = globalEnds.length ? globalEnds.sort().slice(-1)[0] : today;
  return { from, to, page: 1, pageSize: 365 };
}

function historyDefaultFilters(investment = null) {
  const today = new Date().toISOString().slice(0, 10);
  const latestExistingDate = String(investment?.latestValue?.date || '').slice(0, 10);
  const to = /^\d{4}-\d{2}-\d{2}$/.test(latestExistingDate)
    ? minIsoDate(latestExistingDate, today)
    : today;

  const earliestTxnDate = (investment?.transactions || [])
    .map((txn) => String(txn?.transaction_date || '').slice(0, 10))
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
    .sort()[0];

  const from = earliestTxnDate || addDaysIso(to, -365);
  return { from, to, page: 1, pageSize: 365 };
}

export default function InvestmentSettings() {
  const { id } = useParams();
  const location = useLocation();
  const cameFrom = location.state?.from;
  const transactionsSearch = location.state?.transactionsSearch || '';
  const investmentsSearch = location.state?.investmentsSearch || '';
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState(null);
  const [historyRows, setHistoryRows] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historySaving, setHistorySaving] = useState(false);
  const [historyError, setHistoryError] = useState(null);
  const [historySuccess, setHistorySuccess] = useState('');
  const [isAddingHistory, setIsAddingHistory] = useState(false);
  const [editingHistoryId, setEditingHistoryId] = useState(null);
  const [newFormerIsin, setNewFormerIsin] = useState('');
  const [formerIsinSaving, setFormerIsinSaving] = useState(false);
  const [formerIsinError, setFormerIsinError] = useState('');
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [priceHistoryFilters, setPriceHistoryFilters] = useState(() => historyDefaultFilters());
  const [priceHistoryLoading, setPriceHistoryLoading] = useState(false);
  const [priceHistoryError, setPriceHistoryError] = useState('');
  const [priceHistoryData, setPriceHistoryData] = useState(null);
  const [priceHistoryExpanded, setPriceHistoryExpanded] = useState(false);
  const [fxRateCacheFilters, setFxRateCacheFilters] = useState(() => historyDefaultFilters());
  const [fxRateCacheLoading, setFxRateCacheLoading] = useState(false);
  const [fxRateCacheError, setFxRateCacheError] = useState('');
  const [fxRateCacheData, setFxRateCacheData] = useState(null);
  const [fxRateCacheExpanded, setFxRateCacheExpanded] = useState(false);
  const [historyForm, setHistoryForm] = useState({
    symbol: '',
    isin_code: '',
    security_name: '',
    valid_from: '',
    valid_to: '',
    notes: '',
  });
  const [form, setForm] = useState({
    display_name: '',
    ticker_symbol: '',
    isin_code: '',
    amfi_code: '',
    nps_fund_code: '',
    is_active: true,
    exclude_from_tracking: false,
  });

  useEffect(() => { loadData(); }, [id]);

  const loadHistoricalPriceData = useCallback(async (filters = null) => {
    const effectiveFilters = filters || priceHistoryFilters;
    try {
      setPriceHistoryLoading(true);
      setPriceHistoryError('');
      const result = await getInvestmentHistoricalPrices(id, {
        from: effectiveFilters.from,
        to: effectiveFilters.to,
        page: effectiveFilters.page,
        pageSize: effectiveFilters.pageSize,
      });
      setPriceHistoryData(result);
    } catch (e) {
      setPriceHistoryError(e.message || 'Failed to load historical prices');
      setPriceHistoryData(null);
    } finally {
      setPriceHistoryLoading(false);
    }
  }, [id, priceHistoryFilters]);

  const loadFxRateCacheData = useCallback(async (filters = null) => {
    const effectiveFilters = filters || fxRateCacheFilters;
    try {
      setFxRateCacheLoading(true);
      setFxRateCacheError('');
      const result = await getInvestmentFxRateCache(id, {
        from: effectiveFilters.from,
        to: effectiveFilters.to,
        page: effectiveFilters.page,
        pageSize: effectiveFilters.pageSize,
      });
      setFxRateCacheData(result);
    } catch (e) {
      setFxRateCacheError(e.message || 'Failed to load FX rate cache');
      setFxRateCacheData(null);
    } finally {
      setFxRateCacheLoading(false);
    }
  }, [id, fxRateCacheFilters]);

  const resetHistoryForm = () => {
    setIsAddingHistory(false);
    setEditingHistoryId(null);
    setHistoryForm({
      symbol: '',
      isin_code: '',
      security_name: '',
      valid_from: '',
      valid_to: '',
      notes: '',
    });
  };

  const loadSymbolHistory = async (investmentId) => {
    try {
      setHistoryLoading(true);
      setHistoryError(null);
      const response = await getInvestmentSymbolHistory(investmentId);
      setHistoryRows(Array.isArray(response.history) ? response.history : []);
    } catch (e) {
      setHistoryError(e.message || 'Failed to load symbol history');
      setHistoryRows([]);
    } finally {
      setHistoryLoading(false);
    }
  };

  const loadData = async () => {
    try {
      setLoading(true);
      const [result, symbolHistory] = await Promise.all([
        getInvestment(id),
        getInvestmentSymbolHistory(id).catch(() => ({ history: [] })),
      ]);
      setData(result);
      const initialTicker = String(result.ticker_symbol || '').trim();
      setForm({
        display_name: result.display_name || '',
        ticker_symbol: String(result.asset_type || '').toUpperCase() === 'INDIAN_STOCK'
          ? initialTicker.replace(/\.(NS|BO)$/i, '')
          : initialTicker,
        isin_code: result.isin_code || '',
        amfi_code: result.amfi_code || '',
        nps_fund_code: result.nps_fund_code || '',
        is_active: result.is_active !== 0,
        exclude_from_tracking: result.exclude_from_tracking !== 0,
      });
      setHistoryRows(Array.isArray(symbolHistory.history) ? symbolHistory.history : []);
      resetHistoryForm();
      setHistoryError(null);
      setHistorySuccess('');
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!data?.id) return;
    setPriceHistoryFilters(historyDefaultFilters(data));
    setPriceHistoryData(null);
    setPriceHistoryError('');
    setPriceHistoryExpanded(false);
  }, [data?.id]);

  useEffect(() => {
    if (!data?.id) return;
    if (String(data.asset_type || '').toUpperCase() !== 'FOREIGN_STOCK') {
      setFxRateCacheFilters(historyDefaultFilters(data));
      setFxRateCacheData(null);
      setFxRateCacheError('');
      setFxRateCacheExpanded(false);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const allFs = await getInvestments('FOREIGN_STOCK');
        const details = await Promise.all(
          (Array.isArray(allFs) ? allFs : []).map((inv) => getInvestment(inv.id).catch(() => inv))
        );
        if (cancelled) return;
        const fxRange = calculateFxRateCacheDateRangeFromInvestments(details);
        setFxRateCacheFilters(fxRange);
      } catch (_) {
        if (cancelled) return;
        setFxRateCacheFilters(historyDefaultFilters(data));
      } finally {
        if (cancelled) return;
        setFxRateCacheData(null);
        setFxRateCacheError('');
        setFxRateCacheExpanded(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [data?.id, data?.asset_type]);

  const handleStartAddHistory = () => {
    setHistoryError(null);
    setHistorySuccess('');
    setIsAddingHistory(true);
    setEditingHistoryId(null);
    setHistoryForm({
      symbol: '',
      isin_code: '',
      security_name: '',
      valid_from: '',
      valid_to: '',
      notes: '',
    });
  };

  const handleStartEditHistory = (row) => {
    setHistoryError(null);
    setHistorySuccess('');
    setIsAddingHistory(true);
    setEditingHistoryId(row.id);
    setHistoryForm({
      symbol: row.symbol || '',
      isin_code: row.isin_code || '',
      security_name: row.security_name || '',
      valid_from: row.valid_from || '',
      valid_to: row.valid_to || '',
      notes: row.notes || '',
    });
  };

  const handleDeleteHistory = async (row) => {
    const confirmed = window.confirm('Delete this history row? This will mark daily values dirty for recomputation.');
    if (!confirmed) return;
    try {
      setHistorySaving(true);
      setHistoryError(null);
      setHistorySuccess('');
      await deleteInvestmentSymbolHistory(id, row.id);
      setHistorySuccess('History row deleted successfully.');
      await loadSymbolHistory(id);
      resetHistoryForm();
      setTimeout(() => setHistorySuccess(''), 3000);
    } catch (e) {
      setHistoryError(e.message || 'Failed to delete history row');
    } finally {
      setHistorySaving(false);
    }
  };

  const currentFormerIsins = () =>
    String(data?.previous_isin_codes || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

  const saveFormerIsins = async (nextList) => {
    try {
      setFormerIsinSaving(true);
      setFormerIsinError('');
      const value = nextList.join(',');
      const updated = await updateInvestment(id, { previous_isin_codes: value });
      setData((prev) => ({ ...prev, previous_isin_codes: updated?.previous_isin_codes ?? value }));
    } catch (e) {
      setFormerIsinError(e.message || 'Failed to update former ISINs');
    } finally {
      setFormerIsinSaving(false);
    }
  };

  const handleAddFormerIsin = async () => {
    const code = newFormerIsin.trim().toUpperCase();
    if (!code) return;
    if (code === String(data?.isin_code || '').toUpperCase()) {
      setFormerIsinError('That is the current ISIN.');
      return;
    }
    const existing = currentFormerIsins();
    if (existing.includes(code)) {
      setFormerIsinError('ISIN already listed.');
      return;
    }
    await saveFormerIsins([...existing, code]);
    setNewFormerIsin('');
  };

  const handleRemoveFormerIsin = async (code) => {
    await saveFormerIsins(currentFormerIsins().filter((c) => c !== code));
  };

  const handleSave = async (e) => {
    e.preventDefault();
    const confirmed = window.confirm('Save changes to this investment settings record?');
    if (!confirmed) return;

    try {
      setSaving(true);
      setError(null);
      setSuccess(false);
      const tickerToSave = normalizeTickerForAssetType(form.ticker_symbol, data?.asset_type);
      await updateInvestment(id, {
        display_name: form.display_name || null,
        ticker_symbol: tickerToSave,
        isin_code: form.isin_code || null,
        amfi_code: form.amfi_code || null,
        nps_fund_code: data.asset_type === 'NPS' ? (form.nps_fund_code || null) : undefined,
        is_active: form.is_active,
        exclude_from_tracking: form.exclude_from_tracking,
      });
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleSaveHistory = async (e) => {
    e.preventDefault();
    if (!isAddingHistory) return;
    try {
      setHistorySaving(true);
      setHistoryError(null);
      setHistorySuccess('');
      const payload = {
        symbol: historyForm.symbol,
        isin_code: isMF ? (historyForm.isin_code || null) : null,
        security_name: isMF ? (historyForm.security_name || null) : null,
        valid_from: historyForm.valid_from,
        valid_to: historyForm.valid_to || null,
        notes: historyForm.notes || null,
      };

      if (editingHistoryId) {
        await updateInvestmentSymbolHistory(id, editingHistoryId, payload);
        setHistorySuccess('History row updated successfully.');
      } else {
        await createInvestmentSymbolHistory(id, payload);
        setHistorySuccess('History row added successfully.');
      }

      await loadSymbolHistory(id);
      resetHistoryForm();
      setTimeout(() => setHistorySuccess(''), 3000);
    } catch (e) {
      setHistoryError(e.message || 'Failed to save symbol history');
    } finally {
      setHistorySaving(false);
    }
  };

  if (loading) return <div className="d-flex justify-content-center py-5"><Spinner animation="border" variant="primary" /></div>;
  if (!data) return <div className="text-danger">Investment not found</div>;

  const isMF = data.asset_type === 'MUTUAL_FUND';
  const isNPS = data.asset_type === 'NPS';
  const showSymbolHistory = data.asset_type === 'INDIAN_STOCK' || data.asset_type === 'MUTUAL_FUND';
  const formerIsins = String(data.previous_isin_codes || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const isMarketDriven = MARKET_DRIVEN_ASSET_TYPES.has(String(data.asset_type || '').toUpperCase());

  return (
    <div>
      <Link to={`/investments/${id}`} state={{ from: cameFrom, transactionsSearch, investmentsSearch }} className="small text-muted text-decoration-none d-flex align-items-center gap-1 mb-2">
        <ArrowLeft size={16} /> Back to {data.display_name || data.name}
      </Link>
      <h1 className="h4 fw-bold mb-1">Settings</h1>
      <p className="text-muted small mb-4">
        Configure identifiers and display name for <strong>{data.name}</strong>
        <span className="ms-2 badge bg-primary bg-opacity-10 text-primary">{ASSET_TYPE_LABELS[data.asset_type]}</span>
      </p>

      {error && <Alert variant="danger" dismissible onClose={() => setError(null)}>{error}</Alert>}
      {success && <Alert variant="success">Settings saved successfully!</Alert>}

      <Card className="shadow-sm">
        <Card.Body>
          <Form onSubmit={handleSave}>
            <Row className="g-3">
              {/* Display Name */}
              <Col md={6}>
                <Form.Group>
                  <Form.Label className="small fw-semibold">Display Name</Form.Label>
                  <Form.Control
                    type="text"
                    value={form.display_name}
                    onChange={(e) => setForm({ ...form, display_name: e.target.value })}
                    placeholder={data.name}
                  />
                  <Form.Text className="text-muted">
                    Shown everywhere in the app. Leave empty to use the raw name.
                  </Form.Text>
                </Form.Group>
              </Col>

              {/* Raw Name (readonly) */}
              <Col md={6}>
                <Form.Group>
                  <Form.Label className="small fw-semibold">Raw Name (from import)</Form.Label>
                  <Form.Control type="text" value={data.name} readOnly disabled className="bg-light" />
                  <Form.Text className="text-muted">
                    Original name from import. Cannot be changed here.
                  </Form.Text>
                </Form.Group>
              </Col>

              {/* NSE Ticker (non-MF, non-NPS) */}
              {!isMF && !isNPS && (
              <Col md={4}>
                <Form.Group>
                  <Form.Label className="small fw-semibold">Symbol</Form.Label>
                  <Form.Control
                    type="text"
                    value={form.ticker_symbol}
                    onChange={(e) => setForm({ ...form, ticker_symbol: e.target.value })}
                    placeholder="e.g. RELAXO or NSDL.BO"
                  />
                  <Form.Text className="text-muted">
                    Stock exchange symbol. NSE assumed if no suffix.
                  </Form.Text>
                </Form.Group>
              </Col>
              )}

              {/* ISIN (readonly; hidden for NPS) */}
              {!isNPS && (
              <Col md={4}>
                <Form.Group>
                  <Form.Label className="small fw-semibold">ISIN Code</Form.Label>
                  <Form.Control
                    type="text"
                    value={form.isin_code}
                    onChange={(e) => setForm({ ...form, isin_code: e.target.value })}
                    placeholder="Auto-populated from imports"
                  />
                  <Form.Text className="text-muted">
                    Universal security identifier. Can be edited when needed.
                  </Form.Text>
                </Form.Group>
              </Col>
              )}

              {/* NPS Fund Code (NPS only) */}
              {isNPS && (
                <Col md={4}>
                  <Form.Group>
                    <Form.Label className="small fw-semibold">NPS Fund Code</Form.Label>
                    <Form.Control
                      type="text"
                      value={form.nps_fund_code}
                      onChange={(e) => setForm({ ...form, nps_fund_code: e.target.value })}
                      placeholder="e.g. HDFC-XXXX"
                    />
                    <Form.Text className="text-muted">
                      Used to fetch historical NAV for NPS pricing and one-day change.
                    </Form.Text>
                  </Form.Group>
                </Col>
              )}

              {/* AMFI Code (for mutual funds) */}
              {isMF && (
                <Col md={4}>
                  <Form.Group>
                    <Form.Label className="small fw-semibold">AMFI Code</Form.Label>
                    <Form.Control
                      type="text"
                      value={form.amfi_code}
                      onChange={(e) => setForm({ ...form, amfi_code: e.target.value })}
                      placeholder="e.g. 125354"
                    />
                    <Form.Text className="text-muted">
                      Auto-resolved from ISIN during price updates. Edit manually if needed.
                    </Form.Text>
                  </Form.Group>
                </Col>
              )}

              <Col xs={12} className="mt-3">
                <Form.Group className="d-flex align-items-center gap-2">
                  <Form.Check
                    type="switch"
                    id="is-active-switch"
                    checked={form.is_active}
                    onChange={(e) => setForm({ ...form, is_active: e.target.checked })}
                    label={form.is_active ? 'Active' : 'Inactive'}
                  />
                  <Form.Text className="text-muted ms-2">
                    Inactive investments are excluded from price updates (e.g. delisted stocks).
                  </Form.Text>
                </Form.Group>
              </Col>

              <Col xs={12} className="mt-3">
                <Form.Group className="d-flex align-items-center gap-2">
                  <Form.Check
                    type="switch"
                    id="exclude-from-tracking-switch"
                    checked={form.exclude_from_tracking}
                    onChange={(e) => setForm({ ...form, exclude_from_tracking: e.target.checked })}
                    label={form.exclude_from_tracking ? 'Excluded' : 'Included'}
                  />
                  <Form.Text className="text-muted ms-2">
                    Excluded investments are hidden from dashboard and daily value calculations (e.g. derived positions).
                  </Form.Text>
                </Form.Group>
              </Col>

              <Col xs={12} className="mt-3">
                <Button type="submit" variant="primary" disabled={saving} className="d-flex align-items-center gap-2">
                  <Save size={16} />
                  {saving ? 'Saving...' : 'Save Settings'}
                </Button>
              </Col>
            </Row>
          </Form>
        </Card.Body>
      </Card>

      {showSymbolHistory && (
        <Card className="shadow-sm mt-4">
          <Card.Body>
            <CollapsibleSectionHeader
              className="d-flex align-items-center gap-2 mb-2"
              expanded={historyExpanded}
              onToggle={() => setHistoryExpanded((v) => !v)}
              title={isMF ? 'AMFI History' : 'Symbol History'}
              titleClassName="h6 fw-bold mb-0"
              summary={`${historyRows.length} row${historyRows.length === 1 ? '' : 's'}${formerIsins.length ? ` · ${formerIsins.length} former ISIN${formerIsins.length === 1 ? '' : 's'}` : ''}`}
              right={(
                <Button variant="outline-primary" size="sm" onClick={() => { setHistoryExpanded(true); handleStartAddHistory(); }} disabled={historySaving || isAddingHistory}>
                  Add
                </Button>
              )}
            />
            <Collapse in={historyExpanded}>
              <div>
            <p className="text-muted small mb-3">
              {isMF
                ? 'Track AMFI code changes over time so missing cache windows are fetched using the correct historical identifier.'
                : 'Track ticker changes over time for correct historical price fetch and compliance checks.'}
            </p>

            {historyError && (
              <Alert variant="danger" dismissible onClose={() => setHistoryError(null)}>
                {historyError}
              </Alert>
            )}
            {historySuccess && <Alert variant="success">{historySuccess}</Alert>}

            {historyLoading ? (
              <div className="text-muted small">Loading symbol history...</div>
            ) : historyRows.length > 0 ? (
              <Table size="sm" bordered responsive className="mb-3">
                <thead>
                  <tr>
                    <th>{isMF ? 'AMFI' : 'Symbol'}</th>
                    {isMF && <th>ISIN</th>}
                    {isMF && <th>Name</th>}
                    <th>Valid From</th>
                    <th>Valid To</th>
                    <th>Notes</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {historyRows.map((row) => (
                    <tr key={row.id}>
                      <td>{row.symbol}</td>
                      {isMF && <td>{row.isin_code || '-'}</td>}
                      {isMF && <td>{row.security_name || '-'}</td>}
                      <td>{row.valid_from}</td>
                      <td>{row.valid_to || 'Open'}</td>
                      <td className="small text-muted">{row.notes || '-'}</td>
                      <td className="text-nowrap">
                        <Button size="sm" variant="outline-secondary" className="me-2" onClick={() => handleStartEditHistory(row)} disabled={historySaving}>
                          Edit
                        </Button>
                        <Button size="sm" variant="outline-danger" onClick={() => handleDeleteHistory(row)} disabled={historySaving}>
                          Delete
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <div className="text-muted small mb-3">None</div>
            )}

            {isAddingHistory && (
              <Form onSubmit={handleSaveHistory}>
                <Row className="g-3">
                  <Col md={isMF ? 2 : 3}>
                    <Form.Group>
                      <Form.Label className="small fw-semibold">{isMF ? 'AMFI' : 'Symbol'}</Form.Label>
                      <Form.Control
                        type="text"
                        value={historyForm.symbol}
                        onChange={(e) => setHistoryForm((prev) => ({ ...prev, symbol: e.target.value }))}
                        placeholder={isMF ? 'e.g. 112496' : 'e.g. ITIETF'}
                        required
                        disabled={historySaving}
                      />
                    </Form.Group>
                  </Col>
                  {isMF && (
                    <Col md={2}>
                      <Form.Group>
                        <Form.Label className="small fw-semibold">ISIN</Form.Label>
                        <Form.Control
                          type="text"
                          value={historyForm.isin_code}
                          onChange={(e) => setHistoryForm((prev) => ({ ...prev, isin_code: e.target.value }))}
                          placeholder="e.g. INF917K01254"
                          disabled={historySaving}
                        />
                      </Form.Group>
                    </Col>
                  )}
                  {isMF && (
                    <Col md={2}>
                      <Form.Group>
                        <Form.Label className="small fw-semibold">Name</Form.Label>
                        <Form.Control
                          type="text"
                          value={historyForm.security_name}
                          onChange={(e) => setHistoryForm((prev) => ({ ...prev, security_name: e.target.value }))}
                          placeholder="Scheme name"
                          disabled={historySaving}
                        />
                      </Form.Group>
                    </Col>
                  )}
                  <Col md={3}>
                    <Form.Group>
                      <Form.Label className="small fw-semibold">Valid From</Form.Label>
                      <Form.Control
                        type="date"
                        value={historyForm.valid_from}
                        onChange={(e) => setHistoryForm((prev) => ({ ...prev, valid_from: e.target.value }))}
                        required
                        disabled={historySaving}
                      />
                    </Form.Group>
                  </Col>
                  <Col md={3}>
                    <Form.Group>
                      <Form.Label className="small fw-semibold">Valid To</Form.Label>
                      <Form.Control
                        type="date"
                        value={historyForm.valid_to}
                        onChange={(e) => setHistoryForm((prev) => ({ ...prev, valid_to: e.target.value }))}
                        disabled={historySaving}
                      />
                    </Form.Group>
                  </Col>
                  <Col md={3}>
                    <Form.Group>
                      <Form.Label className="small fw-semibold">Notes</Form.Label>
                      <Form.Control
                        type="text"
                        value={historyForm.notes}
                        onChange={(e) => setHistoryForm((prev) => ({ ...prev, notes: e.target.value }))}
                        placeholder="Optional"
                        disabled={historySaving}
                      />
                    </Form.Group>
                  </Col>
                  <Col xs={12} className="d-flex align-items-center gap-2">
                    <Button type="submit" variant="primary" disabled={historySaving}>
                      {historySaving ? 'Saving...' : (editingHistoryId ? 'Update History Row' : 'Add History Row')}
                    </Button>
                    <Button type="button" variant="outline-secondary" onClick={resetHistoryForm} disabled={historySaving}>
                      Cancel
                    </Button>
                  </Col>
                </Row>
              </Form>
            )}

            <hr className="my-3" />
            <div>
              <span className="fw-semibold small">Former ISINs</span>
              <div className="text-muted mb-2" style={{ fontSize: '0.75rem' }}>
                Prior identifiers recorded after a merger/rename. Used to match imported transactions to this holding.
              </div>
              {formerIsins.length > 0 && (
                <div className="d-flex flex-wrap gap-2 mb-2">
                  {formerIsins.map((code) => (
                    <span key={code} className="badge bg-light text-dark border d-inline-flex align-items-center">
                      {code}
                      <button
                        type="button"
                        className="btn-close btn-close-sm ms-2"
                        style={{ fontSize: '0.55rem' }}
                        aria-label={`Remove ${code}`}
                        disabled={formerIsinSaving}
                        onClick={() => handleRemoveFormerIsin(code)}
                      />
                    </span>
                  ))}
                </div>
              )}
              <div className="d-flex align-items-center gap-2" style={{ maxWidth: 480 }}>
                <Form.Control
                  type="text"
                  size="sm"
                  className="flex-grow-1"
                  value={newFormerIsin}
                  onChange={(e) => { setNewFormerIsin(e.target.value); setFormerIsinError(''); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddFormerIsin(); } }}
                  placeholder="Add former ISIN (e.g. INF173K01155)"
                  disabled={formerIsinSaving}
                />
                <Button variant="outline-secondary" size="sm" className="text-nowrap flex-shrink-0" onClick={handleAddFormerIsin} disabled={formerIsinSaving || !newFormerIsin.trim()}>
                  Add ISIN
                </Button>
              </div>
              {formerIsinError && <div className="text-danger small mt-2">{formerIsinError}</div>}
            </div>
              </div>
            </Collapse>
          </Card.Body>
        </Card>
      )}

      {isMarketDriven && (
        <Card className="shadow-sm mt-4">
          <Card.Body>
            <CollapsibleSectionHeader
              expanded={priceHistoryExpanded}
              onToggle={() => {
                const nextExpanded = !priceHistoryExpanded;
                setPriceHistoryExpanded(nextExpanded);
                if (nextExpanded && !priceHistoryData && !priceHistoryLoading) {
                  loadHistoricalPriceData();
                }
              }}
              title="Historical Prices"
              subtitle="Cached market history for sparse-coverage troubleshooting."
            />

            <Collapse in={priceHistoryExpanded}>
              <div>
                <Form
                  className="d-flex flex-wrap align-items-end gap-2 mb-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    loadHistoricalPriceData();
                  }}
                >
                  <Form.Group>
                    <Form.Label className="small mb-1">From</Form.Label>
                    <Form.Control
                      size="sm"
                      type="date"
                      value={priceHistoryFilters.from}
                      onChange={(e) => setPriceHistoryFilters((prev) => ({ ...prev, from: e.target.value, page: 1 }))}
                    />
                  </Form.Group>
                  <Form.Group>
                    <Form.Label className="small mb-1">To</Form.Label>
                    <Form.Control
                      size="sm"
                      type="date"
                      value={priceHistoryFilters.to}
                      onChange={(e) => setPriceHistoryFilters((prev) => ({ ...prev, to: e.target.value, page: 1 }))}
                    />
                  </Form.Group>
                  <Form.Group>
                    <Form.Label className="small mb-1">Rows per page</Form.Label>
                    <Form.Control
                      size="sm"
                      type="number"
                      min="1"
                      max="5000"
                      value={priceHistoryFilters.pageSize}
                      onChange={(e) => setPriceHistoryFilters((prev) => ({
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
                      value={priceHistoryFilters.page}
                      onChange={(e) => setPriceHistoryFilters((prev) => ({
                        ...prev,
                        page: Math.max(1, Number(e.target.value || 1)),
                      }))}
                      style={{ width: 90 }}
                    />
                  </Form.Group>
                  <Button
                    size="sm"
                    type="button"
                    variant="outline-secondary"
                    disabled={priceHistoryLoading}
                    onClick={() => loadHistoricalPriceData(priceHistoryFilters)}
                  >
                    Go
                  </Button>
                  <Button size="sm" type="submit" variant="outline-primary" disabled={priceHistoryLoading}>
                    {priceHistoryLoading ? 'Loading...' : 'Refresh'}
                  </Button>
                </Form>

                {priceHistoryError && <div className="text-danger small mb-2">{priceHistoryError}</div>}

                {priceHistoryData?.pagination && (
                  <div className="d-flex flex-wrap align-items-center gap-2 small mb-3">
                    <Button
                      size="sm"
                      variant="outline-secondary"
                      disabled={priceHistoryLoading || !priceHistoryData.pagination.has_previous}
                      onClick={() => {
                        const nextFilters = { ...priceHistoryFilters, page: Math.max(1, priceHistoryFilters.page - 1) };
                        setPriceHistoryFilters(nextFilters);
                        loadHistoricalPriceData(nextFilters);
                      }}
                    >
                      Previous
                    </Button>
                    <Button
                      size="sm"
                      variant="outline-secondary"
                      disabled={priceHistoryLoading || !priceHistoryData.pagination.has_next}
                      onClick={() => {
                        const nextFilters = { ...priceHistoryFilters, page: priceHistoryFilters.page + 1 };
                        setPriceHistoryFilters(nextFilters);
                        loadHistoricalPriceData(nextFilters);
                      }}
                    >
                      Next
                    </Button>
                    <span className="rounded-3 px-2 py-1 bg-light">
                      Page {priceHistoryData.pagination.page} of {priceHistoryData.pagination.total_pages}
                    </span>
                    <span className="rounded-3 px-2 py-1 bg-light">
                      Showing {priceHistoryData.window?.displayed_from || '-'} to {priceHistoryData.window?.displayed_to || '-'}
                    </span>
                  </div>
                )}

                {priceHistoryData?.summary && (
                  <div className="d-flex flex-wrap gap-2 small mb-3">
                    <span className="rounded-3 px-2 py-1 bg-light">Coverage: {formatNumber(priceHistoryData.summary.coverage_pct, 2)}%</span>
                    <span className="rounded-3 px-2 py-1 bg-light">Expected sessions: {priceHistoryData.summary.expected_sessions}</span>
                    <span className="rounded-3 px-2 py-1 bg-light">Missing sessions: {priceHistoryData.summary.missing_sessions}</span>
                    <span className="rounded-3 px-2 py-1 bg-light">Rows in window: {priceHistoryData.summary.rows_in_window}</span>
                    <span className="rounded-3 px-2 py-1 bg-light">Rows returned: {priceHistoryData.summary.rows_returned}</span>
                    <span className="rounded-3 px-2 py-1 bg-light">First cached: {priceHistoryData.summary.first_cached_date || '-'}</span>
                    <span className="rounded-3 px-2 py-1 bg-light">Last cached: {priceHistoryData.summary.last_cached_date || '-'}</span>
                  </div>
                )}

                {priceHistoryData?.missing_ranges?.length > 0 && (
                  <div className="mb-3">
                    <h3 className="h6 fw-semibold mb-2">Missing Session Ranges</h3>
                    <div className="responsive-table">
                      <Table size="sm" className="mb-0 align-middle">
                        <thead>
                          <tr>
                            <th>From</th>
                            <th>To</th>
                            <th className="text-end">Days</th>
                          </tr>
                        </thead>
                        <tbody>
                          {priceHistoryData.missing_ranges.slice(0, 20).map((range, idx) => (
                            <tr key={`${range.from}-${range.to}-${idx}`}>
                              <td>{range.from}</td>
                              <td>{range.to}</td>
                              <td className="text-end">{range.days}</td>
                            </tr>
                          ))}
                        </tbody>
                      </Table>
                    </div>
                  </div>
                )}

                <h3 className="h6 fw-semibold mb-2">Cached Price Rows</h3>
                {priceHistoryLoading ? (
                  <div className="py-3 d-flex align-items-center gap-2 text-muted small">
                    <Spinner animation="border" size="sm" /> Loading price history...
                  </div>
                ) : (
                  <div className="responsive-table">
                    <Table size="sm" className="mb-0 align-middle">
                      <thead>
                        <tr>
                          <th>Date</th>
                          <th className="text-end">Close</th>
                          <th className="text-end">Adj Close</th>
                          <th className="text-end">Volume</th>
                          <th>Source</th>
                          <th>Symbol</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(priceHistoryData?.rows || []).length === 0 ? (
                          <tr>
                            <td colSpan={6} className="text-center text-muted py-3">No cached prices in selected window.</td>
                          </tr>
                        ) : (
                          priceHistoryData.rows.map((row) => (
                            <tr key={`${row.date}-${row.symbol}-${row.source}`}>
                              <td>{row.date}</td>
                              <td className="text-end">{row.close == null ? '-' : formatNumber(row.close, 4)}</td>
                              <td className="text-end">{row.adj_close == null ? '-' : formatNumber(row.adj_close, 4)}</td>
                              <td className="text-end">{row.volume == null ? '-' : formatNumber(row.volume, 0)}</td>
                              <td>{row.source || '-'}</td>
                              <td>{row.symbol || '-'}</td>
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
      )}

      {data?.asset_type === 'FOREIGN_STOCK' && (
        <Card className="shadow-sm mt-4">
          <Card.Body>
            <CollapsibleSectionHeader
              expanded={fxRateCacheExpanded}
              onToggle={() => {
                const nextExpanded = !fxRateCacheExpanded;
                setFxRateCacheExpanded(nextExpanded);
                if (nextExpanded && !fxRateCacheData && !fxRateCacheLoading) {
                  loadFxRateCacheData();
                }
              }}
              title="FX Rate Cache (USD to INR)"
              subtitle="Cached USD/INR exchange rates for foreign stock valuation."
            />

            <Collapse in={fxRateCacheExpanded}>
              <div>
                <Form
                  className="d-flex flex-wrap align-items-end gap-2 mb-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    loadFxRateCacheData();
                  }}
                >
                  <Form.Group>
                    <Form.Label className="small mb-1">From</Form.Label>
                    <Form.Control
                      size="sm"
                      type="date"
                      value={fxRateCacheFilters.from}
                      onChange={(e) => setFxRateCacheFilters((prev) => ({ ...prev, from: e.target.value, page: 1 }))}
                    />
                  </Form.Group>
                  <Form.Group>
                    <Form.Label className="small mb-1">To</Form.Label>
                    <Form.Control
                      size="sm"
                      type="date"
                      value={fxRateCacheFilters.to}
                      onChange={(e) => setFxRateCacheFilters((prev) => ({ ...prev, to: e.target.value, page: 1 }))}
                    />
                  </Form.Group>
                  <Form.Group>
                    <Form.Label className="small mb-1">Rows per page</Form.Label>
                    <Form.Control
                      size="sm"
                      type="number"
                      min="1"
                      max="5000"
                      value={fxRateCacheFilters.pageSize}
                      onChange={(e) => setFxRateCacheFilters((prev) => ({
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
                      value={fxRateCacheFilters.page}
                      onChange={(e) => setFxRateCacheFilters((prev) => ({
                        ...prev,
                        page: Math.max(1, Number(e.target.value || 1)),
                      }))}
                      style={{ width: 90 }}
                    />
                  </Form.Group>
                  <Button
                    size="sm"
                    type="button"
                    variant="outline-secondary"
                    disabled={fxRateCacheLoading}
                    onClick={() => loadFxRateCacheData(fxRateCacheFilters)}
                  >
                    Go
                  </Button>
                  <Button size="sm" type="submit" variant="outline-primary" disabled={fxRateCacheLoading}>
                    {fxRateCacheLoading ? 'Loading...' : 'Refresh'}
                  </Button>
                </Form>

                {fxRateCacheError && <div className="text-danger small mb-2">{fxRateCacheError}</div>}

                {fxRateCacheData?.pagination && (
                  <div className="d-flex flex-wrap align-items-center gap-2 small mb-3">
                    <Button
                      size="sm"
                      variant="outline-secondary"
                      disabled={fxRateCacheLoading || !fxRateCacheData.pagination.has_previous}
                      onClick={() => {
                        const nextFilters = { ...fxRateCacheFilters, page: Math.max(1, fxRateCacheFilters.page - 1) };
                        setFxRateCacheFilters(nextFilters);
                        loadFxRateCacheData(nextFilters);
                      }}
                    >
                      Previous
                    </Button>
                    <Button
                      size="sm"
                      variant="outline-secondary"
                      disabled={fxRateCacheLoading || !fxRateCacheData.pagination.has_next}
                      onClick={() => {
                        const nextFilters = { ...fxRateCacheFilters, page: fxRateCacheFilters.page + 1 };
                        setFxRateCacheFilters(nextFilters);
                        loadFxRateCacheData(nextFilters);
                      }}
                    >
                      Next
                    </Button>
                    <span className="rounded-3 px-2 py-1 bg-light">
                      Page {fxRateCacheData.pagination.page} of {fxRateCacheData.pagination.total_pages}
                    </span>
                    <span className="rounded-3 px-2 py-1 bg-light">
                      Showing {fxRateCacheData.window?.displayed_from || '-'} to {fxRateCacheData.window?.displayed_to || '-'}
                    </span>
                  </div>
                )}

                {fxRateCacheData?.summary && (
                  <div className="d-flex flex-wrap gap-2 small mb-3">
                    <span className="rounded-3 px-2 py-1 bg-light">Coverage: {formatNumber(fxRateCacheData.summary.coverage_pct, 2)}%</span>
                    <span className="rounded-3 px-2 py-1 bg-light">Expected sessions: {fxRateCacheData.summary.expected_sessions}</span>
                    <span className="rounded-3 px-2 py-1 bg-light">Missing sessions: {fxRateCacheData.summary.missing_sessions}</span>
                    <span className="rounded-3 px-2 py-1 bg-light">Rows in window: {fxRateCacheData.summary.rows_in_window}</span>
                    <span className="rounded-3 px-2 py-1 bg-light">Rows returned: {fxRateCacheData.summary.rows_returned}</span>
                    <span className="rounded-3 px-2 py-1 bg-light">First cached: {fxRateCacheData.summary.first_cached_date || '-'}</span>
                    <span className="rounded-3 px-2 py-1 bg-light">Last cached: {fxRateCacheData.summary.last_cached_date || '-'}</span>
                  </div>
                )}

                {fxRateCacheData?.missing_ranges?.length > 0 && (
                  <div className="mb-3">
                    <h3 className="h6 fw-semibold mb-2">Missing Session Ranges</h3>
                    <div className="responsive-table">
                      <Table size="sm" className="mb-0 align-middle">
                        <thead>
                          <tr>
                            <th>From</th>
                            <th>To</th>
                            <th className="text-end">Days</th>
                          </tr>
                        </thead>
                        <tbody>
                          {fxRateCacheData.missing_ranges.slice(0, 20).map((range, idx) => (
                            <tr key={`${range.from}-${range.to}-${idx}`}>
                              <td>{range.from}</td>
                              <td>{range.to}</td>
                              <td className="text-end">{range.days}</td>
                            </tr>
                          ))}
                        </tbody>
                      </Table>
                    </div>
                  </div>
                )}

                <h3 className="h6 fw-semibold mb-2">Cached FX Rates</h3>
                {fxRateCacheLoading ? (
                  <div className="py-3 d-flex align-items-center gap-2 text-muted small">
                    <Spinner animation="border" size="sm" /> Loading FX rate cache...
                  </div>
                ) : (
                  <div className="responsive-table">
                    <Table size="sm" className="mb-0 align-middle">
                      <thead>
                        <tr>
                          <th>Date</th>
                          <th className="text-end">USDINR</th>
                          <th>Source</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(fxRateCacheData?.rows || []).length === 0 ? (
                          <tr>
                            <td colSpan={3} className="text-center text-muted py-3">No cached FX rates in selected window.</td>
                          </tr>
                        ) : (
                          fxRateCacheData.rows.map((row) => (
                            <tr key={`${row.date}-${row.source}`}>
                              <td>{row.date}</td>
                              <td className="text-end">{row.close == null ? '-' : formatNumber(row.close, 4)}</td>
                              <td>{row.source || '-'}</td>
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
      )}
    </div>
  );
}
