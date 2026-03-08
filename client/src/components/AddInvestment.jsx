import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, Row, Col, Button, Form, Alert } from 'react-bootstrap';
import { createInvestment, addTransaction, searchMutualFunds, searchStock } from '../services/api';
import { ASSET_TYPE_LABELS } from '../utils/formatters';
import { ArrowLeft, Search, CheckCircle, FileUp } from 'lucide-react';
import { usePortfolio } from '../context/PortfolioContext';
import { Link } from 'react-router-dom';

const ASSET_TYPES = ['MUTUAL_FUND', 'INDIAN_STOCK', 'FOREIGN_STOCK', 'PPF', 'PF'];

export default function AddInvestment() {
  const navigate = useNavigate();
  const { portfolios, selectedId } = usePortfolio();
  const [step, setStep] = useState(1);
  const [assetType, setAssetType] = useState('MUTUAL_FUND');
  const [portfolioId, setPortfolioId] = useState(selectedId || '');
  const [form, setForm] = useState({
    name: '',
    ticker_symbol: '',
    amfi_code: '',
    folio_number: '',
    account_number: '',
    interest_rate: '',
    currency: 'INR',
    notes: '',
  });
  const [txn, setTxn] = useState({
    transaction_type: 'BUY',
    transaction_date: new Date().toISOString().split('T')[0],
    units: '',
    price_per_unit: '',
    amount: '',
    fees: '0',
  });
  const [mfResults, setMfResults] = useState([]);
  const [mfSearch, setMfSearch] = useState('');
  const [searching, setSearching] = useState(false);
  const [stockInfo, setStockInfo] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const updateTxn = (field, value) => {
    const updated = { ...txn, [field]: value };
    if ((field === 'units' || field === 'price_per_unit') && updated.units && updated.price_per_unit) {
      updated.amount = (parseFloat(updated.units) * parseFloat(updated.price_per_unit)).toFixed(2);
    }
    setTxn(updated);
  };

  const handleMfSearch = async () => {
    if (mfSearch.length < 2) return;
    setSearching(true);
    try {
      const results = await searchMutualFunds(mfSearch);
      setMfResults(results);
    } catch (e) {
      console.error(e);
    } finally {
      setSearching(false);
    }
  };

  const selectMf = (mf) => {
    setForm({ ...form, name: mf.schemeName, amfi_code: mf.schemeCode });
    setMfResults([]);
    setMfSearch(mf.schemeName);
  };

  const handleStockSearch = async () => {
    if (!form.ticker_symbol) return;
    setSearching(true);
    try {
      const market = assetType === 'INDIAN_STOCK' ? 'NSE' : '';
      const data = await searchStock(form.ticker_symbol, market);
      setStockInfo(data);
      setForm({ ...form, name: data.name, currency: data.currency === 'USD' ? 'USD' : 'INR' });
    } catch (e) {
      setStockInfo(null);
      setError(`Could not find stock: ${form.ticker_symbol}`);
    } finally {
      setSearching(false);
    }
  };

  const handleSubmit = async () => {
    setError('');
    setSubmitting(true);
    try {
      if (!form.name) {
        setError('Name is required');
        setSubmitting(false);
        return;
      }

      const inv = await createInvestment({
        name: form.name,
        asset_type: assetType,
        ticker_symbol: form.ticker_symbol || null,
        amfi_code: form.amfi_code || null,
        folio_number: form.folio_number || null,
        account_number: form.account_number || null,
        interest_rate: form.interest_rate ? parseFloat(form.interest_rate) : null,
        currency: form.currency,
        notes: form.notes || null,
        portfolio_id: portfolioId || null,
      });

      if (txn.amount && parseFloat(txn.amount) > 0) {
        const isPPF = assetType === 'PPF' || assetType === 'PF';
        await addTransaction({
          investment_id: inv.id,
          transaction_type: isPPF ? 'DEPOSIT' : txn.transaction_type,
          transaction_date: txn.transaction_date,
          units: txn.units ? parseFloat(txn.units) : null,
          price_per_unit: txn.price_per_unit ? parseFloat(txn.price_per_unit) : null,
          amount: parseFloat(txn.amount),
          fees: parseFloat(txn.fees) || 0,
        });
      }

      navigate(`/investments/${inv.id}`);
    } catch (e) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  const isPPF = assetType === 'PPF' || assetType === 'PF';
  const isMF = assetType === 'MUTUAL_FUND';
  const isStock = assetType === 'INDIAN_STOCK' || assetType === 'FOREIGN_STOCK';

  return (
    <div className="mx-auto d-flex flex-column gap-4" style={{ maxWidth: 680 }}>
      <div>
        <button onClick={() => navigate(-1)} className="btn btn-link btn-sm text-muted text-decoration-none d-flex align-items-center gap-1 mb-2 p-0">
          <ArrowLeft className="h-4 w-4" /> Back
        </button>
        <h1 className="h4 fw-bold">Add Investment</h1>
      </div>

      {/* CAS Import Banner */}
      <Link
        to="/investments/import-cas"
        className="text-decoration-none d-block rounded border p-3"
        style={{ background: 'linear-gradient(to right, #eff6ff, #eef2ff)', borderColor: '#bfdbfe' }}
      >
        <div className="d-flex align-items-center gap-3">
          <FileUp size={32} className="text-primary" />
          <div>
            <div className="fw-semibold text-dark">Import from CAS PDF</div>
            <div className="small text-muted">Upload CDSL Consolidated Account Statement to bulk-import all your holdings</div>
          </div>
        </div>
      </Link>

      {error && <Alert variant="danger" className="small py-2">{error}</Alert>}

      {/* Step 1: Choose Asset Type */}
      <Card className="shadow-sm">
        <Card.Body>
          <h2 className="h6 fw-semibold mb-3">1. Choose Asset Type</h2>
          <Row className="g-2" xs={2} sm={5}>
            {ASSET_TYPES.map((type) => (
              <Col key={type}>
                <button
                  onClick={() => {
                    setAssetType(type);
                    setForm({ ...form, name: '', ticker_symbol: '', amfi_code: '', currency: type === 'FOREIGN_STOCK' ? 'USD' : 'INR' });
                    setStockInfo(null);
                    setMfResults([]);
                    setMfSearch('');
                  }}
                  className={`btn w-100 btn-sm border-2 ${
                    assetType === type
                      ? 'btn-outline-primary border-primary bg-primary bg-opacity-10'
                      : 'btn-outline-secondary'
                  }`}
                >
                  {ASSET_TYPE_LABELS[type]}
                </button>
              </Col>
            ))}
          </Row>

          {portfolios.length > 0 && (
            <div className="mt-3 pt-3 border-top">
              <Form.Label className="small">Assign to Portfolio</Form.Label>
              <Form.Select
                size="sm"
                value={portfolioId || ''}
                onChange={(e) => setPortfolioId(e.target.value ? Number(e.target.value) : '')}
                style={{ width: 'auto' }}
              >
                <option value="">Unassigned</option>
                {portfolios.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </Form.Select>
            </div>
          )}
        </Card.Body>
      </Card>

      {/* Step 2: Investment Details */}
      <Card className="shadow-sm">
        <Card.Body>
          <h2 className="h6 fw-semibold mb-3">2. Investment Details</h2>

          {/* Mutual Fund Search */}
          {isMF && (
            <div className="mb-3">
              <Form.Label className="small">Search Mutual Fund</Form.Label>
              <div className="d-flex gap-2">
                <Form.Control
                  size="sm"
                  type="text"
                  value={mfSearch}
                  onChange={(e) => setMfSearch(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleMfSearch()}
                  placeholder="Search by fund name (e.g., HDFC Flexi Cap)"
                />
                <Button size="sm" variant="primary" onClick={handleMfSearch} disabled={searching}>
                  <Search size={16} />
                </Button>
              </div>
              {mfResults.length > 0 && (
                <div className="mt-2 border rounded" style={{ maxHeight: 240, overflowY: 'auto' }}>
                  {mfResults.map((mf) => (
                    <button
                      key={mf.schemeCode}
                      onClick={() => selectMf(mf)}
                      className="w-100 text-start px-3 py-2 small border-bottom bg-transparent border-0"
                      style={{ cursor: 'pointer' }}
                      onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#eff6ff'}
                      onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                    >
                      <div className="fw-medium">{mf.schemeName}</div>
                      <div className="text-muted" style={{ fontSize: '0.75rem' }}>Code: {mf.schemeCode}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Stock Ticker Search */}
          {isStock && (
            <div className="mb-3">
              <Form.Label className="small">
                {assetType === 'INDIAN_STOCK' ? 'NSE Symbol' : 'Ticker Symbol'}
              </Form.Label>
              <div className="d-flex gap-2">
                <Form.Control
                  size="sm"
                  type="text"
                  value={form.ticker_symbol}
                  onChange={(e) => setForm({ ...form, ticker_symbol: e.target.value.toUpperCase() })}
                  onKeyDown={(e) => e.key === 'Enter' && handleStockSearch()}
                  placeholder={assetType === 'INDIAN_STOCK' ? 'e.g., RELIANCE, TCS, INFY' : 'e.g., AAPL, MSFT, GOOGL'}
                />
                <Button size="sm" variant="primary" onClick={handleStockSearch} disabled={searching}>
                  <Search size={16} />
                </Button>
              </div>
              {stockInfo && (
                <div className="mt-2 p-2 bg-success bg-opacity-10 rounded d-flex align-items-center gap-2">
                  <CheckCircle size={16} className="text-success" />
                  <span className="small text-success">
                    Found: <strong>{stockInfo.name}</strong> — ₹{stockInfo.price?.toFixed(2)} ({stockInfo.currency})
                  </span>
                </div>
              )}
            </div>
          )}

          <Row className="g-3">
            <Col md={6}>
              <Form.Label className="small">Name</Form.Label>
              <Form.Control
                size="sm"
                type="text"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Investment name"
                required
              />
            </Col>

            {isMF && (
              <>
                <Col md={6}>
                  <Form.Label className="small">AMFI Code</Form.Label>
                  <Form.Control
                    size="sm"
                    type="text"
                    value={form.amfi_code}
                    onChange={(e) => setForm({ ...form, amfi_code: e.target.value })}
                    placeholder="e.g., 118989"
                  />
                </Col>
                <Col md={6}>
                  <Form.Label className="small">Folio Number</Form.Label>
                  <Form.Control
                    size="sm"
                    type="text"
                    value={form.folio_number}
                    onChange={(e) => setForm({ ...form, folio_number: e.target.value })}
                    placeholder="Optional"
                  />
                </Col>
              </>
            )}

            {isPPF && (
              <>
                <Col md={6}>
                  <Form.Label className="small">Account Number</Form.Label>
                  <Form.Control
                    size="sm"
                    type="text"
                    value={form.account_number}
                    onChange={(e) => setForm({ ...form, account_number: e.target.value })}
                    placeholder="Account number"
                  />
                </Col>
                <Col md={6}>
                  <Form.Label className="small">Interest Rate (% p.a.)</Form.Label>
                  <Form.Control
                    size="sm"
                    type="number"
                    step="0.01"
                    value={form.interest_rate}
                    onChange={(e) => setForm({ ...form, interest_rate: e.target.value })}
                    placeholder={assetType === 'PPF' ? '7.1' : '8.25'}
                  />
                </Col>
              </>
            )}

            <Col md={6}>
              <Form.Label className="small">Notes</Form.Label>
              <Form.Control
                size="sm"
                type="text"
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                placeholder="Optional notes"
              />
            </Col>
          </Row>
        </Card.Body>
      </Card>

      {/* Step 3: Initial Transaction */}
      <Card className="shadow-sm">
        <Card.Body>
          <h2 className="h6 fw-semibold mb-3">
            3. Initial Transaction <span className="fw-normal text-muted small">(optional)</span>
          </h2>

          <Row className="g-3">
            <Col md={6}>
              <Form.Label className="small">Date</Form.Label>
              <Form.Control
                size="sm"
                type="date"
                value={txn.transaction_date}
                onChange={(e) => updateTxn('transaction_date', e.target.value)}
              />
            </Col>

            {!isPPF && (
              <>
                <Col md={6}>
                  <Form.Label className="small">Units / Shares</Form.Label>
                  <Form.Control
                    size="sm"
                    type="number"
                    step="0.001"
                    value={txn.units}
                    onChange={(e) => updateTxn('units', e.target.value)}
                    placeholder="Number of units"
                  />
                </Col>
                <Col md={6}>
                  <Form.Label className="small">Price per Unit (₹)</Form.Label>
                  <Form.Control
                    size="sm"
                    type="number"
                    step="0.01"
                    value={txn.price_per_unit}
                    onChange={(e) => updateTxn('price_per_unit', e.target.value)}
                    placeholder="Cost per unit"
                  />
                </Col>
              </>
            )}

            <Col md={6}>
              <Form.Label className="small">Total Amount (₹)</Form.Label>
              <Form.Control
                size="sm"
                type="number"
                step="0.01"
                value={txn.amount}
                onChange={(e) => updateTxn('amount', e.target.value)}
                placeholder="Total invested amount"
              />
            </Col>

            <Col md={6}>
              <Form.Label className="small">Fees (₹)</Form.Label>
              <Form.Control
                size="sm"
                type="number"
                step="0.01"
                value={txn.fees}
                onChange={(e) => updateTxn('fees', e.target.value)}
                placeholder="0"
              />
            </Col>
          </Row>
        </Card.Body>
      </Card>

      {/* Submit */}
      <div className="d-flex justify-content-end gap-2">
        <Button variant="outline-secondary" onClick={() => navigate(-1)}>
          Cancel
        </Button>
        <Button variant="primary" onClick={handleSubmit} disabled={submitting}>
          {submitting ? 'Adding...' : 'Add Investment'}
        </Button>
      </div>
    </div>
  );
}
