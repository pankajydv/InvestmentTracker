import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getDashboardSummary } from '../services/api';
import { formatINR, formatNumber, formatPct, formatDate, profitColor, ASSET_TYPE_LABELS, ASSET_TYPE_COLORS } from '../utils/formatters';
import { TrendingUp, TrendingDown, Wallet, PiggyBank, ArrowRight } from 'lucide-react';
import { usePortfolio } from '../context/PortfolioContext';

export default function Dashboard() {
  const { selectedId, selectedPortfolio } = usePortfolio();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const hideSold = localStorage.getItem('hideSoldInvestments') !== 'false';

  useEffect(() => {
    loadData();
  }, [selectedId]);

  const loadData = async () => {
    try {
      setLoading(true);
      const result = await getDashboardSummary(selectedId, { hideSold });
      setData(result);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  if (loading) return <LoadingSpinner />;
  if (error) return <ErrorMessage message={error} />;
  if (!data) return null;

  const { portfolio, investments, byType, lastUpdate, portfolioCount } = data;

  return (
    <div className="space-y-6">
      {/* Portfolio Header (shows whose portfolio) */}
      {selectedPortfolio ? (
        <div className="flex items-center gap-3">
          <span
            className="w-4 h-4 rounded-full"
            style={{ backgroundColor: selectedPortfolio.color }}
          />
          <h1 className="text-2xl font-bold text-gray-900">{selectedPortfolio.name}</h1>
        </div>
      ) : portfolioCount > 0 ? (
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-bold text-gray-900">
            {portfolioCount} Portfolio{portfolioCount !== 1 ? 's' : ''} Combined
          </h1>
        </div>
      ) : null}

      {/* Portfolio Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Current Value */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <div className="flex items-center gap-2 text-sm text-gray-500 mb-1">
            <Wallet className="h-4 w-4" />
            CURRENT VALUE
          </div>
          <div className="text-3xl font-bold text-gray-900">
            {formatINR(portfolio.total_value)}
          </div>
          <div className="text-sm text-gray-500 mt-1">
            {formatINR(portfolio.total_invested)} Invested
          </div>
        </div>

        {/* 1 Day Change */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <div className="flex items-center gap-2 text-sm text-gray-500 mb-1">
            {portfolio.day_change >= 0 ? (
              <TrendingUp className="h-4 w-4 text-green-500" />
            ) : (
              <TrendingDown className="h-4 w-4 text-red-500" />
            )}
            1 DAY CHANGE
          </div>
          <div className={`text-3xl font-bold ${profitColor(portfolio.day_change)}`}>
            {formatINR(portfolio.day_change)}
          </div>
          <div className={`text-sm mt-1 ${profitColor(portfolio.day_change_pct)}`}>
            {formatPct(portfolio.day_change_pct)}
          </div>
        </div>

        {/* All Time Returns */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <div className="flex items-center gap-2 text-sm text-gray-500 mb-1">
            <PiggyBank className="h-4 w-4" />
            ALL-TIME RETURNS
          </div>
          <div className={`text-3xl font-bold ${profitColor(portfolio.total_profit_loss)}`}>
            {portfolio.total_profit_loss >= 0 ? '+' : ''}{formatINR(portfolio.total_profit_loss)}
          </div>
          <div className={`text-sm mt-1 ${profitColor(portfolio.total_profit_loss_pct)}`}>
            {formatPct(portfolio.total_profit_loss_pct)}
          </div>
        </div>
      </div>

      {/* Asset Type Breakdown */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Asset Allocation</h2>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {Object.entries(byType).map(([type, info]) => (
            <div
              key={type}
              className="rounded-lg p-3 border border-gray-100"
              style={{ borderLeftColor: ASSET_TYPE_COLORS[type], borderLeftWidth: '4px' }}
            >
              <div className="text-xs text-gray-500">{ASSET_TYPE_LABELS[type]}</div>
              <div className="text-lg font-semibold text-gray-900">{formatINR(info.totalValue)}</div>
              <div className={`text-xs ${profitColor(info.totalProfitLoss)}`}>
                {info.totalProfitLoss >= 0 ? '+' : ''}{formatINR(info.totalProfitLoss)}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Investment-wise Breakdown Tables */}
      {Object.entries(byType).map(([type, info]) => (
        <div key={type} className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200 flex justify-between items-center">
            <h2 className="text-lg font-semibold text-gray-900">
              {ASSET_TYPE_LABELS[type]} ({info.investments.length})
            </h2>
            <Link
              to={`/investments?type=${type}`}
              className="text-sm text-blue-600 hover:text-blue-800 flex items-center gap-1"
            >
              View All <ArrowRight className="h-3 w-3" />
            </Link>
          </div>

          <div className="responsive-table">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-left text-xs text-gray-500 uppercase tracking-wider">
                  <th className="px-6 py-3">Name</th>
                  <th className="px-4 py-3 text-right">Last Price</th>
                  <th className="px-4 py-3 text-right">1 Day Change</th>
                  <th className="px-4 py-3 text-right">Total Cost</th>
                  <th className="px-4 py-3 text-right">Current Value</th>
                  <th className="px-4 py-3 text-right">% Portfolio</th>
                  <th className="px-4 py-3 text-right">Total Return</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {info.investments.map((inv) => (
                  <tr key={inv.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-6 py-4">
                      <Link to={`/investments/${inv.id}`} className="font-medium text-blue-700 hover:text-blue-900">
                        {inv.name}
                      </Link>
                      <div className="flex items-center gap-2 mt-0.5">
                        {inv.amfi_code && (
                          <span className="text-xs text-gray-400">{inv.amfi_code}</span>
                        )}
                        {!selectedId && inv.portfolio_name && (
                          <span
                            className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full"
                            style={{ backgroundColor: inv.portfolio_color + '20', color: inv.portfolio_color }}
                          >
                            <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: inv.portfolio_color }} />
                            {inv.portfolio_name}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-4 text-right">
                      <div className="font-medium">{formatNumber(inv.price_per_unit, 2)}</div>
                      <div className="text-xs text-gray-400">{formatDate(inv.date)}</div>
                    </td>
                    <td className="px-4 py-4 text-right">
                      <div className={`font-medium ${profitColor(inv.day_change)}`}>
                        {formatNumber(inv.day_change, 0)}
                      </div>
                      <div className={`text-xs ${profitColor(inv.day_change_pct)}`}>
                        {formatPct(inv.day_change_pct)}
                      </div>
                    </td>
                    <td className="px-4 py-4 text-right">
                      <div className="font-medium">{formatNumber(inv.invested_amount, 0)}</div>
                      <div className="text-xs text-gray-400">
                        {inv.total_units > 1
                          ? `${formatNumber(inv.invested_amount / inv.total_units, 2)}`
                          : ''}
                      </div>
                    </td>
                    <td className="px-4 py-4 text-right">
                      <div className="font-medium">{formatNumber(inv.current_value, 0)}</div>
                      <div className="text-xs text-gray-400">
                        {inv.total_units > 1
                          ? `${formatNumber(inv.total_units, 0)} Units`
                          : ''}
                      </div>
                    </td>
                    <td className="px-4 py-4 text-right">
                      {(inv.portfolio_pct || 0).toFixed(1)}
                    </td>
                    <td className="px-4 py-4 text-right">
                      <div className={`font-semibold ${profitColor(inv.profit_loss)}`}>
                        {inv.profit_loss >= 0 ? '+' : ''}{formatNumber(inv.profit_loss, 0)}
                      </div>
                      <div className={`text-xs ${profitColor(inv.profit_loss_pct)}`}>
                        {formatPct(inv.profit_loss_pct)}
                      </div>
                    </td>
                  </tr>
                ))}
                {/* Type Total Row */}
                <tr className="bg-gray-50 font-semibold">
                  <td className="px-6 py-3">Total</td>
                  <td className="px-4 py-3"></td>
                  <td className={`px-4 py-3 text-right ${profitColor(info.dayChange)}`}>
                    {formatNumber(info.dayChange, 0)}
                  </td>
                  <td className="px-4 py-3 text-right">{formatNumber(info.totalInvested, 0)}</td>
                  <td className="px-4 py-3 text-right">{formatNumber(info.totalValue, 0)}</td>
                  <td className="px-4 py-3 text-right">
                    {portfolio.total_value > 0
                      ? ((info.totalValue / portfolio.total_value) * 100).toFixed(1)
                      : '0'}
                  </td>
                  <td className={`px-4 py-3 text-right ${profitColor(info.totalProfitLoss)}`}>
                    {info.totalProfitLoss >= 0 ? '+' : ''}{formatNumber(info.totalProfitLoss, 0)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {/* Empty state */}
      {investments.length === 0 && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-12 text-center">
          <PiggyBank className="h-16 w-16 text-gray-300 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-900 mb-2">No investments yet</h3>
          <p className="text-gray-500 mb-6">Start by adding your first investment to track your portfolio.</p>
          <Link
            to="/investments/add"
            className="inline-flex items-center gap-2 px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            Add Investment
          </Link>
        </div>
      )}

      {/* Last update info */}
      {lastUpdate && (
        <div className="text-center text-xs text-gray-400">
          Last updated: {formatDate(lastUpdate)} at {new Date(lastUpdate).toLocaleTimeString('en-IN')}
        </div>
      )}
    </div>
  );
}

function LoadingSpinner() {
  return (
    <div className="flex justify-center items-center h-64">
      <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-600"></div>
    </div>
  );
}

function ErrorMessage({ message }) {
  return (
    <div className="bg-red-50 text-red-700 p-4 rounded-lg">
      <strong>Error:</strong> {message}
    </div>
  );
}
