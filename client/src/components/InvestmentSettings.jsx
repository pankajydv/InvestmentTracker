import React, { useEffect, useState } from 'react';
import { useParams, Link, useLocation } from 'react-router-dom';
import { Card, Form, Button, Row, Col, Spinner, Alert } from 'react-bootstrap';
import { getInvestment, updateInvestment } from '../services/api';
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
  const [form, setForm] = useState({
    display_name: '',
    ticker_symbol: '',
    isin_code: '',
    amfi_code: '',
  });

  useEffect(() => { loadData(); }, [id]);

  const loadData = async () => {
    try {
      setLoading(true);
      const result = await getInvestment(id);
      setData(result);
      setForm({
        display_name: result.display_name || '',
        ticker_symbol: (result.ticker_symbol || '').replace(/\.(NS|BO)$/, ''),
        isin_code: result.isin_code || '',
        amfi_code: result.amfi_code || '',
      });
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async (e) => {
    e.preventDefault();
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
      });
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="d-flex justify-content-center py-5"><Spinner animation="border" variant="primary" /></div>;
  if (!data) return <div className="text-danger">Investment not found</div>;

  const isMF = data.asset_type === 'MUTUAL_FUND';

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

              {/* NSE Ticker (stocks only) */}
              {!isMF && (
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

              {/* ISIN (readonly) */}
              <Col md={4}>
                <Form.Group>
                  <Form.Label className="small fw-semibold">ISIN Code</Form.Label>
                  <Form.Control
                    type="text"
                    value={form.isin_code}
                    readOnly
                    disabled
                    className="bg-light"
                    placeholder="Auto-populated from imports"
                  />
                  <Form.Text className="text-muted">
                    Universal security identifier. Set during import.
                  </Form.Text>
                </Form.Group>
              </Col>

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
                <Button type="submit" variant="primary" disabled={saving} className="d-flex align-items-center gap-2">
                  <Save size={16} />
                  {saving ? 'Saving...' : 'Save Settings'}
                </Button>
              </Col>
            </Row>
          </Form>
        </Card.Body>
      </Card>
    </div>
  );
}
