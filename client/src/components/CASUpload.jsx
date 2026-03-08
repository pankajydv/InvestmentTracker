import React, { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, Button, Form, Alert, Table, Spinner } from 'react-bootstrap';
import { usePortfolio } from '../context/PortfolioContext';
import { uploadCASPreview, importCASHoldings, triggerPriceUpdate } from '../services/api';
import { ArrowLeft, Upload, FileText, CheckCircle, AlertCircle, Loader2, ChevronDown, ChevronUp } from 'lucide-react';

const formatCurrency = (v) => '₹' + Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

export default function CASUpload() {
  const navigate = useNavigate();
  const { portfolios, refreshPortfolios } = usePortfolio();
  const fileRef = useRef(null);

  const [portfolioId, setPortfolioId] = useState('');
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState(null);

  const [selectedStocks, setSelectedStocks] = useState(new Set());
  const [selectedMFs, setSelectedMFs] = useState(new Set());
  const [selectedBonds, setSelectedBonds] = useState(new Set());

  const [showStocks, setShowStocks] = useState(true);
  const [showMFs, setShowMFs] = useState(true);
  const [showBonds, setShowBonds] = useState(true);

  const selectedPortfolio = portfolios.find(p => p.id === Number(portfolioId));

  const handleUpload = async () => {
    setError('');
    if (!portfolioId) return setError('Please select a portfolio (family member)');
    if (!file) return setError('Please select a CAS PDF file');

    setUploading(true);
    try {
      const result = await uploadCASPreview(file, portfolioId);
      setPreview(result);
      setSelectedStocks(new Set(result.stocks.filter(h => h.isNew).map((_, i) => i)));
      setSelectedMFs(new Set(result.mutualFunds.filter(h => h.isNew).map((_, i) => i)));
      setSelectedBonds(new Set(result.bonds.filter(h => h.isNew).map((_, i) => i)));
    } catch (e) {
      setError(e.message);
    } finally {
      setUploading(false);
    }
  };

  const handleImport = async () => {
    setError('');
    const holdings = [];
    selectedStocks.forEach(idx => { if (preview.stocks[idx]) holdings.push(preview.stocks[idx]); });
    selectedMFs.forEach(idx => { if (preview.mutualFunds[idx]) holdings.push(preview.mutualFunds[idx]); });
    selectedBonds.forEach(idx => { if (preview.bonds[idx]) holdings.push(preview.bonds[idx]); });

    if (holdings.length === 0) return setError('No holdings selected for import');

    setImporting(true);
    try {
      const result = await importCASHoldings(portfolioId, holdings);
      try { await triggerPriceUpdate(); } catch (e) { /* non-critical */ }
      await refreshPortfolios();
      navigate('/investments', {
        state: { message: `Successfully imported ${result.imported} investments from CAS` },
      });
    } catch (e) {
      setError(e.message);
    } finally {
      setImporting(false);
    }
  };

  const toggleAll = (items, selected, setSelected) => {
    if (selected.size === items.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(items.map((_, i) => i)));
    }
  };

  const toggleItem = (idx, selected, setSelected) => {
    const next = new Set(selected);
    if (next.has(idx)) next.delete(idx);
    else next.add(idx);
    setSelected(next);
  };

  const totalSelected = selectedStocks.size + selectedMFs.size + selectedBonds.size;

  return (
    <div className="mx-auto d-flex flex-column gap-4" style={{ maxWidth: 900 }}>
      {/* Header */}
      <div>
        <button onClick={() => navigate(-1)} className="btn btn-link btn-sm text-muted text-decoration-none d-flex align-items-center gap-1 mb-2 p-0">
          <ArrowLeft size={16} /> Back
        </button>
        <h1 className="h4 fw-bold">Import from CAS PDF</h1>
        <p className="small text-muted mt-1">
          Upload your CDSL Consolidated Account Statement to bulk-import investments
        </p>
      </div>

      {error && (
        <Alert variant="danger" className="small py-2 d-flex align-items-center gap-2">
          <AlertCircle size={16} className="flex-shrink-0" />
          {error}
        </Alert>
      )}

      {/* Step 1: Upload */}
      {!preview && (
        <Card className="shadow-sm">
          <Card.Body className="d-flex flex-column gap-3">
            <h2 className="h6 fw-semibold">1. Select Portfolio & PDF</h2>

            <div>
              <Form.Label className="small">Family Member (Portfolio)</Form.Label>
              <Form.Select
                size="sm"
                value={portfolioId}
                onChange={(e) => setPortfolioId(e.target.value)}
                style={{ maxWidth: 360 }}
              >
                <option value="">Select a portfolio...</option>
                {portfolios.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} {p.pan_number ? `(PAN: ${p.pan_number})` : '(no PAN set)'}
                  </option>
                ))}
              </Form.Select>
              {selectedPortfolio && !selectedPortfolio.pan_number && (
                <p className="text-warning small mt-1">
                  ⚠ This portfolio has no PAN number. The CAS PDF is password-protected with the PAN.
                  Please edit the portfolio to add the PAN number first.
                </p>
              )}
            </div>

            <div>
              <Form.Label className="small">CAS PDF File</Form.Label>
              <div
                onClick={() => fileRef.current?.click()}
                className="dropzone border rounded p-4 text-center"
                style={{ cursor: 'pointer' }}
              >
                <input
                  ref={fileRef}
                  type="file"
                  accept="application/pdf"
                  className="d-none"
                  onChange={(e) => setFile(e.target.files?.[0] || null)}
                />
                {file ? (
                  <div className="d-flex align-items-center justify-content-center gap-3">
                    <FileText size={32} className="text-primary" />
                    <div className="text-start">
                      <div className="fw-medium">{file.name}</div>
                      <div className="text-muted" style={{ fontSize: '0.75rem' }}>{(file.size / 1024).toFixed(1)} KB</div>
                    </div>
                  </div>
                ) : (
                  <div>
                    <Upload size={32} className="text-muted mx-auto mb-2" />
                    <div className="small text-muted">Click to select CAS PDF</div>
                    <div className="text-muted mt-1" style={{ fontSize: '0.75rem' }}>CDSL Consolidated Account Statement (max 20MB)</div>
                  </div>
                )}
              </div>
            </div>

            <div>
              <Button
                variant="primary"
                onClick={handleUpload}
                disabled={uploading || !portfolioId || !file}
                className="d-flex align-items-center gap-2"
              >
                {uploading ? (
                  <>
                    <Loader2 size={16} className="spinner-rotate" />
                    Parsing PDF...
                  </>
                ) : (
                  <>
                    <Upload size={16} />
                    Upload & Parse
                  </>
                )}
              </Button>
            </div>
          </Card.Body>
        </Card>
      )}

      {/* Step 2: Preview & Select */}
      {preview && (
        <>
          {/* Summary Card */}
          <Card className="border-primary border-opacity-25" style={{ background: 'linear-gradient(to right, #eff6ff, #eef2ff)' }}>
            <Card.Body>
              <div className="d-flex align-items-center justify-content-between mb-3">
                <h2 className="h6 fw-semibold mb-0">CAS Summary</h2>
                <span className="small text-muted">{preview.investorName}</span>
              </div>
              <div className="row g-3 text-center">
                <div className="col-6 col-sm-3">
                  <div className="fs-5 fw-bold">{formatCurrency(preview.portfolioValue)}</div>
                  <div className="text-muted" style={{ fontSize: '0.75rem' }}>Total Value</div>
                </div>
                <div className="col-6 col-sm-3">
                  <div className="fs-5 fw-bold text-primary">{preview.summary.totalStocks}</div>
                  <div className="text-muted" style={{ fontSize: '0.75rem' }}>Stocks</div>
                </div>
                <div className="col-6 col-sm-3">
                  <div className="fs-5 fw-bold text-success">{preview.summary.totalMFs}</div>
                  <div className="text-muted" style={{ fontSize: '0.75rem' }}>Mutual Funds</div>
                </div>
                <div className="col-6 col-sm-3">
                  <div className="fs-5 fw-bold text-warning">{preview.summary.totalBonds}</div>
                  <div className="text-muted" style={{ fontSize: '0.75rem' }}>Bonds</div>
                </div>
              </div>
            </Card.Body>
          </Card>

          {/* Stocks */}
          {preview.stocks.length > 0 && (
            <HoldingSection
              title="Stocks"
              emoji="📈"
              items={preview.stocks}
              selected={selectedStocks}
              setSelected={setSelectedStocks}
              open={showStocks}
              toggle={() => setShowStocks(!showStocks)}
              columns={['Name', 'ISIN', 'Units', 'Price', 'Value']}
              renderRow={(h) => [
                <span className="fw-medium">{h.name}</span>,
                <span className="font-monospace" style={{ fontSize: '0.75rem' }}>{h.isin}</span>,
                h.units?.toLocaleString('en-IN'),
                formatCurrency(h.price),
                formatCurrency(h.value),
              ]}
            />
          )}

          {/* Mutual Funds */}
          {preview.mutualFunds.length > 0 && (
            <HoldingSection
              title="Mutual Funds & ETFs"
              emoji="📊"
              items={preview.mutualFunds}
              selected={selectedMFs}
              setSelected={setSelectedMFs}
              open={showMFs}
              toggle={() => setShowMFs(!showMFs)}
              columns={['Name', 'Source', 'Units', 'NAV/Price', 'Value']}
              renderRow={(h) => [
                <div>
                  <span className="fw-medium">{h.name}</span>
                  {h.folio && <span className="text-muted ms-1" style={{ fontSize: '0.75rem' }}>({h.folio})</span>}
                </div>,
                <span className={`badge ${h.source === 'demat' ? 'bg-purple-100 text-purple-700' : 'bg-teal-100 text-teal-700'}`}
                  style={{
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

          {/* Bonds */}
          {preview.bonds.length > 0 && (
            <HoldingSection
              title="Bonds"
              emoji="🏦"
              items={preview.bonds}
              selected={selectedBonds}
              setSelected={setSelectedBonds}
              open={showBonds}
              toggle={() => setShowBonds(!showBonds)}
              columns={['Name', 'ISIN', 'Quantity', 'Market Value', 'Total']}
              renderRow={(h) => [
                <span className="fw-medium">{h.name}</span>,
                <span className="font-monospace" style={{ fontSize: '0.75rem' }}>{h.isin}</span>,
                h.quantity,
                formatCurrency(h.marketValue),
                formatCurrency(h.value),
              ]}
            />
          )}

          {/* Import Bar */}
          <div className="sticky-bottom bg-white border-top rounded shadow-lg p-3 d-flex align-items-center justify-content-between">
            <div className="small text-muted">
              <strong>{totalSelected}</strong> of {(preview.stocks.length + preview.mutualFunds.length + preview.bonds.length)} holdings selected
            </div>
            <div className="d-flex gap-2">
              <Button
                variant="outline-secondary"
                size="sm"
                onClick={() => { setPreview(null); setFile(null); }}
              >
                Back
              </Button>
              <Button
                variant="success"
                size="sm"
                onClick={handleImport}
                disabled={importing || totalSelected === 0}
                className="d-flex align-items-center gap-2"
              >
                {importing ? (
                  <>
                    <Loader2 size={16} className="spinner-rotate" />
                    Importing...
                  </>
                ) : (
                  <>
                    <CheckCircle size={16} />
                    Import {totalSelected} Holdings
                  </>
                )}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/* ─── Reusable holdings table section ─── */
function HoldingSection({ title, emoji, items, selected, setSelected, open, toggle, columns, renderRow }) {
  const allSelected = selected.size === items.length;
  const newCount = items.filter(h => h.isNew).length;
  const existingCount = items.length - newCount;

  return (
    <Card className="shadow-sm overflow-hidden">
      <button
        onClick={toggle}
        className="d-flex align-items-center justify-content-between w-100 px-3 py-3 bg-transparent border-0"
        style={{ cursor: 'pointer' }}
        onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#f8f9fa'}
        onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
      >
        <div className="d-flex align-items-center gap-2">
          <span style={{ fontSize: '1.1rem' }}>{emoji}</span>
          <span className="fw-semibold">{title}</span>
          <span className="small text-muted">({items.length})</span>
          {existingCount > 0 && (
            <span className="badge" style={{ fontSize: '0.7rem', backgroundColor: '#fef3c7', color: '#92400e' }}>
              {existingCount} already tracked
            </span>
          )}
        </div>
        {open ? <ChevronUp size={16} className="text-muted" /> : <ChevronDown size={16} className="text-muted" />}
      </button>

      {open && (
        <div className="border-top">
          <div className="table-responsive">
            <Table size="sm" className="mb-0 small">
              <thead className="table-light">
                <tr>
                  <th className="px-3 py-2" style={{ width: 40 }}>
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
                    <th key={i} className="px-3 py-2 text-muted text-uppercase" style={{ fontSize: '0.7rem' }}>
                      {col}
                    </th>
                  ))}
                  <th className="px-3 py-2 text-muted text-uppercase" style={{ fontSize: '0.7rem' }}>Status</th>
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
                      <td className="px-3 py-2">
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
                        <td key={i} className="px-3 py-2">{cell}</td>
                      ))}
                      <td className="px-3 py-2">
                        {h.isNew ? (
                          <span className="badge" style={{ fontSize: '0.7rem', backgroundColor: '#dcfce7', color: '#15803d' }}>New</span>
                        ) : (
                          <span className="badge bg-light text-muted" style={{ fontSize: '0.7rem' }} title={`Matches: ${h.existingName}`}>
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
    </Card>
  );
}
