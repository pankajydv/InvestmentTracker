import React, { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { getInvestment, deleteInvestment, addTransaction, deleteTransaction } from '../services/api';
import { formatINR, formatNumber, formatPct, formatDate, profitColor, ASSET_TYPE_LABELS } from '../utils/formatters';
import { ArrowLeft, Trash2, Plus, X } from 'lucide-react';

export default function InvestmentDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showAddTxn, setShowAddTxn] = useState(false);
  const [txnForm, setTxnForm] = useState({
    transaction_type: 'BUY',
    transaction_date: new Date().toISOString().split('T')[0],
    units: '',
    price_per_unit: '',
    amount: '',
    fees: '0',
    notes: '',
  });

  useEffect(() => { loadData(); }, [id]);

  const loadData = async () => {
    try {
      setLoading(true);
      const result = await getInvestment(id);
      setData(result);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm('Delete this investment and all its data?')) return;
    await deleteInvestment(id);
    navigate('/investments');
  };

  const handleAddTransaction = async (e) => {
    e.preventDefault();
    try {
      // Auto-calculate amount if units and price given
      let amount = parseFloat(txnForm.amount);
      if (!amount && txnForm.units && txnForm.price_per_unit) {
        amount = parseFloat(txnForm.units) * parseFloat(txnForm.price_per_unit);
      }

      await addTransaction({
        investment_id: parseInt(id),
        transaction_type: txnForm.transaction_type,
        transaction_date: txnForm.transaction_date,
        units: txnForm.units ? parseFloat(txnForm.units) : null,
        price_per_unit: txnForm.price_per_unit ? parseFloat(txnForm.price_per_unit) : null,
        amount,
        fees: parseFloat(txnForm.fees) || 0,
        notes: txnForm.notes || null,
      });
      setShowAddTxn(false);
      setTxnForm({
        transaction_type: 'BUY', transaction_date: new Date().toISOString().split('T')[0],
        units: '', price_per_unit: '', amount: '', fees: '0', notes: '',
      });
      loadData();
    } catch (e) {
      alert('Error: ' + e.message);
    }
  };

  const handleDeleteTxn = async (txnId) => {
    if (!window.confirm('Delete this transaction?')) return;
    await deleteTransaction(txnId);
    loadData();
  };

  // Auto-calculate amount when units and price change
  const updateTxnField = (field, value) => {
    const updated = { ...txnForm, [field]: value };
    if ((field === 'units' || field === 'price_per_unit') && updated.units && updated.price_per_unit) {
      updated.amount = (parseFloat(updated.units) * parseFloat(updated.price_per_unit)).toFixed(2);
    }
    setTxnForm(updated);
  };

  if (loading) return <div className="flex justify-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div></div>;
  if (!data) return <div className="text-red-600">Investment not found</div>;

  const isPPF = data.asset_type === 'PPF' || data.asset_type === 'PF';
  const txnTypes = isPPF
    ? ['DEPOSIT', 'WITHDRAWAL', 'INTEREST']
    : ['BUY', 'SELL', 'DIVIDEND'];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start gap-3">
        <div>
          <Link to="/investments" className="text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1 mb-2">
            <ArrowLeft className="h-4 w-4" /> Back to Investments
          </Link>
          <h1 className="text-2xl font-bold text-gray-900">{data.name}</h1>
          <div className="flex items-center gap-2 mt-1">
            <span className="inline-block px-2 py-0.5 bg-blue-50 text-blue-700 text-xs rounded-full font-medium">
              {ASSET_TYPE_LABELS[data.asset_type]}
            </span>
            {data.portfolio_name && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-gray-50 text-gray-700 text-xs rounded-full font-medium border border-gray-200">
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: data.portfolio_color || '#6b7280' }}></span>
                {data.portfolio_name}
              </span>
            )}
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowAddTxn(true)}
            className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium"
          >
            <Plus className="h-4 w-4" /> Add Transaction
          </button>
          <button
            onClick={handleDelete}
            className="flex items-center gap-1.5 px-4 py-2 bg-red-50 text-red-600 rounded-lg hover:bg-red-100 text-sm font-medium"
          >
            <Trash2 className="h-4 w-4" /> Delete
          </button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <SummaryCard label="Total Invested" value={formatINR(data.totalInvested)} />
        <SummaryCard label="Current Value" value={formatINR(data.latestValue?.current_value)} />
        <SummaryCard
          label="Profit/Loss"
          value={`${data.latestValue?.profit_loss >= 0 ? '+' : ''}${formatINR(data.latestValue?.profit_loss)}`}
          color={profitColor(data.latestValue?.profit_loss)}
        />
        <SummaryCard
          label="Return %"
          value={formatPct(data.latestValue?.profit_loss_pct)}
          color={profitColor(data.latestValue?.profit_loss_pct)}
        />
      </div>

      {/* Details */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-3">Details</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          {data.ticker_symbol && <Detail label="Ticker" value={data.ticker_symbol} />}
          {data.amfi_code && <Detail label="AMFI Code" value={data.amfi_code} />}
          {data.folio_number && <Detail label="Folio No." value={data.folio_number} />}
          {!isPPF && <Detail label="Total Units" value={formatNumber(data.totalUnits, 3)} />}
          {data.latestValue && <Detail label="Last Price" value={`₹${formatNumber(data.latestValue.price_per_unit, 2)}`} />}
          {data.latestValue && <Detail label="1 Day Change" value={formatNumber(data.latestValue.day_change, 0)} color={profitColor(data.latestValue.day_change)} />}
          <Detail label="Currency" value={data.currency} />
        </div>
      </div>

      {/* Add Transaction Form */}
      {showAddTxn && (
        <div className="bg-white rounded-xl shadow-sm border border-blue-200 p-6">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-lg font-semibold text-gray-900">Add Transaction</h2>
            <button onClick={() => setShowAddTxn(false)} className="text-gray-400 hover:text-gray-600">
              <X className="h-5 w-5" />
            </button>
          </div>
          <form onSubmit={handleAddTransaction} className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Type</label>
              <select
                value={txnForm.transaction_type}
                onChange={(e) => updateTxnField('transaction_type', e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              >
                {txnTypes.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Date</label>
              <input
                type="date"
                value={txnForm.transaction_date}
                onChange={(e) => updateTxnField('transaction_date', e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                required
              />
            </div>
            {!isPPF && (
              <>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Units</label>
                  <input
                    type="number"
                    step="0.001"
                    value={txnForm.units}
                    onChange={(e) => updateTxnField('units', e.target.value)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                    placeholder="Number of units"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Price per Unit</label>
                  <input
                    type="number"
                    step="0.01"
                    value={txnForm.price_per_unit}
                    onChange={(e) => updateTxnField('price_per_unit', e.target.value)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                    placeholder="Price per unit"
                  />
                </div>
              </>
            )}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Amount (₹)</label>
              <input
                type="number"
                step="0.01"
                value={txnForm.amount}
                onChange={(e) => updateTxnField('amount', e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                placeholder="Total amount"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Fees (₹)</label>
              <input
                type="number"
                step="0.01"
                value={txnForm.fees}
                onChange={(e) => updateTxnField('fees', e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
              <input
                type="text"
                value={txnForm.notes}
                onChange={(e) => updateTxnField('notes', e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                placeholder="Optional"
              />
            </div>
            <div className="md:col-span-3">
              <button
                type="submit"
                className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium"
              >
                Add Transaction
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Transactions Table */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">Transactions ({data.transactions.length})</h2>
        </div>
        {data.transactions.length === 0 ? (
          <div className="p-6 text-center text-gray-500">
            No transactions recorded yet. Add your first transaction above.
          </div>
        ) : (
          <div className="responsive-table">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-left text-xs text-gray-500 uppercase tracking-wider">
                  <th className="px-6 py-3">Date</th>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3 text-right">Units</th>
                  <th className="px-4 py-3 text-right">Price/Unit</th>
                  <th className="px-4 py-3 text-right">Amount</th>
                  <th className="px-4 py-3 text-right">Fees</th>
                  <th className="px-4 py-3">Notes</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data.transactions.map((txn) => (
                  <tr key={txn.id} className="hover:bg-gray-50">
                    <td className="px-6 py-3">{formatDate(txn.transaction_date)}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
                        ['BUY', 'DEPOSIT'].includes(txn.transaction_type)
                          ? 'bg-green-50 text-green-700'
                          : ['SELL', 'WITHDRAWAL'].includes(txn.transaction_type)
                            ? 'bg-red-50 text-red-700'
                            : 'bg-blue-50 text-blue-700'
                      }`}>
                        {txn.transaction_type}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">{txn.units ? formatNumber(txn.units, 3) : '-'}</td>
                    <td className="px-4 py-3 text-right">{txn.price_per_unit ? `₹${formatNumber(txn.price_per_unit, 2)}` : '-'}</td>
                    <td className="px-4 py-3 text-right font-medium">₹{formatNumber(txn.amount, 2)}</td>
                    <td className="px-4 py-3 text-right">{txn.fees > 0 ? `₹${formatNumber(txn.fees, 2)}` : '-'}</td>
                    <td className="px-4 py-3 text-gray-500">{txn.notes || '-'}</td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => handleDeleteTxn(txn.id)}
                        className="text-red-400 hover:text-red-600"
                        title="Delete"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function SummaryCard({ label, value, color = 'text-gray-900' }) {
  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className={`text-lg font-bold ${color}`}>{value}</div>
    </div>
  );
}

function Detail({ label, value, color = 'text-gray-900' }) {
  return (
    <div>
      <div className="text-gray-500">{label}</div>
      <div className={`font-medium ${color}`}>{value}</div>
    </div>
  );
}
