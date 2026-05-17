import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, Row, Col, Table, Spinner, Alert, Button } from 'react-bootstrap';
import { getDashboardSummary } from '../services/api';
import { formatINR, formatNumber, formatPct, formatDate, profitColor, ASSET_TYPE_LABELS, ASSET_TYPE_COLORS, ASSET_TYPE_FULL_NAMES } from '../utils/formatters';
import { TrendingUp, TrendingDown, Wallet, PiggyBank, ArrowRight, EyeOff, Eye } from 'lucide-react';
import { usePortfolio } from '../context/PortfolioContext';

function combineDashboardSummaries(results, selectedIds) {
  if (!Array.isArray(results) || !results.length) return null;

  const mergedInvestments = new Map();
  const byType = {};
  let totalExpenses = 0;

  const portfolio = {
    total_value: 0,
    total_invested: 0,
    total_profit_loss: 0,
    day_change: 0,
    xirr_pct: null,
  };

  for (const result of results) {
    const p = result?.portfolio || {};
    portfolio.total_value += Number(p.total_value) || 0;
    portfolio.total_invested += Number(p.total_invested) || 0;
    portfolio.total_profit_loss += Number(p.total_profit_loss) || 0;
    portfolio.day_change += Number(p.day_change) || 0;
    totalExpenses += Number(result?.totalExpenses) || 0;

    for (const inv of result?.investments || []) {
      if (!mergedInvestments.has(inv.id)) {
        mergedInvestments.set(inv.id, {
          ...inv,
          current_value: 0,
          invested_amount: 0,
          profit_loss: 0,
          day_change: 0,
          total_units: 0,
        });
      }

      const target = mergedInvestments.get(inv.id);
      target.current_value += Number(inv.current_value) || 0;
      target.invested_amount += Number(inv.invested_amount) || 0;
      target.profit_loss += Number(inv.profit_loss) || 0;
      target.day_change += Number(inv.day_change) || 0;
      target.total_units += Number(inv.total_units) || 0;
      target.price_per_unit = Number(inv.price_per_unit) || target.price_per_unit || 0;
    }
  }

  const investments = Array.from(mergedInvestments.values()).map((inv) => {
    const prevValue = inv.current_value - inv.day_change;
    const profitLossPct = inv.invested_amount > 0 ? (inv.profit_loss / inv.invested_amount) * 100 : 0;
    const dayChangePct = prevValue > 0 ? (inv.day_change / prevValue) * 100 : 0;
    const portfolioPct = portfolio.total_value > 0 ? (inv.current_value / portfolio.total_value) * 100 : 0;
    return {
      ...inv,
      profit_loss_pct: profitLossPct,
      day_change_pct: dayChangePct,
      portfolio_pct: portfolioPct,
    };
  });

  for (const inv of investments) {
    if (!byType[inv.asset_type]) {
      byType[inv.asset_type] = {
        investments: [],
        totalValue: 0,
        totalInvested: 0,
        totalProfitLoss: 0,
        dayChange: 0,
      };
    }
    byType[inv.asset_type].investments.push(inv);
    byType[inv.asset_type].totalValue += Number(inv.current_value) || 0;
    byType[inv.asset_type].totalInvested += Number(inv.invested_amount) || 0;
    byType[inv.asset_type].totalProfitLoss += Number(inv.profit_loss) || 0;
    byType[inv.asset_type].dayChange += Number(inv.day_change) || 0;
  }

  const prevPortfolioValue = portfolio.total_value - portfolio.day_change;
  portfolio.total_profit_loss_pct = portfolio.total_invested > 0
    ? (portfolio.total_profit_loss / portfolio.total_invested) * 100
    : 0;
  portfolio.day_change_pct = prevPortfolioValue > 0
    ? (portfolio.day_change / prevPortfolioValue) * 100
    : 0;

  return {
    portfolio,
    investments,
    byType,
    portfolioCount: selectedIds.length,
    totalExpenses,
    lastUpdate: results.map((r) => r.lastUpdate).filter(Boolean).sort().at(-1) || null,
  };
}

