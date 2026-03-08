import React, { useEffect, useState, useRef } from 'react';
import { Link } from 'react-router-dom';
import { getTransactions, getBrokers, getInvestmentNames } from '../services/api';
import { formatNumber, formatDate, ASSET_TYPE_LABELS } from '../utils/formatters';
import { usePortfolio } from '../context/PortfolioContext';

const TRANSACTION_TYPES = [
  'BUY', 'SELL', 'DIVIDEND', 'BONUS', 'IPO',
];

const TYPE_COLORS = {
  BUY: 'bg-green-50 text-green-700',
  DEPOSIT: 'bg-green-50 text-green-700',
  IPO: 'bg-green-50 text-green-700',
  TRANSFER_IN: 'bg-green-50 text-green-700',
  BONUS: 'bg-emerald-50 text-emerald-700',
  RIGHTS: 'bg-emerald-50 text-emerald-700',
  SPLIT: 'bg-blue-50 text-blue-700',
  DIVIDEND: 'bg-blue-50 text-blue-700',
  INTEREST: 'bg-blue-50 text-blue-700',
  MERGER: 'bg-purple-50 text-purple-700',
  CONSOLIDATION: 'bg-purple-50 text-purple-700',
  SELL: 'bg-red-50 text-red-700',
  WITHDRAWAL: 'bg-red-50 text-red-700',
  TRANSFER_OUT: 'bg-red-50 text-red-700',
};

