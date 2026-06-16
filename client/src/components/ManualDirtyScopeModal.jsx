import React, { useState } from 'react';
import { Modal, Button, Form, Alert, Tabs, Tab, Badge, Spinner } from 'react-bootstrap';
import { AlertCircle, Eye } from 'lucide-react';
import { markDirtyScopesFromSelector } from '../services/api';

const ASSET_TYPES = ['EQUITY', 'MUTUAL_FUND', 'ETF', 'NPS', 'FIXED_INCOME', 'COMMODITY', 'CRYPTO', 'RSU', 'ESPP'];

const DATE_STRATEGIES = [
  { value: 'scope_first_transaction', label: 'From First Transaction (default)', desc: 'Earliest transaction date for each scope' },
  { value: 'fixed_date', label: 'Fixed Date', desc: 'Specific date you choose' },
  { value: 'max_of_fixed_and_scope_first', label: 'Fixed OR First (max)', desc: 'Later of fixed date or first transaction' },
];

export default function ManualDirtyScopeModal({ show, onHide }) {
  const [tab, setTab] = useState('quick');
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

  // Custom selector
  const [portfolioIds, setPortfolioIds] = useState('');
  const [assetTypes, setAssetTypes] = useState('');
  const [investmentIds, setInvestmentIds] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [includeExcluded, setIncludeExcluded] = useState(false);

  // Date strategy
  const [dateStrategy, setDateStrategy] = useState('scope_first_transaction');
  const [fixedDate, setFixedDate] = useState(new Date().toISOString().split('T')[0]);

  // Metadata
  const [reason, setReason] = useState('manual-mark');
  const [dryRun, setDryRun] = useState(true);
  const [executeNow, setExecuteNow] = useState(false);

  const reset = () => {
    setTab('quick');
    setQuickMode('all_active');
    setQuickAsset('');
    setPortfolioIds('');
    setAssetTypes('');
    setInvestmentIds('');
    setIncludeInactive(false);
    setIncludeExcluded(false);
    setDateStrategy('scope_first_transaction');
    setFixedDate(new Date().toISOString().split('T')[0]);
    setReason('manual-mark');
    setDryRun(true);
    setExecuteNow(false);
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

    if (tab === 'quick') {
      if (quickMode === 'all_active') {
        // No selector filters = all active
        selector.include_inactive = false;
        selector.include_excluded = false;
      } else if (quickMode === 'specific_asset' && quickAsset) {
        selector.asset_types = [quickAsset];
        selector.include_inactive = false;
        selector.include_excluded = false;
      } else if (quickMode === 'all_including_inactive') {
        selector.include_inactive = true;
        selector.include_excluded = false;
      }
    } else {
      // Custom
      if (portfolioIds.trim()) {
        selector.portfolio_ids = portfolioIds.split(',').map(p => Number(p.trim())).filter(p => !isNaN(p));
      }
      if (assetTypes.trim()) {
        selector.asset_types = assetTypes.split(',').map(a => a.trim().toUpperCase()).filter(a => a);
      }
      if (investmentIds.trim()) {
        selector.investment_ids = investmentIds.split(',').map(i => Number(i.trim())).filter(i => !isNaN(i));
      }
      selector.include_inactive = includeInactive;
      selector.include_excluded = includeExcluded;
    }

    return selector;
  };

  const handlePreview = async () => {
    try {
      setError('');
      setPreviewData(null);
      setPreviewing(true);

      const selector = buildSelector();
      const payload = {
        selector,
        date_strategy: {
          type: dateStrategy,
          ...(dateStrategy !== 'scope_first_transaction' && { from_date: fixedDate }),
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
      const payload = {
        selector,
        date_strategy: {
          type: dateStrategy,
          ...(dateStrategy !== 'scope_first_transaction' && { from_date: fixedDate }),
        },
        reason,
        dry_run: false,
        execute_now: executeNow,
      };

      const data = await markDirtyScopesFromSelector(payload);
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
              <Eye size={16} /> Preview (Dry-Run)
            </div>
            <small>
              <div>Will match: <Badge bg="secondary">{previewData.matched_count}</Badge> scopes</div>
              {previewData.scopes && previewData.scopes.length > 0 && (
                <div className="mt-2">
                  <div className="small text-muted">Sample (first 5):</div>
                  <div style={{ fontSize: '0.75rem', maxHeight: '150px', overflowY: 'auto' }}>
                    {previewData.scopes.slice(0, 5).map((s, i) => (
                      <div key={i} className="text-muted">
                        Investment {s.investment_id} → {s.portfolio_id} from {s.dirty_from_date}
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

        <Tabs activeKey={tab} onSelect={(k) => setTab(k)} className="mb-3">
          {/* Quick Selector Tab */}
          <Tab eventKey="quick" title="Quick Selector">
            <div className="mt-3">
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
                        {t}
                      </option>
                    ))}
                  </Form.Select>
                )}
              </Form.Group>
            </div>
          </Tab>

          {/* Custom Selector Tab */}
          <Tab eventKey="custom" title="Custom Filters">
            <div className="mt-3 small text-muted mb-3">
              Leave blank to include all. Comma-separated IDs for specific selections.
            </div>

            <Form.Group className="mb-2">
              <Form.Label className="small">Portfolio IDs</Form.Label>
              <Form.Control
                type="text"
                placeholder="e.g. 1,2,3"
                value={portfolioIds}
                onChange={(e) => setPortfolioIds(e.target.value)}
                size="sm"
              />
            </Form.Group>

            <Form.Group className="mb-2">
              <Form.Label className="small">Asset Types</Form.Label>
              <Form.Control
                type="text"
                placeholder="e.g. MUTUAL_FUND,NPS"
                value={assetTypes}
                onChange={(e) => setAssetTypes(e.target.value)}
                size="sm"
              />
            </Form.Group>

            <Form.Group className="mb-3">
              <Form.Label className="small">Investment IDs</Form.Label>
              <Form.Control
                type="text"
                placeholder="e.g. 212,45,67"
                value={investmentIds}
                onChange={(e) => setInvestmentIds(e.target.value)}
                size="sm"
              />
            </Form.Group>

            <Form.Check
              type="checkbox"
              label="Include Inactive Investments"
              checked={includeInactive}
              onChange={(e) => setIncludeInactive(e.target.checked)}
              className="mb-2 small"
            />
            <Form.Check
              type="checkbox"
              label="Include Excluded from Tracking"
              checked={includeExcluded}
              onChange={(e) => setIncludeExcluded(e.target.checked)}
              className="mb-2 small"
            />
          </Tab>
        </Tabs>

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

        {/* Checkboxes */}
        <Form.Group className="mb-3 p-3 bg-light rounded">
          <Form.Check
            type="checkbox"
            label={<span>Dry-run first <Badge bg="info">recommended</Badge></span>}
            checked={dryRun}
            onChange={(e) => setDryRun(e.target.checked)}
            className="mb-2"
          />
          <Form.Text className="d-block small text-muted mb-2">
            Shows what will be marked without writing to database.
          </Form.Text>

          {!dryRun && (
            <Form.Check
              type="checkbox"
              label="Execute immediately after marking"
              checked={executeNow}
              onChange={(e) => setExecuteNow(e.target.checked)}
              className="text-danger small"
            />
          )}
        </Form.Group>
      </Modal.Body>

      <Modal.Footer>
        <Button variant="secondary" onClick={handleClose} disabled={loading || previewing || executing}>
          Close
        </Button>

        {dryRun && !previewData && (
          <Button
            variant="primary"
            onClick={handlePreview}
            disabled={previewing || loading}
          >
            {previewing ? <><Spinner size="sm" className="me-2" />Previewing...</> : 'Preview'}
          </Button>
        )}

        {previewData && dryRun && (
          <>
            <Button
              variant="outline-primary"
              onClick={() => { setDryRun(false); setPreviewData(null); }}
              disabled={executing}
            >
              Continue to Execute
            </Button>
          </>
        )}

        {!dryRun && (
          <Button
            variant="success"
            onClick={handleExecute}
            disabled={executing || loading}
          >
            {executing ? <><Spinner size="sm" className="me-2" />Executing...</> : 'Execute'}
          </Button>
        )}
      </Modal.Footer>
    </Modal>
  );
}
