import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Alert, Button, Card, Col, Row, Spinner } from 'react-bootstrap';
import { ArrowLeft, PiggyBank, TrendingDown, TrendingUp, Wallet } from 'lucide-react';
import { getDashboardSummary, getDashboardVersion, getAssetIntervalMetrics } from '../services/api';
import { usePortfolio } from '../context/PortfolioContext';
import { useAppSettings } from '../context/AppSettingsContext';
import { formatDate, formatINR, formatNumber, formatPct, profitColor, ASSET_TYPE_FULL_NAMES, ASSET_TYPE_LABELS, ASSET_TYPE_SLUG_TO_KEY, isPrivacyMaskEnabled, getMaskedValue } from '../utils/formatters';
import { getDashboardCacheKey, getCachedDashboardSummary, setCachedDashboardSummary } from '../utils/dashboardSummaryCache';
import AssetTypeHoldingsTable from './AssetTypeHoldingsTable';
import DashboardRolloverTable from './DashboardRolloverTable';
import { usePrivacyMaskRefresh } from '../utils/privacyMode';

function combineDashboardSummaries(results, selectedIds) {
  if (!Array.isArray(results) || !results.length) return null;

  const mergedInvestments = new Map();
  const byType = {};
  const byTypeTotals = {};
  let totalExpenses = 0;
  let firstXirrPct = null;
  let xirrPctSet = false;
  let xirrPctConsistent = true;
  const firstRollupWarning = results.find((r) => r?.rollupWarning)?.rollupWarning || null;
  const portfolio = {
    total_value: 0,
    total_invested: 0,
    total_profit_loss: 0,
    total_realized_proceeds: 0,
    day_change: 0,
    day_change_as_of_date: null,
    day_change_as_of_mixed: false,
    xirr_pct: null,
  };

  for (const result of results) {
    const p = result?.portfolio || {};
    portfolio.total_value += Number(p.total_value) || 0;
    portfolio.total_invested += Number(p.total_invested) || 0;
    portfolio.total_profit_loss += Number(p.total_profit_loss) || 0;
    portfolio.total_realized_proceeds += Number(p.total_realized_proceeds) || 0;
    portfolio.day_change += Number(p.day_change) || 0;
    totalExpenses += Number(result?.totalExpenses) || 0;

    if (p.xirr_pct != null) {
      if (!xirrPctSet) {
        firstXirrPct = p.xirr_pct;
        xirrPctSet = true;
      } else if (Math.abs(Number(firstXirrPct) - Number(p.xirr_pct)) > 1e-9) {
        xirrPctConsistent = false;
      }
    } else {
      xirrPctConsistent = false;
    }

    for (const [type, info] of Object.entries(result?.byType || {})) {
      if (!byTypeTotals[type]) {
        byTypeTotals[type] = {
          totalValue: 0,
          totalInvested: 0,
          totalProfitLoss: 0,
          totalRealizedGain: 0,
          xirrPct: null,
        };
      }
      byTypeTotals[type].totalValue += Number(info.totalValue) || 0;
      byTypeTotals[type].totalInvested += Number(info.totalInvested) || 0;
      byTypeTotals[type].totalProfitLoss += Number(info.totalProfitLoss) || 0;
      byTypeTotals[type].totalRealizedGain += Number(info.totalRealizedGain) || 0;
      byTypeTotals[type].xirrPct = info.xirrPct ?? byTypeTotals[type].xirrPct;
    }

    for (const inv of result?.investments || []) {
      if (!mergedInvestments.has(inv.id)) {
        mergedInvestments.set(inv.id, {
          ...inv,
          current_value: 0,
          invested_amount: 0,
          invested_amount_native: 0,
          realized_proceeds: 0,
          profit_loss: 0,
          day_change: 0,
          acquired_units: 0,
          total_units: 0,
          xirr_pct: inv.xirr_pct ?? null,
          _xirr_sources: inv.xirr_pct == null ? 0 : 1,
          day_change_as_of_date: inv.day_change_as_of_date || null,
          day_change_as_of_mixed: false,
          day_change_uses_fallback: !!inv.day_change_uses_fallback,
        });
      }

      const target = mergedInvestments.get(inv.id);
      target.current_value += Number(inv.current_value) || 0;
      target.invested_amount += Number(inv.invested_amount) || 0;
      target.invested_amount_native += Number(inv.invested_amount_native) || 0;
      target.realized_proceeds += Number(inv.realized_proceeds) || 0;
      target.profit_loss += Number(inv.profit_loss) || 0;
      target.day_change += Number(inv.day_change) || 0;
      target.acquired_units += Number(inv.acquired_units) || 0;
      target.total_units += Number(inv.total_units) || 0;
      target.price_per_unit = Number(inv.price_per_unit) || target.price_per_unit || 0;
      target.day_change_uses_fallback = target.day_change_uses_fallback || !!inv.day_change_uses_fallback;
      const nextAsOf = inv.day_change_as_of_date || null;
      if (target.day_change_as_of_date == null) {
        target.day_change_as_of_date = nextAsOf;
      } else if (nextAsOf == null || target.day_change_as_of_date !== nextAsOf) {
        target.day_change_as_of_date = null;
        target.day_change_as_of_mixed = true;
      }
      if (inv.xirr_pct != null) {
        if (target._xirr_sources === 0) {
          target.xirr_pct = inv.xirr_pct;
          target._xirr_sources = 1;
        } else if (Math.abs(Number(target.xirr_pct) - Number(inv.xirr_pct)) > 1e-9) {
          target.xirr_pct = null;
          target._xirr_sources += 1;
        }
      }
    }
  }

  portfolio.xirr_pct = xirrPctConsistent && xirrPctSet ? firstXirrPct : null;

  const investments = Array.from(mergedInvestments.values()).map((inv) => {
    const prevValue = inv.current_value - inv.day_change;
    const profitLossPct = inv.invested_amount > 0 ? (inv.profit_loss / inv.invested_amount) * 100 : 0;
    const dayChangePct = prevValue > 0 ? (inv.day_change / prevValue) * 100 : 0;
    const portfolioPct = portfolio.total_value > 0 ? (inv.current_value / portfolio.total_value) * 100 : 0;
    const acquiredUnits = Number(inv.acquired_units) || 0;
    const avgCostPerUnitNative = acquiredUnits > 0
      ? (Number(inv.invested_amount_native) || 0) / acquiredUnits
      : null;
    return {
      ...inv,
      _xirr_sources: undefined,
      avg_cost_per_unit_native: avgCostPerUnitNative,
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
        totalRealizedGain: 0,
        xirrPct: null,
        dayChange: 0,
        dayChangeAsOfDate: null,
        dayChangeAsOfMixed: false,
        dayChangeFallbackCount: 0,
      };
    }
    byType[inv.asset_type].investments.push(inv);

    const totals = byTypeTotals[inv.asset_type];
    if (totals) {
      byType[inv.asset_type].totalValue = Number(totals.totalValue) || 0;
      byType[inv.asset_type].totalInvested = Number(totals.totalInvested) || 0;
      byType[inv.asset_type].totalProfitLoss = Number(totals.totalProfitLoss) || 0;
      byType[inv.asset_type].totalRealizedGain = Number(totals.totalRealizedGain) || 0;
      byType[inv.asset_type].xirrPct = totals.xirrPct ?? null;
    } else {
      byType[inv.asset_type].totalValue += Number(inv.current_value) || 0;
      byType[inv.asset_type].totalInvested += Number(inv.invested_amount) || 0;
      byType[inv.asset_type].totalProfitLoss += Number(inv.profit_loss) || 0;
      byType[inv.asset_type].totalRealizedGain += Number(inv.realized_proceeds) || 0;
    }
    byType[inv.asset_type].dayChange += Number(inv.day_change) || 0;
    if (inv.day_change_uses_fallback) {
      byType[inv.asset_type].dayChangeFallbackCount += 1;
    }

    const currentAsOf = inv.day_change_as_of_date || null;
    if (byType[inv.asset_type].dayChangeAsOfDate == null) {
      byType[inv.asset_type].dayChangeAsOfDate = currentAsOf;
    } else if (currentAsOf == null || byType[inv.asset_type].dayChangeAsOfDate !== currentAsOf) {
      byType[inv.asset_type].dayChangeAsOfDate = null;
      byType[inv.asset_type].dayChangeAsOfMixed = true;
    }
  }

  // Derive interval change % per asset type from the aggregated amounts. The per-portfolio
  // server responses compute this, but the multi-portfolio combine rebuilds byType and must
  // recompute it, otherwise the card and totals row show 0.00% against a non-zero amount.
  for (const entry of Object.values(byType)) {
    const prevValue = (Number(entry.totalValue) || 0) - (Number(entry.dayChange) || 0);
    entry.intervalChangePct = prevValue > 0 ? ((Number(entry.dayChange) || 0) / prevValue) * 100 : 0;
  }

  const portfolioAsOfDates = investments.map((inv) => inv.day_change_as_of_date).filter(Boolean);
  const uniquePortfolioAsOfDates = [...new Set(portfolioAsOfDates)];
  if (uniquePortfolioAsOfDates.length === 1) {
    portfolio.day_change_as_of_date = uniquePortfolioAsOfDates[0];
    portfolio.day_change_as_of_mixed = false;
  } else if (uniquePortfolioAsOfDates.length > 1) {
    portfolio.day_change_as_of_date = null;
    portfolio.day_change_as_of_mixed = true;
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
    rollupWarning: firstRollupWarning,
    lastUpdate: results.map((r) => r.lastUpdate).filter(Boolean).sort().at(-1) || null,
  };
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

export default function AssetTypeDashboard() {
  usePrivacyMaskRefresh();
  const { assetType: assetTypeSlug } = useParams();
  // Resolve URL slug (e.g. 'mf') back to the enum key (e.g. 'MUTUAL_FUND')
  const assetType = ASSET_TYPE_SLUG_TO_KEY[assetTypeSlug?.toLowerCase()] || assetTypeSlug?.toUpperCase();
  const { selectionMode, selectedId, selectedIds, selectedPortfolio } = usePortfolio();
  const { settings, loading: settingsLoading } = useAppSettings();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedInterval, setSelectedInterval] = useState('1D');
  const [showCustomDatePicker, setShowCustomDatePicker] = useState(false);
  const [customFromDate, setCustomFromDate] = useState('');
  const [customToDate, setCustomToDate] = useState('');
  const [isIntervalSwitching, setIsIntervalSwitching] = useState(false);
  const selectedIdsKey = (selectedIds || []).join(',');

  const hideSold = settings.hideSoldInvestments;
  const includeFullySoldInReturns = hideSold ? settings.includeFullySoldInReturns : true;

  useEffect(() => {
    let cancelled = false;
    const loadData = async () => {
      if (settingsLoading) return;
      if (selectedInterval === 'CUSTOM' && (!customFromDate || !customToDate)) return;

      // Scope resolution mirrors the main Dashboard: the 'all' scope is served by a single
      // server aggregate (portfolio_id=null) whose interval %/XIRR is computed and cached
      // server-side, so we reuse it verbatim instead of re-deriving in the browser. Only a
      // genuine partial subset ('some' with >1 id) has no server endpoint and must be combined
      // client-side (exact for additive amounts; interval % is only exact for 1D there).
      const isAllScope = selectionMode === 'all';
      const isPartialMulti = !isAllScope && selectedIds.length > 1;
      // Namespaced ('at') so asset-type entries (always full XIRR) never mix with the
      // main dashboard's two-phase entries.
      const cacheKey = getDashboardCacheKey({
        targetPortfolioId: isAllScope ? null : (isPartialMulti ? null : selectedId),
        hideSold,
        includeFullySoldInReturns,
        selectedInterval,
        customFromDate,
        customToDate,
        extra: isPartialMulti ? `at:combine:${selectedIdsKey}` : 'at',
      });
      const cachedEntry = getCachedDashboardSummary(cacheKey);

      try {
        setLoading(true);
        setIsIntervalSwitching(true);

        // Instant paint from persisted cache (validated against server version next).
        if (cachedEntry) {
          setData(cachedEntry.data);
          setLoading(false);
        }

        // Version gate: skip the expensive summary fetch when nothing changed.
        if (cachedEntry && cachedEntry.dataVersion != null) {
          let serverVersion = null;
          try {
            const v = await getDashboardVersion();
            serverVersion = v?.dataVersion ?? null;
          } catch (_e) {
            serverVersion = null;
          }
          if (cancelled) return;
          if (serverVersion != null && String(serverVersion) === String(cachedEntry.dataVersion)) {
            setData(cachedEntry.data);
            setError(null);
            setLoading(false);
            setIsIntervalSwitching(false);
            return;
          }
        }

        const requestOptions = {
          hideSold,
          includeFullySoldInReturns,
          xirrMode: 'full',
          interval: selectedInterval,
          customFromDate: customFromDate || undefined,
          customToDate: customToDate || undefined,
        };

        let result;
        let resultVersion = null;
        if (isPartialMulti) {
          const results = await Promise.all(selectedIds.map((id) => getDashboardSummary(id, requestOptions)));
          result = combineDashboardSummaries(results, selectedIds);
          resultVersion = results.find((r) => r?.dataVersion != null)?.dataVersion ?? null;

          // The client combine is exact for additive amounts and for the 1D/YD % (derived from
          // aggregated day_change vs opening value). For every other interval the % is a
          // non-additive XIRR that only the server can solve over unioned cashflows, so overlay
          // the server's exact per-type interval change/% and portfolio interval XIRR here.
          const usesXirrInterval = selectedInterval !== '1D' && selectedInterval !== 'YD';
          if (usesXirrInterval) {
            try {
              const metrics = await getAssetIntervalMetrics({
                portfolioIds: selectedIds,
                interval: selectedInterval,
                customFromDate: customFromDate || undefined,
                customToDate: customToDate || undefined,
              });
              if (metrics?.byType && result?.byType) {
                for (const [type, m] of Object.entries(metrics.byType)) {
                  if (!result.byType[type] || !m) continue;
                  result.byType[type].dayChange = m.dayChange;
                  result.byType[type].intervalChangePct = m.intervalChangePct;
                }
              }
              if (metrics?.intervalXIRR) {
                result.intervalXIRR = { ...(result.intervalXIRR || {}), ...metrics.intervalXIRR };
              }
            } catch (_e) {
              // Fall back to the combine's approximate interval % if the overlay fetch fails.
            }
          }
        } else {
          // 'all' scope -> portfolio_id=null (server aggregate); single scope -> selectedId.
          result = await getDashboardSummary(isAllScope ? null : selectedId, requestOptions);
          resultVersion = result?.dataVersion ?? null;
        }
        if (cancelled) return;

        setData(result);
        setCachedDashboardSummary(cacheKey, result, resultVersion);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError(e.message || 'Failed to load asset type dashboard');
      } finally {
        if (cancelled) return;
        setLoading(false);
        setIsIntervalSwitching(false);
      }
    };

    loadData();
    // selectedIds is intentionally omitted: it is a fresh array each render and would
    // refire this effect on every render. selectedIdsKey is the stable content signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { cancelled = true; };
  }, [selectedId, selectedIdsKey, hideSold, includeFullySoldInReturns, settingsLoading, selectedInterval, customFromDate, customToDate]);

  if (loading) return <LoadingSpinner />;
  if (error) return <ErrorMessage message={error} />;
  if (!data) return null;

  const typeInfo = data.byType?.[assetType] || null;
  const pageTitle = ASSET_TYPE_FULL_NAMES[assetType] || ASSET_TYPE_LABELS[assetType] || assetType;

  if (!typeInfo) {
    return (
      <Alert variant="warning" className="mb-0">
        No holdings found for {pageTitle} in the current portfolio scope.
      </Alert>
    );
  }

  const netProfitLoss = Number(typeInfo.totalProfitLoss) || 0;
  const totalInvested = Number(typeInfo.totalInvested) || 0;
  const totalRealizedGain = Number(typeInfo.totalRealizedGain) || 0;
  const currentInvested = totalInvested - totalRealizedGain;
  const netReturnPct = totalInvested > 0 ? (netProfitLoss / totalInvested) * 100 : 0;
  const intervalChangePct = Number(typeInfo.intervalChangePct ?? 0);
  const intervalLabel = selectedInterval === 'CUSTOM'
    ? `${customFromDate} to ${customToDate}`
    : selectedInterval === '1D'
      ? '1 Day Change'
      : selectedInterval === 'YD'
        ? 'Yesterday Change'
        : `${selectedInterval} Change`;
  const formatINRExact = (amount, options = {}) => {
    const sensitive = options?.sensitive !== false;
    if (sensitive && isPrivacyMaskEnabled()) return getMaskedValue({ currencySymbol: '₹' });
    if (amount == null || Number.isNaN(Number(amount))) return '₹0';
    const value = Number(amount);
    const sign = value < 0 ? '-' : '';
    return `${sign}₹${Math.abs(value).toLocaleString('en-IN', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    })}`;
  };

  return (
    <div className="d-flex flex-column gap-4">
      <div className="d-flex justify-content-between align-items-start flex-wrap gap-3">
        <div>
          <Link to="/" className="small text-muted text-decoration-none d-flex align-items-center gap-1 mb-2">
            <ArrowLeft size={16} /> Back to Dashboard
          </Link>
          <h1 className="h4 fw-bold mb-1">{pageTitle}</h1>
          {selectedPortfolio && (
            <div className="text-muted small">{`${selectedPortfolio.name} portfolio`}</div>
          )}
        </div>
      </div>

      <Row className="g-3">
        <Col md={6} lg={4}>
          <Card className="shadow-sm h-100">
            <Card.Body className="py-3">
              <div className="d-flex align-items-center gap-2 text-muted small mb-1">
                <Wallet size={16} /> Current Value
              </div>
              <div className="fw-bold" style={{ fontSize: '1.9rem', lineHeight: 1.1 }}>{formatINRExact(typeInfo.totalValue)}</div>
              <div className="text-muted small">Net Invested: {formatINRExact(currentInvested)}</div>
              <div className="text-muted small">Cash Proceeds: {formatINRExact(totalRealizedGain)}</div>
            </Card.Body>
          </Card>
        </Col>
        <Col md={6} lg={4}>
          <Card className="shadow-sm h-100">
            <Card.Body className="py-3">
              <div className="d-flex align-items-center justify-content-between gap-2 mb-2">
                <div className="d-flex align-items-center gap-2 text-muted small">
                  {(typeInfo.dayChange ?? 0) >= 0 ? (
                    <TrendingUp size={16} className="text-success" />
                  ) : (
                    <TrendingDown size={16} className="text-danger" />
                  )}
                  <span>{intervalLabel}</span>
                </div>
                <div style={{ fontSize: '0.85rem' }}>
                  <select
                    className="form-select form-select-sm"
                    value={selectedInterval}
                    onChange={(e) => {
                      const val = e.target.value;
                      if (val === 'CUSTOM') {
                        setShowCustomDatePicker(true);
                      } else {
                        setSelectedInterval(val);
                        setShowCustomDatePicker(false);
                      }
                    }}
                    style={{ maxWidth: '100px', fontSize: '0.85rem' }}
                  >
                    <option value="1D">1D</option>
                    <option value="YD">YD</option>
                    <option value="2D">2D</option>
                    <option value="1W">1W</option>
                    <option value="1M">1M</option>
                    <option value="3M">3M</option>
                    <option value="6M">6M</option>
                    <option value="1Y">1Y</option>
                    <option value="2Y">2Y</option>
                    <option value="3Y">3Y</option>
                    <option value="5Y">5Y</option>
                    <option value="7Y">7Y</option>
                    <option value="10Y">10Y</option>
                    <option value="CUSTOM">Custom</option>
                  </select>
                </div>
              </div>

              {showCustomDatePicker && (
                <div className="mb-2 p-2 bg-light rounded small">
                  <div className="d-flex gap-2 mb-2">
                    <input
                      type="date"
                      className="form-control form-control-sm"
                      value={customFromDate}
                      onChange={(e) => setCustomFromDate(e.target.value)}
                      placeholder="From"
                    />
                    <input
                      type="date"
                      className="form-control form-control-sm"
                      value={customToDate}
                      onChange={(e) => setCustomToDate(e.target.value)}
                      placeholder="To"
                    />
                  </div>
                  <Button
                    variant="sm"
                    onClick={() => {
                      setSelectedInterval('CUSTOM');
                      setShowCustomDatePicker(false);
                    }}
                    className="w-100"
                  >
                    Apply
                  </Button>
                </div>
              )}

              {isIntervalSwitching ? (
                <div className="d-flex align-items-center gap-2 text-muted small py-2">
                  <Spinner animation="border" size="sm" />
                  Updating interval metrics...
                </div>
              ) : (
                <>
                  <div className={`fs-3 fw-bold ${profitColor(typeInfo.dayChange)}`}>
                    {formatINR(typeInfo.dayChange || 0, 0)}
                  </div>
                  <div className={`small ${profitColor(intervalChangePct)}`}>
                    Change: {formatPct(intervalChangePct)}{selectedInterval === '1D' || selectedInterval === 'YD' ? '' : ' p.a.'}
                  </div>
                </>
              )}
            </Card.Body>
          </Card>
        </Col>
        <Col md={6} lg={4}>
          <Card className="shadow-sm h-100">
            <Card.Body className="py-3">
              <div className="d-flex align-items-center gap-2 text-muted small mb-1">
                <PiggyBank size={16} /> Total P&L
              </div>
              <div className={`fw-bold ${profitColor(netProfitLoss)}`} style={{ fontSize: '1.9rem', lineHeight: 1.1 }}>
                {netProfitLoss >= 0 ? '+' : ''}{formatINRExact(netProfitLoss)}
              </div>
              <div className={`small ${profitColor(netReturnPct)}`}>
                <span>Abs: {formatPct(netReturnPct)}</span>
                <span className="mx-2 text-muted">|</span>
                <span>XIRR: {typeInfo.xirrPct == null ? 'N/A' : formatPct(typeInfo.xirrPct)}</span>
              </div>
            </Card.Body>
          </Card>
        </Col>
      </Row>

      <AssetTypeHoldingsTable
        type={assetType}
        info={typeInfo}
        portfolioTotalValue={Number(data.portfolio?.total_value) || 0}
        selectedInterval={selectedInterval}
        isIntervalSwitching={isIntervalSwitching}
      />

      <DashboardRolloverTable
        title={`Daily ${pageTitle} Value History`}
        description="Stored daily aggregate snapshots for this asset type in the current dashboard scope."
        assetType={assetType}
        wrapperClassName="shadow-sm"
      />

      {data.lastUpdate && (
        <div className="text-center text-muted" style={{ fontSize: '0.75rem' }}>
          Last updated: {formatDate(data.lastUpdate)} at {new Date(data.lastUpdate).toLocaleTimeString('en-IN')}
        </div>
      )}
    </div>
  );
}