export default function Transactions() {
  const { selectedId } = usePortfolio();
  const [transactions, setTransactions] = useState([]);
  const [brokers, setBrokers] = useState([]);
  const [investmentNames, setInvestmentNames] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterType, setFilterType] = useState([]);
  const [filterBroker, setFilterBroker] = useState('');
  const [filterInvestment, setFilterInvestment] = useState('');
  const [typeDropdownOpen, setTypeDropdownOpen] = useState(false);
  const typeDropdownRef = useRef(null);

  useEffect(() => {
    getBrokers().then(setBrokers).catch(() => {});
  }, []);

  // Close type dropdown on outside click
  useEffect(() => {
    const handleClick = (e) => {
      if (typeDropdownRef.current && !typeDropdownRef.current.contains(e.target)) {
        setTypeDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  useEffect(() => {
    const params = selectedId ? { portfolio_id: selectedId } : {};
    getInvestmentNames(params).then(setInvestmentNames).catch(() => {});
    setFilterInvestment('');
  }, [selectedId]);

  useEffect(() => {
    loadTransactions();
  }, [selectedId, filterType, filterBroker, filterInvestment]);

  const loadTransactions = async () => {
    try {
      setLoading(true);
      const params = {};
      if (selectedId) params.portfolio_id = selectedId;
      if (filterType.length) params.type = filterType.join(',');
      if (filterBroker) params.broker = filterBroker;
      if (filterInvestment) params.investment_name = filterInvestment;
      const result = await getTransactions(params);
      setTransactions(result);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  // Derive the unique types present in the data for showing counts
  const typeCounts = transactions.reduce((acc, t) => {
    acc[t.transaction_type] = (acc[t.transaction_type] || 0) + 1;
    return acc;
  }, {});

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-gray-900">Transactions</h1>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 relative" ref={typeDropdownRef}>
          <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">Type</label>
          <button
            onClick={() => setTypeDropdownOpen(!typeDropdownOpen)}
            className="text-sm border border-gray-300 rounded-lg px-3 py-1.5 bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 flex items-center gap-1.5 min-w-[120px]"
          >
            {filterType.length === 0 ? (
              <span className="text-gray-700">All Types</span>
            ) : (
              <span className="flex flex-wrap gap-1">
                {filterType.map(t => (
                  <span key={t} className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${TYPE_COLORS[t] || 'bg-gray-100 text-gray-700'}`}>
                    {t.replace(/_/g, ' ')}
                    <button
                      onClick={(e) => { e.stopPropagation(); setFilterType(filterType.filter(x => x !== t)); }}
                      className="ml-1 hover:opacity-70"
                    >×</button>
                  </span>
                ))}
              </span>
            )}
            <svg className="w-4 h-4 text-gray-400 ml-auto shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {typeDropdownOpen && (
            <div className="absolute top-full left-0 mt-1 z-20 bg-white border border-gray-200 rounded-lg shadow-lg py-1 min-w-[160px]">
              {TRANSACTION_TYPES.map(t => {
                const selected = filterType.includes(t);
                return (
                  <button
                    key={t}
                    onClick={() => {
                      setFilterType(selected ? filterType.filter(x => x !== t) : [...filterType, t]);
                    }}
                    className={`w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 hover:bg-gray-50 ${selected ? 'font-medium' : ''}`}
                  >
                    <span className={`w-4 h-4 rounded border flex items-center justify-center text-xs ${selected ? 'bg-blue-600 border-blue-600 text-white' : 'border-gray-300'}`}>
                      {selected && '✓'}
                    </span>
                    <span className={`px-1.5 py-0.5 rounded text-xs ${TYPE_COLORS[t] || 'bg-gray-100 text-gray-700'}`}>
                      {t.replace(/_/g, ' ')}
                    </span>
                  </button>
                );
              })}
              {filterType.length > 0 && (
                <>
                  <div className="border-t border-gray-100 my-1" />
                  <button
                    onClick={() => { setFilterType([]); setTypeDropdownOpen(false); }}
                    className="w-full text-left px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-50"
                  >
                    Clear selection
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">Investment</label>
          <select
            value={filterInvestment}
            onChange={(e) => setFilterInvestment(e.target.value)}
            className="text-sm border border-gray-300 rounded-lg px-3 py-1.5 bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 max-w-[220px]"
          >
            <option value="">All Investments</option>
            {investmentNames.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        </div>

        {brokers.length > 0 && (
          <div className="flex items-center gap-2">
            <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">Broker</label>
            <select
              value={filterBroker}
              onChange={(e) => setFilterBroker(e.target.value)}
              className="text-sm border border-gray-300 rounded-lg px-3 py-1.5 bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              <option value="">All Brokers</option>
              {brokers.map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
          </div>
        )}

        {(filterType.length > 0 || filterBroker || filterInvestment) && (
          <button
            onClick={() => { setFilterType([]); setFilterBroker(''); setFilterInvestment(''); }}
            className="text-xs text-gray-500 hover:text-gray-700 underline ml-1"
          >
            Clear filters
          </button>
        )}

        <span className="ml-auto text-xs text-gray-400">
          {transactions.length} transaction{transactions.length !== 1 ? 's' : ''}
        </span>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
        {loading ? (
          <div className="flex justify-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
          </div>
        ) : transactions.length === 0 ? (
          <div className="p-12 text-center text-gray-500">
            <p>No transactions found.</p>
            {(filterType.length > 0 || filterBroker || filterInvestment) ? (
              <button onClick={() => { setFilterType([]); setFilterBroker(''); setFilterInvestment(''); }}
                className="text-blue-600 hover:text-blue-800 mt-2 inline-block">
                Clear filters
              </button>
            ) : (
              <Link to="/investments/add" className="text-blue-600 hover:text-blue-800 mt-2 inline-block">
                Add your first investment
              </Link>
            )}
          </div>
        ) : (
          <div className="responsive-table">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-left text-xs text-gray-500 uppercase tracking-wider">
                  <th className="px-6 py-3">Date</th>
                  <th className="px-4 py-3">Investment</th>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3 text-right">Units</th>
                  <th className="px-4 py-3 text-right">Price/Unit</th>
                  <th className="px-4 py-3 text-right">Amount</th>
                  <th className="px-4 py-3">Broker</th>
                  <th className="px-4 py-3">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {transactions.map((txn) => (
                  <tr key={txn.id} className="hover:bg-gray-50">
                    <td className="px-6 py-3 whitespace-nowrap">{formatDate(txn.transaction_date)}</td>
                    <td className="px-4 py-3">
                      <Link to={`/investments/${txn.investment_id}`} className="text-blue-700 hover:text-blue-900 font-medium">
                        {txn.investment_name}
                      </Link>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-xs text-gray-400">{ASSET_TYPE_LABELS[txn.asset_type]}</span>
                        {!selectedId && txn.portfolio_name && (
                          <span className="text-xs text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded">
                            {txn.portfolio_name}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
                        TYPE_COLORS[txn.transaction_type] || 'bg-gray-50 text-gray-700'
                      }`}>
                        {txn.transaction_type.replace(/_/g, ' ')}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">{txn.units ? formatNumber(txn.units, 3) : '-'}</td>
                    <td className="px-4 py-3 text-right">{txn.price_per_unit ? `₹${formatNumber(txn.price_per_unit, 2)}` : '-'}</td>
                    <td className="px-4 py-3 text-right font-medium">₹{formatNumber(txn.amount, 2)}</td>
                    <td className="px-4 py-3 text-gray-500 text-xs">{txn.broker || '-'}</td>
                    <td className="px-4 py-3 text-gray-500 truncate max-w-[150px]">{txn.notes || '-'}</td>
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
