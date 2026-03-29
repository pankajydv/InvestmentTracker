import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Card, Row, Col, Table, Spinner, Alert, Button } from 'react-bootstrap';
import { getDashboardSummary, triggerPriceUpdate, cancelPriceUpdate } from '../services/api';
import { formatINR, formatNumber, formatPct, formatDate, profitColor, ASSET_TYPE_LABELS, ASSET_TYPE_COLORS } from '../utils/formatters';
import { TrendingUp, TrendingDown, Wallet, PiggyBank, ArrowRight, Receipt, RefreshCw } from 'lucide-react';
import { usePortfolio } from '../context/PortfolioContext';

export default function Dashboard() {
  const navigate = useNavigate();
  const { selectedId, selectedPortfolio } = usePortfolio();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const hideSold = localStorage.getItem('hideSoldInvestments') !== 'false';
  const [sortConfigs, setSortConfigs] = useState({});
  const [updatingType, setUpdatingType] = useState(null);

  const handleUpdateType = async (assetType) => {
    setUpdatingType(assetType);
    try {
      await triggerPriceUpdate([assetType]);
      await loadData();
    } catch (e) {
      alert('Price update failed: ' + e.message);
    } finally {
      setUpdatingType(null);
    }
  };

  const handleCancelUpdate = async () => {
    try { await cancelPriceUpdate(); } catch (_) { /* best effort */ }
  };

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

  const { portfolio, investments, byType, lastUpdate, portfolioCount, totalExpenses } = data;
  const netProfitLoss = portfolio.total_profit_loss - (totalExpenses || 0);

  const handleSort = (type, key) => {
    setSortConfigs(prev => {
      const cur = prev[type] || { key: null, direction: 'asc' };
      if (cur.key !== key) return { ...prev, [type]: { key, direction: 'asc' } };
      if (cur.direction === 'asc') return { ...prev, [type]: { key, direction: 'desc' } };
      return { ...prev, [type]: { key: null, direction: 'asc' } };
    });
  };

  const sortInvestments = (type, investments) => {
    const config = sortConfigs[type];
    if (!config?.key) return investments;
    const fieldMap = {
      name: inv => inv.name,
      price: inv => inv.price_per_unit,
      dayChange: inv => inv.day_change,
      totalCost: inv => inv.invested_amount,
      currentValue: inv => inv.current_value,
      portfolioPct: inv => inv.portfolio_pct || 0,
      totalReturn: inv => inv.profit_loss,
    };
    const getValue = fieldMap[config.key];
    if (!getValue) return investments;
    return [...investments].sort((a, b) => {
      const aVal = getValue(a);
      const bVal = getValue(b);
      const cmp = config.key === 'name'
        ? String(aVal).localeCompare(String(bVal))
        : (aVal || 0) - (bVal || 0);
      return config.direction === 'desc' ? -cmp : cmp;
    });
  };

  const sortColumns = [
    { key: 'name', label: 'Name' },
    { key: 'price', label: 'Last Price', end: true },
    { key: 'dayChange', label: '1 Day Change', end: true },
    { key: 'totalCost', label: 'Total Cost', end: true },
    { key: 'currentValue', label: 'Current Value', end: true },
    { key: 'portfolioPct', label: '% Portfolio', end: true },
    { key: 'totalReturn', label: 'Total Return', end: true },
  ];

  return (
    <div>
      {/* Portfolio Header */}
      {selectedPortfolio ? (
        <div className="d-flex align-items-center gap-2 mb-4">
          <span className="portfolio-dot" style={{ backgroundColor: selectedPortfolio.color }} />
          <h1 className="h4 fw-bold mb-0">{selectedPortfolio.name}</h1>
        </div>
      ) : portfolioCount > 0 ? (
        <h1 className="h4 fw-bold mb-4">
          {portfolioCount} Portfolio{portfolioCount !== 1 ? 's' : ''} Combined
        </h1>
      ) : null}

      {/* Portfolio Summary Cards */}
      <Row className="g-3 mb-4">
        <Col md={4}>
          <Card className="shadow-sm h-100">
            <Card.Body>
              <div className="d-flex align-items-center gap-2 text-muted small mb-1">
                <Wallet size={16} /> CURRENT VALUE
              </div>
              <div className="fs-3 fw-bold">{formatINR(portfolio.total_value)}</div>
              <div className="text-muted small mt-1">{formatINR(portfolio.total_invested)} Invested</div>
            </Card.Body>
          </Card>
        </Col>
        <Col md={4}>
          <Card className="shadow-sm h-100">
            <Card.Body>
              <div className="d-flex align-items-center gap-2 text-muted small mb-1">
                {portfolio.day_change >= 0 ? (
                  <TrendingUp size={16} className="text-success" />
                ) : (
                  <TrendingDown size={16} className="text-danger" />
                )}
                1 DAY CHANGE
              </div>
              <div className={`fs-3 fw-bold ${profitColor(portfolio.day_change)}`}>
                {formatINR(portfolio.day_change)}
              </div>
              <div className={`small mt-1 ${profitColor(portfolio.day_change_pct)}`}>
                {formatPct(portfolio.day_change_pct)}
              </div>
            </Card.Body>
          </Card>
        </Col>
        <Col md={4}>
          <Card className="shadow-sm h-100">
            <Card.Body>
              <div className="d-flex align-items-center gap-2 text-muted small mb-1">
                <PiggyBank size={16} /> ALL-TIME RETURNS
              </div>
              <div className={`fs-3 fw-bold ${profitColor(portfolio.total_profit_loss)}`}>
                {portfolio.total_profit_loss >= 0 ? '+' : ''}{formatINR(portfolio.total_profit_loss)}
              </div>
              <div className={`small mt-1 ${profitColor(portfolio.total_profit_loss_pct)}`}>
                {formatPct(portfolio.total_profit_loss_pct)}
              </div>
              {totalExpenses > 0 && (
                <div className="mt-2 pt-2 border-top" style={{ cursor: 'pointer' }} onClick={() => navigate('/portfolios?tab=charges')} title="View all charges">
                  <div className="d-flex justify-content-between small text-muted">
                    <span><Receipt size={12} className="me-1" />Account Charges</span>
                    <span className="text-danger">-{formatINR(totalExpenses)}</span>
                  </div>
                  <div className="d-flex justify-content-between small fw-semibold mt-1">
                    <span>Net Returns</span>
                    <span className={profitColor(netProfitLoss)}>
                      {netProfitLoss >= 0 ? '+' : ''}{formatINR(netProfitLoss)}
                    </span>
                  </div>
                </div>
              )}
            </Card.Body>
          </Card>
        </Col>
      </Row>

      {/* Asset Allocation */}
      <Card className="shadow-sm mb-4">
        <Card.Body>
          <h2 className="h6 fw-semibold mb-3">Asset Allocation</h2>
          <Row className="g-3">
            {Object.entries(byType).map(([type, info]) => (
              <Col xs={6} md key={type}>
                <div
                  className="rounded p-3 border"
                  style={{ borderLeftColor: ASSET_TYPE_COLORS[type], borderLeftWidth: '4px', borderLeftStyle: 'solid' }}
                >
                  <div className="text-muted" style={{ fontSize: '0.75rem' }}>{ASSET_TYPE_LABELS[type]}</div>
                  <div className="fs-6 fw-semibold">{formatINR(info.totalValue)}</div>
                  <div className={profitColor(info.totalProfitLoss)} style={{ fontSize: '0.75rem' }}>
                    {info.totalProfitLoss >= 0 ? '+' : ''}{formatINR(info.totalProfitLoss)}
                  </div>
                </div>
              </Col>
            ))}
          </Row>
        </Card.Body>
      </Card>

      {/* Investment-wise Breakdown Tables */}
      {Object.entries(byType).map(([type, info]) => (
        <Card key={type} className="shadow-sm mb-4">
          <Card.Header className="bg-white d-flex justify-content-between align-items-center">
            <h2 className="h6 fw-semibold mb-0">
              {ASSET_TYPE_LABELS[type]} ({info.investments.length})
            </h2>
            <div className="d-flex align-items-center gap-2">
              {updatingType === type ? (
                <Button
                  variant="outline-danger"
                  size="sm"
                  className="d-flex align-items-center gap-1 py-0 px-2"
                  style={{ fontSize: '0.75rem' }}
                  onClick={handleCancelUpdate}
                >
                  <RefreshCw size={12} className="spinner-rotate" />
                  Cancel
                </Button>
              ) : (
                <Button
                  variant="outline-success"
                  size="sm"
                  className="d-flex align-items-center gap-1 py-0 px-2"
                  style={{ fontSize: '0.75rem' }}
                  disabled={updatingType != null}
                  onClick={() => handleUpdateType(type)}
                >
                  <RefreshCw size={12} />
                  Update
                </Button>
              )}
              <Link to={`/investments?type=${type}`} className="small text-decoration-none d-flex align-items-center gap-1">
                View All <ArrowRight size={12} />
              </Link>
            </div>
          </Card.Header>
          <div className="responsive-table">
            <Table hover size="sm" className="mb-0 small">
              <thead className="table-light">
                <tr>
                  {sortColumns.map(col => {
                    const sc = sortConfigs[type];
                    return (
                      <th
                        key={col.key}
                        className={`px-3${col.end ? ' text-end' : ''}`}
                        style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}
                        onClick={() => handleSort(type, col.key)}
                      >
                        {col.label}
                        {sc?.key === col.key && (
                          <span className="ms-1" style={{ fontSize: '0.6rem' }}>
                            {sc.direction === 'desc' ? '▼' : '▲'}
                          </span>
                        )}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {sortInvestments(type, info.investments).map((inv) => (
                  <tr key={inv.id}>
                    <td className="px-3">
                      <Link to={`/investments/${inv.id}`} className="fw-medium text-decoration-none">
                        {inv.name}
                      </Link>
                      <div className="d-flex align-items-center gap-2 mt-1">
                        {inv.amfi_code && <span className="text-muted" style={{ fontSize: '0.7rem' }}>{inv.amfi_code}</span>}
                      </div>
                    </td>
                    <td className="px-3 text-end">
                      <div className="fw-medium">{formatNumber(inv.price_per_unit, 2)}</div>
                      <div className="text-muted" style={{ fontSize: '0.7rem' }}>{formatDate(inv.date)}</div>
                    </td>
                    <td className="px-3 text-end">
                      <div className={`fw-medium ${profitColor(inv.day_change)}`}>{formatNumber(inv.day_change, 0)}</div>
                      <div className={profitColor(inv.day_change_pct)} style={{ fontSize: '0.7rem' }}>{formatPct(inv.day_change_pct)}</div>
                    </td>
                    <td className="px-3 text-end">
                      <div className="fw-medium">{formatNumber(inv.invested_amount, 0)}</div>
                      <div className="text-muted" style={{ fontSize: '0.7rem' }}>
                        {inv.total_units > 1 ? formatNumber(inv.invested_amount / inv.total_units, 2) : ''}
                      </div>
                    </td>
                    <td className="px-3 text-end">
                      <div className="fw-medium">{formatNumber(inv.current_value, 0)}</div>
                      <div className="text-muted" style={{ fontSize: '0.7rem' }}>
                        {inv.total_units > 1 ? `${formatNumber(inv.total_units, 0)} Units` : ''}
                      </div>
                    </td>
                    <td className="px-3 text-end">{(inv.portfolio_pct || 0).toFixed(1)}</td>
                    <td className="px-3 text-end">
                      <div className={`fw-semibold ${profitColor(inv.profit_loss)}`}>
                        {inv.profit_loss >= 0 ? '+' : ''}{formatNumber(inv.profit_loss, 0)}
                      </div>
                      <div className={profitColor(inv.profit_loss_pct)} style={{ fontSize: '0.7rem' }}>{formatPct(inv.profit_loss_pct)}</div>
                    </td>
                  </tr>
                ))}
                {/* Total Row */}
                <tr className="table-light fw-semibold">
                  <td className="px-3">Total</td>
                  <td className="px-3"></td>
                  <td className={`px-3 text-end ${profitColor(info.dayChange)}`}>{formatNumber(info.dayChange, 0)}</td>
                  <td className="px-3 text-end">{formatNumber(info.totalInvested, 0)}</td>
                  <td className="px-3 text-end">{formatNumber(info.totalValue, 0)}</td>
                  <td className="px-3 text-end">
                    {portfolio.total_value > 0 ? ((info.totalValue / portfolio.total_value) * 100).toFixed(1) : '0'}
                  </td>
                  <td className={`px-3 text-end ${profitColor(info.totalProfitLoss)}`}>
                    {info.totalProfitLoss >= 0 ? '+' : ''}{formatNumber(info.totalProfitLoss, 0)}
                  </td>
                </tr>
              </tbody>
            </Table>
          </div>
        </Card>
      ))}

      {/* Empty state */}
      {investments.length === 0 && (
        <Card className="shadow-sm text-center p-5">
          <Card.Body>
            <PiggyBank size={64} className="text-muted mx-auto mb-3" style={{ opacity: 0.3 }} />
            <h3 className="h5 fw-medium mb-2">No investments yet</h3>
            <p className="text-muted mb-4">Start by adding your first investment to track your portfolio.</p>
            <Link to="/investments/add" className="btn btn-primary">Add Investment</Link>
          </Card.Body>
        </Card>
      )}

      {/* Last update info */}
      {lastUpdate && (
        <div className="text-center text-muted mt-3" style={{ fontSize: '0.75rem' }}>
          Last updated: {formatDate(lastUpdate)} at {new Date(lastUpdate).toLocaleTimeString('en-IN')}
        </div>
      )}
    </div>
  );
}

function LoadingSpinner() {
  return (
    <div className="d-flex justify-content-center align-items-center" style={{ height: '16rem' }}>
      <Spinner animation="border" variant="primary" />
    </div>
  );
}

function ErrorMessage({ message }) {
  return (
    <Alert variant="danger">
      <strong>Error:</strong> {message}
    </Alert>
  );
}
