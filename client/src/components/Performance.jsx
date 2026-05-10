import React, { useEffect, useState } from 'react';
import { Card, Row, Col, Spinner, Button } from 'react-bootstrap';
import { getPerformance } from '../services/api';
import { formatINR, formatPct, profitColor, TIME_PERIODS } from '../utils/formatters';
import { usePortfolio } from '../context/PortfolioContext';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';

function combinePerformanceResults(results, startDate, endDate, periodLabel = 'custom') {
  if (!Array.isArray(results) || !results.length) return null;

  const byDate = new Map();
  const byType = new Map();

  for (const result of results) {
    for (const row of result?.portfolioData || []) {
      const date = row.date;
      if (!date) continue;
      if (!byDate.has(date)) {
        byDate.set(date, {
          date,
          total_value: 0,
          total_invested: 0,
          total_profit_loss: 0,
        });
      }
      const target = byDate.get(date);
      target.total_value += Number(row.total_value) || 0;
      target.total_invested += Number(row.total_invested) || 0;
      target.total_profit_loss += Number(row.total_profit_loss) || 0;
    }

    const typeEntries = Object.entries(result?.performanceByAssetType || {});
    for (const [assetType, payload] of typeEntries) {
      if (!byType.has(assetType)) byType.set(assetType, new Map());
      const typeMap = byType.get(assetType);
      for (const row of payload?.dailyData || []) {
        const date = row.date;
        if (!date) continue;
        if (!typeMap.has(date)) {
          typeMap.set(date, {
            date,
            total_value: 0,
            total_invested: 0,
            total_profit_loss: 0,
            total_realized_gain: 0,
            total_unrealized_gain: 0,
            day_change: 0,
          });
        }
        const target = typeMap.get(date);
        target.total_value += Number(row.total_value) || 0;
        target.total_invested += Number(row.total_invested) || 0;
        target.total_profit_loss += Number(row.total_profit_loss) || 0;
        target.total_realized_gain += Number(row.total_realized_gain) || 0;
        target.total_unrealized_gain += Number(row.total_unrealized_gain) || 0;
        target.day_change += Number(row.day_change) || 0;
      }
    }
  }

  const portfolioData = Array.from(byDate.values()).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const performanceByAssetType = {};
  for (const [assetType, typeMap] of byType.entries()) {
    performanceByAssetType[assetType] = {
      asset_type: assetType,
      dailyData: Array.from(typeMap.values())
        .sort((a, b) => String(a.date).localeCompare(String(b.date)))
        .map((row) => {
          const invested = Number(row.total_invested || 0);
          const pl = Number(row.total_profit_loss || 0);
          return {
            ...row,
            total_profit_loss_pct: invested > 0 ? (pl / invested) * 100 : 0,
          };
        }),
    };
  }
  const first = portfolioData[0];
  const last = portfolioData[portfolioData.length - 1];
  const periodReturn = first && last ? (last.total_value - first.total_value) : 0;
  const periodReturnPct = first && first.total_value > 0 ? (periodReturn / first.total_value) * 100 : 0;

  return {
    period: periodLabel,
    startDate: startDate || results[0]?.startDate,
    endDate: endDate || results[0]?.endDate,
    portfolioData,
    performanceByAssetType,
    investmentData: [],
    periodReturn,
    periodReturnPct,
  };
}

