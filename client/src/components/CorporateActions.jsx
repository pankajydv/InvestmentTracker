import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, Button, Form, Alert, Spinner, Table } from 'react-bootstrap';
import { ArrowLeft, CheckCircle, AlertTriangle, Trash2, Pencil, Plus, Info } from 'lucide-react';
import { previewCorporateActions, importCorporateActions, previewInterestRateSync, importInterestRateSync } from '../services/api';
import { formatNumber, formatDate } from '../utils/formatters';
import { usePortfolio } from '../context/PortfolioContext';

const TYPE_BADGE = {
  DIVIDEND: 'badge-dividend',
  SPLIT: 'badge-split',
  BONUS: 'badge-bonus',
  TDS: 'badge-tds',
};

const ASSET_TYPE_OPTIONS = [
  { value: 'INDIAN_STOCK', label: 'Stocks' },
  { value: 'FOREIGN_STOCK', label: 'Foreign Stocks' },
];

const RATE_TYPES = new Set(['PPF', 'SSY', 'PF']);

export default function CorporateActions() {
  const navigate = useNavigate();
  const { portfolios, selectedId } = usePortfolio();
  const [assetType, setAssetType] = useState('INDIAN_STOCK');
  const [year, setYear] = useState(new Date().getFullYear() - 1);
  const [loading, setLoading] = useState(false);
  const [suggestions, setSuggestions] = useState(null);
  const [corrections, setCorrections] = useState(null);
  const [deletions, setDeletions] = useState(null);
  const [errors, setErrors] = useState([]);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [datasetVersion, setDatasetVersion] = useState('');

  // Checked state per section
  const [checkedAdd, setCheckedAdd] = useState({});
  const [checkedFix, setCheckedFix] = useState({});
  const [checkedDel, setCheckedDel] = useState({});

  const isRateSync = RATE_TYPES.has(assetType);

  const currentYear = new Date().getFullYear();
  const years = [];
  for (let y = currentYear; y >= 2010; y--) years.push(y);

  const clearPreview = () => {
    setSuggestions(null);
    setCorrections(null);
    setDeletions(null);
    setErrors([]);
  };

  const handleFetch = async () => {
    setError('');
    setResult(null);
    clearPreview();
    setLoading(true);
    try {
      if (isRateSync) {
        const data = await previewInterestRateSync(assetType, selectedId || null);
        setSuggestions(data.suggestions || []);
        setCorrections(data.corrections || []);
        setDeletions(data.deletions || []);
        setDatasetVersion(data.datasetVersion || '');
        // Init checked states
        const initAdd = {}; (data.suggestions || []).forEach((_, i) => { initAdd[i] = true; });
        const initFix = {}; (data.corrections || []).forEach((_, i) => { initFix[i] = true; });
        const initDel = {}; // destructive — unchecked by default
        setCheckedAdd(initAdd);
        setCheckedFix(initFix);
        setCheckedDel(initDel);
      } else {
        const data = await previewCorporateActions(selectedId || null, year, assetType);
        setSuggestions(data.suggestions || []);
        setCorrections(data.corrections || []);
        setDeletions(data.deletions || []);
        setErrors(data.errors || []);
        const initAdd = {}; (data.suggestions || []).forEach((_, i) => { initAdd[i] = true; });
        const initFix = {}; (data.corrections || []).forEach((_, i) => { initFix[i] = true; });
        const initDel = {};
        setCheckedAdd(initAdd);
        setCheckedFix(initFix);
        setCheckedDel(initDel);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleImport = async () => {
    setError('');
    setImporting(true);
    try {
      if (isRateSync) {
        const selAdd = (suggestions || []).filter((_, i) => checkedAdd[i]);
        const selFix = (corrections || []).filter((_, i) => checkedFix[i]);
        const selDel = (deletions || []).filter((_, i) => checkedDel[i]);
        const totalSel = selAdd.length + selFix.length + selDel.length;
        if (!totalSel) { setError('No actions selected'); setImporting(false); return; }
        const data = await importInterestRateSync({
          additions: selAdd,
          corrections: selFix,
          deletions: selDel,
        });
        setResult(data);
        clearPreview();
      } else {
        const selAdd = (suggestions || []).filter((_, i) => checkedAdd[i]);
        const selFix = (corrections || []).filter((_, i) => checkedFix[i]);
        const selDel = (deletions || []).filter((_, i) => checkedDel[i]);
        const totalSel = selAdd.length + selFix.length + selDel.length;
        if (!totalSel) { setError('No actions selected'); setImporting(false); return; }
        const data = await importCorporateActions({
          transactions: selAdd,
          corrections: selFix,
          deletions: selDel,
        });
        setResult(data);
        clearPreview();
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setImporting(false);
    }
  };

  const toggleAll = (items, setter, val) => {
    const next = {};
    items.forEach((_, i) => { next[i] = val; });
    setter(next);
  };

  const countChecked = (items, checked) => items ? items.filter((_, i) => checked[i]).length : 0;
  const addCount = countChecked(suggestions, checkedAdd);
  const fixCount = countChecked(corrections, checkedFix);
  const delCount = countChecked(deletions, checkedDel);
  const totalSelected = addCount + fixCount + delCount;

  const hasData = suggestions !== null;
  const totalItems = (suggestions?.length || 0) + (corrections?.length || 0) + (deletions?.length || 0);

  const portfolioLabel = selectedId
    ? portfolios.find(p => p.id === selectedId)?.name || 'Selected portfolio'
    : 'All Portfolios';
  const moneySymbol = (row) => row?.currency_symbol || '₹';

  return (
    <div className="mx-auto d-flex flex-column gap-4" style={{ maxWidth: 960 }}>
      <div>
        <button onClick={() => navigate(-1)} className="btn btn-link btn-sm text-muted text-decoration-none d-flex align-items-center gap-1 mb-2 p-0">
          <ArrowLeft size={16} /> Back
        </button>
        <h1 className="h4 fw-bold">Sync Corporate Actions</h1>
        <p className="text-muted small mb-0">
          {isRateSync
            ? `Sync ${assetType} interest rates from the reference dataset — add missing and correct wrong.`
            : 'Fetch dividends, splits and bonus issues from Yahoo Finance — add missing, correct wrong, and remove invalid entries.'}
        </p>
      </div>

      {error && <Alert variant="danger" className="small py-2">{error}</Alert>}

      {/* Controls */}
      <Card className="shadow-sm">
        <Card.Body>
          <div className="d-flex flex-wrap align-items-end gap-3">
            <Form.Group>
              <Form.Label className="small fw-semibold">Asset Type</Form.Label>
              <Form.Select size="sm" value={assetType} onChange={(e) => { setAssetType(e.target.value); clearPreview(); setResult(null); }} style={{ width: 140 }}>
                {ASSET_TYPE_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </Form.Select>
            </Form.Group>
            {!isRateSync && (
              <Form.Group>
                <Form.Label className="small fw-semibold">Year</Form.Label>
                <Form.Select size="sm" value={year} onChange={(e) => setYear(parseInt(e.target.value))} style={{ width: 120 }}>
                  {years.map(y => <option key={y} value={y}>{y}</option>)}
                </Form.Select>
              </Form.Group>
            )}
            <div className="d-flex flex-column">
              <span className="small text-muted mb-1">Portfolio: <strong>{portfolioLabel}</strong></span>
              <Button size="sm" variant="primary" onClick={handleFetch} disabled={loading}>
                {loading ? <><Spinner size="sm" className="me-1" /> Fetching...</> : 'Fetch & Analyze'}
              </Button>
            </div>
          </div>
        </Card.Body>
      </Card>

      {/* Dataset version for rate sync */}
      {isRateSync && datasetVersion && hasData && (
        <Alert variant="info" className="small py-2 d-flex align-items-center gap-1">
          <Info size={14} />
          Rates current as of: <strong>{datasetVersion}</strong>
        </Alert>
      )}

      {/* Errors/warnings from providers */}
      {errors.length > 0 && (
        <Alert variant="warning" className="small py-2">
          <AlertTriangle size={14} className="me-1" />
          <div className="fw-semibold mb-1">Issues detected while fetching provider data:</div>
          <ul className="mb-0 ps-3">
            {errors.map((e, i) => (
              <li key={i}>{e.investment ? `${e.investment}: ${e.error}` : e.error}</li>
            ))}
          </ul>
        </Alert>
      )}

      {/* No changes needed */}
      {hasData && totalItems === 0 && errors.length === 0 && (
        <Alert variant="info" className="small py-2">
          {isRateSync
            ? `All ${assetType} interest rates are up to date!`
            : `No changes needed for ${year}. Everything is up to date!`}
        </Alert>
      )}

      {/* ── Stock mode: Add Missing ────────────────────────── */}
      {!isRateSync && suggestions && suggestions.length > 0 && (
        <SectionCard
          icon={<Plus size={14} />}
          title="Add Missing"
          variant="success"
          items={suggestions}
          checked={checkedAdd}
          setChecked={setCheckedAdd}
          toggleAll={(val) => toggleAll(suggestions, setCheckedAdd, val)}
          selectedCount={addCount}
          columns={['Date', 'Stock', 'Type', 'Holdings', 'Per Share', 'Amount / Units', 'Details']}
          renderRow={(s, i) => (
            <tr key={i} className={!checkedAdd[i] ? 'text-muted' : ''}>
              <td className="px-3 py-2">
                <Form.Check type="checkbox" checked={!!checkedAdd[i]}
                  onChange={(e) => setCheckedAdd({ ...checkedAdd, [i]: e.target.checked })} />
              </td>
              <td className="px-3 py-2 text-nowrap">{formatDate(s.transaction_date)}</td>
              <td className="px-3 py-2 fw-medium">{s.investment_name}</td>
              <td className="px-3 py-2"><TypeBadge type={s.transaction_type} /></td>
              <td className="px-3 py-2 text-end">{formatNumber(s.units, 4)}</td>
              <td className="px-3 py-2 text-end">
                {s.transaction_type === 'DIVIDEND' ? `${moneySymbol(s)}${formatNumber(s.price_per_unit, 2)}` : '-'}
              </td>
              <td className="px-3 py-2 text-end fw-medium">
                {s.transaction_type === 'DIVIDEND' ? (
                  <>
                    ₹{formatNumber(s.amount, 2)}
                    {s.usd_amount != null && (
                      <div className="text-muted" style={{ fontSize: '0.75rem', whiteSpace: 'nowrap' }}>
                        ${formatNumber(s.usd_amount, 2)}
                      </div>
                    )}
                  </>
                ) : `+${formatNumber(s.units, 4)} shares`}
              </td>
              <td className="px-3 py-2 text-muted small">{s.notes}</td>
            </tr>
          )}
        />
      )}

      {/* ── Rate mode: Add Missing Rates ───────────────────── */}
      {isRateSync && suggestions && suggestions.length > 0 && (
        <SectionCard
          icon={<Plus size={14} />}
          title="Add Missing Rates"
          variant="success"
          items={suggestions}
          checked={checkedAdd}
          setChecked={setCheckedAdd}
          toggleAll={(val) => toggleAll(suggestions, setCheckedAdd, val)}
          selectedCount={addCount}
          columns={['Effective From', 'Effective To', 'Rate (%)']}
          renderRow={(s, i) => (
            <tr key={i} className={!checkedAdd[i] ? 'text-muted' : ''}>
              <td className="px-3 py-2">
                <Form.Check type="checkbox" checked={!!checkedAdd[i]}
                  onChange={(e) => setCheckedAdd({ ...checkedAdd, [i]: e.target.checked })} />
              </td>
              <td className="px-3 py-2 text-nowrap">{formatDate(s.effective_from)}</td>
              <td className="px-3 py-2 text-nowrap">{s.effective_to ? formatDate(s.effective_to) : '—'}</td>
              <td className="px-3 py-2 fw-medium">{s.rate}%</td>
            </tr>
          )}
        />
      )}

      {/* ── Stock mode: Corrections ────────────────────────── */}
      {!isRateSync && corrections && corrections.length > 0 && (
        <SectionCard
          icon={<Pencil size={14} />}
          title="Correct Existing"
          variant="warning"
          items={corrections}
          checked={checkedFix}
          setChecked={setCheckedFix}
          toggleAll={(val) => toggleAll(corrections, setCheckedFix, val)}
          selectedCount={fixCount}
          columns={['Stock', 'Type', 'Current', '', 'Corrected', 'Details']}
          renderRow={(c, i) => {
            const dateChanged = c.current_date && c.current_date !== c.transaction_date;
            const symbol = moneySymbol(c);
            const currentVal = c.transaction_type === 'DIVIDEND'
              ? `${symbol}${formatNumber(c.current_amount, 2)}`
              : `${formatNumber(c.current_units, 4)} shares`;
            const expectedVal = c.transaction_type === 'DIVIDEND'
              ? `${symbol}${formatNumber(c.expected_amount, 2)}`
              : `${formatNumber(c.expected_units, 4)} shares`;
            return (
            <tr key={i} className={!checkedFix[i] ? 'text-muted' : ''}>
              <td className="px-3 py-2">
                <Form.Check type="checkbox" checked={!!checkedFix[i]}
                  onChange={(e) => setCheckedFix({ ...checkedFix, [i]: e.target.checked })} />
              </td>
              <td className="px-3 py-2 fw-medium">{c.investment_name}</td>
              <td className="px-3 py-2"><TypeBadge type={c.transaction_type} /></td>
              <td className="px-3 py-2 text-end">
                <span className="text-danger text-decoration-line-through">
                  {dateChanged && <>{formatDate(c.current_date)}<br/></>}
                  {currentVal}
                </span>
              </td>
              <td className="px-3 py-2 text-center text-muted">→</td>
              <td className="px-3 py-2 text-end">
                <span className="text-success fw-medium">
                  {dateChanged && <>{formatDate(c.transaction_date)}<br/></>}
                  {expectedVal}
                </span>
              </td>
              <td className="px-3 py-2 text-muted small">{c.notes}</td>
            </tr>
            );
          }}
        />
      )}

      {/* ── Rate mode: Correct Existing Rates ──────────────── */}
      {isRateSync && corrections && corrections.length > 0 && (
        <SectionCard
          icon={<Pencil size={14} />}
          title="Correct Existing Rates"
          variant="warning"
          items={corrections}
          checked={checkedFix}
          setChecked={setCheckedFix}
          toggleAll={(val) => toggleAll(corrections, setCheckedFix, val)}
          selectedCount={fixCount}
          columns={['Effective From', 'Current', '', 'Corrected']}
          renderRow={(c, i) => (
            <tr key={i} className={!checkedFix[i] ? 'text-muted' : ''}>
              <td className="px-3 py-2">
                <Form.Check type="checkbox" checked={!!checkedFix[i]}
                  onChange={(e) => setCheckedFix({ ...checkedFix, [i]: e.target.checked })} />
              </td>
              <td className="px-3 py-2 text-nowrap">{formatDate(c.effective_from)}</td>
              <td className="px-3 py-2 text-end">
                <span className="text-danger text-decoration-line-through">{c.current_rate}%</span>
              </td>
              <td className="px-3 py-2 text-center text-muted">→</td>
              <td className="px-3 py-2 text-end">
                <span className="text-success fw-medium">{c.expected_rate}%</span>
              </td>
            </tr>
          )}
        />
      )}

      {/* ── Deletions (both modes) ─────────────────────────── */}
      {deletions && deletions.length > 0 && (
        <SectionCard
          icon={<Trash2 size={14} />}
          title={isRateSync ? 'Remove Unknown Rates' : 'Remove Unverified'}
          variant="danger"
          items={deletions}
          checked={checkedDel}
          setChecked={setCheckedDel}
          toggleAll={(val) => toggleAll(deletions, setCheckedDel, val)}
          selectedCount={delCount}
          columns={isRateSync
            ? ['Effective From', 'Effective To', 'Rate (%)', 'Reason']
            : ['Date', 'Stock', 'Type', 'Amount / Units', 'Existing Notes', 'Reason']}
          renderRow={isRateSync
            ? (d, i) => (
              <tr key={i} className={!checkedDel[i] ? 'text-muted' : ''}>
                <td className="px-3 py-2">
                  <Form.Check type="checkbox" checked={!!checkedDel[i]}
                    onChange={(e) => setCheckedDel({ ...checkedDel, [i]: e.target.checked })} />
                </td>
                <td className="px-3 py-2 text-nowrap">{formatDate(d.effective_from)}</td>
                <td className="px-3 py-2 text-nowrap">{d.effective_to ? formatDate(d.effective_to) : '—'}</td>
                <td className="px-3 py-2 fw-medium">{d.rate}%</td>
                <td className="px-3 py-2 text-danger small">{d.reason}</td>
              </tr>
            )
            : (d, i) => (
              <tr key={i} className={!checkedDel[i] ? 'text-muted' : ''}>
                <td className="px-3 py-2">
                  <Form.Check type="checkbox" checked={!!checkedDel[i]}
                    onChange={(e) => setCheckedDel({ ...checkedDel, [i]: e.target.checked })} />
                </td>
                <td className="px-3 py-2 text-nowrap">{formatDate(d.transaction_date)}</td>
                <td className="px-3 py-2 fw-medium">{d.investment_name}</td>
                <td className="px-3 py-2"><TypeBadge type={d.transaction_type} /></td>
                <td className="px-3 py-2 text-end">
                  {d.transaction_type === 'DIVIDEND'
                    ? `${moneySymbol(d)}${formatNumber(d.amount, 2)}`
                    : `${formatNumber(d.units, 4)} shares`}
                </td>
                <td className="px-3 py-2 text-muted small">{d.notes || '-'}</td>
                <td className="px-3 py-2 text-danger small">{d.reason}</td>
              </tr>
            )}
        />
      )}

      {/* ── Footer: Approve ────────────────────────────────── */}
      {hasData && totalItems > 0 && (
        <Card className="shadow-sm border-0 bg-light">
          <Card.Body className="d-flex align-items-center justify-content-between py-2">
            <span className="small text-muted">
              {addCount > 0 && <span className="me-3"><strong>{addCount}</strong> to add</span>}
              {fixCount > 0 && <span className="me-3"><strong>{fixCount}</strong> to correct</span>}
              {delCount > 0 && <span className="me-3 text-danger"><strong>{delCount}</strong> to delete</span>}
            </span>
            <div className="d-flex gap-2">
              <Button size="sm" variant="outline-secondary" onClick={clearPreview}>Cancel</Button>
              <Button size="sm" variant="success" onClick={handleImport} disabled={importing || totalSelected === 0}>
                {importing
                  ? <><Spinner size="sm" className="me-1" /> Applying...</>
                  : <><CheckCircle size={14} className="me-1" /> Apply Changes ({totalSelected})</>}
              </Button>
            </div>
          </Card.Body>
        </Card>
      )}

      {/* Import Result */}
      {result && (
        <Alert variant="success" className="small py-2">
          <CheckCircle size={14} className="me-1" />
          {result.created > 0 && `Added ${result.created}. `}
          {result.corrected > 0 && `Corrected ${result.corrected}. `}
          {result.deleted > 0 && `Deleted ${result.deleted}. `}
          {result.skipped > 0 && `Skipped ${result.skipped} (duplicates). `}
          <button className="btn btn-link btn-sm p-0 ms-2" onClick={() => { setResult(null); handleFetch(); }}>
            Check again
          </button>
        </Alert>
      )}
    </div>
  );
}

/* ── Helper components ─────────────────────────────────────────────────────── */

function TypeBadge({ type }) {
  return (
    <span className={`badge ${TYPE_BADGE[type] || 'bg-secondary'}`}>{type}</span>
  );
}

function SectionCard({ icon, title, variant, items, checked, setChecked, toggleAll, selectedCount, columns, renderRow }) {
  return (
    <Card className="shadow-sm">
      <Card.Header className={`bg-white d-flex align-items-center justify-content-between py-2 border-start border-4 border-${variant}`}>
        <div className="small d-flex align-items-center gap-2">
          {icon}
          <strong>{title}</strong>
          <span className="text-muted">({items.length})</span>
        </div>
        <div className="d-flex gap-2">
          <button className="btn btn-link btn-sm p-0 small" onClick={() => toggleAll(true)}>Select all</button>
          <button className="btn btn-link btn-sm p-0 small text-muted" onClick={() => toggleAll(false)}>Deselect all</button>
        </div>
      </Card.Header>
      <div className="table-responsive">
        <Table hover size="sm" className="mb-0 small">
          <thead className="table-light">
            <tr>
              <th className="px-3 py-2" style={{ width: 30 }}>
                <Form.Check type="checkbox"
                  checked={selectedCount === items.length && items.length > 0}
                  onChange={(e) => toggleAll(e.target.checked)} />
              </th>
              {columns.map((col, ci) => (
                <th key={ci} className={`px-3 py-2${col.includes('Amount') || col.includes('Current') || col.includes('Expected') || col === 'Holdings' || col === 'Per Share' ? ' text-end' : ''}`}>
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((item, i) => renderRow(item, i))}
          </tbody>
        </Table>
      </div>
    </Card>
  );
}
