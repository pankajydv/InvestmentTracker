import React, { useState } from 'react';
import { Modal, Button, Form, Alert, Badge, Spinner } from 'react-bootstrap';
import { Eye, Trash2 } from 'lucide-react';
import { purgeMarketPriceCache } from '../services/api';
import { ASSET_TYPE_FILTER_ORDER, ASSET_TYPE_FULL_NAMES } from '../utils/formatters';

const ASSET_TYPES = ASSET_TYPE_FILTER_ORDER;
const DATE_STRATEGIES = [
  { value: 'scope_first_transaction', label: 'From First Transaction (default)', desc: 'Uses earliest transaction date per investment' },
  { value: 'max_of_fixed_and_scope_first', label: 'Fixed OR First (max)', desc: 'Later of fixed date or first transaction date' },
];

export default function PurgeMarketPriceCacheModal({ show, onHide }) {
  const [previewing, setPreviewing] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [result, setResult] = useState(null);
  const [previewData, setPreviewData] = useState(null);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  // Quick selector
  const [quickMode, setQuickMode] = useState('all_active');
  const [quickAsset, setQuickAsset] = useState('');
  const [quickInvestmentId, setQuickInvestmentId] = useState('');

  // Date range
  const today = new Date().toISOString().split('T')[0];
  const [dateStrategy, setDateStrategy] = useState('scope_first_transaction');
  const [fixedDate, setFixedDate] = useState(today);
  const [toDate, setToDate] = useState('');
  const [fxFromDate, setFxFromDate] = useState('');
  const [purgeMode, setPurgeMode] = useState('market');

  const reset = () => {
    setQuickMode('all_active');
    setQuickAsset('');
    setQuickInvestmentId('');
    setDateStrategy('scope_first_transaction');
    setFixedDate(today);
    setToDate('');
    setFxFromDate('');
    setPurgeMode('market');
    setError('');
    setSuccessMsg('');
    setResult(null);
    setPreviewData(null);
  };

  const handleClose = () => {
    reset();
    onHide();
  };

  const buildSelector = () => {
    const selector = {};

    if (quickMode === 'all_active') {
      selector.include_inactive = false;
      selector.include_excluded = false;
    } else if (quickMode === 'specific_asset' && quickAsset) {
      selector.asset_types = [quickAsset];
      selector.include_inactive = false;
      selector.include_excluded = false;
    } else if (quickMode === 'specific_investment' && quickInvestmentId.trim()) {
      selector.investment_ids = [Number(quickInvestmentId.trim())];
      selector.include_inactive = true;
      selector.include_excluded = true;
    } else if (quickMode === 'all_including_inactive') {
      selector.include_inactive = true;
      selector.include_excluded = false;
    }

    return selector;
  };

  const buildPayload = (dryRun) => ({
    selector: buildSelector(),
    date_strategy: {
      type: dateStrategy,
      ...(dateStrategy !== 'scope_first_transaction' && { from_date: fixedDate || undefined }),
    },
    date_range: {
      from_date: purgeMode === 'fx' ? (fxFromDate || undefined) : undefined,
      to_date: toDate || undefined,
    },
    purge_mode: purgeMode,
    dry_run: dryRun,
  });

  const handlePreview = async () => {
    if (purgeMode !== 'fx' && dateStrategy !== 'scope_first_transaction' && !fixedDate) {
      setError('Fixed Date is required for selected date strategy');
      return;
    }
    try {
      setError('');
      setPreviewData(null);
      setPreviewing(true);
      const data = await purgeMarketPriceCache(buildPayload(true));
      setPreviewData(data);
    } catch (e) {
      setError(e.message || 'Preview failed');
    } finally {
      setPreviewing(false);
    }
  };

  const handleExecute = async () => {
    if (purgeMode !== 'fx' && dateStrategy !== 'scope_first_transaction' && !fixedDate) {
      setError('Fixed Date is required for selected date strategy');
      return;
    }
    try {
      setError('');
      setSuccessMsg('');
      setExecuting(true);
      const data = await purgeMarketPriceCache(buildPayload(false));
      setPreviewData(null);
      setResult(data);
      const marketRows = Number(data?.rows_affected || 0);
      const fxRows = Number(data?.fx_rate_cache?.rows_affected || 0);
      if (purgeMode === 'fx') {
        setSuccessMsg(`✓ Purged ${fxRows.toLocaleString()} FX rate rows`);
      } else if (purgeMode === 'both') {
        setSuccessMsg(`✓ Purged ${marketRows.toLocaleString()} market rows and ${fxRows.toLocaleString()} FX rows across ${data.matched_investments} investment(s)`);
      } else {
        setSuccessMsg(`✓ Purged ${marketRows.toLocaleString()} cached price rows across ${data.matched_investments} investment(s)`);
      }
    } catch (e) {
      setError(e.message || 'Purge failed');
    } finally {
      setExecuting(false);
    }
  };

  return (
    <Modal show={show} onHide={handleClose} size="lg" centered>
      <Modal.Header closeButton>
        <Modal.Title className="d-flex align-items-center gap-2">
          <Trash2 size={18} />
          Purge Price Cache
        </Modal.Title>
      </Modal.Header>

      <Modal.Body style={{ maxHeight: '70vh', overflowY: 'auto' }}>
        <Alert variant="info" className="py-2 mb-3 small">
          {purgeMode === 'fx'
            ? 'Purges only fx_rate_cache rows. This mode is independent of selected investments.'
            : 'Purges market_price_cache rows using selected investments and start-date strategy. For market-price purge, the next "Update Prices" run re-fetches purged data from source.'}
        </Alert>

        {error && <Alert variant="danger" className="mb-3">{error}</Alert>}
        {successMsg && <Alert variant="success" className="mb-3">{successMsg}</Alert>}

        {result && !executing && (
          <Alert variant="info" className="mb-3">
            <div className="fw-semibold mb-2 d-flex align-items-center gap-2"><Trash2 size={14} /> Purge Complete</div>
            <small>
              <div>Investments matched: <Badge bg="secondary">{result.matched_investments}</Badge></div>
              {(result.purge_mode === 'market' || result.purge_mode === 'both') && (
                <div>Market rows deleted: <Badge bg="danger">{Number(result.rows_affected || 0).toLocaleString()}</Badge></div>
              )}
              <div>Date strategy: {result.date_strategy?.type || '-'}</div>
              <div>End date: {result.to_date || 'present'}</div>
              {result.fx_rate_cache?.enabled && (
                <div>
                  FX rows deleted: <Badge bg="warning" text="dark">{Number(result.fx_rate_cache?.rows_affected || 0).toLocaleString()}</Badge>
                </div>
              )}
            </small>
          </Alert>
        )}

        {previewData && !executing && (
          <Alert variant="warning" className="mb-3">
            <div className="fw-semibold mb-2 d-flex align-items-center gap-2">
              <Eye size={16} /> Preview
            </div>
            <small>
              {(() => {
                const marketRows = Number(previewData.rows_affected || 0);
                const fxRows = Number(previewData.fx_rate_cache?.rows_affected || 0);
                const mode = previewData.purge_mode || purgeMode;
                if (mode === 'fx') {
                  return (
                    <div className="mb-1">
                      Will purge <Badge bg="warning" text="dark">{fxRows.toLocaleString()}</Badge> FX rows
                    </div>
                  );
                }
                if (mode === 'both') {
                  return (
                    <div className="mb-1">
                      Will purge <Badge bg="danger">{marketRows.toLocaleString()}</Badge> market rows and{' '}
                      <Badge bg="warning" text="dark">{fxRows.toLocaleString()}</Badge> FX rows
                      across <Badge bg="secondary">{previewData.preview?.length || 0}</Badge> investment(s)
                    </div>
                  );
                }
                return (
                  <div className="mb-1">
                    Will purge <Badge bg="danger">{marketRows.toLocaleString()}</Badge> market rows
                    across <Badge bg="secondary">{previewData.preview?.length || 0}</Badge> investment(s)
                  </div>
                );
              })()}
              {previewData.fx_rate_cache?.enabled && (
                <div className="mb-1">
                  FX rows to purge: <Badge bg="warning" text="dark">{Number(previewData.fx_rate_cache?.rows_affected || 0).toLocaleString()}</Badge>
                  {' '}from {previewData.fx_rate_cache?.from_date || '-'} to {previewData.fx_rate_cache?.to_date || 'present'}
                </div>
              )}
              {previewData.preview && previewData.preview.length > 0 && (
                <div className="mt-2">
                  <div className="text-muted small mb-1">Sample (first 5):</div>
                  <div style={{ fontSize: '0.75rem', maxHeight: '140px', overflowY: 'auto' }}>
                    {previewData.preview.slice(0, 5).map((r, i) => (
                      <div key={i} className="text-muted">
                        {r.investment_name || `Investment ${r.investment_id}`} ({r.asset_type}) — {r.row_count.toLocaleString()} rows [from {r.from_date} to {r.to_date || 'present'}]
                      </div>
                    ))}
                    {previewData.preview.length > 5 && (
                      <div className="text-muted">... and {previewData.preview.length - 5} more</div>
                    )}
                  </div>
                </div>
              )}
            </small>
          </Alert>
        )}

        <Form.Group className="mb-3">
          <Form.Label className="fw-semibold">Purge Mode</Form.Label>
          <Form.Check
            type="radio"
            name="purgeMode"
            label="Market price cache only"
            value="market"
            checked={purgeMode === 'market'}
            onChange={(e) => setPurgeMode(e.target.value)}
          />
          <Form.Check
            type="radio"
            name="purgeMode"
            label="FX rate cache only"
            value="fx"
            checked={purgeMode === 'fx'}
            onChange={(e) => setPurgeMode(e.target.value)}
          />
          <Form.Check
            type="radio"
            name="purgeMode"
            label="Both market and FX cache"
            value="both"
            checked={purgeMode === 'both'}
            onChange={(e) => setPurgeMode(e.target.value)}
          />
        </Form.Group>

        {purgeMode !== 'fx' && (
          <Form.Group className="mb-3">
            <Form.Label className="fw-semibold">Select Investments</Form.Label>
            <Form.Check
              type="radio"
              label="All Active Investments"
              name="quickMode"
              value="all_active"
              checked={quickMode === 'all_active'}
              onChange={(e) => setQuickMode(e.target.value)}
            />
            <Form.Check
              type="radio"
              label="All Including Inactive"
              name="quickMode"
              value="all_including_inactive"
              checked={quickMode === 'all_including_inactive'}
              onChange={(e) => setQuickMode(e.target.value)}
            />
            <Form.Check
              type="radio"
              label="Specific Asset Type"
              name="quickMode"
              value="specific_asset"
              checked={quickMode === 'specific_asset'}
              onChange={(e) => setQuickMode(e.target.value)}
            />
            <Form.Check
              type="radio"
              label="Specific Investment"
              name="quickMode"
              value="specific_investment"
              checked={quickMode === 'specific_investment'}
              onChange={(e) => setQuickMode(e.target.value)}
            />
            {quickMode === 'specific_asset' && (
              <Form.Select
                value={quickAsset}
                onChange={(e) => setQuickAsset(e.target.value)}
                className="mt-2"
                size="sm"
              >
                <option value="">Choose asset type...</option>
                {ASSET_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {ASSET_TYPE_FULL_NAMES[t] ? `${ASSET_TYPE_FULL_NAMES[t]} (${t})` : t}
                  </option>
                ))}
              </Form.Select>
            )}
            {quickMode === 'specific_investment' && (
              <Form.Control
                type="number"
                min="1"
                step="1"
                value={quickInvestmentId}
                onChange={(e) => setQuickInvestmentId(e.target.value)}
                className="mt-2"
                size="sm"
                placeholder="Enter investment ID (e.g. 212)"
              />
            )}
          </Form.Group>
        )}

        {/* Date strategy + optional end date */}
        {purgeMode !== 'fx' ? (
          <Form.Group className="mb-3">
            <Form.Label className="fw-semibold">Purge Start Date Strategy</Form.Label>
            {DATE_STRATEGIES.map((strategy) => (
              <div key={strategy.value} className="mb-2">
                <Form.Check
                  type="radio"
                  label={strategy.label}
                  name="purgeDateStrategy"
                  value={strategy.value}
                  checked={dateStrategy === strategy.value}
                  onChange={(e) => setDateStrategy(e.target.value)}
                />
                <Form.Text className="d-block text-muted small ms-4">{strategy.desc}</Form.Text>
              </div>
            ))}

            {dateStrategy !== 'scope_first_transaction' && (
              <div className="ms-4 mt-2">
                <Form.Label className="small mb-1">Fixed Date</Form.Label>
                <Form.Control
                  type="date"
                  value={fixedDate}
                  onChange={(e) => setFixedDate(e.target.value)}
                  size="sm"
                />
              </div>
            )}

            <div className="mt-3">
              <Form.Label className="small mb-1">Optional End Date</Form.Label>
              <Form.Control
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                size="sm"
              />
            </div>
            <Form.Text className="small text-muted">
              Purge starts from calculated per-investment start date and deletes rows up to optional end date.
            </Form.Text>
            {purgeMode === 'both' && (
              <Form.Text className="small text-muted d-block">
                FX purge uses one shared FX window from the earliest computed start date across selected investments.
              </Form.Text>
            )}
          </Form.Group>
        ) : (
          <Form.Group className="mb-3">
            <Form.Label className="fw-semibold">FX Purge Date Window</Form.Label>
            <div className="mb-2">
              <Form.Label className="small mb-1">From Date (optional)</Form.Label>
              <Form.Control
                type="date"
                value={fxFromDate}
                onChange={(e) => setFxFromDate(e.target.value)}
                size="sm"
              />
              <Form.Text className="small text-muted">
                Leave blank to purge from earliest FX cache date.
              </Form.Text>
            </div>
            <div className="mt-2">
              <Form.Label className="small mb-1">To Date (optional)</Form.Label>
              <Form.Control
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                size="sm"
              />
            </div>
          </Form.Group>
        )}

        <div className="p-3 bg-light rounded small text-muted">
          Preview first to see how many rows will be deleted, then confirm the purge.
          Purged data will be re-fetched automatically on the next "Update Prices" run.
        </div>
      </Modal.Body>

      <Modal.Footer>
        <Button variant="secondary" onClick={handleClose} disabled={previewing || executing}>
          Close
        </Button>

        {!previewData && (
          <Button variant="primary" onClick={handlePreview} disabled={previewing}>
            {previewing ? <><Spinner size="sm" className="me-2" />Previewing...</> : <><Eye size={14} className="me-1" />Preview</>}
          </Button>
        )}

        {previewData && (
          <>
            <Button
              variant="outline-secondary"
              onClick={handlePreview}
              disabled={previewing || executing}
            >
              {previewing ? <><Spinner size="sm" className="me-2" />Previewing...</> : 'Refresh Preview'}
            </Button>
            <Button
              variant="danger"
              onClick={handleExecute}
              disabled={executing || previewing || (Number(previewData.rows_affected || 0) + Number(previewData.fx_rate_cache?.rows_affected || 0) === 0)}
            >
              {executing
                ? <><Spinner size="sm" className="me-2" />Purging...</>
                : <><Trash2 size={14} className="me-1" />Purge</>
              }
            </Button>
          </>
        )}
      </Modal.Footer>
    </Modal>
  );
}