export default function Performance() {
  const { selectedId, selectedIds } = usePortfolio();
  const [period, setPeriod] = useState('1M');
  const [selectedAssetType, setSelectedAssetType] = useState('ALL');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');

  useEffect(() => {
    loadData();
  }, [period, selectedId, selectedIds, selectedAssetType]);

  const loadData = async () => {
    try {
      setLoading(true);
      if (selectedIds.length > 1) {
        const results = await Promise.all(selectedIds.map((id) => getPerformance(
          period,
          null,
          null,
          id,
          selectedAssetType !== 'ALL' ? selectedAssetType : null
        )));
        setData(combinePerformanceResults(results, results[0]?.startDate, results[0]?.endDate, period));
      } else {
        const result = await getPerformance(
          period,
          null,
          null,
          selectedId,
          selectedAssetType !== 'ALL' ? selectedAssetType : null
        );
        setData(result);
      }
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
      if (selectedIds.length > 1) {
        const results = await Promise.all(selectedIds.map((id) => getPerformance(
          null,
          customFrom,
          customTo,
          id,
          selectedAssetType !== 'ALL' ? selectedAssetType : null
        )));
        setData(combinePerformanceResults(results, customFrom, customTo, 'custom'));
      } else {
        const result = await getPerformance(
          null,
          customFrom,
          customTo,
          selectedId,
          selectedAssetType !== 'ALL' ? selectedAssetType : null
        );
        setData(result);
      }
      setPeriod('custom');
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const activeSeries = selectedAssetType === 'ALL'
    ? (data?.portfolioData || [])
    : (data?.performanceByAssetType?.[selectedAssetType]?.dailyData || []);

  const chartData = activeSeries.map((d) => ({
    date: d.date,
    value: d.total_value || 0,
    invested: d.total_invested || 0,
    profit: d.total_profit_loss || 0,
  }));

  const startPoint = activeSeries[0];
  const endPoint = activeSeries[activeSeries.length - 1];
  const periodReturn = startPoint && endPoint
    ? (Number(endPoint.total_value || 0) - Number(startPoint.total_value || 0))
    : 0;
  const periodReturnPct = startPoint && Number(startPoint.total_value) > 0
    ? (periodReturn / Number(startPoint.total_value)) * 100
    : 0;
  const availableAssetTypes = Object.keys(data?.performanceByAssetType || {});

  return (
    <div className="d-flex flex-column gap-4">
      <h1 className="h4 fw-bold">Performance</h1>

      {/* Period Selector */}
      <Card className="shadow-sm">
        <Card.Body>
          <div className="d-flex flex-wrap gap-2 mb-3">
            {TIME_PERIODS.map(({ key, label }) => (
              <Button
                key={key}
                size="sm"
                variant={period === key ? 'primary' : 'light'}
                onClick={() => setPeriod(key)}
              >
                {label}
              </Button>
            ))}
          </div>

          <div className="d-flex flex-wrap gap-2 mb-3 border-top pt-3">
            <Button
              size="sm"
              variant={selectedAssetType === 'ALL' ? 'dark' : 'outline-dark'}
              onClick={() => setSelectedAssetType('ALL')}
            >
              All Types
            </Button>
            {availableAssetTypes.map((type) => (
              <Button
                key={type}
                size="sm"
                variant={selectedAssetType === type ? 'dark' : 'outline-dark'}
                onClick={() => setSelectedAssetType(type)}
              >
                {type.replace(/_/g, ' ')}
              </Button>
            ))}
          </div>

          {/* Custom Range */}
          <div className="d-flex flex-wrap align-items-center gap-2 border-top pt-3">
            <span className="small text-muted">Custom:</span>
            <input
              type="date"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="form-control form-control-sm"
              style={{ width: 'auto' }}
            />
            <span className="small text-muted">to</span>
            <input
              type="date"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              className="form-control form-control-sm"
              style={{ width: 'auto' }}
            />
            <Button size="sm" variant="primary" onClick={handleCustomRange}>
              Apply
            </Button>
          </div>
        </Card.Body>
      </Card>

      {loading ? (
        <div className="d-flex justify-content-center py-5">
          <Spinner animation="border" variant="primary" />
        </div>
      ) : data ? (
        <>
          {/* Period Summary */}
          <Row className="g-3">
            <Col md={4}>
              <Card className="shadow-sm h-100">
                <Card.Body>
                  <div className="small text-muted mb-1">Period Return</div>
                  <div className={`fs-4 fw-bold ${profitColor(periodReturn)}`}>
                    {periodReturn >= 0 ? '+' : ''}{formatINR(periodReturn)}
                  </div>
                  <div className={`small ${profitColor(periodReturnPct)}`}>
                    {formatPct(periodReturnPct)}
                  </div>
                </Card.Body>
              </Card>
            </Col>
            {activeSeries.length > 0 && (
              <>
                <Col md={4}>
                  <Card className="shadow-sm h-100">
                    <Card.Body>
                      <div className="small text-muted mb-1">Start Value ({data.startDate})</div>
                      <div className="fs-4 fw-bold">
                        {formatINR(startPoint?.total_value || 0)}
                      </div>
                    </Card.Body>
                  </Card>
                </Col>
                <Col md={4}>
                  <Card className="shadow-sm h-100">
                    <Card.Body>
                      <div className="small text-muted mb-1">End Value ({data.endDate})</div>
                      <div className="fs-4 fw-bold">
                        {formatINR(endPoint?.total_value || 0)}
                      </div>
                    </Card.Body>
                  </Card>
                </Col>
              </>
            )}
          </Row>

          {/* Portfolio Value Chart */}
          {chartData.length > 1 ? (
            <Card className="shadow-sm">
              <Card.Body>
                <h2 className="h6 fw-semibold mb-3">Portfolio Value Over Time</h2>
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
              </Card.Body>
            </Card>
          ) : (
            <Card className="shadow-sm">
              <Card.Body className="py-5 text-center">
                <p className="text-muted">
                  Not enough data to show chart. Data will appear after daily price updates run.
                </p>
                <p className="small text-muted mt-2">
                  Click "Update Prices" in the navbar to fetch latest prices.
                </p>
              </Card.Body>
            </Card>
          )}

          {/* Profit/Loss Chart */}
          {chartData.length > 1 && (
            <Card className="shadow-sm">
              <Card.Body>
                <h2 className="h6 fw-semibold mb-3">Profit/Loss Over Time</h2>
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
              </Card.Body>
            </Card>
          )}
        </>
      ) : null}
    </div>
  );
}
