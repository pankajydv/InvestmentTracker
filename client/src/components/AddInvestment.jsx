import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
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

  // Auto-calculate amount
  const updateTxn = (field, value) => {
    const updated = { ...txn, [field]: value };
    if ((field === 'units' || field === 'price_per_unit') && updated.units && updated.price_per_unit) {
      updated.amount = (parseFloat(updated.units) * parseFloat(updated.price_per_unit)).toFixed(2);
    }
    setTxn(updated);
  };

  // Search mutual funds
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

  // Select a mutual fund from search
  const selectMf = (mf) => {
    setForm({ ...form, name: mf.schemeName, amfi_code: mf.schemeCode });
    setMfResults([]);
    setMfSearch(mf.schemeName);
  };

  // Validate stock ticker
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

  // Submit form
  const handleSubmit = async () => {
    setError('');
    setSubmitting(true);
    try {
      if (!form.name) {
        setError('Name is required');
        setSubmitting(false);
        return;
      }

      // Create investment
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

      // Add initial transaction if amount provided
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
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <button onClick={() => navigate(-1)} className="text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1 mb-2">
          <ArrowLeft className="h-4 w-4" /> Back
        </button>
        <h1 className="text-2xl font-bold text-gray-900">Add Investment</h1>
      </div>

      {/* CAS Import Banner */}
      <Link
        to="/investments/import-cas"
        className="block bg-gradient-to-r from-blue-50 to-indigo-50 rounded-xl border border-blue-200 p-4 hover:border-blue-400 transition-colors"
      >
        <div className="flex items-center gap-3">
          <FileUp className="h-8 w-8 text-blue-600" />
          <div>
            <div className="font-semibold text-gray-900">Import from CAS PDF</div>
            <div className="text-sm text-gray-500">Upload CDSL Consolidated Account Statement to bulk-import all your holdings</div>
          </div>
        </div>
      </Link>

      {error && (
        <div className="bg-red-50 text-red-700 p-3 rounded-lg text-sm">{error}</div>
      )}

      {/* Step 1: Choose Asset Type */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">1. Choose Asset Type</h2>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
          {ASSET_TYPES.map((type) => (
            <button
              key={type}
              onClick={() => {
                setAssetType(type);
                setForm({ ...form, name: '', ticker_symbol: '', amfi_code: '', currency: type === 'FOREIGN_STOCK' ? 'USD' : 'INR' });
                setStockInfo(null);
                setMfResults([]);
                setMfSearch('');
              }}
              className={`p-3 rounded-lg text-sm font-medium border-2 transition-colors ${
                assetType === type
                  ? 'border-blue-500 bg-blue-50 text-blue-700'
                  : 'border-gray-200 text-gray-600 hover:border-gray-300'
              }`}
            >
              {ASSET_TYPE_LABELS[type]}
            </button>
          ))}
        </div>

        {/* Portfolio (Family Member) selector */}
        {portfolios.length > 0 && (
          <div className="mt-4 pt-4 border-t border-gray-100">
            <label className="block text-sm font-medium text-gray-700 mb-2">Assign to Portfolio</label>
            <select
              value={portfolioId || ''}
              onChange={(e) => setPortfolioId(e.target.value ? Number(e.target.value) : '')}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-full sm:w-auto focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              <option value="">Unassigned</option>
              {portfolios.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Step 2: Investment Details */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">2. Investment Details</h2>

        {/* Mutual Fund Search */}
        {isMF && (
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-1">Search Mutual Fund</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={mfSearch}
                onChange={(e) => setMfSearch(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleMfSearch()}
                className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm"
                placeholder="Search by fund name (e.g., HDFC Flexi Cap)"
              />
              <button
                onClick={handleMfSearch}
                disabled={searching}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm disabled:opacity-50"
              >
                <Search className="h-4 w-4" />
              </button>
            </div>
            {mfResults.length > 0 && (
              <div className="mt-2 border border-gray-200 rounded-lg max-h-60 overflow-y-auto">
                {mfResults.map((mf) => (
                  <button
                    key={mf.schemeCode}
                    onClick={() => selectMf(mf)}
                    className="w-full text-left px-4 py-2.5 hover:bg-blue-50 text-sm border-b border-gray-100 last:border-0"
                  >
                    <div className="font-medium text-gray-900">{mf.schemeName}</div>
                    <div className="text-xs text-gray-500">Code: {mf.schemeCode}</div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Stock Ticker Search */}
        {isStock && (
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {assetType === 'INDIAN_STOCK' ? 'NSE Symbol' : 'Ticker Symbol'}
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={form.ticker_symbol}
                onChange={(e) => setForm({ ...form, ticker_symbol: e.target.value.toUpperCase() })}
                onKeyDown={(e) => e.key === 'Enter' && handleStockSearch()}
                className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm"
                placeholder={assetType === 'INDIAN_STOCK' ? 'e.g., RELIANCE, TCS, INFY' : 'e.g., AAPL, MSFT, GOOGL'}
              />
              <button
                onClick={handleStockSearch}
                disabled={searching}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm disabled:opacity-50"
              >
                <Search className="h-4 w-4" />
              </button>
            </div>
            {stockInfo && (
              <div className="mt-2 p-3 bg-green-50 rounded-lg flex items-center gap-2">
                <CheckCircle className="h-4 w-4 text-green-600" />
                <span className="text-sm text-green-700">
                  Found: <strong>{stockInfo.name}</strong> — ₹{stockInfo.price?.toFixed(2)} ({stockInfo.currency})
                </span>
              </div>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              placeholder="Investment name"
              required
            />
          </div>

          {isMF && (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">AMFI Code</label>
                <input
                  type="text"
                  value={form.amfi_code}
                  onChange={(e) => setForm({ ...form, amfi_code: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                  placeholder="e.g., 118989"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Folio Number</label>
                <input
                  type="text"
                  value={form.folio_number}
                  onChange={(e) => setForm({ ...form, folio_number: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                  placeholder="Optional"
                />
              </div>
            </>
          )}

          {isPPF && (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Account Number</label>
                <input
                  type="text"
                  value={form.account_number}
                  onChange={(e) => setForm({ ...form, account_number: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                  placeholder="Account number"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Interest Rate (% p.a.)</label>
                <input
                  type="number"
                  step="0.01"
                  value={form.interest_rate}
                  onChange={(e) => setForm({ ...form, interest_rate: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                  placeholder={assetType === 'PPF' ? '7.1' : '8.25'}
                />
              </div>
            </>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
            <input
              type="text"
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              placeholder="Optional notes"
            />
          </div>
        </div>
      </div>

      {/* Step 3: Initial Transaction */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">
          3. Initial Transaction <span className="text-sm font-normal text-gray-400">(optional)</span>
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Date</label>
            <input
              type="date"
              value={txn.transaction_date}
              onChange={(e) => updateTxn('transaction_date', e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
          </div>

          {!isPPF && (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Units / Shares</label>
                <input
                  type="number"
                  step="0.001"
                  value={txn.units}
                  onChange={(e) => updateTxn('units', e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                  placeholder="Number of units"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Price per Unit (₹)</label>
                <input
                  type="number"
                  step="0.01"
                  value={txn.price_per_unit}
                  onChange={(e) => updateTxn('price_per_unit', e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                  placeholder="Cost per unit"
                />
              </div>
            </>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Total Amount (₹)</label>
            <input
              type="number"
              step="0.01"
              value={txn.amount}
              onChange={(e) => updateTxn('amount', e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              placeholder="Total invested amount"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Fees (₹)</label>
            <input
              type="number"
              step="0.01"
              value={txn.fees}
              onChange={(e) => updateTxn('fees', e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              placeholder="0"
            />
          </div>
        </div>
      </div>

      {/* Submit */}
      <div className="flex justify-end gap-3">
        <button
          onClick={() => navigate(-1)}
          className="px-6 py-3 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 font-medium"
        >
          Cancel
        </button>
        <button
          onClick={handleSubmit}
          disabled={submitting}
          className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium disabled:opacity-50"
        >
          {submitting ? 'Adding...' : 'Add Investment'}
        </button>
      </div>
    </div>
  );
}
