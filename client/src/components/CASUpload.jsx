import React, { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
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

  // Selection state
  const [selectedStocks, setSelectedStocks] = useState(new Set());
  const [selectedMFs, setSelectedMFs] = useState(new Set());
  const [selectedBonds, setSelectedBonds] = useState(new Set());

  // Collapse state
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

      // Auto-select all new holdings
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

    // Collect selected stocks
    selectedStocks.forEach(idx => {
      if (preview.stocks[idx]) holdings.push(preview.stocks[idx]);
    });
    // Collect selected MFs
    selectedMFs.forEach(idx => {
      if (preview.mutualFunds[idx]) holdings.push(preview.mutualFunds[idx]);
    });
    // Collect selected bonds
    selectedBonds.forEach(idx => {
      if (preview.bonds[idx]) holdings.push(preview.bonds[idx]);
    });

    if (holdings.length === 0) return setError('No holdings selected for import');

    setImporting(true);
    try {
      const result = await importCASHoldings(portfolioId, holdings);
      // Trigger price update for newly imported investments
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
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <button onClick={() => navigate(-1)} className="text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1 mb-2">
          <ArrowLeft className="h-4 w-4" /> Back
        </button>
        <h1 className="text-2xl font-bold text-gray-900">Import from CAS PDF</h1>
        <p className="text-sm text-gray-500 mt-1">
          Upload your CDSL Consolidated Account Statement to bulk-import investments
        </p>
      </div>

      {error && (
        <div className="bg-red-50 text-red-700 p-3 rounded-lg text-sm flex items-center gap-2">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {/* Step 1: Upload */}
      {!preview && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 space-y-4">
          <h2 className="text-lg font-semibold text-gray-900">1. Select Portfolio & PDF</h2>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Family Member (Portfolio)</label>
            <select
              value={portfolioId}
              onChange={(e) => setPortfolioId(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-full sm:w-72 focus:ring-2 focus:ring-blue-500"
            >
              <option value="">Select a portfolio...</option>
              {portfolios.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} {p.pan_number ? `(PAN: ${p.pan_number})` : '(no PAN set)'}
                </option>
              ))}
            </select>
            {selectedPortfolio && !selectedPortfolio.pan_number && (
              <p className="text-xs text-amber-600 mt-1">
                ⚠ This portfolio has no PAN number. The CAS PDF is password-protected with the PAN.
                Please edit the portfolio to add the PAN number first.
              </p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">CAS PDF File</label>
            <div
              onClick={() => fileRef.current?.click()}
              className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center cursor-pointer hover:border-blue-400 hover:bg-blue-50/50 transition-colors"
            >
              <input
                ref={fileRef}
                type="file"
                accept="application/pdf"
                className="hidden"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
              />
              {file ? (
                <div className="flex items-center justify-center gap-3">
                  <FileText className="h-8 w-8 text-blue-600" />
                  <div className="text-left">
                    <div className="font-medium text-gray-900">{file.name}</div>
                    <div className="text-xs text-gray-500">{(file.size / 1024).toFixed(1)} KB</div>
                  </div>
                </div>
              ) : (
                <div>
                  <Upload className="h-8 w-8 text-gray-400 mx-auto mb-2" />
                  <div className="text-sm text-gray-500">Click to select CAS PDF</div>
                  <div className="text-xs text-gray-400 mt-1">CDSL Consolidated Account Statement (max 20MB)</div>
                </div>
              )}
            </div>
          </div>

          <button
            onClick={handleUpload}
            disabled={uploading || !portfolioId || !file}
            className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium disabled:opacity-50 flex items-center gap-2"
          >
            {uploading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Parsing PDF...
              </>
            ) : (
              <>
                <Upload className="h-4 w-4" />
                Upload & Parse
              </>
            )}
          </button>
        </div>
      )}

      {/* Step 2: Preview & Select */}
      {preview && (
        <>
          {/* Summary Card */}
          <div className="bg-gradient-to-r from-blue-50 to-indigo-50 rounded-xl border border-blue-100 p-6">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold text-gray-900">CAS Summary</h2>
              <span className="text-sm text-gray-500">{preview.investorName}</span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-center">
              <div>
                <div className="text-2xl font-bold text-gray-900">{formatCurrency(preview.portfolioValue)}</div>
                <div className="text-xs text-gray-500">Total Value</div>
              </div>
              <div>
                <div className="text-2xl font-bold text-blue-600">{preview.summary.totalStocks}</div>
                <div className="text-xs text-gray-500">Stocks</div>
              </div>
              <div>
                <div className="text-2xl font-bold text-green-600">{preview.summary.totalMFs}</div>
                <div className="text-xs text-gray-500">Mutual Funds</div>
              </div>
              <div>
                <div className="text-2xl font-bold text-amber-600">{preview.summary.totalBonds}</div>
                <div className="text-xs text-gray-500">Bonds</div>
              </div>
            </div>
          </div>

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
                <span className="font-medium">{h.name}</span>,
                <span className="font-mono text-xs">{h.isin}</span>,
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
                  <span className="font-medium">{h.name}</span>
                  {h.folio && <span className="text-xs text-gray-400 ml-1">({h.folio})</span>}
                </div>,
                <span className={`text-xs px-2 py-0.5 rounded-full ${
                  h.source === 'demat' ? 'bg-purple-100 text-purple-700' : 'bg-teal-100 text-teal-700'
                }`}>
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
                <span className="font-medium">{h.name}</span>,
                <span className="font-mono text-xs">{h.isin}</span>,
                h.quantity,
                formatCurrency(h.marketValue),
                formatCurrency(h.value),
              ]}
            />
          )}

          {/* Import Bar */}
          <div className="sticky bottom-0 bg-white border-t border-gray-200 rounded-xl shadow-lg p-4 flex items-center justify-between">
            <div className="text-sm text-gray-600">
              <strong>{totalSelected}</strong> of {(preview.stocks.length + preview.mutualFunds.length + preview.bonds.length)} holdings selected
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => { setPreview(null); setFile(null); }}
                className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 text-sm"
              >
                Back
              </button>
              <button
                onClick={handleImport}
                disabled={importing || totalSelected === 0}
                className="px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 font-medium text-sm disabled:opacity-50 flex items-center gap-2"
              >
                {importing ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Importing...
                  </>
                ) : (
                  <>
                    <CheckCircle className="h-4 w-4" />
                    Import {totalSelected} Holdings
                  </>
                )}
              </button>
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
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
      <button
        onClick={toggle}
        className="w-full flex items-center justify-between px-6 py-4 hover:bg-gray-50 transition-colors"
      >
        <div className="flex items-center gap-3">
          <span className="text-lg">{emoji}</span>
          <span className="font-semibold text-gray-900">{title}</span>
          <span className="text-sm text-gray-500">({items.length})</span>
          {existingCount > 0 && (
            <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">
              {existingCount} already tracked
            </span>
          )}
        </div>
        {open ? <ChevronUp className="h-4 w-4 text-gray-400" /> : <ChevronDown className="h-4 w-4 text-gray-400" />}
      </button>

      {open && (
        <div className="border-t border-gray-100">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50">
                  <th className="px-4 py-2 text-left w-10">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={() => {
                        if (allSelected) setSelected(new Set());
                        else setSelected(new Set(items.map((_, i) => i)));
                      }}
                      className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                  </th>
                  {columns.map((col, i) => (
                    <th key={i} className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                      {col}
                    </th>
                  ))}
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((h, idx) => {
                  const cells = renderRow(h);
                  return (
                    <tr
                      key={idx}
                      className={`border-t border-gray-50 ${selected.has(idx) ? 'bg-blue-50/50' : 'hover:bg-gray-50'} ${
                        !h.isNew ? 'opacity-75' : ''
                      }`}
                    >
                      <td className="px-4 py-2">
                        <input
                          type="checkbox"
                          checked={selected.has(idx)}
                          onChange={() => {
                            const next = new Set(selected);
                            if (next.has(idx)) next.delete(idx);
                            else next.add(idx);
                            setSelected(next);
                          }}
                          className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                        />
                      </td>
                      {cells.map((cell, i) => (
                        <td key={i} className="px-4 py-2 text-gray-700">{cell}</td>
                      ))}
                      <td className="px-4 py-2">
                        {h.isNew ? (
                          <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full">New</span>
                        ) : (
                          <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full" title={`Matches: ${h.existingName}`}>
                            Tracked
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