export default function Dashboard() {
  const { selectedId, selectedIds, selectedPortfolio } = usePortfolio();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [hideSold, setHideSold] = useState(() => localStorage.getItem('hideSoldInvestments') !== 'false');
  const [sortConfigs, setSortConfigs] = useState({});

  const scrollToSection = useCallback((sectionId, { smooth = true, updateHash = true } = {}) => {
    const el = document.getElementById(sectionId);
    if (!el) return;

    const appNavbar = document.querySelector('.navbar.sticky-top');
    const appNavHeight = appNavbar ? appNavbar.getBoundingClientRect().height : 56;
    const top = el.getBoundingClientRect().top + window.scrollY - appNavHeight - 12;

    window.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' });

    if (updateHash && window.location.hash !== `#${sectionId}`) {
      window.history.replaceState(null, '', `#${sectionId}`);
    }
  }, []);

  const toggleHideSold = () => {
    setHideSold(prev => {
      const next = !prev;
      localStorage.setItem('hideSoldInvestments', String(next));
      return next;
    });
  };

  useEffect(() => {
    loadData();
  }, [selectedId, selectedIds, hideSold]);

  useEffect(() => {
    const hash = window.location.hash;
    if (!hash || !hash.startsWith('#section-')) return;
    const sectionId = hash.slice(1);
    const raf = window.requestAnimationFrame(() => {
      scrollToSection(sectionId, { smooth: false, updateHash: false });
    });
    return () => window.cancelAnimationFrame(raf);
  }, [data, scrollToSection]);

  const loadData = async () => {
    try {
      setLoading(true);
      if (selectedIds.length > 1) {
        const results = await Promise.all(selectedIds.map((id) => getDashboardSummary(id, { hideSold })));
        setData(combineDashboardSummaries(results, selectedIds));
      } else {
        const result = await getDashboardSummary(selectedId, { hideSold });
        setData(result);
      }
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
  const netReturnPct = portfolio.total_invested > 0 ? (netProfitLoss / portfolio.total_invested) * 100 : 0;
  const formatINRExact = (amount) => {
    if (amount == null || Number.isNaN(Number(amount))) return '₹0';
    const value = Number(amount);
    const sign = value < 0 ? '-' : '';
    return `${sign}₹${Math.abs(value).toLocaleString('en-IN', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    })}`;
  };

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

  const handleAllocationClick = (event, type) => {
    event.preventDefault();
    scrollToSection(`section-${type}`);
  };

  return (
    <div>
      {/* Portfolio Header */}
      <div className="d-flex justify-content-between align-items-center mb-4">
        {selectedPortfolio ? (
          <div className="d-flex align-items-center gap-2">
            <span className="portfolio-dot" style={{ backgroundColor: selectedPortfolio.color }} />
            <h1 className="h4 fw-bold mb-0">{selectedPortfolio.name}</h1>
          </div>
        ) : portfolioCount > 0 ? (
          <h1 className="h4 fw-bold mb-0">
            {portfolioCount} Portfolio{portfolioCount !== 1 ? 's' : ''} Combined
          </h1>
        ) : <div />}
        <Button
          variant={hideSold ? 'outline-warning' : 'outline-secondary'}
          size="sm"
          onClick={toggleHideSold}
          className="d-flex align-items-center gap-1"
          title={hideSold ? 'Showing active holdings only' : 'Showing all investments'}
        >
          {hideSold ? <EyeOff size={16} /> : <Eye size={16} />}
          {hideSold ? 'Sold hidden' : 'Showing all'}
        </Button>
      </div>

      {/* Portfolio Summary Cards */}
      <Row className="g-3 mb-4">
        <Col md={4}>
          <Card className="shadow-sm">
            <Card.Body className="py-3">
              <div className="d-flex align-items-center gap-2 text-muted small mb-1">
                <Wallet size={16} /> CURRENT VALUE
              </div>
              <div className="fw-bold" style={{ fontSize: '1.9rem', lineHeight: 1.1 }}>{formatINRExact(portfolio.total_value)}</div>
              <div className="text-muted small">{formatINRExact(portfolio.total_invested)} Invested</div>
            </Card.Body>
          </Card>
        </Col>
        <Col md={4}>
          <Card className="shadow-sm">
            <Card.Body className="py-3">
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
              <div className={`small ${profitColor(portfolio.day_change_pct)}`}>
                {formatPct(portfolio.day_change_pct)}
              </div>
            </Card.Body>
          </Card>
        </Col>
        <Col md={4}>
          <Card className="shadow-sm">
            <Card.Body className="py-3">
              <div className="d-flex align-items-center gap-2 text-muted small mb-1">
                <PiggyBank size={16} /> NET RETURNS
              </div>
              <div className={`fw-bold ${profitColor(netProfitLoss)}`} style={{ fontSize: '1.9rem', lineHeight: 1.1 }}>
                {netProfitLoss >= 0 ? '+' : ''}{formatINRExact(netProfitLoss)}
              </div>
              <div className={`small ${profitColor(netReturnPct)}`}>
                <span>Abs: {formatPct(netReturnPct)}</span>
                <span className="mx-2 text-muted">|</span>
                <span>XIRR: {portfolio.xirr_pct == null ? 'N/A' : formatPct(portfolio.xirr_pct)}</span>
              </div>
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
                  <a
                    href={`#section-${type}`}
                    className="text-decoration-underline fw-semibold"
                    style={{ fontSize: '0.95rem', color: ASSET_TYPE_COLORS[type] || '#6c757d' }}
                    onClick={(event) => handleAllocationClick(event, type)}
                    title={ASSET_TYPE_FULL_NAMES[type]}
                  >
                    {ASSET_TYPE_LABELS[type]} ↓
                  </a>
                  <div className="fw-semibold text-nowrap" style={{ fontSize: '1.05rem' }}>{formatINR(info.totalValue)}</div>
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
        <Card key={type} id={`section-${type}`} className="shadow-sm mb-4">
          <Card.Header className="bg-white d-flex justify-content-between align-items-center">
            <h2 className="h6 fw-semibold mb-0" title={ASSET_TYPE_FULL_NAMES[type]}>
              {ASSET_TYPE_LABELS[type]} ({info.investments.length})
            </h2>
            <div className="d-flex align-items-center gap-2">
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
                        {inv.asset_type === 'MUTUAL_FUND' && inv.open_folios_count !== undefined ? (
                          <span className="text-muted" style={{ fontSize: '0.7rem' }}>Folios: {inv.open_folios_count}</span>
                        ) : inv.amfi_code ? (
                          <span className="text-muted" style={{ fontSize: '0.7rem' }}>{inv.amfi_code}</span>
                        ) : null}
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
                        {inv.total_units > 0.0001 ? formatNumber(inv.invested_amount / inv.total_units, 2) : ''}
                      </div>
                    </td>
                    <td className="px-3 text-end">
                      <div className="fw-medium">{formatNumber(inv.current_value, 0)}</div>
                      <div className="text-muted" style={{ fontSize: '0.7rem' }}>
                        {inv.total_units > 0.0001 ? `${formatNumber(inv.total_units, 4)} Units` : ''}
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
