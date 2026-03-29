import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, Row, Col, Button, Form, Alert, Spinner, Collapse, Table } from 'react-bootstrap';
import { createInvestment, addTransaction, searchMutualFunds, searchStock, searchStockByName, previewContractNotes, importContractNotes, uploadPnLStatement, uploadCASPreview, importCASHoldings, importCAMSCASTransactions, triggerPriceUpdate } from '../services/api';
import { ASSET_TYPE_LABELS } from '../utils/formatters';
import { ArrowLeft, Search, CheckCircle, FileText, Upload, Receipt, AlertCircle, Loader2, ChevronDown, ChevronUp } from 'lucide-react';
import { usePortfolio } from '../context/PortfolioContext';

const ASSET_TYPES = ['MUTUAL_FUND', 'INDIAN_STOCK', 'PPF', 'PF', 'BOND'];
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
  const [mfTxnLabel, setMfTxnLabel] = useState('Buy');
  const [mfAmountMode, setMfAmountMode] = useState('rupees');
  const [mfBroker, setMfBroker] = useState('');
  const [mfNotes, setMfNotes] = useState('');
  const [stockInfo, setStockInfo] = useState(null);
  const [stockResults, setStockResults] = useState([]);
  const [stockQuery, setStockQuery] = useState('');
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

  // CAS upload state (for Mutual Funds accordion)
  const casFileRef = useRef(null);
  const [casFile, setCasFile] = useState(null);
  const [casUploading, setCasUploading] = useState(false);
  const [casImporting, setCasImporting] = useState(false);
  const [casError, setCasError] = useState('');
  const [casPreview, setCasPreview] = useState(null);
  const [casResult, setCasResult] = useState(null);
  const [casSelectedMFs, setCasSelectedMFs] = useState(new Set());
  const [casShowMFs, setCasShowMFs] = useState(true);
  const [casPassword, setCasPassword] = useState('');
  // CAMS CAS specific state
  const [casSelectedSchemes, setCasSelectedSchemes] = useState(new Set());
  const [casExpandedScheme, setCasExpandedScheme] = useState(null);



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
    if (!stockQuery || stockQuery.length < 2) return;
    setSearching(true);
    setStockInfo(null);
    setStockResults([]);
    setError('');
    try {
      const market = assetType === 'INDIAN_STOCK' ? 'NSE' : '';
      const results = await searchStockByName(stockQuery, market);
      if (results.length === 0) {
        setError(`No stocks found for: ${stockQuery}`);
      } else {
        setStockResults(results);
      }
    } catch (e) {
      setError(`Search failed: ${e.message}`);
    } finally {
      setSearching(false);
    }
  };

  const selectStock = async (result) => {
    setStockResults([]);
    setSearching(true);
    try {
      const data = await searchStock(result.symbol, '');
      setStockInfo(data);
      setForm({ ...form, name: data.name, ticker_symbol: result.symbol, currency: data.currency === 'USD' ? 'USD' : 'INR' });
      setStockQuery(result.name);
    } catch (e) {
      setError(`Could not fetch price for ${result.symbol}`);
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

  // CAS upload handlers
  const casSelectedPortfolio = portfolios.find(p => p.id === Number(portfolioId));
  const formatCurrency = (v) => '₹' + Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

  const handleCASUpload = async () => {
    setCasError('');
    if (!portfolioId) return setCasError('Please select a portfolio first (from the top navbar)');
    if (!casFile) return setCasError('Please select a CAS PDF file');
    setCasUploading(true);
    try {
      const result = await uploadCASPreview(casFile, portfolioId, casPassword || undefined);
      setCasPreview(result);
      if (result.casType === 'cams') {
        // CAMS CAS — select schemes that have new transactions by default
        setCasSelectedSchemes(new Set(
          result.schemes
            .map((s, i) => s.newTransactionCount > 0 ? i : null)
            .filter(i => i !== null)
        ));
      } else {
        // CDSL/NSDL CAS — MF holdings only
        setCasSelectedMFs(new Set(result.mutualFunds.filter(h => h.isNew).map((_, i) => i)));
      }
    } catch (e) {
      setCasError(e.message);
    } finally {
      setCasUploading(false);
    }
  };

  const handleCASImport = async () => {
    setCasError('');
    if (casPreview?.casType === 'cams') {
      // CAMS CAS — import selected schemes' new transactions
      const schemes = [];
      casSelectedSchemes.forEach(idx => {
        const s = casPreview.schemes[idx];
        if (!s) return;
        const newTxns = s.transactions.filter(t => t.isNew);
        if (newTxns.length > 0) {
          schemes.push({
            isin: s.isin,
            schemeName: s.schemeName,
            folio: s.folio,
            amc: s.amc,
            transactions: newTxns,
          });
        }
      });
      if (schemes.length === 0) return setCasError('No new transactions to import in selected schemes');
      setCasImporting(true);
      try {
        const result = await importCAMSCASTransactions(portfolioId, schemes);
        try { await triggerPriceUpdate(); } catch (_) { /* */ }
        await refreshPortfolios();
        setCasResult(result);
        setCasPreview(null);
      } catch (e) {
        setCasError(e.message);
      } finally {
        setCasImporting(false);
      }
      return;
    }

    // CDSL/NSDL CAS — MF holdings only
    const holdings = [];
    casSelectedMFs.forEach(idx => { if (casPreview.mutualFunds[idx]) holdings.push(casPreview.mutualFunds[idx]); });
    if (holdings.length === 0) return setCasError('No mutual fund holdings selected for import');
    setCasImporting(true);
    try {
      const result = await importCASHoldings(portfolioId, holdings);
      try { await triggerPriceUpdate(); } catch (_) { /* non-critical */ }
      await refreshPortfolios();
      setCasResult(result);
      setCasPreview(null);
    } catch (e) {
      setCasError(e.message);
    } finally {
      setCasImporting(false);
    }
  };

  const handleCASReset = () => {
    setCasPreview(null);
    setCasFile(null);
    setCasResult(null);
    setCasError('');
    setCasPassword('');
    setCasSelectedSchemes(new Set());
    setCasExpandedScheme(null);
    if (casFileRef.current) casFileRef.current.value = '';
  };

  const casTotalSelected = casSelectedMFs.size;

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

  // Map MF UI labels to DB transaction types
  const MF_TXN_MAP = { Buy: 'BUY', Sell: 'SELL', SIP: 'BUY', SWP: 'SELL', STP: 'SELL', Switch: 'SELL' };

  const handleMfSubmit = async () => {
    setError('');
    setSubmitting(true);
    try {
      if (!form.name) { setError('Please search and select a scheme'); setSubmitting(false); return; }

      const units = txn.units ? parseFloat(txn.units) : null;
      const nav = txn.price_per_unit ? parseFloat(txn.price_per_unit) : null;
      let amount = txn.amount ? parseFloat(txn.amount) : null;

      // Auto-calculate based on mode
      if (mfAmountMode === 'units' && units && nav) {
        amount = units * nav;
      } else if (mfAmountMode === 'rupees' && amount && nav && !units) {
        // units will be calculated server-side or can be left null
      }

      const inv = await createInvestment({
        name: form.name,
        asset_type: 'MUTUAL_FUND',
        amfi_code: form.amfi_code || null,
        folio_number: form.folio_number || null,
        currency: 'INR',
      });

      if (amount && amount > 0) {
        await addTransaction({
          investment_id: inv.id,
          portfolio_id: portfolioId || null,
          transaction_type: MF_TXN_MAP[mfTxnLabel] || 'BUY',
          transaction_date: txn.transaction_date,
          units,
          price_per_unit: nav,
          amount,
          fees: 0,
          broker: mfBroker || null,
          notes: mfNotes || null,
        });
      }

      navigate(`/investments/${inv.id}`);
    } catch (e) {
      setError(e.message);
    } finally {
      setSubmitting(false);
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
      });

      if (txn.amount && parseFloat(txn.amount) > 0) {
        const isPPF = assetType === 'PPF' || assetType === 'PF';
        await addTransaction({
          investment_id: inv.id,
          portfolio_id: portfolioId || null,
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
  const isBond = assetType === 'BOND';

  // Bond-specific form state
  const [bondForm, setBondForm] = useState({
    name: '',
    face_value: '1000',
    coupon_rate: '',
    coupon_frequency: 'ANNUAL',
    maturity_date: '',
    broker: 'Paytm Money',
    notes: '',
  });
  const [bondTxn, setBondTxn] = useState({
    transaction_type: 'BUY',
    transaction_date: new Date().toISOString().split('T')[0],
    units: '',
    price_per_unit: '',
    fees: '0',
    notes: '',
  });
  const bondAmount = bondTxn.units && bondTxn.price_per_unit
    ? (parseFloat(bondTxn.units) * parseFloat(bondTxn.price_per_unit)).toFixed(2)
    : '';

  const handleBondSubmit = async () => {
    setError('');
    setSubmitting(true);
    try {
      if (!bondForm.name) { setError('Name is required'); setSubmitting(false); return; }
      if (!bondForm.coupon_rate) { setError('Coupon rate is required'); setSubmitting(false); return; }
      if (!bondForm.maturity_date) { setError('Maturity date is required'); setSubmitting(false); return; }
      if (!bondTxn.units || !bondTxn.price_per_unit) { setError('Units and price are required'); setSubmitting(false); return; }

      const inv = await createInvestment({
        name: bondForm.name,
        asset_type: 'BOND',
        interest_rate: parseFloat(bondForm.coupon_rate),
        face_value: parseFloat(bondForm.face_value) || 1000,
        coupon_frequency: bondForm.coupon_frequency,
        maturity_date: bondForm.maturity_date,
        currency: 'INR',
        notes: bondForm.notes || null,
      });

      await addTransaction({
        investment_id: inv.id,
        portfolio_id: portfolioId || null,
        transaction_type: bondTxn.transaction_type,
        transaction_date: bondTxn.transaction_date,
        units: parseFloat(bondTxn.units),
        price_per_unit: parseFloat(bondTxn.price_per_unit),
        amount: parseFloat(bondAmount),
        fees: parseFloat(bondTxn.fees) || 0,
        broker: bondForm.broker || null,
        notes: bondTxn.notes || null,
      });

      navigate(`/investments/${inv.id}`);
    } catch (e) {
      setError(e.message);
    } finally {
      setSubmitting(false);
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
                    setStockResults([]);
                    setStockQuery('');
                    setMfResults([]);
                    setMfSearch('');
                    setContractResult(null);
                    setContractPreview(null);
                    setPnlResult(null);
                    setError('');
                    setExpandedSection(null);
                    handleCASReset();
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
                  {/* Charges breakdown */}
                  {contractPreview.summary?.chargesBreakdown && (() => {
                    const b = contractPreview.summary.chargesBreakdown;
                    const items = [
                      ['Brokerage', b.brokerage],
                      ['STT', b.stt],
                      ['GST', b.gst],
                      ['Exchange', b.exchangeCharges],
                      ['Stamp', b.stampDuty],
                      ['SEBI', b.sebiCharges],
                      ['IPFT', b.ipftCharges],
                      ['DP', b.dpCharges],
                    ].filter(([, v]) => v);
                    if (!items.length) return null;
                    const fmt = v => '₹' + v.toLocaleString('en-IN', { maximumFractionDigits: 2 });
                    return (
                      <div className="mt-1 small text-muted">
                        <strong>Charges:</strong>{' '}
                        {items.map(([label, val], i) => (
                          <span key={label}>{i > 0 && ' · '}{label}: {fmt(val)}</span>
                        ))}
                        {b.total ? <span> · <strong>Total: {fmt(b.total)}</strong></span> : null}
                      </div>
                    );
                  })()}
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
                      value={stockQuery}
                      onChange={(e) => { setStockQuery(e.target.value); setStockInfo(null); setStockResults([]); }}
                      onKeyDown={(e) => e.key === 'Enter' && handleStockSearch()}
                      placeholder="e.g., ICICI, Nifty ETF, Reliance"
                    />
                    <Button size="sm" variant="primary" onClick={handleStockSearch} disabled={searching}>
                      {searching ? <Spinner size="sm" animation="border" /> : <Search size={16} />}
                    </Button>
                  </div>
                  {stockResults.length > 0 && (
                    <div className="border rounded mt-1 bg-white shadow-sm" style={{ maxHeight: 200, overflowY: 'auto' }}>
                      {stockResults.map((r, i) => (
                        <div
                          key={i}
                          className="px-3 py-2 border-bottom small d-flex justify-content-between align-items-center"
                          style={{ cursor: 'pointer' }}
                          onClick={() => selectStock(r)}
                          onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#f0f0f0'}
                          onMouseLeave={(e) => e.currentTarget.style.backgroundColor = ''}
                        >
                          <div>
                            <strong>{r.symbol}</strong>
                            <span className="text-muted ms-2">{r.name}</span>
                          </div>
                          <span className="badge bg-secondary">{r.type}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {stockInfo && (
                    <div className="mt-2 p-2 bg-success bg-opacity-10 rounded d-flex align-items-center gap-2">
                      <CheckCircle size={14} className="text-success" />
                      <span className="small text-success">
                        <strong>{stockInfo.name}</strong> ({form.ticker_symbol}) — ₹{stockInfo.price?.toFixed(2)}
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


        </>
      )}

      {/* Bond form */}
      {isBond && (
        <>
          <Card className="shadow-sm">
            <Card.Body>
              <h2 className="h6 fw-semibold mb-3">2. Bond Details</h2>
              <Row className="g-3">
                <Col md={8}>
                  <Form.Label className="small">Name</Form.Label>
                  <Form.Control
                    size="sm"
                    type="text"
                    value={bondForm.name}
                    onChange={(e) => setBondForm({ ...bondForm, name: e.target.value })}
                    placeholder="e.g., Shriram Finance NCD 9.05%"
                    required
                  />
                </Col>
                <Col md={4}>
                  <Form.Label className="small">Broker</Form.Label>
                  <Form.Select
                    size="sm"
                    value={bondForm.broker}
                    onChange={(e) => setBondForm({ ...bondForm, broker: e.target.value })}
                  >
                    {[
                      { value: 'Paytm Money', label: 'Paytm Money' },
                      ...brokerOptions,
                    ].map(b => (
                      <option key={b.value} value={b.value}>{b.label}</option>
                    ))}
                  </Form.Select>
                </Col>
                <Col md={3}>
                  <Form.Label className="small">Face Value (₹)</Form.Label>
                  <Form.Control
                    size="sm"
                    type="number"
                    step="0.01"
                    value={bondForm.face_value}
                    onChange={(e) => setBondForm({ ...bondForm, face_value: e.target.value })}
                    placeholder="1000"
                  />
                </Col>
                <Col md={3}>
                  <Form.Label className="small">Coupon Rate (% p.a.)</Form.Label>
                  <Form.Control
                    size="sm"
                    type="number"
                    step="0.01"
                    value={bondForm.coupon_rate}
                    onChange={(e) => setBondForm({ ...bondForm, coupon_rate: e.target.value })}
                    placeholder="e.g., 9.05"
                    required
                  />
                </Col>
                <Col md={3}>
                  <Form.Label className="small">Coupon Frequency</Form.Label>
                  <Form.Select
                    size="sm"
                    value={bondForm.coupon_frequency}
                    onChange={(e) => setBondForm({ ...bondForm, coupon_frequency: e.target.value })}
                  >
                    <option value="MONTHLY">Monthly</option>
                    <option value="QUARTERLY">Quarterly</option>
                    <option value="SEMI_ANNUAL">Semi-Annual</option>
                    <option value="ANNUAL">Annual</option>
                  </Form.Select>
                </Col>
                <Col md={3}>
                  <Form.Label className="small">Maturity Date</Form.Label>
                  <Form.Control
                    size="sm"
                    type="date"
                    value={bondForm.maturity_date}
                    onChange={(e) => setBondForm({ ...bondForm, maturity_date: e.target.value })}
                    required
                  />
                </Col>
                <Col md={12}>
                  <Form.Label className="small">Notes</Form.Label>
                  <Form.Control
                    size="sm"
                    type="text"
                    value={bondForm.notes}
                    onChange={(e) => setBondForm({ ...bondForm, notes: e.target.value })}
                    placeholder="Optional notes (e.g., ISIN, series)"
                  />
                </Col>
              </Row>
            </Card.Body>
          </Card>

          <Card className="shadow-sm">
            <Card.Body>
              <h2 className="h6 fw-semibold mb-3">3. Purchase / Sale / Redemption</h2>
              <div className="mb-3">
                <div className="d-flex flex-wrap gap-2">
                  {['BUY', 'SELL', 'REDEMPTION'].map((t) => (
                    <Form.Check
                      key={t}
                      inline
                      type="radio"
                      name="bondTxnType"
                      id={`bond-txn-${t}`}
                      label={{ BUY: 'Buy', SELL: 'Sell', REDEMPTION: 'Redemption' }[t]}
                      checked={bondTxn.transaction_type === t}
                      onChange={() => setBondTxn({ ...bondTxn, transaction_type: t })}
                    />
                  ))}
                </div>
              </div>
              <Row className="g-3">
                <Col md={4}>
                  <Form.Label className="small">Date</Form.Label>
                  <Form.Control
                    size="sm"
                    type="date"
                    value={bondTxn.transaction_date}
                    onChange={(e) => setBondTxn({ ...bondTxn, transaction_date: e.target.value })}
                  />
                </Col>
                <Col md={4}>
                  <Form.Label className="small">No. of Bonds</Form.Label>
                  <Form.Control
                    size="sm"
                    type="number"
                    step="1"
                    value={bondTxn.units}
                    onChange={(e) => setBondTxn({ ...bondTxn, units: e.target.value })}
                    placeholder="e.g., 5"
                  />
                </Col>
                <Col md={4}>
                  <Form.Label className="small">Price per Bond (₹)</Form.Label>
                  <Form.Control
                    size="sm"
                    type="number"
                    step="0.01"
                    value={bondTxn.price_per_unit}
                    onChange={(e) => setBondTxn({ ...bondTxn, price_per_unit: e.target.value })}
                    placeholder="e.g., 1000"
                  />
                </Col>
                <Col md={4}>
                  <Form.Label className="small">Total Amount (₹)</Form.Label>
                  <div className="form-control form-control-sm bg-light" style={{ minHeight: '31px' }}>
                    {bondAmount
                      ? '₹' + parseFloat(bondAmount).toLocaleString('en-IN', { maximumFractionDigits: 2 })
                      : <span className="text-muted">Auto-calculated</span>}
                  </div>
                </Col>
                <Col md={4}>
                  <Form.Label className="small">Charges (₹)</Form.Label>
                  <Form.Control
                    size="sm"
                    type="number"
                    step="0.01"
                    value={bondTxn.fees}
                    onChange={(e) => setBondTxn({ ...bondTxn, fees: e.target.value })}
                    placeholder="0"
                  />
                </Col>
                <Col md={4}>
                  <Form.Label className="small">Notes</Form.Label>
                  <Form.Control
                    size="sm"
                    type="text"
                    value={bondTxn.notes}
                    onChange={(e) => setBondTxn({ ...bondTxn, notes: e.target.value })}
                    placeholder="Optional"
                  />
                </Col>
              </Row>
            </Card.Body>
          </Card>

          <div className="d-flex justify-content-end gap-2">
            <Button variant="outline-secondary" onClick={() => navigate(-1)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={handleBondSubmit} disabled={submitting}>
              {submitting ? 'Adding...' : 'Add Bond'}
            </Button>
          </div>
        </>
      )}

      {/* Mutual Funds: collapsible sections */}
      {isMF && (
        <>
          {/* Upload CAS */}
          <Card className="shadow-sm">
            <Card.Header
              className="d-flex align-items-center gap-2 bg-white py-2 px-3"
              style={{ cursor: 'pointer' }}
              onClick={() => toggleSection('cas')}
            >
              <Upload size={20} className="text-primary" />
              <span className="h6 fw-semibold mb-0 flex-grow-1">Upload Consolidated Account Statement (CAS)</span>
              <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"
                style={{ transition: 'transform 0.2s', transform: expandedSection === 'cas' ? 'rotate(180deg)' : 'rotate(0deg)' }}>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </Card.Header>
            <Collapse in={expandedSection === 'cas'}>
              <div>
                <Card.Body className="pt-2">
                  <p className="small text-muted mb-3">
                    Upload your Consolidated Account Statement (CAS) PDF — supports CAMS / KFintech (transaction history) and CDSL / NSDL (holdings snapshot) to bulk-import mutual fund holdings.
                  </p>

                  {casError && (
                    <Alert variant="danger" className="small py-2 d-flex align-items-center gap-2">
                      <AlertCircle size={14} className="flex-shrink-0" />
                      {casError}
                    </Alert>
                  )}

                  {casResult && (
                    <Alert variant="success" className="small py-2">
                      <CheckCircle size={14} className="me-1" />
                      Successfully imported {casResult.imported} {casResult.schemes ? 'transaction' : 'investment'}{casResult.imported !== 1 ? 's' : ''} from CAS.
                      {casResult.skipped > 0 && <span className="text-muted ms-1">({casResult.skipped} duplicates skipped)</span>}
                      <button className="btn btn-link btn-sm p-0 ms-2" onClick={handleCASReset}>
                        Upload another
                      </button>
                    </Alert>
                  )}

                  {!casPreview && !casResult && (
                    <>
                      <div className="mb-3">
                        <Form.Label className="small">CAS PDF File</Form.Label>
                        <div
                          onClick={() => casFileRef.current?.click()}
                          className="border rounded p-3 text-center"
                          style={{ cursor: 'pointer' }}
                        >
                          <input
                            ref={casFileRef}
                            type="file"
                            accept="application/pdf"
                            className="d-none"
                            onChange={(e) => setCasFile(e.target.files?.[0] || null)}
                          />
                          {casFile ? (
                            <div className="d-flex align-items-center justify-content-center gap-2">
                              <FileText size={20} className="text-primary" />
                              <div className="text-start">
                                <div className="small fw-medium">{casFile.name}</div>
                                <div className="text-muted" style={{ fontSize: '0.75rem' }}>{(casFile.size / 1024).toFixed(1)} KB</div>
                              </div>
                            </div>
                          ) : (
                            <div>
                              <Upload size={24} className="text-muted mx-auto mb-1" />
                              <div className="small text-muted">Click to select CAS PDF</div>
                              <div className="text-muted" style={{ fontSize: '0.75rem' }}>CAMS / KFintech / CDSL / NSDL Consolidated Account Statement (max 20MB)</div>
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="mb-3">
                        <Form.Label className="small">PDF Password <span className="text-muted">(optional)</span></Form.Label>
                        <Form.Control
                          type="password"
                          size="sm"
                          placeholder={casSelectedPortfolio?.pan_number ? `Leave blank to use PAN (${casSelectedPortfolio.pan_number})` : 'Enter PDF password'}
                          value={casPassword}
                          onChange={(e) => setCasPassword(e.target.value)}
                        />
                        {!casSelectedPortfolio?.pan_number && !casPassword && (
                          <div className="text-warning small mt-1">
                            ⚠ No PAN set on this portfolio. Please enter the PDF password or add PAN to the portfolio first.
                          </div>
                        )}
                      </div>

                      <Button
                        size="sm"
                        variant="primary"
                        onClick={handleCASUpload}
                        disabled={casUploading || !casFile}
                        className="d-flex align-items-center gap-2"
                      >
                        {casUploading ? (
                          <><Spinner size="sm" className="me-1" /> Parsing PDF...</>
                        ) : (
                          <><Upload size={14} className="me-1" /> Upload & Parse</>
                        )}
                      </Button>
                    </>
                  )}

                  {/* CAS Preview */}
                  {casPreview && casPreview.casType === 'cams' && (
                    <CAMSCASPreview
                      preview={casPreview}
                      selectedSchemes={casSelectedSchemes}
                      setSelectedSchemes={setCasSelectedSchemes}
                      expandedScheme={casExpandedScheme}
                      setExpandedScheme={setCasExpandedScheme}
                      onImport={handleCASImport}
                      onCancel={handleCASReset}
                      importing={casImporting}
                      formatCurrency={formatCurrency}
                    />
                  )}

                  {casPreview && casPreview.casType !== 'cams' && (
                    <div className="mt-2">
                      {/* Summary Card */}
                      <div className="rounded p-3 mb-3" style={{ background: 'linear-gradient(to right, #eff6ff, #eef2ff)' }}>
                        <div className="d-flex align-items-center justify-content-between mb-2">
                          <span className="small fw-semibold">{casPreview.casType === 'nsdl' ? 'NSDL' : 'CDSL'} CAS Summary</span>
                          <span className="small text-muted">{casPreview.investorName}</span>
                        </div>
                        <div className="row g-2 text-center">
                          <div className="col-6">
                            <div className="fw-bold">{formatCurrency(casPreview.portfolioValue)}</div>
                            <div className="text-muted" style={{ fontSize: '0.7rem' }}>Total Value</div>
                          </div>
                          <div className="col-6">
                            <div className="fw-bold text-success">{casPreview.summary.totalMFs}</div>
                            <div className="text-muted" style={{ fontSize: '0.7rem' }}>Mutual Funds</div>
                          </div>
                        </div>
                      </div>

                      {/* Mutual Funds */}
                      {casPreview.mutualFunds.length > 0 && (
                        <CASHoldingTable
                          title="Mutual Funds & ETFs" emoji="📊"
                          items={casPreview.mutualFunds} selected={casSelectedMFs} setSelected={setCasSelectedMFs}
                          open={casShowMFs} toggle={() => setCasShowMFs(v => !v)}
                          columns={['Name', 'Source', 'Units', 'NAV/Price', 'Value']}
                          renderRow={(h) => [
                            <div>
                              <span className="fw-medium">{h.name}</span>
                              {h.folio && <span className="text-muted ms-1" style={{ fontSize: '0.75rem' }}>({h.folio})</span>}
                            </div>,
                            <span className="badge" style={{
                              fontSize: '0.7rem',
                              backgroundColor: h.source === 'demat' ? '#f3e8ff' : '#ccfbf1',
                              color: h.source === 'demat' ? '#7c3aed' : '#0f766e',
                            }}>
                              {h.source === 'demat' ? 'Demat' : 'RTA'}
                            </span>,
                            h.units?.toLocaleString('en-IN', { maximumFractionDigits: 3 }),
                            formatCurrency(h.nav || h.price),
                            formatCurrency(h.value),
                          ]}
                        />
                      )}

                      {/* Import Bar */}
                      <div className="bg-light border rounded p-2 mt-3 d-flex align-items-center justify-content-between">
                        <div className="small text-muted">
                          <strong>{casTotalSelected}</strong> of {casPreview.mutualFunds.length} mutual funds selected
                        </div>
                        <div className="d-flex gap-2">
                          <Button size="sm" variant="outline-secondary" onClick={handleCASReset}>
                            Cancel
                          </Button>
                          <Button
                            size="sm" variant="success"
                            onClick={handleCASImport}
                            disabled={casImporting || casTotalSelected === 0}
                          >
                            {casImporting ? (
                              <><Spinner size="sm" className="me-1" /> Importing...</>
                            ) : (
                              <><CheckCircle size={14} className="me-1" /> Import {casTotalSelected} Mutual Funds</>
                            )}
                          </Button>
                        </div>
                      </div>
                    </div>
                  )}
                </Card.Body>
              </div>
            </Collapse>
          </Card>

          {/* Add Mutual Funds Manually */}
          <Card className="shadow-sm">
            <Card.Header
              className="d-flex align-items-center gap-2 bg-white py-2 px-3"
              style={{ cursor: 'pointer' }}
              onClick={() => toggleSection('mf-manual')}
            >
              <Search size={20} className="text-primary" />
              <span className="h6 fw-semibold mb-0 flex-grow-1">Add Mutual Funds Manually</span>
              <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"
                style={{ transition: 'transform 0.2s', transform: expandedSection === 'mf-manual' ? 'rotate(180deg)' : 'rotate(0deg)' }}>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </Card.Header>
            <Collapse in={expandedSection === 'mf-manual'}>
              <div>
                <Card.Body className="pt-2">
                  <p className="small text-muted mb-3">Select a fund and enter the transaction details.</p>

                  {/* Transaction Type */}
                  <div className="d-flex align-items-center gap-3 mb-3 flex-wrap">
                    <span className="small fw-medium text-muted">Transaction Type</span>
                    {['Buy', 'Sell', 'SIP', 'SWP', 'STP', 'Switch'].map((label) => (
                      <Form.Check
                        key={label}
                        inline
                        type="radio"
                        name="mfTxnLabel"
                        id={`mf-txn-${label}`}
                        label={label}
                        checked={mfTxnLabel === label}
                        onChange={() => setMfTxnLabel(label)}
                        className="small"
                      />
                    ))}
                  </div>

                  <hr className="my-3" />

                  {/* Scheme Name + Folio */}
                  <Row className="g-3 mb-3">
                    <Col md={8}>
                      <Form.Label className="small text-muted text-uppercase" style={{ fontSize: '0.7rem' }}>Scheme Name</Form.Label>
                      <div className="position-relative">
                        <div className="d-flex gap-2">
                          <div className="position-relative flex-grow-1">
                            <Search size={14} className="position-absolute text-muted" style={{ left: 10, top: '50%', transform: 'translateY(-50%)' }} />
                            <Form.Control
                              size="sm"
                              type="text"
                              value={mfSearch}
                              onChange={(e) => { setMfSearch(e.target.value); if (e.target.value.length >= 3) handleMfSearch(); }}
                              onKeyDown={(e) => e.key === 'Enter' && handleMfSearch()}
                              placeholder="Search Scheme"
                              style={{ paddingLeft: 32 }}
                            />
                          </div>
                        </div>
                        {searching && <div className="small text-muted mt-1">Searching...</div>}
                        {mfResults.length > 0 && (
                          <div className="border rounded mt-1 bg-white shadow-sm position-absolute w-100" style={{ maxHeight: 240, overflowY: 'auto', zIndex: 10 }}>
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
                                <div className="text-muted" style={{ fontSize: '0.7rem' }}>Code: {mf.schemeCode}</div>
                              </button>
                            ))}
                          </div>
                        )}
                        {form.name && mfResults.length === 0 && !searching && (
                          <div className="mt-1 small text-success d-flex align-items-center gap-1">
                            <CheckCircle size={12} /> {form.name}
                          </div>
                        )}
                      </div>
                    </Col>
                    <Col md={4}>
                      <Form.Label className="small text-muted text-uppercase" style={{ fontSize: '0.7rem' }}>Folio No.</Form.Label>
                      <Form.Control
                        size="sm"
                        type="text"
                        value={form.folio_number}
                        onChange={(e) => setForm({ ...form, folio_number: e.target.value })}
                        placeholder="Folio No."
                      />
                    </Col>
                  </Row>

                  {/* Date + Amount */}
                  <Row className="g-3 mb-3">
                    <Col md={6}>
                      <Form.Label className="small text-muted text-uppercase" style={{ fontSize: '0.7rem' }}>Date of Investment</Form.Label>
                      <Form.Control
                        size="sm"
                        type="date"
                        value={txn.transaction_date}
                        onChange={(e) => updateTxn('transaction_date', e.target.value)}
                      />
                    </Col>
                    <Col md={6}>
                      <Form.Label className="small text-muted text-uppercase" style={{ fontSize: '0.7rem' }}>
                        {mfAmountMode === 'rupees' ? 'Amount in \u20b9' : 'Units'}
                      </Form.Label>
                      <Form.Control
                        size="sm"
                        type="number"
                        step={mfAmountMode === 'rupees' ? '0.01' : '0.001'}
                        value={mfAmountMode === 'rupees' ? txn.amount : txn.units}
                        onChange={(e) => mfAmountMode === 'rupees'
                          ? updateTxn('amount', e.target.value)
                          : updateTxn('units', e.target.value)
                        }
                        placeholder={mfAmountMode === 'rupees' ? 'Amount In \u20b9' : 'No. of units'}
                      />
                      <div className="d-flex gap-3 mt-1">
                        <Form.Check
                          inline type="radio" name="mfAmountMode" id="mf-mode-rupees"
                          label="Rupees" className="small"
                          checked={mfAmountMode === 'rupees'}
                          onChange={() => setMfAmountMode('rupees')}
                        />
                        <Form.Check
                          inline type="radio" name="mfAmountMode" id="mf-mode-units"
                          label="Units" className="small"
                          checked={mfAmountMode === 'units'}
                          onChange={() => setMfAmountMode('units')}
                        />
                      </div>
                    </Col>
                  </Row>

                  {/* NAV + Broker */}
                  <Row className="g-3 mb-3">
                    <Col md={6}>
                      <Form.Label className="small text-muted text-uppercase" style={{ fontSize: '0.7rem' }}>NAV (Price)</Form.Label>
                      <Form.Control
                        size="sm"
                        type="number"
                        step="0.0001"
                        value={txn.price_per_unit}
                        onChange={(e) => updateTxn('price_per_unit', e.target.value)}
                        placeholder="NAV at transaction"
                      />
                    </Col>
                    <Col md={6}>
                      <Form.Label className="small text-muted text-uppercase" style={{ fontSize: '0.7rem' }}>Broker / Platform</Form.Label>
                      <Form.Select
                        size="sm"
                        value={mfBroker}
                        onChange={(e) => setMfBroker(e.target.value)}
                      >
                        <option value="">Select broker...</option>
                        <option value="CAMS">CAMS</option>
                        <option value="KFintech">KFintech</option>
                        <option value="MFCentral">MFCentral</option>
                        <option value="Coin (Zerodha)">Coin (Zerodha)</option>
                        <option value="Groww">Groww</option>
                        <option value="Kuvera">Kuvera</option>
                        <option value="Paytm Money">Paytm Money</option>
                        <option value="MFUtility">MFUtility</option>
                        {brokerOptions.map(b => (
                          <option key={b.value} value={b.value}>{b.label}</option>
                        ))}
                      </Form.Select>
                    </Col>
                  </Row>

                  {/* Notes */}
                  <Row className="g-3 mb-3">
                    <Col md={12}>
                      <Form.Label className="small text-muted text-uppercase" style={{ fontSize: '0.7rem' }}>Notes / Remarks</Form.Label>
                      <Form.Control
                        size="sm"
                        type="text"
                        value={mfNotes}
                        onChange={(e) => setMfNotes(e.target.value)}
                        placeholder="Optional"
                      />
                    </Col>
                  </Row>

                  <hr className="my-3" />

                  <div className="d-flex justify-content-center gap-3">
                    <Button variant="primary" onClick={handleMfSubmit} disabled={submitting}>
                      {submitting ? <><Spinner size="sm" className="me-1" /> Adding...</> : '+ Add Transaction'}
                    </Button>
                    <Button variant="link" className="text-muted" onClick={() => navigate(-1)}>
                      Close
                    </Button>
                  </div>
                </Card.Body>
              </div>
            </Collapse>
          </Card>
        </>
      )}

      {/* Non-Indian-Stock / Non-Bond / Non-MF: original flow (PPF, PF) */}
      {!isIndianStock && !isBond && !isMF && (
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
                  <Form.Label className="small">Stock / ETF Name</Form.Label>
                  <div className="d-flex gap-2">
                    <Form.Control
                      size="sm"
                      type="text"
                      value={stockQuery}
                      onChange={(e) => { setStockQuery(e.target.value); setStockInfo(null); setStockResults([]); }}
                      onKeyDown={(e) => e.key === 'Enter' && handleStockSearch()}
                      placeholder="e.g., AAPL, Tesla, S&P 500 ETF"
                    />
                    <Button size="sm" variant="primary" onClick={handleStockSearch} disabled={searching}>
                      {searching ? <Spinner size="sm" animation="border" /> : <Search size={16} />}
                    </Button>
                  </div>
                  {stockResults.length > 0 && (
                    <div className="border rounded mt-1 bg-white shadow-sm" style={{ maxHeight: 200, overflowY: 'auto' }}>
                      {stockResults.map((r, i) => (
                        <div
                          key={i}
                          className="px-3 py-2 border-bottom small d-flex justify-content-between align-items-center"
                          style={{ cursor: 'pointer' }}
                          onClick={() => selectStock(r)}
                          onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#f0f0f0'}
                          onMouseLeave={(e) => e.currentTarget.style.backgroundColor = ''}
                        >
                          <div>
                            <strong>{r.symbol}</strong>
                            <span className="text-muted ms-2">{r.name}</span>
                          </div>
                          <span className="badge bg-secondary">{r.type}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {stockInfo && (
                    <div className="mt-2 p-2 bg-success bg-opacity-10 rounded d-flex align-items-center gap-2">
                      <CheckCircle size={16} className="text-success" />
                      <span className="small text-success">
                        Found: <strong>{stockInfo.name}</strong> ({form.ticker_symbol}) — ${stockInfo.price?.toFixed(2)} ({stockInfo.currency})
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

/* ─── CAS Holdings table (inline in AddInvestment) ─── */
function CASHoldingTable({ title, emoji, items, selected, setSelected, open, toggle, columns, renderRow }) {
  const allSelected = selected.size === items.length;
  const newCount = items.filter(h => h.isNew).length;
  const existingCount = items.length - newCount;

  return (
    <div className="border rounded mb-2 overflow-hidden">
      <button
        onClick={toggle}
        className="d-flex align-items-center justify-content-between w-100 px-3 py-2 bg-transparent border-0"
        style={{ cursor: 'pointer' }}
        onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#f8f9fa'}
        onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
      >
        <div className="d-flex align-items-center gap-2">
          <span>{emoji}</span>
          <span className="small fw-semibold">{title}</span>
          <span className="small text-muted">({items.length})</span>
          {existingCount > 0 && (
            <span className="badge" style={{ fontSize: '0.65rem', backgroundColor: '#fef3c7', color: '#92400e' }}>
              {existingCount} already tracked
            </span>
          )}
        </div>
        <ChevronDown size={14} className="text-muted" style={{ transition: 'transform 0.2s', transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }} />
      </button>

      {open && (
        <div className="border-top">
          <div className="table-responsive" style={{ maxHeight: 300, overflowY: 'auto' }}>
            <Table size="sm" className="mb-0 small">
              <thead className="table-light">
                <tr>
                  <th className="px-2 py-1" style={{ width: 32 }}>
                    <Form.Check
                      type="checkbox"
                      checked={allSelected}
                      onChange={() => {
                        if (allSelected) setSelected(new Set());
                        else setSelected(new Set(items.map((_, i) => i)));
                      }}
                    />
                  </th>
                  {columns.map((col, i) => (
                    <th key={i} className="px-2 py-1 text-muted text-uppercase" style={{ fontSize: '0.65rem' }}>
                      {col}
                    </th>
                  ))}
                  <th className="px-2 py-1 text-muted text-uppercase" style={{ fontSize: '0.65rem' }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((h, idx) => {
                  const cells = renderRow(h);
                  return (
                    <tr
                      key={idx}
                      className={selected.has(idx) ? 'table-primary' : ''}
                      style={{ opacity: !h.isNew ? 0.75 : 1 }}
                    >
                      <td className="px-2 py-1">
                        <Form.Check
                          type="checkbox"
                          checked={selected.has(idx)}
                          onChange={() => {
                            const next = new Set(selected);
                            if (next.has(idx)) next.delete(idx);
                            else next.add(idx);
                            setSelected(next);
                          }}
                        />
                      </td>
                      {cells.map((cell, i) => (
                        <td key={i} className="px-2 py-1">{cell}</td>
                      ))}
                      <td className="px-2 py-1">
                        {h.isNew ? (
                          <span className="badge" style={{ fontSize: '0.65rem', backgroundColor: '#dcfce7', color: '#15803d' }}>New</span>
                        ) : (
                          <span className="badge bg-light text-muted" style={{ fontSize: '0.65rem' }} title={`Matches: ${h.existingName}`}>
                            Tracked
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── CAMS/KFintech CAS Preview (transaction-level delta) ─── */
function CAMSCASPreview({ preview, selectedSchemes, setSelectedSchemes, expandedScheme, setExpandedScheme, onImport, onCancel, importing, formatCurrency }) {
  const totalNewTxns = preview.schemes.reduce((s, sc) => s + sc.newTransactionCount, 0);
  const selectedNewTxns = preview.schemes
    .filter((_, i) => selectedSchemes.has(i))
    .reduce((s, sc) => s + sc.newTransactionCount, 0);

  const allWithNew = preview.schemes
    .map((s, i) => s.newTransactionCount > 0 ? i : null)
    .filter(i => i !== null);
  const allSelected = allWithNew.length > 0 && allWithNew.every(i => selectedSchemes.has(i));

  return (
    <div className="mt-2">
      {/* Summary Card */}
      <div className="rounded p-3 mb-3" style={{ background: 'linear-gradient(to right, #eff6ff, #eef2ff)' }}>
        <div className="d-flex align-items-center justify-content-between mb-2">
          <div>
            <span className="small fw-semibold">CAMS/KFintech CAS</span>
            <span className="badge ms-2" style={{ fontSize: '0.65rem', backgroundColor: '#dbeafe', color: '#1d4ed8' }}>Transaction History</span>
          </div>
          <span className="small text-muted">{preview.investorName}</span>
        </div>
        {preview.dateRange && (
          <div className="text-muted mb-2" style={{ fontSize: '0.7rem' }}>
            Period: {preview.dateRange.from} to {preview.dateRange.to}
          </div>
        )}
        <div className="row g-2 text-center">
          <div className="col-6 col-sm-3">
            <div className="fw-bold text-primary">{preview.summary.totalSchemes}</div>
            <div className="text-muted" style={{ fontSize: '0.7rem' }}>Schemes</div>
          </div>
          <div className="col-6 col-sm-3">
            <div className="fw-bold">{preview.summary.activeSchemes}</div>
            <div className="text-muted" style={{ fontSize: '0.7rem' }}>Active</div>
          </div>
          <div className="col-6 col-sm-3">
            <div className="fw-bold text-success">{preview.summary.newTransactions}</div>
            <div className="text-muted" style={{ fontSize: '0.7rem' }}>New Transactions</div>
          </div>
          <div className="col-6 col-sm-3">
            <div className="fw-bold text-muted">{preview.summary.existingTransactions}</div>
            <div className="text-muted" style={{ fontSize: '0.7rem' }}>Already in DB</div>
          </div>
        </div>
      </div>

      {/* Select All */}
      <div className="d-flex align-items-center gap-2 mb-2">
        <Form.Check
          type="checkbox"
          checked={allSelected}
          onChange={() => {
            if (allSelected) setSelectedSchemes(new Set());
            else setSelectedSchemes(new Set(allWithNew));
          }}
          label={<span className="small text-muted">Select all schemes with new transactions</span>}
        />
      </div>

      {/* Scheme List */}
      {preview.schemes.map((scheme, idx) => {
        const isExpanded = expandedScheme === idx;
        const isSelected = selectedSchemes.has(idx);
        const hasNew = scheme.newTransactionCount > 0;
        const newTxns = scheme.transactions.filter(t => t.isNew);

        return (
          <div key={idx} className="border rounded mb-2 overflow-hidden" style={{ opacity: hasNew ? 1 : 0.6 }}>
            {/* Scheme Header */}
            <div className="d-flex align-items-center px-3 py-2" style={{ backgroundColor: isSelected ? '#eff6ff' : 'transparent' }}>
              <Form.Check
                type="checkbox"
                checked={isSelected}
                disabled={!hasNew}
                onChange={() => {
                  const next = new Set(selectedSchemes);
                  if (next.has(idx)) next.delete(idx);
                  else next.add(idx);
                  setSelectedSchemes(next);
                }}
                className="me-2"
              />
              <button
                onClick={() => setExpandedScheme(isExpanded ? null : idx)}
                className="flex-grow-1 bg-transparent border-0 text-start p-0 d-flex align-items-center"
                style={{ cursor: 'pointer' }}
              >
                <div className="flex-grow-1">
                  <div className="small fw-medium">{scheme.schemeName}</div>
                  <div className="d-flex align-items-center gap-2" style={{ fontSize: '0.7rem' }}>
                    <span className="text-muted font-monospace">{scheme.isin}</span>
                    {scheme.folio && <span className="text-muted">Folio: {scheme.folio}</span>}
                    <span className="text-muted">{scheme.amc}</span>
                  </div>
                </div>
                <div className="d-flex align-items-center gap-2 ms-2">
                  {hasNew ? (
                    <span className="badge" style={{ fontSize: '0.65rem', backgroundColor: '#dcfce7', color: '#15803d' }}>
                      {scheme.newTransactionCount} new
                    </span>
                  ) : (
                    <span className="badge bg-light text-muted" style={{ fontSize: '0.65rem' }}>
                      all in DB
                    </span>
                  )}
                  {scheme.existingTransactionCount > 0 && (
                    <span className="badge bg-light text-muted" style={{ fontSize: '0.65rem' }}>
                      {scheme.existingTransactionCount} existing
                    </span>
                  )}
                  {scheme.closingBalance > 0 && (
                    <span className="small text-muted">{scheme.closingBalance.toLocaleString('en-IN', { maximumFractionDigits: 3 })} units</span>
                  )}
                  <ChevronDown size={14} className="text-muted" style={{ transition: 'transform 0.2s', transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)' }} />
                </div>
              </button>
            </div>

            {/* Expanded Transaction List */}
            {isExpanded && (
              <div className="border-top">
                {scheme.exitLoad && (
                  <div className="px-3 py-1" style={{ fontSize: '0.7rem', backgroundColor: '#fefce8', color: '#854d0e' }}>
                    Exit Load: {scheme.exitLoad}
                  </div>
                )}
                <div className="table-responsive" style={{ maxHeight: 300, overflowY: 'auto' }}>
                  <Table size="sm" className="mb-0" style={{ fontSize: '0.75rem' }}>
                    <thead className="table-light">
                      <tr>
                        <th className="px-2 py-1">Date</th>
                        <th className="px-2 py-1">Type</th>
                        <th className="px-2 py-1 text-end">Amount</th>
                        <th className="px-2 py-1 text-end">Units</th>
                        <th className="px-2 py-1 text-end">Price</th>
                        <th className="px-2 py-1">Description</th>
                        <th className="px-2 py-1">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {scheme.transactions.map((t, ti) => (
                        <tr key={ti} style={{ opacity: t.isNew ? 1 : 0.5 }}>
                          <td className="px-2 py-1 text-nowrap">{t.date}</td>
                          <td className="px-2 py-1">
                            <span className={`badge ${t.type === 'BUY' ? 'bg-success' : t.type === 'SELL' ? 'bg-danger' : 'bg-secondary'}`}
                              style={{ fontSize: '0.65rem' }}>
                              {t.type}
                            </span>
                          </td>
                          <td className="px-2 py-1 text-end">{formatCurrency(t.amount)}</td>
                          <td className="px-2 py-1 text-end">{Math.abs(t.units || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 })}</td>
                          <td className="px-2 py-1 text-end">{formatCurrency(t.price)}</td>
                          <td className="px-2 py-1 text-muted text-truncate" style={{ maxWidth: 180 }}>{t.description}</td>
                          <td className="px-2 py-1">
                            {t.isNew ? (
                              <span className="badge" style={{ fontSize: '0.6rem', backgroundColor: '#dcfce7', color: '#15803d' }}>New</span>
                            ) : (
                              <span className="badge bg-light text-muted" style={{ fontSize: '0.6rem' }}>In DB</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </div>
                {scheme.latestNav && (
                  <div className="px-3 py-1 text-muted" style={{ fontSize: '0.7rem' }}>
                    NAV: {formatCurrency(scheme.latestNav)} | Market Value: {formatCurrency(scheme.marketValue)}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}

      {/* Import Bar */}
      <div className="bg-light border rounded p-2 mt-3 d-flex align-items-center justify-content-between">
        <div className="small text-muted">
          <strong>{selectedNewTxns}</strong> new transactions in <strong>{selectedSchemes.size}</strong> scheme{selectedSchemes.size !== 1 ? 's' : ''} selected
        </div>
        <div className="d-flex gap-2">
          <Button size="sm" variant="outline-secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            size="sm" variant="success"
            onClick={onImport}
            disabled={importing || selectedNewTxns === 0}
          >
            {importing ? (
              <><Spinner size="sm" className="me-1" /> Importing...</>
            ) : (
              <><CheckCircle size={14} className="me-1" /> Import {selectedNewTxns} Transactions</>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
