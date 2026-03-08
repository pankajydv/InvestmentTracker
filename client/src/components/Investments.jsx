import React, { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { getInvestments } from '../services/api';
import { formatINR, ASSET_TYPE_LABELS } from '../utils/formatters';
import { PlusCircle, Filter, EyeOff, Eye } from 'lucide-react';
import { usePortfolio } from '../context/PortfolioContext';

const ASSET_TYPES = ['', 'MUTUAL_FUND', 'INDIAN_STOCK', 'FOREIGN_STOCK', 'PPF', 'PF'];

export default function Investments() {
  const { selectedId } = usePortfolio();
  const [searchParams, setSearchParams] = useSearchParams();
  const [investments, setInvestments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [hideSold, setHideSold] = useState(() => localStorage.getItem('hideSoldInvestments') !== 'false');
  const typeFilter = searchParams.get('type') || '';

  useEffect(() => {
    loadInvestments();
  }, [typeFilter, selectedId, hideSold]);

  const toggleHideSold = () => {
    setHideSold(prev => {
      const next = !prev;
      localStorage.setItem('hideSoldInvestments', String(next));
      return next;
    });
  };

  const loadInvestments = async () => {
    try {
      setLoading(true);
      const result = await getInvestments(typeFilter, selectedId, { hideSold });
      setInvestments(result);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <h1 className="text-2xl font-bold text-gray-900">Investments</h1>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-gray-400" />
            <select
              value={typeFilter}
              onChange={(e) => setSearchParams(e.target.value ? { type: e.target.value } : {})}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              <option value="">All Types</option>
              {ASSET_TYPES.filter(Boolean).map((t) => (
                <option key={t} value={t}>{ASSET_TYPE_LABELS[t]}</option>
              ))}
            </select>
          </div>
          <button
            onClick={toggleHideSold}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors border ${
              hideSold
                ? 'bg-amber-50 text-amber-700 border-amber-300 hover:bg-amber-100'
                : 'bg-gray-50 text-gray-600 border-gray-300 hover:bg-gray-100'
            }`}
            title={hideSold ? 'Showing active holdings only — click to include fully sold' : 'Showing all investments — click to hide fully sold'}
          >
            {hideSold ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            {hideSold ? 'Sold hidden' : 'Showing all'}
          </button>
          <Link
            to="/investments/add"
            className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium transition-colors"
          >
            <PlusCircle className="h-4 w-4" />
            Add Investment
          </Link>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        </div>
      ) : investments.length === 0 ? (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-12 text-center">
          <p className="text-gray-500 mb-4">No investments found.</p>
          <Link to="/investments/add" className="text-blue-600 hover:text-blue-800 font-medium">
            Add your first investment
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {investments.map((inv) => (
            <Link
              key={inv.id}
              to={`/investments/${inv.id}`}
              className="bg-white rounded-xl shadow-sm border border-gray-200 p-5 hover:shadow-md transition-shadow"
            >
              <div className="flex justify-between items-start mb-3">
                <div>
                  <h3 className="font-semibold text-gray-900">{inv.name}</h3>
                  <span className="inline-block mt-1 px-2 py-0.5 bg-blue-50 text-blue-700 text-xs rounded-full font-medium">
                    {ASSET_TYPE_LABELS[inv.asset_type]}
                  </span>
                </div>
              </div>
              <div className="text-sm text-gray-500 space-y-1">
                {inv.ticker_symbol && <div>Ticker: <span className="text-gray-700">{inv.ticker_symbol}</span></div>}
                {inv.amfi_code && <div>AMFI: <span className="text-gray-700">{inv.amfi_code}</span></div>}
                {inv.folio_number && <div>Folio: <span className="text-gray-700">{inv.folio_number}</span></div>}
                <div>Currency: <span className="text-gray-700">{inv.currency}</span></div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
