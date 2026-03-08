import React, { useEffect, useState } from 'react';
import { getPerformance } from '../services/api';
import { formatINR, formatPct, profitColor, TIME_PERIODS } from '../utils/formatters';
import { usePortfolio } from '../context/PortfolioContext';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';

export default function Performance() {
  const { selectedId } = usePortfolio();
  const [period, setPeriod] = useState('1M');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');

  useEffect(() => {
    loadData();
  }, [period, selectedId]);

  const loadData = async () => {
    try {
      setLoading(true);
      const result = await getPerformance(period, null, null, selectedId);
      setData(result);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const handleCustomRange = async () => {
    if (!customFrom || !customTo) return;
    try {
      setLoading(true);
      const result = await getPerformance(null, customFrom, customTo, selectedId);
      setData(result);
      setPeriod('custom');
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  // Format chart data
  const chartData = data?.portfolioData?.map((d) => ({
    date: d.date,
    value: d.total_value,
    invested: d.total_invested,
    profit: d.total_profit_loss,
  })) || [];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">Performance</h1>

      {/* Period Selector */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
        <div className="flex flex-wrap gap-2 mb-4">
          {TIME_PERIODS.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setPeriod(key)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                period === key
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Custom Range */}
        <div className="flex flex-wrap items-center gap-3 border-t border-gray-100 pt-3">
          <span className="text-sm text-gray-500">Custom:</span>
          <input
            type="date"
            value={customFrom}
            onChange={(e) => setCustomFrom(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm"
          />
          <span className="text-sm text-gray-400">to</span>
          <input
            type="date"
            value={customTo}
            onChange={(e) => setCustomTo(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm"
          />
          <button
            onClick={handleCustomRange}
            className="px-4 py-1.5 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700"
          >
            Apply
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        </div>
      ) : data ? (
        <>
          {/* Period Summary */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
              <div className="text-sm text-gray-500 mb-1">Period Return</div>
              <div className={`text-2xl font-bold ${profitColor(data.periodReturn)}`}>
                {data.periodReturn >= 0 ? '+' : ''}{formatINR(data.periodReturn)}
              </div>
              <div className={`text-sm ${profitColor(data.periodReturnPct)}`}>
                {formatPct(data.periodReturnPct)}
              </div>
            </div>
            {data.portfolioData.length > 0 && (
              <>
                <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
                  <div className="text-sm text-gray-500 mb-1">Start Value ({data.startDate})</div>
                  <div className="text-2xl font-bold text-gray-900">
                    {formatINR(data.portfolioData[0]?.total_value)}
                  </div>
                </div>
                <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
                  <div className="text-sm text-gray-500 mb-1">End Value ({data.endDate})</div>
                  <div className="text-2xl font-bold text-gray-900">
                    {formatINR(data.portfolioData[data.portfolioData.length - 1]?.total_value)}
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Portfolio Value Chart */}
          {chartData.length > 1 ? (
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
              <h2 className="text-lg font-semibold text-gray-900 mb-4">Portfolio Value Over Time</h2>
              <ResponsiveContainer width="100%" height={400}>
                <AreaChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 12 }}
                    tickFormatter={(d) => {
                      const date = new Date(d);
                      return `${date.getDate()}/${date.getMonth() + 1}`;
                    }}
                  />
                  <YAxis
                    tick={{ fontSize: 12 }}
                    tickFormatter={(v) => {
                      if (v >= 10000000) return `${(v / 10000000).toFixed(1)}Cr`;
                      if (v >= 100000) return `${(v / 100000).toFixed(1)}L`;
                      return v.toLocaleString('en-IN');
                    }}
                  />
                  <Tooltip
                    formatter={(value, name) => [
                      `₹${Number(value).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`,
                      name === 'value' ? 'Portfolio Value' : name === 'invested' ? 'Invested' : 'Profit/Loss',
                    ]}
                    labelFormatter={(d) => new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                  />
                  <Legend />
                  <Area
                    type="monotone"
                    dataKey="value"
                    name="Portfolio Value"
                    stroke="#3b82f6"
                    fill="#93c5fd"
                    fillOpacity={0.3}
                    strokeWidth={2}
                  />
                  <Area
                    type="monotone"
                    dataKey="invested"
                    name="Invested"
                    stroke="#9ca3af"
                    fill="#e5e7eb"
                    fillOpacity={0.2}
                    strokeWidth={1.5}
                    strokeDasharray="5 5"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-12 text-center">
              <p className="text-gray-500">
                Not enough data to show chart. Data will appear after daily price updates run.
              </p>
              <p className="text-sm text-gray-400 mt-2">
                Click "Update Prices" in the navbar to fetch latest prices.
              </p>
            </div>
          )}

          {/* Profit/Loss Chart */}
          {chartData.length > 1 && (
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
              <h2 className="text-lg font-semibold text-gray-900 mb-4">Profit/Loss Over Time</h2>
              <ResponsiveContainer width="100%" height={300}>
                <AreaChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 12 }}
                    tickFormatter={(d) => {
                      const date = new Date(d);
                      return `${date.getDate()}/${date.getMonth() + 1}`;
                    }}
                  />
                  <YAxis
                    tick={{ fontSize: 12 }}
                    tickFormatter={(v) => {
                      if (Math.abs(v) >= 100000) return `${(v / 100000).toFixed(1)}L`;
                      return v.toLocaleString('en-IN');
                    }}
                  />
                  <Tooltip
                    formatter={(value) => [
                      `₹${Number(value).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`,
                      'Profit/Loss',
                    ]}
                  />
                  <Area
                    type="monotone"
                    dataKey="profit"
                    name="Profit/Loss"
                    stroke="#16a34a"
                    fill="#bbf7d0"
                    fillOpacity={0.3}
                    strokeWidth={2}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
