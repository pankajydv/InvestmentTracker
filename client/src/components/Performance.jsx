import React, { useEffect, useState } from 'react';
import { Card, Row, Col, Spinner, Button } from 'react-bootstrap';
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

  const chartData = data?.portfolioData?.map((d) => ({
    date: d.date,
    value: d.total_value,
    invested: d.total_invested,
    profit: d.total_profit_loss,
  })) || [];

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
                  <div className={`fs-4 fw-bold ${profitColor(data.periodReturn)}`}>
                    {data.periodReturn >= 0 ? '+' : ''}{formatINR(data.periodReturn)}
                  </div>
                  <div className={`small ${profitColor(data.periodReturnPct)}`}>
                    {formatPct(data.periodReturnPct)}
                  </div>
                </Card.Body>
              </Card>
            </Col>
            {data.portfolioData.length > 0 && (
              <>
                <Col md={4}>
                  <Card className="shadow-sm h-100">
                    <Card.Body>
                      <div className="small text-muted mb-1">Start Value ({data.startDate})</div>
                      <div className="fs-4 fw-bold">
                        {formatINR(data.portfolioData[0]?.total_value)}
                      </div>
                    </Card.Body>
                  </Card>
                </Col>
                <Col md={4}>
                  <Card className="shadow-sm h-100">
                    <Card.Body>
                      <div className="small text-muted mb-1">End Value ({data.endDate})</div>
                      <div className="fs-4 fw-bold">
                        {formatINR(data.portfolioData[data.portfolioData.length - 1]?.total_value)}
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
