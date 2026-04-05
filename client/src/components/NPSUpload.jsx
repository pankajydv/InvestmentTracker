import React, { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, Button, Form, Alert, Spinner, Table, Row, Col } from 'react-bootstrap';
import { previewNPSStatements, importNPSTransactions } from '../services/api';
import { ArrowLeft, Upload, CheckCircle, ChevronDown, AlertCircle } from 'lucide-react';
import { usePortfolio } from '../context/PortfolioContext';

const TYPE_COLORS = {
  EMPLOYER_CONTRIBUTION: 'bg-success',
  VOLUNTARY_CONTRIBUTION: 'bg-info',
  CHARGES: 'bg-warning text-dark',
  BUY: 'bg-success',
  SELL: 'bg-danger',
  TRANSFER_IN: 'bg-primary',
  TRANSFER_OUT: 'bg-danger',
};

const TYPE_LABELS = {
  EMPLOYER_CONTRIBUTION: 'Employer',
  VOLUNTARY_CONTRIBUTION: 'Voluntary',
  CHARGES: 'Charges',
  BUY: 'Buy',
  SELL: 'Sell',
  TRANSFER_IN: 'Transfer In',
  TRANSFER_OUT: 'Transfer Out',
};

export default function NPSUpload() {
  const navigate = useNavigate();
  const { portfolios, selectedId, refreshPortfolios } = usePortfolio();
  const fileRef = useRef(null);

  const [portfolioId, setPortfolioId] = useState(selectedId || '');
  const [files, setFiles] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [selectedSchemes, setSelectedSchemes] = useState(new Set());
  const [expandedScheme, setExpandedScheme] = useState(null);
  const [password, setPassword] = useState('');

  const handleUpload = async () => {
    setError('');
    if (!portfolioId) return setError('Please select a portfolio first');
    if (!files.length) return setError('Please select at least one NPS statement file');
    setUploading(true);
    try {
      const data = await previewNPSStatements(files, portfolioId, password);
      setPreview(data);
      // Auto-select schemes with new transactions
      setSelectedSchemes(new Set(
        data.schemes
          .map((s, i) => s.newTransactionCount > 0 ? i : null)
          .filter(i => i !== null)
      ));
    } catch (e) {
      setError(e.message);
    } finally {
      setUploading(false);
    }
  };

  const handleImport = async () => {
    setError('');
    if (!preview) return;
    const schemes = [];
    selectedSchemes.forEach(idx => {
      const s = preview.schemes[idx];
      if (!s) return;
      const newTxns = s.transactions.filter(t => t.isNew);
      if (newTxns.length > 0) {
        schemes.push({
          schemeName: s.schemeName,
          transactions: newTxns,
        });
      }
    });
    if (schemes.length === 0) return setError('No new transactions to import in selected schemes');
    setImporting(true);
    try {
      const res = await importNPSTransactions(portfolioId, preview.pran, schemes);
      setResult(res);
      setPreview(null);
      await refreshPortfolios();
    } catch (e) {
      setError(e.message);
    } finally {
      setImporting(false);
    }
  };

  const handleReset = () => {
    setPreview(null);
    setResult(null);
    setFiles([]);
    setError('');
    setSelectedSchemes(new Set());
    setExpandedScheme(null);
    setPassword('');
    if (fileRef.current) fileRef.current.value = '';
  };

  const formatCurrency = (v) => '₹' + Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

  const totalNewTxns = preview
    ? preview.schemes.reduce((s, sc) => s + sc.newTransactionCount, 0)
    : 0;
  const selectedNewTxns = preview
    ? preview.schemes
        .filter((_, i) => selectedSchemes.has(i))
        .reduce((s, sc) => s + sc.newTransactionCount, 0)
    : 0;

  return (
    <div className="mx-auto d-flex flex-column gap-4" style={{ maxWidth: 800 }}>
      <div>
        <button onClick={() => navigate(-1)} className="btn btn-link btn-sm text-muted text-decoration-none d-flex align-items-center gap-1 mb-2 p-0">
          <ArrowLeft className="h-4 w-4" /> Back
        </button>
        <h1 className="h4 fw-bold">Import NPS Statements</h1>
        <p className="text-muted small mb-0">
          Upload NPS transaction statements (CSV from Protean e-NPS or PDF from Karvy/KFintech).
          Each scheme becomes a separate investment.
        </p>
      </div>

      {error && (
        <Alert variant="danger" className="small py-2 d-flex align-items-center gap-2">
          <AlertCircle size={14} className="flex-shrink-0" />
          {error}
        </Alert>
      )}

      {result && (
        <Alert variant="success" className="small py-2">
          <CheckCircle size={14} className="me-1" />
          Successfully imported {result.imported} transaction{result.imported !== 1 ? 's' : ''} across {result.schemes?.length || 0} scheme{(result.schemes?.length || 0) !== 1 ? 's' : ''}.
          {result.skipped > 0 && <span className="text-muted ms-1">({result.skipped} duplicates skipped)</span>}
          <button className="btn btn-link btn-sm p-0 ms-2" onClick={handleReset}>
            Upload more
          </button>
        </Alert>
      )}

      {/* Upload Form */}
      {!preview && !result && (
        <Card className="shadow-sm">
          <Card.Body>
            <h2 className="h6 fw-semibold mb-3">Upload NPS Statement Files</h2>
            <Row className="g-3">
              <Col md={6}>
                <Form.Label className="small">Portfolio</Form.Label>
                <Form.Select
                  size="sm"
                  value={portfolioId}
                  onChange={(e) => setPortfolioId(e.target.value)}
                >
                  <option value="">Select portfolio...</option>
                  {portfolios.map(p => (
                    <option key={p.id} value={p.id}>{p.name}{p.pan_number ? ` (${p.pan_number})` : ''}</option>
                  ))}
                </Form.Select>
              </Col>
              <Col md={6}>
                <Form.Label className="small">Statement Files (CSV / PDF)</Form.Label>
                <Form.Control
                  ref={fileRef}
                  size="sm"
                  type="file"
                  accept=".csv,.pdf"
                  multiple
                  onChange={(e) => setFiles(Array.from(e.target.files))}
                />
              </Col>
            </Row>
            {files.some(f => f.name.toLowerCase().endsWith('.pdf')) && (
              <Row className="g-3 mt-0">
                <Col md={6}>
                  <Form.Label className="small">PDF Password <span className="text-muted">(usually PRAN)</span></Form.Label>
                  <Form.Control
                    size="sm"
                    type="password"
                    placeholder="Enter PDF password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </Col>
              </Row>
            )}
            {files.length > 0 && (
              <div className="mt-2 small text-muted">
                {files.length} file{files.length > 1 ? 's' : ''} selected: {files.map(f => f.name).join(', ')}
              </div>
            )}
            <div className="mt-3">
              <Button
                size="sm"
                variant="primary"
                onClick={handleUpload}
                disabled={uploading || !files.length || !portfolioId}
              >
                {uploading ? <><Spinner size="sm" className="me-1" /> Parsing...</> : <><Upload size={14} className="me-1" /> Parse & Preview</>}
              </Button>
            </div>
          </Card.Body>
        </Card>
      )}

      {/* Preview */}
      {preview && (
        <Card className="shadow-sm">
          <Card.Body>
            {/* Summary Bar */}
            <div className="d-flex align-items-center gap-2 mb-3 flex-wrap">
              <span className="badge bg-info">NPS</span>
              {preview.pran && <span className="badge bg-secondary">PRAN: {preview.pran}</span>}
              {preview.subscriberName && <span className="badge bg-secondary">{preview.subscriberName}</span>}
              <span className="small text-muted ms-auto">
                {preview.summary.totalSchemes} scheme{preview.summary.totalSchemes !== 1 ? 's' : ''} ·{' '}
                <span className="text-success fw-medium">{preview.summary.newTransactions} new</span>
                {preview.summary.existingTransactions > 0 && <> · {preview.summary.existingTransactions} in DB</>}
              </span>
            </div>

            {/* Select All */}
            {totalNewTxns > 0 && (
              <div className="d-flex align-items-center gap-2 mb-2">
                <Form.Check
                  type="checkbox"
                  checked={selectedSchemes.size === preview.schemes.filter(s => s.newTransactionCount > 0).length}
                  onChange={() => {
                    const withNew = preview.schemes.map((s, i) => s.newTransactionCount > 0 ? i : null).filter(i => i !== null);
                    if (selectedSchemes.size === withNew.length) setSelectedSchemes(new Set());
                    else setSelectedSchemes(new Set(withNew));
                  }}
                  label={<span className="small text-muted">Select all schemes with new transactions</span>}
                />
              </div>
            )}

            {/* Scheme List */}
            {preview.schemes.map((scheme, idx) => {
              const isExpanded = expandedScheme === idx;
              const isSelected = selectedSchemes.has(idx);
              const hasNew = scheme.newTransactionCount > 0;

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
                          {scheme.pran && <span className="text-muted font-monospace">PRAN: {scheme.pran}</span>}
                          {scheme.isNew && <span className="badge" style={{ fontSize: '0.6rem', backgroundColor: '#dbeafe', color: '#1d4ed8' }}>New Investment</span>}
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
                        <ChevronDown size={14} className="text-muted" style={{ transition: 'transform 0.2s', transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)' }} />
                      </div>
                    </button>
                  </div>

                  {/* Expanded Transaction List */}
                  {isExpanded && (
                    <div className="border-top">
                      <div className="table-responsive" style={{ maxHeight: 400, overflowY: 'auto' }}>
                        <Table size="sm" className="mb-0" style={{ fontSize: '0.75rem' }}>
                          <thead className="table-light">
                            <tr>
                              <th className="px-2 py-1">Date</th>
                              <th className="px-2 py-1">Type</th>
                              <th className="px-2 py-1 text-end">Amount</th>
                              <th className="px-2 py-1 text-end">NAV</th>
                              <th className="px-2 py-1 text-end">Units</th>
                              <th className="px-2 py-1">Description</th>
                              <th className="px-2 py-1">Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {scheme.transactions.map((t, ti) => (
                              <tr key={ti} style={{ opacity: t.isNew ? 1 : 0.5 }}>
                                <td className="px-2 py-1 text-nowrap">{t.date}</td>
                                <td className="px-2 py-1">
                                  <span className={`badge ${TYPE_COLORS[t.type] || 'bg-secondary'}`} style={{ fontSize: '0.65rem' }}>
                                    {TYPE_LABELS[t.type] || t.type}
                                  </span>
                                </td>
                                <td className="px-2 py-1 text-end">{formatCurrency(t.amount)}</td>
                                <td className="px-2 py-1 text-end">{t.nav ? t.nav.toFixed(4) : '-'}</td>
                                <td className="px-2 py-1 text-end">{t.units ? t.units.toFixed(4) : '-'}</td>
                                <td className="px-2 py-1 text-muted text-truncate" style={{ maxWidth: 200 }}>{t.particulars}</td>
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
                <Button size="sm" variant="outline-secondary" onClick={handleReset}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  variant="success"
                  onClick={handleImport}
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
          </Card.Body>
        </Card>
      )}
    </div>
  );
}
