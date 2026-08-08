import React, { useState } from 'react';
import { Modal, Button, Form, Alert, Badge, Spinner } from 'react-bootstrap';
import { Eye } from 'lucide-react';
import { markDirtyScopesFromSelector } from '../services/api';
import { ASSET_TYPE_FILTER_ORDER, ASSET_TYPE_FULL_NAMES } from '../utils/formatters';

const ASSET_TYPES = ASSET_TYPE_FILTER_ORDER;

const DATE_STRATEGIES = [
  { value: 'scope_first_transaction', label: 'From First Transaction (default)', desc: 'Earliest transaction date for each scope' },
  { value: 'max_of_fixed_and_scope_first', label: 'Fixed OR First (max)', desc: 'Later of fixed date or first transaction' },
];

function normalizeDateStrategy(strategy) {
  return strategy === 'fixed_date' ? 'max_of_fixed_and_scope_first' : strategy;
}

function formatScopeName(scope) {
  const rawName = String(scope?.portfolio_name || '').trim();
  if (rawName && !/^portfolio\s*\d*$/i.test(rawName)) return rawName;
  return 'Portfolio';
}

export default function ManualDirtyScopeModal({ show, onHide }) {
  const [loading, setLoading] = useState(false);
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

  // Date strategy
  const [dateStrategy, setDateStrategy] = useState('scope_first_transaction');
  const [fixedDate, setFixedDate] = useState(new Date().toISOString().split('T')[0]);

  // Metadata
  const [reason, setReason] = useState('manual-mark');

  const reset = () => {
    setQuickMode('all_active');
    setQuickAsset('');
    setQuickInvestmentId('');
    setDateStrategy('scope_first_transaction');
    setFixedDate(new Date().toISOString().split('T')[0]);
    setReason('manual-mark');
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
      // No selector filters = all active
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

  const handlePreview = async () => {
    try {
      setError('');
      setPreviewData(null);
      setPreviewing(true);

      const selector = buildSelector();
      const normalizedDateStrategy = normalizeDateStrategy(dateStrategy);
      const payload = {
        selector,
        date_strategy: {
          type: normalizedDateStrategy,
          ...(normalizedDateStrategy !== 'scope_first_transaction' && { from_date: fixedDate }),
        },
        reason,
        dry_run: true,
      };

      const data = await markDirtyScopesFromSelector(payload);
      setPreviewData(data);
    } catch (e) {
      setError(e.message || 'Preview failed');
    } finally {
      setPreviewing(false);
    }
  };

  const handleExecute = async () => {
    try {
      setError('');
      setSuccessMsg('');
      setExecuting(true);

      const selector = buildSelector();
      const normalizedDateStrategy = normalizeDateStrategy(dateStrategy);
      const payload = {
        selector,
        date_strategy: {
          type: normalizedDateStrategy,
          ...(normalizedDateStrategy !== 'scope_first_transaction' && { from_date: fixedDate }),
        },
        reason,
        dry_run: false,
      };

      const data = await markDirtyScopesFromSelector(payload);
      setPreviewData(null);
      setResult(data);
      setSuccessMsg(`✓ Enqueued ${data.enqueued_count} scopes for backfill`);
    } catch (e) {
      setError(e.message || 'Execution failed');
    } finally {
      setExecuting(false);
    }
  };

  return (
    <Modal show={show} onHide={handleClose} size="lg" centered>
      <Modal.Header closeButton>
        <Modal.Title>Mark Daily Values Dirty</Modal.Title>
      </Modal.Header>

      <Modal.Body style={{ maxHeight: '70vh', overflowY: 'auto' }}>
        {error && <Alert variant="danger" className="mb-3">{error}</Alert>}
        {successMsg && <Alert variant="success" className="mb-3">{successMsg}</Alert>}

        {result && !executing && (
          <Alert variant="info" className="mb-3">
            <div className="fw-semibold mb-2">✓ Execution Complete</div>
            <small>
              <div>Matched: <Badge bg="secondary">{result.matched_count}</Badge></div>
              <div>Enqueued: <Badge bg="success">{result.enqueued_count}</Badge></div>
              {result.errors && result.errors.length > 0 && (
                <div className="mt-2 text-danger">Errors: {result.errors.length}</div>
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
              <div>Will match: <Badge bg="secondary">{previewData.matched_count}</Badge> scopes</div>
              {previewData.scopes && previewData.scopes.length > 0 && (
                <div className="mt-2">
                  <div className="small text-muted">Sample (first 5):</div>
                  <div style={{ fontSize: '0.75rem', maxHeight: '150px', overflowY: 'auto' }}>
                    {previewData.scopes.slice(0, 5).map((s, i) => (
                      <div key={i} className="text-muted">
                        Investment {s.investment_id} ({formatScopeName(s)}) from {s.dirty_from_date}
                      </div>
                    ))}
                    {previewData.scopes.length > 5 && (
                      <div className="text-muted">... and {previewData.scopes.length - 5} more</div>
                    )}
                  </div>
                </div>
              )}
            </small>
          </Alert>
        )}

        <Form.Group className="mb-3">
          <Form.Label className="fw-semibold">Select Scope</Form.Label>
          <Form.Check
            type="radio"
            label="All Active Investments (default)"
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

        {/* Date Strategy */}
        <Form.Group className="mb-3">
          <Form.Label className="fw-semibold">Dirty From Date</Form.Label>
          {DATE_STRATEGIES.map((strategy) => (
            <div key={strategy.value} className="mb-2">
              <Form.Check
                type="radio"
                label={`${strategy.label}`}
                name="dateStrategy"
                value={strategy.value}
                checked={dateStrategy === strategy.value}
                onChange={(e) => setDateStrategy(e.target.value)}
                id={`strategy-${strategy.value}`}
              />
              <Form.Text className="d-block text-muted small ms-4 mb-2">
                {strategy.desc}
              </Form.Text>
            </div>
          ))}

          {dateStrategy !== 'scope_first_transaction' && (
            <Form.Group className="mt-3 ms-4">
              <Form.Label className="small">Fixed Date</Form.Label>
              <Form.Control
                type="date"
                value={fixedDate}
                onChange={(e) => setFixedDate(e.target.value)}
                size="sm"
              />
            </Form.Group>
          )}
        </Form.Group>

        {/* Metadata */}
        <Form.Group className="mb-3">
          <Form.Label className="fw-semibold">Reason</Form.Label>
          <Form.Control
            type="text"
            placeholder="e.g. manual-correction, fx-rate-fix"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            size="sm"
          />
          <Form.Text className="small text-muted">For audit trail</Form.Text>
        </Form.Group>

        <Form.Group className="mb-3 p-3 bg-light rounded">
          <Form.Text className="d-block small text-muted mb-0">
            Preview first to verify matches, then mark dirty scopes.
          </Form.Text>
        </Form.Group>
      </Modal.Body>

      <Modal.Footer>
        <Button variant="secondary" onClick={handleClose} disabled={loading || previewing || executing}>
          Close
        </Button>

        {!previewData && (
          <Button
            variant="primary"
            onClick={handlePreview}
            disabled={previewing || loading}
          >
            {previewing ? <><Spinner size="sm" className="me-2" />Previewing...</> : 'Preview'}
          </Button>
        )}

        {previewData && (
          <>
            <Button
              variant="outline-secondary"
              onClick={handlePreview}
              disabled={previewing || executing || loading}
            >
              {previewing ? <><Spinner size="sm" className="me-2" />Previewing...</> : 'Refresh Preview'}
            </Button>
            <Button
              variant="success"
              onClick={handleExecute}
              disabled={executing || loading || previewing}
            >
              {executing ? <><Spinner size="sm" className="me-2" />Marking...</> : 'Mark Dirty Scopes'}
            </Button>
          </>
        )}
      </Modal.Footer>
    </Modal>
  );
}
