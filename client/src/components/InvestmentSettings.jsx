import React, { useEffect, useState } from 'react';
import { useParams, Link, useLocation } from 'react-router-dom';
import { Card, Form, Button, Row, Col, Spinner, Alert, Table } from 'react-bootstrap';
import {
  getInvestment,
  updateInvestment,
  getInvestmentSymbolHistory,
  createInvestmentSymbolHistory,
} from '../services/api';
import { ArrowLeft, Save } from 'lucide-react';
import { ASSET_TYPE_LABELS } from '../utils/formatters';

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
  const [historyForm, setHistoryForm] = useState({
    symbol: '',
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

  const resetHistoryForm = () => {
    setIsAddingHistory(false);
    setHistoryForm({
      symbol: '',
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
      setForm({
        display_name: result.display_name || '',
        ticker_symbol: (result.ticker_symbol || '').replace(/\.(NS|BO)$/, ''),
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

  const handleStartAddHistory = () => {
    setHistoryError(null);
    setHistorySuccess('');
    setIsAddingHistory(true);
    setHistoryForm({
      symbol: '',
      valid_from: '',
      valid_to: '',
      notes: '',
    });
  };

  const handleSave = async (e) => {
    e.preventDefault();
    const confirmed = window.confirm('Save changes to this investment settings record?');
    if (!confirmed) return;

    try {
      setSaving(true);
      setError(null);
      setSuccess(false);
      const tickerToSave = form.ticker_symbol
        ? (form.ticker_symbol.includes('.') ? form.ticker_symbol : form.ticker_symbol + '.NS')
        : null;
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
        valid_from: historyForm.valid_from,
        valid_to: historyForm.valid_to || null,
        notes: historyForm.notes || null,
      };

      await createInvestmentSymbolHistory(id, payload);
      setHistorySuccess('Symbol history added successfully.');

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
  const showSymbolHistory = data.asset_type === 'INDIAN_STOCK';

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
            <div className="d-flex align-items-center justify-content-between mb-2">
              <h2 className="h6 fw-bold mb-0">Symbol History</h2>
              <Button variant="outline-primary" size="sm" onClick={handleStartAddHistory} disabled={historySaving || isAddingHistory}>
                Add
              </Button>
            </div>
            <p className="text-muted small mb-3">
              Track ticker changes over time for correct historical price fetch and compliance checks.
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
                    <th>Symbol</th>
                    <th>Valid From</th>
                    <th>Valid To</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {historyRows.map((row) => (
                    <tr key={row.id}>
                      <td>{row.symbol}</td>
                      <td>{row.valid_from}</td>
                      <td>{row.valid_to || 'Open'}</td>
                      <td className="small text-muted">{row.notes || '-'}</td>
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
                  <Col md={3}>
                    <Form.Group>
                      <Form.Label className="small fw-semibold">Symbol</Form.Label>
                      <Form.Control
                        type="text"
                        value={historyForm.symbol}
                        onChange={(e) => setHistoryForm((prev) => ({ ...prev, symbol: e.target.value }))}
                        placeholder="e.g. ITIETF"
                        required
                        disabled={historySaving}
                      />
                    </Form.Group>
                  </Col>
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
                      {historySaving ? 'Saving...' : 'Add History Row'}
                    </Button>
                    <Button type="button" variant="outline-secondary" onClick={resetHistoryForm} disabled={historySaving}>
                      Cancel
                    </Button>
                  </Col>
                </Row>
              </Form>
            )}
          </Card.Body>
        </Card>
      )}
    </div>
  );
}
