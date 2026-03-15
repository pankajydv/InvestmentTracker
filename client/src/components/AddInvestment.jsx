import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, Row, Col, Button, Form, Alert, Spinner, Collapse } from 'react-bootstrap';
import { createInvestment, addTransaction, searchMutualFunds, searchStock, previewContractNotes, importContractNotes, uploadPnLStatement, addAmcCharge } from '../services/api';
import { ASSET_TYPE_LABELS } from '../utils/formatters';
import { ArrowLeft, Search, CheckCircle, FileText, Upload, Receipt, Wallet } from 'lucide-react';
import { usePortfolio } from '../context/PortfolioContext';

const ASSET_TYPES = ['MUTUAL_FUND', 'INDIAN_STOCK', 'FOREIGN_STOCK', 'PPF', 'PF'];
const STOCK_TXN_TYPES = ['BUY', 'SELL'];

export default function AddInvestment() {
  const navigate = useNavigate();
  const { portfolios, selectedId, refreshPortfolios } = usePortfolio();
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

  // Contract notes upload state
  const contractFileRef = useRef(null);
  const [contractFiles, setContractFiles] = useState([]);
  const [contractUploading, setContractUploading] = useState(false);
  const [contractResult, setContractResult] = useState(null);
  const [contractPreview, setContractPreview] = useState(null); // preview data from server
  const [contractImporting, setContractImporting] = useState(false);

  // P&L upload state
  const pnlFileRef = useRef(null);
  const [pnlFile, setPnlFile] = useState(null);
  const [pnlBroker, setPnlBroker] = useState('');
  const [pnlUploading, setPnlUploading] = useState(false);
  const [pnlResult, setPnlResult] = useState(null);

  // AMC charges state
  const [amcForm, setAmcForm] = useState({ date: new Date().toISOString().split('T')[0], amount: '', broker: 'Sharekhan', notes: '' });
  const [amcSubmitting, setAmcSubmitting] = useState(false);
  const [amcResult, setAmcResult] = useState(null);

  // Accordion state for Indian Stocks sections (null = all collapsed)
  const [expandedSection, setExpandedSection] = useState(null);
  const toggleSection = (key) => setExpandedSection(prev => prev === key ? null : key);

  // Sync local portfolioId when navbar portfolio changes
  useEffect(() => {
    setPortfolioId(selectedId || '');
    setError('');
    setContractPreview(null);
  }, [selectedId]);

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

  const handleContractUpload = async () => {
    setError('');
    if (!portfolioId) return setError('Please select a portfolio first');
    if (!contractFiles.length) return setError('Please select at least one contract note file');
    setContractUploading(true);
    try {
      const preview = await previewContractNotes(contractFiles, portfolioId);
      setContractPreview(preview);
    } catch (e) {
      setError(e.message);
    } finally {
      setContractUploading(false);
    }
  };

  const handleContractApprove = async () => {
    setError('');
    if (!contractPreview) return;
    setContractImporting(true);
    try {
      const result = await importContractNotes(portfolioId, contractPreview.broker, contractPreview.trades);
      setContractResult(result);
      setContractPreview(null);
      await refreshPortfolios();
    } catch (e) {
      setError(e.message);
    } finally {
      setContractImporting(false);
    }
  };

  const handleContractCancel = () => {
    setContractPreview(null);
    setContractFiles([]);
    if (contractFileRef.current) contractFileRef.current.value = '';
  };

  const updatePreviewTrade = (index, field, value) => {
    setContractPreview(prev => {
      const trades = [...prev.trades];
      trades[index] = { ...trades[index], [field]: value };
      // Recalculate total if quantity or rate changed
      if (field === 'quantity' || field === 'rate') {
        trades[index].total = (parseFloat(trades[index].quantity) || 0) * (parseFloat(trades[index].rate) || 0);
      }
      return { ...prev, trades };
    });
  };

  const removePreviewTrade = (index) => {
    setContractPreview(prev => ({
      ...prev,
      trades: prev.trades.filter((_, i) => i !== index),
    }));
  };

  const handlePnlUpload = async () => {
    setError('');
    if (!portfolioId) return setError('Please select a portfolio first');
    if (!pnlFile) return setError('Please select a P&L statement file');
    if (!pnlBroker) return setError('Please select a broker');
    setPnlUploading(true);
    try {
      const result = await uploadPnLStatement(pnlFile, pnlBroker, portfolioId);
      setPnlResult(result);
      await refreshPortfolios();
    } catch (e) {
      setError(e.message);
    } finally {
      setPnlUploading(false);
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
  const isIndianStock = assetType === 'INDIAN_STOCK';
  const isForeignStock = assetType === 'FOREIGN_STOCK';
  const isStock = isIndianStock || isForeignStock;

  const handleAmcSubmit = async () => {
    setError('');
    if (!portfolioId) return setError('Please select a portfolio first');
    if (!amcForm.amount || parseFloat(amcForm.amount) <= 0) return setError('Please enter a valid amount');
    setAmcSubmitting(true);
    try {
      await addAmcCharge({ portfolio_id: portfolioId, date: amcForm.date, amount: parseFloat(amcForm.amount), broker: amcForm.broker, notes: amcForm.notes });
      setAmcResult(`₹${Math.abs(parseFloat(amcForm.amount)).toLocaleString('en-IN')} recorded.`);
      setAmcForm({ date: new Date().toISOString().split('T')[0], amount: '', broker: amcForm.broker, notes: '' });
    } catch (e) {
      setError(e.message);
    } finally {
      setAmcSubmitting(false);
    }
  };

  const brokerOptions = [
    { value: 'Sharekhan', label: 'Sharekhan' },
    { value: 'Groww', label: 'Groww' },
    { value: 'Zerodha', label: 'Zerodha' },
    { value: 'Angel', label: 'Angel One' },
    { value: 'ICICI', label: 'ICICI Direct' },
    { value: 'HDFC', label: 'HDFC Securities' },
    { value: 'Kotak', label: 'Kotak Securities' },
    { value: 'Other', label: 'Other' },
  ];

  return (
    <div className="mx-auto d-flex flex-column gap-4" style={{ maxWidth: 680 }}>
      <div>
        <button onClick={() => navigate(-1)} className="btn btn-link btn-sm text-muted text-decoration-none d-flex align-items-center gap-1 mb-2 p-0">
          <ArrowLeft className="h-4 w-4" /> Back
        </button>
        <h1 className="h4 fw-bold">Add Investment</h1>
      </div>

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
                    setContractResult(null);
                    setContractPreview(null);
                    setPnlResult(null);
                    setError('');
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
        </Card.Body>
      </Card>

      {/* Indian Stocks: collapsible sections */}
      {isIndianStock && (
        <>
          {/* Upload Contract Notes */}
          <Card className="shadow-sm">
            <Card.Header
              className="d-flex align-items-center gap-2 bg-white py-2 px-3"
              style={{ cursor: 'pointer' }}
              onClick={() => toggleSection('contract')}
            >
              <Receipt size={20} className="text-primary" />
              <span className="h6 fw-semibold mb-0 flex-grow-1">Upload Contract Notes from Broker</span>
              <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"
                style={{ transition: 'transform 0.2s', transform: expandedSection === 'contract' ? 'rotate(180deg)' : 'rotate(0deg)' }}>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </Card.Header>
            <Collapse in={expandedSection === 'contract'}>
              <div>
                <Card.Body className="pt-2">
              <p className="small text-muted mb-3">
                Upload contract note ZIP, HTM, or PDF files. Broker is auto-detected from the file.
              </p>

              {!contractPreview && !contractResult && (
                <>
                  <Form.Label className="small">Contract Note Files</Form.Label>
                  <Form.Control
                    ref={contractFileRef}
                    size="sm"
                    type="file"
                    accept=".zip,.htm,.html,.pdf"
                    multiple
                    onChange={(e) => setContractFiles(Array.from(e.target.files))}
                  />
                  {contractFiles.length > 0 && (
                    <div className="mt-2 small text-muted">
                      {contractFiles.length} file{contractFiles.length > 1 ? 's' : ''} selected
                    </div>
                  )}
                  <div className="mt-3">
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={handleContractUpload}
                      disabled={contractUploading || !contractFiles.length}
                    >
                      {contractUploading ? <><Spinner size="sm" className="me-1" /> Parsing...</> : <><Upload size={14} className="me-1" /> Parse & Preview</>}
                    </Button>
                  </div>
                </>
              )}

              {/* Preview Table */}
              {contractPreview && contractPreview.trades.length > 0 && (
                <div className="mt-3">
                  <div className="d-flex align-items-center gap-2 mb-2">
                    <span className="badge bg-info">{contractPreview.broker}</span>
                    {contractPreview.panNumber && <span className="badge bg-secondary">PAN: {contractPreview.panNumber}</span>}
                    <span className="badge bg-secondary">Client: {contractPreview.clientCode}</span>
                    <span className="small text-muted ms-auto">Portfolio: {contractPreview.portfolioName}</span>
                  </div>
                  <div className="table-responsive" style={{ maxHeight: 400, overflowY: 'auto' }}>
                    <table className="table table-sm table-bordered small mb-0">
                      <thead className="table-light sticky-top">
                        <tr>
                          <th>Stock</th>
                          <th>Date</th>
                          <th style={{ width: 60 }}>Type</th>
                          <th style={{ width: 70 }}>Shares</th>
                          <th style={{ width: 90 }}>Price</th>
                          <th style={{ width: 90 }}>Charges</th>
                          <th style={{ width: 100 }}>Total</th>
                          <th style={{ width: 30 }}></th>
                        </tr>
                      </thead>
                      <tbody>
                        {contractPreview.trades.map((trade, i) => (
                          <tr key={i}>
                            <td title={trade.isin || ''}>{trade.security}</td>
                            <td>{trade.tradeDate}</td>
                            <td>
                              <span className={`badge ${trade.type === 'BUY' ? 'bg-success' : 'bg-danger'}`}>
                                {trade.type}
                              </span>
                            </td>
                            <td>
                              <input
                                type="number"
                                className="form-control form-control-sm p-0 px-1"
                                value={trade.quantity}
                                onChange={(e) => updatePreviewTrade(i, 'quantity', parseFloat(e.target.value) || 0)}
                              />
                            </td>
                            <td>
                              <input
                                type="number"
                                step="0.01"
                                className="form-control form-control-sm p-0 px-1"
                                value={trade.rate}
                                onChange={(e) => updatePreviewTrade(i, 'rate', parseFloat(e.target.value) || 0)}
                              />
                            </td>
                            <td>
                              <input
                                type="number"
                                step="0.01"
                                className="form-control form-control-sm p-0 px-1"
                                value={trade.brokerage}
                                onChange={(e) => updatePreviewTrade(i, 'brokerage', parseFloat(e.target.value) || 0)}
                              />
                            </td>
                            <td className="text-end">₹{trade.total?.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</td>
                            <td className="text-center">
                              <button
                                className="btn btn-sm btn-link text-danger p-0"
                                title="Remove"
                                onClick={() => removePreviewTrade(i)}
                              >×</button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {/* Summary row */}
                  <div className="d-flex justify-content-between mt-2 small text-muted">
                    <span>
                      {(() => {
                        const buys = contractPreview.trades.filter(t => t.type === 'BUY');
                        const sells = contractPreview.trades.filter(t => t.type === 'SELL');
                        const fmt = v => '₹' + v.toLocaleString('en-IN', { maximumFractionDigits: 2 });
                        const parts = [];
                        if (buys.length) parts.push(`${buys.length} buy${buys.length > 1 ? 's' : ''} @ ${fmt(buys.reduce((s, t) => s + (t.total || 0), 0))}`);
                        if (sells.length) parts.push(`${sells.length} sell${sells.length > 1 ? 's' : ''} @ ${fmt(sells.reduce((s, t) => s + (t.total || 0), 0))}`);
                        return parts.join(', ');
                      })()}
                    </span>
                  </div>
                  <div className="d-flex gap-2 mt-3">
                    <Button
                      size="sm"
                      variant="success"
                      onClick={handleContractApprove}
                      disabled={contractImporting || contractPreview.trades.length === 0}
                    >
                      {contractImporting ? <><Spinner size="sm" className="me-1" /> Importing...</> : <><CheckCircle size={14} className="me-1" /> Approve & Import</>}
                    </Button>
                    <Button size="sm" variant="outline-secondary" onClick={handleContractCancel}>
                      Cancel
                    </Button>
                  </div>
                </div>
              )}

              {contractResult && (
                <Alert variant="success" className="mt-3 small py-2">
                  <CheckCircle size={14} className="me-1" />
                  {contractResult.transactionsCreated > 0 && `Created ${contractResult.transactionsCreated} transaction${contractResult.transactionsCreated !== 1 ? 's' : ''}. `}
                  {contractResult.transactionsUpdated > 0 && `Updated ${contractResult.transactionsUpdated}. `}
                  {contractResult.transactionsSkipped > 0 && `Skipped ${contractResult.transactionsSkipped} (already imported). `}
                  {contractResult.investmentsCreated > 0 && `${contractResult.investmentsCreated} new stock${contractResult.investmentsCreated !== 1 ? 's' : ''} added.`}
                  <button className="btn btn-link btn-sm p-0 ms-2" onClick={() => { setContractResult(null); setContractFiles([]); if (contractFileRef.current) contractFileRef.current.value = ''; }}>
                    Upload more
                  </button>
                </Alert>
              )}
            </Card.Body>
              </div>
            </Collapse>
          </Card>

          {/* Add P&L Statement */}
          <Card className="shadow-sm">
            <Card.Header
              className="d-flex align-items-center gap-2 bg-white py-2 px-3"
              style={{ cursor: 'pointer' }}
              onClick={() => toggleSection('pnl')}
            >
              <FileText size={20} className="text-primary" />
              <span className="h6 fw-semibold mb-0 flex-grow-1">Add P&L Statement</span>
              <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"
                style={{ transition: 'transform 0.2s', transform: expandedSection === 'pnl' ? 'rotate(180deg)' : 'rotate(0deg)' }}>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </Card.Header>
            <Collapse in={expandedSection === 'pnl'}>
              <div>
                <Card.Body className="pt-2">
              <p className="small text-muted mb-3">
                Upload your profit & loss or trade history report (Excel/CSV) from your broker.
              </p>

              <Row className="g-3 align-items-end">
                <Col md={6}>
                  <Form.Label className="small">Broker</Form.Label>
                  <Form.Select
                    size="sm"
                    value={pnlBroker}
                    onChange={(e) => setPnlBroker(e.target.value)}
                  >
                    <option value="">Select broker...</option>
                    {brokerOptions.map(b => (
                      <option key={b.value} value={b.value}>{b.label}</option>
                    ))}
                  </Form.Select>
                </Col>
                <Col md={6}>
                  <Form.Label className="small">P&L / Trade History File</Form.Label>
                  <Form.Control
                    ref={pnlFileRef}
                    size="sm"
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    onChange={(e) => setPnlFile(e.target.files[0] || null)}
                  />
                </Col>
              </Row>
              <div className="mt-3">
                <Button
                  size="sm"
                  variant="primary"
                  onClick={handlePnlUpload}
                  disabled={pnlUploading || !pnlBroker || !pnlFile}
                >
                  {pnlUploading ? <><Spinner size="sm" className="me-1" /> Processing...</> : <><Upload size={14} className="me-1" /> Upload & Import</>}
                </Button>
              </div>
              {pnlResult && (
                <Alert variant="success" className="mt-3 small py-2">
                  <CheckCircle size={14} className="me-1" />
                  Imported {pnlResult.investmentsCreated} stock{pnlResult.investmentsCreated !== 1 ? 's' : ''} with {pnlResult.transactionsCreated} transaction{pnlResult.transactionsCreated !== 1 ? 's' : ''}.
                </Alert>
              )}
            </Card.Body>
              </div>
            </Collapse>
          </Card>

          {/* Add Stocks Manually */}
          <Card className="shadow-sm">
            <Card.Header
              className="d-flex align-items-center gap-2 bg-white py-2 px-3"
              style={{ cursor: 'pointer' }}
              onClick={() => toggleSection('manual')}
            >
              <Search size={20} className="text-primary" />
              <span className="h6 fw-semibold mb-0 flex-grow-1">Add Stocks Manually</span>
              <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"
                style={{ transition: 'transform 0.2s', transform: expandedSection === 'manual' ? 'rotate(180deg)' : 'rotate(0deg)' }}>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </Card.Header>
            <Collapse in={expandedSection === 'manual'}>
              <div>
                <Card.Body className="pt-2">
              <p className="small text-muted mb-3">Search for a stock and enter the transaction details.</p>

              {/* Transaction Type */}
              <div className="mb-3">
                <Form.Label className="small fw-medium">Transaction Type</Form.Label>
                <div className="d-flex flex-wrap gap-2 mt-1">
                  {STOCK_TXN_TYPES.map((t) => (
                    <Form.Check
                      key={t}
                      inline
                      type="radio"
                      name="stockTxnType"
                      id={`txn-${t}`}
                      label={t.charAt(0) + t.slice(1).toLowerCase()}
                      checked={txn.transaction_type === t}
                      onChange={() => setTxn({ ...txn, transaction_type: t })}
                    />
                  ))}
                </div>
              </div>

              <Row className="g-3">
                {/* Stock Name / Search */}
                <Col md={6}>
                  <Form.Label className="small">Stock Name</Form.Label>
                  <div className="d-flex gap-2">
                    <Form.Control
                      size="sm"
                      type="text"
                      value={form.ticker_symbol}
                      onChange={(e) => setForm({ ...form, ticker_symbol: e.target.value.toUpperCase() })}
                      onKeyDown={(e) => e.key === 'Enter' && handleStockSearch()}
                      placeholder="e.g., RELIANCE, TCS, INFY"
                    />
                    <Button size="sm" variant="primary" onClick={handleStockSearch} disabled={searching}>
                      <Search size={16} />
                    </Button>
                  </div>
                  {stockInfo && (
                    <div className="mt-2 p-2 bg-success bg-opacity-10 rounded d-flex align-items-center gap-2">
                      <CheckCircle size={14} className="text-success" />
                      <span className="small text-success">
                        <strong>{stockInfo.name}</strong> — ₹{stockInfo.price?.toFixed(2)}
                      </span>
                    </div>
                  )}
                </Col>

                {/* Notes */}
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

                {/* Date */}
                <Col md={6}>
                  <Form.Label className="small">Date of Investment</Form.Label>
                  <Form.Control
                    size="sm"
                    type="date"
                    value={txn.transaction_date}
                    onChange={(e) => updateTxn('transaction_date', e.target.value)}
                  />
                </Col>

                {/* Shares */}
                <Col md={6}>
                  <Form.Label className="small">No. of Shares</Form.Label>
                  <Form.Control
                    size="sm"
                    type="number"
                    step="0.001"
                    value={txn.units}
                    onChange={(e) => updateTxn('units', e.target.value)}
                    placeholder="Number of shares"
                  />
                </Col>

                {/* Price */}
                <Col md={6}>
                  <Form.Label className="small">Price per Share (₹)</Form.Label>
                  <Form.Control
                    size="sm"
                    type="number"
                    step="0.01"
                    value={txn.price_per_unit}
                    onChange={(e) => updateTxn('price_per_unit', e.target.value)}
                    placeholder={txn.transaction_type === 'SELL' ? 'Selling price' : 'Purchase price'}
                  />
                </Col>

                {/* Total Amount (computed) */}
                <Col md={6}>
                  <Form.Label className="small">Total Amount (₹)</Form.Label>
                  <div className="form-control form-control-sm bg-light" style={{ minHeight: '31px' }}>
                    {txn.units && txn.price_per_unit
                      ? '₹' + (parseFloat(txn.units) * parseFloat(txn.price_per_unit)).toLocaleString('en-IN', { maximumFractionDigits: 2 })
                      : <span className="text-muted">Auto-calculated</span>}
                  </div>
                </Col>

                {/* Fees */}
                <Col md={6}>
                  <Form.Label className="small">Charges (₹)</Form.Label>
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

              <div className="d-flex justify-content-end gap-2 mt-4">
                <Button variant="outline-secondary" size="sm" onClick={() => navigate(-1)}>
                  Cancel
                </Button>
                <Button variant="primary" size="sm" onClick={handleSubmit} disabled={submitting}>
                  {submitting ? 'Adding...' : 'Add Investment'}
                </Button>
              </div>
            </Card.Body>
              </div>
            </Collapse>
          </Card>

          {/* AMC / Maintenance Charges */}
          <Card className="shadow-sm">
            <Card.Header
              className="d-flex align-items-center gap-2 bg-white py-2 px-3"
              style={{ cursor: 'pointer' }}
              onClick={() => toggleSection('amc')}
            >
              <Wallet size={20} className="text-warning" />
              <span className="h6 fw-semibold mb-0 flex-grow-1">AMC / Maintenance Charges</span>
              <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"
                style={{ transition: 'transform 0.2s', transform: expandedSection === 'amc' ? 'rotate(180deg)' : 'rotate(0deg)' }}>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </Card.Header>
            <Collapse in={expandedSection === 'amc'}>
              <div>
                <Card.Body className="pt-2">
              <p className="small text-muted mb-3">
                Record demat account AMC / maintenance charges.
              </p>

              <Row className="g-3 align-items-end">
                <Col md={3}>
                  <Form.Label className="small">Broker</Form.Label>
                  <Form.Select
                    size="sm"
                    value={amcForm.broker}
                    onChange={(e) => setAmcForm({ ...amcForm, broker: e.target.value })}
                  >
                    {brokerOptions.map(b => (
                      <option key={b.value} value={b.value}>{b.label}</option>
                    ))}
                  </Form.Select>
                </Col>
                <Col md={3}>
                  <Form.Label className="small">Date</Form.Label>
                  <Form.Control
                    size="sm"
                    type="date"
                    value={amcForm.date}
                    onChange={(e) => setAmcForm({ ...amcForm, date: e.target.value })}
                  />
                </Col>
                <Col md={3}>
                  <Form.Label className="small">Amount (₹)</Form.Label>
                  <Form.Control
                    size="sm"
                    type="number"
                    step="0.01"
                    value={amcForm.amount}
                    onChange={(e) => setAmcForm({ ...amcForm, amount: e.target.value })}
                    placeholder="e.g., 300"
                  />
                </Col>
                <Col md={3}>
                  <Form.Label className="small">Notes</Form.Label>
                  <Form.Control
                    size="sm"
                    type="text"
                    value={amcForm.notes}
                    onChange={(e) => setAmcForm({ ...amcForm, notes: e.target.value })}
                    placeholder="e.g., Annual AMC"
                  />
                </Col>
              </Row>
              <div className="mt-3">
                <Button
                  size="sm"
                  variant="warning"
                  onClick={handleAmcSubmit}
                  disabled={amcSubmitting || !amcForm.amount}
                >
                  {amcSubmitting ? 'Recording...' : 'Record'}
                </Button>
              </div>
              {amcResult && (
                <Alert variant="success" className="mt-3 small py-2" dismissible onClose={() => setAmcResult(null)}>
                  <CheckCircle size={14} className="me-1" />
                  {amcResult}
                </Alert>
              )}
            </Card.Body>
              </div>
            </Collapse>
          </Card>
        </>
      )}

      {/* Non-Indian-Stock: original flow */}
      {!isIndianStock && (
        <>
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

              {/* Foreign Stock Ticker Search */}
              {isForeignStock && (
                <div className="mb-3">
                  <Form.Label className="small">Ticker Symbol</Form.Label>
                  <div className="d-flex gap-2">
                    <Form.Control
                      size="sm"
                      type="text"
                      value={form.ticker_symbol}
                      onChange={(e) => setForm({ ...form, ticker_symbol: e.target.value.toUpperCase() })}
                      onKeyDown={(e) => e.key === 'Enter' && handleStockSearch()}
                      placeholder="e.g., AAPL, MSFT, GOOGL"
                    />
                    <Button size="sm" variant="primary" onClick={handleStockSearch} disabled={searching}>
                      <Search size={16} />
                    </Button>
                  </div>
                  {stockInfo && (
                    <div className="mt-2 p-2 bg-success bg-opacity-10 rounded d-flex align-items-center gap-2">
                      <CheckCircle size={16} className="text-success" />
                      <span className="small text-success">
                        Found: <strong>{stockInfo.name}</strong> — ${stockInfo.price?.toFixed(2)} ({stockInfo.currency})
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
                  <Form.Label className="small">Charges (₹)</Form.Label>
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
        </>
      )}
    </div>
  );
}
